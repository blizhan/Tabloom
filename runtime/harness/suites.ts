import { createDuckDbWasmExecutor } from "../src/data/duckdb-wasm-executor";
import { ContextStore } from "../src/storage/context-store";
import { bootstrapData } from "../tests/browser/bootstrap-data";
import { bootstrapModel } from "../tests/browser/bootstrap-model";
import { indexedDbReplacementProbe, persistenceRestartProbe, persistenceRoundTrip, persistenceWorkerRestartProbe } from "../tests/browser/persistence";
import { scenarioPublicationSmoke } from "../tests/browser/scenario-publication";
import { predictionRegistrationSmoke } from "../tests/browser/prediction-registration";
import { runActualLifecycle, runDeterministicLifecycleChecks } from "../tests/browser/lifecycle";
import { inspectBuiltAssetContract, type AssetResponseEvidence } from "../tests/browser/built-assets";
import { runCaseBrowser } from "../tests/browser/case";
import { runEstimatorParity } from "../tests/browser/parity";
import { runWorkbenchFlow } from "../tests/browser/workbench-flow";
import { runWorkbenchBootstrap } from "../tests/browser/workbench-bootstrap";
import { runWorkbenchSources } from "../tests/browser/workbench-sources";
import { runWorkbenchPersistence } from "../tests/browser/workbench-persistence";
import { runWorkbenchResponsiveness } from "../tests/browser/workbench-responsiveness";
import { runWorkbenchExport } from "../tests/browser/workbench-export";
import { CASE_VARIANTS } from "../src/model/tabiclv2/case-fixture";
import type { ContextSnapshot } from "../src/model/types";
import { TABPFN35_CACHE_NAMES } from "../src/model/tabpfn35/ort-runtime";

export interface HarnessSuiteResult {
  readonly suite: string;
  readonly provider: "wasm" | "webgpu";
  readonly status: "passed" | "unavailable" | "failed";
  readonly scope?: string;
  readonly evidence?: readonly Record<string, unknown>[];
  readonly reason?: string;
}

function snapshot(): ContextSnapshot {
  const digest = "a".repeat(64);
  // The persistence probe uses a synthetic metadata snapshot, but it still
  // has to satisfy the same TabPFN portable-cache contract as a real export.
  // Keep each tensor tiny so this probe measures IndexedDB lifecycle rather
  // than allocating model-sized buffers; ContextStore replaces the placeholder
  // checksums with verified digests before encoding.
  const tensors = TABPFN35_CACHE_NAMES.map((name) => ({ name, dtype: "float32" as const, shape: [1], bytes: new Uint8Array(4), checksum: "0".repeat(64) }));
  return {
    identity: {
      key: "b".repeat(64), modelId: "tabpfn-3.5", modelVersion: "bootstrap", artifactManifestDigest: digest,
      contextFormatVersion: 1, preprocessingVersion: "bootstrap", trainingDataDigest: "c".repeat(64),
      featureSqlFingerprint: null, schemaDigest: "d".repeat(64), targetName: "target", configurationDigest: "e".repeat(64),
    },
    provenance: { sourceSnapshotId: "bootstrap", builtWithProvider: "wasm" },
    featureNames: ["x"], estimatorState: { schemaVersion: 1, values: { fitted: { profile: "tabpfn35-none", seed: 0 } } },
    payload: { kind: "portable-tensors", tensors },
  };
}

async function runIntegration(provider: "wasm" | "webgpu"): Promise<HarnessSuiteResult> {
  // DuckDB-WASM is currently the only real data bootstrap.  Provider is kept
  // in the report so an integration run cannot be mistaken for cross-provider
  // model parity.
  // Vite mounts the pinned package assets at this path in dev and copies the
  // same files into dist-harness for preview, so workers never receive the
  // SPA fallback document instead of JavaScript/WASM.
  const assetRoot = new URL("/runtime-assets/duckdb/", location.href).href;
  const urls = { workerUrl: `${assetRoot}/duckdb-browser-mvp.worker.js`, wasmUrl: `${assetRoot}/duckdb-mvp.wasm` };
  const { executor } = await createDuckDbWasmExecutor(urls);
  try {
    const data = await bootstrapData(executor);
    const indexedDbReplacement = await indexedDbReplacementProbe();
    const publication = await predictionRegistrationSmoke();
    const scenarios = await scenarioPublicationSmoke();
    const worker = await bootstrapModel(
      () => new Worker(new URL("../src/workers/model.worker-entry.ts", import.meta.url), { type: "module" }),
      provider,
      {
        baseUrl: location.origin,
        contextChainWorkerFactory: () => new Worker(new URL("../tests/browser/bootstrap-model.worker.ts", import.meta.url), { type: "module" }),
      },
    );
    return { suite: "integration", provider, status: scenarios.status === "failed" ? "failed" : "passed", scope: "real DuckDB-WASM + Arrow + IndexedDB replacement + artifact-bound TabPFN ORT module-worker protocol plus deterministic publication lifecycle", ...(scenarios.status === "failed" ? { reason: scenarios.failures.join("; ") } : {}), evidence: [{ data, indexedDbReplacement, publication, scenarios, worker }] };
  } finally {
    await executor.close?.();
  }
}

