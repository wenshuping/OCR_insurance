import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from test_validate_artifact import (
    TEST_SOURCE_DOCUMENT,
    artifact_source_text,
    valid_artifact,
)


SCRIPT = Path(__file__).with_name("render_artifact.py")


def render(artifact):
    with tempfile.TemporaryDirectory() as temp_dir:
        path = Path(temp_dir) / "artifact.json"
        source_path = Path(temp_dir) / "official-source.txt"
        document_path = Path(temp_dir) / "official-source.pdf"
        path.write_text(json.dumps(artifact, ensure_ascii=False), encoding="utf-8")
        source_path.write_text(artifact_source_text(artifact), encoding="utf-8")
        document_path.write_bytes(TEST_SOURCE_DOCUMENT)
        return subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--artifact",
                str(path),
                "--source-text",
                str(source_path),
                "--source-document",
                str(document_path),
                "--official-domain",
                "example.invalid",
            ],
            capture_output=True,
            text=True,
            check=False,
        )


class ArtifactRendererTests(unittest.TestCase):
    def test_renders_source_backed_fields_without_rephrasing_timing(self):
        result = render(valid_artifact())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("新华人寿保险股份有限公司", result.stdout)
        self.assertIn("年满22周岁保单生效对应日", result.stdout)
        self.assertIn("（基本保险金额＋累积红利保险金额）×60%", result.stdout)
        self.assertIn("第二项包括深造金、立业金", result.stdout)
        self.assertNotIn("22周岁前", result.stdout)

    def test_refuses_to_render_artifact_that_fails_validation(self):
        artifact = valid_artifact()
        artifact["company"] = "新华保险"
        result = render(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("company", result.stderr)

    def test_renders_identity_fields_that_are_absent_from_official_source(self):
        artifact = valid_artifact()
        identity = artifact["productIdentity"]
        for key in ("filingCode", "filingDate"):
            identity[key] = ""
            identity["fieldEvidence"][key] = {
                "status": "not_present_in_source",
                "reviewScope": "官方条款PDF全部页面",
            }
        result = render(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("条款备案号：官方来源未载明", result.stdout)
        self.assertIn("备案日期：官方来源未载明", result.stdout)

    def test_renders_contract_defined_basis_evidence(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["sourceExcerpt"] += " 按本合同有效保险金额的60%给付。"
        artifact["officialChecklist"][0]["sourceExcerpt"] = responsibility["sourceExcerpt"]
        indicator = responsibility["indicators"][0]
        indicator["formulaText"] = "有效保险金额 × 60%"
        indicator["normalizedFormula"] = "contract_defined_effective_insured_amount * 0.60"
        indicator["basisKey"] = "contract_defined_effective_insured_amount"
        indicator["evidenceTokens"] = ["有效保险金额", "60%"]
        indicator["basisDefinition"] = {
            "term": "有效保险金额",
            "sourcePage": "PDF第10页第6.10条",
            "sourceExcerpt": "有效保险金额主要包括基本保险金额与累计红利保险金额两部分。",
            "evidenceTokens": ["有效保险金额", "基本保险金额", "累计红利保险金额"],
        }
        result = render(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("基数定义：有效保险金额主要包括基本保险金额与累计红利保险金额两部分", result.stdout)

    def test_renders_parent_kind_aggregation_and_comparison_operands(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["parentResponsibilityId"] = "severe_disease_benefit"
        responsibility["responsibilityKind"] = "waiting_period_refund"
        responsibility["coverageAggregation"] = "exclude"
        source = "按基本保险金额对应的现金价值与实际交纳保险费二者之较大者返还。"
        responsibility["sourceExcerpt"] = source
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        indicator = responsibility["indicators"][0]
        indicator.update({
            "formulaText": "基本保险金额对应的现金价值与实际交纳保险费二者之较大者",
            "normalizedFormula": "max(basic_insured_amount_cash_value, actual_paid_premium)",
            "basisKey": "max_of_basic_insured_amount_cash_value_actual_paid_premium",
            "calculationStatus": "needs_table",
            "requiredInputs": ["basic_insured_amount_cash_value", "actual_paid_premium"],
            "evidenceTokens": ["基本保险金额", "现金价值", "实际交纳保险费", "较大者"],
            "operands": [
                {
                    "operandId": "cash_value",
                    "formulaText": "基本保险金额对应的现金价值",
                    "basisKey": "basic_insured_amount_cash_value",
                    "requiredInputs": ["basic_insured_amount_cash_value"],
                    "evidenceTokens": ["基本保险金额", "现金价值"],
                },
                {
                    "operandId": "premium",
                    "formulaText": "实际交纳保险费",
                    "basisKey": "actual_paid_premium",
                    "requiredInputs": ["actual_paid_premium"],
                    "evidenceTokens": ["实际交纳保险费"],
                },
            ],
        })
        result = render(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("父责任分组：`severe_disease_benefit`", result.stdout)
        self.assertIn("责任类型：`waiting_period_refund`", result.stdout)
        self.assertIn("保障汇总：`exclude`", result.stdout)
        self.assertIn("比较项 `cash_value`", result.stdout)

    def test_renders_product_services_outside_responsibilities(self):
        artifact = valid_artifact()
        artifact["productServices"] = [{
            "serviceId": "health-management",
            "title": "健康管理服务",
            "customerSummary": "按服务手册约定提供健康管理服务。",
            "sourcePage": "PDF第12页",
            "sourceExcerpt": "健康管理服务：按服务手册约定提供健康管理服务。",
        }]
        result = render(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("产品服务（不计入保险责任）", result.stdout)
        self.assertIn("健康管理服务", result.stdout)


if __name__ == "__main__":
    unittest.main()
