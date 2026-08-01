#!/usr/bin/env python3
"""Focused tests for deterministic standard/complex model routing."""

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("prepare_dual_pool_batch.py")
SPEC = importlib.util.spec_from_file_location("prepare_dual_pool_batch", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PrepareDualPoolBatchTests(unittest.TestCase):
    def test_medical_and_critical_illness_categories_route_to_luna(self):
        for name in (
            "某某重大疾病保险",
            "某某百万医疗保险",
            "某某特定疾病保险",
        ):
            with self.subTest(name=name):
                self.assertEqual(
                    MODULE.classify({"productName": name}),
                    ("luna_review", ["medical_or_critical_illness_category"]),
                )

    def test_other_category_alone_stays_standard(self):
        self.assertEqual(
            MODULE.classify({"productName": "某某养老年金保险（分红型）"}),
            ("standard_gemini", []),
        )

    def test_simple_critical_illness_still_routes_to_luna_by_category(self):
        product = {
            "productName": "某某重大疾病保险",
            "existingResponsibilityHint": (
                "若被保险人首次确诊本合同约定的重大疾病，我们按基本保险金额"
                "给付重大疾病保险金，本合同终止。"
            ),
        }
        self.assertEqual(
            MODULE.classify(product),
            ("luna_review", ["medical_or_critical_illness_category"]),
        )

    def test_illness_tiers_are_strong_complex_evidence(self):
        route, reasons = MODULE.classify({
            "existingResponsibilityHint": (
                "轻症疾病保险金按基本保险金额30%给付。"
                "中症疾病保险金按基本保险金额60%给付。"
            ),
        })
        self.assertEqual(route, "luna_review")
        self.assertIn("illness_tiers", reasons)

    def test_medical_formula_and_limit_route_to_luna(self):
        route, reasons = MODULE.classify({
            "existingResponsibilityHint": (
                "合理医疗费用扣除免赔额后按约定赔付比例给付，"
                "各项责任适用年度累计给付限额。"
            ),
        })
        self.assertEqual(route, "luna_review")
        self.assertIn("medical_formula", reasons)
        self.assertIn("medical_limits", reasons)

    def test_simple_annuity_schedule_stays_standard(self):
        product = {
            "productName": "某某养老年金保险",
            "existingResponsibilityHint": (
                "若被保险人在每个保单周年日生存，我们按基本保险金额"
                "给付养老年金。"
            ),
        }
        self.assertEqual(MODULE.classify(product), ("standard_gemini", []))

    def test_annuity_with_options_routes_to_luna(self):
        route, reasons = MODULE.classify({
            "existingResponsibilityHint": (
                "若被保险人在每个保单周年日生存，我们给付养老年金。"
                "领取频次可选择年领或月领。"
            ),
        })
        self.assertEqual(route, "luna_review")
        self.assertIn("scheduled_cashflow", reasons)
        self.assertIn("schedule_options", reasons)

    def test_prior_validation_review_routes_to_luna_without_hint(self):
        self.assertEqual(
            MODULE.classify({"validationStatus": "validation-review"}),
            ("luna_review", ["prior_review"]),
        )


if __name__ == "__main__":
    unittest.main()
