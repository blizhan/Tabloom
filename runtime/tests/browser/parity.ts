import { RuntimeError, type RuntimeErrorCode } from "../../src/model/errors";
import type { ExecutionProvider } from "../../src/model/types";
import { loadEstimatorGoldenManifest, loadEstimatorGoldenScenario, type BrowserGoldenScenario } from "./estimator-golden";
import { type ParityWorkerReply, type ParityWorkerRequest, type ParityWorkerSuccess } from "./parity.worker";

export interface ParityReport { readonly status: "unavailable" | "ready"; readonly reason?: string; readonly tolerance: { readonly fp32: number; readonly fp16Storage: number }; }
export interface EstimatorParityReport {
  readonly status: "passed" | "unavailable" | "failed";
  readonly provider: ExecutionProvider;
  readonly scenarios: readonly string[];
  readonly variants: readonly ParityWorkerSuccess[];
  readonly unavailable: readonly string[];
  readonly failures: readonly string[];
}
export function parityPrerequisiteReport(hasGolden: boolean, provider: "wasm" | "webgpu"): ParityReport { if (!hasGolden) return { status: "unavailable", reason: `Complete estimator golden is required for ${provider} parity`, tolerance: { fp32: 1e-4, fp16Storage: 2e-3 } }; return { status: "ready", tolerance: { fp32: 1e-4, fp16Storage: 2e-3 } }; }
export function assertFiniteMeans(values: ArrayLike<number>): void { for (let index = 0; index < values.length; index += 1) if (!Number.isFinite(values[index])) throw new RuntimeError("RESULT_INVALID", `Non-finite parity mean at ${index}`); }

function waitWorker(worker: Worker, requestId: string, timeoutMs = 180_000): Promise<ParityWorkerReply> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
    const onMessage = (event: MessageEvent) => { const value = event.data as ParityWorkerReply; if (value?.requestId !== requestId) return; cleanup(); resolve(value); };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message || "parity worker failed")); };
    worker.addEventListener("message", onMessage); worker.addEventListener("error", onError);
    timer = setTimeout(() => { cleanup(); reject(new Error(`parity worker timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
}

function workerInput(scenario: BrowserGoldenScenario): ParityWorkerRequest["scenarios"][number] {
  const train = scenario.arrays.x_train;
  const test = scenario.arrays.x_test;
  const target = scenario.arrays.y_train;
  const trainModel = scenario.arrays.x_train_model;
  const testModel = scenario.arrays.x_test_model;
  const targetModel = scenario.arrays.y_train_model;
  const mean = scenario.arrays.mean;
  if (train.shape.length !== 2 || test.shape.length !== 2 || target.shape.length !== 1 || trainModel.shape.length !== 3 || testModel.shape.length !== 3 || targetModel.shape.length !== 1 || mean.shape.length !== 1 || trainModel.shape[0] !== train.shape[0] || trainModel.shape[1] !== 1 || testModel.shape[0] !== test.shape[0] || testModel.shape[1] !== 1 || targetModel.shape[0] !== target.shape[0]) throw new RuntimeError("SHAPE_UNSUPPORTED", `Estimator golden ${scenario.name} has an invalid stage-input shape`);
  return { name: scenario.name, state: scenario.state, xTrain: new Float32Array(train.values), trainShape: [train.shape[0], train.shape[1]], yTrain: new Float32Array(target.values), xTest: new Float32Array(test.values), testShape: [test.shape[0], test.shape[1]], expectedXTrainModel: new Float32Array(trainModel.values), expectedXTrainModelShape: [trainModel.shape[0], trainModel.shape[1], trainModel.shape[2]], expectedXTestModel: new Float32Array(testModel.values), expectedXTestModelShape: [testModel.shape[0], testModel.shape[1], testModel.shape[2]], expectedYTrainModel: new Float32Array(targetModel.values), expectedMean: new Float32Array(mean.values) };
}

function runtimeErrorCode(value: string): RuntimeErrorCode {
  const codes: readonly RuntimeErrorCode[] = [
    "INVALID_DATA", "SCHEMA_MISMATCH", "SHAPE_UNSUPPORTED", "UNSUPPORTED_CAPABILITY",
    "NONFINITE_TARGET", "INF_DISABLED", "NUMERIC_OVERFLOW", "ARTIFACT_MISMATCH",
    "SNAPSHOT_CORRUPT", "CONTEXT_INCOMPATIBLE", "CONTEXT_RELEASED", "FOREIGN_CONTEXT",
    "PROVIDER_UNAVAILABLE", "DEVICE_LOST", "ADAPTER_DISPOSED", "RESULT_INVALID",
    "STALE_REQUEST", "CANCELLED", "CACHE_QUOTA", "STORAGE_UNAVAILABLE",
  ];
  return codes.includes(value as RuntimeErrorCode) ? value as RuntimeErrorCode : "RESULT_INVALID";
}

async function runVariant(baseUrl: string, provider: ExecutionProvider, precision: "fp32" | "fp16-storage-fp32-compute", scenarios: readonly BrowserGoldenScenario[]): Promise<ParityWorkerSuccess> {
  const worker = new Worker(new URL("./parity.worker.ts", import.meta.url), { type: "module" });
  const requestId = `parity-${provider}-${precision}-${Date.now().toString(36)}`;
  try {
    const replyPromise = waitWorker(worker, requestId);
    worker.postMessage({ kind: "run-parity", requestId, baseUrl, provider, precision, scenarios: scenarios.map(workerInput) } satisfies ParityWorkerRequest);
    const reply = await replyPromise;
    if (reply.kind === "failure") throw new RuntimeError(runtimeErrorCode(reply.error.code), reply.error.message, { retryable: reply.error.retryable });
    return reply;
  } finally { worker.terminate(); }
}

/** Run the complete model path in a dedicated module worker for both artifact
 * precisions. Missing browser/provider evidence can be classified as
 * unavailable, but a model or numerical mismatch remains a failure. */
export async function runEstimatorParity(baseUrl: string, provider: ExecutionProvider): Promise<EstimatorParityReport> {
  const unavailable: string[] = [];
  const failures: string[] = [];
  const variants: ParityWorkerSuccess[] = [];
  try {
    const manifest = await loadEstimatorGoldenManifest(baseUrl);
    const scenarios = await Promise.all(manifest.scenarios.map((record) => loadEstimatorGoldenScenario(baseUrl, record)));
    for (const precision of ["fp32", "fp16-storage-fp32-compute"] as const) {
      try { variants.push(await runVariant(baseUrl, provider, precision, scenarios)); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof RuntimeError ? error.code : undefined;
        const providerUnavailable = code === "PROVIDER_UNAVAILABLE" || (code === "ARTIFACT_MISMATCH" && /unavailable|request failed|404|missing|absent/i.test(message));
        if (providerUnavailable || (provider === "webgpu" && /unavailable|provider|artifact request|timed out/i.test(message))) unavailable.push(`${precision}: ${message}`);
        else failures.push(`${precision}: ${message}`);
      }
    }
    const status = failures.length ? "failed" : unavailable.length || variants.length !== 2 ? "unavailable" : "passed";
    return { status, provider, scenarios: scenarios.map((scenario) => scenario.name), variants, unavailable, failures };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "unavailable", provider, scenarios: [], variants, unavailable: [message], failures };
  }
}
