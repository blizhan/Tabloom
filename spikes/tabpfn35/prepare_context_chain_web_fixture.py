#!/usr/bin/env python3
"""Convert the ONNX context-chain fixture into browser-friendly binaries."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def main() -> None:
    source = Path("artifacts/tabpfn35/context-chain/context_chain_browser_fixture.npz")
    output_dir = Path("artifacts/tabpfn35/context-chain/web-fixture")
    output_dir.mkdir(parents=True, exist_ok=True)
    fixture = np.load(source)
    scenarios = ["8x2x4", "24x4x8", "64x8x16", "256x16x32"]
    metadata: dict[str, object] = {
        "dtype": "float32",
        "arrays": {},
        "scenarios": scenarios,
        "cacheNames": [f"cache_{index:02d}" for index in range(54)],
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
