import { RuntimeError } from "../errors";
import { buildContextIdentity, parsePreprocessingConfig } from "../identity";
import { ContextRegistry, type ContextBacking } from "../context-registry";
import type { ArtifactManifest, ArtifactStore } from "../../storage/manifest";
import type { ContextSnapshot, ExecutionProvider, FitContextOptions, ModelCapabilities, ModelContext, ModelLoadOptions, PredictionMetadata, PredictionOptions, PredictionResult, RuntimeTensorSnapshot, TabularDataset, TabularModelAdapter, TrainingDataset } from "../types";
import { fitPreprocessing, transformFeatures, transformTrainingFeatures, checkPreparedShape, TABPFN35_MODEL_VERSION, TABPFN35_PREPROCESSING_VERSION } from "./preprocessing";
import { decodeMean, decodeRegressionMean } from "./decode";
import { validateContextSnapshot, verifyContextSnapshot } from "../context-snapshot";
import { sha256Hex } from "../identity";
import { TabPFN35OrtRuntime, type TabPFN35CacheTensor, type TabPFN35InferenceRuntime, type TabPFN35OrtRuntimeOptions, type TabPFN35RuntimeDiagnostics } from "./ort-runtime";
import { webGpuAvailable } from "../provider";

export interface TabPFN35AdapterOptions {
  readonly artifactStore?: ArtifactStore;
  readonly manifest?: ArtifactManifest;
  readonly modelVersion?: string;
  readonly artifactManifestDigest?: string;
  readonly provider?: ExecutionProvider;
  readonly providerAvailable?: (provider: ExecutionProvider) => boolean | Promise<boolean>;
  readonly runtimeVersion?: string;
  readonly registry?: ContextRegistry;
  /** Real artifact-bound runtime. ORT objects remain owned by this runtime. */
  readonly ortRuntime?: TabPFN35InferenceRuntime;
  /** Lazily creates a provider-specific runtime after provider selection. */
  readonly ortRuntimeFactory?: (provider: ExecutionProvider) => TabPFN35InferenceRuntime;
  /** Convenience constructor options for a real runtime created during load. */
  readonly ortRuntimeOptions?: Omit<TabPFN35OrtRuntimeOptions, "provider"> & { readonly provider?: ExecutionProvider };
  /** Worker entries set this to prevent an accidental linear fallback. */
  readonly requireOrtRuntime?: boolean;
  /** Primitive artifact-fetch counters for browser acceptance diagnostics. */
  readonly artifactDiagnostics?: () => Readonly<Record<string, unknown>>;
  /** Optional ORT-backed predictor. The callback owns ORT sessions and returns
   * host-readable logits; no ORT object crosses the runtime boundary. */
  readonly inference?: { readonly predict: (state: ReturnType<typeof fitPreprocessing>, dataset: TabularDataset) => Promise<ArrayLike<number>> };
}
const VIRTUAL_DIGEST = "0".repeat(64);
function now(): number { return typeof performance !== "undefined" ? performance.now() : Date.now(); }
function flattenPrepared(values: readonly Float32Array[], rowCount: number): Float32Array { const output = new Float32Array(rowCount * values.length); for (let row = 0; row < rowCount; row += 1) for (let column = 0; column < values.length; column += 1) output[row * values.length + column] = values[column][row]; return output; }
function normalizeTarget(target: Float32Array, mean: number, scale: number): Float32Array { const output = new Float32Array(target.length); for (let row = 0; row < target.length; row += 1) output[row] = Math.fround((target[row] - mean) / scale); return output; }
async function cacheSnapshots(cache: readonly TabPFN35CacheTensor[]): Promise<RuntimeTensorSnapshot[]> {
  if (cache.length !== 54) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "TabPFN context builder must return exactly 54 tensors");
  return Promise.all(cache.map(async (tensor, index) => {
    const expected = `cache_${index.toString().padStart(2, "0")}`;
    if (tensor.name !== expected || tensor.dtype !== "float32" || tensor.shape.length === 0 || tensor.shape.some((value) => !Number.isSafeInteger(value) || value <= 0) || tensor.data.some((value) => !Number.isFinite(value))) throw new RuntimeError("CONTEXT_INCOMPATIBLE", `Invalid TabPFN context tensor ${expected}`);
    const bytes = new Uint8Array(tensor.data.byteLength); bytes.set(new Uint8Array(tensor.data.buffer, tensor.data.byteOffset, tensor.data.byteLength));
    return { name: tensor.name, dtype: "float32" as const, shape: [...tensor.shape], bytes, checksum: await sha256Hex(bytes) };
  }));
}

