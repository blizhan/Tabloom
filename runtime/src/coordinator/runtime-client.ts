import { RuntimeError } from "../model/errors";
import type { ContextSnapshot, FitContextOptions, ModelCapabilities, ModelContext, ModelLoadOptions, PredictionOptions, PredictionResult, TabularDataset, TabularModelAdapter, TrainingDataset } from "../model/types";
import { Scheduler, type CancellationToken } from "./scheduler";

export interface RuntimeClientOptions { readonly adapter: TabularModelAdapter; readonly onProgress?: (event: { requestId: string; stage: string; completed: number | null; total: number | null }) => void; }
export class RuntimeClient {
  readonly adapter: TabularModelAdapter; private readonly scheduler = new Scheduler(); private readonly onProgress?: RuntimeClientOptions["onProgress"]; private disposed = false; private requestSequence = 0;
  constructor(options: RuntimeClientOptions) { this.adapter = options.adapter; this.onProgress = options.onProgress; }
  capabilities(): ModelCapabilities { return this.adapter.capabilities(); }
  load(options?: ModelLoadOptions): Promise<void> { return this.guard(() => this.adapter.load(options)); }
  fitContext(dataset: TrainingDataset, options: FitContextOptions, requestId = this.freshRequestId("fit")): Promise<ModelContext> { return this.run(requestId, "model", () => this.adapter.fitContext(dataset, options), (context) => this.adapter.releaseContext(context)); }
  importContext(snapshot: ContextSnapshot, requestId = this.freshRequestId("import")): Promise<ModelContext> { return this.run(requestId, "model", () => this.adapter.importContext(snapshot), (context) => this.adapter.releaseContext(context)); }
  exportContext(context: ModelContext, requestId = this.freshRequestId("export")): Promise<ContextSnapshot> { return this.run(requestId, "model", () => this.adapter.exportContext(context)); }
  predict(context: ModelContext, dataset: TabularDataset, options: PredictionOptions): Promise<PredictionResult> { return this.run(options.requestId, "predict", (token) => { if (token.cancelled) throw new RuntimeError("CANCELLED", "Prediction cancelled"); return this.adapter.predict(context, dataset, options); }); }
  releaseContext(context: ModelContext): Promise<void> { return this.guard(() => this.adapter.releaseContext(context)); }
  cancel(requestId: string): boolean { return this.scheduler.cancel(requestId); }
  status(requestId: string): string { return this.scheduler.status(requestId); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await this.scheduler.dispose(); await this.adapter.dispose(); }
  private guard<T>(task: () => Promise<T>): Promise<T> { if (this.disposed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "Runtime client is disposed")); return task(); }
  private freshRequestId(operation: "fit" | "import" | "export"): string { return `${operation}-${Date.now()}-${++this.requestSequence}`; }
  private run<T>(requestId: string, stage: string, task: (token: CancellationToken) => Promise<T>, releaseCancelledValue?: (value: T) => Promise<void>): Promise<T> { if (this.disposed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "Runtime client is disposed")); this.onProgress?.({ requestId, stage, completed: 0, total: null }); return this.scheduler.enqueue({ requestId, streamId: requestId, mode: "experiment", generation: 0, run: task }).then(async (outcome) => { this.onProgress?.({ requestId, stage, completed: 1, total: 1 }); if (outcome.status === "published") return outcome.value as T; if (outcome.status === "cancelled") { if (releaseCancelledValue && outcome.value !== undefined) await releaseCancelledValue(outcome.value as T); throw new RuntimeError("CANCELLED", `Request ${requestId} cancelled`); } if (outcome.error instanceof Error) throw outcome.error; throw new RuntimeError("RESULT_INVALID", `Request ${requestId} failed`); }); }
}
