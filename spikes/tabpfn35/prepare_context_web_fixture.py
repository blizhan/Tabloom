#!/usr/bin/env python3
"""Convert context-builder reference arrays into browser-friendly binaries."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def main() -> None:
    source_dir = Path("artifacts/tabpfn35/context-build/onnx")
    output_dir = Path("artifacts/tabpfn35/context-build/web-fixture")
    output_dir.mkdir(parents=True, exist_ok=True)
    fixture = np.load(source_dir / "context_browser_fixture.npz")
    scenarios = ["8x2", "24x4", "64x8", "256x16"]
    output_names = [f"cache_{index:02d}" for index in range(54)]
    metadata: dict[str, object] = {
        "dtype": "float32",
        "arrays": {},
        "outputNames": output_names,
        "scenarios": scenarios,
    }
    arrays = metadata["arrays"]
    assert isinstance(arrays, dict)
    for name in fixture.files:
        array = np.asarray(fixture[name], dtype="<f4")
        path = output_dir / f"{name}.f32"
        array.tofile(path)
        arrays[name] = {
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
