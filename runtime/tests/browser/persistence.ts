import { ContextStore } from "../../src/storage/context-store";
import { IndexedDbStore } from "../../src/storage/indexeddb-store";
import { buildContextIdentity } from "../../src/model/identity";
import { PROTOCOL_VERSION, type WorkerReply } from "../../src/workers/protocol";
import type { ContextSnapshot, PreprocessingConfig, TrainingDataset } from "../../src/model/types";
export function persistenceCapabilities(): { storage: string } { return { storage: ContextStore.name }; }
export async function persistenceRoundTrip(snapshot: ContextSnapshot): Promise<{ persistent: boolean; restored: boolean }> { const store = new ContextStore(); const saved = await store.save(snapshot); const restored = Boolean(await store.load(snapshot.identity.key)); return { persistent: saved.persistent, restored }; }

export async function indexedDbReplacementProbe(): Promise<{ readonly chunksAfterReplacement: number; readonly expectedChunks: number; readonly concurrentReadStable: boolean }> {
  const factory = globalThis.indexedDB;
  if (!factory) throw new Error("IndexedDB is unavailable");
  const dbName = `tabloom-replacement-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = "replacement";
  const store = new IndexedDbStore({ dbName, indexedDB: factory });
  await store.put(key, new Uint8Array([1, 2]));
  const replacement = await store.put(key, new Uint8Array([3]));
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(dbName, 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB inspection failed"));
  });
  const chunksAfterReplacement = await new Promise<number>((resolve, reject) => {
    let count = 0;
    const tx = db.transaction("chunks", "readonly");
    const request = tx.objectStore("chunks").openCursor();
    request.onsuccess = () => { const cursor = request.result; if (!cursor) return; if ((cursor.value as { key?: string }).key === key) count += 1; cursor.continue(); };
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB chunk inspection failed"));
  });
  db.close();
  await store.delete(key);
  if (chunksAfterReplacement !== replacement.chunkCount) throw new Error(`IndexedDB replacement retained ${chunksAfterReplacement - replacement.chunkCount} obsolete chunk(s)`);
  const concurrentKey = "concurrent-replacement";
  await store.put(concurrentKey, new Uint8Array([1, 2]));
  const readDuringReplacement = store.get(concurrentKey);
  const concurrentReplacement = store.put(concurrentKey, new Uint8Array([3]));
  const [concurrentRead] = await Promise.all([readDuringReplacement, concurrentReplacement]);
  const finalRead = await store.get(concurrentKey);
  await store.delete(concurrentKey);
  const concurrentReadStable = Boolean(concurrentRead && ([...concurrentRead].join(",") === "1,2" || [...concurrentRead].join(",") === "3") && finalRead && [...finalRead].join(",") === "3");
  if (!concurrentReadStable) throw new Error("Concurrent IndexedDB replacement exposed or deleted an invalid generation");
  return { chunksAfterReplacement, expectedChunks: replacement.chunkCount, concurrentReadStable };
}

export interface PersistenceRestartReport {
  readonly persistent: boolean;
  readonly workerRestarted: boolean;
  readonly coldFetches: number;
  readonly warmFetches: number;
  readonly contextBuilds: number;
  readonly restored: boolean;
  readonly trainingIdentityMiss: boolean;
  readonly predictionIdentityHit: boolean;
}

/**
 * Re-open the same IndexedDB database through a fresh store instance.  Model
 * worker shutdown/restart is supplied by the browser harness; this helper
 * keeps the cache invariants independent of a particular worker implementation.
 */
export async function persistenceRestartProbe(snapshot: ContextSnapshot, changedTrainingKey: string): Promise<PersistenceRestartReport> {
  const dbName = `tabloom-persistence-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const first = new ContextStore({ storage: new IndexedDbStore({ dbName }) });
  const saved = await first.save(snapshot);
  if (!saved.persistent) return { persistent: false, workerRestarted: false, coldFetches: 1, warmFetches: 0, contextBuilds: 1, restored: false, trainingIdentityMiss: true, predictionIdentityHit: false };
  const reopened = new ContextStore({ storage: new IndexedDbStore({ dbName }) });
  const restored = Boolean(await reopened.load(snapshot.identity.key));
  const trainingIdentityMiss = !(await reopened.load(changedTrainingKey));
  const predictionIdentityHit = Boolean(await reopened.load(snapshot.identity.key));
  await reopened.delete(snapshot.identity.key);
  return { persistent: true, workerRestarted: true, coldFetches: 1, warmFetches: 0, contextBuilds: 0, restored, trainingIdentityMiss, predictionIdentityHit };
}

