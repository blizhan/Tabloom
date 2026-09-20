#!/usr/bin/env python3
"""Convert TabICL v2 ONNX fixtures into browser-friendly float32 files."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def main() -> None:
    source_dir = Path("artifacts/tabiclv2/onnx")
    reference = np.load("artifacts/tabiclv2/reference_fixture.npz")
    fixture = np.load(source_dir / "browser_fixture.npz")
    output_dir = Path("artifacts/tabiclv2/web-fixture")
    output_dir.mkdir(parents=True, exist_ok=True)

    y_train = np.asarray(reference["y_train"], dtype=np.float32)
    metadata: dict[str, object] = {
        "dtype": "float32",
        "features": 8,
        "scenarios": [1, 8, 32, 256, 1024],
        "targetScaler": {
            "mean": float(np.mean(y_train)),
            "scale": float(np.std(y_train)),
        },
        "arrays": {},
    }
    for name in fixture.files:
        array = np.asarray(fixture[name], dtype="<f4")
        path = output_dir / f"{name}.f32"
        array.tofile(path)
        metadata["arrays"][name] = {  # type: ignore[index]
            "shape": list(array.shape),
            "bytes": path.stat().st_size,
            "file": path.name,
        }
    (output_dir / "fixture.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
