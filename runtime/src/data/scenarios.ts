import { RuntimeError } from "../model/errors";
import type { TabularDataset } from "../model/types";
import { InputSnapshotStore, type InputSnapshot } from "./input-snapshots";

export interface ScenarioDescriptor { readonly scenarioId: string; readonly baselineSnapshotId: string; readonly snapshotId: string; readonly parentSnapshotId: string; readonly modifications: Readonly<Record<string, unknown>>; readonly rowOrdinalMapping: readonly number[]; readonly createdAt: string; }
let sequence = 0;
export function deriveScenario(store: InputSnapshotStore, baseline: InputSnapshot | string, dataset: TabularDataset, modifications: Readonly<Record<string, unknown>> = {}, scenarioId = `scenario-${++sequence}`): { snapshot: InputSnapshot; descriptor: ScenarioDescriptor } {
  const baselineSnapshot = typeof baseline === "string" ? store.get(baseline) : baseline; if (!store.has(baselineSnapshot.inputSnapshotId)) throw new RuntimeError("INVALID_DATA", "Baseline snapshot is not registered");
  const snapshot = store.deriveScenario(baselineSnapshot.inputSnapshotId, dataset, scenarioId, modifications);
  return { snapshot, descriptor: { scenarioId, baselineSnapshotId: baselineSnapshot.inputSnapshotId, snapshotId: snapshot.inputSnapshotId, parentSnapshotId: baselineSnapshot.inputSnapshotId, modifications: { ...modifications }, rowOrdinalMapping: [...snapshot.rowOrdinal], createdAt: new Date().toISOString() } };
}
