export type RuntimeErrorCode =
  | "INVALID_DATA" | "SCHEMA_MISMATCH" | "SHAPE_UNSUPPORTED" | "UNSUPPORTED_CAPABILITY"
  | "NONFINITE_TARGET" | "INF_DISABLED" | "NUMERIC_OVERFLOW" | "ARTIFACT_MISMATCH"
  | "SNAPSHOT_CORRUPT" | "CONTEXT_INCOMPATIBLE" | "CONTEXT_RELEASED" | "FOREIGN_CONTEXT"
  | "PROVIDER_UNAVAILABLE" | "DEVICE_LOST" | "ADAPTER_DISPOSED" | "RESULT_INVALID"
  | "STALE_REQUEST" | "CANCELLED" | "CACHE_QUOTA" | "STORAGE_UNAVAILABLE"
  | "SOURCE_UNREACHABLE" | "SOURCE_EXPIRED" | "SOURCE_TIMEOUT" | "SOURCE_TOO_LARGE"
  | "CORS_OR_NETWORK" | "INVALID_FORMAT" | "TYPE_LOSS" | "NAME_CONFLICT"
  | "INVALID_QUERY" | "EMPTY_INPUT" | "INVALID_TARGET" | "FEATURE_MISMATCH"
  | "INPUT_LIMIT" | "CACHE_UNAVAILABLE" | "CACHE_CORRUPT" | "EXPORT_FAILED";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly stage?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: RuntimeErrorCode, message: string, options: { stage?: string; retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.stage = options.stage;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export function runtimeError(code: RuntimeErrorCode, message: string, options?: ConstructorParameters<typeof RuntimeError>[2]): RuntimeError {
  return new RuntimeError(code, message, options);
}

export function asRuntimeError(error: unknown, fallbackCode: RuntimeErrorCode = "RESULT_INVALID"): RuntimeError { return error instanceof RuntimeError ? error : new RuntimeError(fallbackCode, error instanceof Error ? error.message : String(error)); }
