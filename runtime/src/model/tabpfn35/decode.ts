import { RuntimeError } from "../errors";

export interface DecoderState {
  readonly temperature?: number;
  readonly borders?: readonly number[];
  /** Borders used by the graph that produced raw logits. When set together
   * with `translateProbabilities`, the official TabPFN probability transfer
   * is applied before decoding. */
  readonly sourceBorders?: readonly number[];
  readonly translateProbabilities?: boolean;
  readonly targetMean: number;
  readonly targetScale: number;
}

export const TABPFN35_REGRESSION_BINS = 5000;

/** Quantiles in original target units, using the same translated distribution as mean. */
export function decodeRegressionQuantiles(logits: ArrayLike<number>, dims: readonly number[], state: DecoderState): { q25: Float32Array; q75: Float32Array } {
  const rows = dims[0]; const bins = dims.at(-1)!;
  if ((dims.length !== 2 && dims.length !== 3) || (dims.length === 3 && dims[1] !== 1) || !Number.isSafeInteger(rows) || rows < 1 || bins !== TABPFN35_REGRESSION_BINS || logits.length !== rows * bins) throw new RuntimeError("SHAPE_UNSUPPORTED", "Invalid quantile logits shape");
  const temperature = state.temperature ?? 1;
  if (!Number.isFinite(temperature) || temperature <= 0 || !Number.isFinite(state.targetMean) || !Number.isFinite(state.targetScale) || state.targetScale <= 0) throw new RuntimeError("INVALID_DATA", "Invalid quantile decoder statistics");
  const borders = state.borders ? [...state.borders] : [...tabPFN35RegressionBorders(bins)];
  validateBorders(borders, bins + 1);
  const raw = borders.map(b => Math.fround(Math.fround(b * state.targetScale) + state.targetMean));
  const q25 = new Float32Array(rows); const q75 = new Float32Array(rows);
  for (let row = 0; row < rows; row++) {
    const probabilities = state.translateProbabilities
      ? translateProbabilities(logits, row * bins, bins, rows, temperature, state.sourceBorders ?? borders, borders)
      : stableSoftmaxFloat32(logits, row * bins, bins, temperature);
    const total = probabilities.reduce((sum, p) => sum + p, 0);
    if (!(total > 0) || !Number.isFinite(total)) throw new RuntimeError("RESULT_INVALID", "Invalid quantile probability mass");
    for (const [q, output] of [[0.25, q25], [0.75, q75]] as const) {
      const threshold = q * total; let before = 0; let bin = 0;
      while (bin < bins - 1 && before + probabilities[bin] < threshold) before += probabilities[bin++];
      const share = Math.max(0, Math.min(1, (threshold - before) / probabilities[bin]));
      const width = raw[bin + 1] - raw[bin];
      // Official TabPFN 9.0 icdf uses linear interpolation in every bucket,
      // including outer buckets (unlike its half-normal mean calculation).
      output[row] = raw[bin] + width * share;
      if (!Number.isFinite(output[row])) throw new RuntimeError("RESULT_INVALID", "Non-finite quantile");
    }
  }
  return { q25, q75 };
}
// torch.distributions.HalfNormal(torch.tensor(1., dtype=float32)) values used
// by FullSupportBarDistribution for the two unbounded tail buckets.
const HALF_NORMAL_MEDIAN = 0.6744897365570068;
const HALF_NORMAL_MEAN_FACTOR = 0.7978845834732056;

/** The official TabPFN 3.5 spline control points, in normalized target units. */
const BORDER_REFERENCE_POINTS = [
  [0, -128], [5, -16.9], [20, -13], [100, -9.9], [200, -8.47], [500, -6.48], [1000, -4.4], [2500, 0],
] as const;

