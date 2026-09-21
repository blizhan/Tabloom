import type { DuckDbResult } from "../data/duckdb-service";

export const WORKBENCH_PROTOCOL_VERSION = 1 as const;
export type SourceFormat = "csv" | "parquet" | "arrow-ipc" | "json" | "duckdb";
export type SourceKind = "file" | "sample" | "remote";
export interface SourceDescriptor { readonly sourceId: string; readonly kind: SourceKind; readonly name: string; readonly format: SourceFormat; readonly mediaType?: string; readonly byteLength?: number; readonly sha256?: string; readonly url?: string; readonly typeInterpretation?: Readonly<Record<string, string>>; }
export interface TableSchema { readonly name: string; readonly type: string; readonly nullable: boolean; }
export interface TableStats { readonly rowCount: number; readonly nullCounts: Readonly<Record<string, number>>; readonly numeric: Readonly<Record<string, { readonly min: number | null; readonly max: number | null; readonly mean: number | null }>>; }
export interface DataSnapshot { readonly inputSnapshotId: string; readonly source: SourceDescriptor; readonly tableId: string; readonly schema: readonly TableSchema[]; readonly stats?: TableStats; readonly createdAt: string; readonly schemaVersion?: number; readonly logicalContentHash?: string; readonly complete?: boolean; }
export interface QueryDefinition { readonly sql: string; readonly parameters?: readonly unknown[]; readonly sourceSnapshotId: string; readonly revision: number; }
export interface MaterializedInput { readonly inputSnapshotId: string; readonly rowCount: number; readonly rowOrdinal: readonly number[]; readonly columns: readonly string[]; readonly result: DuckDbResult; readonly query: QueryDefinition; }
export interface ExperimentRevision { readonly experimentId: string; readonly revision: number; readonly training?: QueryDefinition; readonly prediction: QueryDefinition; readonly featureNames: readonly string[]; readonly targetName?: string; readonly modelId: string; }
export type RunStatus = "queued" | "running" | "complete" | "failed" | "cancelled";
export interface ExperimentRun { readonly runId: string; readonly experimentId: string; readonly revision: number; readonly status: RunStatus; readonly requestId: string; readonly generation: number; }
export interface ExportBundle { readonly format: SourceFormat; readonly data: Uint8Array; readonly metadata: Readonly<Record<string, unknown>>; }
export interface CapabilityEvidence { readonly name: string; readonly supported: boolean; readonly reason?: string; readonly checkedAt: string; }
