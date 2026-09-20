import { RuntimeError } from "../errors";
import { createOrtSession, type OrtOutputValue, type OrtSessionHandle, type OrtSessionOptions } from "../ort-session";
import type { ExecutionProvider, RuntimeTensorSnapshot } from "../types";

export const TABPFN35_CACHE_NAMES = Array.from({ length: 54 }, (_, index) => `cache_${index.toString().padStart(2, "0")}`);
export const TABPFN35_CONTEXT_INPUTS = ["x_train", "y_train"] as const;
export const TABPFN35_PREDICTION_INPUT = "x_test";
export const TABPFN35_PREDICTION_OUTPUT = "logits";
export const TABPFN35_BIN_COUNT = 5000;

export interface TabPFN35CacheTensor {
  readonly name: string;
  readonly dtype: "float32";
  readonly shape: readonly number[];
  readonly data: Float32Array;
}

export interface TabPFN35Logits {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}

/** Primitive-only diagnostics exposed to the validation harness.  No ORT
 * session, tensor, or provider object crosses the worker boundary. */
export interface TabPFN35RuntimeDiagnostics {
  readonly provider: ExecutionProvider;
  readonly wasmProxy: boolean | null;
  readonly wasmNumThreads: number | null;
  readonly wasmPathsConfigured: boolean;
  readonly sharedExternalDataConfigured: boolean;
  readonly sharedExternalDataBytes: number;
  /** Bytes still owned by the runtime's artifact inputs. This is not a
   * process/GPU high-water measurement. */
  readonly artifactBytes: number;
  readonly predictorLoaded: boolean;
  readonly builderActive: boolean;
}

/** Model-neutral surface consumed by the adapter. Implementations own all ORT
 * sessions and may be replaced by a deterministic fake in contract tests. */
export interface TabPFN35InferenceRuntime {
  readonly provider: ExecutionProvider;
  load(): Promise<void>;
  buildContext(xTrain: Float32Array, trainRows: number, features: number, yTrain: Float32Array): Promise<readonly TabPFN35CacheTensor[]>;
  predict(xTest: Float32Array, predictionRows: number, features: number, cache: readonly (TabPFN35CacheTensor | RuntimeTensorSnapshot)[]): Promise<TabPFN35Logits>;
  release(): Promise<void>;
}

export interface TabPFN35OrtRuntimeDependencies {
  readonly createSession?: (options: OrtSessionOptions) => Promise<OrtSessionHandle>;
}

export interface TabPFN35OrtRuntimeOptions {
  readonly provider: ExecutionProvider;
  readonly contextGraph: Uint8Array;
  readonly predictorGraph: Uint8Array;
  readonly externalData?: { readonly path: string; readonly bytes: Uint8Array };
  readonly wasmPaths?: string | Record<string, string | URL>;
  readonly dependencies?: TabPFN35OrtRuntimeDependencies;
  readonly maxTrainRows?: number;
  readonly maxPredictionRows?: number;
  readonly maxFeatures?: number;
}

type CacheInput = TabPFN35CacheTensor | RuntimeTensorSnapshot;

function isSnapshot(value: CacheInput): value is RuntimeTensorSnapshot {
  return "bytes" in value;
}

function elementCount(dims: readonly number[], label: string): number {
  if (dims.length === 0 || dims.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new RuntimeError("RESULT_INVALID", `${label} has invalid dimensions`);
  const count = dims.reduce((total, value) => total * value, 1);
  if (!Number.isSafeInteger(count) || count <= 0) throw new RuntimeError("RESULT_INVALID", `${label} is too large`);
  return count;
}

function numericData(value: unknown, label: string): Float32Array {
  if (value instanceof Float32Array) return new Float32Array(value);
  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    const values = Array.from(value as ArrayLike<number>, Number);
    const output = new Float32Array(values.length);
    for (let index = 0; index < values.length; index += 1) output[index] = values[index];
    return output;
  }
  throw new RuntimeError("RESULT_INVALID", `${label} is not a numeric tensor`);
}

function snapshotData(snapshot: RuntimeTensorSnapshot): Float32Array {
  if (snapshot.dtype !== "float32") throw new RuntimeError("CONTEXT_INCOMPATIBLE", `TabPFN cache tensor ${snapshot.name} must use float32 storage`);
  if (snapshot.bytes.byteLength % 4 !== 0) throw new RuntimeError("SNAPSHOT_CORRUPT", `TabPFN cache tensor ${snapshot.name} has an invalid byte length`);
  const copy = new Uint8Array(snapshot.bytes.byteLength);
  copy.set(snapshot.bytes);
  return new Float32Array(copy.buffer);
}

