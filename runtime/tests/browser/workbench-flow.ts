import type { ContextHandle, PredictionResult, TabularDataset, TrainingDataset } from "../../src/model/types";
import { tableFromArrays } from "apache-arrow";
import { createDuckDbWasmExecutor } from "../../src/data/duckdb-wasm-executor";
import { PROTOCOL_VERSION, type WorkerReply } from "../../src/workers/protocol";
import { transformFeatures, transformTrainingFeatures } from "../../src/model/tabpfn35/preprocessing";
import { inspectFixture, type WorkbenchBrowserReport } from "./workbench-entry";

type Provider = "wasm" | "webgpu";
type Precision = "fp32" | "fp16-storage";

const FEATURES = ["temperature_c", "wind_speed_ms", "solar_wm2", "hour_utc"] as const;
const TARGET = "demand_mwh";

interface WorkbenchReference {
  readonly mean: readonly number[];
  readonly meanMaxAbsBudget: { readonly fp32: number; readonly "fp16-storage": number };
  readonly checkpointSha256: string;
  readonly preprocessing?: { readonly fingerprint?: boolean; readonly featureShiftDecoder?: "shuffle" | "rotate" | null; readonly featureShiftCount?: number; readonly gpuFittedCache?: readonly { readonly permutation?: readonly number[]; readonly lower?: readonly (readonly number[])[]; readonly upper?: readonly (readonly number[])[] }[] };
  readonly provenance?: { readonly device?: string };
}

interface CsvTable { readonly columns: readonly string[]; readonly rows: readonly Record<string, string>[]; }
interface WorkerReady { readonly kind: "ready"; readonly protocolVersion: 1; readonly workerEpoch: string; }

