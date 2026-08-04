import json
import hashlib
import subprocess
import sys
import tempfile
import unittest
from copy import deepcopy
from pathlib import Path


SCRIPT = Path(__file__).with_name("validate_artifact.py")
TEST_SOURCE_DOCUMENT = b"ocr-insurance-validator-test-source"
TEST_SOURCE_DIGEST = "sha256:" + hashlib.sha256(TEST_SOURCE_DOCUMENT).hexdigest()


def valid_artifact():
    responsibility_id = "sec2.3.1-optional2-advanced"
    source_excerpt = "深造金、立业金：年满22周岁保单生效对应日生存，按基本保险金额与累积红利保险金额之和的60%给付深造金。"
    return {
        "company": "新华人寿保险股份有限公司",
        "displayCompany": "新华保险",
        "productName": "示例少儿两全保险（分红型）",
        "productIdentity": {
            "filingCode": "新华保险〔2010〕两全保险012号",
            "productCode": "66020101",
            "filingDate": "2010-05",
            "sourceUrl": "https://example.invalid/official.pdf",
            "sourceDigest": TEST_SOURCE_DIGEST,
            "fieldEvidence": {
                "filingCode": {
                    "status": "verified",
                    "sourceUrl": "https://example.invalid/official.pdf",
                    "sourcePage": "PDF封面",
                    "sourceExcerpt": "条款备案号：新华保险〔2010〕两全保险012号",
                },
                "productCode": {
                    "status": "verified",
                    "sourceUrl": "https://example.invalid/product?riskCode=66020101",
                    "sourcePage": "官网产品页",
                    "sourceExcerpt": "产品代码66020101",
                },
                "filingDate": {
                    "status": "verified",
                    "sourceUrl": "https://example.invalid/official.pdf",
                    "sourcePage": "PDF封面",
                    "sourceExcerpt": "2010年5月备案",
                },
            },
        },
        "optionalGroups": [{
            "groupId": "optional_survival_2",
            "label": "可选生存保险金第二项（深造金、立业金）",
            "selectionStatus": "unknown",
            "childResponsibilityIds": [responsibility_id],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": "第二项包括深造金、立业金。",
        }],
        "officialOptionalGroupChecklist": [{
            "groupId": "optional_survival_2",
            "officialLabel": "第二项",
            "childResponsibilityIds": [responsibility_id],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": "第二项包括深造金、立业金。",
        }],
        "officialChecklist": [{
            "responsibilityId": responsibility_id,
            "officialHeading": "深造金",
            "sourcePage": "PDF第3页",
            "sourceExcerpt": source_excerpt,
        }],
        "responsibilities": [{
            "responsibilityId": responsibility_id,
            "liability": "深造金",
            "groupId": "optional_survival_2",
            "selectionStatus": "unknown",
            "triggerCondition": "第二项可选责任已选且年满22周岁保单生效对应日生存",
            "insurerObligation": "按基本保险金额与累积红利保险金额之和的60%给付",
            "importantLimits": ["与立业金共用第二项可选责任的选择状态"],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": source_excerpt,
            "card": {
                "title": "深造金（可选）",
                "customerSummary": "若选择第二项可选责任，年满22周岁保单生效对应日生存可领取深造金。",
                "benefitExplanation": "按基本保险金额与累积红利保险金额之和的60%给付。",
            },
            "indicators": [{
                "indicatorName": "深造金给付额",
                "formulaText": "（基本保险金额＋累积红利保险金额）×60%",
                "normalizedFormula": "(insured_amount + accumulated_dividend_insured_amount) * 0.60",
                "basisKey": "insured_amount_plus_accumulated_dividend_insured_amount",
                "calculationKey": "percent_of_combined_insured_amount",
                "calculationStatus": "display_only",
                "calculationEligible": False,
                "calculationReason": "未提供当前保单保险金额",
                "requiredInputs": ["insured_amount", "accumulated_dividend_insured_amount"],
                "evidenceTokens": ["22周岁", "基本保险金额", "累积红利保险金额", "60%"],
            }],
        }],
        "audit": {
            "status": "approved",
            "officialChecklistCount": 1,
            "inventoryCount": 1,
            "cardCount": 1,
            "indicatorDecisionCount": 1,
            "matrix": [{
                "responsibilityId": responsibility_id,
                "inventory": "pass",
                "card": "pass",
                "indicatorDecision": "pass",
                "formulaEvidence": "pass",
                "selectionEvidence": "pass",
                "productVersion": "pass",
                "result": "pass",
                "issues": [],
            }],
            "issues": [],
        },
        "publication": {"sqlite": "not_requested", "feishu": "not_requested"},
    }


