import test from "node:test";
import assert from "node:assert/strict";
import { createTabPFN35Adapter } from "../../src/model/tabpfn35/worker-factory";

test("TabPFN worker factory deduplicates concurrent artifact fetches", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  }) as typeof fetch;
  try {
    await Promise.all([
      createTabPFN35Adapter({ precision: "fp32", baseUrl: "http://127.0.0.1:4175" }),
      createTabPFN35Adapter({ precision: "fp32", baseUrl: "http://127.0.0.1:4175" }),
    ]);
    assert.equal(calls, 3, "context graph, predictor graph and shared data should each be fetched once");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
