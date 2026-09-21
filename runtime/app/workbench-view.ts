import { renderPredictionChart, type PredictionPoint } from "./prediction-chart";
import { renderCapabilities } from "./capability-status";
import type { CapabilityEvidence } from "../src/workbench/types";

export const html = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export interface WorkbenchViewModel {
  readonly sources: readonly { name: string; rows: readonly unknown[]; columns: readonly string[] }[];
  readonly datasetSql: string;
  readonly datasetPreview: string;
  readonly datasetRowCount?: number;
  readonly datasetColumnCount?: number;
  readonly datasetStale: boolean;
  readonly trainSql: string;
  readonly testSql: string;
  readonly activeTab: "train" | "test";
  readonly target: string;
  readonly targets: readonly string[];
  readonly candidates: readonly string[];
  readonly features: readonly string[];
  readonly xAxis: string;
  readonly axes: readonly string[];
  readonly trainCount?: number;
  readonly testCount?: number;
  readonly trainPreview: string;
  readonly testPreview: string;
  readonly splitLabel: string;
  readonly splitMode: "ratio" | "time";
  readonly timeColumns?: readonly string[];
  readonly timeColumn?: string;
  readonly timeCutoff?: string;
  readonly busy: boolean;
  readonly predictionBlocker?: string;
  readonly error?: string;
  readonly status: string;
  readonly provider: string;
  readonly precision: string;
  readonly modelState: string;
  readonly capabilities?: readonly CapabilityEvidence[];
  readonly previewLimit: number;
  readonly runStatus: string;
  readonly dialog: string;
  readonly points: readonly PredictionPoint[];
  readonly resultTarget: string;
  readonly resultAxis: string;
  readonly chartScopeStart: number;
  readonly chartScopeEnd: number;
  readonly resultSummary: string;
  readonly resultPreview: string;
}

function options(values: readonly string[], selected: string): string {
  return values.map((value) => `<option value="${html(value)}" ${value === selected ? "selected" : ""}>${html(value)}</option>`).join("");
}

function countLabel(value: number | undefined, empty = "尚未执行"): string {
  return value === undefined ? empty : `${value} 行实际输入`;
}

function modelStateTone(value: string): "ready" | "checking" | "unavailable" {
  if (value === "已加载") return "ready";
  if (/加载中|检查|下载/.test(value)) return "checking";
  return "unavailable";
}

