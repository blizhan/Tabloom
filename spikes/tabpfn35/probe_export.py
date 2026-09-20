#!/usr/bin/env python3
"""Probe whether the raw TabPFN 3.5 forward pass is torch.export compatible."""

from __future__ import annotations

import argparse
import json
import time
import traceback
from pathlib import Path

import torch
from tabpfn.model_loading import load_model


class RegressionForward(torch.nn.Module):
    """Fix Python-only task options while keeping tensor inputs explicit."""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, x: torch.Tensor, y_train: torch.Tensor) -> torch.Tensor:
        return self.model(
            x,
            y_train,
            "regression",
            only_return_standard_out=True,
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/export"),
    )
    parser.add_argument("--train-rows", type=int, default=24)
    parser.add_argument("--test-rows", type=int, default=8)
    parser.add_argument("--features", type=int, default=4)
    parser.add_argument("--seed", type=int, default=20260916)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for this export probe")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)
    device = torch.device("cuda")
    report: dict[str, object] = {
        "model": "tabpfn-3.5",
        "probe": "torch.export",
        "input_shape": {
            "train_rows": args.train_rows,
            "test_rows": args.test_rows,
            "features": args.features,
            "batch": 1,
        },
        "environment": {
            "torch": torch.__version__,
            "cuda_runtime": torch.version.cuda,
            "gpu": torch.cuda.get_device_name(0),
        },
    }

    started = time.perf_counter()
    model, _, architecture_config, _ = load_model(
        path=args.model_path,
        estimator_type="regressor",
        cache_trainset_representation=False,
    )
    model = model.to(device).eval()
    wrapper = RegressionForward(model).to(device).eval()
    report["architecture"] = type(model).__name__
    report["architecture_config"] = type(architecture_config).__name__
    report["load_seconds"] = time.perf_counter() - started

    total_rows = args.train_rows + args.test_rows
    x = torch.randn(total_rows, 1, args.features, device=device)
    y_train = torch.randn(args.train_rows, device=device)

    started = time.perf_counter()
    with torch.inference_mode():
        eager = wrapper(x, y_train)
    torch.cuda.synchronize()
    report["eager_seconds"] = time.perf_counter() - started
    report["eager_shape"] = list(eager.shape)
    report["eager_dtype"] = str(eager.dtype)
    report["eager_finite"] = bool(torch.isfinite(eager).all().item())

    started = time.perf_counter()
    try:
        exported = torch.export.export(wrapper, (x, y_train), strict=False)
        torch.export.save(exported, args.output_dir / "tabpfn35.pt2")
        with torch.inference_mode():
            exported_output = exported.module()(x, y_train)
        torch.cuda.synchronize()
        report["torch_export"] = {
            "status": "supported_fixed_shape",
            "seconds": time.perf_counter() - started,
            "artifact": "tabpfn35.pt2",
            "max_abs_delta": float(
                torch.max(torch.abs(eager - exported_output)).detach().cpu()
            ),
            "graph_nodes": len(list(exported.graph.nodes)),
        }
    except Exception as error:  # noqa: BLE001 - the failure is the probe result
        report["torch_export"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-12000:],
        }

    report["peak_cuda_memory_bytes"] = int(torch.cuda.max_memory_allocated())
    report_path = args.output_dir / "torch_export_report.json"
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()

