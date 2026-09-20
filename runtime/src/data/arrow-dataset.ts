import { RuntimeError } from "../model/errors";
import type { TabularDataset, TrainingDataset } from "../model/types";

export type NumericColumnType = "float" | "float32" | "float64" | "integer" | "int32" | "int64" | "uint32" | "uint64";
export interface ColumnInput {
  readonly name: string;
  readonly values?: ArrayLike<number>;
  readonly chunks?: readonly ArrayLike<number>[];
  readonly validity?: ArrayLike<boolean | number>;
  readonly offset?: number;
  readonly length?: number;
  readonly type?: NumericColumnType;
}
export interface DatasetInput {
  readonly columns: readonly ColumnInput[];
  readonly rowCount?: number;
  readonly target?: ColumnInput;
  readonly targetName?: string;
  readonly expectedColumnNames?: readonly string[];
}

function sourceLength(column: ColumnInput): number {
  if (column.values) return column.values.length;
  return (column.chunks ?? []).reduce((sum, chunk) => sum + chunk.length, 0);
}
function indexed(source: unknown, index: number): number {
  if (source && typeof (source as { get?: (at: number) => unknown }).get === "function") return Number((source as { get: (at: number) => unknown }).get(index));
  return Number((source as ArrayLike<number>)[index]);
}
function chunkAt(column: ColumnInput, index: number): { readonly source: ArrayLike<number>; readonly index: number } | undefined {
  let at = (column.offset ?? 0) + index;
  for (const chunk of column.chunks ?? []) { if (at < chunk.length) return { source: chunk, index: at }; at -= chunk.length; }
  return undefined;
}
function readValue(column: ColumnInput, index: number): number {
  if (column.values) return indexed(column.values, (column.offset ?? 0) + index);
  const located = chunkAt(column, index); return located ? indexed(located.source, located.index) : Number.NaN;
}
function readValid(column: ColumnInput, index: number): boolean {
  if (!column.validity) {
    if (column.values) { const source = column.values as unknown as { isValid?: (at: number) => boolean }; return source.isValid ? source.isValid((column.offset ?? 0) + index) : true; }
    const located = chunkAt(column, index); const source = located?.source as unknown as { isValid?: (at: number) => boolean } | undefined;
    return source?.isValid && located ? source.isValid(located.index) : true;
  }
  const at = (column.offset ?? 0) + index;
  return Boolean(column.validity[at]);
}
function convertValue(value: number, index: number, column: string, kind: NumericColumnType | undefined, allowInf: boolean): number {
  if (kind === "int64" || kind === "uint64") {
    if (!Number.isSafeInteger(value)) throw new RuntimeError("NUMERIC_OVERFLOW", `Unsafe integer in ${column}[${index}]`);
    if (kind === "uint64" && value < 0) throw new RuntimeError("INVALID_DATA", `Negative unsigned integer in ${column}[${index}]`);
  } else if ((kind === "int32" || kind === "uint32") && (!Number.isInteger(value) || value < (kind === "uint32" ? 0 : -2147483648) || value > (kind === "uint32" ? 4294967295 : 2147483647))) {
    throw new RuntimeError("NUMERIC_OVERFLOW", `Integer out of range in ${column}[${index}]`);
  }
  if (Number.isNaN(value)) return Number.NaN;
  if (!Number.isFinite(value)) {
    if (!allowInf) throw new RuntimeError("INF_DISABLED", `Infinity is disabled in ${column}[${index}]`);
    return value;
  }
  const rounded = Math.fround(value);
  if (!Number.isFinite(rounded)) throw new RuntimeError("NUMERIC_OVERFLOW", `Float32 conversion overflow in ${column}[${index}]`);
  return rounded;
}
function convertColumn(column: ColumnInput, rowCount: number, allowInf: boolean): Float32Array {
  if (!column.name || column.name.trim() === "") throw new RuntimeError("INVALID_DATA", "Column name is empty");
  if (column.type && !["float", "float32", "float64", "integer", "int32", "int64", "uint32", "uint64"].includes(column.type)) throw new RuntimeError("INVALID_DATA", `Unsupported column type for ${column.name}`);
  const offset = column.offset ?? 0;
  const available = sourceLength(column);
  const length = column.length ?? available - offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length !== rowCount || offset + length > available) throw new RuntimeError("INVALID_DATA", `Column length mismatch: ${column.name}`);
  const out = new Float32Array(rowCount);
  for (let i = 0; i < rowCount; i += 1) out[i] = readValid(column, i) ? convertValue(readValue(column, i), i, column.name, column.type, allowInf) : Number.NaN;
  return out;
}
function checkNames(columns: readonly ColumnInput[]): void {
  const names = new Set<string>();
  for (const column of columns) { if (names.has(column.name)) throw new RuntimeError("SCHEMA_MISMATCH", `Duplicate column: ${column.name}`); names.add(column.name); }
}
function checkExpected(names: readonly string[], expected?: readonly string[]): void {
  if (!expected) return;
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new RuntimeError("SCHEMA_MISMATCH", "Feature column order does not match the fitted schema");
}

