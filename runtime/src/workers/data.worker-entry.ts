import { RuntimeError } from "../model/errors";
import { DuckDbService } from "../data/duckdb-service";
import type { QueryDefinition } from "../workbench/types";
import { ReadonlyQueryService } from "../workbench/query-service";
import { DATA_PROTOCOL_VERSION, assertDataEnvelope, errorReply, type DataEnvelope, type DataReply, type DataRequestPayload } from "./data-protocol";

export interface DataWorkerHandlers {
  readonly capabilities?: () => unknown | Promise<unknown>;
  readonly importSource?: (payload: DataRequestPayload["importSource"]) => unknown | Promise<unknown>;
  readonly refreshSource?: (payload: DataRequestPayload["refreshSource"]) => unknown | Promise<unknown>;
  readonly inspectTable?: (payload: DataRequestPayload["inspectTable"]) => unknown | Promise<unknown>;
  readonly executeQuery?: (payload: QueryDefinition) => unknown | Promise<unknown>;
  readonly dispose?: () => void | Promise<void>;
}

export class DataWorkerDispatcher {
  readonly workerEpoch: string;
  private chain: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private readonly cancelled = new Set<string>();
  private readonly running = new Set<string>();
  constructor(private readonly handlers: DataWorkerHandlers = {}, workerEpoch = `data-${Date.now().toString(36)}`) { this.workerEpoch = workerEpoch; }
  dispatch(message: unknown): Promise<DataReply> {
    try { assertDataEnvelope(message); } catch (error) { return Promise.reject(error); }
    const envelope = message as DataEnvelope;
    if (envelope.operation === "cancel") {
      const target = (envelope.payload as { requestId?: string } | undefined)?.requestId ?? envelope.requestId;
      this.cancelled.add(target);
      return Promise.resolve({ kind: "cancelled", protocolVersion: DATA_PROTOCOL_VERSION, requestId: envelope.requestId, revision: envelope.revision, generation: envelope.generation, reason: "cancel acknowledged" });
    }
    if (envelope.operation === "status") return Promise.resolve(this.success(envelope, { running: [...this.running], cancelled: [...this.cancelled], disposed: this.disposed }));
    const run = this.chain.then(() => this.handle(envelope));
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
  private async handle(message: DataEnvelope): Promise<DataReply> {
    if (this.disposed && message.operation !== "dispose") return errorReply(message, new RuntimeError("ADAPTER_DISPOSED", "Data worker is disposed"));
    this.running.add(message.requestId);
    try {
      let result: unknown;
      switch (message.operation) {
        case "capabilities": result = await this.handlers.capabilities?.() ?? { query: false, import: false }; break;
        case "importSource": if (!this.handlers.importSource) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Data source import is not configured"); result = await this.handlers.importSource(message.payload as DataRequestPayload["importSource"]); break;
        case "refreshSource": if (!this.handlers.refreshSource) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Data source refresh is not configured"); result = await this.handlers.refreshSource(message.payload as DataRequestPayload["refreshSource"]); break;
        case "inspectTable": if (!this.handlers.inspectTable) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Table inspection is not configured"); result = await this.handlers.inspectTable(message.payload as DataRequestPayload["inspectTable"]); break;
        case "executeQuery": if (!this.handlers.executeQuery) throw new RuntimeError("UNSUPPORTED_CAPABILITY", "Query execution is not configured"); result = await this.handlers.executeQuery(message.payload as QueryDefinition); break;
        case "dispose": await this.handlers.dispose?.(); this.disposed = true; result = undefined; break;
        default: throw new RuntimeError("INVALID_DATA", `Unknown data worker operation: ${message.operation}`);
      }
      if (this.cancelled.delete(message.requestId)) return { kind: "cancelled", protocolVersion: DATA_PROTOCOL_VERSION, requestId: message.requestId, revision: message.revision, generation: message.generation, reason: "cancelled" };
      return this.success(message, result);
    } catch (error) { return errorReply(message, error); }
    finally { this.running.delete(message.requestId); }
  }
  private success(message: DataEnvelope, result: unknown): DataReply { return { kind: "success", protocolVersion: DATA_PROTOCOL_VERSION, requestId: message.requestId, revision: message.revision, generation: message.generation, result }; }
}

export interface DataWorkerReadyMessage { readonly kind: "ready"; readonly protocolVersion: typeof DATA_PROTOCOL_VERSION; readonly workerEpoch: string; }
export function installDataWorker(handlers: DataWorkerHandlers = {}): DataWorkerDispatcher {
  const scope = globalThis as unknown as { postMessage?: (message: unknown) => void; onmessage?: (event: MessageEvent) => void };
  const dispatcher = new DataWorkerDispatcher(handlers);
  if (typeof scope.postMessage !== "function") return dispatcher;
  scope.postMessage({ kind: "ready", protocolVersion: DATA_PROTOCOL_VERSION, workerEpoch: dispatcher.workerEpoch } satisfies DataWorkerReadyMessage);
  scope.onmessage = (event) => { void dispatcher.dispatch(event.data).then((reply) => scope.postMessage?.(reply), (error) => scope.postMessage?.(errorReply(event.data as DataEnvelope, error))); };
  return dispatcher;
}

/** A minimal default data worker for callers that only need a real DuckDB query boundary. */
export function createDuckDbDataWorker(service: DuckDbService): DataWorkerDispatcher {
  const queries = new ReadonlyQueryService(service);
  return new DataWorkerDispatcher({ executeQuery: (query) => queries.execute(query) });
}
