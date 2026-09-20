import test from "node:test";
import assert from "node:assert/strict";
import type { OrtOutputValue, OrtSessionHandle, OrtSessionOptions } from "../../src/model/ort-session";
import type { RuntimeTensorSnapshot } from "../../src/model/types";
import { RuntimeError } from "../../src/model/errors";
import { TABPFN35_CACHE_NAMES, TabPFN35OrtRuntime, type TabPFN35OrtRuntimeDependencies } from "../../src/model/tabpfn35/ort-runtime";

function output(data: Float32Array, dims: readonly number[]): OrtOutputValue {
  return { data, dims, type: "float32" };
}

function fakeSessions(options: { readonly invalidBuilderOutput?: boolean; readonly invalidPredictOutput?: boolean } = {}): { readonly dependencies: TabPFN35OrtRuntimeDependencies; readonly calls: string[]; readonly releases: string[] } {
  const calls: string[] = [];
  const releases: string[] = [];
  const dependencies: TabPFN35OrtRuntimeDependencies = {
    createSession: async (sessionOptions: OrtSessionOptions): Promise<OrtSessionHandle> => {
      const builder = sessionOptions.graph[0] === 1;
      return {
        provider: sessionOptions.provider,
        inputNames: builder ? ["x_train", "y_train"] : ["x_test", ...TABPFN35_CACHE_NAMES],
        outputNames: builder ? [...TABPFN35_CACHE_NAMES] : ["logits"],
        run: async (feeds, fetches) => {
          calls.push(`${builder ? "builder" : "predict"}:${Object.keys(feeds).join(",")}`);
          if (builder) {
            if (options.invalidBuilderOutput) return { cache_00: output(new Float32Array([1]), [1]) };
            const result: Record<string, OrtOutputValue> = {};
            for (const name of TABPFN35_CACHE_NAMES) result[name] = output(new Float32Array([1, 2, 3, 4]), [1, 1, 1, 4]);
            return result;
          }
          if (options.invalidPredictOutput) return { logits: output(new Float32Array([1, 2]), [1, 2]) };
          assert.deepEqual(fetches, ["logits"]);
          const rows = Number((feeds.x_test as { readonly dims: readonly number[] }).dims[0]);
          const data = new Float32Array(rows * 5000);
          for (let index = 0; index < data.length; index += 1) data[index] = index;
          return { logits: output(data, [rows, 1, 5000]) };
        },
        release: async () => { releases.push(builder ? "builder" : "predict"); },
      };
    },
  };
  return { dependencies, calls, releases };
}

function runtime(dependencies: TabPFN35OrtRuntimeDependencies, provider: "wasm" | "webgpu" = "wasm"): TabPFN35OrtRuntime {
  return new TabPFN35OrtRuntime({
    provider,
    contextGraph: new Uint8Array([1]),
    predictorGraph: new Uint8Array([2]),
    externalData: { path: "tabpfn35-shared.data", bytes: new Uint8Array([3, 4]) },
    dependencies,
  });
}

test("TabPFN ORT runtime validates graph schemas and copies all 54 context outputs", async () => {
  const fake = fakeSessions();
  const instance = runtime(fake.dependencies);
  assert.deepEqual(instance.diagnostics(), { provider: "wasm", wasmProxy: false, wasmNumThreads: 1, wasmPathsConfigured: false, sharedExternalDataConfigured: true, sharedExternalDataBytes: 2, artifactBytes: 4, predictorLoaded: false, builderActive: false });
  await instance.load();
  assert.equal(instance.diagnostics().predictorLoaded, true);
  const context = await instance.buildContext(new Float32Array(12), 3, 4, new Float32Array([1, 2, 3]));
  assert.equal(instance.diagnostics().builderActive, false, "builder output must survive its released session");
  assert.equal(context.length, 54);
  assert.deepEqual(context.map((tensor) => tensor.name), TABPFN35_CACHE_NAMES);
  assert.notEqual(context[0].data, context[1].data);
  const prediction = await instance.predict(new Float32Array(4), 2, 2, context);
  assert.deepEqual(prediction.dims, [2, 1, 5000]);
  assert.deepEqual([...prediction.data.slice(0, 6)], [0, 1, 2, 3, 4, 5]);
  await instance.release();
  await instance.release();
  assert.equal(instance.diagnostics().predictorLoaded, false);
  assert.deepEqual(fake.releases.sort(), ["builder", "predict"]);
  assert.equal(fake.calls.length, 2);
});

test("TabPFN ORT runtime rejects incomplete or malformed graph outputs", async () => {
  const invalidBuilder = runtime(fakeSessions({ invalidBuilderOutput: true }).dependencies);
  await invalidBuilder.load();
  await assert.rejects(() => invalidBuilder.buildContext(new Float32Array(12), 3, 4, new Float32Array([1, 2, 3])), (error) => error instanceof RuntimeError && error.code === "RESULT_INVALID");
  await invalidBuilder.release();

  const invalidPredict = fakeSessions({ invalidPredictOutput: true });
  const instance = runtime(invalidPredict.dependencies);
  await instance.load();
  const context = await instance.buildContext(new Float32Array(12), 3, 4, new Float32Array([1, 2, 3]));
  await assert.rejects(() => instance.predict(new Float32Array(4), 2, 2, context), (error) => error instanceof RuntimeError && error.code === "RESULT_INVALID");
  await instance.release();
});

test("TabPFN ORT runtime accepts snapshot-owned cache tensor descriptors", async () => {
  const fake = fakeSessions();
  const instance = runtime(fake.dependencies, "webgpu");
  await instance.load();
  const snapshots: RuntimeTensorSnapshot[] = TABPFN35_CACHE_NAMES.map((name) => ({ name, dtype: "float32", shape: [1, 1, 1, 4], bytes: new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer), checksum: "0".repeat(64) }));
  const result = await instance.predict(new Float32Array(4), 2, 2, snapshots);
  assert.equal(result.data.length, 10000);
  await instance.release();
});
