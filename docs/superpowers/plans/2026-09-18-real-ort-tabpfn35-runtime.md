# Real ORT TabPFN 3.5 Main Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the primary TabPFN 3.5 model-worker fallback with the artifact-bound context-builder and prediction ONNX graphs, preserving 54 context tensors through live and portable context lifecycles and decoding official 5,000-bin regression logits into target-unit means.

**Architecture:** The model worker owns `createOrtSession` handles and the shared external-data buffer. A focused `TabPFN35OrtRuntime` maps fitted model inputs to the builder graph, copies and validates its 54 outputs, and maps prediction inputs plus those tensors to the predictor graph. `TabPFN35Adapter` remains the public model-neutral boundary; its context registry stores only owned CPU tensors and fitted state, never ORT objects. The worker entry constructs this runtime only when a real artifact configuration is supplied and rejects missing/mismatched artifacts instead of silently using linear fallback.

**Tech Stack:** TypeScript 5.9, `onnxruntime-web` 1.30, module Web Workers, Vite/Playwright, Node test runner, Web Crypto SHA-256.

**Spec:** `docs/superpowers/specs/2026-09-17-common-view-runtime-design.md`, `specs/001-common-view-runtime/spec.md`, `specs/001-common-view-runtime/plan.md`.

## Global Constraints

- Keep ORT sessions and tensors inside the model worker; return copied `Float32Array` data only.
- Use the pinned TabPFN context graph (`x_train`,`y_train` → `cache_00`…`cache_53`) and predictor graph (`x_test`,`cache_00`…`cache_53` → `logits`).
- Supported shapes are 3–1,024 train rows, 1–1,024 prediction rows, and 1–32 processed features; reject other shapes.
- Default `none` profile includes official fingerprint injection, feature permutation/shift metadata, missing-value handling, target normalization, and no target transform; unsupported profiles fail explicitly.
- Decode complete `[rows,1,5000]` logits with the official regression borders/temperature and restore target units; never treat a single raw logit as a mean.
- Do not alter the already validated TabICL Case worker path.
- Preserve unrelated existing workspace changes and do not run destructive git commands.

### Task 1: Define the ORT-backed TabPFN runtime boundary

**Files:**
- Create: `runtime/src/model/tabpfn35/ort-runtime.ts`
- Test: `runtime/tests/unit/tabpfn35-ort-runtime.test.ts`

**Interfaces:**
- Consumes: `createOrtSession`, `OrtSessionHandle`, `OrtOutputValue`, `ExecutionProvider`, fitted preprocessing output.
- Produces: `TabPFN35OrtRuntimeOptions`, `TabPFN35OrtRuntime`, `buildContext(xTrain, yTrain)`, `predict(xTest, tensors)`, `release()`.

- [ ] Write a fake-ORT test proving builder input names are checked, all 54 outputs are copied, non-finite/shape-mismatched outputs are rejected, predictor output shape is `[rows,1,5000]`, and release is idempotent.
- [ ] Run `npm --prefix runtime test -- tests/unit/tabpfn35-ort-runtime.test.ts` and observe the expected missing-module failure.
- [ ] Implement the runtime with explicit graph schemas, tensor descriptors, output validation, provider-aware session construction, and cleanup of partially-created sessions.
- [ ] Run the focused test and then `npm --prefix runtime run typecheck:test`.

### Task 2: Store real cache tensors in context backing

**Files:**
- Modify: `runtime/src/model/types.ts`
- Modify: `runtime/src/model/context-registry.ts`
- Test: `runtime/tests/contract/context-snapshot.test.ts`

**Interfaces:**
- Consumes: `RuntimeTensorSnapshot` and current `ContextBacking`.
- Produces: clone-safe context backing containing 54 named tensors, with no references to ORT tensors or transferable buffers.

- [ ] Add assertions that creating/exporting/releasing two handles does not alias tensor bytes and that tensor metadata remains intact after one handle is released.
- [ ] Run the focused contract test and verify it fails before the backing clone changes.
- [ ] Update clone/export paths to deep-copy tensor bytes/shapes/checksums and validate the exact TabPFN cache name/order when the model id is `tabpfn-3.5`.
- [ ] Run `npm --prefix runtime test -- tests/contract/context-snapshot.test.ts`.

### Task 3: Connect adapter fit/predict/dispose to the real runtime

**Files:**
- Modify: `runtime/src/model/tabpfn35/adapter.ts`
- Modify: `runtime/src/model/tabpfn35/preprocessing.ts`
- Modify: `runtime/src/model/tabpfn35/decode.ts`
- Test: `runtime/tests/contract/adapter.test.ts`
- Test: `runtime/tests/unit/tabpfn35-estimator.test.ts`

