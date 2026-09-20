#!/usr/bin/env python3
"""Convert the dynamic TabPFN 3.5 KV-cache graph to ONNX and verify it."""

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

from probe_onnx import fused_rms_norm, searchsorted_tensor


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--exported-program",
        type=Path,
        default=Path("artifacts/tabpfn35/kv-cache/tabpfn35-kv-dynamic.pt2"),
    )
    parser.add_argument(
        "--fixture",
        type=Path,
        default=Path("artifacts/tabpfn35/kv-cache/kv_cache_fixture.npz"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/kv-cache/onnx"),
    )
    parser.add_argument("--opset", type=int, default=20)
    parser.add_argument("--skip-ort", action="store_true")
    return parser.parse_args()


def write_report(output_dir: Path, report: dict[str, object]) -> None:
    (output_dir / "kv_cache_onnx_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    summary = {
        "conversion": report.get("conversion"),
        "graph": report.get("graph"),
        "onnxruntime_cpu": report.get("onnxruntime_cpu"),
    }
    print(json.dumps(summary, indent=2, sort_keys=True))


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "model": "tabpfn-3.5",
        "probe": "onnx-dynamic-kv-cache",
        "opset": args.opset,
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": ort.__version__,
    }

    fixture = np.load(args.fixture)
    cache_names = sorted(name for name in fixture.files if name.startswith("cache_"))
    cache_arrays = tuple(fixture[name] for name in cache_names)
    input_names = ["x_test", *cache_names]
    report["inputs"] = {
        "cache_tensor_count": len(cache_arrays),
        "cache_bytes": int(sum(array.nbytes for array in cache_arrays)),
    }

    started = time.perf_counter()
    exported = torch.export.load(args.exported_program)
    module = exported.module()
    device = next(module.parameters()).device
    report["exported_program_device"] = str(device)
    report["load_seconds"] = time.perf_counter() - started

    onnx_path = args.output_dir / "tabpfn35-kv-dynamic.onnx"
    started = time.perf_counter()
    try:
        torch.onnx.export(
            exported,
            (),
            onnx_path,
            input_names=input_names,
            output_names=["logits"],
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
            "status": "supported_dynamic_test_rows",
            "seconds": time.perf_counter() - started,
        }
    except Exception as error:  # noqa: BLE001 - failure is the probe result
        report["conversion"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-16000:],
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
        torch_cache = tuple(
            torch.from_numpy(array).to(device) for array in cache_arrays
        )
        row_checks: dict[str, object] = {}
        browser_arrays: dict[str, np.ndarray] = {
            name: array for name, array in zip(cache_names, cache_arrays, strict=True)
        }
        generator = torch.Generator(device=device).manual_seed(3500)
        for rows in (1, 8, 32, 256, 1024):
            x = torch.randn((rows, 1, 4), generator=generator, device=device)
            with torch.inference_mode():
                reference = module(x, torch_cache).detach().cpu().numpy()
            browser_arrays[f"x_{rows}"] = x.detach().cpu().numpy()
            browser_arrays[f"output_{rows}"] = reference
            feed = {
                "x_test": x.detach().cpu().numpy(),
                **dict(zip(cache_names, cache_arrays, strict=True)),
            }
            actual = session.run(["logits"], feed)[0]
            row_checks[str(rows)] = {
                "shape": list(actual.shape),
                "finite": bool(np.isfinite(actual).all()),
                "max_abs_delta": float(np.max(np.abs(reference - actual))),
                "mean_abs_delta": float(np.mean(np.abs(reference - actual))),
            }
        report["onnxruntime_cpu"] = {
            "status": "supported",
            "seconds_including_session_load": time.perf_counter() - started,
            "row_checks": row_checks,
        }
        np.savez(args.output_dir / "kv_browser_fixture.npz", **browser_arrays)
    except Exception as error:  # noqa: BLE001 - failure is the probe result
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
