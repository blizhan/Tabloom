# TabICL v2 feasibility spike

This spike validates the official `tabicl==2.2.0` v2 regressor on CUDA and in
Chromium WASM/WebGPU. The cache-aware prediction graph supports 1–1,024 dynamic
test rows. See [RESULTS.md](RESULTS.md) for measurements, export adaptations,
and current limits.

The official model repository is `jingang/TabICL`. Generated checkpoints,
fixtures, ONNX files, and reports stay in ignored project-local directories.

## Reproduce

Sync the isolated environment:

```bash
UV_PROJECT_ENVIRONMENT="$PWD/.venv-tabiclv2" uv sync --project spikes/tabiclv2
```

Download the official `tabicl-regressor-v2-20260212.ckpt` into
`.cache/models/tabiclv2/`, then run the GPU stages with a visible CUDA device:

```bash
.venv-tabiclv2/bin/python spikes/tabiclv2/validate_gpu.py \
  --model-path "$PWD/.cache/models/tabiclv2/tabicl-regressor-v2-20260212.ckpt"

.venv-tabiclv2/bin/python spikes/tabiclv2/probe_export.py \
  --model-path "$PWD/.cache/models/tabiclv2/tabicl-regressor-v2-20260212.ckpt"

.venv-tabiclv2/bin/python spikes/tabiclv2/probe_onnx.py
.venv-tabiclv2/bin/python spikes/tabiclv2/prepare_web_fixture.py

.venv-tabiclv2/bin/python spikes/optimize_onnx.py \
  artifacts/tabiclv2/onnx/tabiclv2-kv-dynamic.onnx \
  --output-dir artifacts/tabiclv2/optimized \
  --name tabiclv2-kv-dynamic --mode fp16-storage

# Export the fixed, artifact-bound Case golden consumed by the runtime. The
# exporter intentionally does not expose arbitrary training-data fitting.
.venv-tabiclv2/bin/python spikes/tabiclv2/export_case_golden.py \
  --model-path "$PWD/.cache/models/tabiclv2/tabicl-regressor-v2-20260212.ckpt" \
  --fp32-model artifacts/tabiclv2/onnx/tabiclv2-kv-dynamic.onnx \
  --fp16-model artifacts/tabiclv2/optimized/tabiclv2-kv-dynamic-fp16-storage.onnx \
  --fp32-max-abs-error "${TABICL_FP32_TARGET_BUDGET:?Set the target-unit acceptance budget before validation}" \
  --fp16-max-abs-error "${TABICL_FP16_TARGET_BUDGET:?Set the target-unit acceptance budget before validation}"
```

The FP16 graph is produced by the optimization command above; its existing
measurements are in [RESULTS.md](RESULTS.md). Both graphs must contain the same fixed training Case.
Declare both budgets in **original target units before running**; graph-output
errors in standardized units are not interchangeable with these budgets. The
exporter records the budgets, tests both supplied graphs against official means
using CPU ONNX Runtime, and refuses to overwrite an existing manifest. This
check binds the supplied graph to the fixture; it does not certify browser parity.

The exporter requires the local checkpoint, both graph files and their external
data and the pinned Python environment. The default release-baseline command
also requires CUDA; `--device cpu` is an explicit, non-release fallback for
reproducibility checks. It fails without writing a golden when dependencies,
inputs, the selected device, preprocessing compatibility or parity checks fail.
It never downloads a checkpoint or substitutes synthetic predictions.

### Case golden schema (version 1)

The default output is `artifacts/tabiclv2/case-golden/manifest.json`, with adjacent
little-endian float32 files. Pass `--output-dir runtime/tests/fixtures/tabiclv2`
only when publishing a verified small fixture into the runtime test suite.

- `arrays` lists raw training features/targets, test targets, baseline and changed
  prediction inputs, complete transformed model inputs and complete official
  mean arrays. Every entry declares shape, byte length, dtype and SHA-256.
- `scenarios` maps baseline and changed-input names to their raw/model/mean arrays.
- `checkpointSha256`, `seed` and the ordered training-array digest record the
  fixed Case provenance. The training digest encoding is explicitly declared;
  it is not the runtime's canonical `ContextIdentity.trainingDataDigest` encoding.
- Each `variants` entry has a precision-specific artifact manifest, graph and
  external-data SHA-256 values, frozen target-unit budget and CPU binding results.
  No model weights are copied into the golden directory.
- `embeddedCaseRecipe` contains the embedded-artifact payload and fitted state:
  feature order/permutation, the official `standardize-clamp-v1` feature
  transform (fitted means/scales and outlier bounds), finite-input restriction,
  normalization, seed, training shape and the **official fitted** target scaler.
  The exporter refuses to omit fitted preprocessing metadata or silently fall
  back to a surrogate transform. The recipe is deliberately not a runtime
  snapshot.

To construct an actual snapshot, load the raw training arrays into the runtime's
`buildContextIdentity` with this feature order, target name, preprocessing version,
precision-specific artifact manifest digest and Case configuration. Supply the
actual source snapshot ID and execution provider; then attach the recipe's fitted
state and embedded-artifact payload and call `encodeContextSnapshot`. Do not
invent a context key or substitute a checkpoint/NPZ digest for the artifact digest.
Browser acceptance must compare all mean values after target inverse scaling to
the frozen precision-specific budget. Case preprocessing contains no surrogate
linear weights or bias.

Run the browser probes:

```bash
cd spikes/tabiclv2/web
npm install
npm run probe:wasm
npm run probe:webgpu
```