async function runPersistence(provider: "wasm" | "webgpu"): Promise<HarnessSuiteResult> {
  const first = new ContextStore();
  const saved = await first.save(snapshot());
  if (!saved.persistent) return { suite: "persistence", provider, status: "unavailable", reason: saved.warning ?? "IndexedDB is unavailable" };
  const reopened = new ContextStore();
  const restored = await reopened.load("b".repeat(64));
  if (!restored) throw new Error("IndexedDB context was not restored after creating a new store");
  const roundTrip = await persistenceRoundTrip(snapshot());
  const restart = await persistenceRestartProbe(snapshot(), "f".repeat(64));
  const worker = await persistenceWorkerRestartProbe(() => new Worker(new URL("../src/workers/model.worker-entry.ts", import.meta.url), { type: "module" }), provider);
  await reopened.delete("b".repeat(64));
  const status = worker.status === "failed" ? "failed" : worker.status === "unavailable" ? "unavailable" : "passed";
  return { suite: "persistence", provider, status, scope: "IndexedDB context snapshot plus real artifact-bound worker restart/import/prediction", ...(worker.status !== "passed" ? { reason: [...worker.unavailable, ...worker.failures].join("; ") || "persistence worker evidence is unavailable" } : {}), evidence: [{ saved, restored: Boolean(restored), roundTrip, restart, worker }] };
}

async function runLifecycle(provider: "wasm" | "webgpu", cycles: number): Promise<HarnessSuiteResult> {
  const deterministic = runDeterministicLifecycleChecks({ provider, cycles });
  const actual = await runActualLifecycle(() => new Worker(new URL("../src/workers/model.worker-entry.ts", import.meta.url), { type: "module" }), provider, cycles);
  // A real worker run now supplies concrete context/build/release evidence.
  // WebGPU still remains unavailable until the browser exposes real GPU
  // allocation and device-loss events; deterministic injections are kept
  // separate from those observations.
  return {
    suite: "lifecycle",
    provider,
    // Keep the actual lifecycle status authoritative. A future hardware run
    // must be able to become `passed`; the report's `unavailable` list still
    // carries any missing GPU/device-loss signals without forcing every
    // WebGPU run into an unconditional unavailable state.
    status: deterministic.status === "failed" || actual.status === "failed" ? "failed" : actual.status,
    scope: "real model-worker context/predict/release cycles plus deterministic ownership checks; GPU allocation/device-loss signals remain explicit",
    reason: deterministic.status === "failed" ? deterministic.failures.join("; ") : actual.status === "failed" ? actual.failures.join("; ") : actual.unavailable.join("; ") || "Real device, GPU allocation, and device-loss event evidence is unavailable",
    evidence: [deterministic, actual],
  };
}

