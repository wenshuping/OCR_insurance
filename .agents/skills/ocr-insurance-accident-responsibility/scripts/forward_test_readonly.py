#!/usr/bin/env python3
"""Run a bounded, read-only accident responsibility forward test on SQLite."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PSEUDO_TITLE_RE = re.compile(
    r"^(保险责任|基本责任|可选责任[一二三四五六七八九十0-9]*|"
    r"意外伤害|意外伤害定义|释义|定义|责任免除|除外责任|"
    r"保险金申请|理赔申请|申请流程|职业类别|职业分类|风险说明|"
    r"伤残等级表|人身保险伤残评定标准及代码|附表[一二三四五六七八九十0-9]*)$"
)
INTERNAL_COPY_TERMS = (
    "audit",
    "validator",
    "sourceDigest",
    "responsibilityId",
    "calculationKey",
    "basisKey",
    "内部检查",
)
EXTRA_RE = re.compile(r"额外给付|另行给付|同时[，,]?\s*再按|除.{0,24}给付.{0,24}外|在.{0,24}基础上")
REPLACEMENT_RE = re.compile(r"替代|不再另行给付|仅按其中|取较高|二者之较[大高]")
MEMBER_ENTRY_RE = re.compile(r"成员资格|被保险人资格|符合.{0,12}条件|在职|参保人员|团体成员|建筑施工")
MEMBER_EXIT_RE = re.compile(r"退出|离职|不再符合|资格终止|减少被保险人|成员资格.{0,12}终止")
PLAN_RE = re.compile(r"保险计划|计划[一二三四五六七八九十A-Z0-9]|档位|方案[一二三四五六七八九十A-Z0-9]|对应的基本保险金额")
RIDER_RE = re.compile(r"本附加合同|主合同|主险合同")
MAIN_DEP_RE = re.compile(r"主合同|主险合同")
RIDER_LIFECYCLE_RE = re.compile(
    r"(主合同|主险合同).{0,40}(生效|终止|中止|失效|效力)"
    r"|(生效|终止|中止|失效|效力).{0,40}(主合同|主险合同)"
)
RIDER_AMOUNT_RE = re.compile(
    r"(主合同|主险合同).{0,30}(基本保险金额|保险金额)"
    r"|本附加合同.{0,30}(基本保险金额|保险金额)"
    r"|保险单.{0,20}(基本保险金额|保险金额)"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def file_state(path: Path) -> dict:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return {"path": str(path), "exists": False}
    return {
        "path": str(path),
        "exists": True,
        "size": stat.st_size,
        "mtimeNs": stat.st_mtime_ns,
        "inode": stat.st_ino,
    }


def db_states(db_path: Path) -> list[dict]:
    return [
        file_state(db_path),
        file_state(Path(f"{db_path}-wal")),
        file_state(Path(f"{db_path}-shm")),
    ]


def open_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{quote(str(db_path.resolve()), safe='/')}?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=30)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    if connection.execute("PRAGMA query_only").fetchone()[0] != 1:
        raise RuntimeError("query_only_not_enabled")
    connection.execute("BEGIN")
    return connection


def json_load(value: str) -> dict:
    loaded = json.loads(value)
    return loaded if isinstance(loaded, dict) else {}


def compact_text(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return " ".join(compact_text(item) for item in value)
    if isinstance(value, dict):
        return " ".join(compact_text(item) for key, item in value.items() if key not in {"company", "productName"})
    return ""


def responsibility_text(responsibility: dict) -> str:
    return " ".join(
        compact_text(responsibility.get(key))
        for key in (
            "liability",
            "triggerCondition",
            "insurerObligation",
            "importantLimits",
            "terminationEffect",
            "sourceExcerpt",
            "evidenceSegments",
            "card",
            "indicators",
        )
    )


def exact_key(row: dict) -> str:
    return "\u241f".join((row["company"], row["productName"], row["sourceDigest"]))


def accident_candidate(payload: dict) -> tuple[bool, dict]:
    responsibilities = payload.get("responsibilities")
    if not isinstance(responsibilities, list) or not responsibilities:
        return False, {}
    product_type = compact_text((payload.get("productOverview") or {}).get("productType"))
    liabilities = [compact_text(item.get("liability")) for item in responsibilities]
    explicit = sum("意外" in liability for liability in liabilities)
    is_candidate = explicit > 0 and (
        "意外" in product_type or explicit == len(responsibilities)
    )
    return is_candidate, {
        "productType": product_type,
        "responsibilityCount": len(responsibilities),
        "explicitAccidentLiabilityCount": explicit,
    }


def signal_counts(payload: dict) -> dict:
    responsibilities = payload.get("responsibilities") or []
    texts = [(compact_text(item.get("liability")), responsibility_text(item)) for item in responsibilities]
    counts = {
        "death": 0,
        "disability": 0,
        "medical": 0,
        "allowance": 0,
        "transportAviation": 0,
        "group": 0,
    }
    for liability, text in texts:
        counts["death"] += int("身故" in liability)
        counts["disability"] += int("伤残" in liability or "残疾" in liability)
        counts["medical"] += int("医疗" in liability or "医药" in liability or "费用补偿" in liability)
        counts["allowance"] += int("津贴" in liability or "日额" in liability)
        counts["transportAviation"] += int(
            any(term in text for term in ("交通工具", "航空", "民航", "驾乘", "自驾车", "列车", "轮船"))
        )
    product_type = compact_text((payload.get("productOverview") or {}).get("productType"))
    counts["group"] = int("团体" in product_type)
    return counts


def primary_stratum(signals: dict) -> str:
    core = sum(bool(signals[key]) for key in ("death", "disability", "medical", "allowance"))
    if signals["transportAviation"]:
        return "transport_aviation"
    if core >= 3:
        return "comprehensive_accident"
    if signals["allowance"]:
        return "accident_allowance"
    if signals["medical"]:
        return "accident_medical"
    if signals["group"]:
        return "group_accident"
    if signals["death"] or signals["disability"]:
        return "death_disability"
    return "other_accident"


def topology_result(payload: dict) -> dict:
    product_type = compact_text((payload.get("productOverview") or {}).get("productType"))
    evidence_text = compact_text(
        {
            "productType": product_type,
            "officialChecklist": payload.get("officialChecklist"),
            "responsibilities": payload.get("responsibilities"),
            "productRules": payload.get("productRules"),
        }
    )
    if "团体" in product_type:
        topology = "group"
        issues = []
        if not (MEMBER_ENTRY_RE.search(evidence_text) and MEMBER_EXIT_RE.search(evidence_text)):
            issues.append("group_member_eligibility_missing")
        if not PLAN_RE.search(evidence_text):
            issues.append("group_plan_tier_missing")
    elif RIDER_RE.search(evidence_text):
        topology = "rider"
        issues = []
        if not MAIN_DEP_RE.search(evidence_text):
            issues.append("rider_main_contract_dependency_missing")
        if not RIDER_LIFECYCLE_RE.search(evidence_text):
            issues.append("rider_effective_termination_linkage_missing")
        if not RIDER_AMOUNT_RE.search(evidence_text):
            issues.append("rider_insured_amount_reference_missing")
    else:
        topology = "standalone"
        issues = []
    return {
        "contractTopology": topology,
        "status": "pass" if not issues else "review",
        "issues": issues,
        "inferenceBasis": "approved structured productType and same-digest evidence only",
    }


def artifact_gate_issues(payload: dict) -> dict:
    responsibilities = payload.get("responsibilities") or []
    missing_evidence: list[str] = []
    formula_issues: list[str] = []
    pseudo_responsibilities: list[str] = []
    relationship_issues: list[str] = []
    for index, responsibility in enumerate(responsibilities):
        rid = compact_text(responsibility.get("responsibilityId")) or f"index:{index}"
        liability = compact_text(responsibility.get("liability"))
        excerpt = compact_text(
            responsibility.get("sourceExcerpt") or responsibility.get("evidenceSegments")
        )
        trigger = compact_text(responsibility.get("triggerCondition"))
        obligation = compact_text(responsibility.get("insurerObligation"))
        if PSEUDO_TITLE_RE.fullmatch(liability.strip()):
            pseudo_responsibilities.append(rid)
        if not excerpt or not trigger or not obligation:
            missing_evidence.append(rid)

        indicators = responsibility.get("indicators")
        quantitative = bool(
            re.search(r"\d|%|比例|金额|费用|免赔|津贴|日额|天|保险金额|给付", excerpt + obligation)
        )
        if not isinstance(indicators, list) or not indicators:
            if quantitative:
                formula_issues.append(f"{rid}:quantitative_indicator_missing")
        else:
            for indicator_index, indicator in enumerate(indicators):
                prefix = f"{rid}:indicator:{indicator_index}"
                if quantitative and not compact_text(indicator.get("formulaText")):
                    formula_issues.append(f"{prefix}:formula_text_missing")
                if quantitative and not compact_text(indicator.get("normalizedFormula")):
                    formula_issues.append(f"{prefix}:normalized_formula_missing")
                if quantitative and not isinstance(indicator.get("requiredInputs"), list):
                    formula_issues.append(f"{prefix}:required_inputs_missing")

        relation_text = " ".join((excerpt, obligation))
        if EXTRA_RE.search(relation_text) or REPLACEMENT_RE.search(relation_text):
            relationship = responsibility.get("benefitRelationship")
            parent = responsibility.get("parentResponsibilityId")
            if not isinstance(relationship, dict) and not parent:
                relationship_issues.append(f"{rid}:base_relationship_missing")
            elif isinstance(relationship, dict) and relationship.get("semantics") not in {
                "additive",
                "substitutive",
                "exclusive",
                "max_of",
                "capped_additive",
            }:
                relationship_issues.append(f"{rid}:relationship_semantics_missing")
    return {
        "evidenceIssues": missing_evidence,
        "formulaIssues": formula_issues,
        "pseudoResponsibilityIds": pseudo_responsibilities,
        "baseExtraRelationshipIssues": relationship_issues,
    }


def projection_rows(connection: sqlite3.Connection, company: str, product: str, digest: str) -> tuple[list[dict], list[dict]]:
    cards: list[dict] = []
    for row in connection.execute(
        "SELECT id,title,payload FROM product_responsibility_cards WHERE company=? AND product_name=?",
        (company, product),
    ):
        payload = json_load(row["payload"])
        nested = payload.get("indicators") or []
        matching = [
            item
            for item in nested
            if (item.get("sourceDigest") or item.get("responsibilitySourceDigest")) == digest
        ]
        if matching or payload.get("sourceDigest") == digest or payload.get("responsibilitySourceDigest") == digest:
            cards.append({"id": row["id"], "title": row["title"], "payload": payload, "matchingIndicators": matching})

    indicators: list[dict] = []
    for row in connection.execute(
        "SELECT id,liability,payload FROM insurance_indicator_records WHERE company=? AND product_name=?",
        (company, product),
    ):
        payload = json_load(row["payload"])
        if (payload.get("sourceDigest") or payload.get("responsibilitySourceDigest")) == digest:
            indicators.append({"id": row["id"], "liability": row["liability"], "payload": payload})
    return cards, indicators


def projection_gate(payload: dict, cards: list[dict], indicators: list[dict]) -> dict:
    artifact_ids = {
        compact_text(item.get("responsibilityId"))
        for item in payload.get("responsibilities") or []
        if compact_text(item.get("responsibilityId"))
    }
    card_ids: set[str] = set()
    pseudo_titles: list[str] = []
    customer_copy_issues: list[str] = []
    title_counts = Counter()
    for card in cards:
        card_payload = card["payload"]
        rid = compact_text(card_payload.get("responsibilityId"))
        if rid:
            card_ids.add(rid)
        for nested in card["matchingIndicators"]:
            nested_rid = compact_text(nested.get("responsibilityId"))
            if nested_rid:
                card_ids.add(nested_rid)
        title = compact_text(card.get("title") or card_payload.get("title")).strip()
        if title:
            title_counts[title] += 1
            if PSEUDO_TITLE_RE.fullmatch(title):
                pseudo_titles.append(title)
        customer_copy = compact_text(
            card_payload.get("plainSummary")
            or card_payload.get("customerSummary")
            or card_payload.get("payoutSummary")
        )
        if not customer_copy:
            customer_copy_issues.append(f"{card['id']}:customer_summary_missing")
        elif any(term in customer_copy for term in INTERNAL_COPY_TERMS):
            customer_copy_issues.append(f"{card['id']}:internal_copy_leak")

    indicator_ids = {
        compact_text(item["payload"].get("responsibilityId"))
        for item in indicators
        if compact_text(item["payload"].get("responsibilityId"))
    }
    duplicate_titles = sorted(title for title, count in title_counts.items() if count > 1)
    return {
        "artifactResponsibilityCount": len(artifact_ids),
        "sameDigestCardCount": len(cards),
        "sameDigestIndicatorCount": len(indicators),
        "missingCardResponsibilityIds": sorted(artifact_ids - card_ids),
        "missingIndicatorResponsibilityIds": sorted(artifact_ids - indicator_ids),
        "orphanCardResponsibilityIds": sorted(card_ids - artifact_ids),
        "orphanIndicatorResponsibilityIds": sorted(indicator_ids - artifact_ids),
        "pseudoCardTitles": sorted(set(pseudo_titles)),
        "duplicateCardTitles": duplicate_titles,
        "customerSummaryIssues": customer_copy_issues,
    }


def write_json(path: Path, value: object) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--minimum-samples", type=int, default=20)
    parser.add_argument("--maximum-samples", type=int, default=40)
    parser.add_argument("--importer", type=Path)
    args = parser.parse_args()

    db_path = args.db.resolve()
    if not db_path.is_file():
        raise SystemExit(f"database_not_found:{db_path}")
    if args.minimum_samples < 20:
        raise SystemExit("minimum_samples_must_be_at_least_20")
    args.output_dir.mkdir(parents=True, exist_ok=True)

    before = db_states(db_path)
    started_at = utc_now()
    connection = open_readonly(db_path)
    try:
        quick_check = connection.execute("PRAGMA quick_check").fetchone()[0]
        data_version = connection.execute("PRAGMA data_version").fetchone()[0]
        rows = connection.execute(
            """
            SELECT id,company,product_name,source_digest,source_url,published_at,payload
            FROM product_responsibility_artifacts
            WHERE json_extract(payload,'$.audit.status')='approved'
            """
        ).fetchall()

        funnel = Counter()
        funnel["approvedArtifactRows"] = len(rows)
        candidates_by_key: dict[str, list[dict]] = {}
        for row in rows:
            payload = json_load(row["payload"])
            source_digest = row["source_digest"]
            identity = payload.get("productIdentity") or {}
            if not (
                DIGEST_RE.fullmatch(str(source_digest or ""))
                and identity.get("sourceDigest") == source_digest
                and compact_text(row["source_url"]).startswith(("http://", "https://"))
            ):
                funnel["identityOrOfficialSourceRejected"] += 1
                continue
            is_candidate, candidate_meta = accident_candidate(payload)
            if not is_candidate:
                funnel["nonAccidentStructureRejected"] += 1
                continue
            funnel["accidentCandidateArtifactRows"] += 1
            item = {
                "artifactId": row["id"],
                "company": row["company"],
                "productName": row["product_name"],
                "sourceDigest": source_digest,
                "sourceUrl": row["source_url"],
                "publishedAt": row["published_at"],
                "payload": payload,
                **candidate_meta,
            }
            candidates_by_key.setdefault(exact_key(item), []).append(item)

        funnel["uniqueExactCandidateKeys"] = len(candidates_by_key)
        funnel["duplicateArtifactRowsWithinExactKeys"] = sum(
            max(0, len(items) - 1) for items in candidates_by_key.values()
        )
        eligible: list[dict] = []
        for items in candidates_by_key.values():
            items.sort(key=lambda item: (compact_text(item["publishedAt"]), item["artifactId"]), reverse=True)
            selected = items[0]
            cards, indicators = projection_rows(
                connection,
                selected["company"],
                selected["productName"],
                selected["sourceDigest"],
            )
            if not cards or not indicators:
                funnel["sameDigestProjectionRejected"] += 1
                continue
            selected["duplicateArtifactRowCount"] = len(items) - 1
            selected["cards"] = cards
            selected["indicators"] = indicators
            eligible.append(selected)
        funnel["eligibleExactKeys"] = len(eligible)

        eligible.sort(
            key=lambda item: (
                primary_stratum(signal_counts(item["payload"])),
                item["company"],
                item["productName"],
                item["sourceDigest"],
            )
        )
        if len(eligible) > args.maximum_samples:
            buckets: dict[str, dict[str, list[dict]]] = {}
            for item in eligible:
                stratum = primary_stratum(signal_counts(item["payload"]))
                buckets.setdefault(stratum, {}).setdefault(item["company"], []).append(item)
            selected_samples = []
            selected_by_company = Counter()
            while len(selected_samples) < args.maximum_samples:
                progressed = False
                for stratum in sorted(buckets):
                    companies = sorted(
                        buckets[stratum],
                        key=lambda company: (selected_by_company[company], company),
                    )
                    for company in companies:
                        company_bucket = buckets[stratum][company]
                        if not company_bucket:
                            continue
                        selected_samples.append(company_bucket.pop(0))
                        selected_by_company[company] += 1
                        progressed = True
                        break
                    if len(selected_samples) == args.maximum_samples:
                        break
                if not progressed:
                    break
            selection_method = "bounded primary-stratum and company round-robin"
        else:
            selected_samples = eligible
            selection_method = "full eligible exact-key cohort"

        if len(selected_samples) < args.minimum_samples:
            raise RuntimeError(
                f"insufficient_same_digest_samples:{len(selected_samples)}<{args.minimum_samples}"
            )

        manifest_rows = []
        forward_rows = []
        issue_counter = Counter()
        for item in selected_samples:
            payload = item["payload"]
            signals = signal_counts(payload)
            stratum = primary_stratum(signals)
            topology = topology_result(payload)
            artifact_gates = artifact_gate_issues(payload)
            projection = projection_gate(payload, item["cards"], item["indicators"])
            issues = []
            issues.extend(topology["issues"])
            for field in (
                "evidenceIssues",
                "formulaIssues",
                "pseudoResponsibilityIds",
                "baseExtraRelationshipIssues",
            ):
                issues.extend(f"{field}:{value}" for value in artifact_gates[field])
            for field in (
                "missingCardResponsibilityIds",
                "missingIndicatorResponsibilityIds",
                "orphanCardResponsibilityIds",
                "orphanIndicatorResponsibilityIds",
                "pseudoCardTitles",
                "duplicateCardTitles",
                "customerSummaryIssues",
            ):
                issues.extend(f"{field}:{value}" for value in projection[field])
            for issue in issues:
                issue_counter[issue.split(":", 1)[0]] += 1

            identity = {
                "company": item["company"],
                "productName": item["productName"],
                "sourceDigest": item["sourceDigest"],
            }
            manifest_rows.append(
                {
                    **identity,
                    "artifactId": item["artifactId"],
                    "sourceUrl": item["sourceUrl"],
                    "productType": item["productType"],
                    "primaryStratum": stratum,
                    "structureSignals": signals,
                    "contractTopology": topology["contractTopology"],
                    "responsibilityCount": item["responsibilityCount"],
                    "sameDigestCardCount": len(item["cards"]),
                    "sameDigestIndicatorCount": len(item["indicators"]),
                    "duplicateArtifactRowCount": item["duplicateArtifactRowCount"],
                }
            )
            forward_rows.append(
                {
                    **identity,
                    "primaryStratum": stratum,
                    "structureSignals": signals,
                    "topologyGate": topology,
                    "artifactGates": artifact_gates,
                    "projectionReadback": projection,
                    "storedArtifactAuditStatus": compact_text((payload.get("audit") or {}).get("status")),
                    "deterministicValidatorRerun": "not_run_no_same_digest_local_source_bytes_and_complete_text_path_in_sqlite_artifact_row",
                    "dedicatedImporterDryRun": "not_run_forward_test_is_read_only_and_does_not_materialize",
                    "result": "pass" if not issues else "review",
                    "issues": issues,
                }
            )

        importer_receipt = {
            "status": "not_run",
            "reason": "no importer path supplied",
        }
        artifact_export_path = args.output_dir / "forward-test-artifacts.json"
        write_json(artifact_export_path, [item["payload"] for item in selected_samples])
        if args.importer:
            importer_path = args.importer.resolve()
            node_path = shutil.which("node")
            if not importer_path.is_file():
                raise RuntimeError(f"importer_not_found:{importer_path}")
            if not node_path:
                raise RuntimeError("node_not_found")
            process = subprocess.run(
                [
                    node_path,
                    str(importer_path),
                    f"--artifacts={artifact_export_path}",
                    f"--sample-limit={len(selected_samples)}",
                ],
                cwd=str(importer_path.parent.parent),
                check=False,
                capture_output=True,
                text=True,
            )
            try:
                parsed_stdout = json.loads(process.stdout)
            except json.JSONDecodeError:
                parsed_stdout = None
            importer_receipt = {
                "status": "passed"
                if process.returncode == 0
                and isinstance(parsed_stdout, dict)
                and parsed_stdout.get("ok") is True
                and parsed_stdout.get("dryRun") is True
                and parsed_stdout.get("materializedProducts") == 0
                and parsed_stdout.get("materializedCards") == 0
                else "failed",
                "command": [
                    node_path,
                    str(importer_path),
                    f"--artifacts={artifact_export_path}",
                    f"--sample-limit={len(selected_samples)}",
                ],
                "exitCode": process.returncode,
                "stdout": parsed_stdout if parsed_stdout is not None else process.stdout,
                "stderr": process.stderr,
            }
            failures_by_product = {
                (
                    compact_text(failure.get("company")),
                    compact_text(failure.get("productName")),
                ): failure.get("issues") or []
                for failure in (parsed_stdout or {}).get("validationFailures", [])
            }
            for row in forward_rows:
                product_failures = failures_by_product.get(
                    (row["company"], row["productName"]), []
                )
                row["dedicatedImporterDryRun"] = (
                    "passed" if not product_failures else "failed"
                )
                if product_failures:
                    row["issues"].extend(
                        f"importerDryRun:{issue}" for issue in product_failures
                    )
                    row["result"] = "review"
            issue_counter["importerDryRun"] = sum(
                1
                for row in forward_rows
                if row["dedicatedImporterDryRun"] == "failed"
            )

        manifest = {
            "schemaVersion": "accident-skill-cohort-v1",
            "generatedAt": utc_now(),
            "databasePath": str(db_path),
            "identity": "exact company+productName+sourceDigest",
            "cohortDefinition": {
                "artifact": "audit.status=approved",
                "accidentClass": "approved productOverview.productType contains 意外, or every concrete liability explicitly contains 意外; productName is not used",
                "source": "table and payload digest equal; official source URL present",
                "projection": "at least one same-digest card nested indicator and same-digest indicator-table row",
            },
            "selectionMethod": selection_method,
            "mutuallyExclusive": True,
            "funnel": dict(funnel),
            "eligibleCohortCount": len(eligible),
            "sampleCount": len(manifest_rows),
            "samples": manifest_rows,
        }
        forward_test = {
            "schemaVersion": "accident-skill-forward-test-v1",
            "generatedAt": utc_now(),
            "sampleCount": len(forward_rows),
            "minimumRequired": args.minimum_samples,
            "mutuallyExclusiveExactKeys": len({exact_key(row) for row in forward_rows})
            == len(forward_rows),
            "results": forward_rows,
        }
        status_counts = Counter(row["result"] for row in forward_rows)
        stratum_counts = Counter(row["primaryStratum"] for row in forward_rows)
        topology_counts = Counter(row["topologyGate"]["contractTopology"] for row in forward_rows)
        company_counts = Counter(row["company"] for row in forward_rows)
        gate_totals = {
            "responsibilityOmissionCount": sum(
                len(row["projectionReadback"]["missingCardResponsibilityIds"])
                + len(row["projectionReadback"]["missingIndicatorResponsibilityIds"])
                for row in forward_rows
            ),
            "pseudoTitleCount": sum(
                len(row["artifactGates"]["pseudoResponsibilityIds"])
                + len(row["projectionReadback"]["pseudoCardTitles"])
                for row in forward_rows
            ),
            "baseExtraRelationshipIssueCount": sum(
                len(row["artifactGates"]["baseExtraRelationshipIssues"])
                for row in forward_rows
            ),
            "evidenceIssueCount": sum(
                len(row["artifactGates"]["evidenceIssues"]) for row in forward_rows
            ),
            "formulaIssueCount": sum(
                len(row["artifactGates"]["formulaIssues"]) for row in forward_rows
            ),
        }
        for family in (
            "evidenceIssues",
            "formulaIssues",
            "pseudoResponsibilityIds",
            "baseExtraRelationshipIssues",
            "missingCardResponsibilityIds",
            "missingIndicatorResponsibilityIds",
            "orphanCardResponsibilityIds",
            "orphanIndicatorResponsibilityIds",
            "pseudoCardTitles",
            "duplicateCardTitles",
            "customerSummaryIssues",
            "group_member_eligibility_missing",
            "group_plan_tier_missing",
            "rider_main_contract_dependency_missing",
            "rider_effective_termination_linkage_missing",
            "rider_insured_amount_reference_missing",
            "importerDryRun",
        ):
            issue_counter.setdefault(family, 0)
        audit = {
            "schemaVersion": "accident-skill-audit-v1",
            "startedAt": started_at,
            "completedAt": utc_now(),
            "databasePath": str(db_path),
            "readOnly": True,
            "queryOnly": True,
            "quickCheck": quick_check,
            "dataVersionAtSnapshot": data_version,
            "sampleCount": len(forward_rows),
            "resultCounts": dict(status_counts),
            "primaryStratumCounts": dict(stratum_counts),
            "contractTopologyCounts": dict(topology_counts),
            "companyCounts": dict(company_counts),
            "issueFamilyCounts": dict(issue_counter),
            "gateTotals": gate_totals,
            "countDefinitions": {
                "responsibilityOmissionCount": "missing artifact responsibility IDs across same-digest card and indicator projections; the same ID can contribute once to each projection",
                "pseudoTitleCount": "artifact responsibilities plus same-digest card titles matching the prohibited heading set",
                "baseExtraRelationshipIssueCount": "source-backed additive or replacement clauses lacking a structured base relationship or semantics",
                "evidenceIssueCount": "responsibilities missing trigger, insurer obligation, or exact excerpt/evidence segments",
                "formulaIssueCount": "quantitative responsibilities missing an indicator formula, normalized formula, or requiredInputs array",
            },
            "importerDryRun": importer_receipt,
            "storedApprovalIsNotValidatorRerun": True,
            "sqliteWrites": 0,
            "networkCalls": 0,
            "modelCalls": 0,
            "feishuWrites": 0,
            "publicationWrites": 0,
        }
        handoff = {
            "schemaVersion": "accident-skill-handoff-v1",
            "generatedAt": utc_now(),
            "items": [
                {
                    "company": row["company"],
                    "productName": row["productName"],
                    "sourceDigest": row["sourceDigest"],
                    "issues": row["issues"],
                }
                for row in forward_rows
                if row["issues"]
            ],
        }

        manifest_path = args.output_dir / "manifest.json"
        audit_path = args.output_dir / "audit.json"
        forward_path = args.output_dir / "forward-test.json"
        handoff_path = args.output_dir / "handoff.json"
        importer_path = args.output_dir / "importer-dry-run.json"
        write_json(manifest_path, manifest)
        write_json(forward_path, forward_test)
        write_json(handoff_path, handoff)
        write_json(importer_path, importer_receipt)
        after = db_states(db_path)
        audit["databaseFilesBefore"] = before
        audit["databaseFilesAfter"] = after
        audit["mainDatabaseFileUnchanged"] = before[0] == after[0]
        audit["sidecarStateMayChangeFromExternalWriter"] = before[1:] != after[1:]
        write_json(audit_path, audit)

        result = {
            "ok": True,
            "sampleCount": len(forward_rows),
            "resultCounts": dict(status_counts),
            "manifestPath": str(manifest_path.resolve()),
            "auditPath": str(audit_path.resolve()),
            "forwardTestPath": str(forward_path.resolve()),
            "handoffPath": str(handoff_path.resolve()),
            "artifactExportPath": str(artifact_export_path.resolve()),
            "importerDryRunPath": str(importer_path.resolve()),
            "sha256": {
                path.name: sha256_file(path)
                for path in (
                    manifest_path,
                    audit_path,
                    forward_path,
                    handoff_path,
                    artifact_export_path,
                    importer_path,
                )
            },
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    finally:
        connection.rollback()
        connection.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(
            json.dumps(
                {"ok": False, "error": f"{type(exc).__name__}:{exc}"},
                ensure_ascii=False,
            ),
            file=sys.stderr,
        )
        sys.exit(1)
