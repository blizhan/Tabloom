import { Scheduler } from "../../src/coordinator/scheduler";
import { InputSnapshotStore } from "../../src/data/input-snapshots";
import { ResultPublicationService, type Reservation } from "../../src/data/result-publication";
import { RuntimeError } from "../../src/model/errors";
import type { PredictionResult } from "../../src/model/types";

export interface ScenarioPublicationReport {
  readonly status: "passed" | "failed";
  readonly evidence: "deterministic-fake";
  readonly latest: string;
  readonly superseded: number;
  readonly baselinePreserved: boolean;
  readonly historyCount: number;
  readonly snapshotRetainedBeforeCleanup: number;
  readonly snapshotsCleaned: boolean;
  readonly deviceLossRejected: boolean;
  readonly unavailable: readonly string[];
  readonly failures: readonly string[];
}

function prediction(reservation: Reservation, snapshot: ReturnType<InputSnapshotStore["get"]>): PredictionResult {
  return {
    mean: new Float32Array(snapshot.rowCount).fill(reservation.generation),
    requestId: reservation.requestId,
    inputSnapshotId: snapshot.inputSnapshotId,
    scenarioId: reservation.scenarioId,
    contextKey: "ctx",
    metadata: { modelId: "tabpfn-3.5", modelVersion: "v", artifactManifestDigest: "a", provider: "wasm", runtimeVersion: "runtime-test", timings: {}, warnings: [] },
  };
}

/**
 * Exercise the full reserve → schedule → publish path with a real snapshot
 * store.  The executor is intentionally controlled: this proves ordering,
 * retention and cleanup without pretending that a fake is a WebGPU/device
 * failure measurement.
 */
export async function scenarioPublicationSmoke(): Promise<ScenarioPublicationReport> {
  const failures: string[] = [];
  const snapshots = new InputSnapshotStore();
  const base = snapshots.create({ columns: [new Float32Array([1, 2, 3])], columnNames: ["x"], rowCount: 3 }, ["dup", "dup", "tail"]);
  const scenarioSnapshot = snapshots.deriveScenario(base.inputSnapshotId, { columns: [new Float32Array([2, 3, 4])], columnNames: ["x"], rowCount: 3 }, "scenario", { x: 1 });
  const publication = new ResultPublicationService({ snapshotRetention: { retain: (id) => { snapshots.retainSnapshot(id); }, release: (id) => { snapshots.releaseSnapshot(id); } } });
  const baseline = await publication.reserve({ requestId: "baseline", streamId: "interactive", generation: 0, epoch: "epoch", inputSnapshotId: base.inputSnapshotId, scenarioId: "baseline" });
  await publication.publish(baseline, prediction(baseline, base), base);

  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const scheduler = new Scheduler();
  const reservations: Reservation[] = [];
  const pending: Array<Promise<Awaited<ReturnType<typeof scheduler.enqueue>>>> = [];
  for (let generation = 1; generation <= 20; generation += 1) {
    const reservation = await publication.reserve({ requestId: `scenario-${generation}`, streamId: "interactive", generation, epoch: "epoch", inputSnapshotId: scenarioSnapshot.inputSnapshotId, scenarioId: `scenario-${generation}` });
    reservations.push(reservation);
    pending.push(scheduler.enqueue({ requestId: reservation.requestId, streamId: reservation.streamId, mode: "interactive", generation, run: async (token) => {
      await gate;
      if (token.cancelled) { await publication.cancel(reservation.requestId, "cancelled"); throw new RuntimeError("CANCELLED", "scenario cancelled"); }
      try { await publication.publish(reservation, prediction(reservation, scenarioSnapshot), scenarioSnapshot); return reservation.scenarioId; }
      catch (error) { if (error instanceof RuntimeError && error.code === "STALE_REQUEST") throw error; throw error; }
    } }));
  }
  releaseGate();
  const outcomes = await Promise.all(pending);
  await scheduler.dispose();
  const latestOutcome = outcomes.at(-1);
  const latest = String(latestOutcome?.value ?? "");
  const superseded = outcomes.filter((outcome) => outcome.status === "superseded").length;
  const latestRun = publication.getRun("scenario-20");
  const baselinePreserved = publication.baselineRun("interactive")?.requestId === baseline.requestId && publication.current("interactive")?.requestId === "scenario-20";
  const historyCount = publication.history("interactive").length;
  const snapshotRetainedBeforeCleanup = snapshots.get(scenarioSnapshot.inputSnapshotId).retained;

  const deviceReservation = await publication.reserve({ requestId: "device-loss", streamId: "interactive", generation: 21, epoch: "epoch", inputSnapshotId: scenarioSnapshot.inputSnapshotId, scenarioId: "device-loss" });
  const deviceScheduler = new Scheduler();
  const deviceOutcome = await deviceScheduler.enqueue({ requestId: deviceReservation.requestId, streamId: deviceReservation.streamId, mode: "interactive", generation: deviceReservation.generation, run: async () => { await publication.cancel(deviceReservation.requestId, "DEVICE_LOST"); throw new RuntimeError("DEVICE_LOST", "injected device loss"); } });
  await deviceScheduler.dispose();
  let deviceLossRejected = false;
  try { await publication.publish(deviceReservation, prediction(deviceReservation, scenarioSnapshot), scenarioSnapshot); }
  catch (error) { deviceLossRejected = deviceOutcome.status === "failed" && error instanceof RuntimeError && error.code === "STALE_REQUEST" && publication.getRun(deviceReservation.requestId)?.status === "cancelled"; }

  for (const reservation of [baseline, ...reservations, deviceReservation]) await publication.delete(reservation.requestId);
  snapshots.releaseSnapshot(scenarioSnapshot.inputSnapshotId);
  // deriveScenario holds a parent reference in addition to the caller's
  // original reference; release both at the end of this isolated probe.
  snapshots.releaseSnapshot(base.inputSnapshotId); snapshots.releaseSnapshot(base.inputSnapshotId);
  const snapshotsCleaned = !snapshots.has(scenarioSnapshot.inputSnapshotId) && !snapshots.has(base.inputSnapshotId);
  if (latest !== "scenario-20") failures.push(`latest scenario was ${latest || "empty"}`);
  if (!latestRun || latestRun.status !== "published") failures.push("latest scenario was not published");
  if (!baselinePreserved) failures.push("baseline or current scenario was not preserved");
  if (superseded !== 18) failures.push(`expected 18 superseded pending requests, received ${superseded}`);
  if (!snapshotsCleaned) failures.push("scenario snapshots remained retained after terminal cleanup");
  if (!deviceLossRejected) failures.push("device-loss cancellation was publishable");
  return { status: failures.length ? "failed" : "passed", evidence: "deterministic-fake", latest, superseded, baselinePreserved, historyCount, snapshotRetainedBeforeCleanup, snapshotsCleaned, deviceLossRejected, unavailable: ["real-device-loss-event"], failures };
}

export async function latestScenarioSmoke(): Promise<string> { const report = await scenarioPublicationSmoke(); return report.latest; }
export async function twentyScenarioSmoke(): Promise<{ latest: string; superseded: number }> { const report = await scenarioPublicationSmoke(); return { latest: report.latest, superseded: report.superseded }; }
