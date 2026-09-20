# TabPFN 3.5 technical validation results

Validation dates: 2026-09-16 to 2026-09-17

## Outcome

TabPFN 3.5 numerical regression inference runs in Chromium through ONNX Runtime
WebGPU. More importantly for Tabloom, a training context can be cached once and
reused by a prediction-only graph. The browser-portable context builder now
accepts dynamic training rows and feature counts, and the prediction graph
accepts the resulting dynamic cache together with dynamic test rows.

On the validation machine, a warm 32-row scenario took about 41 ms on WebGPU. Adding
`0.25` to one feature across those rows produced a different output in about
41 ms, and repeating the same scenario produced identical logits. This validates
the core interaction needed for a weather slider that refreshes a prediction
curve without recomputing the training context.

The raw-model Common View path is therefore validated end to end for numerical
regression: browser inputs can build a fresh context and immediately use it for
prediction without a Python runtime. High-level estimator parity is also now
validated for a single numerical regression ensemble member: after reproducing
the selected estimator preprocessing and official regression decoding, the
FP32 ONNX path matches `TabPFNRegressor.predict()` within `7.51e-5` on the tested
normal, NaN, and opt-in infinity fixtures. The remaining product work is to port
that estimator metadata/preprocessing/decoding into the browser adapter and to
cover multiple ensemble members, categoricals, and classification.

## Validated chain

```text
Official TabPFN 3.5 safetensors
                ↓
PyTorch 2.14 + CUDA 13 on NVIDIA GB10
                ↓
Build explicit training-context KV cache
                ↓
Flatten cache to 54 portable tensor inputs
                ↓
torch.export context builder, dynamic train rows/features
                ↓
ONNX Runtime Web builds 54 cache tensors in Chromium
                ↓
torch.export prediction graph, dynamic train/test rows/features
                ↓
ONNX opset 20 + external weights
                ↓
ONNX Runtime CPU reference
                ↓
ONNX Runtime Web WASM and WebGPU in Chromium
```

Generated models, fixtures, exporter reports, and browser reports are in the
ignored `artifacts/tabpfn35/` and
`spikes/tabpfn35/web/browser-results/` directories.

## Environment

| Component | Version / device |
| --- | --- |
| GPU | NVIDIA GB10, compute capability 12.1 |
| CUDA runtime | 13.0 |
| PyTorch | 2.14.0+cu130 |
| TabPFN | 9.0.0 |
| ONNX | 1.22.0 |
| ONNX Runtime / Web | 1.30.0 |
| Chromium | 152 headless |

## GPU estimator baseline

The high-level `TabPFNRegressor` used one estimator with `fit_with_cache` on a
deterministic synthetic regression fixture.

| Measurement | Result |
| --- | ---: |
| Training / test rows / features | 160 / 32 / 8 |
| Context fit and cache | 1.768 s |
| First prediction | 95.4 ms |
| Warm prediction | 14.6 ms |
| Peak CUDA allocation | 925,056,512 bytes |
| Repeat prediction max difference | 0 |
| Fixture RMSE | 0.3156 |

The RMSE is a smoke-test signal for the synthetic fixture, not a benchmark.

## Full-forward export baseline

The raw regression forward used 24 training rows, 8 test rows, one batch, and 4
features. It returned `[8, 1, 5000]` regression-bin logits.

| Stage | Result |
| --- | --- |
| PyTorch eager forward | Passed, finite float32 output |
| `torch.export`, fixed shape | Passed, 3,378 graph nodes |
| ExportedProgram vs eager | Exact match |
| ONNX opset 20 | Passed after two local lowerings |
| ONNX Runtime CPU | Passed, max logits delta `1.57e-5` |
| Chromium WebGPU | Passed, max logits delta `2.77e-5` |

The fixed ONNX graph has 11,266 nodes and 577 initializers. Its model file is
20,372,907 bytes and its external weights are 855,146,496 bytes.

