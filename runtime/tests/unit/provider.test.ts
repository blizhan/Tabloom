import test from "node:test";
import assert from "node:assert/strict";
import { classifyWebGpuAdapter } from "../../src/model/provider";

test("WebGPU provider probe rejects absent and software adapters", () => {
  assert.equal(classifyWebGpuAdapter(null).available, false);
  assert.equal(classifyWebGpuAdapter({ info: { isFallbackAdapter: true, vendor: "google" } }).available, false);
  assert.equal(classifyWebGpuAdapter({ info: { vendor: "Google", architecture: "SwiftShader" } }).available, false);
});

test("WebGPU provider probe accepts a non-fallback hardware adapter", () => {
  const result = classifyWebGpuAdapter({ info: { vendor: "nvidia", device: "GB10", isFallbackAdapter: false } });
  assert.equal(result.available, true);
  assert.equal(result.adapterInfo?.vendor, "nvidia");
  assert.equal(result.adapterInfo?.device, "GB10");
});
