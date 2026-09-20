#!/usr/bin/env python3
"""Probe browser-portable TabPFN 3.5 training-context construction.

This isolates the train-side work that produces the explicit v3.5 inference
cache. The wrapper returns only tensors, in the same order as flatten_cache(),
so a successful export can become a browser-side context-builder graph.
"""

from __future__ import annotations

import argparse
import json
import time
import traceback
from pathlib import Path
from typing import Any

import torch
from tabpfn.model_loading import load_model

from probe_kv_cache_export import flatten_cache, install_export_sdpa


class ContextBuilderForward(torch.nn.Module):
    """Build the regression KV context from numerical train rows only."""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model
        if model._icl_bf16:  # noqa: SLF001 - architecture feasibility probe
            raise ValueError("The context-builder probe currently requires fp32 ICL")

    def forward(
        self,
        x_train: torch.Tensor,
        y_train: torch.Tensor,
    ) -> tuple[torch.Tensor, ...]:
        num_train = x_train.shape[0]
        batch_size = x_train.shape[1]

        # Stages 0-2, expressed as one full-table pass. This is numerically the
        # same branch the official forward uses when the table is smaller than
        # its row-chunk threshold, but avoids the Python range()/retry loop that
        # specializes symbolic row counts during export.
        x_grouped, y_col_emb, scaler_stats = self.model._preprocess_and_group(  # noqa: SLF001
            x_train,
            y_train,
            num_train,
            None,
            "regression",
        )
        x_emb = self.model.x_embed(x_grouped)
        if y_col_emb is not None:
            x_emb = x_emb + y_col_emb.unsqueeze(2)
        x_emb, inducing_hidden = self.model.feature_distribution_embedder(
            x_BRiCE=x_emb,
            num_train_rows=num_train,
            cached_hidden=None,
            save_peak_memory_factor=None,
            force_recompute_layer=False,
            return_hidden=True,
        )
        x_BRiClE = self.model.column_aggregator(
            x_BRiCE=x_emb,
            save_peak_memory_factor=None,
            force_recompute_layer=False,
        )
        x_BRiD = x_BRiClE.flatten(-2)

        # Stage 3 train pass. Every input row is a train row, so adding the ICL
        # target embedding to the whole tensor is equivalent to the official
        # slice assignment x[:, :num_train] += y_emb.
        y_icl = self.model._prepare_y(  # noqa: SLF001
            y_train,
            num_train,
            batch_size,
            task_type="regression",
        )
        x_BRiD = x_BRiD + self.model._embed_icl_y(  # noqa: SLF001
            y_icl,
            task_type="regression",
        )

        outputs: list[torch.Tensor] = []
        for block in self.model.icl_blocks:
            x_BRiD, kv_entry = block(
                x_BRiD,
                num_train,
                None,
                return_kv=True,
            )
            assert kv_entry.key is not None and kv_entry.value is not None
            outputs.extend((kv_entry.key, kv_entry.value))

        # flatten_cache() sorts these two names alphabetically: mean, std.
        outputs.extend((scaler_stats["mean"], scaler_stats["std"]))
        outputs.append(scaler_stats["ecdf_buckets"])
        assert inducing_hidden is not None
        outputs.extend(inducing_hidden)
        return tuple(outputs)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/context-build"),
    )
    parser.add_argument("--train-rows", type=int, default=24)
    parser.add_argument("--features", type=int, default=4)
    parser.add_argument("--max-train-rows", type=int, default=1024)
    parser.add_argument("--max-features", type=int, default=32)
    parser.add_argument(
        "--device",
        choices=("auto", "cuda", "cpu"),
        default="auto",
        help="Run the reference/export probe on CUDA when available, otherwise CPU.",
    )
    parser.add_argument("--seed", type=int, default=20260917)
    return parser.parse_args()


def max_abs_delta(left: torch.Tensor, right: torch.Tensor) -> float:
    return float(torch.max(torch.abs(left - right)).detach().cpu())


def compare_tuples(
    expected: tuple[torch.Tensor, ...],
    actual: tuple[torch.Tensor, ...],
) -> dict[str, Any]:
    if len(expected) != len(actual):
        return {
            "tensor_count_match": False,
            "expected_tensor_count": len(expected),
            "actual_tensor_count": len(actual),
        }
    deltas = [max_abs_delta(left, right) for left, right in zip(expected, actual)]
    return {
        "tensor_count_match": True,
        "tensor_count": len(expected),
        "max_abs_delta": max(deltas, default=0.0),
        "mean_of_tensor_max_abs_delta": sum(deltas) / len(deltas),
        "nonzero_tensor_deltas": sum(delta != 0.0 for delta in deltas),
    }


def write_report(output_dir: Path, report: dict[str, Any]) -> None:
    report_path = output_dir / "context_build_export_report.json"
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


