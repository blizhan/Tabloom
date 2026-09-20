#!/usr/bin/env python3
"""Probe a prediction-only TabPFN 3.5 graph with an explicit KV cache.

The cache is flattened into a tuple of tensors so it crosses an export/runtime
boundary without Python dataclasses. The exported graph accepts test rows plus
those tensors and does not recompute the training context.
"""

from __future__ import annotations

import argparse
import importlib
import json
import time
import traceback
from pathlib import Path
from typing import Any

import numpy as np
import torch
from tabpfn.architectures.kv_cache import KVCacheEntry
from tabpfn.architectures.tabpfn_v3_5 import TabPFNV3p5Cache
from tabpfn.model_loading import load_model


def install_export_sdpa() -> None:
    """Remove the Python CUDA-grid loop that specializes symbolic row counts."""

    sdpa_module = importlib.import_module(
        "tabpfn.architectures.shared.scaled_dot_product_attention"
    )

    def export_sdpa(
        q_BSHD: torch.Tensor,
        k_BSJD: torch.Tensor | None,
        v_BSJD: torch.Tensor | None,
        _backends_override: object = None,
    ) -> torch.Tensor:
        del _backends_override
        assert k_BSJD is not None and v_BSJD is not None
        q_BHSD = q_BSHD.permute(0, 2, 1, 3)
        keys = k_BSJD.permute(0, 2, 1, 3)
        values = v_BSJD.permute(0, 2, 1, 3)
        num_q_heads = q_BHSD.shape[-3]
        num_kv_heads = keys.shape[-3]
        if num_q_heads != num_kv_heads:
            repeat = num_q_heads // num_kv_heads
            keys = keys.repeat_interleave(repeat, dim=-3)
            values = values.repeat_interleave(repeat, dim=-3)
        output_BHSD = torch.nn.functional.scaled_dot_product_attention(
            q_BHSD.contiguous(),
            keys.contiguous(),
            values.contiguous(),
            attn_mask=None,
        )
        return output_BHSD.permute(0, 2, 1, 3)

    sdpa_module._torch_sdpa = export_sdpa  # noqa: SLF001


class CachedRegressionForward(torch.nn.Module):
    """Rebuild the v3.5 cache from portable tensor inputs."""

    def __init__(
        self,
        model: torch.nn.Module,
        *,
        layer_ids: tuple[int, ...],
        scaler_names: tuple[str, ...],
        inducing_count: int,
        train_shape: tuple[int, int],
    ) -> None:
        super().__init__()
        self.model = model
        self.layer_ids = layer_ids
        self.scaler_names = scaler_names
        self.inducing_count = inducing_count
        self.train_shape = train_shape
        if model._icl_bf16:  # noqa: SLF001 - this is an architecture probe
            raise ValueError("The export shim currently requires fp32 ICL")

    def forward(
        self,
        x_test: torch.Tensor,
        cache_tensors: tuple[torch.Tensor, ...],
    ) -> torch.Tensor:
        cursor = 0
        kv: dict[int, KVCacheEntry] = {}
        for layer_id in self.layer_ids:
            kv[layer_id] = KVCacheEntry(
                key=cache_tensors[cursor],
                value=cache_tensors[cursor + 1],
            )
            cursor += 2

        scaler_cache: dict[str, torch.Tensor] = {}
        for name in self.scaler_names:
            scaler_cache[name] = cache_tensors[cursor]
            cursor += 1

        ecdf_context = cache_tensors[cursor]
        cursor += 1
        inducing_hidden = list(cache_tensors[cursor : cursor + self.inducing_count])

        cache = TabPFNV3p5Cache(
            kv=kv,
            decoder_keys=None,
            train_shape=self.train_shape,
            scaler_cache=scaler_cache,
            ecdf_context=ecdf_context,
            inducing_hidden=inducing_hidden,
        )
        # This is the cached branch of TabPFNV3p5._stages_0_to_2, expressed
        # without its Python row-chunk loop. That loop calls range() with the
        # input row count and therefore specializes torch.export to the example
        # size even when chunking is disabled. All numerical modules and weights
        # below are the official model's own components.
        scaler_with_ecdf = {
            **scaler_cache,
            "ecdf_buckets": ecdf_context,
        }
        empty_y = x_test.new_empty((0,))
        x_grouped, _, _ = self.model._preprocess_and_group(  # noqa: SLF001
            x_test,
            empty_y,
            0,
            scaler_with_ecdf,
            "regression",
        )
        x_emb = self.model.x_embed(x_grouped)
        x_emb, _ = self.model.feature_distribution_embedder(
            x_BRiCE=x_emb,
            num_train_rows=0,
            cached_hidden=inducing_hidden,
            save_peak_memory_factor=None,
            force_recompute_layer=False,
            return_hidden=False,
        )
        x_BRiClE = self.model.column_aggregator(
            x_BRiCE=x_emb,
            save_peak_memory_factor=None,
            force_recompute_layer=False,
        )
        x_BRiD = x_BRiClE.flatten(-2)
        for layer_id, block in enumerate(self.model.icl_blocks):
            x_BRiD, _ = block(
                x_BRiD,
                0,
                None,
                cached_kv=kv[layer_id],
            )
        test_emb = self.model.output_norm(x_BRiD)
        output = self.model.heads(
            None,
            test_emb,
            empty_y.unsqueeze(0),
            task_type="regression",
            num_present_classes=None,
        )
        if self.model._nan_safe_output:  # noqa: SLF001
            output = torch.nan_to_num(output, nan=0.0)
        return output


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabpfn35/kv-cache"),
    )
    parser.add_argument("--train-rows", type=int, default=24)
    parser.add_argument("--test-rows", type=int, default=8)
    parser.add_argument("--features", type=int, default=4)
    parser.add_argument("--max-test-rows", type=int, default=1024)
    parser.add_argument("--seed", type=int, default=20260916)
    return parser.parse_args()


