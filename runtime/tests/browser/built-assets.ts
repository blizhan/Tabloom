export type BuiltAssetKind = "worker" | "wasm" | "model" | "fixture";
export type BuiltAssetReportStatus = "passed" | "unavailable" | "failed";

export interface AssetResponseEvidence {
  readonly kind: BuiltAssetKind;
  readonly url: string;
  readonly status: number | null;
  readonly contentType: string | null;
}

export interface BuiltAssetContractInput {
  readonly headers: Headers | Readonly<Record<string, string | undefined>>;
  readonly pageUrl?: string;
  readonly crossOriginIsolated?: boolean;
  readonly assets?: readonly AssetResponseEvidence[];
  /** Requests classified as remote inference calls; an empty list is evidence of none. */
  readonly inferenceRequests?: readonly string[];
}

export interface BuiltAssetContractReport {
  readonly status: BuiltAssetReportStatus;
  readonly checks: Readonly<Record<string, boolean | null>>;
  readonly unavailable: readonly string[];
  readonly failures: readonly string[];
  readonly evidence: readonly AssetResponseEvidence[];
}

function headerValue(headers: Headers | Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  if (typeof Headers !== "undefined" && headers instanceof Headers) return headers.get(name) ?? undefined;
  const target = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === target);
  return entry?.[1];
}

/** The legacy header-only check remains useful for a page smoke test. */
export function builtAssetContract(headers: Headers | Readonly<Record<string, string | undefined>>): boolean {
  return headerValue(headers, "Cross-Origin-Opener-Policy") === "same-origin" && headerValue(headers, "Cross-Origin-Embedder-Policy") === "require-corp";
}

function sameOrigin(url: string, pageUrl: string): boolean | null {
  try {
    return new URL(url, pageUrl).origin === new URL(pageUrl).origin;
  } catch {
    return null;
  }
}

function expectedMime(kind: BuiltAssetKind, contentType: string | null): boolean | null {
  if (!contentType) return null;
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  if (kind === "wasm") return mime === "application/wasm";
  if (kind === "model") return ["application/octet-stream", "application/onnx", "application/vnd.onnx"].includes(mime);
  if (kind === "fixture") return ["application/octet-stream", "application/json"].includes(mime);
  return ["application/javascript", "text/javascript", "application/ecmascript", "text/ecmascript"].includes(mime);
}

function allObserved<T>(values: readonly T[], predicate: (value: T) => boolean | null): boolean | null {
  if (values.length === 0) return null;
  const checks = values.map(predicate);
  if (checks.some((value) => value === null)) return null;
  return checks.every((value) => value === true);
}

/**
 * Validate a production-like page and its worker/WASM response evidence.
 * Missing observations are `unavailable`, never an implicit pass. A caller
 * should supply an empty `inferenceRequests` array only after it has actually
 * inspected the browser's request log.
 */
export function validateBuiltAssetContract(input: BuiltAssetContractInput): BuiltAssetContractReport {
  const assets = [...(input.assets ?? [])];
  const unavailable: string[] = [];
  const failures: string[] = [];
  const checks: Record<string, boolean | null> = {
    coop: headerValue(input.headers, "Cross-Origin-Opener-Policy") === "same-origin",
    coep: headerValue(input.headers, "Cross-Origin-Embedder-Policy") === "require-corp",
    crossOriginIsolated: input.crossOriginIsolated === undefined ? null : input.crossOriginIsolated,
    workerAsset: null,
    wasmAsset: null,
    modelAsset: null,
    sameOriginAssets: null,
    assetMimeTypes: null,
    noRemoteInference: input.inferenceRequests === undefined ? null : input.inferenceRequests.length === 0,
  };
  if (!checks.coop) failures.push("Cross-Origin-Opener-Policy must be same-origin");
  if (!checks.coep) failures.push("Cross-Origin-Embedder-Policy must be require-corp");
  if (checks.crossOriginIsolated === false) failures.push("page is not cross-origin isolated");
  if (checks.crossOriginIsolated === null) unavailable.push("crossOriginIsolated");
  if (!input.pageUrl) unavailable.push("pageUrl");
  if (input.inferenceRequests === undefined) unavailable.push("inferenceRequests");
  else if (input.inferenceRequests.length) failures.push(`remote inference requests observed: ${input.inferenceRequests.join(", ")}`);

  const workerAssets = assets.filter((asset) => asset.kind === "worker");
  const wasmAssets = assets.filter((asset) => asset.kind === "wasm");
  const modelAssets = assets.filter((asset) => asset.kind === "model");
  checks.workerAsset = allObserved(workerAssets, (asset) => asset.status === null ? null : asset.status >= 200 && asset.status < 300);
  checks.wasmAsset = allObserved(wasmAssets, (asset) => asset.status === null ? null : asset.status >= 200 && asset.status < 300);
  checks.modelAsset = allObserved(modelAssets, (asset) => asset.status === null ? null : asset.status >= 200 && asset.status < 300);
  checks.sameOriginAssets = input.pageUrl && assets.length ? allObserved(assets, (asset) => sameOrigin(asset.url, input.pageUrl!)) : null;
  checks.assetMimeTypes = allObserved(assets, (asset) => expectedMime(asset.kind, asset.contentType));
  if (checks.workerAsset === null) unavailable.push("workerAsset"); else if (!checks.workerAsset) failures.push("worker asset was not observed with a successful response");
  if (checks.wasmAsset === null) unavailable.push("wasmAsset"); else if (!checks.wasmAsset) failures.push("WASM asset was not observed with a successful response");
  if (checks.modelAsset === null) unavailable.push("modelAsset"); else if (!checks.modelAsset) failures.push("Case model asset was not observed with a successful response");
  if (checks.sameOriginAssets === null) unavailable.push("sameOriginAssets"); else if (!checks.sameOriginAssets) failures.push("worker/WASM asset was not same-origin");
  if (checks.assetMimeTypes === null) unavailable.push("assetMimeTypes"); else if (!checks.assetMimeTypes) failures.push("worker/WASM MIME type is incorrect");

  const failed = failures.length > 0;
  const missingEvidence = unavailable.length > 0;
  return { status: failed ? "failed" : missingEvidence ? "unavailable" : "passed", checks, unavailable, failures, evidence: assets };
}

/** Alias used by callers that prefer the inspection verb. */
export const inspectBuiltAssetContract = validateBuiltAssetContract;
