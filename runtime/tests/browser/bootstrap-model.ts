import type { ContextHandle, TabularDataset, TrainingDataset } from "../../src/model/types";
import { PROTOCOL_VERSION, type WorkerReply } from "../../src/workers/protocol";
import type { BootstrapChainWorkerReply, BootstrapChainWorkerRequest, BootstrapChainWorkerSuccess, BootstrapWorkerDiagnostics } from "./bootstrap-model.worker";

export interface BootstrapModelReport {
  readonly provider: "wasm" | "webgpu";
  readonly status: "supported";
  readonly workerEpoch: string;
  readonly inference: "ort";
  readonly contextReused: boolean;
  readonly cacheTensorCount: number;
  readonly predictionRows: number;
  readonly meansFinite: boolean;
  readonly sharedDataFetches: number;
  /** Raw context-chain evidence from the dedicated module worker. */
  readonly contextChain: BootstrapChainWorkerSuccess;
  readonly diagnostics: {
    readonly wasmProxy: boolean | null;
    readonly wasmNumThreads: number | null;
    readonly wasmPathsConfigured: boolean;
    readonly sharedExternalDataConfigured: boolean;
    readonly sharedExternalDataBytes: number;
    readonly builderReleasedBeforePredict: boolean;
  };
}

type WorkerLike = Worker;
type ChainWorkerLike = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;
interface Ready { readonly kind: "ready"; readonly protocolVersion: 1; readonly workerEpoch: string; }
function waitMessage(worker: WorkerLike, predicate: (value: unknown) => boolean, timeoutMs = 180_000): Promise<any> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (event: MessageEvent) => { if (!predicate(event.data)) return; cleanup(); resolve(event.data); };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message)); };
    const cleanup = () => { if (timer) clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
    worker.addEventListener("message", onMessage); worker.addEventListener("error", onError);
    timer = setTimeout(() => { cleanup(); reject(new Error(`model bootstrap worker timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
}

async function call<T = unknown>(worker: WorkerLike, epoch: string, requestId: string, operation: string, payload: unknown): Promise<Extract<WorkerReply<T>, { kind: "success" }>> {
  const reply = waitMessage(worker, (value) => Boolean(value && typeof value === "object" && (value as { requestId?: string }).requestId === requestId));
  worker.postMessage({ protocolVersion: PROTOCOL_VERSION, workerEpoch: epoch, requestId, operation, payload });
  const value = await reply as WorkerReply;
  if (value.kind === "failure") throw new Error(`${value.error.code}: ${value.error.message}`);
  if (value.kind !== "success") throw new Error(`${value.kind}: ${value.reason}`);
  return value as Extract<WorkerReply<T>, { kind: "success" }>;
}

function waitChainReply(worker: ChainWorkerLike, requestId: string, timeoutMs = 180_000): Promise<BootstrapChainWorkerReply> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
    const onMessage = (event: MessageEvent) => { const value = event.data as BootstrapChainWorkerReply; if (value?.requestId !== requestId) return; cleanup(); resolve(value); };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message || "context-chain bootstrap worker failed")); };
    worker.addEventListener("message", onMessage); worker.addEventListener("error", onError);
    timer = setTimeout(() => { cleanup(); reject(new Error(`context-chain bootstrap worker timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
}

function fixture(): { training: TrainingDataset; prediction: TabularDataset } {
  const rows = 4; const feature = new Float32Array([1, 2, 3, 4]); const second = new Float32Array([4, 3, 2, 1]);
  return {
    training: { columns: [feature, second], columnNames: ["x", "y"], rowCount: rows, target: new Float32Array([2, 4, 6, 8]), targetName: "target" },
    prediction: { columns: [new Float32Array([5, 6]), new Float32Array([0, 1])], columnNames: ["x", "y"], rowCount: 2 },
  };
}

export async function bootstrapModel(workerFactory: () => WorkerLike, provider: "wasm" | "webgpu" = "wasm", options: { readonly baseUrl?: string; readonly contextChainWorkerFactory: () => ChainWorkerLike; readonly precision?: BootstrapChainWorkerRequest["precision"] } ): Promise<BootstrapModelReport> {
  const worker = workerFactory();
  try {
    const ready = await waitMessage(worker, (value) => Boolean(value && (value as Ready).kind === "ready")) as Ready;
    await call(worker, ready.workerEpoch, "bootstrap-load", "load", { preferredProvider: provider, allowWasmFallback: false });
    const { training, prediction } = fixture();
    const fit = await call(worker, ready.workerEpoch, "bootstrap-fit", "fitContext", { dataset: training, options: { featureSqlFingerprint: null, sourceSnapshotId: "bootstrap-training", preprocessing: { profile: "tabpfn35-none", seed: 7 } } });
    const context = fit.result as ContextHandle;
    const secondFit = await call(worker, ready.workerEpoch, "bootstrap-fit-again", "fitContext", { dataset: training, options: { featureSqlFingerprint: null, sourceSnapshotId: "bootstrap-training", preprocessing: { profile: "tabpfn35-none", seed: 7 } } });
    const reused = (secondFit.result as ContextHandle).identity.key === context.identity.key;
    const afterFitStatus = await call<{ readonly diagnostics?: BootstrapWorkerDiagnostics }>(worker, ready.workerEpoch, "bootstrap-status-after-fit", "status", undefined);
    const exported = await call(worker, ready.workerEpoch, "bootstrap-export", "exportContext", context);
    const snapshot = exported.result as { readonly payload?: { readonly kind?: string; readonly tensors?: readonly unknown[] } };
    const cacheTensorCount = snapshot.payload?.kind === "portable-tensors" ? snapshot.payload.tensors?.length ?? 0 : 0;
    if (cacheTensorCount !== 54) throw new Error(`Expected 54 TabPFN cache tensors, received ${cacheTensorCount}`);
    const predicted = await call(worker, ready.workerEpoch, "bootstrap-predict", "predict", { context, dataset: prediction, options: { requestId: "bootstrap-predict", inputSnapshotId: "bootstrap-input", scenarioId: "baseline" } });
    const result = predicted.result as { readonly mean?: ArrayLike<number>; readonly metadata?: { readonly inference?: string } };
    const meansFinite = Boolean(result.mean) && Array.from(result.mean ?? [], Number).every(Number.isFinite);
    if (result.metadata?.inference !== "ort") throw new Error(`Expected ORT inference, received ${result.metadata?.inference ?? "missing"}`);
    if (!meansFinite || result.mean?.length !== prediction.rowCount) throw new Error("TabPFN worker returned invalid prediction means");
    const diagnostics = afterFitStatus.result.diagnostics?.ort;
    if (!diagnostics) throw new Error("Model worker did not expose primitive ORT diagnostics");
    const builderReleasedBeforePredict = diagnostics.builderActive === false;
    if (!builderReleasedBeforePredict) throw new Error("TabPFN context builder remained active after fitContext");
    if (provider === "wasm" && (diagnostics.wasmProxy !== false || diagnostics.wasmNumThreads !== 1 || diagnostics.wasmPathsConfigured !== true)) throw new Error("WASM module-worker ORT configuration is not proxy=false/one-thread/explicit-path");
    if (diagnostics.sharedExternalDataConfigured !== true || (diagnostics.sharedExternalDataBytes ?? 0) <= 0) throw new Error("TabPFN sessions did not receive shared external-data bytes");
    const sharedDataFetches = afterFitStatus.result.diagnostics?.artifacts?.files?.["tabpfn35-shared.data"] ?? 0;
    if (sharedDataFetches > 1) throw new Error(`Expected at most one shared TabPFN external-data fetch, received ${sharedDataFetches}`);
    await call(worker, ready.workerEpoch, "bootstrap-release", "releaseContext", context);
    await call(worker, ready.workerEpoch, "bootstrap-dispose", "dispose", undefined);
    const contextChainWorker = options.contextChainWorkerFactory();
    const contextChainRequestId = `bootstrap-context-chain-${provider}-${Date.now().toString(36)}`;
    try {
      const replyPromise = waitChainReply(contextChainWorker, contextChainRequestId);
      contextChainWorker.postMessage({ kind: "run-context-chain", requestId: contextChainRequestId, baseUrl: options.baseUrl ?? location.origin, provider, precision: options.precision ?? "fp16-storage-fp32-compute" } satisfies BootstrapChainWorkerRequest);
      const actual = await replyPromise;
      if (actual.kind === "failure") throw new Error(`${actual.error.code}: ${actual.error.message}`);
      if (actual.provider !== provider || actual.scenarioCount < 1 || actual.scenarios.some((scenario) => scenario.cacheTensorCount !== 54 || !scenario.independentCacheCopies || !scenario.builderReleasedBeforePredict)) throw new Error("Context-chain worker returned incomplete cache/release evidence");
      return { provider, status: "supported", workerEpoch: ready.workerEpoch, inference: "ort", contextReused: reused, cacheTensorCount, predictionRows: prediction.rowCount, meansFinite, sharedDataFetches, diagnostics: { wasmProxy: diagnostics.wasmProxy ?? null, wasmNumThreads: diagnostics.wasmNumThreads ?? null, wasmPathsConfigured: diagnostics.wasmPathsConfigured === true, sharedExternalDataConfigured: diagnostics.sharedExternalDataConfigured === true, sharedExternalDataBytes: diagnostics.sharedExternalDataBytes ?? 0, builderReleasedBeforePredict }, contextChain: actual };
    } finally { contextChainWorker.terminate(); }
  } finally {
    worker.terminate();
  }
}
