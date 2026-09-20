#!/usr/bin/env python3
"""Convert the fixed-shape TabPFN 3.5 ExportedProgram to ONNX and verify it."""

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
from onnx import TensorProto
from onnxscript import opset20 as op


def searchsorted_tensor(
    sorted_sequence,
    values,
    *,
    out_int32: bool = False,
    right: bool = False,
    side: str | None = None,
    sorter=None,
):
    """ONNX lowering for the real-valued aten.searchsorted.Tensor overload.

    TabPFN uses four fixed-shape searchsorted calls during numerical feature
    bucketing. Counting values below each query is equivalent to binary search
    and uses only broadcast comparison, cast, and reduction operators supported
    by standard ONNX runtimes.
    """
    if sorter is not None:
        raise ValueError("TabPFN 3.5 does not use the searchsorted sorter input")
    boundaries = op.Unsqueeze(sorted_sequence, [-2])
    queries = op.Unsqueeze(values, [-1])
    use_right = right or side == "right"
    comparison = (
        op.LessOrEqual(boundaries, queries)
        if use_right
        else op.Less(boundaries, queries)
    )
    result = op.ReduceSum(
        op.Cast(comparison, to=TensorProto.INT64),
        [-1],
        keepdims=0,
    )
    if out_int32:
        result = op.Cast(result, to=TensorProto.INT32)
    return result


def fused_rms_norm(input, normalized_shape, weight=None, eps=None):
    """ONNX lowering for aten._fused_rms_norm used by TabPFN 3.5.

    Every occurrence in the captured graph normalizes the final dimension of a
    float32 tensor. The second return value is the reciprocal RMS; TabPFN only
    consumes the normalized output, but returning both preserves the ATen schema.
    """
    if len(normalized_shape) != 1:
        raise ValueError("The TabPFN export probe only supports 1D RMSNorm")
    epsilon = 1.1920928955078125e-07 if eps is None else eps
    mean_square = op.ReduceMean(
        op.Mul(input, input),
        [-1],
        keepdims=1,
    )
    reciprocal_rms = op.Reciprocal(
        op.Sqrt(op.Add(mean_square, epsilon)),
    )
    output = op.Mul(input, reciprocal_rms)
    if weight is not None:
        output = op.Mul(output, weight)
    return output, reciprocal_rms


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--exported-program",
        type=Path,
        default=Path("artifacts/tabpfn35/export/tabpfn35.pt2"),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/onnx"),
    )
    parser.add_argument("--opset", type=int, default=20)
    parser.add_argument("--skip-ort", action="store_true")
    parser.add_argument("--no-custom-searchsorted", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    report: dict[str, object] = {
        "model": "tabpfn-3.5",
        "probe": "onnx-fixed-shape",
        "opset": args.opset,
        "torch": torch.__version__,
        "onnx": onnx.__version__,
        "onnxruntime": ort.__version__,
    }

    started = time.perf_counter()
    exported = torch.export.load(args.exported_program)
    # ExportedProgram already captures the source module's train/eval state and
    # intentionally rejects calling eval() on the materialized GraphModule.
    module = exported.module()
    device = next(module.parameters()).device
    report["exported_program_device"] = str(device)
    report["load_seconds"] = time.perf_counter() - started

    torch.manual_seed(3500)
    x = torch.randn(32, 1, 4, device=device)
    y_train = torch.randn(24, device=device)
    with torch.inference_mode():
        reference = module(x, y_train)
    if device.type == "cuda":
        torch.cuda.synchronize()
    np.savez(
        args.output_dir / "raw_forward_fixture.npz",
        x=x.detach().cpu().numpy(),
        y_train=y_train.detach().cpu().numpy(),
        output=reference.detach().cpu().numpy(),
    )

    onnx_path = args.output_dir / "tabpfn35.onnx"
    started = time.perf_counter()
    try:
        torch.onnx.export(
            exported,
            (),
            onnx_path,
            input_names=["x", "y_train"],
            output_names=["logits"],
            opset_version=args.opset,
            dynamo=True,
            external_data=True,
            optimize=False,
            custom_translation_table=(
                None
                if args.no_custom_searchsorted
                else {
                    torch.ops.aten.searchsorted.Tensor: searchsorted_tensor,
                    torch.ops.aten._fused_rms_norm.default: fused_rms_norm,
                }
            ),
            report=True,
            artifacts_dir=args.output_dir,
        )
        report["conversion"] = {
            "status": "supported_fixed_shape",
            "seconds": time.perf_counter() - started,
        }
    except Exception as error:  # noqa: BLE001 - the failure is the probe result
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
    external_files = sorted(
        path.name
        for path in args.output_dir.iterdir()
        if path.is_file() and path.name.startswith(onnx_path.name)
    )
    report["graph"] = {
        "nodes": len(graph.graph.node),
        "initializers": len(graph.graph.initializer),
        "operator_counts": dict(sorted(operator_counts.items())),
        "files": {
            path.name: path.stat().st_size
            for path in args.output_dir.iterdir()
            if path.is_file() and path.name in external_files
        },
    }

    if not args.skip_ort:
        started = time.perf_counter()
        try:
            session = ort.InferenceSession(
                str(onnx_path),
                providers=["CPUExecutionProvider"],
            )
            ort_output = session.run(
                ["logits"],
                {
                    "x": x.detach().cpu().numpy(),
                    "y_train": y_train.detach().cpu().numpy(),
                },
            )[0]
            reference_np = reference.detach().cpu().numpy()
            report["onnxruntime_cpu"] = {
                "status": "supported",
                "seconds_including_session_load": time.perf_counter() - started,
                "max_abs_delta": float(np.max(np.abs(reference_np - ort_output))),
                "mean_abs_delta": float(np.mean(np.abs(reference_np - ort_output))),
                "output_shape": list(ort_output.shape),
                "finite": bool(np.isfinite(ort_output).all()),
            }
        except Exception as error:  # noqa: BLE001 - probe result
            report["onnxruntime_cpu"] = {
                "status": "blocked",
                "seconds": time.perf_counter() - started,
                "error_type": type(error).__name__,
                "error": str(error),
                "traceback_tail": traceback.format_exc()[-12000:],
            }

    write_report(args.output_dir, report)


def write_report(output_dir: Path, report: dict[str, object]) -> None:
    (output_dir / "onnx_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