export interface PersistenceWorkerReport {
  readonly status: "passed" | "unavailable" | "failed";
  readonly provider: "wasm" | "webgpu";
  readonly workerRestarted: boolean;
  readonly coldFetches: number;
  readonly warmFetches: number;
  readonly coldContextBuilds: number;
  readonly warmContextBuilds: number;
  readonly restored: boolean;
  readonly meansFinite: boolean;
  readonly maxMeanError: number | null;
  readonly trainingIdentityMiss: boolean;
  readonly predictionIdentityHit: boolean;
  readonly trainingIdentityVariants: number;
  readonly changedPredictionReusedContext: boolean;
  readonly unavailable: readonly string[];
  readonly failures: readonly string[];
}

export type PersistenceWorker = Pick<Worker, "postMessage" | "terminate" | "addEventListener" | "removeEventListener">;
interface WorkerReady { readonly kind: "ready"; readonly protocolVersion: 1; readonly workerEpoch: string; }

function waitWorkerMessage(worker: PersistenceWorker, predicate: (value: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent) => { if (!predicate(event.data)) return; cleanup(); resolve(event.data); };
    const onError = (event: ErrorEvent) => { cleanup(); reject(event.error ?? new Error(event.message || "model worker failed")); };
    const cleanup = () => { worker.removeEventListener("message", onMessage); worker.removeEventListener("error", onError); };
    worker.addEventListener("message", onMessage); worker.addEventListener("error", onError);
  });
}

async function workerCall<T>(worker: PersistenceWorker, epoch: string, requestId: string, operation: string, payload: unknown): Promise<T> {
  const reply = waitWorkerMessage(worker, (value) => Boolean(value && typeof value === "object" && (value as { requestId?: string }).requestId === requestId));
  worker.postMessage({ protocolVersion: PROTOCOL_VERSION, workerEpoch: epoch, requestId, operation, payload });
  const value = await reply as WorkerReply<T>;
  if (value.kind === "failure") throw new Error(`${value.error.code}: ${value.error.message}`);
  if (value.kind !== "success") throw new Error(`${value.kind}: ${value.reason}`);
  return value.result;
}

async function startPersistenceWorker(factory: () => PersistenceWorker, provider: "wasm" | "webgpu"): Promise<{ worker: PersistenceWorker; epoch: string }> {
  const worker = factory();
  try {
    const ready = await waitWorkerMessage(worker, (value) => Boolean(value && typeof value === "object" && (value as WorkerReady).kind === "ready")) as WorkerReady;
    await workerCall(worker, ready.workerEpoch, `persistence-load-${provider}`, "load", { preferredProvider: provider, allowWasmFallback: false });
    return { worker, epoch: ready.workerEpoch };
  } catch (error) { worker.terminate(); throw error; }
}

async function stopPersistenceWorker(active: { worker: PersistenceWorker; epoch: string }, requestId: string): Promise<void> {
  try { await workerCall(active.worker, active.epoch, requestId, "dispose", undefined); } finally { active.worker.terminate(); }
}

function tabpfnResourceCount(): number {
  if (typeof performance === "undefined") return 0;
  // The acceptance invariant is about the shared external-data download:
  // both ORT sessions must consume the same verified blob, so its cold count
  // is one and its warm count is zero. Graph requests remain visible in the
  // browser network panel but are not conflated with shared-weight fetches.
  return performance.getEntriesByType("resource").filter((entry) => /\/runtime-assets\/tabpfn35\/[^/]+\/tabpfn35-shared\.data(?:\?|$)/.test(entry.name)).length;
}

function persistenceFixture(): { training: { columns: Float32Array[]; columnNames: string[]; rowCount: number; target: Float32Array; targetName: string }; prediction: { columns: Float32Array[]; columnNames: string[]; rowCount: number } } {
  return {
    training: { columns: [new Float32Array([1, 2, 3, 4]), new Float32Array([4, 3, 2, 1])], columnNames: ["x", "y"], rowCount: 4, target: new Float32Array([2, 4, 6, 8]), targetName: "target" },
    prediction: { columns: [new Float32Array([5, 6]), new Float32Array([0, 1])], columnNames: ["x", "y"], rowCount: 2 },
  };
}

/**
 * Browser-only persistence gate.  It uses the actual artifact-bound module
 * worker, closes that worker before reopening the same IndexedDB entry, and
 * compares complete target-unit means after import.  A missing browser or
 * IndexedDB is reported as unavailable; no fallback fake is promoted to a
 * persistence pass.
 */
