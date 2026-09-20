# Browser model compression results

Validation date: 2026-09-17

## Decision

Use **FP16 storage with FP32 computation** as the download artifact for both
validated browser models. Large matrix weights are serialized as FP16 and cast
to FP32 once when ONNX Runtime creates the session. This halves download and
persistent-cache size while keeping the operators on the already validated
FP32 WebGPU/WASM paths.

This optimization does not promise a matching reduction in runtime memory.
The session expands the stored FP16 matrices to FP32, and provider-specific
copies and compiled GPU resources add further memory. Browser memory must be
measured separately from artifact bytes.

## Artifact and transfer size

The transfer measurements compress the `.onnx` graph and external data file
separately, matching normal static hosting. Gzip uses level 6 and Brotli uses
quality 5.

| Model and representation | Raw bytes | Gzip bytes | Brotli bytes | Raw reduction from FP32 |
| --- | ---: | ---: | ---: | ---: |
| TabPFN 3.5 FP32 | 659,835,273 | 604,946,358 | 604,113,916 | — |
| TabPFN 3.5 FP16 storage | 334,121,501 | 301,848,375 | 300,668,368 | 49.36% |
| TabICL v2 FP32 | 129,223,201 | 116,330,685 | 114,949,961 | — |
| TabICL v2 FP16 storage | 66,935,156 | 58,323,293 | 57,445,298 | 48.20% |
| TabPFN 3.5 FP8 E4M3 storage | 171,247,320 | 126,653,320 | 125,974,050 | 74.05% |
| TabICL v2 FP8 E4M3 storage | 35,797,754 | 23,905,125 | 23,530,908 | 72.30% |

Brotli alone saves only 8–14% because trained floating-point weights have high
entropy. Converting the storage representation supplies nearly all of the useful
reduction; applying Brotli to that representation brings TabPFN 3.5 to about
301 MB and TabICL v2 to about 57 MB over the network.

## TabPFN 3.5 variants

| Variant | Raw bytes | Numerical result | WebGPU 32-row warm interaction | WASM 32-row warm interaction | Decision |
| --- | ---: | --- | ---: | ---: | --- |
| FP32 | 659,835,273 | reference | 41.1 ms | about 200 ms | fallback/reference |
| FP16 storage, FP32 compute | 334,121,501 | max logits delta `0.00251` | 34.9 ms | 203.0 ms | preferred candidate |
| Dynamic INT8 | 352,592,699 | max logits delta `0.09210` | 395.1 ms | 206.4 ms | reject |
| Full FP16 compute | 333,986,330 | max logits delta `6.06` | not promoted | CPU ORT about 15.6 s at 32 rows | reject |

The INT8 graph quantizes only 100 eligible matrix paths and retains 193 normal
`MatMul` nodes, so it is larger than the FP16-storage graph. ONNX Runtime Web
can load it, but its quantized matrix path does not stay on an efficient WebGPU
route; the warm interaction is roughly eleven times slower than FP16 storage.

The FP16-storage differences above compare 5,000 regression-bin logits. Final
`TabPFNRegressor.predict()` parity, including regression-bin decoding and target
inverse transforms, remains the release gate. Until that passes, retain the
FP32 artifact as a selectable fallback.

## TabICL v2 variant

The FP16-storage graph converts 140 large initializers and retains 188 small or
sensitive initializers as FP32. It returns the final target-scaled mean rather
than intermediate bin logits.

| Measurement | FP32 | FP16 storage |
| --- | ---: | ---: |
| Raw artifact | 129,223,201 bytes | 66,935,156 bytes |
| Largest mean-output delta from PyTorch | about `1.2e-5` | `0.00103` |
| WebGPU 32-row changed/repeat | 32.2 / 35.1 ms | 53.3 / 52.7 ms |
| WASM 32-row changed/repeat | about 46 ms | 46.8 / 46.4 ms |

The compressed TabICL graph stays interactive, but the inserted casts make the
measured WebGPU run slower. It is a useful default for bandwidth-constrained
loading; FP32 can remain available for maximum numerical fidelity and lowest
latency on fast connections.

## FP8 storage experiment

The FP8 candidates use ONNX `FLOAT8E4M3FN` initializers and an FP32 `Cast`
before each original computation path. This reduces raw files a further 49–52%
relative to FP16 storage, but it is not a browser-compatible artifact with the
current ONNX Runtime Web 1.30.0. Both WebGPU and WASM fail during session
creation with:

