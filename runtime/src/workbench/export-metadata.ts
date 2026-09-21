import type { ExperimentRevision, ExportBundle } from "./types";

export interface ExportMetadataInput {
  readonly format: ExportBundle["format"];
  readonly sourceSnapshotId: string;
  readonly inputSnapshotId?: string;
  readonly query?: string;
  readonly predictionQuery?: string;
  readonly featureNames?: readonly string[];
  readonly targetName?: string;
  readonly modelId?: string;
  readonly modelVersion?: string;
  readonly artifactManifestDigest?: string;
  readonly runId?: string;
  readonly provider?: string;
  readonly precision?: string;
  readonly durationMs?: number;
  readonly aggregation?: boolean;
  readonly schema: readonly { readonly name: string; readonly type: string; readonly nullable: boolean }[];
}

export function createExportMetadata(input: ExportMetadataInput): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    format: input.format,
    sourceSnapshotId: input.sourceSnapshotId,
    inputSnapshotId: input.inputSnapshotId,
    query: input.query,
    predictionQuery: input.predictionQuery,
    featureNames: input.featureNames ? [...input.featureNames] : undefined,
    targetName: input.targetName,
    model: input.modelId ? { id: input.modelId, version: input.modelVersion, artifactManifestDigest: input.artifactManifestDigest } : undefined,
    run: input.runId ? { id: input.runId, provider: input.provider, precision: input.precision, durationMs: input.durationMs } : undefined,
    aggregation: input.aggregation ?? false,
    schema: input.schema.map((column) => ({ ...column })),
    generatedAt: new Date().toISOString(),
  };
}

export function encodeMetadata(metadata: Readonly<Record<string, unknown>>): Uint8Array { return new TextEncoder().encode(`${JSON.stringify(metadata, null, 2)}\n`); }
