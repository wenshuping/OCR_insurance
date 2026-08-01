#!/usr/bin/env python3
"""Run a bounded, exact-digest endowment forward test against SQLite read-only."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
DEATH_TITLE_RE = re.compile(r"身故|死亡|全残|身体全残")
MATURITY_TITLE_RE = re.compile(r"满期|期满")
MATURITY_TRIGGER_RE = re.compile(r"生存至|仍生存|保险期间届满|合同期满|满期日")
RECURRING_RE = re.compile(r"每年|每月|每个保单周年日|逐年|年金")
COMPARISON_RE = re.compile(r"较大者|较小者|最大值|最小值|\bmax\s*\(|\bmin\s*\(", re.I)
BRANCH_SIGNAL_RE = re.compile(
    r"未满\s*\d+\s*周岁|已满\s*\d+\s*周岁|年满\s*\d+\s*周岁|"
    r"交费期未满|交费期已满|缴费期未满|缴费期已满|保单年度"
)
ACCIDENT_RE = re.compile(r"意外")
ADDITIVE_RE = re.compile(r"额外|另行|除上述给付外|同时再按|在基础上")
REPLACEMENT_RE = re.compile(r"不再给付|仅给付|二者择一|不重复给付")
PREMIUM_RE = re.compile(r"实际交纳的保险费|已交保险费|已缴保险费|保险费")
CASH_VALUE_RE = re.compile(r"现金价值")
INSURED_AMOUNT_RE = re.compile(r"基本保险金额|基本保额|保险金额")
ACCOUNT_PRODUCT_RE = re.compile(r"万能型|投资连结型")

SEMANTIC_FIELDS = (
    "formulaText",
    "normalizedFormula",
    "requiredInputs",
    "branches",
    "operands",
)


def load_json(raw: str) -> dict[str, Any]:
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError("payload_must_be_object")
    return value


def write_json(path: Path, value: Any) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def canonical_digest(value: Any) -> str:
    encoded = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def responsibility_text(responsibility: dict[str, Any]) -> str:
    return " ".join(
        str(responsibility.get(key) or "")
        for key in (
            "liability",
            "triggerCondition",
            "insurerObligation",
            "sourceExcerpt",
        )
    )


def artifact_roles(
    artifact: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    responsibilities = [
        item
        for item in artifact.get("responsibilities") or []
        if isinstance(item, dict)
    ]
    death = [
        item
        for item in responsibilities
        if DEATH_TITLE_RE.search(str(item.get("liability") or ""))
    ]
    maturity = [
        item
        for item in responsibilities
        if MATURITY_TITLE_RE.search(str(item.get("liability") or ""))
        and MATURITY_TRIGGER_RE.search(responsibility_text(item))
    ]
    periodic = [
        item
        for item in responsibilities
        if item not in maturity
        and (
            "年金" in str(item.get("liability") or "")
            or (
                "生存保险金" in str(item.get("liability") or "")
                and RECURRING_RE.search(responsibility_text(item))
            )
        )
    ]
    return death, maturity, periodic


def semantic_view(indicator: dict[str, Any]) -> dict[str, Any]:
    return {key: indicator.get(key) for key in SEMANTIC_FIELDS}


def official_source_matches(
    connection: sqlite3.Connection,
    product_name: str,
    source_url: str,
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    rows = connection.execute(
        """
        SELECT id, company, product_name, url, payload
        FROM knowledge_records
        WHERE product_name = ? AND url = ?
        """,
        (product_name, source_url),
    )
    for record_id, company, stored_product_name, url, raw in rows:
        try:
            payload = load_json(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        if payload.get("official") not in (True, 1):
            continue
        matches.append(
            {
                "knowledgeRecordId": record_id,
                "company": company,
                "productName": stored_product_name,
                "url": url,
                "officialDomain": payload.get("officialDomain"),
                "qualityStatus": payload.get("qualityStatus"),
            }
        )
    return matches


def projection_payloads(
    connection: sqlite3.Connection,
    table: str,
    company: str,
    product_name: str,
    source_digest: str,
) -> list[dict[str, Any]]:
    payloads: list[dict[str, Any]] = []
    rows = connection.execute(
        f"SELECT payload FROM {table} WHERE company = ? AND product_name = ?",
        (company, product_name),
    )
    for (raw,) in rows:
        try:
            payload = load_json(raw)
        except (json.JSONDecodeError, ValueError):
            continue
        payload_digest = payload.get("sourceDigest") or payload.get(
            "responsibilitySourceDigest"
        )
        if payload_digest == source_digest:
            payloads.append(payload)
    return payloads


def projection_gate(
    artifact: dict[str, Any],
    cards: list[dict[str, Any]],
    indicators: list[dict[str, Any]],
) -> tuple[bool, list[str]]:
    issues: list[str] = []
    responsibilities = [
        item
        for item in artifact.get("responsibilities") or []
        if isinstance(item, dict)
    ]
    for responsibility in responsibilities:
        responsibility_id = responsibility.get("responsibilityId")
        liability = responsibility.get("liability")
        matched_cards = [
            card
            for card in cards
            if card.get("responsibilityId") == responsibility_id
            and card.get("title") == liability
        ]
        if len(matched_cards) != 1:
            issues.append(f"card_exact_match:{responsibility_id}:{len(matched_cards)}")
            continue
        card = matched_cards[0]
        for artifact_indicator in responsibility.get("indicators") or []:
            if not isinstance(artifact_indicator, dict):
                issues.append(f"artifact_indicator_shape:{responsibility_id}")
                continue
            indicator_name = artifact_indicator.get("indicatorName")
            matched_indicators = [
                indicator
                for indicator in indicators
                if indicator.get("responsibilityId") == responsibility_id
                and indicator.get("indicatorName") == indicator_name
            ]
            if len(matched_indicators) != 1:
                issues.append(
                    f"indicator_exact_match:{responsibility_id}:{indicator_name}:"
                    f"{len(matched_indicators)}"
                )
            elif semantic_view(artifact_indicator) != semantic_view(
                matched_indicators[0]
            ):
                issues.append(
                    f"indicator_semantic_mismatch:{responsibility_id}:{indicator_name}"
                )
            nested = [
                indicator
                for indicator in card.get("indicators") or []
                if isinstance(indicator, dict)
                and indicator.get("indicatorName") == indicator_name
            ]
            if len(nested) != 1:
                issues.append(
                    f"nested_indicator_exact_match:{responsibility_id}:"
                    f"{indicator_name}:{len(nested)}"
                )
            elif semantic_view(artifact_indicator) != semantic_view(nested[0]):
                issues.append(
                    f"nested_indicator_semantic_mismatch:{responsibility_id}:"
                    f"{indicator_name}"
                )
    return not issues, issues


def structure_flags(artifact: dict[str, Any]) -> list[str]:
    product_name = str(artifact.get("productName") or "")
    responsibilities = [
        item
        for item in artifact.get("responsibilities") or []
        if isinstance(item, dict)
    ]
    all_text = json.dumps(artifact, ensure_ascii=False)
    flags: set[str] = set()
    product_functions = [
        item
        for item in artifact.get("productFunctions") or []
        if isinstance(item, dict)
    ]
    participating = "分红型" in product_name or any(
        item.get("functionKind") == "participating_dividend"
        for item in product_functions
    )
    flags.add("participating" if participating else "ordinary")
    if ACCOUNT_PRODUCT_RE.search(product_name):
        flags.add("account_or_investment_linked")
    if PREMIUM_RE.search(all_text):
        flags.add("premium_basis")
    if CASH_VALUE_RE.search(all_text):
        flags.add("cash_value_basis")
    if INSURED_AMOUNT_RE.search(all_text):
        flags.add("insured_amount_basis")
    if any(
        indicator.get("operands")
        for responsibility in responsibilities
        for indicator in responsibility.get("indicators") or []
        if isinstance(indicator, dict)
    ):
        flags.add("comparison_operands")
    if any(
        indicator.get("branches")
        for responsibility in responsibilities
        for indicator in responsibility.get("indicators") or []
        if isinstance(indicator, dict)
    ):
        flags.add("conditional_branches")
    if BRANCH_SIGNAL_RE.search(all_text):
        flags.add("age_payment_or_policy_year_condition")
    death, _, _ = artifact_roles(artifact)
    if len(death) > 1 and any(
        ACCIDENT_RE.search(responsibility_text(item)) for item in death
    ):
        flags.add("accident_additional_or_alternative")
    return sorted(flags)


def formula_and_boundary_checks(
    artifact: dict[str, Any],
    death: list[dict[str, Any]],
    maturity: list[dict[str, Any]],
    periodic: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    checks: list[dict[str, Any]] = []
    handoff: list[dict[str, Any]] = []

    death_ids = {item.get("responsibilityId") for item in death}
    maturity_ids = {item.get("responsibilityId") for item in maturity}
    checks.append(
        {
            "gate": "death_maturity_dual_branch",
            "passed": bool(death_ids and maturity_ids and death_ids.isdisjoint(maturity_ids)),
            "deathResponsibilityIds": sorted(value for value in death_ids if value),
            "maturityResponsibilityIds": sorted(value for value in maturity_ids if value),
        }
    )

    maturity_annuity_issues: list[str] = []
    for item in maturity:
        text = responsibility_text(item)
        if RECURRING_RE.search(text):
            maturity_annuity_issues.append(str(item.get("responsibilityId")))
    checks.append(
        {
            "gate": "maturity_is_one_time_not_annuity",
            "passed": not maturity_annuity_issues,
            "periodicResponsibilityIds": [
                item.get("responsibilityId") for item in periodic
            ],
            "maturityWithRecurringSignals": maturity_annuity_issues,
        }
    )
    if maturity_annuity_issues:
        handoff.append(
            {
                "code": "maturity_annuity_boundary_review",
                "responsibilityIds": maturity_annuity_issues,
            }
        )

    comparison_issues: list[str] = []
    branch_issues: list[str] = []
    for responsibility in artifact.get("responsibilities") or []:
        if not isinstance(responsibility, dict):
            continue
        responsibility_id = str(responsibility.get("responsibilityId") or "")
        responsibility_has_branches = False
        for indicator in responsibility.get("indicators") or []:
            if not isinstance(indicator, dict):
                continue
            responsibility_has_branches |= bool(indicator.get("branches"))
            formula = str(indicator.get("formulaText") or "")
            if COMPARISON_RE.search(formula) and not indicator.get("operands"):
                if not any(
                    isinstance(branch, dict)
                    and COMPARISON_RE.search(str(branch.get("formulaText") or ""))
                    and branch.get("operands")
                    for branch in indicator.get("branches") or []
                ):
                    comparison_issues.append(
                        f"{responsibility_id}:{indicator.get('indicatorName')}"
                    )
            for branch in indicator.get("branches") or []:
                if not isinstance(branch, dict):
                    continue
                if COMPARISON_RE.search(str(branch.get("formulaText") or "")) and not branch.get(
                    "operands"
                ):
                    comparison_issues.append(
                        f"{responsibility_id}:{branch.get('branchId')}"
                    )
        if BRANCH_SIGNAL_RE.search(responsibility_text(responsibility)) and not (
            responsibility_has_branches
        ):
            branch_issues.append(responsibility_id)
    checks.append(
        {
            "gate": "comparison_operands_preserved",
            "passed": not comparison_issues,
            "issues": comparison_issues,
        }
    )
    checks.append(
        {
            "gate": "age_payment_policy_year_branches_preserved",
            "passed": not branch_issues,
            "issues": branch_issues,
        }
    )
    if comparison_issues:
        handoff.append(
            {
                "code": "comparison_operands_gap",
                "locations": comparison_issues,
            }
        )
    if branch_issues:
        handoff.append(
            {
                "code": "condition_branch_gap",
                "responsibilityIds": branch_issues,
            }
        )

    all_responsibilities = [
        item
        for item in artifact.get("responsibilities") or []
        if isinstance(item, dict)
    ]
    accident_items = [
        item
        for item in death
        if ACCIDENT_RE.search(responsibility_text(item))
    ]
    relationship_entries = [
        item
        for item in artifact.get("benefitRelationships") or []
        if isinstance(item, dict)
    ]
    relationship_issues: list[str] = []
    if len(death) > 1 and accident_items:
        for item in accident_items:
            text = responsibility_text(item)
            has_source_semantics = ADDITIVE_RE.search(text) or REPLACEMENT_RE.search(text)
            has_structured_relationship = bool(
                item.get("parentResponsibilityId")
                or any(
                    entry.get("additionalResponsibilityId")
                    == item.get("responsibilityId")
                    for entry in relationship_entries
                )
            )
            if not (has_source_semantics and has_structured_relationship):
                relationship_issues.append(str(item.get("responsibilityId")))
    checks.append(
        {
            "gate": "accident_extra_base_relationship",
            "passed": not relationship_issues,
            "accidentResponsibilityIds": [
                item.get("responsibilityId") for item in accident_items
            ],
            "issues": relationship_issues,
        }
    )
    if relationship_issues:
        handoff.append(
            {
                "code": "accident_relationship_gap",
                "responsibilityIds": relationship_issues,
            }
        )

    participating = "分红型" in str(artifact.get("productName") or "") or any(
        isinstance(item, dict)
        and item.get("functionKind") == "participating_dividend"
        for item in artifact.get("productFunctions") or []
    )
    dividend_responsibilities = [
        str(item.get("responsibilityId"))
        for item in all_responsibilities
        if re.search(r"红利|分红", str(item.get("liability") or ""))
    ]
    checks.append(
        {
            "gate": "dividend_not_guaranteed_responsibility",
            "passed": not dividend_responsibilities,
            "participatingSignal": participating,
            "dividendResponsibilityIds": dividend_responsibilities,
        }
    )
    if dividend_responsibilities:
        handoff.append(
            {
                "code": "dividend_responsibility_leak",
                "responsibilityIds": dividend_responsibilities,
            }
        )
    return checks, handoff


def select_stratified(
    candidates: list[dict[str, Any]], sample_size: int
) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    remaining = list(candidates)
    covered_flags: set[str] = set()
    company_counts: Counter[str] = Counter()
    while remaining and len(selected) < sample_size:
        def score(candidate: dict[str, Any]) -> tuple[int, int, int, str]:
            flags = set(candidate["structureFlags"])
            new_flags = len(flags - covered_flags)
            new_company = 1 if company_counts[candidate["company"]] == 0 else 0
            balance = -company_counts[candidate["company"]]
            identity = "|".join(
                (
                    candidate["company"],
                    candidate["productName"],
                    candidate["sourceDigest"],
                )
            )
            return new_flags, new_company, balance, identity

        chosen = max(remaining, key=score)
        remaining.remove(chosen)
        selected.append(chosen)
        covered_flags.update(chosen["structureFlags"])
        company_counts[chosen["company"]] += 1
    return selected


def count_boundary_discovery(
    artifacts: Iterable[dict[str, Any]],
) -> dict[str, int]:
    counts = Counter()
    for artifact in artifacts:
        product_name = str(artifact.get("productName") or "")
        death, maturity, periodic = artifact_roles(artifact)
        if periodic:
            counts["periodic_annuity_structure"] += 1
        if death and not maturity and "定期寿险" in product_name:
            counts["term_life_name_discovery_only"] += 1
        if death and not maturity and "终身寿险" in product_name:
            counts["whole_life_name_discovery_only"] += 1
        all_text = json.dumps(artifact, ensure_ascii=False)
        if (
            death
            and not maturity
            and "终身寿险" in product_name
            and re.search(r"有效保险金额|逐年增长|复利", all_text)
        ):
            counts["incremental_whole_life_structure_signal"] += 1
    return dict(sorted(counts.items()))


def build_candidate(
    connection: sqlite3.Connection,
    row: tuple[str, str, str, str, str, str],
) -> tuple[dict[str, Any] | None, str]:
    artifact_id, company, product_name, source_digest, source_url, raw = row
    try:
        artifact = load_json(raw)
    except (json.JSONDecodeError, ValueError):
        return None, "artifact_json_invalid"
    death, maturity, periodic = artifact_roles(artifact)
    death_ids = {item.get("responsibilityId") for item in death}
    maturity_ids = {item.get("responsibilityId") for item in maturity}
    if not death_ids or not maturity_ids or not death_ids.isdisjoint(maturity_ids):
        return None, "endowment_dual_role_not_proven"
    if "两全" not in product_name:
        return None, "filed_endowment_name_support_absent_after_structural_gate"
    if not DIGEST_RE.fullmatch(source_digest):
        return None, "source_digest_invalid"
    parsed_url = urlparse(source_url or "")
    if parsed_url.scheme not in {"http", "https"} or not parsed_url.netloc:
        return None, "official_source_url_invalid"
    source_matches = official_source_matches(connection, product_name, source_url)
    if not source_matches:
        return None, "official_source_record_not_matched"
    if any(not str(item.get("sourceExcerpt") or "").strip() for item in death + maturity):
        return None, "dual_role_source_excerpt_missing"

    cards = projection_payloads(
        connection,
        "product_responsibility_cards",
        company,
        product_name,
        source_digest,
    )
    indicators = projection_payloads(
        connection,
        "insurance_indicator_records",
        company,
        product_name,
        source_digest,
    )
    projection_passed, projection_issues = projection_gate(
        artifact,
        cards,
        indicators,
    )
    if not projection_passed:
        return None, "projection_not_semantically_exact:" + ",".join(
            projection_issues[:3]
        )
    candidate = {
        "artifactId": artifact_id,
        "company": company,
        "productName": product_name,
        "sourceDigest": source_digest,
        "sourceUrl": source_url,
        "officialSourceRecords": source_matches,
        "artifact": artifact,
        "deathResponsibilityCount": len(death),
        "maturityResponsibilityCount": len(maturity),
        "periodicResponsibilityCount": len(periodic),
        "responsibilityCount": len(artifact.get("responsibilities") or []),
        "cardCountOnDigest": len(cards),
        "indicatorCountOnDigest": len(indicators),
        "structureFlags": structure_flags(artifact),
    }
    return candidate, "qualified"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--sample-size", type=int, default=20)
    args = parser.parse_args()

    if args.sample_size < 20:
        parser.error("--sample-size must be at least 20")
    database_path = args.db.resolve()
    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    connection = sqlite3.connect(
        f"file:{database_path}?mode=ro",
        uri=True,
    )
    connection.execute("PRAGMA query_only=ON")
    query_only = connection.execute("PRAGMA query_only").fetchone()[0]
    if query_only != 1:
        raise RuntimeError("query_only_not_enabled")

    run_at = datetime.now(timezone.utc).isoformat()
    artifact_rows = connection.execute(
        """
        SELECT id, company, product_name, source_digest, source_url, payload
        FROM product_responsibility_artifacts
        WHERE json_extract(payload, '$.audit.status') = 'approved'
        ORDER BY company, product_name, source_digest
        """
    ).fetchall()
    approved_artifacts = [load_json(row[5]) for row in artifact_rows]
    exclusion_reasons: Counter[str] = Counter()
    candidates: list[dict[str, Any]] = []
    product_versions: Counter[tuple[str, str]] = Counter()
    provisional: list[dict[str, Any]] = []
    for row in artifact_rows:
        candidate, reason = build_candidate(connection, row)
        if candidate is None:
            exclusion_reasons[reason.split(":", 1)[0]] += 1
            continue
        provisional.append(candidate)
        product_versions[(candidate["company"], candidate["productName"])] += 1
    for candidate in provisional:
        product_key = (candidate["company"], candidate["productName"])
        if product_versions[product_key] != 1:
            exclusion_reasons["multiple_qualified_digests_same_product"] += 1
            continue
        candidates.append(candidate)

    selected = select_stratified(candidates, args.sample_size)
    if len(selected) < args.sample_size:
        raise RuntimeError(
            f"insufficient_qualified_products:{len(selected)}<{args.sample_size}"
        )

    forward_products: list[dict[str, Any]] = []
    total_handoff = 0
    for candidate in selected:
        artifact = candidate.pop("artifact")
        death, maturity, periodic = artifact_roles(artifact)
        checks, handoff = formula_and_boundary_checks(
            artifact,
            death,
            maturity,
            periodic,
        )
        total_handoff += len(handoff)
        forward_products.append(
            {
                **candidate,
                "identity": {
                    "company": candidate["company"],
                    "productName": candidate["productName"],
                    "sourceDigest": candidate["sourceDigest"],
                },
                "coreLayerGates": {
                    "officialSourceMatchedByExactProductAndUrl": True,
                    "approvedArtifact": True,
                    "cardProjectionSameDigestAndSemanticExact": True,
                    "indicatorProjectionSameDigestAndSemanticExact": True,
                    "nameUsedOnlyAfterStructuralDualRoleGate": True,
                },
                "checks": checks,
                "status": (
                    "pass"
                    if all(check["passed"] for check in checks)
                    else "handoff_required"
                ),
                "handoff": handoff,
            }
        )

    identities = [
        {
            "company": item["company"],
            "productName": item["productName"],
            "sourceDigest": item["sourceDigest"],
            "artifactId": item["artifactId"],
        }
        for item in forward_products
    ]
    identity_set_size = len(
        {
            (item["company"], item["productName"], item["sourceDigest"])
            for item in identities
        }
    )
    company_counts = Counter(item["company"] for item in forward_products)
    flag_counts = Counter(
        flag for item in forward_products for flag in item["structureFlags"]
    )
    status_counts = Counter(item["status"] for item in forward_products)
    database_stat = database_path.stat()
    wal_path = Path(str(database_path) + "-wal")
    manifest = {
        "schemaVersion": "endowment-forward-test-manifest-v1",
        "runAtUtc": run_at,
        "mode": "read_only",
        "database": {
            "path": str(database_path),
            "sizeBytes": database_stat.st_size,
            "mtimeNs": database_stat.st_mtime_ns,
            "walSizeBytes": wal_path.stat().st_size if wal_path.exists() else 0,
            "queryOnly": bool(query_only),
            "journalMode": connection.execute("PRAGMA journal_mode").fetchone()[0],
            "schemaVersion": connection.execute("PRAGMA schema_version").fetchone()[0],
            "dataVersion": connection.execute("PRAGMA data_version").fetchone()[0],
        },
        "selectionContract": {
            "approvedArtifactRequired": True,
            "structuralDualRoleRequiredBeforeNameSupport": True,
            "officialSourceExactProductAndUrlRequired": True,
            "sameDigestCardAndIndicatorSemanticEqualityRequired": True,
            "multipleQualifiedDigestsPerCompanyProductRejected": True,
            "accountOrInvestmentLinkedKeptAsSeparateStructureStratum": True,
            "sampleSize": args.sample_size,
        },
        "identitySetDigest": canonical_digest(identities),
        "identityCount": len(identities),
        "uniqueIdentityCount": identity_set_size,
        "products": identities,
    }
    forward_test = {
        "schemaVersion": "endowment-forward-test-v1",
        "runAtUtc": run_at,
        "databasePath": str(database_path),
        "sampleSize": len(forward_products),
        "mutuallyExclusiveExactIdentity": identity_set_size == len(forward_products),
        "companyCounts": dict(sorted(company_counts.items())),
        "structureCounts": dict(sorted(flag_counts.items())),
        "statusCounts": dict(sorted(status_counts.items())),
        "handoffCount": total_handoff,
        "products": forward_products,
    }
    audit = {
        "schemaVersion": "endowment-skill-distillation-audit-v1",
        "runAtUtc": run_at,
        "scope": {
            "sqliteWrite": False,
            "network": False,
            "model": False,
            "feishu": False,
            "publication": False,
            "productionParserChange": False,
        },
        "approvedArtifactCountScanned": len(artifact_rows),
        "qualifiedBeforeSampling": len(candidates),
        "selectedCount": len(selected),
        "minimumRequired": args.sample_size,
        "uniqueSelectedIdentityCount": identity_set_size,
        "selectionExclusionCounts": dict(sorted(exclusion_reasons.items())),
        "boundaryDiscoveryCounts": count_boundary_discovery(approved_artifacts),
        "boundaryNote": (
            "Product-name boundary counts are discovery-only. Responsibility "
            "classification is based on distinct official death/total-disability "
            "and maturity-survival obligations."
        ),
        "forwardTestStatusCounts": dict(sorted(status_counts.items())),
        "handoffCount": total_handoff,
        "handoffOnly": [
            {
                "company": item["company"],
                "productName": item["productName"],
                "sourceDigest": item["sourceDigest"],
                "handoff": item["handoff"],
            }
            for item in forward_products
            if item["handoff"]
        ],
    }
    connection.close()

    manifest_path = output_dir / "manifest.json"
    audit_path = output_dir / "audit.json"
    forward_path = output_dir / "forward-test.json"
    write_json(manifest_path, manifest)
    write_json(audit_path, audit)
    write_json(forward_path, forward_test)
    checksum_path = output_dir / "SHA256SUMS"
    checksum_lines = [
        f"{file_digest(path)}  {path.name}"
        for path in (manifest_path, audit_path, forward_path)
    ]
    checksum_path.write_text("\n".join(checksum_lines) + "\n", encoding="utf-8")

    result = {
        "ok": True,
        "queryOnly": bool(query_only),
        "approvedArtifactsScanned": len(artifact_rows),
        "qualifiedBeforeSampling": len(candidates),
        "sampleSize": len(selected),
        "uniqueIdentityCount": identity_set_size,
        "statusCounts": dict(sorted(status_counts.items())),
        "handoffCount": total_handoff,
        "outputDir": str(output_dir),
        "manifestPath": str(manifest_path),
        "auditPath": str(audit_path),
        "forwardTestPath": str(forward_path),
        "shaPath": str(checksum_path),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
