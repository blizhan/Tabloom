import test from "node:test";
import assert from "node:assert/strict";
import { TabPFN35Adapter } from "../../src/model/tabpfn35/adapter";
import { TabICLv2CaseAdapter } from "../../src/model/tabiclv2/adapter";
import { RuntimeError } from "../../src/model/errors";
import type { TrainingDataset } from "../../src/model/types";
import { TABPFN35_CACHE_NAMES, type TabPFN35InferenceRuntime } from "../../src/model/tabpfn35/ort-runtime";

const training: TrainingDataset = { columns: [new Float32Array([1, 2, 3]), new Float32Array([3, 2, 1])], columnNames: ["a", "b"], rowCount: 3, target: new Float32Array([2, 4, 6]), targetName: "target" };
test("TabPFN adapter fits, reuses, predicts and releases independent handles", async () => {
  const adapter = new TabPFN35Adapter(); await adapter.load({ preferredProvider: "wasm" });
  const options = { sourceSnapshotId: "train", featureSqlFingerprint: null, preprocessing: { profile: "tabpfn35-none" as const, seed: 1 } };
  const first = await adapter.fitContext(training, options); const second = await adapter.fitContext(training, options); assert.notEqual(first.handleId, second.handleId);
  const prediction = await adapter.predict(first, { columns: [new Float32Array([1, 2]), new Float32Array([3, 2])], columnNames: ["a", "b"], rowCount: 2 }, { requestId: "r", inputSnapshotId: "p", scenarioId: "s" }); assert.equal(prediction.mean.length, 2);
  await adapter.releaseContext(first); await adapter.releaseContext(first); await adapter.releaseContext(second);
  await assert.rejects(() => adapter.predict(first, { columns: [new Float32Array([1])], columnNames: ["a"], rowCount: 1 }, { requestId: "r2", inputSnapshotId: "p", scenarioId: "s" }), (error) => error instanceof RuntimeError && error.code === "CONTEXT_RELEASED");
});
test("TabICL Case refuses dynamic fitting", async () => {
  const digest = "c".repeat(64); const adapter = new TabICLv2CaseAdapter({ manifestDigest: digest, state: { featureNames: ["x"], targetMean: 10, targetScale: 2, weights: [1], bias: 0, trainRows: 3, artifactDigest: digest } }); await adapter.load({ preferredProvider: "wasm" });
  await assert.rejects(() => adapter.fitContext(training, { sourceSnapshotId: "x", featureSqlFingerprint: null, preprocessing: { profile: "tabicl-case", seed: 0 } }), (error) => error instanceof RuntimeError && error.code === "UNSUPPORTED_CAPABILITY");
});

test("TabPFN adapter uses the real runtime for 54-cache fit and 5000-bin predict", async () => {
  let builds = 0; let predictions = 0; let releases = 0; let cacheCount = 0;
  const runtime: TabPFN35InferenceRuntime = {
    provider: "wasm",
    async load() {},
    async buildContext(xTrain, trainRows, features, yTrain) {
      builds += 1; assert.equal(xTrain.length, trainRows * features); assert.equal(yTrain.length, trainRows);
      return TABPFN35_CACHE_NAMES.map((name) => ({ name, dtype: "float32" as const, shape: [1, 1, 1, 4], data: new Float32Array([1, 2, 3, 4]) }));
    },
    async predict(xTest, predictionRows, features, cache) {
      predictions += 1; cacheCount = cache.length; assert.equal(xTest.length, predictionRows * features);
      const data = new Float32Array(predictionRows * 5000); data.fill(-10); for (let row = 0; row < predictionRows; row += 1) data[row * 5000 + 2500] = 10;
      return { data, dims: [predictionRows, 1, 5000] };
    },
    async release() { releases += 1; },
  };
  const adapter = new TabPFN35Adapter({ ortRuntime: runtime }); await adapter.load({ preferredProvider: "wasm" });
  const options = { sourceSnapshotId: "real-train", featureSqlFingerprint: null, preprocessing: { profile: "tabpfn35-none" as const, seed: 1 } };
  const context = await adapter.fitContext(training, options);
  const snapshot = await adapter.exportContext(context);
  assert.equal(snapshot.payload.kind, "portable-tensors"); if (snapshot.payload.kind === "portable-tensors") assert.deepEqual(snapshot.payload.tensors.map((tensor) => tensor.name), TABPFN35_CACHE_NAMES);
  const result = await adapter.predict(context, { columns: [new Float32Array([1, 2]), new Float32Array([3, 2])], columnNames: ["a", "b"], rowCount: 2 }, { requestId: "ort-r", inputSnapshotId: "ort-p", scenarioId: "ort-s" });
  assert.equal(builds, 1); assert.equal(predictions, 1); assert.equal(cacheCount, 54); assert.equal(result.metadata.inference, "ort"); assert.equal(result.mean.length, 2); assert.ok(result.mean.every(Number.isFinite));
  await adapter.dispose(); assert.equal(releases, 1);
});

test("TabPFN adapter rejects an artifact-configured load without a real runtime", async () => {
  const adapter = new TabPFN35Adapter({ requireOrtRuntime: true });
  await assert.rejects(() => adapter.load({ preferredProvider: "wasm" }), (error) => error instanceof RuntimeError && error.code === "ARTIFACT_MISMATCH");
});
