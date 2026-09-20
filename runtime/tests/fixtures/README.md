# Runtime fixtures

The checked-in manifests are schema examples only. Real ONNX graphs, external
weight blobs, full estimator goldens and TabICL Case snapshots stay under the
ignored `artifacts/` directory and are verified by `npm run fixtures:prepare`.
The fixture preparer intentionally fails when those assets are absent; an
unavailable browser/model suite is not reported as a passing skip.
