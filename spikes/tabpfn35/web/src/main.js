import * as ort from "onnxruntime-web/webgpu";

const status = document.querySelector("#status");
const parameters = new URLSearchParams(location.search);
const backend = parameters.get("backend") ?? "webgpu";
const mode = parameters.get("mode") ?? "full";
const variant = parameters.get("variant") ?? "fp32";

ort.env.wasm.wasmPaths = "/ort/";
ort.env.wasm.numThreads = 1;
ort.env.logLevel = "warning";

function publish(result) {
  window.__TABLOOM_RESULT__ = result;
  status.textContent = JSON.stringify(result, null, 2);
  console.log("TABLOOM_RESULT", JSON.stringify(result));
}

async function fetchFloat32(base, file) {
  const response = await fetch(`${base}/${file}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${file}: ${response.status}`);
  }
  return new Float32Array(await response.arrayBuffer());
}

async function getWebGpuInfo() {
  const highPerformanceAdapter = navigator.gpu
    ? await navigator.gpu.requestAdapter({ powerPreference: "high-performance" })
    : null;
  const adapter = highPerformanceAdapter ?? (
    navigator.gpu ? await navigator.gpu.requestAdapter() : null
  );
  return {
    available: Boolean(navigator.gpu),
    adapterAvailable: Boolean(adapter),
    highPerformanceAdapterAvailable: Boolean(highPerformanceAdapter),
    adapterInfo: adapter ? {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      device: adapter.info.device,
      description: adapter.info.description,
      isFallbackAdapter: adapter.info.isFallbackAdapter ?? null,
    } : null,
  };
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
  return {
    finite,
    maxAbsDelta,
    meanAbsDelta: sumAbsDelta / actual.length,
  };
}

async function runFull(started, webgpu) {
  const fixture = await fetch("/model/fixture.json").then((response) => response.json());
  const [x, yTrain, expected] = await Promise.all([
    fetchFloat32("/model", fixture.arrays.x.file),
    fetchFloat32("/model", fixture.arrays.y_train.file),
    fetchFloat32("/model", fixture.arrays.output.file),
  ]);

  const sessionStarted = performance.now();
  const session = await ort.InferenceSession.create("/model/tabpfn35.onnx", {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
    externalData: [
      {
        path: "tabpfn35.onnx.data",
        data: "/model/tabpfn35.onnx.data",
      },
    ],
  });
  const sessionLoadMs = performance.now() - sessionStarted;

  const feeds = {
    x: new ort.Tensor("float32", x, fixture.arrays.x.shape),
    y_train: new ort.Tensor("float32", yTrain, fixture.arrays.y_train.shape),
  };
  const inferenceStarted = performance.now();
  const outputs = await session.run(feeds);
  const firstInferenceMs = performance.now() - inferenceStarted;
  const warmInferenceStarted = performance.now();
  const warmOutputs = await session.run(feeds);
  const warmInferenceMs = performance.now() - warmInferenceStarted;
  const actual = outputs.logits.data;
  const warmActual = warmOutputs.logits.data;

  const comparison = compare(actual, expected);
  let repeatMaxAbsDelta = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const value = Number(actual[index]);
    repeatMaxAbsDelta = Math.max(
      repeatMaxAbsDelta,
      Math.abs(value - Number(warmActual[index])),
    );
  }

  publish({
    status: "supported",
    backend,
    mode,
    userAgent: navigator.userAgent,
    webgpu,
    model: {
      sessionLoadMs,
      firstInferenceMs,
      warmInferenceMs,
      totalMs: performance.now() - started,
      outputLength: actual.length,
      outputShape: outputs.logits.dims,
      ...comparison,
      repeatMaxAbsDelta,
    },
  });
}

