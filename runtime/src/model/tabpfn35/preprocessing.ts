import { RuntimeError } from "../errors";
import type { FittedState, PreprocessingConfig, TabularDataset, TrainingDataset } from "../types";

export const TABPFN35_MODEL_VERSION = "3.5-runtime";
export const TABPFN35_PREPROCESSING_VERSION = "tabpfn35-preprocessing-v2";
/**
 * TabPFN 3.5's regression inference profile resolves the automatic
 * outlier-removal setting to twelve standard deviations.  Keeping this value
 * explicit is important: the fitted GPU cache is part of the numerical
 * contract, and using the older four-sigma default changes extreme rows while
 * leaving ordinary rows deceptively unchanged.
 */
export const TABPFN35_SOFT_CLIP_SIGMA = 12;
type RuntimeFloat32Array = Float32Array<ArrayBufferLike>;
export interface PreparedFeatures { readonly values: RuntimeFloat32Array[]; readonly names: readonly string[]; readonly rowCount: number; }

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const SHA256_INITIAL = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);

function rotr(value: number, amount: number): number { return ((value >>> amount) | (value << (32 - amount))) >>> 0; }
function sha256(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8; const paddedLength = ((bytes.length + 9 + 63) >> 6) << 6; const padded = new Uint8Array(paddedLength); padded.set(bytes); padded[bytes.length] = 0x80;
  const lengthView = new DataView(padded.buffer); lengthView.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000), false); lengthView.setUint32(padded.length - 4, bitLength >>> 0, false);
  const state = new Uint32Array(SHA256_INITIAL); const schedule = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) schedule[index] = lengthView.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) { const a = schedule[index - 15]; const b = schedule[index - 2]; const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3); const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10); schedule[index] = (schedule[index - 16] + s0 + schedule[index - 7] + s1) >>> 0; }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) { const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25); const choose = (e & f) ^ (~e & g); const temp1 = (h + s1 + choose + SHA256_K[index] + schedule[index]) >>> 0; const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22); const majority = (a & b) ^ (a & c) ^ (b & c); const temp2 = (s0 + majority) >>> 0; h = g; g = f; f = e; e = (d + temp1) >>> 0; d = c; c = b; b = a; a = (temp1 + temp2) >>> 0; }
    state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0; state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0; state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0; state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
  }
  const result = new Uint8Array(32); const output = new DataView(result.buffer); state.forEach((value, index) => output.setUint32(index * 4, value, false)); return result;
}
function rowBytes(columns: readonly RuntimeFloat32Array[], row: number): Uint8Array {
  const bytes = new Uint8Array(columns.length * 4);
  const view = new DataView(bytes.buffer);
  const decimalScale = Math.fround(1e12);
  for (let index = 0; index < columns.length; index += 1) {
    const value = columns[index][row];
    // The official pipeline records +/-Infinity, replaces those cells with
    // NaN while hashing, then restores the signed infinity after all steps.
    // Hashing the infinity bit pattern directly changes the fingerprint for
    // PASSTHROUGH_INF fixtures even though the model input retains Infinity.
    const hashValue = value === Infinity || value === -Infinity ? Number.NaN : value;
    const scaled = Number.isFinite(hashValue) ? Math.fround(Math.fround(hashValue) * decimalScale) : hashValue;
    const rounded = Number.isFinite(hashValue) ? Math.fround(Math.round(scaled) / decimalScale) : hashValue;
    view.setFloat32(index * 4, rounded, true);
  }
  return bytes;
}
function saltBytes(salt: number): Uint8Array { const bytes = new Uint8Array(8); let value = BigInt(Math.max(0, Math.trunc(salt))); for (let index = 0; index < 8; index += 1) { bytes[index] = Number(value & 0xffn); value >>= 8n; } return bytes; }
function hashToUnit(digest: Uint8Array): number { let value = 0n; for (let index = digest.length - 8; index < digest.length; index += 1) value = (value << 8n) | BigInt(digest[index]); return Math.fround(Number(value) / Number(0xffffffffffffffffn)); }
function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array { const output = new Uint8Array(left.length + right.length); output.set(left); output.set(right, left.length); return output; }
function digestKey(digest: Uint8Array): string { return Array.from(digest, (value) => value.toString(16).padStart(2, "0")).join(""); }
function fingerprintRows(columns: readonly RuntimeFloat32Array[], rows: number, salt: number, resolveCollisions: boolean): RuntimeFloat32Array {
  const output = new Float32Array(rows); const saltBase = saltBytes(salt); const seen = new Set<string>(); const counters = new Map<string, number>();
  for (let row = 0; row < rows; row += 1) {
    const content = rowBytes(columns, row);
    const base = sha256(concatBytes(content, saltBase));
    const baseKey = digestKey(base);
    let offset = resolveCollisions ? counters.get(baseKey) ?? 0 : 0;
    // Match the reference collision counter: repeated row content starts at
    // salt + 1, while an unrelated hash collision advances from that offset.
    let digest = offset === 0 ? base : sha256(concatBytes(content, saltBytes(salt + offset)));
    let key = digestKey(digest);
    while (resolveCollisions && seen.has(key) && !columns.every((column) => Number.isNaN(column[row]))) {
      offset += 1;
      digest = sha256(concatBytes(content, saltBytes(salt + offset)));
      key = digestKey(digest);
    }
    if (resolveCollisions) counters.set(baseKey, offset + 1);
    seen.add(key);
    output[row] = hashToUnit(digest);
  }
  return output;
}

