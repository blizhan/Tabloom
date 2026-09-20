import test from "node:test";
import assert from "node:assert/strict";
import { ReplyTracker, assertEnvelope } from "../../src/workers/protocol";
import { RuntimeError } from "../../src/model/errors";
import { ModelWorkerDispatcher } from "../../src/workers/model.worker";
import type { TabularModelAdapter } from "../../src/model/types";
test("worker protocol accepts one terminal reply only", () => { const tracker = new ReplyTracker(); const reply = { kind: "success" as const, protocolVersion: 1 as const, workerEpoch: "e", requestId: "r", result: 1 }; tracker.accept(reply); assert.throws(() => tracker.accept(reply), (error) => error instanceof RuntimeError && error.code === "RESULT_INVALID"); });
test("unknown protocol envelope is rejected", () => { assert.throws(() => assertEnvelope({ protocolVersion: 2 }), (error) => error instanceof RuntimeError && error.code === "INVALID_DATA"); });
test("model worker status returns primitive adapter diagnostics", async () => {
  const adapter = {
    diagnostics: () => ({ ort: { wasmProxy: false, builderActive: false }, artifacts: { networkFetches: 3 } }),
  } as unknown as TabularModelAdapter & { diagnostics: () => Readonly<Record<string, unknown>> };
  const dispatcher = new ModelWorkerDispatcher(adapter, "epoch-test");
  const reply = await dispatcher.dispatch({ protocolVersion: 1, workerEpoch: "epoch-test", requestId: "status", operation: "status", payload: undefined });
  assert.equal(reply.kind, "success");
  if (reply.kind === "success") assert.deepEqual(reply.result, { running: [], cancelled: [], disposed: false, diagnostics: { ort: { wasmProxy: false, builderActive: false }, artifacts: { networkFetches: 3 } } });
});
