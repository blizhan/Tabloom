/* Application-owned module-worker entry. Product wiring can inject a manifest
 * and ORT-backed inference callback before installing the adapter; keeping the
 * entry separate prevents ORT objects from crossing the client boundary. */
import { TabPFN35Adapter } from "../model/tabpfn35/adapter";
import { createTabPFN35Adapter, resolveTabPFN35Precision } from "../model/tabpfn35/worker-factory";
import { installModelWorker } from "./model.worker";

/** The primary worker is artifact-bound. The shared FP16-storage bundle is the
 * default production asset; a `?precision=fp32` worker URL selects the
 * reference graph for numerical parity without changing the protocol. */
const precision = resolveTabPFN35Precision(typeof location !== "undefined" ? new URL(location.href).searchParams.get("precision") : undefined);

void (async () => {
  let adapter: Awaited<ReturnType<typeof createTabPFN35Adapter>>;
  try {
    adapter = await createTabPFN35Adapter({ precision });
  } catch {
    // Keep the protocol alive so clients receive a typed ARTIFACT_MISMATCH
    // from `load` instead of hanging while waiting for the ready handshake.
    adapter = new TabPFN35Adapter({ requireOrtRuntime: true, modelVersion: `3.5-runtime-shared-${precision}`, artifactManifestDigest: "0".repeat(64) });
  }
  installModelWorker(adapter);
})();