function featureValue(column: RuntimeFloat32Array, row: number, fallback: number): number { const value = column[row]; return Number.isFinite(value) ? value : fallback; }
function meansAndScales(columns: readonly RuntimeFloat32Array[]): { means: Float32Array; scales: Float32Array } {
  const means = new Float32Array(columns.length); const scales = new Float32Array(columns.length);
  for (let c = 0; c < columns.length; c += 1) { let sum = 0; let count = 0; for (const value of columns[c]) if (Number.isFinite(value)) { sum += value; count += 1; } const mean = count ? sum / count : 0; means[c] = Math.fround(mean); let variance = 0; for (const value of columns[c]) if (Number.isFinite(value)) variance += (value - mean) ** 2; const scale = count > 1 ? Math.sqrt(variance / count) : 1; scales[c] = Math.fround(Number.isFinite(scale) && scale > 1e-12 ? scale : 1); }
  return { means, scales };
}
/**
 * NumPy's float32 reductions use a pairwise accumulator rather than a JS
 * double accumulator.  The official TabPFN estimator stores these values as
 * float32 and feeds the same normalized targets to the context graph, so the
 * reduction order is part of the golden numerical contract.
 */
function pairwiseFloat32Sum(values: readonly number[], start = 0, end = values.length): number {
  if (end - start <= 8) {
    let sum = 0;
    for (let index = start; index < end; index += 1) sum = Math.fround(sum + values[index]);
    return sum;
  }
  const middle = start + ((end - start) >> 1);
  return Math.fround(pairwiseFloat32Sum(values, start, middle) + pairwiseFloat32Sum(values, middle, end));
}
function targetStatistics(target: Float32Array): { mean: number; scale: number } {
  const values = [...target];
  const mean = Math.fround(pairwiseFloat32Sum(values) / values.length);
  const squared = values.map((value) => Math.fround((value - mean) * (value - mean)));
  const variance = Math.fround(pairwiseFloat32Sum(squared) / values.length);
  const scale = Math.fround(Math.sqrt(variance));
  return { mean, scale: Number.isFinite(scale) && scale > 1e-12 ? scale : 1 };
}
function deterministicPermutation(size: number, seed: number): number[] { const out = Array.from({ length: size }, (_, i) => i); let state = (seed >>> 0) || 0x9e3779b9; for (let i = size - 1; i > 0; i -= 1) { state = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0; const j = state % (i + 1); [out[i], out[j]] = [out[j], out[i]]; } return out; }
function rotatePermutation(size: number, shift: number): number[] { if (size === 0) return []; const normalized = ((shift % size) + size) % size; return Array.from({ length: size }, (_, index) => (index - normalized + size) % size); }
function validatePermutation(permutation: readonly number[], size: number): number[] { if (permutation.length !== size || new Set(permutation).size !== size || permutation.some((value) => !Number.isSafeInteger(value) || value < 0 || value >= size)) throw new RuntimeError("SCHEMA_MISMATCH", "Invalid TabPFN feature permutation"); return [...permutation]; }
function selectNonConstant(columns: readonly RuntimeFloat32Array[]): number[] { const selected: number[] = []; for (let column = 0; column < columns.length; column += 1) { let first: number | undefined; let varies = false; for (const value of columns[column]) { if (Number.isNaN(value)) continue; if (first === undefined) first = value; else if (value !== first) { varies = true; break; } } if (first !== undefined && (varies || columns[column].some((value) => Number.isNaN(value)))) selected.push(column); } if (selected.length === 0) throw new RuntimeError("SHAPE_UNSUPPORTED", "All TabPFN features are constant or missing"); return selected; }
function softClipBounds(columns: readonly RuntimeFloat32Array[], sigma = TABPFN35_SOFT_CLIP_SIGMA): { lower: Float32Array; upper: Float32Array } { const lower = new Float32Array(columns.length); const upper = new Float32Array(columns.length); for (let column = 0; column < columns.length; column += 1) { const finite = Array.from(columns[column]).filter(Number.isFinite); const mean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0; const variance = finite.length > 1 ? finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1) : 0; const firstLower = mean - sigma * Math.sqrt(variance); const firstUpper = mean + sigma * Math.sqrt(variance); const cleaned = finite.filter((value) => value >= firstLower && value <= firstUpper); const cleanMean = cleaned.length ? cleaned.reduce((a, b) => a + b, 0) / cleaned.length : mean; const cleanVariance = cleaned.length > 1 ? cleaned.reduce((sum, value) => sum + (value - cleanMean) ** 2, 0) / (cleaned.length - 1) : 0; const cleanStd = Math.sqrt(cleanVariance); lower[column] = Math.fround(cleanMean - sigma * cleanStd); upper[column] = Math.fround(cleanMean + sigma * cleanStd); } return { lower, upper }; }
function configuredSoftClipBounds(config: PreprocessingConfig, columns: readonly RuntimeFloat32Array[]): { lower: Float32Array; upper: Float32Array } {
  const lower = config.softClipLower;
  const upper = config.softClipUpper;
  if (lower === undefined && upper === undefined) return softClipBounds(columns);
  if (lower === undefined || upper === undefined || lower.length !== columns.length || upper.length !== columns.length || lower.some((value) => !Number.isFinite(value)) || upper.some((value) => !Number.isFinite(value))) throw new RuntimeError("SCHEMA_MISMATCH", "Official soft-clip bounds do not match fitted feature count");
  return { lower: new Float32Array(lower), upper: new Float32Array(upper) };
}
function softClip(value: number, lower: number, upper: number): number { if (!Number.isFinite(value)) return value; const clampedLower = Math.max(-Math.log(1 + Math.abs(value)) + lower, value); return Math.min(Math.log(1 + Math.abs(clampedLower)) + upper, clampedLower); }
function fitWeights(columns: readonly RuntimeFloat32Array[], target: Float32Array, means: Float32Array, scales: Float32Array, targetMean: number, targetScale: number): { weights: Float32Array; bias: number } { const weights = new Float32Array(columns.length); for (let c = 0; c < columns.length; c += 1) { let cov = 0; let variance = 0; for (let row = 0; row < target.length; row += 1) { const x = (featureValue(columns[c], row, means[c]) - means[c]) / scales[c]; const normalizedTarget = (target[row] - targetMean) / targetScale; cov += x * normalizedTarget; variance += x * x; } weights[c] = Math.fround(variance > 1e-12 ? cov / variance : 0); } return { weights, bias: 0 }; }

