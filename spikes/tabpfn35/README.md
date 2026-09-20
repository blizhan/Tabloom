# TabPFN 3.5 feasibility spike

This spike answers the first technical question for Tabloom: can the official
TabPFN 3.5 model run correctly on the available GPU, and what blocks exporting
the same inference path to a browser runtime?

## Environment

Create the isolated environment from the repository root:

```bash
uv sync --project spikes/tabpfn35
```

The project pins the CUDA 13.0 PyTorch index because the validation machine uses
an NVIDIA GB10 GPU (compute capability 12.1).

Keep caches inside the repository's ignored `.cache` directory:

```bash
export HF_HOME="$PWD/.cache/huggingface"
export SKB_DATA_DIRECTORY="$PWD/.cache/skrub"
export MPLCONFIGDIR="$PWD/.cache/matplotlib"
```

## GPU reference run

```bash
.venv/bin/python spikes/tabpfn35/validate_gpu.py
```

The command writes the deterministic fixture and environment/timing report to
`artifacts/tabpfn35/`. Generated artifacts and model caches are ignored by Git.

## Raw forward export probe

Run the fixed-shape `torch.export` probe against a local checkpoint with a real
`.safetensors` filename:

```bash
.venv/bin/python spikes/tabpfn35/probe_export.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"
```

The report distinguishes eager-forward failures from graph-capture failures and
stores the exact exception under `artifacts/tabpfn35/export/`.

Probe bounded dynamic test-row and feature dimensions:

```bash
.venv/bin/python spikes/tabpfn35/probe_dynamic_export.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"
```

Probe the prediction-only explicit KV-cache path and dynamic test batches:

```bash
.venv/bin/python spikes/tabpfn35/probe_kv_cache_export.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"

.venv/bin/python spikes/tabpfn35/probe_kv_cache_onnx.py
.venv/bin/python spikes/tabpfn35/prepare_kv_web_fixture.py
```

Probe browser-side context construction and a prediction graph whose training
rows, test rows, and feature count are all dynamic:

```bash
.venv/bin/python spikes/tabpfn35/probe_context_build_export.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"
.venv/bin/python spikes/tabpfn35/probe_context_build_onnx.py
.venv/bin/python spikes/tabpfn35/prepare_context_web_fixture.py

.venv/bin/python spikes/tabpfn35/probe_dynamic_context_prediction_export.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"
.venv/bin/python spikes/tabpfn35/probe_kv_cache_onnx.py \
  --exported-program artifacts/tabpfn35/dynamic-context-predict/tabpfn35-predict-dynamic-context.pt2 \
  --fixture artifacts/tabpfn35/kv-cache/kv_cache_fixture.npz \
  --output-dir artifacts/tabpfn35/dynamic-context-predict/onnx

.venv/bin/python spikes/tabpfn35/probe_context_chain_onnx.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"
.venv/bin/python spikes/tabpfn35/prepare_context_chain_web_fixture.py
```

Convert the captured fixed-shape program to ONNX and compare it with ONNX
Runtime CPU:

```bash
.venv/bin/python spikes/tabpfn35/probe_onnx.py
```

The ONNX probe records the full operator inventory. That inventory is the input
to the subsequent ONNX Runtime Web/WebGPU compatibility check.

Prepare the browser fixture and run the two browser execution providers:

```bash
.venv/bin/python spikes/tabpfn35/prepare_web_fixture.py

# Export complete estimator-level inputs/means for the Common View runtime.
# This requires the same checkpoint and a visible CUDA device; it never
# invents golden values when either prerequisite is missing.
.venv/bin/python spikes/tabpfn35/export_estimator_golden.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors"
cd spikes/tabpfn35/web
npm install
npm run probe:wasm
npm run probe:webgpu
npm run probe:kv-wasm
npm run probe:kv-webgpu
npm run probe:context-wasm
npm run probe:context-webgpu
npm run probe:context-chain-wasm
npm run probe:shared-context-chain-wasm
npm run probe:shared-context-chain-webgpu
```

The runner uses the system Chromium, records WebGPU adapter information, and
compares browser logits with the PyTorch fixture. The `kv-*` commands exercise
one dynamic prediction graph at 1, 8, 32, 256, and 1,024 rows and rerun a changed
32-row scenario against the same training cache. Browser reports are written to
the ignored `spikes/tabpfn35/web/browser-results/` directory.

The `shared-context-chain-*` probes fetch the deduplicated FP16 external-data
blob once into a `Uint8Array`, reuse that exact buffer for both the dynamic
context-builder and prediction sessions, then run the complete chain. This is
the packaging path intended for Common View.

## Official estimator golden export

The exporter uses the pinned official estimator, not the runtime implementation.
Help works with standard Python and no checkpoint/GPU:

```bash
python3 spikes/tabpfn35/export_estimator_golden.py --help
UV_PROJECT_ENVIRONMENT="$PWD/.venv" uv sync --project spikes/tabpfn35 --frozen
.venv/bin/python spikes/tabpfn35/export_estimator_golden.py \
  --model-path "$PWD/.cache/models/tabpfn-v3.5-20260909.safetensors" \
  --output-dir artifacts/tabpfn35/estimator-golden
```

Generation requires a real local checkpoint, tabpfn 9.0.0 and visible CUDA.
Missing prerequisites fail without downloading a model or inventing references.
The output directory must be empty: use a new directory for another generation.
Normal, missing values, opt-in infinity, a second seed, duplicate rows, constant
columns and extreme finite values are covered; default infinity rejection is
checked separately. Unsupported fitted profiles fail explicitly.

The manifest is written last. Partial files without it are not usable fixtures.
See [estimator-golden-schema.md](estimator-golden-schema.md) for the format and
the distinction between exported reference values and completed parity testing.
This command does not run browser comparisons or certify the runtime adapter.

## Validation order

1. Run the official TabPFN 3.5 estimator on CUDA.
2. Freeze a deterministic reference fixture.
3. Isolate preprocessing from the raw PyTorch model forward pass.
4. Probe `torch.export` and ONNX export with fixed shapes.
5. Compare ONNX Runtime CPU output with the Python reference.
6. Inspect the exported operator set against ONNX Runtime Web/WebGPU support.
7. Run the artifact in a browser and record cold/warm latency and memory.

The spike does not claim browser support until steps 4–7 pass.
