import { RuntimeError } from "../model/errors";
import type { DuckDbResult } from "../data/duckdb-service";

export interface PredictionVectors { readonly mean: readonly number[]; readonly q25: readonly number[]; readonly q75: readonly number[]; }
export interface TestResultTable { readonly table: DuckDbResult; readonly outputColumns: { readonly mean: string; readonly q25: string; readonly q75: string } }

/** Keep Test rows as the identity of a prediction. Prediction columns are
 * appended with collision-safe names so an input column named `mean` is never
 * silently replaced. */
export function enrichTestRows(test: DuckDbResult, predictions: PredictionVectors): TestResultTable {
  const count = test.rows.length;
  if (predictions.mean.length !== count || predictions.q25.length !== count || predictions.q75.length !== count) throw new RuntimeError("RESULT_INVALID", "Prediction vector length does not match Test rows");
  for (let index = 0; index < count; index += 1) {
    const mean = predictions.mean[index]; const q25 = predictions.q25[index]; const q75 = predictions.q75[index];
    if (![mean, q25, q75].every(Number.isFinite)) throw new RuntimeError("RESULT_INVALID", `Prediction row ${index} contains a non-finite value`);
    if (q25 > q75) throw new RuntimeError("RESULT_INVALID", `Prediction row ${index} has q25 > q75`);
  }
  const used = new Set(test.columns);
  const mean = addOutputName("mean", used); const q25 = addOutputName("q25", used); const q75 = addOutputName("q75", used);
  const rows = test.rows.map((row, index) => ({ ...row, [mean]: predictions.mean[index], [q25]: predictions.q25[index], [q75]: predictions.q75[index] }));
  return { table: { columns: [...test.columns, mean, q25, q75], rows }, outputColumns: { mean, q25, q75 } };
}

function addOutputName(base: string, used: Set<string>): string {
  const candidates = [base, `prediction_${base}`];
  for (const candidate of candidates) if (!used.has(candidate)) { used.add(candidate); return candidate; }
  let index = 2; while (used.has(`prediction_${base}_${index}`)) index += 1;
  const value = `prediction_${base}_${index}`; used.add(value); return value;
}
