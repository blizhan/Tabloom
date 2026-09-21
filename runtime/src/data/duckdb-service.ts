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
  /** Optional file-system bridge exposed by DuckDB-WASM.  These operations
   * are intentionally kept at the executor boundary so product code cannot
   * mistake a browser file buffer for an arbitrary host file. */
  registerFileBuffer?(name: string, bytes: Uint8Array): Promise<void>;
  copyFileToBuffer?(name: string): Promise<Uint8Array>;
  dropFile?(name: string): Promise<void>;
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
  private readonly snapshots = new Map<string, InputSnapshot>(); private readonly resultRows = new Map<string, ResultRow[]>(); private readonly resultTables = new Map<string, string>();
  private readonly snapshotStore: InputSnapshotStore;
  constructor(executor?: DuckDbExecutor, snapshotStore?: InputSnapshotStore) { this.executor = executor; this.snapshotStore = snapshotStore ?? new InputSnapshotStore(); }
  async open(executor?: DuckDbExecutor): Promise<void> { if (this.closed) throw new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed"); if (executor) this.executor = executor; if (!this.executor) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB executor is not configured"); }
  private serial<T>(task: () => T | Promise<T>): Promise<T> { const run = this.queue.then(task); this.queue = run.then(() => undefined, () => undefined); return run; }
  query(sql: string, parameters: readonly unknown[] = []): Promise<DuckDbResult> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (!sql.trim()) return Promise.reject(new RuntimeError("INVALID_DATA", "SQL query is empty")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Use the transaction-scoped query method inside a transaction")); const executor = this.executor; if (!executor) return Promise.reject(new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB executor is not configured")); return this.serial(() => executor.query(sql, normalizeParameters(parameters))); }
  exec(sql: string, parameters: readonly unknown[] = []): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Use the transaction-scoped exec method inside the transaction")); const executor = this.executor; if (!executor?.exec) return Promise.reject(new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB executor does not support execution")); return this.serial(() => executor.exec!(sql, normalizeParameters(parameters))); }
  registerArrow(table: unknown, name: string): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot register Arrow data inside a transaction")); if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return Promise.reject(new RuntimeError("INVALID_DATA", `Unsafe Arrow table name: ${name}`)); if (!this.executor?.registerArrow) return Promise.reject(new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB executor does not support Arrow registration")); return this.serial(() => this.executor!.registerArrow!(table, name)); }
  registerFileBuffer(name: string, bytes: Uint8Array): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot register a file inside a transaction")); if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) return Promise.reject(new RuntimeError("INVALID_DATA", "DuckDB file bytes are empty")); if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) return Promise.reject(new RuntimeError("INVALID_DATA", `Unsafe DuckDB file name: ${name}`)); if (!this.executor?.registerFileBuffer) return Promise.reject(new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB executor does not support file registration")); return this.serial(() => this.executor!.registerFileBuffer!(name, new Uint8Array(bytes))); }
  dropFile(name: string): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot drop a file inside a transaction")); if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) return Promise.reject(new RuntimeError("INVALID_DATA", `Unsafe DuckDB file name: ${name}`)); if (!this.executor?.dropFile) return Promise.reject(new RuntimeError("UNSUPPORTED_CAPABILITY", "DuckDB executor does not support file removal")); return this.serial(() => this.executor!.dropFile!(name)); }
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
  registerResults(requestId: string, rows: readonly ResultRow[]): Promise<void> { if (this.closed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "DuckDB service is closed")); if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot register results inside a transaction")); return this.serial(async () => { const copy = [...rows]; const tableName = `predictions_${requestId.replace(/[^A-Za-z0-9_]/g, "_")}`; if (this.executor?.exec) { await this.executor.exec(`DROP TABLE IF EXISTS ${escapeIdentifier(tableName)}`); await this.executor.exec(`CREATE TEMP TABLE ${escapeIdentifier(tableName)} (request_id VARCHAR, input_snapshot_id VARCHAR, row_ordinal BIGINT, scenario_id VARCHAR, context_key VARCHAR, mean DOUBLE, q25 DOUBLE, q75 DOUBLE, metadata_json VARCHAR)`); for (const row of copy) await this.executor.exec(`INSERT INTO ${escapeIdentifier(tableName)} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, normalizeParameters([row.requestId, row.inputSnapshotId, row.rowOrdinal, row.scenarioId, row.contextKey, row.mean, row.q25 ?? null, row.q75 ?? null, JSON.stringify(row.metadata)])); } this.resultRows.set(requestId, copy); this.resultTables.set(requestId, tableName); }); }
  queryResults(requestId: string): readonly ResultRow[] { return [...(this.resultRows.get(requestId) ?? [])]; }
  resultTableName(requestId: string): string | undefined { return this.resultTables.get(requestId); }
  close(): Promise<void> { if (this.transactionActive) return Promise.reject(new RuntimeError("INVALID_DATA", "Cannot close DuckDB inside a transaction")); if (this.closePromise) return this.closePromise; this.closed = true; const queued = this.queue; this.closePromise = (async () => { await queued; const executor = this.executor; this.executor = undefined; await executor?.close?.(); })(); return this.closePromise; }
}
