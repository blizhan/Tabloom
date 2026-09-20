import { RuntimeError } from "../model/errors";
import type { ContextSnapshot, FitContextOptions, ModelContext, ModelLoadOptions, PredictionOptions, TabularDataset, TabularModelAdapter, TrainingDataset } from "../model/types";
import { PROTOCOL_VERSION, assertEnvelope, type WorkerEnvelope, type WorkerReply } from "./protocol";

export class ModelWorkerDispatcher {
  readonly epoch: string; private chain: Promise<unknown> = Promise.resolve(); private disposed = false; private readonly cancelled = new Set<string>(); private readonly running = new Set<string>();
  constructor(private readonly adapter: TabularModelAdapter, epoch = `epoch-${Date.now().toString(36)}`) { this.epoch = epoch; }
  dispatch(message: unknown): Promise<WorkerReply> {
    try { assertEnvelope(message); } catch (error) { return Promise.reject(error); }
    const envelope = message as WorkerEnvelope; if (envelope.workerEpoch !== this.epoch) return Promise.resolve({ kind: "failure", protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId: envelope.requestId, error: { code: "STALE_REQUEST", message: "Worker epoch mismatch", retryable: false } } as WorkerReply);
    if (envelope.operation === "cancel") { const requestId = (envelope.payload as { requestId?: string }).requestId ?? envelope.requestId; this.cancelled.add(requestId); return Promise.resolve({ kind: "cancelled", protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId: envelope.requestId, reason: "cancel acknowledged" }); }
    if (envelope.operation === "status") {
      const diagnostics = (this.adapter as TabularModelAdapter & { diagnostics?: () => Readonly<Record<string, unknown>> }).diagnostics?.();
      return Promise.resolve({ kind: "success", protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId: envelope.requestId, result: { running: [...this.running], cancelled: [...this.cancelled], disposed: this.disposed, ...(diagnostics ? { diagnostics } : {}) } });
    }
    const run = this.chain.then(() => this.handle(envelope)); this.chain = run.then(() => undefined, () => undefined); return run;
  }
  private async handle(message: WorkerEnvelope): Promise<WorkerReply> {
    if (this.disposed && message.operation !== "dispose") return this.failure(message, new RuntimeError("ADAPTER_DISPOSED", "Worker is disposed"));
    this.running.add(message.requestId);
    try {
      let result: unknown;
      switch (message.operation) {
        case "capabilities": result = this.adapter.capabilities(); break;
        case "load": await this.adapter.load(message.payload as ModelLoadOptions); result = undefined; break;
        case "fitContext": { const payload = message.payload as { dataset: TrainingDataset; options: FitContextOptions }; result = await this.adapter.fitContext(payload.dataset, payload.options); break; }
        case "importContext": result = await this.adapter.importContext(message.payload as ContextSnapshot); break;
        case "exportContext": result = await this.adapter.exportContext(message.payload as ModelContext); break;
        case "predict": { const payload = message.payload as { context: ModelContext; dataset: TabularDataset; options: PredictionOptions }; result = await this.adapter.predict(payload.context, payload.dataset, payload.options); break; }
        case "releaseContext": await this.adapter.releaseContext(message.payload as ModelContext); result = undefined; break;
        case "dispose": await this.adapter.dispose(); this.disposed = true; result = undefined; break;
        default: throw new RuntimeError("INVALID_DATA", `Unknown worker operation: ${message.operation}`);
      }
      if (this.cancelled.has(message.requestId)) { this.cancelled.delete(message.requestId); return { kind: "cancelled", protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId: message.requestId, reason: "cancelled" }; }
      return { kind: "success", protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId: message.requestId, result };
    } catch (error) { return this.failure(message, error instanceof RuntimeError ? error : new RuntimeError("RESULT_INVALID", error instanceof Error ? error.message : String(error))); } finally { this.running.delete(message.requestId); }
  }
  private failure(message: WorkerEnvelope, error: RuntimeError): WorkerReply { return { kind: "failure", protocolVersion: PROTOCOL_VERSION, workerEpoch: this.epoch, requestId: message.requestId, error: { code: error.code, message: error.message, stage: error.stage, retryable: error.retryable } }; }
}

export interface WorkerReadyMessage { readonly kind: "ready"; readonly protocolVersion: typeof PROTOCOL_VERSION; readonly workerEpoch: string; }

export function installModelWorker(adapter: TabularModelAdapter): ModelWorkerDispatcher {
  const scope = globalThis as unknown as { postMessage?: (message: unknown) => void; onmessage?: (event: MessageEvent) => void };
  const dispatcher = new ModelWorkerDispatcher(adapter);
  if (typeof scope.postMessage !== "function") return dispatcher;
  // A module worker has no synchronous way for the client to discover its
  // epoch.  Publish a small, non-protocol handshake before accepting work so
  // the client can bind every subsequent request to this worker instance.
  scope.postMessage({ kind: "ready", protocolVersion: PROTOCOL_VERSION, workerEpoch: dispatcher.epoch } satisfies WorkerReadyMessage);
  scope.onmessage = (event) => { void dispatcher.dispatch(event.data).then((reply) => scope.postMessage?.(reply)); };
  return dispatcher;
}
