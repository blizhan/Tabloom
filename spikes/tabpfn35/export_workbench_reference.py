#!/usr/bin/env python3
"""Export the official TabPFN 3.5 mean for the workbench v1 fixture.

This is intentionally separate from the browser runtime. It requires an
existing checkpoint and CUDA; it never downloads a model or invents a mean.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import importlib.metadata
import json
from pathlib import Path


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_split(path: Path, *, target: bool) -> tuple[list[list[float]], list[float]]:
    features = ["temperature_c", "wind_speed_ms", "solar_wm2", "hour_utc"]
    x: list[list[float]] = []
    y: list[float] = []
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            x.append([float(row[name]) for name in features])
            if target:
                y.append(float(row["demand_mwh"]))
    return x, y


def update_manifest(root: Path, reference: dict[str, object]) -> None:
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    reference_path = root / "expected" / "tabpfn35-mean.json"
    files = [entry for entry in manifest.get("files", []) if entry.get("path") != "expected/tabpfn35-mean.json"]
    files.append({"path": "expected/tabpfn35-mean.json", "bytes": reference_path.stat().st_size, "sha256": digest(reference_path)})
    manifest["reference"] = reference
    manifest["files"] = sorted(files, key=lambda item: item["path"])
    manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def export(args: argparse.Namespace) -> dict[str, object]:
    if not args.model_path.is_file():
        raise FileNotFoundError(f"Official checkpoint not found: {args.model_path}; no automatic download")
    if importlib.metadata.version("tabpfn") != "9.0.0":
        raise RuntimeError("This exporter requires tabpfn==9.0.0")
    try:
        import numpy as np
        import torch
        from tabpfn import TabPFNRegressor
        from tabpfn.constants import ModelVersion
    except ImportError as exc:
        raise RuntimeError("Official reference requires numpy, torch and tabpfn==9.0.0 in the spike environment") from exc
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for official workbench reference generation")
    train_x, train_y = read_split(args.root / "normal/train.csv", target=True)
    predict_x, _ = read_split(args.root / "normal/predict.csv", target=False)
    estimator = TabPFNRegressor.create_default_for_version(
        ModelVersion.V3_5,
        model_path=args.model_path,
        device="cuda",
        n_estimators=1,
        random_state=args.seed,
        show_progress_bar=False,
        fit_mode="fit_with_cache",
        kv_cache_precision="auto",
        inference_precision=torch.float32,
        inference_config=None,
    )
    estimator.fit(np.asarray(train_x, dtype=np.float32), np.asarray(train_y, dtype=np.float32))
    prediction = np.asarray(estimator.predict(np.asarray(predict_x, dtype=np.float32)), dtype=np.float64)
    if prediction.shape != (len(predict_x),) or not np.isfinite(prediction).all():
        raise RuntimeError("Official TabPFN returned a non-finite or incorrectly shaped mean")
    member = estimator.executor_.ensemble_members[0]

    def portable(value):
        if isinstance(value, (torch.Tensor, np.ndarray)):
            return np.asarray(value).tolist()
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, dict):
            return {str(key): portable(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [portable(item) for item in value]
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        return str(value)

    payload = {
        "schemaVersion": 1,
        "modelId": "tabpfn-3.5",
        "tabpfnVersion": "9.0.0",
        "referencePrecision": "fp32",
        "seed": args.seed,
        "input": {"trainRows": len(train_x), "predictRows": len(predict_x), "features": 4, "trainSha256": digest(args.root / "normal/train.csv"), "predictSha256": digest(args.root / "normal/predict.csv")},
        "checkpointSha256": digest(args.model_path),
        "meanMaxAbsBudget": {"fp32": 1e-4, "fp16-storage": 2e-3},
        "mean": [float(value) for value in prediction.tolist()],
        "preprocessing": {
            "fingerprint": bool(member.config.add_fingerprint_feature),
            "featureShiftDecoder": member.config.feature_shift_decoder,
            "featureShiftCount": int(member.config.feature_shift_count),
            "gpuFittedCache": portable(getattr(member.gpu_preprocessor, "fitted_cache", None)),
            "targetMean": float(estimator.y_train_mean_),
            "targetScale": float(estimator.y_train_std_),
        },
        "provenance": {"torch": torch.__version__, "numpy": np.__version__, "device": torch.cuda.get_device_name(0), "configuration": "single-member official TabPFNRegressor, no target transform"},
    }
    args.root.joinpath("expected").mkdir(parents=True, exist_ok=True)
    output = args.root / "expected/tabpfn35-mean.json"
    output.write_text(json.dumps(payload, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    update_manifest(args.root, {"status": "complete", "file": "expected/tabpfn35-mean.json", "sha256": digest(output), "modelId": "tabpfn-3.5", "checkpointSha256": digest(args.model_path), "referencePrecision": "fp32"})
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--root", type=Path, default=Path("runtime/tests/fixtures/workbench/v1"))
    parser.add_argument("--seed", type=int, default=20260920)
    args = parser.parse_args()
    try:
        print(json.dumps(export(args), indent=2))
        return 0
    except (FileNotFoundError, ImportError, OSError, RuntimeError, TypeError, ValueError) as exc:
        print(f"Workbench reference export failed: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
