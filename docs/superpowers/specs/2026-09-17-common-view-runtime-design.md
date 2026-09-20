# Common View Runtime Design

Date: 2026-09-17

## Goal

Turn the validated TabPFN 3.5 and TabICL v2 browser spikes into a reusable
browser runtime that can consume DuckDB-WASM query results, build/cache model
context, run predictions through ONNX Runtime Web, and register results back
into DuckDB without a Python backend.

TabPFN 3.5 is the primary/default implementation. TabICL v2 must fit the same
public adapter boundary. TabPFN v3 remains non-blocking for the MVP.

For the MVP, arbitrary Common View training data is supported by TabPFN 3.5.
TabICL v2 initially supports published Case View contexts only. Its current
spike embeds a fixed training cache in ONNX initializers; browser context
construction and replaceable context inputs are separate, unproven capabilities.
Implementing the common interface does not imply support for `fitContext()`.

## Scope

The first implementation covers numerical regression and the already validated
single-member estimator behavior. It includes:

- Arrow/TypedArray dataset handoff from DuckDB-WASM;
- model-neutral adapter interfaces;
- TabPFN 3.5 estimator preprocessing and regression decoding in TypeScript;
- shared ONNX artifact loading for the context-builder and prediction sessions;
- reusable model context objects;
- persistent artifact/context caching;
- explicit session creation/disposal and runtime memory measurements;
- prediction results suitable for registration back into DuckDB.

Categorical features, classification, multi-member ensembles, TabPFN v3, and
the final application UI are follow-up work.

## Approaches considered

### A. One unified ONNX graph

Bundle context construction and prediction into one graph/session.

This simplifies session ownership but loses the main product advantage of a
reusable context, forces Common View to keep the heavy context path around for
interactive prediction, and is no longer required for weight deduplication.

### B. Two model-specific sessions with duplicated artifacts

Keep the current spike graphs mostly unchanged and let each session load its own
external data file.

This is the smallest code change, but wastes roughly 40% of the network payload
for TabPFN 3.5 and makes persistent caching less attractive.

### C. Two sessions sharing one artifact blob — selected

Keep context-building and prediction as independent sessions while loading one
deduplicated FP16 external-data blob into a shared browser buffer. The validated
TabPFN 3.5 bundle is about 427.8 MB and works in Chromium WASM and hardware
WebGPU with a single fetch reused by both sessions.

This preserves reusable contexts, supports a lightweight Case View, and keeps a
clean path to disposing the context-builder after a Common View context is
created. The remaining memory risk is runtime duplication inside ORT/WebGPU,
which must be measured rather than inferred from download size.

## Architecture

```text
DuckDB-WASM query
      |
      v
Arrow / TypedArray dataset boundary
      |
      v
TabularModelAdapter
      |
      +--> Estimator preprocessing / metadata
      |
      +--> ArtifactStore ----> OPFS / IndexedDB
      |          |
      |          v
      |     shared model blob
      |
      +--> SessionManager
      |       |          |
      |       |          +--> prediction ORT session
      |       +-------------> context ORT session (on demand)
      |
      +--> ModelContext cache
      |
      v
PredictionResult
      |
      v
DuckDB-WASM result table
```

The runtime is independent of React/Case View UI state. UI code calls the same
runtime API used by Common View and Case View.

## Public runtime boundary

