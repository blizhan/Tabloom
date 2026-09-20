import { asRuntimeError, RuntimeError } from "../../src/model/errors";
import { TabPFN35OrtRuntime, type TabPFN35RuntimeDiagnostics } from "../../src/model/tabpfn35/ort-runtime";
import type { ExecutionProvider } from "../../src/model/types";

/** Request sent to the dedicated bootstrap module worker. This worker
 * consumes the original context-chain fixture in graph-native shapes and
 * proves the builder -> predictor ownership boundary. */
export interface BootstrapChainWorkerRequest {
  readonly kind: "run-context-chain";
  readonly requestId: string;
  readonly baseUrl: string;
  readonly provider: ExecutionProvider;
  readonly precision: "fp32" | "fp16-storage-fp32-compute";
}

export interface BootstrapChainScenarioEvidence {
  readonly name: string;
  readonly trainRows: number;
  readonly features: number;
  readonly predictionRows: number;
  readonly maxAbsError: number;
  readonly finite: boolean;
  readonly cacheTensorCount: number;
  readonly independentCacheCopies: boolean;
  readonly builderReleasedBeforePredict: boolean;
}

export interface BootstrapChainWorkerSuccess {
  readonly kind: "success";
  readonly requestId: string;
  readonly provider: ExecutionProvider;
  readonly precision: BootstrapChainWorkerRequest["precision"];
  readonly scenarioCount: number;
  readonly scenarios: readonly BootstrapChainScenarioEvidence[];
  readonly tolerance: number;
  readonly diagnostics: TabPFN35RuntimeDiagnostics;
  readonly sharedExternalDataFetches: number;
  readonly sharedExternalDataReused: boolean;
  readonly sharedExternalDataBytes: number;
  readonly graphFetches: number;
}

export interface BootstrapChainWorkerFailure {
  readonly kind: "failure";
  readonly requestId: string;
  readonly provider?: ExecutionProvider;
  readonly precision?: BootstrapChainWorkerRequest["precision"];
  readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean };
}

export type BootstrapChainWorkerReply = BootstrapChainWorkerSuccess | BootstrapChainWorkerFailure;

interface FixtureArray { readonly file: string; readonly shape: readonly number[]; readonly bytes: number; }
interface ContextChainFixture { readonly cacheNames: readonly string[]; readonly scenarios: readonly string[]; readonly arrays: Readonly<Record<string, FixtureArray>>; }

function endpoint(baseUrl: string, path: string): string { return new URL(path, baseUrl).toString(); }

