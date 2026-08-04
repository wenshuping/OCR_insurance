#!/usr/bin/env python3

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("audit_forward_test.py")
SPEC = importlib.util.spec_from_file_location("critical_illness_audit", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class AuditForwardTest(unittest.TestCase):
    def test_simple_route_requires_single_non_complex_disease_benefit(self):
        payload = {
            "responsibilities": [
                {
                    "responsibilityId": "critical",
                    "liability": "重大疾病保险金",
                    "indicators": [{"calculationStatus": "display_only"}],
                }
            ]
        }
        patterns = MODULE.derive_patterns(payload)
        self.assertIn("single_pay", patterns)
        self.assertEqual("deepseek-standard", MODULE.route_for(payload, patterns))

    def test_grouped_multiple_routes_to_luna(self):
        payload = {
            "responsibilities": [
                {"responsibilityId": "first", "liability": "第一次重度疾病保险金"},
                {"responsibilityId": "second", "liability": "第二次重度疾病保险金"},
            ],
            "productOverview": {"importantLimits": ["重度疾病分组，累计给付六次"]},
        }
        patterns = MODULE.derive_patterns(payload)
        self.assertIn("grouped_multiple", patterns)
        self.assertEqual("luna-complex", MODULE.route_for(payload, patterns))

    def test_definition_candidate_is_rejected_without_disease_dictionary(self):
        fixture = {
            "fixtureId": "definition-boundary",
            "contractTopology": "standalone",
            "topologyEvidence": "独立合同。",
            "sourceText": "独立合同。疾病定义 本病种定义如下。",
            "candidates": [
                {
                    "heading": "疾病定义",
                    "sectionType": "definition",
                    "evidence": "疾病定义 本病种定义如下。"
                }
            ],
            "expected": {
                "acceptedHeadings": [],
                "rejectedHeadings": ["疾病定义"],
                "patterns": ["false_heading_gate"]
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fixture.json"
            path.write_text(json.dumps(fixture, ensure_ascii=False), encoding="utf-8")
            result = MODULE.validate_fixture(path)
        self.assertEqual("passed", result["status"])
        self.assertEqual(0, result["acceptedCount"])

    def test_formula_gate_rejects_max_without_operands(self):
        payload = {
            "responsibilities": [
                {
                    "responsibilityId": "critical",
                    "liability": "重大疾病保险金",
                    "sourceExcerpt": "按基本保险金额和现金价值的较大者给付",
                    "indicators": [
                        {
                            "formulaText": "按较大者给付",
                            "normalizedFormula": "max(basic_insurance_amount,cash_value)",
                            "basisKey": "max_of_basic_insurance_amount_cash_value",
                            "calculationStatus": "needs_table",
                            "requiredInputs": ["basic_insurance_amount", "cash_value"],
                            "evidenceTokens": ["较大者"],
                            "operands": []
                        }
                    ]
                }
            ]
        }
        result = MODULE.audit_formula(payload)
        self.assertEqual("failed", result["status"])
        self.assertTrue(any(item["issue"] == "comparison_without_operands" for item in result["issues"]))


if __name__ == "__main__":
    unittest.main()
