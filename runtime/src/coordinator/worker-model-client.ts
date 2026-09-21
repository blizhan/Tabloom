import { RuntimeError, asRuntimeError } from "../model/errors";
import type {
  ContextSnapshot,
  FitContextOptions,
  ModelCapabilities,
  ModelContext,
  ModelLoadOptions,
  PredictionOptions,
  PredictionResult,
  TabularDataset,
  TabularModelAdapter,
  TrainingDataset,
} from "../model/types";
import {
  PROTOCOL_VERSION,
  type WorkerEnvelope,
  type WorkerProgress,
  type WorkerReply,
} from "../workers/protocol";
import type { WorkerReadyMessage } from "../workers/model.worker";
import type { ModelAssetEvent } from "../workbench/model-asset-status";

/** The small subset of Worker used by the runtime. Keeping this structural
 * makes the client testable with a deterministic in-process fake. */
export interface ModelWorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown, transfer?: readonly Transferable[]): void;
  terminate(): void;
}

export interface WorkerModelClientOptions {
  readonly worker: ModelWorkerLike;
  readonly onProgress?: (event: WorkerProgress) => void;
  readonly onAssetEvent?: (event: ModelAssetEvent) => void;
  readonly workerEpoch?: string;
  readonly defaultCapabilities?: ModelCapabilities;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const fallbackCapabilities: ModelCapabilities = {
  taskTypes: ["regression"],
  canBuildContext: true,
  canImportContext: true,
  supportsMissingFeatures: true,
  supportsPassthroughInf: false,
  maxModelFeatures: 32,
  trainRows: { min: 3, max: 1024 },
  predictionRows: { min: 1, max: 1024 },
};

/** Adapter-compatible client for the artifact-bound model worker. It owns no
 * ORT objects: all model state remains inside the worker. */
export class WorkerModelClient implements TabularModelAdapter {
  readonly id = "tabpfn-3.5" as const;
  private readonly worker: ModelWorkerLike;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onProgress?: WorkerModelClientOptions["onProgress"];
  private readonly onAssetEvent?: WorkerModelClientOptions["onAssetEvent"];
  private readonly ready: Promise<void>;
  private epoch: string;
  private capabilitiesValue: ModelCapabilities;
  private sequence = 0;
  private disposed = false;

