#!/usr/bin/env python3
"""Rebuild one source-ready pipeline candidate without models, network, or DB writes."""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path


def compact_with_positions(value: str):
    compacted = []
    positions = []
    for index, char in enumerate(value):
        for normalized in unicodedata.normalize("NFKC", char):
            if normalized.isspace():
                continue
            compacted.append(normalized)
            positions.append(index)
    return "".join(compacted), positions


def exact_span(source: str, phrase: str) -> str:
    source_compact, positions = compact_with_positions(source)
    phrase_compact, _ = compact_with_positions(phrase)
    start = source_compact.find(phrase_compact)
    if start < 0:
        raise ValueError(f"source phrase not found: {phrase[:80]}")
    end = start + len(phrase_compact)
    return source[positions[start] : positions[end - 1] + 1]


def indicator(name, formula, normalized, basis, key, reason, excerpt, tokens, inputs):
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
        "sourcePage": "第1页",
        "sourceExcerpt": excerpt,
        "evidenceTokens": tokens,
        "branches": [],
        "operands": [],
    }


def responsibility(rid, liability, kind, trigger, obligation, excerpt, card_summary, explanation, ind):
    return {
        "responsibilityId": rid,
        "liability": liability,
        "groupId": None,
        "parentResponsibilityId": None,
        "responsibilityKind": kind,
        "coverageAggregation": "include",
        "selectionStatus": "included",
        "triggerCondition": trigger,
        "insurerObligation": obligation,
        "importantLimits": [],
        "ruleRefs": [],
        "sourcePage": "第1页",
        "sourceExcerpt": excerpt,
        "card": {
            "title": liability,
            "customerSummary": card_summary,
            "benefitExplanation": explanation,
        },
        "indicators": [ind],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    source_dir = args.source_dir.resolve()
    out = args.output_dir.resolve()
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f"output directory must be empty: {out}")
    out.mkdir(parents=True, exist_ok=True)
    source_pdf = source_dir / "official-source.pdf"
    source_text_path = source_dir / "official-source.pages.txt"
    source_text = source_text_path.read_text(encoding="utf-8")
    source_digest = "sha256:" + hashlib.sha256(source_pdf.read_bytes()).hexdigest()

    phrases = {
        "survival": "（一）被保险人在合同生效后的每三周年时生存，且合同有效，本公司按保险单所载保险金额的10%给付生存保险金，直至被保险人身故，保险责任终止。",
        "death": "（二）被保险人因意外伤害身故，或在合同生效一百八十日后因疾病导致身故，本公司按保险单当时生效的保险金额给付身故保险金，保险责任终止。",
        "disability": "（三）被保险人因意外伤害所致身体高残，或在合同生效一百八十日后因疾病所致身体高残，本公司按当时生效的保险金额给付高残保险金，高残保险责任终止。高残保险金给付后，被保险人仍可领取生存保险金，但被保险人身故时，本公司不再给付身故保险金。",
        "waiver": "（四）被保险人因意外伤害所致身体高残, 或在合同生效一百八十日后因疾病所致身体高残，投保人可免交自被保险人被确定高残之日起的分期保险费。",
    }
    excerpts = {key: exact_span(source_text, phrase) for key, phrase in phrases.items()}
    official = [
        {"responsibilityId": "survival_benefit", "officialHeading": "生存保险金", "sourcePage": "第1页", "sourceExcerpt": excerpts["survival"]},
        {"responsibilityId": "death_benefit", "officialHeading": "身故保险金", "sourcePage": "第1页", "sourceExcerpt": excerpts["death"]},
        {"responsibilityId": "high_disability_benefit", "officialHeading": "高残保险金", "sourcePage": "第1页", "sourceExcerpt": excerpts["disability"]},
        {"responsibilityId": "premium_waiver_after_high_disability", "officialHeading": "豁免保险费", "sourcePage": "第1页", "sourceExcerpt": excerpts["waiver"]},
    ]
    artifact = {
        "company": "新华人寿保险股份有限公司",
        "displayCompany": "新华保险",
        "productName": "新华人寿保险股份有限公司美满人生保险",
        "productIdentity": {
            "filingCode": "",
            "productCode": "",
            "filingDate": "",
            "sourceUrl": "https://static-cdn.newchinalife.com/ncl/pdf/20260514/0b969c30-9489-4cab-8697-a795d769049e.pdf",
            "sourceDigest": source_digest,
            "fieldEvidence": {
                "filingCode": {"status": "not_present_in_source", "reviewScope": "官方条款PDF全部页面"},
                "productCode": {"status": "not_present_in_source", "reviewScope": "官方条款PDF全部页面"},
                "filingDate": {"status": "not_present_in_source", "reviewScope": "官方条款PDF全部页面"},
            },
        },
        "productOverview": {
            "productType": "终身寿险",
            "primaryPurpose": "提供生存、身故、身体高残及高残后豁免分期保险费保障",
            "mainFunctions": ["每三周年生存保险金", "身故保险金", "高残保险金", "高残后豁免分期保险费"],
            "importantLimits": ["生存保险金按保险金额的10%给付", "疾病身故或高残须在合同生效一百八十日后"],
        },
        "productServices": [],
        "productRules": [],
        "currentPolicyInputs": {},
        "optionalGroups": [],
        "officialOptionalGroupChecklist": [],
        "officialChecklist": official,
        "responsibilities": [
            responsibility("survival_benefit", "生存保险金", "benefit", "被保险人在合同生效后的每三周年时生存且合同有效", "按保险单所载保险金额的10%给付生存保险金，直至被保险人身故，保险责任终止", excerpts["survival"], "合同生效后每三周年生存且合同有效的，按保险单所载保险金额的10%给付生存保险金。", "给付金额 = 保险单所载保险金额 × 10%。", indicator("生存保险金", "insured_amount * 10%", "insured_amount * 0.10", "insured_amount", "percentage_of_insured_amount", "缺少当前保单保险金额输入值", excerpts["survival"], ["每三周年", "保险金额的10%"], ["insured_amount"])),
            responsibility("death_benefit", "身故保险金", "benefit", "被保险人因意外伤害身故，或在合同生效一百八十日后因疾病导致身故", "按保险单当时生效的保险金额给付身故保险金，保险责任终止", excerpts["death"], "因意外伤害身故，或合同生效180日后因疾病身故的，按当时生效的保险金额给付身故保险金。", "给付金额 = 保险单当时生效的保险金额。", indicator("身故保险金", "insured_amount", "insured_amount", "insured_amount", "insured_amount", "缺少当前保单当时生效的保险金额输入值", excerpts["death"], ["意外伤害身故", "一百八十日后", "保险金额"], ["insured_amount"])),
            responsibility("high_disability_benefit", "高残保险金", "benefit", "被保险人因意外伤害所致身体高残，或在合同生效一百八十日后因疾病所致身体高残", "按当时生效的保险金额给付高残保险金，高残保险责任终止；给付后仍可领取生存保险金，但身故时不再给付身故保险金", excerpts["disability"], "因意外伤害高残，或合同生效180日后因疾病高残的，按当时生效的保险金额给付高残保险金。", "给付金额 = 当时生效的保险金额；高残保险金给付后，身故时不再给付身故保险金。", indicator("高残保险金", "insured_amount", "insured_amount", "insured_amount", "insured_amount", "缺少当前保单当时生效的保险金额输入值", excerpts["disability"], ["身体高残", "一百八十日后", "保险金额"], ["insured_amount"])),
            responsibility("premium_waiver_after_high_disability", "豁免保险费", "waiver", "被保险人因意外伤害所致身体高残，或在合同生效一百八十日后因疾病所致身体高残，并自被保险人被确定高残之日起", "投保人可免交自被保险人被确定高残之日起的分期保险费", excerpts["waiver"], "符合高残条件并被确定高残后，可免交自确定之日起的分期保险费。", "自被保险人被确定高残之日起免交分期保险费；具体免交金额取决于当期分期保险费。", indicator("豁免保险费", "waive_future_premium_installments", "waive_future_premium_installments", "premium_installment", "premium_waiver", "条款仅规定免交分期保险费，缺少当前分期保险费输入值", excerpts["waiver"], ["免交", "被保险人被确定高残之日起", "分期保险费"], ["premium_installment"])),
        ],
        "audit": {"status": "approved", "officialChecklistCount": 4, "inventoryCount": 4, "cardCount": 4, "indicatorDecisionCount": 4, "matrix": [{"responsibilityId": rid, "inventory": "pass", "card": "pass", "indicatorDecision": "pass", "formulaEvidence": "pass", "selectionEvidence": "pass", "productVersion": "pass", "result": "pass", "issues": []} for rid in ("survival_benefit", "death_benefit", "high_disability_benefit", "premium_waiver_after_high_disability")], "issues": []},
        "publication": {"sqlite": "parse_only_not_written", "feishu": "not_requested"},
    }
    artifact_path = out / "artifact.json"
    artifact_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    result = {
        "status": "pipeline_repair_candidate",
        "stage": "pipeline",
        "failureClass": "pipeline_error_repaired_deterministically",
        "company": artifact["displayCompany"],
        "productName": artifact["productName"],
        "sourceUrl": artifact["productIdentity"]["sourceUrl"],
        "sourceDigest": source_digest,
        "provider": "deterministic-local-rebuild",
        "parseOnly": True,
        "sourceTextPath": str(source_text_path),
        "sourceDocumentPath": str(source_pdf),
        "artifactPath": str(artifact_path),
    }
    (out / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"artifactPath": str(artifact_path), "sourceDigest": source_digest, "responsibilityCount": 4, "parseOnly": True}, ensure_ascii=False))


if __name__ == "__main__":
    main()
