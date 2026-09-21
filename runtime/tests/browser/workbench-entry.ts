export type WorkbenchSuiteName = "data" | "duckdb-file" | "flow" | "model-cache" | "sources" | "persistence" | "responsiveness" | "built-assets";
export interface WorkbenchBrowserReport { readonly suite: WorkbenchSuiteName; readonly provider?: "wasm" | "webgpu"; readonly precision?: "fp32" | "fp16-storage"; readonly status: "passed" | "failed" | "not-run" | "unsupported"; readonly evidence: readonly Record<string, unknown>[]; }

export async function inspectFixture(baseUrl = "/runtime-fixtures/workbench/v1/"): Promise<WorkbenchBrowserReport> {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/manifest.json`, { cache: "no-store" });
    if (!response.ok) return { suite: "data", status: "failed", evidence: [{ error: `manifest HTTP ${response.status}` }] };
    const manifest = await response.json() as { counts?: Record<string, number>; formats?: readonly string[]; cases?: readonly unknown[] };
    const valid = manifest.counts?.train === 256 && manifest.counts.predict === 32 && manifest.counts.features === 4 && manifest.formats?.includes("duckdb") && (manifest.cases?.length ?? 0) >= 8;
    return { suite: "data", status: valid ? "passed" : "failed", evidence: [{ counts: manifest.counts, formats: manifest.formats, cases: manifest.cases?.length }] };
  } catch (error) { return { suite: "data", status: "failed", evidence: [{ error: error instanceof Error ? error.message : String(error) }] }; }
}

export function requireProviderPrecision(suite: WorkbenchSuiteName, provider?: string, precision?: string): void { if (["flow", "model-cache", "responsiveness"].includes(suite) && (!((provider === "wasm") || (provider === "webgpu")) || !((precision === "fp32") || (precision === "fp16-storage")))) throw new Error("provider and precision are required for model suites"); }
