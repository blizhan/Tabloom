import { createDuckDbWasmExecutor } from "../../src/data/duckdb-wasm-executor";
import { DuckDbService } from "../../src/data/duckdb-service";
import { decodeSource, type SourceRow } from "../../src/workbench/file-codecs";
import { fetchRemoteSource, parseJsonRows } from "../../src/workbench/remote-source";
import { SourceService } from "../../src/workbench/source-service";

export interface SourceFailureEvidence { readonly code: string; readonly keptExistingTables: boolean; readonly requestCount?: number; }
export function assertFailureIsolation(evidence: SourceFailureEvidence): void { if (!evidence.keptExistingTables) throw new Error(`${evidence.code} removed an existing table`); }

export interface WorkbenchSourcesReport {
  readonly status: "passed" | "failed" | "not-run";
  readonly localFormats: readonly { format: "csv" | "parquet" | "arrow-ipc" | "json"; rows: number; logicalDigest: string }[];
  readonly remote: readonly Record<string, unknown>[];
  readonly failures: readonly SourceFailureEvidence[];
  readonly requestCounts?: Readonly<Record<string, number>>;
  readonly evidence: readonly Record<string, unknown>[];
}

async function bytesAt(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`fixture request failed (${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function errorCode(error: unknown): string {
  const value = error as { code?: unknown } | undefined;
  return typeof value?.code === "string" ? value.code : error instanceof Error ? error.message : String(error);
}

async function expectedFailure(task: Promise<unknown>, code: string): Promise<boolean> {
  try { await task; return false; }
  catch (error) { return errorCode(error).includes(code); }
}

function normalizeRows(rows: readonly Record<string, unknown>[]): SourceRow[] {
  return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [key, value];
    if (typeof value === "bigint") return [key, Number.isSafeInteger(Number(value)) ? Number(value) : String(value)];
    if (value instanceof Date) return [key, value.toISOString()];
    return [key, String(value)];
  })) as SourceRow);
}

/** Runs the source story without loading a model.  It deliberately exercises
 * all three local columnar/text formats, the JSON path, the controlled second
 * origin and failure isolation in SourceService. */
export async function runWorkbenchSources(baseUrl: string, sourceBaseUrl: string): Promise<WorkbenchSourcesReport> {
  const evidence: Record<string, unknown>[] = [];
  const localFormats: Array<{ format: "csv" | "parquet" | "arrow-ipc" | "json"; rows: number; logicalDigest: string }> = [];
  let duck: { executor: Awaited<ReturnType<typeof createDuckDbWasmExecutor>>["executor"]; close: () => Promise<void> } | undefined;
  try {
    const csvBytes = await bytesAt(new URL("/runtime-fixtures/workbench/v1/normal/predict.csv", baseUrl).toString());
    const jsonBytes = await bytesAt(new URL("/runtime-fixtures/workbench/v1/normal/predict.json", baseUrl).toString());
    const arrowBytes = await bytesAt(new URL("/runtime-fixtures/workbench/v1/normal/predict.arrow", baseUrl).toString());
    const parquetBytes = await bytesAt(new URL("/runtime-fixtures/workbench/v1/normal/predict.parquet", baseUrl).toString());
    const csv = await decodeSource(csvBytes, "csv");
    const json = await decodeSource(jsonBytes, "json");
    const arrow = await decodeSource(arrowBytes, "arrow-ipc");
    localFormats.push({ format: "csv", rows: csv.rows.length, logicalDigest: csv.logicalDigest }, { format: "json", rows: json.rows.length, logicalDigest: json.logicalDigest }, { format: "arrow-ipc", rows: arrow.rows.length, logicalDigest: arrow.logicalDigest });
    if (csv.rows.length !== 32 || json.logicalDigest !== csv.logicalDigest || arrow.logicalDigest !== csv.logicalDigest) throw new Error("CSV/JSON/Arrow logical source equivalence failed");

    const duckUrls = { workerUrl: new URL("/runtime-assets/duckdb/duckdb-browser-mvp.worker.js", baseUrl).toString(), wasmUrl: new URL("/runtime-assets/duckdb/duckdb-mvp.wasm", baseUrl).toString() };
    duck = await createDuckDbWasmExecutor(duckUrls);
    if (!duck.executor.registerFileBuffer) throw new Error("DuckDB-WASM file buffer registration is unavailable");
    await duck.executor.registerFileBuffer("workbench-source.parquet", parquetBytes);
    const parquetResult = await duck.executor.query("SELECT * FROM read_parquet('workbench-source.parquet') ORDER BY source_row_id");
    await duck.executor.dropFile?.("workbench-source.parquet");
    const parquet = await decodeSource(parquetBytes, "parquet", { types: csv.types, parquetDecoder: () => normalizeRows(parquetResult.rows) });
    localFormats.push({ format: "parquet", rows: parquet.rows.length, logicalDigest: parquet.logicalDigest });
    if (parquet.logicalDigest !== csv.logicalDigest) throw new Error(`Parquet logical source equivalence failed (${parquet.logicalDigest} != ${csv.logicalDigest}); parquet=${JSON.stringify(parquet.rows[0])}; csv=${JSON.stringify(csv.rows[0])}`);
    evidence.push({ localFormats, rowCount: csv.rows.length, logicalEquivalent: true });

    const service = new SourceService();
    await service.importSource({ sourceId: "source-local", name: "existing", format: "csv", bytes: csvBytes });
    let replacementKept = false;
    try { await service.importSource({ sourceId: "source-local", name: "existing", format: "csv", bytes: new TextEncoder().encode("bad\n") , replaceExisting: true }); }
    catch { replacementKept = Boolean(service.get("existing")); }
    const failures: SourceFailureEvidence[] = [{ code: "INVALID_FORMAT", keptExistingTables: replacementKept }];
    assertFailureIsolation(failures[0]);

    const remoteCsv = `${sourceBaseUrl}/train.csv`;
    const remoteJson = `${sourceBaseUrl}/json/nested`;
    const fetched = await fetchRemoteSource(remoteCsv);
    const remoteDecoded = await decodeSource(fetched.bytes, "csv");
    const nestedRows = parseJsonRows((await fetchRemoteSource(remoteJson)).bytes, "$.rows");
    if (remoteDecoded.rows.length !== 256 || nestedRows.length !== 32) throw new Error("Remote CSV/JSON row counts are incorrect");
    const exactLimit = await fetchRemoteSource(`${sourceBaseUrl}/predict.csv`);
    const exact = await fetchRemoteSource(`${sourceBaseUrl}/predict.csv`, { remoteImportMaxBytes: exactLimit.bytes.byteLength });
    const tooLarge = await expectedFailure(fetchRemoteSource(`${sourceBaseUrl}/predict.csv`, { remoteImportMaxBytes: exactLimit.bytes.byteLength - 1 }), "SOURCE_TOO_LARGE");
    const forbidden = await expectedFailure(fetchRemoteSource(`${sourceBaseUrl}/forbidden`), "SOURCE_EXPIRED");
    const expired = await expectedFailure(fetchRemoteSource(`${sourceBaseUrl}/expired`), "SOURCE_EXPIRED");
    const truncated = await expectedFailure(fetchRemoteSource(`${sourceBaseUrl}/truncated`, { remoteImportMaxBytes: exactLimit.bytes.byteLength }), "SOURCE_TOO_LARGE");
    const timedOut = await expectedFailure(fetchRemoteSource(`${sourceBaseUrl}/timeout`, { remoteImportTimeoutMs: 50 }), "SOURCE_TIMEOUT");
    const controller = new AbortController(); const cancellation = expectedFailure(fetchRemoteSource(`${sourceBaseUrl}/timeout`, { signal: controller.signal, remoteImportTimeoutMs: 5000 }), "CANCELLED"); controller.abort(); const cancelled = await cancellation;
    const noCors = await expectedFailure(fetchRemoteSource(`${sourceBaseUrl}/no-cors`), "CORS_OR_NETWORK");
    const remote = [
      { format: "csv", rows: remoteDecoded.rows.length, contentHash: fetched.contentHash },
      { format: "json", path: "$.rows", rows: nestedRows.length },
      { exactLimit: exact.bytes.byteLength, exactAccepted: exact.bytes.byteLength === exactLimit.bytes.byteLength, tooLarge, forbidden, expired, truncated, timedOut, cancelled, noCors },
    ];
    if (!tooLarge || !forbidden || !expired || !truncated || !timedOut || !cancelled || !noCors) throw new Error(`One or more source failure cases did not produce the expected typed error: ${JSON.stringify({ tooLarge, forbidden, expired, truncated, timedOut, cancelled, noCors })}`);
    const countResponse = await fetch(`${sourceBaseUrl}/__counts`, { cache: "no-store" });
    const requestCounts = countResponse.ok ? await countResponse.json() as Record<string, number> : undefined;
    evidence.push({ remote, requestCounts, failureIsolation: failures });
    return { status: "passed", localFormats, remote, failures, requestCounts, evidence };
  } catch (error) {
    return { status: "failed", localFormats, remote: [], failures: [], evidence: [...evidence, { error: error instanceof Error ? error.message : String(error) }] };
  } finally { await duck?.close().catch(() => undefined); }
}
