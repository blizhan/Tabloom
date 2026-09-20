import { createOrtSession, type OrtOutputValue, type OrtSessionHandle, type OrtSessionOptions } from "../../src/model/ort-session";
import { RuntimeError, asRuntimeError } from "../../src/model/errors";
import { TabICLv2CaseAdapter } from "../../src/model/tabiclv2/adapter";
import { CASE_VARIANTS, loadCaseFixture, type CaseFixture, type CaseVariant } from "../../src/model/tabiclv2/case-fixture";
import type { ContextSnapshot, ExecutionProvider, TabularDataset, TrainingDataset } from "../../src/model/types";

export interface CaseWorkerRunRequest {
  readonly kind: "run-case";
  readonly requestId: string;
  readonly provider: ExecutionProvider;
  readonly variant: CaseVariant;
  readonly baseUrl: string;
}

export interface CaseWorkerDisposeRequest {
  readonly kind: "dispose";
  readonly requestId: string;
}

export interface CaseWorkerSuccess {
  readonly kind: "success";
  readonly requestId: string;
  readonly provider: ExecutionProvider;
  readonly variant: CaseVariant;
  readonly baselineMean: readonly number[];
  readonly changedMean: readonly number[];
  readonly maxAbsError: number;
  readonly repeatedMaxAbsDelta: number;
  readonly changedMaxAbsDelta: number;
  readonly targetUnitBudget: number;
  readonly artifactManifestDigest: string;
  readonly modelVersion: string;
  readonly precision: string;
  readonly graphSha256: string;
  readonly snapshotChecks: {
    readonly dynamicFitRejected: boolean;
    readonly identityPreserved: boolean;
    readonly exportedPayload: "embedded-artifact";
  };
}

