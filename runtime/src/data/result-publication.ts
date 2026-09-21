import { RuntimeError } from "../model/errors";
import type { PredictionResult } from "../model/types";
import type { InputSnapshot } from "./input-snapshots";

export interface ResultRow { readonly requestId: string; readonly inputSnapshotId: string; readonly rowOrdinal: number; readonly businessKey?: unknown; readonly scenarioId: string; readonly contextKey: string; readonly mean: number; readonly q25?: number; readonly q75?: number; readonly metadata: PredictionResult["metadata"]; readonly createdAt: string; }
export interface RunRecord { readonly requestId: string; readonly streamId: string; readonly generation: number; readonly epoch: string; readonly status: "pending" | "published" | "cancelled" | "superseded" | "failed"; readonly inputSnapshotId: string; readonly scenarioId: string; readonly experiment?: boolean; readonly rows?: readonly ResultRow[]; readonly error?: string; }
export interface Reservation { readonly requestId: string; readonly streamId: string; readonly generation: number; readonly epoch: string; readonly inputSnapshotId: string; readonly scenarioId: string; readonly experiment: boolean; }
export interface SnapshotRetention {
  /** Keep a snapshot alive while a reservation/result refers to it. */
  readonly retain: (snapshotId: string) => void;
  /** Release the reservation-owned reference after terminal cleanup. */
  readonly release: (snapshotId: string) => void;
}
export interface ResultPublicationOptions { readonly snapshotRetention?: SnapshotRetention; }
interface MutableRun extends RunRecord { status: RunRecord["status"]; rows?: readonly ResultRow[]; error?: string; snapshotRetained: boolean; previousBaselineRequestId?: string; }

