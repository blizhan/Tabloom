import { tableFromArrays } from "apache-arrow";
import { validateReadonlyQuery } from "../src/workbench/query-service";
import { numericColumns, preparePredictionInput } from "../src/workbench/prediction-input";
import type { DuckDbResult } from "../src/data/duckdb-service";
import { renderWorkbench } from "./workbench-view";
import { bindPredictionChart, relabelPredictionPoints, type PredictionPoint } from "./prediction-chart";
import { DataSnapshotStore, type SnapshotFormat } from "../src/storage/data-snapshot-store";
import type { WorkbenchPrecision, WorkbenchProvider } from "../src/storage/workbench-experiment-store";
import { InputSnapshotStore } from "../src/data/input-snapshots";
import { DuckDbService, escapeIdentifier } from "../src/data/duckdb-service";
import { createDuckDbWasmExecutor } from "../src/data/duckdb-wasm-executor";
import { RuntimeClient } from "../src/coordinator/runtime-client";
import { RuntimeCoordinator } from "../src/coordinator/runtime-coordinator";
import { WorkerModelClient } from "../src/coordinator/worker-model-client";
import { RuntimeError } from "../src/model/errors";
import type { ModelContext } from "../src/model/types";
import { decodeSource } from "../src/workbench/file-codecs";
import { fetchRemoteSource } from "../src/workbench/remote-source";
import { OperationEventBus } from "../src/workbench/operation-events";
import { assertSourceImportActive, sourceNameKey } from "../src/workbench/source-snapshots";
import { renderAddSourceDialog, readAddSourceInput, validateAddSourceInput, type AddSourceInput, type SourceFormatChoice } from "./components/AddSourceDialog";
import { renderRunStatus, type RunStatusView } from "./components/RunStatus";
import type { CapabilityEvidence } from "../src/workbench/types";
import { createSplitSql, DATASET_ROW_ID, materializeWorkbenchDataset, type SplitPreset, validateSourceName } from "../src/workbench/dataset-workflow";
import { loadSourceBytes } from "./source-loader";
import type { ModelAssetEvent } from "../src/workbench/model-asset-status";
import { enrichTestRows } from "../src/workbench/test-results";
import { probeWebGpuAdapter } from "../src/model/provider";

type WorkbenchCell = string | number | boolean | null;
interface WorkbenchRow { readonly [column: string]: WorkbenchCell; }
interface Table { readonly name: string; readonly columns: readonly string[]; readonly rows: readonly WorkbenchRow[]; readonly snapshotId: string; readonly format: SnapshotFormat; }
interface QueryResult { readonly columns: readonly string[]; readonly rows: readonly WorkbenchRow[]; readonly total: number; readonly meanColumn: string; readonly q25Column: string; readonly q75Column: string; readonly truthColumn: string; }
interface DatasetState { readonly sql: string; readonly table: Table; readonly stale: boolean; }
interface PreparedInputs { readonly train: DuckDbResult; readonly test: DuckDbResult; readonly revision: number; }

function toWorkbenchRow(row: Record<string, unknown>): WorkbenchRow {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCell(value)])) as WorkbenchRow;
}
function normalizeCell(value: unknown): WorkbenchCell { if (value === null || value === undefined) return null; if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value; if (typeof value === "bigint" && Number.isSafeInteger(Number(value))) return Number(value); if (value instanceof Date) return value.toISOString(); return String(value); }
function businessKeys(rows: readonly WorkbenchRow[], columns: readonly string[]): readonly unknown[] { if (columns.includes(DATASET_ROW_ID)) return rows.map((row) => row[DATASET_ROW_ID]); return rows.map((_row, index) => index); }
function likelyTimeColumn(columns: readonly string[]): string | undefined { return columns.find((name) => /timestamp|target_time|event[_ ]?time|^time$|^date$/i.test(name)); }
function isInternalColumn(name: string): boolean { return name === DATASET_ROW_ID || name.startsWith("__tabloom_"); }
function featureCandidates(prepared: PreparedInputs | undefined, target: string): string[] {
  if (!prepared) return [];
  const targets = numericColumns(prepared.train).filter((name) => !isInternalColumn(name));
  const testNumbers = numericColumns(prepared.test);
  return targets.filter((name) => name !== target && testNumbers.includes(name) && !/(^id$|_id$|ordinal|timestamp|available_at|__tabloom_)/i.test(name));
}
function formatForCodec(format: SnapshotFormat): "csv" | "json" | "arrow-ipc" | "parquet" { if (format === "arrow") return "arrow-ipc"; if (format === "csv" || format === "json" || format === "parquet") return format; throw new Error(`格式 ${format} 暂不支持关系型导入`); }

export function mountWorkbench(root: HTMLElement): void { new WorkbenchApp(root).start(); }

class WorkbenchApp {
  private readonly snapshots = new DataSnapshotStore();
  private readonly events = new OperationEventBus();
  private readonly tables = new Map<string, Table>();
  private selectedSourceName = "";
  private dataset?: DatasetState;
  private datasetSql = "SELECT * FROM weather_example";
  private trainingSql = "SELECT * FROM dataset";
  private testSql = "SELECT * FROM dataset";
  private splitPreset: SplitPreset = { mode: "ratio" };
  private splitMode: "ratio" | "time" = "ratio";
  private splitLabel = "前 80% / 后 20%";
  private timeColumn = "";
  private timeCutoff = "";
  private activeTab: "train" | "test" = "train";
  private target = "";
  private features: string[] = [];
  private featuresTouched = false;
  private xAxis = "";
  private prepared?: PreparedInputs;
  private dataDb?: Promise<DuckDbService>;
  private registered = new Map<string, string>();
  private chartPoints: PredictionPoint[] = [];
  private resultTarget = "";
  private resultAxis = "";
  private resultSummary = "";
  private result?: QueryResult;
  private resultStale = false;
  private lastQueryError: string | undefined;
  private status = "准备就绪。添加数据源后生成 Dataset。";
  private busy = false;
  private configRevision = 0;
  private runStatus: RunStatusView = { stage: "idle", status: "complete", completed: null, total: null, message: "尚未执行查询" };
  private provider: WorkbenchProvider = "wasm";
  private precision: WorkbenchPrecision = "fp32";
  private modelState = "未加载";
  private modelRuntime?: RuntimeCoordinator;
  private modelAdapter?: WorkerModelClient;
  private modelRuntimeKey?: string;
  private modelContext?: ModelContext;
  private modelRunGeneration = 0;
  private activeModelRequestId?: string;
  private modelCancelRequested = false;
  private sourceImportController?: AbortController;
  private chartCleanup?: () => void;
  private chartScopeStart = 0;
  private chartScopeEnd = -1;
  private webgpuAvailable = false;
  private webgpuChecked = false;
  private webgpuReason = "正在检测";
  private duckdbAvailable = false;
  private duckdbChecked = false;
  private duckdbReason = "正在检测";
  private readonly root: HTMLElement;