```ts
type ModelId = "tabpfn-3.5" | "tabicl-v2" | "tabpfn-3";
type ExecutionProvider = "webgpu" | "wasm";

interface TabularDataset {
  columns: readonly Float32Array[];
  columnNames: readonly string[];
  rowCount: number;
}

interface TrainingDataset extends TabularDataset {
  target: Float32Array;
  targetName: string;
}

interface FitContextOptions {
  // Provenance supplied by the integration layer; never replaces content hashing.
  featureSqlFingerprint: string | null;
  sourceSnapshotId: string;
  preprocessing: PreprocessingConfig;
  seed: number;
}

interface ContextIdentity {
  key: string;
  modelId: ModelId;
  modelVersion: string;
  artifactManifestDigest: string;
  contextFormatVersion: number;
  preprocessingVersion: string;
  trainingDataDigest: string;
  featureSqlFingerprint: string | null;
  schemaDigest: string;
  targetName: string;
  configurationDigest: string;
}

interface ModelContext {
  // Opaque handle, local to one adapter instance in the model worker.
  readonly handleId: string;
  readonly identity: ContextIdentity;
}

interface TensorSnapshot {
  name: string;
  dtype: TensorDType;
  shape: readonly number[];
  bytes: Uint8Array;
  checksum: string;
}

interface ContextSnapshot {
  identity: ContextIdentity;
  provenance: { sourceSnapshotId: string; builtWithProvider: ExecutionProvider };
  featureNames: readonly string[];
  estimatorState: SerializedEstimatorState;
  payload:
    | { kind: "portable-tensors"; tensors: readonly TensorSnapshot[] }
    | { kind: "embedded-artifact"; manifestDigest: string };
}

interface ModelCapabilities {
  taskTypes: readonly ["regression"];
  canBuildContext: boolean;
  canImportContext: boolean;
  supportsMissingFeatures: boolean;
  supportsPassthroughInf: boolean;
  // Bounds refer to graph inputs after estimator preprocessing.
  maxModelFeatures: number;
  trainRows: { min: number; max: number };
  predictionRows: { min: number; max: number };
}

interface PredictionOptions {
  requestId: string;
  inputSnapshotId: string;
  scenarioId: string;
}

interface PredictionResult {
  mean: Float32Array;
  requestId: string;
  inputSnapshotId: string;
  scenarioId: string;
  contextKey: string;
  metadata: PredictionMetadata;
}

interface TabularModelAdapter {
  readonly id: ModelId;
  load(options?: ModelLoadOptions): Promise<void>;
  fitContext(dataset: TrainingDataset, options: FitContextOptions): Promise<ModelContext>;
  importContext(snapshot: ContextSnapshot): Promise<ModelContext>;
  exportContext(context: ModelContext): Promise<ContextSnapshot>;
  releaseContext(context: ModelContext): Promise<void>;
  predict(context: ModelContext, dataset: TabularDataset,
          options: PredictionOptions): Promise<PredictionResult>;
  capabilities(): ModelCapabilities;
  dispose(): Promise<void>;
}
```

The MVP keeps the result contract intentionally small. Distribution/probability
outputs can be added without changing the context/session ownership model.

Supporting types above are model-specific, versioned schemas, not arbitrary
objects: `PreprocessingConfig` is a discriminated configuration by model id;
`SerializedEstimatorState` contains only validated scalar/array records and
binary tensor references, never Python objects or ORT handles. `TensorDType`
is the manifest-declared allowlist of supported tensor element types.
`ModelLoadOptions` selects the artifact manifest, preferred provider and
`allowWasmFallback` (default false). `PredictionMetadata` records artifact and
preprocessing versions, actual provider, runtime version, timings, and fallback
reason when applicable. Unsupported model ids fail before artifact download.

## Components

### Dataset boundary

DuckDB integration converts query results into a model-neutral columnar dataset.
Conversion is isolated from model preprocessing so adapters can be tested with
fixtures without starting DuckDB-WASM.

The first path accepts numeric Arrow columns and materializes contiguous
`Float32Array` values only where required by the model runtime.

The conversion contract is explicit:

- Read Arrow validity bitmaps, logical slice offsets and every record batch;
  never reinterpret the underlying value buffer as the entire column.
- Feature nulls become NaN. Whether NaN is supported is adapter-specific;
  TabPFN 3.5 supports it, while the initial TabICL profile rejects it.
- Training targets are required, finite and non-null. Reject invalid targets
  rather than dropping rows or imputing labels implicitly.
