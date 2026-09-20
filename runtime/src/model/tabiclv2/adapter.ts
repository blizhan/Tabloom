import { RuntimeError } from "../errors";
import { ContextRegistry, type ContextBacking } from "../context-registry";
import type { ContextSnapshot, ExecutionProvider, FitContextOptions, ModelCapabilities, ModelContext, ModelLoadOptions, PredictionMetadata, PredictionOptions, PredictionResult, TabularDataset, TabularModelAdapter, TrainingDataset } from "../types";
import { webGpuAvailable } from "../provider";
import { inverseTarget, prepareCaseFeatures, validateCaseState, type TabICLCaseState } from "./preprocessing";
import { validateContextSnapshot } from "../context-snapshot";

export interface TabICLCaseOptions { readonly manifestDigest: string; readonly state: TabICLCaseState; readonly provider?: ExecutionProvider; readonly modelVersion?: string; readonly providerAvailable?: (provider: ExecutionProvider) => boolean | Promise<boolean>; readonly registry?: ContextRegistry; readonly runtimeVersion?: string; readonly inference?: { readonly predict: (dataset: TabularDataset, state: TabICLCaseState) => Promise<ArrayLike<number>> }; }
function sameArray<T>(left: ArrayLike<T> | undefined, right: ArrayLike<T> | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}
function sameOptionalArray<T>(left: ArrayLike<T> | undefined, right: ArrayLike<T> | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return sameArray(left, right);
}
function assertSnapshotStateCompatible(snapshotState: TabICLCaseState, expected: TabICLCaseState, manifestDigest: string): void {
  validateCaseState(snapshotState);
  if (snapshotState.artifactDigest !== manifestDigest || snapshotState.artifactDigest !== expected.artifactDigest ||
      !sameArray(snapshotState.featureNames, expected.featureNames) || snapshotState.trainRows !== expected.trainRows ||
      snapshotState.targetMean !== expected.targetMean || snapshotState.targetScale !== expected.targetScale ||
      snapshotState.featureTransform !== expected.featureTransform ||
      !sameOptionalArray(snapshotState.featureMeans, expected.featureMeans) ||
      !sameOptionalArray(snapshotState.featureScales, expected.featureScales) ||
      !sameOptionalArray(snapshotState.outlierLowerBounds, expected.outlierLowerBounds) ||
      !sameOptionalArray(snapshotState.outlierUpperBounds, expected.outlierUpperBounds) ||
      snapshotState.bias !== expected.bias ||
      !sameOptionalArray(snapshotState.weights, expected.weights)) {
    throw new RuntimeError("CONTEXT_INCOMPATIBLE", "Snapshot fitted state does not match the published TabICL Case");
  }
}
export class TabICLv2CaseAdapter implements TabularModelAdapter {
  readonly id = "tabicl-v2" as const;
  readonly registry: ContextRegistry;
  private readonly options: TabICLCaseOptions;
  private loaded = false; private disposed = false; private provider: ExecutionProvider = "wasm"; private warnings: string[] = [];
  constructor(options: TabICLCaseOptions) { validateCaseState(options.state); this.options = options; this.registry = options.registry ?? new ContextRegistry(); }
  capabilities(): ModelCapabilities { return { taskTypes: ["regression"], canBuildContext: false, canImportContext: true, supportsMissingFeatures: false, supportsPassthroughInf: false, maxModelFeatures: this.options.state.featureNames.length, trainRows: { min: this.options.state.trainRows, max: this.options.state.trainRows }, predictionRows: { min: 1, max: 1024 } }; }
  async load(options: ModelLoadOptions = {}): Promise<void> { if (this.disposed) throw new RuntimeError("ADAPTER_DISPOSED", "Case adapter is disposed"); this.warnings = []; const preferred = options.preferredProvider ?? this.options.provider ?? "wasm"; const available = await (this.options.providerAvailable?.(preferred) ?? (preferred === "wasm" || webGpuAvailable())); if (!available) { if (options.allowWasmFallback && preferred !== "wasm") { this.provider = "wasm"; this.warnings.push(`fallback from ${preferred} to wasm`); } else throw new RuntimeError("PROVIDER_UNAVAILABLE", `Provider ${preferred} is unavailable`); } else this.provider = preferred; this.loaded = true; }
  private ensureReady(): void { if (this.disposed) throw new RuntimeError("ADAPTER_DISPOSED", "Case adapter is disposed"); if (!this.loaded) throw new RuntimeError("PROVIDER_UNAVAILABLE", "Model is not loaded"); }
  async fitContext(_dataset: TrainingDataset, _options: FitContextOptions): Promise<ModelContext> { throw new RuntimeError("UNSUPPORTED_CAPABILITY", "TabICL v2 only supports published preconfigured cases"); }
  async importContext(snapshot: ContextSnapshot): Promise<ModelContext> {
    this.ensureReady(); validateContextSnapshot(snapshot);
    if (snapshot.identity.modelId !== this.id || snapshot.identity.artifactManifestDigest !== this.options.manifestDigest || snapshot.provenance.builtWithProvider !== this.provider || snapshot.payload.kind !== "embedded-artifact") throw new RuntimeError("CONTEXT_INCOMPATIBLE", "Snapshot is not compatible with this TabICL Case");
    const snapshotState = snapshot.estimatorState.values as unknown as TabICLCaseState;
    assertSnapshotStateCompatible(snapshotState, this.options.state, this.options.manifestDigest);
    if (!sameArray(snapshot.featureNames, this.options.state.featureNames)) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "Snapshot feature schema does not match the published TabICL Case");
    return this.registry.create({ identity: snapshot.identity, featureNames: snapshot.featureNames, tensors: [], provenance: snapshot.provenance });
  }
  async exportContext(context: ModelContext): Promise<ContextSnapshot> { this.ensureReady(); const backing = this.registry.export(context); return { identity: backing.identity, provenance: backing.provenance ?? { sourceSnapshotId: "case", builtWithProvider: this.provider }, featureNames: [...backing.featureNames], estimatorState: { schemaVersion: 1, values: this.options.state as unknown as Record<string, unknown> }, payload: { kind: "embedded-artifact", manifestDigest: this.options.manifestDigest } }; }
  async releaseContext(context: ModelContext): Promise<void> { this.ensureReady(); this.registry.release(context); }
  async predict(context: ModelContext, dataset: TabularDataset, options: PredictionOptions): Promise<PredictionResult> { this.ensureReady(); const release = this.registry.pin(context); try { const state = this.options.state; const columns = prepareCaseFeatures(dataset, state); const preparedDataset = { ...dataset, columns }; const normalized = this.options.inference ? new Float32Array(await this.options.inference.predict(preparedDataset, state)) : new Float32Array(dataset.rowCount); if (!this.options.inference) { if (!state.weights || state.bias === undefined) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "This Case requires an artifact-backed inference callback"); for (let row = 0; row < dataset.rowCount; row += 1) { let value = state.bias; for (let column = 0; column < columns.length; column += 1) value += columns[column][row] * state.weights[column]; normalized[row] = value; } } if (normalized.length !== dataset.rowCount) throw new RuntimeError("RESULT_INVALID", "Case inference returned an unexpected row count"); const mean = inverseTarget(normalized, state); const metadata: PredictionMetadata = { modelId: this.id, modelVersion: this.options.modelVersion ?? "2-runtime", artifactManifestDigest: this.options.manifestDigest, provider: this.provider, runtimeVersion: this.options.runtimeVersion ?? "runtime-dev", timings: {}, warnings: [...this.warnings] }; return { mean, requestId: options.requestId, inputSnapshotId: options.inputSnapshotId, scenarioId: options.scenarioId, contextKey: context.identity.key, metadata, rowOrdinal: Array.from({ length: dataset.rowCount }, (_, index) => index) }; } finally { release(); } }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; this.loaded = false; this.registry.dispose(); }
}
