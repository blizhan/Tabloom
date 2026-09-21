/* Application-owned module-worker entry. Product wiring can inject a manifest
 * and ORT-backed inference callback before installing the adapter; keeping the
 * entry separate prevents ORT objects from crossing the client boundary. */
import { resolveTabPFN35Precision } from "../model/tabpfn35/worker-factory";
import { startModelWorker } from "./model-worker-bootstrap";

/** The primary worker is artifact-bound. The shared FP16-storage bundle is the
 * default production asset; a `?precision=fp32` worker URL selects the
 * reference graph for numerical parity without changing the protocol. */
const precision = resolveTabPFN35Precision(typeof location !== "undefined" ? new URL(location.href).searchParams.get("precision") : undefined);

void startModelWorker(precision);
