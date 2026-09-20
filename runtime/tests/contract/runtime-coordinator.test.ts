import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeCoordinator } from "../../src/coordinator/runtime-coordinator";
import type { ModelContext, PredictionResult, TabularDataset, TabularModelAdapter } from "../../src/model/types";

test("submits a snapshot materialized by the default DuckDB service", async () => {
  const adapter = {
    id: "tabpfn-3.5",
    capabilities: () => ({ taskTypes: ["regression"], canBuildContext: true, canImportContext: true, supportsMissingFeatures: true, supportsPassthroughInf: false, maxModelFeatures: 1, trainRows: { min: 1, max: 10 }, predictionRows: { min: 1, max: 10 } }),
    load: async () => undefined,
    fitContext: async () => context,
    importContext: async () => context,
    exportContext: async () => { throw new Error("unused"); },
    releaseContext: async () => undefined,
    predict: async (_context: ModelContext, _dataset: TabularDataset, options: { requestId: string; inputSnapshotId: string; scenarioId: string }): Promise<PredictionResult> => ({ mean: new Float32Array([2]), requestId: options.requestId, inputSnapshotId: options.inputSnapshotId, scenarioId: options.scenarioId, contextKey: "context", metadata: { modelId: "tabpfn-3.5", modelVersion: "test", artifactManifestDigest: "a".repeat(64), provider: "wasm", runtimeVersion: "test", timings: {}, warnings: [] } }),
    dispose: async () => undefined,
  } satisfies TabularModelAdapter;
  const coordinator = new RuntimeCoordinator({ adapter: adapter as never });
  const context = { handleId: "context", identity: { key: "context" }, workerEpoch: "epoch" } as ModelContext;
  await coordinator.duckdb.open({ query: async () => ({ columns: ["x"], rows: [{ x: 1 }] }) });
  const snapshot = await coordinator.duckdb.materializePrediction("SELECT x", [], ["x"]);
  const outcome = await coordinator.submitPrediction({ streamId: "stream", generation: 0, epoch: "epoch", scenarioId: "baseline", requestId: "request", inputSnapshot: snapshot, context });
  assert.equal(outcome.status, "published");
  assert.equal(outcome.value?.[0]?.mean, 2);
  await coordinator.dispose();
});
