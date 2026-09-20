import { ResourceLedger, observeResources, type ResourceObservation } from "../../src/diagnostics/resources";
import { PROTOCOL_VERSION, type WorkerReply } from "../../src/workers/protocol";

/**
 * These are deterministic coordination checks. They intentionally do not
 * claim that a WebGPU device, driver, or real GPU allocation was observed.
 * The browser runner must add real-device evidence separately.
 */
export type LifecycleProvider = "wasm" | "webgpu";
export type LifecycleCheckStatus = "passed" | "failed";
export interface LifecycleCheckResult { readonly status: LifecycleCheckStatus; readonly details?: string; }
export interface LifecycleChecks {
  readonly twentyCycles: LifecycleCheckResult;
  readonly stagedVsDualSession: LifecycleCheckResult;
  readonly resourcePeaks: LifecycleCheckResult;
  readonly modelSwitch: LifecycleCheckResult;
  readonly failedInitialization: LifecycleCheckResult;
  readonly exportReleasePins: LifecycleCheckResult;
  readonly disposeDuringRun: LifecycleCheckResult;
  readonly deviceLoss: LifecycleCheckResult;
  readonly guardedPublication: LifecycleCheckResult;
  readonly foreignHandle: LifecycleCheckResult;
}
export interface LifecycleReport {
  readonly suite: "lifecycle";
  readonly status: LifecycleCheckStatus;
  readonly evidence: "deterministic-fake";
  readonly requestedProvider: LifecycleProvider;
  readonly cycles: number;
  readonly observations: readonly ResourceObservation[];
  readonly checks: LifecycleChecks;
  /** Always present: fake checks do not measure hardware. */
  readonly unavailable: readonly string[];
  /** These are controlled coordination injections, not observations of a
   * browser/driver event.  Keeping them explicit prevents device-loss tests
   * from being reported as hardware evidence. */
  readonly injected: Readonly<{ deviceLoss: boolean; failedInitialization: boolean; disposeDuringRun: boolean }>;
  readonly failures: readonly string[];
}

interface FakeHandle { readonly id: string; readonly epoch: string; released: boolean; pins: number; }
interface FakeRun { readonly requestId: string; readonly generation: number; cancelled: boolean; failedCode?: "DEVICE_LOST" | "ADAPTER_DISPOSED"; published: boolean; }

/** A tiny model-worker stand-in used only for deterministic lifecycle checks. */
class FakeLifecycleRuntime {
  state: "new" | "loading" | "ready" | "failed" | "disposing" | "disposed" = "new";
  private handleNumber = 0;
  private runNumber = 0;
  private readonly handles = new Map<string, FakeHandle>();
  private readonly runs = new Map<string, FakeRun>();
  private readonly ledger = new ResourceLedger();
  constructor(readonly epoch: string) {}

