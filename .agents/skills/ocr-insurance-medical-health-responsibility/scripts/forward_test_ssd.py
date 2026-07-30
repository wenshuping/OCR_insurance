#!/usr/bin/env python3
"""Read-only forward test for medical/health responsibility artifacts."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
NUMBER_TOKEN_RE = re.compile(r"\d[\d,]*(?:\.\d+)?(?:%|元|万元|天|次|年|个月|日)")
MEDICAL_RESPONSIBILITY_TERMS = (
    "医疗保险金",
    "医疗费用",
    "住院津贴",
    "住院补贴",
    "门诊保险金",
    "门急诊保险金",
    "药品费用保险金",
    "护理保险金",
)
FALSE_TITLE_TERMS = (
    "释义",
    "定义",
    "除外责任",
    "免责",
    "理赔申请",
    "如何申请",
    "就医流程",
    "理赔流程",
    "医院范围",
    "医疗机构范围",
)
REIMBURSEMENT_TERMS = ("报销", "补偿", "实际发生", "医疗费用", "扣除")
FIXED_TERMS = ("津贴", "补贴", "每日给付", "日额")
SOCIAL_INSURANCE_TERMS = ("基本医疗保险", "公费医疗", "医保")
SHARED_LIMIT_TERMS = (
    "共享限额",
    "共用限额",
    "公共保险金额",
    "累计给付金额之和",
    "各项医疗保险金责任累计",
    "家庭保单",
)
GROUP_TERMS = (
    "投保团体",
    "团体成员",
    "成员资格",
    "离开投保团体",
    "团体共享",
)
RIDER_TERMS = ("本附加合同", "主合同")
STUDENT_SAMPLE_TERMS = ("学生", "学平", "幼儿")
DISALLOWED_MEDICAL_BASES = {
    "account_value",
    "cash_value",
    "annual_premium",
    "first_premium",
    "total_paid_premium",
    "actual_paid_premium",
}


def parse_json(value: Any, default: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    if not isinstance(value, str) or not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def normalized_numeric_tokens(text: str) -> set[str]:
    tokens: set[str] = set()
    for token in NUMBER_TOKEN_RE.findall(text):
        match = re.fullmatch(r"([\d,]+(?:\.\d+)?)(%|元|万元|天|次|年|个月|日)", token)
        if not match:
            continue
        number, unit = match.groups()
        number = number.replace(",", "")
        if "." in number:
            number = number.rstrip("0").rstrip(".")
        number = number.lstrip("0") or "0"
        tokens.add(f"{number}{unit}")
    return tokens


def digest_of_row_payload(payload: dict[str, Any]) -> str:
    direct = payload.get("sourceDigest")
    if isinstance(direct, str) and direct:
        return direct
    identity = payload.get("responsibilityProductIdentity")
    if isinstance(identity, dict):
        nested = identity.get("sourceDigest")
        if isinstance(nested, str):
            return nested
    return ""


def iter_segments(value: Any) -> list[str]:
    segments: list[str] = []
    if isinstance(value, str) and value.strip():
        segments.append(value)
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, dict):
                text = item.get("sourceExcerpt")
                if isinstance(text, str) and text.strip():
                    segments.append(text)
    return segments


def official_evidence_text(payload: dict[str, Any]) -> str:
    parts: list[str] = []
    for key in ("responsibilities", "officialChecklist", "productRules", "productServices"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            parts.extend(iter_segments(item.get("sourceExcerpt")))
            parts.extend(iter_segments(item.get("evidenceSegments")))
            for nested_key in ("indicators",):
                nested_items = item.get(nested_key)
                if isinstance(nested_items, list):
                    for nested in nested_items:
                        if isinstance(nested, dict):
                            parts.extend(iter_segments(nested.get("sourceExcerpt")))
                            parts.extend(iter_segments(nested.get("evidenceSegments")))
    overview = payload.get("productOverview")
    if isinstance(overview, dict):
        for key in ("importantLimits", "mainFunctions"):
            values = overview.get(key)
            if isinstance(values, list):
                parts.extend(str(value) for value in values if value)
    return "\n".join(parts)


def responsibility_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    records = payload.get("responsibilities")
    return [item for item in records if isinstance(item, dict)] if isinstance(records, list) else []


def is_medical_artifact(payload: dict[str, Any]) -> bool:
    for responsibility in responsibility_records(payload):
        text = "\n".join(
            str(responsibility.get(key) or "")
            for key in ("liability", "triggerCondition", "insurerObligation", "sourceExcerpt")
        )
        if any(term in text for term in MEDICAL_RESPONSIBILITY_TERMS):
            return True
        indicators = responsibility.get("indicators")
        if isinstance(indicators, list):
            for indicator in indicators:
                if not isinstance(indicator, dict):
                    continue
                basis = str(indicator.get("basisKey") or "")
                formula = str(indicator.get("formulaText") or "")
                if basis in {"medical_expense", "actual_expense"} or "医疗费用" in formula:
                    return True
    return False


def artifact_features(payload: dict[str, Any], product_name: str) -> dict[str, Any]:
    responsibilities = responsibility_records(payload)
    evidence = official_evidence_text(payload)
    medical_responsibilities = []
    for responsibility in responsibilities:
        responsibility_text = "\n".join(
            str(responsibility.get(key) or "")
            for key in ("liability", "triggerCondition", "insurerObligation", "sourceExcerpt")
        )
        if any(term in responsibility_text for term in MEDICAL_RESPONSIBILITY_TERMS):
            medical_responsibilities.append(responsibility)
            continue
        indicators = responsibility.get("indicators")
        if isinstance(indicators, list) and any(
            isinstance(indicator, dict)
            and (
                indicator.get("basisKey") in {"medical_expense", "actual_expense"}
                or "医疗费用" in str(indicator.get("formulaText") or "")
            )
            for indicator in indicators
        ):
            medical_responsibilities.append(responsibility)
    medical_text = "\n".join(
        "\n".join(
            str(responsibility.get(key) or "")
            for key in ("liability", "triggerCondition", "insurerObligation", "sourceExcerpt")
        )
        for responsibility in medical_responsibilities
    )
    medical_ids = {
        str(responsibility.get("responsibilityId"))
        for responsibility in medical_responsibilities
        if responsibility.get("responsibilityId")
    }
    applicable_rule_parts: list[str] = []
    for rule in payload.get("productRules") or []:
        if not isinstance(rule, dict):
            continue
        affected = {
            str(value)
            for value in (rule.get("affectedResponsibilityIds") or [])
            if value
        }
        if affected and not (affected & medical_ids):
            continue
        applicable_rule_parts.extend(iter_segments(rule.get("sourceExcerpt")))
        applicable_rule_parts.extend(iter_segments(rule.get("evidenceSegments")))
        calculation = rule.get("calculation")
        if isinstance(calculation, dict):
            applicable_rule_parts.extend(iter_segments(calculation.get("sourceExcerpt")))
            applicable_rule_parts.extend(iter_segments(calculation.get("evidenceSegments")))
    combined = f"{medical_text}\n" + "\n".join(applicable_rule_parts)
    topology_text = evidence
    percent_tokens = sorted(set(re.findall(r"\d+(?:\.\d+)?%", combined)))
    deductible_tokens = sorted(
        set(
            re.findall(
                r"(?:\d+(?:\.\d+)?(?:元|万元)?免赔额|免赔额(?:为|是)?\d+(?:\.\d+)?(?:元|万元)?)",
                combined,
            )
        )
    )
    has_rider = all(term in topology_text for term in RIDER_TERMS)
    has_group = any(term in topology_text for term in GROUP_TERMS)
    explicit_standalone = "本合同为主险合同" in topology_text or "主险合同" in topology_text
    if has_group and has_rider:
        topology = "review"
        topology_issue = "rider_group_composite_requires_contract_decision"
    elif has_rider:
        topology = "rider"
        topology_issue = ""
    elif has_group:
        topology = "group"
        topology_issue = ""
    elif explicit_standalone:
        topology = "standalone"
        topology_issue = ""
    else:
        topology = "review"
        topology_issue = "contract_topology_not_explicit_in_stored_evidence"

    has_reimbursement = any(term in combined for term in REIMBURSEMENT_TERMS)
    has_fixed = any(term in combined for term in FIXED_TERMS)
    if has_reimbursement and has_fixed:
        payment_mode = "mixed"
    elif has_fixed:
        payment_mode = "fixed_benefit"
    else:
        payment_mode = "reimbursement"

    parent_ids = [
        item.get("parentResponsibilityId")
        for item in responsibilities
        if item.get("parentResponsibilityId")
    ]
    shared_rule = any(term in combined for term in SHARED_LIMIT_TERMS)
    special = any(term in combined for term in ("特定药", "特药", "质子", "重离子"))
    overseas = any(term in combined for term in ("海外", "境外", "国外", "全球"))
    social = any(term in combined for term in SOCIAL_INSURANCE_TERMS)
    social_branches = (
        social
        and any(term in combined for term in ("未从基本医疗保险", "未以基本医疗保险", "没有通过基本医疗保险"))
        and any(term in combined for term in ("已从基本医疗保险", "以基本医疗保险", "通过基本医疗保险"))
    )
    inpatient = "住院" in combined
    outpatient = any(term in combined for term in ("门诊", "门急诊", "门（急）诊", "门 急 诊"))
    bundle_candidate = any(term in product_name for term in STUDENT_SAMPLE_TERMS)
    multi_tier = (
        len(percent_tokens) >= 2
        and "免赔额" in combined
        and any(term in combined for term in ("计划", "给付比例表", "保险金给付比例表"))
    ) or (len(percent_tokens) >= 2 and len(deductible_tokens) >= 2)

    if bundle_candidate:
        stratum = "student_bundle_mapping_review"
    elif topology == "rider":
        stratum = "rider_medical"
    elif topology == "group":
        stratum = "group_medical"
    elif special and overseas:
        stratum = "special_drug_proton_overseas"
    elif special:
        stratum = "special_drug_or_proton"
    elif overseas:
        stratum = "overseas_medical"
    elif social_branches:
        stratum = "social_insurance_branches"
    elif multi_tier:
        stratum = "multi_tier_deductible_ratio"
    elif shared_rule:
        stratum = "shared_or_aggregate_limit"
    elif inpatient and outpatient:
        stratum = "inpatient_and_outpatient"
    elif payment_mode == "fixed_benefit":
        stratum = "fixed_benefit"
    else:
        stratum = "other_medical"

    return {
        "stratum": stratum,
        "paymentModeSignal": payment_mode,
        "topologySignal": topology,
        "topologyIssue": topology_issue,
        "bundleCandidateSamplingOnly": bundle_candidate,
        "socialInsurance": social,
        "socialInsuranceBranches": social_branches,
        "deductibleTokenCount": len(deductible_tokens),
        "multiTierDeductibleRatio": multi_tier,
        "reimbursementRateTokens": percent_tokens,
        "sharedOrAggregateLimit": shared_rule,
        "inpatient": inpatient,
        "outpatient": outpatient,
        "specialDrugOrProtonHeavyIon": special,
        "overseas": overseas,
        "parentResponsibilityLinks": len(parent_ids),
        "medicalResponsibilityCount": len(medical_responsibilities),
        "officialEvidenceChars": len(evidence),
    }


def exact_digest_match(row_digest: str, source_digest: str) -> bool:
    return bool(row_digest and source_digest and row_digest == source_digest)


def row_responsibility_id(payload: dict[str, Any]) -> str:
    value = payload.get("responsibilityId")
    return value if isinstance(value, str) else ""


def select_sample(
    cohort: list[dict[str, Any]], sample_size: int
) -> list[dict[str, Any]]:
    by_stratum: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in cohort:
        by_stratum[item["features"]["stratum"]].append(item)
    for items in by_stratum.values():
        items.sort(
            key=lambda item: (
                not item.get("sameDigestProjectionReady", False),
                item["company"],
                item["productName"],
                item["sourceDigest"],
            )
        )

    priority = [
        "student_bundle_mapping_review",
        "rider_medical",
        "group_medical",
        "social_insurance_branches",
        "shared_or_aggregate_limit",
        "inpatient_and_outpatient",
        "special_drug_proton_overseas",
        "special_drug_or_proton",
        "overseas_medical",
        "fixed_benefit",
        "multi_tier_deductible_ratio",
        "other_medical",
    ]
    selected: list[dict[str, Any]] = []
    selected_keys: set[tuple[str, str, str]] = set()
    company_counts: Counter[str] = Counter()

    def add(item: dict[str, Any]) -> None:
        key = (item["company"], item["productName"], item["sourceDigest"])
        if key in selected_keys:
            return
        selected.append(item)
        selected_keys.add(key)
        company_counts[item["company"]] += 1

    for stratum in priority:
        candidates = by_stratum.get(stratum, [])
        if not candidates:
            continue
        candidates = sorted(
            candidates,
            key=lambda item: (
                not item.get("sameDigestProjectionReady", False),
                company_counts[item["company"]],
                item["company"],
                item["productName"],
                item["sourceDigest"],
            ),
        )
        add(candidates[0])
        if len(selected) >= sample_size:
            return selected

    remaining_by_stratum = {
        stratum: [
            item
            for item in by_stratum.get(stratum, [])
            if (item["company"], item["productName"], item["sourceDigest"]) not in selected_keys
        ]
        for stratum in priority
    }
    while len(selected) < sample_size:
        added = False
        stratum_counts = Counter(item["features"]["stratum"] for item in selected)
        ordered_strata = sorted(
            priority,
            key=lambda stratum: (stratum_counts[stratum], priority.index(stratum)),
        )
        for max_per_company in (2, 3, 4, 999):
            for stratum in ordered_strata:
                candidates = sorted(
                    remaining_by_stratum.get(stratum, []),
                    key=lambda item: (
                        not item.get("sameDigestProjectionReady", False),
                        company_counts[item["company"]],
                        item["company"],
                        item["productName"],
                        item["sourceDigest"],
                    ),
                )
                item = next(
                    (
                        candidate
                        for candidate in candidates
                        if (
                            candidate["company"],
                            candidate["productName"],
                            candidate["sourceDigest"],
                        )
                        not in selected_keys
                        if company_counts[candidate["company"]] < max_per_company
                    ),
                    None,
                )
                if item is None:
                    continue
                add(item)
                added = True
                if len(selected) >= sample_size:
                    break
            if len(selected) >= sample_size or added:
                break
        if not added:
            break
    return selected


def table_query_plan(connection: sqlite3.Connection, table: str) -> list[str]:
    rows = connection.execute(
        f"EXPLAIN QUERY PLAN SELECT id, payload FROM {table} "
        "WHERE company=? AND product_name=?",
        ("示例", "示例"),
    ).fetchall()
    return [str(row[3]) for row in rows]


def scoped_rows(
    connection: sqlite3.Connection,
    table: str,
    company: str,
    product_name: str,
) -> list[sqlite3.Row]:
    if table == "product_customer_responsibility_summaries":
        return connection.execute(
            "SELECT id, source_digest, payload, summary_json, status "
            "FROM product_customer_responsibility_summaries "
            "WHERE company=? AND product_name=?",
            (company, product_name),
        ).fetchall()
    return connection.execute(
        f"SELECT id, payload FROM {table} WHERE company=? AND product_name=?",
        (company, product_name),
    ).fetchall()


def formula_records(payload: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for responsibility in responsibility_records(payload):
        indicators = responsibility.get("indicators")
        if isinstance(indicators, list):
            records.extend(item for item in indicators if isinstance(item, dict))
    rules = payload.get("productRules")
    if isinstance(rules, list):
        for rule in rules:
            if isinstance(rule, dict) and isinstance(rule.get("calculation"), dict):
                records.append(rule["calculation"])
    return records


def inspect_sample(
    connection: sqlite3.Connection,
    item: dict[str, Any],
) -> dict[str, Any]:
    company = item["company"]
    product_name = item["productName"]
    source_digest = item["sourceDigest"]
    payload = item["payload"]
    features = item["features"]
    responsibilities = responsibility_records(payload)
    artifact_ids = {
        str(responsibility.get("responsibilityId"))
        for responsibility in responsibilities
        if responsibility.get("responsibilityId")
    }
    official_ids = {
        str(row.get("responsibilityId"))
        for row in (payload.get("officialChecklist") or [])
        if isinstance(row, dict) and row.get("responsibilityId")
    }
    cards = scoped_rows(connection, "product_responsibility_cards", company, product_name)
    indicators = scoped_rows(connection, "insurance_indicator_records", company, product_name)
    summaries = scoped_rows(
        connection, "product_customer_responsibility_summaries", company, product_name
    )

    exact_cards: list[dict[str, Any]] = []
    for row in cards:
        row_payload = parse_json(row["payload"], {})
        if exact_digest_match(digest_of_row_payload(row_payload), source_digest):
            exact_cards.append(row_payload)
    exact_indicators: list[dict[str, Any]] = []
    for row in indicators:
        row_payload = parse_json(row["payload"], {})
        if exact_digest_match(digest_of_row_payload(row_payload), source_digest):
            exact_indicators.append(row_payload)
    digest_without_prefix = source_digest.removeprefix("sha256:")
    exact_summaries = [
        row
        for row in summaries
        if str(row["source_digest"] or "") in {source_digest, digest_without_prefix}
    ]

    card_ids = {row_responsibility_id(row) for row in exact_cards if row_responsibility_id(row)}
    indicator_ids = {
        row_responsibility_id(row) for row in exact_indicators if row_responsibility_id(row)
    }
    evidence_issues: list[str] = []
    split_issues: list[str] = []
    numeric_issues: list[str] = []
    profile_gaps: list[str] = []

    identity_digest = (
        payload.get("productIdentity", {}).get("sourceDigest")
        if isinstance(payload.get("productIdentity"), dict)
        else ""
    )
    if identity_digest != source_digest:
        evidence_issues.append("artifact_identity_digest_mismatch")
    if payload.get("audit", {}).get("status") != "approved":
        evidence_issues.append("artifact_not_approved")
    if not payload.get("productIdentity", {}).get("sourceUrl"):
        evidence_issues.append("missing_official_source_url")
    missing_responsibility_evidence = 0
    for responsibility in responsibilities:
        has_evidence = bool(iter_segments(responsibility.get("sourceExcerpt"))) or bool(
            iter_segments(responsibility.get("evidenceSegments"))
        )
        if not has_evidence:
            missing_responsibility_evidence += 1
    if missing_responsibility_evidence:
        evidence_issues.append(
            f"responsibilities_missing_exact_evidence:{missing_responsibility_evidence}"
        )
    if not exact_cards:
        evidence_issues.append("missing_same_digest_cards")
    if not exact_indicators:
        evidence_issues.append("missing_same_digest_indicators")
    if exact_cards and artifact_ids != card_ids:
        evidence_issues.append("artifact_card_responsibility_id_mismatch")
    if exact_indicators and not artifact_ids.issubset(indicator_ids):
        evidence_issues.append("artifact_indicator_responsibility_id_missing")
    if not exact_summaries:
        evidence_issues.append("missing_same_digest_customer_summary")

    if official_ids and official_ids != artifact_ids:
        split_issues.append("official_inventory_artifact_id_mismatch")
    if exact_cards and len(exact_cards) < len(artifact_ids):
        split_issues.append("possible_under_split_in_cards")
    if exact_cards and len(exact_cards) > len(artifact_ids):
        split_issues.append("possible_over_split_in_cards")
    for responsibility in responsibilities:
        title = str(responsibility.get("liability") or "")
        if any(term in title for term in FALSE_TITLE_TERMS):
            split_issues.append(f"false_title_as_responsibility:{title}")
        source_excerpt = str(responsibility.get("sourceExcerpt") or "")
        named_benefits = set(
            re.findall(
                r"(?:^|[。\n；])\s*"
                r"(?:（[一二三四五六七八九十\d]+）|\d+[、.](?!\d))\s*"
                r"([^。\n；：]{1,30}保险金)",
                source_excerpt,
            )
        )
        if len(named_benefits) >= 2 and not responsibility.get("parentResponsibilityId"):
            split_issues.append(
                f"possible_under_split_multiple_named_benefits:{responsibility.get('responsibilityId','')}"
            )

    formulas = formula_records(payload) + exact_indicators
    evidence = official_evidence_text(payload)
    for record in formulas:
        formula_text = "\n".join(
            str(record.get(key) or "") for key in ("formulaText", "normalizedFormula")
        )
        formula_tokens = normalized_numeric_tokens(formula_text)
        record_evidence = "\n".join(
            iter_segments(record.get("sourceExcerpt"))
            + iter_segments(record.get("evidenceSegments"))
            + [str(token) for token in (record.get("evidenceTokens") or [])]
        )
        evidence_tokens = normalized_numeric_tokens(record_evidence)
        unsupported = sorted(formula_tokens - evidence_tokens)
        if unsupported:
            numeric_issues.append(
                "formula_numeric_token_not_in_own_evidence:" + ",".join(unsupported)
            )
    if features["socialInsuranceBranches"]:
        branch_count = sum(
            len(record.get("branches") or [])
            for record in formulas
            if isinstance(record.get("branches"), list)
        )
        if branch_count < 2:
            numeric_issues.append("missing_social_insurance_formula_branches")
    if features["deductibleTokenCount"] >= 2 and len(features["reimbursementRateTokens"]) >= 2:
        branch_count = sum(
            len(record.get("branches") or [])
            for record in formulas
            if isinstance(record.get("branches"), list)
        )
        if branch_count < 2:
            numeric_issues.append("missing_multi_tier_formula_branches")
    for record in formulas:
        basis = str(record.get("basisKey") or "")
        record_text = " ".join(
            str(record.get(key) or "")
            for key in ("formulaText", "sourceExcerpt", "liability", "indicatorName")
        )
        if basis in DISALLOWED_MEDICAL_BASES and (
            "医疗费用" in record_text or "住院" in record_text or "门诊" in record_text
        ):
            numeric_issues.append(f"medical_reimbursement_basis_mismatch:{basis}")

    if not any(isinstance(row.get("medicalProfile"), dict) for row in responsibilities):
        profile_gaps.append("medical_profile_not_materialized")
    if features["topologySignal"] != "review" and not isinstance(
        payload.get("contractTopology"), dict
    ):
        profile_gaps.append("contract_topology_evidence_not_structured")
    if features["topologySignal"] == "review":
        profile_gaps.append(features["topologyIssue"])
    if any(term in evidence for term in ("医院", "医疗机构")):
        profile_gaps.append("facility_scope_requires_structured_extraction")
    if features["socialInsurance"]:
        profile_gaps.append("social_insurance_scope_requires_structured_extraction")
    if "免赔额" in evidence:
        profile_gaps.append("deductible_scope_requires_structured_extraction")
    if any(term in evidence for term in ("年度限额", "累计限额", "保险金额为限")):
        profile_gaps.append("limit_scope_requires_structured_extraction")
    if any(term in evidence for term in ("等待期", "既往症")):
        profile_gaps.append("waiting_or_preexisting_scope_requires_structured_extraction")
    if features["bundleCandidateSamplingOnly"]:
        profile_gaps.append("bundle_mapping_required_marketing_plan_to_filed_component")

    issues = evidence_issues + split_issues + numeric_issues + profile_gaps
    return {
        "company": company,
        "productName": product_name,
        "sourceDigest": source_digest,
        "identityKey": [company, product_name, source_digest],
        "stratum": features["stratum"],
        "features": features,
        "artifact": {
            "id": item["artifactId"],
            "publishedAt": item["publishedAt"],
            "responsibilityCount": len(artifact_ids),
            "officialChecklistCount": len(official_ids),
        },
        "readback": {
            "productLevelCardCount": len(cards),
            "sameDigestCardCount": len(exact_cards),
            "productLevelIndicatorCount": len(indicators),
            "sameDigestIndicatorCount": len(exact_indicators),
            "productLevelCustomerSummaryCount": len(summaries),
            "sameDigestCustomerSummaryCount": len(exact_summaries),
        },
        "gates": {
            "evidence": "pass" if not evidence_issues else "review",
            "split": "pass" if not split_issues else "review",
            "numeric": "pass" if not numeric_issues else "review",
            "profile": "pass" if not profile_gaps else "review",
        },
        "evidenceIssues": sorted(set(evidence_issues)),
        "splitIssues": sorted(set(split_issues)),
        "numericIssues": sorted(set(numeric_issues)),
        "profileGaps": sorted(set(profile_gaps)),
        "result": "pass" if not issues else "review",
    }


def load_cohort(connection: sqlite3.Connection) -> tuple[list[dict[str, Any]], dict[str, int]]:
    rows = connection.execute(
        "SELECT a.id, a.company, a.product_name, a.source_digest, a.source_url, "
        "a.published_at, a.payload, "
        "EXISTS (SELECT 1 FROM product_responsibility_cards c "
        " WHERE c.company=a.company AND c.product_name=a.product_name "
        " AND json_extract(c.payload,'$.sourceDigest')=a.source_digest) AS same_digest_cards, "
        "EXISTS (SELECT 1 FROM insurance_indicator_records i "
        " WHERE i.company=a.company AND i.product_name=a.product_name "
        " AND json_extract(i.payload,'$.sourceDigest')=a.source_digest) AS same_digest_indicators "
        "FROM product_responsibility_artifacts a "
        "WHERE json_extract(a.payload,'$.audit.status')='approved'"
    ).fetchall()
    stats = {"approvedArtifactRows": len(rows), "invalidPayloadRows": 0, "medicalRows": 0}
    exact: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        payload = parse_json(row["payload"], {})
        if not isinstance(payload, dict) or not payload:
            stats["invalidPayloadRows"] += 1
            continue
        if not is_medical_artifact(payload):
            continue
        stats["medicalRows"] += 1
        key = (str(row["company"]), str(row["product_name"]), str(row["source_digest"]))
        item = {
            "artifactId": str(row["id"]),
            "company": key[0],
            "productName": key[1],
            "sourceDigest": key[2],
            "sourceUrl": str(row["source_url"] or ""),
            "publishedAt": str(row["published_at"] or ""),
            "payload": payload,
            "sameDigestProjectionReady": bool(
                row["same_digest_cards"] and row["same_digest_indicators"]
            ),
        }
        item["features"] = artifact_features(payload, item["productName"])
        prior = exact.get(key)
        if prior is None or (item["publishedAt"], item["artifactId"]) > (
            prior["publishedAt"],
            prior["artifactId"],
        ):
            exact[key] = item
    cohort = sorted(
        exact.values(),
        key=lambda item: (item["company"], item["productName"], item["sourceDigest"]),
    )
    stats["exactDeduplicatedCohort"] = len(cohort)
    stats["duplicateMedicalRowsRemoved"] = stats["medicalRows"] - len(cohort)
    stats["sameDigestCardAndIndicatorCohort"] = sum(
        bool(item["sameDigestProjectionReady"]) for item in cohort
    )
    return cohort, stats


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--sample-size", type=int, default=24)
    args = parser.parse_args()
    if args.sample_size < 20:
        parser.error("--sample-size must be at least 20")

    db_path = Path(args.db).resolve()
    output_path = Path(args.output).resolve()
    if not db_path.is_file():
        parser.error(f"database not found: {db_path}")
    stat_before = db_path.stat()
    uri = f"file:{db_path.as_posix()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("BEGIN")
    metadata = {
        "journalMode": connection.execute("PRAGMA journal_mode").fetchone()[0],
        "schemaVersion": connection.execute("PRAGMA schema_version").fetchone()[0],
        "userVersion": connection.execute("PRAGMA user_version").fetchone()[0],
        "pageCount": connection.execute("PRAGMA page_count").fetchone()[0],
        "dataVersion": connection.execute("PRAGMA data_version").fetchone()[0],
        "queryPlans": {
            "cards": table_query_plan(connection, "product_responsibility_cards"),
            "indicators": table_query_plan(connection, "insurance_indicator_records"),
            "summaries": table_query_plan(
                connection, "product_customer_responsibility_summaries"
            ),
        },
    }
    cohort, cohort_stats = load_cohort(connection)
    selected = select_sample(cohort, args.sample_size)
    samples = [inspect_sample(connection, item) for item in selected]
    connection.execute("ROLLBACK")
    total_changes = connection.total_changes
    connection.close()
    stat_after = db_path.stat()

    strata = Counter(sample["stratum"] for sample in samples)
    companies = Counter(sample["company"] for sample in samples)
    gate_counts = {
        gate: dict(Counter(sample["gates"][gate] for sample in samples))
        for gate in ("evidence", "split", "numeric", "profile")
    }
    issue_counts = Counter(
        issue.split(":", 1)[0]
        for sample in samples
        for field in ("evidenceIssues", "splitIssues", "numericIssues", "profileGaps")
        for issue in sample[field]
    )
    payload = {
        "schemaVersion": "medical-health-forward-test-v1",
        "generatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "mode": "read_only",
        "database": {
            "path": str(db_path),
            "sizeBytesBefore": stat_before.st_size,
            "mtimeNsBefore": stat_before.st_mtime_ns,
            "sizeBytesAfter": stat_after.st_size,
            "mtimeNsAfter": stat_after.st_mtime_ns,
            "connectionTotalChanges": total_changes,
            **metadata,
        },
        "cohortDefinition": {
            "identity": "exact company + productName + sourceDigest",
            "artifactGate": "payload.audit.status == approved",
            "medicalGate": (
                "accepted responsibility or indicator contains medical expense, "
                "medical payment, inpatient/outpatient allowance, drug expense, "
                "or nursing-benefit evidence; product name is not used"
            ),
            "dedupe": "latest published_at then artifact id within the exact identity",
            "projectionGate": (
                "cards, indicators, and customer summaries are evaluated separately "
                "and pass only on the same sourceDigest"
            ),
        },
        "cohort": {
            **cohort_stats,
            "companyCount": len({item["company"] for item in cohort}),
            "strata": dict(
                sorted(Counter(item["features"]["stratum"] for item in cohort).items())
            ),
        },
        "sample": {
            "requested": args.sample_size,
            "selected": len(samples),
            "uniqueExactIdentities": len(
                {
                    tuple(sample["identityKey"])
                    for sample in samples
                }
            ),
            "mutuallyExclusiveStrata": dict(sorted(strata.items())),
            "companies": dict(sorted(companies.items())),
        },
        "summary": {
            "resultCounts": dict(Counter(sample["result"] for sample in samples)),
            "gateCounts": gate_counts,
            "issueCounts": dict(sorted(issue_counts.items())),
            "databaseWriteCount": total_changes,
        },
        "samples": samples,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    digest = hashlib.sha256(output_path.read_bytes()).hexdigest()
    print(
        json.dumps(
            {
                "ok": len(samples) >= 20 and total_changes == 0,
                "output": str(output_path),
                "sha256": digest,
                "cohort": len(cohort),
                "samples": len(samples),
                "databaseWriteCount": total_changes,
                "resultCounts": payload["summary"]["resultCounts"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0 if len(samples) >= 20 and total_changes == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
