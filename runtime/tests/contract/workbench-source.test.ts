import test from "node:test";
import assert from "node:assert/strict";
import { SourceService } from "../../src/workbench/source-service";
import { createDataSnapshot } from "../../src/workbench/source-snapshots";
import { decodeSource } from "../../src/workbench/file-codecs";

test("source service keeps prior tables when a replacement fails", async () => {
  const service = new SourceService();
  const bytes = new TextEncoder().encode("id,value\na,1\n");
  await service.importSource({ sourceId: "source-a", name: "sample", format: "csv", bytes });
  await assert.rejects(service.importSource({ sourceId: "source-a", name: "sample", format: "csv", bytes: new TextEncoder().encode("id,value\n") , replaceExisting: true }), { code: "EMPTY_INPUT" });
  assert.equal(service.get("sample")?.snapshot.stats?.rowCount, 1);
});

test("source service rejects names that collide under DuckDB identifier semantics", async () => {
  const service = new SourceService();
  const bytes = new TextEncoder().encode("id\n1\n");
  await service.importSource({ sourceId: "source-a", name: "Foo", format: "csv", bytes });
  await assert.rejects(service.importSource({ sourceId: "source-b", name: "foo", format: "csv", bytes }), { code: "NAME_CONFLICT" });
  assert.deepEqual(service.list().map((snapshot) => snapshot.source.name), ["Foo"]);
});

test("source service replaces a case-insensitive collision only when requested", async () => {
  const service = new SourceService();
  const bytes = new TextEncoder().encode("id\n1\n");
  await service.importSource({ sourceId: "source-a", name: "Foo", format: "csv", bytes });
  await service.importSource({ sourceId: "source-b", name: "foo", format: "csv", bytes, replaceExisting: true });
  assert.deepEqual(service.list().map((snapshot) => snapshot.source.name), ["foo"]);
});

test("source service does not commit when cancellation arrives before import commit", async () => {
  const service = new SourceService();
  const controller = new AbortController();
  const importPromise = service.importSource({ sourceId: "source-cancelled", name: "cancelled", format: "csv", bytes: new TextEncoder().encode("id\n1\n"), signal: controller.signal });
  controller.abort();
  await assert.rejects(importPromise, { code: "CANCELLED" });
  assert.equal(service.list().length, 0);
});

test("snapshot identity includes format/type interpretation while retaining raw and logical hashes", async () => {
  const bytes = new TextEncoder().encode("id,value\n1,2\n");
  const decoded = await decodeSource(bytes, "csv");
  const csv = await createDataSnapshot({ sourceId: "source", name: "sample", format: "csv", bytes, decoded, typeInterpretation: { value: "number" } });
  const jsonBytes = new TextEncoder().encode('[{"id":1,"value":2}]');
  const json = await createDataSnapshot({ sourceId: "source", name: "sample", format: "json", bytes: jsonBytes, decoded: await decodeSource(jsonBytes, "json"), typeInterpretation: { value: "number" } });
  assert.notEqual(csv.inputSnapshotId, json.inputSnapshotId);
  assert.equal(csv.logicalContentHash, decoded.logicalDigest);
  assert.equal(csv.source.sha256, await (async () => { const { sha256Hex } = await import("../../src/model/identity"); return sha256Hex(bytes); })());
  assert.equal(csv.complete, true);
  assert.equal(csv.source.typeInterpretation?.value, "number");
});