- Support numeric integer and floating columns. Reject decimal and other
  logical types in the MVP unless explicitly cast by the user's SQL. Reject
  integers outside JavaScript's safe integer range before conversion; normal
  Float32 rounding is part of the documented input contract. A finite source
  value that overflows Float32 is rejected, even with passthrough Inf enabled.
- Actual feature infinities require both an adapter capability and explicit
  `PASSTHROUGH_INF`. Never infer this option from the input.
- Names must be unique; column count, column lengths and target length must
  match the declared shape. Prediction names and order must match the fitted
  schema exactly; fail rather than silently reorder them.
- Validate graph bounds after preprocessing as well as the raw input shape.
  TabPFN's fingerprint feature can increase the feature count, so 32 raw
  features must not automatically be advertised as supported by a 32-feature
  graph. No automatic subsampling or prediction chunking is promised.

Input buffers become runtime-owned copies or explicitly transferred buffers at
the worker boundary. Callers must not mutate them while hashing or inference
is in progress. Snapshot hashing and preprocessing consume the same frozen data.

### Prediction row identity and DuckDB registration

The integration layer materializes each prediction query once and assigns an
`inputSnapshotId` plus a unique `rowOrdinal` within that snapshot. It retains
the original rows and business keys outside the model feature matrix; identifiers
and timestamps are not converted to Float32 just to join predictions later.

`mean[i]` must correspond to row `i` of that exact materialized snapshot, with
`mean.length === rowCount`. Register results using
`(inputSnapshotId, rowOrdinal, scenarioId, requestId)` and context/model metadata.
Join to the saved input snapshot, never to a newly executed query using an
assumed SQL row order or a possibly duplicated business key. Each modified
scenario gets a new input snapshot linked to the baseline row identities.

Registration validates length and finite outputs, then publishes the complete
result atomically. Failed or obsolete requests do not replace the current
result. Old snapshots remain while referenced by retained experiments/results;
explicit result removal permits their cleanup.

### Estimator preprocessing

`TabPFN35Adapter` owns the estimator semantics validated against
`TabPFNRegressor.predict()`:

- feature ordering and fingerprint feature generation;
- feature shuffle/shift metadata;
- missing-value handling;
- optional `PASSTHROUGH_INF` behavior;
- target normalization/border translation;
- final regression distribution aggregation and mean decode.

The TypeScript implementation must be fixture-driven and compared against the
existing Python estimator parity outputs. The FP32 graph remains the numerical
reference; FP16-storage is the default delivery candidate.

The supported profile is pinned, not whatever the upstream estimator happens
to select by default: one member, numerical regression, the validated `none`
preprocessing profile, fingerprint generation, recorded feature permutation,
and no target transform beyond the validated target normalization/decode.
Other preprocessing profiles fail explicitly. Persist the fitted state needed
to transform prediction rows, including seed, permutation, feature metadata,
normalization statistics, softmax temperature and regression borders/tail
parameters. Never fit preprocessing statistics on prediction rows.

Before the TypeScript port, extend the Python parity probe to export golden
fixtures containing raw train/test/target arrays, resolved configuration and
fitted state, transformed train/test tensors, normalized targets, decoder
inputs, and complete expected final means. The existing probe calls official
Python preprocessing/decoding and reports summary errors and prediction heads;
those reports alone are not portable golden fixtures. Record package versions,
checkpoint and artifact digests, fixture seed and per-array checksums.

### ArtifactStore

`ArtifactStore` owns model files, the shared external-data blob, versions,
checksums, download progress, and persistent storage.

Loading order:

1. resolve model manifest and checksum;
2. check OPFS/IndexedDB cache;
3. fetch once on a miss;
4. verify size/checksum;
5. expose one store-owned `Uint8Array` to session creation; consumers must not
   mutate it (JavaScript typed arrays are not intrinsically immutable).

Storage backend details stay behind the interface so the first implementation
can start with a simple persistent strategy and evolve without changing model
adapters.

