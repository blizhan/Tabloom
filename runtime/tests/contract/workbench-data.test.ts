import test from "node:test";
import assert from "node:assert/strict";
import { DuckDbService } from "../../src/data/duckdb-service";
import { DataClient } from "../../src/workbench/data-client";
import { ReadonlyQueryService, validateReadonlyQuery } from "../../src/workbench/query-service";
import { DataWorkerDispatcher } from "../../src/workers/data.worker-entry";
import { bootstrapWorkbenchData } from "../../src/workbench/bootstrap";
import { DataSnapshotStore } from "../../src/storage/data-snapshot-store";
import { WorkbenchExperimentStore, type WorkbenchExperimentDefinition } from "../../src/storage/workbench-experiment-store";
import { WorkbenchRestoreService } from "../../src/workbench/restore-service";

test("DuckDB service fails closed when no real executor is configured", async () => {
  const service = new DuckDbService();
  await assert.rejects(() => service.query("SELECT 1"), (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_CAPABILITY");
  await assert.rejects(() => service.exec("CREATE TABLE t (x INTEGER)"), (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_CAPABILITY");
});

test("workbench bootstrap requires a real executor and verifies its probe", async () => {
  await assert.rejects(() => bootstrapWorkbenchData(), (error) => error instanceof Error && "code" in error && error.code === "UNSUPPORTED_CAPABILITY");
  const bootstrapped = await bootstrapWorkbenchData({ query: async () => ({ columns: ["ready"], rows: [{ ready: 1 }] }) });
  await bootstrapped.db.close();
});

test("read-only query validation accepts relation queries and rejects side effects", () => {
  validateReadonlyQuery("WITH values AS (SELECT 1 AS x) SELECT x FROM values;");
  assert.throws(() => validateReadonlyQuery("SELECT 1; DELETE FROM values"), /read-only SQL statement/);
  assert.throws(() => validateReadonlyQuery("SELECT * FROM read_parquet('x.parquet')"), /forbidden/);
  assert.throws(() => validateReadonlyQuery("UPDATE values SET x = 2"), /read-only relation/);
  validateReadonlyQuery("SELECT 'DROP TABLE values' AS note");
});

test("read-only query validation rejects external relation shorthand and quoted table functions", () => {
  assert.throws(() => validateReadonlyQuery("SELECT * FROM \"read_csv_auto\"('https://example.com/data.csv')"), /forbidden/);
  assert.throws(() => validateReadonlyQuery("SELECT * FROM 'https://example.com/data.csv'"), /forbidden/);
  validateReadonlyQuery("SELECT 'read_csv_auto(https://example.com/data.csv)' AS note");
});

test("data worker dispatcher routes requests and returns typed cancellation", async () => {
  const dispatcher = new DataWorkerDispatcher({ executeQuery: async (query) => ({ columns: ["x"], rows: [{ x: query.sql }] }) }, "test-epoch");
  const reply = await dispatcher.dispatch({ protocolVersion: 1, requestId: "q1", operation: "executeQuery", payload: { sql: "SELECT 1", sourceSnapshotId: "s", revision: 1 } });
  assert.equal(reply.kind, "success");
  assert.deepEqual((reply as { result: unknown }).result, { columns: ["x"], rows: [{ x: "SELECT 1" }] });
  const cancelled = await dispatcher.dispatch({ protocolVersion: 1, requestId: "cancel-1", operation: "cancel", payload: { requestId: "q1" } });
  assert.equal(cancelled.kind, "cancelled");
});

test("data client resolves worker replies and propagates worker failures", async () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const dispatcher = new DataWorkerDispatcher({ executeQuery: async () => ({ columns: ["x"], rows: [{ x: 1 }] }) });
  const port = {
    postMessage(message: unknown) { void dispatcher.dispatch(message).then((reply) => { for (const listener of listeners) listener({ data: reply } as MessageEvent); }); },
    addEventListener(_type: "message", listener: (event: MessageEvent) => void) { listeners.add(listener); },
    removeEventListener(_type: "message", listener: (event: MessageEvent) => void) { listeners.delete(listener); },
  };
  const client = new DataClient(port, { requestId: (() => { let n = 0; return () => `client-${++n}`; })() });
  const result = await client.request<{ readonly rows: readonly unknown[] }>("executeQuery", { sql: "SELECT 1", sourceSnapshotId: "s", revision: 1 });
  assert.equal(result.rows.length, 1);
  await client.dispose();
});

test("readonly query service preserves result rows and capped preview", async () => {
  const service = new DuckDbService({ query: async () => ({ columns: ["x"], rows: [{ x: 1 }, { x: 2 }, { x: 3 }] }) });
  const query = new ReadonlyQueryService(service, 2);
  const result = await query.execute({ sql: "SELECT x FROM values", sourceSnapshotId: "source", revision: 3 });
  assert.equal(result.rowCount, 3);
  assert.equal(result.previewRows.length, 2);
  assert.deepEqual(result.rowOrdinal, [0, 1, 2]);
});

test("experiment definitions round-trip Dataset metadata without sharing mutable arrays", async () => {
  const store = new WorkbenchExperimentStore({ allowMemoryFallback: true });
  const definition = {
    experimentId: "experiment-dataset",
    revision: 1,
    name: "demand_mwh",
    trainingQuery: "SELECT * FROM dataset WHERE split = 'train'",
    predictionQuery: "SELECT * FROM dataset WHERE split = 'test'",
    targetName: "demand_mwh",
    featureNames: ["temperature_c"],
    modelId: "tabpfn-3.5",
    provider: "wasm" as const,
    precision: "fp32" as const,
    inputSnapshotId: "dataset-snapshot",
    sourceBindings: [{ name: "weather", snapshotId: "source-snapshot" }],
    dataset: { version: 1 as const, query: "SELECT * FROM weather", snapshotId: "dataset-snapshot", splitPreset: { mode: "ratio" as const, orderBy: "timestamp_utc" } },
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
  await store.save(definition);
  const restored = await store.get(definition.experimentId, 1);
  assert.deepEqual(restored?.dataset, definition.dataset);
  assert.notEqual(restored?.featureNames, definition.featureNames);
  assert.notEqual(restored?.sourceBindings, definition.sourceBindings);
  const mutable = restored as unknown as { dataset: { splitPreset: { orderBy?: string } }; sourceBindings: Array<{ name: string }> };
  mutable.dataset.splitPreset.orderBy = "changed";
  mutable.sourceBindings[0].name = "changed";
  const reread = await store.get(definition.experimentId, 1);
  assert.equal(reread?.dataset?.splitPreset && "orderBy" in reread.dataset.splitPreset ? reread.dataset.splitPreset.orderBy : undefined, "timestamp_utc");
  assert.equal(reread?.sourceBindings?.[0]?.name, "weather");

  const legacy = { ...definition, experimentId: "experiment-legacy", inputSnapshotId: "legacy-source", dataset: undefined };
  await store.save(legacy);
  assert.equal((await store.get(legacy.experimentId, legacy.revision))?.dataset, undefined);
});

test("restore validates Dataset and every bound source before returning a usable experiment", async () => {
  const snapshots = new DataSnapshotStore({ allowMemoryFallback: true });
  const experiments = new WorkbenchExperimentStore({ allowMemoryFallback: true });
  const restore = new WorkbenchRestoreService(snapshots, experiments);
  const datasetBytes = new TextEncoder().encode('[{"value":1}]\n');
  await snapshots.save({ snapshotId: "dataset-ready", sourceId: "dataset", sourceName: "__dataset__", format: "json", typeInterpretation: { value: "number" }, rowCount: 1, columns: ["value"], bytes: datasetBytes });
  const definition: WorkbenchExperimentDefinition = {
    experimentId: "experiment-bound-source",
    revision: 1,
    name: "value",
    trainingQuery: "SELECT * FROM dataset",
    predictionQuery: "SELECT * FROM dataset",
    targetName: "value",
    featureNames: [],
    modelId: "tabpfn-3.5",
    provider: "wasm",
    precision: "fp32",
    inputSnapshotId: "dataset-ready",
    sourceBindings: [{ name: "weather", snapshotId: "source-missing" }],
    dataset: { version: 1, query: "SELECT * FROM weather", snapshotId: "dataset-ready", splitPreset: { mode: "ratio" } },
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
  await experiments.save(definition);

  const restored = await restore.restore(definition.experimentId, definition.revision);

  assert.equal(restored.status, "needs-data");
  assert.match(restored.message ?? "", /weather|source-missing/);
});

test("experiment save snapshots nested Dataset metadata before retaining it", async () => {
  const store = new WorkbenchExperimentStore({ allowMemoryFallback: true });
  const definition = {
    experimentId: "experiment-input-clone",
    revision: 1,
    name: "value",
    trainingQuery: "SELECT * FROM dataset",
    predictionQuery: "SELECT * FROM dataset",
    targetName: "value",
    featureNames: ["feature"],
    modelId: "tabpfn-3.5",
    provider: "wasm" as const,
    precision: "fp32" as const,
    inputSnapshotId: "dataset-snapshot",
    sourceBindings: [{ name: "weather", snapshotId: "source-snapshot" }],
    dataset: { version: 1 as const, query: "SELECT * FROM weather", snapshotId: "dataset-snapshot", splitPreset: { mode: "ratio" as const, orderBy: "timestamp_utc" } },
    createdAt: "2026-09-21T00:00:00.000Z",
    updatedAt: "2026-09-21T00:00:00.000Z",
  };
  await store.save(definition);
  definition.sourceBindings[0].name = "changed-source";
  definition.dataset.splitPreset.orderBy = "changed-column";

  const restored = await store.get(definition.experimentId, definition.revision);

  assert.equal(restored?.sourceBindings?.[0]?.name, "weather");
  assert.equal(restored?.dataset?.splitPreset && "orderBy" in restored.dataset.splitPreset ? restored.dataset.splitPreset.orderBy : undefined, "timestamp_utc");
});
