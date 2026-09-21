#!/usr/bin/env python3
"""Generate the deterministic, model-independent Tabloom workbench fixture."""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterable

import pyarrow as pa
import pyarrow.ipc as ipc
import pyarrow.parquet as pq

GENERATOR_VERSION = "workbench-fixtures-1.0.0"
SEED = 20260920
TRAIN_ROWS = 256
PREDICT_ROWS = 32
FEATURES = ["temperature_c", "wind_speed_ms", "solar_wm2", "hour_utc"]
TARGET = "demand_mwh"
START = datetime(2025, 1, 1, tzinfo=timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def row_for(index: int, *, train: bool, origin: datetime) -> dict[str, object]:
    timestamp = START + timedelta(hours=index)
    hour = timestamp.hour
    # Integer modulo arithmetic makes the fixture reproducible across Python/JS.
    temperature = round(7.5 + ((index * 17 + 3) % 181) / 10, 6)
    wind = round(((index * 29 + 7) % 91) / 10, 6)
    daylight = max(0, math.sin((hour - 6) * math.pi / 12))
    solar = round(daylight * (650 + (index * 11) % 120), 6)
    demand = round(18.0 + temperature * 0.31 + wind * 0.52 + solar * 0.006 + hour * 0.17, 6)
    row: dict[str, object] = {
        "source_row_id": f"wb-v1-{index:04d}",
        "business_key": f"meter-{index % 8:02d}",
        "timestamp_utc": iso(timestamp),
        "features_available_at": iso(timestamp if train else origin),
        "temperature_c": temperature,
        "wind_speed_ms": wind,
        "solar_wm2": solar,
        "hour_utc": hour,
    }
    if train:
        row[TARGET] = demand
    return row


def canonical_rows() -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    origin = START + timedelta(hours=TRAIN_ROWS)
    return (
        [row_for(i, train=True, origin=origin) for i in range(TRAIN_ROWS)],
        [row_for(TRAIN_ROWS + i, train=False, origin=origin) for i in range(PREDICT_ROWS)],
    )


def schema() -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "datasetId": "tabloom-workbench-v1",
        "generatorVersion": GENERATOR_VERSION,
        "seed": SEED,
        "forecastOrigin": iso(START + timedelta(hours=TRAIN_ROWS)),
        "trainRows": TRAIN_ROWS,
        "predictRows": PREDICT_ROWS,
        "features": FEATURES,
        "target": TARGET,
        "targetUnit": "MWh",
        "targetMeaning": "Synthetic demand; not a real business forecast.",
        "columns": [
            {"name": "source_row_id", "type": "string", "nullable": False},
            {"name": "business_key", "type": "string", "nullable": False},
            {"name": "timestamp_utc", "type": "timestamp[us, UTC]", "nullable": False},
            {"name": "features_available_at", "type": "timestamp[us, UTC]", "nullable": False},
            {"name": "temperature_c", "type": "float64", "nullable": False},
            {"name": "wind_speed_ms", "type": "float64", "nullable": False},
            {"name": "solar_wm2", "type": "float64", "nullable": False},
            {"name": "hour_utc", "type": "int32", "nullable": False},
            {"name": TARGET, "type": "float64", "nullable": False, "tables": ["train"]},
        ],
    }


def arrow_table(rows: list[dict[str, object]], train: bool) -> pa.Table:
    names = ["source_row_id", "business_key", "timestamp_utc", "features_available_at", *FEATURES]
    if train:
        names.append(TARGET)
    arrays: dict[str, pa.Array] = {}
    for name in names:
        values = [row[name] for row in rows]
        if name in ("timestamp_utc", "features_available_at"):
            arrays[name] = pa.array([datetime.fromisoformat(str(v).replace("Z", "+00:00")) for v in values], type=pa.timestamp("us", tz="UTC"))
        elif name == "hour_utc":
            arrays[name] = pa.array(values, type=pa.int32())
        elif name in FEATURES or name == TARGET:
            arrays[name] = pa.array(values, type=pa.float64())
        else:
            arrays[name] = pa.array(values, type=pa.string())
    return pa.table(arrays)