  constructor(root: HTMLElement) { this.root = root; }
  start(): void {
    this.render();
    void this.refreshCapabilities();
    if (typeof matchMedia !== "undefined") matchMedia("(max-width: 600px)").addEventListener("change", () => this.render());
  }

  private render(): void {
    this.chartCleanup?.();
    const focusedElement = document.activeElement;
    const focusedId = focusedElement instanceof HTMLElement && this.root.contains(focusedElement) ? focusedElement.id : undefined;
    const selection = focusedElement instanceof HTMLInputElement || focusedElement instanceof HTMLTextAreaElement
      ? { start: focusedElement.selectionStart, end: focusedElement.selectionEnd, direction: focusedElement.selectionDirection }
      : undefined;
    const open = [...this.root.querySelectorAll<HTMLDetailsElement>("details[open]")].map((node) => node.id).filter(Boolean);
    const prepared = this.prepared;
    const targets = prepared ? numericColumns(prepared.train).filter((name) => !isInternalColumn(name)) : [];
    const candidates = featureCandidates(prepared, this.target);
    const predictionBlocker = this.getPredictionBlocker();
    const displayStatus = !this.busy && this.modelState === "已加载" && predictionBlocker ? `模型已加载；${predictionBlocker}` : this.status;
    const chartScope = this.getChartScope();
    const datasetPreview = this.dataset ? renderTable({ columns: this.dataset.table.columns, rows: this.dataset.table.rows.slice(0, 200), total: this.dataset.table.rows.length }) : "";
    const resultSummary = this.resultStale ? `上次运行结果（配置已改变） · ${this.resultSummary}` : this.resultSummary;
    this.root.innerHTML = renderWorkbench({
      sources: [...this.tables.values()], datasetSql: this.datasetSql, datasetPreview, datasetRowCount: this.dataset?.table.rows.length, datasetColumnCount: this.dataset?.table.columns.length, datasetStale: this.dataset?.stale ?? false,
      trainSql: this.trainingSql, testSql: this.testSql, activeTab: this.activeTab, target: this.target, targets, candidates, features: this.features, xAxis: this.xAxis, axes: prepared?.test.columns.filter((column) => column !== this.target && !isInternalColumn(column)) ?? [], trainCount: prepared?.train.rows.length, testCount: prepared?.test.rows.length,
      trainPreview: prepared ? renderTable({ columns: prepared.train.columns, rows: prepared.train.rows.slice(0, 200).map(toWorkbenchRow), total: prepared.train.rows.length }) : "", testPreview: prepared ? renderTable({ columns: prepared.test.columns, rows: prepared.test.rows.slice(0, 200).map(toWorkbenchRow), total: prepared.test.rows.length }) : "", splitLabel: this.splitLabel, splitMode: this.splitMode, timeColumns: this.dataset?.table.columns.filter((name) => /timestamp|target_time|event[_ ]?time|^time$|^date$/i.test(name)) ?? [], timeColumn: this.timeColumn, timeCutoff: this.timeCutoff,
      busy: this.busy, predictionBlocker, error: this.lastQueryError, status: displayStatus, provider: this.provider, precision: this.precision, modelState: this.modelState, capabilities: this.capabilities(), previewLimit: 200, runStatus: this.busy || this.runStatus.status === "failed" ? renderRunStatus(this.runStatus, { canCancel: this.busy, canRetry: false }) : "", dialog: renderAddSourceDialog(), points: this.chartPoints, resultTarget: this.resultTarget, resultAxis: this.resultAxis, chartScopeStart: chartScope.start, chartScopeEnd: chartScope.end, resultSummary, resultPreview: this.result ? renderTable(this.result) : "",
    });
    for (const id of open) { const node = this.root.querySelector<HTMLDetailsElement>(`#${CSS.escape(id)}`); if (node) node.open = true; }
    this.bindEvents();
    this.chartCleanup = bindPredictionChart(this.root, this.chartPoints);
    if (focusedId) {
      const node = this.root.querySelector<HTMLElement>(`#${CSS.escape(focusedId)}`);
      node?.focus({ preventScroll: true });
      if (node && selection && (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) && selection.start !== null && selection.end !== null) {
        node.setSelectionRange(selection.start, selection.end, selection.direction ?? "none");
      }
    }
  }

  private async ensureDataDb(): Promise<DuckDbService> {
    if (!this.dataDb) this.dataDb = (async () => { const connection = await createDuckDbWasmExecutor({ workerUrl: new URL("runtime-assets/duckdb/duckdb-browser-mvp.worker.js", document.baseURI).toString(), wasmUrl: new URL("runtime-assets/duckdb/duckdb-mvp.wasm", document.baseURI).toString() }); const db = new DuckDbService(connection.executor); await db.open(); return db; })().then((db) => { this.duckdbAvailable = true; this.duckdbChecked = true; this.duckdbReason = "DuckDB WASM 已初始化"; return db; }).catch((error) => { this.dataDb = undefined; this.duckdbAvailable = false; this.duckdbChecked = true; this.duckdbReason = error instanceof Error ? error.message : String(error); throw error; });
    return this.dataDb;
  }

