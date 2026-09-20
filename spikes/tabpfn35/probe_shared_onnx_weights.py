#!/usr/bin/env python3
"""Deduplicate exact initializers across context and prediction ONNX graphs."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, numpy_helper


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
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
        "--fixture",
        type=Path,
        default=Path(
            "artifacts/tabpfn35/context-chain/context_chain_browser_fixture.npz"
        ),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/shared-weights"),
    )
    return parser.parse_args()


def tensor_bytes(tensor: TensorProto) -> bytes:
    return numpy_helper.to_array(tensor).tobytes(order="C")


def tensor_key(tensor: TensorProto) -> tuple[int, tuple[int, ...], str, int]:
    data = tensor_bytes(tensor)
    return (
        int(tensor.data_type),
        tuple(int(value) for value in tensor.dims),
        hashlib.sha256(data).hexdigest(),
        len(data),
    )


def external_tensor(
    source: TensorProto,
    *,
    location: str,
    offset: int,
    length: int,
) -> TensorProto:
    result = TensorProto()
    result.name = source.name
    result.data_type = source.data_type
    result.dims.extend(source.dims)
    result.data_location = TensorProto.EXTERNAL
    for key, value in (
        ("location", location),
        ("offset", str(offset)),
        ("length", str(length)),
    ):
        entry = result.external_data.add()
        entry.key = key
        entry.value = value
    return result


def rewrite_model(
    model: onnx.ModelProto,
    *,
    offsets: dict[tuple[int, tuple[int, ...], str, int], tuple[int, int]],
    shared_name: str,
) -> None:
    replacements = []
    for tensor in model.graph.initializer:
        key = tensor_key(tensor)
        offset, length = offsets[key]
        replacements.append(
            external_tensor(
                tensor,
                location=shared_name,
                offset=offset,
                length=length,
            )
        )
    del model.graph.initializer[:]
    model.graph.initializer.extend(replacements)


def max_abs(left: np.ndarray, right: np.ndarray) -> float:
    return float(np.max(np.abs(left - right)))


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    context = onnx.load(str(args.context_model), load_external_data=True)
    prediction = onnx.load(str(args.prediction_model), load_external_data=True)
    models = [context, prediction]

    model_keys: list[set[tuple[int, tuple[int, ...], str, int]]] = []
    unique_data: dict[tuple[int, tuple[int, ...], str, int], bytes] = {}
    for model in models:
        keys = set()
        for tensor in model.graph.initializer:
            key = tensor_key(tensor)
            keys.add(key)
            unique_data.setdefault(key, tensor_bytes(tensor))
        model_keys.append(keys)

    shared_keys = model_keys[0] & model_keys[1]
    context_bytes = sum(key[3] for key in model_keys[0])
    prediction_bytes = sum(key[3] for key in model_keys[1])
    shared_bytes = sum(key[3] for key in shared_keys)

    shared_path = args.output_dir / "tabpfn35-shared.data"
    offsets: dict[tuple[int, tuple[int, ...], str, int], tuple[int, int]] = {}
    with shared_path.open("wb") as handle:
        for key, data in unique_data.items():
            padding = (-handle.tell()) % 64
            if padding:
                handle.write(b"\0" * padding)
            offset = handle.tell()
            handle.write(data)
            offsets[key] = (offset, len(data))

    shared_name = shared_path.name
    rewrite_model(context, offsets=offsets, shared_name=shared_name)
    rewrite_model(prediction, offsets=offsets, shared_name=shared_name)
    context_path = args.output_dir / "tabpfn35-context-dynamic.onnx"
    prediction_path = args.output_dir / "tabpfn35-predict-dynamic.onnx"
    onnx.save_model(context, str(context_path))
    onnx.save_model(prediction, str(prediction_path))

    fixture = np.load(args.fixture)
    scenario = "24x4x8"
    x_train = fixture[f"x_train_{scenario}"]
    y_train = fixture[f"y_train_{scenario}"]
    x_test = fixture[f"x_test_{scenario}"]
    expected = fixture[f"output_{scenario}"]
    cache_names = [f"cache_{index:02d}" for index in range(54)]
    context_session = ort.InferenceSession(
        str(context_path), providers=["CPUExecutionProvider"]
    )
    prediction_session = ort.InferenceSession(
        str(prediction_path), providers=["CPUExecutionProvider"]
    )
    cache_arrays = context_session.run(
        cache_names, {"x_train": x_train, "y_train": y_train}
    )
    actual = prediction_session.run(
        ["logits"],
        {
            "x_test": x_test,
            **dict(zip(cache_names, cache_arrays, strict=True)),
        },
    )[0]

    report: dict[str, Any] = {
        "model": "tabpfn-3.5",
        "probe": "shared-external-data-deduplication",
        "initializers": {
            "context": len(model_keys[0]),
            "prediction": len(model_keys[1]),
            "shared_exact": len(shared_keys),
            "unique_union": len(unique_data),
        },
        "bytes": {
            "context_initializers": context_bytes,
            "prediction_initializers": prediction_bytes,
            "shared_exact": shared_bytes,
            "before_dedup": context_bytes + prediction_bytes,
            "shared_bundle": shared_path.stat().st_size,
            "saved": context_bytes + prediction_bytes - shared_path.stat().st_size,
        },
        "fractions": {
            "context_shared": shared_bytes / context_bytes,
            "prediction_shared": shared_bytes / prediction_bytes,
            "download_reduction": 1
            - shared_path.stat().st_size / (context_bytes + prediction_bytes),
        },
        "validation": {
            "status": "supported",
            "scenario": scenario,
            "shape": list(actual.shape),
            "finite": bool(np.isfinite(actual).all()),
            "max_abs_delta_vs_pytorch_fixture": max_abs(actual, expected),
        },
        "artifacts": {
            "context_model": str(context_path),
            "prediction_model": str(prediction_path),
            "shared_data": str(shared_path),
        },
    }
    (args.output_dir / "shared_weights_report.json").write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