The official full forward specializes total rows and feature count. A bounded
export attempt with dynamic test rows and features failed, which motivated the
prediction-only cache graph below.

## Dynamic browser context construction

The train-side work was isolated into a tensor-only context-builder graph. For
numerical regression it performs the same preprocessing, distribution
embedding, column aggregation, target embedding, and ICL train pass used by the
official v3.5 forward, then emits the same 54 tensors as `TabPFNV3p5Cache`.

Against `return_kv_cache=True`, all 54 PyTorch tensors matched exactly. The
exported graph supports 3–1,024 training rows and 1–32 input features in the
validated range. Checks at 8x2, 24x4, 64x8, and 256x16 had zero difference from
the eager wrapper.

The dynamic context-builder ONNX graph has 6,675 nodes, 557 initializers, two
inputs, and 54 outputs. Its graph file is about 10.9 MB and its external data is
about 792.4 MB in FP32. ONNX Runtime CPU passed all four dynamic shapes; the
largest per-cache-tensor difference was `3.22e-4`.

Chromium WASM also passed all four shapes:

| Train rows x features | Context time | Max cache-tensor delta |
| ---: | ---: | ---: |
| 8 x 2 | 166 ms | `7.18e-5` |
| 24 x 4 | 202 ms | `2.89e-4` |
| 64 x 8 | 499 ms | `1.63e-4` |
| 256 x 16 | 2.06 s | `2.94e-4` |

The same graph created a WebGPU session and completed every shape in Chromium
using SwiftShader. That proves current ONNX Runtime Web operator compatibility,
but its multi-second timings and larger numerical drift are software-fallback
results and are not hardware-WebGPU measurements. The native NVIDIA GPU was not
visible to the execution environment for this follow-up run.

The prediction graph was then re-exported so the cache dimensions are dynamic as
well. One exported program accepted 3–1,024 training rows, 1–1,024 test rows,
and 1–32 features. Eager/export checks at four different train/feature/test
shapes were exact.

Finally, the two ONNX sessions were chained directly:

```text
x_train + y_train
       ↓
context-builder ONNX
       ↓ 54 tensors
prediction ONNX + x_test
       ↓
5,000 regression logits
```

ONNX Runtime CPU matched the official full PyTorch forward within `2.96e-5` at
the largest tested shape (256 train rows, 16 features, 32 test rows). Chromium
WASM ran the same chain with no Python intermediate and the same `2.96e-5`
maximum logits difference.

### High-level estimator parity

`probe_estimator_parity.py` then compares the exported context/prediction path
with the official `TabPFNRegressor` rather than only with the raw network. The
validated estimator uses `n_estimators=1`, `fit_with_cache`, float32 inference,
the fitted ensemble member's official feature preprocessing, target handling,
border translation, aggregation, and `FullSupportBarDistribution` mean decode.

The actual fitted member used `preprocess_config='none'`, fingerprint feature
injection, feature-shuffle decoding, no target transform, and the official GPU
preprocessing path. The raw 8-feature fixture therefore enters the model with 9
features after preprocessing.

| Scenario | FP32 final mean max delta vs estimator | FP16-storage final mean max delta |
| --- | ---: | ---: |
| Numerical | `7.39e-5` | `0.001650` |
| Missing NaN | `4.63e-5` | `0.000630` |
| `+/-Inf`, `PASSTHROUGH_INF=True` | `7.51e-5` | `0.000916` |

NaN is accepted by the default estimator path. Infinity is rejected by default
and only participates in this parity check when the inference configuration
explicitly enables `PASSTHROUGH_INF=True`. The FP32 probability-distribution
maximum error stayed below `6.0e-7` in these fixtures. FP16 storage increases
raw logits/cache error, but the decoded mean remained within about `0.00165` of
the official estimator on the tested cases.

### Shared FP16 browser bundle

