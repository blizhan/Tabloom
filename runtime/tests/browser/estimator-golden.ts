import { RuntimeError } from "../../src/model/errors";

export interface BrowserGoldenArray { readonly shape: readonly number[]; readonly values: Float32Array; }
export interface BrowserGoldenState {
  readonly seed: number;
  readonly fingerprint: boolean;
  readonly featureShiftDecoder: "shuffle" | "rotate" | null;
  readonly featureShiftCount: number;
  readonly targetMean: number;
  readonly targetScale: number;
  readonly temperature: number;
  readonly passthroughInf: boolean;
  readonly gpu: { readonly fittedCache?: readonly { readonly permutation?: readonly number[] }[] };
}
export interface BrowserGoldenScenario {
  readonly name: string;
  readonly arrays: Readonly<Record<string, BrowserGoldenArray>>;
  readonly state: BrowserGoldenState;
}
export interface BrowserGoldenManifestScenario { readonly name: string; readonly file: string; readonly sha256: string; readonly stateFile: string; readonly stateSha256: string; }
export interface BrowserGoldenManifest { readonly schemaVersion: number; readonly scenarios: readonly BrowserGoldenManifestScenario[]; readonly meanMaxAbsBudget?: { readonly fp32: number; readonly "fp16-storage": number } }

function view(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }
function typedError(message: string): RuntimeError { return new RuntimeError("ARTIFACT_MISMATCH", message); }

async function fetchBytes(url: string): Promise<Uint8Array> {
  let response: Response;
  try { response = await fetch(url); } catch (error) { throw typedError(`Estimator golden request failed: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw typedError(`Estimator golden asset is unavailable (${response.status}): ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function digest(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw typedError("Web Crypto SHA-256 is unavailable for estimator golden verification");
  const result = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
  return Array.from(result, (value) => value.toString(16).padStart(2, "0")).join("");
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const data = view(bytes);
  for (let offset = Math.max(0, bytes.byteLength - 22 - 0xffff); offset <= bytes.byteLength - 22; offset += 1) if (data.getUint32(offset, true) === 0x06054b50) return offset;
  throw typedError("Estimator golden NPZ has no ZIP end record");
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw typedError("Browser does not provide DecompressionStream for estimator golden NPZ");
  const source = new Uint8Array(bytes);
  const stream = new Blob([source]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function readNpz(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const data = view(bytes);
  const endRecord = findEndOfCentralDirectory(bytes);
  const centralSize = data.getUint32(endRecord + 12, true);
  const centralOffset = data.getUint32(endRecord + 16, true);
  const entries = new Map<string, Uint8Array>();
  let offset = centralOffset;
  while (offset < centralOffset + centralSize) {
    if (data.getUint32(offset, true) !== 0x02014b50) throw typedError("Estimator golden NPZ central directory is malformed");
    const method = data.getUint16(offset + 10, true);
    const compressedSize = data.getUint32(offset + 20, true);
    const nameLength = data.getUint16(offset + 28, true);
    const extraLength = data.getUint16(offset + 30, true);
    const commentLength = data.getUint16(offset + 32, true);
    const localOffset = data.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (data.getUint32(localOffset, true) !== 0x04034b50) throw typedError(`Estimator golden NPZ local entry is malformed: ${name}`);
    const localNameLength = data.getUint16(localOffset + 26, true);
    const localExtraLength = data.getUint16(localOffset + 28, true);
    const payloadOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(payloadOffset, payloadOffset + compressedSize);
    const decoded = method === 0 ? new Uint8Array(compressed) : method === 8 ? await inflateRaw(compressed) : undefined;
    if (!decoded) throw typedError(`Estimator golden NPZ uses unsupported ZIP compression ${method}`);
    entries.set(name, decoded);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function parseNpy(bytes: Uint8Array): BrowserGoldenArray {
  if (bytes.byteLength < 12 || bytes[0] !== 0x93 || new TextDecoder().decode(bytes.subarray(1, 6)) !== "NUMPY") throw typedError("Estimator golden member is not an NPY array");
  const data = view(bytes);
  const major = bytes[6];
  const headerLength = major === 1 ? data.getUint16(8, true) : major === 2 ? data.getUint32(8, true) : 0;
  const headerOffset = major === 1 ? 10 : major === 2 ? 12 : 0;
  if (!headerLength) throw typedError(`Unsupported estimator golden NPY version ${major}`);
  const header = new TextDecoder().decode(bytes.subarray(headerOffset, headerOffset + headerLength));
  const dtype = /['"]descr['"]\s*:\s*['"]([^'"]+)['"]/.exec(header)?.[1];
  const shapeText = /['"]shape['"]\s*:\s*\(([^)]*)\)/.exec(header)?.[1];
  const shape = shapeText?.split(",").map((part) => part.trim()).filter(Boolean).map(Number) ?? [];
  if (dtype !== "<f4" || shape.length === 0 || shape.some((value) => !Number.isSafeInteger(value) || value < 0)) throw typedError("Estimator golden NPY dtype or shape is unsupported");
  const count = shape.reduce((total, value) => total * value, 1);
  const payloadOffset = headerOffset + headerLength;
  if (bytes.byteLength - payloadOffset !== count * 4) throw typedError("Estimator golden NPY byte length does not match its shape");
  const values = new Float32Array(count);
  values.set(new Float32Array(bytes.slice(payloadOffset).buffer));
  return { shape, values };
}

export async function loadEstimatorGoldenManifest(baseUrl: string): Promise<BrowserGoldenManifest> {
  const bytes = await fetchBytes(new URL("/runtime-fixtures/tabpfn35/estimator-golden/manifest.json", baseUrl).toString());
  let manifest: BrowserGoldenManifest;
  try { manifest = JSON.parse(new TextDecoder().decode(bytes)) as BrowserGoldenManifest; } catch { throw typedError("Estimator golden manifest is not valid JSON"); }
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.scenarios) || manifest.scenarios.length === 0) throw typedError("Estimator golden manifest schema is unsupported");
  return manifest;
}

export async function loadEstimatorGoldenScenario(baseUrl: string, record: BrowserGoldenManifestScenario): Promise<BrowserGoldenScenario> {
  const archiveBytes = await fetchBytes(new URL(`/runtime-fixtures/tabpfn35/estimator-golden/${record.file}`, baseUrl).toString());
  const stateBytes = await fetchBytes(new URL(`/runtime-fixtures/tabpfn35/estimator-golden/${record.stateFile}`, baseUrl).toString());
  if ((await digest(archiveBytes)) !== record.sha256.toLowerCase()) throw typedError(`Estimator golden checksum mismatch: ${record.file}`);
  if ((await digest(stateBytes)) !== record.stateSha256.toLowerCase()) throw typedError(`Estimator golden checksum mismatch: ${record.stateFile}`);
  let state: BrowserGoldenState;
  try { state = JSON.parse(new TextDecoder().decode(stateBytes)) as BrowserGoldenState; } catch { throw typedError(`Estimator golden state is not valid JSON: ${record.stateFile}`); }
  const entries = await readNpz(archiveBytes);
  const arrays: Record<string, BrowserGoldenArray> = {};
  for (const [name, bytes] of entries) arrays[name.replace(/\.npy$/, "")] = parseNpy(bytes);
  for (const required of ["x_train", "x_test", "y_train", "mean"]) if (!arrays[required]) throw typedError(`Estimator golden array is missing: ${record.name}/${required}`);
  return { name: record.name, arrays, state };
}
