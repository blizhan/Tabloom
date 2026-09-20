import test from "node:test";
import assert from "node:assert/strict";
import { buildContextIdentity, canonicalBytes, parsePreprocessingConfig, sha256Hex } from "../../src/model/identity";
import type { TrainingDataset } from "../../src/model/types";

test("canonical identity preserves signed zero and normalizes NaN", async () => {
  assert.notDeepEqual(canonicalBytes(-0), canonicalBytes(0)); assert.deepEqual(canonicalBytes(Number.NaN), canonicalBytes(Number.NaN));
  assert.equal(await sha256Hex(new TextEncoder().encode("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("context identity changes with training semantics but not prediction rows", async () => {
  const dataset: TrainingDataset = { columns: [new Float32Array([1, 2, 3])], columnNames: ["x"], rowCount: 3, target: new Float32Array([2, 4, 6]), targetName: "y" };
  const config = parsePreprocessingConfig({ profile: "tabpfn35-none", seed: 1 }); const args = { modelId: "tabpfn-3.5" as const, modelVersion: "v1", artifactManifestDigest: "a".repeat(64), preprocessingVersion: "p1", dataset, featureSqlFingerprint: "sql", config };
  const one = await buildContextIdentity(args); const two = await buildContextIdentity({ ...args, dataset: { ...dataset, target: new Float32Array([2, 4, 7]) } }); assert.notEqual(one.key, two.key); assert.equal(one.targetName, "y");
});
