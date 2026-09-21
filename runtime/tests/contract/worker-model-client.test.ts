import test from "node:test";
import assert from "node:assert/strict";
import { WorkerModelClient } from "../../src/coordinator/worker-model-client";
import { PROTOCOL_VERSION } from "../../src/workers/protocol";
import type { ModelAssetEvent } from "../../src/workbench/model-asset-status";

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage(message: any): void { queueMicrotask(() => { if (message.operation === "dispose") this.onmessage?.({ data: { kind: "success", protocolVersion: PROTOCOL_VERSION, workerEpoch: "epoch", requestId: message.requestId, result: undefined } } as MessageEvent); else if (message.operation === "capabilities") this.onmessage?.({ data: { kind: "success", protocolVersion: PROTOCOL_VERSION, workerEpoch: "epoch", requestId: message.requestId, result: { taskTypes: ["regression"], canBuildContext: true, canImportContext: true, supportsMissingFeatures: true, supportsPassthroughInf: false, maxModelFeatures: 32, trainRows: { min: 3, max: 1024 }, predictionRows: { min: 1, max: 1024 } } } } as MessageEvent); else this.onmessage?.({ data: { kind: "success", protocolVersion: PROTOCOL_VERSION, workerEpoch: "epoch", requestId: message.requestId, result: message.payload } } as MessageEvent); }); }
  terminate(): void {}
  emit(message: ModelAssetEvent): void { this.onmessage?.({ data: message } as MessageEvent); }
}

test("worker model client binds replies to the ready epoch and disposes", async () => {
  const worker = new FakeWorker(); const client = new WorkerModelClient({ worker, workerEpoch: "epoch" });
  await client.load();
  assert.equal(client.capabilities().taskTypes[0], "regression");
  await client.dispose();
  await assert.rejects(client.load(), { code: "ADAPTER_DISPOSED" });
});

test("forwards model asset events before the worker ready handshake", () => {
  const worker = new FakeWorker(); const events: ModelAssetEvent[] = [];
  const client = new WorkerModelClient({ worker, workerEpoch: "epoch", onAssetEvent: (event) => events.push(event) });
  worker.emit({ kind: "model-assets", precision: "fp32", state: "downloading", file: "context.onnx" });
  assert.deepEqual(events, [{ kind: "model-assets", precision: "fp32", state: "downloading", file: "context.onnx" }]);
  void client.dispose();
});
