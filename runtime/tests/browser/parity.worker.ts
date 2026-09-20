import { asRuntimeError, RuntimeError } from "../../src/model/errors";
import { createTabPFN35Adapter, type TabPFN35Precision } from "../../src/model/tabpfn35/worker-factory";
import { transformFeatures, transformTrainingFeatures, type PreparedFeatures } from "../../src/model/tabpfn35/preprocessing";
import type { ExecutionProvider, ModelContext, TabularDataset, TrainingDataset } from "../../src/model/types";
import type { BrowserGoldenState } from "./estimator-golden";

export interface ParityScenarioInput {
  readonly name: string;
  readonly state: BrowserGoldenState;
  readonly xTrain: Float32Array;
  readonly trainShape: readonly [number, number];
  readonly yTrain: Float32Array;
  readonly xTest: Float32Array;
  readonly testShape: readonly [number, number];
  readonly expectedXTrainModel: Float32Array;
  readonly expectedXTrainModelShape: readonly [number, number, number];
  readonly expectedXTestModel: Float32Array;
  readonly expectedXTestModelShape: readonly [number, number, number];
  readonly expectedYTrainModel: Float32Array;
  readonly expectedMean: Float32Array;
}
export interface ParityWorkerRequest {
  readonly kind: "run-parity";
  readonly requestId: string;
  readonly baseUrl: string;
  readonly provider: ExecutionProvider;
  readonly precision: TabPFN35Precision;
  readonly scenarios: readonly ParityScenarioInput[];
}
export interface ParityScenarioEvidence { readonly name: string; readonly maxAbsError: number; readonly meanRows: number; readonly finite: boolean; readonly cacheTensorCount: number; readonly contextReused: boolean; readonly stageMaxAbsError: { readonly xTrainModel: number; readonly xTestModel: number; readonly yTrainModel: number }; readonly defaultInfRejected?: boolean; }
export interface ParityWorkerSuccess { readonly kind: "success"; readonly requestId: string; readonly provider: ExecutionProvider; readonly precision: TabPFN35Precision; readonly tolerance: number; readonly scenarios: readonly ParityScenarioEvidence[]; }
export interface ParityWorkerFailure { readonly kind: "failure"; readonly requestId: string; readonly provider?: ExecutionProvider; readonly precision?: TabPFN35Precision; readonly error: { readonly code: string; readonly message: string; readonly retryable: boolean }; }
export type ParityWorkerReply = ParityWorkerSuccess | ParityWorkerFailure;

function dataset(values: Float32Array, shape: readonly [number, number]): TabularDataset {
  const [rowCount, featureCount] = shape;
  if (values.length !== rowCount * featureCount || rowCount < 1 || featureCount < 1) throw new RuntimeError("SHAPE_UNSUPPORTED", "Estimator golden dataset shape is invalid");
  const columns = Array.from({ length: featureCount }, (_, column) => {
    const output = new Float32Array(rowCount);
    for (let row = 0; row < rowCount; row += 1) output[row] = values[row * featureCount + column];
    return output;
  });
  return { columns, columnNames: Array.from({ length: featureCount }, (_, index) => `x${index}`), rowCount };
}

function maxAbsError(actual: ArrayLike<number>, expected: ArrayLike<number>): { readonly value: number; readonly finite: boolean } {
  if (actual.length !== expected.length) throw new RuntimeError("RESULT_INVALID", "Estimator golden mean row count differs from ORT output");
  let maximum = 0;
  let finite = true;
  for (let index = 0; index < actual.length; index += 1) {
    const left = Number(actual[index]);
    const right = Number(expected[index]);
    finite = finite && Number.isFinite(left) && Number.isFinite(right);
    if (!Number.isFinite(left)) continue;
    maximum = Math.max(maximum, Math.abs(left - right));
  }
  return { value: maximum, finite };
}

function rowMajor(prepared: PreparedFeatures): Float32Array {
  const output = new Float32Array(prepared.rowCount * prepared.values.length);
  for (let row = 0; row < prepared.rowCount; row += 1) for (let column = 0; column < prepared.values.length; column += 1) output[row * prepared.values.length + column] = prepared.values[column][row];
  return output;
}

function stageError(actual: ArrayLike<number>, expected: ArrayLike<number>, label: string): number {
  if (actual.length !== expected.length) throw new RuntimeError("RESULT_INVALID", `${label} length differs from the estimator golden`);
  let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const left = Number(actual[index]);
    const right = Number(expected[index]);
    if (Number.isFinite(left) && Number.isFinite(right)) { maximum = Math.max(maximum, Math.abs(left - right)); continue; }
    const sameNonFinite = (Number.isNaN(left) && Number.isNaN(right)) || left === right;
    if (!sameNonFinite) throw new RuntimeError("RESULT_INVALID", `${label} has a non-finite mismatch at ${index}`);
  }
  return maximum;
}

function preprocessing(state: BrowserGoldenState, includeInf: boolean): { profile: "tabpfn35-none"; seed: number; passthroughInf: boolean; featureFingerprint: boolean; featurePermutation: readonly number[]; featureShiftDecoder: "shuffle" | "rotate" | null; featureShiftCount: number } {
  const permutation = state.gpu.fittedCache?.[1]?.permutation;
  if (!permutation) throw new RuntimeError("ARTIFACT_MISMATCH", "Estimator golden state has no fitted feature permutation");
  return { profile: "tabpfn35-none", seed: state.seed, passthroughInf: includeInf ? state.passthroughInf : false, featureFingerprint: state.fingerprint, featurePermutation: permutation, featureShiftDecoder: state.featureShiftDecoder, featureShiftCount: state.featureShiftCount };
}

