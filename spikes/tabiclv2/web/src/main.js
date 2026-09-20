import * as ort from "onnxruntime-web/webgpu";

const status = document.querySelector("#status");
const searchParams = new URLSearchParams(location.search);
const backend = searchParams.get("backend") ?? "webgpu";
const variant = searchParams.get("variant") ?? "fp32";

const variants = {
  fp32: {
    model: "/model/onnx/tabiclv2-kv-dynamic.onnx",
    data: "/model/onnx/tabiclv2-kv-dynamic.onnx.data",
    dataName: "tabiclv2-kv-dynamic.onnx.data",
    modelBytes: 129223201,
  },
  "fp16-storage": {
    model: "/model/optimized/tabiclv2-kv-dynamic-fp16-storage.onnx",
    data: "/model/optimized/tabiclv2-kv-dynamic-fp16-storage.onnx.data",
    dataName: "tabiclv2-kv-dynamic-fp16-storage.onnx.data",
    modelBytes: 66935156,
  },
  "fp8-storage": {
    model: "/model/optimized/tabiclv2-kv-dynamic-fp8-storage.onnx",
    data: "/model/optimized/tabiclv2-kv-dynamic-fp8-storage.onnx.data",
    dataName: "tabiclv2-kv-dynamic-fp8-storage.onnx.data",
    modelBytes: 35797754,
  },
};

if (!(variant in variants)) throw new Error(`Unsupported variant: ${variant}`);

ort.env.wasm.wasmPaths = "/ort/";
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

function publish(result) {
  window.__TABLOOM_RESULT__ = result;
  status.textContent = JSON.stringify(result, null, 2);
  console.log("TABLOOM_RESULT", JSON.stringify(result));
}

async function fetchFloat32(file) {
  const response = await fetch(`/fixture/${file}`);
  if (!response.ok) throw new Error(`Failed to fetch ${file}: ${response.status}`);
  return new Float32Array(await response.arrayBuffer());
}

function compare(actual, expected) {
  let maxAbsDelta = 0;
  let sumAbsDelta = 0;
  let finite = true;
  for (let index = 0; index < actual.length; index += 1) {
    const value = Number(actual[index]);
    finite &&= Number.isFinite(value);
    const delta = Math.abs(value - expected[index]);
    maxAbsDelta = Math.max(maxAbsDelta, delta);
    sumAbsDelta += delta;
  }
  return { finite, maxAbsDelta, meanAbsDelta: sumAbsDelta / actual.length };
}

async function webGpuInfo() {
  const adapter = navigator.gpu
    ? await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
    : null;
  return {
    available: Boolean(navigator.gpu),
    adapterAvailable: Boolean(adapter),
    adapterInfo: adapter ? {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter ?? null,
    } : null,
  };
}

async function run() {
  const started = performance.now();
  const detectedWebGpu = await webGpuInfo();
  const fixture = await fetch("/fixture/fixture.json").then((response) => response.json());
  const sessionStarted = performance.now();
  const model = variants[variant];
  const session = await ort.InferenceSession.create(model.model, {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
    externalData: [{
      path: model.dataName,
      data: model.data,
    }],
  });
  const sessionLoadMs = performance.now() - sessionStarted;
  const scenarios = {};
  let baseline32 = null;

  for (const rows of fixture.scenarios) {
    const xMetadata = fixture.arrays[`x_${rows}`];
    const expectedMetadata = fixture.arrays[`output_${rows}`];
    const [x, expected] = await Promise.all([
      fetchFloat32(xMetadata.file),
      fetchFloat32(expectedMetadata.file),
    ]);
    const inferenceStarted = performance.now();
    const output = (await session.run({
      x_test: new ort.Tensor("float32", x, xMetadata.shape),
    })).prediction_scaled;
    scenarios[rows] = {
      inferenceMs: performance.now() - inferenceStarted,
      outputShape: output.dims,
      outputLength: output.data.length,
      ...compare(output.data, expected),
    };
    if (rows === 32) baseline32 = Float32Array.from(output.data);
  }

  const changedMetadata = fixture.arrays.x_32;
  const changed = await fetchFloat32(changedMetadata.file);
  for (let row = 0; row < 32; row += 1) changed[row * fixture.features] += 0.25;
  const changedFeeds = {
    x_test: new ort.Tensor("float32", changed, changedMetadata.shape),
  };
  const changedStarted = performance.now();
  const changedOutput = (await session.run(changedFeeds)).prediction_scaled;
  const changedInferenceMs = performance.now() - changedStarted;
  const repeatStarted = performance.now();
  const repeatOutput = (await session.run(changedFeeds)).prediction_scaled;
  const repeatInferenceMs = performance.now() - repeatStarted;
  let responseMaxAbsDelta = 0;
  let repeatMaxAbsDelta = 0;
  for (let index = 0; index < changedOutput.data.length; index += 1) {
    responseMaxAbsDelta = Math.max(
      responseMaxAbsDelta,
      Math.abs(Number(changedOutput.data[index]) - Number(baseline32[index])),
    );
    repeatMaxAbsDelta = Math.max(
      repeatMaxAbsDelta,
      Math.abs(Number(changedOutput.data[index]) - Number(repeatOutput.data[index])),
    );
  }

  publish({
    status: "supported",
    backend,
    variant,
    userAgent: navigator.userAgent,
    webgpu: detectedWebGpu,
    model: {
      sessionLoadMs,
      modelBytes: model.modelBytes,
      cacheEmbeddedInModel: true,
      scenarios,
      scenarioInteraction: {
        rows: 32,
        feature: 0,
        offset: 0.25,
        changedInferenceMs,
        repeatInferenceMs,
        responseMaxAbsDelta,
        responseMaxAbsDeltaOriginalUnits: responseMaxAbsDelta * fixture.targetScaler.scale,
        repeatMaxAbsDelta,
      },
      totalMs: performance.now() - started,
    },
  });
}

run().catch((error) => publish({
  status: "blocked",
  backend,
  variant,
  errorType: error?.constructor?.name ?? typeof error,
  error: String(error?.stack ?? error),
  webgpuAvailable: Boolean(navigator.gpu),
}));
