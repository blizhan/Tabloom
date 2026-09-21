# Tabloom Common View Runtime

## Interactive prediction workbench

Open `http://127.0.0.1:4176/` after `npm --prefix runtime run dev:app` from the repository root.
Add one or more data sources, then materialise them as one **Dataset**. The quick-start
example is under **添加数据源 → 加载示例数据** and loads all 256 rows at once. Dataset SQL
can reference multiple sources and use ordinary SQL `JOIN`; the materialised Dataset is
then split into **Train / Test** using the standard machine-learning terminology.

Edit **Train SQL** and **Test SQL**, then click **执行 Train / Test SQL**. SQL column
selection, `WHERE`, `ORDER BY` and `LIMIT` determine the actual model input; the 200-row
table preview limit is display-only and never truncates the model data. The default split
is deterministic 80% Train / 20% Test (204 / 52 rows for the example); a time split uses
`Train < cutoff` and `Test >= cutoff`.

Choose one numeric target tag and any number of shared numeric feature tags. The target
never enters the feature matrix, even when Test contains it as a truth column. The main
result is a mean curve and q25–q75 central prediction interval; missing truth stays
missing rather than becoming zero. Choose the chart x-axis in **05 · RESULT**—`hour_utc`
and other Test columns are valid choices—or use input row order. Load the model first;
the Test prediction button remains disabled until the model reports **已加载**. Hover,
touch or focus chart points to read values at that x-position. Use the range sliders,
quick presets and move/zoom controls to inspect a window; the y-axis bounds recalculate
from the visible rows. Test details are collapsed below the chart, while CSV download
and experiment export/save stay in the left rail.

Saved configurations retain the Dataset snapshot, both SQL statements, split preset,
target, features, x-axis and source snapshot bindings. Experiment JSON contains only
configuration and snapshot references; it explicitly does not include source data or
model weights, so it is not a standalone cross-device data package.

For example, after loading the example Dataset, use
`SELECT temperature_c AS x, demand_mwh * 2 AS price FROM dataset ORDER BY __tabloom_row_id LIMIT 64`
for Train and the equivalent `LIMIT 7` query for Test. The result must contain exactly
7 predictions. The current TabPFN workbench accepts 3–1024 Train rows, 1–1024 Test
rows and at most 32 numeric features; the active capability panel is authoritative.

Run `npm --prefix runtime run test:prediction-ui` with local model assets to check
the Dataset-first flow, real predictions, SQL limits, alternate targets, quartiles,
truth gaps, chart tooltip, CSV, failed-query preservation and configuration restoration.
Set `TABLOOM_CHROMIUM` if necessary; `TABLOOM_CAPTURE=1` also saves desktop/mobile screenshots.
Reports are in `artifacts/workbench/prediction-ui/`.
The official fixture `flow` suite separately checks numerical parity with its
Python-fitted preprocessing state; arbitrary SQL inputs fit their own state.

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
npm run typecheck:app
npm run build:app
npm run dev:app
npm run fixtures:workbench:check -- --allow-missing-reference
npm run test:workbench -- --suite data
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

Phase 1 also ships a fixed offline fixture at `tests/fixtures/workbench/v1`: 256
training rows, 32 prediction rows, four ordered numeric features,
CSV/Parquet/Arrow/JSON/DuckDB copies, eight boundary cases, SQL examples and
independent scalar statistics. The browser workbench is served on port 4176 and
loads that committed file rather than generating rows in the page.
`fixtures:workbench` is a maintainer-only generator; it requires the locked
Python tool environment and an explicit authorized TabPFN checkpoint for the
official reference. Browser users do not need Python. The current acceptance
run uses the checked TabPFN 3.5 reference and records all four WASM/WebGPU ×
FP32/FP16-storage flows under `artifacts/workbench/acceptance/`; an environment
without the reference/model asset must still report model suites as `not-run`.
