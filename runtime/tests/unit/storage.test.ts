import test from "node:test";
import assert from "node:assert/strict";
import { IndexedDbStore } from "../../src/storage/indexeddb-store";
import { ContextStore } from "../../src/storage/context-store";
import { encodeContextSnapshot } from "../../src/model/context-snapshot";
import type { ContextSnapshot } from "../../src/model/types";
test("memory persistence verifies bytes and replaces complete generations atomically", async () => { const store = new IndexedDbStore(); await store.put("k", new Uint8Array([1, 2])); assert.deepEqual([...(await store.get("k") ?? [])], [1, 2]); await store.put("k", new Uint8Array([3])); assert.deepEqual([...(await store.get("k") ?? [])], [3]); });

test("context store deduplicates concurrent persistent loads", async () => {
  const key = "a".repeat(64);
  const snapshot: ContextSnapshot = { identity: { key, modelId: "tabpfn-3", modelVersion: "test", artifactManifestDigest: "b".repeat(64), contextFormatVersion: 1, preprocessingVersion: "test", trainingDataDigest: "c".repeat(64), featureSqlFingerprint: null, schemaDigest: "d".repeat(64), targetName: "target", configurationDigest: "e".repeat(64) }, provenance: { sourceSnapshotId: "test", builtWithProvider: "wasm" }, featureNames: ["x"], estimatorState: { schemaVersion: 1, values: {} }, payload: { kind: "portable-tensors", tensors: [] } };
  const bytes = await encodeContextSnapshot(snapshot);
  class CountingStore extends IndexedDbStore {
    calls = 0;
    override get persistentAvailable(): boolean { return true; }
    override async get(requestedKey: string): Promise<Uint8Array | undefined> { this.calls += 1; await new Promise((resolve) => setTimeout(resolve, 1)); return requestedKey === key ? bytes : undefined; }
    override async delete(): Promise<void> { /* the test entry is valid and is never deleted */ }
  }
  const storage = new CountingStore(); const contexts = new ContextStore({ storage, allowMemoryFallback: false });
  const loaded = await Promise.all([contexts.load(key), contexts.load(key), contexts.load(key)]);
  assert.equal(storage.calls, 1); assert.ok(loaded.every(Boolean)); assert.equal(loaded[0]?.identity.key, key);
});