async function fetchBytes(url: string, label: string): Promise<Uint8Array> {
  let response: Response;
  try { response = await fetch(url); } catch (error) { throw new RuntimeError("ARTIFACT_MISMATCH", `${label} request failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new RuntimeError("ARTIFACT_MISMATCH", `${label} is unavailable (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchFixture(baseUrl: string): Promise<ContextChainFixture> {
  const bytes = await fetchBytes(endpoint(baseUrl, "/runtime-fixtures/tabpfn35/context-chain/fixture.json"), "TabPFN context-chain fixture");
  let fixture: ContextChainFixture;
  try { fixture = JSON.parse(new TextDecoder().decode(bytes)) as ContextChainFixture; } catch { throw new RuntimeError("ARTIFACT_MISMATCH", "TabPFN context-chain fixture is not valid JSON"); }
  if (!Array.isArray(fixture.cacheNames) || fixture.cacheNames.length !== 54 || !Array.isArray(fixture.scenarios) || fixture.scenarios.length === 0 || !fixture.arrays) throw new RuntimeError("ARTIFACT_MISMATCH", "TabPFN context-chain fixture schema is incomplete");
  return fixture;
}

async function fetchFloat32(baseUrl: string, metadata: FixtureArray, label: string): Promise<Float32Array> {
  if (!Array.isArray(metadata.shape) || metadata.shape.length === 0 || metadata.shape.some((value) => !Number.isSafeInteger(value) || value <= 0) || metadata.bytes !== metadata.shape.reduce((total, value) => total * value, 1) * 4) throw new RuntimeError("ARTIFACT_MISMATCH", `${label} has an invalid shape or byte count`);
  const bytes = await fetchBytes(endpoint(baseUrl, `/runtime-fixtures/tabpfn35/context-chain/${metadata.file}`), label);
  if (bytes.byteLength !== metadata.bytes || bytes.byteLength % 4 !== 0) throw new RuntimeError("ARTIFACT_MISMATCH", `${label} byte length does not match fixture metadata`);
  const values = new Float32Array(bytes.byteLength / 4);
  values.set(new Float32Array(bytes.slice().buffer));
  return values;
}

function shapeRowsFeatures(shape: readonly number[], label: string): { readonly rows: number; readonly features: number } {
  if (shape.length !== 3 || shape[1] !== 1 || !Number.isSafeInteger(shape[0]) || !Number.isSafeInteger(shape[2]) || shape[0] < 1 || shape[2] < 1) throw new RuntimeError("SHAPE_UNSUPPORTED", `${label} must have graph shape [rows, 1, features]`);
  return { rows: shape[0], features: shape[2] };
}

function maxAbsError(actual: ArrayLike<number>, expected: ArrayLike<number>): { readonly value: number; readonly finite: boolean } {
  if (actual.length !== expected.length) throw new RuntimeError("RESULT_INVALID", "Context-chain prediction output length differs from its fixture");
  let maximum = 0;
  let finite = true;
  for (let index = 0; index < actual.length; index += 1) {
    const left = Number(actual[index]);
    const right = Number(expected[index]);
    finite = finite && Number.isFinite(left) && Number.isFinite(right);
    if (Number.isFinite(left) && Number.isFinite(right)) maximum = Math.max(maximum, Math.abs(left - right));
  }
  return { value: maximum, finite };
}

async function execute(request: BootstrapChainWorkerRequest): Promise<BootstrapChainWorkerSuccess> {
  const fixture = await fetchFixture(request.baseUrl);
  const root = `/runtime-assets/tabpfn35/${request.precision}`;
  const [contextGraph, predictorGraph, sharedData] = await Promise.all([
    fetchBytes(endpoint(request.baseUrl, `${root}/tabpfn35-context-dynamic.onnx`), "TabPFN context graph"),
    fetchBytes(endpoint(request.baseUrl, `${root}/tabpfn35-predict-dynamic.onnx`), "TabPFN prediction graph"),
    fetchBytes(endpoint(request.baseUrl, `${root}/tabpfn35-shared.data`), "TabPFN shared external data"),
  ]);
  const runtime = new TabPFN35OrtRuntime({
    provider: request.provider,
    contextGraph,
    predictorGraph,
    // Both sessions receive this exact Uint8Array object. It is never
    // transferred; ORT receives provider-local tensor views instead.
    externalData: { path: "tabpfn35-shared.data", bytes: sharedData },
    // The WebGPU JSEP backend also loads ORT's companion WASM module. Keep
    // the path explicit for both providers; otherwise Vite's SPA fallback can
    // be fetched as a `.wasm` binary from a module-worker-relative URL.
    wasmPaths: new URL("/runtime-assets/ort/", request.baseUrl).toString(),
    maxTrainRows: 1024,
    maxPredictionRows: 1024,
    maxFeatures: 32,
  });
  const tolerance = request.precision === "fp32" ? 1e-4 : 1e-2;
  try {
    await runtime.load();
    const scenarios: BootstrapChainScenarioEvidence[] = [];
    for (const name of fixture.scenarios) {
      const train = fixture.arrays[`x_train_${name}`];
      const target = fixture.arrays[`y_train_${name}`];
      const test = fixture.arrays[`x_test_${name}`];
      const expected = fixture.arrays[`output_${name}`];
      if (!train || !target || !test || !expected) throw new RuntimeError("ARTIFACT_MISMATCH", `Context-chain fixture is missing scenario ${name}`);
      const [xTrain, yTrain, xTest, expectedLogits] = await Promise.all([
        fetchFloat32(request.baseUrl, train, `${name} training features`),
        fetchFloat32(request.baseUrl, target, `${name} training target`),
        fetchFloat32(request.baseUrl, test, `${name} prediction features`),
        fetchFloat32(request.baseUrl, expected, `${name} expected logits`),
      ]);
      const trainShape = shapeRowsFeatures(train.shape, `${name} training features`);
      const testShape = shapeRowsFeatures(test.shape, `${name} prediction features`);
      if (target.shape.length !== 1 || target.shape[0] !== trainShape.rows || yTrain.length !== trainShape.rows) throw new RuntimeError("SHAPE_UNSUPPORTED", `${name} training target shape is invalid`);
      if (expected.shape.length !== 3 || expected.shape[0] !== testShape.rows || expected.shape[1] !== 1 || expected.shape[2] !== 5000) throw new RuntimeError("SHAPE_UNSUPPORTED", `${name} expected logits shape is invalid`);
      const cache = await runtime.buildContext(xTrain, trainShape.rows, trainShape.features, yTrain);
      const diagnosticsAfterBuild = runtime.diagnostics();
      const independentCacheCopies = cache.length === 54 && cache.every((tensor, index) => tensor.data instanceof Float32Array && (index === 0 || tensor.data !== cache[index - 1].data));
      const logits = await runtime.predict(xTest, testShape.rows, testShape.features, cache);
      const comparison = maxAbsError(logits.data, expectedLogits);
      const builderReleasedBeforePredict = diagnosticsAfterBuild.builderActive === false;
      if (!comparison.finite || comparison.value > tolerance || !independentCacheCopies || !builderReleasedBeforePredict) throw new RuntimeError("RESULT_INVALID", `${name} context-chain evidence failed (error=${comparison.value}, cache=${cache.length}, builderReleased=${builderReleasedBeforePredict})`);
      scenarios.push({ name, trainRows: trainShape.rows, features: trainShape.features, predictionRows: testShape.rows, maxAbsError: comparison.value, finite: comparison.finite, cacheTensorCount: cache.length, independentCacheCopies, builderReleasedBeforePredict });
    }
    const diagnostics = runtime.diagnostics();
    return {
      kind: "success",
      requestId: request.requestId,
      provider: request.provider,
      precision: request.precision,
      scenarioCount: scenarios.length,
      scenarios,
      tolerance,
      diagnostics,
      // This worker makes exactly one explicit shared-data request and passes
      // that object to both sessions.
      sharedExternalDataFetches: 1,
      sharedExternalDataReused: diagnostics.sharedExternalDataConfigured && diagnostics.sharedExternalDataBytes === sharedData.byteLength,
      sharedExternalDataBytes: sharedData.byteLength,
      graphFetches: 2,
    };
  } finally {
    await runtime.release().catch(() => undefined);
  }
}

export async function runBootstrapChainRequest(request: BootstrapChainWorkerRequest): Promise<BootstrapChainWorkerReply> {
  try { return await execute(request); } catch (error) {
    const runtimeError = asRuntimeError(error, "RESULT_INVALID");
    return { kind: "failure", requestId: request.requestId, provider: request.provider, precision: request.precision, error: { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable } };
  }
}

const scope = globalThis as unknown as { postMessage?: (value: BootstrapChainWorkerReply) => void; onmessage?: (event: MessageEvent<BootstrapChainWorkerRequest>) => void };
if (typeof scope.postMessage === "function") scope.onmessage = (event) => { void runBootstrapChainRequest(event.data).then((reply) => scope.postMessage?.(reply)); };

/** Serializable status payload returned by the application-owned model worker. */
export interface BootstrapWorkerMessage { readonly kind: "bootstrap"; readonly provider: "wasm" | "webgpu"; }

export interface BootstrapWorkerDiagnostics {
  readonly artifacts?: {
    readonly networkFetches?: number;
    readonly files?: Record<string, number>;
  };
  readonly ort?: {
    readonly provider?: "wasm" | "webgpu";
    readonly wasmProxy?: boolean | null;
    readonly wasmNumThreads?: number | null;
    readonly wasmPathsConfigured?: boolean;
    readonly sharedExternalDataConfigured?: boolean;
    readonly sharedExternalDataBytes?: number;
    readonly artifactBytes?: number;
    readonly predictorLoaded?: boolean;
    readonly builderActive?: boolean;
  };
  readonly resources?: {
    readonly ownedBytes?: number;
    readonly cacheBytes?: number;
    readonly peakCacheBytes?: number;
    readonly contextCount?: number;
    readonly handleCount?: number;
    readonly pinnedHandles?: number;
  };
}

export interface BootstrapWorkerStatus {
  readonly running: readonly string[];
  readonly cancelled: readonly string[];
  readonly disposed: boolean;
  readonly diagnostics?: BootstrapWorkerDiagnostics;
}
