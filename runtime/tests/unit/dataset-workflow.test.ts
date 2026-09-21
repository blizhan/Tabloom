import test from "node:test";
import assert from "node:assert/strict";
import { DuckDbService } from "../../src/data/duckdb-service";
import { DATASET_ROW_ID, createSplitSql, inspectOverlap, materializeWorkbenchDataset, quoteColumn, validateSourceName } from "../../src/workbench/dataset-workflow";

test("validates source names and quotes arbitrary SQL column names", () => {
  assert.throws(() => validateSourceName("dataset"));
  assert.throws(() => validateSourceName("__tabloom_import"));
  assert.throws(() => validateSourceName('x"; DROP TABLE x'));
  assert.equal(quoteColumn('a" b'), '"a"" b"');
  assert.doesNotThrow(() => validateSourceName("weather_2025"));
});

test("materializes a complete dataset with a stable row id", async () => {
  const registered: string[] = [];
  const service = new DuckDbService({
    query: async (sql) => {
      assert.equal(sql, "SELECT city, demand FROM weather ORDER BY city");
      return { columns: ["city", "demand"], rows: [{ city: "A", demand: 2 }, { city: "B", demand: 3 }] };
    },
    registerArrow: async (_table, name) => { registered.push(name); },
    exec: async () => undefined,
  });

  const result = await materializeWorkbenchDataset(service, "SELECT city, demand FROM weather ORDER BY city");
  assert.deepEqual(result.columns, [DATASET_ROW_ID, "city", "demand"]);
  assert.deepEqual(result.rows, [
    { [DATASET_ROW_ID]: 1, city: "A", demand: 2 },
    { [DATASET_ROW_ID]: 2, city: "B", demand: 3 },
  ]);
  assert.equal(registered.length, 1);
});

test("rejects an empty or duplicate-column dataset before replacing the table", async () => {
  const service = new DuckDbService({
    query: async (sql) => sql.includes("empty")
      ? { columns: ["x"], rows: [] }
      : { columns: ["x", "x"], rows: [{ x: 1 }] },
  });
  await assert.rejects(() => materializeWorkbenchDataset(service, "SELECT * FROM empty"), { code: "EMPTY_INPUT" });
  await assert.rejects(() => materializeWorkbenchDataset(service, "SELECT x, x FROM duplicate"), { code: "SCHEMA_MISMATCH" });
});

test("creates deterministic 80/20 SQL and verifies overlap by Dataset row id", () => {
  const split = createSplitSql({ mode: "ratio", orderBy: "timestamp" });
  assert.match(split.trainingSql, /floor\(__tabloom_count \* 0\.8\)/);
  assert.match(split.trainingSql, /"timestamp" ASC NULLS LAST/);
  assert.match(split.trainingSql, /"__tabloom_row_id" ASC/);
  assert.match(split.testSql, /> floor\(__tabloom_count \* 0\.8\)/);
  const train = { columns: [DATASET_ROW_ID], rows: [{ [DATASET_ROW_ID]: 1 }, { [DATASET_ROW_ID]: 2 }] };
  const testRows = { columns: [DATASET_ROW_ID], rows: [{ [DATASET_ROW_ID]: 2 }, { [DATASET_ROW_ID]: 3 }] };
  assert.deepEqual(inspectOverlap(train, testRows), { verifiable: true, overlapCount: 1 });
  assert.equal(inspectOverlap({ columns: ["value"], rows: [{ value: 1 }] }, testRows).verifiable, false);
});

test("creates a strict time boundary with escaped cutoff", () => {
  const split = createSplitSql({ mode: "time", column: "event time", cutoff: "2025-01-02T00:00:00Z" });
  assert.match(split.trainingSql, /CAST\("event time" AS TIMESTAMPTZ\) < CAST\('2025-01-02T00:00:00Z' AS TIMESTAMPTZ\)/);
  assert.match(split.testSql, /CAST\("event time" AS TIMESTAMPTZ\) >= CAST\('2025-01-02T00:00:00Z' AS TIMESTAMPTZ\)/);
  assert.throws(() => createSplitSql({ mode: "time", column: "time", cutoff: "not-a-date" }), { code: "INVALID_DATA" });
});
