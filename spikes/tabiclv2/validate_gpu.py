#!/usr/bin/env python3
"""Validate the official TabICL v2 regressor and its KV cache on CUDA."""

from __future__ import annotations

import argparse
import importlib.metadata
import json
import platform
import time
from pathlib import Path

import numpy as np
import torch
from sklearn.model_selection import train_test_split
from tabicl import TabICLRegressor


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--model-path",
        type=Path,
        required=True,
        help="Local official TabICL v2 regression checkpoint.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabiclv2"),
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


def cache_tensors(cache: object) -> list[torch.Tensor]:
    tensors: list[torch.Tensor] = []
    if getattr(cache, "row_repr", None) is not None:
        tensors.append(cache.row_repr)
    for name in ("col_cache", "icl_cache"):
        section = getattr(cache, name, None)
        if section is None:
            continue
        for entry in section.kv.values():
            if entry.key is not None:
                tensors.append(entry.key)
            if entry.value is not None:
                tensors.append(entry.value)
    return tensors


def timed_prediction(model: TabICLRegressor, x: np.ndarray) -> tuple[np.ndarray, float]:
    synchronize()
    started = time.perf_counter()
    prediction = np.asarray(model.predict(x, output_type="mean"), dtype=np.float32)
    synchronize()
    return prediction, time.perf_counter() - started


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available; this spike must run on GPU")
    if not args.model_path.is_file():
        raise FileNotFoundError(args.model_path)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    x_train, x_test, y_train, y_test = make_fixture(args.seed)

    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    torch.cuda.reset_peak_memory_stats()

    model = TabICLRegressor(
        n_estimators=1,
        norm_methods=["none"],
        feat_shuffle_method="none",
        batch_size=1,
        kv_cache=True,
        model_path=args.model_path,
        allow_auto_download=False,
        device="cuda",
        use_amp=False,
        use_fa3=False,
        offload_mode=False,
        random_state=args.seed,
    )

    started = time.perf_counter()
    model.fit(x_train, y_train)
    synchronize()
    fit_seconds = time.perf_counter() - started

    prediction, first_predict_seconds = timed_prediction(model, x_test)
    warm_prediction, warm_predict_seconds = timed_prediction(model, x_test)

    scenario_x = x_test.copy()
    scenario_x[:, 0] += 1.0
    scenario_prediction, scenario_predict_seconds = timed_prediction(model, scenario_x)
    scenario_repeat, scenario_repeat_seconds = timed_prediction(model, scenario_x)

    # Prove the estimator output is exactly the official raw cache path plus
    # the estimator's inverse target transform for this single-member setup.
    x_encoded = model.X_encoder_.transform(x_test)
    test_data = model.ensemble_generator_.transform(x_encoded, mode="test")
    norm_method, (x_views,) = next(iter(test_data.items()))
    cache = model.model_kv_cache_[norm_method]
    x_tensor = torch.from_numpy(x_views).float().to(model.device_)
    with torch.no_grad():
        raw_scaled = model.model_.predict_stats_with_cache(
            X_test=x_tensor,
            output_type="mean",
            cache=cache,
            inference_config=model.inference_config_,
        )
    raw_scaled_np = raw_scaled.float().cpu().numpy()
    raw_prediction = model.y_scaler_.inverse_transform(raw_scaled_np.reshape(-1, 1)).reshape(raw_scaled_np.shape)[0]

    tensors = cache_tensors(cache)
    cache_bytes = sum(t.numel() * t.element_size() for t in tensors)
    cache_devices = sorted({str(t.device) for t in tensors})
    cache_dtypes = sorted({str(t.dtype) for t in tensors})

    if not np.isfinite(prediction).all():
        raise RuntimeError("TabICL returned non-finite predictions")

    report = {
        "model": "tabicl-regressor-v2-20260212",
        "package_version": importlib.metadata.version("tabicl"),
        "task": "regression",
        "seed": args.seed,
        "dataset": {
            "train_rows": int(x_train.shape[0]),
            "test_rows": int(x_test.shape[0]),
            "features": int(x_train.shape[1]),
        },
        "configuration": {
            "n_estimators": 1,
            "norm_methods": ["none"],
            "feat_shuffle_method": "none",
            "cache_mode": model.cache_mode_,
            "use_amp": False,
            "use_fa3": False,
            "offload_mode": False,
        },
        "environment": {
            "python": platform.python_version(),
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
            "compute_capability": list(torch.cuda.get_device_capability(0)),
        },
        "timings_seconds": {
            "fit_and_build_cache": fit_seconds,
            "first_predict": first_predict_seconds,
            "warm_predict": warm_predict_seconds,
            "scenario_predict": scenario_predict_seconds,
            "scenario_repeat": scenario_repeat_seconds,
        },
        "peak_cuda_memory_bytes": int(torch.cuda.max_memory_allocated()),
        "cache": {
            "type": cache.cache_type,
            "tensor_count": len(tensors),
            "bytes": cache_bytes,
            "devices": cache_devices,
            "dtypes": cache_dtypes,
            "train_shape": list(cache.train_shape),
            "col_layers": len(cache.col_cache.kv),
            "icl_layers": len(cache.icl_cache.kv),
            "has_row_repr": cache.row_repr is not None,
        },
        "fixture_rmse": float(np.sqrt(np.mean((prediction - y_test) ** 2))),
        "repeat_prediction_max_abs_delta": float(np.max(np.abs(prediction - warm_prediction))),
        "raw_cache_path_max_abs_delta": float(np.max(np.abs(prediction - raw_prediction))),
        "scenario": {
            "feature": 0,
            "delta": 1.0,
            "prediction_max_abs_change": float(np.max(np.abs(prediction - scenario_prediction))),
            "repeat_max_abs_delta": float(np.max(np.abs(scenario_prediction - scenario_repeat))),
        },
        "prediction_head": prediction[:8].tolist(),
    }

    np.savez(
        args.output_dir / "reference_fixture.npz",
        x_train=x_train,
        y_train=y_train,
        x_test=x_test,
        y_test=y_test,
        prediction=prediction,
        scenario_x=scenario_x,
        scenario_prediction=scenario_prediction,
        transformed_x_test=x_views,
        raw_scaled_prediction=raw_scaled_np,
    )
    (args.output_dir / "gpu_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