  load(): void {
    if (this.state === "disposed" || this.state === "disposing") throw new Error("ADAPTER_DISPOSED");
    this.state = "loading";
    this.ledger.set("ownedBytes", 4096);
    this.ledger.set("hostCopyBytes", 0);
    this.ledger.set("readbackBytes", 0);
    this.ledger.set("digestBytes", 64);
    this.ledger.set("cacheBytes", 2048);
    this.state = "ready";
  }
  failInitialization(): void {
    this.state = "loading";
    this.ledger.set("ownedBytes", 2048);
    this.ledger.set("hostCopyBytes", 512);
    this.ledger.set("digestBytes", 64);
    this.ledger.set("cacheBytes", 1024);
    this.ledger.set("temporaryBytes", 1024);
    this.ledger.set("ownedBytes", 0);
    this.ledger.set("hostCopyBytes", 0);
    this.ledger.set("digestBytes", 0);
    this.ledger.set("cacheBytes", 0);
    this.ledger.set("temporaryBytes", 0);
    this.state = "failed";
  }
  createHandle(): FakeHandle {
    if (this.state !== "ready") throw new Error("PROVIDER_UNAVAILABLE");
    const handle: FakeHandle = { id: `handle-${++this.handleNumber}`, epoch: this.epoch, released: false, pins: 0 };
    this.handles.set(handle.id, handle);
    this.ledger.add("ownedBytes", 512);
    this.ledger.add("hostCopyBytes", 256);
    return handle;
  }
  pin(handle: FakeHandle): void { this.assertHandle(handle); if (handle.released) throw new Error("CONTEXT_RELEASED"); handle.pins += 1; }
  unpin(handle: FakeHandle): void { this.assertHandle(handle); if (handle.pins < 1) throw new Error("INVALID_DATA"); handle.pins -= 1; this.freeHandleIfUnpinned(handle); }
  release(handle: FakeHandle): void { this.assertHandle(handle); if (handle.released) return; handle.released = true; this.freeHandleIfUnpinned(handle); }
  startRun(generation: number): FakeRun {
    if (this.state !== "ready") throw new Error("ADAPTER_DISPOSED");
    const run: FakeRun = { requestId: `run-${++this.runNumber}`, generation, cancelled: false, published: false };
    this.runs.set(run.requestId, run);
    this.ledger.add("temporaryBytes", 128);
    this.ledger.add("readbackBytes", 64);
    return run;
  }
  cancel(run: FakeRun): void { run.cancelled = true; }
  loseDevice(): void { for (const run of this.runs.values()) if (!run.published) run.failedCode = "DEVICE_LOST"; this.state = "failed"; }
  publish(run: FakeRun, currentGeneration: number): boolean {
    if (run.cancelled || run.failedCode || this.state !== "ready" || run.generation !== currentGeneration) { this.finishRun(run); return false; }
    run.published = true; this.finishRun(run); return true;
  }
  dispose(): void {
    if (this.state === "disposed") return;
    this.state = "disposing";
    for (const run of this.runs.values()) { if (!run.published) { run.cancelled = true; run.failedCode = "ADAPTER_DISPOSED"; } this.finishRun(run); }
    for (const handle of this.handles.values()) { handle.released = true; handle.pins = 0; this.freeHandleIfUnpinned(handle); }
    this.ledger.set("ownedBytes", 0); this.ledger.set("hostCopyBytes", 0); this.ledger.set("readbackBytes", 0); this.ledger.set("digestBytes", 0); this.ledger.set("cacheBytes", 0); this.ledger.set("temporaryBytes", 0); this.state = "disposed";
  }
  observe(stage: string, capturedAt: string): ResourceObservation { return this.ledger.observe(stage, { capturedAt }); }
  acceptsForeignHandle(handle: FakeHandle): boolean { try { this.assertHandle(handle); return true; } catch { return false; } }
  private assertHandle(handle: FakeHandle): void { if (handle.epoch !== this.epoch || this.handles.get(handle.id) !== handle) throw new Error("FOREIGN_CONTEXT"); }
  private freeHandleIfUnpinned(handle: FakeHandle): void { if (handle.released && handle.pins === 0 && this.handles.delete(handle.id)) { this.ledger.release("ownedBytes", 512); this.ledger.release("hostCopyBytes", 256); } }
  private finishRun(run: FakeRun): void { if (this.runs.delete(run.requestId)) { this.ledger.release("temporaryBytes", 128); this.ledger.release("readbackBytes", 64); } }
}

function check(status: boolean, details: string): LifecycleCheckResult { return status ? { status: "passed" } : { status: "failed", details }; }

function checkTwentyCycles(cycles: number): { result: LifecycleCheckResult; observations: ResourceObservation[] } {
  const observations: ResourceObservation[] = [];
  let passed = Number.isSafeInteger(cycles) && cycles > 0;
  for (let index = 0; index < cycles; index += 1) {
    const runtime = new FakeLifecycleRuntime(`cycle-${index + 1}`); runtime.load(); const handle = runtime.createHandle(); const run = runtime.startRun(1);
    observations.push(runtime.observe(`cycle-${index + 1}:prepared`, `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`));
    observations.push(runtime.observe(`cycle-${index + 1}:running`, `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`));
    passed = passed && runtime.publish(run, 1); runtime.release(handle); runtime.dispose();
    const finalObservation = runtime.observe(`cycle-${index + 1}:disposed`, `2026-01-01T00:01:${String(index).padStart(2, "0")}Z`); observations.push(finalObservation);
    passed = passed && runtime.state === "disposed" && finalObservation.ownedBytes === 0 && finalObservation.temporaryBytes === 0 && (finalObservation.peaks.ownedBytes ?? 0) >= 4608 && (finalObservation.peaks.temporaryBytes ?? 0) >= 128;
  }
  return { result: check(passed, "one or more deterministic lifecycle cycles leaked state"), observations };
}