async function runKv(started, webgpu) {
  const fixture = await fetch("/kv-fixture/fixture.json").then((response) => response.json());
  const cacheArrays = await Promise.all(
    fixture.cacheNames.map((name) => fetchFloat32("/kv-fixture", fixture.arrays[name].file)),
  );
  const cacheFeeds = Object.fromEntries(
    fixture.cacheNames.map((name, index) => [
      name,
      new ort.Tensor("float32", cacheArrays[index], fixture.arrays[name].shape),
    ]),
  );
  const sessionStarted = performance.now();
  const optimized = variant !== "fp32";
  const modelName = variant === "fp16-storage"
    ? "tabpfn35-kv-dynamic-fp16-storage.onnx"
    : variant === "fp8-storage"
      ? "tabpfn35-kv-dynamic-fp8-storage.onnx"
      : variant === "int8"
        ? "tabpfn35-kv-dynamic-int8.onnx"
        : "tabpfn35-kv-dynamic.onnx";
  const modelBase = optimized ? "/kv-optimized" : "/kv-model";
  const session = await ort.InferenceSession.create(
    `${modelBase}/${modelName}`,
    {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
      externalData: [{
        path: `${modelName}.data`,
        data: `${modelBase}/${modelName}.data`,
      }],
    },
  );
  const sessionLoadMs = performance.now() - sessionStarted;
  const scenarios = {};
  let baseline32 = null;
  for (const rows of fixture.scenarios) {
    const xName = `x_${rows}`;
    const outputName = `output_${rows}`;
    const [x, expected] = await Promise.all([
      fetchFloat32("/kv-fixture", fixture.arrays[xName].file),
      fetchFloat32("/kv-fixture", fixture.arrays[outputName].file),
    ]);
    const inferenceStarted = performance.now();
    const outputs = await session.run({
      x_test: new ort.Tensor("float32", x, fixture.arrays[xName].shape),
      ...cacheFeeds,
    });
    scenarios[rows] = {
      inferenceMs: performance.now() - inferenceStarted,
      outputShape: outputs.logits.dims,
      outputLength: outputs.logits.data.length,
      ...compare(outputs.logits.data, expected),
    };
    if (rows === 32) {
      baseline32 = Float32Array.from(outputs.logits.data);
    }
  }
  const x32Metadata = fixture.arrays.x_32;
  const changedX32 = await fetchFloat32("/kv-fixture", x32Metadata.file);
  for (let row = 0; row < 32; row += 1) {
    changedX32[row * 4] += 0.25;
  }
  const changedFeeds = {
    x_test: new ort.Tensor("float32", changedX32, x32Metadata.shape),
    ...cacheFeeds,
  };
  const changedStarted = performance.now();
  const changedOutputs = await session.run(changedFeeds);
  const changedInferenceMs = performance.now() - changedStarted;
  const warmStarted = performance.now();
  const warmChangedOutputs = await session.run(changedFeeds);
  const warmChangedInferenceMs = performance.now() - warmStarted;
  let responseMaxAbsDelta = 0;
  let repeatMaxAbsDelta = 0;
  for (let index = 0; index < changedOutputs.logits.data.length; index += 1) {
    responseMaxAbsDelta = Math.max(
      responseMaxAbsDelta,
      Math.abs(Number(changedOutputs.logits.data[index]) - Number(baseline32[index])),
    );
    repeatMaxAbsDelta = Math.max(
      repeatMaxAbsDelta,
      Math.abs(
        Number(changedOutputs.logits.data[index])
          - Number(warmChangedOutputs.logits.data[index]),
      ),
    );
  }
  publish({
    status: "supported",
    backend,
    mode,
    variant,
    userAgent: navigator.userAgent,
    webgpu,
    model: {
      sessionLoadMs,
      cacheTensorCount: fixture.cacheNames.length,
      scenarios,
      scenarioInteraction: {
        rows: 32,
        feature: 0,
        offset: 0.25,
        changedInferenceMs,
        warmChangedInferenceMs,
        responseMaxAbsDelta,
        repeatMaxAbsDelta,
      },
      totalMs: performance.now() - started,
    },
  });
}

