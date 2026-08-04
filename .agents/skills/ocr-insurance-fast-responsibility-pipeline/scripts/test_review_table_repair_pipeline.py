#!/usr/bin/env python3
"""Focused tests for review table repair coordination."""

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("run_review_table_repair_pipeline.py")
SPEC = importlib.util.spec_from_file_location("review_table_pipeline", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ReviewTableRepairPipelineTests(unittest.TestCase):
    def test_accepts_only_table_numeric_conflicts(self):
        comparison = {
            "materialConflicts": [{
                "type": "numeric_tokens_missing_from_artifact",
                "responsibilityId": "accidental_disability",
                "tokens": ["100%", "90%"],
            }],
        }
        targets, reason = MODULE.table_repair_targets(comparison)
        self.assertIsNone(reason)
        self.assertEqual(
            targets,
            [("accidental_disability", ["100%", "90%"])],
        )

    def test_rejects_mixed_semantic_conflicts(self):
        comparison = {
            "materialConflicts": [
                {
                    "type": "numeric_tokens_missing_from_artifact",
                    "responsibilityId": "a",
                    "tokens": ["100%"],
                },
                {
                    "type": "responsibility_missing",
                    "responsibilityId": "b",
                },
            ],
        }
        targets, reason = MODULE.table_repair_targets(comparison)
        self.assertIsNone(targets)
        self.assertIn("non-table", reason)

    def test_resolves_queue_relative_path(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            queue = root / "queues" / "review.jsonl"
            queue.parent.mkdir()
            target = queue.parent / "artifact.json"
            target.write_text("{}", encoding="utf-8")
            self.assertEqual(
                MODULE.resolve_record_path("artifact.json", queue),
                target.resolve(),
            )

    def test_safe_name_is_stable(self):
        self.assertEqual(MODULE.safe_name("公司 / 产品 A"), "公司-产品-A")


if __name__ == "__main__":
    unittest.main()
