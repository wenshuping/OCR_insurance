#!/usr/bin/env python3
"""Validate focused fixtures and read-only forward-test term-life SSD cohorts."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


TERM_DISCOVERY_RE = re.compile(r"定期寿险|定寿")
TERM_TYPE_RE = re.compile(r"定期寿险|定寿")
TERM_EVENT_RE = re.compile(r"身故|全残|永久完全残疾|高度残疾")
OBLIGATION_RE = re.compile(r"给付|返还")
TERM_SCOPE_RE = re.compile(r"保险期间|个人保险期间|有效期内|合同终止|责任终止")
WAITING_RE = re.compile(r"等待期|生效日.{0,30}\d+\s*日|复效日.{0,30}\d+\s*日")
DECREASING_RE = re.compile(r"递减|减额|年度有效保额|贷款余额|未偿还")
COMPARISON_RE = re.compile(r"较大者|较小者|max\s*\(|min\s*\(|maximum_of_bases|minimum_of_bases", re.I)
DISABILITY_RE = re.compile(r"全残|永久完全残疾|高度残疾")
FALSE_WHOLE_LIFE_RE = re.compile(r"增额终身寿险|终身寿险")
OTHER_FAMILY_RE = re.compile(r"年金|万能账户")
PSEUDO_TITLE_RE = re.compile(r"^(保险责任|基本责任|可选责任|定义|释义|责任免除|basic|optional)$", re.I)
CLAUSE_TITLE_RE = re.compile(r"^(在|若|如|因)")
INTERNAL_CUSTOMER_TERMS = (
    "basisKey",
    "calculationKey",
    "requiredInputs",
    "indicatorCheckStatus",
    "指标核对",
    "结构化指标",
)
TOPOLOGIES = {"standalone", "rider", "group", "bundle_component"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixtures-dir", type=Path)
    parser.add_argument("--db", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--sample-size", type=int, default=20)
    parser.add_argument("--validate-fixtures-only", action="store_true")
    return parser.parse_args()


def load_json(value: str | None, default: Any) -> Any:
    if not value:
        return default
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return default


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def exact_evidence(item: dict[str, Any]) -> str:
    pieces: list[str] = []
    excerpt = item.get("sourceExcerpt")
    if isinstance(excerpt, str):
        pieces.append(excerpt)
    for segment in item.get("evidenceSegments") or []:
        if isinstance(segment, dict) and isinstance(segment.get("sourceExcerpt"), str):
            pieces.append(segment["sourceExcerpt"])
    return "\n".join(pieces)


def validate_fixtures(fixtures_dir: Path) -> dict[str, Any]:
    paths = sorted(fixtures_dir.glob("*.json"))
    issues: list[dict[str, str]] = []
    required_shapes = Counter()
    topology_counts = Counter()

    if len(paths) < 7:
        issues.append({"fixture": "*", "issue": "fixture_count_below_7"})

    for path in paths:
        try:
            fixture = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            issues.append({"fixture": path.name, "issue": f"invalid_json:{error}"})
            continue

        source_text = fixture.get("sourceText")
        expected = fixture.get("expected") or {}
        topology = expected.get("contractTopology")
        responsibilities = expected.get("responsibilities") or []
        rejected = expected.get("rejectedFragments") or []

        if expected.get("semanticFamily") != "term_life":
            issues.append({"fixture": path.name, "issue": "semantic_family_not_term_life"})
        if topology not in TOPOLOGIES:
            issues.append({"fixture": path.name, "issue": "invalid_contract_topology"})
        else:
            topology_counts[topology] += 1
        if not isinstance(source_text, str) or not source_text.strip():
            issues.append({"fixture": path.name, "issue": "missing_source_text"})
            continue
        if not responsibilities and not rejected:
            issues.append({"fixture": path.name, "issue": "no_responsibility_or_rejection"})
        shape = expected.get("focusedShape")
        if shape:
            required_shapes[shape] += 1

        ids: list[str] = []
        for responsibility in responsibilities:
            responsibility_id = responsibility.get("responsibilityId")
            ids.append(str(responsibility_id or ""))
            excerpt = exact_evidence(responsibility)
            if not responsibility_id or not responsibility.get("liability"):
                issues.append({"fixture": path.name, "issue": "missing_responsibility_identity"})
            if excerpt and excerpt not in source_text:
                issues.append({"fixture": path.name, "issue": f"non_exact_excerpt:{responsibility_id}"})
            for branch in responsibility.get("branches") or []:
                for field in ("branchId", "conditionText", "formulaText", "basisKey", "requiredInputs"):
                    if field not in branch:
                        issues.append(
                            {"fixture": path.name, "issue": f"branch_missing_{field}:{responsibility_id}"}
                        )
                condition = branch.get("conditionText")
                if condition and condition not in source_text:
                    issues.append(
                        {"fixture": path.name, "issue": f"branch_condition_not_in_source:{responsibility_id}"}
                    )
            for operand in responsibility.get("operands") or []:
                for field in ("operandId", "formulaText", "basisKey", "requiredInputs"):
                    if field not in operand:
                        issues.append(
                            {"fixture": path.name, "issue": f"operand_missing_{field}:{responsibility_id}"}
                        )
        if len(ids) != len(set(ids)):
            issues.append({"fixture": path.name, "issue": "duplicate_responsibility_id"})
        if shape == "combined_death_total_disability_cause_branches":
            if len(responsibilities) != 1:
                issues.append(
                    {
                        "fixture": path.name,
                        "issue": "combined_death_disability_must_have_one_responsibility",
                    }
                )
            else:
                responsibility = responsibilities[0]
                branches = responsibility.get("branches") or []
                conditions = [
                    str(branch.get("conditionText") or "")
                    for branch in branches
                    if isinstance(branch, dict)
                ]
                if responsibility.get("indicatorDecisionCount") != 1:
                    issues.append(
                        {
                            "fixture": path.name,
                            "issue": "combined_death_disability_must_have_one_indicator",
                        }
                    )
                if not any("疾病" in condition for condition in conditions) or not any(
                    "意外" in condition for condition in conditions
                ):
                    issues.append(
                        {
                            "fixture": path.name,
                            "issue": "cause_conditions_must_remain_branches",
                        }
                    )

    required_topologies = TOPOLOGIES - set(topology_counts)
    for topology in sorted(required_topologies):
        issues.append({"fixture": "*", "issue": f"missing_topology_fixture:{topology}"})

    return {
        "fixtureCount": len(paths),
        "fixturePaths": [str(path.resolve()) for path in paths],
        "focusedShapeCounts": dict(sorted(required_shapes.items())),
        "topologyCounts": dict(sorted(topology_counts.items())),
        "issues": issues,
        "ok": not issues,
    }


def connect_read_only(path: Path) -> sqlite3.Connection:
    resolved = path.resolve()
    connection = sqlite3.connect(f"file:{resolved}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    if connection.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise RuntimeError("query_only_not_enabled")
    connection.execute("BEGIN")
    connection.execute("SELECT count(*) FROM sqlite_master").fetchone()
    return connection


def file_snapshot(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"path": str(path), "exists": False}
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "exists": True,
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
    }


def load_approved_artifacts(
    connection: sqlite3.Connection,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int]:
    rows = connection.execute(
        """
        WITH ranked AS (
          SELECT a.*,
                 row_number() OVER (
                   PARTITION BY company, product_name, source_digest
                   ORDER BY published_at DESC, id DESC
                 ) AS rn
            FROM product_responsibility_artifacts a
           WHERE json_extract(payload, '$.audit.status') = 'approved'
        )
        SELECT id, company, product_name, source_digest, source_url,
               published_at, publisher_version, payload
          FROM ranked
         WHERE rn = 1
        """
    ).fetchall()
    artifacts: list[dict[str, Any]] = []
    rejected: list[dict[str, Any]] = []
    discovery_count = 0
    for row in rows:
        payload = load_json(row["payload"], {})
        product_type = str((payload.get("productOverview") or {}).get("productType") or "")
        responsibilities = payload.get("responsibilities") or []
        evidence = "\n".join(exact_evidence(item) for item in responsibilities if isinstance(item, dict))
        discovery = "\n".join((row["product_name"] or "", product_type, evidence))
        if not TERM_DISCOVERY_RE.search(discovery):
            continue
        discovery_count += 1
        has_term_type = bool(TERM_TYPE_RE.search(product_type))
        has_term_semantics = bool(
            TERM_EVENT_RE.search(evidence)
            and OBLIGATION_RE.search(evidence)
            and TERM_SCOPE_RE.search(evidence)
        )
        rejection_reasons = []
        if not has_term_type:
            rejection_reasons.append("artifact_product_type_not_term_life")
        if not has_term_semantics:
            rejection_reasons.append("source_backed_term_life_semantics_not_proven")
        if rejection_reasons:
            rejected.append(
                {
                    "company": row["company"],
                    "productName": row["product_name"],
                    "sourceDigest": row["source_digest"],
                    "productType": product_type,
                    "reasons": rejection_reasons,
                }
            )
            continue
        artifacts.append(
            {
                "id": row["id"],
                "company": row["company"],
                "productName": row["product_name"],
                "sourceDigest": row["source_digest"],
                "sourceUrl": row["source_url"],
                "publishedAt": row["published_at"],
                "publisherVersion": row["publisher_version"],
                "payload": payload,
                "productType": product_type,
            }
        )
    return artifacts, rejected, discovery_count


def load_projection_rows(
    connection: sqlite3.Connection,
    table: str,
    company: str,
    product_name: str,
    source_digest: str,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        f"""
        SELECT *
          FROM {table}
         WHERE company = ?
           AND product_name = ?
           AND json_extract(payload, '$.sourceDigest') = ?
        """,
        (company, product_name, source_digest),
    ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["payload"] = load_json(item.get("payload"), {})
        result.append(item)
    return result


def responsibility_ids(items: list[dict[str, Any]]) -> list[str]:
    return [str(item.get("responsibilityId") or "") for item in items]


def official_ids(payload: dict[str, Any]) -> list[str]:
    return [
        str(item.get("responsibilityId") or "")
        for item in payload.get("officialChecklist") or []
        if isinstance(item, dict)
    ]


def topology_for(artifact: dict[str, Any], evidence: str) -> tuple[str, list[str]]:
    product_type = artifact["productType"]
    gaps: list[str] = []
    explicit = str(artifact["payload"].get("contractTopology") or "")
    if explicit in TOPOLOGIES:
        return explicit, gaps
    gaps.append("contract_topology_not_materialized")
    if "团体" in product_type:
        return "group", gaps
    if "附加" in product_type or re.search(r"附加合同|主合同", evidence):
        return "rider", gaps
    if re.search(r"组合保障计划|保障计划组成部分|组合合同", evidence):
        return "bundle_component", gaps
    return "standalone", gaps


def bucket_for(
    artifact: dict[str, Any],
    responsibilities: list[dict[str, Any]],
    evidence: str,
    topology: str,
) -> str:
    liabilities = "\n".join(str(item.get("liability") or "") for item in responsibilities)
    formula_text = "\n".join(
        json_text(indicator)
        for responsibility in responsibilities
        for indicator in (responsibility.get("indicators") or [])
        if isinstance(indicator, dict)
    )
    if any(
        PSEUDO_TITLE_RE.fullmatch(str(item.get("liability") or "").strip())
        or len(str(item.get("liability") or "")) > 48
        or CLAUSE_TITLE_RE.match(str(item.get("liability") or "").strip())
        for item in responsibilities
    ):
        return "definition_or_exclusion_pseudo_title"
    if COMPARISON_RE.search(formula_text) and "现金价值" in (formula_text + evidence):
        return "premium_cash_value_amount_comparison"
    if DECREASING_RE.search(evidence + formula_text):
        return "decreasing_amount"
    if WAITING_RE.search(evidence) and any(
        len(indicator.get("branches") or []) > 1
        for item in responsibilities
        for indicator in (item.get("indicators") or [])
        if isinstance(indicator, dict)
    ):
        return "waiting_period_branch"
    if topology == "group":
        return "group"
    if topology in {"rider", "bundle_component"}:
        return topology
    if DISABILITY_RE.search(liabilities):
        return "death_and_total_disability"
    if "身故" in liabilities:
        return "death_only"
    return "other_term_life"


def formula_issues(responsibilities: list[dict[str, Any]]) -> list[str]:
    issues: list[str] = []
    for responsibility in responsibilities:
        responsibility_id = str(responsibility.get("responsibilityId") or "")
        for indicator in responsibility.get("indicators") or []:
            if not isinstance(indicator, dict):
                issues.append(f"{responsibility_id}:indicator_not_object")
                continue
            formula = str(indicator.get("formulaText") or "")
            branches = indicator.get("branches") or []
            operands = indicator.get("operands") or []
            normalized = str(indicator.get("normalizedFormula") or "")
            indicator_evidence = exact_evidence(indicator)
            if (
                not formula
                and not branches
                and indicator.get("calculationStatus") != "not_quantitative"
            ):
                issues.append(f"{responsibility_id}:missing_formula")
            for branch in branches:
                if not isinstance(branch, dict):
                    issues.append(f"{responsibility_id}:branch_not_object")
                    continue
                for field in ("branchId", "conditionText", "formulaText", "basisKey", "requiredInputs"):
                    if field not in branch or branch[field] in (None, "", []):
                        issues.append(f"{responsibility_id}:branch_missing_{field}")
                if branch.get("conditionText") not in indicator_evidence:
                    issues.append(f"{responsibility_id}:branch_condition_not_in_indicator_evidence")
                for token in branch.get("evidenceTokens") or []:
                    if token not in indicator_evidence:
                        issues.append(f"{responsibility_id}:branch_token_not_in_indicator_evidence")
                branch_formula = json_text(branch)
                if COMPARISON_RE.search(branch_formula) and not branch.get("operands"):
                    issues.append(f"{responsibility_id}:branch_comparison_missing_operands")
                for operand in branch.get("operands") or []:
                    for token in operand.get("evidenceTokens") or []:
                        if token not in indicator_evidence:
                            issues.append(f"{responsibility_id}:operand_token_not_in_indicator_evidence")
            if COMPARISON_RE.search(formula + normalized) and not operands and not any(
                isinstance(branch, dict) and branch.get("operands") for branch in branches
            ):
                issues.append(f"{responsibility_id}:comparison_missing_operands")
            for operand in operands:
                for token in operand.get("evidenceTokens") or []:
                    if token not in indicator_evidence:
                        issues.append(f"{responsibility_id}:operand_token_not_in_indicator_evidence")
    return sorted(set(issues))


def evaluate_artifact(connection: sqlite3.Connection, artifact: dict[str, Any]) -> dict[str, Any]:
    payload = artifact["payload"]
    responsibilities = [
        item for item in payload.get("responsibilities") or [] if isinstance(item, dict)
    ]
    evidence = "\n".join(exact_evidence(item) for item in responsibilities)
    cards = load_projection_rows(
        connection,
        "product_responsibility_cards",
        artifact["company"],
        artifact["productName"],
        artifact["sourceDigest"],
    )
    indicators = load_projection_rows(
        connection,
        "insurance_indicator_records",
        artifact["company"],
        artifact["productName"],
        artifact["sourceDigest"],
    )
    card_payloads = [item["payload"] for item in cards]
    indicator_payloads = [item["payload"] for item in indicators]
    resp_ids = responsibility_ids(responsibilities)
    checklist_ids = official_ids(payload)
    card_ids = responsibility_ids(card_payloads)
    indicator_ids = responsibility_ids(indicator_payloads)
    topology, topology_gaps = topology_for(artifact, evidence)
    bucket = bucket_for(artifact, responsibilities, evidence, topology)

    identity_ok = (
        payload.get("company") == artifact["company"]
        and payload.get("productName") == artifact["productName"]
        and (payload.get("productIdentity") or {}).get("sourceDigest") == artifact["sourceDigest"]
    )
    source_host = urlparse(str(artifact["sourceUrl"] or "")).hostname
    evidence_missing = [
        str(item.get("responsibilityId") or "")
        for item in responsibilities
        if not exact_evidence(item).strip()
    ]
    inventory_ok = (
        bool(resp_ids)
        and len(resp_ids) == len(set(resp_ids))
        and sorted(checklist_ids) == sorted(resp_ids)
    )
    card_ok = sorted(card_ids) == sorted(resp_ids) and len(card_ids) == len(set(card_ids))
    indicator_ok = set(indicator_ids) == set(resp_ids) and all(
        indicator_ids.count(responsibility_id) >= 1 for responsibility_id in resp_ids
    )
    customer_issues = [
        str(card.get("responsibilityId") or card.get("title") or "")
        for card in card_payloads
        if not str(card.get("customerSummary") or "").strip()
        or any(term in str(card.get("customerSummary") or "") for term in INTERNAL_CUSTOMER_TERMS)
    ]
    projection_source_mismatches = [
        str(item.get("responsibilityId") or item.get("title") or item.get("liability") or "")
        for item in card_payloads + indicator_payloads
        if item.get("sourceUrl") != artifact["sourceUrl"]
    ]
    unofficial_indicators = [
        str(item.get("responsibilityId") or item.get("liability") or "")
        for item in indicator_payloads
        if item.get("official") is not True
    ]
    malformed_titles = [
        str(item.get("liability") or "")
        for item in responsibilities
        if PSEUDO_TITLE_RE.fullmatch(str(item.get("liability") or "").strip())
        or len(str(item.get("liability") or "")) > 48
        or CLAUSE_TITLE_RE.match(str(item.get("liability") or "").strip())
    ]
    classification_fields = "\n".join(
        (
            artifact["productType"],
            str(payload.get("semanticFamily") or ""),
            str((payload.get("productOverview") or {}).get("semanticFamily") or ""),
            "\n".join(str(item.get("category") or "") for item in card_payloads),
        )
    )
    false_whole_life = bool(FALSE_WHOLE_LIFE_RE.search(classification_fields))
    other_family = bool(OTHER_FAMILY_RE.search(artifact["productType"]))
    formula_failures = formula_issues(responsibilities)

    issues: list[str] = []
    if not identity_ok:
        issues.append("identity_mismatch")
    if not source_host:
        issues.append("official_source_url_missing")
    if evidence_missing:
        issues.append("responsibility_evidence_missing")
    if projection_source_mismatches or unofficial_indicators:
        issues.append("projection_official_source_mismatch")
    if not inventory_ok:
        issues.append("responsibility_inventory_omission_or_duplicate")
    if not card_ok:
        issues.append("card_exact_readback_mismatch")
    if not indicator_ok:
        issues.append("indicator_exact_readback_mismatch")
    if customer_issues:
        issues.append("customer_summary_gate_failed")
    if malformed_titles:
        issues.append("definition_exclusion_or_clause_used_as_title")
    if false_whole_life or other_family:
        issues.append("wrong_non_term_classification")
    if formula_failures:
        issues.append("formula_branch_gate_failed")
    issues.extend(topology_gaps)

    return {
        "company": artifact["company"],
        "productName": artifact["productName"],
        "sourceDigest": artifact["sourceDigest"],
        "sourceUrl": artifact["sourceUrl"],
        "productType": artifact["productType"],
        "contractTopology": topology,
        "sampleBucket": bucket,
        "responsibilityCount": len(resp_ids),
        "cardCount": len(card_ids),
        "indicatorCount": len(indicator_ids),
        "gates": {
            "approvedArtifact": (payload.get("audit") or {}).get("status") == "approved",
            "exactIdentity": identity_ok,
            "officialSourceAndSameDigestEvidence": (
                bool(source_host)
                and not evidence_missing
                and not projection_source_mismatches
                and not unofficial_indicators
            ),
            "inventory": inventory_ok,
            "cardReadback": card_ok,
            "indicatorReadback": indicator_ok,
            "customerSummary": not customer_issues,
            "termLifeClassification": not false_whole_life and not other_family,
            "formulaBranchesEvidence": not formula_failures,
            "contractTopologyMaterialized": not topology_gaps,
        },
        "responsibilityOmissions": sorted(set(checklist_ids) - set(resp_ids)),
        "missingCardResponsibilityIds": sorted(set(resp_ids) - set(card_ids)),
        "missingIndicatorResponsibilityIds": sorted(set(resp_ids) - set(indicator_ids)),
        "malformedResponsibilityTitles": malformed_titles,
        "wrongIncreasedWholeLifeClassification": false_whole_life,
        "formulaBranchEvidenceFailures": formula_failures,
        "missingEvidenceResponsibilityIds": evidence_missing,
        "projectionSourceMismatches": projection_source_mismatches,
        "unofficialIndicatorResponsibilityIds": unofficial_indicators,
        "customerSummaryIssues": customer_issues,
        "issues": sorted(set(issues)),
    }


def select_mutually_exclusive_sample(
    evaluated: list[dict[str, Any]], sample_size: int
) -> list[dict[str, Any]]:
    if sample_size < 20:
        raise ValueError("sample_size_must_be_at_least_20")
    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in evaluated:
        groups[item["sampleBucket"]].append(item)
    for items in groups.values():
        items.sort(key=lambda item: (item["company"], item["sourceDigest"], item["productName"]))

    selected: list[dict[str, Any]] = []
    used: set[tuple[str, str, str]] = set()
    company_counts: Counter[str] = Counter()
    bucket_counts: Counter[str] = Counter()

    for bucket in sorted(groups):
        item = groups[bucket].pop(0)
        identity = (item["company"], item["productName"], item["sourceDigest"])
        selected.append(item)
        used.add(identity)
        company_counts[item["company"]] += 1
        bucket_counts[bucket] += 1
        if len(selected) == sample_size:
            return selected

    while len(selected) < sample_size:
        candidates = [item for items in groups.values() for item in items]
        if not candidates:
            break
        item = min(
            candidates,
            key=lambda candidate: (
                company_counts[candidate["company"]],
                bucket_counts[candidate["sampleBucket"]],
                candidate["sampleBucket"],
                candidate["company"],
                candidate["sourceDigest"],
            ),
        )
        groups[item["sampleBucket"]].remove(item)
        identity = (item["company"], item["productName"], item["sourceDigest"])
        if identity in used:
            continue
        selected.append(item)
        used.add(identity)
        company_counts[item["company"]] += 1
        bucket_counts[item["sampleBucket"]] += 1
    return selected


def build_forward_test(db_path: Path, sample_size: int) -> dict[str, Any]:
    db_before = file_snapshot(db_path)
    wal_path = Path(f"{db_path}-wal")
    wal_before = file_snapshot(wal_path)
    connection = connect_read_only(db_path)
    try:
        artifacts, discovery_rejected, discovery_count = load_approved_artifacts(connection)
        evaluated = [evaluate_artifact(connection, artifact) for artifact in artifacts]
    finally:
        connection.close()
    db_after = file_snapshot(db_path)
    wal_after = file_snapshot(wal_path)

    sample = select_mutually_exclusive_sample(evaluated, sample_size)
    issue_counts = Counter(issue for item in sample for issue in item["issues"])
    bucket_counts = Counter(item["sampleBucket"] for item in sample)
    topology_counts = Counter(item["contractTopology"] for item in sample)
    company_counts = Counter(item["company"] for item in sample)

    return {
        "databasePath": str(db_path.resolve()),
        "databaseMode": "sqlite_uri_mode_ro+query_only+single_read_transaction",
        "databaseSnapshot": {
            "databaseBefore": db_before,
            "databaseAfter": db_after,
            "walBefore": wal_before,
            "walAfter": wal_after,
            "externalFilesChangedDuringRead": db_before != db_after or wal_before != wal_after,
            "readTransactionConsistent": True,
        },
        "cohortIdentity": ["company", "productName", "sourceDigest"],
        "approvedExactDiscoveryCohortCount": discovery_count,
        "cohortCount": len(evaluated),
        "discoveryRejectedCount": len(discovery_rejected),
        "discoveryRejected": discovery_rejected,
        "sampleCount": len(sample),
        "sampleRequested": sample_size,
        "mutuallyExclusiveBucketCounts": dict(sorted(bucket_counts.items())),
        "contractTopologyCounts": dict(sorted(topology_counts.items())),
        "companyCounts": dict(sorted(company_counts.items())),
        "issueCounts": dict(sorted(issue_counts.items())),
        "responsibilityOmissionSampleCount": sum(
            bool(item["responsibilityOmissions"]) for item in sample
        ),
        "cardReadbackMismatchSampleCount": sum(
            bool(item["missingCardResponsibilityIds"]) for item in sample
        ),
        "indicatorReadbackMismatchSampleCount": sum(
            bool(item["missingIndicatorResponsibilityIds"]) for item in sample
        ),
        "wrongIncreasedWholeLifeClassificationCount": sum(
            item["wrongIncreasedWholeLifeClassification"] for item in sample
        ),
        "formulaBranchEvidenceFailureSampleCount": sum(
            bool(item["formulaBranchEvidenceFailures"]) for item in sample
        ),
        "evidenceGateFailureSampleCount": sum(
            not item["gates"]["officialSourceAndSameDigestEvidence"] for item in sample
        ),
        "sample": sample,
    }


def main() -> int:
    args = parse_args()
    report: dict[str, Any] = {}

    if args.fixtures_dir:
        report["fixtures"] = validate_fixtures(args.fixtures_dir.resolve())
    if args.validate_fixtures_only:
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return 0 if report.get("fixtures", {}).get("ok") else 1

    if not args.db or not args.output:
        raise SystemExit("--db and --output are required unless --validate-fixtures-only is used")
    if args.sample_size < 20:
        raise SystemExit("--sample-size must be at least 20")

    report["forwardTest"] = build_forward_test(args.db.resolve(), args.sample_size)
    canonical = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(canonical, encoding="utf-8")
    digest = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    print(
        json.dumps(
            {
                "ok": report.get("fixtures", {}).get("ok", True),
                "output": str(output),
                "sha256": digest,
                "sampleCount": report["forwardTest"]["sampleCount"],
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0 if report.get("fixtures", {}).get("ok", True) else 1


if __name__ == "__main__":
    raise SystemExit(main())
