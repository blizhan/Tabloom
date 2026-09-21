# Tabloom

Browser-native tabular machine learning powered by DuckDB-WASM and tabular
foundation models.

- [Project roadmap](roadmap.md)
- [Original product plan](plan.md)
- [TabPFN 3.5 technical validation](spikes/tabpfn35/RESULTS.md)
- [TabICL v2 technical validation](spikes/tabiclv2/RESULTS.md)
- [Browser model compression results](spikes/COMPRESSION_RESULTS.md)
- [Phase 1 workbench specification](specs/002-phase1-workbench/spec.md)
- [Phase 1 acceptance ledger](specs/002-phase1-workbench/acceptance.md)

The repository includes an offline v1 workbench fixture under
`runtime/tests/fixtures/workbench/v1`. Validate it with
`npm --prefix runtime run fixtures:workbench:check -- --allow-missing-reference`;
the command checks all five formats, hashes, the 256/32 split and eight boundary
cases without loading a model. The standalone workbench runs on port 4176 via
`npm --prefix runtime run dev:app`; the existing validation harness remains on
port 4175. Model/reference generation is a maintainer operation and never uses
the browser's output as expected data.
