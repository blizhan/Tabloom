import { RuntimeError } from "./errors";
import type { ContextIdentity, FittedState, ModelContext, RuntimeTensorSnapshot } from "./types";

export interface ContextBacking {
  readonly identity: ContextIdentity;
  readonly featureNames: readonly string[];
  readonly state?: FittedState;
  readonly tensors: readonly RuntimeTensorSnapshot[];
  readonly provenance?: { readonly sourceSnapshotId: string; readonly builtWithProvider: "webgpu" | "wasm" };
}
interface Entry { readonly backing: ContextBacking; refs: number; pins: number; released: boolean; }

export interface ContextResourceSnapshot {
  readonly cacheBytes: number;
  readonly peakCacheBytes: number;
  readonly contextCount: number;
  readonly handleCount: number;
  readonly pinnedHandles: number;
}

function cloneState(state: FittedState | undefined): FittedState | undefined {
  if (!state) return undefined;
  return { ...state, featureNames: [...state.featureNames], featureMeans: new Float32Array(state.featureMeans), featureScales: new Float32Array(state.featureScales), featurePermutation: [...state.featurePermutation], modelWeights: new Float32Array(state.modelWeights), extra: state.extra ? { ...state.extra } : undefined };
}
function cloneBacking(backing: ContextBacking): ContextBacking {
  return { ...backing, featureNames: [...backing.featureNames], state: cloneState(backing.state), tensors: backing.tensors.map((tensor) => ({ ...tensor, shape: [...tensor.shape], bytes: new Uint8Array(tensor.bytes) })), provenance: backing.provenance ? { ...backing.provenance } : undefined };
}

export class ContextRegistry {
  readonly instanceId: string;
  readonly workerEpoch: string;
  private readonly entries = new Map<string, Entry>();
  private readonly handles = new Map<string, string>();
  private sequence = 0;
  private disposed = false;
  private peakCacheBytes = 0;

  constructor(instanceId = `instance-${Math.random().toString(36).slice(2)}`, workerEpoch = `epoch-${Date.now().toString(36)}`) { this.instanceId = instanceId; this.workerEpoch = workerEpoch; }
  private ensureLive(): void { if (this.disposed) throw new RuntimeError("ADAPTER_DISPOSED", "Context registry is disposed"); }
  create(backingInput: ContextBacking): ModelContext {
    this.ensureLive();
    const key = backingInput.identity.key; let entry = this.entries.get(key);
    if (!entry || entry.released) { entry = { backing: cloneBacking(backingInput), refs: 0, pins: 0, released: false }; this.entries.set(key, entry); }
    entry.refs += 1; const handleId = `${this.instanceId}:context-${++this.sequence}`; this.handles.set(handleId, key);
    this.peakCacheBytes = Math.max(this.peakCacheBytes, this.cacheBytes());
    return { handleId, identity: entry.backing.identity, workerEpoch: this.workerEpoch, instanceId: this.instanceId, state: cloneState(entry.backing.state) };
  }
  private keyFor(context: ModelContext): string {
    if (context.instanceId !== this.instanceId || context.workerEpoch !== this.workerEpoch || !context.handleId.startsWith(`${this.instanceId}:`)) throw new RuntimeError("FOREIGN_CONTEXT", "Context handle belongs to another runtime instance");
    const key = this.handles.get(context.handleId); if (!key) throw new RuntimeError("CONTEXT_RELEASED", "Context handle has been released");
    const entry = this.entries.get(key); if (!entry || entry.released) throw new RuntimeError("CONTEXT_RELEASED", "Context backing has been released"); return key;
  }
  get(context: ModelContext): ContextBacking { return cloneBacking(this.entries.get(this.keyFor(context))!.backing); }
  pin(context: ModelContext): () => void {
    const key = this.keyFor(context); const entry = this.entries.get(key)!; entry.pins += 1; let done = false;
    return () => { if (done) return; done = true; entry.pins = Math.max(0, entry.pins - 1); this.collect(key, entry); };
  }
  release(context: ModelContext): void {
    if (context.instanceId !== this.instanceId || context.workerEpoch !== this.workerEpoch || !context.handleId.startsWith(`${this.instanceId}:`)) throw new RuntimeError("FOREIGN_CONTEXT", "Context handle belongs to another runtime instance");
    const key = this.handles.get(context.handleId); if (!key) return; // idempotent release in this instance
    this.handles.delete(context.handleId); const entry = this.entries.get(key); if (!entry) return; entry.refs = Math.max(0, entry.refs - 1); this.collect(key, entry);
  }
  private collect(key: string, entry: Entry): void { if (entry.refs === 0 && entry.pins === 0) { entry.released = true; this.entries.delete(key); } }
  has(identityKey: string): boolean { const entry = this.entries.get(identityKey); return Boolean(entry && !entry.released); }
  find(identityKey: string): ModelContext | undefined {
    const entry = this.entries.get(identityKey); if (!entry || entry.released) return undefined;
    return this.create(entry.backing);
  }
  export(context: ModelContext): ContextBacking { const releasePin = this.pin(context); try { return cloneBacking(this.entries.get(this.keyFor(context))!.backing); } finally { releasePin(); } }
  dispose(): void { if (this.disposed) return; this.disposed = true; this.entries.clear(); this.handles.clear(); }
  get size(): number { return this.entries.size; }
  /** Return only runtime-owned context storage facts. GPU allocations and
   * host-wide process memory remain intentionally unavailable. */
  resourceSnapshot(): ContextResourceSnapshot {
    let cacheBytes = 0;
    let pinnedHandles = 0;
    for (const entry of this.entries.values()) {
      cacheBytes += entry.backing.tensors.reduce((total, tensor) => total + tensor.bytes.byteLength, 0);
      pinnedHandles += entry.pins;
    }
    return { cacheBytes, peakCacheBytes: Math.max(this.peakCacheBytes, cacheBytes), contextCount: this.entries.size, handleCount: this.handles.size, pinnedHandles };
  }
  private cacheBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.backing.tensors.reduce((sum, tensor) => sum + tensor.bytes.byteLength, 0);
    return total;
  }
}