async function runBuiltAssets(provider: "wasm" | "webgpu"): Promise<HarnessSuiteResult> {
  const page = await fetch(location.href);
  const assetPaths = [
    { kind: "worker" as const, path: "/runtime-assets/duckdb/duckdb-browser-mvp.worker.js" },
    { kind: "wasm" as const, path: "/runtime-assets/duckdb/duckdb-mvp.wasm" },
    { kind: "wasm" as const, path: "/runtime-assets/ort/ort-wasm-simd-threaded.wasm" },
    { kind: "model" as const, path: "/runtime-assets/tabiclv2/fp32/tabiclv2-kv-dynamic.onnx" },
    { kind: "model" as const, path: "/runtime-assets/tabiclv2/fp32/tabiclv2-kv-dynamic.onnx.data" },
    { kind: "model" as const, path: "/runtime-assets/tabiclv2/fp16-storage-fp32-compute/tabiclv2-kv-dynamic-fp16-storage.onnx" },
    { kind: "model" as const, path: "/runtime-assets/tabiclv2/fp16-storage-fp32-compute/tabiclv2-kv-dynamic-fp16-storage.onnx.data" },
    { kind: "model" as const, path: "/runtime-assets/tabpfn35/fp16-storage-fp32-compute/tabpfn35-context-dynamic.onnx" },
    { kind: "model" as const, path: "/runtime-assets/tabpfn35/fp16-storage-fp32-compute/tabpfn35-predict-dynamic.onnx" },
    { kind: "model" as const, path: "/runtime-assets/tabpfn35/fp16-storage-fp32-compute/tabpfn35-shared.data" },
    { kind: "fixture" as const, path: "/runtime-fixtures/tabpfn35/context-chain/fixture.json" },
    { kind: "fixture" as const, path: "/runtime-fixtures/tabpfn35/context-chain/x_train_8x2x4.f32" },
    { kind: "fixture" as const, path: "/runtime-fixtures/tabpfn35/context-chain/output_8x2x4.f32" },
  ];
  const assets: AssetResponseEvidence[] = [];
  for (const item of assetPaths) {
    const response = await fetch(item.path);
    assets.push({ kind: item.kind, url: new URL(item.path, location.href).href, status: response.status, contentType: response.headers.get("content-type") });
  }
  const remote = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => { try { return new URL(name).origin !== location.origin; } catch { return false; } });
  const inspection = inspectBuiltAssetContract({ headers: page.headers, pageUrl: location.href, crossOriginIsolated: globalThis.crossOriginIsolated, assets, inferenceRequests: remote });
  const persistence = await persistenceRestartProbe(snapshot(), `missing-${"f".repeat(63)}`);
  const persistenceUnavailable = !persistence.persistent;
  const persistenceFailed = persistence.persistent && (!persistence.workerRestarted || !persistence.restored || persistence.coldFetches !== 1 || persistence.warmFetches !== 0 || persistence.contextBuilds !== 0 || !persistence.trainingIdentityMiss || !persistence.predictionIdentityHit);
  const status = inspection.status === "failed" || persistenceFailed ? "failed" : inspection.status === "unavailable" || persistenceUnavailable ? "unavailable" : "passed";
  const reason = persistenceUnavailable ? "IndexedDB persistence/reopen is unavailable" : persistenceFailed ? "IndexedDB persistence/reopen evidence failed" : undefined;
  return { suite: "built-assets", provider, status, scope: "production-like static build; same-origin worker/WASM/MIME/headers plus IndexedDB reopen", ...(reason ? { reason } : {}), evidence: [{ inspection, persistence }] };
}

async function runCase(provider: "wasm" | "webgpu"): Promise<HarnessSuiteResult> {
  const evidence: Record<string, unknown>[] = [];
  const failures: string[] = [];
  const unavailable: string[] = [];
  for (const variant of CASE_VARIANTS) {
    const reply = await runCaseBrowser(location.origin, provider, variant);
    evidence.push(reply as unknown as Record<string, unknown>);
    if (reply.kind === "failure") {
      const text = `${reply.error.code}: ${reply.error.message}`;
      if (reply.error.code === "PROVIDER_UNAVAILABLE" || /request failed \(404\)|fixture .*unavailable|artifact .*absent/i.test(reply.error.message)) unavailable.push(`${variant}: ${text}`);
      else failures.push(`${variant}: ${text}`);
    }
  }
  if (failures.length) return { suite: "case", provider, status: "failed", scope: "real TabICL v2 Case ORT graph", reason: failures.join("; "), evidence };
  if (unavailable.length) return { suite: "case", provider, status: "unavailable", scope: "real TabICL v2 Case ORT graph", reason: unavailable.join("; "), evidence };
  return { suite: "case", provider, status: "passed", scope: "real TabICL v2 Case ORT graph; target-unit comparison against published FP32/FP16-storage means", evidence };
}

