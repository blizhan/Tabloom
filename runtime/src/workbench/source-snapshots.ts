import { RuntimeError } from "../model/errors";
import { sha256Hex } from "../model/identity";
import type { DataSnapshot, SourceDescriptor, SourceFormat } from "./types";
import type { DecodedTable } from "./file-codecs";

export interface SnapshotRegistration {
  readonly sourceId: string;
  readonly name: string;
  readonly kind?: SourceDescriptor["kind"];
  readonly format: SourceFormat;
  readonly mediaType?: string;
  readonly url?: string;
  readonly typeInterpretation?: Readonly<Record<string, string>>;
  readonly bytes: Uint8Array;
  readonly decoded: DecodedTable;
}

/** Creates the immutable identity used by both the database table and the
 * persistence layer.  The raw digest and logical digest are intentionally
 * separate: formatting changes are visible without changing row semantics. */
export async function createDataSnapshot(input: SnapshotRegistration): Promise<DataSnapshot> {
  if (!input.sourceId || !input.name) throw new RuntimeError("INVALID_DATA", "Source id and table name are required");
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) throw new RuntimeError("INVALID_DATA", "Source bytes are required");
  if (!input.decoded.columns.length) throw new RuntimeError("EMPTY_INPUT", "Source has no columns");
  const rawDigest = await sha256Hex(input.bytes);
  const logicalDigest = input.decoded.logicalDigest;
  const identityDigest = await sha256Hex(new TextEncoder().encode(JSON.stringify({ format: input.format, logicalDigest, typeInterpretation: input.typeInterpretation ?? {} })));
  const inputSnapshotId = `snapshot-${identityDigest.slice(0, 20)}`;
  const tableId = `table-${stableName(input.name)}-${identityDigest.slice(0, 12)}`;
  const nullCounts: Record<string, number> = {};
  const numeric: Record<string, { min: number | null; max: number | null; mean: number | null }> = {};
  for (const column of input.decoded.columns) {
    const values = input.decoded.rows.map((row) => row[column]);
    nullCounts[column] = values.filter((value) => value === null || value === undefined).length;
    const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (numbers.length) { let min = numbers[0]; let max = numbers[0]; let sum = 0; for (const number of numbers) { min = Math.min(min, number); max = Math.max(max, number); sum += number; } numeric[column] = { min, max, mean: sum / numbers.length }; } else numeric[column] = { min: null, max: null, mean: null };
  }
  const source: SourceDescriptor = { sourceId: input.sourceId, kind: input.kind ?? "file", name: input.name, format: input.format, mediaType: input.mediaType, byteLength: input.bytes.byteLength, sha256: rawDigest, url: input.url, typeInterpretation: input.typeInterpretation ? { ...input.typeInterpretation } : undefined };
  return { inputSnapshotId, source, tableId, schema: input.decoded.columns.map((name) => ({ name, type: input.decoded.types[name], nullable: (nullCounts[name] ?? 0) > 0 })), stats: { rowCount: input.decoded.rows.length, nullCounts, numeric }, createdAt: new Date().toISOString(), schemaVersion: 1, logicalContentHash: logicalDigest, complete: true };
}

export function assertSourceImportActive(signal?: AbortSignal): void { if (signal?.aborted) throw new RuntimeError("CANCELLED", "Source import cancelled"); }

export function assertNameAvailable(name: string, existing: Iterable<string>, replacementConfirmed = false): void {
  if (!name.trim()) throw new RuntimeError("INVALID_DATA", "Table name cannot be empty");
  const key = sourceNameKey(name);
  if ([...existing].some((candidate) => sourceNameKey(candidate) === key) && !replacementConfirmed) throw new RuntimeError("NAME_CONFLICT", `A table named ${name} already exists; choose a new name or confirm replacement`);
}

export function sourceNameKey(name: string): string { return name.trim().toLowerCase(); }

function stableName(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "table"; }
