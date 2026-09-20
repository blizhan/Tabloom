import { RuntimeError } from "../model/errors";

export type ScheduleMode = "interactive" | "experiment";
export interface CancellationToken { readonly requestId: string; readonly signal: AbortSignal; readonly cancelled: boolean; cancel(): void; }
export interface ScheduledRequest<T> { readonly requestId: string; readonly streamId: string; readonly mode: ScheduleMode; readonly generation: number; readonly run: (token: CancellationToken) => Promise<T>; }
export interface ScheduleOutcome<T> { readonly requestId: string; readonly status: "published" | "cancelled" | "superseded" | "failed"; readonly value?: T; readonly error?: unknown; }
interface Entry<T> extends ScheduledRequest<T> { token: Token; resolve: (outcome: ScheduleOutcome<T>) => void; settled: boolean; }
class Token implements CancellationToken { readonly controller = new AbortController(); cancelled = false; constructor(readonly requestId: string) {} get signal(): AbortSignal { return this.controller.signal; } cancel(): void { if (this.cancelled) return; this.cancelled = true; this.controller.abort(); } }
const MAX_FINISHED_STATUSES = 1024;

export class Scheduler {
  private readonly queue: Entry<unknown>[] = []; private readonly pending = new Map<string, Entry<unknown>>(); private readonly running = new Map<string, Entry<unknown>>(); private readonly all = new Map<string, Entry<unknown>>(); private readonly finished = new Map<string, ScheduleOutcome<unknown>["status"]>(); private readonly idleResolvers = new Set<() => void>(); private pumping = false; private disposed = false;
  enqueue<T>(request: ScheduledRequest<T>): Promise<ScheduleOutcome<T>> {
    if (this.disposed) return Promise.reject(new RuntimeError("ADAPTER_DISPOSED", "Scheduler is disposed"));
    if (this.all.has(request.requestId) || this.finished.has(request.requestId)) return Promise.reject(new RuntimeError("INVALID_DATA", "Duplicate request id"));
    return new Promise<ScheduleOutcome<T>>((resolve) => {
      const entry = { ...request, token: new Token(request.requestId), resolve: resolve as (outcome: ScheduleOutcome<unknown>) => void, settled: false } as Entry<unknown>; this.all.set(request.requestId, entry);
      if (request.mode === "interactive") {
        const old = this.pending.get(request.streamId); if (old) this.finish(old, { requestId: old.requestId, status: "superseded" });
        const queued = this.queue.find((candidate) => candidate.streamId === request.streamId && candidate.mode === "interactive");
        if (queued) { this.finish(queued, { requestId: queued.requestId, status: "superseded" }); this.queue.splice(this.queue.indexOf(queued), 1); }
        this.pending.set(request.streamId, entry); if (!this.running.has(request.streamId)) this.promotePending(request.streamId);
      } else this.queue.push(entry);
      void this.pump();
    });
  }
  private promotePending(streamId: string): void { const entry = this.pending.get(streamId); if (!entry) return; this.pending.delete(streamId); this.queue.push(entry); }
  private async pump(): Promise<void> { if (this.pumping) return; this.pumping = true; try { while (!this.disposed && this.queue.length) { const entry = this.queue.shift()!; if (entry.settled) continue; this.running.set(entry.streamId, entry); let outcome: ScheduleOutcome<unknown>; try { const value = await entry.run(entry.token); outcome = { requestId: entry.requestId, status: entry.token.cancelled ? "cancelled" : "published", value }; } catch (error) { outcome = { requestId: entry.requestId, status: entry.token.cancelled ? "cancelled" : "failed", error }; } finally { this.running.delete(entry.streamId); }
        this.finish(entry, outcome); if (entry.mode === "interactive" && this.pending.has(entry.streamId)) this.promotePending(entry.streamId);
      } } finally { this.pumping = false; if (!this.queue.length && !this.running.size && !this.pending.size) { for (const resolve of this.idleResolvers) resolve(); this.idleResolvers.clear(); } } }
  private finish(entry: Entry<unknown>, outcome: ScheduleOutcome<unknown>): void { if (entry.settled) return; entry.settled = true; this.all.delete(entry.requestId); this.finished.set(entry.requestId, outcome.status); while (this.finished.size > MAX_FINISHED_STATUSES) this.finished.delete(this.finished.keys().next().value!); entry.resolve(outcome); }
  cancel(requestId: string, reason = "cancelled"): boolean { const entry = this.all.get(requestId); if (!entry || entry.settled) return false; entry.token.cancel(); if (this.pending.get(entry.streamId) === entry) { this.pending.delete(entry.streamId); this.finish(entry, { requestId, status: "cancelled", error: reason }); } else { const index = this.queue.indexOf(entry); if (index >= 0) { this.queue.splice(index, 1); this.finish(entry, { requestId, status: "cancelled", error: reason }); } } return true; }
  status(requestId: string): "queued" | "running" | "published" | "failed" | "cancelled" | "superseded" | "unknown" { const entry = this.all.get(requestId); if (entry) return this.running.get(entry.streamId) === entry ? "running" : "queued"; return this.finished.get(requestId) ?? "unknown"; }
  async waitForIdle(): Promise<void> { if (!this.queue.length && !this.running.size && !this.pending.size) return; await new Promise<void>((resolve) => { this.idleResolvers.add(resolve); }); }
  async dispose(): Promise<void> { if (this.disposed) return; this.disposed = true; for (const entry of this.pending.values()) { entry.token.cancel(); this.finish(entry, { requestId: entry.requestId, status: "cancelled" }); } this.pending.clear(); for (const entry of this.queue) { entry.token.cancel(); this.finish(entry, { requestId: entry.requestId, status: "cancelled" }); } this.queue.length = 0; for (const entry of this.running.values()) entry.token.cancel(); await this.waitForIdle(); this.finished.clear(); }
}