export async function runHarnessSuite(suite: string, provider: "wasm" | "webgpu", cycles: number, precision: "fp32" | "fp16-storage" = "fp16-storage", payload?: unknown): Promise<HarnessSuiteResult> {
  if (suite === "integration") return runIntegration(provider);
  if (suite === "persistence") return runPersistence(provider);
  if (suite === "lifecycle") return runLifecycle(provider, cycles);
  if (suite === "built-assets") return runBuiltAssets(provider);
  if (suite === "parity") {
    const parity = await runEstimatorParity(location.origin, provider);
    const reason = parity.status === "failed"
      ? parity.failures.join("; ")
      : parity.status === "unavailable"
        ? parity.unavailable.join("; ") || "Estimator parity prerequisites are unavailable"
        : undefined;
    return {
      suite,
      provider,
      status: parity.status,
      scope: "real TabPFN 3.5 ORT graph; FP32 and FP16-storage worker variants",
      ...(reason ? { reason } : {}),
      evidence: [parity],
    };
  }
  if (suite === "case") return runCase(provider);
  if (suite === "workbench-flow") {
    const result = await runWorkbenchFlow(location.origin, provider, precision);
    return { suite, provider, status: result.status === "failed" ? "failed" : result.status === "not-run" ? "unavailable" : "passed", scope: "real TabPFN 3.5 ORT worker against workbench v1 train/predict fixture", ...(result.status !== "passed" ? { reason: result.evidence.map((item) => String(item.reason ?? "workbench flow unavailable")).join("; ") } : {}), evidence: result.evidence };
  }
  if (suite === "workbench-bootstrap") {
    const assetRoot = new URL("/runtime-assets/duckdb/", location.href).href;
    const { executor } = await createDuckDbWasmExecutor({ workerUrl: `${assetRoot}duckdb-browser-mvp.worker.js`, wasmUrl: `${assetRoot}duckdb-mvp.wasm` });
    try { const result = await runWorkbenchBootstrap(executor); return { suite, provider, status: "passed", scope: "real DuckDB-WASM workbench readonly bootstrap", evidence: [result] }; }
    finally { await executor.close?.(); }
  }
  if (suite === "workbench-export") {
    const result = await runWorkbenchExport(location.origin);
    return { suite, provider, status: result.status === "passed" ? "passed" : result.status === "not-run" ? "unavailable" : "failed", scope: "real CSV/Arrow/Parquet export and SQL query round-trip", ...(result.status !== "passed" ? { reason: result.evidence.map((item) => String(item.error ?? "export unavailable")).join("; ") } : {}), evidence: result.evidence.concat(result.formats as unknown as Record<string, unknown>[]) };
  }
  if (suite === "workbench-sources") {
    const sourceBaseUrl = typeof payload === "object" && payload && "sourceBaseUrl" in payload ? String((payload as { sourceBaseUrl: unknown }).sourceBaseUrl) : "";
    if (!sourceBaseUrl) return { suite, provider, status: "unavailable", reason: "Controlled source origin was not supplied" };
    const result = await runWorkbenchSources(location.origin, sourceBaseUrl);
    return { suite, provider, status: result.status === "passed" ? "passed" : result.status === "not-run" ? "unavailable" : "failed", scope: "local CSV/Parquet/Arrow plus controlled remote source origin", ...(result.status !== "passed" ? { reason: result.evidence.map((item) => String(item.error ?? "source suite unavailable")).join("; ") } : {}), evidence: result.evidence };
  }
  if (suite === "workbench-persistence") {
    const result = await runWorkbenchPersistence();
    return { suite, provider, status: result.status === "passed" ? "passed" : result.status === "not-run" ? "unavailable" : "failed", scope: "model-free IndexedDB data snapshot and experiment restart", ...(result.status !== "passed" ? { reason: result.evidence.map((item) => String(item.reason ?? "persistence suite failed")).join("; ") } : {}), evidence: result.evidence };
  }
  if (suite === "workbench-model-cache") {
    const flow = await runWorkbenchFlow(location.origin, provider, precision);
    const worker = await persistenceWorkerRestartProbe(() => { const workerUrl = new URL("../src/workers/model.worker-entry.ts", import.meta.url); workerUrl.searchParams.set("precision", precision === "fp32" ? "fp32" : "fp16-storage"); return new Worker(workerUrl, { type: "module" }); }, provider);
    const status = flow.status === "passed" && worker.status === "passed" && worker.warmFetches === 0 && worker.meansFinite ? "passed" : flow.status === "not-run" || worker.status === "unavailable" ? "unavailable" : "failed";
    return { suite, provider, status, scope: "real model worker restart with application ContextStore cache and independent workbench mean", ...(status !== "passed" ? { reason: [...worker.unavailable, ...worker.failures, ...(flow.status !== "passed" ? ["independent workbench flow did not pass"] : [])].join("; ") } : {}), evidence: [{ flow, worker, applicationCacheHit: worker.warmFetches === 0, independentMeanChecked: flow.status === "passed" }] };
  }
  if (suite === "workbench-responsiveness") {
    const result = await runWorkbenchResponsiveness(location.origin, provider, precision);
    return { suite, provider, status: result.status === "passed" ? "passed" : result.status === "not-run" ? "unavailable" : "failed", scope: "30 event-loop feedback interactions plus one real model prediction", ...(result.status !== "passed" ? { reason: result.evidence.map((item) => String(item.reason ?? "responsiveness suite failed")).join("; ") } : {}), evidence: result.evidence.concat(result.phases as unknown as Record<string, unknown>[]) };
  }
  return { suite, provider, status: "failed", reason: `Unknown harness suite: ${suite}` };
}
