import { DataSnapshotStore, type StoredDataSnapshot } from "../storage/data-snapshot-store";
import { WorkbenchExperimentStore, type WorkbenchExperimentDefinition } from "../storage/workbench-experiment-store";

export type RestoreStatus = "restored" | "needs-data" | "missing" | "corrupt";
export interface RestoredSourceSnapshot { readonly name: string; readonly snapshot: StoredDataSnapshot; }
export interface RestoreResult { readonly status: RestoreStatus; readonly experiment?: WorkbenchExperimentDefinition; readonly snapshot?: StoredDataSnapshot; readonly sourceSnapshots?: readonly RestoredSourceSnapshot[]; readonly message?: string; }

/** Restores definitions and immutable input bytes, never worker/context handles. */
export class WorkbenchRestoreService {
  constructor(readonly snapshots: DataSnapshotStore = new DataSnapshotStore(), readonly experiments: WorkbenchExperimentStore = new WorkbenchExperimentStore()) {}
  async save(experiment: WorkbenchExperimentDefinition, snapshot?: Parameters<DataSnapshotStore["save"]>[0]): Promise<{ persistent: boolean; warning?: string }> {
    const snapshotResult = snapshot ? await this.snapshots.save(snapshot) : undefined;
    const result = await this.experiments.save(experiment);
    return { persistent: result.persistent && (snapshotResult?.persistent ?? true), warning: result.warning ?? snapshotResult?.warning };
  }
  async restore(experimentId: string, revision?: number): Promise<RestoreResult> {
    const experiment = await this.experiments.get(experimentId, revision);
    if (!experiment) return { status: "missing", message: "Saved experiment was not found" };
    const references: Array<{ readonly label: string; readonly snapshotId: string }> = [];
    const datasetSnapshotId = experiment.dataset?.snapshotId;
    if (datasetSnapshotId) references.push({ label: "Dataset", snapshotId: datasetSnapshotId });
    else references.push({ label: "输入", snapshotId: experiment.inputSnapshotId });
    if (datasetSnapshotId && experiment.inputSnapshotId !== datasetSnapshotId) references.push({ label: "实验输入", snapshotId: experiment.inputSnapshotId });
    for (const binding of experiment.sourceBindings ?? []) references.push({ label: `数据源 ${binding.name}`, snapshotId: binding.snapshotId });

    const snapshots = new Map<string, StoredDataSnapshot>();
    const missing: string[] = [];
    for (const reference of references) {
      if (snapshots.has(reference.snapshotId)) continue;
      const snapshot = await this.snapshots.get(reference.snapshotId);
      if (snapshot) snapshots.set(reference.snapshotId, snapshot);
      else missing.push(`${reference.label}（${reference.snapshotId}）`);
    }
    if (missing.length) return { status: "needs-data", experiment, message: `实验引用的数据快照不可恢复：${missing.join("、")}。请重新导入并核对数据摘要。` };

    const snapshot = snapshots.get(datasetSnapshotId ?? experiment.inputSnapshotId);
    if (!snapshot) return { status: "corrupt", experiment, message: "实验快照引用不完整，无法恢复。" };
    const sourceSnapshots = (experiment.sourceBindings ?? []).map((binding) => ({ name: binding.name, snapshot: snapshots.get(binding.snapshotId)! }));
    return { status: "restored", experiment, snapshot, sourceSnapshots };
  }
}
