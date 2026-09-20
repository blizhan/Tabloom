import { RuntimeError } from "../model/errors";
import { InputSnapshotStore } from "./input-snapshots";
import type { RunRecord } from "./result-publication";

export interface Experiment { readonly experimentId: string; readonly name: string; readonly requestIds: readonly string[]; readonly snapshotIds: readonly string[]; readonly createdAt: string; }
export class ExperimentStore {
  private readonly experiments = new Map<string, Experiment>(); private sequence = 0;
  constructor(private readonly snapshots?: InputSnapshotStore) {}
  create(name: string, runs: readonly RunRecord[]): Experiment { const snapshotIds = [...new Set(runs.map((run) => run.inputSnapshotId))]; snapshotIds.forEach((id) => this.snapshots?.retain(id)); const experiment = { experimentId: `experiment-${++this.sequence}`, name, requestIds: runs.map((run) => run.requestId), snapshotIds, createdAt: new Date().toISOString() }; this.experiments.set(experiment.experimentId, experiment); return experiment; }
  get(id: string): Experiment { const experiment = this.experiments.get(id); if (!experiment) throw new RuntimeError("INVALID_DATA", `Unknown experiment: ${id}`); return { ...experiment, requestIds: [...experiment.requestIds], snapshotIds: [...experiment.snapshotIds] }; }
  delete(id: string): void { const experiment = this.experiments.get(id); if (!experiment) return; experiment.snapshotIds.forEach((snapshotId) => this.snapshots?.release(snapshotId)); this.experiments.delete(id); }
}
