import { RuntimeError } from "../model/errors";
import { addTensorChecksums, decodeContextSnapshot, encodeContextSnapshot, verifyContextSnapshot } from "../model/context-snapshot";
import type { ContextSnapshot } from "../model/types";
import { IndexedDbStore } from "./indexeddb-store";

export interface ContextStoreOptions { readonly storage?: IndexedDbStore; readonly allowMemoryFallback?: boolean; }
export class ContextStore {
  readonly storage: IndexedDbStore; private readonly memory = new Map<string, ContextSnapshot>(); private readonly loading = new Map<string, Promise<ContextSnapshot | undefined>>(); private readonly allowMemoryFallback: boolean;
  constructor(options: ContextStoreOptions = {}) { this.storage = options.storage ?? new IndexedDbStore(); this.allowMemoryFallback = options.allowMemoryFallback ?? true; }
  async save(snapshot: ContextSnapshot): Promise<{ persistent: boolean; warning?: string }> { const normalized = await addTensorChecksums(snapshot); const bytes = await encodeContextSnapshot(normalized); if (!this.storage.persistentAvailable) { if (!this.allowMemoryFallback) throw new RuntimeError("STORAGE_UNAVAILABLE", "IndexedDB is unavailable"); this.memory.set(normalized.identity.key, normalized); return { persistent: false, warning: "IndexedDB is unavailable; context is session-only" }; } try { await this.storage.put(normalized.identity.key, bytes); return { persistent: true }; } catch (error) { if (!this.allowMemoryFallback) throw error; this.memory.set(normalized.identity.key, normalized); return { persistent: false, warning: error instanceof Error ? error.message : String(error) }; } }
  async load(key: string): Promise<ContextSnapshot | undefined> {
    const memorySnapshot = this.memory.get(key); if (memorySnapshot) return memorySnapshot;
    const existing = this.loading.get(key); if (existing) return existing;
    const task = (async () => {
      const bytes = await this.storage.get(key);
      if (!bytes) return undefined;
      try { const snapshot = decodeContextSnapshot(bytes); await verifyContextSnapshot(snapshot); return snapshot; }
      catch { await this.storage.delete(key).catch(() => undefined); return undefined; }
    })();
    this.loading.set(key, task);
    try { return await task; } finally { if (this.loading.get(key) === task) this.loading.delete(key); }
  }
  async delete(key: string): Promise<void> { this.memory.delete(key); await this.storage.delete(key); }
  async has(key: string): Promise<boolean> { return Boolean(await this.load(key)); }
}