/** Reproduce `_spline_based_regression_borders(5000)` without a model import. */
export function tabPFN35RegressionBorders(binCount = TABPFN35_REGRESSION_BINS): Float32Array {
  if (!Number.isSafeInteger(binCount) || binCount < 2) throw new RuntimeError("SHAPE_UNSUPPORTED", "Regression decoder requires at least two bins");
  const points = [...BORDER_REFERENCE_POINTS, ...BORDER_REFERENCE_POINTS.slice(0, -1).reverse().map(([index, value]) => [5000 - index, -value] as const)];
  const scale = binCount / 5000;
  const output = new Float32Array(binCount + 1);
  let segment = 0;
  for (let index = 0; index <= binCount; index += 1) {
    const x = index;
    while (segment + 1 < points.length && x > points[segment + 1][0] * scale) segment += 1;
    if (segment + 1 >= points.length) { output[index] = points[points.length - 1][1]; continue; }
    const [x0, y0] = points[segment]; const [x1, y1] = points[segment + 1];
    const left = x0 * scale; const right = x1 * scale;
    const fraction = right === left ? 0 : (x - left) / (right - left);
    output[index] = Math.fround(y0 + (y1 - y0) * fraction);
  }
  return output;
}

function validateBorders(borders: readonly number[], expectedLength: number): void {
  if (borders.length !== expectedLength || borders.some((value) => !Number.isFinite(value))) throw new RuntimeError("RESULT_INVALID", "Regression decoder borders are invalid");
  for (let index = 1; index < borders.length; index += 1) if (borders[index] < borders[index - 1]) throw new RuntimeError("RESULT_INVALID", "Regression decoder borders must be sorted");
}

function pairwiseFloat32Sum(values: ArrayLike<number>, start = 0, end = values.length): number {
  if (end - start <= 8) {
    let sum = 0;
    for (let index = start; index < end; index += 1) sum = Math.fround(sum + Number(values[index]));
    return sum;
  }
  const middle = start + ((end - start) >> 1);
  return Math.fround(pairwiseFloat32Sum(values, start, middle) + pairwiseFloat32Sum(values, middle, end));
}

function stableSoftmaxFloat32(logits: ArrayLike<number>, start: number, count: number, temperature: number): Float32Array {
  let maximum = -Infinity;
  for (let index = 0; index < count; index += 1) {
    const value = Number(logits[start + index]);
    if (Number.isNaN(value) || value === Infinity) throw new RuntimeError("RESULT_INVALID", `Non-finite regression logit at ${Math.floor(start / count)}:${index}`);
    const scaled = value / temperature;
    if (scaled > maximum) maximum = scaled;
  }
  if (maximum === -Infinity) throw new RuntimeError("RESULT_INVALID", "Regression logits contain no finite probability mass");
  const output = new Float32Array(count);
  let denominator = 0;
  for (let index = 0; index < count; index += 1) {
    const value = Number(logits[start + index]);
    output[index] = value === -Infinity ? 0 : Math.fround(Math.exp(Math.fround(value / temperature - maximum)));
    denominator += output[index];
  }
  if (!Number.isFinite(denominator) || denominator <= 0) throw new RuntimeError("RESULT_INVALID", "Regression logits have invalid probability mass");
  for (let index = 0; index < count; index += 1) output[index] = Math.fround(output[index] / denominator);
  return output;
}

function lowerBound(values: readonly number[], value: number): number {
  let left = 0;
  let right = values.length;
  while (left < right) {
    const middle = left + ((right - left) >> 1);
    if (values[middle] < value) left = middle + 1;
    else right = middle;
  }
  return left;
}

/** Reproduce tabpfn.utils.translate_probs_across_borders for one row. The
 * official helper intentionally computes a CDF even when the border arrays
 * are equal; retaining that cumsum/difference round trip matters for the
 * reference mean at the 1e-4 budget. */
function scanThreadsX(rowCount: number, rowSize: number): number {
  let logRows = 0;
  let logSize = 0;
  while ((1 << logRows) < rowCount) logRows += 1;
  while ((1 << logSize) < rowSize) logSize += 1;
  const raw = Math.trunc((9 + logSize - logRows) / 2);
  return 1 << Math.min(9, Math.max(4, raw));
}