function checkStagedVsDualSession(): LifecycleCheckResult {
  const staged = new FakeLifecycleRuntime("staged"); staged.load(); const stagedHandle = staged.createHandle(); const stagedRun = staged.startRun(1); const stagedDuringRun = staged.observe("staged", "2026-01-01T00:00:00.000Z"); staged.publish(stagedRun, 1); staged.release(stagedHandle); staged.dispose();
  const dual = new FakeLifecycleRuntime("dual"); dual.load(); const dualHandle = dual.createHandle(); const dualRun = dual.startRun(1); const dualDuringRun = dual.observe("dual", "2026-01-01T00:00:01.000Z"); dual.publish(dualRun, 1); dual.release(dualHandle); dual.dispose();
  return check(stagedDuringRun.ownedBytes === dualDuringRun.ownedBytes && stagedDuringRun.temporaryBytes === dualDuringRun.temporaryBytes && stagedDuringRun.peaks.ownedBytes === dualDuringRun.peaks.ownedBytes && stagedDuringRun.peaks.temporaryBytes === dualDuringRun.peaks.temporaryBytes, "staged and dual-session owned counters diverged");
}
function checkResourcePeaks(): LifecycleCheckResult {
  const runtime = new FakeLifecycleRuntime("peaks"); runtime.load(); const handle = runtime.createHandle(); const run = runtime.startRun(1);
  const running = runtime.observe("peak-running", "2026-01-01T00:00:00.000Z"); runtime.publish(run, 1); runtime.release(handle); runtime.dispose();
  const disposed = runtime.observe("peak-disposed", "2026-01-01T00:00:01.000Z");
  return check(running.ownedBytes === 4608 && running.hostCopyBytes === 256 && running.readbackBytes === 64 && running.temporaryBytes === 128 && disposed.ownedBytes === 0 && disposed.temporaryBytes === 0 && disposed.peaks.ownedBytes === 4608 && disposed.peaks.hostCopyBytes === 256 && disposed.peaks.readbackBytes === 64 && disposed.peaks.temporaryBytes === 128, "resource high-water marks were lost or conflated with current bytes");
}
function checkModelSwitch(): LifecycleCheckResult { const first = new FakeLifecycleRuntime("first"); first.load(); first.dispose(); const second = new FakeLifecycleRuntime("second"); second.load(); const ready = second.state === "ready"; second.dispose(); return check(ready && first.state === "disposed" && second.state === "disposed", "model switch did not dispose the previous runtime first"); }
function checkFailedInitialization(): LifecycleCheckResult { const runtime = new FakeLifecycleRuntime("failed-init"); runtime.failInitialization(); const observation = runtime.observe("failed-init", "2026-01-01T00:00:00.000Z"); return check(runtime.state === "failed" && observation.ownedBytes === 0 && observation.hostCopyBytes === 0 && observation.digestBytes === 0 && observation.cacheBytes === 0 && observation.temporaryBytes === 0 && (observation.peaks.ownedBytes ?? 0) > 0, "failed initialization retained partially allocated resources"); }
function checkExportReleasePins(): LifecycleCheckResult { const runtime = new FakeLifecycleRuntime("pins"); runtime.load(); const handle = runtime.createHandle(); runtime.pin(handle); runtime.release(handle); const pinned = runtime.observe("export-pinned", "2026-01-01T00:00:00.000Z"); runtime.unpin(handle); const released = runtime.observe("export-released", "2026-01-01T00:00:01.000Z"); runtime.dispose(); return check(pinned.ownedBytes === 4608 && released.ownedBytes === 4096, "release freed a context while an export pin was active"); }
function checkDisposeDuringRun(): LifecycleCheckResult { const runtime = new FakeLifecycleRuntime("dispose"); runtime.load(); const run = runtime.startRun(1); runtime.dispose(); return check(!run.published && run.cancelled && run.failedCode === "ADAPTER_DISPOSED" && runtime.state === "disposed", "dispose allowed a running request to publish"); }
function checkDeviceLoss(): LifecycleCheckResult { const runtime = new FakeLifecycleRuntime("device-loss"); runtime.load(); const run = runtime.startRun(1); runtime.loseDevice(); const published = runtime.publish(run, 1); return check(!published && run.failedCode === "DEVICE_LOST" && runtime.state === "failed", "device loss was silently retried or published"); }
function checkGuardedPublication(): LifecycleCheckResult { const runtime = new FakeLifecycleRuntime("publication"); runtime.load(); const oldRun = runtime.startRun(1); const newRun = runtime.startRun(2); const oldPublished = runtime.publish(oldRun, 2); const newPublished = runtime.publish(newRun, 2); runtime.dispose(); return check(!oldPublished && newPublished, "a stale generation became current"); }
function checkForeignHandle(): LifecycleCheckResult { const first = new FakeLifecycleRuntime("worker-a"); const second = new FakeLifecycleRuntime("worker-b"); first.load(); second.load(); const handle = first.createHandle(); const rejected = !second.acceptsForeignHandle(handle); first.dispose(); second.dispose(); return check(rejected, "a handle from another worker epoch was accepted"); }