export class TabPFN35Adapter implements TabularModelAdapter {
  readonly id = "tabpfn-3.5" as const;
  readonly registry: ContextRegistry;
  private readonly options: TabPFN35AdapterOptions;
  private loaded = false;
  private disposed = false;
  private provider: ExecutionProvider = "wasm";
  private warnings: string[] = [];
  private readonly modelVersion: string;
  private readonly artifactDigest: string;
  private ortRuntime?: TabPFN35InferenceRuntime;
  constructor(options: TabPFN35AdapterOptions = {}) { this.options = options; this.registry = options.registry ?? new ContextRegistry(); this.modelVersion = options.modelVersion ?? TABPFN35_MODEL_VERSION; this.artifactDigest = options.artifactManifestDigest ?? options.manifest?.manifestDigest ?? VIRTUAL_DIGEST; }
  /** Return only serializable runtime facts for worker diagnostics. */
  diagnostics(): Readonly<Record<string, unknown>> {
    const runtimeDiagnostics = this.ortRuntime && typeof (this.ortRuntime as TabPFN35InferenceRuntime & { diagnostics?: () => TabPFN35RuntimeDiagnostics }).diagnostics === "function"
      ? (this.ortRuntime as TabPFN35InferenceRuntime & { diagnostics: () => TabPFN35RuntimeDiagnostics }).diagnostics()
      : undefined;
    const contextResources = this.registry.resourceSnapshot();
    return {
      loaded: this.loaded,
      disposed: this.disposed,
      provider: this.provider,
      inference: this.ortRuntime ? "ort" : "fallback",
      ...(this.options.artifactDiagnostics ? { artifacts: this.options.artifactDiagnostics() } : {}),
      ...(runtimeDiagnostics ? { ort: runtimeDiagnostics } : {}),
      resources: {
        // These are runtime-owned host buffers only. GPU allocation and
        // browser process peaks remain unavailable unless a platform signal
        // explicitly supplies them.
        ownedBytes: (runtimeDiagnostics?.artifactBytes ?? 0) + contextResources.cacheBytes,
        cacheBytes: contextResources.cacheBytes,
        peakCacheBytes: contextResources.peakCacheBytes,
        contextCount: contextResources.contextCount,
        handleCount: contextResources.handleCount,
        pinnedHandles: contextResources.pinnedHandles,
      },
    };
  }
  capabilities(): ModelCapabilities { return { taskTypes: ["regression"], canBuildContext: true, canImportContext: true, supportsMissingFeatures: true, supportsPassthroughInf: true, maxModelFeatures: 32, trainRows: { min: 3, max: 1024 }, predictionRows: { min: 1, max: 1024 } }; }
  async load(options: ModelLoadOptions = {}): Promise<void> {
    this.ensureNotDisposed(); this.warnings = [];
    const preferred = options.preferredProvider ?? this.options.provider ?? "wasm";
    const check = this.options.providerAvailable;
    const available = async (provider: ExecutionProvider) => await (check?.(provider) ?? (provider === "wasm" || webGpuAvailable()));
    if (await available(preferred)) this.provider = preferred;
    else if (options.allowWasmFallback && preferred !== "wasm" && await available("wasm")) { this.provider = "wasm"; this.warnings.push(`fallback from ${preferred} to wasm`); }
    else throw new RuntimeError("PROVIDER_UNAVAILABLE", `Provider ${preferred} is unavailable`);
    if (this.options.manifest && !this.options.manifest.providerCompatibility.includes(this.provider)) throw new RuntimeError("PROVIDER_UNAVAILABLE", `Artifact does not support provider ${this.provider}`);
    if (this.options.manifest && this.options.artifactStore) await this.options.artifactStore.load(this.options.manifest);
    const configuredRuntime = this.options.ortRuntime ?? this.options.ortRuntimeFactory?.(this.provider) ?? (this.options.ortRuntimeOptions ? new TabPFN35OrtRuntime({ ...this.options.ortRuntimeOptions, provider: this.provider }) : undefined);
    if (configuredRuntime) {
      if (configuredRuntime.provider !== this.provider) throw new RuntimeError("PROVIDER_UNAVAILABLE", `TabPFN runtime provider ${configuredRuntime.provider} does not match selected provider ${this.provider}`);
      await configuredRuntime.load();
      this.ortRuntime = configuredRuntime;
    } else if (this.options.requireOrtRuntime || this.options.manifest) {
      throw new RuntimeError("ARTIFACT_MISMATCH", "A real TabPFN artifact runtime is required but was not configured");
    }
    this.loaded = true;
  }
  private ensureReady(): void { this.ensureNotDisposed(); if (!this.loaded) throw new RuntimeError("PROVIDER_UNAVAILABLE", "Model is not loaded"); }
  private ensureNotDisposed(): void { if (this.disposed) throw new RuntimeError("ADAPTER_DISPOSED", "Model adapter is disposed"); }
  async fitContext(dataset: TrainingDataset, options: FitContextOptions): Promise<ModelContext> {
    this.ensureReady(); if (dataset.rowCount !== dataset.target.length) throw new RuntimeError("INVALID_DATA", "Target length mismatch");
    const config = parsePreprocessingConfig(options.preprocessing); if (config.profile === "tabicl-case") throw new RuntimeError("UNSUPPORTED_CAPABILITY", "TabPFN 3.5 does not accept the TabICL Case preprocessing profile"); if (config.passthroughInf && !this.capabilities().supportsPassthroughInf) throw new RuntimeError("INF_DISABLED", "This model profile does not support passthrough Infinity"); const identity = await buildContextIdentity({ modelId: this.id, modelVersion: this.modelVersion, artifactManifestDigest: this.artifactDigest, preprocessingVersion: TABPFN35_PREPROCESSING_VERSION, dataset, featureSqlFingerprint: options.featureSqlFingerprint, typedSqlParams: options.typedSqlParams, config });
    const existing = this.registry.find(identity.key); if (existing) return existing;
    const capabilities = this.capabilities(); const fitted = fitPreprocessing(dataset, config, { minRows: capabilities.trainRows.min, maxRows: capabilities.trainRows.max, maxFeatures: capabilities.maxModelFeatures });
    let tensors: RuntimeTensorSnapshot[] = [];
    if (this.ortRuntime) {
      const prepared = transformTrainingFeatures(dataset, fitted); checkPreparedShape(prepared, { minRows: capabilities.trainRows.min, maxRows: capabilities.trainRows.max, maxFeatures: capabilities.maxModelFeatures });
      const cache = await this.ortRuntime.buildContext(flattenPrepared(prepared.values, prepared.rowCount), prepared.rowCount, prepared.values.length, normalizeTarget(dataset.target, fitted.targetMean, fitted.targetScale));
      tensors = await cacheSnapshots(cache);
    }
    const backing: ContextBacking = { identity, featureNames: [...fitted.featureNames], state: fitted, tensors, provenance: { sourceSnapshotId: options.sourceSnapshotId, builtWithProvider: this.provider } };
    return this.registry.create(backing);
  }
  async importContext(snapshot: ContextSnapshot): Promise<ModelContext> {
    this.ensureReady(); validateContextSnapshot(snapshot); await verifyContextSnapshot(snapshot); if (snapshot.identity.modelId !== this.id || snapshot.identity.artifactManifestDigest !== this.artifactDigest || snapshot.provenance.builtWithProvider !== this.provider) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "Context snapshot does not match this model artifact/provider");
    const state = snapshot.estimatorState.values as unknown as { fitted?: ReturnType<typeof fitPreprocessing> };
    if (!state.fitted) throw new RuntimeError("SNAPSHOT_CORRUPT", "TabPFN snapshot is missing fitted state");
    return this.registry.create({ identity: snapshot.identity, featureNames: snapshot.featureNames, state: state.fitted, tensors: snapshot.payload.kind === "portable-tensors" ? snapshot.payload.tensors : [], provenance: snapshot.provenance });
  }
  async exportContext(context: ModelContext): Promise<ContextSnapshot> {
    this.ensureReady(); const backing = this.registry.export(context);
    return { identity: backing.identity, provenance: backing.provenance ?? { sourceSnapshotId: "unknown", builtWithProvider: this.provider }, featureNames: [...backing.featureNames], estimatorState: { schemaVersion: 1, values: { fitted: backing.state } }, payload: { kind: "portable-tensors", tensors: backing.tensors.map((tensor) => ({ ...tensor, bytes: new Uint8Array(tensor.bytes), shape: [...tensor.shape] })) } };
  }
  async releaseContext(context: ModelContext): Promise<void> { this.ensureNotDisposed(); this.registry.release(context); }
  async predict(context: ModelContext, dataset: TabularDataset, options: PredictionOptions): Promise<PredictionResult> {
    this.ensureReady(); const started = now(); const release = this.registry.pin(context);
    try {
      const backing = this.registry.get(context); const state = backing.state; if (!state) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "Context has no fitted state");
      const capabilities = this.capabilities(); const prepared = transformFeatures(dataset, state); checkPreparedShape(prepared, { minRows: capabilities.predictionRows.min, maxRows: capabilities.predictionRows.max, maxFeatures: capabilities.maxModelFeatures });
      let mean: Float32Array; let inference: "ort" | "fallback" = "fallback";
      if (this.ortRuntime) {
        const logits = await this.ortRuntime.predict(flattenPrepared(prepared.values, prepared.rowCount), prepared.rowCount, prepared.values.length, backing.tensors);
        mean = decodeRegressionMean(logits.data, logits.dims, { targetMean: state.targetMean, targetScale: state.targetScale, temperature: Number(state.extra?.decoderTemperature ?? 1), borders: Array.isArray(state.extra?.standardBorders) ? state.extra.standardBorders.map(Number) : undefined });
        inference = "ort";
      } else {
        const raw = this.options.inference ? new Float32Array(await this.options.inference.predict(state, dataset)) : new Float32Array(dataset.rowCount);
        if (!this.options.inference) for (let row = 0; row < dataset.rowCount; row += 1) { let value = state.modelBias; for (let column = 0; column < prepared.values.length; column += 1) value += prepared.values[column][row] * state.modelWeights[column]; raw[row] = value; }
        if (raw.length !== dataset.rowCount) throw new RuntimeError("RESULT_INVALID", "Inference returned an unexpected row count");
        mean = decodeMean(raw, { targetMean: state.targetMean, targetScale: state.targetScale });
      }
      const metadata: PredictionMetadata = { modelId: this.id, modelVersion: this.modelVersion, artifactManifestDigest: this.artifactDigest, provider: this.provider, runtimeVersion: this.options.runtimeVersion ?? "runtime-dev", timings: { predictMs: now() - started }, warnings: [...this.warnings], inference };
      return { mean, requestId: options.requestId, inputSnapshotId: options.inputSnapshotId, scenarioId: options.scenarioId, contextKey: backing.identity.key, metadata, rowOrdinal: Array.from({ length: dataset.rowCount }, (_, index) => index) };
    } finally { release(); }
  }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.loaded = false; const runtime = this.ortRuntime; this.ortRuntime = undefined; try { await runtime?.release(); } finally { this.registry.dispose(); } }
}
