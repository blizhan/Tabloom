import { decodeSource, type DecodedTable, type SourceRow, type SourceValue } from "../src/workbench/file-codecs";
import { DuckDbService } from "../src/data/duckdb-service";
import { RuntimeError } from "../src/model/errors";

/** Decode a user source without making the UI know about DuckDB's virtual FS.
 * Parquet is the one binary format that must cross that boundary. */
export async function loadSourceBytes(db: DuckDbService, bytes: Uint8Array, format: "csv" | "json" | "arrow-ipc" | "parquet", jsonPath?: string): Promise<DecodedTable> {
  if (format !== "parquet") return decodeSource(bytes, format, { jsonPath });
  const fileName = `__tabloom_source_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.parquet`;
  await db.registerFileBuffer(fileName, bytes);
  try {
    const result = await db.query(`SELECT * FROM read_parquet('${fileName}')`);
    const rows = result.rows.map((row) => Object.fromEntries(result.columns.map((column) => [column, toSourceValue(row[column])])) as SourceRow);
    return decodeSource(new TextEncoder().encode(JSON.stringify(rows)), "json");
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError("INVALID_FORMAT", `Parquet decode failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.dropFile(fileName).catch(() => undefined);
  }
}

function toSourceValue(value: unknown): SourceValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new RuntimeError("TYPE_LOSS", "Parquet contains a non-finite number"); return value; }
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === "object" && "toISOString" in value && typeof (value as { toISOString?: unknown }).toISOString === "function") return (value as { toISOString: () => string }).toISOString();
  throw new RuntimeError("TYPE_LOSS", "Parquet value cannot be represented without loss");
}
