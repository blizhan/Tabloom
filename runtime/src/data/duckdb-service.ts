import { RuntimeError } from "../model/errors";
import type { TypedSqlParameter } from "../model/identity";
import type { InputSnapshot } from "./input-snapshots";
import type { ResultRow } from "./result-publication";
import { materializeDataset } from "./arrow-dataset";
import { InputSnapshotStore } from "./input-snapshots";

export interface DuckDbResult { readonly columns: readonly string[]; readonly rows: readonly Record<string, unknown>[]; }
export interface DuckDbExecutor {
  query(sql: string, parameters?: readonly TypedSqlParameter[]): Promise<DuckDbResult>;
  exec?(sql: string, parameters?: readonly TypedSqlParameter[]): Promise<void>;
  /** Optional Arrow IPC registration exposed by the real WASM executor. */
  registerArrow?(table: unknown, name: string): Promise<void>;
  close?(): Promise<void>;
}
export interface DuckDbTransaction {
  query(sql: string, parameters?: readonly unknown[]): Promise<DuckDbResult>;
  exec(sql: string, parameters?: readonly unknown[]): Promise<void>;
}
export function escapeIdentifier(identifier: string): string { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) throw new RuntimeError("INVALID_DATA", `Unsafe SQL identifier: ${identifier}`); return `"${identifier.replaceAll('"', '""')}"`; }
export function normalizeParameters(parameters: readonly unknown[] = []): TypedSqlParameter[] { return parameters.map((value) => { if (value === null || value === undefined) return { type: "null", value: null }; if (typeof value === "string") return { type: "string", value }; if (typeof value === "boolean") return { type: "boolean", value }; if (typeof value === "bigint") return { type: "int64", value: value.toString(10) }; if (typeof value === "number") { if (!Number.isFinite(value)) throw new RuntimeError("INVALID_DATA", "SQL parameter must be finite"); return { type: "float64", value: Object.is(value, -0) ? "-0" : value.toString() }; } if (value instanceof Uint8Array) return { type: "bytes", value: new Uint8Array(value) }; throw new RuntimeError("INVALID_DATA", "Unsupported SQL parameter type"); }); }
function numericValue(value: unknown): number { return value === null || value === undefined ? Number.NaN : Number(value); }

