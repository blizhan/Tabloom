#!/usr/bin/env python3
"""Export official TabPFN goldens; --help works without numerical dependencies."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path


def digest(path):
    with path.open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def export(args):
    if not args.model_path.is_file():
        raise FileNotFoundError(f"Official checkpoint not found: {args.model_path}; no automatic download")
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise ValueError(f"Output directory must be empty: {args.output_dir}")
    if importlib.metadata.version("tabpfn") != "9.0.0":
        raise RuntimeError("This exporter requires tabpfn==9.0.0")
    import numpy as np
    import torch
    from tabpfn import TabPFNRegressor
    from tabpfn.base import resolved_softmax_temperature
    from tabpfn.constants import ModelVersion
    from tabpfn.inference import _maybe_run_gpu_preprocessing
    from tabpfn.preprocessing.clean import clean_data_transform
    from tabpfn.preprocessing.datamodel import FeatureModality
    from tabpfn.validation import ensure_compatible_predict_input_sklearn
    from probe_estimator_parity import make_inf_fixture, make_missing_fixture
    from validate_gpu import make_fixture

    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is required for official golden generation")

    def array(value):
        if isinstance(value, torch.Tensor):
            value = value.detach().cpu().numpy()
        result = np.asarray(value)
        if result.dtype.hasobject:
            raise TypeError("Object arrays are not portable")
        return result

    def state(value):
        if isinstance(value, (torch.Tensor, np.ndarray)):
            return array(value).tolist()
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, np.random.Generator):
            return state(value.bit_generator.state)
        if isinstance(value, dict):
            return {str(key): state(item) for key, item in value.items()}
        if isinstance(value, (list, tuple)):
            return [state(item) for item in value]
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        raise TypeError(f"Unsupported fitted state {type(value).__name__}; export aborted")

    def pipeline_state(pipeline):
        if pipeline is None:
            return None
        steps = []
        for step, _modalities in pipeline.steps:
            # Explicit fields needed to reproduce the supported numerical profile.
            fields = {key: value for key, value in vars(step).items()
                      if key in ("n_cells_", "index_permutation_", "random_state",
                                 "shuffle_method", "shuffle_index")}
            steps.append({"class": type(step).__name__, "state": state(fields)})
        return {"steps": steps, "fittedCache": state(getattr(pipeline, "fitted_cache", None))}

    def estimator(seed, passthrough=False):
        return TabPFNRegressor.create_default_for_version(
            ModelVersion.V3_5, model_path=args.model_path, device="cuda",
            n_estimators=1, random_state=seed, show_progress_bar=False,
            fit_mode="fit_with_cache", kv_cache_precision="auto",
            inference_precision=torch.float32,
            inference_config={"PASSTHROUGH_INF": True} if passthrough else None)

    cases = [
        ("normal", make_fixture(args.seed), args.seed, False),
        ("missing", make_missing_fixture(args.seed + 1), args.seed + 1, False),
        ("opt-in-inf", make_inf_fixture(args.seed + 2), args.seed + 2, True),
        ("second-seed", make_fixture(args.seed + 3), args.seed + 3, False),
    ]
    for name in ("duplicate-rows", "constant-column", "extreme-values"):
        train, test, target, expected = make_fixture(args.seed)
        if name == "duplicate-rows":
            train[1:4], test[1:4] = train[0], test[0]
        elif name == "constant-column":
            train[:, 0] = test[:, 0] = 3.0
        else:
            train[0, 0], test[0, 0] = 1e12, -1e12
        cases.append((name, (train, test, target, expected), args.seed, False))

    inf_train, _, inf_target, _ = make_inf_fixture(args.seed)
    try:
        estimator(args.seed).fit(inf_train, inf_target)
    except ValueError as exc:
        if "inf" not in str(exc).lower():
            raise RuntimeError("Inf rejected for an unrelated reason") from exc
        rejection = {"status": "rejected", "exception": type(exc).__name__, "message": str(exc)}
    else:
        raise RuntimeError("Default estimator unexpectedly accepted infinity")

    args.output_dir.mkdir(parents=True, exist_ok=True)
    records = []
    for name, (train, test, target, _), seed, passthrough in cases:
        model = estimator(seed, passthrough)
        model.fit(train, target)
        prediction = model.predict(test, output_type="full")
        member = model.executor_.ensemble_members[0]
        if member.config.preprocess_config.name != "none" or member.config.target_transform is not None:
            raise RuntimeError("Unsupported fitted profile; refusing to approximate preprocessing")
        cleaned = model.text_transformer_.transform(model.date_transformer_.transform(test))
        cleaned = ensure_compatible_predict_input_sklearn(cleaned, model)
        cleaned = clean_data_transform(
            cleaned, cat_indices=model.inferred_feature_schema_.indices_for(FeatureModality.CATEGORICAL),
            ord_encoder=getattr(model, "ordinal_encoder_", None), passthrough_inf=passthrough)
        cpu_test = member.transform_X_test(cleaned)
        transformed = []
        for values, rows in ((member.X_train, len(train)), (cpu_test, 0)):
            tensor, _ = _maybe_run_gpu_preprocessing(
                torch.as_tensor(values, dtype=torch.float32, device="cuda").unsqueeze(1),
                member.gpu_preprocessor, member.feature_schema,
                num_train_rows=rows, use_fitted_cache=True)
            transformed.append(array(tensor))
        raw_logits, _ = next(model.executor_.iter_outputs(cleaned, autocast=model.use_autocast_, task_type="regression"))
        arrays = {
            "x_train": train, "x_test": test, "y_train": target,
            "x_train_model": transformed[0], "x_test_model": transformed[1],
            "y_train_model": member.y_train, "raw_logits": raw_logits,
            "logits": prediction["logits"], "mean": prediction["mean"],
            "standard_borders": model.znorm_space_bardist_.borders,
            "raw_borders": model.raw_space_bardist_.borders,
        }
        arrays = {key: array(value) for key, value in arrays.items()}
        if not np.isfinite(arrays["mean"]).all():
            raise RuntimeError(f"Non-finite official means in {name}")
        fitted = {
            "seed": seed, "cpu": pipeline_state(member.cpu_preprocessor),
            "gpu": pipeline_state(member.gpu_preprocessor),
            "featureIndices": state(member.feature_indices),
            "fingerprint": bool(member.config.add_fingerprint_feature),
            "featureShiftDecoder": member.config.feature_shift_decoder,
            "featureShiftCount": int(member.config.feature_shift_count),
            "targetMean": model.y_train_mean_, "targetScale": model.y_train_std_,
            "temperature": resolved_softmax_temperature(model),
            "averageBeforeSoftmax": model.average_before_softmax,
            "targetTransform": None, "passthroughInf": passthrough,
        }
        fitted_json = json.dumps(fitted, indent=2, allow_nan=False)
        binary = args.output_dir / f"{name}.npz"
        np.savez(binary, **arrays)
        metadata = args.output_dir / f"{name}.state.json"
        metadata.write_text(fitted_json + "\n", encoding="utf-8")
        records.append({
            "name": name, "file": binary.name, "sha256": digest(binary),
            "stateFile": metadata.name, "stateSha256": digest(metadata),
            "arrays": {key: {"shape": list(value.shape), "dtype": value.dtype.str} for key, value in arrays.items()},
        })
        del model
    manifest = {
        "schemaVersion": 2, "modelId": "tabpfn-3.5", "tabpfnVersion": "9.0.0",
        "checkpointSha256": digest(args.model_path), "referencePrecision": "fp32",
        "scenarios": records, "defaultInfRejection": rejection,
        "meanMaxAbsBudget": {"fp32": 1e-4, "fp16-storage": 2e-3},
        "environment": {"torch": torch.__version__, "numpy": np.__version__, "gpu": torch.cuda.get_device_name(0)},
    }
    # A partial export never publishes a valid manifest.
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-path", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("artifacts/tabpfn35/estimator-golden"))
    parser.add_argument("--seed", type=int, default=20260916)
    args = parser.parse_args()
    try:
        export(args)
    except (ImportError, importlib.metadata.PackageNotFoundError, OSError, ValueError, RuntimeError, TypeError) as exc:
        raise SystemExit(f"Golden export failed: {exc}") from exc


if __name__ == "__main__":
    main()