def two_optional_group_artifact():
    artifact = valid_artifact()
    template = artifact["responsibilities"][0]
    specs = [
        ("optional-high-school", "高中教育金", "optional_survival_1"),
        ("optional-advanced", "深造金", "optional_survival_2"),
        ("optional-career", "立业金", "optional_survival_2"),
    ]
    responsibilities = []
    checklist = []
    matrix = []
    for responsibility_id, heading, group_id in specs:
        responsibility = deepcopy(template)
        responsibility["responsibilityId"] = responsibility_id
        responsibility["liability"] = heading
        responsibility["groupId"] = group_id
        responsibility["card"]["title"] = f"{heading}（可选）"
        responsibilities.append(responsibility)
        checklist.append({
            "responsibilityId": responsibility_id,
            "officialHeading": heading,
            "sourcePage": "PDF第3页",
            "sourceExcerpt": responsibility["sourceExcerpt"],
        })
        row = deepcopy(artifact["audit"]["matrix"][0])
        row["responsibilityId"] = responsibility_id
        matrix.append(row)
    artifact["responsibilities"] = responsibilities
    artifact["officialChecklist"] = checklist
    artifact["optionalGroups"] = [
        {
            "groupId": "optional_survival_1",
            "label": "第一项（高中教育金）",
            "selectionStatus": "unknown",
            "childResponsibilityIds": ["optional-high-school"],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": "第一项包括高中教育金。",
        },
        {
            "groupId": "optional_survival_2",
            "label": "第二项（深造金、立业金）",
            "selectionStatus": "unknown",
            "childResponsibilityIds": ["optional-advanced", "optional-career"],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": "第二项包括深造金、立业金。",
        },
    ]
    artifact["officialOptionalGroupChecklist"] = [
        {
            "groupId": "optional_survival_1",
            "officialLabel": "第一项",
            "childResponsibilityIds": ["optional-high-school"],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": "第一项包括高中教育金。",
        },
        {
            "groupId": "optional_survival_2",
            "officialLabel": "第二项",
            "childResponsibilityIds": ["optional-advanced", "optional-career"],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": "第二项包括深造金、立业金。",
        },
    ]
    artifact["audit"].update({
        "officialChecklistCount": 3,
        "inventoryCount": 3,
        "cardCount": 3,
        "indicatorDecisionCount": 3,
        "matrix": matrix,
    })
    return artifact


def maximum_comparison_artifact():
    artifact = valid_artifact()
    responsibility = artifact["responsibilities"][0]
    source = "按基本保险金额对应的现金价值与实际交纳保险费二者之较大者给付身故保险金。"
    responsibility["sourceExcerpt"] = source
    artifact["officialChecklist"][0]["sourceExcerpt"] = source
    indicator = responsibility["indicators"][0]
    indicator.update({
        "formulaText": "基本保险金额对应的现金价值与实际交纳保险费二者之较大者",
        "normalizedFormula": "max(basic_insured_amount_cash_value, actual_paid_premium)",
        "basisKey": "max_of_basic_insured_amount_cash_value_actual_paid_premium",
        "calculationKey": "maximum_of_bases",
        "calculationStatus": "needs_table",
        "requiredInputs": ["basic_insured_amount_cash_value", "actual_paid_premium"],
        "evidenceTokens": ["基本保险金额", "现金价值", "实际交纳保险费", "较大者"],
        "operands": [
            {
                "operandId": "basic_insured_amount_cash_value",
                "formulaText": "基本保险金额对应的现金价值",
                "basisKey": "basic_insured_amount_cash_value",
                "requiredInputs": ["basic_insured_amount_cash_value"],
                "evidenceTokens": ["基本保险金额", "现金价值"],
            },
            {
                "operandId": "actual_paid_premium",
                "formulaText": "实际交纳保险费",
                "basisKey": "actual_paid_premium",
                "requiredInputs": ["actual_paid_premium"],
                "evidenceTokens": ["实际交纳保险费"],
            },
        ],
    })
    return artifact


def staged_severe_disease_artifact():
    artifact = valid_artifact()
    artifact["optionalGroups"] = []
    artifact["officialOptionalGroupChecklist"] = []
    template = artifact["responsibilities"][0]
    rows = []
    checklist = []
    matrix = []
    for index, numeral in enumerate(("一", "二"), start=1):
        responsibility = deepcopy(template)
        responsibility_id = f"severe-{index}"
        heading = f"第{numeral}次重度疾病保险金"
        source = f"{heading}：确诊约定重度疾病后给付基本保险金额，累计给付次数达到六次时本项责任终止。"
        responsibility.update({
            "responsibilityId": responsibility_id,
            "liability": heading,
            "groupId": None,
            "selectionStatus": "included",
            "parentResponsibilityId": "severe_disease_benefit",
            "sourceExcerpt": source,
        })
        responsibility["card"].update({
            "title": heading,
            "customerSummary": f"符合第{numeral}次重疾给付条件时可领取保险金。",
            "benefitExplanation": "按基本保险金额给付，累计给付达到六次时本项责任终止。",
        })
        indicator = responsibility["indicators"][0]
        indicator.update({
            "formulaText": "基本保险金额",
            "normalizedFormula": "basic_insured_amount",
            "basisKey": "basic_insured_amount",
            "evidenceTokens": ["基本保险金额"],
        })
        rows.append(responsibility)
        checklist.append({
            "responsibilityId": responsibility_id,
            "officialHeading": heading,
            "sourcePage": "PDF第4页",
            "sourceExcerpt": source,
        })
        audit_row = deepcopy(artifact["audit"]["matrix"][0])
        audit_row["responsibilityId"] = responsibility_id
        matrix.append(audit_row)
    artifact["responsibilities"] = rows
    artifact["officialChecklist"] = checklist
    artifact["audit"].update({
        "officialChecklistCount": 2,
        "inventoryCount": 2,
        "cardCount": 2,
        "indicatorDecisionCount": 2,
        "matrix": matrix,
    })
    return artifact


def artifact_source_text(artifact):
    excerpts = []

    def collect(value):
        if isinstance(value, dict):
            excerpt = value.get("sourceExcerpt")
            if isinstance(excerpt, str) and excerpt.strip():
                excerpts.append(excerpt)
            for child in value.values():
                collect(child)
        elif isinstance(value, list):
            for child in value:
                collect(child)

    collect(artifact)
    return "\n".join(excerpts)


