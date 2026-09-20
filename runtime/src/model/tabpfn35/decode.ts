import { RuntimeError } from "../errors";

export interface DecoderState { readonly temperature?: number; readonly borders?: readonly number[]; readonly targetMean: number; readonly targetScale: number; }

export const TABPFN35_REGRESSION_BINS = 5000;
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
