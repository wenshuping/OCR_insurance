#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
SKILL_DIR = SCRIPT_DIR.parent
SPEC = importlib.util.spec_from_file_location(
    "validate_unified_parser", SCRIPT_DIR / "validate_unified_parser.py"
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load validate_unified_parser.py")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class UnifiedParserFixtureTest(unittest.TestCase):
    def test_required_fixture_matrix_passes(self) -> None:
        result = VALIDATOR.validate_fixtures(SKILL_DIR / "fixtures")
        self.assertTrue(result["ok"])
        self.assertGreaterEqual(result["fixtureCount"], 12)
        self.assertEqual(set(result["topologies"]), VALIDATOR.TOPOLOGIES)
        self.assertGreater(result["routes"]["deepseek-standard"], 0)
        self.assertGreater(result["routes"]["luna-complex"], 0)
        self.assertGreater(result["ownerConflictFixtures"], 0)

    def test_duplicate_owner_is_rejected_without_review_contract(self) -> None:
        fixture_source = json.loads(
            (SKILL_DIR / "fixtures" / "compositions.json").read_text(encoding="utf-8")
        )
        fixture = fixture_source[0]
        fixture["inventory"][0]["ownerProposals"] = ["medical_health", "accident"]
        fixture["inventory"][0].pop("ownerProfile")
        with tempfile.TemporaryDirectory() as directory:
            fixture_dir = Path(directory)
            (fixture_dir / "invalid.json").write_text(
                json.dumps([fixture], ensure_ascii=False), encoding="utf-8"
            )
            with self.assertRaises(VALIDATOR.ValidationError):
                VALIDATOR.validate_fixtures(fixture_dir)

    def test_deepseek_cannot_own_complex_domain_fixture(self) -> None:
        fixture_source = json.loads(
            (SKILL_DIR / "fixtures" / "compositions.json").read_text(encoding="utf-8")
        )
        fixture = fixture_source[0]
        fixture["expected"]["route"] = "deepseek-standard"
        with tempfile.TemporaryDirectory() as directory:
            fixture_dir = Path(directory)
            (fixture_dir / "invalid.json").write_text(
                json.dumps([fixture], ensure_ascii=False), encoding="utf-8"
            )
            with self.assertRaises(VALIDATOR.ValidationError):
                VALIDATOR.validate_fixtures(fixture_dir)


if __name__ == "__main__":
    unittest.main()