async function execute(request: ParityWorkerRequest): Promise<ParityWorkerSuccess> {
  const tolerance = request.precision === "fp32" ? 1e-4 : 2e-3;
  const adapter = await createTabPFN35Adapter({ precision: request.precision, baseUrl: request.baseUrl });
  const contexts: ModelContext[] = [];
  try {
    await adapter.load({ preferredProvider: request.provider, allowWasmFallback: false });
    const scenarios: ParityScenarioEvidence[] = [];
    for (const input of request.scenarios) {
      const training = { ...dataset(input.xTrain, input.trainShape), target: new Float32Array(input.yTrain), targetName: "target" } as TrainingDataset;
      const prediction = dataset(input.xTest, input.testShape);
      const options = { featureSqlFingerprint: null, sourceSnapshotId: `golden-${input.name}`, preprocessing: preprocessing(input.state, true) } as const;
      const context = await adapter.fitContext(training, options);
      contexts.push(context);
      const repeated = await adapter.fitContext(training, options);
      contexts.push(repeated);
      const exported = await adapter.exportContext(context);
      const cacheTensorCount = exported.payload.kind === "portable-tensors" ? exported.payload.tensors.length : 0;
      const fitted = (exported.estimatorState.values as { readonly fitted?: Parameters<typeof transformFeatures>[1] }).fitted;
      if (!fitted) throw new RuntimeError("CONTEXT_INCOMPATIBLE", `${input.name} context export does not contain fitted preprocessing state`);
      const trainPrepared = transformTrainingFeatures(training, fitted);
      const testPrepared = transformFeatures(prediction, fitted);
      if (trainPrepared.values.length !== input.expectedXTrainModelShape[2] || testPrepared.values.length !== input.expectedXTestModelShape[2]) throw new RuntimeError("RESULT_INVALID", `${input.name} fitted preprocessing feature count differs from the golden`);
      const stageMaxAbsError = {
        xTrainModel: stageError(rowMajor(trainPrepared), input.expectedXTrainModel, `${input.name} x_train_model`),
        xTestModel: stageError(rowMajor(testPrepared), input.expectedXTestModel, `${input.name} x_test_model`),
        yTrainModel: stageError(training.target.map((value) => Math.fround((value - fitted.targetMean) / fitted.targetScale)), input.expectedYTrainModel, `${input.name} y_train_model`),
      };
      if (stageMaxAbsError.xTrainModel > 1e-5 || stageMaxAbsError.xTestModel > 1e-5 || stageMaxAbsError.yTrainModel > 1e-5) throw new RuntimeError("RESULT_INVALID", `${input.name} fitted preprocessing differs from the estimator golden (train=${stageMaxAbsError.xTrainModel}, test=${stageMaxAbsError.xTestModel}, target=${stageMaxAbsError.yTrainModel})`);
      const result = await adapter.predict(context, prediction, { requestId: `golden-${request.provider}-${request.precision}-${input.name}`, inputSnapshotId: `golden-${input.name}`, scenarioId: "baseline" });
      const error = maxAbsError(result.mean, input.expectedMean);
      if (!error.finite || error.value > tolerance) throw new RuntimeError("RESULT_INVALID", `${input.name} ${request.precision} mean error ${error.value} exceeds ${tolerance}`);
      let defaultInfRejected: boolean | undefined;
      if (input.name === "opt-in-inf") {
        try {
          await adapter.fitContext(training, { ...options, preprocessing: preprocessing(input.state, false) });
        } catch (error) {
          defaultInfRejected = error instanceof RuntimeError && error.code === "INF_DISABLED";
        }
        if (!defaultInfRejected) throw new RuntimeError("RESULT_INVALID", "Default TabPFN preprocessing accepted Infinity input");
      }
      scenarios.push({ name: input.name, maxAbsError: error.value, meanRows: result.mean.length, finite: error.finite, cacheTensorCount, contextReused: repeated.identity.key === context.identity.key, stageMaxAbsError, ...(defaultInfRejected === undefined ? {} : { defaultInfRejected }) });
    }
    if (scenarios.some((scenario) => !scenario.contextReused || scenario.cacheTensorCount !== 54)) throw new RuntimeError("RESULT_INVALID", "TabPFN golden context reuse/cache evidence is incomplete");
    return { kind: "success", requestId: request.requestId, provider: request.provider, precision: request.precision, tolerance, scenarios };
  } finally {
    for (const context of contexts.reverse()) await adapter.releaseContext(context).catch(() => undefined);
    await adapter.dispose().catch(() => undefined);
  }
}

export async function runParityRequest(request: ParityWorkerRequest): Promise<ParityWorkerReply> {
  try { return await execute(request); } catch (error) {
    const runtimeError = asRuntimeError(error, "RESULT_INVALID");
    return { kind: "failure", requestId: request.requestId, provider: request.provider, precision: request.precision, error: { code: runtimeError.code, message: runtimeError.message, retryable: runtimeError.retryable } };
  }
}

const scope = globalThis as unknown as { postMessage?: (value: ParityWorkerReply) => void; onmessage?: (event: MessageEvent<ParityWorkerRequest>) => void };
if (typeof scope.postMessage === "function") scope.onmessage = (event) => { void runParityRequest(event.data).then((reply) => scope.postMessage?.(reply)); };
