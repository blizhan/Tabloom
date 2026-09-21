# Phase 1 acceptance ledger

本账本只引用已经落盘的代码、命令和浏览器报告。最近一次完整报告时间为
`2026-09-20T06:11:38Z`，汇总位于
`artifacts/workbench/acceptance/summary.json`。

## 总体结论

- 数据包、来源、持久化、构建资产、可访问性和数据 bootstrap 均为 `passed`。
- TabPFN 3.5 官方 checkpoint 已取得，四种真实浏览器 flow 均为 `passed`；没有使用 JS/fake adapter 生成 expected。
- `model-cache --provider wasm --precision fp16-storage` 和
  `responsiveness --provider webgpu --precision fp16-storage` 均为 `passed`。
- DuckDB 文件 probe 按规格保留逐项结论：`open/read = constrained`，`attach/write = unsupported`；原始文件 hash 未变化。这不是默认内存预测流程的失败。
- 当前 `runtime/app` 已提供数据导入、查询、来源、保存/恢复和能力/状态 UI；`app-flow.json` 进一步证明页面点击“运行真实预测”后会经 Worker/RuntimeCoordinator 发布 32 行 DuckDB SQL 结果表。

## Functional requirements

| Requirement | Evidence | Status |
|---|---|---|
| FR-001 / SC-001 | `runtime/tests/browser/workbench-flow.ts`、`flow-*.json`、`flow-data.json`、`app-flow.json`；`runtime/app/` | `passed` |
| FR-002 | `runtime/tests/browser/workbench-sources.ts`、`sources.json` | `passed` |
| FR-003 / SC-007 | `duckdb-file.json`、`runtime/docs/workbench-capabilities.md` | `passed` with constrained/unsupported per operation |
| FR-004 | `workbench-bootstrap.ts`、`bootstrap.json`、catalog/query services | `passed` |
| FR-005 | query/input materialization contracts and `bootstrap.json` | `passed` |
| FR-006 / SC-004 | four `flow-<provider>-<precision>.json` reports; real ORT worker | `passed` |
| FR-007 | `ResultPublicationService`, `RuntimeCoordinator`, publication contract, flow SQL table evidence | `passed` |
| FR-008 / SC-002 | `workbench-export.ts` and `flow-data.json` | `passed` |
| FR-009 / SC-005 | `responsiveness-webgpu-fp16-storage.json` and `responsiveness.json` | `passed` |
| FR-010 / SC-006 | `persistence-data.json` and `model-cache-wasm-fp16-storage.json` | `passed` |
| FR-011 | versioned errors, source failures, capability/recovery docs | `passed` |
| FR-012 / SC-003 | `runtime/tests/fixtures/workbench/v1/manifest.json` and fixture checker | `passed`: 1,133,044 bytes; 256/32/4; eight boundary cases |
| FR-013 | five-format fixture check, source equivalence, export round-trip | `passed` |
| FR-014 | `cases.json`, fixture contract tests and `flow-data.json` | `passed` |
| FR-015 | `expected/tabpfn35-mean.json`, reference provenance and flow checks | `passed` |
| FR-016 | fixture README, SQL examples, cases index and quickstart | `passed` |

## Independent model reference and four real flows

Reference identity:

- checkpoint: `.cache/models/tabpfn-v3.5-20260909.safetensors`
- checkpoint SHA-256: `ece4d67eadfea42eb0e610df5189bea60cb7f31073d81e9c7a019b76eacf0be3`
- reference SHA-256: `63a5940b823742dc3e85f144f427418b568c0fffce22af11b9d89823e56664ad`
- reference estimator: TabPFN 3.5 / tabpfn `9.0.0`
- reference device: NVIDIA GB10
- input: 256 training rows, 32 prediction rows, 4 user features; prediction input has no target column

