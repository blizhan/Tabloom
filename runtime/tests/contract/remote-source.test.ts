import test from "node:test";
import assert from "node:assert/strict";
import { fetchRemoteSource } from "../../src/workbench/remote-source";

test("remote source accepts exactly the configured byte budget and rejects one byte over", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-type": "application/octet-stream" } });
    const result = await fetchRemoteSource("https://example.test/source", { remoteImportMaxBytes: 4, remoteImportTimeoutMs: 1000 });
    assert.equal(result.bytes.byteLength, 4);
    await assert.rejects(fetchRemoteSource("https://example.test/source", { remoteImportMaxBytes: 3, remoteImportTimeoutMs: 1000 }), { code: "SOURCE_TOO_LARGE" });
  } finally { globalThis.fetch = original; }
});

test("remote source maps caller cancellation separately from timeout", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (_input, init) => await new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); });
    const controller = new AbortController(); const promise = fetchRemoteSource("https://example.test/source", { signal: controller.signal, remoteImportTimeoutMs: 1000 }); controller.abort();
    await assert.rejects(promise, { code: "CANCELLED" });
  } finally { globalThis.fetch = original; }
});
