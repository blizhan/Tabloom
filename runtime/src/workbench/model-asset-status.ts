import { IndexedDbStore, type BinaryEntryManifest } from "../storage/indexeddb-store";

export type ModelAssetPrecision = "fp32" | "fp16-storage-fp32-compute";
export interface ModelAssetEvent {
  readonly kind: "model-assets";
  readonly precision: ModelAssetPrecision;
  readonly state: "checking" | "downloading" | "available" | "failed";
  readonly file?: string;
  readonly message?: string;
}

export const ARTIFACT_CACHE_DB = "tabloom-runtime-artifacts-v1";
export const ARTIFACT_CACHE_VERSION = "tabpfn35-runtime-cache-v1";
export const MODEL_ARTIFACT_FILES = ["tabpfn35-context-dynamic.onnx", "tabpfn35-predict-dynamic.onnx", "tabpfn35-shared.data"] as const;

export function artifactCacheKey(precision: ModelAssetPrecision, file: string): string { return `${ARTIFACT_CACHE_VERSION}:${precision}:${file}`; }
export function createArtifactCacheStore(): IndexedDbStore { return new IndexedDbStore({ dbName: ARTIFACT_CACHE_DB }); }

export interface ModelAssetCacheStatus { readonly precision: ModelAssetPrecision; readonly files: Readonly<Record<string, BinaryEntryManifest | undefined>>; readonly cachedCount: number; }
export async function inspectModelAssetCache(precision: ModelAssetPrecision, store = createArtifactCacheStore()): Promise<ModelAssetCacheStatus> {
  const files: Record<string, BinaryEntryManifest | undefined> = {};
  for (const file of MODEL_ARTIFACT_FILES) files[file] = await store.getManifest(artifactCacheKey(precision, file)).catch(() => undefined);
  return { precision, files, cachedCount: Object.values(files).filter(Boolean).length };
}