async function runContext(started, webgpu) {
  const fixture = await fetch("/context-fixture/fixture.json").then((response) => response.json());
  const modelName = "tabpfn35-context-dynamic.onnx";
  const sessionStarted = performance.now();
  const session = await ort.InferenceSession.create(
    `/context-model/${modelName}`,
    {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
      externalData: [{
        path: `${modelName}.data`,
        data: `/context-model/${modelName}.data`,
      }],
    },
  );
  const sessionLoadMs = performance.now() - sessionStarted;
  const scenarios = {};
  for (const scenario of fixture.scenarios) {
    const xName = `x_train_${scenario}`;
    const yName = `y_train_${scenario}`;
    const [xTrain, yTrain, ...expected] = await Promise.all([
      fetchFloat32("/context-fixture", fixture.arrays[xName].file),
      fetchFloat32("/context-fixture", fixture.arrays[yName].file),
      ...fixture.outputNames.map((name) => (
        fetchFloat32("/context-fixture", fixture.arrays[`${name}_${scenario}`].file)
      )),
    ]);
    const inferenceStarted = performance.now();
    const outputs = await session.run({
      x_train: new ort.Tensor("float32", xTrain, fixture.arrays[xName].shape),
      y_train: new ort.Tensor("float32", yTrain, fixture.arrays[yName].shape),
    });
    const tensorComparisons = fixture.outputNames.map((name, index) => (
      compare(outputs[name].data, expected[index])
    ));
    scenarios[scenario] = {
      inferenceMs: performance.now() - inferenceStarted,
      outputTensorCount: fixture.outputNames.length,
      finite: tensorComparisons.every((item) => item.finite),
      maxAbsDelta: Math.max(...tensorComparisons.map((item) => item.maxAbsDelta)),
      meanOfTensorMaxAbsDelta: tensorComparisons.reduce(
        (sum, item) => sum + item.maxAbsDelta,
        0,
      ) / tensorComparisons.length,
    };
  }
  publish({
    status: "supported",
    backend,
    mode,
    userAgent: navigator.userAgent,
    webgpu,
    model: {
      sessionLoadMs,
      scenarios,
      totalMs: performance.now() - started,
    },
  });
}

async function runContextChain(started, webgpu) {
  const fixture = await fetch("/context-chain-fixture/fixture.json").then((response) => response.json());
  const contextModelName = "tabpfn35-context-dynamic.onnx";
  const predictionModelName = "tabpfn35-kv-dynamic.onnx";
  const sessionStarted = performance.now();
  const [contextSession, predictionSession] = await Promise.all([
    ort.InferenceSession.create(`/context-model/${contextModelName}`, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
      externalData: [{
        path: `${contextModelName}.data`,
        data: `/context-model/${contextModelName}.data`,
      }],
    }),
    ort.InferenceSession.create(`/dynamic-context-predict/${predictionModelName}`, {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
      externalData: [{
        path: `${predictionModelName}.data`,
        data: `/dynamic-context-predict/${predictionModelName}.data`,
      }],
    }),
  ]);
  const sessionLoadMs = performance.now() - sessionStarted;
  const scenarios = {};
  for (const scenario of fixture.scenarios) {
    const xTrainName = `x_train_${scenario}`;
    const yTrainName = `y_train_${scenario}`;
    const xTestName = `x_test_${scenario}`;
    const outputName = `output_${scenario}`;
    const [xTrain, yTrain, xTest, expected] = await Promise.all([
      fetchFloat32("/context-chain-fixture", fixture.arrays[xTrainName].file),
      fetchFloat32("/context-chain-fixture", fixture.arrays[yTrainName].file),
      fetchFloat32("/context-chain-fixture", fixture.arrays[xTestName].file),
      fetchFloat32("/context-chain-fixture", fixture.arrays[outputName].file),
    ]);
    const contextStarted = performance.now();
    const cacheOutputs = await contextSession.run({
      x_train: new ort.Tensor("float32", xTrain, fixture.arrays[xTrainName].shape),
      y_train: new ort.Tensor("float32", yTrain, fixture.arrays[yTrainName].shape),
    });
    const contextMs = performance.now() - contextStarted;
    const predictionStarted = performance.now();
    const outputs = await predictionSession.run({
      x_test: new ort.Tensor("float32", xTest, fixture.arrays[xTestName].shape),
      ...Object.fromEntries(fixture.cacheNames.map((name) => [name, cacheOutputs[name]])),
    });
    scenarios[scenario] = {
      contextMs,
      predictionMs: performance.now() - predictionStarted,
      outputShape: outputs.logits.dims,
      ...compare(outputs.logits.data, expected),
    };
  }
  publish({
    status: "supported",
    backend,
    mode,
    userAgent: navigator.userAgent,
    webgpu,
    model: {
      sessionLoadMs,
      scenarios,
      totalMs: performance.now() - started,
    },
  });
}

