import { RuntimeError } from "../model/errors";
import { sha256Hex } from "../model/identity";
import { IndexedDbStore } from "./indexeddb-store";

export type SnapshotFormat = "csv" | "parquet" | "arrow" | "json" | "duckdb" | "unknown";

export interface DataSnapshotDescriptor {
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly sourceName?: string;
  readonly format: SnapshotFormat;
  readonly jsonPath?: string;
  readonly typeInterpretation: Readonly<Record<string, string>>;
  readonly schemaVersion: number;
  readonly schemaDigest?: string;
  readonly sourceDigest: string;
  readonly logicalDigest?: string;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly size: number;
  readonly chunkCount: number;
  readonly createdAt: string;
  readonly complete: boolean;
}

export interface DataSnapshotInput {
  readonly snapshotId: string;
  readonly sourceId: string;
  readonly sourceName?: string;
  readonly format: SnapshotFormat;
  readonly jsonPath?: string;
  readonly typeInterpretation?: Readonly<Record<string, string>>;
  readonly schemaVersion?: number;
  readonly schemaDigest?: string;
  readonly logicalDigest?: string;
  readonly rowCount: number;
  readonly columns: readonly string[];
  readonly bytes: Uint8Array;
}

export interface StoredDataSnapshot {
  readonly descriptor: DataSnapshotDescriptor;
  readonly bytes: Uint8Array;
}

export interface DataSnapshotStoreOptions {
  readonly storage?: IndexedDbStore;
  readonly allowMemoryFallback?: boolean;
  readonly namespace?: string;
}

interface MemoryRecord extends StoredDataSnapshot {}
interface SnapshotIndex { readonly snapshotIds: readonly string[]; }

/**
 * Durable, immutable input snapshots.  Data is written before its complete
 * descriptor is published; a descriptor with `complete: false` is never
 * returned to a caller.  The existing IndexedDbStore supplies checksummed,
 * chunked binary writes while this class owns snapshot identity and indexing.
 */
export class DataSnapshotStore {
  readonly storage: IndexedDbStore;
  private readonly allowMemoryFallback: boolean;
  private readonly namespace: string;
  private readonly memory = new Map<string, MemoryRecord>();

  constructor(options: DataSnapshotStoreOptions = {}) {
    this.storage = options.storage ?? new IndexedDbStore({ dbName: "tabloom-workbench" });
    this.allowMemoryFallback = options.allowMemoryFallback ?? true;
    this.namespace = options.namespace ?? "snapshots";
  }

  async save(input: DataSnapshotInput): Promise<{ snapshot: DataSnapshotDescriptor; persistent: boolean; warning?: string }> {
    this.validateInput(input);
    const bytes = new Uint8Array(input.bytes);
    const sourceDigest = await sha256Hex(bytes);
    const existing = await this.get(input.snapshotId);
    if (existing && existing.descriptor.sourceDigest.toLowerCase() !== sourceDigest.toLowerCase()) throw new RuntimeError("INVALID_DATA", `Snapshot ${input.snapshotId} is immutable and already contains different bytes`);
    if (existing) return { snapshot: cloneDescriptor(existing.descriptor), persistent: this.storage.persistentAvailable };
    const descriptor: DataSnapshotDescriptor = {
      snapshotId: input.snapshotId,
      sourceId: input.sourceId,
      sourceName: input.sourceName,
      format: input.format,
      jsonPath: input.jsonPath,
      typeInterpretation: { ...(input.typeInterpretation ?? {}) },
      schemaVersion: input.schemaVersion ?? 1,
      schemaDigest: input.schemaDigest,
      sourceDigest,
      logicalDigest: input.logicalDigest,
      rowCount: input.rowCount,
      columns: [...input.columns],
      size: bytes.byteLength,
      chunkCount: Math.max(1, Math.ceil(bytes.byteLength / 8_388_608)),
      createdAt: new Date().toISOString(),
      complete: false,
    };
    const complete = { ...descriptor, complete: true } as DataSnapshotDescriptor;
    try {
      if (!this.storage.persistentAvailable) throw new RuntimeError("STORAGE_UNAVAILABLE", "IndexedDB is unavailable");
      await this.storage.put(this.metaKey(input.snapshotId), encodeJson(descriptor));
      await this.storage.put(this.dataKey(input.snapshotId), bytes);
      await this.storage.put(this.metaKey(input.snapshotId), encodeJson(complete));
      await this.addToIndex(input.snapshotId);
      this.memory.delete(input.snapshotId);
      return { snapshot: cloneDescriptor(complete), persistent: true };
    } catch (error) {
      if (!this.allowMemoryFallback) throw error;
      const warning = error instanceof Error ? error.message : String(error);
      const record = { descriptor: cloneDescriptor(complete), bytes };
      this.memory.set(input.snapshotId, record);
      return { snapshot: cloneDescriptor(complete), persistent: false, warning };
    }
  }