  private async ensureSourcesRegistered(db: DuckDbService): Promise<void> {
    for (const table of this.tables.values()) {
      if (this.registered.get(table.name) === table.snapshotId) continue;
      const staging = `__tabloom_import_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const columns = Object.fromEntries(table.columns.map((name) => [name, table.rows.map((row) => row[name])]));
      await db.registerArrow(tableFromArrays(columns), staging);
      await db.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(table.name)}`);
      await db.exec(`ALTER TABLE ${escapeIdentifier(staging)} RENAME TO ${escapeIdentifier(table.name)}`);
      this.registered.set(table.name, table.snapshotId);
    }
  }

  private async ensureDatasetRegistered(db: DuckDbService): Promise<void> {
    const dataset = this.dataset;
    if (!dataset || dataset.stale || this.registered.get("dataset") === dataset.table.snapshotId) return;
    const staging = `__tabloom_dataset_restore_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const columns = Object.fromEntries(dataset.table.columns.map((name) => [name, dataset.table.rows.map((row) => row[name])]));
    await db.registerArrow(tableFromArrays(columns), staging);
    await db.exec(`DROP TABLE IF EXISTS ${escapeIdentifier("dataset")}`);
    await db.exec(`ALTER TABLE ${escapeIdentifier(staging)} RENAME TO ${escapeIdentifier("dataset")}`);
    this.registered.set("dataset", dataset.table.snapshotId);
  }

  private async queryInput(sql: string): Promise<DuckDbResult> {
    validateReadonlyQuery(sql);
    const db = await this.ensureDataDb();
    await this.ensureSourcesRegistered(db);
    await this.ensureDatasetRegistered(db);
    const result = await db.query(sql);
    return { columns: result.columns, rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeCell(value)]))) };
  }

  private markChanged(datasetChanged = false, inputsChanged = true): void {
    this.configRevision += 1;
    if (inputsChanged) this.prepared = undefined;
    if (datasetChanged) {
      if (this.dataset) this.dataset = { ...this.dataset, stale: true };
    }
    if (this.result) this.resultStale = true;
  }

  private async buildDataset(): Promise<void> {
    if (this.busy || !this.tables.size) return;
    const revision = this.configRevision;
    this.busy = true; this.lastQueryError = undefined; this.status = "正在物化 Dataset…"; this.runStatus = { stage: "dataset", status: "running", completed: null, total: null }; this.render();
    try {
      const db = await this.ensureDataDb(); await this.ensureSourcesRegistered(db);
      const previous = this.dataset;
      const result = await materializeWorkbenchDataset(db, this.datasetSql);
      if (revision !== this.configRevision) throw new Error("Dataset 配置已改变，请重新生成。");
      const table: Table = { name: "dataset", columns: result.columns, rows: result.rows.map(toWorkbenchRow), snapshotId: `dataset-${crypto.randomUUID()}`, format: "duckdb" };
      this.dataset = { sql: this.datasetSql, table, stale: false };
      this.registered.set("dataset", table.snapshotId);
      if (!previous || previous.stale) {
        const orderBy = likelyTimeColumn(result.columns);
        this.timeColumn = orderBy ?? "";
        this.timeCutoff = "";
        this.splitMode = "ratio";
        this.splitPreset = orderBy ? { mode: "ratio", orderBy } : { mode: "ratio" };
        const split = createSplitSql(this.splitPreset); this.trainingSql = split.trainingSql; this.testSql = split.testSql; this.splitLabel = orderBy ? `前 80% / 后 20% · 按 ${orderBy} 排序` : "前 80% / 后 20%";
      }
      this.prepared = undefined; this.chartScopeStart = 0; this.chartScopeEnd = -1; this.resultStale = Boolean(this.result); this.configRevision += 1; this.status = `Dataset 已生成：${table.rows.length} 行 · ${table.columns.length} 列`; this.runStatus = { stage: "dataset", status: "complete", completed: table.rows.length, total: table.rows.length, message: "Dataset 已物化" };
    } catch (error) { this.lastQueryError = this.describeQueryError(error); this.status = `Dataset 生成失败：${this.lastQueryError}`; this.runStatus = { stage: "dataset", status: "failed", message: this.lastQueryError }; }
    finally { this.busy = false; this.render(); }
  }

  private applyRatioSplit(): void {
    if (!this.dataset || this.busy) return;
    const orderBy = likelyTimeColumn(this.dataset.table.columns);
    this.timeColumn = orderBy ?? "";
    this.timeCutoff = "";
    this.splitMode = "ratio";
    this.splitPreset = orderBy ? { mode: "ratio", orderBy } : { mode: "ratio" };
    const split = createSplitSql(this.splitPreset); this.trainingSql = split.trainingSql; this.testSql = split.testSql; this.splitLabel = orderBy ? `前 80% / 后 20% · 按 ${orderBy} 排序` : "前 80% / 后 20%"; this.markChanged(); this.render();
  }

  private applyTimeSplit(): void {
    if (!this.dataset || this.busy) return;
    const column = this.root.querySelector<HTMLSelectElement>("#time-column")?.value || likelyTimeColumn(this.dataset.table.columns);
    if (!column) { this.lastQueryError = "当前 Dataset 没有可识别的时间列，请使用 80 / 20 切分或在 SQL 中手动指定。"; this.render(); return; }
    const values = this.dataset.table.rows.map((row) => row[column]).filter((value): value is string | number => typeof value === "string" || typeof value === "number");
    const cutoff = this.root.querySelector<HTMLInputElement>("#time-cutoff")?.value || String(values[Math.min(values.length - 1, Math.floor(values.length * 0.8))] ?? "");
    try { const split = createSplitSql({ mode: "time", column, cutoff }); this.timeColumn = column; this.timeCutoff = cutoff; this.splitMode = "time"; this.splitPreset = { mode: "time", column, cutoff }; this.trainingSql = split.trainingSql; this.testSql = split.testSql; this.splitLabel = `时间切分 · ${column} < ${cutoff} / ≥ ${cutoff}`; this.markChanged(); this.render(); }
    catch (error) { this.lastQueryError = this.describeQueryError(error); this.render(); }
  }

  private async prepareInputs(): Promise<void> {
    if (!this.dataset || this.dataset.stale) throw new Error("请先生成最新 Dataset。");
    const train = await this.queryInput(this.trainingSql); const test = await this.queryInput(this.testSql);
    if (!train.rows.length || !test.rows.length) throw new Error("Train 或 Test SQL 返回 0 行，请调整切分条件。");
    this.prepared = { train, test, revision: this.configRevision };
    const targets = numericColumns(train).filter((name) => !isInternalColumn(name)); if (!targets.includes(this.target)) this.target = targets.includes("demand_mwh") ? "demand_mwh" : targets.at(-1) ?? "";
    const candidates = featureCandidates(this.prepared, this.target);
    this.features = this.features.filter((name) => candidates.includes(name)); if (!this.features.length && !this.featuresTouched) this.features = [...candidates];
    if (!test.columns.includes(this.xAxis) || this.xAxis === this.target || isInternalColumn(this.xAxis)) this.xAxis = likelyTimeColumn(test.columns.filter((name) => name !== this.target && !isInternalColumn(name))) ?? "";
  }

  private async checkInputs(): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.lastQueryError = undefined; this.status = "正在执行 Train / Test SQL…"; this.runStatus = { stage: "validate", status: "running" }; this.render();
    const revision = this.configRevision;
    try { await this.prepareInputs(); if (revision !== this.configRevision) throw new Error("输入配置已改变，请重新执行。"); this.status = `输入已就绪：Train ${this.prepared!.train.rows.length} 行 · Test ${this.prepared!.test.rows.length} 行`; this.runStatus = { stage: "validate", status: "complete", completed: this.prepared!.train.rows.length + this.prepared!.test.rows.length, total: this.prepared!.train.rows.length + this.prepared!.test.rows.length }; }
    catch (error) { this.prepared = undefined; this.lastQueryError = this.describeQueryError(error); this.status = "Train / Test SQL 执行失败"; this.runStatus = { stage: "validate", status: "failed", message: this.lastQueryError }; }
    finally { this.busy = false; this.render(); }
  }

  private bindEvents(): void {
    this.root.querySelector("#add-source")?.addEventListener("click", () => this.openSourceDialog());
    this.root.querySelector("#build-dataset")?.addEventListener("click", () => void this.buildDataset());
    this.root.querySelector("#prepare-input")?.addEventListener("click", () => void this.checkInputs());
    this.root.querySelector("#apply-ratio-split")?.addEventListener("click", () => this.applyRatioSplit());
    this.root.querySelector("#apply-time-split")?.addEventListener("click", () => this.applyTimeSplit());
    this.root.querySelector<HTMLSelectElement>("#time-column")?.addEventListener("change", (event) => { this.timeColumn = (event.target as HTMLSelectElement).value; });
    this.root.querySelector<HTMLInputElement>("#time-cutoff")?.addEventListener("input", (event) => { this.timeCutoff = (event.target as HTMLInputElement).value; });
    for (const [id, tab] of [["train-tab", "train"], ["test-tab", "test"]] as const) this.root.querySelector(`#${id}`)?.addEventListener("click", () => { this.activeTab = tab; this.render(); });
    this.root.querySelectorAll<HTMLElement>("[data-tab]").forEach((node) => node.addEventListener("keydown", (event) => this.handleTabKey(event as KeyboardEvent)));
    this.root.querySelector<HTMLTextAreaElement>("#dataset-query")?.addEventListener("input", (event) => { this.datasetSql = (event.target as HTMLTextAreaElement).value; this.markChanged(true); this.render(); });
    for (const [id, key] of [["training-query", "trainingSql"], ["test-query", "testSql"]] as const) this.root.querySelector<HTMLTextAreaElement>(`#${id}`)?.addEventListener("input", (event) => { this[key] = (event.target as HTMLTextAreaElement).value; this.markChanged(); });
    this.root.querySelectorAll<HTMLInputElement>("[data-target]").forEach((node) => node.addEventListener("change", (event) => {
      const previousCandidates = featureCandidates(this.prepared, this.target);
      const allFeaturesSelected = previousCandidates.length > 0 && this.features.length === previousCandidates.length && previousCandidates.every((name) => this.features.includes(name));
      this.target = (event.target as HTMLInputElement).value;
      const nextCandidates = featureCandidates(this.prepared, this.target);
      this.features = allFeaturesSelected ? [...nextCandidates] : this.features.filter((name) => nextCandidates.includes(name));
      this.markChanged(false, false);
      this.render();
    }));
    this.root.querySelector<HTMLInputElement>("[data-feature-all]")?.addEventListener("change", (event) => {
      this.featuresTouched = true;
      const candidates = featureCandidates(this.prepared, this.target);
      this.features = (event.target as HTMLInputElement).checked ? [...candidates] : [];
      this.markChanged(false, false);
      this.render();
    });
    this.root.querySelectorAll<HTMLInputElement>("[data-feature]").forEach((node) => node.addEventListener("change", () => { this.featuresTouched = true; this.features = [...this.root.querySelectorAll<HTMLInputElement>("[data-feature]:checked")].map((input) => input.dataset.feature!); this.markChanged(false, false); this.render(); }));
    this.root.querySelector<HTMLSelectElement>("#x-axis")?.addEventListener("change", (event) => { this.xAxis = (event.target as HTMLSelectElement).value; this.updateChartAxis(); this.render(); });
    this.root.querySelectorAll<HTMLInputElement>("[data-scope-range]").forEach((node) => { node.addEventListener("input", () => this.updateChartScope(node, false)); node.addEventListener("change", () => this.updateChartScope(node, true)); });
    this.root.querySelectorAll<HTMLElement>("[data-source]").forEach((node) => node.addEventListener("click", () => { const name = node.dataset.source; if (!name) return; this.selectedSourceName = name; this.datasetSql = `SELECT * FROM ${escapeIdentifier(name)}`; this.markChanged(true); this.render(); }));
    this.root.querySelector("#download-results")?.addEventListener("click", () => this.downloadResults());
    this.root.querySelector("#export-experiment")?.addEventListener("click", () => this.exportExperiment());
    this.root.querySelector("#run-model")?.addEventListener("click", () => void this.runModel());
    this.root.querySelector("#load-model")?.addEventListener("click", () => void this.loadModel());
    this.root.querySelector<HTMLSelectElement>("#provider")?.addEventListener("change", (event) => { this.provider = (event.target as HTMLSelectElement).value as WorkbenchProvider; void this.resetModelRuntime(); });
    this.root.querySelector<HTMLSelectElement>("#precision")?.addEventListener("change", (event) => { this.precision = (event.target as HTMLSelectElement).value as WorkbenchPrecision; void this.resetModelRuntime(); });
    this.root.querySelector("#close-source-dialog")?.addEventListener("click", () => this.closeSourceDialog());
    this.root.querySelector("#cancel-source-dialog")?.addEventListener("click", () => this.closeSourceDialog());
    this.root.querySelector("#load-example")?.addEventListener("click", () => void this.loadFixture());
    this.root.querySelector<HTMLSelectElement>("#source-kind")?.addEventListener("change", (event) => this.updateSourceKind((event.target as HTMLSelectElement).value));
    this.root.querySelector<HTMLSelectElement>("#source-format")?.addEventListener("change", (event) => this.updateSourceFormat((event.target as HTMLSelectElement).value));
    this.root.querySelector<HTMLFormElement>("#source-form")?.addEventListener("submit", (event) => { event.preventDefault(); void this.submitSource(event.currentTarget as HTMLFormElement); });
    this.root.querySelector("#cancel-operation")?.addEventListener("click", () => this.cancelOperation());
  }

  private handleTabKey(event: KeyboardEvent): void {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" || event.key === "ArrowLeft" ? "train" : "test"; this.activeTab = next; this.render(); this.root.querySelector<HTMLElement>(`#${next}-tab`)?.focus();
  }

  private getChartScope(): { start: number; end: number } {
    const max = this.chartPoints.length - 1;
    if (max < 0) return { start: 0, end: 0 };
    const start = Math.max(0, Math.min(max, this.chartScopeStart));
    const end = this.chartScopeEnd < 0 ? max : Math.max(0, Math.min(max, this.chartScopeEnd));
    return start <= end ? { start, end } : { start: end, end: start };
  }

  private chartPointsForResult(result: QueryResult): PredictionPoint[] {
    return result.rows.map((row) => ({
      mean: Number(row[result.meanColumn]),
      q25: Number(row[result.q25Column]),
      q75: Number(row[result.q75Column]),
      truth: row[result.truthColumn] == null ? null : Number(row[result.truthColumn]),
      label: "",
    }));
  }

  private updateChartAxis(): void {
    if (!this.result) return;
    const axisValues = this.xAxis ? this.result.rows.map((row) => row[this.xAxis]) : [];
    this.chartPoints = relabelPredictionPoints(this.chartPointsForResult(this.result), axisValues, this.xAxis);
    this.resultAxis = this.xAxis || "输入行序号";
  }

  private updateScopeNavigator(): void {
    const navigator = this.root.querySelector<HTMLElement>(".scope-navigator");
    if (!navigator || this.chartPoints.length < 2) return;
    const scope = this.getChartScope();
    const divisor = Math.max(1, this.chartPoints.length - 1);
    navigator.style.setProperty("--scope-start", `${(scope.start / divisor * 100).toFixed(4)}%`);
    navigator.style.setProperty("--scope-end", `${(scope.end / divisor * 100).toFixed(4)}%`);
    const label = this.root.querySelector<HTMLOutputElement>("#scope-label");
    if (label) label.textContent = `${scope.start + 1}–${scope.end + 1} / ${this.chartPoints.length} 行`;
    const start = this.root.querySelector<HTMLInputElement>("#scope-start");
    const end = this.root.querySelector<HTMLInputElement>("#scope-end");
    if (start) start.value = String(scope.start);
    if (end) end.value = String(scope.end);
  }

  private updateChartScope(input: HTMLInputElement, render = true): void {
    const current = this.getChartScope(); const value = Number(input.value); if (!Number.isInteger(value)) return;
    if (input.dataset.scopeRange === "start") this.chartScopeStart = Math.min(value, current.end); else this.chartScopeEnd = Math.max(value, current.start);
    if (render) this.render(); else this.updateScopeNavigator();
  }

  private async refreshCapabilities(): Promise<void> {
    const [webgpuResult, duckdbResult] = await Promise.allSettled([probeWebGpuAdapter(), this.ensureDataDb()]);
    this.webgpuChecked = true;
    if (webgpuResult.status === "fulfilled") {
      this.webgpuAvailable = webgpuResult.value.available;
      this.webgpuReason = webgpuResult.value.available ? "硬件适配器可用" : (webgpuResult.value.reason ?? "未检测到可用适配器");
    } else {
      this.webgpuAvailable = false;
      this.webgpuReason = webgpuResult.reason instanceof Error ? webgpuResult.reason.message : String(webgpuResult.reason);
    }
    this.duckdbChecked = true;
    if (duckdbResult.status === "fulfilled") {
      this.duckdbAvailable = true;
      this.duckdbReason = "DuckDB WASM 已初始化";
    } else {
      this.duckdbAvailable = false;
      this.duckdbReason = duckdbResult.reason instanceof Error ? duckdbResult.reason.message : String(duckdbResult.reason);
    }
    if (!this.webgpuAvailable && this.provider === "webgpu") {
      this.provider = "wasm";
      await this.disposeModelRuntime().catch(() => undefined);
    }
    this.render();
  }

  private capabilities(): readonly CapabilityEvidence[] {
    const wasm = typeof WebAssembly !== "undefined";
    return [
      { name: "IndexedDB 快照", supported: this.snapshots.storage.persistentAvailable, reason: this.snapshots.storage.persistentAvailable ? undefined : "浏览器未提供 IndexedDB，快照仅保留在当前会话", checkedAt: "runtime" },
      { name: "WASM", supported: wasm, reason: wasm ? undefined : "浏览器未提供 WebAssembly", checkedAt: "runtime" },
      { name: "WebGPU", supported: this.webgpuAvailable, reason: this.webgpuChecked ? this.webgpuReason : "正在检测", checkedAt: this.webgpuChecked ? "runtime" : "checking" },
      { name: "DuckDB WASM", supported: this.duckdbAvailable, reason: this.duckdbChecked ? this.duckdbReason : "正在检测", checkedAt: this.duckdbChecked ? "runtime" : "checking" },
    ];
  }

  private async resetModelRuntime(): Promise<void> { this.modelContext = undefined; await this.disposeModelRuntime(); this.modelState = "未加载"; this.status = `已切换执行策略：${this.provider} / ${this.precision}`; this.render(); }
  private async disposeModelRuntime(): Promise<void> { const runtime = this.modelRuntime; this.modelRuntime = undefined; this.modelAdapter = undefined; this.modelRuntimeKey = undefined; if (runtime) await runtime.dispose(); }
  private handleModelAssetEvent(event: ModelAssetEvent): void { if (event.precision !== (this.precision === "fp32" ? "fp32" : "fp16-storage-fp32-compute")) return; const label = event.state === "checking" ? "检查权重缓存…" : event.state === "downloading" ? `下载权重…${event.file ? ` ${event.file}` : ""}` : event.state === "available" ? "权重已可用，加载中…" : `加载失败${event.message ? `：${event.message}` : ""}`; this.modelState = label; if (!this.busy) this.status = label; this.render(); }
  private async loadModel(): Promise<void> { if (this.busy) return; this.busy = true; this.status = "正在加载模型…"; this.render(); try { await this.ensureModelRuntime(); this.status = "模型已加载，可以运行 Test 预测。"; } catch (error) { this.status = this.describeQueryError(error); this.modelState = "加载失败"; } finally { this.busy = false; this.render(); } }

  private getPredictionBlocker(): string | undefined {
    if (this.modelState !== "已加载") return "请先加载模型";
    if (!this.dataset) return "请先生成 Dataset";
    if (this.dataset.stale) return "请先重新生成最新 Dataset";
    if (this.prepared?.revision === this.configRevision) {
      if (!this.target) return "请先选择预测目标";
      if (!this.features.length) return "请至少选择一个输入特征";
    }
    return undefined;
  }

  private async ensureModelRuntime(): Promise<RuntimeCoordinator> {
    const key = `${this.provider}:${this.precision}`; if (this.modelRuntime && this.modelRuntimeKey === key) return this.modelRuntime;
    await this.disposeModelRuntime(); this.modelState = "加载中…"; this.render();
    const worker = this.precision === "fp32" ? new Worker(new URL("../src/workers/model.worker-entry-fp32.ts", import.meta.url), { type: "module" }) : new Worker(new URL("../src/workers/model.worker-entry.ts", import.meta.url), { type: "module" });
    const adapter = new WorkerModelClient({ worker, onAssetEvent: (event) => this.handleModelAssetEvent(event) });
    try {
      const duckdb = await createDuckDbWasmExecutor({ workerUrl: new URL("runtime-assets/duckdb/duckdb-browser-mvp.worker.js", document.baseURI).toString(), wasmUrl: new URL("runtime-assets/duckdb/duckdb-mvp.wasm", document.baseURI).toString() });
      const inputSnapshots = new InputSnapshotStore(); const service = new DuckDbService(duckdb.executor, inputSnapshots); await service.open(); const runtime = new RuntimeCoordinator({ client: new RuntimeClient({ adapter }), inputSnapshots, duckdb: service });
      await runtime.load({ preferredProvider: this.provider, allowWasmFallback: false }); this.modelAdapter = adapter; this.modelRuntime = runtime; this.modelRuntimeKey = key; this.modelState = "已加载"; return runtime;
    } catch (error) { this.modelState = "加载失败"; await adapter.dispose().catch(() => undefined); throw error; }
  }

  private async runModel(): Promise<void> {
    if (this.busy) return;
    if (this.modelState !== "已加载") { this.status = "请先加载模型，模型 ready 后才能运行 Test 预测。"; this.runStatus = { stage: "model-load", status: "failed", message: this.status }; this.render(); return; }
    if (!this.dataset || this.dataset.stale) { this.status = this.dataset ? "请先重新生成最新 Dataset" : "请先生成 Dataset"; this.runStatus = { stage: "validate", status: "failed", message: this.status }; this.render(); return; }
    const requestId = `workbench-app-${Date.now().toString(36)}-${++this.modelRunGeneration}`; const capturedRevision = this.configRevision; this.activeModelRequestId = requestId; this.modelCancelRequested = false; this.busy = true; this.lastQueryError = undefined; this.status = `正在准备 ${this.provider} / ${this.precision} 模型…`; this.runStatus = { stage: "model-load", status: "running", completed: null, total: null }; this.render();
    try {
      if (this.prepared?.revision !== capturedRevision) await this.prepareInputs();
      if (!this.target || !this.features.length) throw new Error(!this.target ? "请先选择预测目标" : "请至少选择一个输入特征");
      const target = this.target; const features = [...this.features]; const axis = this.xAxis; const trainSql = this.trainingSql; const testSql = this.testSql; const trainResult = this.prepared?.revision === capturedRevision ? this.prepared.train : await this.queryInput(trainSql); const testResult = this.prepared?.revision === capturedRevision ? this.prepared.test : await this.queryInput(testSql); if (capturedRevision !== this.configRevision) throw new Error("配置在运行期间已改变，请重新执行。"); this.prepared = { train: trainResult, test: testResult, revision: capturedRevision };
      const { training, prediction, truth } = preparePredictionInput(trainResult, testResult, target, features); const trainKeys = businessKeys(trainResult.rows.map(toWorkbenchRow), trainResult.columns); const testKeys = businessKeys(testResult.rows.map(toWorkbenchRow), testResult.columns); const runtime = await this.ensureModelRuntime(); if (this.modelCancelRequested) throw new Error("CANCELLED: 已取消当前操作");
      this.runStatus = { stage: "context", status: "running", completed: null, total: null }; this.status = "正在构建训练上下文…"; this.render(); const trainSnapshot = runtime.createTrainingSnapshot(training, trainKeys, { source: this.dataset.table.snapshotId, sql: trainSql, featureNames: features, targetName: target }); if (this.modelContext) await this.modelAdapter!.releaseContext(this.modelContext); this.modelContext = await runtime.fitContext(training, { featureSqlFingerprint: trainSql, sourceSnapshotId: trainSnapshot.inputSnapshotId, preprocessing: { profile: "tabpfn35-none", seed: 20260920, featureFingerprint: true, featureShiftDecoder: "shuffle", featureShiftCount: 0 } }, `${requestId}-fit`);
      if (this.modelCancelRequested) throw new Error("CANCELLED: 已取消当前操作"); const predictionSnapshot = runtime.createPredictionSnapshot(prediction, testKeys, { source: this.dataset.table.snapshotId, sql: testSql, featureNames: features }); this.runStatus = { stage: "predict", status: "running", completed: null, total: prediction.rowCount }; this.status = "正在执行真实 ORT 预测…"; this.render(); const outcome = await runtime.submitPrediction({ streamId: "workbench-app", generation: this.modelRunGeneration, epoch: this.modelContext.workerEpoch, scenarioId: "baseline", requestId, inputSnapshot: predictionSnapshot, context: this.modelContext, mode: "experiment" }); if (outcome.status !== "published" || !outcome.value) throw outcome.error instanceof Error ? outcome.error : new Error(`预测未发布：${outcome.status}`); if (this.modelCancelRequested) throw new Error("CANCELLED: 已取消当前操作"); const resultTableName = runtime.duckdb.resultTableName(requestId); if (!resultTableName) throw new Error("RESULT_INVALID: DuckDB 结果表未注册"); const query = await runtime.duckdb.query(`SELECT row_ordinal, mean, q25, q75, context_key FROM ${escapeIdentifier(resultTableName)} ORDER BY row_ordinal`); if (query.rows.length !== prediction.rowCount) throw new Error(`RESULT_INVALID: 结果行数 ${query.rows.length} != ${prediction.rowCount}`);
      const enriched = enrichTestRows(testResult, { mean: query.rows.map((row) => Number(row.mean)), q25: query.rows.map((row) => Number(row.q25)), q75: query.rows.map((row) => Number(row.q75)) });
      const usedColumns = new Set(enriched.table.columns); const ordinalColumn = uniqueColumnName("row_ordinal", usedColumns); const truthColumn = uniqueColumnName("truth", usedColumns);
      const rows: WorkbenchRow[] = query.rows.map((row) => { const ordinal = Number(row.row_ordinal); const base = enriched.table.rows[ordinal] ?? {}; return toWorkbenchRow({ ...base, [ordinalColumn]: ordinal, [truthColumn]: truth[ordinal] }); });
      const columns = [...enriched.table.columns, ordinalColumn, truthColumn];
      const result: QueryResult = { columns, rows, total: rows.length, meanColumn: enriched.outputColumns.mean, q25Column: enriched.outputColumns.q25, q75Column: enriched.outputColumns.q75, truthColumn };
      this.result = result;
      this.chartPoints = relabelPredictionPoints(this.chartPointsForResult(result), axis ? rows.map((row) => row[axis]) : [], axis);
      this.chartScopeStart = 0; this.chartScopeEnd = this.chartPoints.length - 1; this.resultTarget = target; this.resultAxis = axis || "输入行序号"; this.resultSummary = `Train ${training.rowCount} 行 · Test ${prediction.rowCount} 行 · ${features.length} 个特征 · ${this.provider} / ${this.precision}`; this.resultStale = false; this.runStatus = { stage: "publish", status: "complete", completed: rows.length, total: rows.length, message: "预测已附加到 Test 行" }; this.status = `真实预测完成：${rows.length} 个 Test 行已更新`;
    } catch (error) { const message = this.describeQueryError(error); const cancelled = this.modelCancelRequested || /^CANCELLED:/i.test(message); this.runStatus = { stage: cancelled ? "cancelled" : "predict", status: cancelled ? "cancelled" : "failed", completed: null, total: null, message: cancelled ? "已取消，上一成功结果仍保留" : message }; this.status = cancelled ? "已取消当前操作" : `预测失败：${message}`; }
    finally { if (this.activeModelRequestId === requestId) this.activeModelRequestId = undefined; this.modelCancelRequested = false; this.busy = false; this.render(); }
  }

  private cancelOperation(): void { if (!this.busy) return; this.modelCancelRequested = true; this.sourceImportController?.abort("cancelled"); if (this.activeModelRequestId) this.modelRuntime?.cancel(this.activeModelRequestId); this.runStatus = { ...this.runStatus, status: "cancelled", message: "已确认取消请求；上一成功结果仍保留" }; this.status = "已确认取消请求"; this.render(); }

  private openSourceDialog(): void { const dialog = this.root.querySelector<HTMLDialogElement>("#source-dialog"); if (!dialog) return; if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", ""); this.updateSourceKind("file"); }
  private closeSourceDialog(): void { const dialog = this.root.querySelector<HTMLDialogElement>("#source-dialog"); if (!dialog) return; if (typeof dialog.close === "function") dialog.close(); else dialog.removeAttribute("open"); }
  private updateSourceKind(kind: string): void { const isUrl = kind === "url"; const isJson = kind === "json"; const fileRow = this.root.querySelector<HTMLElement>("#source-file-row"); const urlRow = this.root.querySelector<HTMLElement>("#source-url-row"); const jsonRow = this.root.querySelector<HTMLElement>("#source-json-path-row"); if (fileRow) fileRow.hidden = isUrl; if (urlRow) urlRow.hidden = !isUrl; if (jsonRow) jsonRow.hidden = !isJson; const format = this.root.querySelector<HTMLSelectElement>("#source-format"); if (format && isJson) format.value = "json"; }
  private updateSourceFormat(formatValue: string): void { const kind = this.root.querySelector<HTMLSelectElement>("#source-kind")?.value; const jsonRow = this.root.querySelector<HTMLElement>("#source-json-path-row"); if (jsonRow) jsonRow.hidden = kind !== "json" && formatValue !== "json"; }

  private async submitSource(form: HTMLFormElement): Promise<void> {
    const input = readAddSourceInput(form); const validation = validateAddSourceInput(input); const errorNode = this.root.querySelector<HTMLElement>("#source-error"); if (validation) { if (errorNode) { errorNode.textContent = validation; errorNode.hidden = false; } return; } if (errorNode) errorNode.hidden = true; this.closeSourceDialog(); this.busy = true; this.modelCancelRequested = false; this.sourceImportController = new AbortController(); const controller = this.sourceImportController; this.status = `正在导入 ${input.name}…`; this.runStatus = { stage: "importing", status: "running", completed: null, total: null }; this.render();
    try { if (input.kind === "url") { const remote = await fetchRemoteSource(input.url!, { signal: controller.signal }); await this.importBytes(input.name, remote.bytes, input.format, input.jsonPath, false, controller.signal); } else if (input.file) { await this.importBytes(input.name, new Uint8Array(await input.file.arrayBuffer()), input.format, input.jsonPath, false, controller.signal); } else throw new Error("请选择数据文件"); }
    catch (error) { const cancelled = controller.signal.aborted || this.modelCancelRequested || (error instanceof RuntimeError && error.code === "CANCELLED"); this.busy = false; this.runStatus = { stage: "import", status: cancelled ? "cancelled" : "failed", message: cancelled ? "已取消，上一成功结果仍保留" : this.describeSourceError(error) }; this.status = cancelled ? "已取消当前操作" : this.describeSourceError(error); this.render(); }
    finally { if (this.sourceImportController === controller) this.sourceImportController = undefined; this.modelCancelRequested = false; }
  }

  private async importBytes(name: string, bytes: Uint8Array, formatChoice: SourceFormatChoice, jsonPath = "$", replace = false, signal?: AbortSignal): Promise<void> {
    assertSourceImportActive(signal); validateSourceName(name); const format = formatChoice === "arrow" ? "arrow" : formatChoice as SnapshotFormat; const codec = formatForCodec(format); const decoded = format === "parquet" || format === "arrow" ? await loadSourceBytes(await this.ensureDataDb(), bytes, codec, jsonPath) : await decodeSource(bytes, codec, { jsonPath }); assertSourceImportActive(signal); if (!decoded.rows.length) throw new Error("数据为空或缺少列");
    const conflictingNames = [...this.tables.keys()].filter((candidate) => sourceNameKey(candidate) === sourceNameKey(name));
    if (conflictingNames.length && !replace) { const existingName = conflictingNames[0]; const confirmed = typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(`数据源 ${existingName} 已存在，确认替换吗？`) : false; if (!confirmed) throw new Error(`数据源 ${existingName} 已存在；请选择新名称或确认替换`); }
    const columns = [...decoded.columns]; const rows = decoded.rows.map((row) => toWorkbenchRow(row)); const snapshotId = `snapshot-${crypto.randomUUID()}`; let saved: Awaited<ReturnType<DataSnapshotStore["save"]>>; try { saved = await this.snapshots.save({ snapshotId, sourceId: `source-${name}`, sourceName: name, format, typeInterpretation: decoded.types, rowCount: rows.length, columns, bytes }); assertSourceImportActive(signal); } catch (error) { if (signal?.aborted) await this.snapshots.delete(snapshotId).catch(() => undefined); throw error; } for (const existingName of conflictingNames) if (existingName !== name) { this.tables.delete(existingName); this.registered.delete(existingName); } const table: Table = { name, columns, rows, snapshotId, format }; this.tables.set(name, table); this.selectedSourceName = name; this.datasetSql = `SELECT * FROM ${escapeIdentifier(name)}`; this.dataset = this.dataset ? { ...this.dataset, stale: true } : undefined; this.prepared = undefined; this.configRevision += 1; this.busy = false; this.lastQueryError = undefined; this.runStatus = { stage: "import", status: "complete", completed: rows.length, total: rows.length }; this.status = `${name} 已导入，${rows.length} 行；${saved.persistent ? "已保存到 IndexedDB" : "仅保留在本次会话"}`; this.events.emit({ type: "finished", operationId: snapshotId, status: "complete", at: Date.now() }); this.render();
  }

  private async loadFixture(): Promise<void> {
    this.closeSourceDialog(); this.busy = true; this.status = "正在加载示例数据…"; this.render();
    try { const response = await fetch(new URL("runtime-fixtures/workbench/v1/normal/train.csv", document.baseURI)); if (!response.ok) throw new Error(`示例数据加载失败（HTTP ${response.status}）`); await this.importBytes("weather_example", new TextEncoder().encode(await response.text()), "csv", "$", true); await this.buildDataset(); }
    catch (error) { this.busy = false; this.status = error instanceof Error ? error.message : String(error); this.render(); }
  }

  private downloadResults(): void { if (!this.result) return; const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`; const csv = [this.result.columns.map(cell).join(","), ...this.result.rows.map((row) => this.result!.columns.map((key) => cell(row[key])).join(","))].join("\n") + "\n"; const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `${this.resultTarget || "test"}-predictions.csv`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
  private exportExperiment(): void {
    const data = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      note: "此 JSON 只包含配置与快照引用，不包含原始数据和模型权重。",
      dataset: this.dataset ? { version: 1, query: this.datasetSql, snapshotId: null, splitPreset: this.splitPreset } : undefined,
      datasetSql: this.datasetSql,
      trainingSql: this.trainingSql,
      testSql: this.testSql,
      target: this.target,
      features: [...this.features],
      xAxis: this.xAxis,
      splitPreset: this.splitPreset,
      model: { id: "tabpfn-3.5", provider: this.provider, precision: this.precision },
      sources: [...this.tables.values()].map((table) => ({ name: table.name, snapshotId: table.snapshotId, format: table.format, columns: table.columns, rowCount: table.rows.length })),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })); const link = document.createElement("a"); link.href = url; link.download = "tabloom-experiment.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private describeSourceError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/[^\s)]+/gi, "远端来源"); }
  private describeQueryError(error: unknown): string { const message = error instanceof Error ? error.message : String(error); return /_setThrew/.test(message) ? "SQL 执行失败，请检查表名、列名和语法。" : message; }
}

function uniqueColumnName(base: string, used: Set<string>): string { if (!used.has(base)) { used.add(base); return base; } let index = 2; while (used.has(`${base}_${index}`)) index += 1; const name = `${base}_${index}`; used.add(name); return name; }

interface TablePreview { readonly columns: readonly string[]; readonly rows: readonly WorkbenchRow[]; readonly total: number; }
function renderTable(result: TablePreview): string { return `<div class="table-wrap" data-pagination="preview-limit-200" aria-label="数据预览（最多显示 200 行）"><table><thead><tr>${result.columns.map((column) => `<th scope="col">${escapeHtml(column)}</th>`).join("")}</tr></thead><tbody>${result.rows.map((row) => `<tr>${result.columns.map((column) => `<td>${escapeHtml(formatValue(row[column]))}</td>`).join("")}</tr>`).join("")}</tbody></table><p class="muted" aria-label="分页说明">预览最多 200 行；实际行数：${result.total}</p></div>`; }
function formatValue(value: unknown): string { return value === null || value === undefined ? "NULL" : String(value); }
function escapeHtml(value: string): string { return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;"); }
