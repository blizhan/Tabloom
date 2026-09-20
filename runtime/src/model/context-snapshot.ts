import { RuntimeError } from "./errors";
import { sha256Hex } from "./identity";
import type { ContextSnapshot, RuntimeTensorSnapshot } from "./types";
import { TABPFN35_CACHE_NAMES } from "./tabpfn35/ort-runtime";

const MAGIC = "TABLOOM-CONTEXT-1\n";
const MAX_TENSOR_BYTES = 128 * 1024 * 1024;
function base64Encode(bytes: Uint8Array): string { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); if (typeof btoa !== "function") throw new RuntimeError("STORAGE_UNAVAILABLE", "Base64 encoder is unavailable"); return btoa(binary); }
function base64Decode(value: string): Uint8Array { if (typeof atob !== "function") throw new RuntimeError("STORAGE_UNAVAILABLE", "Base64 decoder is unavailable"); const binary = atob(value); const bytes = new Uint8Array(binary.length); for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i); return bytes; }
function jsonValue(value: unknown): unknown { if (value instanceof Float32Array) return { $typed: "f32", values: [...value] }; if (value instanceof Uint8Array) return { $typed: "u8", values: [...value] }; if (Array.isArray(value)) return value.map(jsonValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)])); return value; }
function fromJsonValue(value: unknown): unknown { if (value && typeof value === "object" && "$typed" in value) { const typed = value as { $typed: string; values: number[] }; if (typed.$typed === "f32") return new Float32Array(typed.values); if (typed.$typed === "u8") return new Uint8Array(typed.values); } if (Array.isArray(value)) return value.map(fromJsonValue); if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fromJsonValue(item)])); return value; }
function tensorMeta(tensor: RuntimeTensorSnapshot): Record<string, unknown> { return { name: tensor.name, dtype: tensor.dtype, shape: [...tensor.shape], checksum: tensor.checksum, bytes: base64Encode(tensor.bytes) }; }

export interface ContextSnapshotEnvelope { readonly format: "tabloom-context"; readonly version: 1; readonly snapshot: Omit<ContextSnapshot, "payload" | "estimatorState"> & { estimatorState: unknown; payload: ContextSnapshot["payload"] | { kind: "portable-tensors"; tensors: readonly Record<string, unknown>[] } }; }
export function validateContextSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
  if (!snapshot?.identity?.key || !/^[a-f0-9]{64}$/i.test(snapshot.identity.key) || snapshot.estimatorState?.schemaVersion !== 1 || !snapshot.featureNames?.length || !snapshot.provenance?.builtWithProvider) throw new RuntimeError("SNAPSHOT_CORRUPT", "Context snapshot metadata is incomplete");
  if (snapshot.payload.kind === "portable-tensors") {
    if (snapshot.identity.modelId === "tabpfn-3.5" && (snapshot.payload.tensors.length !== TABPFN35_CACHE_NAMES.length || snapshot.payload.tensors.some((tensor, index) => tensor.name !== TABPFN35_CACHE_NAMES[index]))) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "TabPFN context snapshot must contain cache_00 through cache_53 in order");
    for (const tensor of snapshot.payload.tensors) {
      const count = tensor.shape.reduce((total, value) => total * value, 1);
      if (!tensor.name || tensor.dtype !== "float32" || tensor.shape.length === 0 || tensor.shape.some((value) => !Number.isSafeInteger(value) || value <= 0) || !Number.isSafeInteger(count) || count <= 0 || count * 4 !== tensor.bytes.byteLength || tensor.bytes.byteLength > MAX_TENSOR_BYTES || !/^[a-f0-9]{64}$/i.test(tensor.checksum)) throw new RuntimeError("SNAPSHOT_CORRUPT", `Invalid tensor ${tensor.name}`);
    }
  }
  if (snapshot.payload.kind === "embedded-artifact" && snapshot.payload.manifestDigest !== snapshot.identity.artifactManifestDigest) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "Embedded artifact digest does not match identity");
  return snapshot;
}
export async function encodeContextSnapshot(snapshot: ContextSnapshot): Promise<Uint8Array> {
  validateContextSnapshot(snapshot); const payload = snapshot.payload.kind === "portable-tensors" ? { kind: "portable-tensors" as const, tensors: snapshot.payload.tensors.map(tensorMeta) } : snapshot.payload;
  const envelope: ContextSnapshotEnvelope = { format: "tabloom-context", version: 1, snapshot: { ...snapshot, estimatorState: jsonValue(snapshot.estimatorState), payload } as ContextSnapshotEnvelope["snapshot"] };
  return new TextEncoder().encode(MAGIC + JSON.stringify(envelope));
}
export function decodeContextSnapshot(bytes: Uint8Array): ContextSnapshot {
  const text = new TextDecoder().decode(bytes); if (!text.startsWith(MAGIC)) throw new RuntimeError("SNAPSHOT_CORRUPT", "Unknown context snapshot format");
  let envelope: ContextSnapshotEnvelope; try { envelope = JSON.parse(text.slice(MAGIC.length)) as ContextSnapshotEnvelope; } catch { throw new RuntimeError("SNAPSHOT_CORRUPT", "Context snapshot metadata is not valid JSON"); }
  if (envelope.format !== "tabloom-context" || envelope.version !== 1) throw new RuntimeError("SNAPSHOT_CORRUPT", "Unsupported context snapshot version");
  const raw = envelope.snapshot; const payload = raw.payload.kind === "portable-tensors" ? { kind: "portable-tensors" as const, tensors: raw.payload.tensors.map((item) => { const tensor = item as Record<string, unknown>; return { name: String(tensor.name), dtype: tensor.dtype as RuntimeTensorSnapshot["dtype"], shape: (Array.isArray(tensor.shape) ? tensor.shape : []).map(Number), bytes: base64Decode(String(tensor.bytes)), checksum: String(tensor.checksum) }; }) } : raw.payload;
  const snapshot = { ...raw, estimatorState: fromJsonValue(raw.estimatorState) as ContextSnapshot["estimatorState"], payload } as ContextSnapshot; validateContextSnapshot(snapshot); return snapshot;
}
export async function verifyContextSnapshot(snapshot: ContextSnapshot): Promise<void> { validateContextSnapshot(snapshot); if (snapshot.payload.kind === "portable-tensors") for (const tensor of snapshot.payload.tensors) if ((await sha256Hex(tensor.bytes)).toLowerCase() !== tensor.checksum.toLowerCase()) throw new RuntimeError("SNAPSHOT_CORRUPT", `Checksum mismatch for tensor ${tensor.name}`); }
export async function addTensorChecksums(snapshot: ContextSnapshot): Promise<ContextSnapshot> { if (snapshot.payload.kind !== "portable-tensors") return snapshot; const tensors = await Promise.all(snapshot.payload.tensors.map(async (tensor) => ({ ...tensor, checksum: await sha256Hex(tensor.bytes), bytes: new Uint8Array(tensor.bytes), shape: [...tensor.shape] }))); return { ...snapshot, payload: { kind: "portable-tensors", tensors } }; }
