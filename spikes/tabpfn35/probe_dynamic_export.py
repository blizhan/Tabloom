#!/usr/bin/env python3
"""Probe bounded dynamic test-row and feature dimensions for TabPFN 3.5."""

from __future__ import annotations

import argparse
import json
import time
import traceback
from pathlib import Path

import torch
from probe_export import RegressionForward
from tabpfn.model_loading import load_model


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/dynamic-export"),
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda")
    report: dict[str, object] = {
        "model": "tabpfn-3.5",
        "probe": "torch.export-bounded-dynamic-shapes",
        "dynamic_dimensions": {
            "train_rows": "fixed:24",
            "test_rows": "1..64",
            "features": "1..16",
        },
    }

    model, _, _, _ = load_model(
        path=args.model_path,
        estimator_type="regressor",
        cache_trainset_representation=False,
    )
    wrapper = RegressionForward(model.to(device).eval()).to(device).eval()
    y_train = torch.randn(24, device=device)
    x = torch.randn(32, 1, 4, device=device)

    test_rows = torch.export.Dim("test_rows", min=1, max=64)
    features = torch.export.Dim("features", min=1, max=16)
    dynamic_shapes = ({0: test_rows + 24, 2: features}, None)

    started = time.perf_counter()
    try:
        exported = torch.export.export(
            wrapper,
            (x, y_train),
            dynamic_shapes=dynamic_shapes,
            strict=False,
        )
        torch.export.save(exported, args.output_dir / "tabpfn35-dynamic.pt2")
        variants = [(32, 4), (40, 6), (25, 1), (88, 16)]
        comparisons = []
        for total_rows, feature_count in variants:
            variant_x = torch.randn(total_rows, 1, feature_count, device=device)
            with torch.inference_mode():
                expected = wrapper(variant_x, y_train)
                actual = exported.module()(variant_x, y_train)
            comparisons.append(
                {
                    "total_rows": total_rows,
                    "test_rows": total_rows - 24,
                    "features": feature_count,
                    "output_shape": list(actual.shape),
                    "max_abs_delta": float(
                        torch.max(torch.abs(expected - actual)).detach().cpu()
                    ),
                }
            )
        report["torch_export"] = {
            "status": "supported_bounded_dynamic",
            "seconds": time.perf_counter() - started,
            "graph_nodes": len(list(exported.graph.nodes)),
            "comparisons": comparisons,
        }
    except Exception as error:  # noqa: BLE001 - probe result
        report["torch_export"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-16000:],
        }

    (args.output_dir / "dynamic_export_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