/** The CUDA cumsum kernel used by the official reference performs a
 * Sklansky inclusive scan over two values per thread, with a carried block
 * total. Reproducing that order avoids the tail-mass drift of a sequential
 * JavaScript sum while remaining provider-independent. */
function cudaInclusiveScan(probabilities: Float32Array, rowCount: number): Float32Array {
  const threadsX = scanThreadsX(rowCount, probabilities.length);
  const chunkSize = threadsX * 2;
  const cumulative = new Float32Array(probabilities.length);
  let blockTotal = 0;
  for (let blockStart = 0; blockStart < probabilities.length; blockStart += chunkSize) {
    const buffer = new Float32Array(chunkSize);
    for (let index = 0; index < chunkSize; index += 1) {
      const source = blockStart + index;
      buffer[index] = source < probabilities.length ? probabilities[source] : 0;
    }
    buffer[0] = Math.fround(buffer[0] + blockTotal);
    for (let stride = 1; stride <= threadsX; stride <<= 1) {
      for (let thread = 0; thread < threadsX; thread += 1) {
        const start = Math.floor(thread / stride) * (stride * 2) + stride;
        const target = start + (thread % stride);
        const source = start - 1;
        buffer[target] = Math.fround(buffer[target] + buffer[source]);
      }
    }
    for (let index = 0; index < chunkSize && blockStart + index < probabilities.length; index += 1) cumulative[blockStart + index] = buffer[index];
    blockTotal = buffer[chunkSize - 1];
  }
  return cumulative;
}

function translateProbabilities(logits: ArrayLike<number>, start: number, binCount: number, rowCount: number, temperature: number, from: readonly number[], to: readonly number[]): Float32Array {
  validateBorders(from, binCount + 1);
  if (to.length < 2 || to.some((value) => !Number.isFinite(value)) || to.some((value, index) => index > 0 && value < to[index - 1])) throw new RuntimeError("RESULT_INVALID", "Regression target borders are invalid");
  const probabilities = stableSoftmaxFloat32(logits, start, binCount, temperature);
  const cumulative = cudaInclusiveScan(probabilities, rowCount);
  const probabilityBefore = new Float32Array(binCount);
  for (let index = 0; index < binCount; index += 1) {
    // PyTorch computes `torch.cumsum(probs) - probs`, rather than indexing
    // the previous cumulative element. The subtraction is observable in the
    // low bits and is part of the official border-translation result.
    probabilityBefore[index] = Math.fround(cumulative[index] - probabilities[index]);
  }
  const cdfValues = new Float32Array(to.length);
  for (let border = 0; border < to.length; border += 1) {
    const value = to[border];
    let bucket = lowerBound(from, value) - 1;
    if (value === from[0]) bucket = 0;
    if (value === from[from.length - 1]) bucket = binCount - 1;
    bucket = Math.max(0, Math.min(binCount - 1, bucket));
    const width = Number(from[bucket + 1]) - Number(from[bucket]);
    const share = width > 0 ? Math.max(0, Math.min(1, (value - Number(from[bucket])) / width)) : 0;
    const before = probabilityBefore[bucket];
    let cdf = Math.fround(before + probabilities[bucket] * share);
    if (value <= from[0]) cdf = 0;
    if (value >= from[from.length - 1]) cdf = 1;
    cdfValues[border] = Math.fround(Math.max(0, Math.min(1, cdf)));
  }
  cdfValues[0] = 0;
  cdfValues[cdfValues.length - 1] = 1;
  const translated = new Float32Array(to.length - 1);
  for (let index = 0; index < translated.length; index += 1) translated[index] = Math.max(0, Math.fround(cdfValues[index + 1] - cdfValues[index]));
  return translated;
}

/**
 * Decode the complete TabPFN regression distribution. ORT returns raw logits
 * with shape `[rows, 1, 5000]`; each bin contributes its midpoint after the
 * stable temperature softmax, then the normalized target is restored to raw
 * target units. The one-value linear decoder below remains only for the
 * explicitly unconfigured compatibility path.
 */
