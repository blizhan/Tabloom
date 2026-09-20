import test from "node:test";
import assert from "node:assert/strict";
import { DuckDbService, normalizeParameters } from "../../src/data/duckdb-service";
import { RuntimeError } from "../../src/model/errors";

test("normalizes finite SQL numbers as round-trippable decimal values", () => {
  const parameters = normalizeParameters([17, 10, 1.5, -0, Number.MIN_VALUE, Number.MAX_VALUE]);
  assert.deepEqual(parameters.map((parameter) => parameter.value), ["17", "10", "1.5", "-0", "5e-324", "1.7976931348623157e+308"]);
});

test("preserves SQL NULL features as missing values and rejects a NULL training target", async () => {
  const prediction = new DuckDbService({ query: async () => ({ columns: ["x"], rows: [{ x: null }] }) });
  const predictionSnapshot = await prediction.materializePrediction("SELECT x", [], ["x"]);
  assert.ok(Number.isNaN(predictionSnapshot.dataset.columns[0][0]));

  const training = new DuckDbService({ query: async () => ({ columns: ["x", "target"], rows: [{ x: 1, target: null }] }) });
  await assert.rejects(
    () => training.materializeTraining("SELECT x, target", [], ["x"], "target"),
    (error) => error instanceof RuntimeError && error.code === "NONFINITE_TARGET",
  );
});

test("executes transaction-scoped operations without re-entering the serial queue", async () => {
  const operations: string[] = [];
  const service = new DuckDbService({
    exec: async (sql) => { operations.push(sql); },
    query: async (sql) => { operations.push(sql); return { columns: ["value"], rows: [{ value: 1 }] }; },
  });
  type Transaction = { exec(sql: string, parameters?: readonly unknown[]): Promise<void>; query(sql: string, parameters?: readonly unknown[]): Promise<{ readonly rows: readonly Record<string, unknown>[] }> };
  const run = service.transaction.bind(service) as unknown as <T>(task: (transaction: Transaction) => T | Promise<T>) => Promise<T>;
  const value = await run(async (transaction) => {
    await transaction.exec("INSERT INTO values VALUES (?)", [1]);
    return (await transaction.query("SELECT value FROM values")).rows[0]?.value;
  });
  assert.equal(value, 1);
  assert.deepEqual(operations, ["BEGIN TRANSACTION", "INSERT INTO values VALUES (?)", "SELECT value FROM values", "COMMIT"]);
});

test("rolls back a failed transaction", async () => {
  const operations: string[] = [];
  const service = new DuckDbService({ query: async () => ({ columns: [], rows: [] }), exec: async (sql) => { operations.push(sql); } });
  type Transaction = { exec(sql: string): Promise<void> };
  const run = service.transaction.bind(service) as unknown as <T>(task: (transaction: Transaction) => T | Promise<T>) => Promise<T>;
  await assert.rejects(() => run(async (transaction) => { await transaction.exec("UPDATE values SET value = 2"); throw new Error("stop"); }), /stop/);
  assert.deepEqual(operations, ["BEGIN TRANSACTION", "UPDATE values SET value = 2", "ROLLBACK"]);
});

