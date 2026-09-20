#!/usr/bin/env python3
"""Validate optimized browser ONNX variants against saved PyTorch fixtures."""

from __future__ import annotations

import argparse
import json
import time
import traceback
from pathlib import Path

import numpy as np
import onnxruntime as ort


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rows", type=int, nargs="+", default=[1, 8, 32, 256, 1024])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    fixture = np.load(args.fixture)
    cache_names = sorted(name for name in fixture.files if name.startswith("cache_"))
    report: dict[str, object] = {
        "model": str(args.model),
        "fixture": str(args.fixture),
        "onnxruntime": ort.__version__,
        "cache_tensor_count": len(cache_names),
    }

    try:
        started = time.perf_counter()
        session = ort.InferenceSession(
            str(args.model),
            providers=["CPUExecutionProvider"],
        )
        report["session_load_seconds"] = time.perf_counter() - started
        output_name = session.get_outputs()[0].name
        input_dtypes = {
            value.name: np.float16 if value.type == "tensor(float16)" else np.float32
            for value in session.get_inputs()
        }
        cache_feed = {
            name: fixture[name].astype(input_dtypes[name], copy=False)
            for name in cache_names
        }
        checks: dict[str, object] = {}
        for rows in args.rows:
            x = fixture[f"x_{rows}"].astype(input_dtypes["x_test"], copy=False)
            expected = fixture[f"output_{rows}"]
            started = time.perf_counter()
            actual = session.run(
                [output_name],
                {"x_test": x, **cache_feed},
            )[0]
            elapsed = time.perf_counter() - started
            delta = np.abs(actual.astype(np.float32) - expected.astype(np.float32))
            checks[str(rows)] = {
                "seconds": elapsed,
                "shape": list(actual.shape),
                "dtype": str(actual.dtype),
                "finite": bool(np.isfinite(actual).all()),
                "max_abs_delta": float(delta.max()),
                "mean_abs_delta": float(delta.mean()),
            }
        report["status"] = "supported"
        report["checks"] = checks
    except Exception as error:  # noqa: BLE001 - compatibility failure is a result
        report["status"] = "blocked"
        report["error_type"] = type(error).__name__
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if report["status"] != "supported":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