export class ResultPublicationService {
  private readonly runs = new Map<string, MutableRun>(); private readonly heads = new Map<string, number>(); private readonly baseline = new Map<string, string>(); private queue: Promise<void> = Promise.resolve();
  private readonly snapshotRetention?: SnapshotRetention;
  constructor(options: ResultPublicationOptions = {}) { this.snapshotRetention = options.snapshotRetention; }
  private serial<T>(task: () => T | Promise<T>): Promise<T> { const run = this.queue.then(task); this.queue = run.then(() => undefined, () => undefined); return run; }
  private retainSnapshot(snapshotId: string): void { this.snapshotRetention?.retain(snapshotId); }
  private releaseSnapshot(run: MutableRun): void { if (!run.snapshotRetained) return; run.snapshotRetained = false; this.snapshotRetention?.release(run.inputSnapshotId); }
  reserve(input: Omit<Reservation, "experiment"> & { experiment?: boolean }): Promise<Reservation> { return this.serial(() => {
    if (this.runs.has(input.requestId)) throw new RuntimeError("INVALID_DATA", "Request id is already registered");
    const isBaseline = input.scenarioId === "baseline" || input.generation === 0;
    const hasCurrent = this.heads.has(input.streamId); const current = this.heads.get(input.streamId) ?? -1;
    if (!input.experiment && !isBaseline && hasCurrent && input.generation <= current) throw new RuntimeError("STALE_REQUEST", "Scenario generation is not newer than the current head");
    // A reservation owns one reference until it is deleted or reaches a
    // terminal failure.  Retaining before mutating the publication indexes
    // means a missing snapshot cannot leave a half-registered run behind.
    this.retainSnapshot(input.inputSnapshotId);
    if (!input.experiment && (!isBaseline || !hasCurrent)) {
      this.heads.set(input.streamId, input.generation);
      for (const old of this.runs.values()) if (old.streamId === input.streamId && old.status === "pending" && old.generation < input.generation && old.scenarioId !== "baseline") {
        old.status = "superseded"; old.error = "newer generation exists"; this.releaseSnapshot(old);
      }
    }
    const run: MutableRun = { requestId: input.requestId, streamId: input.streamId, generation: input.generation, epoch: input.epoch, status: "pending", inputSnapshotId: input.inputSnapshotId, scenarioId: input.scenarioId, experiment: input.experiment ?? false, snapshotRetained: true };
    this.runs.set(input.requestId, run); return { ...input, experiment: input.experiment ?? false };
  }); }
  cancel(requestId: string, reason = "cancelled"): Promise<void> { return this.serial(() => { const run = this.runs.get(requestId); if (!run || run.status === "published" || run.status === "cancelled" || run.status === "superseded" || run.status === "failed") return; run.status = "cancelled"; run.error = reason; this.releaseSnapshot(run); }); }
  publish(reservation: Reservation, result: PredictionResult, snapshot: InputSnapshot): Promise<readonly ResultRow[]> { return this.serial(() => {
    const run = this.runs.get(reservation.requestId); if (!run || run.status !== "pending") throw new RuntimeError("STALE_REQUEST", "Reservation is no longer publishable");
    if (run.epoch !== reservation.epoch || run.inputSnapshotId !== snapshot.inputSnapshotId || result.requestId !== reservation.requestId || result.inputSnapshotId !== snapshot.inputSnapshotId || result.scenarioId !== reservation.scenarioId || result.contextKey.length === 0 || result.mean.length !== snapshot.rowCount) { const reason = "result identity or row count mismatch"; this.failRun(run, reason); throw new RuntimeError("RESULT_INVALID", reason); }
    const isBaseline = reservation.scenarioId === "baseline" || reservation.generation === 0;
    const current = this.heads.get(reservation.streamId) ?? reservation.generation; if (!reservation.experiment && !isBaseline && current !== reservation.generation) { run.status = "superseded"; run.error = "newer generation exists"; this.releaseSnapshot(run); throw new RuntimeError("STALE_REQUEST", run.error); }
    let rows: ResultRow[];
    try {
      if (Boolean(result.q25) !== Boolean(result.q75) || (result.q25 && (result.q25.length !== snapshot.rowCount || result.q75!.length !== snapshot.rowCount))) throw new RuntimeError("RESULT_INVALID", "Quantile row counts do not match");
      const ordinals = result.rowOrdinal ? [...result.rowOrdinal] : Array.from({ length: result.mean.length }, (_, index) => index);
      if (ordinals.length !== snapshot.rowCount || new Set(ordinals).size !== snapshot.rowCount || ordinals.some((ordinal) => !Number.isInteger(ordinal) || ordinal < 0 || ordinal >= snapshot.rowCount)) throw new RuntimeError("RESULT_INVALID", "Prediction row identities are not a complete permutation");
      rows = Array.from({ length: snapshot.rowCount }, (_unused, outputIndex) => {
        const rowOrdinal = ordinals[outputIndex];
        const mean = result.mean[outputIndex];
        if (!Number.isFinite(mean)) throw new RuntimeError("RESULT_INVALID", `Non-finite prediction at row ${rowOrdinal}`);
        const q25 = result.q25?.[outputIndex]; const q75 = result.q75?.[outputIndex];
        if (q25 !== undefined && (!Number.isFinite(q25) || !Number.isFinite(q75) || q25 > q75!)) throw new RuntimeError("RESULT_INVALID", "Invalid quantile interval");
        return { q25, q75, requestId: reservation.requestId, inputSnapshotId: snapshot.inputSnapshotId, rowOrdinal, businessKey: snapshot.businessKeys[rowOrdinal], scenarioId: reservation.scenarioId, contextKey: result.contextKey, mean, metadata: result.metadata, createdAt: new Date().toISOString() };
      });
    } catch (error) { this.failRun(run, error instanceof Error ? error.message : String(error)); throw error; }
    run.status = "published"; run.rows = rows; if (isBaseline) { run.previousBaselineRequestId = this.baseline.get(reservation.streamId); this.baseline.set(reservation.streamId, reservation.requestId); } return rows;
  }); }
  getRun(requestId: string): RunRecord | undefined { const run = this.runs.get(requestId); return run ? { ...run, rows: run.rows ? [...run.rows] : undefined } : undefined; }
  current(streamId: string): RunRecord | undefined { const head = this.heads.get(streamId); if (head === undefined) return undefined; return [...this.runs.values()].filter((run) => run.streamId === streamId && run.generation === head && run.status === "published").at(-1); }
  baselineRun(streamId: string): RunRecord | undefined { const requestId = this.baseline.get(streamId); return requestId ? this.getRun(requestId) : undefined; }
  history(streamId: string): readonly RunRecord[] { return [...this.runs.values()].filter((run) => run.streamId === streamId).map((run) => ({ ...run, rows: run.rows ? [...run.rows] : undefined })); }
  queryRows(requestId: string): readonly ResultRow[] { return this.runs.get(requestId)?.rows ? [...this.runs.get(requestId)!.rows!] : []; }
  /** Mark a just-published run failed when the database transaction cannot
   * commit. The previous successful generation remains the visible head. */
  rollback(requestId: string, reason: string): Promise<void> { return this.serial(() => { const run = this.runs.get(requestId); if (!run || run.status !== "published") return; const wasBaseline = this.baseline.get(run.streamId) === requestId; run.status = "failed"; run.error = reason; run.rows = undefined; this.releaseSnapshot(run); const candidates = [...this.runs.values()].filter((item) => item.streamId === run.streamId && item.status === "published" && !item.experiment); const next = candidates.sort((a, b) => b.generation - a.generation)[0]; if (next) this.heads.set(run.streamId, next.generation); else this.heads.delete(run.streamId); if (wasBaseline) { const previous = run.previousBaselineRequestId ? this.runs.get(run.previousBaselineRequestId) : undefined; if (previous?.status === "published") this.baseline.set(run.streamId, previous.requestId); else this.baseline.delete(run.streamId); } }); }
  delete(requestId: string, releaseSnapshot?: (snapshotId: string) => void): Promise<void> { return this.serial(() => { const run = this.runs.get(requestId); if (!run) return; this.releaseSnapshot(run); if (run.rows) releaseSnapshot?.(run.inputSnapshotId); this.runs.delete(requestId); if (this.baseline.get(run.streamId) === requestId) this.baseline.delete(run.streamId); }); }
  async waitForIdle(): Promise<void> { await this.queue; }
  private failRun(run: MutableRun, reason: string): void { run.status = "failed"; run.error = reason; run.rows = undefined; this.releaseSnapshot(run); const candidates = [...this.runs.values()].filter((item) => item.streamId === run.streamId && item.status === "published" && !item.experiment); const next = candidates.sort((a, b) => b.generation - a.generation)[0]; if (next) this.heads.set(run.streamId, next.generation); else this.heads.delete(run.streamId); }
}

export const ResultTable = ResultPublicationService;
