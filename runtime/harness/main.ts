import { RuntimeCoordinator } from "../src/coordinator/runtime-coordinator";
import { lifecycleObservation } from "../tests/browser/lifecycle";
import { renderCapabilities } from "./common";
import { runHarnessSuite } from "./suites";

const status = document.querySelector<HTMLParagraphElement>("#status");
export const coordinator = new RuntimeCoordinator();
if (status) renderCapabilities(coordinator, status);

// The browser runner uses this narrow global instead of reaching into module
// internals.  Keeping the entry point on the validation page also makes it
// possible to execute the same data/worker/persistence checks manually.
Object.assign(globalThis, {
  __TABLOOM_HARNESS__: {
    run: (suite: string, provider: "wasm" | "webgpu", cycles: number, precision?: "fp32" | "fp16-storage", payload?: unknown) => runHarnessSuite(suite, provider, cycles, precision, payload),
    diagnostics: () => ({ resources: lifecycleObservation(), note: "Browser/device signals are reported as unavailable when the platform does not expose them." }),
  },
});
