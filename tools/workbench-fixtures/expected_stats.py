#!/usr/bin/env python3
"""Regenerate the independent expected scalar statistics for the fixture."""
from __future__ import annotations

import argparse
from pathlib import Path

from generate import canonical_rows, write_expected_stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path("runtime/tests/fixtures/workbench/v1"))
    args = parser.parse_args()
    train, predict = canonical_rows()
    write_expected_stats(args.root.resolve(), train, predict)
    print(f"Wrote independent stats to {args.root.resolve() / 'expected/stats.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