  async get(snapshotId: string): Promise<StoredDataSnapshot | undefined> {
    const memory = this.memory.get(snapshotId);
    if (memory) return cloneRecord(memory);
    const metadataBytes = await this.storage.get(this.metaKey(snapshotId));
    if (!metadataBytes) return undefined;
    const descriptor = decodeDescriptor(metadataBytes);
    if (!descriptor?.complete) return undefined;
    const bytes = await this.storage.get(this.dataKey(snapshotId));
    if (!bytes || bytes.byteLength !== descriptor.size || (await sha256Hex(bytes)).toLowerCase() !== descriptor.sourceDigest.toLowerCase()) {
      await this.removePersistent(snapshotId).catch(() => undefined);
      return undefined;
    }
    return { descriptor: cloneDescriptor(descriptor), bytes: new Uint8Array(bytes) };
  }

  async list(): Promise<readonly DataSnapshotDescriptor[]> {
    const result = new Map<string, DataSnapshotDescriptor>();
    for (const [id, record] of this.memory) result.set(id, cloneDescriptor(record.descriptor));
    const index = await this.readIndex();
    for (const id of index.snapshotIds) {
      if (result.has(id)) continue;
      const record = await this.get(id);
      if (record) result.set(id, record.descriptor);
    }
    return [...result.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async delete(snapshotId: string): Promise<void> {
    this.memory.delete(snapshotId);
    await this.removePersistent(snapshotId);
    const index = await this.readIndex();
    await this.writeIndex({ snapshotIds: index.snapshotIds.filter((id) => id !== snapshotId) });
  }

  private validateInput(input: DataSnapshotInput): void {
    if (!input.snapshotId || !input.sourceId || !input.format || !Number.isSafeInteger(input.rowCount) || input.rowCount < 0) throw new RuntimeError("INVALID_DATA", "Snapshot identity and row count are required");
    if (!Number.isSafeInteger(input.schemaVersion ?? 1) || (input.schemaVersion ?? 1) <= 0) throw new RuntimeError("INVALID_DATA", "Snapshot schema version must be positive");
    if (!input.bytes || !(input.bytes instanceof Uint8Array)) throw new RuntimeError("INVALID_DATA", "Snapshot bytes are required");
    if (new Set(input.columns).size !== input.columns.length) throw new RuntimeError("SCHEMA_MISMATCH", "Snapshot columns must be unique");
  }

  private dataKey(id: string): string { return `${this.namespace}:data:${id}`; }
  private metaKey(id: string): string { return `${this.namespace}:meta:${id}`; }
  private indexKey(): string { return `${this.namespace}:index`; }
  private async readIndex(): Promise<SnapshotIndex> {
    const bytes = await this.storage.get(this.indexKey()).catch(() => undefined);
    if (!bytes) return { snapshotIds: [] };
    try { const value = JSON.parse(new TextDecoder().decode(bytes)) as SnapshotIndex; return { snapshotIds: Array.isArray(value.snapshotIds) ? value.snapshotIds.filter((id): id is string => typeof id === "string") : [] }; }
    catch { return { snapshotIds: [] }; }
  }
  private async writeIndex(index: SnapshotIndex): Promise<void> { await this.storage.put(this.indexKey(), encodeJson({ snapshotIds: [...new Set(index.snapshotIds)] })); }
  private async addToIndex(id: string): Promise<void> { const index = await this.readIndex(); if (!index.snapshotIds.includes(id)) await this.writeIndex({ snapshotIds: [...index.snapshotIds, id] }); }
  private async removePersistent(id: string): Promise<void> { await Promise.all([this.storage.delete(this.dataKey(id)), this.storage.delete(this.metaKey(id))]); }
}

function encodeJson(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function decodeDescriptor(bytes: Uint8Array): DataSnapshotDescriptor | undefined {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as DataSnapshotDescriptor;
    if (!value || value.complete !== true || typeof value.snapshotId !== "string" || typeof value.sourceDigest !== "string") return undefined;
    return value;
  } catch { return undefined; }
}
function cloneDescriptor(value: DataSnapshotDescriptor): DataSnapshotDescriptor { return { ...value, columns: [...value.columns], typeInterpretation: { ...value.typeInterpretation } }; }
function cloneRecord(value: StoredDataSnapshot): StoredDataSnapshot { return { descriptor: cloneDescriptor(value.descriptor), bytes: new Uint8Array(value.bytes) }; }