export function decodeRegressionMean(logits: ArrayLike<number>, dims: readonly number[], state: DecoderState): Float32Array {
  if (dims.length !== 3 && dims.length !== 2) throw new RuntimeError("SHAPE_UNSUPPORTED", "Regression logits must have rank 2 or 3");
  const rowCount = dims.length === 3 ? (dims[1] === 1 ? Number(dims[0]) : -1) : Number(dims[0]);
  const binCount = dims.length === 3 ? Number(dims[2]) : Number(dims[1]);
  if (!Number.isSafeInteger(rowCount) || rowCount < 1 || binCount !== TABPFN35_REGRESSION_BINS || logits.length !== rowCount * binCount) throw new RuntimeError("SHAPE_UNSUPPORTED", "Regression logits shape must be [rows, 1, 5000] or [rows, 5000]");
  const temperature = state.temperature ?? 1;
  if (!Number.isFinite(temperature) || temperature <= 0) throw new RuntimeError("INVALID_DATA", "Decoder temperature must be positive");
  if (!Number.isFinite(state.targetMean) || !Number.isFinite(state.targetScale) || state.targetScale <= 0) throw new RuntimeError("INVALID_DATA", "Decoder target statistics are invalid");
  const borders = state.borders ? [...state.borders] : [...tabPFN35RegressionBorders(binCount)];
  validateBorders(borders, binCount + 1);
  // The published estimator decodes in raw target units.  Construct the
  // raw-space borders with float32 operations before taking widths/midpoints;
  // transforming a normalized mean after the weighted sum is observably
  // different for the very wide tail buckets.
  const rawBorders = new Float32Array(binCount + 1);
  for (let index = 0; index <= binCount; index += 1) rawBorders[index] = Math.fround(Math.fround(Number(borders[index]) * state.targetScale) + state.targetMean);
  const bucketMeans = new Float32Array(binCount);
  for (let index = 0; index < binCount; index += 1) {
    const width = Math.fround(Number(rawBorders[index + 1]) - Number(rawBorders[index]));
    bucketMeans[index] = Math.fround(Number(rawBorders[index]) + Math.fround(width / 2));
  }
  // FullSupportBarDistribution models the first and last buckets as half-normal
  // tails rather than uniform intervals.  Its mean() replaces the ordinary
  // midpoint for exactly these two buckets.
  const leftWidth = Math.fround(Number(rawBorders[1]) - Number(rawBorders[0]));
  const rightWidth = Math.fround(Number(rawBorders[binCount]) - Number(rawBorders[binCount - 1]));
  const leftScale = Math.fround(leftWidth / HALF_NORMAL_MEDIAN);
  const rightScale = Math.fround(rightWidth / HALF_NORMAL_MEDIAN);
  const leftMean = Math.fround(leftScale * HALF_NORMAL_MEAN_FACTOR);
  const rightMean = Math.fround(rightScale * HALF_NORMAL_MEAN_FACTOR);
  bucketMeans[0] = Math.fround(-leftMean + Number(rawBorders[1]));
  bucketMeans[binCount - 1] = Math.fround(rightMean + Number(rawBorders[binCount - 1]));
  const output = new Float32Array(rowCount);
  for (let row = 0; row < rowCount; row += 1) {
    if (state.translateProbabilities) {
      const sourceBorders = state.sourceBorders ? [...state.sourceBorders] : borders;
      const translated = translateProbabilities(logits, row * binCount, binCount, rowCount, temperature, sourceBorders, borders);
      let maximum = -Infinity;
      const exponentials = new Float32Array(binCount);
      for (let bin = 0; bin < binCount; bin += 1) {
        const value = translated[bin] > 0 ? Math.fround(Math.log(translated[bin])) : -Infinity;
        exponentials[bin] = value;
        if (value > maximum) maximum = value;
      }
      if (maximum === -Infinity) throw new RuntimeError("RESULT_INVALID", `Regression decoder produced an empty probability row at ${row}`);
      let denominator = 0;
      const normalized = new Float32Array(binCount);
      for (let bin = 0; bin < binCount; bin += 1) {
        const value = exponentials[bin] === -Infinity ? 0 : Math.fround(Math.exp(Math.fround(exponentials[bin] - maximum)));
        normalized[bin] = value;
        denominator += value;
      }
      if (!Number.isFinite(denominator) || denominator <= 0) throw new RuntimeError("RESULT_INVALID", `Regression decoder produced an invalid probability row at ${row}`);
      let numerator = 0;
      for (let bin = 0; bin < binCount; bin += 1) numerator += Math.fround(normalized[bin] / denominator) * bucketMeans[bin];
      if (!Number.isFinite(numerator)) throw new RuntimeError("RESULT_INVALID", `Regression decoder produced an invalid row at ${row}`);
      output[row] = Math.fround(numerator);
    } else {
      let max = -Infinity;
      for (let bin = 0; bin < binCount; bin += 1) {
        const value = Number(logits[row * binCount + bin]);
        // TabPFN masks bins outside the fitted support with `-Infinity`.  Those
        // logits are valid softmax inputs (their probability is exactly zero),
        // while NaN and positive infinity would make the distribution
        // undefined and must still fail closed.
        if (Number.isNaN(value) || value === Infinity) throw new RuntimeError("RESULT_INVALID", `Non-finite regression logit at ${row}:${bin}`);
        const scaled = value / temperature;
        if (scaled > max) max = scaled;
      }
      const weights = new Float32Array(binCount);
      const contributions = new Float32Array(binCount);
      for (let bin = 0; bin < binCount; bin += 1) {
        const logit = Number(logits[row * binCount + bin]);
        const weight = logit === -Infinity ? 0 : Math.fround(Math.exp(Math.fround(logit / temperature) - max));
        weights[bin] = weight;
        contributions[bin] = Math.fround(weight * bucketMeans[bin]);
      }
      const denominator = pairwiseFloat32Sum(weights);
      const numerator = pairwiseFloat32Sum(contributions);
      if (!Number.isFinite(denominator) || denominator <= 0 || !Number.isFinite(numerator)) throw new RuntimeError("RESULT_INVALID", `Regression decoder produced an invalid row at ${row}`);
      output[row] = Math.fround(numerator / denominator);
    }
  }
  if ([...output].some((value) => !Number.isFinite(value))) throw new RuntimeError("RESULT_INVALID", "Decoded prediction is non-finite");
  return output;
}