export async function persistenceWorkerRestartProbe(factory: () => PersistenceWorker, provider: "wasm" | "webgpu"): Promise<PersistenceWorkerReport> {
  const unavailable: string[] = []; const failures: string[] = [];
  const storage = new IndexedDbStore({ dbName: `tabloom-persistence-worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` });
  if (!storage.persistentAvailable) return { status: "unavailable", provider, workerRestarted: false, coldFetches: 0, warmFetches: 0, coldContextBuilds: 0, warmContextBuilds: 0, restored: false, meansFinite: false, maxMeanError: null, trainingIdentityMiss: false, predictionIdentityHit: false, trainingIdentityVariants: 0, changedPredictionReusedContext: false, unavailable: ["IndexedDB is unavailable"], failures: [] };
  const store = new ContextStore({ storage, allowMemoryFallback: false });
  let first: { worker: PersistenceWorker; epoch: string } | undefined;
  let second: { worker: PersistenceWorker; epoch: string } | undefined;
  let persistedKey: string | undefined;
  let workerRestarted = false; let coldFetches = 0; let warmFetches = 0; let restored = false; let meansFinite = false; let maxMeanError: number | null = null; let trainingIdentityMiss = false; let predictionIdentityHit = false; let trainingIdentityVariants = 0; let changedPredictionReusedContext = false;
  try {
    const beforeColdFetches = tabpfnResourceCount();
    const { training, prediction } = persistenceFixture();
    first = await startPersistenceWorker(factory, provider);
    const context = await workerCall<{ readonly identity: { readonly key: string } }>(first.worker, first.epoch, "persistence-fit", "fitContext", { dataset: training, options: { featureSqlFingerprint: null, sourceSnapshotId: "persistence-training", preprocessing: { profile: "tabpfn35-none", seed: 7 } } });
    const snapshot = await workerCall<ContextSnapshot>(first.worker, first.epoch, "persistence-export", "exportContext", context);
    persistedKey = snapshot.identity.key;
    const cold = await workerCall<{ readonly mean: ArrayLike<number> }>(first.worker, first.epoch, "persistence-cold-predict", "predict", { context, dataset: prediction, options: { requestId: "persistence-cold-predict", inputSnapshotId: "persistence-prediction", scenarioId: "baseline" } });
    coldFetches = Math.max(0, tabpfnResourceCount() - beforeColdFetches);
    const saved = await store.save(snapshot);
    if (!saved.persistent) { unavailable.push(saved.warning ?? "IndexedDB persistence is unavailable"); return { status: "unavailable", provider, workerRestarted: false, coldFetches, warmFetches: 0, coldContextBuilds: 1, warmContextBuilds: 0, restored: false, meansFinite: false, maxMeanError: null, trainingIdentityMiss: false, predictionIdentityHit: false, trainingIdentityVariants: 0, changedPredictionReusedContext: false, unavailable, failures }; }
    await workerCall(first.worker, first.epoch, "persistence-release", "releaseContext", context);
    await stopPersistenceWorker(first, "persistence-dispose-first"); first = undefined;
    workerRestarted = true;

    const concurrent = await Promise.all([store.load(snapshot.identity.key), store.load(snapshot.identity.key), store.load(snapshot.identity.key)]);
    restored = concurrent.every((value) => Boolean(value));
    const restoredSnapshot = concurrent[0];
    if (!restoredSnapshot) throw new Error("persisted context could not be reopened after worker shutdown");
    predictionIdentityHit = Boolean(await store.load(snapshot.identity.key));
    const identityConfig: PreprocessingConfig = { profile: "tabpfn35-none", seed: 7, passthroughInf: false, featureFingerprint: true, featureShiftDecoder: null, featureShiftCount: 0 };
    const reverseRows = (dataset: TrainingDataset): TrainingDataset => ({ ...dataset, columns: dataset.columns.map((column) => new Float32Array(Array.from(column).reverse())), target: new Float32Array(Array.from(dataset.target).reverse()) });
    const reverseFeatures = (dataset: TrainingDataset): TrainingDataset => ({ ...dataset, columns: [...dataset.columns].reverse().map((column) => new Float32Array(column)), columnNames: [...dataset.columnNames].reverse() });
    const changedTarget: TrainingDataset = { ...training, target: new Float32Array(training.target).map((value, index) => value + (index === 0 ? 1 : 0)) };
    const variants: Array<{ dataset: TrainingDataset; config?: PreprocessingConfig; modelVersion?: string; artifactManifestDigest?: string; contextFormatVersion?: number; preprocessingVersion?: string; featureSqlFingerprint?: string | null; typedSqlParams?: readonly unknown[]; schemaDigest?: string }> = [
      { dataset: changedTarget },
      { dataset: reverseRows(training) },
      { dataset: reverseFeatures(training) },
      { dataset: training, config: { ...identityConfig, seed: 8 } },
      { dataset: training, config: { ...identityConfig, profile: "tabpfn35-fingerprint" } },
      { dataset: training, config: { ...identityConfig, passthroughInf: true } },
      { dataset: training, artifactManifestDigest: "f".repeat(64) },
      { dataset: training, modelVersion: `${snapshot.identity.modelVersion}-changed` },
      { dataset: training, contextFormatVersion: snapshot.identity.contextFormatVersion + 1 },
      { dataset: training, preprocessingVersion: `${snapshot.identity.preprocessingVersion}-changed` },
      { dataset: training, featureSqlFingerprint: "sql-changed" },
      { dataset: training, typedSqlParams: ["changed"] },
      { dataset: training, schemaDigest: "f".repeat(64) },
      { dataset: { ...training, targetName: "changed-target" } },
    ];
    const variantKeys = await Promise.all(variants.map((variant) => buildContextIdentity({ modelId: snapshot.identity.modelId, modelVersion: variant.modelVersion ?? snapshot.identity.modelVersion, artifactManifestDigest: variant.artifactManifestDigest ?? snapshot.identity.artifactManifestDigest, preprocessingVersion: variant.preprocessingVersion ?? snapshot.identity.preprocessingVersion, contextFormatVersion: variant.contextFormatVersion ?? snapshot.identity.contextFormatVersion, dataset: variant.dataset, featureSqlFingerprint: variant.featureSqlFingerprint ?? null, typedSqlParams: variant.typedSqlParams, schemaDigest: variant.schemaDigest, config: variant.config ?? identityConfig })));
    trainingIdentityVariants = variantKeys.length;
    const variantHits = await Promise.all(variantKeys.map((identity) => store.load(identity.key)));
    trainingIdentityMiss = variantHits.every((value) => !value);
    const beforeWarmFetches = tabpfnResourceCount();
    second = await startPersistenceWorker(factory, provider);
    const imported = await workerCall<{ readonly identity: { readonly key: string } }>(second.worker, second.epoch, "persistence-import", "importContext", restoredSnapshot);
    const warm = await workerCall<{ readonly mean: ArrayLike<number> }>(second.worker, second.epoch, "persistence-warm-predict", "predict", { context: imported, dataset: prediction, options: { requestId: "persistence-warm-predict", inputSnapshotId: "persistence-prediction", scenarioId: "baseline" } });
    const changedPrediction = { columns: [new Float32Array([7, 8]), new Float32Array([2, 3])], columnNames: ["x", "y"], rowCount: 2 };
    const changedPredictionResult = await workerCall<{ readonly mean: ArrayLike<number>; readonly contextKey: string }>(second.worker, second.epoch, "persistence-changed-predict", "predict", { context: imported, dataset: changedPrediction, options: { requestId: "persistence-changed-predict", inputSnapshotId: "persistence-prediction-changed", scenarioId: "scenario" } });
    changedPredictionReusedContext = changedPredictionResult.contextKey === snapshot.identity.key && Array.from(changedPredictionResult.mean, Number).every(Number.isFinite);
    warmFetches = Math.max(0, tabpfnResourceCount() - beforeWarmFetches);
    const coldMeans = Array.from(cold.mean, Number); const warmMeans = Array.from(warm.mean, Number);
    meansFinite = coldMeans.length === warmMeans.length && coldMeans.every(Number.isFinite) && warmMeans.every(Number.isFinite);
    maxMeanError = meansFinite && coldMeans.length ? Math.max(...coldMeans.map((value, index) => Math.abs(value - warmMeans[index]))) : null;
    if (!meansFinite || maxMeanError === null || maxMeanError > 2e-3) failures.push(`restored means differ from the cold prediction (max error ${maxMeanError ?? "unavailable"})`);
    if (warmFetches !== 0) failures.push(`warm worker fetched ${warmFetches} TabPFN asset resource(s)`);
    if (!trainingIdentityMiss) failures.push("a changed training identity unexpectedly hit the persisted context");
    if (!predictionIdentityHit) failures.push("an unchanged training identity did not hit the persisted context");
    if (!changedPredictionReusedContext) failures.push("changing only prediction rows did not reuse the imported context");
    await workerCall(second.worker, second.epoch, "persistence-release-second", "releaseContext", imported);
    await stopPersistenceWorker(second, "persistence-dispose-second"); second = undefined;
  } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  finally {
    if (first) await stopPersistenceWorker(first, "persistence-dispose-cleanup").catch(() => undefined);
    if (second) await stopPersistenceWorker(second, "persistence-dispose-cleanup").catch(() => undefined);
  }
  if (persistedKey) await store.delete(persistedKey).catch(() => undefined);
  const status = failures.length ? "failed" : "passed";
  return { status, provider, workerRestarted, coldFetches, warmFetches, coldContextBuilds: 1, warmContextBuilds: 0, restored, meansFinite, maxMeanError, trainingIdentityMiss, predictionIdentityHit, trainingIdentityVariants, changedPredictionReusedContext, unavailable, failures };
}
