#!/usr/bin/env python3
"""Read-only forward test for approved care/disability-income products."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CARE_PRODUCT_RE = re.compile(r"(护理保险|失能收入损失保险)")
STATE_TRIGGER_RE = re.compile(
    r"(护理状态|日常生活活动|ADL|认知|伤残|失能|特定疾病|不能从事|收入损失)"
)
PERIODIC_RE = re.compile(r"(每月|按月|每年|按年|每日|按日|给付.{0,8}(次|年|月|日))")
LIMIT_RE = re.compile(r"(最多|累计|给付期间|给付次数|给付.{0,8}(次|年|月|日)|上限)")
TERMINATION_RE = re.compile(r"(终止|不再给付|停止给付|恢复|身故|复核|重新评定|持续)")
FALSE_TITLE_RE = re.compile(
    r"^(保险责任|基本责任|护理状态|日常生活活动|认知障碍|释义|责任免除|理赔申请|保险金申请)$"
)
ACCEPTED_CHECK_STATUSES = {
    "accepted_deterministic_pipeline",
    "accepted_manual_review",
    "approved",
    "passed",
}
STRATUM_PATTERNS = {
    "long_term_care": re.compile(r"长期护理"),
    "disease_care": re.compile(r"(疾病.{0,16}护理|护理.{0,16}疾病)"),
    "accident_care": re.compile(r"(意外.{0,16}护理|护理.{0,16}意外)"),
    "disability_income": re.compile(r"失能收入"),
    "lump_sum": re.compile(r"(一次性|一次给付|仅给付一次)"),
    "periodic": PERIODIC_RE,
    "adl": re.compile(r"(日常生活活动|ADL|进食|穿衣|移动|行动|沐浴|如厕|大小便)"),
    "cognitive_impairment": re.compile(r"(认知障碍|认知能力|阿尔茨海默|器质性痴呆)"),
}


def load_json(raw: str) -> dict:
    value = json.loads(raw)
    return value if isinstance(value, dict) else {}


def accepted_projection(payload: dict) -> bool:
    status = payload.get("indicatorCheckStatus")
    issues = payload.get("indicatorCheckIssues")
    return status in ACCEPTED_CHECK_STATUSES and (not issues or issues == [])


def responsibility_id(payload: dict) -> str:
    return str(payload.get("responsibilityId") or "")


def official_identity_gate(row: sqlite3.Row, artifact: dict) -> list[str]:
    issues: list[str] = []
    identity = artifact.get("productIdentity") or {}
    if artifact.get("audit", {}).get("status") != "approved":
        issues.append("artifact_not_approved")
    if artifact.get("company") != row["company"]:
        issues.append("artifact_company_mismatch")
    if artifact.get("productName") != row["product_name"]:
        issues.append("artifact_product_name_mismatch")
    if identity.get("sourceDigest") != row["source_digest"]:
        issues.append("artifact_source_digest_mismatch")
    if not DIGEST_RE.fullmatch(str(row["source_digest"] or "")):
        issues.append("invalid_source_digest")
    source_url = str(row["source_url"] or "")
    if not source_url.startswith(("https://", "http://")):
        issues.append("official_source_url_missing")
    artifact_url = str(identity.get("sourceUrl") or "")
    if artifact_url and artifact_url != source_url:
        issues.append("artifact_source_url_mismatch")
    if not artifact.get("officialChecklist"):
        issues.append("official_checklist_missing")
    return issues


def classify_strata(text: str) -> list[str]:
    return [name for name, pattern in STRATUM_PATTERNS.items() if pattern.search(text)]


def topology_from_artifact(artifact: dict) -> str:
    candidates = [
        artifact.get("contractTopology"),
        (artifact.get("productOverview") or {}).get("contractTopology"),
        (artifact.get("productIdentity") or {}).get("contractTopology"),
    ]
    for value in candidates:
        if isinstance(value, dict):
            value = value.get("type")
        if value in {"standalone", "rider", "group", "bundle_component"}:
            return value
    return "unknown"


def audit_product(
    connection: sqlite3.Connection,
    row: sqlite3.Row,
    artifact: dict,
) -> dict:
    company = row["company"]
    product_name = row["product_name"]
    digest = row["source_digest"]
    responsibilities = artifact.get("responsibilities") or []
    artifact_ids = {
        str(item.get("responsibilityId") or "")
        for item in responsibilities
        if item.get("responsibilityId")
    }

    card_rows = connection.execute(
        """
        SELECT id, title, payload
          FROM product_responsibility_cards
         WHERE company = ? AND product_name = ?
        """,
        (company, product_name),
    ).fetchall()
    indicator_rows = connection.execute(
        """
        SELECT id, liability, payload
          FROM insurance_indicator_records
         WHERE company = ? AND product_name = ?
        """,
        (company, product_name),
    ).fetchall()

    cards: list[dict] = []
    foreign_card_digests: set[str] = set()
    for card_row in card_rows:
        payload = load_json(card_row["payload"])
        card_digest = str(payload.get("sourceDigest") or "")
        if card_digest != digest:
            if card_digest:
                foreign_card_digests.add(card_digest)
            continue
        if accepted_projection(payload):
            cards.append(payload)

    indicators: list[dict] = []
    foreign_indicator_digests: set[str] = set()
    for indicator_row in indicator_rows:
        payload = load_json(indicator_row["payload"])
        indicator_digest = str(payload.get("sourceDigest") or "")
        if indicator_digest != digest:
            if indicator_digest:
                foreign_indicator_digests.add(indicator_digest)
            continue
        if accepted_projection(payload):
            indicators.append(payload)

    card_ids = {responsibility_id(item) for item in cards if responsibility_id(item)}
    indicator_ids = {
        responsibility_id(item) for item in indicators if responsibility_id(item)
    }
    identity_issues = official_identity_gate(row, artifact)
    projection_issues: list[str] = []
    if artifact_ids != card_ids:
        projection_issues.append("artifact_card_responsibility_ids_mismatch")
    if artifact_ids != indicator_ids:
        projection_issues.append("artifact_indicator_responsibility_ids_mismatch")
    if foreign_card_digests:
        projection_issues.append("other_digest_cards_present_but_excluded")
    if foreign_indicator_digests:
        projection_issues.append("other_digest_indicators_present_but_excluded")

    omissions: list[dict] = []
    false_responsibilities: list[dict] = []
    state_gate: list[dict] = []
    periodic_gate: list[dict] = []
    reimbursement_confusion: list[dict] = []
    indicators_by_responsibility: dict[str, list[dict]] = defaultdict(list)
    for indicator in indicators:
        indicators_by_responsibility[responsibility_id(indicator)].append(indicator)

    for responsibility in responsibilities:
        rid = str(responsibility.get("responsibilityId") or "")
        title = str(responsibility.get("liability") or "")
        trigger = str(responsibility.get("triggerCondition") or "")
        obligation = str(responsibility.get("insurerObligation") or "")
        evidence = str(responsibility.get("sourceExcerpt") or "")
        if not evidence and responsibility.get("evidenceSegments"):
            evidence = json.dumps(
                responsibility.get("evidenceSegments"), ensure_ascii=False
            )
        joined = " ".join(
            [
                title,
                trigger,
                obligation,
                evidence,
                json.dumps(responsibility.get("importantLimits") or [],
                           ensure_ascii=False),
                json.dumps(indicators_by_responsibility.get(rid) or [],
                           ensure_ascii=False),
            ]
        )

        missing_fields = [
            name
            for name, value in (
                ("triggerCondition", trigger),
                ("insurerObligation", obligation),
                ("sourceEvidence", evidence),
            )
            if not value
        ]
        if rid not in card_ids:
            missing_fields.append("approvedSameDigestCard")
        if rid not in indicator_ids:
            missing_fields.append("approvedSameDigestIndicator")
        if missing_fields:
            omissions.append({"responsibilityId": rid, "missing": missing_fields})

        if FALSE_TITLE_RE.fullmatch(title.strip()):
            false_responsibilities.append(
                {"responsibilityId": rid, "title": title, "reason": "supporting_heading"}
            )
        if "护理" in title or "失能收入" in title:
            if not STATE_TRIGGER_RE.search(trigger + " " + evidence):
                state_gate.append(
                    {"responsibilityId": rid, "issue": "care_or_disability_state_trigger_missing"}
                )
        if PERIODIC_RE.search(joined):
            responsibility_indicators = indicators_by_responsibility.get(rid) or []
            if not any(item.get("formulaText") for item in responsibility_indicators):
                periodic_gate.append(
                    {"responsibilityId": rid, "issue": "periodic_formula_missing"}
                )
            if not any(isinstance(item.get("requiredInputs"), list)
                       for item in responsibility_indicators):
                periodic_gate.append(
                    {"responsibilityId": rid, "issue": "periodic_required_inputs_missing"}
                )
            if not LIMIT_RE.search(joined):
                periodic_gate.append(
                    {"responsibilityId": rid, "issue": "period_or_count_limit_missing"}
                )
            if not TERMINATION_RE.search(joined):
                periodic_gate.append(
                    {"responsibilityId": rid,
                     "issue": "continuation_reassessment_or_termination_missing"}
                )

        looks_like_care_cash = "护理" in title and not re.search(r"(医疗|费用补偿)", title)
        reimbursement_terms = re.search(
            r"(实际.{0,12}(医疗)?费用|免赔额|报销比例|补偿原则)", joined
        )
        if looks_like_care_cash and reimbursement_terms:
            reimbursement_confusion.append(
                {"responsibilityId": rid,
                 "issue": "care_cash_contains_medical_reimbursement_basis"}
            )

    artifact_text = json.dumps(artifact, ensure_ascii=False, sort_keys=True)
    result = {
        "company": company,
        "productName": product_name,
        "sourceDigest": digest,
        "sourceUrl": row["source_url"],
        "artifactId": row["id"],
        "topology": topology_from_artifact(artifact),
        "strata": classify_strata(artifact_text),
        "counts": {
            "artifactResponsibilities": len(artifact_ids),
            "approvedSameDigestCards": len(card_ids),
            "approvedSameDigestIndicators": len(indicators),
            "indicatorCoveredResponsibilities": len(indicator_ids),
        },
        "identityAndOfficialSourceGate": {
            "passed": not identity_issues,
            "issues": identity_issues,
        },
        "sameDigestProjectionGate": {
            "passed": not projection_issues,
            "issues": projection_issues,
            "foreignCardDigestsExcluded": sorted(foreign_card_digests),
            "foreignIndicatorDigestsExcluded": sorted(foreign_indicator_digests),
        },
        "omissions": omissions,
        "falseResponsibilities": false_responsibilities,
        "stateConditionGate": state_gate,
        "periodicPaymentGate": periodic_gate,
        "medicalReimbursementConfusion": reimbursement_confusion,
    }
    semantic_issue_count = sum(
        len(result[key])
        for key in (
            "omissions",
            "falseResponsibilities",
            "stateConditionGate",
            "periodicPaymentGate",
            "medicalReimbursementConfusion",
        )
    )
    result["status"] = (
        "pass"
        if not identity_issues and not projection_issues and semantic_issue_count == 0
        else "review"
    )
    return result


def select_stratified(results: list[dict], sample_size: int) -> list[dict]:
    selected: list[dict] = []
    selected_keys: set[tuple[str, str, str]] = set()
    company_counts: Counter[str] = Counter()

    def add(item: dict) -> None:
        key = (item["company"], item["productName"], item["sourceDigest"])
        if key in selected_keys or len(selected) >= sample_size:
            return
        selected.append(item)
        selected_keys.add(key)
        company_counts[item["company"]] += 1

    for stratum in STRATUM_PATTERNS:
        candidates = [item for item in results if stratum in item["strata"]]
        candidates.sort(
            key=lambda item: (
                company_counts[item["company"]],
                -len(item["strata"]),
                item["company"],
                item["productName"],
            )
        )
        if candidates:
            add(candidates[0])

    by_company: dict[str, list[dict]] = defaultdict(list)
    for item in results:
        by_company[item["company"]].append(item)
    for company in sorted(by_company):
        candidates = sorted(
            by_company[company],
            key=lambda item: (-len(item["strata"]), item["productName"]),
        )
        for candidate in candidates:
            key = (candidate["company"], candidate["productName"],
                   candidate["sourceDigest"])
            if key not in selected_keys:
                add(candidate)
                break

    for item in sorted(
        results,
        key=lambda candidate: (
            company_counts[candidate["company"]],
            -len(candidate["strata"]),
            candidate["company"],
            candidate["productName"],
        ),
    ):
        add(item)
    return selected


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--manifest-output", type=Path)
    parser.add_argument("--sample-size", type=int, default=24)
    args = parser.parse_args()
    if args.sample_size < 20:
        parser.error("--sample-size must be at least 20")
    if not args.db.is_file():
        parser.error(f"database not found: {args.db}")

    database_uri = f"file:{quote(str(args.db.resolve()))}?mode=ro"
    connection = sqlite3.connect(database_uri, uri=True)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute("PRAGMA query_only = ON")
        query_only = connection.execute("PRAGMA query_only").fetchone()[0]
        rows = connection.execute(
            """
            SELECT id, company, product_name, source_digest, source_url,
                   published_at, payload
              FROM product_responsibility_artifacts
             WHERE json_extract(payload, '$.audit.status') = 'approved'
               AND (product_name LIKE '%护理保险%'
                    OR product_name LIKE '%失能收入损失保险%')
             ORDER BY company, product_name, source_digest
            """
        ).fetchall()

        grouped: dict[tuple[str, str], list[sqlite3.Row]] = defaultdict(list)
        for row in rows:
            grouped[(row["company"], row["product_name"])].append(row)
        ambiguous_products = [
            {
                "company": key[0],
                "productName": key[1],
                "sourceDigests": sorted({row["source_digest"] for row in values}),
            }
            for key, values in grouped.items()
            if len({row["source_digest"] for row in values}) != 1
        ]

        results: list[dict] = []
        for key, values in grouped.items():
            digests = {row["source_digest"] for row in values}
            if len(digests) != 1:
                continue
            row = max(values, key=lambda item: str(item["published_at"] or ""))
            artifact = load_json(row["payload"])
            if not CARE_PRODUCT_RE.search(row["product_name"]):
                continue
            results.append(audit_product(connection, row, artifact))
    finally:
        connection.close()

    selected = select_stratified(results, args.sample_size)
    if len(selected) < 20:
        print(
            json.dumps(
                {
                    "ok": False,
                    "issue": "fewer than 20 mutually exclusive approved candidates",
                    "candidateCount": len(results),
                    "selectedCount": len(selected),
                },
                ensure_ascii=False,
            )
        )
        return 2

    generated_at = datetime.now(timezone.utc).isoformat()
    strata_counts = Counter(
        stratum for item in selected for stratum in item["strata"]
    )
    topology_counts = Counter(item["topology"] for item in selected)
    status_counts = Counter(item["status"] for item in selected)
    report = {
        "schemaVersion": "long-term-care-forward-test-v1",
        "generatedAt": generated_at,
        "database": {
            "path": str(args.db.resolve()),
            "sha256": file_sha256(args.db),
            "openMode": "mode=ro",
            "queryOnly": bool(query_only),
            "writesAttempted": 0,
        },
        "selection": {
            "eligibleExactProducts": len(results),
            "selectedMutuallyExclusiveProducts": len(selected),
            "selectedCompanies": len({item["company"] for item in selected}),
            "ambiguousVersionProductsExcluded": ambiguous_products,
            "strataCounts": dict(sorted(strata_counts.items())),
            "topologyCounts": dict(sorted(topology_counts.items())),
        },
        "resultCounts": dict(sorted(status_counts.items())),
        "products": selected,
    }
    write_json(args.output, report)

    if args.manifest_output:
        manifest = {
            "schemaVersion": "long-term-care-forward-manifest-v1",
            "generatedAt": generated_at,
            "databasePath": str(args.db.resolve()),
            "databaseSha256": report["database"]["sha256"],
            "identity": "exact company + productName + sourceDigest",
            "selectionRules": [
                "artifact audit.status == approved",
                "product title is a care-insurance or disability-income-loss product",
                "one unambiguous approved digest per exact company and productName",
                "cards and indicators are accepted and filtered to the same sourceDigest",
                "stratified across care structure and company without duplicate exact keys",
            ],
            "products": [
                {
                    "company": item["company"],
                    "productName": item["productName"],
                    "sourceDigest": item["sourceDigest"],
                    "sourceUrl": item["sourceUrl"],
                    "artifactId": item["artifactId"],
                    "strata": item["strata"],
                    "topology": item["topology"],
                }
                for item in selected
            ],
        }
        write_json(args.manifest_output, manifest)

    print(
        json.dumps(
            {
                "ok": True,
                "output": str(args.output.resolve()),
                "manifestOutput": (
                    str(args.manifest_output.resolve())
                    if args.manifest_output else None
                ),
                "selected": len(selected),
                "companies": report["selection"]["selectedCompanies"],
                "resultCounts": report["resultCounts"],
                "writesAttempted": 0,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
