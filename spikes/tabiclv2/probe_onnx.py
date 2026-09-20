#!/usr/bin/env python3
"""Convert TabICL v2's dynamic KV-cache graph to ONNX and verify it."""

from __future__ import annotations

import argparse
import collections
import json
import time
import traceback
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--exported-program",
        type=Path,
        default=Path("artifacts/tabiclv2/export/tabiclv2-kv-dynamic.pt2"),
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=Path("artifacts/tabiclv2/reference_fixture.npz"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabiclv2/onnx"),
    )
    parser.add_argument("--opset", type=int, default=20)
    parser.add_argument("--skip-ort", action="store_true")
    return parser.parse_args()


def write_report(output_dir: Path, report: dict[str, object]) -> None:
    (output_dir / "onnx_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "model": "tabicl-regressor-v2-20260212",
        "probe": "onnx-dynamic-kv-cache",
        "opset": args.opset,
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": ort.__version__,
    }

    fixture = np.load(args.fixture)
    example = torch.from_numpy(fixture["transformed_x_test"])

    started = time.perf_counter()
    exported = torch.export.load(args.exported_program)
    module = exported.module()
    device = next(module.parameters()).device
    example = example.to(device)
    report["exported_program_device"] = str(device)
    report["load_seconds"] = time.perf_counter() - started

    onnx_path = args.output_dir / "tabiclv2-kv-dynamic.onnx"
    started = time.perf_counter()
    try:
        torch.onnx.export(
            exported,
            (),
            onnx_path,
            input_names=["x_test"],
            output_names=["prediction_scaled"],
            opset_version=args.opset,
            dynamo=True,
            external_data=True,
            optimize=False,
            report=True,
            artifacts_dir=args.output_dir,
        )
        report["conversion"] = {
            "status": "supported_dynamic_test_rows",
            "seconds": time.perf_counter() - started,
        }
    except Exception as error:  # noqa: BLE001 - exporter failure is the probe result
        report["conversion"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-16000:],
        }
        write_report(args.output_dir, report)
        raise SystemExit(1) from error

    graph = onnx.load(onnx_path, load_external_data=False)
    operator_counts = collections.Counter(node.op_type for node in graph.graph.node)
    model_files = sorted(
        path for path in args.output_dir.iterdir() if path.is_file() and path.name.startswith(onnx_path.name)
    )
    report["graph"] = {
        "nodes": len(graph.graph.node),
        "initializers": len(graph.graph.initializer),
        "inputs": [value.name for value in graph.graph.input],
        "outputs": [value.name for value in graph.graph.output],
        "operator_counts": dict(sorted(operator_counts.items())),
        "files": {path.name: path.stat().st_size for path in model_files},
    }

    if args.skip_ort:
        write_report(args.output_dir, report)
        return

    started = time.perf_counter()
    try:
        session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
        row_checks: dict[str, object] = {}
        browser_arrays: dict[str, np.ndarray] = {}
        for rows in (1, 8, 32, 256, 1024):
            sample = example[:, :1].repeat(1, rows, 1)
            sample[:, :, 0] += torch.linspace(0.0, 1.0, rows, device=device)
            with torch.inference_mode():
                reference = module(sample).detach().cpu().numpy()
            sample_np = sample.detach().cpu().numpy()
            actual = session.run(["prediction_scaled"], {"x_test": sample_np})[0]
            row_checks[str(rows)] = {
                "shape": list(actual.shape),
                "finite": bool(np.isfinite(actual).all()),
                "max_abs_delta": float(np.max(np.abs(reference - actual))),
                "mean_abs_delta": float(np.mean(np.abs(reference - actual))),
            }
            browser_arrays[f"x_{rows}"] = sample_np
            browser_arrays[f"output_{rows}"] = reference
        report["onnxruntime_cpu"] = {
            "status": "supported",
            "seconds_including_session_load": time.perf_counter() - started,
            "row_checks": row_checks,
        }
        np.savez(args.output_dir / "browser_fixture.npz", **browser_arrays)
    except Exception as error:  # noqa: BLE001 - ORT failure is the probe result
        report["onnxruntime_cpu"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-12000:],
        }

    write_report(args.output_dir, report)


if __name__ == "__main__":
    main()
