#!/usr/bin/env python3
"""Convert the dynamic KV-cache fixture into browser-friendly binaries."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np


def main() -> None:
    source_dir = Path("artifacts/tabpfn35/kv-cache/onnx")
    output_dir = Path("artifacts/tabpfn35/kv-cache/web-fixture")
    output_dir.mkdir(parents=True, exist_ok=True)
    fixture = np.load(source_dir / "kv_browser_fixture.npz")
    metadata: dict[str, object] = {
        "dtype": "float32",
        "arrays": {},
        "cacheNames": sorted(
            name for name in fixture.files if name.startswith("cache_")
        ),
        "scenarios": [1, 8, 32, 256, 1024],
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
