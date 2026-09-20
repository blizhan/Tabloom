import test from "node:test";
import assert from "node:assert/strict";
import { createOrtSession, type OrtRuntimeModule } from "../../src/model/ort-session";

function fakeOrt(outputData: Float32Array) {
  let releaseCount = 0;
  let outputDisposeCount = 0;
  let createdInput: unknown;
  const session = {
    inputNames: ["x_test"],
    outputNames: ["prediction"],
    async run(feeds: Record<string, unknown>) {
      createdInput = feeds.x_test;
      return {
        prediction: {
          data: outputData,
          dims: [1, outputData.length],
          type: "float32",
          dispose() { outputDisposeCount += 1; },
        },
      };
    },
    async release() {
      releaseCount += 1;
    },
  };
  const module: OrtRuntimeModule = {
    env: { wasm: { proxy: true } },
    Tensor: class {
      readonly type: string;
      readonly data: unknown;
      readonly dims: readonly number[];
      constructor(type: string, data: unknown, dims: readonly number[]) {
        this.type = type;
        this.data = data;
        this.dims = dims;
      }
    },
    InferenceSession: { create: async () => session },
  };
  return { module, session, get releaseCount() { return releaseCount; }, get outputDisposeCount() { return outputDisposeCount; }, get createdInput() { return createdInput; } };
}

test("WASM sessions disable proxy and return copied output data with dimensions", async () => {
  const source = new Float32Array([1, 2]);
  const fake = fakeOrt(source);
  const handle = await createOrtSession(
    { graph: new Uint8Array([1, 2, 3]), provider: "wasm", wasmPaths: "/runtime-assets/ort/" },
    { ortModule: fake.module },
  );

  assert.equal(fake.module.env.wasm.proxy, false);
  assert.equal(fake.module.env.wasm.numThreads, 1);
  assert.equal(fake.module.env.wasm.wasmPaths, "/runtime-assets/ort/");
  const result = await handle.run({ x_test: { type: "float32", data: new Float32Array([3, 4]), dims: [1, 1, 2] } });
  assert.deepEqual(result.prediction, { type: "float32", data: new Float32Array([1, 2]), dims: [1, 2] });
  assert.notEqual((result.prediction as { data: Float32Array }).data, source);
  assert.equal(fake.outputDisposeCount, 1);
  assert.equal((fake.createdInput as { type: string }).type, "float32");
  assert.deepEqual((fake.createdInput as { data: Float32Array }).data, new Float32Array([3, 4]));
  assert.deepEqual((fake.createdInput as { dims: readonly number[] }).dims, [1, 1, 2]);
});

test("ORT session release is idempotent", async () => {
  const fake = fakeOrt(new Float32Array([1]));
  const handle = await createOrtSession({ graph: new Uint8Array([1]), provider: "webgpu" }, { ortModule: fake.module });
  await handle.release();
  await handle.release();
  assert.equal(fake.releaseCount, 1);
});
