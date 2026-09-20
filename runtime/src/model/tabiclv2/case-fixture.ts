import { RuntimeError } from "../errors";
import { validateCaseState, type TabICLCaseState } from "./preprocessing";
import type { ExecutionProvider } from "../types";
import type { OrtSessionOptions } from "../ort-session";

export const CASE_VARIANTS = ["fp32", "fp16-storage-fp32-compute"] as const;
export type CaseVariant = (typeof CASE_VARIANTS)[number];

export interface CaseArraySpec {
  readonly file: string;
  readonly dtype: "float32";
  readonly shape: readonly number[];
  readonly bytes: number;
  readonly sha256: string;
}

export interface CaseArtifactFile {
  readonly path: string;
  readonly role: "graph" | "external-data";
  readonly bytes: number;
  readonly sha256: string;
}

export interface CaseArtifactManifest {
  readonly schemaVersion: number;
  readonly modelId: "tabicl-v2";
  readonly modelVersion: string;
  readonly precision: string;
  readonly preprocessingVersion: string;
  readonly files: readonly CaseArtifactFile[];
  readonly inputs: readonly { readonly name: string; readonly dtype: string; readonly minRank: number; readonly maxRank: number }[];
  readonly providerCompatibility: readonly ExecutionProvider[];
  readonly capabilities: {
    readonly canBuildContext: false;
    readonly canImportContext: true;
    readonly maxModelFeatures: number;
    readonly trainRows: { readonly min: number; readonly max: number };
    readonly predictionRows: { readonly min: number; readonly max: number };
  };
  readonly manifestDigest: string;
}

export interface CaseScenarioSpec {
  readonly id: string;
  readonly rawInput: string;
  readonly modelInput: string;
  readonly officialMean: string;
}

export interface EmbeddedCaseRecipe {
  readonly payload: { readonly kind: "embedded-artifact"; readonly manifestDigest: string };
  readonly trainingDataSha256?: string;
  readonly featureNames: readonly string[];
  readonly estimatorState: { readonly schemaVersion: number; readonly values: Readonly<Record<string, unknown>> };
}

export interface CaseVariantManifest {
  readonly artifactManifest: CaseArtifactManifest;
  readonly maxAbsErrorTargetUnits: number;
  readonly bindingCheck?: { readonly provider: string; readonly errors: Readonly<Record<string, number>> };
  readonly embeddedCaseRecipe: EmbeddedCaseRecipe;
}

export interface CaseFixtureManifest {
  readonly schemaVersion: number;
  readonly modelId: "tabicl-v2";
  readonly arrays: Readonly<Record<string, CaseArraySpec>>;
  readonly scenarios: readonly CaseScenarioSpec[];
  readonly variants: Partial<Record<CaseVariant, CaseVariantManifest>>;
}

export interface CaseFixtureScenario {
  readonly id: string;
  readonly rawInput: Float32Array;
  readonly rawShape: readonly number[];
  readonly modelInput: Float32Array;
  readonly modelInputShape: readonly number[];
  readonly officialMean: Float32Array;
}

export interface CaseFixture {
  readonly variant: CaseVariant;
  readonly manifest: CaseFixtureManifest;
  readonly variantManifest: CaseVariantManifest;
  readonly state: TabICLCaseState;
  readonly scenarios: readonly CaseFixtureScenario[];
  readonly arrays: Readonly<Record<string, Float32Array>>;
  readonly ortOptions: OrtSessionOptions;
  readonly artifactManifestDigest: string;
  readonly modelVersion: string;
  readonly targetUnitBudget: number;
}

export interface CaseFixtureDependencies {
  readonly fetch?: typeof fetch;
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeError("ARTIFACT_MISMATCH", message);
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.startsWith("/") || value.includes("\\")) throw new RuntimeError("ARTIFACT_MISMATCH", `${label} must be a relative path`);
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) throw new RuntimeError("ARTIFACT_MISMATCH", `${label} contains an unsafe path`);
  return value;
}

function endpoint(baseUrl: string, route: string, relativePath: string): string {
  const root = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return new URL(`${route}/${relativePath}`, root).href;
}

async function getResponse(url: string, fetchImpl: typeof fetch): Promise<Response> {
  const response = await fetchImpl(url, { credentials: "same-origin" });
  if (!response.ok) throw new RuntimeError("ARTIFACT_MISMATCH", `Fixture request failed (${response.status}): ${url}`);
  return response;
}

