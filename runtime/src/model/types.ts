export type ModelId = "tabpfn-3.5" | "tabicl-v2" | "tabpfn-3";
export type ExecutionProvider = "webgpu" | "wasm";
export type TensorDType = "float32" | "float16" | "int32" | "uint8";
export type RuntimeState = "new" | "loading" | "ready" | "failed" | "disposing" | "disposed";

export interface TabularDataset {
  readonly columns: readonly Float32Array[];
  readonly columnNames: readonly string[];
  readonly rowCount: number;
  readonly sourceSnapshotId?: string;
}
export interface TrainingDataset extends TabularDataset {
  readonly target: Float32Array;
  readonly targetName: string;
}
export interface PreprocessingConfig {
  readonly profile: "tabpfn35-none" | "tabpfn35-fingerprint" | "tabpfn35-permutation" | "tabicl-case";
  readonly seed: number;
  readonly passthroughInf?: boolean;
  readonly featureFingerprint?: boolean;
  readonly featurePermutation?: readonly number[];
  /** Resolved official TabPFN feature-shift metadata. When present it is
   * preferred over deriving a new permutation from the seed, which keeps a
   * browser fit identical to a published estimator member. */
  readonly featureShiftDecoder?: "shuffle" | "rotate" | null;
  readonly featureShiftCount?: number;
  readonly version?: string;
}
export interface ContextIdentity {
  readonly key: string;
  readonly modelId: ModelId;
  readonly modelVersion: string;
  readonly artifactManifestDigest: string;
  readonly contextFormatVersion: number;
  readonly preprocessingVersion: string;
  readonly trainingDataDigest: string;
  readonly featureSqlFingerprint: string | null;
  readonly sqlParametersDigest?: string;
  readonly schemaDigest: string;
  readonly targetName: string;
  readonly configurationDigest: string;
}
export interface RuntimeTensorSnapshot {
  readonly name: string;
  readonly dtype: TensorDType;
  readonly shape: readonly number[];
  readonly bytes: Uint8Array;
  readonly checksum: string;
}
export interface FittedState {
  readonly profile: PreprocessingConfig["profile"];
  readonly seed: number;
  readonly featureNames: readonly string[];
  readonly featureMeans: Float32Array;
  readonly featureScales: Float32Array;
  readonly targetMean: number;
  readonly targetScale: number;
  readonly featurePermutation: readonly number[];
  readonly modelWeights: Float32Array;
  readonly modelBias: number;
  readonly extra?: Readonly<Record<string, unknown>>;
}
export interface SerializedEstimatorState {
  readonly schemaVersion: number;
  readonly values: Readonly<Record<string, unknown>>;
}
export interface ContextSnapshot {
  readonly identity: ContextIdentity;
  readonly provenance: { sourceSnapshotId: string; builtWithProvider: ExecutionProvider };
  readonly featureNames: readonly string[];
  readonly estimatorState: SerializedEstimatorState;
  readonly payload:
    | { readonly kind: "portable-tensors"; readonly tensors: readonly RuntimeTensorSnapshot[] }
    | { readonly kind: "embedded-artifact"; readonly manifestDigest: string };
}
export interface ModelContext {
  readonly handleId: string;
  readonly identity: ContextIdentity;
  readonly workerEpoch: string;
  readonly instanceId?: string;
  readonly state?: FittedState;
}
export type ContextHandle = ModelContext;
export interface ModelCapabilities {
  readonly taskTypes: readonly ["regression"];
  readonly canBuildContext: boolean;
  readonly canImportContext: boolean;
  readonly supportsMissingFeatures: boolean;
  readonly supportsPassthroughInf: boolean;
  readonly maxModelFeatures: number;
  readonly trainRows: { readonly min: number; readonly max: number };
  readonly predictionRows: { readonly min: number; readonly max: number };
}
export interface FitContextOptions {
  readonly featureSqlFingerprint: string | null;
  readonly typedSqlParams?: readonly unknown[];
  readonly sourceSnapshotId: string;
  readonly preprocessing: PreprocessingConfig;
}
export interface PredictionOptions {
  readonly requestId: string;
  readonly inputSnapshotId: string;
  readonly scenarioId: string;
}
export interface PredictionMetadata {
  readonly modelId: ModelId;
  readonly modelVersion: string;
  readonly artifactManifestDigest: string;
  readonly provider: ExecutionProvider;
  readonly inference?: "ort" | "fallback";
  readonly runtimeVersion: string;
  readonly timings: Readonly<Record<string, number>>;
  readonly warnings: readonly string[];
}
export interface PredictionResult {
  readonly mean: Float32Array;
  readonly requestId: string;
  readonly inputSnapshotId: string;
  readonly scenarioId: string;
  readonly contextKey: string;
  readonly metadata: PredictionMetadata;
  readonly rowOrdinal?: readonly number[];
}
export interface TabularModelAdapter {
  readonly id: ModelId;
  load(options?: ModelLoadOptions): Promise<void>;
  capabilities(): ModelCapabilities;
  fitContext(dataset: TrainingDataset, options: FitContextOptions): Promise<ModelContext>;
  importContext(snapshot: ContextSnapshot): Promise<ModelContext>;
  exportContext(context: ModelContext): Promise<ContextSnapshot>;
  releaseContext(context: ModelContext): Promise<void>;
  predict(context: ModelContext, dataset: TabularDataset, options: PredictionOptions): Promise<PredictionResult>;
  dispose(): Promise<void>;
}
export interface ModelLoadOptions {
  readonly preferredProvider?: ExecutionProvider;
  readonly allowWasmFallback?: boolean;
  readonly artifactManifestDigest?: string;
  readonly modelVersion?: string;
}

export interface ModelStatus {
  readonly state: RuntimeState;
  readonly provider?: ExecutionProvider;
  readonly warnings: readonly string[];
  readonly operation?: string;
}
