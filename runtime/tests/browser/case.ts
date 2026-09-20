export { caseTransitionSmoke } from "./case-transition";

import type { ExecutionProvider } from "../../src/model/types";
import type { CaseVariant } from "../../src/model/tabiclv2/case-fixture";
import type { CaseWorkerReply } from "./case.worker";

/** Run one published Case variant in its own module worker.  The worker is
 * terminated only after its single terminal reply, so ORT/session cleanup is
 * performed by the worker's finally block before the browser harness moves to
 * the next precision variant. */
export async function runCaseBrowser(baseUrl: string, provider: ExecutionProvider, variant: CaseVariant): Promise<CaseWorkerReply> {
  const worker = new Worker(new URL("./case.worker.ts", import.meta.url), { type: "module" });
  return await new Promise<CaseWorkerReply>((resolve) => {
    let settled = false;
    const finish = (reply: CaseWorkerReply) => { if (settled) return; settled = true; worker.terminate(); resolve(reply); };
    worker.addEventListener("message", (event) => {
      const value = event.data as CaseWorkerReply;
      if (value?.kind === "success" || value?.kind === "failure") finish(value);
    });
    worker.addEventListener("error", (event) => finish({ kind: "failure", requestId: `case-${variant}`, provider, variant, error: { code: "RESULT_INVALID", message: event.message || "Case worker failed", retryable: false } }));
    worker.postMessage({ kind: "run-case", requestId: `case-${provider}-${variant}`, provider, variant, baseUrl });
  });
}