async function getBytes(url: string, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const response = await getResponse(url, fetchImpl);
  return new Uint8Array(await response.arrayBuffer());
}

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await getResponse(url, fetchImpl);
  return await response.json() as T;
}

async function digest(bytes: Uint8Array): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) throw new RuntimeError("ARTIFACT_MISMATCH", "Web Crypto SHA-256 is unavailable");
  const owned = new Uint8Array(bytes.byteLength);
  owned.set(bytes);
  const hash = await cryptoApi.subtle.digest("SHA-256", owned as unknown as BufferSource);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function expectedElementCount(shape: readonly number[]): number {
  if (shape.length === 0 || shape.some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new RuntimeError("SHAPE_UNSUPPORTED", "Fixture shape must contain positive dimensions");
  const count = shape.reduce((total, value) => total * value, 1);
  if (!Number.isSafeInteger(count)) throw new RuntimeError("SHAPE_UNSUPPORTED", "Fixture shape is too large");
  return count;
}

function decodeF32(bytes: Uint8Array, shape: readonly number[], label: string): Float32Array {
  const count = expectedElementCount(shape);
  if (bytes.byteLength !== count * 4) throw new RuntimeError("SHAPE_UNSUPPORTED", `${label} byte length does not match its declared shape`);
  const values = new Float32Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < count; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) throw new RuntimeError("RESULT_INVALID", `${label} contains a non-finite value`);
    values[index] = value;
  }
  return values;
}

async function fetchVerifiedArray(baseUrl: string, name: string, spec: CaseArraySpec, fetchImpl: typeof fetch): Promise<Float32Array> {
  const file = safeRelativePath(spec.file, `array ${name}`);
  if (spec.dtype !== "float32" || !/\.f32$/i.test(file) || !/^[a-f0-9]{64}$/i.test(spec.sha256)) throw new RuntimeError("ARTIFACT_MISMATCH", `Invalid array manifest for ${name}`);
  const bytes = await getBytes(endpoint(baseUrl, "runtime-fixtures/tabiclv2/case-golden", file), fetchImpl);
  if (bytes.byteLength !== spec.bytes) throw new RuntimeError("ARTIFACT_MISMATCH", `${name} byte count does not match the manifest`);
  if ((await digest(bytes)) !== spec.sha256.toLowerCase()) throw new RuntimeError("ARTIFACT_MISMATCH", `${name} SHA-256 checksum mismatch`);
  return decodeF32(bytes, spec.shape, name);
}

async function fetchVerifiedArtifact(baseUrl: string, variant: CaseVariant, file: CaseArtifactFile, fetchImpl: typeof fetch): Promise<Uint8Array> {
  const path = safeRelativePath(file.path, `${file.role} path`);
  if (!/^[a-f0-9]{64}$/i.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 1) throw new RuntimeError("ARTIFACT_MISMATCH", `Invalid ${file.role} manifest entry`);
  const bytes = await getBytes(endpoint(baseUrl, `runtime-assets/tabiclv2/${variant}`, path), fetchImpl);
  if (bytes.byteLength !== file.bytes) throw new RuntimeError("ARTIFACT_MISMATCH", `${file.role} byte count does not match the manifest`);
  if ((await digest(bytes)) !== file.sha256.toLowerCase()) throw new RuntimeError("ARTIFACT_MISMATCH", `${file.role} SHA-256 checksum mismatch`);
  return bytes;
}

function stateFromRecipe(recipe: EmbeddedCaseRecipe, artifactDigest: string): TabICLCaseState {
  const values = recipe.estimatorState.values;
  const state = {
    featureNames: [...recipe.featureNames],
    targetMean: Number(values.targetMean),
    targetScale: Number(values.targetScale),
    trainRows: Number(values.trainRows),
    artifactDigest: String(values.artifactDigest ?? artifactDigest),
    featureTransform: values.featureTransform as TabICLCaseState["featureTransform"],
    featureMeans: values.featureMeans as readonly number[] | undefined,
    featureScales: values.featureScales as readonly number[] | undefined,
    outlierLowerBounds: values.outlierLowerBounds as readonly number[] | undefined,
    outlierUpperBounds: values.outlierUpperBounds as readonly number[] | undefined,
    weights: values.weights as readonly number[] | undefined,
    bias: values.bias === undefined ? undefined : Number(values.bias),
  } satisfies TabICLCaseState;
  validateCaseState(state);
  if (state.artifactDigest !== artifactDigest || recipe.payload.manifestDigest !== artifactDigest) throw new RuntimeError("ARTIFACT_MISMATCH", "Embedded Case recipe is bound to a different artifact digest");
  return state;
}