The initial two-graph packaging duplicated most weights. In FP32, the context
graph carries about 792.4 MB of initializers and the prediction graph about
651.9 MB. Exactly 417 initializer tensors are byte-identical, accounting for
589.1 MB shared bytes: 74.35% of context weights and 90.37% of prediction
weights.

Using FP16 storage with FP32 compute reduces the two graphs to 722,519,456 bytes
of initializer data before deduplication. Rewriting both ONNX models to point to
one external-data file produces a 427,785,792-byte shared blob, saving
294,733,664 bytes, or 40.79%, compared with storing both FP16 weight sets
separately. Together with the two small ONNX graph files, this is the practical
Common View delivery candidate.

Chromium then fetched that shared 427,785,792-byte file once into one
`Uint8Array` and reused the same object to initialize both ONNX Runtime Web
sessions. Both WASM and WebGPU completed the full context-builder -> prediction
chain successfully. The WebGPU run used a non-fallback NVIDIA adapter.

| Backend | Shared-data fetches | 256x16 context | 32-row prediction | Max logits delta |
| --- | ---: | ---: | ---: | ---: |
| WASM | 1 | 2.06 s | 246 ms | `0.003161` |
| WebGPU (NVIDIA) | 1 | 316 ms | 41.5 ms | `0.003156` |

The first small WebGPU scenario paid shader/provider warm-up cost, so its timing
is not representative. The 256x16x32 run is a better steady-state signal for
the Common View context build. The key packaging result is that a unified graph
is not required merely to avoid duplicate network download: two sessions can
reference one browser-fetched shared weight blob.

This does not prove runtime memory is shared. ONNX Runtime can still materialize
and cast weights separately inside each session. The MVP should therefore cache
the one network blob in persistent browser storage, create the context-builder
session only when Common View needs a fresh context, dispose it after producing
the reusable context where practical, and let Case View skip the context builder
entirely when a prebuilt context is available.

## Dynamic explicit KV-cache path

The probe builds the official `TabPFNV3p5Cache`, then flattens it into normal
tensor inputs. For a 24-row, 4-feature training context it contains:

- 24 key/value layer pairs;
- standardizer mean and standard deviation;
- ECDF context;
- three inducing-hidden tensors;
- 54 tensors and 1,082,528 bytes in total.

Cached eager inference took about 8.6 ms on CUDA. Its maximum logits difference
from the equivalent full forward was `2.86e-6`.

### `torch.export`

The original prediction graph supported test batches from 1 through 1,024 rows
with a fixed cache. The follow-up dynamic-context export also makes training rows
and feature count dynamic. Runs across 8/24/64/256 training rows, 2/4/8/16
features, and varying test rows exactly matched the eager cached wrapper.

Two export-only adaptations were required:

1. The official stage 0–2 path uses a Python row loop even when it performs one
   iteration. The wrapper directly composes the same official preprocessing,
   distribution embedder, column aggregator, ICL blocks, and regression head.
2. The TabPFN SDPA wrapper calculates CUDA grid chunks with a Python loop, which
   specializes a symbolic row count. The export wrapper calls the same PyTorch
   SDPA operation once. The validated 1,024-row bound is well below that
   wrapper's 65,536 parallel-call protection threshold.

No installed package source or checkpoint was changed.

### ONNX Runtime CPU

The dynamic ONNX graph has 4,905 nodes, 437 initializers, and 55 inputs: one
test tensor plus the 54 cache tensors.

| File | Bytes |
| --- | ---: |
| `tabpfn35-kv-dynamic.onnx` | 7,981,449 |
| `tabpfn35-kv-dynamic.onnx.data` | 651,853,824 |

ONNX Runtime CPU passed every tested row count. The largest logits difference
from PyTorch was `2.15e-5`, at 1,024 rows.

### Chromium browser results

Both providers used the same dynamic graph and cache. Timings are single local
runs and include provider warm-up effects; the one-row WebGPU run is therefore
not representative of steady interaction latency.

