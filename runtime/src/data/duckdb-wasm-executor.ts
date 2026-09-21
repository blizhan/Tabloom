import type { DuckDbExecutor, DuckDbResult } from "./duckdb-service";
import type { TypedSqlParameter } from "../model/identity";
import { RuntimeError } from "../model/errors";

export interface DuckDbWasmOptions { readonly workerUrl: string; readonly wasmUrl: string; readonly pthreadWorkerUrl?: string; readonly maximumThreads?: number; }
export function prepareParameters(sql: string, parameters: readonly TypedSqlParameter[]): { readonly sql: string; readonly values: readonly unknown[] } {
  const values = parameters.filter((parameter) => parameter.type !== "null").map((parameter) => {
    if (parameter.type === "bytes") return [...parameter.value as Uint8Array].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (parameter.type === "boolean") return String(parameter.value);
    return parameter.value;
  });
  const expression = (parameter: TypedSqlParameter | undefined): string => {
    if (parameter?.type === "float64") return "CAST(? AS DOUBLE)";
    if (parameter?.type === "int64") return "CAST(? AS BIGINT)";
    if (parameter?.type === "bytes") return "from_hex(?)";
    if (parameter?.type === "boolean") return "CAST(? AS BOOLEAN)";
    if (parameter?.type === "string") return "CAST(? AS VARCHAR)";
    if (parameter?.type === "null") return "NULL";
    return "?";
  };
  let parameterIndex = 0; let state: "normal" | "single" | "double" | "dollar" | "line" | "block" = "normal"; let rewritten = "";
  let escapeString = false; let dollarDelimiter = ""; let blockDepth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index]; const next = sql[index + 1];
    if (state === "normal") {
      if (char === "'") { const prefix = sql[index - 1]; const beforePrefix = sql[index - 2]; escapeString = (prefix === "E" || prefix === "e") && (index < 2 || !/[A-Za-z0-9_$]/.test(beforePrefix)); state = "single"; }
      else if (char === '"') state = "double";
      else if (char === "-" && next === "-") { state = "line"; rewritten += char; index += 1; rewritten += next; continue; }
      else if (char === "/" && next === "*") { state = "block"; blockDepth = 1; rewritten += char; index += 1; rewritten += next; continue; }
      else if (char === "$") { const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]; if (delimiter) { state = "dollar"; dollarDelimiter = delimiter; rewritten += delimiter; index += delimiter.length - 1; continue; } }
      else if (char === "?") { if (parameterIndex >= parameters.length) throw new RuntimeError("INVALID_DATA", "SQL placeholder count exceeds parameter count"); rewritten += expression(parameters[parameterIndex++]); continue; }
    } else if (state === "single") {
      if (escapeString && char === "\\" && next !== undefined) { rewritten += char; index += 1; rewritten += next; continue; }
      if (char === "'") { if (next === "'") { rewritten += char; index += 1; rewritten += next; continue; } state = "normal"; escapeString = false; }
    }
    else if (state === "double" && char === '"') { if (next === '"') { rewritten += char; index += 1; rewritten += next; continue; } state = "normal"; }
    else if (state === "dollar" && sql.startsWith(dollarDelimiter, index)) { rewritten += dollarDelimiter; index += dollarDelimiter.length - 1; state = "normal"; dollarDelimiter = ""; continue; }
    else if (state === "line" && (char === "\n" || char === "\r")) state = "normal";
    else if (state === "block" && char === "/" && next === "*") { blockDepth += 1; rewritten += char; index += 1; rewritten += next; continue; }
    else if (state === "block" && char === "*" && next === "/") { blockDepth -= 1; if (blockDepth === 0) state = "normal"; rewritten += char; index += 1; rewritten += next; continue; }
    rewritten += char;
  }
  if (parameterIndex !== parameters.length) throw new RuntimeError("INVALID_DATA", "SQL parameter count exceeds placeholder count");
  return { sql: rewritten, values };
}
/** Create the real DuckDB-WASM async worker executor. This is intentionally an
 * explicit factory so importing the pure data/model entry does not pull WASM
 * or UI dependencies into unit tests. */
export async function createDuckDbWasmExecutor(options: DuckDbWasmOptions): Promise<{ executor: DuckDbExecutor; close: () => Promise<void> }> {
  const duckdb = await import("@duckdb/duckdb-wasm"); const worker = await duckdb.createWorker(options.workerUrl); const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker); await db.instantiate(options.wasmUrl, options.pthreadWorkerUrl ?? null); await db.open({ maximumThreads: options.maximumThreads ?? 1, arrowLosslessConversion: true }); const connection = await db.connect();
  const executor: DuckDbExecutor = {
    async query(sql: string, parameters: readonly TypedSqlParameter[] = []): Promise<DuckDbResult> {
      let table;
      if (parameters.length) {
        const prepared = prepareParameters(sql, parameters); const statement = await connection.prepare(prepared.sql);
        try { table = await statement.query(...prepared.values); }
        finally { await statement.close(); }
      } else table = await connection.query(sql);
      const rows = (table as unknown as { toArray: () => unknown[] }).toArray().map((row) => (typeof (row as { toJSON?: () => unknown }).toJSON === "function" ? (row as { toJSON: () => Record<string, unknown> }).toJSON() : row as Record<string, unknown>));
      const columns = table.schema.fields.map((field) => field.name);
      return { columns, rows };
    },
    async exec(sql: string, parameters: readonly TypedSqlParameter[] = []): Promise<void> {
      if (parameters.length) {
        const prepared = prepareParameters(sql, parameters); const statement = await connection.prepare(prepared.sql);
        try { await statement.query(...prepared.values); }
        finally { await statement.close(); }
      } else await connection.query(sql);
    },
    async registerArrow(table: unknown, name: string): Promise<void> {
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe Arrow table name: ${name}`);
      await connection.insertArrowTable(table as never, { name });
    },
    async registerFileBuffer(name: string, bytes: Uint8Array): Promise<void> {
      if (!name || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Unsafe DuckDB file name: ${name}`);
      await db.registerFileBuffer(name, new Uint8Array(bytes));
    },
    async copyFileToBuffer(name: string): Promise<Uint8Array> {
      if (!name || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Unsafe DuckDB file name: ${name}`);
      return new Uint8Array(await db.copyFileToBuffer(name));
    },
    async dropFile(name: string): Promise<void> {
      if (!name || !/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new Error(`Unsafe DuckDB file name: ${name}`);
      await db.dropFile(name);
    },
    async close(): Promise<void> { await connection.close(); await db.terminate(); },
  };
  return { executor, close: () => executor.close?.() ?? Promise.resolve() };
}
