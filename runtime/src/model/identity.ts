import type { ContextIdentity, ModelId, PreprocessingConfig, TrainingDataset } from "./types";

/* Identity bytes are independent of JSON.stringify: JSON loses signed zero,
 * turns NaN/Infinity into null and does not preserve integer widths. */
const textEncoder = new TextEncoder();

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Identity lengths must be non-negative safe integers");
  const out = new Uint8Array(8); let n = BigInt(value);
  for (let i = 0; i < 8; i += 1) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
}
function frame(tag: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + 8 + bytes.byteLength); out[0] = tag; out.set(u64(bytes.byteLength), 1); out.set(bytes, 9); return out;
}
function concat(parts: readonly Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.byteLength, 0); const out = new Uint8Array(size); let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; } return out;
}
function numberBytes(value: number): Uint8Array {
  const buffer = new ArrayBuffer(8); const view = new DataView(buffer); view.setFloat64(0, Number.isNaN(value) ? Number.NaN : value, true); return new Uint8Array(buffer);
}
function typedBytes(value: ArrayBufferView): Uint8Array {
  if (value instanceof Float32Array) {
    const out = new Uint8Array(value.length * 4); const view = new DataView(out.buffer);
    for (let i = 0; i < value.length; i += 1) {
      const raw = new DataView(value.buffer, value.byteOffset + i * 4, 4).getUint32(0, true);
      view.setUint32(i * 4, Number.isNaN(value[i]) ? 0x7fc00000 : raw, true);
    }
    return out;
  }
  if (value instanceof Float64Array) {
    const out = new Uint8Array(value.length * 8); const view = new DataView(out.buffer);
    for (let i = 0; i < value.length; i += 1) view.setFloat64(i * 8, Number.isNaN(value[i]) ? Number.NaN : value[i], true);
    return out;
  }
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
function bytesFor(value: unknown): Uint8Array {
  if (value === null) return frame(0, new Uint8Array());
  if (value === undefined) return frame(1, new Uint8Array());
  if (typeof value === "string") return frame(2, textEncoder.encode(value));
  if (typeof value === "number") return frame(3, numberBytes(value));
  if (typeof value === "bigint") return frame(4, textEncoder.encode(value.toString(10)));
  if (typeof value === "boolean") return frame(value ? 5 : 6, new Uint8Array());
  if (ArrayBuffer.isView(value)) return frame(7, typedBytes(value));
  if (value instanceof ArrayBuffer) return frame(8, new Uint8Array(value));
  if (Array.isArray(value)) return frame(9, concat(value.map(bytesFor)));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return frame(10, concat(entries.flatMap(([key, item]) => [bytesFor(key), bytesFor(item)])));
  }
  throw new TypeError(`Unsupported identity value: ${typeof value}`);
}
export function canonicalBytes(value: unknown): Uint8Array { return bytesFor(value); }