test("rejects outer service operations from a transaction callback instead of deadlocking", async () => {
  const service = new DuckDbService({ query: async () => ({ columns: [], rows: [] }), exec: async () => undefined });
  type Transaction = { exec(sql: string): Promise<void> };
  const run = service.transaction.bind(service) as unknown as <T>(task: (transaction: Transaction) => T | Promise<T>) => Promise<T>;
  const state = await Promise.race([
    run(async () => { await service.exec("SELECT 1"); }).then(() => "resolved", (error) => error instanceof RuntimeError ? error.code : "other-error"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
  ]);
  assert.equal(state, "INVALID_DATA");
});

test("rejects nested transactions and transaction handles used after commit", async () => {
  const service = new DuckDbService({ query: async () => ({ columns: [], rows: [] }), exec: async () => undefined });
  let leaked: { exec(sql: string): Promise<void> } | undefined;
  const nested = await service.transaction(async (transaction) => {
    leaked = transaction;
    return Promise.race([
      service.transaction(async () => undefined).then(() => "resolved", (error) => error instanceof RuntimeError ? error.code : "other-error"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
  });
  assert.equal(nested, "INVALID_DATA");
  await assert.rejects(() => leaked!.exec("SELECT 1"), (error) => error instanceof RuntimeError && error.code === "INVALID_DATA");
});

test("rejects transactions when the executor cannot execute transaction boundaries", async () => {
  const service = new DuckDbService({ query: async () => ({ columns: [], rows: [] }) });
  await assert.rejects(() => service.transaction(async () => undefined), (error) => error instanceof RuntimeError && error.code === "UNSUPPORTED_CAPABILITY");
});

test("rejects work after the DuckDB service is closed", async () => {
  const service = new DuckDbService({ query: async () => ({ columns: [], rows: [] }), exec: async () => undefined });
  await service.close();
  await assert.rejects(() => service.query("SELECT 1"), (error) => error instanceof RuntimeError && error.code === "ADAPTER_DISPOSED");
  await assert.rejects(() => service.exec("SELECT 1"), (error) => error instanceof RuntimeError && error.code === "ADAPTER_DISPOSED");
  await assert.rejects(() => service.transaction(async () => undefined), (error) => error instanceof RuntimeError && error.code === "ADAPTER_DISPOSED");
});

test("rejects non-transactional service APIs from a transaction callback without deadlocking", async () => {
  const calls: Array<(service: DuckDbService) => Promise<unknown>> = [
    (service) => service.registerSnapshot({} as never),
    (service) => service.registerResults("request", []),
    (service) => service.close(),
  ];
  for (const call of calls) {
    const service = new DuckDbService({ query: async () => ({ columns: [], rows: [] }), exec: async () => undefined });
    const state = await Promise.race([
      service.transaction(async () => call(service)).then(() => "resolved", (error) => error instanceof RuntimeError ? error.code : "other-error"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);
    assert.equal(state, "INVALID_DATA");
    await service.close();
  }
});

test("expires a transaction handle before commit begins", async () => {
  let releaseCommit!: () => void; let commitStarted!: () => void;
  const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
  const commitObserved = new Promise<void>((resolve) => { commitStarted = resolve; });
  const service = new DuckDbService({
    query: async () => ({ columns: [], rows: [] }),
    exec: async (sql) => { if (sql === "COMMIT") { commitStarted(); await commitGate; } },
  });
  let leaked!: { exec(sql: string): Promise<void> };
  const running = service.transaction(async (transaction) => { leaked = transaction; });
  await commitObserved;
  await assert.rejects(() => leaked.exec("AFTER CALLBACK"), (error) => error instanceof RuntimeError && error.code === "INVALID_DATA");
  releaseCommit(); await running;
});

test("rejects new work as soon as close begins", async () => {
  let releaseQuery!: () => void; let queryStarted!: () => void;
  const queryGate = new Promise<void>((resolve) => { releaseQuery = resolve; });
  const queryObserved = new Promise<void>((resolve) => { queryStarted = resolve; });
  const operations: string[] = [];
  const service = new DuckDbService({
    query: async (sql) => { operations.push(`query:${sql}`); queryStarted(); await queryGate; return { columns: [], rows: [] }; },
    close: async () => { operations.push("close"); },
  });
  const first = service.query("q1"); await queryObserved;
  const closing = service.close();
  const second = service.query("q2");
  releaseQuery(); await first; await closing;
  await assert.rejects(() => second, (error) => error instanceof RuntimeError && error.code === "ADAPTER_DISPOSED");
  assert.deepEqual(operations, ["query:q1", "close"]);
});

test("waits for unawaited scoped operations before rolling back a failed callback", async () => {
  let releaseSlow!: () => void; let slowStarted!: () => void;
  const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const slowObserved = new Promise<void>((resolve) => { slowStarted = resolve; });
  const operations: string[] = [];
  const service = new DuckDbService({
    query: async () => ({ columns: [], rows: [] }),
    exec: async (sql) => { operations.push(`${sql}:start`); if (sql === "SLOW") { slowStarted(); await slowGate; } operations.push(`${sql}:end`); },
  });
  const running = service.transaction(async (transaction) => { void transaction.exec("SLOW"); throw new Error("callback failed"); });
  await slowObserved; releaseSlow();
  await assert.rejects(() => running, /callback failed/);
  assert.deepEqual(operations, ["BEGIN TRANSACTION:start", "BEGIN TRANSACTION:end", "SLOW:start", "SLOW:end", "ROLLBACK:start", "ROLLBACK:end"]);
});
