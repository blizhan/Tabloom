import { RuntimeError } from "./errors";
import type { ExecutionProvider, ModelLoadOptions, ModelStatus } from "./types";
import type { ArtifactManifest, ArtifactStore, LoadedArtifact } from "../storage/manifest";
import { webGpuAvailable } from "./provider";

export interface SessionManagerOptions { readonly artifactStore?: ArtifactStore; readonly providerAvailable?: (provider: ExecutionProvider) => boolean | Promise<boolean>; readonly runtimeVersion?: string; }
export class SessionManager {
  private state: ModelStatus = { state: "new", warnings: [] };
  private artifact?: LoadedArtifact;
  private readonly options: SessionManagerOptions;
  private disposed = false;
  constructor(options: SessionManagerOptions = {}) { this.options = options; }
  async load(manifest: ArtifactManifest, options: ModelLoadOptions = {}): Promise<{ provider: ExecutionProvider; artifact: LoadedArtifact; warnings: readonly string[] }> {
    if (this.disposed) throw new RuntimeError("ADAPTER_DISPOSED", "Session manager is disposed");
    this.state = { state: "loading", warnings: [] };
    const preferred = options.preferredProvider ?? "webgpu"; const candidates: ExecutionProvider[] = [preferred, preferred === "webgpu" ? "wasm" : "webgpu"];
    let selected: ExecutionProvider | undefined; const warnings: string[] = [];
    for (const candidate of candidates) {
      if (!manifest.providerCompatibility.includes(candidate)) { warnings.push(`${candidate} is not listed by the artifact`); continue; }
      const available = await (this.options.providerAvailable?.(candidate) ?? (candidate === "wasm" ? true : webGpuAvailable()));
      if (available) { selected = candidate; break; }
      warnings.push(`${candidate} unavailable`);
      if (candidate === preferred && !options.allowWasmFallback) break;
    }
    if (!selected) { this.state = { state: "failed", warnings }; throw new RuntimeError("PROVIDER_UNAVAILABLE", "No compatible execution provider is available", { details: { warnings } }); }
    if (selected !== preferred) warnings.push(`fallback from ${preferred} to ${selected}`);
    const artifactStore = this.options.artifactStore;
    if (!artifactStore) throw new RuntimeError("ARTIFACT_MISMATCH", "No artifact store configured");
    try { this.artifact = await artifactStore.load(manifest); } catch (error) { this.state = { state: "failed", warnings }; throw error; }
    this.state = { state: "ready", provider: selected, warnings }; return { provider: selected, artifact: this.artifact, warnings };
  }
  get status(): ModelStatus { return { ...this.state, warnings: [...this.state.warnings] }; }
  get loadedArtifact(): LoadedArtifact { if (!this.artifact) throw new RuntimeError("ARTIFACT_MISMATCH", "Model is not loaded"); return this.artifact; }
  async dispose(): Promise<void> { if (this.disposed) return; this.state = { state: "disposing", warnings: this.state.warnings }; this.artifact = undefined; this.disposed = true; this.state = { state: "disposed", warnings: this.state.warnings }; }
}
