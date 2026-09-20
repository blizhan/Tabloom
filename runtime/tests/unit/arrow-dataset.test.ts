import test from "node:test";
import assert from "node:assert/strict";
import { materializeDataset } from "../../src/data/arrow-dataset";
import { RuntimeError } from "../../src/model/errors";
import { vectorFromArray } from "apache-arrow";

test("materializes sliced/chunked nullable columns without dropping rows", () => {
  const result = materializeDataset({ rowCount: 3, columns: [{ name: "x", values: new Float64Array([99, 1, 2, 3]), offset: 1, length: 3, validity: [0, 1, 0, 1] }, { name: "y", chunks: [new Int32Array([4]), new Int32Array([5, 6])], type: "integer" }] });
  assert.deepEqual([...result.columns[0]], [1, Number.NaN, 3]); assert.deepEqual([...result.columns[1]], [4, 5, 6]);
});
test("uses an explicit slice length as the inferred row count", () => {
  const result = materializeDataset({ columns: [{ name: "x", values: [0, 1, 2, 3], offset: 1, length: 2 }] });
  assert.equal(result.rowCount, 2); assert.deepEqual([...result.columns[0]], [1, 2]);
});
test("derives chunked slice length from the backing source and offset", () => {
  const result = materializeDataset({ columns: [{ name: "x", chunks: [[0, 1], [2, 3]], offset: 1 }] });
  assert.equal(result.rowCount, 3); assert.deepEqual([...result.columns[0]], [1, 2, 3]);
});
test("reads null validity from Arrow-like chunks", () => {
  const vector = vectorFromArray([1, null, 3]);
  const result = materializeDataset({ columns: [{ name: "x", chunks: [vector as never] }] });
  assert.deepEqual([...result.columns[0]], [1, Number.NaN, 3]);
});
test("rejects unsafe integer and float overflow", () => {
  assert.throws(() => materializeDataset({ columns: [{ name: "x", values: [Number.MAX_SAFE_INTEGER + 1], type: "int64" }] }), (error) => error instanceof RuntimeError && error.code === "NUMERIC_OVERFLOW");
  assert.throws(() => materializeDataset({ columns: [{ name: "x", values: [Number.MAX_VALUE] }] }), (error) => error instanceof RuntimeError && error.code === "NUMERIC_OVERFLOW");
});
test("requires finite target and ordered schema", () => {
  assert.throws(() => materializeDataset({ columns: [{ name: "x", values: [1] }], targetName: "target", target: { name: "target", values: [Infinity] } }), (error) => error instanceof RuntimeError && error.code === "NONFINITE_TARGET");
  assert.throws(() => materializeDataset({ columns: [{ name: "b", values: [1] }, { name: "a", values: [2] }], expectedColumnNames: ["a", "b"] }), (error) => error instanceof RuntimeError && error.code === "SCHEMA_MISMATCH");
});
