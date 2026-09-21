import test from "node:test";
import assert from "node:assert/strict";
import { InputSnapshotStore } from "../../src/data/input-snapshots";
import { ResultPublicationService } from "../../src/data/result-publication";
import type { PredictionResult, TabularDataset } from "../../src/model/types";

const dataset: TabularDataset = { columns: [new Float32Array([1, 2, 3])], columnNames: ["x"], rowCount: 3 };

test("quartiles follow output ordinals and invalid intervals fail publication", async () => {
  const snapshot = new InputSnapshotStore().create(dataset);
  const service = new ResultPublicationService();
  const reservation = await service.reserve({ requestId: "q", streamId: "q", generation: 0, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "baseline" });
  const rows = await service.publish(reservation, { ...result([30,10,20], snapshot.inputSnapshotId,"q",[2,0,1]), q25:new Float32Array([29,9,19]),q75:new Float32Array([31,11,21]) }, snapshot);
  assert.deepEqual(rows.map(row=>[row.rowOrdinal,row.q25,row.q75]),[[2,29,31],[0,9,11],[1,19,21]]);
  for (const [index, intervals] of [
    {q25:new Float32Array([1]),q75:new Float32Array([2])},
    {q25:new Float32Array([4,4,4]),q75:new Float32Array([2,2,2])},
    {q25:new Float32Array([NaN,1,2]),q75:new Float32Array([2,2,3])},
    {q25:new Float32Array([1,1,1])},
  ].entries()) {
    const id="invalid-q-"+index;
    const r=await service.reserve({requestId:id,streamId:id,generation:0,epoch:"e",inputSnapshotId:snapshot.inputSnapshotId,scenarioId:"baseline"});
    await assert.rejects(service.publish(r,{...result([1,2,3],snapshot.inputSnapshotId,id),...intervals},snapshot),{code:"RESULT_INVALID"});
  }
});
function result(mean: number[], inputSnapshotId: string, requestId = "r", rowOrdinal?: number[]): PredictionResult { return { mean: new Float32Array(mean), rowOrdinal, requestId, inputSnapshotId, scenarioId: "baseline", contextKey: "context", metadata: { modelId: "tabpfn-3.5", modelVersion: "test", artifactManifestDigest: "a", provider: "wasm", inference: "ort", runtimeVersion: "test", timings: {}, warnings: [] } }; }

test("publication preserves explicit row ordinals and rejects duplicate identities", async () => {
  const snapshots = new InputSnapshotStore(); const snapshot = snapshots.create(dataset, ["a", "b", "c"]); const service = new ResultPublicationService();
  const reservation = await service.reserve({ requestId: "r", streamId: "s", generation: 0, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "baseline" });
  const rows = await service.publish(reservation, result([30, 10, 20], snapshot.inputSnapshotId, "r", [2, 0, 1]), snapshot);
  assert.deepEqual(rows.map((row) => [row.rowOrdinal, row.businessKey, row.mean]), [[2, "c", 30], [0, "a", 10], [1, "b", 20]]);
  const badSnapshot = snapshots.create(dataset);
  const bad = await service.reserve({ requestId: "bad", streamId: "bad", generation: 0, epoch: "e", inputSnapshotId: badSnapshot.inputSnapshotId, scenarioId: "baseline" });
  await assert.rejects(service.publish(bad, result([1, 2, 3], badSnapshot.inputSnapshotId, "bad", [0, 0, 2]), badSnapshot), { code: "RESULT_INVALID" });
});

test("invalid publication does not hide the previous successful generation", async () => {
  const snapshots = new InputSnapshotStore(); const snapshot = snapshots.create(dataset, ["a", "b", "c"]); const service = new ResultPublicationService();
  const base = await service.reserve({ requestId: "base", streamId: "rollback", generation: 0, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "baseline" });
  await service.publish(base, result([1, 2, 3], snapshot.inputSnapshotId, "base"), snapshot);
  const next = await service.reserve({ requestId: "next", streamId: "rollback", generation: 1, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "scenario" });
  await assert.rejects(service.publish(next, result([1, 2, 3], snapshot.inputSnapshotId, "wrong"), snapshot), { code: "RESULT_INVALID" });
  assert.equal(service.current("rollback")?.requestId, "base");
});

test("publication rollback restores the previous baseline pointer", async () => {
  const snapshots = new InputSnapshotStore(); const snapshot = snapshots.create(dataset, ["a", "b", "c"]); const service = new ResultPublicationService();
  const base = await service.reserve({ requestId: "base", streamId: "baseline-rollback", generation: 0, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "baseline" });
  await service.publish(base, result([1, 2, 3], snapshot.inputSnapshotId, "base"), snapshot);
  const next = await service.reserve({ requestId: "next", streamId: "baseline-rollback", generation: 1, epoch: "e", inputSnapshotId: snapshot.inputSnapshotId, scenarioId: "baseline" });
  await service.publish(next, result([4, 5, 6], snapshot.inputSnapshotId, "next"), snapshot);

  assert.equal(service.baselineRun("baseline-rollback")?.requestId, "next");
  await service.rollback("next", "registration failed");

  assert.equal(service.getRun("next")?.status, "failed");
  assert.equal(service.baselineRun("baseline-rollback")?.requestId, "base");
});
