import { RuntimeError } from "../model/errors";
import { DuckDbService, type DuckDbResult } from "../data/duckdb-service";
import type { MaterializedInput, QueryDefinition, TableSchema, TableStats } from "./types";

const forbidden = /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|ATTACH|DETACH|COPY|EXPORT|INSTALL|LOAD|PRAGMA|SET|RESET|BEGIN|COMMIT|ROLLBACK|CALL)\b/i;
const externalFunctions = new Set(["read_csv", "read_csv_auto", "read_json", "read_json_auto", "read_json_objects", "read_ndjson", "read_parquet", "parquet_scan", "parquet_metadata", "glob", "read_blob", "read_text", "httpfs", "http_get", "http_post", "sqlite_scan", "postgres_scan", "mysql_scan", "deltalake_scan", "iceberg_scan"]);
type SqlToken = { readonly kind: "word" | "quotedIdentifier" | "string" | "symbol"; readonly value: string };
interface SqlScan { readonly statement: string; readonly hasTopLevelSemicolon: boolean; readonly tokens: readonly SqlToken[]; }

function scanSql(sql: string): SqlScan {
  const tokens: SqlToken[] = []; let statement = ""; let semicolon = false; let lineComment = false; let blockDepth = 0;
  for (let index = 0; index < sql.length;) {
    const char = sql[index]; const next = sql[index + 1];
    if (lineComment) { if (char === "\n" || char === "\r") lineComment = false; index += 1; continue; }
    if (blockDepth) { if (char === "/" && next === "*") { blockDepth += 1; index += 2; } else if (char === "*" && next === "/") { blockDepth -= 1; index += 2; } else index += 1; continue; }
    if (char === "-" && next === "-") { lineComment = true; index += 2; continue; }
    if (char === "/" && next === "*") { blockDepth = 1; index += 2; continue; }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char; let value = ""; let end = index + 1;
      for (; end < sql.length; end += 1) {
        if (sql[end] === quote && sql[end + 1] === quote) { if (quote !== "'") value += quote; end += 1; continue; }
        if (sql[end] === quote) { end += 1; break; }
        if (quote !== "'") value += sql[end];
      }
      tokens.push({ kind: quote === "'" ? "string" : "quotedIdentifier", value }); statement += " ".repeat(end - index); index = end; continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1; while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) end += 1;
      const value = sql.slice(index, end); tokens.push({ kind: "word", value }); statement += value; index = end; continue;
    }
    if (char === ";") { if (sql.slice(index + 1).trim()) semicolon = true; index += 1; continue; }
    if (!/\s/.test(char)) tokens.push({ kind: "symbol", value: char }); statement += char; index += 1;
  }
  return { statement, hasTopLevelSemicolon: semicolon, tokens };
}

function hasExternalOperation(tokens: readonly SqlToken[]): boolean {
  let relationExpected = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]; const normalized = token.value.toLowerCase();
    if ((token.kind === "word" || token.kind === "quotedIdentifier") && externalFunctions.has(normalized) && tokens[index + 1]?.kind === "symbol" && tokens[index + 1]?.value === "(") return true;
    if (token.kind === "word" && (normalized === "from" || normalized === "join")) { relationExpected = true; continue; }
    if (!relationExpected) continue;
    if (token.kind === "string") return true;
    if (token.kind === "symbol" && token.value === "(") { relationExpected = false; continue; }
    relationExpected = false;
  }
  return false;
}
export function validateReadonlyQuery(sql: string): void {
  if (!sql.trim()) throw new RuntimeError("INVALID_QUERY", "SQL query is empty");
  const scanned = scanSql(sql); const normalized = scanned.statement.trim();
  if (scanned.hasTopLevelSemicolon) throw new RuntimeError("INVALID_QUERY", "Only one read-only SQL statement is allowed");
  if (!/^(?:WITH\b|SELECT\b|VALUES\b|TABLE\b)/i.test(normalized)) throw new RuntimeError("INVALID_QUERY", "Query must be a read-only relation query");
  if (forbidden.test(normalized) || hasExternalOperation(scanned.tokens)) throw new RuntimeError("INVALID_QUERY", "Query contains a forbidden mutation or external data operation");
}
export interface QueryPreview { readonly sourceSnapshotId: string; readonly revision: number; readonly result: DuckDbResult; readonly rowCount: number; readonly previewRows: readonly Record<string, unknown>[]; readonly rowOrdinal: readonly number[]; }
export class ReadonlyQueryService {
  constructor(private readonly db: DuckDbService, private readonly maxPreviewRows = 200) { if (!Number.isSafeInteger(maxPreviewRows) || maxPreviewRows <= 0 || maxPreviewRows > 200) throw new RuntimeError("INPUT_LIMIT", "Preview row limit must be between 1 and 200"); }
  async execute(definition: QueryDefinition): Promise<QueryPreview> { if (!definition.sourceSnapshotId?.trim()) throw new RuntimeError("INVALID_QUERY", "A source snapshot binding is required"); if (!Number.isSafeInteger(definition.revision) || definition.revision < 0) throw new RuntimeError("INVALID_QUERY", "Query revision must be a non-negative integer"); validateReadonlyQuery(definition.sql); const result = await this.db.query(definition.sql, definition.parameters ?? []); const previewRows = result.rows.slice(0, this.maxPreviewRows); return { sourceSnapshotId: definition.sourceSnapshotId, revision: definition.revision, result, rowCount: result.rows.length, previewRows, rowOrdinal: Array.from({ length: result.rows.length }, (_, index) => index) }; }
  async materialize(definition: QueryDefinition): Promise<MaterializedInput> { const preview = await this.execute(definition); const inputSnapshotId = `query-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`; return { inputSnapshotId, rowCount: preview.rowCount, rowOrdinal: preview.rowOrdinal, columns: preview.result.columns, result: preview.result, query: definition }; }
  async inspect(definition: QueryDefinition, tableId: string): Promise<{ readonly schema: readonly TableSchema[]; readonly stats: TableStats }> { if (!tableId.trim()) throw new RuntimeError("INVALID_QUERY", "Table id is required"); const result = await this.execute(definition); const nullCounts: Record<string, number> = {}; const numeric: Record<string, { min: number | null; max: number | null; mean: number | null }> = {}; for (const column of result.result.columns) { const values = result.result.rows.map((row) => row[column]); nullCounts[column] = values.filter((value) => value === null || value === undefined).length; const numbers = values.flatMap((value) => typeof value === "number" && Number.isFinite(value) ? [value] : typeof value === "bigint" && Number.isSafeInteger(Number(value)) ? [Number(value)] : []); if (numbers.length) { let min = numbers[0]; let max = numbers[0]; let sum = 0; for (const number of numbers) { min = Math.min(min, number); max = Math.max(max, number); sum += number; } numeric[column] = { min, max, mean: sum / numbers.length }; } else numeric[column] = { min: null, max: null, mean: null }; } return { schema: result.result.columns.map((name) => ({ name, type: inferType(result.result.rows, name), nullable: nullCounts[name] > 0 })), stats: { rowCount: result.rowCount, nullCounts, numeric } }; }
}
function inferType(rows: readonly Record<string, unknown>[], name: string): string { const value = rows.find((row) => row[name] !== null && row[name] !== undefined)?.[name]; return value === null || value === undefined ? "unknown" : typeof value; }
