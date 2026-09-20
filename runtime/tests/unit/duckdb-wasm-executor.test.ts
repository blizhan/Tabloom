import test from "node:test";
import assert from "node:assert/strict";
import { prepareParameters } from "../../src/data/duckdb-wasm-executor";
import { RuntimeError } from "../../src/model/errors";

test("rewrites placeholders only outside DuckDB strings and nested comments", () => {
  const sql = "SELECT E'a\\' ? b', /* outer ? /* inner ? */ still ? */ $$?$$, ?";
  const prepared = prepareParameters(sql, [{ type: "float64", value: "1.5" }]);
  assert.equal(prepared.sql, "SELECT E'a\\' ? b', /* outer ? /* inner ? */ still ? */ $$?$$, CAST(? AS DOUBLE)");
  assert.deepEqual(prepared.values, ["1.5"]);
});

test("rejects extra parameters even when they are NULL", () => {
  assert.throws(
    () => prepareParameters("SELECT ?", [{ type: "string", value: "ok" }, { type: "null", value: null }]),
    (error) => error instanceof RuntimeError && error.code === "INVALID_DATA",
  );
});
