#!/usr/bin/env python3

import copy
import importlib.util
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("deterministic_table_repair.py")
SPEC = importlib.util.spec_from_file_location("deterministic_table_repair", SCRIPT_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def fixture_artifact():
    return {
        "company": "测试保险股份有限公司",
        "productName": "测试意外伤害保险",
        "responsibilities": [
            {
                "responsibilityId": "accidental_death",
                "liability": "意外身故保险金",
                "sourceExcerpt": "意外身故保险金按基本保险金额给付。",
                "indicators": [{"indicatorName": "身故给付额"}],
            },
            {
                "responsibilityId": "accidental_disability",
                "liability": "意外伤残保险金",
                "evidenceSegments": [
                    {
                        "sourcePage": "3",
                        "sourceExcerpt": (
                            "我们按伤残评定结果所对应的保险金给付比例乘以"
                            "意外身故伤残基本保险金额给付意外伤残保险金。\n"
                            "伤残评定结果所对应的保险金给付比例如下表：\n"
                            "伤残等级 1级 2级 3级 4级 5级 6级 7级 8级 9级 10级"
                        ),
                    },
                    {
                        "sourcePage": "4",
                        "sourceExcerpt": (
                            "给付比例 100% 90% 80% 70% 60% 50% 40% 30% 20% 10%\n"
                            "累计给付以基本保险金额为限。"
                        ),
                    },
                ],
                "indicators": [
                    {
                        "indicatorName": "意外伤残保险金给付额",
                        "formulaText": "意外身故伤残基本保险金额 × 伤残等级对应比例",
                        "normalizedFormula": "insured_amount * disability_ratio",
                        "basisKey": "insured_amount",
                        "calculationKey": "table_lookup_multiplication",
                        "calculationStatus": "needs_table",
                        "calculationEligible": False,
                        "calculationReason": "需要查表",
                        "requiredInputs": [
                            "accidental_death_disability_insured_amount",
                            "disability_level",
                        ],
                        "evidenceTokens": [
                            "意外身故伤残基本保险金额",
                            "保险金给付比例",
                        ],
                        "branches": [],
                        "operands": [],
                    }
                ],
            },
        ],
    }


class DeterministicTableRepairTest(unittest.TestCase):
    def test_repairs_ten_grade_rows_and_only_changes_target_indicator(self):
        source = fixture_artifact()
        expected_non_target = copy.deepcopy(source["responsibilities"][0])
        expected_target_evidence = copy.deepcopy(
            source["responsibilities"][1]["evidenceSegments"]
        )

        repaired, receipt = MODULE.repair_artifact(source, "accidental_disability")

        self.assertEqual(receipt["status"], "auto_merge")
        self.assertEqual(receipt["rowCount"], 10)
        self.assertEqual(
            repaired["responsibilities"][0],
            expected_non_target,
        )
        target = repaired["responsibilities"][1]
        self.assertEqual(target["responsibilityId"], "accidental_disability")
        self.assertEqual(target["evidenceSegments"], expected_target_evidence)
        indicator = target["indicators"][0]
        self.assertEqual(indicator["basisKey"], "piecewise")
        self.assertEqual(indicator["calculationKey"], "branch_based")
        self.assertEqual(indicator["calculationStatus"], "needs_claim_facts")
        self.assertEqual(len(indicator["branches"]), 10)
        self.assertEqual(
            indicator["branches"][0]["evidenceTokens"],
            ["1级", "100%", "意外身故伤残基本保险金额"],
        )
        self.assertEqual(
            indicator["branches"][-1]["evidenceTokens"],
            ["10级", "10%", "意外身故伤残基本保险金额"],
        )
        self.assertIn("10级", indicator["evidenceTokens"])
        self.assertIn("10%", indicator["evidenceTokens"])
        self.assertEqual(source, fixture_artifact())

    def test_rejects_ambiguous_duplicate_header(self):
        source = fixture_artifact()
        source["responsibilities"][1]["evidenceSegments"][1]["sourceExcerpt"] += (
            "\n伤残等级 1级 2级"
        )

        repaired, receipt = MODULE.repair_artifact(source, "accidental_disability")

        self.assertIsNone(repaired)
        self.assertEqual(receipt["status"], "source_repair_required")
        self.assertIn("exactly one", receipt["reason"])

    def test_rejects_mismatched_column_counts(self):
        source = fixture_artifact()
        source["responsibilities"][1]["evidenceSegments"][1]["sourceExcerpt"] = (
            "给付比例 100% 90% 80%"
        )

        repaired, receipt = MODULE.repair_artifact(source, "accidental_disability")

        self.assertIsNone(repaired)
        self.assertEqual(receipt["status"], "source_repair_required")
        self.assertIn("different column counts", receipt["reason"])

    def test_rejects_non_adjacent_value_row(self):
        source = fixture_artifact()
        segments = source["responsibilities"][1]["evidenceSegments"]
        segments.insert(1, {"sourcePage": "3b", "sourceExcerpt": "无关续页"})

        repaired, receipt = MODULE.repair_artifact(source, "accidental_disability")

        self.assertIsNone(repaired)
        self.assertEqual(receipt["status"], "source_repair_required")
        self.assertIn("immediate continuation", receipt["reason"])


if __name__ == "__main__":
    unittest.main()