async function runSharedContextChain(started, webgpu) {
  const fixture = await fetch("/context-chain-fixture/fixture.json").then((response) => response.json());
  const modelBase = "/shared-dynamic-fp16";
  const contextModelName = "tabpfn35-context-dynamic.onnx";
  const predictionModelName = "tabpfn35-predict-dynamic.onnx";
  const sharedDataName = "tabpfn35-shared.data";
  let sharedDataFetchCount = 0;
  const sharedDataStarted = performance.now();
  const sharedDataResponse = await fetch(`${modelBase}/${sharedDataName}`);
  sharedDataFetchCount += 1;
  if (!sharedDataResponse.ok) {
    throw new Error(`Failed to fetch shared external data: ${sharedDataResponse.status}`);
  }
  const sharedData = new Uint8Array(await sharedDataResponse.arrayBuffer());
  const sharedDataLoadMs = performance.now() - sharedDataStarted;

  const externalData = [{ path: sharedDataName, data: sharedData }];
  const contextSessionStarted = performance.now();
  const contextSession = await ort.InferenceSession.create(
    `${modelBase}/${contextModelName}`,
    {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
      externalData,
    },
  );
  const contextSessionLoadMs = performance.now() - contextSessionStarted;
  const predictionSessionStarted = performance.now();
  const predictionSession = await ort.InferenceSession.create(
    `${modelBase}/${predictionModelName}`,
    {
      executionProviders: [backend],
      graphOptimizationLevel: "all",
      externalData,
    },
  );
  const predictionSessionLoadMs = performance.now() - predictionSessionStarted;

  const scenarios = {};
  for (const scenario of fixture.scenarios) {
    const xTrainName = `x_train_${scenario}`;
    const yTrainName = `y_train_${scenario}`;
    const xTestName = `x_test_${scenario}`;
    const outputName = `output_${scenario}`;
    const [xTrain, yTrain, xTest, expected] = await Promise.all([
      fetchFloat32("/context-chain-fixture", fixture.arrays[xTrainName].file),
      fetchFloat32("/context-chain-fixture", fixture.arrays[yTrainName].file),
      fetchFloat32("/context-chain-fixture", fixture.arrays[xTestName].file),
      fetchFloat32("/context-chain-fixture", fixture.arrays[outputName].file),
    ]);
    const contextStarted = performance.now();
    const cacheOutputs = await contextSession.run({
      x_train: new ort.Tensor("float32", xTrain, fixture.arrays[xTrainName].shape),
      y_train: new ort.Tensor("float32", yTrain, fixture.arrays[yTrainName].shape),
    });
    const contextMs = performance.now() - contextStarted;
    const predictionStarted = performance.now();
    const outputs = await predictionSession.run({
      x_test: new ort.Tensor("float32", xTest, fixture.arrays[xTestName].shape),
      ...Object.fromEntries(fixture.cacheNames.map((name) => [name, cacheOutputs[name]])),
    });
    scenarios[scenario] = {
      contextMs,
      predictionMs: performance.now() - predictionStarted,
      outputShape: outputs.logits.dims,
      ...compare(outputs.logits.data, expected),
    };
  }

  publish({
    status: "supported",
    backend,
    mode,
    variant,
    userAgent: navigator.userAgent,
    webgpu,
    sharedExternalData: {
      fetchCount: sharedDataFetchCount,
      bytes: sharedData.byteLength,
      loadMs: sharedDataLoadMs,
      sameUint8ArrayReused: externalData[0].data === sharedData,
    },
    model: {
      contextSessionLoadMs,
      predictionSessionLoadMs,
      scenarios,
      totalMs: performance.now() - started,
    },
  });
}

async function run() {
  const started = performance.now();
  const webgpu = await getWebGpuInfo();
  if (mode === "kv") {
    await runKv(started, webgpu);
  } else if (mode === "context") {
    await runContext(started, webgpu);
  } else if (mode === "context-chain") {
    await runContextChain(started, webgpu);
  } else if (mode === "shared-context-chain") {
    await runSharedContextChain(started, webgpu);
  } else {
    await runFull(started, webgpu);
  }
}

run().catch((error) => {
  publish({
    status: "blocked",
    backend,
    mode,
    errorType: error?.constructor?.name ?? typeof error,
    error: String(error?.stack ?? error),
    webgpuAvailable: Boolean(navigator.gpu),
  });
});