A manifest binds graph files, external-data paths/offsets, weight checksums,
precision variant, graph I/O schema and supported shapes as one artifact
revision. Its digest changes when any component changes. Concurrent loads of
the same digest share one in-flight fetch. Cache writes use a temporary entry
and publish only after verification; interrupted/corrupt entries are never
cache hits. Quota failures may retain the verified in-memory artifact with an
explicit warning. Storage eviction must not invalidate active buffer references.

### SessionManager

`SessionManager` owns ONNX Runtime Web sessions and execution-provider choice.

For TabPFN 3.5:

- prediction session is the long-lived interactive session;
- context session is created only when `fitContext()` is required;
- both sessions receive the same shared artifact buffer;
- WebGPU is preferred when supported, WASM is the explicit fallback;
- context session can be disposed after its output tensors have been detached
  into context-owned storage independent of that session;
- `releaseContext()` releases one logical handle; shared backing allocations
  are released only when all handles and in-flight operations release them;
- `dispose()` releases all adapter sessions and live contexts, invalidating
  their handles. Previously exported snapshots remain usable.

Session lifecycle records load time and memory observations so the runtime can
later choose device-specific policies instead of hard-coding assumptions.

The MVP portable context uses owned CPU tensor buffers as its durable source;
provider-specific uploads are transient resources. GPU output readback/copy
must complete before releasing the producing session. A handle cannot be used
with another adapter instance or after release; callers export/import snapshots
to cross instances. Repeated release/dispose calls are idempotent.

### Worker execution and request lifecycle

DuckDB queries run in the data worker and model loading, hashing, preprocessing,
decode and ORT execution run in a model worker. The UI receives progress and
opaque ids; ORT objects and live handles never cross the worker boundary.
Transfer only buffers exclusively owned by the sender, otherwise copy them.

The model worker serializes adapter operations in the MVP. For each interactive
scenario stream, retain at most the running request and the latest pending
request; superseded pending requests finish with a typed cancellation result.
The coordinator checks request generation before display and inside the result
publication operation. Separate explicit experiments are not silently coalesced.

Cancellation is cooperative: a running ORT call may finish, but its obsolete
result is discarded and temporary tensors are released. Dispose stops accepting
new operations, cancels queued work, waits for running work to settle, then
releases resources. Context release waits for operations using that handle.
Failed initialization cleans up partially created resources. Device loss
invalidates device state and rejects affected requests; it does not silently
replay them on another provider. Retry requires an explicit caller operation.

Provider choice is made during load. A permitted WASM fallback is reported in
metadata/progress; without permission, provider initialization failure is an
error. Capability detection includes successful ORT initialization, not only
the presence of `navigator.gpu`.

### Context cache

Contexts are first-class reusable artifacts. The runtime computes the cache key
using SHA-256 over a versioned canonical record:

```text
model id + model version + artifact manifest digest + context format version +
preprocessing implementation version + ordered training content digest +
ordered feature schema + feature SQL fingerprint + target name +
resolved estimator/preprocessing configuration (including seed)
```

Case View may ship or retrieve a prebuilt context. Common View builds a context
in-browser and can persist it for reuse. Context invalidation is deterministic:
any key component change produces a new context.

The integration layer supplies SQL provenance, source snapshot id and target
name through the public fit parameters. The runtime hashes the actual ordered
Float32 feature and target values, names, dimensions and schema, before fitted
preprocessing. Canonical hashing specifies UTF-8 strings with length prefixes,
little-endian numeric encodings, sorted configuration keys and one canonical
NaN representation; signed zero is preserved. SQL uses the exact supplied text
and bound parameter values in its fingerprint; direct TypedArray callers use
null. A source snapshot id is provenance, not a substitute for content hashing
and not a reason to miss the cache when all semantic inputs are unchanged.

Prediction rows and scenario changes do not enter the training context key.
Changing a target value, training row order, seed, feature order, graph/weight
precision or preprocessing implementation does. Explicit provider provenance
is stored with each snapshot; cross-provider reuse is allowed only for tested
artifact/provider combinations, otherwise rebuild or return incompatibility.