def write_csv(path: Path, rows: list[dict[str, object]], train: bool) -> None:
    names = ["source_row_id", "business_key", "timestamp_utc", "features_available_at", *FEATURES]
    if train:
        names.append(TARGET)
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=names, lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def write_json(path: Path, rows: list[dict[str, object]]) -> None:
    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def write_arrow(path: Path, rows: list[dict[str, object]], train: bool) -> None:
    with path.open("wb") as handle:
        with ipc.new_file(handle, arrow_table(rows, train).schema) as writer:
            writer.write_table(arrow_table(rows, train))


def write_parquet(path: Path, rows: list[dict[str, object]], train: bool) -> None:
    pq.write_table(arrow_table(rows, train), path, compression=None, version="2.6", data_page_version="1.0")


def write_duckdb(path: Path, train: list[dict[str, object]], predict: list[dict[str, object]]) -> None:
    try:
        import duckdb
    except ImportError as exc:
        raise RuntimeError("Native DuckDB is required to create sample.duckdb; run `uv sync --project tools/workbench-fixtures --frozen`") from exc
    if path.exists():
        path.unlink()
    connection = duckdb.connect(str(path))
    try:
        for name, rows, is_train in (("train", train, True), ("predict", predict, False)):
            table = arrow_table(rows, is_train)
            connection.register(f"_{name}_arrow", table)
            connection.execute(f'CREATE TABLE "{name}" AS SELECT * FROM "_{name}_arrow"')
            connection.unregister(f"_{name}_arrow")
    finally:
        connection.close()


def write_queries(directory: Path) -> None:
    queries = {
        "train.sql": "SELECT source_row_id, timestamp_utc, temperature_c, wind_speed_ms, solar_wm2, hour_utc, demand_mwh FROM train ORDER BY timestamp_utc;\n",
        "predict.sql": "SELECT source_row_id, timestamp_utc, temperature_c, wind_speed_ms, solar_wm2, hour_utc FROM predict ORDER BY timestamp_utc;\n",
        "join.sql": "SELECT p.source_row_id, p.timestamp_utc, p.demand_mwh FROM predict p LEFT JOIN predictions r USING (source_row_id) ORDER BY p.timestamp_utc;\n",
        "aggregate.sql": "SELECT business_key, COUNT(*) AS row_count, AVG(demand_mwh) AS mean_demand_mwh FROM train GROUP BY business_key ORDER BY business_key;\n",
        "export.sql": "SELECT * FROM train ORDER BY timestamp_utc;\n",
    }
    directory.mkdir(parents=True, exist_ok=True)
    for name, content in queries.items():
        (directory / name).write_text(content, encoding="utf-8")


