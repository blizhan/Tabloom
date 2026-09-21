#!/usr/bin/env python3
"""Regenerate only the documented boundary-case files."""
from __future__ import annotations

import argparse
from pathlib import Path

from generate import canonical_rows, write_variants


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("runtime/tests/fixtures/workbench/v1"))
    args = parser.parse_args()
    train, predict = canonical_rows()
    cases = write_variants(args.root.resolve() / "variants", train, predict)
    print(f"Wrote {len(cases)} boundary cases")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
