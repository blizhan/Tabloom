import test from "node:test";
import assert from "node:assert/strict";
import { ResourceLedger, observeResources } from "../../src/diagnostics/resources";
import { validateBuiltAssetContract } from "../browser/built-assets";

test("resource ledger never turns unknown counters into zero", () => {
  const ledger = new ResourceLedger();
  const initial = observeResources("initial");
  assert.equal(initial.ownedBytes, null);
  ledger.set("ownedBytes", 1024);
  ledger.add("temporaryBytes", 16);
  const running = ledger.observe("running", { capturedAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(running.ownedBytes, 1024);
  assert.equal(running.temporaryBytes, 16);
  assert.equal(running.peaks.ownedBytes, 1024);
  assert.equal(running.peaks.temporaryBytes, 16);
  assert.equal(running.wasmBytes, null);
  assert.match(running.unavailableReasons.wasmBytes, /not exposed/);
  ledger.release("temporaryBytes", 16);
  assert.equal(ledger.snapshot().counters.temporaryBytes, 0);
  assert.equal(ledger.snapshot().peaks.temporaryBytes, 16);
  assert.equal(observeResources("consistent", { ownedBytes: 10, peaks: { ownedBytes: 1 } }).peaks.ownedBytes, 10);
});

test("built asset contract rejects missing evidence and remote inference", () => {
  const report = validateBuiltAssetContract({
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" },
    pageUrl: "https://app.example/",
    crossOriginIsolated: true,
    assets: [{ kind: "worker", url: "https://cdn.example/worker.js", status: 200, contentType: "text/javascript" }, { kind: "wasm", url: "https://app.example/model.wasm", status: 200, contentType: "application/wasm" }],
    inferenceRequests: ["https://remote.example/predict"],
  });
  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((failure) => failure.includes("remote inference")));
  assert.ok(report.failures.some((failure) => failure.includes("same-origin")));
});
