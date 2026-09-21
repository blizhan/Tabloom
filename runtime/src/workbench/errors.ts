import { RuntimeError, type RuntimeErrorCode, asRuntimeError } from "../model/errors";

export interface WorkbenchErrorDetails { readonly recovery?: readonly string[]; readonly requestId?: string; readonly details?: Record<string, unknown>; }
export class WorkbenchError extends RuntimeError {
  readonly recovery: readonly string[];
  readonly requestId?: string;
  constructor(code: RuntimeErrorCode, message: string, options: { stage?: string; retryable?: boolean; recovery?: readonly string[]; requestId?: string; details?: Record<string, unknown> } = {}) {
    super(code, message, options); this.name = "WorkbenchError"; this.recovery = options.recovery ?? []; this.requestId = options.requestId;
  }
}
export function asWorkbenchError(error: unknown, requestId?: string): WorkbenchError {
  if (error instanceof WorkbenchError) return error;
  const runtime = asRuntimeError(error); return new WorkbenchError(runtime.code, runtime.message, { stage: runtime.stage, retryable: runtime.retryable, details: runtime.details, requestId });
}