def flatten_cache(
    cache: TabPFNV3p5Cache,
) -> tuple[tuple[torch.Tensor, ...], dict[str, Any]]:
    layer_ids = tuple(sorted(cache.kv))
    tensors: list[torch.Tensor] = []
    tensor_manifest: list[dict[str, Any]] = []

    def append(name: str, tensor: torch.Tensor) -> None:
        # The official inference engine builds caches under inference_mode.
        # Export capture may run operations that save inputs for backward, which
        # rejects inference tensors even though this graph is inference-only.
        # Cloning outside inference_mode gives the portable boundary a regular
        # tensor, as serialization/deserialization would in the browser path.
        tensor = tensor.detach().clone()
        tensors.append(tensor)
        tensor_manifest.append(
            {
                "name": name,
                "shape": list(tensor.shape),
                "dtype": str(tensor.dtype),
                "bytes": tensor.numel() * tensor.element_size(),
            }
        )

    for layer_id in layer_ids:
        entry = cache.kv[layer_id]
        if not isinstance(entry, KVCacheEntry):
            raise TypeError("The export probe requires an unquantized KV cache")
        assert entry.key is not None and entry.value is not None
        append(f"kv.{layer_id}.key", entry.key)
        append(f"kv.{layer_id}.value", entry.value)

    assert cache.scaler_cache is not None
    scaler_names = tuple(sorted(cache.scaler_cache))
    for name in scaler_names:
        append(f"scaler.{name}", cache.scaler_cache[name])

    assert cache.ecdf_context is not None
    append("ecdf_context", cache.ecdf_context)

    assert cache.inducing_hidden is not None
    for index, tensor in enumerate(cache.inducing_hidden):
        append(f"inducing_hidden.{index}", tensor)

    metadata = {
        "layer_ids": list(layer_ids),
        "scaler_names": list(scaler_names),
        "inducing_count": len(cache.inducing_hidden),
        "train_shape": list(cache.train_shape),
        "tensor_count": len(tensors),
        "total_bytes": sum(item["bytes"] for item in tensor_manifest),
        "tensors": tensor_manifest,
    }
    return tuple(tensors), metadata


