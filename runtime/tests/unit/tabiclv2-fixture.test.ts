import test from "node:test";
import assert from "node:assert/strict";
import { loadCaseFixture, type CaseFixtureManifest } from "../../src/model/tabiclv2/case-fixture";

const baseUrl = "https://runtime.test/";
const digest = "c".repeat(64);

function f32Bytes(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const hash = await crypto.subtle.digest("SHA-256", owned as unknown as BufferSource);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fixtureMap(): Promise<Map<string, Uint8Array | string>> {
  const arrays = {
    baseline_raw: f32Bytes([1, 2, 3, 4]),
    baseline_model_input: f32Bytes([10, 20, 30, 40]),
    baseline_mean: f32Bytes([11, 21]),
    changed_raw: f32Bytes([2, 3, 4, 5]),
    changed_model_input: f32Bytes([20, 30, 40, 50]),
    changed_mean: f32Bytes([12, 22]),
  } as const;
  const graph = new Uint8Array([7, 8, 9]);
  const external = new Uint8Array([1, 3, 5, 7]);
  const arrayEntries: Record<string, { file: string; dtype: "float32"; shape: readonly number[]; bytes: number; sha256: string }> = {};
  for (const [name, bytes] of Object.entries(arrays)) {
    arrayEntries[name] = { file: `${name}.f32`, dtype: "float32", shape: name.endsWith("raw") ? [2, 2] : name.endsWith("model_input") ? [1, 2, 2] : [2], bytes: bytes.byteLength, sha256: await sha256(bytes) };
  }
  const artifactFile = async (path: string, role: "graph" | "external-data", bytes: Uint8Array) => ({ path, role, bytes: bytes.byteLength, sha256: await sha256(bytes) });
  const manifest: CaseFixtureManifest = {
    schemaVersion: 1,
    modelId: "tabicl-v2",
    arrays: arrayEntries,
    scenarios: [
      { id: "baseline", rawInput: "baseline_raw", modelInput: "baseline_model_input", officialMean: "baseline_mean" },
      { id: "changed", rawInput: "changed_raw", modelInput: "changed_model_input", officialMean: "changed_mean" },
    ],
    variants: {
      fp32: {
        artifactManifest: {
          schemaVersion: 1, modelId: "tabicl-v2", modelVersion: "test", precision: "fp32", preprocessingVersion: "tabicl-case-standardize-clamp-v1",
          files: [await artifactFile("model.onnx", "graph", graph), await artifactFile("model.onnx.data", "external-data", external)],
          inputs: [{ name: "x_test", dtype: "float32", minRank: 3, maxRank: 3 }], providerCompatibility: ["wasm", "webgpu"],
          capabilities: { canBuildContext: false, canImportContext: true, maxModelFeatures: 2, trainRows: { min: 2, max: 2 }, predictionRows: { min: 1, max: 1024 } }, manifestDigest: digest,
        },
        maxAbsErrorTargetUnits: 0.0001,
        embeddedCaseRecipe: {
          payload: { kind: "embedded-artifact", manifestDigest: digest },
          featureNames: ["x0", "x1"],
          estimatorState: { schemaVersion: 1, values: { profile: "tabicl-case", seed: 1, featureNames: ["x0", "x1"], featureTransform: "identity-finite-float32", featurePermutation: [0, 1], targetMean: 0, targetScale: 1, trainRows: 2, artifactDigest: digest } },
        },
      },
    },
  };
  const map = new Map<string, Uint8Array | string>();
  map.set(new URL("runtime-fixtures/tabiclv2/case-golden/manifest.json", baseUrl).href, JSON.stringify(manifest));
  for (const [name, bytes] of Object.entries(arrays)) map.set(new URL(`runtime-fixtures/tabiclv2/case-golden/${name}.f32`, baseUrl).href, bytes);
  map.set(new URL("runtime-assets/tabiclv2/fp32/model.onnx", baseUrl).href, graph);
  map.set(new URL("runtime-assets/tabiclv2/fp32/model.onnx.data", baseUrl).href, external);
  return map;
}

function fetchFrom(map: Map<string, Uint8Array | string>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const key = String(input);
    const value = map.get(key);
    if (value === undefined) return new Response("missing", { status: 404 });
    return typeof value === "string" ? new Response(value, { status: 200, headers: { "content-type": "application/json" } }) : new Response(value as unknown as BodyInit, { status: 200 });
  }) as typeof fetch;
}

test("Case fixture selects the requested variant and validates shapes/digests", async () => {
  const map = await fixtureMap();
  const fixture = await loadCaseFixture(baseUrl, "fp32", { fetch: fetchFrom(map) });
  assert.equal(fixture.variant, "fp32");
  assert.equal(fixture.state.artifactDigest, digest);
  assert.deepEqual([...fixture.arrays.baseline_model_input], [10, 20, 30, 40]);
  assert.deepEqual(fixture.scenarios.map((scenario) => scenario.id), ["baseline", "changed"]);
  assert.deepEqual(fixture.ortOptions.graph, new Uint8Array([7, 8, 9]));
  assert.equal(fixture.ortOptions.externalData?.path, "model.onnx.data");
});

test("Case fixture rejects a checksum mismatch instead of loading untrusted bytes", async () => {
  const map = await fixtureMap();
  const key = new URL("runtime-fixtures/tabiclv2/case-golden/baseline_raw.f32", baseUrl).href;
  map.set(key, f32Bytes([999, 2, 3, 4]));
  await assert.rejects(() => loadCaseFixture(baseUrl, "fp32", { fetch: fetchFrom(map) }), /checksum|sha256/i);
});
