import test from "node:test";
import assert from "node:assert/strict";
import { InputSnapshotStore } from "../../src/data/input-snapshots";
import { ResultPublicationService } from "../../src/data/result-publication";
import type { PredictionResult } from "../../src/model/types";
test("publication joins by snapshot ordinal and rejects stale generations", async () => {
  const snapshots = new InputSnapshotStore(); const snapshot = snapshots.create({ columns: [new Float32Array([1, 2])], columnNames: ["x"], rowCount: 2 }, ["dup", "dup"]); const service = new ResultPublicationService(); const first = await service.reserve({ requestId: "r1", streamId: "s", generation: 1, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "a" }); const second = await service.reserve({ requestId: "r2", streamId: "s", generation: 2, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "b" });
  const result = (requestId: string, mean: number[]): PredictionResult => ({ mean: new Float32Array(mean), requestId, inputSnapshotId: snapshot.inputSnapshotId, scenarioId: requestId === "r1" ? "a" : "b", contextKey: "ctx", metadata: { modelId: "tabpfn-3.5", modelVersion: "v", artifactManifestDigest: "a", provider: "wasm", runtimeVersion: "r", timings: {}, warnings: [] } });
  await assert.rejects(() => service.publish(first, result("r1", [1, 2]), snapshot)); const rows = await service.publish(second, result("r2", [3, 4]), snapshot); assert.deepEqual(rows.map((row) => row.rowOrdinal), [0, 1]); assert.deepEqual(rows.map((row) => row.businessKey), ["dup", "dup"]);
});

test("publication retention keeps pending snapshots alive and releases superseded/cancelled runs", async () => {
  const snapshots = new InputSnapshotStore();
  const snapshot = snapshots.create({ columns: [new Float32Array([1, 2, 3])], columnNames: ["x"], rowCount: 3 }, ["a", "a", "b"]);
  const service = new ResultPublicationService({ snapshotRetention: { retain: (id) => { snapshots.retainSnapshot(id); }, release: (id) => { snapshots.releaseSnapshot(id); } } });
  const baseline = await service.reserve({ requestId: "baseline", streamId: "retention", generation: 0, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "baseline" });
  assert.equal(snapshots.get(snapshot.inputSnapshotId).retained, 2);
  await service.cancel(baseline.requestId, "test-cancel");
  assert.equal(snapshots.get(snapshot.inputSnapshotId).retained, 1);

  const pending = await service.reserve({ requestId: "pending", streamId: "retention", generation: 1, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "scenario-1" });
  const replacement = await service.reserve({ requestId: "replacement", streamId: "retention", generation: 2, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "scenario-2" });
  assert.equal(service.getRun(pending.requestId)?.status, "superseded");
  // The replacement is the only reservation-owned reference left.
  assert.equal(snapshots.get(snapshot.inputSnapshotId).retained, 2);
  await service.cancel(replacement.requestId);
  assert.equal(snapshots.get(snapshot.inputSnapshotId).retained, 1);
});

test("baseline publication remains queryable when a newer scenario is reserved", async () => {
  const snapshots = new InputSnapshotStore();
  const snapshot = snapshots.create({ columns: [new Float32Array([1, 2])], columnNames: ["x"], rowCount: 2 }, ["a", "b"]);
  const service = new ResultPublicationService();
  const result = (requestId: string, scenarioId: string): PredictionResult => ({ mean: new Float32Array([1, 2]), requestId, inputSnapshotId: snapshot.inputSnapshotId, scenarioId, contextKey: "ctx", metadata: { modelId: "tabpfn-3.5", modelVersion: "v", artifactManifestDigest: "a", provider: "wasm", runtimeVersion: "r", timings: {}, warnings: [] } });
  const baseline = await service.reserve({ requestId: "base", streamId: "baseline-stream", generation: 0, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "baseline" });
  const scenario = await service.reserve({ requestId: "scenario", streamId: "baseline-stream", generation: 1, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "scenario" });
  await service.publish(baseline, result("base", "baseline"), snapshot);
  await service.publish(scenario, result("scenario", "scenario"), snapshot);
  assert.equal(service.baselineRun("baseline-stream")?.requestId, "base");
  assert.equal(service.current("baseline-stream")?.requestId, "scenario");
});