function validateOutput(name: string, output: OrtOutputValue | undefined): TabPFN35CacheTensor {
  if (!output) throw new RuntimeError("RESULT_INVALID", `TabPFN context graph did not return ${name}`);
  const shape = [...output.dims].map(Number);
  const count = elementCount(shape, name);
  const data = numericData(output.data, name);
  if (count !== data.length) throw new RuntimeError("RESULT_INVALID", `${name} output shape does not match its data length`);
  for (let index = 0; index < data.length; index += 1) if (!Number.isFinite(data[index])) throw new RuntimeError("RESULT_INVALID", `${name} contains a non-finite value at ${index}`);
  return { name, dtype: "float32", shape, data };
}

function validateRowsAndFeatures(rows: number, features: number, limits: { readonly minRows: number; readonly maxRows: number; readonly maxFeatures: number }, label: string): void {
  if (!Number.isSafeInteger(rows) || rows < limits.minRows || rows > limits.maxRows || !Number.isSafeInteger(features) || features < 1 || features > limits.maxFeatures) throw new RuntimeError("SHAPE_UNSUPPORTED", `${label} shape is outside TabPFN 3.5 bounds`);
}

function requiredNames(actual: readonly string[], expected: readonly string[], label: string): void {
  const actualSet = new Set(actual);
  if (actual.length !== actualSet.size || expected.some((name) => !actualSet.has(name))) throw new RuntimeError("ARTIFACT_MISMATCH", `${label} graph I/O names do not match the TabPFN 3.5 contract`);
}

/**
 * Owns the two artifact-bound ORT sessions used by the primary TabPFN worker.
 * The builder is lazy and released after each context build; the predictor is
 * long-lived until the adapter is disposed. No ORT object crosses this class.
 */
export class TabPFN35OrtRuntime implements TabPFN35InferenceRuntime {
  private readonly options: Required<Pick<TabPFN35OrtRuntimeOptions, "maxTrainRows" | "maxPredictionRows" | "maxFeatures">> & TabPFN35OrtRuntimeOptions;
  private readonly createSession: (options: OrtSessionOptions) => Promise<OrtSessionHandle>;
  private predictor?: OrtSessionHandle;
  private builder?: OrtSessionHandle;
  private loaded = false;
  private released = false;

  constructor(options: TabPFN35OrtRuntimeOptions) {
    this.options = { maxTrainRows: 1024, maxPredictionRows: 1024, maxFeatures: 32, ...options };
    this.createSession = options.dependencies?.createSession ?? createOrtSession;
  }

  get provider(): ExecutionProvider { return this.options.provider; }

  diagnostics(): TabPFN35RuntimeDiagnostics {
    const externalDataBytes = this.options.externalData?.bytes.byteLength ?? 0;
    const artifactBytes = this.options.contextGraph.byteLength + this.options.predictorGraph.byteLength + externalDataBytes;
    return {
      provider: this.provider,
      // createOrtSession pins these values for a module-worker WASM session.
      // WebGPU has no WASM proxy/thread setting, so keep those fields null;
      // it still uses the companion WASM binary and therefore reports whether
      // its explicit asset path was configured.
      wasmProxy: this.provider === "wasm" ? false : null,
      wasmNumThreads: this.provider === "wasm" ? 1 : null,
      wasmPathsConfigured: this.options.wasmPaths !== undefined,
      sharedExternalDataConfigured: externalDataBytes > 0,
      sharedExternalDataBytes: externalDataBytes,
      artifactBytes,
      predictorLoaded: Boolean(this.predictor) && this.loaded,
      builderActive: Boolean(this.builder),
    };
  }

  async load(): Promise<void> {
    if (this.released) throw new RuntimeError("ADAPTER_DISPOSED", "TabPFN ORT runtime has been released");
    if (this.loaded) return;
    try {
      this.predictor = await this.createSession(this.sessionOptions(this.options.predictorGraph));
      requiredNames(this.predictor.inputNames, [TABPFN35_PREDICTION_INPUT, ...TABPFN35_CACHE_NAMES], "TabPFN predictor");
      requiredNames(this.predictor.outputNames, [TABPFN35_PREDICTION_OUTPUT], "TabPFN predictor");
      this.loaded = true;
    } catch (error) {
      await this.predictor?.release().catch(() => undefined);
      this.predictor = undefined;
      throw error;
    }
  }

  private sessionOptions(graph: Uint8Array): OrtSessionOptions {
    return {
      graph,
      provider: this.options.provider,
      ...(this.options.externalData ? { externalData: this.options.externalData } : {}),
      ...(this.options.wasmPaths !== undefined ? { wasmPaths: this.options.wasmPaths } : {}),
    };
  }

  private ensureLoaded(): void {
    if (this.released) throw new RuntimeError("ADAPTER_DISPOSED", "TabPFN ORT runtime has been released");
    if (!this.loaded || !this.predictor) throw new RuntimeError("PROVIDER_UNAVAILABLE", "TabPFN ORT runtime is not loaded");
  }