| Flow | Actual provider | Precision | Max absolute error | Budget | Hardware evidence | Result |
|---|---|---|---:|---:|---|---|
| `flow-wasm-fp32.json` | WASM / ORT | FP32 | `0.000072479248046875` | `0.0001` | WASM path | passed |
| `flow-webgpu-fp32.json` | WebGPU / ORT | FP32 | `0.0000743865966796875` | `0.0001` | NVIDIA, non-fallback adapter | passed |
| `flow-wasm-fp16-storage.json` | WASM / ORT | FP16-storage | `0.0004863739013671875` | `0.002` | WASM path | passed |
| `flow-webgpu-fp16-storage.json` | WebGPU / ORT | FP16-storage | `0.000484466552734375` | `0.002` | NVIDIA, non-fallback adapter | passed |

Every flow also records finite means, valid train/predict time split and feature availability,
32 distinct ordinals, zero reordered-input error, and a prediction table independently
queryable as SQL (`workbench_predictions`).

## Cache, responsiveness and source evidence

- `model-cache-wasm-fp16-storage.json`: worker restarted, application cache hit, zero warm model fetches, restored context, finite independent mean.
- `responsiveness-webgpu-fp16-storage.json`: loading/query/predict each has 10 feedback samples; all feedback samples are below 1 second. The approximately 12-second real prediction operation is recorded separately from event-loop feedback and is not presented as interaction latency.
- `sources.json`: local CSV/JSON/Arrow/Parquet logical digests match; controlled remote CSV/JSON, exact byte limit, over-limit, 403, expired, truncation, timeout, cancellation and CORS cases pass with failure isolation.
- `persistence-data.json`: IndexedDB snapshot/experiment restart, digest verification, explicit refresh versioning, reference protection, corruption rejection and zero content downloads pass.
- `built-assets.json`: root and `/tabloom/` base builds, COOP/COEP, DuckDB/ORT, both FP32/FP16 model assets and MIME/fallback checks pass.
- `accessibility.json`: keyboard order, focused field error, 200-row preview pagination and live status checks pass.
- `app-flow.json`: current Chromium/X11 page click flow loads train + predict fixtures, runs real ORT through the app, selects `predictions`, and shows `32 rows` with a completed publish status.

## DuckDB file capability evidence

`duckdb-file.json` verifies the native DuckDB copy and unchanged SHA-256
`d362543cf62432e546452c692e3344777b6a770426a9a8a094568ddbd11095f4` before/after the probe.

| Operation | Conclusion | Reason |
|---|---|---|
| open | constrained | native copy is valid; browser adapter-specific probe is not available in this runner |
| read | constrained | native read is verified; browser adapter read remains dependent on the selected adapter |
| attach | unsupported | no verified browser adapter path |
| write | unsupported | committed source file is treated as read-only; product never writes it in place |

## Reproduction

```bash
npm --prefix runtime run typecheck
npm --prefix runtime run typecheck:test
npm --prefix runtime run typecheck:app
npm --prefix runtime test
npm --prefix runtime run fixtures:workbench:check
git diff --check
```

The browser reports can be reproduced with the authorized Chromium/X11 environment:

```bash
export TABLOOM_CHROMIUM=/snap/chromium/current/usr/lib/chromium-browser/chrome
export TABLOOM_HEADLESS=0
export TABLOOM_DISPLAY=:0

npm --prefix runtime run test:workbench -- --suite data
npm --prefix runtime run test:workbench -- --suite sources
npm --prefix runtime run test:workbench -- --suite persistence
npm --prefix runtime run test:workbench -- --suite built-assets
npm --prefix runtime run test:workbench -- --suite accessibility
npm --prefix runtime run test:workbench -- --suite app-flow
npm --prefix runtime run test:workbench -- --suite flow --provider wasm --precision fp32
npm --prefix runtime run test:workbench -- --suite flow --provider webgpu --precision fp32
npm --prefix runtime run test:workbench -- --suite flow --provider wasm --precision fp16-storage
npm --prefix runtime run test:workbench -- --suite flow --provider webgpu --precision fp16-storage
npm --prefix runtime run test:workbench -- --suite model-cache --provider wasm --precision fp16-storage
npm --prefix runtime run test:workbench -- --suite responsiveness --provider webgpu --precision fp16-storage
```

The task list is only checked for implementation and acceptance evidence that exists in
these reports. The app-level click flow is now part of the reproducible acceptance set.
