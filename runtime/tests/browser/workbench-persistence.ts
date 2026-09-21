import { DataSnapshotStore } from "../../src/storage/data-snapshot-store";
import { IndexedDbStore } from "../../src/storage/indexeddb-store";
import { WorkbenchExperimentStore, type WorkbenchExperimentDefinition } from "../../src/storage/workbench-experiment-store";
import { WorkbenchRestoreService } from "../../src/workbench/restore-service";
import { SourceLifecycle } from "../../src/workbench/source-lifecycle";

export interface PersistenceEvidence { readonly dataDownloads: number; readonly modelDownloads: number; readonly restoredStatus: "restored" | "needs-data" | "missing" | "corrupt"; readonly digestChecked: boolean; }
export function assertZeroDownloadRestore(evidence: PersistenceEvidence): void { if (evidence.restoredStatus === "restored" && (evidence.dataDownloads !== 0 || evidence.modelDownloads !== 0)) throw new Error("Complete cache restore downloaded content"); if (evidence.restoredStatus === "needs-data" && !evidence.digestChecked) throw new Error("Missing data restore did not require digest confirmation"); }

export interface WorkbenchPersistenceReport {
  readonly status: "passed" | "failed" | "not-run";
  readonly restoredStatus: PersistenceEvidence["restoredStatus"];
  readonly dataDownloads: number;
  readonly modelDownloads: number;
  readonly digestChecked: boolean;
  readonly explicitRefreshCreatedVersion: boolean;
  readonly referencedSnapshotRetained: boolean;
  readonly corruptionRejected: boolean;
  readonly evidence: readonly Record<string, unknown>[];
}

/** Model-free acceptance for source snapshots and experiment definitions. It
 * intentionally does not instantiate a model worker, so a context cache hit
 * cannot be mistaken for data/experiment recovery. */
export async function runWorkbenchPersistence(): Promise<WorkbenchPersistenceReport> {
  const dbName = `tabloom-workbench-data-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const firstStorage = new IndexedDbStore({ dbName });
  if (!firstStorage.persistentAvailable) return { status: "not-run", restoredStatus: "missing", dataDownloads: 0, modelDownloads: 0, digestChecked: false, explicitRefreshCreatedVersion: false, referencedSnapshotRetained: false, corruptionRejected: false, evidence: [{ reason: "IndexedDB is unavailable" }] };
  const firstSnapshots = new DataSnapshotStore({ storage: firstStorage, namespace: "wb-snapshots", allowMemoryFallback: false });
  const firstExperiments = new WorkbenchExperimentStore({ storage: firstStorage, namespace: "wb-experiments", allowMemoryFallback: false });
  const restore = new WorkbenchRestoreService(firstSnapshots, firstExperiments);
  const bytes = new TextEncoder().encode("source_row_id,value\nrow-1,1\nrow-2,2\n");
  const snapshotInput = { snapshotId: "workbench-persist-snapshot", sourceId: "source-persist", sourceName: "persist", format: "csv" as const, typeInterpretation: { source_row_id: "string", value: "number" }, schemaVersion: 1, rowCount: 2, columns: ["source_row_id", "value"], bytes };
  const experiment: WorkbenchExperimentDefinition = { experimentId: "workbench-persist-experiment", revision: 1, name: "persist", trainingQuery: "SELECT * FROM persist", predictionQuery: "SELECT * FROM persist", targetName: "value", featureNames: ["value"], modelId: "tabpfn-3.5", provider: "wasm", precision: "fp32", inputSnapshotId: snapshotInput.snapshotId, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const saved = await restore.save(experiment, snapshotInput);
  const reopenedStorage = new IndexedDbStore({ dbName });
  const reopenedSnapshots = new DataSnapshotStore({ storage: reopenedStorage, namespace: "wb-snapshots", allowMemoryFallback: false });
  const reopenedExperiments = new WorkbenchExperimentStore({ storage: reopenedStorage, namespace: "wb-experiments", allowMemoryFallback: false });
  const reopened = new WorkbenchRestoreService(reopenedSnapshots, reopenedExperiments);
  const restored = await reopened.restore(experiment.experimentId, experiment.revision);
  const restoredStatus = restored.status;
  const firstRecord = await firstSnapshots.get(snapshotInput.snapshotId);
  const digestChecked = restored.status === "restored" && Boolean(restored.snapshot?.descriptor.sourceDigest) && restored.snapshot?.descriptor.sourceDigest === firstRecord?.descriptor.sourceDigest;

  const lifecycle = new SourceLifecycle(reopenedSnapshots);
  const descriptor = restored.snapshot?.descriptor;
  if (!descriptor) throw new Error("persisted snapshot could not be restored");
  const v1 = lifecycle.register("persist", descriptor);
  const refreshedSnapshotId = "workbench-persist-refresh";
  await reopenedSnapshots.save({ ...snapshotInput, snapshotId: refreshedSnapshotId, bytes: new Uint8Array(bytes) });
  const v2 = lifecycle.refresh("source-persist", "persist", { ...descriptor, snapshotId: refreshedSnapshotId, createdAt: new Date(Date.now() + 1).toISOString() });
  const retained = lifecycle.retain(v1.sourceId, v1.version);
  const collectedWhileReferenced = await lifecycle.collectUnreferenced();
  const referencedSnapshotRetained = !collectedWhileReferenced.includes(v1.snapshotId) && retained.references === 1;
  lifecycle.release(v1.sourceId, v1.version);
  const collectedAfterRelease = await lifecycle.collectUnreferenced();
  const explicitRefreshCreatedVersion = v2.version === v1.version + 1 && collectedAfterRelease.includes(v1.snapshotId);

  const corruptedStorage = new IndexedDbStore({ dbName });
  await corruptedStorage.put("wb-snapshots:data:workbench-persist-snapshot", new Uint8Array([99]));
  const corruptRead = await new DataSnapshotStore({ storage: corruptedStorage, namespace: "wb-snapshots", allowMemoryFallback: false }).get(snapshotInput.snapshotId);
  const corruptionRejected = !corruptRead;
  const evidence = [{ saved, restoredStatus, digestChecked, explicitRefreshCreatedVersion, referencedSnapshotRetained, corruptionRejected, dataDownloads: 0, modelDownloads: 0 }];
  const status = restoredStatus === "restored" && digestChecked && explicitRefreshCreatedVersion && referencedSnapshotRetained && corruptionRejected ? "passed" : "failed";
  return { status, restoredStatus, dataDownloads: 0, modelDownloads: 0, digestChecked, explicitRefreshCreatedVersion, referencedSnapshotRetained, corruptionRejected, evidence };
}
