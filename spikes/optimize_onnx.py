#!/usr/bin/env python3
"""Create and inspect browser-oriented ONNX weight-size variants."""

from __future__ import annotations

import argparse
import collections
import json
import time
import traceback
from pathlib import Path

import onnx
import numpy as np
import ml_dtypes
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization import QuantType, quantize_dynamic
from onnxruntime.transformers.float16 import convert_float_to_float16


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("model", type=Path)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument(
        "--mode",
        choices=("fp16", "fp16-storage", "fp8-storage", "int8"),
        required=True,
    )
    return parser.parse_args()


def tensor_dtype_name(data_type: int) -> str:
    try:
        return TensorProto.DataType.Name(data_type)
    except ValueError:
        return str(data_type)


def model_files(model_path: Path) -> dict[str, int]:
    return {
        path.name: path.stat().st_size
        for path in sorted(model_path.parent.glob(f"{model_path.name}*"))
        if path.is_file()
    }


def summarize(model_path: Path) -> dict[str, object]:
    model = onnx.load(model_path, load_external_data=False)
    dtypes = collections.Counter(
        tensor_dtype_name(initializer.data_type)
        for initializer in model.graph.initializer
    )
    ops = collections.Counter(node.op_type for node in model.graph.node)
    files = model_files(model_path)
    return {
        "files": files,
        "total_bytes": sum(files.values()),
        "nodes": len(model.graph.node),
        "initializers": len(model.graph.initializer),
        "initializer_dtypes": dict(sorted(dtypes.items())),
        "operator_counts": dict(sorted(ops.items())),
        "inputs": [value.name for value in model.graph.input],
        "outputs": [value.name for value in model.graph.output],
    }


def topologically_sort_graph(graph: onnx.GraphProto) -> None:
    """Restore stable topological order after converters append Cast nodes."""
    available = {value.name for value in graph.input}
    available.update(initializer.name for initializer in graph.initializer)
    available.update(initializer.values.name for initializer in graph.sparse_initializer)
    pending = list(graph.node)
    ordered: list[onnx.NodeProto] = []

    while pending:
        next_pending: list[onnx.NodeProto] = []
        progressed = False
        for node in pending:
            if all(not name or name in available for name in node.input):
                ordered.append(node)
                available.update(name for name in node.output if name)
                progressed = True
            else:
                next_pending.append(node)
        if not progressed:
            unresolved = sorted(
                {
                    name
                    for node in next_pending
                    for name in node.input
                    if name and name not in available
                }
            )
            raise RuntimeError(f"Unable to topologically sort graph; unresolved inputs: {unresolved[:20]}")
        pending = next_pending

    del graph.node[:]
    graph.node.extend(ordered)


def fix_fp16_constant_of_shape_defaults(graph: onnx.GraphProto) -> None:
    """ConstantOfShape defaults to FP32 unless an explicit value is present."""
    for node in graph.node:
        if node.op_type == "ConstantOfShape" and not any(attr.name == "value" for attr in node.attribute):
            node.attribute.append(
                helper.make_attribute(
                    "value",
                    helper.make_tensor("value", TensorProto.FLOAT16, [1], [0.0]),
                )
            )


def clear_destination(destination: Path) -> None:
    """Remove only the exact generated output files before recreating them."""
    destination.unlink(missing_ok=True)
    destination.with_name(f"{destination.name}.data").unlink(missing_ok=True)
    destination.with_name(f"{destination.name}.data.data").unlink(missing_ok=True)


def convert_fp16(source: Path, destination: Path) -> None:
    model = onnx.load(source, load_external_data=True)
    converted = convert_float_to_float16(
        model,
        keep_io_types=False,
        disable_shape_infer=False,
    )
    fix_fp16_constant_of_shape_defaults(converted.graph)
    topologically_sort_graph(converted.graph)
    clear_destination(destination)
    onnx.save_model(
        converted,
        destination,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=f"{destination.name}.data",
        size_threshold=1024,
    )


