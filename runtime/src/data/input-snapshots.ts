import { RuntimeError } from "../model/errors";
import type { TabularDataset, TrainingDataset } from "../model/types";
import { cloneDataset } from "./arrow-dataset";

export interface SnapshotProvenance { readonly sql?: string; readonly typedParams?: readonly unknown[]; readonly featureNames: readonly string[]; readonly targetName?: string; readonly source?: string; }
export interface InputSnapshot {
  readonly inputSnapshotId: string; readonly rowCount: number; readonly rowOrdinal: readonly number[]; readonly businessKeys: readonly unknown[];
  readonly businessRows: readonly unknown[]; readonly dataset: TabularDataset | TrainingDataset; readonly parentSnapshotId?: string; readonly scenarioId?: string;
  readonly modifications?: Readonly<Record<string, unknown>>; readonly provenance?: SnapshotProvenance; readonly retained: number;
}
let nextId = 0;
function freshId(prefix: string): string { return `${prefix}-${Date.now().toString(36)}-${(++nextId).toString(36)}`; }
function cloneSnapshot(snapshot: InputSnapshot): InputSnapshot { return { ...snapshot, rowOrdinal: [...snapshot.rowOrdinal], businessKeys: [...snapshot.businessKeys], businessRows: [...snapshot.businessRows], dataset: cloneDataset(snapshot.dataset), provenance: snapshot.provenance ? { ...snapshot.provenance, featureNames: [...snapshot.provenance.featureNames], typedParams: snapshot.provenance.typedParams ? [...snapshot.provenance.typedParams] : undefined } : undefined, modifications: snapshot.modifications ? { ...snapshot.modifications } : undefined }; }

export class InputSnapshotStore {
  private readonly snapshots = new Map<string, InputSnapshot>();
  create(dataset: TabularDataset | TrainingDataset, businessKeys: readonly unknown[] = [], options: { parentSnapshotId?: string; scenarioId?: string; businessRows?: readonly unknown[]; modifications?: Readonly<Record<string, unknown>>; provenance?: SnapshotProvenance } = {}): InputSnapshot {
    if (!dataset || dataset.rowCount <= 0 || dataset.columns.some((column) => column.length !== dataset.rowCount)) throw new RuntimeError("INVALID_DATA", "Invalid snapshot dataset");
    if (businessKeys.length && businessKeys.length !== dataset.rowCount) throw new RuntimeError("INVALID_DATA", "Business key length mismatch");
    const id = freshId("input"); const snapshot: InputSnapshot = { inputSnapshotId: id, rowCount: dataset.rowCount, rowOrdinal: Array.from({ length: dataset.rowCount }, (_, i) => i), businessKeys: [...businessKeys], businessRows: [...(options.businessRows ?? businessKeys)], dataset: cloneDataset(dataset), parentSnapshotId: options.parentSnapshotId, scenarioId: options.scenarioId, modifications: options.modifications ? { ...options.modifications } : undefined, provenance: options.provenance, retained: 1 };
    this.snapshots.set(id, snapshot); return cloneSnapshot(snapshot);
  }
  get(id: string): InputSnapshot { const snapshot = this.snapshots.get(id); if (!snapshot) throw new RuntimeError("INVALID_DATA", `Unknown input snapshot: ${id}`); return cloneSnapshot(snapshot); }
  retain(id: string): InputSnapshot { const old = this.snapshots.get(id); if (!old) throw new RuntimeError("INVALID_DATA", `Unknown input snapshot: ${id}`); const next = { ...old, retained: old.retained + 1 }; this.snapshots.set(id, next); return cloneSnapshot(next); }
  release(id: string): void { const old = this.snapshots.get(id); if (!old) return; const retained = old.retained - 1; if (retained <= 0) this.snapshots.delete(id); else this.snapshots.set(id, { ...old, retained }); }
  deriveScenario(baseId: string, dataset: TabularDataset, scenarioId: string, modifications: Readonly<Record<string, unknown>> = {}): InputSnapshot { const base = this.get(baseId); const keys = dataset.rowCount === base.rowCount ? base.businessKeys : Array.from({ length: dataset.rowCount }, (_, index) => base.businessKeys[index]); const rows = dataset.rowCount === base.rowCount ? base.businessRows : keys; this.retain(baseId); try { return this.create(dataset, keys, { parentSnapshotId: baseId, scenarioId, businessRows: rows, modifications, provenance: base.provenance }); } catch (error) { this.release(baseId); throw error; } }
  retainSnapshot(id: string): InputSnapshot { return this.retain(id); }
  releaseSnapshot(id: string): void { this.release(id); }
  has(id: string): boolean { return this.snapshots.has(id); }
  get size(): number { return this.snapshots.size; }
}
