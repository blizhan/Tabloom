#!/usr/bin/env python3
"""Export TabICL v2's cache-aware regression path with torch.export."""

from __future__ import annotations

import argparse
import json
import traceback
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from tabicl import TabICLRegressor
from tabicl._model.inference import InferenceManager
from tabicl._model.kv_cache import KVCache, KVCacheEntry, TabICLCache
from tabicl._model.layers import InducedSelfAttentionBlock, SkippableLinear

from validate_gpu import make_fixture


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("artifacts/tabiclv2/export"),
    )
    parser.add_argument("--seed", type=int, default=20260916)
    parser.add_argument("--max-test-rows", type=int, default=1024)
    return parser.parse_args()


class CachedRegressor(torch.nn.Module):
    """Tensor-only facade around an official fitted TabICL KV cache."""

    def __init__(
        self,
        model: torch.nn.Module,
        cache: TabICLCache,
        inference_config: object,
    ) -> None:
        super().__init__()
        self.model = model
        self.inference_config = inference_config
        self.train_shape = cache.train_shape
        self.num_classes = cache.num_classes
        self.col_indices = tuple(sorted(cache.col_cache.kv))
        self.icl_indices = tuple(sorted(cache.icl_cache.kv))

        for index in self.col_indices:
            entry = cache.col_cache.kv[index]
            self.register_buffer(f"col_{index}_key", entry.key)
            self.register_buffer(f"col_{index}_value", entry.value)
        for index in self.icl_indices:
            entry = cache.icl_cache.kv[index]
            self.register_buffer(f"icl_{index}_key", entry.key)
            self.register_buffer(f"icl_{index}_value", entry.value)

    def forward(self, x_test: torch.Tensor) -> torch.Tensor:
        col_cache = KVCache(
            kv={
                index: KVCacheEntry(
                    key=getattr(self, f"col_{index}_key"),
                    value=getattr(self, f"col_{index}_value"),
                )
                for index in self.col_indices
            }
        )
        icl_cache = KVCache(
            kv={
                index: KVCacheEntry(
                    key=getattr(self, f"icl_{index}_key"),
                    value=getattr(self, f"icl_{index}_value"),
                )
                for index in self.icl_indices
            }
        )
        cache = TabICLCache(
            col_cache=col_cache,
            icl_cache=icl_cache,
            train_shape=self.train_shape,
            num_classes=self.num_classes,
        )
        raw_quantiles = self.model.forward_with_cache(
            X_test=x_test,
            cache=cache,
            inference_config=self.inference_config,
        )
        return torch.sort(raw_quantiles, dim=-1).values.mean(dim=-1)

    def official_mean(self, x_test: torch.Tensor) -> torch.Tensor:
        """Run the package's distribution-based mean path for parity checks."""
        col_cache = KVCache(
            kv={
                index: KVCacheEntry(
                    key=getattr(self, f"col_{index}_key"),
                    value=getattr(self, f"col_{index}_value"),
                )
                for index in self.col_indices
            }
        )
        icl_cache = KVCache(
            kv={
                index: KVCacheEntry(
                    key=getattr(self, f"icl_{index}_key"),
                    value=getattr(self, f"icl_{index}_value"),
                )
                for index in self.icl_indices
            }
        )
        cache = TabICLCache(
            col_cache=col_cache,
            icl_cache=icl_cache,
            train_shape=self.train_shape,
            num_classes=self.num_classes,
        )
        return self.model.predict_stats_with_cache(
            X_test=x_test,
            output_type="mean",
            cache=cache,
            inference_config=self.inference_config,
        )


def build_model(args: argparse.Namespace) -> tuple[CachedRegressor, torch.Tensor]:
    x_train, x_test, y_train, _ = make_fixture(args.seed)
    estimator = TabICLRegressor(
        n_estimators=1,
        norm_methods=["none"],
        feat_shuffle_method="none",
        batch_size=1,
        kv_cache=True,
        model_path=args.model_path,
        allow_auto_download=False,
        device="cuda",
        use_amp=False,
        use_fa3=False,
        offload_mode=False,
        random_state=args.seed,
    )
    estimator.fit(x_train, y_train)
    encoded = estimator.X_encoder_.transform(x_test)
    test_data = estimator.ensemble_generator_.transform(encoded, mode="test")
    norm_method, (x_views,) = next(iter(test_data.items()))
    cache = estimator.model_kv_cache_[norm_method]
    example = torch.from_numpy(x_views).float().to(estimator.device_)
    wrapper = CachedRegressor(estimator.model_, cache, estimator.inference_config_).eval()
    return wrapper, example


def max_delta(a: torch.Tensor, b: torch.Tensor) -> float:
    return float(torch.max(torch.abs(a.float() - b.float())).cpu())


