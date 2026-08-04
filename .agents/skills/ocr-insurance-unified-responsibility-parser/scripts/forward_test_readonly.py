#!/usr/bin/env python3
"""Read-only forward test for the unified responsibility orchestration contract."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import unquote, urlsplit, urlunsplit


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
OWNER_DOMAINS = (
    "medical_health",
    "critical_illness",
    "accident",
    "term_life",
    "annuity",
    "long_term_care",
    "endowment",
    "whole_life",
    "incremental_whole_life",
    "universal_account",
)
TOPOLOGIES = ("standalone", "rider", "group", "bundle_component")
PAYMENT_TARGETS = (
    "lump_sum",
    "medical_reimbursement",
    "daily_allowance",
    "annuity",
    "waiver",
    "account",
    "max_min_comparison",
)
COMPLEX_OWNERS = {
    "medical_health",
    "critical_illness",
    "accident",
    "long_term_care",
}
ALIGNMENT_FIELDS = (
    "formulaText",
    "normalizedFormula",
    "requiredInputs",
    "operands",
    "branches",
)
OUTPUT_FILES = (
    "immutable-manifest.json",
    "forward-test.json",
    "routing-audit.json",
    "handoff.json",
)


class ForwardTestError(Exception):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def normalize_identity_text(value: Any) -> str:
    return re.sub(r"[\s\u3000]+", "", text(value)).casefold()


def normalize_url(value: Any) -> str:
    raw = unquote(text(value))
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
    except ValueError:
        return raw.casefold()
    return urlunsplit(
        (
            parts.scheme.casefold(),
            parts.netloc.casefold(),
            re.sub(r"/+", "/", parts.path).rstrip("/"),
            parts.query,
            "",
        )
    )


def parse_json(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not isinstance(raw, str):
        return {}
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def rows(value: Any) -> list[dict[str, Any]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def artifact_responsibilities(payload: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("responsibilities", "acceptedResponsibilities"):
        value = rows(payload.get(key))
        if value:
            return value
    return []


def official_inventory(payload: dict[str, Any]) -> list[dict[str, Any]]:
    for key in ("responsibilityInventory", "officialChecklist"):
        value = payload.get(key)
        if isinstance(value, dict):
            value = value.get("responsibilities")
        result = rows(value)
        if result:
            return result
    return []


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_hash(value: Any) -> str:
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


def responsibility_text(responsibility: dict[str, Any]) -> str:
    indicator_text = " ".join(
        " ".join(
            [
                text(indicator.get("indicatorName")),
                text(indicator.get("formulaText")),
                text(indicator.get("normalizedFormula")),
                text(indicator.get("sourceExcerpt")),
            ]
        )
        for indicator in rows(responsibility.get("indicators"))
    )
    return " ".join(
        [
            text(responsibility.get("liability") or responsibility.get("officialTitle")),
            text(responsibility.get("triggerCondition")),
            text(responsibility.get("insurerObligation")),
            text(responsibility.get("sourceExcerpt")),
            indicator_text,
        ]
    )


def product_labels(product_name: str, responsibilities: list[dict[str, Any]]) -> list[str]:
    combined = product_name + " " + " ".join(responsibility_text(row) for row in responsibilities)
    labels: set[str] = set()
    if re.search(r"护理|长期照护|失能收入|失能保险金|ADL", combined, re.I):
        labels.add("long_term_care")
    if re.search(r"重大疾病|轻症|中症|疾病保险金|特定疾病", combined):
        labels.add("critical_illness")
    if re.search(r"意外伤害|意外身故|意外伤残|意外医疗|交通工具", combined):
        labels.add("accident")
    if re.search(r"医疗|住院|门诊|药品费用|医疗费用|津贴", combined):
        labels.add("medical_health")
    if re.search(r"定期寿险|定期身故", product_name):
        labels.add("term_life")
    if re.search(r"年金|养老金|生存金|教育金", combined):
        labels.add("annuity")
    if "两全" in product_name or re.search(r"满期保险金|满期生存", combined):
        labels.add("endowment")
    if re.search(r"增额.*终身寿|有效保险金额.*(?:递增|增长|\^)", combined):
        labels.update({"whole_life", "incremental_whole_life"})
    elif "终身寿" in product_name:
        labels.add("whole_life")
    if re.search(r"万能|个人账户|保单账户|账户价值|结算利率", combined):
        labels.add("universal_account")
    if not labels:
        labels.add("term_life")
    return sorted(labels)


def topology_candidate(product_name: str) -> dict[str, str]:
    if "团体" in product_name:
        topology = "group"
        signal = "product-name contains 团体"
    elif "附加" in product_name:
        topology = "rider"
        signal = "product-name contains 附加"
    elif re.search(r"学平|学生平安|学生儿童|学生幼儿", product_name):
        topology = "bundle_component"
        signal = "student-plan name signal"
    else:
        topology = "standalone"
        signal = "absence of rider/group/bundle name signal"
    return {
        "type": topology,
        "signal": signal,
        "evidenceStatus": "unverified_name_signal",
    }


def payment_profiles(responsibility: dict[str, Any]) -> list[str]:
    combined = responsibility_text(responsibility)
    profiles: set[str] = set()
    if "豁免" in combined:
        profiles.add("waiver")
    if re.search(r"医疗费用|药品费用|实际.*费用|补偿|报销", combined):
        profiles.add("medical_reimbursement")
    if re.search(r"津贴|日额|每日|住院日数|住院天数", combined):
        profiles.add("daily_allowance")
    if re.search(r"年金|养老金|生存金|教育金", combined):
        profiles.add("annuity")
    if re.search(r"账户价值|个人账户|保单账户", combined):
        profiles.add("account")
    if re.search(r"较大者|较小者|max\s*\(|min\s*\(", combined, re.I):
        profiles.add("max_min_comparison")
    if re.search(r"满期", combined):
        profiles.add("scheduled_maturity")
    if re.search(r"护理", combined) and re.search(r"每月|每年|定期", combined):
        profiles.add("periodic_care")
    if re.search(r"伤残等级|伤残评定|给付比例表", combined):
        profiles.add("disability_table")
    if not profiles:
        profiles.add("lump_sum")
    return sorted(profiles)


def owner_assignment(
    responsibility: dict[str, Any], labels: Iterable[str]
) -> dict[str, Any]:
    combined = responsibility_text(responsibility)
    label_set = set(labels)
    candidates: set[str] = set()

    accident = bool(re.search(r"意外伤害|意外身故|意外伤残|意外医疗|交通工具", combined))
    medical = bool(re.search(r"医疗|住院|门诊|药品费用|医疗费用|津贴", combined))
    if accident:
        candidates.add("accident")
    if medical:
        candidates.add("medical_health")
    if re.search(r"重大疾病保险金|轻症疾病保险金|中症疾病保险金|疾病豁免", combined):
        candidates.add("critical_illness")
    if re.search(r"护理保险金|长期护理|失能收入|ADL", combined, re.I):
        candidates.add("long_term_care")
    if re.search(r"年金|养老金|生存金|教育金", combined):
        candidates.add("annuity")
    if re.search(r"满期保险金|满期生存", combined):
        candidates.add("endowment")

    if accident:
        owner = "accident"
        reason = "accident causation owns accident medical/allowance/extra benefit"
    elif "long_term_care" in candidates:
        owner = "long_term_care"
        reason = "care-state obligation"
    elif "critical_illness" in candidates and not medical:
        owner = "critical_illness"
        reason = "disease-tier or disease-waiver obligation"
    elif medical:
        owner = "medical_health"
        reason = "medical expense or fixed medical obligation"
    elif "annuity" in candidates:
        owner = "annuity"
        reason = "recurring scheduled survival obligation"
    elif "endowment" in candidates:
        owner = "endowment"
        reason = "finite maturity-survival obligation"
    elif "incremental_whole_life" in label_set:
        owner = "incremental_whole_life"
        reason = "product label candidate plus effective-amount signal"
    elif "whole_life" in label_set:
        owner = "whole_life"
        reason = "lifetime death product boundary"
    elif "endowment" in label_set:
        owner = "endowment"
        reason = "in-term endowment death obligation"
    elif "term_life" in label_set:
        owner = "term_life"
        reason = "finite-period life obligation"
    elif "critical_illness" in label_set:
        owner = "critical_illness"
        reason = "critical-illness product obligation"
    elif "annuity" in label_set:
        owner = "annuity"
        reason = "annuity product obligation"
    elif "universal_account" in label_set and re.search(r"账户.*(?:给付|支付)", combined):
        owner = "universal_account"
        reason = "separately payable account obligation"
    else:
        owner = ""
        reason = "no deterministic owner"

    unresolved = sorted(candidate for candidate in candidates if candidate != owner)
    resolved_by_precedence = accident and "medical_health" in unresolved
    conflict = bool(unresolved) and not resolved_by_precedence
    return {
        "ownerProfile": "" if conflict else owner,
        "ownerCandidates": sorted(candidates),
        "ownerConflict": conflict or not owner,
        "resolution": reason,
    }


def model_route(
    labels: Iterable[str],
    responsibilities: list[dict[str, Any]],
    owners: Iterable[str],
    historical_status: str,
) -> tuple[str, list[str]]:
    reasons: list[str] = []
    label_set = set(labels)
    owner_set = set(owners)
    if owner_set & COMPLEX_OWNERS:
        reasons.append("complex-domain-owner")
    if label_set & {"medical_health", "critical_illness", "accident", "long_term_care"}:
        reasons.append("complex-domain-product")
    if "universal_account" in label_set:
        reasons.append("universal-account-cashflow")
    if len(responsibilities) > 3:
        reasons.append("multi-responsibility")
    if any(
        rows(indicator.get("branches"))
        for responsibility in responsibilities
        for indicator in rows(responsibility.get("indicators"))
    ):
        reasons.append("multi-branch")
    if any(
        rows(indicator.get("operands"))
        for responsibility in responsibilities
        for indicator in rows(responsibility.get("indicators"))
    ):
        reasons.append("max-min-operands")
    if historical_status and historical_status != "approved":
        reasons.append("historical-validation-failure")
    return ("luna-complex", reasons) if reasons else (
        "deepseek-standard",
        ["few-responsibility-single-branch"],
    )


def dedupe_key(candidate: dict[str, Any]) -> str:
    digest = candidate["sourceDigest"]
    if DIGEST_RE.fullmatch(digest):
        return f"sourceDigest:{digest}"
    url = normalize_url(candidate["sourceUrl"])
    if url:
        return f"sourceUrl:{url}"
    return (
        "companyProduct:"
        + normalize_identity_text(candidate["company"])
        + "\x1f"
        + normalize_identity_text(candidate["productName"])
    )


def load_candidates(connection: sqlite3.Connection) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    query = """
        SELECT id, company, product_name, source_digest, source_url, published_at, payload
        FROM product_responsibility_artifacts
        ORDER BY published_at DESC, id
    """
    raw_candidates: list[dict[str, Any]] = []
    for row in connection.execute(query):
        payload = parse_json(row["payload"])
        responsibilities = artifact_responsibilities(payload)
        historical_status = text((payload.get("audit") or {}).get("status"))
        labels = product_labels(text(row["product_name"]), responsibilities)
        assignments = [owner_assignment(item, labels) for item in responsibilities]
        owners = [
            assignment["ownerProfile"]
            for assignment in assignments
            if assignment["ownerProfile"]
        ]
        payments = sorted(
            {
                profile
                for responsibility in responsibilities
                for profile in payment_profiles(responsibility)
            }
        )
        route, route_reasons = model_route(
            labels, responsibilities, owners, historical_status
        )
        candidate = {
            "artifactId": text(row["id"]),
            "company": text(row["company"]),
            "productName": text(row["product_name"]),
            "sourceDigest": text(row["source_digest"]),
            "sourceUrl": text(row["source_url"]),
            "publishedAt": text(row["published_at"]),
            "payload": payload,
            "responsibilities": responsibilities,
            "historicalArtifactStatus": historical_status or "unknown",
            "productLabels": labels,
            "topology": topology_candidate(text(row["product_name"])),
            "ownerAssignments": assignments,
            "ownerProfiles": sorted(set(owners)),
            "paymentProfiles": payments or ["lump_sum"],
            "modelRoute": route,
            "modelRouteReasons": route_reasons,
        }
        candidate["dedupeKey"] = dedupe_key(candidate)
        candidate["sortKey"] = stable_hash(
            [
                candidate["dedupeKey"],
                candidate["artifactId"],
                candidate["company"],
                candidate["productName"],
            ]
        )
        raw_candidates.append(candidate)

    selected_by_key: dict[str, dict[str, Any]] = {}
    excluded: list[dict[str, Any]] = []
    for candidate in raw_candidates:
        key = candidate["dedupeKey"]
        if key not in selected_by_key:
            selected_by_key[key] = candidate
        else:
            excluded.append(
                {
                    "artifactId": candidate["artifactId"],
                    "company": candidate["company"],
                    "productName": candidate["productName"],
                    "sourceDigest": candidate["sourceDigest"],
                    "sourceUrl": candidate["sourceUrl"],
                    "dedupeKey": key,
                    "excludedByArtifactId": selected_by_key[key]["artifactId"],
                    "reason": key.split(":", 1)[0],
                }
            )
    return list(selected_by_key.values()), excluded


def mark_version_conflicts(candidates: list[dict[str, Any]]) -> None:
    by_name: dict[str, set[str]] = defaultdict(set)
    by_url: dict[str, set[str]] = defaultdict(set)
    for candidate in candidates:
        digest = candidate["sourceDigest"]
        if not DIGEST_RE.fullmatch(digest):
            continue
        by_name[
            normalize_identity_text(candidate["company"])
            + "\x1f"
            + normalize_identity_text(candidate["productName"])
        ].add(digest)
        url = normalize_url(candidate["sourceUrl"])
        if url:
            by_url[url].add(digest)
    for candidate in candidates:
        name_key = (
            normalize_identity_text(candidate["company"])
            + "\x1f"
            + normalize_identity_text(candidate["productName"])
        )
        url_key = normalize_url(candidate["sourceUrl"])
        candidate["versionConflict"] = len(by_name[name_key]) > 1 or (
            bool(url_key) and len(by_url[url_key]) > 1
        )


def select_sample(candidates: list[dict[str, Any]], sample_size: int) -> list[dict[str, Any]]:
    if len(candidates) < sample_size:
        raise ForwardTestError(
            f"only {len(candidates)} mutually exclusive artifacts for sample size {sample_size}"
        )
    domain_counts: Counter[str] = Counter()
    topology_counts: Counter[str] = Counter()
    payment_counts: Counter[str] = Counter()
    remaining = sorted(candidates, key=lambda item: item["sortKey"])
    selected: list[dict[str, Any]] = []

    def score(candidate: dict[str, Any]) -> int:
        value = sum(
            4 for label in candidate["productLabels"] if domain_counts[label] < 3
        )
        if topology_counts[candidate["topology"]["type"]] < 3:
            value += 7
        value += sum(
            2 for profile in candidate["paymentProfiles"] if payment_counts[profile] < 2
        )
        if candidate["versionConflict"]:
            value += 1
        return value

    while len(selected) < sample_size:
        best = max(remaining, key=lambda item: (score(item), item["sortKey"]))
        remaining.remove(best)
        selected.append(best)
        domain_counts.update(best["productLabels"])
        topology_counts.update([best["topology"]["type"]])
        payment_counts.update(best["paymentProfiles"])
    return sorted(selected, key=lambda item: item["sortKey"])


def source_evidence(
    connection: sqlite3.Connection, candidate: dict[str, Any]
) -> dict[str, Any]:
    knowledge_rows = connection.execute(
        """
        SELECT id, company, product_name, url, payload
        FROM knowledge_records
        WHERE product_name = ?
        LIMIT 50
        """,
        (candidate["productName"],),
    ).fetchall()
    selected: list[dict[str, Any]] = []
    for row in knowledge_rows:
        payload = parse_json(row["payload"])
        row_url = normalize_url(row["url"] or payload.get("sourceUrl"))
        exact_url = bool(candidate["sourceUrl"]) and row_url == normalize_url(
            candidate["sourceUrl"]
        )
        exact_company = normalize_identity_text(row["company"]) == normalize_identity_text(
            candidate["company"]
        )
        if not exact_url and not exact_company:
            continue
        page_text = text(payload.get("pageText") or payload.get("originalPageText"))
        selected.append(
            {
                "id": row["id"],
                "url": text(row["url"]),
                "payload": payload,
                "pageText": page_text,
            }
        )

    readable = any(len(row["pageText"]) >= 200 for row in selected)
    local_candidates: list[Path] = []
    page_counts: list[int] = []
    for row in selected:
        payload = row["payload"]
        for field in ("pdfLocalPath", "pdfFilePath"):
            value = text(payload.get(field))
            if value:
                local_candidates.append(Path(value))
        pages = payload.get("pages")
        if isinstance(pages, int) and pages > 0:
            page_counts.append(pages)

    verified_path = ""
    bytes_verified = False
    for path in local_candidates:
        try:
            if not path.is_file():
                continue
            with path.open("rb") as handle:
                magic = handle.read(5)
            if magic != b"%PDF-":
                continue
            if "sha256:" + file_sha256(path) == candidate["sourceDigest"]:
                bytes_verified = True
                verified_path = str(path.resolve())
                break
        except OSError:
            continue

    payload = candidate["payload"]
    source_contract_path = text(payload.get("sourceContractPath"))
    source_contract_present = bool(
        source_contract_path and Path(source_contract_path).is_file()
    ) or bool(rows(payload.get("sourceRecords")))
    source_excerpt_checks: list[bool] = []
    knowledge_texts = [row["pageText"] for row in selected if row["pageText"]]
    for responsibility in candidate["responsibilities"]:
        excerpt = text(responsibility.get("sourceExcerpt"))
        source_excerpt_checks.append(
            bool(excerpt)
            and any(excerpt in knowledge_text for knowledge_text in knowledge_texts)
        )

    issues: list[str] = []
    if not DIGEST_RE.fullmatch(candidate["sourceDigest"]):
        issues.append("invalid_or_missing_source_digest")
    if not candidate["sourceUrl"].startswith(("https://", "http://")):
        issues.append("missing_official_url")
    if not readable:
        issues.append("no_scoped_readable_source_text")
    if not bytes_verified:
        issues.append("current_pdf_magic_and_sha_not_verified")
    if not page_counts:
        issues.append("current_page_count_not_verified")
    if not source_contract_present:
        issues.append("source_contract_not_present")
    if source_excerpt_checks and not all(source_excerpt_checks):
        issues.append("artifact_excerpt_not_exact_substring_of_scoped_source_text")
    issues.append("official_host_not_network_verified_offline")

    return {
        "knowledgeRecordIds": [row["id"] for row in selected],
        "readableText": readable,
        "pdfBytesAndDigestVerifiedNow": bytes_verified,
        "verifiedPdfPath": verified_path,
        "pageCountVerifiedNow": max(page_counts) if page_counts else None,
        "sourceContractPresent": source_contract_present,
        "allArtifactExcerptsExactInScopedText": bool(source_excerpt_checks)
        and all(source_excerpt_checks),
        "officialHostNetworkVerifiedNow": False,
        "pass": not issues,
        "issues": issues,
    }


def expected_indicator_rows(responsibility: dict[str, Any]) -> list[dict[str, Any]]:
    return rows(responsibility.get("indicators"))


def record_digest(payload: dict[str, Any]) -> str:
    identity = payload.get("responsibilityProductIdentity")
    identity_digest = identity.get("sourceDigest") if isinstance(identity, dict) else ""
    return text(
        payload.get("responsibilitySourceDigest")
        or payload.get("sourceDigest")
        or identity_digest
    )


def alignment_audit(
    connection: sqlite3.Connection, candidate: dict[str, Any]
) -> dict[str, Any]:
    card_rows = connection.execute(
        """
        SELECT id, title, source_url, payload
        FROM product_responsibility_cards
        WHERE company = ? AND product_name = ?
        """,
        (candidate["company"], candidate["productName"]),
    ).fetchall()
    indicator_rows = connection.execute(
        """
        SELECT id, liability, payload
        FROM insurance_indicator_records
        WHERE company = ? AND product_name = ?
        """,
        (candidate["company"], candidate["productName"]),
    ).fetchall()
    cards = [
        {
            "id": row["id"],
            "title": text(row["title"]),
            "sourceUrl": text(row["source_url"]),
            "payload": parse_json(row["payload"]),
        }
        for row in card_rows
    ]
    indicators = [
        {
            "id": row["id"],
            "liability": text(row["liability"]),
            "payload": parse_json(row["payload"]),
        }
        for row in indicator_rows
    ]
    digest = candidate["sourceDigest"]
    responsibility_results: list[dict[str, Any]] = []
    all_cards_exact = True
    all_indicators_exact = True

    for responsibility in candidate["responsibilities"]:
        responsibility_id = text(responsibility.get("responsibilityId"))
        liability = text(responsibility.get("liability"))
        matching_cards = [
            card
            for card in cards
            if text(card["payload"].get("responsibilityId")) == responsibility_id
            and record_digest(card["payload"]) == digest
        ]
        card_issues: list[str] = []
        if len(matching_cards) != 1:
            card_issues.append(f"matching_card_count:{len(matching_cards)}")
        card = matching_cards[0] if len(matching_cards) == 1 else None
        if card:
            card_title = text(card["payload"].get("title") or card["title"])
            if card_title != liability:
                card_issues.append("title_mismatch")
            card_url = text(card["payload"].get("sourceUrl") or card["sourceUrl"])
            if normalize_url(card_url) != normalize_url(candidate["sourceUrl"]):
                card_issues.append("source_url_mismatch")

        expected_indicators = expected_indicator_rows(responsibility)
        nested_issues: list[str] = []
        table_issues: list[str] = []
        nested_rows = rows(card["payload"].get("indicators")) if card else []
        for expected in expected_indicators:
            indicator_name = text(expected.get("indicatorName"))
            nested_matches = [
                row
                for row in nested_rows
                if text(row.get("indicatorName")) == indicator_name
            ]
            if len(nested_matches) != 1:
                nested_issues.append(
                    f"{indicator_name}:matching_nested_count:{len(nested_matches)}"
                )
            else:
                actual = nested_matches[0]
                for field in ALIGNMENT_FIELDS:
                    if canonical_json(actual.get(field)) != canonical_json(
                        expected.get(field)
                    ):
                        nested_issues.append(f"{indicator_name}:{field}_mismatch")

            table_matches = [
                row
                for row in indicators
                if text(row["payload"].get("responsibilityId")) == responsibility_id
                and record_digest(row["payload"]) == digest
                and text(
                    row["payload"].get("indicatorName")
                    or row["payload"].get("liability")
                    or row["liability"]
                )
                == indicator_name
            ]
            if len(table_matches) != 1:
                table_issues.append(
                    f"{indicator_name}:matching_indicator_count:{len(table_matches)}"
                )
            else:
                actual = table_matches[0]["payload"]
                if text(actual.get("liability") or table_matches[0]["liability"]) != liability:
                    table_issues.append(f"{indicator_name}:liability_mismatch")
                for field in ALIGNMENT_FIELDS:
                    if canonical_json(actual.get(field)) != canonical_json(
                        expected.get(field)
                    ):
                        table_issues.append(f"{indicator_name}:{field}_mismatch")

        card_exact = not card_issues and not nested_issues
        indicator_exact = bool(expected_indicators) and not table_issues
        all_cards_exact = all_cards_exact and card_exact
        all_indicators_exact = all_indicators_exact and indicator_exact
        responsibility_results.append(
            {
                "responsibilityId": responsibility_id,
                "officialTitle": liability,
                "cardExact": card_exact,
                "indicatorExact": indicator_exact,
                "cardIssues": card_issues,
                "nestedIndicatorIssues": nested_issues,
                "indicatorTableIssues": table_issues,
            }
        )

    return {
        "artifactResponsibilityCount": len(candidate["responsibilities"]),
        "scopedCardRowCount": len(cards),
        "scopedIndicatorRowCount": len(indicators),
        "artifactToCardExact": bool(candidate["responsibilities"]) and all_cards_exact,
        "artifactToIndicatorExact": bool(candidate["responsibilities"])
        and all_indicators_exact,
        "exactAlignment": bool(candidate["responsibilities"])
        and all_cards_exact
        and all_indicators_exact,
        "responsibilities": responsibility_results,
    }


def inventory_audit(candidate: dict[str, Any]) -> dict[str, Any]:
    responsibilities = candidate["responsibilities"]
    inventory = official_inventory(candidate["payload"])
    responsibility_ids = [text(row.get("responsibilityId")) for row in responsibilities]
    inventory_ids = [
        text(row.get("responsibilityId") or row.get("id")) for row in inventory
    ]
    duplicate_ids = sorted(
        key for key, count in Counter(responsibility_ids).items() if key and count > 1
    )
    evidence_keys = [
        (
            text(row.get("liability") or row.get("officialTitle")),
            stable_hash(
                text(row.get("sourceExcerpt"))
                or [
                    text(segment.get("sourceExcerpt"))
                    for segment in rows(row.get("evidenceSegments"))
                ]
            ),
        )
        for row in responsibilities
    ]
    duplicate_evidence = sorted(
        title for (title, _), count in Counter(evidence_keys).items() if title and count > 1
    )
    ids_match = bool(inventory_ids) and Counter(inventory_ids) == Counter(responsibility_ids)
    lock_receipt = isinstance(candidate["payload"].get("responsibilityInventory"), (list, dict))
    return {
        "officialInventoryCount": len(inventory_ids),
        "artifactResponsibilityCount": len(responsibility_ids),
        "currentRecomputedIdsMatch": ids_match,
        "inventoryLockReceiptPresent": lock_receipt,
        "currentInventoryGatePass": ids_match and lock_receipt,
        "duplicateResponsibilityIds": duplicate_ids,
        "duplicateTitleEvidencePackets": duplicate_evidence,
        "duplicateResponsibility": bool(duplicate_ids or duplicate_evidence),
    }


def formula_evidence_audit(candidate: dict[str, Any]) -> dict[str, Any]:
    responsibility_results: list[dict[str, Any]] = []
    all_evidence = True
    all_formula = True
    for responsibility in candidate["responsibilities"]:
        issues: list[str] = []
        for field in (
            "responsibilityId",
            "liability",
            "triggerCondition",
            "insurerObligation",
            "sourceExcerpt",
        ):
            if not text(responsibility.get(field)):
                issues.append(f"missing_{field}")
        indicators = expected_indicator_rows(responsibility)
        if not indicators:
            issues.append("missing_indicator_decision")
        formula_issues: list[str] = []
        for index, indicator in enumerate(indicators):
            location = text(indicator.get("indicatorName")) or f"indicator_{index}"
            if not text(indicator.get("formulaText")):
                formula_issues.append(f"{location}:missing_formulaText")
            if not text(indicator.get("normalizedFormula")):
                formula_issues.append(f"{location}:missing_normalizedFormula")
            for field in ("requiredInputs", "operands", "branches"):
                if not isinstance(indicator.get(field), list):
                    formula_issues.append(f"{location}:{field}_not_list")
            numeric_tokens = re.findall(r"\d+(?:\.\d+)?%?", text(indicator.get("formulaText")))
            evidence = text(indicator.get("sourceExcerpt"))
            missing_tokens = [token for token in numeric_tokens if token not in evidence]
            if missing_tokens:
                formula_issues.append(
                    f"{location}:numeric_tokens_missing_from_evidence:{','.join(missing_tokens)}"
                )
        evidence_pass = not issues
        formula_pass = bool(indicators) and not formula_issues
        all_evidence = all_evidence and evidence_pass
        all_formula = all_formula and formula_pass
        responsibility_results.append(
            {
                "responsibilityId": text(responsibility.get("responsibilityId")),
                "evidencePass": evidence_pass,
                "formulaPass": formula_pass,
                "evidenceIssues": issues,
                "formulaIssues": formula_issues,
            }
        )
    return {
        "evidenceGatePass": bool(candidate["responsibilities"]) and all_evidence,
        "formulaGatePass": bool(candidate["responsibilities"]) and all_formula,
        "responsibilities": responsibility_results,
    }


def terminal_status(
    candidate: dict[str, Any],
    source: dict[str, Any],
    inventory: dict[str, Any],
    formula: dict[str, Any],
    alignment: dict[str, Any],
) -> str:
    if candidate["versionConflict"]:
        return "version_conflict"
    if "no_scoped_readable_source_text" in source["issues"]:
        return "source_blocked"
    if not source["pass"]:
        return "source_pending"
    if any(item["ownerConflict"] for item in candidate["ownerAssignments"]):
        return "manual_review"
    if inventory["duplicateResponsibility"]:
        return "manual_review"
    if not inventory["currentInventoryGatePass"]:
        return "parse_pending"
    if not formula["evidenceGatePass"] or not formula["formulaGatePass"]:
        return "validation_review"
    if not alignment["exactAlignment"]:
        return "materializer_blocked"
    return "import_pending"


def audit_product(
    connection: sqlite3.Connection, candidate: dict[str, Any]
) -> dict[str, Any]:
    source = source_evidence(connection, candidate)
    inventory = inventory_audit(candidate)
    formula = formula_evidence_audit(candidate)
    alignment = alignment_audit(connection, candidate)
    status = terminal_status(candidate, source, inventory, formula, alignment)
    return {
        "artifactId": candidate["artifactId"],
        "identity": {
            "company": candidate["company"],
            "productName": candidate["productName"],
            "sourceDigest": candidate["sourceDigest"],
            "sourceUrl": candidate["sourceUrl"],
            "dedupeKey": candidate["dedupeKey"],
        },
        "historicalArtifactStatus": candidate["historicalArtifactStatus"],
        "historicalStatusAcceptedAsCurrentPass": False,
        "productLabels": candidate["productLabels"],
        "contractTopology": candidate["topology"],
        "ownerAssignments": [
            {
                "responsibilityId": text(responsibility.get("responsibilityId")),
                "officialTitle": text(responsibility.get("liability")),
                "paymentProfiles": payment_profiles(responsibility),
                **assignment,
            }
            for responsibility, assignment in zip(
                candidate["responsibilities"], candidate["ownerAssignments"]
            )
        ],
        "modelRoute": candidate["modelRoute"],
        "modelRouteReasons": candidate["modelRouteReasons"],
        "sourceGate": source,
        "inventoryCoverage": inventory,
        "formulaEvidenceGate": formula,
        "deterministicGateReceipts": {
            "canonicalizer": "not_run",
            "validator": "not_run",
            "dedicatedImporterDryRun": "not_run",
            "reason": "offline read-only forward test does not recreate approval receipts",
        },
        "cardIndicatorAlignment": alignment,
        "versionConflict": candidate["versionConflict"],
        "terminalStatus": status,
    }


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def build_reports(
    db_path: Path,
    output_dir: Path,
    sample_size: int,
    candidate_pool_count: int,
    selected_candidates: list[dict[str, Any]],
    excluded: list[dict[str, Any]],
    products: list[dict[str, Any]],
) -> None:
    generated_at = utc_now()
    selected_manifest = [
        {
            "artifactId": candidate["artifactId"],
            "company": candidate["company"],
            "productName": candidate["productName"],
            "sourceDigest": candidate["sourceDigest"],
            "sourceUrl": candidate["sourceUrl"],
            "dedupeKey": candidate["dedupeKey"],
            "historicalArtifactStatus": candidate["historicalArtifactStatus"],
            "versionConflict": candidate["versionConflict"],
        }
        for candidate in selected_candidates
    ]
    manifest = {
        "schemaVersion": "unified-responsibility-forward-test-v1",
        "generatedAt": generated_at,
        "targetPopulationContract": 30592,
        "database": {
            "path": str(db_path.resolve()),
            "bytes": db_path.stat().st_size,
            "mtimeNs": db_path.stat().st_mtime_ns,
        },
        "readOnly": {"sqliteMode": "ro", "queryOnly": True},
        "dedupeOrder": [
            "sourceDigest",
            "sourceUrl",
            "normalized company+productName",
        ],
        "candidateCountAfterDedupe": candidate_pool_count,
        "selected": selected_manifest,
        "excludedDuplicateCount": len(excluded),
        "excludedDuplicates": excluded,
        "selectedIdentitySha256": stable_hash(selected_manifest),
    }
    status_counts = Counter(product["terminalStatus"] for product in products)
    owner_conflict_products = sum(
        any(assignment["ownerConflict"] for assignment in product["ownerAssignments"])
        for product in products
    )
    materializer_failure_products = sum(
        not product["cardIndicatorAlignment"]["exactAlignment"] for product in products
    )
    forward = {
        "schemaVersion": "unified-responsibility-forward-test-v1",
        "generatedAt": generated_at,
        "execution": {
            "databaseOpen": "mode=ro",
            "queryOnly": True,
            "network": False,
            "models": False,
            "prohibitedInvocations": {
                "sqliteWrites": 0,
                "externalModels": 0,
                "network": 0,
                "feishu": 0,
                "publication": 0,
                "importer": 0,
            },
        },
        "approvalRule": "historical approved and quick_check are not current passes",
        "summary": {
            "sampleCount": len(products),
            "requestedSampleSize": sample_size,
            "sourceReadableText": sum(
                product["sourceGate"]["readableText"] for product in products
            ),
            "sourcePdfBytesAndDigestVerifiedNow": sum(
                product["sourceGate"]["pdfBytesAndDigestVerifiedNow"]
                for product in products
            ),
            "sourceGateCurrentPass": sum(
                product["sourceGate"]["pass"] for product in products
            ),
            "inventoryIdsMatched": sum(
                product["inventoryCoverage"]["currentRecomputedIdsMatch"]
                for product in products
            ),
            "inventoryLockReceipts": sum(
                product["inventoryCoverage"]["inventoryLockReceiptPresent"]
                for product in products
            ),
            "ownerConflicts": sum(
                assignment["ownerConflict"]
                for product in products
                for assignment in product["ownerAssignments"]
            ),
            "ownerConflictProducts": owner_conflict_products,
            "duplicateResponsibilityProducts": sum(
                product["inventoryCoverage"]["duplicateResponsibility"]
                for product in products
            ),
            "formulaGatePass": sum(
                product["formulaEvidenceGate"]["formulaGatePass"]
                for product in products
            ),
            "evidenceGatePass": sum(
                product["formulaEvidenceGate"]["evidenceGatePass"]
                for product in products
            ),
            "cardExact": sum(
                product["cardIndicatorAlignment"]["artifactToCardExact"]
                for product in products
            ),
            "indicatorExact": sum(
                product["cardIndicatorAlignment"]["artifactToIndicatorExact"]
                for product in products
            ),
            "exactAlignment": sum(
                product["cardIndicatorAlignment"]["exactAlignment"]
                for product in products
            ),
            "terminalStatuses": dict(sorted(status_counts.items())),
            "failureLayers": {
                "source": {
                    "sourcePending": status_counts["source_pending"],
                    "sourceBlocked": status_counts["source_blocked"],
                    "versionConflict": status_counts["version_conflict"],
                },
                "review": {
                    "ownerConflictProducts": owner_conflict_products,
                    "inventoryGateFailed": sum(
                        not product["inventoryCoverage"]["currentInventoryGatePass"]
                        for product in products
                    ),
                    "evidenceGateFailed": sum(
                        not product["formulaEvidenceGate"]["evidenceGatePass"]
                        for product in products
                    ),
                    "formulaGateFailed": sum(
                        not product["formulaEvidenceGate"]["formulaGatePass"]
                        for product in products
                    ),
                },
                "materializer": {
                    "exactAlignmentFailed": materializer_failure_products,
                },
            },
        },
        "products": products,
    }
    route_counts = Counter(product["modelRoute"] for product in products)
    owner_counts = Counter(
        assignment["ownerProfile"] or "owner_conflict"
        for product in products
        for assignment in product["ownerAssignments"]
    )
    payment_counts = Counter(
        payment
        for product in products
        for assignment in product["ownerAssignments"]
        for payment in assignment["paymentProfiles"]
    )
    topology_counts = Counter(
        product["contractTopology"]["type"] for product in products
    )
    label_counts = Counter(
        label for product in products for label in product["productLabels"]
    )
    routing = {
        "schemaVersion": "unified-responsibility-routing-audit-v1",
        "generatedAt": generated_at,
        "modelRoutes": {
            "deepseek-standard": route_counts["deepseek-standard"],
            "luna-complex": route_counts["luna-complex"],
        },
        "disabledProviders": ["gemini", "dianjin"],
        "silentFallbackAllowed": False,
        "deepSeekFailureTerminal": "model_retry:deepseek-standard",
        "ownerProfiles": dict(sorted(owner_counts.items())),
        "paymentProfiles": dict(sorted(payment_counts.items())),
        "productLabels": dict(sorted(label_counts.items())),
        "contractTopologies": dict(sorted(topology_counts.items())),
        "topologyEvidenceWarning": (
            "forward-test topology strata are name signals only; every sampled "
            "topology remains unverified until exact relationship evidence is parsed"
        ),
        "ownerConflictCount": sum(
            assignment["ownerConflict"]
            for product in products
            for assignment in product["ownerAssignments"]
        ),
        "duplicateResponsibilityProductCount": sum(
            product["inventoryCoverage"]["duplicateResponsibility"]
            for product in products
        ),
        "coverage": {
            "allRequestedOwnerDomainsPresent": all(
                label_counts[domain] > 0 for domain in OWNER_DOMAINS
            ),
            "missingOwnerDomains": [
                domain for domain in OWNER_DOMAINS if label_counts[domain] == 0
            ],
            "allTopologiesPresent": all(
                topology_counts[topology] > 0 for topology in TOPOLOGIES
            ),
            "missingTopologies": [
                topology for topology in TOPOLOGIES if topology_counts[topology] == 0
            ],
            "allMajorPaymentProfilesPresent": all(
                payment_counts[payment] > 0 for payment in PAYMENT_TARGETS
            ),
            "missingMajorPaymentProfiles": [
                payment for payment in PAYMENT_TARGETS if payment_counts[payment] == 0
            ],
        },
    }
    systemic_gaps: list[dict[str, Any]] = []

    def add_gap(code: str, count: int, detail: str) -> None:
        if count:
            systemic_gaps.append({"code": code, "productCount": count, "detail": detail})

    add_gap(
        "current_source_bytes_sha_unverified",
        sum(
            not product["sourceGate"]["pdfBytesAndDigestVerifiedNow"]
            for product in products
        ),
        "No current pass without preserved PDF magic and SHA readback.",
    )
    add_gap(
        "inventory_lock_receipt_missing",
        sum(
            not product["inventoryCoverage"]["inventoryLockReceiptPresent"]
            for product in products
        ),
        "Legacy officialChecklist is not a reusable one-per-digest inventory receipt.",
    )
    add_gap(
        "card_indicator_exact_alignment_failed",
        materializer_failure_products,
        "Artifact fields did not survive both card and indicator projections exactly.",
    )
    add_gap(
        "owner_conflict_detected",
        owner_conflict_products,
        "Legacy artifacts have no locked ownerProfile, and bounded deterministic signals remain ambiguous.",
    )
    add_gap(
        "formula_or_evidence_gate_incomplete",
        sum(
            not (
                product["formulaEvidenceGate"]["formulaGatePass"]
                and product["formulaEvidenceGate"]["evidenceGatePass"]
            )
            for product in products
        ),
        "Missing structured fields or exact evidence prevents deterministic approval.",
    )
    add_gap(
        "topology_evidence_not_currently_proven",
        len(products),
        "Sampling covered topology strata using names, but names cannot approve topology.",
    )
    add_gap(
        "current_canonicalizer_validator_importer_receipts_missing",
        len(products),
        "Read-only forward test intentionally did not recreate deterministic approval receipts.",
    )
    handoff = {
        "schemaVersion": "unified-responsibility-handoff-v1",
        "generatedAt": generated_at,
        "result": "forward_test_complete_no_publication",
        "systemicGaps": systemic_gaps,
        "terminalQueues": {
            status: [
                {
                    "artifactId": product["artifactId"],
                    **product["identity"],
                }
                for product in products
                if product["terminalStatus"] == status
            ]
            for status in sorted(status_counts)
        },
        "skippedGates": [
            {
                "gate": "official-host network verification",
                "reason": "network forbidden",
            },
            {
                "gate": "canonicalizer and validator replay",
                "reason": "historical DB artifacts were audited in place; no artifact was rewritten",
            },
            {
                "gate": "dedicated importer dry-run",
                "reason": "SSD remained mode=ro and the forward test does not open it through an importer",
            },
            {
                "gate": "publication/import",
                "reason": "SQLite writes, Feishu, and publication forbidden",
            },
        ],
        "nextActions": [
            "Acquire or verify preserved official PDF bytes and source contracts by immutable manifest.",
            "Build one locked inventory receipt per sourceDigest before domain parsing.",
            "Run the current canonicalizer, validator, and dedicated importer dry-run on newly generated artifacts.",
            "Repair materializer gaps only after artifact gates pass; verify cards and indicators exactly.",
        ],
    }

    write_json(output_dir / "immutable-manifest.json", manifest)
    write_json(output_dir / "forward-test.json", forward)
    write_json(output_dir / "routing-audit.json", routing)
    write_json(output_dir / "handoff.json", handoff)
    sha_lines = [
        f"{file_sha256(output_dir / name)}  {name}" for name in sorted(OUTPUT_FILES)
    ]
    (output_dir / "SHA256SUMS").write_text("\n".join(sha_lines) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sample-size", type=int, default=48)
    parser.add_argument("--replace-existing-output", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    db_path = args.db.resolve()
    output_dir = args.output_dir.resolve()
    if args.sample_size < 40:
        raise ForwardTestError("--sample-size must be at least 40")
    if not db_path.is_file():
        raise ForwardTestError(f"database does not exist: {db_path}")
    if output_dir.exists() and any(output_dir.iterdir()):
        existing = {path.name for path in output_dir.iterdir()}
        expected = {*OUTPUT_FILES, "SHA256SUMS"}
        if not args.replace_existing_output or not existing.issubset(expected):
            raise ForwardTestError(f"output directory is not empty: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    uri = f"{db_path.as_uri()}?mode=ro&immutable=1"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only=ON")
        query_only = connection.execute("PRAGMA query_only").fetchone()[0]
        if query_only != 1:
            raise ForwardTestError("SQLite query_only did not enable")
        candidates, excluded = load_candidates(connection)
        mark_version_conflicts(candidates)
        sample = select_sample(candidates, args.sample_size)
        products = [audit_product(connection, candidate) for candidate in sample]
    finally:
        connection.close()

    build_reports(
        db_path,
        output_dir,
        args.sample_size,
        len(candidates),
        sample,
        excluded,
        products,
    )
    result = {
        "ok": True,
        "outputDir": str(output_dir),
        "sampleCount": len(products),
        "modelRoutes": dict(Counter(product["modelRoute"] for product in products)),
        "terminalStatuses": dict(
            Counter(product["terminalStatus"] for product in products)
        ),
        "files": [str(output_dir / name) for name in (*OUTPUT_FILES, "SHA256SUMS")],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ForwardTestError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False, indent=2))
        sys.exit(1)
