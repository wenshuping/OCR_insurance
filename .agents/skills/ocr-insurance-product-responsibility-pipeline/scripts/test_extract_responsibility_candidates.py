#!/usr/bin/env python3

import unittest
from pathlib import Path

from extract_responsibility_candidates import load_rules, retrieve


RULES = load_rules(Path(__file__).with_name("responsibility_retrieval_rules.json"))


class ResponsibilityCandidateTests(unittest.TestCase):
    def test_selects_responsibility_chapter_and_stops_at_exclusions(self):
        source = """PDF_PAGE_1
某某人寿保险条款
PDF_PAGE_2
目录
PDF_PAGE_3
2.3 保险责任
身故保险金
被保险人身故，我们按基本保险金额的100%给付身故保险金。
PDF_PAGE_4
可选责任一
轻度疾病保险金
被保险人确诊轻度疾病，按基本保险金额的20%给付。
PDF_PAGE_5
本项保险责任终止，其他保险责任继续有效。
PDF_PAGE_6
2.4 责任免除
故意行为不承担责任。
PDF_PAGE_7
保险金申请
申请人应提交材料。
PDF_PAGE_8
释义
基本保险金额以保险单为准。"""
        _, report = retrieve(source, "某某重大疾病保险", RULES)
        self.assertEqual(report["mode"], "candidate_pages")
        self.assertEqual(report["sectionRanges"], [{"startPage": 3, "endPage": 6}])
        self.assertIn(4, report["selectedPages"])
        self.assertNotIn(8, report["selectedPages"])

    def test_termination_sentence_is_not_a_new_section_heading(self):
        source = """PDF_PAGE_1
产品条款
PDF_PAGE_2
保险责任
PDF_PAGE_3
满期保险金
给付后本项保险责任终止。
PDF_PAGE_4
责任免除"""
        _, report = retrieve(source, "某某两全保险", RULES)
        self.assertEqual(report["sectionRanges"], [{"startPage": 2, "endPage": 4}])

    def test_uses_full_text_when_no_responsibility_signals_exist(self):
        source = "PDF_PAGE_1\n封面\nPDF_PAGE_2\n普通说明\nPDF_PAGE_3\n其他内容"
        candidate, report = retrieve(source, "未知产品", RULES)
        self.assertEqual(report["mode"], "full_text_fallback")
        self.assertEqual(report["selectedPages"], [1, 2, 3])
        self.assertIn("PDF_PAGE_3", candidate)

    def test_detects_product_pack_and_keeps_table_reference(self):
        source = """PDF_PAGE_1
某某交通意外伤害保险
PDF_PAGE_2
保险责任
航空交通意外身故保险金
按基本保险金额乘以附表《给付系数表》的对应系数给付。
PDF_PAGE_3
责任免除
PDF_PAGE_4
给付系数表
保险期间十年，对应系数为100%。
PDF_PAGE_5
其他内容
PDF_PAGE_6
其他内容"""
        _, report = retrieve(source, "某某交通意外伤害保险", RULES)
        self.assertIn("accident", report["productPacks"])
        self.assertIn(4, report["selectedPages"])

    def test_keeps_layout_table_and_cross_page_continuation(self):
        source = """PDF_PAGE_1
某某高端医疗保险
PDF_PAGE_2
保险责任
住院医疗保险金按附录1保险计划表约定给付。
PDF_PAGE_3
责任免除
PDF_PAGE_4
其他内容
PDF_PAGE_5
PDF_LAYOUT_PAGE_5
附录 1 保险计划表
保险计划 优享计划 尊享计划
累计限额 5万元 10万元
给付比例 90% 100%
PDF_PAGE_6
PDF_LAYOUT_PAGE_6
保险计划 优享计划 尊享计划
给付次数 前8次 第9次及之后
免赔额 0元 500元
PDF_PAGE_7
其他内容"""
        _, report = retrieve(source, "某某高端医疗保险", RULES)
        self.assertIn(5, report["selectedTablePages"])
        self.assertIn(6, report["selectedTablePages"])
        self.assertIn(6, report["selectedPages"])


if __name__ == "__main__":
    unittest.main()
