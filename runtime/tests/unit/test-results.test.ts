import test from "node:test";
import assert from "node:assert/strict";
import { enrichTestRows } from "../../src/workbench/test-results";

test("appends prediction columns without overwriting Test source columns", () => {
  const result = enrichTestRows(
    { columns: ["timestamp", "mean", "q25", "q75"], rows: [{ timestamp: "t1", mean: 99, q25: 98, q75: 100 }] },
    { mean: [10], q25: [8], q75: [12] },
  );
  assert.deepEqual(result.outputColumns, { mean: "prediction_mean", q25: "prediction_q25", q75: "prediction_q75" });
  assert.equal(result.table.rows[0].mean, 99);
  assert.equal(result.table.rows[0].prediction_mean, 10);
  assert.equal(result.table.rows[0].prediction_q25, 8);
  assert.equal(result.table.rows[0].prediction_q75, 12);
});

test("rejects mismatched, non-finite, or unordered prediction intervals", () => {
  const testRows = { columns: ["x"], rows: [{ x: 1 }] };
  assert.throws(() => enrichTestRows(testRows, { mean: [], q25: [], q75: [] }), { code: "RESULT_INVALID" });
  assert.throws(() => enrichTestRows(testRows, { mean: [Number.NaN], q25: [0], q75: [1] }), { code: "RESULT_INVALID" });
  assert.throws(() => enrichTestRows(testRows, { mean: [1], q25: [3], q75: [2] }), { code: "RESULT_INVALID" });
});