  private async ensureBuilder(): Promise<OrtSessionHandle> {
    this.ensureLoaded();
    if (this.builder) return this.builder;
    try {
      this.builder = await this.createSession(this.sessionOptions(this.options.contextGraph));
      requiredNames(this.builder.inputNames, TABPFN35_CONTEXT_INPUTS, "TabPFN context builder");
      requiredNames(this.builder.outputNames, TABPFN35_CACHE_NAMES, "TabPFN context builder");
      return this.builder;
    } catch (error) {
      await this.builder?.release().catch(() => undefined);
      this.builder = undefined;
      throw error;
    }
  }

  async buildContext(xTrain: Float32Array, trainRows: number, features: number, yTrain: Float32Array): Promise<readonly TabPFN35CacheTensor[]> {
    const limits = { minRows: 3, maxRows: this.options.maxTrainRows, maxFeatures: this.options.maxFeatures };
    validateRowsAndFeatures(trainRows, features, limits, "TabPFN context");
    if (xTrain.length !== trainRows * features || yTrain.length !== trainRows) throw new RuntimeError("SHAPE_UNSUPPORTED", "TabPFN context input lengths do not match their shape");
    const builder = await this.ensureBuilder();
    try {
      const outputs = await builder.run({
        x_train: { type: "float32", data: new Float32Array(xTrain), dims: [trainRows, 1, features] },
        y_train: { type: "float32", data: new Float32Array(yTrain), dims: [trainRows] },
      }, TABPFN35_CACHE_NAMES);
      return TABPFN35_CACHE_NAMES.map((name) => validateOutput(name, outputs[name]));
    } finally {
      this.builder = undefined;
      await builder.release();
    }
  }

  async predict(xTest: Float32Array, predictionRows: number, features: number, cache: readonly CacheInput[]): Promise<TabPFN35Logits> {
    const limits = { minRows: 1, maxRows: this.options.maxPredictionRows, maxFeatures: this.options.maxFeatures };
    validateRowsAndFeatures(predictionRows, features, limits, "TabPFN prediction");
    if (xTest.length !== predictionRows * features) throw new RuntimeError("SHAPE_UNSUPPORTED", "TabPFN prediction input length does not match its shape");
    if (cache.length !== TABPFN35_CACHE_NAMES.length) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "TabPFN context must contain exactly 54 cache tensors");
    const feeds: Record<string, unknown> = {
      [TABPFN35_PREDICTION_INPUT]: { type: "float32", data: new Float32Array(xTest), dims: [predictionRows, 1, features] },
    };
    for (let index = 0; index < TABPFN35_CACHE_NAMES.length; index += 1) {
      const expectedName = TABPFN35_CACHE_NAMES[index];
      const tensor = cache[index];
      if (!tensor || tensor.name !== expectedName) throw new RuntimeError("CONTEXT_INCOMPATIBLE", `TabPFN context tensor ${expectedName} is missing or out of order`);
      const data = isSnapshot(tensor) ? snapshotData(tensor) : new Float32Array(tensor.data);
      const count = elementCount(tensor.shape, expectedName);
      if (data.length !== count) throw new RuntimeError("CONTEXT_INCOMPATIBLE", `TabPFN context tensor ${expectedName} shape does not match its data`);
      feeds[expectedName] = { type: "float32", data, dims: [...tensor.shape] };
    }
    this.ensureLoaded();
    const outputs = await this.predictor!.run(feeds, [TABPFN35_PREDICTION_OUTPUT]);
    const output = outputs[TABPFN35_PREDICTION_OUTPUT];
    if (!output) throw new RuntimeError("RESULT_INVALID", "TabPFN predictor did not return logits");
    const dims = [...output.dims].map(Number);
    if (dims.length !== 3 || dims[0] !== predictionRows || dims[1] !== 1 || dims[2] !== TABPFN35_BIN_COUNT) throw new RuntimeError("RESULT_INVALID", "TabPFN predictor logits shape is not [rows, 1, 5000]");
    const data = numericData(output.data, TABPFN35_PREDICTION_OUTPUT);
    if (data.length !== predictionRows * TABPFN35_BIN_COUNT) throw new RuntimeError("RESULT_INVALID", "TabPFN predictor logits length does not match its shape");
    // The regression graph intentionally emits -Infinity for masked bins.
    // Preserve those zeros through the stable decoder; reject NaN/+Infinity.
    for (let index = 0; index < data.length; index += 1) if (Number.isNaN(data[index]) || data[index] === Infinity) throw new RuntimeError("RESULT_INVALID", `TabPFN predictor logits contain a non-finite value at ${index}`);
    return { data, dims };
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.loaded = false;
    const builder = this.builder;
    const predictor = this.predictor;
    this.builder = undefined;
    this.predictor = undefined;
    const errors: unknown[] = [];
    if (builder) await builder.release().catch((error) => errors.push(error));
    if (predictor) await predictor.release().catch((error) => errors.push(error));
    if (errors.length > 0) throw errors[0];
  }
}
