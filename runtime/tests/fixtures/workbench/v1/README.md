# Tabloom Workbench v1 fixture

Deterministic synthetic hourly demand fixture for offline tests. It contains 256 historical training rows, 32 forecast rows, four ordered numeric features, five equivalent input formats, explicit boundary cases (`cases.json`), and no model weights.

Run `npm --prefix runtime run fixtures:workbench:check` (or the locked `uv` tool directly) before using it. The target is synthetic and has no real business meaning. `truth/predict-targets.csv` is reference-only and must not be imported into the normal prediction table.

The official TabPFN reference is generated separately by `spikes/tabpfn35/export_workbench_reference.py`; missing model/CUDA prerequisites are errors, never replaced with browser output.
