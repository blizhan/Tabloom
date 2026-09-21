# Workbench capability evidence

This matrix records what is implemented and what still needs an environment-specific probe. `unsupported` is not a hidden fallback: the application returns the reason and preserves the existing table. The evidence paths below are the current Phase 1 acceptance outputs.

| Capability | Current state | Evidence/command | Notes |
|---|---|---|---|
| CSV/JSON decode | supported | `npm --prefix runtime test` and `src/workbench/file-codecs.ts` | Explicit null/empty-string and finite-number handling. |
| Parquet/Arrow fixture correctness | supported by native checker | `npm --prefix runtime run fixtures:workbench:check -- --allow-missing-reference` | Browser import/export still requires the DuckDB/Arrow adapter. |
| Read-only SQL | supported | `runtime/src/workbench/query-service.ts`, contract tests | Mutation and external file/network functions are rejected. |
| Data Worker routing | supported | `runtime/tests/contract/workbench-data.test.ts` | Versioned request/reply, cancellation and dispose. |
| DuckDB file open/attach/read/write | open/read constrained; attach/write unsupported | `npm --prefix runtime run test:workbench -- --suite duckdb-file` | Native file validity and unchanged original hash are verified; browser adapter limitations remain explicit. |
| Remote source download | supported boundary implementation | `runtime/src/workbench/remote-source.ts` | 120 s / 64 MiB defaults; caller may inject finite positive limits. |
| TabPFN 3.5 model flow | passed for four provider/precision combinations | `artifacts/workbench/acceptance/flow-*.json` | Real ORT worker, independent reference, 32-row SQL publication; FP32 ≤0.0001 and FP16-storage ≤0.002 MWh. |
| Workbench page model flow | passed | `artifacts/workbench/acceptance/app-flow.json` | Current Chromium click flow publishes 32 rows to the DuckDB result table. |
| WebGPU | NVIDIA hardware passed in declared run; otherwise environment-dependent | `flow-webgpu-*.json`, `responsiveness-webgpu-fp16-storage.json` | Software adapters are not promoted to hardware evidence. |
| Persistent snapshots/experiments | supported with memory fallback | `DataSnapshotStore`, `WorkbenchExperimentStore` | IndexedDB corruption is invalidated; memory fallback is reported. |

## Recovery rules

- A failed source fetch, decode, query or export does not replace an existing table/result.
- A missing or corrupt snapshot enters `needs-data`; re-selection must be checked against the original digest.
- A model suite without an asset/provider is `not-run`, never a passing smoke test; the current asset-backed run is recorded separately from that fallback state.
- Credentials are stripped from persisted experiment parameters and never emitted in export metadata.