def main() -> None:
    args = parse_args()
    if args.device == "cuda" and not torch.cuda.is_available():
        raise RuntimeError("--device=cuda requested but CUDA is not available")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)
    resolved_device = (
        "cuda" if args.device == "auto" and torch.cuda.is_available()
        else "cpu" if args.device == "auto"
        else args.device
    )
    device = torch.device(resolved_device)
    report: dict[str, Any] = {
        "model": "tabpfn-3.5",
        "probe": "training-context-builder-export",
        "input_shape": {
            "train_rows": args.train_rows,
            "features": args.features,
            "batch": 1,
        },
        "environment": {
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "device": str(device),
            "gpu": torch.cuda.get_device_name(0) if device.type == "cuda" else None,
        },
    }

    started = time.perf_counter()
    model, _, _, _ = load_model(
        path=args.model_path,
        estimator_type="regressor",
        cache_trainset_representation=False,
    )
    model = model.to(device).eval().requires_grad_(False)
    report["model_load_seconds"] = time.perf_counter() - started
    install_export_sdpa()

    x_train = torch.randn(args.train_rows, 1, args.features, device=device)
    y_train = torch.randn(args.train_rows, device=device)

    # Official reference cache.
    started = time.perf_counter()
    with torch.inference_mode():
        _, official_cache = model(
            x_train,
            y_train,
            "regression",
            only_return_standard_out=True,
            return_kv_cache=True,
        )
    if device.type == "cuda":
        torch.cuda.synchronize()
    report["official_context_seconds"] = time.perf_counter() - started
    official_tensors, cache_metadata = flatten_cache(official_cache)
    report["official_cache"] = cache_metadata

    wrapper = ContextBuilderForward(model).eval()
    started = time.perf_counter()
    with torch.inference_mode():
        eager_tensors = wrapper(x_train, y_train)
    if device.type == "cuda":
        torch.cuda.synchronize()
    report["wrapper_context_seconds"] = time.perf_counter() - started
    report["wrapper_vs_official"] = compare_tuples(official_tensors, eager_tensors)

    started = time.perf_counter()
    try:
        fixed_export = torch.export.export(
            wrapper,
            (x_train, y_train),
            strict=False,
        )
        fixed_path = args.output_dir / "tabpfn35-context-fixed.pt2"
        torch.export.save(fixed_export, fixed_path)
        with torch.inference_mode():
            fixed_tensors = fixed_export.module()(x_train, y_train)
        report["fixed_export"] = {
            "status": "supported",
            "seconds": time.perf_counter() - started,
            "artifact": fixed_path.name,
            "artifact_bytes": fixed_path.stat().st_size,
            "graph_nodes": len(list(fixed_export.graph.nodes)),
            "vs_official": compare_tuples(official_tensors, fixed_tensors),
        }
    except Exception as error:  # noqa: BLE001 - failure is a probe result
        report["fixed_export"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-16000:],
        }

    started = time.perf_counter()
    try:
        train_rows = torch.export.Dim(
            "train_rows", min=3, max=args.max_train_rows
        )
        features = torch.export.Dim("features", min=1, max=args.max_features)
        dynamic_export = torch.export.export(
            wrapper,
            (x_train, y_train),
            dynamic_shapes=(
                {0: train_rows, 2: features},
                {0: train_rows},
            ),
            strict=False,
        )
        dynamic_path = args.output_dir / "tabpfn35-context-dynamic.pt2"
        torch.export.save(dynamic_export, dynamic_path)
        dynamic_module = dynamic_export.module()
        checks: dict[str, Any] = {}
        variants = [
            (args.train_rows, args.features),
            (8, 2),
            (64, 8),
            (min(256, args.max_train_rows), min(16, args.max_features)),
        ]
        for rows, feature_count in variants:
            if rows > args.max_train_rows or feature_count > args.max_features:
                continue
            x_variant = torch.randn(rows, 1, feature_count, device=device)
            y_variant = torch.randn(rows, device=device)
            with torch.inference_mode():
                expected = wrapper(x_variant, y_variant)
                actual = dynamic_module(x_variant, y_variant)
            checks[f"{rows}x{feature_count}"] = compare_tuples(expected, actual)
        report["dynamic_export"] = {
            "status": "supported",
            "seconds": time.perf_counter() - started,
            "artifact": dynamic_path.name,
            "artifact_bytes": dynamic_path.stat().st_size,
            "graph_nodes": len(list(dynamic_export.graph.nodes)),
            "train_rows_range": [3, args.max_train_rows],
            "features_range": [1, args.max_features],
            "checks": checks,
        }
    except Exception as error:  # noqa: BLE001 - failure is a probe result
        report["dynamic_export"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-16000:],
        }

    report["peak_cuda_memory_bytes"] = (
        int(torch.cuda.max_memory_allocated()) if device.type == "cuda" else None
    )
    write_report(args.output_dir, report)


if __name__ == "__main__":
    main()
