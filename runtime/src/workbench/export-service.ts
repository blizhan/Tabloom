import { RuntimeError } from "../model/errors";
import type { DuckDbResult } from "../data/duckdb-service";
import { encodeCsv, encodeJson, type SourceRow } from "./file-codecs";
import { createExportMetadata, type ExportMetadataInput } from "./export-metadata";
import type { ExportBundle, SourceFormat } from "./types";

export interface ExportOptions extends Omit<ExportMetadataInput, "format" | "schema"> {
  readonly columns: readonly string[];
  readonly schema: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[];
  readonly rows: readonly Record<string, unknown>[];
  readonly format: "csv" | "parquet" | "arrow-ipc";
  readonly parquetEncoder?: (result: DuckDbResult) => Promise<Uint8Array>;
}

export class ExportService {
  async export(options: ExportOptions): Promise<{ readonly bundle: ExportBundle; readonly metadata: Readonly<Record<string, unknown>> }> {
    if (!options.rows || !options.columns.length) throw new RuntimeError("EXPORT_FAILED", "Nothing to export");
    const rows = options.rows.map((row) => Object.fromEntries(options.columns.map((column) => [column, toSourceValue(row[column])])) as SourceRow);
    let data: Uint8Array;
    if (options.format === "csv") data = encodeCsv(options.columns, rows);
    else if (options.format === "arrow-ipc") data = await encodeArrow(options.columns, rows);
    else if (options.parquetEncoder) data = await options.parquetEncoder({ columns: options.columns, rows: options.rows });
    else throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Parquet export requires the DuckDB-WASM parquet encoder");
    const metadata = createExportMetadata({ ...options, format: options.format, schema: options.schema });
    return { bundle: { format: options.format, data, metadata }, metadata };
  }
  metadataSidecar(metadata: Readonly<Record<string, unknown>>): Uint8Array { return new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`); }
}

async function encodeArrow(columns: readonly string[], rows: readonly SourceRow[]): Promise<Uint8Array> {
  try {
    const arrow = await import("apache-arrow") as unknown as { tableFromArrays: (arrays: Record<string, unknown>) => unknown; tableToIPC: (table: unknown, type?: string) => Uint8Array };
    const arrays = Object.fromEntries(columns.map((column) => [column, rows.map((row) => row[column] ?? null)]));
    return new Uint8Array(arrow.tableToIPC(arrow.tableFromArrays(arrays), "file"));
  } catch (error) { throw new RuntimeError("EXPORT_FAILED", `Arrow IPC export failed: ${error instanceof Error ? error.message : String(error)}`); }
}

function toSourceValue(value: unknown): string | number | boolean | null { if (value === null || value === undefined) return null; if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") { if (typeof value === "number" && !Number.isFinite(value)) throw new RuntimeError("TYPE_LOSS", "Cannot export non-finite numbers"); return value; } if (typeof value === "bigint") { if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) throw new RuntimeError("TYPE_LOSS", "CSV/JSON export cannot losslessly represent this integer"); return Number(value); } throw new RuntimeError("TYPE_LOSS", `Cannot export value of type ${typeof value}`); }
