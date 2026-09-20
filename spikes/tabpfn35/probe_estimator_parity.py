#!/usr/bin/env python3
"""Validate the browser ONNX chain against TabPFNRegressor.predict()."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import torch
from tabpfn import TabPFNRegressor
from tabpfn.base import resolved_softmax_temperature
from tabpfn.constants import ModelVersion
from tabpfn.inference import _maybe_run_gpu_preprocessing
from tabpfn.preprocessing.clean import clean_data_transform
from tabpfn.preprocessing.datamodel import FeatureModality
from tabpfn.regressor import _logits_to_output
from tabpfn.utils import transform_borders_one, translate_probs_across_borders
from tabpfn.validation import ensure_compatible_predict_input_sklearn

from probe_kv_cache_export import flatten_cache
from validate_gpu import make_fixture


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument(
        "--context-model",
        type=Path,
        default=Path(
            "artifacts/tabpfn35/context-build/onnx/tabpfn35-context-dynamic.onnx"
        ),
    )
    parser.add_argument(
        "--prediction-model",
        type=Path,
        default=Path(
            "artifacts/tabpfn35/dynamic-context-predict/onnx/tabpfn35-kv-dynamic.onnx"
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/estimator-parity"),
    )
    parser.add_argument("--seed", type=int, default=20260916)
    return parser.parse_args()


def make_missing_fixture(
    seed: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    x_train, x_test, y_train, y_test = make_fixture(seed)
    x_train = x_train.copy()
    x_test = x_test.copy()
    x_train[::17, 1] = np.nan
    x_test[::5, 2] = np.nan
    x_train[::29, 4] = np.nan
    x_test[1::9, 6] = np.nan
    return x_train, x_test, y_train, y_test


def make_inf_fixture(
    seed: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    x_train, x_test, y_train, y_test = make_fixture(seed)
    x_train = x_train.copy()
    x_test = x_test.copy()
    x_train[::29, 4] = np.inf
    x_test[1::9, 6] = -np.inf
    return x_train, x_test, y_train, y_test


def max_abs(left: np.ndarray, right: np.ndarray) -> float:
    return float(np.max(np.abs(left - right)))


def compare_log_probs(left: torch.Tensor, right: torch.Tensor) -> dict[str, float]:
    finite = torch.isfinite(left) & torch.isfinite(right)
    if finite.any():
        finite_delta = float(torch.max(torch.abs(left[finite] - right[finite])).cpu())
    else:
        finite_delta = 0.0
    prob_delta = float(
        torch.max(
            torch.abs(torch.softmax(left, dim=-1) - torch.softmax(right, dim=-1))
        ).cpu()
    )
    return {
        "finite_logit_max_abs_delta": finite_delta,
        "probability_max_abs_delta": prob_delta,
    }


def run_scenario(
    *,
    name: str,
    fixture: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
    model_path: Path,
    seed: int,
    context_session: ort.InferenceSession,
    prediction_session: ort.InferenceSession,
    passthrough_inf: bool = False,
) -> dict[str, Any]:
    x_train, x_test, y_train, _y_test = fixture
    estimator = TabPFNRegressor.create_default_for_version(
        ModelVersion.V3_5,
        model_path=model_path,
        device="cuda",
        n_estimators=1,
        random_state=seed,
        show_progress_bar=False,
        fit_mode="fit_with_cache",
        kv_cache_precision="auto",
        inference_precision=torch.float32,
        inference_config=(
            {"PASSTHROUGH_INF": True} if passthrough_inf else None
        ),
    )
    estimator.fit(x_train, y_train)
    official = estimator.predict(x_test, output_type="full")

    x = estimator.date_transformer_.transform(x_test)
    x = estimator.text_transformer_.transform(x)
    x = ensure_compatible_predict_input_sklearn(x, estimator)
    cat_indices = estimator.inferred_feature_schema_.indices_for(
        FeatureModality.CATEGORICAL
    )
    x = clean_data_transform(
        x,
        cat_indices=cat_indices,
        ord_encoder=getattr(estimator, "ordinal_encoder_", None),
        passthrough_inf=estimator.get_inference_config().PASSTHROUGH_INF,
    )

    member = estimator.executor_.ensemble_members[0]
    x_test_member = member.transform_X_test(x)
    x_train_tensor = torch.as_tensor(
        member.X_train, dtype=torch.float32, device="cuda"
    ).unsqueeze(1)
    x_test_tensor = torch.as_tensor(
        x_test_member, dtype=torch.float32, device="cuda"
    ).unsqueeze(1)
    x_train_model, train_schema = _maybe_run_gpu_preprocessing(
        x_train_tensor,
        member.gpu_preprocessor,
        member.feature_schema,
        num_train_rows=x_train_tensor.shape[0],
        use_fitted_cache=True,
    )
    x_test_model, test_schema = _maybe_run_gpu_preprocessing(
        x_test_tensor,
        member.gpu_preprocessor,
        member.feature_schema,
        num_train_rows=0,
        use_fitted_cache=True,
    )

    cache_names = [f"cache_{index:02d}" for index in range(54)]
    cache_arrays = context_session.run(
        cache_names,
        {
            "x_train": x_train_model.detach().cpu().numpy(),
            "y_train": np.asarray(member.y_train, dtype=np.float32),
        },
    )
    executor_cache_tensors, _ = flatten_cache(estimator.executor_.kv_caches[0])
    context_delta = max(
        max_abs(array, tensor.detach().cpu().numpy())
        for array, tensor in zip(cache_arrays, executor_cache_tensors, strict=True)
    )

    raw_onnx = prediction_session.run(
        ["logits"],
        {
            "x_test": x_test_model.detach().cpu().numpy(),
            **dict(zip(cache_names, cache_arrays, strict=True)),
        },
    )[0][:, 0, :]
    raw_executor, config = next(
        estimator.executor_.iter_outputs(
            x, autocast=estimator.use_autocast_, task_type="regression"
        )
    )
    raw_executor_np = raw_executor.detach().cpu().numpy()

    raw = torch.from_numpy(raw_onnx).to(estimator.znorm_space_bardist_.borders.device)
    temperature = resolved_softmax_temperature(estimator)
    if temperature != 1:
        raw = raw / temperature
    standard_borders = estimator.znorm_space_bardist_.borders.detach().cpu().numpy()
    if config.target_transform is None:
        borders = standard_borders.copy()
        cancel_mask = None
    else:
        cancel_mask, descending, borders = transform_borders_one(
            standard_borders,
            target_transform=config.target_transform,
            repair_nan_borders_after_transform=(
                estimator.inference_config_.FIX_NAN_BORDERS_AFTER_TARGET_TRANSFORM
            ),
        )
        if descending:
            borders = borders.flip(-1)
    if cancel_mask is not None:
        raw = raw.clone()
        raw[..., cancel_mask] = float("-inf")
    transformed = translate_probs_across_borders(
        raw,
        frm=torch.as_tensor(borders, device=raw.device),
        to=estimator.znorm_space_bardist_.borders.to(raw.device),
    )
    if estimator.average_before_softmax:
        transformed = transformed.log()
    browser_logits = estimator._reduce_accumulated_logits(transformed, 1)
    browser_mean = np.asarray(
        _logits_to_output(
            logits=browser_logits,
            criterion=estimator.raw_space_bardist_,
            quantiles=[0.1],
            output_type="mean",
        )
    )
    official_mean = np.asarray(official["mean"])
    official_logits = official["logits"]

    return {
        "scenario": name,
        "input_shape": {
            "train_rows": int(x_train.shape[0]),
            "test_rows": int(x_test.shape[0]),
            "raw_features": int(x_train.shape[1]),
            "model_features": int(x_train_model.shape[2]),
        },
        "config": {
            "preprocess": member.config.preprocess_config.name,
            "target_transform": (
                None
                if member.config.target_transform is None
                else type(member.config.target_transform).__name__
            ),
            "add_fingerprint_feature": bool(member.config.add_fingerprint_feature),
            "feature_shift_decoder": member.config.feature_shift_decoder,
            "feature_shift_count": int(member.config.feature_shift_count),
            "passthrough_inf": bool(
                estimator.get_inference_config().PASSTHROUGH_INF
            ),
        },
        "categorical_indices_after_gpu_preprocessing": train_schema.indices_for(
            FeatureModality.CATEGORICAL
        ),
        "test_schema_matches_train": test_schema == train_schema,
        "context_vs_executor_cache_max_abs_delta": context_delta,
        "raw_logits_vs_executor_max_abs_delta": max_abs(raw_onnx, raw_executor_np),
        "final_distribution": compare_log_probs(browser_logits, official_logits),
        "mean_vs_predict_max_abs_delta": max_abs(browser_mean, official_mean),
        "browser_mean_head": browser_mean[:5].tolist(),
        "official_mean_head": official_mean[:5].tolist(),
    }


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for estimator-parity validation")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    context_session = ort.InferenceSession(
        str(args.context_model), providers=["CPUExecutionProvider"]
    )
    prediction_session = ort.InferenceSession(
        str(args.prediction_model), providers=["CPUExecutionProvider"]
    )

    scenarios = [
        run_scenario(
            name="numerical",
            fixture=make_fixture(args.seed),
            model_path=args.model_path,
            seed=args.seed,
            context_session=context_session,
            prediction_session=prediction_session,
        ),
        run_scenario(
            name="missing-nan",
            fixture=make_missing_fixture(args.seed + 1),
            model_path=args.model_path,
            seed=args.seed + 1,
            context_session=context_session,
            prediction_session=prediction_session,
        ),
        run_scenario(
            name="passthrough-inf",
            fixture=make_inf_fixture(args.seed + 2),
            model_path=args.model_path,
            seed=args.seed + 2,
            context_session=context_session,
            prediction_session=prediction_session,
            passthrough_inf=True,
        ),
    ]
    report = {
        "model": "tabpfn-3.5",
        "probe": "high-level-estimator-to-browser-onnx-parity",
        "configuration": {
            "n_estimators": 1,
            "fit_mode": "fit_with_cache",
            "kv_cache_precision": "auto",
            "inference_precision": "float32",
        },
        "environment": {
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
            "onnxruntime": ort.__version__,
        },
        "scenarios": scenarios,
    }
    report_path = args.output_dir / "estimator_parity_report.json"
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
