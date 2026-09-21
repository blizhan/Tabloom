import { RuntimeError } from "../model/errors";
import { IndexedDbStore } from "./indexeddb-store";
import type { SplitPreset } from "../workbench/dataset-workflow";

export type WorkbenchProvider = "wasm" | "webgpu";
export type WorkbenchPrecision = "fp32" | "fp16-storage";

export interface WorkbenchExperimentDefinition {
  readonly experimentId: string;
  readonly revision: number;
  readonly name: string;
  readonly trainingQuery: string;
  readonly predictionQuery: string;
  readonly parameters?: readonly unknown[];
  readonly targetName?: string;
  readonly featureNames: readonly string[];
  readonly modelId: string;
  readonly provider: WorkbenchProvider;
  readonly precision: WorkbenchPrecision;
  readonly inputSnapshotId: string;
  readonly sourceBindings?: readonly { name: string; snapshotId: string }[];
  readonly xAxis?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dataset?: { readonly version: 1; readonly query: string; readonly snapshotId: string; readonly splitPreset?: SplitPreset };
}

export interface WorkbenchExperimentStoreOptions { readonly storage?: IndexedDbStore; readonly allowMemoryFallback?: boolean; readonly namespace?: string; }
interface ExperimentIndex { readonly revisions: Readonly<Record<string, readonly number[]>>; }

/** Stores immutable experiment revisions without retaining worker handles or credentials. */
export class WorkbenchExperimentStore {
  readonly storage: IndexedDbStore;
  private readonly allowMemoryFallback: boolean;
  private readonly namespace: string;
  private readonly memory = new Map<string, WorkbenchExperimentDefinition>();
  constructor(options: WorkbenchExperimentStoreOptions = {}) {
    this.storage = options.storage ?? new IndexedDbStore({ dbName: "tabloom-workbench" });
    this.allowMemoryFallback = options.allowMemoryFallback ?? true;
    this.namespace = options.namespace ?? "experiments";
  }

