import unittest
from unittest.mock import patch

from canonicalize_excerpts import (
    canonical_evidence_segments,
    canonical_excerpt,
    canonicalize,
    canonicalize_to_fixed_point,
    compact_with_positions,
)


SOURCE = """1、大学教育金 被保险人生存至十八——二十一周岁（详见释义）生效对应日，
本公司按有效保险金额（详见释义）的20%给付大学教育金。
被保险人身故时，按已交保险费给付。
以上已交保险费不包括因健康原因增加的保险费。
给付后本合同终止。"""


class CanonicalExcerptTests(unittest.TestCase):
    def setUp(self):
        self.compact, self.positions = compact_with_positions(SOURCE)

    def canonicalize(self, excerpt):
        return canonical_excerpt(excerpt, SOURCE, self.compact, self.positions)

    def test_keeps_exact_excerpt(self):
        excerpt = "本公司按有效保险金额（详见释义）的20%给付大学教育金。"
        self.assertEqual(self.canonicalize(excerpt), excerpt)

    def test_restores_omitted_parenthetical(self):
        result = self.canonicalize(
            "被保险人生存至十八——二十一周岁生效对应日，本公司按有效保险金额的20%给付大学教育金。"
        )
        self.assertIn("（详见释义）", result)
        self.assertIn("有效保险金额（详见释义）", result)

    def test_restores_skipped_middle_paragraph(self):
        result = self.canonicalize("被保险人身故时，按已交保险费给付。给付后本合同终止。")
        self.assertIn("以上已交保险费不包括因健康原因增加的保险费。", result)

    def test_restores_footnote_without_consuming_the_next_branch(self):
        source = """一、如果被保险人在等待期内因意外伤害事故6以外的原因导致身故，我们按保单账户价值给付。\n二、如果被保险人等待期后身故，我们按保险金额给付。"""
        source_compact, positions = compact_with_positions(source)
        result = canonical_excerpt(
            "如果被保险人在等待期内因意外伤害事故以外的原因导致身故，",
            source,
            source_compact,
            positions,
        )
        self.assertEqual(result, "如果被保险人在等待期内因意外伤害事故6以外的原因导致身故，")

    def test_does_not_repair_paraphrased_claim(self):
        self.assertIsNone(self.canonicalize("客户身故以后，公司会赔一笔钱。"))

    def test_splits_exact_segments_around_inserted_footnote(self):
        source = "住院医疗保险金：合理且必要5的医疗费用。\n5合理且必要是指符合通常惯例。\n依照约定给付住院医疗保险金。"
        source_compact, positions = compact_with_positions(source)
        segments = canonical_evidence_segments(
            "住院医疗保险金：合理且必要的医疗费用。依照约定给付住院医疗保险金。",
            source,
            source_compact,
            positions,
            source_page="PDF第3-4页",
        )
        self.assertGreaterEqual(len(segments), 2)
        self.assertTrue(all(segment["sourceExcerpt"] in source for segment in segments))

    def test_splits_exact_excerpt_around_pdf_page_marker(self):
        source = "按累计交清增额\n\nPDF_PAGE_4\n\n基本保险金额给付满期保险金。"
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "sourcePage": "PDF第3-4页",
            "sourceExcerpt": source,
        }
        changed, unresolved = canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(unresolved, [])
        self.assertIn("artifact.sourceExcerpt", changed)
        self.assertNotIn("sourceExcerpt", artifact)
        self.assertEqual(
            [segment["sourceExcerpt"] for segment in artifact["evidenceSegments"]],
            ["按累计交清增额", "基本保险金额给付满期保险金。"],
        )

    def test_splits_exact_excerpt_around_layout_page_marker(self):
        source = "普通条款文字\n\nPDF_LAYOUT_PAGE_14\n\n给付比例 90% 100%"
        source_compact, positions = compact_with_positions(source)
        artifact = {"sourcePage": "PDF第14页", "sourceExcerpt": source}
        canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(
            [segment["sourceExcerpt"] for segment in artifact["evidenceSegments"]],
            ["普通条款文字", "给付比例 90% 100%"],
        )

    def test_flattens_page_markers_inside_existing_evidence_segments(self):
        source = "K值表\n\nPDF_PAGE_3\n\n到达年龄计算公式。"
        source_compact, positions = compact_with_positions(source)
        artifact = {"evidenceSegments": [{
            "sourcePage": "PDF第2页",
            "sourceExcerpt": source,
        }]}
        canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(
            [segment["sourceExcerpt"] for segment in artifact["evidenceSegments"]],
            ["K值表", "到达年龄计算公式。"],
        )

    def test_canonicalizes_branch_condition_against_parent_evidence(self):
        source = "如果被保险人在等待期内因意外伤害事故6以外的原因导致身故，我们按保单账户价值给付。"
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "sourceExcerpt": source,
            "indicators": [{
                "branches": [{
                    "conditionText": "如果被保险人在等待期内因意外伤害事故以外的原因导致身故，"
                }]
            }],
        }
        changed, unresolved = canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(unresolved, [])
        self.assertIn("artifact.indicators[0].branches[0].conditionText", changed)
        self.assertEqual(
            artifact["indicators"][0]["branches"][0]["conditionText"],
            "如果被保险人在等待期内因意外伤害事故6以外的原因导致身故，",
        )

    def test_removes_internal_page_marker_from_cross_page_branch_condition(self):
        source = "被保险人于90日内因疾病原因，由本\n\nPDF_PAGE_4\n\n公司认可医院确诊重大疾病。"
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "evidenceSegments": [
                {"sourcePage": "PDF第3页", "sourceExcerpt": "被保险人于90日内因疾病原因，由本"},
                {"sourcePage": "PDF第4页", "sourceExcerpt": "公司认可医院确诊重大疾病。"},
            ],
            "indicators": [{
                "branches": [{
                    "conditionText": "被保险人于90日内因疾病原因，由本\n\nPDF_PAGE_4\n\n公司认可医院确诊重大疾病。"
                }]
            }],
        }

        changed, unresolved = canonicalize(artifact, source, source_compact, positions)

        self.assertEqual(unresolved, [])
        self.assertIn("artifact.indicators[0].branches[0].conditionText", changed)
        self.assertEqual(
            artifact["indicators"][0]["branches"][0]["conditionText"],
            "被保险人于90日内因疾病原因，由本\n\n公司认可医院确诊重大疾病。",
        )

    def test_adds_exact_source_segment_when_branch_evidence_is_missing(self):
        source = """1.累计医疗费用的有效金额≤免赔额，则应给付的保险金=0。\n2.累计医疗费用的有效金额>免赔额，则按约定比例给付。"""
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "sourceExcerpt": "2.累计医疗费用的有效金额>免赔额，则按约定比例给付。",
            "calculation": {
                "branches": [{
                    "conditionText": "累计医疗费用的有效金额≤免赔额",
                    "evidenceTokens": ["≤", "免赔额", "0"],
                }]
            },
        }
        changed, unresolved = canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(unresolved, [])
        self.assertNotIn("artifact.calculation.branches[0].conditionText", changed)
        evidence = "".join(segment["sourceExcerpt"] for segment in artifact["evidenceSegments"])
        self.assertIn("累计医疗费用的有效金额≤免赔额", evidence)
        self.assertIn("累计医疗费用的有效金额>免赔额", evidence)

    def test_adds_exact_source_context_for_evidence_token_from_another_clause(self):
        source = """住院医疗保险金按实际费用给付。
补偿原则：最高给付金额不超过实际费用扣除已获补偿后的余额。
年度累计给付不超过累计限额。"""
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "sourceExcerpt": "住院医疗保险金按实际费用给付。",
            "indicators": [{
                "formulaText": "年度累计给付不超过累计限额",
                "evidenceTokens": ["累计限额"],
            }],
        }
        changed, unresolved = canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(unresolved, [])
        evidence = "".join(segment["sourceExcerpt"] for segment in artifact["evidenceSegments"])
        self.assertIn("年度累计给付不超过累计限额", evidence)
        self.assertIn("累计限额", artifact["indicators"][0]["evidenceTokens"])

    def test_fills_missing_branch_evidence_token_from_exact_formula(self):
        source = "累计费用超过免赔额时，按约定比例给付。"
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "sourceExcerpt": source,
            "calculation": {"branches": [{
                "conditionText": "累计费用超过免赔额时",
                "formulaText": "按约定比例给付",
                "evidenceTokens": [],
            }]},
        }
        changed, unresolved = canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(unresolved, [])
        self.assertEqual(
            artifact["calculation"]["branches"][0]["evidenceTokens"],
            ["按约定比例给付"],
        )

    def test_rebuilds_optional_group_evidence_with_all_child_headings(self):
        source = """可选责任E\nE.1 门诊医生费\n按约定给付。\nE.2 处方药费\n按约定给付。"""
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "officialChecklist": [
                {"responsibilityId": "e1", "officialHeading": "E.1 门诊医生费"},
                {"responsibilityId": "e2", "officialHeading": "E.2 处方药费"},
            ],
            "officialOptionalGroupChecklist": [{
                "groupId": "E", "officialLabel": "可选责任E",
                "childResponsibilityIds": ["e1", "e2"],
                "sourcePage": "PDF第3页", "sourceExcerpt": "可选责任E E.1 门诊医生费",
            }],
            "optionalGroups": [{
                "groupId": "E", "label": "可选责任E", "selectionStatus": "unknown",
                "childResponsibilityIds": ["e1", "e2"],
                "sourcePage": "PDF第3页", "sourceExcerpt": "可选责任E E.1 门诊医生费",
            }],
        }
        canonicalize(artifact, source, source_compact, positions)
        official = artifact["officialOptionalGroupChecklist"][0]["sourceExcerpt"]
        generated = artifact["optionalGroups"][0]["sourceExcerpt"]
        self.assertEqual(official, generated)
        self.assertIn("E.2 处方药费", official)
        self.assertIn(official, source)

    def test_rebuilds_optional_group_evidence_when_pdf_columns_reorder_children(self):
        source = """E.2 处方药费\n按约定给付。\n可选责任E\nE.1 门诊医生费\n按约定给付。"""
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "officialChecklist": [
                {"responsibilityId": "e1", "officialHeading": "E.1 门诊医生费"},
                {"responsibilityId": "e2", "officialHeading": "E.2 处方药费"},
            ],
            "officialOptionalGroupChecklist": [{
                "groupId": "E", "officialLabel": "可选责任E",
                "childResponsibilityIds": ["e1", "e2"],
                "sourcePage": "PDF第3页", "sourceExcerpt": "可选责任E E.1 门诊医生费",
            }],
            "optionalGroups": [{
                "groupId": "E", "label": "可选责任E", "selectionStatus": "unknown",
                "childResponsibilityIds": ["e1", "e2"],
                "sourcePage": "PDF第3页", "sourceExcerpt": "可选责任E E.1 门诊医生费",
            }],
        }
        canonicalize(artifact, source, source_compact, positions)
        official = artifact["officialOptionalGroupChecklist"][0]["sourceExcerpt"]
        self.assertIn("E.1 门诊医生费", official)
        self.assertIn("E.2 处方药费", official)
        self.assertEqual(official, artifact["optionalGroups"][0]["sourceExcerpt"])

    def test_rebuilds_group_evidence_when_numbered_children_share_parent_heading(self):
        source = """PDF_PAGE_2
2.5 年金给付方式 年金给付方式有平准给付、增额给付二种。
PDF_PAGE_3
年金 (1)平准给付：每年按保险金额给付一次年金。
(2)增额给付：以后每年按固定额度增加一次。"""
        source_compact, positions = compact_with_positions(source)
        artifact = {
            "officialChecklist": [
                {"responsibilityId": "level", "officialHeading": "年金(1)平准给付"},
                {"responsibilityId": "increasing", "officialHeading": "年金(2)增额给付"},
            ],
            "officialOptionalGroupChecklist": [{
                "groupId": "annuity", "officialLabel": "年金给付方式",
                "childResponsibilityIds": ["level", "increasing"],
                "sourcePage": "PDF第3页", "sourceExcerpt": "(1)平准给付",
            }],
            "optionalGroups": [{
                "groupId": "annuity", "label": "年金给付方式", "selectionStatus": "unknown",
                "childResponsibilityIds": ["level", "increasing"],
                "sourcePage": "PDF第3页", "sourceExcerpt": "(1)平准给付",
            }],
        }
        canonicalize(artifact, source, source_compact, positions)
        official = artifact["officialOptionalGroupChecklist"][0]
        evidence = "".join(segment["sourceExcerpt"] for segment in official["evidenceSegments"])
        self.assertIn("年金给付方式", evidence)
        self.assertIn("年金 (1)平准给付", evidence)
        self.assertIn("(2)增额给付", evidence)
        self.assertEqual(
            official["evidenceSegments"],
            artifact["optionalGroups"][0]["evidenceSegments"],
        )

    def test_normalizes_comparison_basis_and_operand_inputs(self):
        source = "给付实际费用与年度限额二者较大者。"
        source_compact, positions = compact_with_positions(source)
        artifact = {"sourceExcerpt": source, "indicators": [{
            "formulaText": "实际费用与年度限额二者较大者",
            "normalizedFormula": "max(actual_expense, annual_limit)",
            "basisKey": "piecewise", "calculationKey": "piecewise",
            "operands": [
                {"basisKey": "actual_expense", "requiredInputs": []},
                {"basisKey": "annual_limit", "requiredInputs": []},
            ],
        }]}
        canonicalize(artifact, source, source_compact, positions)
        indicator = artifact["indicators"][0]
        self.assertEqual(indicator["basisKey"], "max_of_actual_expense_annual_limit")
        self.assertEqual(indicator["calculationKey"], "maximum_of_bases")
        self.assertEqual(indicator["operands"][0]["requiredInputs"], ["actual_expense"])

    def test_classifies_waiting_period_refund(self):
        source = "等待期内发生保险事故，我们退还已交保险费。"
        source_compact, positions = compact_with_positions(source)
        artifact = {"liability": "等待期保险费返还", "sourceExcerpt": source}
        canonicalize(artifact, source, source_compact, positions)
        self.assertEqual(artifact["responsibilityKind"], "waiting_period_refund")
        self.assertEqual(artifact["coverageAggregation"], "exclude")

    def test_fixed_point_runs_until_stable(self):
        artifact = {"stage": 0}

        def normalize(value, *_args, **_kwargs):
            if value["stage"] < 2:
                value["stage"] += 1
                return ["artifact.stage"], []
            return [], []

        with patch("canonicalize_excerpts.canonicalize", side_effect=normalize):
            passes, unresolved, converged = canonicalize_to_fixed_point(
                artifact,
                "source",
                "source",
                list(range(6)),
            )

        self.assertEqual(artifact["stage"], 2)
        self.assertEqual(len(passes), 3)
        self.assertTrue(passes[-1]["stable"])
        self.assertTrue(converged)
        self.assertEqual(unresolved, [])

    def test_fixed_point_stops_after_three_changing_passes(self):
        artifact = {"stage": 0}

        def normalize(value, *_args, **_kwargs):
            value["stage"] += 1
            return ["artifact.stage"], []

        with patch("canonicalize_excerpts.canonicalize", side_effect=normalize):
            passes, _, converged = canonicalize_to_fixed_point(
                artifact,
                "source",
                "source",
                list(range(6)),
            )

        self.assertEqual(artifact["stage"], 3)
        self.assertEqual(len(passes), 3)
        self.assertFalse(converged)


if __name__ == "__main__":
    unittest.main()
