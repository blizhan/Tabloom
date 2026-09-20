#!/usr/bin/env python3
"""Convert the NumPy ONNX fixture into browser-friendly float32 binaries."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def main() -> None:
    fixture_dir = Path("artifacts/tabpfn35/onnx")
    fixture = np.load(fixture_dir / "raw_forward_fixture.npz")
    names = ("x", "y_train", "output")
    metadata: dict[str, object] = {"dtype": "float32", "arrays": {}}
    for name in names:
        array = np.asarray(fixture[name], dtype="<f4")
        path = fixture_dir / f"{name}.f32"
        array.tofile(path)
        metadata["arrays"][name] = {  # type: ignore[index]
            "shape": list(array.shape),
            "bytes": path.stat().st_size,
            "file": path.name,
        }
    (fixture_dir / "fixture.json").write_text(
        json.dumps(metadata, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()

