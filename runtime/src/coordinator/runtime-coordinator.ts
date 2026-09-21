import { RuntimeError } from "../model/errors";
import { InputSnapshotStore, type InputSnapshot } from "../data/input-snapshots";
import { ResultPublicationService, type Reservation, type ResultRow } from "../data/result-publication";
import { DuckDbService } from "../data/duckdb-service";
import { ContextStore } from "../storage/context-store";
import { TabPFN35Adapter } from "../model/tabpfn35/adapter";
import type { ContextSnapshot, FitContextOptions, ModelContext, ModelLoadOptions, PredictionOptions, PredictionResult, TabularDataset, TrainingDataset } from "../model/types";
import { RuntimeClient } from "./runtime-client";
import { Scheduler, type ScheduleOutcome } from "./scheduler";
import { ProgressTracker } from "../diagnostics/progress";

export interface RuntimeCoordinatorOptions { readonly client?: RuntimeClient; readonly adapter?: TabPFN35Adapter; readonly inputSnapshots?: InputSnapshotStore; readonly publication?: ResultPublicationService; readonly duckdb?: DuckDbService; readonly contextStore?: ContextStore; }
export interface SubmitPredictionOptions { readonly streamId: string; readonly generation: number; readonly epoch: string; readonly scenarioId: string; readonly requestId: string; readonly inputSnapshot: InputSnapshot; readonly context: ModelContext; readonly mode?: "interactive" | "experiment"; }
export class RuntimeCoordinator {
  readonly inputSnapshots: InputSnapshotStore; readonly publication: ResultPublicationService; readonly duckdb: DuckDbService; readonly contextStore: ContextStore; readonly progress = new ProgressTracker(); readonly client: RuntimeClient; private readonly scheduler = new Scheduler(); private disposed = false;
  constructor(options: RuntimeCoordinatorOptions = {}) {
    this.inputSnapshots = options.inputSnapshots ?? new InputSnapshotStore();
    this.publication = options.publication ?? new ResultPublicationService({ snapshotRetention: { retain: (snapshotId) => { this.inputSnapshots.retainSnapshot(snapshotId); }, release: (snapshotId) => { this.inputSnapshots.releaseSnapshot(snapshotId); } } });
    this.duckdb = options.duckdb ?? new DuckDbService(undefined, this.inputSnapshots); this.contextStore = options.contextStore ?? new ContextStore(); this.client = options.client ?? new RuntimeClient({ adapter: options.adapter ?? new TabPFN35Adapter() });
  }
  capabilities() { return this.client.capabilities(); }
  load(options?: ModelLoadOptions): Promise<void> { return this.client.load(options); }
  createTrainingSnapshot(dataset: TrainingDataset, businessKeys: readonly unknown[] = [], provenance?: InputSnapshot["provenance"]): InputSnapshot { return this.inputSnapshots.create(dataset, businessKeys, { provenance }); }
  createPredictionSnapshot(dataset: TabularDataset, businessKeys: readonly unknown[] = [], provenance?: InputSnapshot["provenance"]): InputSnapshot { return this.inputSnapshots.create(dataset, businessKeys, { provenance }); }
  fitContext(dataset: TrainingDataset, options: FitContextOptions, requestId?: string): Promise<ModelContext> { return this.client.fitContext(dataset, options, requestId); }
  predict(context: ModelContext, dataset: TabularDataset, options: PredictionOptions): Promise<PredictionResult> { return this.client.predict(context, dataset, options); }
  async submitPrediction(input: SubmitPredictionOptions): Promise<ScheduleOutcome<readonly ResultRow[]>> {
    if (this.disposed) throw new RuntimeError("ADAPTER_DISPOSED", "Runtime coordinator is disposed");
    const reservation = await this.publication.reserve({ requestId: input.requestId, streamId: input.streamId, generation: input.generation, epoch: input.epoch, inputSnapshotId: input.inputSnapshot.inputSnapshotId, scenarioId: input.scenarioId, experiment: input.mode === "experiment" });
    this.progress.start(input.requestId, "predicting", input.inputSnapshot.rowCount);
    const outcome = await this.scheduler.enqueue({ requestId: input.requestId, streamId: input.streamId, mode: input.mode ?? "interactive", generation: input.generation, run: async (token) => {
      if (token.cancelled) { await this.publication.cancel(input.requestId); throw new RuntimeError("CANCELLED", "Prediction cancelled"); }
      const result = await this.client.predict(input.context, input.inputSnapshot.dataset as TabularDataset, { requestId: input.requestId, inputSnapshotId: input.inputSnapshot.inputSnapshotId, scenarioId: input.scenarioId });
      if (token.cancelled) { await this.publication.cancel(input.requestId); throw new RuntimeError("CANCELLED", "Prediction cancelled"); }
      const rows = await this.publication.publish(reservation, result, input.inputSnapshot);
      try { await this.duckdb.registerResults(input.requestId, rows); }
      catch (error) { await this.publication.rollback(input.requestId, error instanceof Error ? error.message : String(error)); throw error; }
      this.progress.finish(input.requestId, "complete"); return rows;
    } });
    if (outcome.status !== "published") { await this.publication.cancel(input.requestId, outcome.status); this.progress.finish(input.requestId, outcome.status === "cancelled" ? "cancelled" : "failed"); }
    return outcome;
  }
  cancel(requestId: string): boolean { const cancelled = this.scheduler.cancel(requestId); if (cancelled) void this.publication.cancel(requestId); return cancelled; }
  current(streamId: string): readonly ResultRow[] { const run = this.publication.current(streamId); return run?.rows ? [...run.rows] : []; }
  history(streamId: string) { return this.publication.history(streamId); }
  async saveContext(context: ModelContext): Promise<{ persistent: boolean; warning?: string }> { const snapshot = await this.client.exportContext(context); return this.contextStore.save(snapshot); }
  async restoreContext(snapshotOrKey: ContextSnapshot | string): Promise<ModelContext | undefined> { const snapshot = typeof snapshotOrKey === "string" ? await this.contextStore.load(snapshotOrKey) : snapshotOrKey; if (!snapshot) return undefined; return this.client.importContext(snapshot); }
  async waitForIdle(): Promise<void> { await this.scheduler.waitForIdle(); await this.publication.waitForIdle(); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; await this.scheduler.dispose(); await this.client.dispose(); await this.duckdb.close(); }
}
