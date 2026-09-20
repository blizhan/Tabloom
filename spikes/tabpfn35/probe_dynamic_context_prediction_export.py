#!/usr/bin/env python3
"""Probe one TabPFN 3.5 prediction graph across dynamic context shapes."""

from __future__ import annotations

import argparse
import json
import time
import traceback
from pathlib import Path
from typing import Any

import torch
from tabpfn.architectures.tabpfn_v3_5 import TabPFNV3p5Cache
from tabpfn.model_loading import load_model

from probe_kv_cache_export import (
    CachedRegressionForward,
    flatten_cache,
    install_export_sdpa,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/dynamic-context-predict"),
    )
    parser.add_argument("--max-train-rows", type=int, default=1024)
    parser.add_argument("--max-test-rows", type=int, default=1024)
    parser.add_argument("--max-features", type=int, default=32)
    parser.add_argument(
        "--device", choices=("auto", "cuda", "cpu"), default="auto"
    )
    parser.add_argument("--seed", type=int, default=20260917)
    return parser.parse_args()


def max_abs_delta(left: torch.Tensor, right: torch.Tensor) -> float:
    return float(torch.max(torch.abs(left - right)).detach().cpu())


def build_cache(
    model: torch.nn.Module,
    rows: int,
    features: int,
    *,
    device: torch.device,
    generator: torch.Generator,
) -> tuple[tuple[torch.Tensor, ...], dict[str, Any]]:
    x_train = torch.randn(
        rows, 1, features, generator=generator, device=device
    )
    y_train = torch.randn(rows, generator=generator, device=device)
    with torch.inference_mode():
        _, cache = model(
            x_train,
            y_train,
            "regression",
            only_return_standard_out=True,
            return_kv_cache=True,
        )
    assert isinstance(cache, TabPFNV3p5Cache)
    return flatten_cache(cache)


def cache_dynamic_shapes(
    tensor_count: int,
    *,
    train_rows: torch.export.Dim,
    features: torch.export.Dim,
) -> tuple[dict[int, torch.export.Dim] | None, ...]:
    if tensor_count != 54:
        raise ValueError(f"Expected 54 cache tensors, got {tensor_count}")
    specs: list[dict[int, torch.export.Dim] | None] = []
    # 24 ICL layers, key + value. Shape: (1, train_rows, 1, 64).
    specs.extend({1: train_rows} for _ in range(48))
    # scaler mean/std: (1, features).
    specs.extend(({1: features}, {1: features}))
    # ECDF context: (3, 1, features, train_rows) for train_rows <= 8192.
    specs.append({2: features, 3: train_rows})
    # Three inducing-hidden tensors: (features, 128, 128).
    specs.extend({0: features} for _ in range(3))
    return tuple(specs)


def write_report(output_dir: Path, report: dict[str, Any]) -> None:
    (output_dir / "dynamic_context_prediction_export_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


def main() -> None:
    args = parse_args()
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("--device=cuda requested but CUDA is unavailable")
    resolved_device = (
        "cuda" if args.device == "auto" and torch.cuda.is_available()
        else "cpu" if args.device == "auto"
        else args.device
    )
    device = torch.device(resolved_device)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)
    generator = torch.Generator(device=device).manual_seed(args.seed)

    report: dict[str, Any] = {
        "model": "tabpfn-3.5",
        "probe": "dynamic-context-prediction-export",
        "environment": {
            "device": str(device),
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0) if device.type == "cuda" else None,
        },
    }
    model, _, _, _ = load_model(
        path=args.model_path,
        estimator_type="regressor",
        cache_trainset_representation=False,
    )
    model = model.to(device).eval().requires_grad_(False)
    install_export_sdpa()

    base_cache, metadata = build_cache(
        model, 24, 4, device=device, generator=generator
    )
    wrapper = CachedRegressionForward(
        model,
        layer_ids=tuple(metadata["layer_ids"]),
        scaler_names=tuple(metadata["scaler_names"]),
        inducing_count=metadata["inducing_count"],
        train_shape=tuple(metadata["train_shape"]),
    ).eval()
    x_test = torch.randn(8, 1, 4, generator=generator, device=device)

    train_rows = torch.export.Dim("train_rows", min=3, max=args.max_train_rows)
    test_rows = torch.export.Dim("test_rows", min=1, max=args.max_test_rows)
    features = torch.export.Dim("features", min=1, max=args.max_features)
    started = time.perf_counter()
    try:
        exported = torch.export.export(
            wrapper,
            (x_test, base_cache),
            dynamic_shapes=(
                {0: test_rows, 2: features},
                cache_dynamic_shapes(
                    len(base_cache), train_rows=train_rows, features=features
                ),
            ),
            strict=False,
        )
        export_path = args.output_dir / "tabpfn35-predict-dynamic-context.pt2"
        torch.export.save(exported, export_path)
        module = exported.module()
        checks: dict[str, Any] = {}
        for n_train, n_features, n_test in (
            (8, 2, 4),
            (24, 4, 8),
            (64, 8, 16),
            (256, 16, 32),
        ):
            cache_tensors, _ = build_cache(
                model,
                n_train,
                n_features,
                device=device,
                generator=generator,
            )
            scenario = torch.randn(
                n_test, 1, n_features, generator=generator, device=device
            )
            with torch.inference_mode():
                expected = wrapper(scenario, cache_tensors)
                actual = module(scenario, cache_tensors)
            checks[f"train={n_train},features={n_features},test={n_test}"] = {
                "shape": list(actual.shape),
                "finite": bool(torch.isfinite(actual).all().item()),
                "max_abs_delta": max_abs_delta(expected, actual),
            }
        report["torch_export"] = {
            "status": "supported",
            "seconds": time.perf_counter() - started,
            "artifact": export_path.name,
            "artifact_bytes": export_path.stat().st_size,
            "graph_nodes": len(list(exported.graph.nodes)),
            "train_rows_range": [3, args.max_train_rows],
            "test_rows_range": [1, args.max_test_rows],
            "features_range": [1, args.max_features],
            "checks": checks,
        }
    except Exception as error:  # noqa: BLE001 - failure is the probe result
        report["torch_export"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-20000:],
        }

    write_report(args.output_dir, report)


if __name__ == "__main__":
    main()
