import test from "node:test";
import assert from "node:assert/strict";
import { decodeSource, encodeCsv, parseCsv } from "../../src/workbench/file-codecs";
import { ExportService } from "../../src/workbench/export-service";

test("workbench codecs distinguish NULL from empty strings and preserve row order", async () => {
  const decoded = await decodeSource(new TextEncoder().encode("id,empty,value\n1,\\N,3.5\n2,\"\",4\n3,hello,5\n"), "csv");
  assert.deepEqual(decoded.columns, ["id", "empty", "value"]);
  assert.equal(decoded.rows[0].empty, null);
  assert.equal(decoded.rows[1].empty, "");
  assert.equal(decoded.rows[2].empty, "hello");
  assert.deepEqual(parseCsv(new TextDecoder().decode(encodeCsv(decoded.columns, decoded.rows))), decoded.rows);
});

test("export metadata identifies the source and refuses non-finite values", async () => {
  const service = new ExportService();
  const common = { columns: ["rowOrdinal", "mean"], schema: [{ name: "rowOrdinal", type: "int64", nullable: false }, { name: "mean", type: "float64", nullable: false }], rows: [{ rowOrdinal: 0, mean: 1.5 }], sourceSnapshotId: "snapshot-v1", format: "csv" as const };
  const exported = await service.export(common);
  assert.equal(exported.metadata.sourceSnapshotId, "snapshot-v1");
  await assert.rejects(service.export({ ...common, rows: [{ rowOrdinal: 0, mean: Number.NaN }] }), { code: "TYPE_LOSS" });
});

test("codec keeps unsafe CSV integers as text instead of silently rounding", async () => {
  const decoded = await decodeSource(new TextEncoder().encode("id\n9007199254740993\n"), "csv");
  assert.equal(decoded.rows[0].id, "9007199254740993");
  await assert.rejects(() => decodeSource(new TextEncoder().encode("id\n9007199254740993\n"), "csv", { types: { id: "number" } }), { code: "TYPE_LOSS" });
});

test("JSON missing properties remain nullable without changing inferred numeric types", async () => {
  const decoded = await decodeSource(new TextEncoder().encode('[{"x":1,"y":2},{"y":3}]'), "json");
  assert.equal(decoded.types.x, "number");
  assert.deepEqual(decoded.rows, [{ x: 1, y: 2 }, { x: null, y: 3 }]);
});

test("parquet decoding is explicit and injected through the data boundary", async () => {
  const decoded = await decodeSource(new Uint8Array([1, 2, 3]), "parquet", { parquetDecoder: async () => [{ id: 1, value: "ok" }] });
  assert.deepEqual(decoded.columns, ["id", "value"]);
  await assert.rejects(() => decodeSource(new Uint8Array([1]), "parquet"), { code: "UNSUPPORTED_CAPABILITY" });
});