/** Load the published Case manifest, fixtures, graph and external data from
 * same-origin routes. Every byte and declared shape is checked before it can
 * reach an ORT session. */
export async function loadCaseFixture(baseUrl: string, variant: CaseVariant, dependencies: CaseFixtureDependencies = {}): Promise<CaseFixture> {
  if (!(CASE_VARIANTS as readonly string[]).includes(variant)) throw new RuntimeError("INVALID_DATA", `Unsupported TabICL Case variant: ${String(variant)}`);
  if (typeof location !== "undefined" && new URL(baseUrl, location.href).origin !== location.origin) throw new RuntimeError("ARTIFACT_MISMATCH", "Case fixtures must be loaded from the current origin");
  const fetchImpl = dependencies.fetch ?? fetch;
  const manifest = await getJson<CaseFixtureManifest>(endpoint(baseUrl, "runtime-fixtures/tabiclv2/case-golden", "manifest.json"), fetchImpl);
  assertObject(manifest, "Case manifest must be an object");
  if (manifest.schemaVersion !== 1 || manifest.modelId !== "tabicl-v2" || !manifest.arrays || !Array.isArray(manifest.scenarios)) throw new RuntimeError("ARTIFACT_MISMATCH", "Unsupported TabICL Case manifest");
  const variantManifest = manifest.variants?.[variant];
  if (!variantManifest) throw new RuntimeError("ARTIFACT_MISMATCH", `Case variant ${variant} is absent from the manifest`);
  const artifact = variantManifest.artifactManifest;
  if (!/^[a-f0-9]{64}$/i.test(artifact.manifestDigest) || artifact.modelId !== "tabicl-v2" || artifact.capabilities.canBuildContext !== false || artifact.capabilities.canImportContext !== true || !artifact.providerCompatibility.includes("wasm")) throw new RuntimeError("ARTIFACT_MISMATCH", "Case artifact manifest is incompatible with the runtime");
  const graphFile = artifact.files.find((file) => file.role === "graph");
  const externalFile = artifact.files.find((file) => file.role === "external-data");
  if (!graphFile || !externalFile || artifact.files.filter((file) => file.role === "graph").length !== 1 || artifact.files.filter((file) => file.role === "external-data").length !== 1) throw new RuntimeError("ARTIFACT_MISMATCH", "Case artifact must declare one graph and one external-data file");
  const [graph, externalData] = await Promise.all([fetchVerifiedArtifact(baseUrl, variant, graphFile, fetchImpl), fetchVerifiedArtifact(baseUrl, variant, externalFile, fetchImpl)]);
  const arrays: Record<string, Float32Array> = {};
  for (const [name, spec] of Object.entries(manifest.arrays)) arrays[name] = await fetchVerifiedArray(baseUrl, name, spec, fetchImpl);
  const state = stateFromRecipe(variantManifest.embeddedCaseRecipe, artifact.manifestDigest);
  const scenarios = manifest.scenarios.map((scenario) => {
    const raw = arrays[scenario.rawInput]; const modelInput = arrays[scenario.modelInput]; const officialMean = arrays[scenario.officialMean];
    if (!raw || !modelInput || !officialMean) throw new RuntimeError("ARTIFACT_MISMATCH", `Case scenario ${scenario.id} references a missing array`);
    const rawSpec = manifest.arrays[scenario.rawInput]; const modelSpec = manifest.arrays[scenario.modelInput]; const meanSpec = manifest.arrays[scenario.officialMean];
    if (!rawSpec || !modelSpec || !meanSpec) throw new RuntimeError("ARTIFACT_MISMATCH", `Case scenario ${scenario.id} has incomplete array metadata`);
    return { id: scenario.id, rawInput: raw, rawShape: [...rawSpec.shape], modelInput, modelInputShape: [...modelSpec.shape], officialMean };
  });
  if (scenarios.length === 0) throw new RuntimeError("ARTIFACT_MISMATCH", "Case manifest contains no scenarios");
  return {
    variant, manifest, variantManifest, state, scenarios, arrays,
    artifactManifestDigest: artifact.manifestDigest, modelVersion: artifact.modelVersion,
    targetUnitBudget: variantManifest.maxAbsErrorTargetUnits,
    ortOptions: { graph, externalData: { path: safeRelativePath(externalFile.path, "external-data path"), bytes: externalData }, provider: "wasm", wasmPaths: endpoint(baseUrl, "runtime-assets/ort", "") },
  };
}
