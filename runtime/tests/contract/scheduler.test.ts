import test from "node:test";
import assert from "node:assert/strict";
import { Scheduler } from "../../src/coordinator/scheduler";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
test("interactive scheduler keeps only latest pending request", async () => {
  const scheduler = new Scheduler(); const first = scheduler.enqueue({ requestId: "a", streamId: "s", mode: "interactive", generation: 1, run: async () => { await delay(10); return 1; } }); const second = scheduler.enqueue({ requestId: "b", streamId: "s", mode: "interactive", generation: 2, run: async () => 2 }); const third = scheduler.enqueue({ requestId: "c", streamId: "s", mode: "interactive", generation: 3, run: async () => 3 }); const outcomes = await Promise.all([first, second, third]); assert.equal(outcomes[1].status, "superseded"); assert.equal(outcomes[2].status, "published"); await scheduler.dispose();
});
test("experiments are not merged", async () => { const scheduler = new Scheduler(); const one = scheduler.enqueue({ requestId: "e1", streamId: "x", mode: "experiment", generation: 1, run: async () => 1 }); const two = scheduler.enqueue({ requestId: "e2", streamId: "x", mode: "experiment", generation: 2, run: async () => 2 }); assert.deepEqual((await Promise.all([one, two])).map((item) => item.status), ["published", "published"]); await scheduler.dispose(); });

test("resolves every concurrent idle waiter", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new Scheduler();
  const running = scheduler.enqueue({ requestId: "idle", streamId: "idle", mode: "experiment", generation: 0, run: async () => { await gate; } });
  const first = scheduler.waitForIdle(); const second = scheduler.waitForIdle();
  release(); await running;
  const state = await Promise.race([Promise.all([first, second]).then(() => "idle"), delay(50).then(() => "timeout")]);
  assert.equal(state, "idle");
  await scheduler.dispose();
});

test("dispose does not orphan an existing idle waiter", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new Scheduler();
  const running = scheduler.enqueue({ requestId: "dispose", streamId: "dispose", mode: "experiment", generation: 0, run: async () => { await gate; } });
  const idle = scheduler.waitForIdle(); const disposed = scheduler.dispose();
  release(); await running;
  const state = await Promise.race([Promise.all([idle, disposed]).then(() => "disposed"), delay(50).then(() => "timeout")]);
  assert.equal(state, "disposed");
});

test("cancelling a queued experiment prevents it from running", async () => {
  let release!: () => void; let runs = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const scheduler = new Scheduler();
  const first = scheduler.enqueue({ requestId: "running", streamId: "running", mode: "experiment", generation: 0, run: async () => { await gate; } });
  const queued = scheduler.enqueue({ requestId: "queued", streamId: "queued", mode: "experiment", generation: 0, run: async () => { runs += 1; return new Uint8Array(1024); } });
  assert.equal(scheduler.cancel("queued"), true);
  release();
  assert.equal((await queued).status, "cancelled"); await first; await scheduler.waitForIdle();
  assert.equal(runs, 0);
  await scheduler.dispose();
});

test("bounds completed status history without retaining outcome values", async () => {
  const scheduler = new Scheduler();
  for (let index = 0; index < 1025; index += 1) {
    await scheduler.enqueue({ requestId: `history-${index}`, streamId: "history", mode: "experiment", generation: index, run: async () => new Uint8Array(1024) });
  }
  assert.equal(scheduler.status("history-0"), "unknown");
  assert.equal(scheduler.status("history-1024"), "published");
  const finished = (scheduler as unknown as { finished: Map<string, unknown> }).finished;
  assert.equal(finished.size, 1024);
  assert.ok([...finished.values()].every((value) => typeof value === "string"));
  await scheduler.dispose();
  assert.equal(finished.size, 0);
});
