import test from "node:test";
import assert from "node:assert/strict";
import { TabICLv2CaseAdapter } from "../../src/model/tabiclv2/adapter";
import { RuntimeError } from "../../src/model/errors";
import type { ContextSnapshot } from "../../src/model/types";

test("TabICL adapter advertises fixed Case capability", () => {
  const digest = "d".repeat(64);
  const adapter = new TabICLv2CaseAdapter({ manifestDigest: digest, state: { featureNames: ["x"], targetMean: 0, targetScale: 1, weights: [1], bias: 0, trainRows: 3, artifactDigest: digest } });
  assert.equal(adapter.capabilities().canBuildContext, false);
});

test("TabICL Case uses fitted feature transform and inverse target units", async () => {
  const digest = "d".repeat(64);
  const state = {
    featureNames: ["x", "y"], targetMean: 10, targetScale: 2, trainRows: 3, artifactDigest: digest,
    featureTransform: "standardize-clamp-v1" as const, featureMeans: [1, 2], featureScales: [2, 4],
    outlierLowerBounds: [-1, -1], outlierUpperBounds: [1, 1],
  };
  let prepared: Float32Array[] | undefined;
  const adapter = new TabICLv2CaseAdapter({ manifestDigest: digest, state, inference: { predict: async (dataset) => { prepared = [...dataset.columns]; return [0, 1]; } } });
  await adapter.load({ preferredProvider: "wasm" });
  const snapshot: ContextSnapshot = {
    identity: { key: "e".repeat(64), modelId: "tabicl-v2", modelVersion: "2.2.0", artifactManifestDigest: digest, contextFormatVersion: 1, preprocessingVersion: "tabicl-case-standardize-clamp-v1", trainingDataDigest: "f".repeat(64), featureSqlFingerprint: null, schemaDigest: "a".repeat(64), targetName: "target", configurationDigest: "b".repeat(64) },
    provenance: { sourceSnapshotId: "case", builtWithProvider: "wasm" }, featureNames: ["x", "y"],
    estimatorState: { schemaVersion: 1, values: state }, payload: { kind: "embedded-artifact", manifestDigest: digest },
  };
  const context = await adapter.importContext(snapshot);
  const result = await adapter.predict(context, { columns: [new Float32Array([3, 5]), new Float32Array([6, 10])], columnNames: ["x", "y"], rowCount: 2 }, { requestId: "case-predict", inputSnapshotId: "input", scenarioId: "baseline" });
  assert.deepEqual(prepared?.map((column) => [...column]), [[1, 1], [1, 1]]);
  assert.deepEqual([...result.mean], [10, 12]);
});

test("TabICL Case rejects a snapshot with mismatched fitted state", async () => {
  const digest = "a".repeat(64); const state = { featureNames: ["x"], targetMean: 0, targetScale: 1, weights: [1], bias: 0, trainRows: 3, artifactDigest: digest };
  const adapter = new TabICLv2CaseAdapter({ manifestDigest: digest, state }); await adapter.load({ preferredProvider: "wasm" });
  const snapshot: ContextSnapshot = { identity: { key: "b".repeat(64), modelId: "tabicl-v2", modelVersion: "2.2.0", artifactManifestDigest: digest, contextFormatVersion: 1, preprocessingVersion: "tabicl-case", trainingDataDigest: "c".repeat(64), featureSqlFingerprint: null, schemaDigest: "d".repeat(64), targetName: "target", configurationDigest: "e".repeat(64) }, provenance: { sourceSnapshotId: "case", builtWithProvider: "wasm" }, featureNames: ["x"], estimatorState: { schemaVersion: 1, values: { ...state, targetScale: 2 } }, payload: { kind: "embedded-artifact", manifestDigest: digest } };
  await assert.rejects(() => adapter.importContext(snapshot), (error) => error instanceof RuntimeError && error.code === "CONTEXT_INCOMPATIBLE");
});
