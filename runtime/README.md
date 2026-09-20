# Tabloom Common View Runtime

This package contains the browser-first data/model runtime and a small
validation harness. It keeps model contexts in an application-owned registry,
materialises input rows once, publishes results transactionally, and exposes
latest-only scenario scheduling. TabPFN 3.5 supports user-built numerical
contexts; TabICL v2 is intentionally limited to an artifact-bound Case.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run dev
npm run acceptance:summary
```

Large model files and complete golden arrays are not committed. Put authorised
artifacts under `artifacts/` and run `npm run fixtures:prepare -- --artifact-root
../artifacts`; the command reports concrete missing files and never downloads a
different model or invents expected values. Existing page-level spikes under
`spikes/` remain useful probes but do not certify this worker/data runtime.

The primary `model.worker-entry.ts` owns both TabPFN 3.5 ORT sessions. Its
`status` reply exposes only primitive acceptance diagnostics: the WASM module
worker is configured with `proxy=false`, one thread and an explicit same-origin
WASM path; both sessions receive the same external-data byte source; and the
context builder is released before prediction while its 54 copied cache tensors
remain usable. Artifact fetch counters distinguish a cold shared-data fetch
from a persistent-cache hit without exposing ORT handles across the boundary.

The integration bootstrap also starts `bootstrap-model.worker.ts`, an
independent module worker that consumes the original 8/24/64/256-row
context-chain fixture in graph-native shapes. It checks all 54 copied cache
tensors after builder release, compares logits against the published fixture,
and records the single shared external-data request. This is separate from
the page-level spike and is not treated as hardware WebGPU evidence.

Browser acceptance is explicit:

```bash
npm run test:browser -- --suite integration --provider wasm
npm run test:browser -- --suite parity --provider webgpu
npm run test:browser -- --suite case --provider wasm

# published TabICL v2 Case, both graph variants
TABLOOM_HEADLESS=0 TABLOOM_DISPLAY=:0 \
  npm run test:browser -- --suite case --provider webgpu
```

The `case` suite is the real artifact-bound ORT path. It loads the checked
Case manifest, graph, external-data file and raw/model-input/official-mean
fixtures through same-origin routes, then runs baseline, changed and repeat
predictions in a dedicated module worker. The worker exports/imports the
embedded Case snapshot and verifies that dynamic fitting remains explicitly
unsupported. Its target-unit budgets are `0.0001` for FP32 and `0.01` for
FP16-storage/FP32-compute; raw graph output is never compared as a target-unit
result. The report includes provider, adapter vendor, model version, graph
digest, variant, budget and observed maximum error.

The default runner is headless and is suitable for WASM/data checks. Hardware
WebGPU is a separate headed-X11 validation because Playwright's headless
defaults select SwiftShader. On a desktop session with NVIDIA available:

```bash
TABLOOM_HEADLESS=0 TABLOOM_DISPLAY=:0 \
  npm run test:browser -- --suite lifecycle --provider webgpu --cycles 20
```

The report records the adapter vendor and marks SwiftShader or a missing
adapter as unavailable; it never counts the software fallback as hardware
WebGPU evidence.

The model and Case adapters use the same requestAdapter probe inside their
workers. They reject an explicit fallback adapter (including SwiftShader,
llvmpipe and Lavapipe) before ORT session creation, so a provider selection
cannot silently turn into software execution.

Lifecycle reports additionally expose runtime-owned artifact/cache bytes and
retain unknown WASM/GPU/host counters as unavailable. The real worker
lifecycle probe runs when the provider can load; deterministic fault
injections and a real device-loss event remain separate evidence.

Missing hardware or fixtures produces a non-zero `unavailable` report. The
runtime uses COOP/COEP headers on `127.0.0.1:4175`; production hosts must serve
the module worker and ORT/WASM assets same-origin with equivalent headers.
