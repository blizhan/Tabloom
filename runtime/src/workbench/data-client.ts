import { RuntimeError, asRuntimeError } from "../model/errors";
import { WorkbenchError } from "./errors";
import type { QueryDefinition } from "./types";
import { DATA_PROTOCOL_VERSION, type DataEnvelope, type DataOperation, type DataProgress, type DataReply } from "../workers/data-protocol";

export interface DataWorkerPort { postMessage(message: unknown, transfer?: readonly Transferable[]): void; addEventListener?(type: "message", listener: (event: MessageEvent) => void): void; removeEventListener?(type: "message", listener: (event: MessageEvent) => void): void; onmessage?: ((event: MessageEvent) => void) | null; }
export interface DataClientOptions { readonly requestId?: () => string; readonly onProgress?: (progress: DataProgress) => void; }
interface Pending { readonly requestId: string; readonly operation: DataOperation; readonly revision?: number; readonly generation?: number; resolve(value: unknown): void; reject(error: unknown): void; }

export class DataClient {
  private readonly pending = new Map<string, Pending>();
  private readonly nextId: () => string;
  private disposed = false;
  private readonly listener: (event: MessageEvent) => void;
  constructor(private readonly port: DataWorkerPort, private readonly options: DataClientOptions = {}) {
    let count = 0; this.nextId = options.requestId ?? (() => `data-request-${Date.now().toString(36)}-${(++count).toString(36)}`);
    this.listener = (event) => this.receive(event.data);
    if (port.addEventListener) port.addEventListener("message", this.listener); else port.onmessage = this.listener;
  }
  request<T>(operation: Exclude<DataOperation, "cancel" | "status" | "dispose">, payload: unknown, options: { revision?: number; generation?: number; transfer?: readonly Transferable[] } = {}): Promise<T> {
    if (this.disposed) return Promise.reject(new WorkbenchError("ADAPTER_DISPOSED", "Data client is disposed"));
    const requestId = this.nextId(); const envelope: DataEnvelope = { protocolVersion: DATA_PROTOCOL_VERSION, requestId, operation, payload, revision: options.revision, generation: options.generation };
    return new Promise<T>((resolve, reject) => { this.pending.set(requestId, { requestId, operation, revision: options.revision, generation: options.generation, resolve, reject }); try { this.port.postMessage(envelope, options.transfer); } catch (error) { this.pending.delete(requestId); reject(asRuntimeError(error)); } });
  }
  cancel(targetRequestId: string): Promise<void> {
    const requestId = this.nextId(); const envelope: DataEnvelope = { protocolVersion: DATA_PROTOCOL_VERSION, requestId, operation: "cancel", payload: { requestId: targetRequestId } };
    return new Promise<void>((resolve, reject) => { this.pending.set(requestId, { requestId, operation: "cancel", resolve, reject }); try { this.port.postMessage(envelope); } catch (error) { this.pending.delete(requestId); reject(error); } });
  }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; const requestId = this.nextId(); try { this.port.postMessage({ protocolVersion: DATA_PROTOCOL_VERSION, requestId, operation: "dispose", payload: undefined } satisfies DataEnvelope); } finally { for (const pending of this.pending.values()) pending.reject(new WorkbenchError("ADAPTER_DISPOSED", "Data client is disposed", { requestId: pending.requestId })); this.pending.clear(); if (this.port.removeEventListener) this.port.removeEventListener("message", this.listener); else this.port.onmessage = null; } }
  private receive(value: unknown): void {
    if (!value || typeof value !== "object") return;
    if ((value as { kind?: string }).kind === "progress") { this.options.onProgress?.(value as DataProgress); return; }
    const reply = value as DataReply; if (reply.protocolVersion !== DATA_PROTOCOL_VERSION || typeof reply.requestId !== "string") return;
    const pending = this.pending.get(reply.requestId); if (!pending) return; this.pending.delete(reply.requestId);
    if (pending.generation !== undefined && reply.generation !== undefined && reply.generation < pending.generation) { pending.reject(new WorkbenchError("STALE_REQUEST", "Stale data response", { requestId: reply.requestId })); return; }
    if (reply.kind === "success") { pending.resolve(reply.result); return; }
    if (reply.kind === "cancelled" || reply.kind === "superseded") { pending.reject(new WorkbenchError(reply.kind === "cancelled" ? "CANCELLED" : "STALE_REQUEST", reply.reason, { requestId: reply.requestId })); return; }
    if (reply.kind !== "failure") return;
    const failure = reply.error; pending.reject(new WorkbenchError(failure.code, failure.message, { stage: failure.stage, retryable: failure.retryable, recovery: failure.recovery, details: failure.details, requestId: reply.requestId }));
  }
}

export type DataQueryClient = Pick<DataClient, "request" | "cancel" | "dispose">;
