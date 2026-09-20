import test from "node:test";
import assert from "node:assert/strict";
import { runDeterministicLifecycleChecks } from "../browser/lifecycle";

test("lifecycle diagnostics preserve current bytes, high-water marks, and injected-event scope", () => {
  const report = runDeterministicLifecycleChecks({ cycles: 20, provider: "webgpu" });
  assert.equal(report.status, "passed", report.failures.join("; "));
  assert.equal(report.observations.length, 60);
  assert.equal(report.checks.resourcePeaks.status, "passed");
  assert.equal(report.checks.deviceLoss.status, "passed");
  assert.equal(report.checks.foreignHandle.status, "passed");
  assert.deepEqual(report.injected, { deviceLoss: true, failedInitialization: true, disposeDuringRun: true });
  assert.ok(report.unavailable.includes("real-device-loss-event"));
  const disposed = report.observations.find((observation) => observation.stage === "cycle-1:disposed");
  assert.equal(disposed?.ownedBytes, 0);
  assert.equal(disposed?.temporaryBytes, 0);
  assert.equal(disposed?.peaks.ownedBytes, 4608);
});