export interface CaseWorkerFailure {
  readonly kind: "failure";
  readonly requestId: string;
  readonly provider?: ExecutionProvider;
  readonly variant?: string;
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export type CaseWorkerReply = CaseWorkerSuccess | CaseWorkerFailure;

export interface CaseWorkerDependencies {
  readonly loadFixture?: (baseUrl: string, variant: CaseVariant) => Promise<CaseFixture>;
  readonly createSession?: (options: OrtSessionOptions) => Promise<OrtSessionHandle>;
  readonly providerAvailable?: (provider: ExecutionProvider) => Promise<boolean> | boolean;
}

function isProvider(value: unknown): value is ExecutionProvider { return value === "wasm" || value === "webgpu"; }
function isVariant(value: unknown): value is CaseVariant { return (CASE_VARIANTS as readonly string[]).includes(String(value)); }

async function defaultProviderAvailable(provider: ExecutionProvider): Promise<boolean> {
  if (provider === "wasm") return true;
  const gpu = (globalThis as typeof globalThis & { navigator?: Navigator & { gpu?: { requestAdapter?: (options?: unknown) => Promise<unknown> } } }).navigator?.gpu;
  if (!gpu?.requestAdapter) return false;
  try { return Boolean(await gpu.requestAdapter({ powerPreference: "high-performance" })); } catch { return false; }
}

function datasetFromRaw(fixture: CaseFixture, scenarioIndex: number): TabularDataset {
  const scenario = fixture.scenarios[scenarioIndex];
  const featureCount = fixture.state.featureNames.length;
  if (!scenario || scenario.rawShape.length !== 2 || scenario.rawShape[1] !== featureCount || scenario.rawShape[0] <= 0 || scenario.rawInput.length !== scenario.rawShape[0] * scenario.rawShape[1]) throw new RuntimeError("SHAPE_UNSUPPORTED", "Case raw fixture shape does not match its fitted feature schema");
  const rowCount = scenario.rawShape[0];
  const columns = Array.from({ length: featureCount }, (_, columnIndex) => {
    const column = new Float32Array(rowCount);
    for (let row = 0; row < rowCount; row += 1) column[row] = scenario.rawInput[row * featureCount + columnIndex];
    return column;
  });
  return { columns, columnNames: [...fixture.state.featureNames], rowCount };
}

function rowMajor(columns: readonly Float32Array[], rowCount: number): Float32Array {
  const out = new Float32Array(rowCount * columns.length);
  for (let row = 0; row < rowCount; row += 1) for (let column = 0; column < columns.length; column += 1) out[row * columns.length + column] = columns[column][row];
  return out;
}

function asNumbers(data: unknown): number[] {
  if (ArrayBuffer.isView(data)) return Array.from(data as unknown as ArrayLike<number>, Number);
  if (Array.isArray(data)) return data.map(Number);
  throw new RuntimeError("RESULT_INVALID", "Case ORT output is not a numeric tensor");
}

function tensorElementCount(dims: readonly number[]): number {
  if (dims.length === 0 || dims.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new RuntimeError("RESULT_INVALID", "Case ORT output has invalid dimensions");
  return dims.reduce((total, value) => total * value, 1);
}

function maxAbsError(actual: ArrayLike<number>, expected: ArrayLike<number>): number {
  if (actual.length !== expected.length) throw new RuntimeError("RESULT_INVALID", "Case prediction row count does not match the official fixture");
  let max = 0;
  for (let index = 0; index < actual.length; index += 1) {
    if (!Number.isFinite(actual[index])) throw new RuntimeError("RESULT_INVALID", "Case prediction contains a non-finite value");
    max = Math.max(max, Math.abs(actual[index] - expected[index]));
  }
  return max;
}

function buildCaseSnapshot(fixture: CaseFixture, provider: ExecutionProvider): ContextSnapshot {
  const digest = fixture.artifactManifestDigest;
  const recipe = fixture.variantManifest.embeddedCaseRecipe;
  return {
    identity: {
      key: digest,
      modelId: "tabicl-v2",
      modelVersion: fixture.modelVersion,
      artifactManifestDigest: digest,
      contextFormatVersion: 1,
      preprocessingVersion: fixture.variantManifest.artifactManifest.preprocessingVersion,
      trainingDataDigest: recipe.trainingDataSha256 ?? digest,
      featureSqlFingerprint: null,
      schemaDigest: digest,
      targetName: "target",
      configurationDigest: digest,
    },
    provenance: { sourceSnapshotId: "tabicl-case-golden", builtWithProvider: provider },
    featureNames: [...fixture.state.featureNames],
    estimatorState: recipe.estimatorState,
    payload: { kind: "embedded-artifact", manifestDigest: digest },
  };
}

async function executeCase(request: CaseWorkerRunRequest, dependencies: CaseWorkerDependencies): Promise<CaseWorkerSuccess> {
  if (!isProvider(request.provider)) throw new RuntimeError("INVALID_DATA", `Unsupported Case provider: ${String(request.provider)}`);
  if (!isVariant(request.variant)) throw new RuntimeError("INVALID_DATA", `Unsupported Case variant: ${String(request.variant)}`);
  if (typeof request.baseUrl !== "string" || request.baseUrl.length === 0) throw new RuntimeError("INVALID_DATA", "Case baseUrl is required");
  const providerAvailable = await (dependencies.providerAvailable ?? defaultProviderAvailable)(request.provider);
  if (!providerAvailable) throw new RuntimeError("PROVIDER_UNAVAILABLE", `Provider ${request.provider} is unavailable`, { retryable: true });
  const fixture = await (dependencies.loadFixture ?? loadCaseFixture)(request.baseUrl, request.variant);
  if (!fixture.variantManifest.artifactManifest.providerCompatibility.includes(request.provider)) throw new RuntimeError("PROVIDER_UNAVAILABLE", `Case artifact does not support ${request.provider}`, { retryable: true });
  const session = await (dependencies.createSession ?? createOrtSession)({ ...fixture.ortOptions, provider: request.provider });
  let adapter: TabICLv2CaseAdapter | undefined;
  const contexts: Array<{ readonly handleId: string; readonly identity: ContextSnapshot["identity"]; readonly workerEpoch: string; readonly instanceId?: string }> = [];
  try {
    const inputName = fixture.variantManifest.artifactManifest.inputs[0]?.name ?? session.inputNames[0];
    const outputName = session.outputNames[0];
    if (!inputName || !outputName || !session.inputNames.includes(inputName) || !session.outputNames.includes(outputName)) throw new RuntimeError("RESULT_INVALID", "Case graph input/output names do not match the manifest");
    let activeScenario = 0;
    adapter = new TabICLv2CaseAdapter({
      manifestDigest: fixture.artifactManifestDigest,
      state: fixture.state,
      provider: request.provider,
      modelVersion: fixture.modelVersion,
      providerAvailable: async () => true,
      inference: {
        predict: async (dataset) => {
          const scenario = fixture.scenarios[activeScenario];
          const modelInput = rowMajor(dataset.columns, dataset.rowCount);
          if (scenario.modelInputShape.length !== 3 || scenario.modelInputShape[0] !== 1 || scenario.modelInputShape[1] !== dataset.rowCount || scenario.modelInputShape[2] !== dataset.columnNames.length || scenario.modelInput.length !== modelInput.length) throw new RuntimeError("SHAPE_UNSUPPORTED", "Case model-input fixture shape does not match the prediction dataset");
          for (let index = 0; index < modelInput.length; index += 1) if (Math.abs(modelInput[index] - scenario.modelInput[index]) > 1e-6) throw new RuntimeError("RESULT_INVALID", "Case preprocessing does not match the published model-input fixture");
          const outputs = await session.run({ [inputName]: { type: "float32", data: modelInput, dims: [1, dataset.rowCount, dataset.columnNames.length] } }, [outputName]);
          const output = outputs[outputName] as OrtOutputValue | undefined;
          if (!output) throw new RuntimeError("RESULT_INVALID", `Case graph did not return ${outputName}`);
          const data = asNumbers(output.data);
          if (tensorElementCount(output.dims) !== data.length || data.length !== dataset.rowCount) throw new RuntimeError("RESULT_INVALID", "Case graph output shape does not match prediction rows");
          return new Float32Array(data);
        },
      },
    });
    await adapter.load({ preferredProvider: request.provider });
    const snapshot = buildCaseSnapshot(fixture, request.provider);
    const context = await adapter.importContext(snapshot); contexts.push(context);
    const exported = await adapter.exportContext(context);
    const imported = await adapter.importContext(exported); contexts.push(imported);
    const identityPreserved = imported.identity.key === context.identity.key && imported.identity.artifactManifestDigest === context.identity.artifactManifestDigest && exported.payload.kind === "embedded-artifact";
    let dynamicFitRejected = false;
    try {
      const training = datasetFromRaw(fixture, 0) as TrainingDataset;
      await adapter.fitContext({ ...training, target: new Float32Array(training.rowCount), targetName: "target" }, { featureSqlFingerprint: null, sourceSnapshotId: "dynamic", preprocessing: { profile: "tabicl-case", seed: 0 } });
    } catch (error) {
      dynamicFitRejected = error instanceof RuntimeError && error.code === "UNSUPPORTED_CAPABILITY";
    }
    if (!dynamicFitRejected) throw new RuntimeError("RESULT_INVALID", "Case dynamic fit was not rejected");
    const predictScenario = async (index: number): Promise<number[]> => { activeScenario = index; const result = await adapter!.predict(context, datasetFromRaw(fixture, index), { requestId: `${request.requestId}-${fixture.scenarios[index].id}`, inputSnapshotId: "tabicl-case-golden", scenarioId: fixture.scenarios[index].id }); return Array.from(result.mean); };
    const baselineMean = await predictScenario(0);
    const repeatedMean = await predictScenario(0);
    const changedMean = await predictScenario(1);
    const baselineError = maxAbsError(baselineMean, fixture.scenarios[0].officialMean);
    const changedError = maxAbsError(changedMean, fixture.scenarios[1].officialMean);
    const repeatedMaxAbsDelta = maxAbsError(repeatedMean, baselineMean);
    const changedMaxAbsDelta = maxAbsError(changedMean, baselineMean);
    if (Math.max(baselineError, changedError) > fixture.targetUnitBudget) throw new RuntimeError("RESULT_INVALID", `Case target-unit error ${Math.max(baselineError, changedError)} exceeds budget ${fixture.targetUnitBudget}`);
    if (repeatedMaxAbsDelta > 1e-5) throw new RuntimeError("RESULT_INVALID", `Case repeat delta ${repeatedMaxAbsDelta} exceeds 1e-5`);
    if (changedMaxAbsDelta === 0) throw new RuntimeError("RESULT_INVALID", "Changed Case input did not change the prediction");
    const graphSha256 = fixture.variantManifest.artifactManifest.files.find((file) => file.role === "graph")?.sha256;
    if (!graphSha256) throw new RuntimeError("ARTIFACT_MISMATCH", "Case artifact manifest has no graph digest");
    return { kind: "success", requestId: request.requestId, provider: request.provider, variant: request.variant, baselineMean, changedMean, maxAbsError: Math.max(baselineError, changedError), repeatedMaxAbsDelta, changedMaxAbsDelta, targetUnitBudget: fixture.targetUnitBudget, artifactManifestDigest: fixture.artifactManifestDigest, modelVersion: fixture.modelVersion, precision: fixture.variantManifest.artifactManifest.precision, graphSha256, snapshotChecks: { dynamicFitRejected, identityPreserved, exportedPayload: "embedded-artifact" } };
  } finally {
    for (const context of contexts.reverse()) await adapter?.releaseContext(context).catch(() => undefined);
    await adapter?.dispose().catch(() => undefined);
    await session.release().catch(() => undefined);
  }
}

export async function runCaseRequest(request: CaseWorkerRunRequest, dependencies: CaseWorkerDependencies = {}): Promise<CaseWorkerReply> {
  try { return await executeCase(request, dependencies); } catch (error) {
    const runtimeError = asRuntimeError(error, "RESULT_INVALID");
    return { kind: "failure", requestId: request.requestId, ...(isProvider(request.provider) ? { provider: request.provider } : {}), ...(typeof request.variant === "string" ? { variant: request.variant } : {}), error: { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable } };
  }
}

export function installCaseWorker(dependencies: CaseWorkerDependencies = {}): void {
  const scope = globalThis as unknown as { postMessage?: (message: CaseWorkerReply | { kind: "disposed"; requestId: string }) => void; onmessage?: (event: MessageEvent) => void };
  if (typeof scope.postMessage !== "function") return;
  let disposed = false;
  scope.onmessage = (event) => {
    const value = event.data as Partial<CaseWorkerRunRequest> | Partial<CaseWorkerDisposeRequest>;
    if (value?.kind === "dispose") {
      if (!disposed) disposed = true;
      scope.postMessage?.({ kind: "disposed", requestId: String(value.requestId ?? "dispose") });
      return;
    }
    const request = value as CaseWorkerRunRequest;
    const promise = disposed ? Promise.resolve<CaseWorkerReply>({ kind: "failure", requestId: String(request.requestId ?? "unknown"), error: { code: "ADAPTER_DISPOSED", message: "Case worker is disposed", retryable: false } }) : runCaseRequest(request, dependencies);
    void promise.then((reply) => scope.postMessage?.(reply));
  };
}

installCaseWorker();
