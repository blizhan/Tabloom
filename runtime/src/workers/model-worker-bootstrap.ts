import { TabPFN35Adapter } from "../model/tabpfn35/adapter";
import { createTabPFN35Adapter, type TabPFN35Precision } from "../model/tabpfn35/worker-factory";
import { installModelWorker } from "./model.worker";
import type { ModelAssetEvent } from "../workbench/model-asset-status";

/** Start an artifact-bound model worker for a statically selected precision. */
export async function startModelWorker(precision: TabPFN35Precision): Promise<void> {
  const scope = globalThis as unknown as { postMessage?: (message: unknown) => void };
  let adapter: Awaited<ReturnType<typeof createTabPFN35Adapter>>;
  try {
    adapter = await createTabPFN35Adapter({ precision, onAssetEvent: (event: ModelAssetEvent) => scope.postMessage?.(event) });
  } catch (error) {
    scope.postMessage?.({ kind: "model-assets", precision, state: "failed", message: error instanceof Error ? error.message : String(error) } satisfies ModelAssetEvent);
    // Keep the protocol alive so clients receive a typed ARTIFACT_MISMATCH
    // from `load` instead of hanging while waiting for the ready handshake.
    adapter = new TabPFN35Adapter({ requireOrtRuntime: true, modelVersion: `3.5-runtime-shared-${precision}`, artifactManifestDigest: "0".repeat(64) });
  }
  installModelWorker(adapter);
}
