import json
import tempfile
import unittest
from pathlib import Path

from build_responsibility_inventory import (
    build_inventory,
    load_manifest,
    normalize_input_product,
)


class ResponsibilityInventoryTest(unittest.TestCase):
    def test_builds_exact_pre_model_inventory_and_stops_at_exclusions(self):
        source = """
===== PAGE 1 =====
某某保险条款
2.3 保险责任
意外住院津贴保险金
被保险人因意外伤害住院治疗的，我们按实际住院日数给付意外住院津贴保险金。
一般住院津贴保险金
被保险人在等待期后因疾病住院治疗的，我们按实际住院日数给付一般住院津贴保险金。
2.4 责任免除
申请人填写保险金给付申请书。
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试住院津贴保险",
            "sourceUrl": "https://official.example.com/policy.pdf",
            "sourceDigest": "sha256:test",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertTrue(inventory["inventoryBuiltBeforeModel"])
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["意外住院津贴保险金", "一般住院津贴保险金"],
        )
        self.assertTrue(all(item["offsetStatus"] == "exact" for item in inventory["responsibilities"]))
        self.assertTrue(all(item["packetGate"] == "pass" for item in inventory["responsibilities"]))
        self.assertNotIn("保险金给付申请书", str(inventory["responsibilities"]))

    def test_blocks_when_no_responsibility_section_exists(self):
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "无责任章节保险",
        }, "这里只包含投保须知和责任免除。")

        self.assertEqual(inventory["status"], "inventory_blocked")
        self.assertIn("responsibility_section_not_found", inventory["blockers"])
        self.assertEqual(inventory["responsibilities"], [])

    def test_builds_inventory_from_numbered_obligation_sentences(self):
        source = """
===== PAGE 1 =====
第四条 保险责任
在本合同保险期间内，本公司承担以下保险责任：
一、被保险人在养老年金开始领取日前身故，本公司按现金价值给付身故保险金，本合同终止。
二、被保险人生存至养老年金开始领取日，本公司按约定给付养老年金。
第五条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试养老年金保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["身故保险金", "养老年金"],
        )

    def test_rejects_generic_responsibility_heading(self):
        source = """
===== PAGE 1 =====
第五条 保险责任
保险责任
被保险人遭受意外伤害，本公司给付意外伤害保险金。
第六条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试意外伤害保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["意外伤害保险金"],
        )

    def test_infers_generic_death_benefit_from_exact_title_elsewhere(self):
        source = """
===== PAGE 1 =====
第五条 保险责任
被保险人在等待期内因疾病身故，我们退还已交保险费并给付保险金。
被保险人因前述以外情形身故，我们按保险金额给付保险金。
第六条 责任免除
第十条 受益人
投保人可以指定身故保险金受益人。
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试定期寿险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["身故保险金"],
        )
        responsibility = inventory["responsibilities"][0]
        self.assertEqual(responsibility["detectedBy"], "cross_section_official_title")
        self.assertEqual(
            source[responsibility["titleStartOffset"]:responsibility["titleEndOffset"]],
            "身故保险金",
        )
        self.assertIn("给付保险金", responsibility["evidencePacket"])

    def test_rejects_contract_constraint_and_projection_phrases(self):
        source = """
===== PAGE 1 =====
第五条 保险责任
养老年金
被保险人生存至领取日，我们按约定给付养老年金。
身故保险金
被保险人身故，我们给付身故保险金。
本合同的身故保险金和身体高度残疾保险金
两项保险金仅给付一项。
账户价值终身月领（或年领）在养老年金
第六条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试养老年金保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["养老年金", "身故保险金"],
        )

    def test_loads_jsonl_and_normalizes_source_aliases(self):
        with tempfile.TemporaryDirectory() as temporary:
            manifest_path = Path(temporary) / "source-ready.jsonl"
            manifest_path.write_text(
                json.dumps({
                    "company": "测试人寿",
                    "productName": "测试产品",
                    "sourceFile": "/tmp/source.pdf",
                    "responsibilityTextFile": "/tmp/source.txt",
                }, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )

            products = load_manifest(manifest_path)
            product = normalize_input_product(products[0])

            self.assertEqual(product["sourceDocumentPath"], "/tmp/source.pdf")
            self.assertEqual(product["sourceTextPath"], "/tmp/source.txt")

    def test_inline_definition_marker_does_not_end_responsibility_section(self):
        source = """
