export type OperationEvent =
  | { readonly type: "started"; readonly operationId: string; readonly operation: string; readonly at: number }
  | { readonly type: "progress"; readonly operationId: string; readonly stage: string; readonly completed: number | null; readonly total: number | null; readonly at: number }
  | { readonly type: "finished"; readonly operationId: string; readonly status: "complete" | "cancelled" | "failed"; readonly message?: string; readonly at: number };

export type OperationEventListener = (event: OperationEvent) => void;

export class OperationEventBus {
  private readonly listeners = new Set<OperationEventListener>();
  private readonly historyByOperation = new Map<string, OperationEvent[]>();
  subscribe(listener: OperationEventListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event: OperationEvent): OperationEvent { const history = this.historyByOperation.get(event.operationId) ?? []; history.push(event); this.historyByOperation.set(event.operationId, history.slice(-100)); for (const listener of this.listeners) listener(event); return event; }
  history(operationId: string): readonly OperationEvent[] { return [...(this.historyByOperation.get(operationId) ?? [])]; }
  clear(operationId?: string): void { if (operationId) this.historyByOperation.delete(operationId); else this.historyByOperation.clear(); }
}