def validate(artifact, source_text=None, official_domains=None):
    with tempfile.TemporaryDirectory() as temp_dir:
        path = Path(temp_dir) / "artifact.json"
        source_path = Path(temp_dir) / "official-source.txt"
        document_path = Path(temp_dir) / "official-source.pdf"
        path.write_text(json.dumps(artifact, ensure_ascii=False), encoding="utf-8")
        source_path.write_text(source_text if source_text is not None else artifact_source_text(artifact), encoding="utf-8")
        document_path.write_bytes(TEST_SOURCE_DOCUMENT)
        domains = official_domains or ["example.invalid"]
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
                *[item for domain in domains for item in ("--official-domain", domain)],
            ],
            capture_output=True,
            text=True,
            check=False,
        )


class ArtifactValidatorTests(unittest.TestCase):
    def test_accepts_exact_multi_segment_evidence(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        full_excerpt = responsibility.pop("sourceExcerpt")
        responsibility["evidenceSegments"] = [
            {"sourcePage": "PDF第3页", "sourceExcerpt": "深造金、立业金：年满22周岁保单生效对应日生存，"},
            {"sourcePage": "PDF第4页", "sourceExcerpt": "按基本保险金额与累积红利保险金额之和的60%给付深造金。"},
        ]
        source_text = artifact_source_text(artifact) + "\n" + full_excerpt
        result = validate(artifact, source_text=source_text)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_non_source_multi_segment_evidence(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        original_source = artifact_source_text(artifact)
        responsibility["evidenceSegments"] = [
            {"sourcePage": "PDF第3页", "sourceExcerpt": "模型拼接出来的不存在原文"},
        ]
        responsibility.pop("sourceExcerpt")
        result = validate(artifact, source_text=original_source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exact contiguous excerpt", result.stderr)

    def test_accepts_shared_settlement_rule_referenced_by_responsibilities(self):
        artifact = valid_artifact()
        rule_excerpt = "扣除年度免赔额后，按有社会医疗保险和无社会医疗保险分别以100%和60%的比例给付。"
        artifact["productRules"] = [{
            "ruleId": "medical_reimbursement_ratio",
            "ruleKind": "reimbursement_ratio",
            "title": "医疗费用给付比例",
            "affectedResponsibilityIds": [artifact["responsibilities"][0]["responsibilityId"]],
            "sourcePage": "PDF第5页",
            "sourceExcerpt": rule_excerpt,
            "calculation": {
                "formulaText": "按是否使用社会医疗保险分段给付",
                "normalizedFormula": "piecewise(social_medical_insurance_used, 1.0, 0.6)",
                "basisKey": "piecewise",
                "calculationKey": "medical_reimbursement_ratio_piecewise",
                "calculationStatus": "needs_claim_facts",
                "calculationReason": "实际给付比例取决于是否使用社会医疗保险结算",
                "requiredInputs": ["social_medical_insurance_used"],
                "evidenceTokens": ["100%", "60%"],
                "branches": [
                    {
                        "branchId": "social_medical_insurance_used",
                        "conditionText": "有社会医疗保险",
                        "formulaText": "100%",
                        "basisKey": "actual_expense_after_deductible",
                        "calculationStatus": "needs_claim_facts",
                        "requiredInputs": ["actual_expense_after_deductible"],
                        "evidenceTokens": ["100%"],
                    },
                    {
                        "branchId": "social_medical_insurance_not_used",
                        "conditionText": "无社会医疗保险",
                        "formulaText": "60%",
                        "basisKey": "actual_expense_after_deductible",
                        "calculationStatus": "needs_claim_facts",
                        "requiredInputs": ["actual_expense_after_deductible"],
                        "evidenceTokens": ["60%"],
                    },
                ],
            },
        }]
        artifact["responsibilities"][0]["ruleRefs"] = ["medical_reimbursement_ratio"]
        artifact["responsibilities"][0]["indicators"][0]["ruleRefs"] = ["medical_reimbursement_ratio"]
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_shared_rule_reference(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["ruleRefs"] = ["missing_rule"]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unknown productRules ruleId", result.stderr)

    def test_accepts_complete_approved_artifact(self):
        result = validate(valid_artifact())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_two_source_backed_optional_packages(self):
        result = validate(two_optional_group_artifact())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_maximum_comparison_with_explicit_operands(self):
        result = validate(maximum_comparison_artifact())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_maximum_detected_from_formula_text_when_normalized_formula_is_empty(self):
        artifact = maximum_comparison_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["formulaText"] = "max(基本保险金额对应的现金价值, 实际交纳保险费)"
        indicator["normalizedFormula"] = ""
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_contract_defined_basis_as_comparison_operand(self):
        artifact = maximum_comparison_artifact()
        responsibility = artifact["responsibilities"][0]
        source = "本合同有效保险金额与现金价值二者之较大者。"
        responsibility["sourceExcerpt"] = source
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        indicator = responsibility["indicators"][0]
        indicator.update({
            "formulaText": "本合同有效保险金额与现金价值二者之较大者",
            "normalizedFormula": "max(contract_defined_effective_insured_amount, cash_value)",
            "basisKey": "max_of_contract_defined_effective_insured_amount_and_cash_value",
            "requiredInputs": ["contract_defined_effective_insured_amount", "cash_value"],
            "evidenceTokens": ["有效保险金额", "现金价值", "较大者"],
            "basisDefinition": {
                "term": "有效保险金额",
                "sourcePage": "PDF第9页",
                "sourceExcerpt": "有效保险金额按基本保险金额以1.75%年复利增加。",
                "evidenceTokens": ["有效保险金额", "基本保险金额", "1.75%"],
            },
            "operands": [
                {
                    "operandId": "effective_amount",
                    "formulaText": "本合同有效保险金额",
                    "basisKey": "contract_defined_effective_insured_amount",
                    "requiredInputs": ["contract_defined_effective_insured_amount"],
                    "evidenceTokens": ["有效保险金额"],
                },
                {
                    "operandId": "cash_value",
                    "formulaText": "现金价值",
                    "basisKey": "cash_value",
                    "requiredInputs": ["cash_value"],
                    "evidenceTokens": ["现金价值"],
                },
            ],
        })
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_maximum_comparison_mislabeled_as_piecewise(self):
        artifact = maximum_comparison_artifact()
        artifact["responsibilities"][0]["indicators"][0]["basisKey"] = "piecewise"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("max_of_", result.stderr)

    def test_rejects_maximum_comparison_with_cash_value_as_display_only(self):
        artifact = maximum_comparison_artifact()
        artifact["responsibilities"][0]["indicators"][0]["calculationStatus"] = "display_only"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("comparison containing cash value requires needs_table", result.stderr)

    def test_accepts_staged_benefits_with_one_conceptual_parent(self):
        result = validate(staged_severe_disease_artifact())
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_staged_benefits_with_different_conceptual_parents(self):
        artifact = staged_severe_disease_artifact()
        artifact["responsibilities"][1]["parentResponsibilityId"] = "different_parent"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("staged severe-disease benefits", result.stderr)

    def test_rejects_waiting_period_refund_in_coverage_totals(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["responsibilityKind"] = "waiting_period_refund"
        responsibility["coverageAggregation"] = "include"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("waiting-period refund", result.stderr)

    def test_rejects_unclassified_waiting_period_refund(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        source = "等待期内因疾病确诊，退还本合同实际交纳的保险费，合同终止。"
        responsibility["liability"] = "等待期内疾病保险费退还"
        responsibility["sourceExcerpt"] = source
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        indicator = responsibility["indicators"][0]
        indicator.update({
            "formulaText": "本合同实际交纳的保险费",
            "normalizedFormula": "actual_paid_premium",
            "basisKey": "actual_paid_premium",
            "evidenceTokens": ["实际交纳", "保险费"],
        })
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("classified explicitly", result.stderr)

    def test_accepts_waiting_period_refund_excluded_from_coverage_totals(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["responsibilityKind"] = "waiting_period_refund"
        responsibility["coverageAggregation"] = "exclude"
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_waiver_with_waiting_period_refund_branch(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["liability"] = "重大疾病豁免保险费"
        responsibility["responsibilityKind"] = "waiver"
        responsibility["coverageAggregation"] = "include"
        source = "重大疾病豁免保险费：等待期后确诊则豁免后续保费；等待期内确诊则退还已交保费。"
        responsibility["sourceExcerpt"] = source
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        responsibility["indicators"][0].update({
            "indicatorName": "豁免后续保费",
            "formulaText": "豁免后续保费",
            "normalizedFormula": "remaining_premium",
            "basisKey": "remaining_premium",
            "calculationKey": "waive_remaining_premium",
            "requiredInputs": ["remaining_premium"],
            "evidenceTokens": ["豁免", "后续保费"],
        })
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_truncated_responsibility_evidence(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["sourceExcerpt"] += "……"
        artifact["officialChecklist"][0]["sourceExcerpt"] = artifact["responsibilities"][0]["sourceExcerpt"]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("truncated evidence", result.stderr)

    def test_rejects_card_that_drops_cumulative_payment_count(self):
        artifact = staged_severe_disease_artifact()
        artifact["responsibilities"][0]["card"]["benefitExplanation"] = "按基本保险金额给付，给付后本项责任终止。"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cumulative payment count", result.stderr)

    def test_rejects_customer_claim_not_supported_by_source(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["card"]["benefitExplanation"] += "其他权益不受影响。"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("权益不受影响", result.stderr)

    def test_rejects_unsupported_non_duplication_claim(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["card"]["benefitExplanation"] += "与其他责任不重复。"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("non-duplication", result.stderr)

    def test_rejects_waiver_mislabeled_as_benefit(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["liability"] = "重度疾病豁免保险费"
        responsibility["responsibilityKind"] = "benefit"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must use 'waiver'", result.stderr)

    def test_accepts_explicit_waiver_kind(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["liability"] = "重度疾病豁免保险费"
        responsibility["responsibilityKind"] = "waiver"
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_unsupported_waiver_present_value(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        source = "确诊重度疾病后，免交自确诊之日起本合同的保险费，本合同继续有效。"
        responsibility.update({
            "liability": "重度疾病豁免保险费",
            "responsibilityKind": "waiver",
            "sourceExcerpt": source,
        })
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        responsibility["indicators"][0].update({
            "formulaText": "剩余缴费期间各期保险费之和（折现）",
            "normalizedFormula": "future_premium_present_value",
            "basisKey": "future_premium_present_value",
            "calculationKey": "present_value_of_future_premiums",
            "calculationStatus": "display_only",
            "calculationEligible": False,
            "requiredInputs": ["annual_premium", "remaining_premium_years"],
            "evidenceTokens": ["保险费"],
        })
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("present-value/discounting", result.stderr)

    def test_accepts_source_backed_waiver_scope_without_discounting(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        source = "确诊重度疾病后，免交自确诊之日起本合同的保险费，我们视同按期交纳，本合同继续有效。"
        responsibility.update({
            "liability": "重度疾病豁免保险费",
            "responsibilityKind": "waiver",
            "sourceExcerpt": source,
        })
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        responsibility["indicators"][0].update({
            "formulaText": "免交自确诊之日起本合同的保险费，我们视同按期交纳",
            "normalizedFormula": "future_premiums_from_diagnosis_date",
            "basisKey": "future_premiums_from_diagnosis_date",
            "calculationKey": "future_premiums_from_diagnosis_date",
            "calculationStatus": "needs_table",
            "calculationEligible": False,
            "requiredInputs": ["diagnosis_date", "premium_payment_plan", "future_premiums"],
            "evidenceTokens": ["免交自确诊之日起本合同的保险费", "我们视同按期交纳"],
        })
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_actual_paid_premium_mapped_to_total_paid_premium(self):
        artifact = valid_artifact()
        source = "等待期内因疾病发生约定事故，退还本合同实际交纳的保险费，本合同终止。"
        artifact["responsibilities"][0].update({
            "responsibilityKind": "waiting_period_refund",
            "coverageAggregation": "exclude",
            "sourceExcerpt": source,
        })
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        artifact["responsibilities"][0]["indicators"][0].update({
            "formulaText": "本合同实际交纳的保险费",
            "normalizedFormula": "total_paid_premium",
            "basisKey": "total_paid_premium",
            "calculationKey": "total_paid_premium",
            "requiredInputs": ["total_paid_premium"],
            "evidenceTokens": ["实际交纳的保险费"],
        })
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("actual_paid_premium, not total_paid_premium", result.stderr)

    def test_accepts_actual_paid_premium_basis(self):
        artifact = valid_artifact()
        source = "等待期内因疾病发生约定事故，退还本合同实际交纳的保险费，本合同终止。"
        artifact["responsibilities"][0].update({
            "responsibilityKind": "waiting_period_refund",
            "coverageAggregation": "exclude",
            "sourceExcerpt": source,
        })
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        artifact["responsibilities"][0]["indicators"][0].update({
            "formulaText": "本合同实际交纳的保险费",
            "normalizedFormula": "actual_paid_premium",
            "basisKey": "actual_paid_premium",
            "calculationKey": "actual_paid_premium",
            "requiredInputs": ["actual_paid_premium"],
            "evidenceTokens": ["实际交纳的保险费"],
        })
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_unsupported_other_responsibilities_unaffected_claim(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["importantLimits"].append("不影响其他保险责任")
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unsupported continuation claim", result.stderr)

    def test_rejects_calculable_without_current_policy_inputs(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["calculationStatus"] = "calculable"
        indicator["calculationEligible"] = True
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("calculable requires supplied currentPolicyInputs", result.stderr)

    def test_accepts_calculable_with_all_current_policy_inputs(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["calculationStatus"] = "calculable"
        indicator["calculationEligible"] = True
        artifact["currentPolicyInputs"] = {
            "insured_amount": 100000,
            "accumulated_dividend_insured_amount": 0,
        }
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_product_code_when_official_risk_code_url_was_reviewed(self):
        artifact = valid_artifact()
        identity = artifact["productIdentity"]
        identity["productCode"] = ""
        identity["fieldEvidence"]["productCode"] = {
            "status": "not_present_in_source",
            "reviewScope": "官方产品查询网页",
            "reviewedSourceUrls": ["https://example.invalid/product?riskCode=00936000"],
        }
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("official riskCode URL", result.stderr)

    def test_rejects_web_review_claim_without_reviewed_urls(self):
        artifact = valid_artifact()
        identity = artifact["productIdentity"]
        identity["productCode"] = ""
        identity["fieldEvidence"]["productCode"] = {
            "status": "not_present_in_source",
            "reviewScope": "官方产品查询网页",
        }
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("reviewedSourceUrls", result.stderr)

    def test_rejects_three_optional_children_merged_into_one_package(self):
        artifact = two_optional_group_artifact()
        artifact["optionalGroups"] = [{
            "groupId": "optional_survival",
            "label": "可选生存保险金",
            "selectionStatus": "unknown",
            "childResponsibilityIds": ["optional-high-school", "optional-advanced", "optional-career"],
            "sourcePage": "PDF第3页",
            "sourceExcerpt": "第一项包括高中教育金；第二项包括深造金、立业金。",
        }]
        for responsibility in artifact["responsibilities"]:
            responsibility["groupId"] = "optional_survival"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("optional group mapping", result.stderr)

    def test_rejects_approved_artifact_without_independent_matrix(self):
        artifact = valid_artifact()
        artifact["audit"].pop("matrix")
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("audit.matrix", result.stderr)

    def test_rejects_optional_child_whose_selection_differs_from_group(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["selectionStatus"] = "included"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("selectionStatus", result.stderr)

    def test_rejects_optional_groups_without_independent_official_group_checklist(self):
        artifact = valid_artifact()
        artifact.pop("officialOptionalGroupChecklist")
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("officialOptionalGroupChecklist", result.stderr)

    def test_rejects_generated_optional_group_that_disagrees_with_official_group(self):
        artifact = valid_artifact()
        artifact["optionalGroups"][0]["childResponsibilityIds"] = ["different-child"]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("optional group mapping", result.stderr)

    def test_rejects_truncated_optional_group_evidence(self):
        artifact = valid_artifact()
        artifact["optionalGroups"][0]["sourceExcerpt"] = "第二项包括深造金……立业金。"
        artifact["officialOptionalGroupChecklist"][0]["sourceExcerpt"] = "第二项包括深造金……立业金。"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("truncated evidence", result.stderr)

    def test_accepts_numbered_optional_children_with_shared_parent_heading(self):
        artifact = two_optional_group_artifact()
        group = artifact["officialOptionalGroupChecklist"][1]
        generated_group = artifact["optionalGroups"][1]
        child_ids = group["childResponsibilityIds"]
        headings = ["年金(1)平准给付", "年金(2)增额给付"]
        evidence = "年金 (1)平准给付：每年给付一次年金；(2)增额给付：以后每年增加一次。"
        for child_id, heading in zip(child_ids, headings, strict=True):
            checklist_item = next(
                item for item in artifact["officialChecklist"]
                if item["responsibilityId"] == child_id
            )
            checklist_item["officialHeading"] = heading
        group["sourceExcerpt"] = evidence
        generated_group["sourceExcerpt"] = evidence
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_shared_parent_group_when_numbered_child_is_missing(self):
        artifact = two_optional_group_artifact()
        group = artifact["officialOptionalGroupChecklist"][1]
        generated_group = artifact["optionalGroups"][1]
        child_ids = group["childResponsibilityIds"]
        headings = ["年金(1)平准给付", "年金(2)增额给付"]
        for child_id, heading in zip(child_ids, headings, strict=True):
            checklist_item = next(
                item for item in artifact["officialChecklist"]
                if item["responsibilityId"] == child_id
            )
            checklist_item["officialHeading"] = heading
        evidence = "年金 (1)平准给付：每年给付一次年金。"
        group["sourceExcerpt"] = evidence
        generated_group["sourceExcerpt"] = evidence
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("年金(2)增额给付", result.stderr)

    def test_rejects_filing_date_stored_as_filing_code(self):
        artifact = valid_artifact()
        artifact["productIdentity"]["filingCode"] = "2010年5月备案"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("filingCode", result.stderr)

    def test_accepts_exact_source_when_filing_metadata_is_not_present(self):
        artifact = valid_artifact()
        identity = artifact["productIdentity"]
        identity["filingCode"] = ""
        identity["filingDate"] = ""
        identity["fieldEvidence"]["filingCode"] = {
            "status": "not_present_in_source",
            "reviewScope": "官方条款PDF全部页面",
        }
        identity["fieldEvidence"]["filingDate"] = {
            "status": "not_present_in_source",
            "reviewScope": "官方条款PDF全部页面",
        }
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_product_code_repackaged_as_filing_code(self):
        artifact = valid_artifact()
        identity = artifact["productIdentity"]
        identity["productCode"] = "00627000"
        identity["filingCode"] = "00627000号"
        identity["fieldEvidence"]["productCode"]["sourceExcerpt"] = "产品代码00627000"
        identity["fieldEvidence"]["filingCode"]["sourceExcerpt"] = "险种代码00627000"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not be derived from productCode", result.stderr)

    def test_rejects_verified_identity_value_without_field_evidence(self):
        artifact = valid_artifact()
        artifact["productIdentity"]["fieldEvidence"]["filingCode"]["sourceExcerpt"] = "条款备案材料"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("fieldEvidence.filingCode", result.stderr)

    def test_rejects_not_present_status_with_fabricated_value(self):
        artifact = valid_artifact()
        artifact["productIdentity"]["fieldEvidence"]["filingCode"] = {
            "status": "not_present_in_source",
            "reviewScope": "官方条款PDF全部页面",
        }
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be empty", result.stderr)

    def test_rejects_evidence_token_missing_from_source_excerpt(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["indicators"][0]["evidenceTokens"].append("90%")
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("evidenceTokens", result.stderr)

    def test_accepts_indicator_evidence_from_separate_official_table(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["sourcePage"] = "PDF第8页保障计划表"
        indicator["sourceExcerpt"] = "大学教育金给付比例为基本保险金额的90%。"
        indicator["evidenceTokens"] = ["基本保险金额", "90%"]
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_truncated_indicator_evidence(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["sourcePage"] = "PDF第8页保障计划表"
        indicator["sourceExcerpt"] = "基本保险金额……60%"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("sourceExcerpt: truncated evidence", result.stderr)

    def test_rejects_piecewise_formula_without_branch_statuses(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["normalizedFormula"] = "if(age < 18, premium, insured_amount * 5)"
        indicator["formulaText"] = "18周岁前按保险费，18周岁后按保险金额的5倍"
        indicator["evidenceTokens"] = ["22周岁"]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("branches", result.stderr)

    def test_accepts_explicit_piecewise_basis_with_source_backed_branches(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["sourceExcerpt"] = (
            "18周岁保单生效对应日前身故，按实际交纳的保险费给付；"
            "18周岁保单生效对应日后身故，按基本保险金额的5倍给付。"
        )
        indicator = responsibility["indicators"][0]
        indicator.update({
            "formulaText": "按身故年龄分段给付",
            "normalizedFormula": "age_based_death_benefit",
            "basisKey": "piecewise",
            "calculationKey": "age_based_piecewise_benefit",
            "calculationStatus": "needs_claim_facts",
            "requiredInputs": ["age_at_death"],
            "evidenceTokens": ["18周岁保单生效对应日前", "18周岁保单生效对应日后"],
            "branches": [
                {
                    "branchId": "before_18",
                    "conditionText": "18周岁保单生效对应日前身故",
                    "formulaText": "实际交纳的保险费",
                    "basisKey": "actual_paid_premium",
                    "calculationStatus": "display_only",
                    "requiredInputs": ["actual_paid_premium"],
                    "evidenceTokens": ["实际交纳的保险费"],
                },
                {
                    "branchId": "after_18",
                    "conditionText": "18周岁保单生效对应日后身故",
                    "formulaText": "基本保险金额 × 5",
                    "basisKey": "basic_insured_amount",
                    "calculationStatus": "display_only",
                    "requiredInputs": ["basic_insured_amount"],
                    "evidenceTokens": ["基本保险金额", "5倍"],
                },
            ],
        })
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_accepts_comparison_operands_nested_inside_piecewise_branch(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        source = (
            "18周岁前身故，按实际交纳的保险费给付；"
            "18周岁后身故，按有效保险金额与现金价值二者之较大者给付。"
        )
        responsibility["sourceExcerpt"] = source
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        indicator = responsibility["indicators"][0]
        indicator.update({
            "formulaText": "按身故年龄分段给付",
            "normalizedFormula": "piecewise(age_at_death)",
            "basisKey": "piecewise",
            "calculationKey": "piecewise",
            "calculationStatus": "needs_table",
            "requiredInputs": ["age_at_death", "actual_paid_premium", "contract_defined_effective_insured_amount", "cash_value"],
            "evidenceTokens": ["18周岁前", "18周岁后", "实际交纳的保险费", "有效保险金额", "现金价值", "较大者"],
            "basisDefinition": {
                "term": "有效保险金额",
                "sourcePage": "PDF第9页",
                "sourceExcerpt": "有效保险金额按基本保险金额以1.75%年复利增加。",
                "evidenceTokens": ["有效保险金额", "基本保险金额", "1.75%"],
            },
            "operands": [],
            "branches": [
                {
                    "branchId": "before_18",
                    "conditionText": "18周岁前身故",
                    "formulaText": "实际交纳的保险费",
                    "basisKey": "actual_paid_premium",
                    "calculationStatus": "display_only",
                    "requiredInputs": ["actual_paid_premium"],
                    "evidenceTokens": ["实际交纳的保险费"],
                },
                {
                    "branchId": "after_18",
                    "conditionText": "18周岁后身故",
                    "formulaText": "有效保险金额与现金价值二者之较大者",
                    "basisKey": "max_of_contract_defined_effective_insured_amount_and_cash_value",
                    "calculationStatus": "needs_table",
                    "requiredInputs": ["contract_defined_effective_insured_amount", "cash_value"],
                    "evidenceTokens": ["有效保险金额", "现金价值", "较大者"],
                    "operands": [
                        {
                            "operandId": "effective_amount",
                            "formulaText": "有效保险金额",
                            "basisKey": "contract_defined_effective_insured_amount",
                            "requiredInputs": ["contract_defined_effective_insured_amount"],
                            "evidenceTokens": ["有效保险金额"],
                        },
                        {
                            "operandId": "cash_value",
                            "formulaText": "现金价值",
                            "basisKey": "cash_value",
                            "requiredInputs": ["cash_value"],
                            "evidenceTokens": ["现金价值"],
                        },
                    ],
                },
            ],
        })
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_generic_group_heading_as_card_title(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["card"]["title"] = "可选责任二"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("card.title", result.stderr)

    def test_rejects_ambiguous_effective_insured_amount_basis(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["indicators"][0]["basisKey"] = "effective_insured_amount"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("basisKey", result.stderr)

    def test_rejects_ambiguous_sum_assured_basis(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["indicators"][0]["basisKey"] = "sum_assured"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("basisKey", result.stderr)

    def test_rejects_contract_defined_effective_amount_expanded_to_simple_sum(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["sourceExcerpt"] += " 按本合同有效保险金额的60%给付。"
        artifact["officialChecklist"][0]["sourceExcerpt"] = responsibility["sourceExcerpt"]
        indicator = responsibility["indicators"][0]
        indicator["formulaText"] = "有效保险金额 × 60%"
        indicator["normalizedFormula"] = "(basic_insured_amount + dividend_insured_amount) * 0.60"
        indicator["basisKey"] = "basic_insured_amount_plus_dividend_insured_amount"
        indicator["evidenceTokens"] = ["有效保险金额", "60%"]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("contract_defined_effective_insured_amount", result.stderr)

    def test_accepts_source_backed_contract_defined_effective_amount(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["sourceExcerpt"] += " 按本合同有效保险金额的60%给付。"
        artifact["officialChecklist"][0]["sourceExcerpt"] = responsibility["sourceExcerpt"]
        indicator = responsibility["indicators"][0]
        indicator["formulaText"] = "有效保险金额 × 60%"
        indicator["normalizedFormula"] = "contract_defined_effective_insured_amount * 0.60"
        indicator["basisKey"] = "contract_defined_effective_insured_amount"
        indicator["requiredInputs"] = ["contract_defined_effective_insured_amount"]
        indicator["evidenceTokens"] = ["有效保险金额", "60%"]
        indicator["basisDefinition"] = {
            "term": "有效保险金额",
            "sourcePage": "PDF第10页第6.10条",
            "sourceExcerpt": "有效保险金额主要包括基本保险金额与累计红利保险金额两部分；特定日期还包括不足整保单年度的红利保险金额。",
            "evidenceTokens": ["有效保险金额", "基本保险金额", "累计红利保险金额", "不足整保单年度"],
        }
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_contract_defined_basis_without_definition_evidence(self):
        artifact = valid_artifact()
        responsibility = artifact["responsibilities"][0]
        responsibility["sourceExcerpt"] += " 按本合同有效保险金额的60%给付。"
        artifact["officialChecklist"][0]["sourceExcerpt"] = responsibility["sourceExcerpt"]
        indicator = responsibility["indicators"][0]
        indicator["formulaText"] = "有效保险金额 × 60%"
        indicator["basisKey"] = "contract_defined_effective_insured_amount"
        indicator["evidenceTokens"] = ["有效保险金额", "60%"]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("basisDefinition", result.stderr)

    def test_rejects_cash_value_branch_without_table_dependency(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["formulaText"] = "18周岁前按现金价值，18周岁后按保险金额"
        indicator["normalizedFormula"] = "if(age < 18, cash_value, insured_amount)"
        indicator["basisKey"] = "piecewise"
        indicator["branches"] = [{
            "branchId": "before_age_18_policy_anniversary",
            "conditionText": "18周岁前",
            "formulaText": "现金价值",
            "basisKey": "cash_value",
            "calculationStatus": "needs_claim_facts",
            "requiredInputs": ["cash_value"],
            "evidenceTokens": ["现金价值"],
        }]
        artifact["responsibilities"][0]["sourceExcerpt"] += " 18周岁前按现金价值。"
        artifact["officialChecklist"][0]["sourceExcerpt"] = artifact["responsibilities"][0]["sourceExcerpt"]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cash value branch requires needs_table", result.stderr)

    def test_rejects_piecewise_branch_without_source_backed_condition(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["normalizedFormula"] = "if(age < 18, premium, insured_amount)"
        indicator["basisKey"] = "piecewise"
        indicator["branches"] = [{
            "branchId": "on_or_after_age_18_policy_anniversary",
            "conditionText": "18周岁对应日及以后",
            "formulaText": "按基本保险金额给付",
            "basisKey": "insured_amount",
            "calculationStatus": "display_only",
            "requiredInputs": ["insured_amount"],
            "evidenceTokens": ["基本保险金额"],
        }]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("conditionText", result.stderr)

    def test_rejects_brand_name_instead_of_legal_company_name(self):
        artifact = valid_artifact()
        artifact["company"] = "新华保险"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("company", result.stderr)

    def test_rejects_official_checklist_without_source_evidence(self):
        artifact = valid_artifact()
        artifact["officialChecklist"][0].pop("sourceExcerpt")
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("officialChecklist[0].sourceExcerpt", result.stderr)

    def test_rejects_piecewise_branch_without_valid_status(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["normalizedFormula"] = "if(age < 18, premium, insured_amount * 5)"
        indicator["branches"] = [{"branchId": "before18", "calculationStatus": "maybe"}]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("branches[0].calculationStatus", result.stderr)

    def test_piecewise_calculation_key_requires_piecewise_basis(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["calculationKey"] = "piecewise"
        indicator["branches"] = [{
            "branchId": "at_age_22",
            "conditionText": "22周岁",
            "formulaText": "按基本保险金额给付",
            "basisKey": "insured_amount",
            "calculationStatus": "display_only",
            "requiredInputs": ["insured_amount"],
            "evidenceTokens": ["基本保险金额"],
        }]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("piecewise formula must use 'piecewise'", result.stderr)

    def test_branch_based_calculation_key_requires_piecewise_basis(self):
        artifact = valid_artifact()
        indicator = artifact["responsibilities"][0]["indicators"][0]
        indicator["normalizedFormula"] = "IF 方案一 THEN 100 ELSE 200"
        indicator["calculationKey"] = "branch_based"
        indicator["branches"] = [{
            "branchId": "plan1",
            "conditionText": "22周岁",
            "formulaText": "按基本保险金额给付",
            "basisKey": "insured_amount",
            "calculationStatus": "display_only",
            "requiredInputs": ["insured_amount"],
            "evidenceTokens": ["基本保险金额"],
        }]
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("piecewise formula must use 'piecewise'", result.stderr)

    def test_rejects_non_official_source_domain(self):
        artifact = valid_artifact()
        artifact["productIdentity"]["sourceUrl"] = "https://bank.example/distributor.pdf"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("approved official insurer domain", result.stderr)

    def test_rejects_source_document_digest_mismatch(self):
        artifact = valid_artifact()
        artifact["productIdentity"]["sourceDigest"] = "sha256:" + "0" * 64
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the supplied official source document", result.stderr)

    def test_rejects_paraphrased_source_excerpt(self):
        artifact = valid_artifact()
        official_source = artifact_source_text(artifact)
        artifact["responsibilities"][0]["sourceExcerpt"] += "这是模型补写的说明。"
        result = validate(artifact, source_text=official_source)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("exact contiguous excerpt", result.stderr)

    def test_rejects_merged_independently_named_child_benefits(self):
        artifact = valid_artifact()
        source = (
            "住院津贴保险金：（1）特定疾病住院津贴：按实际住院日数给付；"
            "（2）一般住院津贴：按实际住院日数给付。"
        )
        artifact["responsibilities"][0]["liability"] = "住院津贴保险金"
        artifact["responsibilities"][0]["sourceExcerpt"] = source
        artifact["officialChecklist"][0]["officialHeading"] = "住院津贴保险金"
        artifact["officialChecklist"][0]["sourceExcerpt"] = source
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("independently named child benefits must be split", result.stderr)

    def test_rejects_health_management_service_as_responsibility(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["liability"] = "健康管理服务"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rule or service", result.stderr)

    def test_rejects_responsibility_extension_as_responsibility(self):
        artifact = valid_artifact()
        artifact["responsibilities"][0]["liability"] = "责任延续"
        result = validate(artifact)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rule or service", result.stderr)

    def test_accepts_health_management_in_product_services(self):
        artifact = valid_artifact()
        artifact["productServices"] = [{
            "serviceId": "health-management",
            "title": "健康管理服务",
            "customerSummary": "按服务手册约定提供健康管理服务。",
            "sourcePage": "PDF第12页",
            "sourceExcerpt": "健康管理服务：按服务手册约定提供健康管理服务。",
        }]
        result = validate(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
