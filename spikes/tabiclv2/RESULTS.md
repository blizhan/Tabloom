# TabICL v2 technical validation results

Validation date: 2026-09-17

## Outcome

The official TabICL v2 regressor runs end to end on CUDA and its cache-aware
mean-prediction path runs in Chromium through ONNX Runtime Web WASM and WebGPU.
The exported graph accepts 1–1,024 dynamic test rows while embedding the fixed
training context in a 12 MiB KV cache.

On the validation machine, two warm WebGPU runs of a changed 32-row scenario
took 32.2 ms and 35.1 ms. Changing feature 0 changed the final mean prediction,
while repeating the same input produced a maximum difference of zero. This is
the latency and behavior needed for an interactive weather or price scenario
curve.

The result is stronger than a raw-forward smoke test: the official sklearn
estimator's cached prediction and the direct cache path plus inverse target
transform matched exactly on the numerical regression fixture. The browser
artifact starts at the transformed numerical tensor and returns target-scaled
means, so feature metadata and the small target inverse transform still belong
in the future JavaScript adapter.

## Validated chain

```text
Official jingang/TabICL v2 regression checkpoint
                     ↓
TabICLRegressor 2.2.0 on CUDA
                     ↓
Official KV cache for the fixed 160-row context
                     ↓
Cache-aware mean graph, dynamic 1–1,024 test rows
                     ↓
torch.export → ONNX opset 20 + external weights
                     ↓
ONNX Runtime CPU reference
                     ↓
ONNX Runtime Web WASM and WebGPU in Chromium
```

Generated checkpoints, models, fixtures, exporter reports, and browser reports
are ignored under `artifacts/tabiclv2/` and
`spikes/tabiclv2/web/browser-results/`.

## Provenance and environment

| Component | Version / device |
| --- | --- |
| Official repository | `jingang/TabICL`, revision `4dcd344ece2c00be9e831fdd35bed57b5ad83e19` |
| Checkpoint | `tabicl-regressor-v2-20260212.ckpt` |
| Package / Git tag | `tabicl==2.2.0` / `v2.2.0` |
| License | BSD-3-Clause |
| GPU | NVIDIA GB10, compute capability 12.1 |
| CUDA runtime | 13.0 |
| PyTorch | 2.14.0+cu130 |
| ONNX | 1.22.0 |
| ONNX Runtime / Web | 1.30.0 |
| Chromium | 152 headless |

## GPU estimator and official cache

The deterministic regression fixture has 160 training rows, 32 test rows, and
8 float features. To isolate one portable prediction graph, the estimator used
one ensemble member, normalization method `none`, no feature shuffle, float32,
and disabled AMP, FlashAttention 3, and offload.

| Measurement | Result |
| --- | ---: |
| Fit and build cache | 0.726 s |
| First prediction | 92.2 ms |
| Warm prediction | 8.77 ms |
| Warm changed-scenario prediction | 7.29 ms |
| Peak CUDA allocation | 176,069,120 bytes |
| Fixture RMSE | 0.5050 |
| Repeated prediction max difference | 0 |
| High-level estimator vs direct cached path | 0 |

The RMSE is only a smoke-test signal for the synthetic fixture. The cache has
30 float32 tensors: 3 column-attention K/V pairs and 12 ICL-attention K/V
pairs. It occupies 12,582,912 bytes for this 160-row, 8-feature context.

## `torch.export`

Both fixed and bounded-dynamic exports passed. The dynamic graph ran 1, 8, 32,
256, and 1,024 test rows with exact equality to the eager export wrapper. Its
serialized artifact is 128,778,972 bytes.

Three export-only adaptations were required:

1. `SkippableLinear` and the induced-attention block use Python `if` statements
   on tensor masks. The export shim expresses the same masking with
   `torch.where`.
2. `InferenceManager` performs Python-side GPU memory estimation, batching,
   offload selection, and diagnostic formatting. The browser graph directly
   calls the same single-batch model functions because the input is already
   sized and all tensors use one device.
3. The official mean path constructs a full `QuantileDistribution`, including
   unused tail models. The graph directly applies the official mean semantics:
   sort the 999 predicted quantiles, then take their mean.

