import type { ExecutionProvider } from "./types";
import { RuntimeError } from "./errors";

/** A small structural surface keeps the worker boundary independent of ORT's
 * concrete Tensor/InferenceSession classes and makes the ownership rules
 * testable without starting a WASM or WebGPU backend. */
export interface OrtRuntimeModule {
  readonly env: { readonly wasm: { proxy?: boolean; wasmPaths?: unknown; numThreads?: number } };
  readonly Tensor: new (type: string, data: unknown, dims: readonly number[]) => {
    readonly type?: string;
    readonly data?: unknown;
    readonly dims?: readonly number[];
    readonly dispose?: () => void;
  };
  readonly InferenceSession: {
    create(model: Uint8Array, options?: unknown): Promise<OrtInferenceSession>;
  };
}

export interface OrtInferenceSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>, fetches?: readonly string[]): Promise<Record<string, unknown>>;
  release(): Promise<void>;
}

export interface OrtTensorInput {
  readonly type?: string;
  readonly data: unknown;
  readonly dims: readonly number[];
}

export interface OrtOutputValue {
  readonly data: unknown;
  readonly dims: readonly number[];
  readonly type?: string;
}

export interface OrtSessionOptions {
  readonly graph: Uint8Array;
  readonly externalData?: { readonly path: string; readonly bytes: Uint8Array };
  readonly provider: ExecutionProvider;
  readonly wasmPaths?: string | Record<string, string | URL>;
}

export interface OrtSessionDependencies {
  /** Test-only injection point; production callers use the provider-specific
   * onnxruntime-web module selected below. */
  readonly ortModule?: OrtRuntimeModule;
}

export interface OrtSessionHandle {
  readonly provider: ExecutionProvider;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, unknown>, fetches?: readonly string[]): Promise<Record<string, OrtOutputValue>>;
  release(): Promise<void>;
}

async function loadOrtModule(provider: ExecutionProvider): Promise<OrtRuntimeModule> {
  // The provider-specific entry points avoid pulling the WebGPU JSEP backend
  // into WASM-only validation and make the selected backend explicit in the
  // worker bundle. Both entries expose the same public ORT API.
  const module = provider === "webgpu" ? await import("onnxruntime-web/webgpu") : await import("onnxruntime-web/wasm");
  return module as unknown as OrtRuntimeModule;
}

function isTensorInput(value: unknown): value is OrtTensorInput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.dims) && "data" in candidate && typeof candidate.dispose !== "function";
}

function copyView(value: unknown): unknown {
  if (value instanceof Float32Array) return new Float32Array(value);
  if (value instanceof Float64Array) return new Float64Array(value);
  if (value instanceof Int8Array) return new Int8Array(value);
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof Uint8ClampedArray) return new Uint8ClampedArray(value);
  if (value instanceof Int16Array) return new Int16Array(value);
  if (value instanceof Uint16Array) return new Uint16Array(value);
  if (value instanceof Int32Array) return new Int32Array(value);
  if (value instanceof Uint32Array) return new Uint32Array(value);
  if (value instanceof BigInt64Array) return new BigInt64Array(value);
  if (value instanceof BigUint64Array) return new BigUint64Array(value);
  if (Array.isArray(value)) return [...value];
  return value;
}

function copyDims(value: unknown): readonly number[] {
  return Array.isArray(value) ? value.map(Number) : [];
}

/**
 * Create an ORT session whose native objects never leave the model worker.
 * `run()` accepts plain tensor descriptors, creates provider-local ORT
 * tensors, and returns detached data/dims copies for the caller.
 */
export async function createOrtSession(options: OrtSessionOptions, dependencies: OrtSessionDependencies = {}): Promise<OrtSessionHandle> {
  const ort = dependencies.ortModule ?? await loadOrtModule(options.provider);
  if (options.provider === "wasm" || options.wasmPaths !== undefined) {
    ort.env.wasm.proxy = false;
    // A module worker already owns the ORT session. Keep WASM execution in
    // that worker unless a future benchmark explicitly opts into pthreads;
    // this avoids nested worker asset/CORP races and preserves deterministic
    // ownership of the model memory.
    ort.env.wasm.numThreads = 1;
    if (options.wasmPaths !== undefined) ort.env.wasm.wasmPaths = options.wasmPaths;
  }

  const externalData = options.externalData ? [{ path: options.externalData.path, data: options.externalData.bytes }] : undefined;
  let session: OrtInferenceSession;
  try {
    session = await ort.InferenceSession.create(options.graph, {
      executionProviders: [options.provider],
      ...(externalData ? { externalData } : {}),
    });
  } catch (error) {
    throw new RuntimeError("PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : String(error), { retryable: true });
  }

  let released = false;
  return {
    provider: options.provider,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
    async run(feeds, fetches) {
      if (released) throw new RuntimeError("ADAPTER_DISPOSED", "ORT session has been released");
      const ownedTensors: Array<{ dispose?: () => void }> = [];
      const outputTensors: Array<{ dispose?: () => void }> = [];
      try {
        const ortFeeds: Record<string, unknown> = {};
        for (const [name, feed] of Object.entries(feeds)) {
          if (isTensorInput(feed)) {
            const tensor = new ort.Tensor(feed.type ?? "float32", copyView(feed.data), [...feed.dims]);
            ortFeeds[name] = tensor;
            ownedTensors.push(tensor);
          } else {
            ortFeeds[name] = feed;
          }
        }
        const result = fetches === undefined ? await session.run(ortFeeds) : await session.run(ortFeeds, fetches);
        const copied: Record<string, OrtOutputValue> = {};
        for (const [name, value] of Object.entries(result)) {
          const tensor = value as { data?: unknown; dims?: readonly number[]; type?: string; getData?: (releaseData?: boolean) => Promise<unknown>; dispose?: () => void };
          outputTensors.push(tensor);
          let data: unknown;
          try { data = tensor.data; } catch { data = undefined; }
          if (data === undefined && typeof tensor.getData === "function") data = await tensor.getData(true);
          copied[name] = { data: copyView(data), dims: copyDims(tensor.dims), ...(typeof tensor.type === "string" ? { type: tensor.type } : {}) };
        }
        return copied;
      } catch (error) {
        if (error instanceof RuntimeError) throw error;
        throw new RuntimeError("RESULT_INVALID", error instanceof Error ? error.message : String(error));
      } finally {
        for (const tensor of outputTensors) tensor.dispose?.();
        for (const tensor of ownedTensors) tensor.dispose?.();
      }
    },
    async release() {
      if (released) return;
      released = true;
      await session.release();
    },
  };
}