def max_abs_delta(left: torch.Tensor, right: torch.Tensor) -> float:
    return float(torch.max(torch.abs(left - right)).detach().cpu())


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for the KV-cache export probe")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    torch.manual_seed(args.seed)
    device = torch.device("cuda")
    report: dict[str, Any] = {
        "model": "tabpfn-3.5",
        "probe": "explicit-kv-cache-export",
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
    model, _, _, _ = load_model(
        path=args.model_path,
        estimator_type="regressor",
        cache_trainset_representation=False,
    )
    model = model.to(device).eval().requires_grad_(False)
    report["model_load_seconds"] = time.perf_counter() - started

    x_train = torch.randn(args.train_rows, 1, args.features, device=device)
    y_train = torch.randn(args.train_rows, device=device)
    x_test = torch.randn(args.test_rows, 1, args.features, device=device)
    x_full = torch.cat((x_train, x_test))

    with torch.inference_mode():
        full_output = model(
            x_full,
            y_train,
            "regression",
            only_return_standard_out=True,
        )
        cache_build_output, cache = model(
            x_train,
            y_train,
            "regression",
            only_return_standard_out=True,
            return_kv_cache=True,
        )
    assert isinstance(cache, TabPFNV3p5Cache)
    cache_tensors, cache_metadata = flatten_cache(cache)
    report["cache"] = cache_metadata
    install_export_sdpa()
    report["export_shims"] = [
        "single-call torch SDPA below the CUDA grid-splitting threshold"
    ]

    wrapper = CachedRegressionForward(
        model,
        layer_ids=tuple(cache_metadata["layer_ids"]),
        scaler_names=tuple(cache_metadata["scaler_names"]),
        inducing_count=cache_metadata["inducing_count"],
        train_shape=tuple(cache_metadata["train_shape"]),
    ).eval()

    started = time.perf_counter()
    with torch.inference_mode():
        cached_output = wrapper(x_test, cache_tensors)
    torch.cuda.synchronize()
    report["eager_cached_seconds"] = time.perf_counter() - started
    report["output_shape"] = list(cached_output.shape)
    report["output_finite"] = bool(torch.isfinite(cached_output).all().item())
    report["cache_build_train_output_shape"] = list(cache_build_output.shape)
    report["cached_vs_full_max_abs_delta"] = max_abs_delta(
        cached_output, full_output
    )
    np.savez(
        args.output_dir / "kv_cache_fixture.npz",
        x_test=x_test.detach().cpu().numpy(),
        output=cached_output.detach().cpu().numpy(),
        **{
            f"cache_{index:02d}": tensor.detach().cpu().numpy()
            for index, tensor in enumerate(cache_tensors)
        },
    )

    started = time.perf_counter()
    try:
        fixed_export = torch.export.export(
            wrapper,
            (x_test, cache_tensors),
            strict=False,
        )
        fixed_path = args.output_dir / "tabpfn35-kv-fixed.pt2"
        torch.export.save(fixed_export, fixed_path)
        with torch.inference_mode():
            fixed_output = fixed_export.module()(x_test, cache_tensors)
        report["fixed_export"] = {
            "status": "supported",
            "seconds": time.perf_counter() - started,
            "artifact": fixed_path.name,
            "artifact_bytes": fixed_path.stat().st_size,
            "graph_nodes": len(list(fixed_export.graph.nodes)),
            "max_abs_delta": max_abs_delta(cached_output, fixed_output),
        }
    except Exception as error:  # noqa: BLE001 - failure is a probe result
        report["fixed_export"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-12000:],
        }

    started = time.perf_counter()
    try:
        test_rows = torch.export.Dim(
            "test_rows", min=1, max=args.max_test_rows
        )
        dynamic_shapes = (
            {0: test_rows},
            tuple(None for _ in cache_tensors),
        )
        dynamic_export = torch.export.export(
            wrapper,
            (x_test, cache_tensors),
            dynamic_shapes=dynamic_shapes,
            strict=False,
        )
        dynamic_path = args.output_dir / "tabpfn35-kv-dynamic.pt2"
        torch.export.save(dynamic_export, dynamic_path)
        exported_module = dynamic_export.module()
        row_checks: dict[str, dict[str, Any]] = {}
        row_sizes = sorted(
            rows
            for rows in {1, 8, 32, 256, args.max_test_rows}
            if rows <= args.max_test_rows
        )
        for rows in row_sizes:
            scenario = torch.randn(rows, 1, args.features, device=device)
            with torch.inference_mode():
                eager = wrapper(scenario, cache_tensors)
                actual = exported_module(scenario, cache_tensors)
            row_checks[str(rows)] = {
                "shape": list(actual.shape),
                "finite": bool(torch.isfinite(actual).all().item()),
                "max_abs_delta": max_abs_delta(eager, actual),
            }
        report["dynamic_export"] = {
            "status": "supported",
            "seconds": time.perf_counter() - started,
            "artifact": dynamic_path.name,
            "artifact_bytes": dynamic_path.stat().st_size,
            "graph_nodes": len(list(dynamic_export.graph.nodes)),
            "test_rows_range": [1, args.max_test_rows],
            "row_checks": row_checks,
        }
    except Exception as error:  # noqa: BLE001 - failure is a probe result
        report["dynamic_export"] = {
            "status": "blocked",
            "seconds": time.perf_counter() - started,
            "error_type": type(error).__name__,
            "error": str(error),
            "traceback_tail": traceback.format_exc()[-12000:],
        }

    report["peak_cuda_memory_bytes"] = int(torch.cuda.max_memory_allocated())
    report_path = args.output_dir / "kv_cache_export_report.json"
    report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
