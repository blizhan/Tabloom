#!/usr/bin/env python3
"""Convert the dynamic TabPFN 3.5 context-builder graph to ONNX and verify it."""

from __future__ import annotations

import argparse
import collections
import json
import time
import traceback
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
import torch

from probe_onnx import fused_rms_norm, searchsorted_tensor


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--exported-program",
        type=Path,
        default=Path("artifacts/tabpfn35/context-build/tabpfn35-context-dynamic.pt2"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/context-build/onnx"),
    )
    parser.add_argument("--opset", type=int, default=20)
    parser.add_argument("--skip-ort", action="store_true")
    return parser.parse_args()


def tuple_delta(
    expected: tuple[np.ndarray, ...],
    actual: list[np.ndarray],
) -> dict[str, Any]:
    if len(expected) != len(actual):
        return {
            "tensor_count_match": False,
            "expected_tensor_count": len(expected),
            "actual_tensor_count": len(actual),
        }
    max_deltas = [
        float(np.max(np.abs(left - right)))
        for left, right in zip(expected, actual, strict=True)
    ]
    return {
        "tensor_count_match": True,
        "tensor_count": len(expected),
        "max_abs_delta": max(max_deltas, default=0.0),
        "mean_of_tensor_max_abs_delta": float(np.mean(max_deltas)),
        "nonzero_tensor_deltas": sum(delta != 0.0 for delta in max_deltas),
        "finite": all(np.isfinite(array).all() for array in actual),
    }


def write_report(output_dir: Path, report: dict[str, Any]) -> None:
    (output_dir / "context_build_onnx_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, Any] = {
        "model": "tabpfn-3.5",
        "probe": "training-context-builder-onnx",
        "opset": args.opset,
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": ort.__version__,
    }

    started = time.perf_counter()
    exported = torch.export.load(args.exported_program)
    module = exported.module()
    report["load_seconds"] = time.perf_counter() - started
    report["exported_program_device"] = str(next(module.parameters()).device)

    output_names = [f"cache_{index:02d}" for index in range(54)]
    onnx_path = args.output_dir / "tabpfn35-context-dynamic.onnx"
    started = time.perf_counter()
    try:
        torch.onnx.export(
            exported,
            (),
            onnx_path,
            input_names=["x_train", "y_train"],
            output_names=output_names,
            opset_version=args.opset,
            dynamo=True,
            external_data=True,
            optimize=False,
            custom_translation_table={
                torch.ops.aten.searchsorted.Tensor: searchsorted_tensor,
                torch.ops.aten._fused_rms_norm.default: fused_rms_norm,
            },
            report=True,
            artifacts_dir=args.output_dir,
        )
        report["conversion"] = {
            "status": "supported_dynamic_context",
            "seconds": time.perf_counter() - started,
        }
    except Exception as error:  # noqa: BLE001 - failure is a probe result
        report["conversion"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-20000:],
        }
        write_report(args.output_dir, report)
        return

    graph = onnx.load(onnx_path, load_external_data=False)
    operator_counts = collections.Counter(node.op_type for node in graph.graph.node)
    model_files = sorted(
        path
        for path in args.output_dir.iterdir()
        if path.is_file() and path.name.startswith(onnx_path.name)
    )
    report["graph"] = {
        "nodes": len(graph.graph.node),
        "initializers": len(graph.graph.initializer),
        "inputs": len(graph.graph.input),
        "outputs": len(graph.graph.output),
        "operator_counts": dict(sorted(operator_counts.items())),
        "files": {path.name: path.stat().st_size for path in model_files},
    }

    if args.skip_ort:
        write_report(args.output_dir, report)
        return

    started = time.perf_counter()
    try:
        session = ort.InferenceSession(
            str(onnx_path),
            providers=["CPUExecutionProvider"],
        )
        generator = torch.Generator(device="cpu").manual_seed(3501)
        checks: dict[str, Any] = {}
        fixture_arrays: dict[str, np.ndarray] = {}
        for rows, features in ((8, 2), (24, 4), (64, 8), (256, 16)):
            scenario = f"{rows}x{features}"
            x_train = torch.randn(
                (rows, 1, features), generator=generator, dtype=torch.float32
            )
            y_train = torch.randn((rows,), generator=generator, dtype=torch.float32)
            with torch.inference_mode():
                reference_tensors = module(x_train, y_train)
            reference = tuple(tensor.detach().cpu().numpy() for tensor in reference_tensors)
            actual = session.run(
                output_names,
                {
                    "x_train": x_train.numpy(),
                    "y_train": y_train.numpy(),
                },
            )
            checks[scenario] = tuple_delta(reference, actual)
            fixture_arrays[f"x_train_{scenario}"] = x_train.numpy()
            fixture_arrays[f"y_train_{scenario}"] = y_train.numpy()
            for name, array in zip(output_names, reference, strict=True):
                fixture_arrays[f"{name}_{scenario}"] = array
        report["onnxruntime_cpu"] = {
            "status": "supported",
            "seconds_including_session_load": time.perf_counter() - started,
            "checks": checks,
        }
        np.savez(args.output_dir / "context_browser_fixture.npz", **fixture_arrays)
    except Exception as error:  # noqa: BLE001 - probe result
        report["onnxruntime_cpu"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-16000:],
        }

    write_report(args.output_dir, report)


if __name__ == "__main__":
    main()