  constructor(options: WorkerModelClientOptions) {
    this.worker = options.worker;
    this.onProgress = options.onProgress;
    this.onAssetEvent = options.onAssetEvent;
    this.capabilitiesValue = options.defaultCapabilities ?? fallbackCapabilities;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    this.ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    this.epoch = options.workerEpoch ?? "pending";
    this.worker.onmessage = (event) => {
      const message = event.data as WorkerReadyMessage | WorkerReply | WorkerProgress;
      if (message && typeof message === "object" && (message as { kind?: string }).kind === "ready") {
        const readyMessage = message as WorkerReadyMessage;
        if (readyMessage.protocolVersion !== PROTOCOL_VERSION) { readyReject(new RuntimeError("INVALID_DATA", "Unknown model worker protocol")); return; }
        // A ready epoch is authoritative. The constructor override is only a
        // test hook for fakes that do not send a handshake.
        (this as unknown as { epoch: string }).epoch = readyMessage.workerEpoch;
        readyResolve();
        return;
      }
      if (message && typeof message === "object" && (message as { kind?: string }).kind === "model-assets") { this.onAssetEvent?.(message as unknown as ModelAssetEvent); return; }
      if (!message || typeof message !== "object" || !("requestId" in message)) return;
      if ((message as WorkerProgress).kind === "progress") { this.onProgress?.(message as WorkerProgress); return; }
      const reply = message as WorkerReply;
      if (reply.protocolVersion !== PROTOCOL_VERSION || reply.workerEpoch !== this.epoch) return;
      const request = this.pending.get(reply.requestId);
      if (!request) return;
      this.pending.delete(reply.requestId);
      if (reply.kind === "success") { request.resolve(reply.result); return; }
      if (reply.kind === "cancelled" || reply.kind === "superseded") { request.reject(new RuntimeError("CANCELLED", reply.reason)); return; }
      if (reply.kind === "failure") request.reject(new RuntimeError(reply.error.code, reply.error.message, { stage: reply.error.stage, retryable: reply.error.retryable }));
    };
    this.worker.onerror = (event) => {
      const error = new RuntimeError("DEVICE_LOST", event.message || "Model worker failed", { retryable: true });
      readyReject(error);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    // A real worker always sends ready. Test fakes may provide an explicit
    // epoch and begin accepting requests immediately.
    if (options.workerEpoch) readyResolve();
  }

  capabilities(): ModelCapabilities { return this.capabilitiesValue; }

  async load(options?: ModelLoadOptions): Promise<void> {
    await this.request<void>("load", options ?? {});
    try { this.capabilitiesValue = await this.request<ModelCapabilities>("capabilities", {}); }
    catch { /* capability probing is best effort; the load result is authoritative */ }
  }

  fitContext(dataset: TrainingDataset, options: FitContextOptions): Promise<ModelContext> {
    const copy = cloneTrainingDataset(dataset);
    return this.request<ModelContext>("fitContext", { dataset: copy.value, options }, undefined, copy.transfer);
  }

  importContext(snapshot: ContextSnapshot): Promise<ModelContext> { return this.request<ModelContext>("importContext", snapshot); }
  exportContext(context: ModelContext): Promise<ContextSnapshot> { return this.request<ContextSnapshot>("exportContext", context); }
  releaseContext(context: ModelContext): Promise<void> { return this.request<void>("releaseContext", context); }
  predict(context: ModelContext, dataset: TabularDataset, options: PredictionOptions): Promise<PredictionResult> {
    const copy = cloneDataset(dataset);
    return this.request<PredictionResult>("predict", { context, dataset: copy.value, options }, options.requestId, copy.transfer);
  }

  cancel(requestId: string): boolean {
    if (this.disposed) return false;
    const cancelId = this.nextId("cancel");
    this.worker.postMessage({ protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId: cancelId, operation: "cancel", payload: { requestId } } satisfies WorkerEnvelope);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try { await this.request<void>("dispose", {}); } finally { this.worker.terminate(); }
  }

  private nextId(prefix: string): string { return `${prefix}-${Date.now().toString(36)}-${++this.sequence}`; }

  private async request<T>(operation: WorkerEnvelope["operation"], payload: unknown, requestId = this.nextId(operation), transfer: readonly Transferable[] = []): Promise<T> {
    if (this.disposed && operation !== "dispose") throw new RuntimeError("ADAPTER_DISPOSED", "Model worker client is disposed");
    await this.ready;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      try { this.worker.postMessage({ protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId, operation, payload } satisfies WorkerEnvelope, transfer); }
      catch (error) { this.pending.delete(requestId); reject(asRuntimeError(error)); }
    });
  }
}

function cloneDataset(dataset: TabularDataset): { readonly value: TabularDataset; readonly transfer: Transferable[] } {
  const columns = dataset.columns.map((column) => new Float32Array(column));
  return { value: { ...dataset, columns, columnNames: [...dataset.columnNames] }, transfer: columns.map((column) => column.buffer) };
}
function cloneTrainingDataset(dataset: TrainingDataset): { readonly value: TrainingDataset; readonly transfer: Transferable[] } {
  const copy = cloneDataset(dataset);
  const target = new Float32Array(dataset.target);
  return { value: { ...copy.value, target, targetName: dataset.targetName }, transfer: [...copy.transfer, target.buffer] };
}

export function createWorkerModelClient(workerUrl: string, options: Omit<WorkerModelClientOptions, "worker"> = {}): WorkerModelClient {
  const worker = new Worker(workerUrl, { type: "module" });
  return new WorkerModelClient({ ...options, worker });
}