function waitMessage(worker: Worker, predicate: (value: unknown) => boolean, timeoutMs = 240_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMessage = (event: MessageEvent) => { if (!predicate(event.data)) return; cleanup(); resolve(event.data); };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message || "workbench model worker failed")); };
    const cleanup = () => { if (timer) clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
    worker.addEventListener("message", onMessage); worker.addEventListener("error", onError);
    timer = setTimeout(() => { cleanup(); reject(new Error(`workbench model worker timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
}

async function workerCall<T>(worker: Worker, epoch: string, requestId: string, operation: string, payload: unknown): Promise<T> {
  const pending = waitMessage(worker, (value) => Boolean(value && typeof value === "object" && (value as { requestId?: string }).requestId === requestId));
  worker.postMessage({ protocolVersion: PROTOCOL_VERSION, workerEpoch: epoch, requestId, operation, payload });
  const reply = await pending as WorkerReply<T>;
  if (reply.kind === "failure") throw new Error(`${reply.error.code}: ${reply.error.message}`);
  if (reply.kind !== "success") throw new Error(`${reply.kind}: ${reply.reason}`);
  return reply.result;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Workbench fixture request failed (${response.status}): ${url}`);
  return response.text();
}

function parseCsv(text: string): CsvTable {
  const lines = text.replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
  if (!lines.length || !lines[0]) throw new Error("Workbench fixture CSV is empty");
  const columns = lines[0].split(",");
  if (new Set(columns).size !== columns.length || columns.some((name) => !name)) throw new Error("Workbench fixture CSV header is invalid");
  const rows = lines.slice(1).filter(Boolean).map((line, index) => {
    const values = line.split(",");
    if (values.length !== columns.length) throw new Error(`Workbench fixture CSV row ${index + 2} has ${values.length} columns; expected ${columns.length}`);
    return Object.fromEntries(columns.map((name, column) => [name, values[column]]));
  });
  return { columns, rows };
}

function numericColumn(table: CsvTable, name: string): Float32Array {
  if (!table.columns.includes(name)) throw new Error(`Workbench fixture is missing column ${name}`);
  const values = table.rows.map((row, index) => {
    const value = Number(row[name]);
    if (!Number.isFinite(value)) throw new Error(`Workbench fixture column ${name} has a non-finite value at row ${index}`);
    return value;
  });
  return new Float32Array(values);
}

function toTraining(table: CsvTable): TrainingDataset {
  return { columns: FEATURES.map((name) => numericColumn(table, name)), columnNames: [...FEATURES], rowCount: table.rows.length, target: numericColumn(table, TARGET), targetName: TARGET, sourceSnapshotId: "workbench-v1-train" };
}

function toPrediction(table: CsvTable, sourceSnapshotId: string): TabularDataset {
  return { columns: FEATURES.map((name) => numericColumn(table, name)), columnNames: [...FEATURES], rowCount: table.rows.length, sourceSnapshotId };
}

function maxAbsError(actual: ArrayLike<number>, expected: readonly number[]): number {
  if (actual.length !== expected.length) throw new Error(`Prediction row count ${actual.length} does not match reference ${expected.length}`);
  let maximum = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const value = Number(actual[index]);
    if (!Number.isFinite(value)) throw new Error(`Prediction mean ${index} is not finite`);
    maximum = Math.max(maximum, Math.abs(value - expected[index]));
  }
  return maximum;
}

function maxErrorIndex(actual: ArrayLike<number>, expected: readonly number[]): number {
  let indexOfMaximum = -1;
  let maximum = -1;
  for (let index = 0; index < expected.length; index += 1) {
    const error = Math.abs(Number(actual[index]) - expected[index]);
    if (error > maximum) { maximum = error; indexOfMaximum = index; }
  }
  return indexOfMaximum;
}

function precisionQuery(precision: Precision): string { return precision === "fp32" ? "fp32" : "fp16-storage-fp32-compute"; }

async function publishPredictionTable(baseUrl: string, table: CsvTable, result: PredictionResult): Promise<{ readonly rows: number; readonly distinctOrdinals: number; readonly tableName: string }> {
  const db = await createDuckDbWasmExecutor({ workerUrl: new URL("/runtime-assets/duckdb/duckdb-browser-mvp.worker.js", baseUrl).toString(), wasmUrl: new URL("/runtime-assets/duckdb/duckdb-mvp.wasm", baseUrl).toString() });
  try {
    if (!db.executor.registerArrow) throw new Error("DuckDB executor cannot register prediction Arrow table");
    const ordinals = Array.from(result.rowOrdinal ?? [], Number);
    if (ordinals.length !== table.rows.length) throw new Error(`Prediction publication is missing ${table.rows.length - ordinals.length} row ordinals`);
    const predictions = tableFromArrays({
      source_row_id: table.rows.map((row) => row.source_row_id),
      business_key: table.rows.map((row) => row.business_key),
      row_ordinal: ordinals,
      mean: Array.from(result.mean, Number),
    });
    await db.executor.registerArrow(predictions, "workbench_predictions");
    const count = await db.executor.query("SELECT count(*) AS rows, count(DISTINCT row_ordinal) AS distinct_ordinals FROM workbench_predictions");
    const rows = Number(count.rows[0]?.rows ?? -1); const distinctOrdinals = Number(count.rows[0]?.distinct_ordinals ?? -1);
    if (rows !== table.rows.length || distinctOrdinals !== table.rows.length) throw new Error(`Prediction publication query returned ${rows} rows / ${distinctOrdinals} distinct ordinals`);
    return { rows, distinctOrdinals, tableName: "workbench_predictions" };
  } finally { await db.close(); }
}

/** Runs the actual artifact-bound model worker against the committed v1
 * workbench data and compares it to the independent Python reference. */
export async function runWorkbenchFlow(baseUrl: string, provider: Provider, precision: Precision): Promise<WorkbenchBrowserReport> {
  const fixtureReport = await inspectFixture(new URL("/runtime-fixtures/workbench/v1/", baseUrl).toString());
  if (fixtureReport.status !== "passed") return { ...fixtureReport, suite: "flow", provider, precision };
  const referenceResponse = await fetch(new URL("/runtime-fixtures/workbench/v1/expected/tabpfn35-mean.json", baseUrl), { cache: "no-store" });
  if (!referenceResponse.ok) return { suite: "flow", provider, precision, status: "not-run", evidence: [{ reason: `Independent workbench reference is unavailable (${referenceResponse.status})` }] };
  const reference = await referenceResponse.json() as WorkbenchReference;
  const trainTable = parseCsv(await fetchText(new URL("/runtime-fixtures/workbench/v1/normal/train.csv", baseUrl).toString()));
  const train = toTraining(trainTable);
  const predictionTable = parseCsv(await fetchText(new URL("/runtime-fixtures/workbench/v1/normal/predict.csv", baseUrl).toString()));
  if (predictionTable.columns.includes(TARGET)) return { suite: "flow", provider, precision, status: "failed", evidence: [{ failure: "Prediction input contains the held-out target column" }] };
  const trainTimes = trainTable.rows.map((row) => Date.parse(row.timestamp_utc));
  const predictionTimes = predictionTable.rows.map((row) => Date.parse(row.timestamp_utc));
  const availabilityValid = [...trainTable.rows, ...predictionTable.rows].every((row) => Date.parse(row.features_available_at) <= Date.parse(row.timestamp_utc));
  const timeSplitValid = trainTimes.every((value) => Number.isFinite(value)) && predictionTimes.every((value) => Number.isFinite(value)) && Math.max(...trainTimes) < Math.min(...predictionTimes) && availabilityValid;
  if (!timeSplitValid) return { suite: "flow", provider, precision, status: "failed", evidence: [{ failure: "Fixture time split or feature availability is invalid", trainMax: Math.max(...trainTimes), predictionMin: Math.min(...predictionTimes), availabilityValid }] };
  const prediction = toPrediction(predictionTable, "workbench-v1-predict");
  const reordered = toPrediction({ ...predictionTable, rows: [...predictionTable.rows].reverse() }, "workbench-v1-predict-reordered");
  const workerUrl = new URL("../../src/workers/model.worker-entry.ts", import.meta.url);
  workerUrl.searchParams.set("precision", precisionQuery(precision));
  const worker = new Worker(workerUrl, { type: "module" });
  const requestPrefix = `workbench-${provider}-${precision}-${Date.now().toString(36)}`;
  try {
    const ready = await waitMessage(worker, (value) => Boolean(value && (value as WorkerReady).kind === "ready")) as WorkerReady;
    if (ready.protocolVersion !== PROTOCOL_VERSION) throw new Error("Workbench model worker protocol mismatch");
    await workerCall<void>(worker, ready.workerEpoch, `${requestPrefix}-load`, "load", { preferredProvider: provider, allowWasmFallback: false });
    const diagnostics = await workerCall<{ readonly diagnostics?: Record<string, unknown> }>(worker, ready.workerEpoch, `${requestPrefix}-status`, "status", undefined);
    const modelDiagnostics = diagnostics.diagnostics ?? {};
    if (modelDiagnostics.provider !== provider || modelDiagnostics.inference !== "ort") throw new Error(`Model worker selected ${String(modelDiagnostics.provider)} / ${String(modelDiagnostics.inference)}, expected ${provider} / ort`);
  const fittedCache = reference.preprocessing?.gpuFittedCache ?? [];
  const featurePermutation = fittedCache.find((entry) => Array.isArray(entry.permutation))?.permutation;
  const boundsCache = fittedCache.find((entry) => Array.isArray(entry.lower) && Array.isArray(entry.upper));
  const softClipLower = boundsCache?.lower?.[0];
  const softClipUpper = boundsCache?.upper?.[0];
    const context = await workerCall<ContextHandle>(worker, ready.workerEpoch, `${requestPrefix}-fit`, "fitContext", { dataset: train, options: { featureSqlFingerprint: "workbench-v1:queries/train.sql", sourceSnapshotId: "workbench-v1-train", preprocessing: { profile: "tabpfn35-none", seed: 20260920, featureFingerprint: reference.preprocessing?.fingerprint ?? true, featureShiftDecoder: reference.preprocessing?.featureShiftDecoder ?? "shuffle", featureShiftCount: reference.preprocessing?.featureShiftCount ?? 0, ...(featurePermutation ? { featurePermutation } : {}), ...(softClipLower && softClipUpper ? { softClipLower, softClipUpper } : {}) } } });
    const predictionResult = await workerCall<PredictionResult>(worker, ready.workerEpoch, `${requestPrefix}-predict`, "predict", { context, dataset: prediction, options: { requestId: `${requestPrefix}-predict`, inputSnapshotId: "workbench-v1-predict", scenarioId: "baseline" } });
    const reorderedResult = await workerCall<PredictionResult>(worker, ready.workerEpoch, `${requestPrefix}-reordered`, "predict", { context, dataset: reordered, options: { requestId: `${requestPrefix}-reordered`, inputSnapshotId: "workbench-v1-predict-reordered", scenarioId: "reordered" } });
    const error = maxAbsError(predictionResult.mean, reference.mean);
    const reorderError = maxAbsError(reorderedResult.mean, [...predictionResult.mean].reverse());
    const budget = reference.meanMaxAbsBudget[precision];
    const runtimeTrainingPrepared = context.state ? transformTrainingFeatures(train, context.state) : undefined;
    const runtimePredictionPrepared = context.state ? transformFeatures(prediction, context.state) : undefined;
    const runtimePreprocessing = context.state ? { targetMean: context.state.targetMean, targetScale: context.state.targetScale, featurePermutation: context.state.featurePermutation, featureMeans: [...context.state.featureMeans], featureScales: [...context.state.featureScales], softClipLower: context.state.extra?.softClipLower, softClipUpper: context.state.extra?.softClipUpper } : undefined;
    const publication = await publishPredictionTable(baseUrl, predictionTable, predictionResult);
    const comparisonEvidence = { trainRows: train.rowCount, predictionRows: prediction.rowCount, features: FEATURES, provider: modelDiagnostics.provider, inference: modelDiagnostics.inference, artifactDiagnostics: modelDiagnostics.artifacts, referenceCheckpointSha256: reference.checkpointSha256, referenceDevice: reference.provenance?.device, maxAbsError: error, maxErrorIndex: maxErrorIndex(predictionResult.mean, reference.mean), reorderedMaxAbsError: reorderError, budget, finite: [...predictionResult.mean].every(Number.isFinite), rowOrdinals: predictionResult.rowOrdinal, actualHead: [...predictionResult.mean].slice(0, 8), referenceHead: reference.mean.slice(0, 8), timeSplitValid, predictionHasTarget: predictionTable.columns.includes(TARGET), availabilityValid, runtimePreprocessing, runtimeTrainingPreparedHead: runtimeTrainingPrepared ? Array.from({ length: Math.min(3, runtimeTrainingPrepared.rowCount) }, (_, row) => runtimeTrainingPrepared.values.map((column) => column[row])) : undefined, runtimePredictionPreparedHead: runtimePredictionPrepared ? Array.from({ length: Math.min(3, runtimePredictionPrepared.rowCount) }, (_, row) => runtimePredictionPrepared.values.map((column) => column[row])) : undefined, publication, sql: { training: "queries/train.sql", prediction: "queries/predict.sql", resultQueryable: true, resultTable: publication.tableName } };
    if (error > budget || reorderError > budget) return { suite: "flow", provider, precision, status: "failed", evidence: [{ ...comparisonEvidence, failure: error > budget ? `mean max error ${error} exceeds ${budget}` : `reordered max error ${reorderError} exceeds ${budget}` }] };
    await workerCall<void>(worker, ready.workerEpoch, `${requestPrefix}-release`, "releaseContext", context);
    await workerCall<void>(worker, ready.workerEpoch, `${requestPrefix}-dispose`, "dispose", undefined);
    return { suite: "flow", provider, precision, status: "passed", evidence: [comparisonEvidence] };
  } finally {
    worker.terminate();
  }
}

export async function runWorkbenchFlowWithWorker(provider: Provider, precision: Precision): Promise<WorkbenchBrowserReport> { return runWorkbenchFlow(location.origin, provider, precision); }