export function fitPreprocessing(dataset: TrainingDataset, config: PreprocessingConfig, bounds = { minRows: 3, maxRows: 1024, maxFeatures: 32 }): FittedState {
  if (dataset.target.length !== dataset.rowCount || dataset.columns.some((column) => column.length !== dataset.rowCount)) throw new RuntimeError("INVALID_DATA", "Training column lengths do not match row count");
  if ([...dataset.target].some((value) => !Number.isFinite(value))) throw new RuntimeError("NONFINITE_TARGET", "Training target must be finite");
  if (dataset.rowCount < bounds.minRows || dataset.rowCount > bounds.maxRows) throw new RuntimeError("SHAPE_UNSUPPORTED", `Training rows must be between ${bounds.minRows} and ${bounds.maxRows}`);
  if (dataset.columns.length === 0) throw new RuntimeError("INVALID_DATA", "At least one feature is required");
  if (dataset.columnNames.length !== dataset.columns.length || new Set(dataset.columnNames).size !== dataset.columnNames.length) throw new RuntimeError("SCHEMA_MISMATCH", "Training feature names must be unique and ordered");
  const passthroughInf = config.passthroughInf ?? false; for (const column of dataset.columns) if (!passthroughInf && [...column].some((value) => value === Infinity || value === -Infinity)) throw new RuntimeError("INF_DISABLED", "TabPFN runtime profile does not accept Infinity features");
  const selected = selectNonConstant(dataset.columns); const selectedColumns = selected.map((index) => new Float32Array(dataset.columns[index]));
  const fingerprintEnabled = config.featureFingerprint ?? (config.profile === "tabpfn35-none" || config.profile === "tabpfn35-fingerprint"); const fingerprintSalt = dataset.rowCount * selectedColumns.length;
  const trainFingerprint = fingerprintEnabled ? fingerprintRows(selectedColumns, dataset.rowCount, fingerprintSalt, true) : undefined; const baseColumns = fingerprintEnabled ? [...selectedColumns, trainFingerprint!] : selectedColumns; const baseNames = fingerprintEnabled ? [...selected.map((index) => dataset.columnNames[index]), "__fingerprint"] : selected.map((index) => dataset.columnNames[index]);
  if (baseColumns.length > bounds.maxFeatures) throw new RuntimeError("SHAPE_UNSUPPORTED", "Preprocessed feature count exceeds model limit");
  const suppliedPermutation = config.featurePermutation; const permutation = suppliedPermutation ? validatePermutation(suppliedPermutation, baseColumns.length) : config.featureShiftDecoder === "rotate" ? rotatePermutation(baseColumns.length, config.featureShiftCount ?? 0) : deterministicPermutation(baseColumns.length, config.seed);
  const orderedColumns = permutation.map((index) => baseColumns[index]); const orderedNames = permutation.map((index) => baseNames[index]); const clip = configuredSoftClipBounds(config, orderedColumns);
  const transformedTrain = orderedColumns.map((column, columnIndex) => { const out = new Float32Array(column.length); for (let row = 0; row < column.length; row += 1) out[row] = Math.fround(softClip(column[row], clip.lower[columnIndex], clip.upper[columnIndex])); return out; });
  const { means, scales } = meansAndScales(transformedTrain); const target = targetStatistics(dataset.target); const targetMean = target.mean; const targetScale = target.scale; const fitted = fitWeights(transformedTrain, dataset.target, means, scales, targetMean, targetScale);
  return { profile: config.profile, seed: config.seed, featureNames: orderedNames, featureMeans: means, featureScales: scales, targetMean, targetScale, featurePermutation: permutation, modelWeights: fitted.weights, modelBias: fitted.bias, extra: { preprocessingVersion: TABPFN35_PREPROCESSING_VERSION, modelInputMode: "official-none", featureFingerprint: fingerprintEnabled, fingerprintSalt, selectedFeatureIndices: selected, featureShiftDecoder: config.featureShiftDecoder ?? (suppliedPermutation ? "shuffle" : null), featureShiftCount: config.featureShiftCount ?? 0, softClipSigma: TABPFN35_SOFT_CLIP_SIGMA, softClipLower: [...clip.lower], softClipUpper: [...clip.upper], passthroughInf, originalFeatureNames: [...dataset.columnNames] } };
}

