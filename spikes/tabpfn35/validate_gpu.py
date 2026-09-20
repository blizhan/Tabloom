#!/usr/bin/env python3
"""Run a deterministic TabPFN 3.5 regression fixture on CUDA.

The generated report is deliberately small and JSON serializable so it can be
compared with later ONNX and browser runs without depending on Python objects.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import time
from pathlib import Path

import numpy as np
import torch
from sklearn.model_selection import train_test_split
from tabpfn import TabPFNRegressor
from tabpfn.constants import ModelVersion


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35"),
    )
    parser.add_argument(
        "--model-path",
        type=Path,
        help="Optional local TabPFN 3.5 checkpoint path.",
    )
    parser.add_argument("--seed", type=int, default=20260916)
    return parser.parse_args()


def make_fixture(seed: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(192, 8)).astype(np.float32)
    y = (
        1.7 * x[:, 0]
        - 0.8 * x[:, 1] ** 2
        + np.sin(2.2 * x[:, 2])
        + 0.35 * x[:, 3] * x[:, 4]
        + rng.normal(scale=0.05, size=len(x))
    ).astype(np.float32)
    return train_test_split(x, y, test_size=32, random_state=seed)


def synchronize() -> None:
    torch.cuda.synchronize()


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available; this spike must run on GPU")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    x_train, x_test, y_train, y_test = make_fixture(args.seed)

    model_kwargs: dict[str, object] = {
        "device": "cuda",
        "n_estimators": 1,
        "random_state": args.seed,
        "show_progress_bar": False,
        "fit_mode": "fit_with_cache",
    }
    if args.model_path is not None:
        model_kwargs["model_path"] = args.model_path

    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    model = TabPFNRegressor.create_default_for_version(
        ModelVersion.V3_5,
        **model_kwargs,
    )
    model.fit(x_train, y_train)
    synchronize()
    fit_seconds = time.perf_counter() - started

    started = time.perf_counter()
    prediction = np.asarray(model.predict(x_test), dtype=np.float32)
    synchronize()
    first_predict_seconds = time.perf_counter() - started

    started = time.perf_counter()
    warm_prediction = np.asarray(model.predict(x_test), dtype=np.float32)
    synchronize()
    warm_predict_seconds = time.perf_counter() - started

    if not np.isfinite(prediction).all():
        raise RuntimeError("TabPFN returned non-finite predictions")
    if not np.array_equal(prediction, warm_prediction):
        max_delta = float(np.max(np.abs(prediction - warm_prediction)))
    else:
        max_delta = 0.0

    rmse = float(np.sqrt(np.mean((prediction - y_test) ** 2)))
    report = {
        "model": "tabpfn-3.5",
        "task": "regression",
        "seed": args.seed,
        "dataset": {
            "train_rows": int(x_train.shape[0]),
            "test_rows": int(x_test.shape[0]),
            "features": int(x_train.shape[1]),
        },
        "environment": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
            "compute_capability": list(torch.cuda.get_device_capability(0)),
            "tabpfn": __import__("tabpfn").__version__,
        },
        "timings_seconds": {
            "fit_with_cache": fit_seconds,
            "first_predict": first_predict_seconds,
            "warm_predict": warm_predict_seconds,
        },
        "peak_cuda_memory_bytes": int(torch.cuda.max_memory_allocated()),
        "fixture_rmse": rmse,
        "repeat_prediction_max_abs_delta": max_delta,
        "prediction_head": prediction[:8].tolist(),
        "cache_locations": {
            "hf_home": os.environ.get("HF_HOME"),
            "skrub": os.environ.get("SKB_DATA_DIRECTORY"),
        },
    }

    np.savez(
        args.output_dir / "reference_fixture.npz",
        x_train=x_train,
        y_train=y_train,
        x_test=x_test,
        y_test=y_test,
        prediction=prediction,
    )
    (args.output_dir / "gpu_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

