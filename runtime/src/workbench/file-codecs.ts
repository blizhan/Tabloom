import { RuntimeError } from "../model/errors";
import { sha256Hex } from "../model/identity";

/** A row representation that deliberately keeps null, empty strings, numbers,
 * booleans and timestamp-looking strings distinguishable. */
export type SourceValue = string | number | boolean | null;
export type SourceRow = Readonly<Record<string, SourceValue>>;

export interface DecodedTable {
  readonly columns: readonly string[];
  readonly rows: readonly SourceRow[];
  readonly types: Readonly<Record<string, "string" | "number" | "boolean" | "timestamp" | "null">>;
  readonly logicalDigest: string;
}

export interface DecodeOptions {
  /** Explicit column types win over inference. */
  readonly types?: Readonly<Record<string, string>>;
  readonly jsonPath?: string;
  /** Parquet is decoded by the configured DuckDB-WASM boundary. Keeping the
   * decoder injectable keeps this codec free of database connections. */
  readonly parquetDecoder?: (bytes: Uint8Array) => Promise<SourceRow[]> | SourceRow[];
}

export async function decodeSource(bytes: Uint8Array, format: "csv" | "json" | "arrow-ipc" | "parquet", options: DecodeOptions = {}): Promise<DecodedTable> {
  const rows = format === "csv" ? parseCsv(new TextDecoder().decode(bytes)) : format === "json" ? parseJson(new TextDecoder().decode(bytes), options.jsonPath ?? "$") : format === "arrow-ipc" ? await decodeArrowIpc(bytes) : options.parquetDecoder ? await options.parquetDecoder(bytes) : (() => { throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Parquet decoding requires the DuckDB-WASM codec"); })();
  const columns = collectColumns(rows);
  const types = inferTypes(columns, rows, options.types);
  const normalized = rows.map((row) => Object.fromEntries(columns.map((name) => [name, coerce(row[name], types[name])])) as SourceRow);
  return { columns, rows: normalized, types, logicalDigest: await digestRows(columns, normalized) };
}

export async function decodeArrowIpc(bytes: Uint8Array): Promise<SourceRow[]> {
  try {
    const arrow = await import("apache-arrow") as unknown as { tableFromIPC: (input: Uint8Array) => { toArray: () => readonly Record<string, unknown>[] } };
    const table = arrow.tableFromIPC(bytes) as unknown as { toArray: () => readonly Record<string, unknown>[]; schema?: { fields?: readonly { name: string; type?: { toString?: () => string } }[] } };
    const timestampColumns = new Set((table.schema?.fields ?? []).filter((field) => /timestamp|date/i.test(field.type?.toString?.() ?? "")).map((field) => field.name));
    return table.toArray().map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, timestampColumns.has(key) && typeof value === "number" ? new Date(value).toISOString() : normalizeArrowValue(value)])) as SourceRow);
  } catch (error) { throw new RuntimeError("INVALID_FORMAT", `Arrow IPC decode failed: ${error instanceof Error ? error.message : String(error)}`); }
}

export function parseCsv(text: string): SourceRow[] {
  const lines = splitRecords(text.replace(/^\uFEFF/, ""));
  if (!lines.length || (lines.length === 1 && lines[0].every((cell) => cell.value === ""))) return [];
  const header = lines[0].map((cell) => cell.value);
  if (!header.length || header.some((value) => !value.trim())) throw new RuntimeError("SCHEMA_MISMATCH", "CSV header contains an empty column");
  if (new Set(header).size !== header.length) throw new RuntimeError("SCHEMA_MISMATCH", "CSV header contains duplicate columns");
  return lines.slice(1).filter((row) => row.some((value) => value.value !== "" || value.quoted)).map((values, rowIndex) => {
    if (values.length !== header.length) throw new RuntimeError("INVALID_FORMAT", `CSV row ${rowIndex + 2} has ${values.length} columns; expected ${header.length}`);
    return Object.fromEntries(header.map((name, index) => [name, parseCsvValue(values[index].value, values[index].quoted)])) as SourceRow;
  });
}

