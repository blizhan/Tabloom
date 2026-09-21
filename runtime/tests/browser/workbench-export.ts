export interface ExportRoundTripEvidence { readonly format: "csv" | "parquet" | "arrow-ipc"; readonly rows: number; readonly preserved: boolean; readonly metadataSidecar: boolean; }
export function assertExportRoundTrip(evidence: ExportRoundTripEvidence): void { if (!evidence.preserved || !evidence.metadataSidecar) throw new Error(`${evidence.format} round-trip did not preserve data identity/metadata`); }

import { tableFromArrays } from "apache-arrow";
import { createDuckDbWasmExecutor } from "../../src/data/duckdb-wasm-executor";
import { decodeSource, type SourceRow } from "../../src/workbench/file-codecs";
import { ExportService } from "../../src/workbench/export-service";

export interface WorkbenchExportReport { readonly status: "passed" | "failed" | "not-run"; readonly rows: number; readonly formats: readonly ExportRoundTripEvidence[]; readonly evidence: readonly Record<string, unknown>[]; }

async function fetchBytes(url: string): Promise<Uint8Array> { const response = await fetch(url, { cache: "no-store" }); if (!response.ok) throw new Error(`fixture request failed (${response.status})`); return new Uint8Array(await response.arrayBuffer()); }
function asRecordRows(rows: readonly SourceRow[]): readonly Record<string, unknown>[] { return rows.map((row) => ({ ...row })); }

/** Export/round-trip acceptance against the real Arrow and DuckDB-WASM
 * encoders. Parquet is written to a registered in-memory DuckDB file, never
 * to the user's filesystem. */
export async function runWorkbenchExport(baseUrl: string): Promise<WorkbenchExportReport> {
  let db: Awaited<ReturnType<typeof createDuckDbWasmExecutor>> | undefined;
  const evidence: Record<string, unknown>[] = [];
  try {
    const source = await decodeSource(await fetchBytes(new URL("/runtime-fixtures/workbench/v1/normal/predict.csv", baseUrl).toString()), "csv");
    const rows = asRecordRows(source.rows);
    const schema = source.columns.map((name) => ({ name, type: source.types[name], nullable: rows.some((row) => row[name] === null) }));
    const service = new ExportService();
    const common = { columns: source.columns, schema, rows, sourceSnapshotId: "workbench-v1-predict", inputSnapshotId: "workbench-v1-predict", query: "SELECT * FROM predict", predictionQuery: "SELECT * FROM predict", featureNames: ["temperature_c", "wind_speed_ms", "solar_wm2", "hour_utc"], targetName: "demand_mwh", modelId: "tabpfn-3.5", modelVersion: "3.5", runId: "workbench-export", provider: "wasm", precision: "fp32", durationMs: 1 } as const;
    const csv = await service.export({ ...common, format: "csv" });
    const csvDecoded = await decodeSource(csv.bundle.data, "csv", { types: Object.fromEntries(schema.map((item) => [item.name, item.type])) });
    const csvEvidence: ExportRoundTripEvidence = { format: "csv", rows: csvDecoded.rows.length, preserved: csvDecoded.logicalDigest === source.logicalDigest, metadataSidecar: Object.keys(csv.metadata).length > 0 && Boolean(csv.metadata.inputSnapshotId) };
    assertExportRoundTrip(csvEvidence);
    const arrow = await service.export({ ...common, format: "arrow-ipc" });
    const arrowDecoded = await decodeSource(arrow.bundle.data, "arrow-ipc");
    const arrowEvidence: ExportRoundTripEvidence = { format: "arrow-ipc", rows: arrowDecoded.rows.length, preserved: arrowDecoded.logicalDigest === source.logicalDigest, metadataSidecar: Object.keys(arrow.metadata).length > 0 && Boolean(arrow.metadata.inputSnapshotId) };
    assertExportRoundTrip(arrowEvidence);

    db = await createDuckDbWasmExecutor({ workerUrl: new URL("/runtime-assets/duckdb/duckdb-browser-mvp.worker.js", baseUrl).toString(), wasmUrl: new URL("/runtime-assets/duckdb/duckdb-mvp.wasm", baseUrl).toString() });
    if (!db.executor.registerArrow || !db.executor.copyFileToBuffer) throw new Error("DuckDB-WASM file export bridge is unavailable");
    const arrowTable = tableFromArrays(Object.fromEntries(source.columns.map((column) => [column, rows.map((row) => row[column] ?? null)])));
    await db.executor.registerArrow(arrowTable, "workbench_export_rows");
    await db.executor.exec?.("COPY workbench_export_rows TO 'workbench-export.parquet' (FORMAT PARQUET)");
    const parquetBytes = await db.executor.copyFileToBuffer("workbench-export.parquet");
    const parquetRows = await db.executor.query("SELECT * FROM read_parquet('workbench-export.parquet') ORDER BY source_row_id");
    const parquetDecoded = await decodeSource(parquetBytes, "parquet", { parquetDecoder: () => parquetRows.rows.map((row) => ({ ...row }) as SourceRow) });
    const parquet = await service.export({ ...common, format: "parquet", parquetEncoder: async () => parquetBytes });
    const parquetEvidence: ExportRoundTripEvidence = { format: "parquet", rows: parquetDecoded.rows.length, preserved: parquetDecoded.logicalDigest === source.logicalDigest, metadataSidecar: Object.keys(parquet.metadata).length > 0 && Boolean(parquet.metadata.inputSnapshotId) };
    assertExportRoundTrip(parquetEvidence);
    await db.executor.dropFile?.("workbench-export.parquet");
    evidence.push({ queryableRows: parquetRows.rows.length, metadata: [csv.metadata, arrow.metadata, parquet.metadata] });
    return { status: "passed", rows: source.rows.length, formats: [csvEvidence, parquetEvidence, arrowEvidence], evidence };
  } catch (error) { return { status: "failed", rows: 0, formats: [], evidence: [...evidence, { error: error instanceof Error ? error.message : String(error) }] }; }
  finally { await db?.close().catch(() => undefined); }
}
