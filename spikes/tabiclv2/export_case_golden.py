#!/usr/bin/env python3
"""Export an artifact-bound TabICL Case golden (never a dynamic training API)."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import importlib.metadata
from pathlib import Path


def digest_file(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--fp32-model", type=Path, required=True)
    parser.add_argument("--fp16-model", type=Path, required=True)
    parser.add_argument("--fp32-max-abs-error", type=float, required=True,
                        help="Predeclared error budget in original target units")
    parser.add_argument("--fp16-max-abs-error", type=float, required=True,
                        help="Predeclared error budget in original target units")
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cuda",
                        help="Reference fitting device; CUDA is the release baseline, CPU is an explicit reproducibility fallback")
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/tabiclv2/case-golden"))
    parser.add_argument("--seed", type=int, default=20260916)
    args = parser.parse_args()
    for path in (args.model_path, args.fp32_model, args.fp16_model):
        if not path.is_file():
            parser.error(f"checkpoint/model not found: {path}; no golden generated")
    for budget in (args.fp32_max_abs_error, args.fp16_max_abs_error):
        if not math.isfinite(budget) or budget <= 0:
            parser.error("budgets must be positive finite values in original target units")
    if (args.output_dir / "manifest.json").exists():
        parser.error("manifest already exists; use a fresh directory to preserve frozen budgets")

    # Validate CLI and files before importing optional heavyweight dependencies.
    import numpy as np
    import onnx
    import onnxruntime as ort
    import torch
    from tabicl import TabICLRegressor
    from validate_gpu import make_fixture

    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the default official TabICL export; use --device cpu only for an explicit CPU reference")
    if importlib.metadata.version("tabicl") != "2.2.0":
        raise RuntimeError("This exporter requires tabicl==2.2.0")
    torch.manual_seed(args.seed)
    if args.device == "cuda":
        torch.cuda.manual_seed_all(args.seed)
    x_train, x_test, y_train, y_test = make_fixture(args.seed)
    estimator = TabICLRegressor(
        n_estimators=1, norm_methods=["none"], feat_shuffle_method="none",
        batch_size=1, kv_cache=True, model_path=args.model_path,
        allow_auto_download=False, device=args.device, use_amp=False,
        use_fa3=False, offload_mode=False, random_state=args.seed,
    )
    estimator.fit(x_train, y_train)
    target_mean = float(estimator.y_scaler_.mean_[0])
    target_scale = float(estimator.y_scaler_.scale_[0])
    arrays = {"x_train": x_train, "y_train": y_train, "y_test": y_test}
    scenarios = []
    changed = x_test.copy()
    changed[:, 0] += 1
    for name, raw in (("baseline", x_test), ("changed", changed)):
        encoded = estimator.X_encoder_.transform(raw)
        views = estimator.ensemble_generator_.transform(encoded, mode="test")
        if len(views) != 1:
            raise RuntimeError("Case profile requires one estimator")
        method, (model_input,) = next(iter(views.items()))
        if method != "none" or model_input.shape != (1, *raw.shape):
            raise RuntimeError("Case profile requires one fixed numerical model view")
        expected = np.asarray(estimator.predict(raw, output_type="mean"), dtype="<f4")
        if expected.shape != (len(raw),) or not np.isfinite(expected).all():
            raise RuntimeError("Official estimator returned invalid predictions")
        arrays.update({f"{name}_raw": raw, f"{name}_model_input": model_input,
                       f"{name}_mean": expected})
        scenarios.append({"id": name, "rawInput": f"{name}_raw",
                          "modelInput": f"{name}_model_input", "officialMean": f"{name}_mean"})
    pipeline = estimator.ensemble_generator_.preprocessors_["none"]
    scaler = pipeline.standard_scaler_
    outlier = pipeline.outlier_remover_
    if scaler is None or outlier is None:
        raise RuntimeError("Official Case preprocessing did not expose fitted scaler/outlier state")
    names = [f"x{i}" for i in range(x_train.shape[1])]
    state = {"profile": "tabicl-case", "seed": args.seed, "featureNames": names,
             "featureTransform": "standardize-clamp-v1", "featurePermutation": list(range(len(names))),
             "featureMeans": np.asarray(scaler.mean_, dtype="<f4").tolist(),
             "featureScales": np.asarray(scaler.scale_, dtype="<f4").tolist(),
             "outlierLowerBounds": np.asarray(outlier.lower_bounds_, dtype="<f4").tolist(),
             "outlierUpperBounds": np.asarray(outlier.upper_bounds_, dtype="<f4").tolist(),
             "normalization": "none", "nEstimators": 1, "missingValues": "reject",
             "infinities": "reject", "targetMean": target_mean, "targetScale": target_scale,
             "trainRows": len(x_train), "targetName": "target"}
    train_digest = hashlib.sha256(x_train.astype("<f4").tobytes() + y_train.astype("<f4").tobytes()).hexdigest()
    variants = {}
    for precision, graph, budget in (
        ("fp32", args.fp32_model, args.fp32_max_abs_error),
        ("fp16-storage-fp32-compute", args.fp16_model, args.fp16_max_abs_error),
    ):
        model = onnx.load(graph, load_external_data=False)
        locations = sorted({entry.value for tensor in model.graph.initializer
                            for entry in tensor.external_data if entry.key == "location"})
        files = [{"path": graph.name, "role": "graph", "bytes": graph.stat().st_size, "sha256": digest_file(graph)}]
        for location in locations:
            path = graph.parent / location
            if Path(location).is_absolute() or ".." in Path(location).parts or not path.is_file():
                raise ValueError(f"Invalid or missing external-data file: {location}")
            files.append({"path": location, "role": "external-data", "bytes": path.stat().st_size, "sha256": digest_file(path)})
        manifest = {"schemaVersion": 1, "modelId": "tabicl-v2", "modelVersion": "2.2.0",
                    "precision": precision, "preprocessingVersion": "tabicl-case-standardize-clamp-v1",
                    "files": files, "inputs": [{"name": "x_test", "dtype": "float32", "minRank": 3, "maxRank": 3}],
                    "providerCompatibility": ["wasm", "webgpu"],
                    "capabilities": {"canBuildContext": False, "canImportContext": True,
                                     "maxModelFeatures": len(names), "trainRows": {"min": len(x_train), "max": len(x_train)},
                                     "predictionRows": {"min": 1, "max": 1024}}}
        artifact_digest = hashlib.sha256(json.dumps(manifest, separators=(",", ":")).encode()).hexdigest()
        manifest["manifestDigest"] = artifact_digest
        # The runtime validates the Case state against the exact artifact
        # manifest.  Keep this binding inside every precision-specific recipe;
        # a single shared state would allow an fp32 snapshot to be paired with
        # the fp16 graph by accident.
        case_state = {**state, "artifactDigest": artifact_digest}
        # Check supplied graphs against the fitted Case, not merely their names.
        session = ort.InferenceSession(str(graph), providers=["CPUExecutionProvider"])
        errors = {}
        for scenario in scenarios:
            raw_mean = session.run(None, {"x_test": np.asarray(arrays[scenario["modelInput"]], dtype=np.float32)})[0]
            actual = raw_mean.reshape(-1) * target_scale + target_mean
            expected = arrays[scenario["officialMean"]]
            if actual.shape != expected.shape or not np.isfinite(actual).all():
                raise RuntimeError(f"{precision}: invalid graph outputs")
            error = float(np.max(np.abs(actual - expected)))
            if error > budget:
                raise RuntimeError(f"{precision}/{scenario['id']}: target-unit error {error} exceeds budget {budget}")
            errors[scenario["id"]] = error
        del session
        variants[precision] = {"artifactManifest": manifest, "maxAbsErrorTargetUnits": budget,
                               "bindingCheck": {"provider": "CPUExecutionProvider", "errors": errors},
                               "embeddedCaseRecipe": {"payload": {"kind": "embedded-artifact", "manifestDigest": artifact_digest},
                                                      "trainingDataSha256": train_digest, "featureNames": names,
                                                      "estimatorState": {"schemaVersion": 1, "values": case_state}}}
    # No outputs are written until both precision checks pass.
    args.output_dir.mkdir(parents=True, exist_ok=True)
    metadata = {}
    for name, value in arrays.items():
        array = np.asarray(value, dtype="<f4")
        path = args.output_dir / f"{name}.f32"
        path.write_bytes(array.tobytes())
        metadata[name] = {"file": path.name, "dtype": "float32", "shape": list(array.shape),
                          "bytes": path.stat().st_size, "sha256": digest_file(path)}
    result = {"schemaVersion": 1, "modelId": "tabicl-v2", "packageVersion": "2.2.0",
              "checkpointSha256": digest_file(args.model_path), "seed": args.seed,
              "trainingDigestEncoding": "row-major little-endian float32 X_train followed by y_train",
              "arrays": metadata, "scenarios": scenarios, "variants": variants}
    (args.output_dir / "manifest.json").write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status": "exported", "manifest": str(args.output_dir / "manifest.json")}))


if __name__ == "__main__":
    main()