/* Portable fallback for environments without Web Crypto. */
function sha256Fallback(input: Uint8Array): Uint8Array {
  const k = new Uint32Array([
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
  ]);
  const bitLength = input.byteLength * 8; const padded = new Uint8Array(((input.byteLength + 9 + 63) >> 6) << 6); padded.set(input); padded[input.byteLength] = 0x80;
  const end = padded.byteLength - 8; const endView = new DataView(padded.buffer); endView.setUint32(end, Math.floor(bitLength / 0x100000000), false); endView.setUint32(end + 4, bitLength >>> 0, false);
  let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;
  const rotr=(x:number,n:number)=>(x>>>n)|(x<<(32-n));
  for (let off=0;off<padded.length;off+=64) {
    const w=new Uint32Array(64); const dv=new DataView(padded.buffer,off,64); for(let i=0;i<16;i++)w[i]=dv.getUint32(i*4,false);
    for(let i=16;i<64;i++){const s0=rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);const s1=rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);w[i]=(w[i-16]+s0+w[i-7]+s1)>>>0;}
    let a=h0,b=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;
    for(let i=0;i<64;i++){const S1=rotr(e,6)^rotr(e,11)^rotr(e,25);const ch=(e&f)^((~e)&g);const t1=(hh+S1+ch+k[i]+w[i])>>>0;const S0=rotr(a,2)^rotr(a,13)^rotr(a,22);const maj=(a&b)^(a&c)^(b&c);const t2=(S0+maj)>>>0;hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+hh)>>>0;
  }
  const out=new Uint8Array(32);const dv=new DataView(out.buffer);[h0,h1,h2,h3,h4,h5,h6,h7].forEach((v,i)=>dv.setUint32(i*4,v,false));return out;
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)) : sha256Fallback(bytes);
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
export async function digestFloat32Columns(columns: readonly Float32Array[], target?: Float32Array): Promise<string> { return sha256Hex(canonicalBytes({ columns, target: target ?? null })); }
export interface TypedSqlParameter { readonly type: "null" | "string" | "boolean" | "int64" | "float64" | "bytes"; readonly value: string | boolean | null | Uint8Array; }
export function canonicalSqlParameters(parameters: readonly TypedSqlParameter[]): Uint8Array { return canonicalBytes(parameters); }
export function parsePreprocessingConfig(input: Partial<PreprocessingConfig> & { profile?: PreprocessingConfig["profile"] }): PreprocessingConfig {
  const profile = input.profile ?? "tabpfn35-none"; const seed = input.seed ?? 0;
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("seed must be a non-negative safe integer");
  if (profile !== "tabpfn35-none" && profile !== "tabpfn35-fingerprint" && profile !== "tabpfn35-permutation" && profile !== "tabicl-case") throw new TypeError(`Unsupported preprocessing profile: ${profile}`);
  const permutation = input.featurePermutation ? [...input.featurePermutation] : undefined;
  if (permutation && permutation.some((value) => !Number.isSafeInteger(value) || value < 0)) throw new TypeError("Invalid feature permutation");
  const softClipLower = input.softClipLower ? [...input.softClipLower] : undefined;
  const softClipUpper = input.softClipUpper ? [...input.softClipUpper] : undefined;
  if ((softClipLower && !softClipUpper) || (!softClipLower && softClipUpper) || (softClipLower && softClipUpper && (softClipLower.length !== softClipUpper.length || softClipLower.some((value) => !Number.isFinite(value)) || softClipUpper.some((value) => !Number.isFinite(value))))) throw new TypeError("Invalid soft-clip bounds");
  return { profile, seed, passthroughInf: input.passthroughInf ?? false, featureFingerprint: input.featureFingerprint ?? (profile === "tabpfn35-none" || profile === "tabpfn35-fingerprint"), featurePermutation: permutation, featureShiftDecoder: input.featureShiftDecoder ?? null, featureShiftCount: input.featureShiftCount ?? 0, softClipLower, softClipUpper, version: input.version };
}
export async function buildContextIdentity(args: {
  modelId: ModelId; modelVersion: string; artifactManifestDigest: string; preprocessingVersion: string;
  contextFormatVersion?: number; dataset: TrainingDataset; featureSqlFingerprint: string | null;
  config: PreprocessingConfig; schemaDigest?: string; typedSqlParams?: readonly unknown[];
}): Promise<ContextIdentity> {
  const trainingDataDigest = await digestFloat32Columns(args.dataset.columns, args.dataset.target);
  const schemaDigest = args.schemaDigest ?? await sha256Hex(canonicalBytes({ names: args.dataset.columnNames, rows: args.dataset.rowCount, target: args.dataset.targetName }));
  const configurationDigest = await sha256Hex(canonicalBytes(args.config));
  const sqlParametersDigest = await sha256Hex(canonicalBytes(args.typedSqlParams ?? null));
  const keyRecord = { modelId: args.modelId, modelVersion: args.modelVersion, artifactManifestDigest: args.artifactManifestDigest, contextFormatVersion: args.contextFormatVersion ?? 1, preprocessingVersion: args.preprocessingVersion, trainingDataDigest, featureSqlFingerprint: args.featureSqlFingerprint, sqlParametersDigest, schemaDigest, targetName: args.dataset.targetName, configurationDigest };
  return { ...keyRecord, key: await sha256Hex(canonicalBytes(keyRecord)) };
}
