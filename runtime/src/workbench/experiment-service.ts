import { RuntimeError } from "../model/errors";
import type { ModelContext, PredictionResult, TabularModelAdapter } from "../model/types";
import { RuntimeCoordinator } from "../coordinator/runtime-coordinator";
import type { InputSnapshot } from "../data/input-snapshots";
import type { ResultRow } from "../data/result-publication";
import { ReadonlyQueryService } from "./query-service";
import { WorkbenchExperimentStore, type WorkbenchExperimentDefinition } from "../storage/workbench-experiment-store";
import type { ExperimentRevision, QueryDefinition } from "./types";

export interface ExperimentCreateInput {
  readonly experimentId: string;
  readonly name: string;
  readonly revision?: number;
  readonly training: QueryDefinition;
  readonly prediction: QueryDefinition;
  readonly featureNames: readonly string[];
  readonly targetName: string;
  readonly modelId: string;
  readonly provider: "wasm" | "webgpu";
  readonly precision: "fp32" | "fp16-storage";
  readonly inputSnapshotId: string;
}

export interface ExperimentRunInput { readonly streamId: string; readonly generation?: number; readonly epoch: string; readonly requestId: string; readonly context: ModelContext; readonly prediction: InputSnapshot; }

/** Binds immutable SQL definitions to one revision and delegates computation
 * to the existing coordinator; editing a saved definition cannot mutate a
 * queued run. */
export class ExperimentService {
  constructor(readonly queries: ReadonlyQueryService, readonly coordinator: RuntimeCoordinator, readonly store: WorkbenchExperimentStore = new WorkbenchExperimentStore()) {}

  async validate(input: ExperimentCreateInput): Promise<{ readonly trainingRows: number; readonly predictionRows: number; readonly columns: readonly string[] }> {
    if (!input.featureNames.length || !input.targetName) throw new RuntimeError("FEATURE_MISMATCH", "At least one ordered feature and a target are required");
    const training = await this.queries.execute(input.training);
    const prediction = await this.queries.execute(input.prediction);
    const trainColumns = new Set(training.result.columns);
    const predictionColumns = new Set(prediction.result.columns);
    if (!trainColumns.has(input.targetName)) throw new RuntimeError("INVALID_TARGET", `Training query does not include target ${input.targetName}`);
    for (const name of input.featureNames) if (!trainColumns.has(name) || !predictionColumns.has(name)) throw new RuntimeError("FEATURE_MISMATCH", `Feature ${name} is missing from training or prediction query`);
    if (!training.rowCount || !prediction.rowCount) throw new RuntimeError("EMPTY_INPUT", "Training and prediction queries must return rows");
    return { trainingRows: training.rowCount, predictionRows: prediction.rowCount, columns: [...input.featureNames] };
  }

  async save(input: ExperimentCreateInput): Promise<{ readonly experiment: WorkbenchExperimentDefinition; readonly persistent: boolean; readonly warning?: string }> {
    await this.validate(input);
    const now = new Date().toISOString();
    const definition: WorkbenchExperimentDefinition = { experimentId: input.experimentId, revision: input.revision ?? 1, name: input.name, trainingQuery: input.training.sql, predictionQuery: input.prediction.sql, parameters: input.training.parameters ?? input.prediction.parameters, targetName: input.targetName, featureNames: [...input.featureNames], modelId: input.modelId, provider: input.provider, precision: input.precision, inputSnapshotId: input.inputSnapshotId, createdAt: now, updatedAt: now };
    return this.store.save(definition);
  }

  async run(input: ExperimentRunInput): Promise<readonly ResultRow[]> {
    const outcome = await this.coordinator.submitPrediction({ streamId: input.streamId, generation: input.generation ?? 0, epoch: input.epoch, scenarioId: "baseline", requestId: input.requestId, inputSnapshot: input.prediction, context: input.context, mode: "experiment" });
    if (outcome.status !== "published") throw outcome.error instanceof Error ? outcome.error : new RuntimeError(outcome.status === "cancelled" ? "CANCELLED" : "RESULT_INVALID", `Experiment run ${outcome.status}`);
    return outcome.value ?? [];
  }
}

export function toExperimentRevision(input: ExperimentCreateInput): ExperimentRevision { return { experimentId: input.experimentId, revision: input.revision ?? 1, training: input.training, prediction: input.prediction, featureNames: [...input.featureNames], targetName: input.targetName, modelId: input.modelId }; }
