# Real ORT Case Runtime Integration Implementation Plan

> For agentic workers: use a task-by-task implementation workflow and keep each task independently verifiable.

Goal: Replace the TabICL Case harness fallback with a real same-origin ONNX Runtime Web worker that validates the published Case artifact, runs FP32 and FP16-storage graphs through WASM and WebGPU, and preserves the existing Case/snapshot contracts.

Architecture: ORT sessions stay owned by a module worker. The browser harness loads the generated Case fixture and artifact through same-origin Vite routes, injects an inference callback into TabICLv2CaseAdapter, and lets the adapter own preprocessing, inverse target scaling, identity checks, and lifecycle. The generic TabPFN worker remains a separate follow-up because its builder/predictor/decode chain is materially different.

Tech stack: TypeScript 5.9, onnxruntime-web 1.30, Vite 7, Playwright/Chromium, WebGPU or WASM execution providers, node:test.

Spec: specs/001-common-view-runtime/spec.md; contracts/runtime.md; contracts/persistence.md; tasks.md (T050/T051/T052/T054/T055/T057).

## Global constraints

- Use artifacts/tabiclv2/case-golden/manifest.json; never invent means or replace the graph with a linear surrogate.
- The published Case is artifact-bound and canBuildContext=false; dynamic training returns UNSUPPORTED_CAPABILITY.
- Final target-unit budgets are FP32 0.0001 and FP16-storage 0.01; compare inverse-scaled means, not raw graph output.
- Graph, external-data, fixture, ORT WASM and worker requests are same-origin and covered by COOP/COEP.
- WASM sets ort.env.wasm.proxy=false; ORT tensors and sessions are released inside the worker; no ORT object crosses postMessage.
- Missing artifact, hash mismatch, provider unavailability, non-finite output, shape mismatch, or incompatible snapshot remains explicit unavailable/failure.

## Task 1: Make ORT session ownership/provider execution testable

Files:
- Modify runtime/src/model/ort-session.ts
- Create runtime/tests/unit/ort-session.test.ts

Interfaces:
- createOrtSession(options) continues to return OrtSessionHandle.
- OrtSessionHandle.run() returns each output data copy together with dims and optional type.
- OrtSessionHandle.release() releases the InferenceSession exactly once.

Steps:
- Write failing tests for WASM configuration, output dims/data copy, and idempotent release with a dependency-injected fake ORT module.
- Run the focused test and confirm the current wrapper fails because it drops dims and can release twice.
- Select onnxruntime-web/webgpu for WebGPU and onnxruntime-web for WASM; set wasm proxy=false and same-origin wasmPaths; copy data and dims; guard release.
- Run the focused test, then the complete runtime unit suite.

## Task 2: Serve and load the generated Case artifact safely

Files:
- Modify runtime/vite.config.ts
- Create runtime/src/model/tabiclv2/case-fixture.ts
- Create runtime/tests/unit/tabiclv2-fixture.test.ts

Interfaces:
- loadCaseFixture(baseUrl, variant) accepts only fp32 or fp16-storage-fp32-compute.
- It fetches the manifest, raw/model-input/mean f32 files, graph and external-data files, validates SHA-256 and declared shapes, and returns copied Float32Array values plus TabICLCaseState and OrtSessionOptions.

Steps:
- Write failing tests for variant selection, shape/finite checks, manifest digest binding, and checksum mismatch rejection with a fake fetch map.
- Add Vite dev/preview routes for runtime-assets/tabiclv2 and runtime-fixtures/tabiclv2, and copy the same assets into dist-harness.
- Implement Web Crypto SHA-256, strict path allow-listing, little-endian Float32 decoding, and conversion of the manifest recipe into the existing TabICLCaseState.
- Run focused tests and build; verify a graph/WASM request never receives index.html.

## Task 3: Run a real Case graph in a dedicated module worker

Files:
- Create runtime/tests/browser/case.worker.ts
- Modify runtime/tests/browser/case.ts
- Modify runtime/harness/suites.ts
- Create runtime/tests/contract/case-worker.test.ts

Interfaces:
- Worker input is run-case with provider, variant, and baseUrl, or dispose.
- Success includes provider, variant, baselineMean, changedMean, maxAbsError, repeatedMaxAbsDelta, and snapshotChecks; failures include a stable code/message.

Steps:
- Write failing contract tests for exactly one terminal reply, unsupported provider/variant rejection, and Case fitContext rejection.
- Implement the module worker: load fixture, create ORT session, build [1,N,8] row-major input from prepared columns, run the graph, validate N outputs, inject inference.predict, create/import an embedded snapshot, run baseline/changed/repeat predictions, and release context/session/buffers in finally.
- Compare final means to manifest official means with the variant budget; assert changed input changes output, repeat delta is within 1e-5, dynamic fit is rejected, and exported snapshot preserves Case identity.
- Register the browser suite; return unavailable only for missing assets/provider adapter and failed for checksum, shape, ORT, or numerical errors.
- Run contract tests, WASM, then headed X11 WebGPU for both variants.

## Task 4: Acceptance/reporting and traceability

Files:
- Modify runtime/scripts/summarize-acceptance.mjs
- Modify runtime/README.md
- Modify specs/001-common-view-runtime/quickstart.md
- Modify specs/001-common-view-runtime/tasks.md

Steps:
- Add Case variant, graph digest, provider, adapter vendor, target-unit budget, observed max error, and unavailable reason to the report.
- Run Case for WASM/WebGPU x FP32/FP16-storage and keep unavailable distinct from passed.
- Mark only the portions of T057 proven by both providers/variants; leave TabPFN T029 and real lifecycle tasks unchecked.
- Run typecheck, typecheck:test, test, build, fixture preparation, all four Case browser combinations, and acceptance:summary.

## Explicit non-goals

- This plan does not claim TabPFN estimator parity. Its builder/predictor requires a separate 54-tensor worker chain, official preprocessing state, and distribution decoder.
- This plan does not fabricate GPU allocation/device-loss evidence.