/** Decode a row-wise predictive distribution without exposing ORT tensors. */
export function decodeMean(logits: ArrayLike<number>, state: DecoderState): Float32Array {
  const temperature = state.temperature ?? 1; if (!Number.isFinite(temperature) || temperature <= 0) throw new RuntimeError("INVALID_DATA", "Decoder temperature must be positive");
  const out = new Float32Array(logits.length);
  for (let i = 0; i < logits.length; i += 1) { const value = Number(logits[i]); if (!Number.isFinite(value)) throw new RuntimeError("RESULT_INVALID", `Non-finite decoder value at ${i}`); out[i] = Math.fround((value / temperature) * state.targetScale + state.targetMean); }
  if ([...out].some((value) => !Number.isFinite(value))) throw new RuntimeError("RESULT_INVALID", "Decoded prediction is non-finite");
  return out;
}
export function decodeQuantileMean(quantiles: ArrayLike<number>, rowCount: number, quantileCount: number, state: DecoderState): Float32Array {
  if (quantileCount <= 0 || quantiles.length !== rowCount * quantileCount) throw new RuntimeError("SHAPE_UNSUPPORTED", "Decoder tensor shape mismatch");
  const logits = new Float32Array(rowCount); for (let row = 0; row < rowCount; row += 1) { let sum = 0; for (let q = 0; q < quantileCount; q += 1) sum += Number(quantiles[row * quantileCount + q]); logits[row] = Math.fround(sum / quantileCount); }
  return decodeMean(logits, state);
}