export class DuckDbService {
  private executor?: DuckDbExecutor; private closed = false; private closePromise?: Promise<void>; private transactionActive = false; private queue: Promise<unknown> = Promise.resolve();
  private readonly snapshots = new Map<string, InputSnapshot>(); private readonly resultRows = new Map<string, ResultRow[]>();
  private readonly snapshotStore: InputSnapshotStore;
  constructor(executor?: DuckDbExecutor, snapshotStore?: InputSnapshotStore) { this.executor = executor; this.snapshotStore = snapshotStore ?? new InputSnapshotStore(); }
  async open(executor?: DuckDbExecutor): Promise<void> { if (this.closed) throw new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed"); if (executor) this.executor = executor; }
  private serial<T>(task: () => T | Promise<T>): Promise<T> { const run = this.queue.then(task); this.queue = run.then(() => undefined, () => undefined); return run; }
  query(sql: string, parameters: readonly unknown[] = []): Promise<DuckDbResult> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (!sql.trim()) return Promise.reject(new RuntimeError("INVALID_DATA", "SQL query is empty")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Use the transaction-scoped query method inside a transaction")); return this.serial(() => this.executor ? this.executor.query(sql, normalizeParameters(parameters)) : ({ columns: [], rows: [] })); }
  exec(sql: string, parameters: readonly unknown[] = []): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Use the transaction-scoped exec method inside a transaction")); return this.serial(async () => { if (this.executor?.exec) await this.executor.exec(sql, normalizeParameters(parameters)); }); }
  transaction<T>(task: (transaction: DuckDbTransaction) => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed"));
    if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Nested DuckDB transactions are not supported"));
    const executor = this.executor; const execute = executor?.exec?.bind(executor); if (!executor || !execute) return Promise.reject(new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB executor does not support transactions"));
    return this.serial(async () => {
    this.transactionActive = true;
    let scopeActive = true;
    let operations: Promise<unknown> = Promise.resolve();
    const assertScopeActive = (): void => { if (!scopeActive) throw new RuntimeError("INVALID_DATA", "DuckDB transaction scope is no longer active"); };
    const scoped = <R>(operation: () => Promise<R>): Promise<R> => { assertScopeActive(); const run = operations.then(operation); operations = run; return run; };
    const transaction: DuckDbTransaction = {
      query: async (sql, parameters = []) => { if (!sql.trim()) throw new RuntimeError("INVALID_DATA", "SQL query is empty"); return scoped(() => executor.query(sql, normalizeParameters(parameters))); },
      exec: async (sql, parameters = []) => scoped(() => execute(sql, normalizeParameters(parameters))),
    };
    try {
      await execute("BEGIN TRANSACTION", []);
      let result: T;
      try { result = await task(transaction); } finally { scopeActive = false; }
      await operations;
      await execute("COMMIT", []);
      return result;
    } catch (error) {
      try { await operations; } catch { /* preserve the callback or scoped-operation failure */ }
      try { await execute("ROLLBACK", []); } catch { /* preserve the transaction failure */ }
      throw error;
    } finally { scopeActive = false; this.transactionActive = false; }
  }); }
  registerSnapshot(snapshot: InputSnapshot): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot register a snapshot inside a transaction")); return this.serial(() => { if (this.snapshots.has(snapshot.inputSnapshotId)) throw new RuntimeError("INVALID_DATA", "Snapshot id is already registered"); this.snapshots.set(snapshot.inputSnapshotId, snapshot); }); }
  async materializeTraining(sql: string, typedParams: readonly unknown[], featureNames: readonly string[], targetName: string, businessKeyNames: readonly string[] = []): Promise<InputSnapshot> {
    const result = await this.query(sql, typedParams); const columns = featureNames.map((name) => ({ name, values: result.rows.map((row) => numericValue(row[name])), type: "float64" as const })); const target = { name: targetName, values: result.rows.map((row) => numericValue(row[targetName])), type: "float64" as const }; const dataset = materializeDataset({ columns, target, targetName }); const keys = businessKeyNames.map((name) => result.rows.map((row) => row[name])); const businessKeys = keys.length ? result.rows.map((_row, index) => keys.map((column) => column[index])) : []; const snapshot = this.snapshotStore.create(dataset, businessKeys, { businessRows: result.rows, provenance: { sql, typedParams, featureNames, targetName } }); await this.registerSnapshot(snapshot); return snapshot;
  }
  async materializePrediction(sql: string, typedParams: readonly unknown[], featureNames: readonly string[], businessKeyNames: readonly string[] = []): Promise<InputSnapshot> {
    const result = await this.query(sql, typedParams); const columns = featureNames.map((name) => ({ name, values: result.rows.map((row) => numericValue(row[name])), type: "float64" as const })); const dataset = materializeDataset({ columns }); const keys = businessKeyNames.map((name) => result.rows.map((row) => row[name])); const businessKeys = keys.length ? result.rows.map((_row, index) => keys.map((column) => column[index])) : []; const snapshot = this.snapshotStore.create(dataset, businessKeys, { businessRows: result.rows, provenance: { sql, typedParams, featureNames } }); await this.registerSnapshot(snapshot); return snapshot;
  }
  getSnapshot(id: string): InputSnapshot | undefined { return this.snapshots.get(id); }
  registerResults(requestId: string, rows: readonly ResultRow[]): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot register results inside a transaction")); return this.serial(() => { this.resultRows.set(requestId, [...rows]); }); }
  queryResults(requestId: string): readonly ResultRow[] { return [...(this.resultRows.get(requestId) ?? [])]; }
  close(): Promise<void> { if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot close DuckDB inside a transaction")); if (this.closePromise) return this.closePromise; this.closed = true; const queued = this.queue; this.closePromise = (async () => { await queued; const executor = this.executor; this.executor = undefined; await executor?.close?.(); })(); return this.closePromise; }
}