**Interfaces:**
- Consumes: `TabPFN35OrtRuntime`, fitted state, `ContextRegistry`, estimator golden state files.
- Produces: `fitContext()` that builds/stores real cache tensors, `predict()` that invokes the predictor graph and official decoder, and deterministic cleanup.

- [ ] Add tests using a fake runtime for cache-backed fit/predict and a golden-shaped logits tensor; assert no linear fallback is used when runtime is configured and context handles remain valid after fit.
- [ ] Run the tests to confirm the new assertions fail against the existing callback/fallback implementation.
- [ ] Implement runtime creation during `load`, context building from fitted model-space tensors, predictor invocation from transformed prediction tensors, complete decode, provider metadata, and runtime disposal.
- [ ] Reject configured real-artifact loads without a runtime or with unsupported preprocessing profiles using typed errors.
- [ ] Run adapter/estimator tests and `npm --prefix runtime run typecheck`.

### Task 4: Implement the official 5,000-bin regression decoder

**Files:**
- Modify: `runtime/src/model/tabpfn35/decode.ts`
- Test: `runtime/tests/unit/tabpfn35-estimator.test.ts`

**Interfaces:**
- Consumes: `[rows,5000]` or `[rows,1,5000]` logits, golden `raw_borders`, `standard_borders`, `targetMean`, `targetScale`, `temperature`.
- Produces: finite `Float32Array` target-unit means with exact row count.

- [ ] Add a golden decoder test that compares known fixture logits to the exported `mean` within the FP32 budget and rejects wrong ranks/non-finite logits.
- [ ] Run the focused test and verify failure against the placeholder linear decoder.
- [ ] Implement numerically stable temperature softmax, bin-probability aggregation over borders/tails, target-unit restoration, and finite/shape guards.
- [ ] Run the focused estimator test and the full unit suite.

### Task 5: Wire the primary module worker to real artifact configuration

**Files:**
- Modify: `runtime/src/workers/model.worker-entry.ts`
- Modify: `runtime/src/workers/model.worker.ts`
- Modify: `runtime/src/model/factory.ts`
- Test: `runtime/tests/browser/bootstrap-model.ts`
- Create/modify: `runtime/tests/browser/tabpfn35.worker.ts`

**Interfaces:**
- Consumes: real graph/external-data URLs or injected bytes, provider selection, `TabPFN35OrtRuntimeOptions`.
- Produces: primary worker bootstrap that loads the real TabPFN artifact, emits provider metadata, builds context, predicts, releases context, and disposes sessions.

- [ ] Add a browser worker smoke request that asserts `inference: "ort"`, 54 cache tensors, finite 5,000-bin logits/means, builder release, and context reuse.
- [ ] Run the browser smoke in the current harness and record the expected failure while the entry still installs the fallback adapter.
- [ ] Parse/validate worker bootstrap configuration, construct the adapter with real runtime dependencies, and make absence/mismatch an explicit unavailable/failure result rather than fallback.
- [ ] Run typecheck/build and the focused browser smoke in WASM before touching WebGPU.

### Task 6: Connect golden parity and mark the implemented tasks

**Files:**
- Modify: `runtime/tests/browser/parity.ts`
- Modify: `runtime/tests/browser/bootstrap-model.ts`
- Modify: `specs/001-common-view-runtime/tasks.md`
- Create/modify: `artifacts/runtime/reports/bootstrap-model.json`, `artifacts/runtime/reports/parity-wasm.json`, `artifacts/runtime/reports/parity-webgpu.json`

**Interfaces:**
- Consumes: real worker path, estimator-golden arrays/state, provider/precision variants.
- Produces: acceptance evidence separating unavailable prerequisites from passed numerical parity.

- [ ] Add parity assertions for normal, missing, opt-in-inf, duplicate/constant/extreme golden scenarios and both FP32/FP16-storage variants.
- [ ] Run parity in headed WASM and NVIDIA WebGPU; retain explicit unavailable evidence if a provider cannot initialize.
- [ ] Run `npm --prefix runtime test`, `npm --prefix runtime run build`, and `npm --prefix runtime run fixtures:prepare -- --artifact-root "$PWD/artifacts"`.
- [ ] Mark only tasks with fresh passing evidence as `[X]`; leave hardware-gated lifecycle tasks unchecked.

## Execution Notes

- Work in the existing workspace because the feature artifacts and previous runtime implementation are intentionally shared; preserve all unrelated user changes.
- If the first real graph run fails, capture input/output names, dimensions, provider, and session error before changing code; do not widen tolerances or re-enable fallback to hide it.
- Keep the implementation incremental: runtime boundary → registry ownership → adapter → decoder → worker wiring → parity.
