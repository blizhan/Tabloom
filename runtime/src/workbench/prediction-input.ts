import { materializeDataset } from "../data/arrow-dataset";
import type { DuckDbResult } from "../data/duckdb-service";
import type { TrainingDataset, TabularDataset } from "../model/types";

export function numericColumns(table: DuckDbResult): string[] {
  return table.columns.filter(name => table.rows.some(row => typeof row[name] === "number") && table.rows.every(row => row[name] == null || typeof row[name] === "number"));
}

/** SQL results are the complete model input; preview truncation happens only in the view. */
export function preparePredictionInput(train: DuckDbResult, predict: DuckDbResult, target: string, features: readonly string[]): { training: TrainingDataset; prediction: TabularDataset; truth: (number | null)[] } {
  if (!train.rows.length || !predict.rows.length) throw new Error("训练或预测 SQL 返回 0 行，请调整筛选条件。");
  if (!target || !train.columns.includes(target)) throw new Error("请选择训练 SQL 中的目标列。");
  if (!features.length || features.includes(target) || new Set(features).size !== features.length) throw new Error("请选择至少一个特征，目标列不能同时作为特征。");
  for (const name of features) if (!train.columns.includes(name) || !predict.columns.includes(name)) throw new Error(`训练和预测 SQL 都必须包含特征：${name}`);
  const column = (table: DuckDbResult, name: string) => {
    const values = table.rows.map(row => {
      const value = row[name];
      if (value == null) return Number.NaN;
      if (typeof value !== "number") throw new Error(`列 ${name} 必须为数值；可在 SQL 中显式 CAST。`);
      return value;
    });
    return { name, values, type: "float64" as const };
  };
  const training = materializeDataset({ columns: features.map(name => column(train, name)), target: column(train, target), targetName: target }, { requireTarget: true }) as TrainingDataset;
  const prediction = materializeDataset({ columns: features.map(name => column(predict, name)) }) as TabularDataset;
  const truth = predict.rows.map(row => typeof row[target] === "number" && Number.isFinite(row[target]) ? row[target] as number : null);
  return { training, prediction, truth };
}
