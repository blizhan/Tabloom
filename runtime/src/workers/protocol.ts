import { RuntimeError } from "../model/errors";

export const PROTOCOL_VERSION = 1 as const;
export const KNOWN_OPERATIONS = ["capabilities", "load", "fitContext", "importContext", "exportContext", "predict", "releaseContext", "cancel", "status", "dispose"] as const;
export interface WorkerEnvelope<T = unknown> { protocolVersion: 1; workerEpoch: string; requestId: string; operation: string; payload: T; }
export interface WorkerProgress { kind: "progress"; protocolVersion: 1; workerEpoch: string; requestId: string; stage: string; completed: number | null; total: number | null; warnings: string[]; }
export type WorkerReply<T = unknown> =
  | { kind: "success"; protocolVersion: 1; workerEpoch: string; requestId: string; result: T }
  | { kind: "failure"; protocolVersion: 1; workerEpoch: string; requestId: string; error: Pick<RuntimeError, "code" | "message" | "stage" | "retryable"> }
  | { kind: "cancelled" | "superseded"; protocolVersion: 1; workerEpoch: string; requestId: string; reason: string };

export function assertEnvelope(input: unknown): asserts input is WorkerEnvelope {
  if (!input || typeof input !== "object") throw new RuntimeError("INVALID_DATA", "Worker message must be an object");
  const value = input as Record<string, unknown>;
  if (value.protocolVersion !== PROTOCOL_VERSION || typeof value.workerEpoch !== "string" || typeof value.requestId !== "string" || typeof value.operation !== "string" || !(KNOWN_OPERATIONS as readonly string[]).includes(value.operation)) {
    throw new RuntimeError("INVALID_DATA", "Invalid worker envelope");
  }
}

export function isTerminalReply(value: WorkerReply | WorkerProgress): value is WorkerReply { return value.kind === "success" || value.kind === "failure" || value.kind === "cancelled" || value.kind === "superseded"; }

export class ReplyTracker {
  private readonly terminal = new Set<string>();
  accept(reply: WorkerReply | WorkerProgress): void {
    if (reply.protocolVersion !== PROTOCOL_VERSION) throw new RuntimeError("INVALID_DATA", "Unknown worker protocol version");
    if (!isTerminalReply(reply)) return;
    if (this.terminal.has(reply.requestId)) throw new RuntimeError("RESULT_INVALID", `Duplicate terminal reply for ${reply.requestId}`);
    this.terminal.add(reply.requestId);
  }
  hasTerminal(requestId: string): boolean { return this.terminal.has(requestId); }
}
