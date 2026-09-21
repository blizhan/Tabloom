import { tableFromArrays } from "apache-arrow";
import { DuckDbService, escapeIdentifier, type DuckDbResult } from "../data/duckdb-service";
import { RuntimeError } from "../model/errors";
import { validateReadonlyQuery } from "./query-service";

export const DATASET_TABLE = "dataset";
export const DATASET_ROW_ID = "__tabloom_row_id";
export type SplitPreset =
  | { readonly mode: "ratio"; readonly orderBy?: string }
  | { readonly mode: "time"; readonly column: string; readonly cutoff: string };

/** Source names become DuckDB table names. Keep this check stricter than the
 * SQL identifier escaper because source names are also used in UI bindings. */
export function validateSourceName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new RuntimeError("INVALID_DATA", "Source name must be a SQL-safe identifier");
  if (name.toLowerCase() === DATASET_TABLE || name.toLowerCase().startsWith("__tabloom_")) throw new RuntimeError("NAME_CONFLICT", `Source name ${name} is reserved by the workbench`);
}

export function quoteColumn(name: string): string {
  if (!name) throw new RuntimeError("INVALID_DATA", "Column name cannot be empty");
  return `"${name.replaceAll('"', '""')}"`;
}

/** Run the user relation once, add an immutable row identity, and replace the
 * materialized Dataset in a transaction. The returned result is the complete
 * Dataset, never the UI preview slice. */
export async function materializeWorkbenchDataset(db: DuckDbService, sql: string): Promise<DuckDbResult> {
  validateReadonlyQuery(sql);
  const result = await db.query(sql);
  if (!result.rows.length) throw new RuntimeError("EMPTY_INPUT", "Dataset 返回 0 行");
  if (result.columns.some((column) => column.toLowerCase().startsWith("__tabloom_"))) throw new RuntimeError("SCHEMA_MISMATCH", "Dataset 不能包含 __tabloom_ 前缀的保留列");
  if (new Set(result.columns).size !== result.columns.length) throw new RuntimeError("SCHEMA_MISMATCH", "Dataset 含重复列名，请使用 AS 指定唯一名称");
  const rows: Array<Record<string, unknown>> = result.rows.map((row, index) => ({ [DATASET_ROW_ID]: index + 1, ...row }));
  const columns = [DATASET_ROW_ID, ...result.columns];
  const arrays: Record<string, unknown[]> = Object.fromEntries(columns.map((name) => [name, rows.map((row) => row[name])]));
  const staging = `__tabloom_dataset_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.registerArrow(tableFromArrays(arrays), staging);
  try {
    await db.transaction(async (transaction) => {
      await transaction.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(DATASET_TABLE)}`);
      await transaction.exec(`ALTER TABLE ${escapeIdentifier(staging)} RENAME TO ${escapeIdentifier(DATASET_TABLE)}`);
    });
  } catch (error) {
    await db.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(staging)}`).catch(() => undefined);
    throw error;
  }
  return { columns, rows };
}

export function createSplitSql(preset: SplitPreset): { readonly trainingSql: string; readonly testSql: string } {
  if (preset.mode === "ratio") {
    const order = `${preset.orderBy ? `${quoteColumn(preset.orderBy)} ASC NULLS LAST, ` : ""}${quoteColumn(DATASET_ROW_ID)} ASC`;
    const ranked = `WITH ranked AS (SELECT *, row_number() OVER (ORDER BY ${order}) AS __tabloom_rank, count(*) OVER () AS __tabloom_count FROM ${escapeIdentifier(DATASET_TABLE)})`;
    const select = (condition: string) => `${ranked} SELECT * EXCLUDE (__tabloom_rank, __tabloom_count) FROM ranked WHERE ${condition} ORDER BY __tabloom_rank ASC`;
    return { trainingSql: select("__tabloom_rank <= floor(__tabloom_count * 0.8)"), testSql: select("__tabloom_rank > floor(__tabloom_count * 0.8)") };
  }
  if (!preset.column.trim()) throw new RuntimeError("INVALID_DATA", "Time split column is required");
  if (!preset.cutoff.trim() || Number.isNaN(Date.parse(preset.cutoff))) throw new RuntimeError("INVALID_DATA", "Time split cutoff must be a valid date or timestamp");
  const column = quoteColumn(preset.column);
  const cutoff = `'${preset.cutoff.replaceAll("'", "''")}'`;
  const base = `FROM ${escapeIdentifier(DATASET_TABLE)} WHERE ${column} IS NOT NULL AND CAST(${column} AS TIMESTAMPTZ)`;
  const order = ` ORDER BY ${quoteColumn(DATASET_ROW_ID)} ASC`;
  return {
    trainingSql: `SELECT * ${base} < CAST(${cutoff} AS TIMESTAMPTZ)${order}`,
    testSql: `SELECT * ${base} >= CAST(${cutoff} AS TIMESTAMPTZ)${order}`,
  };
}

export function inspectOverlap(train: DuckDbResult, test: DuckDbResult): { readonly verifiable: boolean; readonly overlapCount: number } {
  if (!train.columns.includes(DATASET_ROW_ID) || !test.columns.includes(DATASET_ROW_ID)) return { verifiable: false, overlapCount: 0 };
  const trainIds = new Set(train.rows.map((row) => canonicalIdentity(row[DATASET_ROW_ID])));
  const overlap = new Set(test.rows.map((row) => canonicalIdentity(row[DATASET_ROW_ID])).filter((id) => trainIds.has(id)));
  return { verifiable: true, overlapCount: overlap.size };
}

function canonicalIdentity(value: unknown): string {
  if (typeof value === "bigint") return `bigint:${value.toString(10)}`;
  return `${typeof value}:${String(value)}`;
}
