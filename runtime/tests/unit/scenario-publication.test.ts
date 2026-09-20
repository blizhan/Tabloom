import test from "node:test";
import assert from "node:assert/strict";
import { scenarioPublicationSmoke } from "../browser/scenario-publication";

test("scenario publication keeps the baseline, latest generation, and snapshot cleanup invariant", async () => {
  const report = await scenarioPublicationSmoke();
  assert.equal(report.status, "passed", report.failures.join("; "));
  assert.equal(report.latest, "scenario-20");
  assert.equal(report.superseded, 18);
  assert.equal(report.baselinePreserved, true);
  assert.equal(report.historyCount, 21);
  assert.equal(report.snapshotsCleaned, true);
  assert.equal(report.deviceLossRejected, true);
  assert.ok(report.unavailable.includes("real-device-loss-event"));
});
