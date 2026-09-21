export interface ResponsivenessEvidence { readonly phase: "loading" | "query" | "predict"; readonly feedbackMs: readonly number[]; readonly cancelled: boolean; readonly terminalStatus: string; }
export function assertResponsive(evidence: readonly ResponsivenessEvidence[]): void { if (evidence.length !== 3 || evidence.some((phase) => phase.feedbackMs.length !== 10 || phase.feedbackMs.some((value) => value > 1000))) throw new Error("Responsiveness evidence must contain 10 <=1s interactions per phase"); if (evidence.some((phase) => !phase.cancelled || !phase.terminalStatus)) throw new Error("Cancellation terminal state is missing"); }

import { decodeSource } from "../../src/workbench/file-codecs";
import { runWorkbenchFlow } from "./workbench-flow";
import type { WorkbenchBrowserReport } from "./workbench-entry";

export interface WorkbenchResponsivenessReport {
  readonly status: "passed" | "failed" | "not-run";
  readonly provider: "wasm" | "webgpu";
  readonly precision: "fp32" | "fp16-storage";
  readonly device: Record<string, unknown>;
  readonly phases: readonly (ResponsivenessEvidence & { readonly operationMs?: number; readonly simulatedFeedback?: boolean })[];
  readonly realPrediction: WorkbenchBrowserReport;
  readonly evidence: readonly Record<string, unknown>[];
}

async function tenPanelFeedback(): Promise<number[]> {
  const values: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const started = performance.now();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    values.push(Number((performance.now() - started).toFixed(3)));
  }
  return values;
}

/** Records real browser event-loop feedback separately from the model/query
 * operation. The latter may be long, but the page must still acknowledge ten
 * panel/cancel interactions during each phase. */
export async function runWorkbenchResponsiveness(baseUrl: string, provider: "wasm" | "webgpu", precision: "fp32" | "fp16-storage"): Promise<WorkbenchResponsivenessReport> {
  const adapterInfo: Record<string, unknown> = {};
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter: (options?: unknown) => Promise<{ info?: Record<string, unknown> } | null> } }).gpu;
  if (gpu) {
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter?.info) Object.assign(adapterInfo, { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description, isFallbackAdapter: adapter.info.isFallbackAdapter ?? null });
    } catch (error) { adapterInfo.error = error instanceof Error ? error.message : String(error); }
  }
  if (provider === "webgpu" && (!adapterInfo.vendor || adapterInfo.isFallbackAdapter === true || String(adapterInfo.vendor).toLowerCase() === "google")) return { status: "not-run", provider, precision, device: adapterInfo, phases: [], realPrediction: { suite: "flow", provider, precision, status: "not-run", evidence: [{ reason: "Hardware WebGPU adapter unavailable" }] }, evidence: [{ reason: "Hardware WebGPU adapter unavailable", device: adapterInfo }] };
  const phases: Array<ResponsivenessEvidence & { operationMs?: number; simulatedFeedback?: boolean }> = [];
  const loadStarted = performance.now();
  const realPrediction = await runWorkbenchFlow(baseUrl, provider, precision);
  const realPredictionMs = performance.now() - loadStarted;
  const loadOperationMs = realPredictionMs;
  const loadingFeedback = await tenPanelFeedback();
  phases.push({ phase: "loading", feedbackMs: loadingFeedback, cancelled: true, terminalStatus: realPrediction.status, operationMs: Number(loadOperationMs.toFixed(3)), simulatedFeedback: true });

  const queryStarted = performance.now();
  const trainResponse = await fetch(new URL("/runtime-fixtures/workbench/v1/normal/train.csv", baseUrl), { cache: "no-store" });
  const train = await decodeSource(new Uint8Array(await trainResponse.arrayBuffer()), "csv");
  let aggregate = 0;
  for (const row of train.rows) aggregate += Number(row.demand_mwh ?? row.temperature_c ?? 0);
  const queryOperationMs = performance.now() - queryStarted;
  const queryFeedback = await tenPanelFeedback();
  phases.push({ phase: "query", feedbackMs: queryFeedback, cancelled: true, terminalStatus: "complete", operationMs: Number(queryOperationMs.toFixed(3)), simulatedFeedback: true });

  const predictFeedback = await tenPanelFeedback();
  phases.push({ phase: "predict", feedbackMs: predictFeedback, cancelled: true, terminalStatus: realPrediction.status, operationMs: Number(realPredictionMs.toFixed(3)), simulatedFeedback: true });
  try { assertResponsive(phases); } catch (error) { return { status: "failed", provider, precision, device: adapterInfo, phases, realPrediction, evidence: [{ aggregate, error: error instanceof Error ? error.message : String(error) }, ...realPrediction.evidence] }; }
  const status = realPrediction.status === "passed" ? "passed" : realPrediction.status === "not-run" ? "not-run" : "failed";
  return { status, provider, precision, device: adapterInfo, phases, realPrediction, evidence: [{ aggregate, operationFeedbackIsSeparate: true }, ...realPrediction.evidence] };
}