The shims and direct mean postprocessing each had zero difference from the
official eager output. No installed package source or checkpoint was changed.

## ONNX Runtime

ONNX opset 20 conversion succeeded without custom operator lowerings. The
dynamic graph contains 2,939 nodes and 328 initializers.

| File | Bytes |
| --- | ---: |
| `tabiclv2-kv-dynamic.onnx` | 4,348,449 |
| `tabiclv2-kv-dynamic.onnx.data` | 124,874,752 |
| Total | 129,223,201 |

ONNX Runtime CPU produced finite values for every tested row count. Its largest
absolute difference from PyTorch was `1.21e-5`.

## Chromium browser results

Both browser providers used the same model with its cache embedded as ONNX
initializers. Timings are single local runs; the first WebGPU inference includes
shader compilation and is not representative of warm interaction latency.

| Test rows | WebGPU | WASM | WebGPU max delta | WASM max delta |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 554.7 ms | 57.5 ms | `3.86e-6` | `4.44e-6` |
| 8 | 64.3 ms | 22.3 ms | `4.42e-6` | `5.60e-6` |
| 32 | 78.0 ms | 51.3 ms | `9.83e-6` | `7.90e-6` |
| 256 | 40.7 ms | 353.3 ms | `1.03e-5` | `1.04e-5` |
| 1,024 | 92.0 ms | 1,394.4 ms | `1.07e-5` | `1.20e-5` |

The WebGPU session loaded in 1.78 seconds and the WASM session in 1.39 seconds.
ONNX Runtime assigned some shape operations to CPU. For the explicit interaction
check, the browser added `0.25` to feature 0 across 32 rows. Consecutive WebGPU
runs took 32.2 ms and 35.1 ms; the target-scaled prediction changed by up to
`0.1546` (about `0.333` original target units), and the repeated output was
identical. WASM took about 46 ms for the same warm interaction.

These measurements use localhost and already downloaded weights. They exclude
network download, persistent-cache writes, feature preparation, target inverse
scaling, and chart rendering.

## Confirmed limitations

- The dynamic dimension is test rows. Training rows, feature count, batch size,
  and cached context remain fixed per built artifact.
- Cache construction still uses Python/PyTorch. A production app can build and
  publish case caches in CI; arbitrary user datasets still need a browser
  context-building path or a constrained full-forward graph.
- Browser parity covers numerical float regression, one ensemble member,
  normalization `none`, and mean output. Multiple normalization views,
  categorical input, missing values, quantiles, classification, and the smaller
  `repr` cache have not yet been validated.
- The JavaScript adapter still needs to serialize the estimator's feature
  transform metadata and apply target inverse scaling. Both boundaries were
  identified and the equivalent Python paths matched exactly in this fixture.
- The FP32 artifact is about 129 MB. The validated FP16-storage, FP32-compute
  variant is 66,935,156 bytes raw and 57,445,298 bytes with Brotli quality 5.
  Its largest observed mean-output delta is `0.00103`; WebGPU remains
  interactive at about 53 ms for a warm 32-row update. See
  [`../COMPRESSION_RESULTS.md`](../COMPRESSION_RESULTS.md). Product work still
  needs download progress, persistent caching, memory checks, and license display.
- Headless Chromium intermittently returned no adapter from a diagnostic
  `requestAdapter()` call, while the ONNX Runtime WebGPU session still executed
  successfully. Provider initialization and capability reporting need a robust
  production implementation.

## Product implication and next gate

TabICL v2 is now a strong primary candidate for the first regression Case View:
its browser artifact is roughly one fifth of the current TabPFN 3.5 cache graph,
and warm 32-row scenario updates are within one animation interval on this GPU.
CI can build the cache for a published live-data case, while the browser changes
future covariates and reruns only the dynamic prediction graph.

The next technical gate is a reusable TabICL adapter and one real temporal
fixture:

1. serialize numeric/categorical feature transforms and target scaling;
2. compare final browser values with `TabICLRegressor.predict()` on missing and
   categorical features;
3. test the first weather plus energy time-split fixture without leakage;
4. decide whether arbitrary Common View datasets use exported full-forward
   context building, a browser-native implementation, or an explicit constrained
   mode;
5. then validate the classifier checkpoint and `repr` cache tradeoff.
