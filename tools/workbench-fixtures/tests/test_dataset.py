from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check import validate
from generate import FEATURES, PREDICT_ROWS, TRAIN_ROWS


ROOT = Path(__file__).resolve().parents[3] / "runtime/tests/fixtures/workbench/v1"


class WorkbenchFixtureTest(unittest.TestCase):
    def test_manifest_shape_and_formats(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["counts"], {"train": TRAIN_ROWS, "predict": PREDICT_ROWS, "features": 4})
        self.assertEqual(manifest["features"], FEATURES)
        self.assertEqual(set(manifest["formats"]), {"csv", "parquet", "arrow-ipc", "json", "duckdb"})

    def test_all_normal_formats_have_equivalent_rows(self) -> None:
        report = validate(ROOT, require_reference=False)
        self.assertEqual(report["errors"], [])
        self.assertEqual(report["status"], "passed")
        self.assertLessEqual(report["totalBytes"], 10 * 1024 * 1024)

    def test_boundary_cases_are_declared(self) -> None:
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        cases_file = json.loads((ROOT / "cases.json").read_text(encoding="utf-8"))
        cases = {case["caseId"] for case in manifest["cases"]}
        self.assertTrue({"empty", "missing-target", "missing-feature", "duplicate-key", "reordered", "wrong-type", "non-finite", "over-limit"} <= cases)
        self.assertEqual(cases, {case["caseId"] for case in cases_file["cases"]})


if __name__ == "__main__":
    unittest.main()