| Test rows | WebGPU | WASM | WebGPU max delta | WASM max delta |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 543.3 ms | 104.7 ms | `2.00e-5` | `1.14e-5` |
| 8 | 105.0 ms | 75.7 ms | `2.62e-5` | `1.41e-5` |
| 32 | 61.0 ms | 208.7 ms | `2.86e-5` | `1.49e-5` |
| 256 | 73.9 ms | 1,451.8 ms | `3.00e-5` | `2.15e-5` |
| 1,024 | 178.2 ms | 5,712.0 ms | `3.47e-5` | `2.19e-5` |

The WebGPU session loaded in 2.88 seconds and used a non-fallback NVIDIA
adapter. ONNX Runtime assigned some shape operations to CPU, as indicated by
its execution-provider warning.

For the explicit interaction check, the browser added `0.25` to feature 0 for
32 rows. Two consecutive WebGPU runs took 41.3 and 41.1 ms; the logits changed
by up to `0.392`, and the repeated result had zero difference. WASM performed
the same update in 200.3 ms.

These measurements use localhost and an already downloaded model. They exclude
first network download, persistent cache population, regression decoding, and
chart rendering.

## Required ONNX lowerings

PyTorch 2.14 did not provide ONNX translations for two captured ATen operators:

1. `aten.searchsorted.Tensor`, lowered to broadcast comparison, cast, and
   `ReduceSum` for numerical ECDF bucketing;
2. `aten._fused_rms_norm.default`, lowered to `ReduceMean(x²)`, epsilon, square
   root, reciprocal, and weight multiplication.

The local implementations live in `probe_onnx.py`.

## Confirmed limitations

- The validated dynamic range is 3–1,024 training rows, 1–1,024 test rows, and
  1–32 numerical features at batch size 1. Larger shapes need separate memory
  and export validation.
- Estimator parity has been established with official preprocessing/decoding in
  the Python probe, but the equivalent metadata-driven preprocessing and decode
  still need to be implemented in the browser adapter.
- Missing NaN values passed estimator parity. Infinity requires the explicit
  `PASSTHROUGH_INF=True` inference option; default estimator behavior rejects it.
- Categorical features, classification, and multiple ensemble members have not
  yet been validated end to end.
- The shared external-data bundle removes duplicate network/disk weights, but it
  does not prove that two ORT sessions share runtime/GPU memory. Session lifetime
  and disposal still need memory measurement on target browsers.
- FP16 storage is the leading browser candidate because decoded estimator means
  stayed within about `0.00165` on the current fixtures. FP32 remains the
  reference/fallback until real Case View datasets confirm this tolerance.
- Download progress, IndexedDB/OPFS caching, licenses, and measured browser
  memory limits remain product work.

## Package integration issue found

`tabpfn==9.0.0` resolves an explicitly supplied checkpoint path before format
detection. A Hugging Face cache symlink becomes an extensionless blob path and
is incorrectly treated as a PyTorch pickle. The spike uses a local checkpoint
file whose `.safetensors` suffix is preserved.

## Next validation gate

The numerical-regression core and shared browser delivery path are now strong
enough to move into product integration. The next gate is the actual browser
adapter rather than another raw-model export experiment:

1. port estimator metadata, feature transforms, regression decode, and target
   inverse into TypeScript, checked against the existing parity fixtures;
2. connect DuckDB-WASM Arrow/TypedArray columns to `fitContext()` and `predict()`;
3. persist the shared weight blob and generated contexts in IndexedDB/OPFS, and
   measure peak JS/WASM/GPU memory while creating and disposing sessions;
4. run the same final-mean parity check on the first real weather Case View;
5. then add multiple ensemble members, categoricals, classification, and the
   non-blocking TabPFN v3 compatibility probe.

Fixed full-forward shape buckets and a mandatory unified TabPFN graph are no
longer needed for the MVP architecture.
