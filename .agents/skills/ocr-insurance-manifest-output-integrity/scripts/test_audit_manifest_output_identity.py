#!/usr/bin/env python3
import json
import unittest
from pathlib import Path

from audit_manifest_output_identity import audit


FIXTURES = Path(__file__).parents[1] / "references"


class ManifestOutputIdentityTests(unittest.TestCase):
    def load(self, name):
        return json.loads((FIXTURES / name).read_text(encoding="utf-8"))

    def test_focused_v2_regression_blocks_all_identity_failures(self):
        report = audit(self.load("fixture-focused-v2.json"))
        codes = {issue["code"] for issue in report["issues"]}
        self.assertEqual(report["status"], "identity_blocked")
        self.assertEqual(set(report["failureStatuses"]), {"identity_blocked", "manifest_output_identity_misaligned"})
        for code in {
            "missing_item",
            "duplicate_item",
            "ordinal_mismatch",
            "resume_copied_last_item",
            "artifact_container_identity_mismatch",
            "version_conflict",
            "validator_before_identity_gate",
            "approved_identity_reuse_blocked",
            "terminal_intersection",
        }:
            self.assertIn(code, codes)

    def test_healthy_fixture_passes(self):
        report = audit(self.load("fixture-healthy.json"))
        self.assertEqual(report["status"], "pass")
        self.assertTrue(report["identityGatePassed"])
        self.assertTrue(report["terminalUnionEqualsManifest"])
        self.assertTrue(report["terminalIntersectionsZero"])
        self.assertEqual(report["issues"], [])


if __name__ == "__main__":
    unittest.main()
