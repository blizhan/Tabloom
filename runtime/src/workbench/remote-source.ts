import { RuntimeError } from "../model/errors";

export interface RemoteSourceLimits {
  readonly remoteImportTimeoutMs?: number;
  readonly remoteImportMaxBytes?: number;
}

export interface RemoteSourceResult {
  readonly url: string;
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly contentHash: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 67_108_864;

function assertLimit(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RuntimeError("INVALID_DATA", `${name} must be a positive integer`);
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/** Fetch a user data source into an immutable, bounded snapshot. It never
 * returns an opaque no-cors response or silently truncates a large source. */
export async function fetchRemoteSource(url: string, options: RemoteSourceLimits & { readonly signal?: AbortSignal } = {}): Promise<RemoteSourceResult> {
  let parsed: URL;
  try { parsed = new URL(url, typeof location === "undefined" ? "http://localhost/" : location.href); }
  catch { throw new RuntimeError("SOURCE_UNREACHABLE", `Invalid source URL: ${url}`); }
  if (typeof location !== "undefined" && location.protocol === "https:" && parsed.protocol !== "https:") throw new RuntimeError("CORS_OR_NETWORK", "HTTPS pages cannot load an insecure HTTP source");
  const timeoutMs = assertLimit(options.remoteImportTimeoutMs ?? DEFAULT_TIMEOUT_MS, "remoteImportTimeoutMs");
  const maxBytes = assertLimit(options.remoteImportMaxBytes ?? DEFAULT_MAX_BYTES, "remoteImportMaxBytes");
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason ?? "cancelled");
  if (options.signal?.aborted) abortFromCaller(); else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    let response: Response;
    try { response = await fetch(parsed, { signal: controller.signal }); }
    catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason === "timeout") throw new RuntimeError("SOURCE_TIMEOUT", `Source request exceeded ${timeoutMs} ms`, { retryable: true });
        throw new RuntimeError("CANCELLED", "Source request cancelled");
      }
      throw new RuntimeError("CORS_OR_NETWORK", error instanceof Error ? error.message : "Source request failed", { retryable: true });
    }
    if (!response.ok) {
      const code = response.status === 401 || response.status === 403 || response.status === 404 || response.status === 410 ? "SOURCE_EXPIRED" : "SOURCE_UNREACHABLE";
      throw new RuntimeError(code, `Source request failed with HTTP ${response.status}`, { retryable: code === "SOURCE_UNREACHABLE", details: { status: response.status } });
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new RuntimeError("SOURCE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`, { details: { maxBytes, contentLength: declaredLength } });
    if (!response.body) {
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await response.arrayBuffer()); }
      catch (error) { throw mapAbort(error, controller.signal, timeoutMs); }
      if (bytes.byteLength > maxBytes) throw new RuntimeError("SOURCE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`, { details: { maxBytes } });
      return { url: parsed.toString(), bytes, contentType: response.headers.get("content-type"), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), contentHash: await sha256(bytes) };
    }
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        let part: ReadableStreamReadResult<Uint8Array>;
        try { part = await reader.read(); } catch (error) { throw mapAbort(error, controller.signal, timeoutMs); }
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) { await reader.cancel("too-large"); throw new RuntimeError("SOURCE_TOO_LARGE", `Source exceeds ${maxBytes} bytes`, { details: { maxBytes } }); }
        chunks.push(part.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return { url: parsed.toString(), bytes, contentType: response.headers.get("content-type"), etag: response.headers.get("etag"), lastModified: response.headers.get("last-modified"), contentHash: await sha256(bytes) };
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abortFromCaller); }
}

function mapAbort(error: unknown, signal: AbortSignal, timeoutMs: number): RuntimeError {
  if (signal.aborted && signal.reason === "timeout") return new RuntimeError("SOURCE_TIMEOUT", `Source request exceeded ${timeoutMs} ms`, { retryable: true });
  if (signal.aborted) return new RuntimeError("CANCELLED", "Source request cancelled");
  return new RuntimeError("SOURCE_UNREACHABLE", error instanceof Error ? error.message : "Source response could not be read", { retryable: true });
}

export function parseJsonRows(bytes: Uint8Array, path = "$"): readonly Record<string, unknown>[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new RuntimeError("INVALID_FORMAT", "Source is not valid JSON"); }
  if (path !== "$") for (const part of path.replace(/^\$\.?/, "").split(".").filter(Boolean)) { if (!value || typeof value !== "object") throw new RuntimeError("INVALID_FORMAT", `JSON path ${path} does not resolve to rows`); value = (value as Record<string, unknown>)[part]; }
  if (!Array.isArray(value) || value.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new RuntimeError("INVALID_FORMAT", "JSON source must be an array of row objects");
  return value as readonly Record<string, unknown>[];
}
