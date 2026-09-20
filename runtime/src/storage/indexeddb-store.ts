import { RuntimeError } from "../model/errors";
import { sha256Hex } from "../model/identity";

export const CHUNK_BYTES = 8 * 1024 * 1024;
export interface BinaryEntryManifest { readonly key: string; readonly generation: string; readonly size: number; readonly sha256: string; readonly chunkCount: number; readonly createdAt: string; }
interface MemoryRecord { manifest: BinaryEntryManifest; chunks: Uint8Array[]; }
interface PersistentRecord { manifest: BinaryEntryManifest; chunks?: Uint8Array[]; }
export interface IndexedDbStoreOptions { readonly dbName?: string; readonly indexedDB?: IDBFactory; readonly fault?: (operation: string) => void; }

export class IndexedDbStore {
  private readonly memory = new Map<string, MemoryRecord>(); private readonly options: IndexedDbStoreOptions; private db?: IDBDatabase; private openPromise?: Promise<IDBDatabase | undefined>;
  constructor(options: IndexedDbStoreOptions = {}) { this.options = options; }
  get persistentAvailable(): boolean { return Boolean(this.options.indexedDB ?? globalThis.indexedDB); }
  private async open(): Promise<IDBDatabase | undefined> {
    if (this.db) return this.db; if (this.openPromise) return this.openPromise; const factory = this.options.indexedDB ?? globalThis.indexedDB; if (!factory) return undefined;
    this.openPromise = new Promise((resolve, reject) => { const request = factory.open(this.options.dbName ?? "tabloom-runtime", 1); request.onupgradeneeded = () => { const db = request.result; if (!db.objectStoreNames.contains("entries")) db.createObjectStore("entries", { keyPath: "key" }); if (!db.objectStoreNames.contains("chunks")) db.createObjectStore("chunks", { keyPath: ["key", "generation", "index"] }); if (!db.objectStoreNames.contains("writes")) db.createObjectStore("writes", { keyPath: ["key", "generation"] }); }; request.onsuccess = () => { this.db = request.result; resolve(this.db); }; request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed")); });
    return this.openPromise;
  }
  async put(key: string, bytes: Uint8Array): Promise<BinaryEntryManifest> {
    if (!key) throw new RuntimeError("INVALID_DATA", "Storage key is required"); this.options.fault?.("put:start"); const digest = await sha256Hex(bytes); const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; const chunks: Uint8Array[] = []; for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) chunks.push(new Uint8Array(bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength)))); if (!chunks.length) chunks.push(new Uint8Array()); const manifest = { key, generation, size: bytes.byteLength, sha256: digest, chunkCount: chunks.length, createdAt: new Date().toISOString() };
    const db = await this.open(); if (!db) { this.memory.set(key, { manifest, chunks }); return manifest; }
    try { await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["entries", "chunks", "writes"], "readwrite");
      const entries = tx.objectStore("entries"); const chunkStore = tx.objectStore("chunks"); const writes = tx.objectStore("writes");
      const previousRequest = entries.get(key);
      previousRequest.onsuccess = () => {
        const previous = previousRequest.result as BinaryEntryManifest | undefined;
        writes.put({ ...manifest });
        chunks.forEach((chunk, index) => chunkStore.put({ key, generation, index, bytes: chunk.buffer }));
        entries.put(manifest);
        writes.delete([key, generation]);
        if (previous && previous.generation !== generation) for (let index = 0; index < previous.chunkCount; index += 1) chunkStore.delete([key, previous.generation, index]);
      };
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error("IndexedDB write failed")); tx.onabort = () => reject(tx.error ?? new Error("IndexedDB write aborted"));
    }); } catch (error) { throw new RuntimeError("CACHE_QUOTA", error instanceof Error ? error.message : String(error), { retryable: true }); }
    return manifest;
  }
  async get(key: string): Promise<Uint8Array | undefined> {
    this.options.fault?.("get"); const record = this.memory.get(key); if (record) { const bytes = concat(record.chunks); if (bytes.byteLength !== record.manifest.size || await sha256Hex(bytes) !== record.manifest.sha256) { this.memory.delete(key); return undefined; } return bytes; }
    const db = await this.open(); if (!db) return undefined; const stored = await this.readRecord(db, key); if (!stored) return undefined; if (!stored.chunks) { await this.deleteGenerationIfCurrent(db, key, stored.manifest.generation); return undefined; } const bytes = concat(stored.chunks); if (bytes.byteLength !== stored.manifest.size || await sha256Hex(bytes) !== stored.manifest.sha256) { await this.deleteGenerationIfCurrent(db, key, stored.manifest.generation); return undefined; } return bytes;
  }
  async getManifest(key: string): Promise<BinaryEntryManifest | undefined> { const memory = this.memory.get(key)?.manifest; if (memory) return memory; const db = await this.open(); return db ? this.readEntry(db, key) : undefined; }
  async delete(key: string): Promise<void> { this.memory.delete(key); const db = await this.open(); if (!db) return; await new Promise<void>((resolve, reject) => { const tx = db.transaction(["entries", "chunks"], "readwrite"); tx.objectStore("entries").delete(key); const request = tx.objectStore("chunks").openCursor(); request.onsuccess = () => { const cursor = request.result; if (!cursor) return; const value = cursor.value as { key: string }; if (value.key === key) cursor.delete(); cursor.continue(); }; tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
  async clear(): Promise<void> { this.memory.clear(); const db = await this.open(); if (!db) return; await new Promise<void>((resolve, reject) => { const tx = db.transaction(["entries", "chunks", "writes"], "readwrite"); tx.objectStore("entries").clear(); tx.objectStore("chunks").clear(); tx.objectStore("writes").clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); }); }
  private readEntry(db: IDBDatabase, key: string): Promise<BinaryEntryManifest | undefined> { return new Promise((resolve, reject) => { const request = db.transaction("entries", "readonly").objectStore("entries").get(key); request.onsuccess = () => resolve(request.result as BinaryEntryManifest | undefined); request.onerror = () => reject(request.error); }); }
  private readRecord(db: IDBDatabase, key: string): Promise<PersistentRecord | undefined> { return new Promise((resolve, reject) => {
    const tx = db.transaction(["entries", "chunks"], "readonly"); const entries = tx.objectStore("entries"); const chunkStore = tx.objectStore("chunks");
    let manifest: BinaryEntryManifest | undefined; const chunks: Array<Uint8Array | undefined> = [];
    const manifestRequest = entries.get(key);
    manifestRequest.onsuccess = () => {
      manifest = manifestRequest.result as BinaryEntryManifest | undefined;
      if (!manifest) return;
      for (let index = 0; index < manifest.chunkCount; index += 1) {
        const chunkRequest = chunkStore.get([key, manifest.generation, index]);
        chunkRequest.onsuccess = () => { const value = chunkRequest.result as { bytes?: ArrayBuffer } | undefined; chunks[index] = value?.bytes ? new Uint8Array(value.bytes) : undefined; };
      }
    };
    tx.oncomplete = () => resolve(manifest ? { manifest, chunks: chunks.length === manifest.chunkCount && chunks.every(Boolean) ? chunks as Uint8Array[] : undefined } : undefined);
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB read failed")); tx.onabort = () => reject(tx.error ?? new Error("IndexedDB read aborted"));
  }); }
  private deleteGenerationIfCurrent(db: IDBDatabase, key: string, generation: string): Promise<void> { return new Promise((resolve, reject) => {
    const tx = db.transaction(["entries", "chunks"], "readwrite"); const entries = tx.objectStore("entries"); const chunks = tx.objectStore("chunks"); const request = entries.get(key);
    request.onsuccess = () => { const current = request.result as BinaryEntryManifest | undefined; if (current?.generation !== generation) return; entries.delete(key); for (let index = 0; index < current.chunkCount; index += 1) chunks.delete([key, generation, index]); };
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error("IndexedDB cleanup failed")); tx.onabort = () => reject(tx.error ?? new Error("IndexedDB cleanup aborted"));
  }); }
}
function concat(chunks: readonly Uint8Array[]): Uint8Array { const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0); const out = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; } return out; }
