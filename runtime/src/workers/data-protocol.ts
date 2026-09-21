import { RuntimeError, asRuntimeError, type RuntimeErrorCode } from "../model/errors";
import type { DataSnapshot, QueryDefinition } from "../workbench/types";
import type { WorkbenchErrorDetails } from "../workbench/errors";

export const DATA_PROTOCOL_VERSION = 1 as const;
export const DATA_OPERATIONS = ["capabilities", "importSource", "refreshSource", "inspectTable", "executeQuery", "cancel", "status", "dispose"] as const;
export type DataOperation = typeof DATA_OPERATIONS[number];
export interface DataEnvelope<T = unknown> { readonly protocolVersion: 1; readonly requestId: string; readonly revision?: number; readonly generation?: number; readonly operation: DataOperation; readonly payload: T; }
export interface DataProgress { readonly kind: "progress"; readonly protocolVersion: 1; readonly requestId: string; readonly revision?: number; readonly generation?: number; readonly stage: string; readonly completed: number | null; readonly total: number | null; }
export type DataReply<T = unknown> =
  | { readonly kind: "success"; readonly protocolVersion: 1; readonly requestId: string; readonly revision?: number; readonly generation?: number; readonly result: T }
  | { readonly kind: "failure"; readonly protocolVersion: 1; readonly requestId: string; readonly revision?: number; readonly generation?: number; readonly error: { readonly code: RuntimeErrorCode; readonly message: string; readonly stage?: string; readonly retryable: boolean; readonly recovery?: readonly string[]; readonly details?: Record<string, unknown> } }
  | { readonly kind: "cancelled" | "superseded"; readonly protocolVersion: 1; readonly requestId: string; readonly revision?: number; readonly generation?: number; readonly reason: string };
export type DataRequestPayload = { readonly capabilities: undefined; readonly importSource: { readonly snapshot: DataSnapshot; readonly data?: Uint8Array }; readonly refreshSource: { readonly sourceId: string; readonly snapshot: DataSnapshot; readonly data?: Uint8Array }; readonly inspectTable: { readonly snapshotId: string; readonly tableId: string }; readonly executeQuery: QueryDefinition; readonly cancel: { readonly requestId: string }; readonly status: undefined; readonly dispose: undefined };
export function assertDataEnvelope(input: unknown): asserts input is DataEnvelope {
  if (!input || typeof input !== "object") throw new RuntimeError("INVALID_DATA", "Data worker message must be an object");
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== DATA_PROTOCOL_VERSION || typeof value.requestId !== "string" || !value.requestId || typeof value.operation !== "string" || !(DATA_OPERATIONS as readonly string[]).includes(value.operation)) throw new RuntimeError("INVALID_DATA", "Invalid data worker envelope");
}
export function errorReply(message: DataEnvelope | unknown, error: unknown): DataReply {
  const value = message && typeof message === "object" ? message as Partial<DataEnvelope> : {};
  const runtime = asRuntimeError(error, "RESULT_INVALID"); const recovery = (runtime as unknown as { readonly recovery?: readonly string[] }).recovery;
  return { kind: "failure", protocolVersion: DATA_PROTOCOL_VERSION, requestId: typeof value.requestId === "string" ? value.requestId : "invalid-request", revision: value.revision, generation: value.generation, error: { code: runtime.code, message: runtime.message, stage: runtime.stage, retryable: runtime.retryable, ...(recovery ? { recovery } : {}), ...(runtime.details ? { details: runtime.details } : {}) } };
}