export function materializeDataset(input: DatasetInput, options: { allowInf?: boolean; requireTarget?: boolean; expectedColumnNames?: readonly string[] } = {}): TabularDataset | TrainingDataset {
  if (!input || !Array.isArray(input.columns)) throw new RuntimeError("INVALID_DATA", "Columns are required");
  checkNames(input.columns);
  const inferred = input.rowCount ?? (input.columns[0] ? (input.columns[0].length ?? sourceLength(input.columns[0]) - (input.columns[0].offset ?? 0)) : 0);
  if (!Number.isSafeInteger(inferred) || inferred <= 0) throw new RuntimeError("INVALID_DATA", "Dataset must contain at least one row");
  const rowCount = inferred; const names = input.columns.map((column) => column.name);
  checkExpected(names, options.expectedColumnNames ?? input.expectedColumnNames);
  const columns = input.columns.map((column) => convertColumn(column, rowCount, options.allowInf ?? false));
  if (!input.target) {
    if (options.requireTarget) throw new RuntimeError("NONFINITE_TARGET", "Training target is required");
    return { columns, columnNames: names, rowCount };
  }
  if (!input.targetName || names.includes(input.targetName) || (input.target.name && input.target.name !== input.targetName)) throw new RuntimeError("INVALID_DATA", "Target name must be present and distinct from feature columns");
  let target: Float32Array;
  try { target = convertColumn(input.target, rowCount, false); } catch (error) { if (error instanceof RuntimeError && (error.code === "INF_DISABLED" || error.code === "INVALID_DATA")) throw new RuntimeError("NONFINITE_TARGET", "Training target must be finite"); throw error; }
  if ([...target].some((value) => !Number.isFinite(value))) throw new RuntimeError("NONFINITE_TARGET", "Training target must be finite");
  return { columns, columnNames: names, rowCount, target, targetName: input.targetName };
}

export function cloneDataset(dataset: TabularDataset | TrainingDataset): TabularDataset | TrainingDataset {
  const base = { columns: dataset.columns.map((column) => new Float32Array(column)), columnNames: [...dataset.columnNames], rowCount: dataset.rowCount, sourceSnapshotId: dataset.sourceSnapshotId };
  return "target" in dataset ? { ...base, target: new Float32Array(dataset.target), targetName: dataset.targetName } : base;
}

export function assertDatasetSchema(dataset: TabularDataset, expectedNames: readonly string[], bounds?: { minRows?: number; maxRows?: number; maxFeatures?: number }): void {
  checkExpected(dataset.columnNames, expectedNames);
  if (bounds?.minRows !== undefined && dataset.rowCount < bounds.minRows) throw new RuntimeError("SHAPE_UNSUPPORTED", "Too few rows");
  if (bounds?.maxRows !== undefined && dataset.rowCount > bounds.maxRows) throw new RuntimeError("SHAPE_UNSUPPORTED", "Too many rows");
  if (bounds?.maxFeatures !== undefined && dataset.columns.length > bounds.maxFeatures) throw new RuntimeError("SHAPE_UNSUPPORTED", "Too many features");
}