Context storage is separate from active handles. The adapter validates snapshot
checksums, identity, tensor names/dtypes/shapes and serialized estimator state
before allocating device resources. Cache eviction removes stored snapshots,
not contexts in use. Never deserialize executable objects. Publish complete
snapshots atomically and treat corrupt entries as misses; a supplied Case
snapshot that is incompatible produces an explicit error rather than retraining
without the user's selected data.

For the initial TabICL profile, a snapshot references the immutable Case-specific
artifact containing its cache, with its training identity and fitted state.
Import verifies the matching artifact; export preserves that reference. It does
not turn the embedded cache into interchangeable tensor inputs. This profile
declares `canBuildContext=false`; `fitContext()` fails before downloading or
running anything. Its feature/train bounds are fixed by the Case manifest.

## Data flow

### Common View

1. DuckDB-WASM executes training and prediction SQL.
2. Arrow results cross the dataset boundary.
3. `fitContext()` validates the training input and resolves configuration/identity.
4. It checks the context cache and validates/restores a compatible snapshot.
5. On a miss, fitted preprocessing and the context session build a new context;
   the runtime retains owned outputs and can persist its snapshot.
6. Prediction preprocessing uses that fitted state, then the prediction session
   consumes the context and future/scenario rows.
7. TypeScript decoder returns final mean predictions.
8. Results plus model/data/scenario metadata are registered back into DuckDB.

### Case View

Case View uses the same adapter but may begin from a prebuilt cached context.
That allows it to load only the prediction path during normal interaction. An
"Open in Common View" transition keeps the same dataset/model/context identity.

For a prebuilt TabICL Case, this transition allows inspecting data and running
compatible scenarios, but changing training data requires a model that can build
contexts or a newly published Case artifact. The UI exposes that limitation and
does not silently substitute TabPFN. Enabling arbitrary TabICL training later
requires a browser context builder, explicit replaceable cache inputs and final
estimator parity across multiple training sizes/feature counts. This gate is
not required for the first TabPFN Common View integration.

## Error handling and capability boundaries

The runtime must fail explicitly for unsupported combinations instead of
silently changing models or execution providers.

Important errors include:

- WebGPU unavailable and WASM fallback disabled;
- artifact checksum/version mismatch;
- unsupported row/feature bounds;
- unsupported categorical/classification request;
- schema mismatch between context and prediction dataset;
- Inf input when `PASSTHROUGH_INF` is not enabled;
- persistent-cache quota failure;
- missing/non-finite target, malformed Arrow input or Float32 conversion overflow;
- context construction unavailable for the selected model/profile;
- incompatible/corrupt snapshot or released/foreign context handle;
- cancelled/superseded operation, device loss or adapter disposed;
- result row-count mismatch or non-finite prediction output.

Cache failures degrade to in-memory operation when safe. Model-semantic errors
do not degrade silently.

## Memory strategy

Network deduplication is already proven, but runtime memory sharing is not.
Therefore the MVP must measure rather than assume memory behavior.

The first implementation records, where the browser exposes useful signals:

- JS heap before/after shared blob load;
- context session creation/disposal;
- prediction session creation;
- context tensor size;
- GPU/WebGPU allocation signals available through the execution environment.

If simultaneous sessions exceed practical limits, Common View builds context,
disposes the context session, then creates/retains the prediction session. This
keeps the public adapter unchanged.

Start with the staged lifecycle until simultaneous sessions are demonstrated
safe on the target device. Record host context copies/readback and outstanding
artifact buffers as well as session allocations. Unavailable browser memory
signals are reported as unavailable, never zero. Compare repeated fit/predict/
release cycles and record failures, device/browser, shapes and actual provider.
If GPU peak bytes cannot be observed, use available telemetry plus explicit
allocation accounting and a bounded stress test; do not claim a measured GPU
peak. The initial limit remains the validated shape range, not an inferred
capacity from compressed download size.