def install_export_shims() -> None:
    """Remove Python-only branches and runtime memory scheduling from export.

    The official inference manager's batching/offload logic is useful in Python,
    but a browser graph receives one already-sized tensor. Both replacements are
    mathematically equivalent for this GPU, float32, single-batch probe.
    """

    def skippable_linear_forward(self: SkippableLinear, src: torch.Tensor) -> torch.Tensor:
        out = F.linear(src, self.weight, self.bias)
        skip_mask = (src == self.skip_value).all(dim=-1, keepdim=True)
        return torch.where(skip_mask, self.skip_value, out)

    def direct_inference(
        self: InferenceManager,
        forward_fn: object,
        inputs: dict[str, object],
        auto_batch: bool = True,
        output_repeat: int = 1,
    ) -> torch.Tensor:
        del self, auto_batch, output_repeat
        return forward_fn(**inputs)

    def isab_forward_with_cache(
        self: InducedSelfAttentionBlock,
        src: torch.Tensor,
        col_cache: KVCache,
        block_idx: int,
        train_size: int | None = None,
        use_cache: bool = False,
        store_cache: bool = True,
    ) -> torch.Tensor:
        skip_mask = (src == self.skip_value).all(dim=(-2, -1))
        out = self.induced_attention_with_cache(
            src,
            col_cache,
            block_idx,
            train_size,
            use_cache,
            store_cache,
        )
        return torch.where(skip_mask[..., None, None], self.skip_value, out)

    SkippableLinear.forward = skippable_linear_forward
    InducedSelfAttentionBlock.forward_with_cache = isab_forward_with_cache
    InferenceManager.__call__ = direct_inference


def record_error(report: dict[str, object], key: str, error: BaseException) -> None:
    report[key] = {
        "status": "failed",
        "error_type": type(error).__name__,
        "error": str(error),
        "traceback": traceback.format_exc(),
    }


def main() -> None:
    args = parse_args()
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available; this spike must run on GPU")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    torch.manual_seed(args.seed)
    wrapper, example = build_model(args)
    with torch.no_grad():
        official_eager = wrapper.official_mean(example)
        browser_eager = wrapper(example)
    install_export_shims()
    with torch.no_grad():
        eager = wrapper(example)

    report: dict[str, object] = {
        "probe": "tabicl-v2-cache-aware-torch-export",
        "torch": torch.__version__,
        "example_shape": list(example.shape),
        "max_test_rows": args.max_test_rows,
        "browser_postprocess_max_abs_delta": max_delta(official_eager, browser_eager),
        "export_shim_max_abs_delta": max_delta(browser_eager, eager),
    }

    try:
        fixed = torch.export.export(wrapper, (example,), strict=False)
        fixed_path = args.output_dir / "tabiclv2-kv-fixed.pt2"
        torch.export.save(fixed, fixed_path)
        with torch.no_grad():
            fixed_out = fixed.module()(example)
        report["fixed"] = {
            "status": "passed",
            "artifact": str(fixed_path),
            "bytes": fixed_path.stat().st_size,
            "max_abs_delta": max_delta(eager, fixed_out),
            "output_shape": list(fixed_out.shape),
        }
    except Exception as error:  # noqa: BLE001 - the report must preserve exporter failures
        record_error(report, "fixed", error)

    try:
        rows = torch.export.Dim("test_rows", min=1, max=args.max_test_rows)
        dynamic = torch.export.export(
            wrapper,
            (example,),
            dynamic_shapes={"x_test": {1: rows}},
            strict=False,
        )
        dynamic_path = args.output_dir / "tabiclv2-kv-dynamic.pt2"
        torch.export.save(dynamic, dynamic_path)
        dynamic_module = dynamic.module()
        checks: dict[str, object] = {}
        for test_rows in (1, 8, 32, 256, args.max_test_rows):
            sample = example[:, :1].repeat(1, test_rows, 1)
            sample[:, :, 0] += torch.linspace(0.0, 1.0, test_rows, device=sample.device)
            with torch.no_grad():
                expected = wrapper(sample)
                actual = dynamic_module(sample)
            checks[str(test_rows)] = {
                "output_shape": list(actual.shape),
                "max_abs_delta": max_delta(expected, actual),
            }
        report["dynamic"] = {
            "status": "passed",
            "artifact": str(dynamic_path),
            "bytes": dynamic_path.stat().st_size,
            "checks": checks,
        }
    except Exception as error:  # noqa: BLE001 - the report must preserve exporter failures
        record_error(report, "dynamic", error)

    report_path = args.output_dir / "torch_export_report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, sort_keys=True))

    if any(isinstance(report.get(key), dict) and report[key].get("status") == "failed" for key in ("fixed", "dynamic")):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