def convert_fp16_storage(source: Path, destination: Path) -> None:
    """Store large weights as FP16 and cast them once to FP32 for computation."""
    model = onnx.load(source, load_external_data=True)
    cast_nodes: list[onnx.NodeProto] = []
    converted_initializers: list[onnx.TensorProto] = []

    for initializer in model.graph.initializer:
        array = numpy_helper.to_array(initializer)
        if initializer.data_type == TensorProto.FLOAT and array.ndim >= 2 and array.size >= 4096:
            original_name = initializer.name
            storage_name = f"{original_name}__fp16_storage"
            converted_initializers.append(
                numpy_helper.from_array(array.astype(np.float16), name=storage_name)
            )
            cast_nodes.append(
                helper.make_node(
                    "Cast",
                    [storage_name],
                    [original_name],
                    name=f"storage_cast_{len(cast_nodes)}",
                    to=TensorProto.FLOAT,
                )
            )
        else:
            converted_initializers.append(initializer)

    del model.graph.initializer[:]
    model.graph.initializer.extend(converted_initializers)
    original_nodes = list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend([*cast_nodes, *original_nodes])
    clear_destination(destination)
    onnx.save_model(
        model,
        destination,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=f"{destination.name}.data",
        size_threshold=1024,
    )


def convert_fp8_storage(source: Path, destination: Path) -> None:
    """Store large weights as ONNX FLOAT8 E4M3FN and cast to FP32."""
    model = onnx.load(source, load_external_data=True)
    cast_nodes: list[onnx.NodeProto] = []
    converted_initializers: list[onnx.TensorProto] = []

    for initializer in model.graph.initializer:
        array = numpy_helper.to_array(initializer)
        if initializer.data_type == TensorProto.FLOAT and array.ndim >= 2 and array.size >= 4096:
            original_name = initializer.name
            storage_name = f"{original_name}__fp8_storage"
            converted_initializers.append(
                numpy_helper.from_array(
                    np.asarray(array, dtype=ml_dtypes.float8_e4m3fn),
                    name=storage_name,
                )
            )
            cast_nodes.append(
                helper.make_node(
                    "Cast",
                    [storage_name],
                    [original_name],
                    name=f"storage_cast_{len(cast_nodes)}",
                    to=TensorProto.FLOAT,
                )
            )
        else:
            converted_initializers.append(initializer)

    del model.graph.initializer[:]
    model.graph.initializer.extend(converted_initializers)
    original_nodes = list(model.graph.node)
    del model.graph.node[:]
    model.graph.node.extend([*cast_nodes, *original_nodes])
    clear_destination(destination)
    onnx.save_model(
        model,
        destination,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=f"{destination.name}.data",
        size_threshold=1024,
    )


def convert_int8(source: Path, destination: Path) -> None:
    clear_destination(destination)
    model = onnx.load(source, load_external_data=True)
    # Torch's exported graph contains stale intermediate value_info entries for
    # a few reshapes. ORT quantization runs shape inference and rejects those
    # annotations before it reaches the weights, so let it infer them afresh.
    del model.graph.value_info[:]
    quantize_dynamic(
        model,
        destination,
        weight_type=QuantType.QInt8,
        per_channel=False,
        reduce_range=False,
        use_external_data_format=True,
        extra_options={
            "MatMulConstBOnly": True,
            "EnableSubgraph": False,
        },
    )


def main() -> None:
    args = parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    destination = args.output_dir / f"{args.name}-{args.mode}.onnx"
    report_path = args.output_dir / f"{args.name}-{args.mode}-report.json"
    report: dict[str, object] = {
        "source": str(args.model),
        "destination": str(destination),
        "mode": args.mode,
        "source_summary": summarize(args.model),
    }

    started = time.perf_counter()
    try:
        if args.mode == "fp16":
            convert_fp16(args.model, destination)
        elif args.mode == "fp16-storage":
            convert_fp16_storage(args.model, destination)
        elif args.mode == "fp8-storage":
            convert_fp8_storage(args.model, destination)
        else:
            convert_int8(args.model, destination)
        onnx.checker.check_model(destination)
        report["status"] = "converted"
        report["seconds"] = time.perf_counter() - started
        report["output_summary"] = summarize(destination)
    except Exception as error:  # noqa: BLE001 - converter failure is a result
        report["status"] = "blocked"
        report["seconds"] = time.perf_counter() - started
        report["error_type"] = type(error).__name__
        report["error"] = str(error)
        report["traceback"] = traceback.format_exc()

    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))
    if report["status"] != "converted":
        raise SystemExit(1)


if __name__ == "__main__":
    main()