```text
ERROR_CODE: 9 ... tensor type 17 is not supported
```

Therefore there is no meaningful browser runtime-memory or latency measurement
for FP8: the session never reaches allocation or inference. A custom loader
could download FP8 bytes and expand them to Float32 before creating the ONNX
session, but then the runtime would still hold the expanded FP32 weights and the
implementation would need its own decoder.

The native ONNX Runtime CPU validator can execute the graph, which quantifies
the numerical cost of the storage format:

| Model | FP8 max error | FP8 mean error | FP16-storage max error | FP16-storage mean error |
| --- | ---: | ---: | ---: | ---: |
| TabPFN 3.5 logits | `0.36007` | `0.04545` | `0.00251` | `0.00033` |
| TabICL v2 final mean | `0.09668` | `0.06040` | `0.00103` | `0.00072` |

FP8 error is roughly 143× larger than FP16 storage for TabPFN logits and 94×
larger for TabICL's maximum output error. Even before considering browser
compatibility, this is too much drift for the interactive prediction curves.
FP8 remains an experiment for a future runtime with explicit FP8 decode support;
FP16 storage is the current compressed release candidate.

## Product loading policy

1. Publish immutable, content-hashed FP16-storage graph and data files with
   Brotli and gzip content negotiation.
2. Show the real compressed download size in the model picker: roughly 301 MB
   for TabPFN 3.5 and 57 MB for TabICL v2 with the current artifacts.
3. Download on demand, display progress, and persist by model hash. Avoid
   downloading all model families during application startup.
4. Keep one ONNX session resident at a time. Artifact size is not a proxy for
   GPU or WASM memory, so add device memory and session-creation probes before
   enabling TabPFN 3.5 on constrained devices.
5. Use TabICL v2 as the first Case View default. Offer TabPFN 3.5 as an explicit
   higher-cost comparison after its final decoded-prediction parity passes.

## Runtime memory snapshot

The following post-inference snapshots were taken after running every scenario
through 1,024 rows in headless Chromium 152 on the NVIDIA GB10. GPU memory is
the NVIDIA process allocation. Host memory is the sum of Chromium process RSS,
so it includes browser overhead and can double-count shared pages; treat it as
a practical upper-bound snapshot rather than model-only memory.

| Backend and model | FP32 host RSS | FP16-storage host RSS | FP32 GPU | FP16-storage GPU |
| --- | ---: | ---: | ---: | ---: |
| WebGPU TabPFN 3.5 | about 2.09 GiB | about 2.83 GiB | 996 MiB | 996 MiB |
| WebGPU TabICL v2 | about 1.60 GiB | about 1.76 GiB | 528 MiB | 529 MiB |
| WASM TabPFN 3.5 | about 2.26 GiB | about 2.33 GiB | n/a | n/a |
| WASM TabICL v2 | about 1.70 GiB | about 1.64 GiB | n/a | n/a |

FP16 storage is therefore a network and persistent-cache optimization, not a
runtime-memory optimization. On WebGPU, ONNX Runtime expands weights to FP32;
the browser can also retain the downloaded FP16 data, which explains the higher
host RSS. A safe initial capability gate is roughly 2 GiB of available GPU
memory and 4 GiB of available host memory for TabPFN, or 1 GiB GPU and 2.5 GiB
host memory for TabICL. Integrated GPUs share system memory, so those budgets
must be considered together.

## Precision impact in prediction units

For TabPFN 3.5, FP16 storage changes the 5,000 regression-bin logits by a mean
absolute `0.00033` and a maximum `0.00251`. The tested feature edit changed
logits by up to `0.392`, making the maximum storage error about 0.64% of that
interaction signal. This is encouraging but does not establish final prediction
error because the official bar-distribution decode and estimator transforms are
not yet included in the browser graph.

TabICL v2 already returns its final mean in target-scaled coordinates. Its
maximum and mean absolute differences are `0.00103` and about `0.00072` there.
After the fixture's target inverse scale, these become approximately `0.00221`
maximum and `0.00156` mean in original target units. The maximum is about 0.19%
of this synthetic fixture's prediction range. Real weather and energy fixtures
still need their own acceptance thresholds because the meaning of 0.002 target
units depends on the target being predicted.

The converters and validators are in `spikes/optimize_onnx.py`,
`spikes/validate_optimized_onnx.py`, and
`spikes/measure_transport_compression.mjs`. Generated model and browser result
files remain under ignored `artifacts/` and `browser-results/` directories.
