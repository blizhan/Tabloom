#!/usr/bin/env python3
"""Validate context-builder ONNX -> prediction ONNX as one dynamic pipeline."""

from __future__ import annotations

import argparse
import json
import time
import traceback
from pathlib import Path
from typing import Any

import numpy as np
import onnxruntime as ort
import torch
from tabpfn.model_loading import load_model


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
        default=Path("artifacts/tabpfn35/context-chain"),
    )
    parser.add_argument("--seed", type=int, default=20260917)
    return parser.parse_args()


def write_report(output_dir: Path, report: dict[str, Any]) -> None:
    (output_dir / "context_chain_onnx_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "model": "tabpfn-3.5",
        "probe": "context-builder-to-prediction-onnx-chain",
        "onnxruntime": ort.__version__,
        "context_model": str(args.context_model),
        "prediction_model": str(args.prediction_model),
    }
    cache_names = [f"cache_{index:02d}" for index in range(54)]

    try:
        started = time.perf_counter()
        context_session = ort.InferenceSession(
            str(args.context_model), providers=["CPUExecutionProvider"]
        )
        prediction_session = ort.InferenceSession(
            str(args.prediction_model), providers=["CPUExecutionProvider"]
        )
        report["session_load_seconds"] = time.perf_counter() - started

        model, _, _, _ = load_model(
            path=args.model_path,
            estimator_type="regressor",
            cache_trainset_representation=False,
        )
        model = model.cpu().eval().requires_grad_(False)
        generator = torch.Generator(device="cpu").manual_seed(args.seed)

        checks: dict[str, Any] = {}
        fixture: dict[str, np.ndarray] = {}
        for n_train, n_features, n_test in (
            (8, 2, 4),
            (24, 4, 8),
            (64, 8, 16),
            (256, 16, 32),
        ):
            scenario = f"{n_train}x{n_features}x{n_test}"
            x_train = torch.randn(
                n_train, 1, n_features, generator=generator, dtype=torch.float32
            )
            y_train = torch.randn(n_train, generator=generator, dtype=torch.float32)
            x_test = torch.randn(
                n_test, 1, n_features, generator=generator, dtype=torch.float32
            )
            with torch.inference_mode():
                reference = model(
                    torch.cat((x_train, x_test), dim=0),
                    y_train,
                    "regression",
                    only_return_standard_out=True,
                ).numpy()

            context_started = time.perf_counter()
            cache_arrays = context_session.run(
                cache_names,
                {"x_train": x_train.numpy(), "y_train": y_train.numpy()},
            )
            context_seconds = time.perf_counter() - context_started
            prediction_started = time.perf_counter()
            actual = prediction_session.run(
                ["logits"],
                {
                    "x_test": x_test.numpy(),
                    **dict(zip(cache_names, cache_arrays, strict=True)),
                },
            )[0]
            prediction_seconds = time.perf_counter() - prediction_started
            delta = np.abs(reference - actual)
            checks[scenario] = {
                "shape": list(actual.shape),
                "finite": bool(np.isfinite(actual).all()),
                "context_seconds": context_seconds,
                "prediction_seconds": prediction_seconds,
                "max_abs_delta": float(np.max(delta)),
                "mean_abs_delta": float(np.mean(delta)),
            }

            fixture[f"x_train_{scenario}"] = x_train.numpy()
            fixture[f"y_train_{scenario}"] = y_train.numpy()
            fixture[f"x_test_{scenario}"] = x_test.numpy()
            fixture[f"output_{scenario}"] = reference

        report["status"] = "supported"
        report["checks"] = checks
        np.savez(args.output_dir / "context_chain_browser_fixture.npz", **fixture)
    except Exception as error:  # noqa: BLE001 - failure is a probe result
        report["status"] = "blocked"
        report["error_type"] = type(error).__name__
        report["error"] = str(error)
        report["traceback_tail"] = traceback.format_exc()[-16000:]

    write_report(args.output_dir, report)


if __name__ == "__main__":
    main()