def write_variants(directory: Path, train: list[dict[str, object]], predict: list[dict[str, object]]) -> list[dict[str, object]]:
    directory.mkdir(parents=True, exist_ok=True)
    common = list(train)
    cases: list[dict[str, object]] = []

    def add(case_id: str, description: str, expected: str, rows: list[dict[str, object]], *, train_case: bool = True, format_name: str = "csv") -> None:
        case_dir = directory / case_id
        case_dir.mkdir(parents=True, exist_ok=True)
        file = case_dir / f"input.{format_name}"
        if format_name == "json":
            write_json(file, rows)
        else:
            write_csv(file, rows, train_case)
        cases.append({"caseId": case_id, "description": description, "file": str(file.relative_to(directory.parent)), "expected": expected})

    add("empty", "Schema with zero records", "EMPTY_INPUT", [], train_case=True)
    missing_target = [dict(row) for row in common]
    missing_target[0][TARGET] = None
    add("missing-target", "Training target is NULL", "INVALID_TARGET", missing_target)
    missing_feature = [dict(row) for row in common]
    missing_feature[0]["temperature_c"] = None
    add("missing-feature", "One feature is NULL", "NULL_FEATURE_OR_MISSING", missing_feature)
    duplicate = [dict(row) for row in common]
    duplicate[1]["business_key"] = duplicate[0]["business_key"]
    duplicate[1]["source_row_id"] = "wb-v1-duplicate-0001"
    add("duplicate-key", "Business key repeats with a distinct source row", "ACCEPT_AND_PRESERVE_ORDINAL", duplicate)
    add("reordered", "Rows are reversed", "ACCEPT_INPUT_ORDER", list(reversed(common)))
    wrong_type = [dict(row) for row in common]
    wrong_type[0]["temperature_c"] = "not-a-number"
    add("wrong-type", "Feature contains unparseable text", "FEATURE_TYPE_MISMATCH", wrong_type)
    non_finite = [dict(row) for row in common]
    non_finite[0]["temperature_c"] = "NaN"
    non_finite[1][TARGET] = "Infinity"
    add("non-finite", "Non-finite feature and target are explicit CSV tokens", "REJECT_TARGET_AND_DEFAULT_REJECT_FEATURE", non_finite)
    over_limit = common + [dict(common[-1], source_row_id=f"wb-v1-over-{i:04d}") for i in range(16)]
    add("over-limit", "Input exceeds the locked 256-row model fixture limit", "INPUT_LIMIT", over_limit)

    # Small type-preservation cases are deliberately separate from model cases.
    edge_rows = [{"empty_string": "", "big_integer": 9007199254740993, "timestamp_utc": "2025-01-01T00:00:00Z", "nullable": None}]
    edge_path = directory / "type-roundtrip" / "input.json"
    edge_path.parent.mkdir(parents=True, exist_ok=True)
    write_json(edge_path, edge_rows)
    cases.append({"caseId": "type-roundtrip", "description": "Empty string, 64-bit integer and NULL", "file": str(edge_path.relative_to(directory.parent)), "expected": "PRESERVE_TYPES"})
    return cases


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def files_for_manifest(root: Path) -> list[dict[str, object]]:
    result = []
    for path in sorted(p for p in root.rglob("*") if p.is_file() and p.name != "manifest.json"):
        result.append({"path": path.relative_to(root).as_posix(), "bytes": path.stat().st_size, "sha256": digest(path)})
    return result


def write_expected_stats(root: Path, train: list[dict[str, object]], predict: list[dict[str, object]]) -> None:
    def table_stats(rows: list[dict[str, object]], names: list[str]) -> dict[str, object]:
        stats: dict[str, object] = {"rows": len(rows), "nulls": {}, "numeric": {}, "keys": {}}
        for name in names:
            values = [row.get(name) for row in rows]
            stats["nulls"][name] = sum(value is None for value in values)  # type: ignore[index]
            if values and all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in values):
                numbers = [float(value) for value in values]
                stats["numeric"][name] = {"min": min(numbers), "max": max(numbers), "mean": round(sum(numbers) / len(numbers), 12)}  # type: ignore[index]
            if name in ("source_row_id", "business_key"):
                stats["keys"][name] = sorted(set(str(value) for value in values))  # type: ignore[index]
        return stats

    names = ["source_row_id", "business_key", *FEATURES, TARGET]
    payload = {
        "schemaVersion": 1,
        "calculation": "Independent deterministic scalar calculation over canonical rows; not read from DuckDB or browser output.",
        "train": table_stats(train, names),
        "predict": table_stats(predict, [name for name in names if name != TARGET]),
        "aggregate": [{"business_key": key, "row_count": sum(row["business_key"] == key for row in train), "mean_demand_mwh": round(sum(float(row[TARGET]) for row in train if row["business_key"] == key) / sum(row["business_key"] == key for row in train), 12)} for key in sorted({str(row["business_key"]) for row in train})],
    }
    path = root / "expected" / "stats.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")


