import test from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../../src/storage/manifest";
import { RuntimeError } from "../../src/model/errors";
const digest = "0".repeat(64);
test("validates artifact file checksums and shape bounds", () => { const manifest = validateManifest({ schemaVersion: 1, modelId: "tabpfn-3.5", modelVersion: "v1", manifestDigest: digest, precision: "fp32", preprocessingVersion: "p", files: [{ path: "graph.onnx", role: "graph", bytes: 1, sha256: digest }], inputs: [], providerCompatibility: ["wasm"], capabilities: { canBuildContext: true, canImportContext: true, maxModelFeatures: 32, trainRows: { min: 3, max: 10 }, predictionRows: { min: 1, max: 10 } } }); assert.equal(manifest.modelId, "tabpfn-3.5"); });
test("rejects path traversal", () => { assert.throws(() => validateManifest({ schemaVersion: 1, modelId: "tabpfn-3.5", modelVersion: "v1", manifestDigest: digest, precision: "fp32", preprocessingVersion: "p", files: [{ path: "../secret", role: "graph", bytes: 1, sha256: digest }], inputs: [], providerCompatibility: ["wasm"], capabilities: { canBuildContext: true, canImportContext: true, maxModelFeatures: 1, trainRows: { min: 1, max: 1 }, predictionRows: { min: 1, max: 1 } } }), (error) => error instanceof RuntimeError && error.code === "ARTIFACT_MISMATCH"); });
