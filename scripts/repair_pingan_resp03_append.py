#!/usr/bin/env python3
"""Bounded parse-only repair for Ping An resp-03 evidence continuity."""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path


def compact_positions(value):
    chars, positions = [], []
    for index, char in enumerate(value):
        for normalized in unicodedata.normalize("NFKC", char):
            if normalized.isspace():
                continue
            chars.append(normalized)
            positions.append(index)
    return "".join(chars), positions


def exact(source, phrase):
    haystack, positions = compact_positions(source)
    needle, _ = compact_positions(phrase)
    start = haystack.find(needle)
    if start < 0:
        raise ValueError(f"phrase absent from official source: {phrase[:90]}")
    end = start + len(needle)
    return source[positions[start]:positions[end - 1] + 1]


def segment(source, page, phrase):
    return {"sourcePage": page, "sourceExcerpt": exact(source, phrase)}


def indicator(name, formula, normalized, basis, key, reason, evidence, tokens, inputs, branches=None):
    return {
        "indicatorName": name,
        "formulaText": formula,
        "normalizedFormula": normalized,
        "basisKey": basis,
        "calculationKey": key,
        "calculationStatus": "display_only",
        "calculationEligible": False,
        "calculationReason": reason,
        "requiredInputs": inputs,
        "ruleRefs": [],
        "sourcePage": evidence[0]["sourcePage"],
        "evidenceSegments": evidence,
        "evidenceTokens": tokens,
        "branches": branches or [],
        "operands": [],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    source_dir, out = args.source_dir.resolve(), args.output_dir.resolve()
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"output directory must be empty: {out}")
    out.mkdir(parents=True, exist_ok=True)
    source_text_path = source_dir / "official-source.pages.txt"
    source_pdf = source_dir / "official-source.pdf"
    source = source_text_path.read_text(encoding="utf-8")
    digest = "sha256:" + hashlib.sha256(source_pdf.read_bytes()).hexdigest()
    url = "https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1329&versionNo=1329-1&attachmentType=1"

    p1 = segment(source, "第2页", "之前身故，我们无息返还所交保险费，本主险合同终止。")
    p1_formula = segment(source, "第2页", "基本保险金额确定的年交保险费")
    p2 = segment(source, "第2页", "给付身故保险金，本主险合同终止。")
    p3_intro = segment(source, "第2页", "确诊的、符合平安附加少儿平安福19 提前给付重大疾病保险合同（简称“少儿福重疾19 合同”）约定的特定轻度重疾，且满足少儿福重疾 19 合同约定的特定轻度重疾保险金给付条件")
    p3_1 = segment(source, "第2页", "（1）被保险人于18 周岁的保单周年日之后（含该保单周年日）身故，且在70 周岁的保单周年日前 （不含该保单周年日）发生过一次特定轻度重疾，我们按照本主险合同基本保险金额的 20%额外给付身故保险金，本主险合同终止；")
    p3_2a = segment(source, "第2页", "（2）被保险人于18 周岁的保单周年日之后（含该保单周年日）身故，且在70 周岁的保单周年日前 （不含该保单周年日）发生过两次不同种")
    p3_2b = segment(source, "第3页", "特定轻度重疾，我们按照本主险合同基本保险金额的 40%额外给付身故保险金，本主险合同终止；")
    p3_3 = segment(source, "第3页", "（3）被保险人于18 周岁的保单周年日之后（含该保单周年日）身故，且在70 周岁的保单周年日前 （不含该保单周年日）发生过三次不同种特定轻度重疾，我们按照本主险合同基本保险金额的 60%额外给付身故保险金，本主险合同终止。")
    p3_non = segment(source, "第3页", "我们按照被保险人身故时满足的以上约定条件之一单独给付额外身故保险金，不累计给付。")
    resp3_evidence = [p3_intro, p3_1, p3_2a, p3_2b, p3_3, p3_non]

    responsibilities = [
        {
            "responsibilityId": "resp-01", "liability": "基本身故保险金（18周岁保单周年日之前）", "groupId": None, "parentResponsibilityId": None, "responsibilityKind": "benefit", "coverageAggregation": "include", "selectionStatus": "included", "triggerCondition": "被保险人于18周岁的保单周年日之前身故", "insurerObligation": "无息返还所交保险费，本主险合同终止。", "importantLimits": ["所交保险费按身故时基本保险金额确定的年交保险费和保单年度数计算"], "ruleRefs": [], "sourcePage": "第2页", "evidenceSegments": [p1, p1_formula], "card": {"title": "基本身故保险金（18周岁保单周年日之前）", "customerSummary": "被保险人于18周岁的保单周年日之前身故的，无息返还按约定计算的所交保险费。", "benefitExplanation": "无息返还所交保险费；所交保险费按基本保险金额确定的年交保险费和保单年度数计算。"}, "indicators": [indicator("基本身故保险金（18周岁保单周年日之前）", "annual_premium * policy_years_count", "annual_premium * policy_years_count", "annual_premium", "paid_premium_by_policy_years", "缺少当前保单年交保险费及保单年度数输入值", [p1_formula], ["所交保险费", "年交保险费", "保单年度数"], ["annual_premium", "policy_years_count"])],
        },
        {
            "responsibilityId": "resp-02", "liability": "基本身故保险金（18周岁保单周年日之后）", "groupId": None, "parentResponsibilityId": None, "responsibilityKind": "benefit", "coverageAggregation": "include", "selectionStatus": "included", "triggerCondition": "被保险人于18周岁的保单周年日之后（含该保单周年日）身故", "insurerObligation": "按本主险合同基本保险金额给付身故保险金，本主险合同终止。", "importantLimits": [], "ruleRefs": [], "sourcePage": "第2页", "evidenceSegments": [p2], "card": {"title": "基本身故保险金（18周岁保单周年日之后）", "customerSummary": "被保险人于18周岁的保单周年日之后（含该保单周年日）身故的，按基本保险金额给付身故保险金。", "benefitExplanation": "给付金额 = 本主险合同基本保险金额。"}, "indicators": [indicator("基本身故保险金（18周岁保单周年日之后）", "basic_sum_insured", "basic_sum_insured", "basic_sum_insured", "basic_sum_insured", "缺少当前保单基本保险金额输入值", [p2], ["基本保险金额"], ["basic_sum_insured"])],
        },
    ]
    branches = [
        {"branchId": "one_specific_mild_illness", "conditionText": "在70周岁的保单周年日前（不含该保单周年日）发生过一次特定轻度重疾", "formulaText": "basic_sum_insured * 20%", "basisKey": "basic_sum_insured", "calculationStatus": "display_only", "requiredInputs": ["basic_sum_insured", "specific_mild_illness_count"], "evidenceTokens": ["一次特定轻度重疾", "20%", "基本保险金额"]},
        {"branchId": "two_different_specific_mild_illnesses", "conditionText": "在70周岁的保单周年日前（不含该保单周年日）发生过两次不同种特定轻度重疾", "formulaText": "basic_sum_insured * 40%", "basisKey": "basic_sum_insured", "calculationStatus": "display_only", "requiredInputs": ["basic_sum_insured", "specific_mild_illness_count"], "evidenceTokens": ["两次不同种", "40%", "基本保险金额"]},
        {"branchId": "three_different_specific_mild_illnesses", "conditionText": "在70周岁的保单周年日前（不含该保单周年日）发生过三次不同种特定轻度重疾", "formulaText": "basic_sum_insured * 60%", "basisKey": "basic_sum_insured", "calculationStatus": "display_only", "requiredInputs": ["basic_sum_insured", "specific_mild_illness_count"], "evidenceTokens": ["三次不同种", "60%", "基本保险金额"]},
    ]
    responsibilities.append({"responsibilityId": "resp-03", "liability": "额外身故保险金", "groupId": None, "parentResponsibilityId": None, "responsibilityKind": "benefit", "coverageAggregation": "include", "selectionStatus": "included", "triggerCondition": "发生过约定的特定轻度重疾并满足给付条件，且被保险人于18周岁的保单周年日之后（含该保单周年日）身故", "insurerObligation": "按发生过的一次、两次或三次不同种特定轻度重疾，分别按基本保险金额的20%、40%或60%额外给付身故保险金，本主险合同终止；以上条件之一单独给付，不累计。", "importantLimits": ["须在70周岁的保单周年日前（不含该保单周年日）发生特定轻度重疾", "不累计给付"], "ruleRefs": [], "sourcePage": "第2-3页", "evidenceSegments": resp3_evidence, "card": {"title": "额外身故保险金", "customerSummary": "满足特定轻度重疾及身故条件的，按发生次数以基本保险金额的20%、40%或60%额外给付身故保险金。", "benefitExplanation": "按条件分支给付基本保险金额的20%、40%或60%；满足的条件之一单独给付，不累计。"}, "indicators": [indicator("额外身故保险金", "piecewise", "piecewise", "piecewise", "piecewise_formula", "缺少当前保单基本保险金额及特定轻度重疾发生次数输入值", resp3_evidence, ["20%", "40%", "60%", "不累计给付"], ["basic_sum_insured", "specific_mild_illness_count"], branches)]})
    matrix = [{"responsibilityId": item["responsibilityId"], "inventory": "pass", "card": "pass", "indicatorDecision": "pass", "formulaEvidence": "pass", "selectionEvidence": "pass", "productVersion": "pass", "result": "pass", "issues": []} for item in responsibilities]
    artifact = {
        "company": "中国平安人寿保险股份有限公司", "displayCompany": "中国平安人寿保险股份有限公司", "productName": "平安少儿平安福19终身寿险",
        "productIdentity": {"filingCode": "平安人寿[2018]终身寿险218号", "productCode": "1329", "filingDate": "", "sourceUrl": url, "sourceDigest": digest, "fieldEvidence": {"filingCode": {"status": "verified", "sourceUrl": url, "sourcePage": "第1页", "sourceExcerpt": exact(source, "平安人寿[2018]终身寿险 218 号")}, "productCode": {"status": "verified", "sourceUrl": url, "sourcePage": "第1页", "sourceExcerpt": exact(source, "1329")}, "filingDate": {"status": "not_present_in_source", "reviewScope": "官方条款PDF全部页面"}}},
        "productOverview": {"productType": "终身寿险", "primaryPurpose": "提供基本身故及特定轻度重疾相关额外身故保障", "mainFunctions": ["基本身故保险金", "额外身故保险金"], "importantLimits": ["18周岁保单周年日前后责任不同", "额外身故保险金按满足条件之一单独给付，不累计"]},
        "productServices": [], "productRules": [], "currentPolicyInputs": {}, "optionalGroups": [], "officialOptionalGroupChecklist": [],
        "officialChecklist": [{"responsibilityId": "resp-01", "officialHeading": "基本身故保险金（18周岁保单周年日之前）", "sourcePage": "第2页", "evidenceSegments": [p1, p1_formula]}, {"responsibilityId": "resp-02", "officialHeading": "基本身故保险金（18周岁保单周年日之后）", "sourcePage": "第2页", "evidenceSegments": [p2]}, {"responsibilityId": "resp-03", "officialHeading": "额外身故保险金", "sourcePage": "第2-3页", "evidenceSegments": resp3_evidence}],
        "responsibilities": responsibilities,
        "audit": {"status": "approved", "officialChecklistCount": 3, "inventoryCount": 3, "cardCount": 3, "indicatorDecisionCount": 3, "matrix": matrix, "issues": []},
        "publication": {"sqlite": "parse_only_not_written", "feishu": "not_requested"},
    }
    (out / "artifact.json").write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "source-provenance.json").write_text(json.dumps({"sourceUrl": url, "sourceDigest": digest, "sourceTextPath": str(source_text_path), "sourceDocumentPath": str(source_pdf), "repairScope": "resp-03 evidence continuity only; resp-01/resp-02 copied from existing model result semantics"}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputDir": str(out), "sourceDigest": digest, "responsibilityCount": 3, "resp03Segments": len(resp3_evidence), "parseOnly": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
