import { RuntimeError } from "../errors";
import { sha256Hex } from "../identity";
import { TabPFN35Adapter } from "./adapter";
import { TabPFN35OrtRuntime } from "./ort-runtime";
import type { ExecutionProvider } from "../types";
import { artifactCacheKey, createArtifactCacheStore, type ModelAssetEvent, MODEL_ARTIFACT_FILES } from "../../workbench/model-asset-status";

export type TabPFN35Precision = "fp32" | "fp16-storage-fp32-compute";
export interface TabPFN35ArtifactFetchStats {
  networkFetches: number;
  readonly files: Record<string, number>;
  readonly bytes: Record<string, number>;
}
const artifactCache = createArtifactCacheStore();
const artifactInflight = new Map<string, Promise<Uint8Array>>();

export function resolveTabPFN35Precision(value: unknown): TabPFN35Precision {
  return value === "fp32" ? "fp32" : "fp16-storage-fp32-compute";
}

function assetUrl(file: string, precision: TabPFN35Precision, baseUrl?: string): string {
  const origin = baseUrl ?? (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:4175");
  return new URL(`/runtime-assets/tabpfn35/${precision}/${file}`, origin).toString();
}

async function fetchAsset(file: string, precision: TabPFN35Precision, baseUrl: string | undefined, stats: TabPFN35ArtifactFetchStats, onAssetEvent?: (event: ModelAssetEvent) => void): Promise<Uint8Array> {
  // Bind the persistent generation to an explicit cache/artifact version,
  // precision and exact file path. IndexedDbStore verifies length and SHA-256 for every
  // cached generation; a corrupt or interrupted cache entry is a miss.
  const cacheKey = artifactCacheKey(precision, file);
  const pending = artifactInflight.get(cacheKey);
  if (pending) return pending;
  const task = (async () => {
    try {
      const manifest = await artifactCache.getManifest(cacheKey);
      onAssetEvent?.({ kind: "model-assets", precision, state: "checking", file, message: manifest ? "发现缓存，加载时校验" : "检查本地缓存" });
      const cached = await artifactCache.get(cacheKey);
      if (cached) return cached;
    } catch {
      onAssetEvent?.({ kind: "model-assets", precision, state: "checking", file, message: "本地缓存不可用，准备下载" });
      /* disabled/quota storage falls back to network */
    }
    onAssetEvent?.({ kind: "model-assets", precision, state: "downloading", file, message: "正在下载权重" });
    let response: Response;
    try {
      response = await fetch(assetUrl(file, precision, baseUrl));
    } catch (error) {
      throw new RuntimeError("ARTIFACT_MISMATCH", `TabPFN artifact request failed for ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new RuntimeError("ARTIFACT_MISMATCH", `TabPFN artifact ${file} is unavailable (${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    stats.networkFetches += 1;
    stats.files[file] = (stats.files[file] ?? 0) + 1;
    stats.bytes[file] = bytes.byteLength;
    try { await artifactCache.put(cacheKey, bytes); } catch { /* verified network bytes remain usable */ }
    return bytes;
  })();
  artifactInflight.set(cacheKey, task);
  try { return await task; } finally { if (artifactInflight.get(cacheKey) === task) artifactInflight.delete(cacheKey); }
}

/** Create the artifact-bound adapter used by the primary model worker and the
 * browser parity worker.  ORT sessions remain owned by the adapter; only
 * host-readable results cross the worker protocol. */
export async function createTabPFN35Adapter(options: { readonly precision?: TabPFN35Precision; readonly baseUrl?: string; readonly onAssetEvent?: (event: ModelAssetEvent) => void } = {}): Promise<TabPFN35Adapter> {
  const precision = resolveTabPFN35Precision(options.precision);
  options.onAssetEvent?.({ kind: "model-assets", precision, state: "checking", message: "检查 TabPFN 3.5 权重" });
  const fetchStats: TabPFN35ArtifactFetchStats = { networkFetches: 0, files: Object.create(null) as Record<string, number>, bytes: Object.create(null) as Record<string, number> };
  try {
    const [contextGraph, predictorGraph, sharedData] = await Promise.all(MODEL_ARTIFACT_FILES.map((file) => fetchAsset(file, precision, options.baseUrl, fetchStats, options.onAssetEvent))) as [Uint8Array, Uint8Array, Uint8Array];
    options.onAssetEvent?.({ kind: "model-assets", precision, state: "available", message: fetchStats.networkFetches ? "权重已获取，正在校验并加载" : "发现并校验本地缓存" });
  const digestInput = new Uint8Array(contextGraph.byteLength + predictorGraph.byteLength + sharedData.byteLength);
  digestInput.set(contextGraph, 0);
  digestInput.set(predictorGraph, contextGraph.byteLength);
  digestInput.set(sharedData, contextGraph.byteLength + predictorGraph.byteLength);
  const artifactManifestDigest = await sha256Hex(digestInput);
  // ORT's WASM and WebGPU entry points both use a small WASM companion
  // module. They resolve its binaries relative to the worker module URL by
  // default, while Vite serves the pinned runtime binaries from a same-origin
  // route. Make that route explicit for both providers so a module worker
  // never receives the SPA fallback HTML as a `.wasm` response.
  const origin = options.baseUrl ?? (typeof location !== "undefined" ? location.origin : "http://127.0.0.1:4175");
  const wasmPaths = new URL("/runtime-assets/ort/", origin).toString();
  const runtimeFactory = (provider: ExecutionProvider) => new TabPFN35OrtRuntime({
    provider,
    contextGraph,
    predictorGraph,
    externalData: { path: "tabpfn35-shared.data", bytes: sharedData },
    wasmPaths,
    maxTrainRows: 1024,
    maxPredictionRows: 1024,
    maxFeatures: 32,
  });
    return new TabPFN35Adapter({
    modelVersion: `3.5-runtime-shared-${precision}`,
    artifactManifestDigest,
    requireOrtRuntime: true,
    ortRuntimeFactory: runtimeFactory,
    artifactDiagnostics: () => ({ networkFetches: fetchStats.networkFetches, files: { ...fetchStats.files }, bytes: { ...fetchStats.bytes }, ownedBytes: Object.values(fetchStats.bytes).reduce((total, value) => total + value, 0) }),
    });
  } catch (error) {
    options.onAssetEvent?.({ kind: "model-assets", precision, state: "failed", message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
