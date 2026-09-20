import { RuntimeError } from "../errors";
import type { TabularDataset } from "../types";

export interface TabICLCaseState {
  readonly featureNames: readonly string[];
  readonly targetMean: number;
  readonly targetScale: number;
  /** Legacy deterministic fallback parameters; official Case graphs do not
   * use these weights, but older synthetic fixtures may still provide them. */
  readonly weights?: readonly number[];
  readonly bias?: number;
  readonly trainRows: number;
  readonly artifactDigest: string;
  /** Fitted official feature preprocessing, when the Case graph requires it. */
  readonly featureTransform?: "identity-finite-float32" | "standardize-clamp-v1";
  readonly featureMeans?: readonly number[];
  readonly featureScales?: readonly number[];
  readonly outlierLowerBounds?: readonly number[];
  readonly outlierUpperBounds?: readonly number[];
}
function isSequence(value: unknown): value is ArrayLike<number> {
  return Array.isArray(value) || (ArrayBuffer.isView(value) && typeof (value as unknown as ArrayLike<number>).length === "number");
}
export function validateCaseState(state: TabICLCaseState): void {
  if (!state || typeof state !== "object" || !/^[a-f0-9]{64}$/i.test(state.artifactDigest) || !Array.isArray(state.featureNames) || state.featureNames.length === 0 || state.featureNames.some((name) => typeof name !== "string" || name.length === 0) || new Set(state.featureNames).size !== state.featureNames.length || (state.weights !== undefined && (!Array.isArray(state.weights) || state.weights.length !== state.featureNames.length)) || !Number.isFinite(state.targetMean) || !Number.isFinite(state.targetScale) || state.targetScale <= 0 || !Number.isSafeInteger(state.trainRows) || state.trainRows <= 0) throw new RuntimeError("SNAPSHOT_CORRUPT", "Invalid TabICL case state");
  if (state.weights?.some((value) => !Number.isFinite(value)) || (state.bias !== undefined && !Number.isFinite(state.bias))) throw new RuntimeError("SNAPSHOT_CORRUPT", "TabICL case weights must be finite");
  if (state.featureTransform === "standardize-clamp-v1") {
    const size = state.featureNames.length;
    const arrays = [state.featureMeans, state.featureScales, state.outlierLowerBounds, state.outlierUpperBounds];
    if (arrays.some((values) => !isSequence(values) || values.length !== size)) throw new RuntimeError("SNAPSHOT_CORRUPT", "TabICL Case preprocessing metadata is incomplete");
    if (Array.from(state.featureMeans!).some((value) => !Number.isFinite(value)) || Array.from(state.featureScales!).some((value) => !Number.isFinite(value) || value <= 0) || Array.from(state.outlierLowerBounds!).some((value) => !Number.isFinite(value)) || Array.from(state.outlierUpperBounds!).some((value) => !Number.isFinite(value))) throw new RuntimeError("SNAPSHOT_CORRUPT", "TabICL Case preprocessing metadata is not finite");
    for (let index = 0; index < size; index += 1) if (state.outlierLowerBounds![index] > state.outlierUpperBounds![index]) throw new RuntimeError("SNAPSHOT_CORRUPT", "TabICL Case outlier bounds are reversed");
  } else if (state.featureTransform !== undefined && state.featureTransform !== "identity-finite-float32") throw new RuntimeError("SNAPSHOT_CORRUPT", "Unsupported TabICL Case feature transform");
}
export function prepareCaseFeatures(dataset: TabularDataset, state: TabICLCaseState): Float32Array[] {
  if (dataset.rowCount <= 0 || dataset.columns.some((column) => column.length !== dataset.rowCount)) throw new RuntimeError("INVALID_DATA", "Case prediction column lengths do not match row count");
  if (dataset.columnNames.length !== state.featureNames.length || dataset.columnNames.some((name, index) => name !== state.featureNames[index])) throw new RuntimeError("SCHEMA_MISMATCH", "Case feature schema mismatch");
  return dataset.columns.map((column, featureIndex) => {
    const copy = new Float32Array(column);
    const transformed = state.featureTransform === "standardize-clamp-v1";
    for (let row = 0; row < copy.length; row += 1) {
      const value = copy[row];
      if (!Number.isFinite(value)) throw new RuntimeError("INF_DISABLED", "TabICL cases require finite feature values");
      if (transformed) {
        const scaled = (value - state.featureMeans![featureIndex]) / state.featureScales![featureIndex];
        copy[row] = Math.fround(Math.min(state.outlierUpperBounds![featureIndex], Math.max(state.outlierLowerBounds![featureIndex], scaled)));
      }
    }
    return copy;
  });
}
export function inverseTarget(values: ArrayLike<number>, state: TabICLCaseState): Float32Array {
  validateCaseState(state); const out = new Float32Array(values.length); for (let i = 0; i < values.length; i += 1) { const value = Number(values[i]); if (!Number.isFinite(value)) throw new RuntimeError("RESULT_INVALID", "TabICL output is non-finite"); out[i] = Math.fround(value * state.targetScale + state.targetMean); }
  return out;
}