  async save(definition: WorkbenchExperimentDefinition): Promise<{ experiment: WorkbenchExperimentDefinition; persistent: boolean; warning?: string }> {
    const normalized = normalize(definition);
    const existing = await this.get(normalized.experimentId, normalized.revision);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) throw new RuntimeError("INVALID_DATA", `Experiment ${normalized.experimentId}@${normalized.revision} is immutable; save a new revision`);
    if (existing) return { experiment: clone(existing), persistent: this.storage.persistentAvailable };
    try {
      if (!this.storage.persistentAvailable) throw new RuntimeError("STORAGE_UNAVAILABLE", "IndexedDB is unavailable");
      await this.storage.put(this.key(normalized.experimentId, normalized.revision), encodeJson(normalized));
      const index = await this.readIndex();
      const revisions = [...(index.revisions[normalized.experimentId] ?? []), normalized.revision].filter((value, position, values) => values.indexOf(value) === position).sort((a, b) => a - b);
      await this.writeIndex({ revisions: { ...index.revisions, [normalized.experimentId]: revisions } });
      this.memory.delete(this.memoryKey(normalized.experimentId, normalized.revision));
      return { experiment: clone(normalized), persistent: true };
    } catch (error) {
      if (!this.allowMemoryFallback) throw error;
      this.memory.set(this.memoryKey(normalized.experimentId, normalized.revision), normalized);
      return { experiment: clone(normalized), persistent: false, warning: error instanceof Error ? error.message : String(error) };
    }
  }

  async get(experimentId: string, revision?: number): Promise<WorkbenchExperimentDefinition | undefined> {
    const selected = revision ?? (await this.latestRevision(experimentId));
    if (selected === undefined) return undefined;
    const memory = this.memory.get(this.memoryKey(experimentId, selected));
    if (memory) return clone(memory);
    const bytes = await this.storage.get(this.key(experimentId, selected));
    if (!bytes) return undefined;
    try { const value = normalize(JSON.parse(new TextDecoder().decode(bytes)) as WorkbenchExperimentDefinition); return clone(value); }
    catch { await this.storage.delete(this.key(experimentId, selected)).catch(() => undefined); return undefined; }
  }

  async list(experimentId?: string): Promise<readonly WorkbenchExperimentDefinition[]> {
    const index = await this.readIndex();
    const ids = experimentId ? [experimentId] : Object.keys(index.revisions);
    const result: WorkbenchExperimentDefinition[] = [];
    for (const id of ids) for (const revision of index.revisions[id] ?? []) { const value = await this.get(id, revision); if (value) result.push(value); }
    for (const value of this.memory.values()) if ((!experimentId || value.experimentId === experimentId) && !result.some((item) => item.experimentId === value.experimentId && item.revision === value.revision)) result.push(clone(value));
    return result.sort((a, b) => a.experimentId.localeCompare(b.experimentId) || a.revision - b.revision);
  }

  async delete(experimentId: string, revision?: number): Promise<void> {
    const revisions = revision === undefined ? (await this.readIndex()).revisions[experimentId] ?? [] : [revision];
    for (const value of revisions) { this.memory.delete(this.memoryKey(experimentId, value)); await this.storage.delete(this.key(experimentId, value)); }
    const index = await this.readIndex();
    const remaining = (index.revisions[experimentId] ?? []).filter((value) => !revisions.includes(value));
    const next = { ...index.revisions }; if (remaining.length) next[experimentId] = remaining; else delete next[experimentId];
    await this.writeIndex({ revisions: next });
  }

  private async latestRevision(id: string): Promise<number | undefined> { const values = (await this.readIndex()).revisions[id] ?? []; const memoryValues = [...this.memory.values()].filter((item) => item.experimentId === id).map((item) => item.revision); return [...values, ...memoryValues].sort((a, b) => b - a)[0]; }
  private key(id: string, revision: number): string { return `${this.namespace}:revision:${id}:${revision}`; }
  private memoryKey(id: string, revision: number): string { return `${id}:${revision}`; }
  private indexKey(): string { return `${this.namespace}:index`; }
  private async readIndex(): Promise<ExperimentIndex> { const bytes = await this.storage.get(this.indexKey()).catch(() => undefined); if (!bytes) return { revisions: {} }; try { const value = JSON.parse(new TextDecoder().decode(bytes)) as ExperimentIndex; return value?.revisions && typeof value.revisions === "object" ? value : { revisions: {} }; } catch { return { revisions: {} }; } }
  private async writeIndex(index: ExperimentIndex): Promise<void> { await this.storage.put(this.indexKey(), encodeJson(index)); }
}

function normalize(value: WorkbenchExperimentDefinition): WorkbenchExperimentDefinition {
  if (!value?.experimentId || !Number.isSafeInteger(value.revision) || value.revision < 1 || !value.name || !value.inputSnapshotId || !value.modelId) throw new RuntimeError("INVALID_DATA", "Experiment identity is incomplete");
  if (!Number.isSafeInteger(value.revision) || !["wasm", "webgpu"].includes(value.provider) || !["fp32", "fp16-storage"].includes(value.precision)) throw new RuntimeError("INVALID_DATA", "Experiment provider or precision is invalid");
  return { ...value, parameters: value.parameters ? value.parameters.map(stripCredential) : undefined, featureNames: [...value.featureNames], sourceBindings: value.sourceBindings?.map((binding) => ({ ...binding })), dataset: value.dataset ? { ...value.dataset, splitPreset: value.dataset.splitPreset ? { ...value.dataset.splitPreset } : undefined } : undefined };
}
function stripCredential(value: unknown): unknown { if (Array.isArray(value)) return value.map(stripCredential); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/(password|token|secret|authorization|credential)/i.test(key)).map(([key, item]) => [key, stripCredential(item)])); return value; }
function encodeJson(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(value)); }
function clone(value: WorkbenchExperimentDefinition): WorkbenchExperimentDefinition { return { ...value, parameters: value.parameters ? [...value.parameters] : undefined, featureNames: [...value.featureNames], sourceBindings: value.sourceBindings?.map((binding) => ({ ...binding })), dataset: value.dataset ? { ...value.dataset, splitPreset: value.dataset.splitPreset ? { ...value.dataset.splitPreset } : undefined } : undefined }; }