export function parseJson(text: string, path = "$"): SourceRow[] {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { throw new RuntimeError("INVALID_FORMAT", `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (path !== "$") {
    for (const part of path.replace(/^\$\.?/, "").split(".").filter(Boolean)) {
      if (!value || typeof value !== "object") throw new RuntimeError("INVALID_FORMAT", `JSON path ${path} does not resolve to rows`);
      value = (value as Record<string, unknown>)[part];
    }
  }
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new RuntimeError("INVALID_FORMAT", "JSON input must be an array of row objects");
  return value.map((row) => Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, item]) => [key, normalizeJsonValue(item)])) as SourceRow);
}

export function encodeCsv(columns: readonly string[], rows: readonly SourceRow[]): Uint8Array {
  if (!columns.length) throw new RuntimeError("EXPORT_FAILED", "Cannot export a table without columns");
  const lines = [columns.map(csvCell).join(","), ...rows.map((row) => columns.map((name) => csvCell(row[name])).join(","))];
  return new TextEncoder().encode(`${lines.join("\n")}\n`);
}

export function encodeJson(columns: readonly string[], rows: readonly SourceRow[]): Uint8Array {
  const values = rows.map((row) => Object.fromEntries(columns.map((name) => [name, row[name] ?? null])));
  return new TextEncoder().encode(`${JSON.stringify(values, null, 2)}\n`);
}

export async function digestRows(columns: readonly string[], rows: readonly SourceRow[]): Promise<string> {
  const canonical = rows.map((row) => columns.map((name) => [name, row[name] ?? null]));
  return sha256Hex(new TextEncoder().encode(JSON.stringify({ columns, rows: canonical })));
}

interface CsvCell { readonly value: string; readonly quoted: boolean; }
function splitRecords(text: string): CsvCell[][] {
  const records: CsvCell[][] = [];
  let record: CsvCell[] = [];
  let cell = "";
  let quoted = false;
  let everQuoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"') {
      if (quoted && next === '"') { cell += '"'; index += 1; }
      else { quoted = !quoted; everQuoted = true; }
    } else if (char === "," && !quoted) { record.push({ value: cell, quoted: everQuoted }); cell = ""; everQuoted = false; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      record.push({ value: cell, quoted: everQuoted }); cell = ""; everQuoted = false;
      if (record.some((value) => value.value !== "" || value.quoted)) records.push(record);
      record = [];
    } else cell += char;
  }
  if (quoted) throw new RuntimeError("INVALID_FORMAT", "CSV contains an unterminated quoted field");
  if (cell.length || record.length || everQuoted) { record.push({ value: cell, quoted: everQuoted }); if (record.some((value) => value.value !== "" || value.quoted)) records.push(record); }
  return records;
}

function parseCsvValue(value: string, quoted: boolean): SourceValue { if (value === "\\N") return null; if (value === "" && !quoted) return null; if (value === "" && quoted) return ""; const trimmed = value.trim(); if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true"; if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) { const number = Number(trimmed); if (Number.isFinite(number) && (!Number.isInteger(number) || Number.isSafeInteger(number))) return number; } return value; }
function normalizeJsonValue(value: unknown): SourceValue { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") { if (typeof value === "number" && !Number.isFinite(value)) throw new RuntimeError("INVALID_FORMAT", "JSON cannot contain non-finite numbers"); if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) throw new RuntimeError("TYPE_LOSS", "JSON integer exceeds the lossless JavaScript range; use Arrow/Parquet or an explicit string type"); return value; } throw new RuntimeError("TYPE_LOSS", "Nested JSON values require an explicit relational transform"); }
function normalizeArrowValue(value: unknown): SourceValue { if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value; if (value instanceof Date) return value.toISOString(); if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : String(value); if (value && typeof value === "object" && "toISOString" in value && typeof (value as { toISOString?: unknown }).toISOString === "function") return (value as { toISOString: () => string }).toISOString(); throw new RuntimeError("TYPE_LOSS", "Arrow value cannot be represented without loss"); }
function collectColumns(rows: readonly SourceRow[]): string[] { const columns: string[] = []; const seen = new Set<string>(); for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); columns.push(key); } return columns; }
function inferTypes(columns: readonly string[], rows: readonly SourceRow[], explicit?: Readonly<Record<string, string>>): Record<string, DecodedTable["types"][string]> { const types: Record<string, DecodedTable["types"][string]> = {}; for (const column of columns) { const declared = explicit?.[column]?.toLowerCase(); if (declared === "string" || declared === "number" || declared === "boolean" || declared === "timestamp" || declared === "null") { types[column] = declared; continue; } const values = rows.map((row) => row[column]).filter((value): value is Exclude<SourceValue, null> => value !== null && value !== undefined); if (!values.length) types[column] = "null"; else if (values.every((value) => typeof value === "number")) types[column] = "number"; else if (values.every((value) => typeof value === "boolean")) types[column] = "boolean"; else if (values.every((value) => typeof value === "string" && isTimestampString(value))) types[column] = "timestamp"; else types[column] = "string"; } return types; }
function isTimestampString(value: string): boolean { return /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(value) && !Number.isNaN(Date.parse(value)); }
function coerce(value: SourceValue | undefined, type: DecodedTable["types"][string]): SourceValue { if (value === null || value === undefined) return null; if (type === "number") { const number = typeof value === "number" ? value : Number(value); if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) throw new RuntimeError("TYPE_LOSS", `Value ${String(value)} is not a lossless finite number`); return number; } if (type === "boolean") { if (typeof value === "boolean") return value; if (/^(true|false)$/i.test(String(value))) return String(value).toLowerCase() === "true"; throw new RuntimeError("TYPE_LOSS", `Value ${String(value)} is not boolean`); } if (type === "timestamp") { const date = typeof value === "number" ? new Date(value) : new Date(String(value)); if (Number.isNaN(date.getTime())) throw new RuntimeError("TYPE_LOSS", `Value ${String(value)} is not a valid timestamp`); return date.toISOString(); } if (type === "null") return null; return String(value); }
function csvCell(value: SourceValue | undefined): string { if (value === null || value === undefined) return "\\N"; const text = String(value); return text === "" || /[\",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }
