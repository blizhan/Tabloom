import test from "node:test";
import assert from "node:assert/strict";
import { RuntimeClient } from "../../src/coordinator/runtime-client";
import type { TabularModelAdapter } from "../../src/model/types";
import { RuntimeError } from "../../src/model/errors";

test("generates unique default request ids within the same millisecond", async () => {
  let release!: () => void; let fitCount = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const adapter = {
    fitContext: async () => { fitCount += 1; if (fitCount === 1) await gate; return { handleId: `context-${fitCount}` }; },
    dispose: async () => undefined,
  } as unknown as TabularModelAdapter;
  const starts: string[] = [];
  const client = new RuntimeClient({ adapter, onProgress: (event) => { if (event.completed === 0) starts.push(event.requestId); } });
  const originalNow = Date.now;
  try {
    Date.now = () => 1234;
    const first = client.fitContext({} as never, {} as never);
    const second = client.fitContext({} as never, {} as never);
    release();
    const settled = await Promise.allSettled([first, second]);
    assert.ok(settled.every((result) => result.status === "fulfilled"));
    assert.equal(starts.length, 2); assert.notEqual(starts[0], starts[1]);
    assert.ok(starts.every((requestId) => requestId.startsWith("fit-1234-")));
  } finally {
    Date.now = originalNow;
    release();
    await client.dispose();
  }
});

test("releases a context produced after its running fit is cancelled", async () => {
  let releaseFit!: () => void; let fitStarted!: () => void; let releases = 0;
  const fitGate = new Promise<void>((resolve) => { releaseFit = resolve; });
  const fitObserved = new Promise<void>((resolve) => { fitStarted = resolve; });
  const context = { handleId: "cancelled-context" };
  const adapter = {
    fitContext: async () => { fitStarted(); await fitGate; return context; },
    releaseContext: async (released: unknown) => { assert.equal(released, context); releases += 1; },
    dispose: async () => undefined,
  } as unknown as TabularModelAdapter;
  const client = new RuntimeClient({ adapter });
  const running = client.fitContext({} as never, {} as never, "cancel-running-fit");
  await fitObserved; assert.equal(client.cancel("cancel-running-fit"), true); releaseFit();
  await assert.rejects(() => running, (error) => error instanceof RuntimeError && error.code === "CANCELLED");
  assert.equal(releases, 1);
  await client.dispose();
});