/**
 * Run coordination-only lifecycle evidence. The unavailable entries are
 * intentional: a deterministic fake cannot establish real WebGPU/device-loss
 * evidence and must never be reported as having done so.
 */
export function runDeterministicLifecycleChecks(options: { readonly cycles?: number; readonly provider?: LifecycleProvider } = {}): LifecycleReport {
  const cycles = options.cycles ?? 20; const provider = options.provider ?? "webgpu"; const twenty = checkTwentyCycles(cycles);
  const checks: LifecycleChecks = { twentyCycles: twenty.result, stagedVsDualSession: checkStagedVsDualSession(), resourcePeaks: checkResourcePeaks(), modelSwitch: checkModelSwitch(), failedInitialization: checkFailedInitialization(), exportReleasePins: checkExportReleasePins(), disposeDuringRun: checkDisposeDuringRun(), deviceLoss: checkDeviceLoss(), guardedPublication: checkGuardedPublication(), foreignHandle: checkForeignHandle() };
  const failures = Object.entries(checks).filter(([, result]) => result.status === "failed").map(([name, result]) => `${name}: ${result.details ?? "failed"}`);
  return { suite: "lifecycle", status: failures.length === 0 ? "passed" : "failed", evidence: "deterministic-fake", requestedProvider: provider, cycles, observations: twenty.observations, checks, unavailable: ["real-device-memory", "real-gpu-allocation", "real-device-loss-event"], injected: { deviceLoss: true, failedInitialization: true, disposeDuringRun: true }, failures };
}

export function lifecycleObservation(): ResourceObservation { return observeResources("lifecycle"); }
/** Backwards-compatible convenience entry point used by the browser harness. */
export function lifecycleTwentyCycles(): LifecycleReport { return runDeterministicLifecycleChecks({ cycles: 20, provider: "webgpu" }); }

export interface ActualLifecycleReport {
  readonly status: "passed" | "unavailable" | "failed";
  readonly provider: LifecycleProvider;
  readonly requestedCycles: number;
  readonly completedCycles: number;
  readonly observations: readonly ResourceObservation[];
  readonly diagnostics: readonly Record<string, unknown>[];
  readonly unavailable: readonly string[];
  readonly failures: readonly string[];
}

type LifecycleWorker = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;
interface ActualReady { readonly kind: "ready"; readonly protocolVersion: 1; readonly workerEpoch: string; }

function waitLifecycleMessage(worker: LifecycleWorker, predicate: (value: unknown) => boolean, timeoutMs = 180_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => { if (timer) clearTimeout(timer); worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
    const onMessage = (event: MessageEvent) => { if (!predicate(event.data)) return; cleanup(); resolve(event.data); };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message || "lifecycle model worker failed")); };
    worker.addEventListener("message", onMessage); worker.addEventListener("error", onError);
    timer = setTimeout(() => { cleanup(); reject(new Error(`lifecycle model worker timed out after ${timeoutMs}ms`)); }, timeoutMs);
  });
}

async function lifecycleCall<T>(worker: LifecycleWorker, epoch: string, requestId: string, operation: string, payload: unknown): Promise<T> {
  const replyPromise = waitLifecycleMessage(worker, (value) => Boolean(value && typeof value === "object" && (value as { requestId?: string }).requestId === requestId));
  worker.postMessage({ protocolVersion: PROTOCOL_VERSION, workerEpoch: epoch, requestId, operation, payload });
  const reply = await replyPromise as WorkerReply<T>;
  if (reply.kind === "failure") throw Object.assign(new Error(`${reply.error.code}: ${reply.error.message}`), { code: reply.error.code });
  if (reply.kind !== "success") throw Object.assign(new Error(`${reply.kind}: ${reply.reason}`), { code: reply.kind.toUpperCase() });
  return reply.result;
}

function actualLifecycleFixture(cycle: number): { readonly training: Record<string, unknown>; readonly prediction: Record<string, unknown> } {
  const trainRows = 8;
  return {
    training: {
      columns: [new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]), new Float32Array([8, 7, 6, 5, 4, 3, 2, 1])],
      columnNames: ["x", "y"], rowCount: trainRows,
      target: new Float32Array([2, 4, 6, 8, 10, 12, 14, 16].map((value) => value + cycle * 0.0001)), targetName: "target",
    },
    prediction: { columns: [new Float32Array([9, 10, 11, 12]), new Float32Array([0, 1, 2, 3])], columnNames: ["x", "y"], rowCount: 4 },
  };
}

