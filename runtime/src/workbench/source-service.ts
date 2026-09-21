import { RuntimeError } from "../model/errors";
import { decodeSource, type DecodedTable } from "./file-codecs";
import { assertNameAvailable, assertSourceImportActive, createDataSnapshot, sourceNameKey } from "./source-snapshots";
import { fetchRemoteSource, type RemoteSourceLimits } from "./remote-source";
import type { DataSnapshot, SourceFormat } from "./types";

export interface ImportSourceInput { readonly sourceId: string; readonly name: string; readonly format: SourceFormat; readonly bytes: Uint8Array; readonly mediaType?: string; readonly url?: string; readonly jsonPath?: string; readonly typeInterpretation?: Readonly<Record<string, string>>; readonly replaceExisting?: boolean; readonly signal?: AbortSignal; }
export interface SourceRecord { readonly snapshot: DataSnapshot; readonly decoded: DecodedTable; readonly bytes: Uint8Array; }

/** Application-level source registry. A failed decode never mutates the
 * registry, so already imported tables remain queryable. */
export class SourceService {
  private readonly records = new Map<string, SourceRecord>();
  constructor(private readonly limits: RemoteSourceLimits = {}) {}
  async importSource(input: ImportSourceInput): Promise<SourceRecord> {
    assertSourceImportActive(input.signal);
    assertNameAvailable(input.name, [...this.records.values()].map((record) => record.snapshot.source.name), input.replaceExisting ?? false);
    const decoded = await decodeSource(input.bytes, codecFormat(input.format), { jsonPath: input.jsonPath, types: input.typeInterpretation });
    assertSourceImportActive(input.signal);
    if (!decoded.rows.length) throw new RuntimeError("EMPTY_INPUT", "Source contains no data rows");
    const snapshot = await createDataSnapshot({ sourceId: input.sourceId, name: input.name, format: input.format, mediaType: input.mediaType, url: input.url, typeInterpretation: input.typeInterpretation, bytes: input.bytes, decoded });
    assertSourceImportActive(input.signal);
    const record = { snapshot, decoded, bytes: new Uint8Array(input.bytes) };
    if (input.replaceExisting) for (const existingName of this.records.keys()) if (existingName !== input.name && sourceNameKey(existingName) === sourceNameKey(input.name)) this.records.delete(existingName);
    this.records.set(input.name, record);
    return cloneRecord(record);
  }
  async importRemote(input: Omit<ImportSourceInput, "bytes"> & { readonly remoteUrl: string }): Promise<SourceRecord> { const fetched = await fetchRemoteSource(input.remoteUrl, { ...this.limits, signal: input.signal }); return this.importSource({ ...input, bytes: fetched.bytes, url: fetched.url, mediaType: fetched.contentType ?? input.mediaType }); }
  get(name: string): SourceRecord | undefined { const value = this.records.get(name); return value ? cloneRecord(value) : undefined; }
  list(): readonly DataSnapshot[] { return [...this.records.values()].map((record) => record.snapshot).map((snapshot) => ({ ...snapshot, schema: [...snapshot.schema] })); }
  remove(name: string): void { this.records.delete(name); }
}

function codecFormat(format: SourceFormat): "csv" | "json" | "arrow-ipc" | "parquet" { if (format === "arrow-ipc" || format === "parquet" || format === "csv" || format === "json") return format; throw new RuntimeError("INVALID_FORMAT", `Unsupported source format ${format}`); }
function cloneRecord(record: SourceRecord): SourceRecord { return { snapshot: { ...record.snapshot, schema: [...record.snapshot.schema] }, decoded: { ...record.decoded, columns: [...record.decoded.columns], rows: record.decoded.rows.map((row) => ({ ...row })), types: { ...record.decoded.types } }, bytes: new Uint8Array(record.bytes) }; }