## Testing and acceptance

The runtime is ready for the first Common View integration when all of these are
true:

1. Export complete golden fixtures and test TypeScript preprocessing, standalone
   decode, and browser end-to-end final means separately. For the existing
   synthetic normal/NaN/opt-in Inf fixtures, require every output to be finite
   and max absolute final-mean error <= `1e-4` for FP32 and <= `2e-3` for
   FP16-storage on both WASM and hardware WebGPU. These are proposed acceptance
   budgets, not new measurements; historical observed maxima were about
   `7.51e-5` and `0.00165`. Stage-specific tolerances are recorded in fixture
   manifests before implementation validation. A failure triggers investigation,
   not automatic tolerance widening. Real Case data gets an explicit target-unit
   error budget before FP16 is accepted for that Case.
2. NaN fixture passes; Inf is rejected by default and passes only with
   `PASSTHROUGH_INF=true`.
3. Shared-weight browser test observes one artifact fetch while context and
   prediction sessions both initialize successfully.
4. Arrow/TypedArray input can build a context and predict without Python.
5. Prediction output joins to the exact saved input snapshot after reordering,
   duplicate business keys and scenario edits; failed/obsolete requests cannot
   replace the current result.
6. Context cache hit avoids rebuilding context for unchanged fingerprints.
   Changing only a label value, row/feature order, seed, precision artifact or
   preprocessing version causes a miss; changing only prediction rows does not.
7. Browser tests cover WebGPU and WASM fallback.
8. Memory evidence is captured for the two-session and staged-session lifecycle,
   including repeated releases, host copies and unavailable telemetry, so any
   change from the staged default is evidence-based.
9. Build/export a context, release all sessions, restart the worker and import
   the persisted snapshot; predictions satisfy the same numerical thresholds.
   Test corrupt snapshots, wrong artifact versions and released/foreign handles.
10. Real Arrow fixtures cover null validity, slices, multiple record batches,
    column order mismatch, invalid targets and numeric conversion boundaries.
11. Test rapid scenario requests, disposal during inference, initialization
    failure, cancelled queued work and device-loss handling without stale writes
    or leaked owned resources. Provider fallback is always observable.
12. Concurrent artifact loads fetch once, persistent reload avoids network
    download, interrupted writes cannot become hits, and quota failures can
    continue with a verified in-memory artifact.

The TabICL Case adapter has a separate acceptance gate: load a published snapshot,
apply serialized feature transforms and target inverse scaling, and compare
complete browser means to the official estimator on WASM and hardware WebGPU.
Its fixture manifest pins precision-specific final-target-unit tolerances before
validation; graph-output error alone is not sufficient. Verify that changed
training inputs cannot reuse the embedded artifact and `fitContext()` returns
the documented capability error. Arbitrary TabICL context construction remains
unsupported until its separate export/browser/parity gate passes.

## Implementation order

1. Export complete estimator golden fixtures and pin profiles, schemas and
   numerical acceptance budgets.
2. Create the TypeScript runtime package, worker protocol, model-neutral
   interfaces and explicit capability/lifecycle contracts.
3. Move shared artifact/session loading out of the TabPFN spike harness and
   implement preprocessing/final decode against the golden fixtures.
4. Add context identity, snapshot serialization/import, persistent caches and
   staged session disposal; verify reuse across a worker restart.
5. Add validated DuckDB-WASM Arrow conversion, input snapshots and atomic
   prediction-table registration with request generation checks.
6. Add the constrained TabICL Case adapter with embedded-artifact snapshots and
   explicit unsupported context construction. Track dynamic TabICL cache inputs
   and browser context construction as a separate technical gate.
7. Connect the runtime to Common View and the first Case View.

This order keeps the validated model path intact while preventing the UI,
DuckDB, storage, and model-specific estimator logic from becoming one coupled
subsystem.