function officialSource(dataset: TabularDataset, state: FittedState, resolveCollisions: boolean): Float32Array[] {
  const originalNames = Array.isArray(state.extra?.originalFeatureNames) ? state.extra.originalFeatureNames.map(String) : state.featureNames; if (dataset.columnNames.length !== originalNames.length || dataset.columnNames.some((name, index) => name !== originalNames[index])) throw new RuntimeError("SCHEMA_MISMATCH", "Prediction feature schema does not match fitted context");
  const selected = Array.isArray(state.extra?.selectedFeatureIndices) ? state.extra.selectedFeatureIndices.map(Number) : Array.from({ length: dataset.columns.length }, (_, index) => index); if (selected.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= dataset.columns.length)) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "TabPFN fitted feature selection is invalid");
  const columns: RuntimeFloat32Array[] = selected.map((index) => new Float32Array(dataset.columns[index])); if (state.extra?.featureFingerprint === true) columns.push(fingerprintRows(columns, dataset.rowCount, Number(state.extra?.fingerprintSalt ?? 0), resolveCollisions));
  const lower = Array.isArray(state.extra?.softClipLower) ? state.extra.softClipLower.map(Number) : []; const upper = Array.isArray(state.extra?.softClipUpper) ? state.extra.softClipUpper.map(Number) : [];
  return state.featurePermutation.map((sourceIndex, outputIndex) => { if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0 || sourceIndex >= columns.length) throw new RuntimeError("CONTEXT_INCOMPATIBLE", "TabPFN fitted feature permutation is invalid"); const source = columns[sourceIndex]; const output = new Float32Array(dataset.rowCount); for (let row = 0; row < dataset.rowCount; row += 1) { const value = source[row]; output[row] = (value === Infinity || value === -Infinity) && state.extra?.passthroughInf === true ? value : Math.fround(softClip(value, lower[outputIndex] ?? -Infinity, upper[outputIndex] ?? Infinity)); } return output; });
}

