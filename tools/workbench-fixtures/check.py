#!/usr/bin/env python3
"""Read-only validation for the committed workbench fixture package."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.ipc as ipc
import pyarrow.parquet as pq

from generate import FEATURES, PREDICT_ROWS, TARGET, TRAIN_ROWS, canonical_rows


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def normalize(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            value = value.astimezone(timezone.utc)
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, float):
        return round(value, 6) if math.isfinite(value) else value
    return value


def rows_from_table(table: pa.Table) -> list[dict[str, Any]]:
    return [{name: normalize(value.as_py()) for name, value in zip(table.column_names, row)} for row in table.to_pylist()] if False else [
        {name: normalize(value) for name, value in row.items()} for row in table.to_pylist()
    ]


def read_rows(path: Path) -> list[dict[str, Any]]:
    suffix = path.suffix.lower()
    if suffix == ".csv":
        with path.open(newline="", encoding="utf-8") as handle:
            return [{key: parse_csv_value(key, value) for key, value in row.items()} for row in csv.DictReader(handle)]
    if suffix == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    if suffix == ".parquet":
        return rows_from_table(pq.read_table(path))
    if suffix == ".arrow":
        with path.open("rb") as handle:
            return rows_from_table(ipc.open_file(handle).read_all())
    raise ValueError(f"Unsupported tabular file: {path}")


def parse_csv_value(name: str, value: str) -> Any:
    if value == "":
        return None
    if name == "hour_utc":
        return int(value)
    if name in FEATURES or name == TARGET:
        try:
            parsed = float(value)
            return parsed
        except ValueError:
            return value
    return value


def compare_rows(actual: list[dict[str, Any]], expected: list[dict[str, Any]], label: str) -> list[str]:
    errors: list[str] = []
    if len(actual) != len(expected):
        errors.append(f"{label}: row count {len(actual)} != {len(expected)}")
        return errors
    for index, (left, right) in enumerate(zip(actual, expected)):
        if set(left) != set(right):
            errors.append(f"{label}[{index}]: columns {sorted(left)} != {sorted(right)}")
            continue
        for key in right:
            a, b = normalize(left[key]), normalize(right[key])
            if isinstance(a, float) and isinstance(b, (int, float)) and math.isfinite(a):
                if abs(a - float(b)) > 1e-6:
                    errors.append(f"{label}[{index}].{key}: {a!r} != {b!r}")
            elif a != b:
                errors.append(f"{label}[{index}].{key}: {a!r} != {b!r}")
    return errors


def validate(root: Path, require_reference: bool = True) -> dict[str, Any]:
    errors: list[str] = []
    manifest_path = root / "manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"Missing manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("counts") != {"train": TRAIN_ROWS, "predict": PREDICT_ROWS, "features": len(FEATURES)}:
        errors.append(f"manifest counts are not {TRAIN_ROWS}/{PREDICT_ROWS}/{len(FEATURES)}")
    if manifest.get("features") != FEATURES or manifest.get("target") != TARGET:
        errors.append("manifest feature order or target is incorrect")
    schema_path = root / "schema.json"
    if not schema_path.is_file():
        errors.append("missing schema.json")
    else:
        try:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            if schema.get("trainRows") != TRAIN_ROWS or schema.get("predictRows") != PREDICT_ROWS:
                errors.append("schema row counts are incorrect")
            if schema.get("features") != FEATURES or schema.get("target") != TARGET:
                errors.append("schema feature order or target is incorrect")
            if schema.get("forecastOrigin") != manifest.get("forecastOrigin"):
                errors.append("schema forecastOrigin does not match manifest")
        except Exception as exc:
            errors.append(f"schema.json is invalid: {exc}")
    train_expected, predict_expected = canonical_rows()
    for split, expected in (("train", train_expected), ("predict", predict_expected)):
        for extension in ("csv", "parquet", "arrow", "json"):
            path = root / "normal" / f"{split}.{extension}"
            try:
                errors.extend(compare_rows(read_rows(path), expected, path.relative_to(root).as_posix()))
            except Exception as exc:
                errors.append(f"{path.relative_to(root)}: cannot read ({exc})")

    try:
        import duckdb
    except ImportError as exc:
        raise RuntimeError("Native DuckDB is required for full fixture validation; run `uv sync --project tools/workbench-fixtures --frozen`") from exc
    duckdb_path = root / "normal" / "sample.duckdb"
    try:
        connection = duckdb.connect(str(duckdb_path), read_only=True)
        for table_name, expected in (("train", train_expected), ("predict", predict_expected)):
            table = connection.execute(f'SELECT * FROM "{table_name}" ORDER BY timestamp_utc').to_arrow_table()
            errors.extend(compare_rows(rows_from_table(table), expected, f"normal/sample.duckdb:{table_name}"))
        table_names = {row[0] for row in connection.execute("SHOW TABLES").fetchall()}
        if table_names != {"train", "predict"}:
            errors.append(f"sample.duckdb tables {sorted(table_names)} != ['predict', 'train']")
        connection.close()
    except Exception as exc:
        errors.append(f"normal/sample.duckdb: cannot read ({exc})")

    stats_path = root / "expected" / "stats.json"
    if not stats_path.is_file():
        errors.append("missing expected/stats.json")
    else:
        expected_stats = json.loads(stats_path.read_text(encoding="utf-8"))
        if expected_stats.get("train", {}).get("rows") != TRAIN_ROWS or expected_stats.get("predict", {}).get("rows") != PREDICT_ROWS:
            errors.append("expected/stats.json row counts are incorrect")
    cases_path = root / "cases.json"
    if not cases_path.is_file():
        errors.append("missing cases.json")
    else:
        try:
            declared_cases = json.loads(cases_path.read_text(encoding="utf-8")).get("cases", [])
            if {case.get("caseId") for case in declared_cases} != {case.get("caseId") for case in manifest.get("cases", [])}:
                errors.append("cases.json does not match manifest cases")
        except Exception as exc:
            errors.append(f"cases.json is invalid: {exc}")

    declared = {entry["path"]: entry for entry in manifest.get("files", [])}
    actual_files = {path.relative_to(root).as_posix(): path for path in root.rglob("*") if path.is_file() and path.name != "manifest.json"}
    if set(declared) != set(actual_files):
        errors.append(f"manifest file list mismatch; missing={sorted(set(actual_files)-set(declared))}, extra={sorted(set(declared)-set(actual_files))}")
    total_bytes = 0
    for name, path in actual_files.items():
        total_bytes += path.stat().st_size
        entry = declared.get(name)
        if entry and (entry.get("bytes") != path.stat().st_size or entry.get("sha256") != digest(path)):
            errors.append(f"{name}: manifest byte length or SHA-256 mismatch")
    if total_bytes > 10 * 1024 * 1024:
        errors.append(f"fixture is {total_bytes} bytes, above the 10 MiB limit")
    cases = {case.get("caseId") for case in manifest.get("cases", [])}
    required_cases = {"empty", "missing-target", "missing-feature", "duplicate-key", "reordered", "wrong-type", "non-finite", "over-limit"}
    if cases != cases | required_cases:
        errors.append(f"missing required boundary cases: {sorted(required_cases - cases)}")
    for case in manifest.get("cases", []):
        case_path = root / case.get("file", "")
        if not case_path.is_file():
            errors.append(f"case {case.get('caseId')} is missing file {case_path.relative_to(root)}")
    reference = manifest.get("reference", {})
    if require_reference and (reference.get("status") != "complete" or not (root / "expected" / "tabpfn35-mean.json").is_file()):
        errors.append("official TabPFN reference is missing; run export_workbench_reference.py with a local checkpoint and CUDA")
    reference_path = root / "expected" / "tabpfn35-mean.json"
    if reference_path.is_file():
        try:
            reference_payload = json.loads(reference_path.read_text(encoding="utf-8"))
            if reference_payload.get("input", {}).get("trainRows") != TRAIN_ROWS or reference_payload.get("input", {}).get("predictRows") != PREDICT_ROWS:
                errors.append("official reference input row counts are incorrect")
            if reference_payload.get("input", {}).get("features") != len(FEATURES):
                errors.append("official reference feature count is incorrect")
            for split in ("train", "predict"):
                expected_digest = digest(root / "normal" / f"{split}.csv")
                if reference_payload.get("input", {}).get(f"{split}Sha256") != expected_digest:
                    errors.append(f"official reference {split} input SHA-256 does not match normal/{split}.csv")
            means = reference_payload.get("mean")
            if not isinstance(means, list) or len(means) != PREDICT_ROWS or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in means):
                errors.append("official reference mean must contain 32 finite values")
        except Exception as exc:
            errors.append(f"official reference is invalid: {exc}")
    return {"root": str(root), "status": "failed" if errors else "passed", "errors": errors, "totalBytes": total_bytes, "checkedFormats": ["csv", "parquet", "arrow", "json", "duckdb"], "reference": reference}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("runtime/tests/fixtures/workbench/v1"))
    parser.add_argument("--allow-missing-reference", action="store_true")
    args = parser.parse_args()
    try:
        report = validate(args.root.resolve(), require_reference=not args.allow_missing_reference)
    except Exception as exc:
        print(f"Fixture validation failed before checks: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(report, indent=2))
    if report["errors"]:
        for error in report["errors"]:
            print(f"- {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