def generate(root: Path, *, force: bool = False) -> dict[str, object]:
    root = root.resolve()
    if root.exists() and any(root.iterdir()) and not force:
        raise RuntimeError(f"Output directory is not empty: {root}; pass --force only for an intentional regeneration")
    if force and root.exists():
        for child in root.iterdir():
            if child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
    root.mkdir(parents=True, exist_ok=True)
    train, predict = canonical_rows()
    normal = root / "normal"
    normal.mkdir()
    for name, writer, is_train, rows in (("train.csv", write_csv, True, train), ("predict.csv", write_csv, False, predict), ("train.parquet", write_parquet, True, train), ("predict.parquet", write_parquet, False, predict), ("train.arrow", write_arrow, True, train), ("predict.arrow", write_arrow, False, predict), ("train.json", write_json, True, train), ("predict.json", write_json, False, predict)):
        writer(normal / name, rows, is_train) if writer is not write_json else writer(normal / name, rows)
    write_duckdb(normal / "sample.duckdb", train, predict)

    (root / "schema.json").write_text(json.dumps(schema(), indent=2) + "\n", encoding="utf-8")
    truth_path = root / "truth" / "predict-targets.csv"
    truth_path.parent.mkdir(parents=True, exist_ok=True)
    write_csv(truth_path, [dict(row_for(TRAIN_ROWS + i, train=True, origin=START + timedelta(hours=TRAIN_ROWS)), source_row_id=f"wb-v1-{TRAIN_ROWS + i:04d}") for i in range(PREDICT_ROWS)], True)
    write_queries(root / "queries")
    cases = write_variants(root / "variants", train, predict)
    (root / "cases.json").write_text(json.dumps({"schemaVersion": 1, "cases": cases}, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    write_expected_stats(root, train, predict)
    readme = """# Tabloom Workbench v1 fixture\n\nDeterministic synthetic hourly demand fixture for offline tests. It contains 256 historical training rows, 32 forecast rows, four ordered numeric features, five equivalent input formats, explicit boundary cases (`cases.json`), and no model weights.\n\nRun `npm --prefix runtime run fixtures:workbench:check` (or the locked `uv` tool directly) before using it. The target is synthetic and has no real business meaning. `truth/predict-targets.csv` is reference-only and must not be imported into the normal prediction table.\n\nThe official TabPFN reference is generated separately by `spikes/tabpfn35/export_workbench_reference.py`; missing model/CUDA prerequisites are errors, never replaced with browser output.\n"""
    (root / "README.md").write_text(readme, encoding="utf-8")
    (root / "LICENSE").write_text("Synthetic fixture data for Tabloom development and tests.\nCopyright (c) 2026 Tabloom contributors.\n", encoding="utf-8")
    manifest = {
        "schemaVersion": 1,
        "datasetId": "tabloom-workbench-v1",
        "generatorVersion": GENERATOR_VERSION,
        "seed": SEED,
        "generatedFrom": "tools/workbench-fixtures/generate.py",
        "counts": {"train": TRAIN_ROWS, "predict": PREDICT_ROWS, "features": len(FEATURES)},
        "formats": ["csv", "parquet", "arrow-ipc", "json", "duckdb"],
        "features": FEATURES,
        "target": TARGET,
        "forecastOrigin": iso(START + timedelta(hours=TRAIN_ROWS)),
        "cases": cases,
        "reference": {"status": "missing", "reason": "Generate with a local official TabPFN checkpoint and CUDA."},
    }
    manifest["files"] = files_for_manifest(root)
    (root / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8")
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=Path("runtime/tests/fixtures/workbench/v1"))
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        print(json.dumps(generate(args.output_dir, force=args.force), indent=2))
        return 0
    except Exception as exc:
        print(f"Fixture generation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
