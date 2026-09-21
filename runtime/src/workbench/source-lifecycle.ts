import type { DataSnapshotDescriptor } from "../storage/data-snapshot-store";
import { DataSnapshotStore } from "../storage/data-snapshot-store";

export interface SourceVersion { readonly sourceId: string; readonly alias: string; readonly version: number; readonly snapshotId: string; readonly digest: string; readonly createdAt: string; readonly references: number; }

/** Keeps refreshes immutable and prevents collection of snapshots in use by experiments/results. */
export class SourceLifecycle {
  private readonly sources = new Map<string, SourceVersion>();
  constructor(readonly snapshots: DataSnapshotStore = new DataSnapshotStore()) {}
  register(alias: string, descriptor: DataSnapshotDescriptor): SourceVersion { const version = [...this.sources.values()].filter((value) => value.sourceId === descriptor.sourceId).reduce((max, value) => Math.max(max, value.version), 0) + 1; const source = { sourceId: descriptor.sourceId, alias, version, snapshotId: descriptor.snapshotId, digest: descriptor.sourceDigest, createdAt: descriptor.createdAt, references: 0 }; this.sources.set(this.key(descriptor.sourceId, version), source); return clone(source); }
  refresh(sourceId: string, alias: string, descriptor: DataSnapshotDescriptor): SourceVersion { return this.register(alias, { ...descriptor, sourceId }); }
  list(): readonly SourceVersion[] { return [...this.sources.values()].map(clone).sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.version - b.version); }
  retain(sourceId: string, version: number): SourceVersion { const source = this.require(sourceId, version); const next = { ...source, references: source.references + 1 }; this.sources.set(this.key(sourceId, version), next); return clone(next); }
  release(sourceId: string, version: number): SourceVersion | undefined { const source = this.sources.get(this.key(sourceId, version)); if (!source) return undefined; const next = { ...source, references: Math.max(0, source.references - 1) }; this.sources.set(this.key(sourceId, version), next); return clone(next); }
  async collectUnreferenced(): Promise<readonly string[]> { const removed: string[] = []; const latest = new Map<string, number>(); for (const source of this.sources.values()) latest.set(source.sourceId, Math.max(latest.get(source.sourceId) ?? 0, source.version)); for (const [key, source] of this.sources) if (source.references === 0 && source.version < (latest.get(source.sourceId) ?? source.version)) { await this.snapshots.delete(source.snapshotId); this.sources.delete(key); removed.push(source.snapshotId); } return removed; }
  private require(sourceId: string, version: number): SourceVersion { const source = this.sources.get(this.key(sourceId, version)); if (!source) throw new Error(`Unknown source version: ${sourceId}@${version}`); return source; }
  private key(sourceId: string, version: number): string { return `${sourceId}:${version}`; }
}
function clone(value: SourceVersion): SourceVersion { return { ...value }; }
