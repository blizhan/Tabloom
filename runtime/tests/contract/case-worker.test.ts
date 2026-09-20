import test from "node:test";
import assert from "node:assert/strict";
import { runCaseRequest, type CaseWorkerDependencies, type CaseWorkerRunRequest } from "../../tests/browser/case.worker";
import type { CaseFixture } from "../../src/model/tabiclv2/case-fixture";
import type { OrtSessionHandle } from "../../src/model/ort-session";

const digest = "a".repeat(64);
const state = { featureNames: ["x", "y"], targetMean: 0, targetScale: 1, trainRows: 2, artifactDigest: digest, featureTransform: "identity-finite-float32" as const };
const scenario = (id: string, raw: readonly number[], output: readonly number[]) => ({ id, rawInput: new Float32Array(raw), rawShape: [2, 2], modelInput: new Float32Array(raw), modelInputShape: [1, 2, 2], officialMean: new Float32Array(output) });
const fixture = {
  variant: "fp32" as const,
  manifest: {} as CaseFixture["manifest"],
  variantManifest: { artifactManifest: { modelVersion: "test", preprocessingVersion: "test", precision: "fp32", providerCompatibility: ["wasm"], inputs: [{ name: "x_test" }], files: [{ role: "graph", path: "model.onnx", sha256: "b".repeat(64) }] }, embeddedCaseRecipe: { payload: { kind: "embedded-artifact", manifestDigest: digest }, featureNames: ["x", "y"], estimatorState: { schemaVersion: 1, values: state } }, maxAbsErrorTargetUnits: 0.0001 } as unknown as CaseFixture["variantManifest"],
  state,
  scenarios: [scenario("baseline", [1, 2, 3, 4], [1, 2]), scenario("changed", [2, 3, 4, 5], [2, 3])],
  arrays: {},
  artifactManifestDigest: digest,
  modelVersion: "test",
  targetUnitBudget: 0.0001,
  ortOptions: { graph: new Uint8Array([1]), provider: "wasm" as const },
} satisfies CaseFixture;

function fakeSession(): OrtSessionHandle {
  return {
    provider: "wasm",
    inputNames: ["x_test"],
    outputNames: ["prediction_scaled"],
    async run(feeds) {
      const input = feeds.x_test as { data: Float32Array };
      return { prediction_scaled: { data: input.data[0] > 1.5 ? new Float32Array([2, 3]) : new Float32Array([1, 2]), dims: [1, 2], type: "float32" } };
    },
    async release() { /* no-op fake */ },
  };
}

function dependencies(): CaseWorkerDependencies {
  return { loadFixture: async () => fixture, createSession: async () => fakeSession(), providerAvailable: async () => true };
}

test("Case worker returns one terminal success with repeat and snapshot checks", async () => {
  const request: CaseWorkerRunRequest = { kind: "run-case", requestId: "case-1", provider: "wasm", variant: "fp32", baseUrl: "https://runtime.test/" };
  const reply = await runCaseRequest(request, dependencies());
  assert.equal(reply.kind, "success");
  if (reply.kind === "success") {
    assert.deepEqual(reply.baselineMean, [1, 2]);
    assert.deepEqual(reply.changedMean, [2, 3]);
    assert.equal(reply.repeatedMaxAbsDelta, 0);
    assert.equal(reply.snapshotChecks.dynamicFitRejected, true);
    assert.equal(reply.snapshotChecks.identityPreserved, true);
    assert.equal(reply.graphSha256, "b".repeat(64));
  }
});

test("Case worker rejects an unsupported provider or variant before loading artifacts", async () => {
  const invalidProvider = await runCaseRequest({ kind: "run-case", requestId: "bad-provider", provider: "cpu" as never, variant: "fp32", baseUrl: "https://runtime.test/" }, dependencies());
  assert.equal(invalidProvider.kind, "failure");
  if (invalidProvider.kind === "failure") assert.equal(invalidProvider.error.code, "INVALID_DATA");
  const invalidVariant = await runCaseRequest({ kind: "run-case", requestId: "bad-variant", provider: "wasm", variant: "bogus" as never, baseUrl: "https://runtime.test/" }, dependencies());
  assert.equal(invalidVariant.kind, "failure");
  if (invalidVariant.kind === "failure") assert.equal(invalidVariant.error.code, "INVALID_DATA");
});
