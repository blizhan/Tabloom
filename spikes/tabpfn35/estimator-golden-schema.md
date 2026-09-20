# Official estimator golden schema v2

Generated output stays under ignored `artifacts/`; an absent export is not a
passing test. The current exporter is restricted to the official single-member,
numerical `none` preprocessing profile with no target transform.

`manifest.json` contains `schemaVersion: 2`, model/package identity, SHA-256 of
the actual checkpoint, environment, scenario records, observed default infinity
rejection, and final-mean acceptance budgets (FP32 `1e-4`, FP16 storage `2e-3`).
These budgets are intended comparison thresholds, not claimed measured errors.
The reference estimator always computes FP32. FP16-storage validation runs the
candidate artifact against the same official means and records its own digest.

Each scenario record names an NPZ `file`, its `sha256`, a `stateFile` and its
`stateSha256`, plus dtype and shape for every array. Consumers must validate both
checksums and reject unsupported schema versions before using any expected value.
NPZ is numeric-only and must be read with `allow_pickle=False`.

| Array | Meaning |
| --- | --- |
| x_train, x_test, y_train | Original fixture values, preserving NaN/Inf |
| x_train_model, x_test_model | Official fitted preprocessing outputs, including batch axis |
| y_train_model | Official ensemble member's transformed training targets |
| raw_logits | Raw official executor output before estimator decoding |
| logits | Official estimator's final distribution logits |
| mean | Complete predictions in original target units |
| standard_borders, raw_borders | Official normalized and target-space decoder borders |

State JSON contains seed, per-step class and available fingerprint salt
`n_cells_`, fitted permutation `index_permutation_`, shuffle configuration/RNG,
GPU fitted caches, selected feature indices, fingerprint flag, target mean and
scale, temperature and aggregation mode. It never serializes executable Python
objects. Unknown state types, non-finite JSON state and unsupported preprocessing
profiles fail closed. These are reference diagnostics, not a promise that the
browser adapter currently reconstructs every official step.

No browser-consumable full golden fixture or per-stage numerical budget is
considered validated until this export succeeds and the actual preprocessing,
decoder and end-to-end comparisons run. In particular, raw-logit discrepancies
must not be compared against or substituted for final-mean acceptance budgets.
