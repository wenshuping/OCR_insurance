#!/usr/bin/env python3
"""Read-only cohort and forward-test audit for critical-illness responsibilities."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_VERSION = "2026-07-29-v1"
ALLOWED_TOPOLOGIES = {"standalone", "rider", "group", "bundle_component"}
TARGET_PATTERNS = (
    "single_pay",
    "grouped_multiple",
    "ungrouped_multiple",
    "tiered",
    "additional_age_condition",
    "waiver",
    "optional_death_disability",
    "waiting_period",
)


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def normalized(value: Any) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text(value)))


def rows(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def parse_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    try:
        parsed = json.loads(text(value))
    except (json.JSONDecodeError, TypeError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def evidence_parts(item: dict[str, Any]) -> list[str]:
    direct = text(item.get("sourceExcerpt"))
    if direct:
        return [direct]
    return [
        text(segment.get("sourceExcerpt") or segment.get("text") or segment.get("excerpt"))
        for segment in rows(item.get("evidenceSegments"))
        if isinstance(segment, dict)
        and text(segment.get("sourceExcerpt") or segment.get("text") or segment.get("excerpt"))
    ]


def liability(item: dict[str, Any]) -> str:
    card = item.get("card") if isinstance(item.get("card"), dict) else {}
    return text(
        item.get("liability")
        or item.get("responsibilityName")
        or item.get("title")
        or card.get("title")
    )


def responsibility_id(item: dict[str, Any]) -> str:
    return text(item.get("responsibilityId"))


def derive_patterns(payload: dict[str, Any]) -> set[str]:
    responsibilities = [item for item in rows(payload.get("responsibilities")) if isinstance(item, dict)]
    titles = [liability(item) for item in responsibilities]
    joined = json.dumps(payload, ensure_ascii=False)
    severe = [title for title in titles if "重大疾病" in title or "重度疾病" in title]
    patterns: set[str] = set()

    grouped = "分组" in joined and "不分组" not in joined and "无分组" not in joined
    ungrouped = "不分组" in joined or "无分组" in joined
    multiple = bool(re.search(r"(第二次|第三次|多次|累计.{0,8}[两二三四五六七八九十]次)", joined))
    tiered = any("轻度疾病" in title or "轻症" in title for title in titles) and any(
        "中度疾病" in title or "中症" in title for title in titles
    ) and bool(severe)

    if len(severe) == 1 and not multiple and not grouped and not ungrouped:
        patterns.add("single_pay")
    if grouped and multiple:
        patterns.add("grouped_multiple")
    if ungrouped and multiple:
        patterns.add("ungrouped_multiple")
    if tiered:
        patterns.add("tiered")
    if any("额外" in title or "关爱" in title for title in titles) and re.search(
        r"\d+\s*周岁|年龄|保单周年日|第\d+个保单年度", joined
    ):
        patterns.add("additional_age_condition")
    if any(text(item.get("responsibilityKind")) == "waiver" or "豁免" in liability(item) for item in responsibilities):
        patterns.add("waiver")
    if any(
        item.get("groupId") is not None and ("身故" in liability(item) or "全残" in liability(item))
        for item in responsibilities
    ):
        patterns.add("optional_death_disability")
    if any(
        text(item.get("responsibilityKind")) == "waiting_period_refund" for item in responsibilities
    ) or "等待期" in joined:
        patterns.add("waiting_period")
    return patterns


def route_for(payload: dict[str, Any], patterns: set[str]) -> str:
    responsibilities = [item for item in rows(payload.get("responsibilities")) if isinstance(item, dict)]
    joined = json.dumps(payload, ensure_ascii=False)
    severe_count = sum("重大疾病" in liability(item) or "重度疾病" in liability(item) for item in responsibilities)
    complex_markers = patterns - {"single_pay", "waiting_period"}
    has_formula_complexity = bool(re.search(r"(分支|较大者|较小者|max\(|min\(|系数表|给付比例表)", joined))
    has_optional = bool(rows(payload.get("optionalGroups")))
    return (
        "deepseek-standard"
        if severe_count == 1 and not complex_markers and not has_formula_complexity and not has_optional
        else "luna-complex"
    )


def validate_fixture(path: Path) -> dict[str, Any]:
    fixture = parse_json(path.read_text(encoding="utf-8"))
    issues: list[str] = []
    source = text(fixture.get("sourceText"))
    topology = text(fixture.get("contractTopology"))
    topology_evidence = text(fixture.get("topologyEvidence"))
    if topology not in ALLOWED_TOPOLOGIES:
        issues.append(f"invalid contractTopology: {topology}")
    if not topology_evidence or normalized(topology_evidence) not in normalized(source):
        issues.append("topologyEvidence is not an exact source substring")
    topology_fields = fixture.get("topology") if isinstance(fixture.get("topology"), dict) else {}
    if topology == "rider" and not topology_fields.get("mainContractDependency"):
        issues.append("rider is missing mainContractDependency")
    if topology == "group" and not topology_fields.get("memberEligibility"):
        issues.append("group is missing memberEligibility")
    if topology == "bundle_component" and not (
        topology_fields.get("containingContract") and topology_fields.get("component")
    ):
        issues.append("bundle_component is missing containingContract/component")

    accepted: list[str] = []
    rejected: list[str] = []
    for index, candidate in enumerate(rows(fixture.get("candidates"))):
        if not isinstance(candidate, dict):
            issues.append(f"candidate[{index}] is not an object")
            continue
        heading = text(candidate.get("heading"))
        section_type = text(candidate.get("sectionType"))
        evidence = text(candidate.get("evidence"))
        if not evidence or normalized(evidence) not in normalized(source):
            issues.append(f"{heading}: evidence is not an exact source substring")
        if section_type == "responsibility":
            trigger = text(candidate.get("triggerCondition"))
            obligation = text(candidate.get("insurerObligation"))
            if not trigger or normalized(trigger) not in normalized(evidence):
                issues.append(f"{heading}: missing exact triggerCondition")
            if not obligation or normalized(obligation) not in normalized(evidence):
                issues.append(f"{heading}: missing exact insurerObligation")
            formula = candidate.get("formula") if isinstance(candidate.get("formula"), dict) else {}
            if not isinstance(formula.get("requiredInputs"), list):
                issues.append(f"{heading}: requiredInputs must be an array")
            for token in rows(formula.get("evidenceTokens")):
                if normalized(token) not in normalized(evidence):
                    issues.append(f"{heading}: formula token not in evidence: {token}")
            accepted.append(heading)
        else:
            rejected.append(heading)

    expected = fixture.get("expected") if isinstance(fixture.get("expected"), dict) else {}
    if accepted != rows(expected.get("acceptedHeadings")):
        issues.append("accepted heading set/order differs from expected")
    if rejected != rows(expected.get("rejectedHeadings")):
        issues.append("rejected heading set/order differs from expected")
    return {
        "fixtureId": text(fixture.get("fixtureId")) or path.stem,
        "path": str(path.resolve()),
        "contractTopology": topology,
        "acceptedCount": len(accepted),
        "rejectedCount": len(rejected),
        "patterns": rows(expected.get("patterns")),
        "status": "passed" if not issues else "failed",
        "issues": issues,
    }


def validate_fixtures(fixtures_dir: Path) -> dict[str, Any]:
    results = [validate_fixture(path) for path in sorted(fixtures_dir.glob("*.json"))]
    ids = [item["fixtureId"] for item in results]
    duplicate_ids = sorted(key for key, count in Counter(ids).items() if count > 1)
    return {
        "status": "passed" if results and not duplicate_ids and all(item["status"] == "passed" for item in results) else "failed",
        "fixtureCount": len(results),
        "passedCount": sum(item["status"] == "passed" for item in results),
        "duplicateFixtureIds": duplicate_ids,
        "results": results,
    }


def open_read_only(db_path: Path) -> sqlite3.Connection:
    uri = f"{db_path.resolve().as_uri()}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    connection.execute("PRAGMA busy_timeout=5000")
    if connection.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise RuntimeError("SQLite query_only could not be enabled")
    return connection


def load_cohort(connection: sqlite3.Connection) -> tuple[list[dict[str, Any]], int]:
    raw_count = connection.execute(
        """
        SELECT count(*)
        FROM product_responsibility_artifacts
        WHERE json_extract(payload, '$.audit.status') = 'approved'
          AND (
            product_name LIKE '%重大疾病%'
            OR product_name LIKE '%重疾%'
            OR product_name LIKE '%疾病保险%'
          )
        """
    ).fetchone()[0]
    records = connection.execute(
        """
        WITH ranked AS (
          SELECT id, company, product_name, source_digest, source_url, published_at, payload,
                 row_number() OVER (
                   PARTITION BY company, product_name, source_digest
                   ORDER BY published_at DESC, id DESC
                 ) AS rn
          FROM product_responsibility_artifacts
          WHERE json_extract(payload, '$.audit.status') = 'approved'
            AND (
              product_name LIKE '%重大疾病%'
              OR product_name LIKE '%重疾%'
              OR product_name LIKE '%疾病保险%'
            )
        )
        SELECT id, company, product_name, source_digest, source_url, published_at, payload
        FROM ranked
        WHERE rn = 1
        ORDER BY company, product_name, source_digest
        """
    ).fetchall()
    cohort: list[dict[str, Any]] = []
    for record in records:
        payload = parse_json(record["payload"])
        patterns = derive_patterns(payload)
        cohort.append(
            {
                "artifactId": record["id"],
                "company": text(record["company"]),
                "productName": text(record["product_name"]),
                "sourceDigest": text(record["source_digest"]),
                "sourceUrl": text(record["source_url"] or payload.get("productIdentity", {}).get("sourceUrl")),
                "publishedAt": text(record["published_at"]),
                "payload": payload,
                "patterns": patterns,
                "route": route_for(payload, patterns),
                "contractTopology": text(payload.get("contractTopology")) or "unknown",
            }
        )
    return cohort, raw_count


def select_samples(cohort: list[dict[str, Any]], sample_size: int) -> list[dict[str, Any]]:
    ordered = sorted(
        cohort,
        key=lambda item: hashlib.sha256(
            f"{item['company']}\x1f{item['productName']}\x1f{item['sourceDigest']}".encode()
        ).hexdigest(),
    )
    selected: list[dict[str, Any]] = []
    selected_keys: set[tuple[str, str, str]] = set()
    company_counts: Counter[str] = Counter()

    def add(item: dict[str, Any], company_limit: int) -> bool:
        key = (item["company"], item["productName"], item["sourceDigest"])
        if key in selected_keys or company_counts[item["company"]] >= company_limit:
            return False
        selected.append(item)
        selected_keys.add(key)
        company_counts[item["company"]] += 1
        return True

    for pattern in TARGET_PATTERNS:
        for item in ordered:
            if pattern in item["patterns"] and add(item, 1):
                break
    for company_limit in (1, 2, sample_size):
        for item in ordered:
            if len(selected) >= sample_size:
                break
            add(item, company_limit)
        if len(selected) >= sample_size:
            break
    if len(selected) < sample_size:
        raise RuntimeError(f"cohort only yielded {len(selected)} mutually exclusive samples")
    return selected[:sample_size]


def load_related_rows(
    connection: sqlite3.Connection,
    table: str,
    selected: list[dict[str, Any]],
) -> dict[tuple[str, str], list[dict[str, Any]]]:
    predicates = " OR ".join("(company = ? AND product_name = ?)" for _ in selected)
    parameters = [value for item in selected for value in (item["company"], item["productName"])]
    columns = "id, company, product_name, payload"
    if table == "product_responsibility_cards":
        columns += ", title"
    else:
        columns += ", liability"
    result: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for record in connection.execute(f"SELECT {columns} FROM {table} WHERE {predicates}", parameters):
        item = dict(record)
        item["payload"] = parse_json(item["payload"])
        result[(text(item["company"]), text(item["product_name"]))].append(item)
    return result


def load_source_texts(
    connection: sqlite3.Connection,
    selected: list[dict[str, Any]],
) -> dict[str, list[str]]:
    urls = sorted({item["sourceUrl"] for item in selected if item["sourceUrl"]})
    if not urls:
        return {}
    placeholders = ",".join("?" for _ in urls)
    source_texts: dict[str, list[str]] = defaultdict(list)
    query = f"SELECT url, payload FROM knowledge_records WHERE url IN ({placeholders})"
    for record in connection.execute(query, urls):
        payload = parse_json(record["payload"])
        page_text = text(payload.get("pageText"))
        if page_text:
            source_texts[text(record["url"])].append(page_text)
    return source_texts


def audit_evidence(payload: dict[str, Any], source_texts: list[str]) -> dict[str, Any]:
    missing_packets: list[str] = []
    missing_semantics: list[str] = []
    non_exact: list[str] = []
    official_text = normalized("\n".join(source_texts))
    responsibilities = [item for item in rows(payload.get("responsibilities")) if isinstance(item, dict)]
    for item in responsibilities:
        rid = responsibility_id(item) or liability(item)
        parts = evidence_parts(item)
        if not parts:
            missing_packets.append(rid)
        if not text(item.get("triggerCondition")) or not text(item.get("insurerObligation")):
            missing_semantics.append(rid)
        if official_text:
            for part in parts:
                if normalized(part) not in official_text:
                    non_exact.append(rid)
                    break
    if missing_packets or missing_semantics:
        status = "failed"
    elif not official_text or non_exact:
        status = "review"
    else:
        status = "passed"
    return {
        "status": status,
        "responsibilityCount": len(responsibilities),
        "localOfficialTextFound": bool(official_text),
        "missingEvidencePackets": sorted(set(missing_packets)),
        "missingTriggerOrObligation": sorted(set(missing_semantics)),
        "nonExactEvidenceAgainstLocalText": sorted(set(non_exact)),
    }


def audit_formula(payload: dict[str, Any]) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    indicator_count = 0
    responsibilities = [item for item in rows(payload.get("responsibilities")) if isinstance(item, dict)]
    for item in responsibilities:
        rid = responsibility_id(item) or liability(item)
        indicators = [entry for entry in rows(item.get("indicators")) if isinstance(entry, dict)]
        if not indicators:
            issues.append({"responsibilityId": rid, "issue": "missing_indicator_decision"})
            continue
        for indicator in indicators:
            indicator_count += 1
            formula_text = text(indicator.get("formulaText"))
            normalized_formula = text(indicator.get("normalizedFormula"))
            basis = text(indicator.get("basisKey"))
            status = text(indicator.get("calculationStatus"))
            branches = rows(indicator.get("branches"))
            operands = rows(indicator.get("operands"))
            required_inputs = indicator.get("requiredInputs")
            evidence = normalized("\n".join(evidence_parts(indicator) or evidence_parts(item)))
            if not isinstance(required_inputs, list):
                issues.append({"responsibilityId": rid, "issue": "requiredInputs_not_array"})
            if status != "not_quantitative" and not (formula_text or normalized_formula or branches or operands):
                issues.append({"responsibilityId": rid, "issue": "missing_formula_or_not_quantitative_decision"})
            if basis == "piecewise" and not branches:
                issues.append({"responsibilityId": rid, "issue": "piecewise_without_branches"})
            if re.search(r"\b(max|min)\s*\(", normalized_formula) and not operands:
                issues.append({"responsibilityId": rid, "issue": "comparison_without_operands"})
            for branch in branches:
                if not isinstance(branch, dict) or not all(
                    key in branch
                    for key in ("branchId", "conditionText", "formulaText", "basisKey", "calculationStatus", "requiredInputs")
                ):
                    issues.append({"responsibilityId": rid, "issue": "invalid_branch_shape"})
            for operand in operands:
                if not isinstance(operand, dict) or not all(
                    key in operand for key in ("operandId", "formulaText", "basisKey", "requiredInputs")
                ):
                    issues.append({"responsibilityId": rid, "issue": "invalid_operand_shape"})
            for token in rows(indicator.get("evidenceTokens")):
                if evidence and normalized(token) not in evidence:
                    issues.append({"responsibilityId": rid, "issue": f"formula_token_not_in_evidence:{token}"})
    return {
        "status": "passed" if not issues else "failed",
        "indicatorCount": indicator_count,
        "issueCount": len(issues),
        "issues": issues,
    }


def formula_signature(indicator: dict[str, Any]) -> str:
    projection = {
        "formulaText": text(indicator.get("formulaText")),
        "normalizedFormula": text(indicator.get("normalizedFormula")),
        "requiredInputs": rows(indicator.get("requiredInputs")),
        "branches": rows(indicator.get("branches")),
        "operands": rows(indicator.get("operands")),
    }
    return json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def audit_readback(
    sample: dict[str, Any],
    card_rows: list[dict[str, Any]],
    indicator_rows: list[dict[str, Any]],
) -> dict[str, Any]:
    payload = sample["payload"]
    digest = sample["sourceDigest"]
    responsibilities = [item for item in rows(payload.get("responsibilities")) if isinstance(item, dict)]
    expected_ids = {responsibility_id(item) for item in responsibilities if responsibility_id(item)}
    expected_titles: set[str] = set()
    expected_primary_titles: set[str] = set()
    for item in responsibilities:
        card = item.get("card") if isinstance(item.get("card"), dict) else {}
        primary_title = text(card.get("title")) or liability(item)
        if primary_title:
            expected_primary_titles.add(normalized(primary_title))
        if liability(item):
            expected_titles.add(normalized(liability(item)))
        if text(card.get("title")):
            expected_titles.add(normalized(card.get("title")))

    digest_cards = [
        item for item in card_rows if text(item["payload"].get("sourceDigest")) == digest
    ]
    observed_cards = digest_cards or card_rows
    card_ids = {
        text(item["payload"].get("responsibilityId"))
        for item in observed_cards
        if text(item["payload"].get("responsibilityId"))
    }
    card_titles = {
        normalized(item.get("title") or item["payload"].get("title"))
        for item in observed_cards
        if text(item.get("title") or item["payload"].get("title"))
    }

    indicator_ids = {
        text(item["payload"].get("responsibilityId"))
        for item in indicator_rows
        if text(item["payload"].get("responsibilityId"))
    }
    indicator_titles = {
        normalized(item.get("liability") or item["payload"].get("liability"))
        for item in indicator_rows
        if text(item.get("liability") or item["payload"].get("liability"))
    }
    missing_cards = sorted(expected_ids - card_ids)
    missing_indicators = sorted(expected_ids - indicator_ids)
    missing_card_titles = sorted(expected_primary_titles - card_titles)
    missing_indicator_titles = sorted(expected_primary_titles - indicator_titles)
    pseudo_cards = sorted(
        text(item.get("title") or item["payload"].get("title"))
        for item in observed_cards
        if (
            text(item["payload"].get("responsibilityId"))
            and text(item["payload"].get("responsibilityId")) not in expected_ids
        )
        or (
            not text(item["payload"].get("responsibilityId"))
            and normalized(item.get("title") or item["payload"].get("title")) not in expected_titles
        )
    )
    pseudo_indicators = sorted(
        text(item.get("liability") or item["payload"].get("liability"))
        for item in indicator_rows
        if (
            text(item["payload"].get("responsibilityId"))
            and text(item["payload"].get("responsibilityId")) not in expected_ids
        )
        or (
            not text(item["payload"].get("responsibilityId"))
            and normalized(item.get("liability") or item["payload"].get("liability")) not in expected_titles
        )
    )

    provenance_gaps = sorted(
        text(item.get("liability") or item["payload"].get("liability") or item["id"])
        for item in indicator_rows
        if text(item["payload"].get("responsibilityId"))
        and text(item["payload"].get("responsibilitySourceDigest")) != digest
    )

    summary_mismatches: list[str] = []
    summary_unverifiable: list[str] = []
    formula_projection_gaps: list[str] = []
    formula_projection_unverifiable: list[str] = []
    card_by_id = {
        text(item["payload"].get("responsibilityId")): item["payload"] for item in observed_cards
    }
    indicators_by_id: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for item in indicator_rows:
        indicators_by_id[text(item["payload"].get("responsibilityId"))].append(item["payload"])

    for responsibility in responsibilities:
        rid = responsibility_id(responsibility)
        artifact_card = responsibility.get("card") if isinstance(responsibility.get("card"), dict) else {}
        expected_summary = normalized(artifact_card.get("customerSummary"))
        persisted_card = card_by_id.get(rid, {})
        actual_summary = normalized(
            persisted_card.get("customerSummary")
            or persisted_card.get("plainSummary")
            or persisted_card.get("benefitExplanation")
        )
        if expected_summary and not persisted_card:
            summary_unverifiable.append(rid)
        elif expected_summary and expected_summary != actual_summary:
            summary_mismatches.append(rid)
        if not persisted_card or not indicators_by_id.get(rid):
            formula_projection_unverifiable.append(rid)
            continue
        persisted_signatures = {formula_signature(item) for item in indicators_by_id.get(rid, [])}
        nested_signatures = {
            formula_signature(item)
            for item in rows(persisted_card.get("indicators"))
            if isinstance(item, dict)
        }
        for artifact_indicator in rows(responsibility.get("indicators")):
            if not isinstance(artifact_indicator, dict):
                continue
            signature = formula_signature(artifact_indicator)
            if signature not in persisted_signatures or signature not in nested_signatures:
                formula_projection_gaps.append(rid)
                break

    strict_issues = (
        missing_cards
        or missing_indicators
        or missing_card_titles
        or missing_indicator_titles
        or pseudo_cards
        or pseudo_indicators
        or provenance_gaps
        or summary_mismatches
        or summary_unverifiable
        or formula_projection_gaps
        or formula_projection_unverifiable
        or len(digest_cards) != len(expected_ids)
    )
    return {
        "status": "passed" if not strict_issues else "materializer_blocked",
        "expectedResponsibilityCount": len(expected_ids),
        "matchingDigestCardCount": len(digest_cards),
        "cardTitleFallbackCoverage": len(expected_titles & card_titles),
        "indicatorTitleFallbackCoverage": len(expected_titles & indicator_titles),
        "missingCardResponsibilityIds": missing_cards,
        "missingIndicatorResponsibilityIds": missing_indicators,
        "missingCardTitles": missing_card_titles,
        "missingIndicatorTitles": missing_indicator_titles,
        "pseudoResponsibilityCards": pseudo_cards,
        "pseudoResponsibilityIndicators": pseudo_indicators,
        "indicatorSourceDigestGaps": provenance_gaps,
        "customerSummaryMismatches": sorted(set(summary_mismatches)),
        "customerSummaryUnverifiableMissingStableId": sorted(set(summary_unverifiable)),
        "formulaProjectionGaps": sorted(set(formula_projection_gaps)),
        "formulaProjectionUnverifiableMissingStableId": sorted(set(formula_projection_unverifiable)),
    }


def audit_sample(
    sample: dict[str, Any],
    cards: dict[tuple[str, str], list[dict[str, Any]]],
    indicators: dict[tuple[str, str], list[dict[str, Any]]],
    source_texts: dict[str, list[str]],
) -> dict[str, Any]:
    key = (sample["company"], sample["productName"])
    evidence = audit_evidence(sample["payload"], source_texts.get(sample["sourceUrl"], []))
    formula = audit_formula(sample["payload"])
    readback = audit_readback(sample, cards.get(key, []), indicators.get(key, []))
    return {
        "company": sample["company"],
        "productName": sample["productName"],
        "sourceDigest": sample["sourceDigest"],
        "sourceUrl": sample["sourceUrl"],
        "contractTopology": sample["contractTopology"],
        "patterns": sorted(sample["patterns"]),
        "route": sample["route"],
        "historicalArtifactAuditStatus": text(sample["payload"].get("audit", {}).get("status")),
        "deterministicGates": {
            "evidence": evidence,
            "formula": formula,
            "validator": "not_reexecuted_db_payload_only",
            "importerDryRun": "not_reexecuted_db_payload_only",
            "readback": readback,
        },
        "forwardTestStatus": (
            "passed_structural_read_only"
            if evidence["status"] == "passed"
            and formula["status"] == "passed"
            and readback["status"] == "passed"
            else "review"
        ),
    }


def write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_hashes(output_dir: Path, filenames: list[str]) -> None:
    lines = []
    for filename in filenames:
        digest = hashlib.sha256((output_dir / filename).read_bytes()).hexdigest()
        lines.append(f"{digest}  {filename}")
    (output_dir / "sha256sums.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures-dir", type=Path, required=True)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--sample-size", type=int, default=24)
    args = parser.parse_args()

    if args.sample_size < 20:
        raise SystemExit("--sample-size must be at least 20")
    if not args.db.is_file():
        raise SystemExit(f"database not found: {args.db}")
    if not args.fixtures_dir.is_dir():
        raise SystemExit(f"fixtures directory not found: {args.fixtures_dir}")
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        raise SystemExit(f"output directory must be empty: {args.output_dir}")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    fixture_validation = validate_fixtures(args.fixtures_dir)
    if fixture_validation["status"] != "passed":
        write_json(args.output_dir / "fixture-validation.json", fixture_validation)
        raise SystemExit("fixture validation failed")

    db_stat = args.db.stat()
    connection = open_read_only(args.db)
    try:
        cohort, raw_count = load_cohort(connection)
        selected = select_samples(cohort, args.sample_size)
        cards = load_related_rows(connection, "product_responsibility_cards", selected)
        indicators = load_related_rows(connection, "insurance_indicator_records", selected)
        source_texts = load_source_texts(connection, selected)
        forward_rows = [audit_sample(item, cards, indicators, source_texts) for item in selected]
    finally:
        connection.close()

    generated_at = datetime.now(timezone.utc).isoformat()
    cohort_company_counts = Counter(item["company"] for item in cohort)
    pattern_counts = Counter(pattern for item in cohort for pattern in item["patterns"])
    route_counts = Counter(item["route"] for item in cohort)
    topology_counts = Counter(item["contractTopology"] for item in cohort)
    selected_keys = {
        (item["company"], item["productName"], item["sourceDigest"]) for item in selected
    }

    manifest = {
        "schemaVersion": SCRIPT_VERSION,
        "generatedAt": generated_at,
        "database": {
            "path": str(args.db.resolve()),
            "openMode": "mode=ro + PRAGMA query_only=ON",
            "sizeBytes": db_stat.st_size,
            "mtimeNs": db_stat.st_mtime_ns,
            "sha256": "not_computed_live_database_has_external_writer",
        },
        "cohortDefinition": {
            "artifactAuditStatus": "approved",
            "productNameFilter": ["%重大疾病%", "%重疾%", "%疾病保险%"],
            "dedupeKey": ["company", "productName", "sourceDigest"],
            "rawArtifactRows": raw_count,
            "exactTripleCount": len(cohort),
            "duplicateRowsCollapsed": raw_count - len(cohort),
        },
        "selection": {
            "requested": args.sample_size,
            "selected": len(selected),
            "uniqueExactTriples": len(selected_keys),
            "mutuallyExclusive": len(selected_keys) == len(selected),
            "strategy": "target structure flags, then distinct companies, deterministic triple hash order",
            "targetPatternCoverage": {
                pattern: sum(pattern in item["patterns"] for item in selected)
                for pattern in TARGET_PATTERNS
            },
            "unavailablePatternsInCohort": [
                pattern for pattern in TARGET_PATTERNS if pattern_counts[pattern] == 0
            ],
        },
        "samples": [
            {
                "company": item["company"],
                "productName": item["productName"],
                "sourceDigest": item["sourceDigest"],
                "sourceUrl": item["sourceUrl"],
                "artifactId": item["artifactId"],
                "patterns": sorted(item["patterns"]),
                "route": item["route"],
                "contractTopology": item["contractTopology"],
            }
            for item in selected
        ],
    }
    pattern_audit = {
        "schemaVersion": SCRIPT_VERSION,
        "generatedAt": generated_at,
        "cohortExactTripleCount": len(cohort),
        "companyCount": len(cohort_company_counts),
        "topCompanies": [
            {"company": company, "exactTripleCount": count}
            for company, count in cohort_company_counts.most_common(30)
        ],
        "structureCounts": {
            pattern: pattern_counts[pattern] for pattern in TARGET_PATTERNS
        },
        "routeCounts": dict(sorted(route_counts.items())),
        "declaredContractTopologyCounts": dict(sorted(topology_counts.items())),
        "topologyAuditNote": "unknown is retained; topology is never inferred from product names",
        "genericRules": [
            "inventory headings before cards",
            "accept only trigger plus insurer obligation",
            "definitions/exclusions/claims/interpretations are not responsibilities",
            "preserve tiers, groups, counts, intervals, age/stage conditions, waivers, optional duties, and waiting-period refunds",
            "keep rider dependency, group member eligibility, and bundle-component relation separate from responsibility formulas",
        ],
    }
    handoff = {
        "schemaVersion": SCRIPT_VERSION,
        "generatedAt": generated_at,
        "productionParserChanged": False,
        "sqliteChanged": False,
        "findings": [
            {
                "code": "historical_topology_missing",
                "count": topology_counts["unknown"],
                "action": "Populate contractTopology only during a future exact-clause review; never infer it from product names.",
            },
            {
                "code": "stable_responsibility_identity_missing_in_readback",
                "cardCount": sum(
                    len(row["deterministicGates"]["readback"]["missingCardResponsibilityIds"])
                    for row in forward_rows
                ),
                "indicatorCount": sum(
                    len(row["deterministicGates"]["readback"]["missingIndicatorResponsibilityIds"])
                    for row in forward_rows
                ),
                "action": "Reproduce on a temporary SQLite copy and repair stable ID/provenance projection before publication.",
            },
            {
                "code": "title_level_responsibility_gap",
                "cardCount": sum(
                    len(row["deterministicGates"]["readback"]["missingCardTitles"])
                    for row in forward_rows
                ),
                "indicatorCount": sum(
                    len(row["deterministicGates"]["readback"]["missingIndicatorTitles"])
                    for row in forward_rows
                ),
                "action": "Review the exact artifact and source packet; do not synthesize the missing title.",
            },
            {
                "code": "formula_gate_failure",
                "sampleCount": sum(
                    row["deterministicGates"]["formula"]["status"] == "failed"
                    for row in forward_rows
                ),
                "action": "Repair exact formula evidence or operands, then rerun canonicalizer, validator, and importer dry-run.",
            },
        ],
        "constraints": [
            "No production parser edit in this task.",
            "No SQLite write or publication.",
            "Any repair must use an isolated temporary database replay and exact source evidence.",
        ],
    }
    forward_test = {
        "schemaVersion": SCRIPT_VERSION,
        "generatedAt": generated_at,
        "sampleCount": len(forward_rows),
        "allSamplesMutuallyExclusive": len(selected_keys) == len(forward_rows),
        "modelCalls": 0,
        "databaseWrites": 0,
        "validatorReexecuted": 0,
        "importerDryRunsReexecuted": 0,
        "gatePolicy": "not_reexecuted is not passed; structural evidence/formula/readback checks are reported separately",
        "summary": {
            "evidence": dict(Counter(row["deterministicGates"]["evidence"]["status"] for row in forward_rows)),
            "formula": dict(Counter(row["deterministicGates"]["formula"]["status"] for row in forward_rows)),
            "readback": dict(Counter(row["deterministicGates"]["readback"]["status"] for row in forward_rows)),
            "forwardTestStatus": dict(Counter(row["forwardTestStatus"] for row in forward_rows)),
            "stableIdMissingResponsibilityCards": sum(
                len(row["deterministicGates"]["readback"]["missingCardResponsibilityIds"])
                for row in forward_rows
            ),
            "stableIdMissingResponsibilityIndicators": sum(
                len(row["deterministicGates"]["readback"]["missingIndicatorResponsibilityIds"])
                for row in forward_rows
            ),
            "titleLevelMissingResponsibilityCards": sum(
                len(row["deterministicGates"]["readback"]["missingCardTitles"])
                for row in forward_rows
            ),
            "titleLevelMissingResponsibilityIndicators": sum(
                len(row["deterministicGates"]["readback"]["missingIndicatorTitles"])
                for row in forward_rows
            ),
            "pseudoResponsibilityCards": sum(
                len(row["deterministicGates"]["readback"]["pseudoResponsibilityCards"])
                for row in forward_rows
            ),
            "pseudoResponsibilityIndicators": sum(
                len(row["deterministicGates"]["readback"]["pseudoResponsibilityIndicators"])
                for row in forward_rows
            ),
            "formulaProjectionGaps": sum(
                len(row["deterministicGates"]["readback"]["formulaProjectionGaps"])
                for row in forward_rows
            ),
            "formulaProjectionUnverifiableMissingStableId": sum(
                len(row["deterministicGates"]["readback"]["formulaProjectionUnverifiableMissingStableId"])
                for row in forward_rows
            ),
            "customerSummaryMismatches": sum(
                len(row["deterministicGates"]["readback"]["customerSummaryMismatches"])
                for row in forward_rows
            ),
            "customerSummaryUnverifiableMissingStableId": sum(
                len(row["deterministicGates"]["readback"]["customerSummaryUnverifiableMissingStableId"])
                for row in forward_rows
            ),
        },
        "samples": forward_rows,
        "handoff": handoff,
    }

    outputs = [
        "fixture-validation.json",
        "sample-manifest.json",
        "pattern-audit.json",
        "forward-test.json",
        "handoff.json",
    ]
    write_json(args.output_dir / outputs[0], fixture_validation)
    write_json(args.output_dir / outputs[1], manifest)
    write_json(args.output_dir / outputs[2], pattern_audit)
    write_json(args.output_dir / outputs[3], forward_test)
    write_json(args.output_dir / outputs[4], handoff)
    write_hashes(args.output_dir, outputs)
    print(
        json.dumps(
            {
                "ok": True,
                "cohortExactTriples": len(cohort),
                "sampleCount": len(forward_rows),
                "fixtureCount": fixture_validation["fixtureCount"],
                "outputDir": str(args.output_dir.resolve()),
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