===== PAGE 1 =====
第四条 保险责任
一、基本部分
1、意外伤害保险金
（1）意外身故保险金
被保险人因遭受意外事故（释义六）身故，我们给付意外身故保险金。
（2）意外伤残保险金
被保险人因遭受意外事故导致伤残，我们给付意外伤残保险金。
第五条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试意外伤害保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["意外身故保险金", "意外伤残保险金"],
        )

    def test_builds_inventory_from_unnumbered_colon_section_and_chinese_list(self):
        source = """
===== PAGE 1 =====
保险责任：
一、生存保险金
被保险人生存至约定领取日，我们按基本保险金额给付生存保险金。
二、身故保险金
被保险人身故，我们按现金价值给付身故保险金。
第五条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试年金保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["生存保险金", "身故保险金"],
        )

    def test_builds_inventory_from_period_terminated_responsibility_title(self):
        source = """
===== PAGE 1 =====
保险责任
一、满期保险金。
被保险人生存至保险期间届满，我们给付满期保险金。
第二条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试两全保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["满期保险金"],
        )

    def test_builds_inventory_when_page_marker_separates_title_and_body(self):
        source = """
PDF_PAGE_1
保险责任：
一、意外身故保险金
PDF_PAGE_2
被保险人因意外伤害身故，我们给付意外身故保险金。
第三条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试意外伤害保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["意外身故保险金"],
        )

    def test_finds_enumerated_heading_after_page_header_noise(self):
        source = """
保险责任：
一、住院医疗保险金
被保险人住院治疗，我们报销住院医疗费用。
PDF_PAGE_2
某某医疗保险条款（第二页）
二、门诊医疗保险金
被保险人接受门诊治疗，我们报销门诊医疗费用。
第三条 责任免除
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试医疗保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["住院医疗保险金", "门诊医疗保险金"],
        )

    def test_accepts_exact_short_annuity_heading(self):
        source = """
保险责任：
年金
我们自年金领取起始日起按年给付年金。
身故保险金
若被保险人身故，我们给付身故保险金。
保险金申请
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试年金保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_ready")
        self.assertEqual(
            [item["officialTitle"] for item in inventory["responsibilities"]],
            ["年金", "身故保险金"],
        )

    def test_does_not_treat_truncated_responsibility_sentence_as_section_heading(self):
        source = """
保险责任。
本合同效力中止后两年内，您可以申请恢复合同效力。
如何领取保险金
受益人申请给付重大疾病保险金时，应提交保险金给付申请书。
对不属于保险责任的，我们将发出拒绝给付保险金通知书。
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试重大疾病保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_blocked")
        self.assertIn("responsibility_section_not_found", inventory["blockers"])
        self.assertEqual(inventory["responsibilities"], [])

    def test_does_not_invent_title_from_service_provider_or_claim_prose(self):
        source = """
保险责任：
一、对于被保险人在指定医疗服务提供单位就医支出的医疗费用，
我们按约定的给付比例给付保险金。
保险金申请
受益人应填写保险金给付申请书。
释义
医疗服务提供单位是指约定医院。
"""
        inventory = build_inventory({
            "company": "测试人寿保险有限公司",
            "productName": "测试团体医疗保险",
        }, source)

        self.assertEqual(inventory["status"], "inventory_blocked")
        self.assertIn("responsibility_title_inventory_empty", inventory["blockers"])
        self.assertEqual(inventory["responsibilities"], [])


if __name__ == "__main__":
    unittest.main()