function ownedResourceObservation(stage: string, diagnostics: Record<string, unknown>): ResourceObservation {
  const resources = diagnostics.resources as { ownedBytes?: unknown; cacheBytes?: unknown; peakCacheBytes?: unknown } | undefined;
  const integer = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const ownedBytes = integer(resources?.ownedBytes);
  const cacheBytes = integer(resources?.cacheBytes);
  const peakCacheBytes = integer(resources?.peakCacheBytes);
  return observeResources(stage, {
    ...(ownedBytes === undefined ? {} : { ownedBytes }),
    ...(cacheBytes === undefined ? {} : { cacheBytes }),
    ...(peakCacheBytes === undefined ? {} : { peaks: { cacheBytes: peakCacheBytes } }),
  });
}

/** Run the real application-owned model worker for repeated context
 * preparation/prediction/release. This supplies concrete host-owned byte
 * observations while deliberately leaving GPU allocation/device-loss signals
 * unavailable unless the browser exposes them. */
export async function runActualLifecycle(factory: () => LifecycleWorker, provider: LifecycleProvider, cycles = 20): Promise<ActualLifecycleReport> {
  const requestedCycles = Number.isSafeInteger(cycles) && cycles > 0 ? cycles : 20;
  // A device-loss event is a WebGPU-only observation. WASM lifecycle runs can
  // still provide a complete control-path comparison without being forced
  // into `unavailable` by a signal that does not apply to their provider.
  const unavailable: string[] = provider === "webgpu" ? ["real-device-loss-event"] : [];
  const failures: string[] = [];
  const observations: ResourceObservation[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  let completedCycles = 0;
  const worker = factory();
  let epoch: string | undefined;
  try {
    const ready = await waitLifecycleMessage(worker, (value) => Boolean(value && typeof value === "object" && (value as ActualReady).kind === "ready")) as ActualReady;
    epoch = ready.workerEpoch;
    await lifecycleCall(worker, epoch, "lifecycle-load", "load", { preferredProvider: provider, allowWasmFallback: false });
    for (let cycle = 1; cycle <= requestedCycles; cycle += 1) {
      const fixture = actualLifecycleFixture(cycle);
      const context = await lifecycleCall<{ readonly handleId: string }>(worker, epoch, `lifecycle-fit-${cycle}`, "fitContext", { dataset: fixture.training, options: { featureSqlFingerprint: null, sourceSnapshotId: `lifecycle-${cycle}`, preprocessing: { profile: "tabpfn35-none", seed: 7 + cycle } } });
      const status = await lifecycleCall<{ readonly diagnostics?: Record<string, unknown> }>(worker, epoch, `lifecycle-status-${cycle}`, "status", undefined);
      if (status.diagnostics) { diagnostics.push(status.diagnostics); observations.push(ownedResourceObservation(`cycle-${cycle}:prepared`, status.diagnostics)); }
      const prediction = await lifecycleCall<{ readonly mean?: ArrayLike<number> }>(worker, epoch, `lifecycle-predict-${cycle}`, "predict", { context, dataset: fixture.prediction, options: { requestId: `lifecycle-${cycle}`, inputSnapshotId: `lifecycle-input-${cycle}`, scenarioId: "baseline" } });
      if (!prediction.mean || prediction.mean.length !== 4 || !Array.from(prediction.mean, Number).every(Number.isFinite)) throw new Error(`cycle ${cycle} returned invalid prediction means`);
      await lifecycleCall(worker, epoch, `lifecycle-release-${cycle}`, "releaseContext", context);
      const after = await lifecycleCall<{ readonly diagnostics?: Record<string, unknown> }>(worker, epoch, `lifecycle-status-after-${cycle}`, "status", undefined);
      if (after.diagnostics) { diagnostics.push(after.diagnostics); observations.push(ownedResourceObservation(`cycle-${cycle}:released`, after.diagnostics)); }
      completedCycles += 1;
    }
    await lifecycleCall(worker, epoch, "lifecycle-dispose", "dispose", undefined);
    const status = await lifecycleCall<{ readonly diagnostics?: Record<string, unknown> }>(worker, epoch, "lifecycle-status-disposed", "status", undefined).catch(() => undefined);
    if (status?.diagnostics) { diagnostics.push(status.diagnostics); observations.push(ownedResourceObservation("disposed", status.diagnostics)); }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/PROVIDER_UNAVAILABLE|adapter|webgpu|device/i.test(message) && provider === "webgpu") unavailable.push(message);
    else failures.push(message);
  } finally { worker.terminate(); }
  const status = failures.length ? "failed" : unavailable.length ? "unavailable" : "passed";
  return { status, provider, requestedCycles, completedCycles, observations, diagnostics, unavailable, failures };
}
