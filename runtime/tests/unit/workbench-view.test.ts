import test from "node:test";
import assert from "node:assert/strict";
import { renderWorkbench } from "../../app/workbench-view";

const unavailableWebGpu = [
  { name: "IndexedDB 快照", supported: true, checkedAt: "runtime" },
  { name: "WASM", supported: true, checkedAt: "runtime" },
  { name: "WebGPU", supported: false, reason: "未检测到可用适配器", checkedAt: "runtime" },
  { name: "DuckDB WASM", supported: true, checkedAt: "runtime" },
] as const;

test("renders the dataset-first Train/Test workbench hierarchy", () => {
  const markup = renderWorkbench({
    sources: [{ name: "weather", rows: [{ id: 1 }], columns: ["id"] }],
    datasetSql: "SELECT * FROM weather",
    datasetPreview: "<table></table>",
    datasetRowCount: 1,
    datasetColumnCount: 1,
    datasetStale: false,
    trainSql: "SELECT * FROM dataset WHERE id < 1",
    testSql: "SELECT * FROM dataset WHERE id >= 1",
    activeTab: "train",
    target: "demand",
    targets: ["demand"],
    candidates: ["temperature"],
    features: ["temperature"],
    xAxis: "time",
    axes: ["time"],
    trainCount: 1,
    testCount: 1,
    trainPreview: "<table></table>",
    testPreview: "<table></table>",
    splitLabel: "前 80% / 后 20%",
    splitMode: "ratio",
    timeColumns: ["timestamp"],
    timeColumn: "timestamp",
    timeCutoff: "2025-01-02T00:00:00Z",
    busy: false,
    error: undefined,
    status: "准备就绪",
    provider: "wasm",
    precision: "fp32",
    modelState: "未加载",
    capabilities: unavailableWebGpu,
    previewLimit: 200,
    runStatus: "",
    dialog: "",
    points: [],
    resultTarget: "",
    resultAxis: "",
    resultSummary: "",
    resultPreview: "",
  } as never);
  assert.match(markup, /id="dataset-query"/);
  assert.match(markup, /id="train-tab"[^>]*role="tab"/);
  assert.match(markup, /id="test-tab"[^>]*role="tab"/);
  assert.match(markup, /id="train-preview"/);
  assert.match(markup, /id="test-preview"/);
  assert.match(markup, /id="x-axis"/);
  assert.match(markup, /id="run-model"[^>]*disabled/);
  assert.match(markup, /id="model-state" class="model-state unavailable"/);
  assert.match(markup, /id="apply-ratio-split"[^>]*aria-pressed="true"/);
  assert.match(markup, /id="apply-time-split"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(markup, /id="time-column"/);
  assert.doesNotMatch(markup, /id="time-cutoff"/);
  const configPanel = markup.slice(markup.indexOf('id="config-panel"'), markup.indexOf('id="model-panel"'));
  assert.doesNotMatch(configPanel, /id="x-axis"/);
  assert.match(markup, /输入特征/);
  assert.match(markup, />全部<\/span>/);
  assert.doesNotMatch(markup, /全部（排除预测目标后）/);
  assert.match(markup, /data-feature-all/);
  assert.match(markup, /WebGPU<\/span><small>不可用/);
  assert.match(markup, /DuckDB WASM<\/span><small>可用/);
  assert.doesNotMatch(markup, /<option value="webgpu"/);
  assert.doesNotMatch(markup, /save-experiment/);
  assert.doesNotMatch(markup, /capabilities-and-experiments/);
  assert.doesNotMatch(markup, /id="load-predict"/);
  assert.doesNotMatch(markup, /data-table="predictions"/);
});

test("renders time split controls only for the selected time mode", () => {
  const markup = renderWorkbench({
    sources: [], datasetSql: "SELECT * FROM dataset", datasetPreview: "", datasetRowCount: 10, datasetColumnCount: 2, datasetStale: false,
    trainSql: "SELECT * FROM dataset", testSql: "SELECT * FROM dataset", activeTab: "train", target: "demand", targets: [], candidates: [], features: [], xAxis: "", axes: [],
    trainPreview: "", testPreview: "", splitLabel: "时间切分 · timestamp < 2025-01-02T00:00:00Z / ≥ 2025-01-02T00:00:00Z", splitMode: "time",
    timeColumns: ["timestamp"], timeColumn: "timestamp", timeCutoff: "2025-01-02T00:00:00Z", busy: false, status: "准备就绪", provider: "wasm", precision: "fp32", modelState: "未加载", capabilities: unavailableWebGpu, previewLimit: 200,
    runStatus: "", dialog: "", points: [], resultTarget: "", resultAxis: "", chartScopeStart: 0, chartScopeEnd: 0, resultSummary: "", resultPreview: "",
  });
  assert.match(markup, /id="apply-ratio-split"[^>]*aria-pressed="false"/);
  assert.match(markup, /id="apply-time-split"[^>]*aria-pressed="true"/);
  assert.match(markup, /id="time-column"/);
  assert.match(markup, /id="time-cutoff"/);
});

test("allows a loaded model to prepare inputs on demand", () => {
  const markup = renderWorkbench({
    sources: [], datasetSql: "SELECT * FROM dataset", datasetPreview: "", datasetRowCount: 10, datasetColumnCount: 2, datasetStale: false,
    trainSql: "SELECT * FROM dataset", testSql: "SELECT * FROM dataset", activeTab: "train", target: "", targets: [], candidates: [], features: [], xAxis: "", axes: [],
    trainPreview: "", testPreview: "", splitLabel: "前 80% / 后 20%", splitMode: "ratio", timeColumns: [], timeColumn: "", timeCutoff: "", busy: false, status: "模型已加载，可以运行 Test 预测。", provider: "wasm", precision: "fp32", modelState: "已加载", previewLimit: 200,
    capabilities: [{ name: "WebGPU", supported: true, checkedAt: "runtime" }], runStatus: "", dialog: "", points: [], resultTarget: "", resultAxis: "", chartScopeStart: 0, chartScopeEnd: 0, resultSummary: "", resultPreview: "",
  });
  assert.match(markup, /id="run-model"[^>]*title="运行 Test 预测"(?![^>]*disabled)/);
  assert.match(markup, /id="model-state" class="model-state ready"/);
  assert.match(markup, /<option value="webgpu"/);
});