export function renderWorkbench(v: WorkbenchViewModel): string {
  const disabled = v.busy ? "disabled" : "";
  const activeTrain = v.activeTab === "train";
  const capabilities = v.capabilities ?? [];
  const webgpuAvailable = capabilities.some((entry) => entry.name === "WebGPU" && entry.supported);
  const allFeaturesSelected = v.candidates.length > 0 && v.features.length === v.candidates.length && v.candidates.every((name) => v.features.includes(name));
  const runDisabled = v.busy || v.modelState !== "已加载" || Boolean(v.predictionBlocker);
  const runTitle = v.predictionBlocker ?? (v.modelState !== "已加载" ? "请先加载模型" : "运行 Test 预测");
  return `<div class="shell">
    <header class="topbar"><div class="brand"><strong>Tabloom</strong><span>预测工作台</span></div><div class="topbar-right"><span class="local-note">浏览器内计算 · 数据留在本地</span>${renderCapabilities(capabilities)}</div></header>
    <div class="layout">
      <aside class="sidebar">
        <section class="side-block"><div class="panel-heading"><div><span class="eyebrow">INPUTS</span><h2>数据源</h2></div><button id="add-source" ${disabled}>添加</button></div>
          <p class="hint">先添加一个或多个源，再物化为 Dataset。</p>
          <div class="source-list">${v.sources.length ? v.sources.map((source) => `<button class="table-card" data-source="${html(source.name)}" ${disabled}><strong>${html(source.name)}</strong><span>${source.rows.length} 行 · ${source.columns.length} 列</span></button>`).join("") : `<p class="empty-note">还没有数据源。可从“添加”里选择示例数据。</p>`}</div>
        </section>
        <section class="side-block side-actions"><span class="eyebrow">OUTPUT</span><h2>导出</h2><button id="download-results" ${disabled || !v.points.length ? "disabled" : ""}>下载 Test 预测 CSV</button><button id="export-experiment" ${disabled || !v.target ? "disabled" : ""}>导出实验 JSON</button></section>
      </aside>
      <main class="workspace">
        <section class="workspace-card dataset-card" id="dataset-panel">
          <div class="section-heading"><div><span class="eyebrow">01 · DATASET</span><h1>构建 Dataset</h1><p class="hint">把一个或多个数据源物化成稳定的数据集；JOIN、列选择和清洗逻辑都写在这里。</p></div><button id="build-dataset" class="primary" ${disabled || !v.sources.length ? "disabled" : ""}>${v.datasetStale ? "重新生成 Dataset" : "生成 Dataset"}</button></div>
          <label class="sql-label"><span>Dataset SQL <small>可引用左侧数据源，例如 ${v.sources.length ? html(v.sources[0].name) : "weather"}</small></span><textarea id="dataset-query" spellcheck="false" ${disabled}>${html(v.datasetSql)}</textarea></label>
          ${v.datasetStale ? `<p class="stale-note" role="status">数据源或 Dataset SQL 已改变，当前 Dataset 需要重新生成。</p>` : ""}
          <div class="dataset-meta"><span>${v.datasetRowCount === undefined ? "尚未物化" : `${v.datasetRowCount} 行 · ${v.datasetColumnCount ?? 0} 列`}</span><span>预览上限 ${v.previewLimit} 行</span></div>
          ${v.datasetRowCount === undefined ? "" : `<details id="dataset-preview"><summary>查看 Dataset 预览 <span class="hint">不影响实际输入行数</span></summary>${v.datasetPreview}</details>`}
        </section>

        <section class="workspace-card split-card" id="split-panel">
          <div class="section-heading"><div><span class="eyebrow">02 · SPLIT</span><h2>Train / Test 输入</h2><p class="hint">SQL 的返回列、WHERE、ORDER BY 和 LIMIT 决定真正送入模型的数据；预览只负责查看。</p></div><button id="prepare-input" ${disabled || v.datasetRowCount === undefined || v.datasetStale ? "disabled" : ""}>执行 Train / Test SQL</button></div>
          <div class="split-controls"><span class="split-label">当前切分：${html(v.splitLabel)}</span><div class="split-options" role="group" aria-label="切分方式"><button class="split-action ${v.splitMode === "ratio" ? "selected" : ""}" type="button" id="apply-ratio-split" aria-pressed="${v.splitMode === "ratio"}" ${disabled || v.datasetRowCount === undefined ? "disabled" : ""}>应用 80 / 20</button><button class="split-action ${v.splitMode === "time" ? "selected" : ""}" type="button" id="apply-time-split" aria-pressed="${v.splitMode === "time"}" ${disabled || v.datasetRowCount === undefined ? "disabled" : ""}>应用时间切分</button></div>${v.splitMode === "time" ? `<div class="split-time-fields"><label class="split-field">时间列<select id="time-column" ${disabled || v.datasetRowCount === undefined ? "disabled" : ""}><option value="">自动选择</option>${options(v.timeColumns ?? [], v.timeColumn ?? "")}</select></label><label class="split-field">切分点<input id="time-cutoff" type="text" value="${html(v.timeCutoff ?? "")}" placeholder="2025-01-02T00:00:00Z" ${disabled || v.datasetRowCount === undefined ? "disabled" : ""}></label></div>` : ""}</div>
          <div class="tabs" role="tablist" aria-label="数据切分"><button id="train-tab" role="tab" aria-selected="${activeTrain}" aria-controls="train-panel" data-tab="train" tabindex="${activeTrain ? "0" : "-1"}">Train <span>${v.trainCount === undefined ? "" : v.trainCount}</span></button><button id="test-tab" role="tab" aria-selected="${!activeTrain}" aria-controls="test-panel" data-tab="test" tabindex="${activeTrain ? "-1" : "0"}">Test <span>${v.testCount === undefined ? "" : v.testCount}</span></button></div>
          <section id="train-panel" role="tabpanel" aria-labelledby="train-tab" ${activeTrain ? "" : "hidden"}>
            <label class="sql-label"><span>Train SQL <small id="train-count">${countLabel(v.trainCount)}</small></span><textarea id="training-query" spellcheck="false" ${disabled}>${html(v.trainSql)}</textarea><span class="hint">用于拟合上下文；必须包含目标列和所选特征。</span></label>
            ${v.trainCount === undefined ? "" : `<details id="train-preview"><summary>Train data preview <span class="hint">${v.trainCount} 行实际输入</span></summary>${v.trainPreview}</details>`}
          </section>
          <section id="test-panel" role="tabpanel" aria-labelledby="test-tab" ${activeTrain ? "hidden" : ""}>
            <label class="sql-label"><span>Test SQL <small id="test-count">${countLabel(v.testCount)}</small></span><textarea id="test-query" spellcheck="false" ${disabled}>${html(v.testSql)}</textarea><span class="hint">这些行会被原样保留，并在其上附加 mean、q25、q75 和可选真值。</span></label>
            ${v.testCount === undefined ? "" : `<details id="test-preview"><summary>Test data preview <span class="hint">${v.testCount} 行实际输入</span></summary>${v.testPreview}</details>`}
          </section>
          ${v.error ? `<p class="query-error" role="alert">${html(v.error)}</p>` : ""}
        </section>

        <section class="workspace-card config-card" id="config-panel">
          <div class="section-heading"><div><span class="eyebrow">03 · SCHEMA</span><h2>定义目标与特征</h2><p class="hint">目标只能选一个；特征可多选。Test 中同名目标只作为真值对照，不会泄漏到输入。</p></div></div>
          <div class="tag-columns"><fieldset class="tag-group"><legend>预测目标 <span>单选</span></legend><div class="tag-list">${v.targets.length ? v.targets.map((name) => `<label class="tag ${name === v.target ? "selected" : ""}"><input type="radio" name="target" data-target="${html(name)}" value="${html(name)}" ${name === v.target ? "checked" : ""} ${disabled}><span>${html(name)}</span></label>`).join("") : `<p class="hint">执行 SQL 后显示数值列。</p>`}</div></fieldset><fieldset class="tag-group"><legend>输入特征 <span>可多选 · ${v.features.length} 列</span></legend><div class="tag-list">${v.candidates.length ? `<label class="tag tag-all ${allFeaturesSelected ? "selected" : ""}"><input type="checkbox" data-feature-all aria-label="全部输入特征" ${allFeaturesSelected ? "checked" : ""} ${disabled}><span>全部</span></label>${v.candidates.map((name) => `<label class="tag ${v.features.includes(name) ? "selected" : ""}"><input type="checkbox" data-feature="${html(name)}" ${v.features.includes(name) ? "checked" : ""} ${disabled}><span>${html(name)}</span></label>`).join("")}` : `<p class="hint">执行 SQL 后显示 Train/Test 共有的数值列。</p>`}</div></fieldset></div>
        </section>

        <section class="workspace-card model-card" id="model-panel">
          <div class="section-heading"><div><span class="eyebrow">04 · MODEL</span><h2>模型与执行</h2><p class="hint">选择可用模型、权重存储精度和计算后端。</p></div><div class="model-actions"><span id="model-state" class="model-state ${modelStateTone(v.modelState)}" role="status">${html(v.modelState)}</span><button id="load-model" ${disabled}>${v.modelState === "已加载" ? "重新加载模型" : "加载模型"}</button></div></div>
          <div class="model-grid"><label>模型<select id="model-name" ${disabled}><option value="tabpfn-3.5">TabPFN 3.5 · 数值回归</option><option disabled>TabICL · 当前工作台不支持动态拟合</option></select></label><label>权重精度<select id="precision" ${disabled}><option value="fp32" ${v.precision === "fp32" ? "selected" : ""}>FP32</option><option value="fp16-storage" ${v.precision === "fp16-storage" ? "selected" : ""}>FP16 存储 / FP32 计算</option></select></label><label>计算后端<select id="provider" ${disabled}><option value="wasm" ${v.provider === "wasm" ? "selected" : ""}>WASM</option>${webgpuAvailable ? `<option value="webgpu" ${v.provider === "webgpu" ? "selected" : ""}>WebGPU</option>` : ""}</select></label></div>
          <div class="run-bar"><span class="status-pill" role="status">${html(v.status)}</span><button id="run-model" class="primary" title="${html(runTitle)}" ${runDisabled ? "disabled" : ""}>运行 Test 预测</button></div>${v.runStatus}
        </section>

        <section class="workspace-card result-section" id="result-panel"><div class="section-heading"><div><span class="eyebrow">05 · RESULT</span><h2>Test 预测结果${v.points.length ? ` · ${html(v.resultTarget)}` : ""}</h2><p class="hint" id="result-summary">${html(v.resultSummary)}</p></div><label class="axis-select result-axis">横轴选择<select id="x-axis" aria-label="横轴选择" ${disabled || !v.testCount ? "disabled" : ""}><option value="">输入行序号</option>${options(v.axes, v.xAxis)}</select></label></div>${renderPredictionChart(v.points, v.resultTarget, v.resultAxis, { start: v.chartScopeStart, end: v.chartScopeEnd })}${v.points.length ? `<details id="prediction-details"><summary>查看 Test 行与预测明细</summary><div id="prediction-table">${v.resultPreview}</div></details>` : ""}</section>
      </main>
    </div>${v.dialog}
  </div>`;
}
