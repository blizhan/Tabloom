import { RuntimeError } from "../model/errors";
import { sha256Hex } from "../model/identity";
import type { ExecutionProvider, ModelId, TensorDType } from "../model/types";
import type { IndexedDbStore } from "./indexeddb-store";

export interface ArtifactFile { readonly path: string; readonly role: "graph" | "external-data"; readonly bytes: number; readonly sha256: string; }
export interface ArtifactManifest {
  readonly schemaVersion: number; readonly modelId: ModelId; readonly modelVersion: string; readonly manifestDigest: string;
  readonly precision: "fp32" | "fp16-storage-fp32-compute"; readonly preprocessingVersion: string;
  readonly files: readonly ArtifactFile[]; readonly inputs: readonly { name: string; dtype: TensorDType; minRank: number; maxRank: number }[];
  readonly providerCompatibility: readonly ExecutionProvider[];
  readonly capabilities: { readonly canBuildContext: boolean; readonly canImportContext: boolean; readonly maxModelFeatures: number; readonly trainRows: { min: number; max: number }; readonly predictionRows: { min: number; max: number } };
}
export function validateManifest(manifest: ArtifactManifest): ArtifactManifest {
  if (!manifest || manifest.schemaVersion !== 1 || !manifest.manifestDigest || manifest.files.length === 0) throw new RuntimeError("ARTIFACT_MISMATCH", "Invalid artifact manifest");
  if (!/^[a-f0-9]{64}$/i.test(manifest.manifestDigest)) throw new RuntimeError("ARTIFACT_MISMATCH", "Manifest digest must be SHA-256");
  if (!manifest.providerCompatibility.length) throw new RuntimeError("ARTIFACT_MISMATCH", "Manifest has no compatible provider");
  const paths = new Set<string>();
  for (const file of manifest.files) { if (!file.path || paths.has(file.path) || file.path.startsWith("/") || file.path.includes("..") || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new RuntimeError("ARTIFACT_MISMATCH", `Invalid artifact file: ${file.path}`); paths.add(file.path); }
  if (manifest.capabilities.trainRows.min > manifest.capabilities.trainRows.max || manifest.capabilities.predictionRows.min > manifest.capabilities.predictionRows.max || manifest.capabilities.maxModelFeatures <= 0) throw new RuntimeError("ARTIFACT_MISMATCH", "Invalid shape bounds");
  return manifest;
}

export interface LoadedArtifact { readonly manifest: ArtifactManifest; readonly files: ReadonlyMap<string, Uint8Array>; readonly sharedWeights: Uint8Array; readonly warnings: readonly string[]; }
export type ArtifactFetcher = (url: string) => Promise<Uint8Array>;
export async function computeManifestDigest(manifest: Omit<ArtifactManifest, "manifestDigest">): Promise<string> { return sha256Hex(new TextEncoder().encode(JSON.stringify(manifest))); }
function defaultFetcher(url: string): Promise<Uint8Array> { return fetch(url).then(async (response) => { if (!response.ok) throw new RuntimeError("ARTIFACT_MISMATCH", `Artifact fetch failed (${response.status})`); return new Uint8Array(await response.arrayBuffer()); }); }

export interface ArtifactStoreOptions { readonly persistent?: IndexedDbStore; }
export class ArtifactStore {
  private readonly inflight = new Map<string, Promise<LoadedArtifact>>();
  private readonly loaded = new Map<string, LoadedArtifact>();
  private readonly fetcher: ArtifactFetcher; private readonly persistent?: IndexedDbStore;
  constructor(fetcher: ArtifactFetcher = defaultFetcher, options: ArtifactStoreOptions = {}) { this.fetcher = fetcher; this.persistent = options.persistent; }
  async load(manifestOrUrl: ArtifactManifest | string, options: { baseUrl?: string; expectedManifestDigest?: string; onProgress?: (completed: number, total: number) => void } = {}): Promise<LoadedArtifact> {
    const manifest = typeof manifestOrUrl === "string" ? validateManifest(JSON.parse(new TextDecoder().decode(await this.fetcher(manifestOrUrl))) as ArtifactManifest) : validateManifest(manifestOrUrl);
    if (options.expectedManifestDigest && manifest.manifestDigest.toLowerCase() !== options.expectedManifestDigest.toLowerCase()) throw new RuntimeError("ARTIFACT_MISMATCH", "Manifest digest does not match expected identity");
    const cached = this.loaded.get(manifest.manifestDigest); if (cached) return cached;
    const pending = this.inflight.get(manifest.manifestDigest); if (pending) return pending;
    const task = this.loadFiles(manifest, options).finally(() => this.inflight.delete(manifest.manifestDigest)); this.inflight.set(manifest.manifestDigest, task); return task;
  }
  private async loadFiles(manifest: ArtifactManifest, options: { baseUrl?: string; onProgress?: (completed: number, total: number) => void }): Promise<LoadedArtifact> {
    const files = new Map<string, Uint8Array>(); let completed = 0; const warnings: string[] = [];
    for (const file of manifest.files) {
      const persistentKey = `${manifest.manifestDigest}:${file.path}`; let bytes: Uint8Array | undefined;
      try { bytes = await this.persistent?.get(persistentKey); } catch (error) { warnings.push(`persistent cache read failed for ${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
      if (!bytes) { const url = options.baseUrl ? new URL(file.path, options.baseUrl).toString() : file.path; bytes = await this.fetcher(url); }
      if (bytes.byteLength !== file.bytes) throw new RuntimeError("ARTIFACT_MISMATCH", `Unexpected length for ${file.path}`);
      if ((await sha256Hex(bytes)).toLowerCase() !== file.sha256.toLowerCase()) throw new RuntimeError("ARTIFACT_MISMATCH", `Checksum mismatch for ${file.path}`);
      if (this.persistent && !warnings.some((warning) => warning.includes(file.path))) try { await this.persistent.put(persistentKey, bytes); } catch (error) { warnings.push(`persistent cache write failed for ${file.path}: ${error instanceof Error ? error.message : String(error)}`); }
      files.set(file.path, bytes); completed += 1; options.onProgress?.(completed, manifest.files.length);
    }
    const sharedWeights = files.get(manifest.files.find((file) => file.role === "external-data")?.path ?? manifest.files[0].path)!;
    const result: LoadedArtifact = { manifest, files, sharedWeights, warnings }; this.loaded.set(manifest.manifestDigest, result); return result;
  }
  clear(manifestDigest?: string): void { if (manifestDigest) this.loaded.delete(manifestDigest); else this.loaded.clear(); }
}