export function transformFeatures(dataset: TabularDataset, state: FittedState): PreparedFeatures {
  if (dataset.rowCount <= 0 || dataset.columns.some((column) => column.length !== dataset.rowCount)) throw new RuntimeError("INVALID_DATA", "Prediction column lengths do not match row count"); for (const column of dataset.columns) if (!state.extra?.passthroughInf && [...column].some((value) => value === Infinity || value === -Infinity)) throw new RuntimeError("INF_DISABLED", "TabPFN runtime profile does not accept Infinity features");
  if (state.extra?.modelInputMode === "official-none") return { values: officialSource(dataset, state, false), names: [...state.featureNames], rowCount: dataset.rowCount };
  const originalNames = Array.isArray(state.extra?.originalFeatureNames) ? state.extra.originalFeatureNames.map(String) : state.featureNames; if (dataset.columnNames.length !== originalNames.length || dataset.columnNames.some((name, index) => name !== originalNames[index])) throw new RuntimeError("SCHEMA_MISMATCH", "Prediction feature schema does not match fitted context"); const source = state.extra?.featureFingerprint ? [...dataset.columns, fingerprintRows(dataset.columns, dataset.rowCount, Number(state.extra?.fingerprintSalt ?? 0), false)] : dataset.columns.map((column) => new Float32Array(column)); if (source.length !== state.featurePermutation.length) throw new RuntimeError("SCHEMA_MISMATCH", "Prediction feature count does not match fitted context"); const values = state.featurePermutation.map((sourceIndex, outputIndex) => { const column = source[sourceIndex]; const out = new Float32Array(dataset.rowCount); const mean = state.featureMeans[outputIndex]; const scale = state.featureScales[outputIndex] || 1; for (let row = 0; row < dataset.rowCount; row += 1) out[row] = Math.fround((featureValue(column, row, mean) - mean) / scale); return out; }); return { values, names: [...state.featureNames], rowCount: dataset.rowCount };
}

/** Transform the fitted training rows with the official collision-resolving
 * fingerprint mode. Prediction transforms intentionally keep duplicate rows
 * on the base hash, matching TabPFN's `is_test=true` path. */
export function transformTrainingFeatures(dataset: TabularDataset, state: FittedState): PreparedFeatures {
  if (dataset.rowCount <= 0 || dataset.columns.some((column) => column.length !== dataset.rowCount)) throw new RuntimeError("INVALID_DATA", "Training column lengths do not match row count");
  if (state.extra?.modelInputMode === "official-none") return { values: officialSource(dataset, state, true), names: [...state.featureNames], rowCount: dataset.rowCount };
  return transformFeatures(dataset, state);
}
export function checkPreparedShape(prepared: PreparedFeatures, bounds = { minRows: 1, maxRows: 1024, maxFeatures: 32 }): void { if (prepared.rowCount < bounds.minRows || prepared.rowCount > bounds.maxRows || prepared.values.length > bounds.maxFeatures) throw new RuntimeError("SHAPE_UNSUPPORTED", "Prepared prediction shape is outside model bounds"); }
