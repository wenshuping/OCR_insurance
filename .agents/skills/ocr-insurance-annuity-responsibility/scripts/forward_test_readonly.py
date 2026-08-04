#!/usr/bin/env python3
"""Run a stratified, exact-digest annuity audit against SQLite in read-only mode."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


SCRIPT_VERSION = "annuity-forward-test-v1"
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
NUMBER_TOKEN_RE = re.compile(r"\d+(?:\.\d+)?%?")
ANNUITY_TITLE_TERMS = (
    "年金",
    "养老金",
    "教育金",
    "深造金",
    "立业金",
    "婚嫁金",
    "创业金",
    "祝寿金",
    "生存金",
)
CONVERSION_ONLY_TERMS = ("年金转换选择权", "年金转换权", "转换为年金产品")
FUNCTION_ONLY_TERMS = (
    "账户结算",
    "结算利率",
    "最低保证利率",
    "红利分配",
    "现金红利",
    "累积红利",
    "保单贷款",
    "自动垫交",
    "部分领取",
    "退保",
    "现金价值表",
)
STRATUM_ORDER = (
    "education_annuity",
    "guaranteed_annuity",
    "increasing_or_decreasing",
    "universal_or_participating_linked",
    "multiple_frequency_or_method",
    "pension_annuity",
    "death_and_maturity_linked",
    "ordinary_annuity",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--sample-size", type=int, default=24)
    return parser.parse_args()


def json_load(raw: object, default: object) -> object:
    if not isinstance(raw, str):
        return default
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return default


def json_text(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def normalize_digest(value: object) -> str:
    if not isinstance(value, str):
        return ""
    value = value.strip().lower()
    if re.fullmatch(r"[0-9a-f]{64}", value):
        return f"sha256:{value}"
    return value


def normalize_evidence_text(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value))


def responsibility_evidence_text(responsibility: dict[str, object]) -> str:
    parts: list[str] = []
    for key in (
        "liability",
        "title",
        "triggerCondition",
        "insurerObligation",
        "sourceExcerpt",
    ):
        value = responsibility.get(key)
        if isinstance(value, str):
            parts.append(value)
    for segment in responsibility.get("evidenceSegments") or []:
        if isinstance(segment, dict) and isinstance(segment.get("sourceExcerpt"), str):
            parts.append(segment["sourceExcerpt"])
    return "\n".join(parts)


def responsibility_text(responsibility: dict[str, object]) -> str:
    parts = [responsibility_evidence_text(responsibility)]
    for indicator in responsibility.get("indicators") or []:
        if isinstance(indicator, dict):
            for key in ("indicatorName", "formulaText", "normalizedFormula"):
                value = indicator.get(key)
                if isinstance(value, str):
                    parts.append(value)
    return "\n".join(parts)


def has_trigger_and_obligation(responsibility: dict[str, object]) -> bool:
    trigger = str(responsibility.get("triggerCondition") or "")
    obligation = str(responsibility.get("insurerObligation") or "")
    excerpt = str(responsibility.get("sourceExcerpt") or "")
    trigger_signal = any(term in f"{trigger}\n{excerpt}" for term in ("生存", "领取日", "周年日", "年满", "期满"))
    obligation_signal = any(term in f"{obligation}\n{excerpt}" for term in ("给付", "支付", "领取"))
    return trigger_signal and obligation_signal


def is_annuity_responsibility(responsibility: dict[str, object]) -> bool:
    text = responsibility_text(responsibility)
    if not any(term in text for term in ANNUITY_TITLE_TERMS):
        return False
    if any(term in text for term in CONVERSION_ONLY_TERMS) and not has_trigger_and_obligation(responsibility):
        return False
    return has_trigger_and_obligation(responsibility)


def source_excerpt_count(responsibilities: list[dict[str, object]]) -> int:
    count = 0
    for responsibility in responsibilities:
        excerpt = responsibility.get("sourceExcerpt")
        segments = responsibility.get("evidenceSegments")
        if isinstance(excerpt, str) and excerpt.strip():
            count += 1
        elif isinstance(segments, list) and any(
            isinstance(segment, dict) and str(segment.get("sourceExcerpt") or "").strip()
            for segment in segments
        ):
            count += 1
    return count


def structural_flags(artifact: dict[str, object], annuity_items: list[dict[str, object]]) -> list[str]:
    responsibilities = [
        item for item in artifact.get("responsibilities") or [] if isinstance(item, dict)
    ]
    annuity_text = "\n".join(responsibility_text(item) for item in annuity_items)
    all_text = "\n".join(responsibility_text(item) for item in responsibilities)
    overview = artifact.get("productOverview")
    overview_text = json_text(overview if isinstance(overview, dict) else {})
    flags: list[str] = []

    checks = (
        ("ordinary_annuity", bool(annuity_items)),
        ("pension_annuity", any(term in annuity_text for term in ("养老年金", "养老金"))),
        (
            "education_annuity",
            any(term in annuity_text for term in ("教育金", "深造金", "立业金", "婚嫁金", "创业金")),
        ),
        (
            "guaranteed_annuity",
            any(term in all_text for term in ("保证领取", "保证给付", "保证养老年金", "剩余固定年金")),
        ),
        (
            "multiple_frequency_or_method",
            (
                any(term in annuity_text for term in ("按年领取", "年领"))
                and any(term in annuity_text for term in ("按月领取", "月领"))
            )
            or "领取方式" in annuity_text,
        ),
        (
            "death_return",
            any("身故" in str(item.get("liability") or item.get("title") or "") for item in responsibilities),
        ),
        (
            "maturity_benefit",
            any("满期" in str(item.get("liability") or item.get("title") or "") for item in responsibilities),
        ),
        (
            "universal_or_participating_linked",
            any(term in f"{overview_text}\n{all_text}" for term in ("万能型", "分红型", "个人账户价值", "累计增额红利")),
        ),
        (
            "increasing_or_decreasing",
            any(term in annuity_text for term in ("递增", "递减", "逐年增加", "逐年减少", "上一年年金")),
        ),
        (
            "account_value_basis",
            any(term in annuity_text for term in ("个人账户价值", "保留账户价值", "账户价值")),
        ),
    )
    for label, present in checks:
        if present:
            flags.append(label)
    return flags


def primary_stratum(flags: list[str]) -> str:
    flag_set = set(flags)
    if "education_annuity" in flag_set:
        return "education_annuity"
    if "guaranteed_annuity" in flag_set:
        return "guaranteed_annuity"
    if "increasing_or_decreasing" in flag_set:
        return "increasing_or_decreasing"
    if "universal_or_participating_linked" in flag_set:
        return "universal_or_participating_linked"
    if "multiple_frequency_or_method" in flag_set:
        return "multiple_frequency_or_method"
    if "pension_annuity" in flag_set:
        return "pension_annuity"
    if {"death_return", "maturity_benefit"}.issubset(flag_set):
        return "death_and_maturity_linked"
    return "ordinary_annuity"


def infer_topology_from_evidence(artifact: dict[str, object]) -> dict[str, object]:
    declared = artifact.get("contractTopology")
    if isinstance(declared, dict) and declared.get("type") in {
        "standalone",
        "rider",
        "group",
        "bundle_component",
    }:
        return {"type": declared["type"], "basis": "artifact_exact_evidence"}
    source = "\n".join(
        responsibility_text(item)
        for item in artifact.get("responsibilities") or []
        if isinstance(item, dict)
    )
    if "本附加合同" in source:
        return {"type": "rider", "basis": "exact_responsibility_evidence_signal"}
    if any(term in source for term in ("团体保险合同", "团体年金", "个人账户中已归属部分")):
        return {"type": "group", "basis": "exact_responsibility_evidence_signal"}
    return {"type": "unknown", "basis": "topology_evidence_not_materialized"}


def load_candidates(connection: sqlite3.Connection) -> list[dict[str, object]]:
    rows = connection.execute(
        """
        SELECT id, company, product_name, source_digest, source_url, published_at, payload
          FROM product_responsibility_artifacts
         WHERE json_extract(payload, '$.audit.status') = 'approved'
         ORDER BY company, product_name, source_digest
        """
    ).fetchall()
    candidates: list[dict[str, object]] = []
    for row in rows:
        artifact = json_load(row["payload"], {})
        if not isinstance(artifact, dict):
            continue
        responsibilities = [
            item for item in artifact.get("responsibilities") or [] if isinstance(item, dict)
        ]
        annuity_items = [item for item in responsibilities if is_annuity_responsibility(item)]
        if not annuity_items:
            continue
        digest = normalize_digest(row["source_digest"])
        payload_digest = normalize_digest(
            (artifact.get("productIdentity") or {}).get("sourceDigest")
            if isinstance(artifact.get("productIdentity"), dict)
            else ""
        )
        flags = structural_flags(artifact, annuity_items)
        candidates.append(
            {
                "artifactId": row["id"],
                "company": row["company"],
                "productName": row["product_name"],
                "sourceDigest": digest,
                "sourceUrl": row["source_url"]
                or (
                    (artifact.get("productIdentity") or {}).get("sourceUrl")
                    if isinstance(artifact.get("productIdentity"), dict)
                    else None
                ),
                "publishedAt": row["published_at"],
                "artifact": artifact,
                "artifactPayloadSha256": hashlib.sha256(row["payload"].encode("utf-8")).hexdigest(),
                "identityDigestMatch": digest == payload_digest and DIGEST_RE.fullmatch(digest) is not None,
                "responsibilityCount": len(responsibilities),
                "annuityResponsibilityCount": len(annuity_items),
                "sourceExcerptCount": source_excerpt_count(responsibilities),
                "structuralFlags": flags,
                "primaryStratum": primary_stratum(flags),
                "contractTopology": infer_topology_from_evidence(artifact),
            }
        )
    return candidates


def attach_preselection_layer_gate(
    connection: sqlite3.Connection,
    candidates: list[dict[str, object]],
) -> None:
    for candidate in candidates:
        company = str(candidate["company"])
        product_name = str(candidate["productName"])
        digest = str(candidate["sourceDigest"])
        card_count = connection.execute(
            """
            SELECT count(*)
              FROM product_responsibility_cards
             WHERE company = ?
               AND product_name = ?
               AND (
                 lower(json_extract(payload, '$.sourceDigest')) = ?
                 OR lower(json_extract(payload, '$.responsibilitySourceDigest')) = ?
               )
            """,
            (company, product_name, digest, digest),
        ).fetchone()[0]
        indicator_count = connection.execute(
            """
            SELECT count(*)
              FROM insurance_indicator_records
             WHERE company = ?
               AND product_name = ?
               AND (
                 lower(json_extract(payload, '$.sourceDigest')) = ?
                 OR lower(json_extract(payload, '$.responsibilitySourceDigest')) = ?
               )
            """,
            (company, product_name, digest, digest),
        ).fetchone()[0]
        source_url = str(candidate.get("sourceUrl") or "")
        official_terms_count = connection.execute(
            """
            SELECT count(*)
              FROM knowledge_records
             WHERE url = ?
               AND json_extract(payload, '$.official') = 1
               AND length(coalesce(json_extract(payload, '$.pageText'), '')) > 0
            """,
            (source_url,),
        ).fetchone()[0]
        candidate["preselectionLayerGate"] = {
            "sameDigestCardCount": card_count,
            "sameDigestIndicatorCount": indicator_count,
            "officialTermsCount": official_terms_count,
            "passed": card_count > 0 and indicator_count > 0 and official_terms_count > 0,
        }


def select_stratified(candidates: list[dict[str, object]], sample_size: int) -> list[dict[str, object]]:
    groups: dict[str, list[dict[str, object]]] = defaultdict(list)
    for candidate in candidates:
        layer_gate = candidate.get("preselectionLayerGate")
        if not isinstance(layer_gate, dict) or not layer_gate.get("passed"):
            continue
        groups[str(candidate["primaryStratum"])].append(candidate)
    for items in groups.values():
        items.sort(
            key=lambda item: (
                -int(bool(item["identityDigestMatch"])),
                -int(item["sourceExcerptCount"]),
                str(item["company"]),
                str(item["productName"]),
                str(item["sourceDigest"]),
            )
        )

    selected: list[dict[str, object]] = []
    selected_keys: set[tuple[str, str, str]] = set()
    company_counts: Counter[str] = Counter()
    while len(selected) < sample_size:
        progressed = False
        for stratum in STRATUM_ORDER:
            available = [
                item
                for item in groups.get(stratum, [])
                if (str(item["company"]), str(item["productName"]), str(item["sourceDigest"]))
                not in selected_keys
            ]
            if not available:
                continue
            available.sort(
                key=lambda item: (
                    company_counts[str(item["company"])],
                    -int(bool(item["identityDigestMatch"])),
                    -int(item["sourceExcerptCount"]),
                    str(item["company"]),
                    str(item["productName"]),
                )
            )
            item = available[0]
            key = (str(item["company"]), str(item["productName"]), str(item["sourceDigest"]))
            selected.append(item)
            selected_keys.add(key)
            company_counts[str(item["company"])] += 1
            progressed = True
            if len(selected) >= sample_size:
                break
        if not progressed:
            break
    return selected


def row_digest(payload: dict[str, object]) -> str:
    return normalize_digest(payload.get("sourceDigest") or payload.get("responsibilitySourceDigest"))


def layer_rows(
    connection: sqlite3.Connection,
    table: str,
    company: str,
    product_name: str,
) -> list[dict[str, object]]:
    rows = connection.execute(
        f"SELECT id, payload FROM {table} WHERE company = ? AND product_name = ? ORDER BY id",
        (company, product_name),
    ).fetchall()
    result = []
    for row in rows:
        payload = json_load(row["payload"], {})
        result.append(
            {
                "id": row["id"],
                "payload": payload if isinstance(payload, dict) else {},
                "payloadSha256": hashlib.sha256(row["payload"].encode("utf-8")).hexdigest(),
            }
        )
    return result


def audit_indicator(indicator: dict[str, object], evidence: str, prefix: str) -> list[dict[str, str]]:
    issues: list[dict[str, str]] = []
    formula = str(indicator.get("formulaText") or "")
    basis = str(indicator.get("basisKey") or "")
    branches = indicator.get("branches") or []
    operands = indicator.get("operands") or []
    required_inputs = indicator.get("requiredInputs")
    evidence_tokens = indicator.get("evidenceTokens") or []
    if not formula:
        issues.append({"code": "formula_text_missing", "path": prefix})
    if formula and not basis:
        issues.append({"code": "formula_basis_missing", "path": prefix})
    if formula and not isinstance(required_inputs, list):
        issues.append({"code": "required_inputs_missing", "path": prefix})
    if ("piecewise" in basis or "分段" in formula or "按以下" in formula) and not branches:
        issues.append({"code": "piecewise_branches_missing", "path": prefix})
    if any(term in formula for term in ("较大者", "较大值", "max(", "MAX(")) and not operands and not branches:
        issues.append({"code": "max_operands_missing", "path": prefix})
    if any(term in formula for term in ("较小者", "较小值", "min(", "MIN(")) and not operands and not branches:
        issues.append({"code": "min_operands_missing", "path": prefix})
    if NUMBER_TOKEN_RE.search(formula) and not evidence_tokens:
        issues.append({"code": "formula_numeric_evidence_tokens_missing", "path": prefix})
    normalized_evidence = normalize_evidence_text(evidence)
    for token in evidence_tokens:
        if normalize_evidence_text(token) not in normalized_evidence:
            issues.append(
                {
                    "code": "indicator_evidence_token_not_in_official_excerpt",
                    "path": prefix,
                    "token": token,
                }
            )
    for index, branch in enumerate(branches):
        if not isinstance(branch, dict):
            issues.append({"code": "branch_not_object", "path": f"{prefix}.branches[{index}]"})
            continue
        for key in ("conditionText", "formulaText", "basisKey", "requiredInputs"):
            if key not in branch or branch[key] in ("", None):
                issues.append({"code": f"branch_{key}_missing", "path": f"{prefix}.branches[{index}]"})
        if not isinstance(branch.get("evidenceTokens"), list) or not branch.get("evidenceTokens"):
            issues.append(
                {"code": "branch_evidenceTokens_missing", "path": f"{prefix}.branches[{index}]"}
            )
        else:
            for token in branch["evidenceTokens"]:
                if normalize_evidence_text(token) not in normalized_evidence:
                    issues.append(
                        {
                            "code": "branch_evidence_token_not_in_official_excerpt",
                            "path": f"{prefix}.branches[{index}]",
                            "token": token,
                        }
                    )
    for index, operand in enumerate(operands):
        if not isinstance(operand, dict):
            issues.append({"code": "operand_not_object", "path": f"{prefix}.operands[{index}]"})
            continue
        for key in ("formulaText", "basisKey", "requiredInputs"):
            if key not in operand or operand[key] in ("", None):
                issues.append({"code": f"operand_{key}_missing", "path": f"{prefix}.operands[{index}]"})
        if not isinstance(operand.get("evidenceTokens"), list) or not operand.get("evidenceTokens"):
            issues.append(
                {"code": "operand_evidenceTokens_missing", "path": f"{prefix}.operands[{index}]"}
            )
    return issues


def audit_candidate(connection: sqlite3.Connection, candidate: dict[str, object]) -> dict[str, object]:
    artifact = candidate["artifact"]
    assert isinstance(artifact, dict)
    company = str(candidate["company"])
    product_name = str(candidate["productName"])
    digest = str(candidate["sourceDigest"])
    responsibilities = [
        item for item in artifact.get("responsibilities") or [] if isinstance(item, dict)
    ]
    annuity_items = [item for item in responsibilities if is_annuity_responsibility(item)]
    cards = layer_rows(connection, "product_responsibility_cards", company, product_name)
    indicators = layer_rows(connection, "insurance_indicator_records", company, product_name)
    exact_cards = [row for row in cards if row_digest(row["payload"]) == digest]
    exact_indicators = [row for row in indicators if row_digest(row["payload"]) == digest]
    official_terms_row = connection.execute(
        """
        SELECT id, url, payload
          FROM knowledge_records
         WHERE url = ?
           AND json_extract(payload, '$.official') = 1
           AND length(coalesce(json_extract(payload, '$.pageText'), '')) > 0
         ORDER BY length(json_extract(payload, '$.pageText')) DESC, id
         LIMIT 1
        """,
        (candidate["sourceUrl"],),
    ).fetchone()
    official_terms_payload = (
        json_load(official_terms_row["payload"], {}) if official_terms_row is not None else {}
    )
    official_terms_text = (
        str(official_terms_payload.get("pageText") or "")
        if isinstance(official_terms_payload, dict)
        else ""
    )
    normalized_official_terms = normalize_evidence_text(official_terms_text)
    supported_excerpt_count = 0
    for responsibility in responsibilities:
        excerpts = []
        if isinstance(responsibility.get("sourceExcerpt"), str):
            excerpts.append(responsibility["sourceExcerpt"])
        for segment in responsibility.get("evidenceSegments") or []:
            if isinstance(segment, dict) and isinstance(segment.get("sourceExcerpt"), str):
                excerpts.append(segment["sourceExcerpt"])
        if excerpts and all(
            normalize_evidence_text(excerpt) in normalized_official_terms for excerpt in excerpts
        ):
            supported_excerpt_count += 1
    issues: list[dict[str, object]] = []

    if not candidate["identityDigestMatch"]:
        issues.append({"code": "artifact_identity_digest_mismatch", "layer": "artifact"})
    if not candidate["sourceUrl"]:
        issues.append({"code": "official_source_url_missing", "layer": "artifact"})
    if candidate["sourceExcerptCount"] < candidate["responsibilityCount"]:
        issues.append({"code": "responsibility_exact_evidence_missing", "layer": "artifact"})
    if official_terms_row is None:
        issues.append({"code": "same_source_url_official_terms_missing", "layer": "official_terms"})
    elif supported_excerpt_count < candidate["responsibilityCount"]:
        issues.append(
            {
                "code": "artifact_excerpt_not_in_official_terms_text",
                "layer": "official_terms",
                "supportedResponsibilityCount": supported_excerpt_count,
                "responsibilityCount": candidate["responsibilityCount"],
            }
        )
    if not exact_cards:
        issues.append({"code": "same_digest_cards_missing", "layer": "card"})
    if not exact_indicators:
        issues.append({"code": "same_digest_indicator_rows_missing", "layer": "indicator"})
    if len(exact_cards) != len(cards):
        issues.append({"code": "cross_digest_or_unversioned_card_rows_present", "layer": "card"})
    if len(exact_indicators) != len(indicators):
        issues.append({"code": "cross_digest_or_unversioned_indicator_rows_present", "layer": "indicator"})

    for index, responsibility in enumerate(responsibilities):
        title = str(responsibility.get("liability") or responsibility.get("title") or "")
        text = responsibility_text(responsibility)
        if any(term in title for term in FUNCTION_ONLY_TERMS) and not has_trigger_and_obligation(responsibility):
            issues.append(
                {
                    "code": "probable_product_function_emitted_as_responsibility",
                    "layer": "artifact",
                    "responsibilityId": responsibility.get("responsibilityId"),
                    "title": title,
                }
            )
        if any(term in title for term in CONVERSION_ONLY_TERMS):
            issues.append(
                {
                    "code": "annuity_conversion_option_requires_product_function_review",
                    "layer": "artifact",
                    "responsibilityId": responsibility.get("responsibilityId"),
                    "title": title,
                }
            )
        for indicator_index, indicator in enumerate(responsibility.get("indicators") or []):
            if isinstance(indicator, dict):
                indicator_evidence_parts = [responsibility_evidence_text(responsibility)]
                if isinstance(indicator.get("sourceExcerpt"), str):
                    indicator_evidence_parts.append(indicator["sourceExcerpt"])
                for segment in indicator.get("evidenceSegments") or []:
                    if isinstance(segment, dict) and isinstance(segment.get("sourceExcerpt"), str):
                        indicator_evidence_parts.append(segment["sourceExcerpt"])
                issues.extend(
                    audit_indicator(
                        indicator,
                        "\n".join(indicator_evidence_parts),
                        f"responsibilities[{index}].indicators[{indicator_index}]",
                    )
                )

    for item in annuity_items:
        text = responsibility_text(item)
        responsibility_id = item.get("responsibilityId")
        if not any(term in text for term in ("领取日", "周年日", "年满", "生效满", "期满")):
            issues.append({"code": "annuity_start_condition_incomplete", "responsibilityId": responsibility_id})
        if "生存" not in text:
            issues.append({"code": "annuity_survival_condition_missing", "responsibilityId": responsibility_id})
        if not any(term in text for term in ("每年", "每月", "年领", "月领", "一次性", "按年", "按月")):
            issues.append({"code": "annuity_frequency_missing", "responsibilityId": responsibility_id})
        if not any(term in text for term in ("直至", "至", "期间", "终身", "届满", "一次性")):
            issues.append({"code": "annuity_payment_period_missing", "responsibilityId": responsibility_id})
        if not item.get("indicators"):
            issues.append({"code": "annuity_indicator_missing", "responsibilityId": responsibility_id})

    topology = candidate["contractTopology"]
    if isinstance(topology, dict) and topology.get("type") == "unknown":
        issues.append({"code": "contract_topology_not_materialized", "layer": "artifact"})

    card_ids = {
        str(row["payload"].get("responsibilityId"))
        for row in exact_cards
        if row["payload"].get("responsibilityId")
    }
    artifact_ids = {
        str(item.get("responsibilityId")) for item in responsibilities if item.get("responsibilityId")
    }
    indicator_ids = {
        str(row["payload"].get("responsibilityId"))
        for row in exact_indicators
        if row["payload"].get("responsibilityId")
    }
    if card_ids and card_ids != artifact_ids:
        issues.append({"code": "artifact_card_responsibility_id_mismatch", "layer": "readback"})
    if indicator_ids and not indicator_ids.issubset(artifact_ids):
        issues.append({"code": "indicator_unknown_responsibility_id", "layer": "readback"})

    result = {
        key: value
        for key, value in candidate.items()
        if key not in {"artifact"}
    }
    result.update(
        {
            "officialEvidenceMode": "source-url-bound official terms plus same-digest approved artifact excerpts",
            "sourceTextRead": bool(official_terms_text),
            "sourceBytesRead": False,
            "layers": {
                "officialTerms": {
                    "knowledgeRecordId": official_terms_row["id"]
                    if official_terms_row is not None
                    else None,
                    "exactSourceUrlMatch": official_terms_row is not None,
                    "official": bool(official_terms_payload.get("official"))
                    if isinstance(official_terms_payload, dict)
                    else False,
                    "pageTextLength": len(official_terms_text),
                    "pageTextSha256": hashlib.sha256(
                        official_terms_text.encode("utf-8")
                    ).hexdigest()
                    if official_terms_text
                    else None,
                    "supportedResponsibilityExcerptCount": supported_excerpt_count,
                },
                "artifact": {
                    "approved": (artifact.get("audit") or {}).get("status") == "approved"
                    if isinstance(artifact.get("audit"), dict)
                    else False,
                    "responsibilityCount": len(responsibilities),
                    "annuityResponsibilityCount": len(annuity_items),
                    "sourceExcerptCount": candidate["sourceExcerptCount"],
                },
                "cards": {
                    "rowCount": len(cards),
                    "sameDigestRowCount": len(exact_cards),
                    "payloadSha256": [row["payloadSha256"] for row in exact_cards],
                },
                "indicators": {
                    "rowCount": len(indicators),
                    "sameDigestRowCount": len(exact_indicators),
                    "payloadSha256": [row["payloadSha256"] for row in exact_indicators],
                },
            },
            "auditStatus": "passed" if not issues else "review",
            "issueCount": len(issues),
            "issues": issues,
        }
    )
    return result


def ensure_tables(connection: sqlite3.Connection) -> None:
    required = {
        "knowledge_records",
        "product_responsibility_artifacts",
        "product_responsibility_cards",
        "insurance_indicator_records",
    }
    found = {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        ).fetchall()
    }
    missing = sorted(required - found)
    if missing:
        raise RuntimeError(f"missing required tables: {', '.join(missing)}")


def write_json(path: Path, payload: dict[str, object]) -> None:
    if path.exists():
        raise FileExistsError(f"refusing to overwrite existing output: {path}")
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    if args.sample_size < 20:
        raise SystemExit("--sample-size must be at least 20")
    db_path = Path(args.db).resolve()
    output_dir = Path(args.output_dir).resolve()
    if not db_path.is_file():
        raise SystemExit(f"database not found: {db_path}")
    output_dir.mkdir(parents=True, exist_ok=True)

    db_uri = f"file:{quote(str(db_path))}?mode=ro"
    connection = sqlite3.connect(db_uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    connection.execute("PRAGMA busy_timeout = 5000")
    try:
        ensure_tables(connection)
        query_only = connection.execute("PRAGMA query_only").fetchone()[0]
        candidates = load_candidates(connection)
        attach_preselection_layer_gate(connection, candidates)
        selected = select_stratified(candidates, args.sample_size)
        audited = [audit_candidate(connection, candidate) for candidate in selected]
    finally:
        connection.close()

    if len(audited) < 20:
        raise SystemExit(f"only {len(audited)} mutually exclusive products selected")

    now = datetime.now(timezone.utc).isoformat()
    stat = db_path.stat()
    source_db = {
        "path": str(db_path),
        "sizeBytes": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
        "openedMode": "ro",
        "queryOnly": bool(query_only),
    }
    manifest_products = [
        {
            "company": item["company"],
            "productName": item["productName"],
            "sourceDigest": item["sourceDigest"],
            "sourceUrl": item["sourceUrl"],
            "artifactId": item["artifactId"],
            "artifactPayloadSha256": item["artifactPayloadSha256"],
            "primaryStratum": item["primaryStratum"],
            "structuralFlags": item["structuralFlags"],
        }
        for item in audited
    ]
    manifest = {
        "schemaVersion": 1,
        "generatedAt": now,
        "scriptVersion": SCRIPT_VERSION,
        "sourceDb": source_db,
        "selection": {
            "candidateAuthority": "approved artifact responsibility semantics",
            "productNameClassification": False,
            "mutuallyExclusiveExactTuples": True,
            "companyDiversityApplied": True,
            "sampleSizeRequested": args.sample_size,
            "selectedCount": len(audited),
        },
        "products": manifest_products,
    }
    issue_counter = Counter(
        str(issue["code"])
        for item in audited
        for issue in item.get("issues") or []
        if isinstance(issue, dict) and issue.get("code")
    )
    structural_flag_counter = Counter(
        str(flag) for item in audited for flag in item.get("structuralFlags") or []
    )
    false_responsibility_codes = {
        "probable_product_function_emitted_as_responsibility",
        "annuity_conversion_option_requires_product_function_review",
    }
    formula_codes = {
        code
        for code in issue_counter
        if code.startswith("formula_")
        or code.startswith("piecewise_")
        or code.startswith("max_")
        or code.startswith("min_")
        or code.startswith("branch_")
        or code.startswith("operand_")
    }
    audit = {
        "schemaVersion": 1,
        "generatedAt": now,
        "scriptVersion": SCRIPT_VERSION,
        "sourceDb": source_db,
        "candidateCount": len(candidates),
        "sameDigestLayerEligibleCount": sum(
            1
            for candidate in candidates
            if isinstance(candidate.get("preselectionLayerGate"), dict)
            and candidate["preselectionLayerGate"].get("passed")
        ),
        "selectedCount": len(audited),
        "passedCount": sum(1 for item in audited if item["auditStatus"] == "passed"),
        "reviewCount": sum(1 for item in audited if item["auditStatus"] == "review"),
        "stratumCounts": dict(Counter(str(item["primaryStratum"]) for item in audited)),
        "structuralFlagCounts": dict(sorted(structural_flag_counter.items())),
        "companyCounts": dict(Counter(str(item["company"]) for item in audited)),
        "topologyCounts": dict(
            Counter(str((item.get("contractTopology") or {}).get("type")) for item in audited)
        ),
        "issueCounts": dict(sorted(issue_counter.items())),
        "auditDimensions": {
            "omissions": {
                code: count
                for code, count in sorted(issue_counter.items())
                if code.startswith("annuity_") or code == "contract_topology_not_materialized"
            },
            "falseResponsibilities": {
                code: issue_counter.get(code, 0)
                for code in sorted(false_responsibility_codes)
            },
            "formulasAndBranches": {
                code: issue_counter[code] for code in sorted(formula_codes)
            },
        },
        "scope": {
            "sqliteWrites": 0,
            "networkCalls": 0,
            "modelCalls": 0,
            "feishuWrites": 0,
            "publicationCalls": 0,
            "sourceBytesRead": False,
            "sourceTextRead": True,
            "officialEvidenceMode": "source-url-bound official terms plus same-digest approved artifact excerpts",
        },
    }
    forward_test = {
        "schemaVersion": 1,
        "generatedAt": now,
        "scriptVersion": SCRIPT_VERSION,
        "manifestFile": "manifest.json",
        "auditFile": "audit.json",
        "handoffFile": "handoff.json",
        "products": audited,
    }
    handoff = {
        "schemaVersion": 1,
        "generatedAt": now,
        "scriptVersion": SCRIPT_VERSION,
        "status": "review",
        "policy": "gaps_only_no_parser_or_sqlite_changes",
        "products": [
            {
                "company": item["company"],
                "productName": item["productName"],
                "sourceDigest": item["sourceDigest"],
                "sourceUrl": item["sourceUrl"],
                "issueCount": item["issueCount"],
                "issueCodes": sorted(
                    {
                        str(issue["code"])
                        for issue in item.get("issues") or []
                        if isinstance(issue, dict) and issue.get("code")
                    }
                ),
                "issues": item["issues"],
            }
            for item in audited
            if item["issueCount"] > 0
        ],
    }

    write_json(output_dir / "manifest.json", manifest)
    write_json(output_dir / "audit.json", audit)
    write_json(output_dir / "forward-test.json", forward_test)
    write_json(output_dir / "handoff.json", handoff)
    print(
        json.dumps(
            {
                "ok": True,
                "candidateCount": len(candidates),
                "selectedCount": len(audited),
                "outputDir": str(output_dir),
                "files": [
                    "manifest.json",
                    "audit.json",
                    "forward-test.json",
                    "handoff.json",
                ],
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
