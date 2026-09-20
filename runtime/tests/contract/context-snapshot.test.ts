import test from "node:test";
import assert from "node:assert/strict";
import { encodeContextSnapshot, decodeContextSnapshot } from "../../src/model/context-snapshot";
import type { ContextSnapshot } from "../../src/model/types";
const snapshot: ContextSnapshot = { identity: { key: "a".repeat(64), modelId: "tabpfn-3", modelVersion: "v", artifactManifestDigest: "a".repeat(64), contextFormatVersion: 1, preprocessingVersion: "p", trainingDataDigest: "d", featureSqlFingerprint: null, schemaDigest: "s", targetName: "y", configurationDigest: "c" }, provenance: { sourceSnapshotId: "input", builtWithProvider: "wasm" }, featureNames: ["x"], estimatorState: { schemaVersion: 1, values: { mean: new Float32Array([1]) } }, payload: { kind: "portable-tensors", tensors: [{ name: "t", dtype: "float32", shape: [1], bytes: new Uint8Array([1, 2, 3, 4]), checksum: "0".repeat(64) }] } };

test("context tensor bytes are copied for independent live handles", async () => {
  const { ContextRegistry } = await import("../../src/model/context-registry");
  const registry = new ContextRegistry("test-instance", "test-epoch");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const first = registry.create({ identity: snapshot.identity, featureNames: snapshot.featureNames, tensors: [{ name: "cache_00", dtype: "float32", shape: [1], bytes, checksum: "0".repeat(64) }], provenance: snapshot.provenance });
  const second = registry.find(snapshot.identity.key);
  assert.ok(second);
  bytes[0] = 99;
  const firstBacking = registry.get(first);
  const secondBacking = registry.get(second);
  assert.equal(firstBacking.tensors[0].bytes[0], 1);
  assert.equal(secondBacking.tensors[0].bytes[0], 1);
  firstBacking.tensors[0].bytes[0] = 77;
  assert.equal(registry.get(second).tensors[0].bytes[0], 1);
  registry.release(first);
  registry.release(second);
  registry.dispose();
});
test("context snapshot round-trips owned bytes", async () => {
  const encoded = await encodeContextSnapshot(snapshot); const decoded = decodeContextSnapshot(encoded); assert.deepEqual([...((decoded.estimatorState.values as { mean: Float32Array }).mean)], [1]); if (decoded.payload.kind === "portable-tensors") assert.deepEqual([...decoded.payload.tensors[0].bytes], [1, 2, 3, 4]);
});
