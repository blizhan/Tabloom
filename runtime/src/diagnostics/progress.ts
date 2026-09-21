export type ProgressStage = "loading" | "fitting" | "predicting" | "persisting" | "publishing" | "disposing";
export interface ProgressState { readonly requestId: string; readonly stage: ProgressStage; readonly completed: number | null; readonly total: number | null; readonly startedAt: number; readonly updatedAt: number; readonly warnings: readonly string[]; readonly status: "running" | "cancelled" | "complete" | "failed"; }
export class ProgressTracker {
  private readonly states = new Map<string, ProgressState>();
  private readonly listeners = new Set<(state: ProgressState) => void>();
  subscribe(listener: (state: ProgressState) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  start(requestId: string, stage: ProgressStage, total: number | null = null): ProgressState { const now = Date.now(); const state = { requestId, stage, completed: 0, total, startedAt: now, updatedAt: now, warnings: [], status: "running" as const }; this.states.set(requestId, state); this.notify(state); return state; }
  update(requestId: string, update: Partial<Pick<ProgressState, "stage" | "completed" | "total" | "warnings">>): ProgressState { const old = this.states.get(requestId); if (!old) return this.start(requestId, update.stage ?? "predicting", update.total ?? null); const next = { ...old, ...update, updatedAt: Date.now(), warnings: [...(update.warnings ?? old.warnings)] }; this.states.set(requestId, next); this.notify(next); return next; }
  finish(requestId: string, status: ProgressState["status"] = "complete"): ProgressState | undefined { const old = this.states.get(requestId); if (!old) return undefined; const next = { ...old, status, updatedAt: Date.now() }; this.states.set(requestId, next); this.notify(next); return next; }
  get(requestId: string): ProgressState | undefined { const state = this.states.get(requestId); return state ? { ...state, warnings: [...state.warnings] } : undefined; }
  all(): readonly ProgressState[] { return [...this.states.values()].map((state) => ({ ...state, warnings: [...state.warnings] })); }
  private notify(state: ProgressState): void { const copy = { ...state, warnings: [...state.warnings] }; for (const listener of this.listeners) listener(copy); }
}
