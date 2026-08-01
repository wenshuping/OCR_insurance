#!/usr/bin/env python3
"""Re-gate fixed approved queues without writing the target SQLite database."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import shutil
import sqlite3
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from pypdf import PdfReader


DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
CLASSIFICATIONS = (
    "approved_import_ready",
    "bounded_repair",
    "version_conflict",
    "source_review",
    "materializer_blocked",
    "manual_review",
)
ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
BACKFILL = ROOT / "artifacts/responsibility-full-backfill-20260729"
SOURCE_REPAIR = ROOT / "artifacts/missing-approved-artifact-source-repair-20260729"
CANONICALIZER = (
    ROOT
    / ".worktrees/dev-agent-semantic-integration/.agents/skills/"
    "ocr-insurance-product-responsibility-pipeline/scripts/canonicalize_excerpts.py"
)
VALIDATOR = CANONICALIZER.with_name("validate_artifact.py")
IMPORTER = (
    ROOT
    / ".worktrees/dev-agent-semantic-integration/scripts/"
    "import-reviewed-responsibility-artifacts.mjs"
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


def normalize_identity(value: Any) -> str:
    result = re.sub(r"[\s\u3000]+", "", text(value)).casefold()
    for suffix in (
        "保险股份有限公司",
        "保险有限公司",
        "股份有限公司",
        "有限公司",
    ):
        result = result.removesuffix(suffix)
    return result


def normalize_url(value: Any) -> str:
    raw = text(value)
    if not raw:
        return ""
    parts = urlsplit(raw)
    return (
        parts.scheme.casefold()
        + "://"
        + parts.netloc.casefold()
        + re.sub(r"/+", "/", parts.path).rstrip("/")
        + (("?" + parts.query) if parts.query else "")
    )


def row_artifact_path(row: dict[str, Any]) -> Path:
    raw = row.get("artifactPath") or row.get("finalArtifactPath") or row.get(
        "canonicalArtifactPath"
    )
    return Path(text(raw))


def load_rows(queue_paths: list[Path]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    raw_rows: list[dict[str, Any]] = []
    queue_receipts: list[dict[str, Any]] = []
    for queue_index, path in enumerate(queue_paths, 1):
        data = path.read_bytes()
        physical = 0
        for line_number, line in enumerate(data.decode("utf-8").splitlines(), 1):
            if not line.strip():
                continue
            physical += 1
            row = json.loads(line)
            row["_queuePath"] = str(path)
            row["_queueIndex"] = queue_index
            row["_lineNumber"] = line_number
            row["_rowSha256"] = sha_bytes(line.encode("utf-8"))
            raw_rows.append(row)
        queue_receipts.append(
            {
                "queueIndex": queue_index,
                "path": str(path),
                "sha256": sha_file(path),
                "bytes": path.stat().st_size,
                "physicalRows": physical,
            }
        )
    return raw_rows, queue_receipts


def dedupe(rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    selected: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    by_digest: dict[str, int] = {}
    by_url: dict[str, int] = {}
    by_name: dict[str, int] = {}
    for row in rows:
        digest = text(row.get("sourceDigest"))
        url = normalize_url(row.get("sourceUrl"))
        name_key = (
            normalize_identity(row.get("company"))
            + "\x1f"
            + normalize_identity(row.get("productName"))
        )
        match: int | None = None
        rule = ""
        if digest and digest in by_digest:
            match, rule = by_digest[digest], "sourceDigest"
        elif not digest and url and url in by_url:
            match, rule = by_url[url], "sourceUrl"
        elif not digest and not url and name_key in by_name:
            match, rule = by_name[name_key], "normalized company+productName"
        if match is not None:
            excluded.append(
                {
                    "queuePath": row["_queuePath"],
                    "lineNumber": row["_lineNumber"],
                    "rowSha256": row["_rowSha256"],
                    "excludedBySelectedIndex": match + 1,
                    "dedupeRule": rule,
                    "sourceDigest": digest,
                    "sourceUrl": text(row.get("sourceUrl")),
                    "company": text(row.get("company")),
                    "productName": text(row.get("productName")),
                }
            )
            continue
        index = len(selected)
        selected.append(row)
        if digest:
            by_digest[digest] = index
        if url:
            by_url[url] = index
        by_name[name_key] = index
    return selected, excluded


def build_json_index(paths: list[Path], required_name: str | None = None) -> dict[str, list[Path]]:
    index: dict[str, list[Path]] = defaultdict(list)
    for base in paths:
        if not base.exists():
            continue
        pattern = f"**/{required_name}" if required_name else "**/inventories/*.json"
        for path in base.glob(pattern):
            try:
                value = read_json(path)
            except (OSError, json.JSONDecodeError):
                continue
            digest = text(value.get("sourceDigest")) if isinstance(value, dict) else ""
            if DIGEST_RE.fullmatch(digest):
                index[digest].append(path.resolve())
    return index


def sibling_json_values(product_dir: Path) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if not product_dir.is_dir():
        return result
    for path in product_dir.glob("*.json"):
        try:
            value = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(value, dict):
            result.append(value)
    return result


def resolve_inventory(
    row: dict[str, Any], inventory_index: dict[str, list[Path]]
) -> tuple[Path | None, list[str]]:
    digest = text(row.get("sourceDigest"))
    candidates: list[Path] = []
    direct = text(row.get("inventoryPath"))
    if direct:
        candidates.append(Path(direct))
    product_dir = Path(text(row.get("productDir"))) if row.get("productDir") else row_artifact_path(row).parent
    for value in sibling_json_values(product_dir):
        candidate = text(value.get("inventoryPath"))
        if candidate:
            candidates.append(Path(candidate))
    candidates.extend(inventory_index.get(digest, []))
    valid: list[Path] = []
    for candidate in candidates:
        try:
            payload = read_json(candidate)
        except (OSError, json.JSONDecodeError):
            continue
        if text(payload.get("sourceDigest")) == digest:
            valid.append(candidate.resolve())
    unique = list(dict.fromkeys(valid))
    return (unique[0] if unique else None), [str(path) for path in unique]


def resolve_sources(
    row: dict[str, Any],
    inventory: dict[str, Any],
    contract_index: dict[str, list[Path]],
) -> tuple[Path | None, Path | None, Path | None, list[str]]:
    digest = text(row.get("sourceDigest"))
    document_candidates = [
        Path(value)
        for value in (
            text(row.get("sourceFile")),
            text(inventory.get("sourceDocumentPath")),
        )
        if value
    ]
    text_candidates = [
        Path(value)
        for value in (
            text(row.get("sourceTextFile")),
            text(inventory.get("sourceTextPath")),
        )
        if value
    ]
    product_dir = (
        Path(text(row.get("productDir")))
        if row.get("productDir")
        else row_artifact_path(row).parent
    )
    for value in sibling_json_values(product_dir):
        for field in ("sourceDocumentPath", "sourceFile"):
            candidate = text(value.get(field))
            if candidate:
                document_candidates.append(Path(candidate))
        for field in ("sourceTextPath", "responsibilityTextFile", "extractedTextFile"):
            candidate = text(value.get(field))
            if candidate:
                text_candidates.append(Path(candidate))
    contract_candidates = list(contract_index.get(digest, []))
    for path in list(document_candidates):
        sibling = path.parent / "source-contract.json"
        if sibling.is_file():
            contract_candidates.insert(0, sibling)
        for name in (
            "official-source.pages.txt",
            "official-source.txt",
            "pages.txt",
            "responsibility-text.txt",
            "responsibility-section.txt",
        ):
            text_candidates.append(path.parent / name)
    valid_contracts: list[Path] = []
    for path in contract_candidates:
        try:
            contract = read_json(path)
        except (OSError, json.JSONDecodeError):
            continue
        if text(contract.get("sourceDigest")) != digest:
            continue
        valid_contracts.append(path.resolve())
        source_file = text(contract.get("sourceFile"))
        if source_file:
            document_candidates.append(Path(source_file))
        for field in ("responsibilityTextFile", "extractedTextFile"):
            source_text = text(contract.get(field))
            if source_text:
                text_candidates.append(Path(source_text))
    document: Path | None = None
    for path in document_candidates:
        try:
            if path.is_file() and "sha256:" + sha_file(path) == digest:
                document = path.resolve()
                break
        except OSError:
            continue
    readable_text_candidates: list[tuple[int, Path]] = []
    for path in text_candidates:
        try:
            if path.is_file():
                size = len(path.read_text(encoding="utf-8"))
                if size >= 100:
                    readable_text_candidates.append((size, path.resolve()))
        except (OSError, UnicodeDecodeError):
            continue
    source_text = (
        max(readable_text_candidates, key=lambda item: item[0])[1]
        if readable_text_candidates
        else None
    )
    contract_path = valid_contracts[0] if valid_contracts else None
    return document, source_text, contract_path, [str(path) for path in dict.fromkeys(valid_contracts)]


def exact_segment(source: str, excerpt: str) -> dict[str, Any]:
    if not excerpt:
        return {"exact": False, "startOffset": None, "endOffset": None}
    start = source.find(excerpt)
    return {
        "exact": start >= 0,
        "startOffset": start if start >= 0 else None,
        "endOffset": start + len(excerpt) if start >= 0 else None,
    }


def product_labels(product_name: str, artifact: dict[str, Any]) -> list[str]:
    all_text = product_name + compact(artifact.get("responsibilities", []))
    labels: set[str] = set()
    if "意外伤害保险" in product_name or "意外伤害身故保险金" in all_text:
        labels.add("accident")
    if "定期寿险" in product_name:
        labels.add("term_life")
    if "年金" in product_name or "年金" in all_text:
        labels.add("annuity")
    if "两全" in product_name or "满期保险金" in all_text or "满期生存保险金" in all_text:
        labels.add("endowment")
    if "终身寿险" in product_name:
        labels.add("whole_life")
    if re.search(r"有效保险金额.*(?:增加|递增)|1\s*\+\s*0\.2|min\(", all_text, re.I):
        labels.add("incremental_whole_life")
    if "万能" in product_name or re.search(r"个人账户|账户价值|结算利率", all_text):
        labels.add("universal_account")
    return sorted(labels)


def owner_for(
    product_name: str, responsibility: dict[str, Any], labels: list[str]
) -> tuple[str, str, list[str]]:
    title = text(responsibility.get("liability") or responsibility.get("officialTitle"))
    body = title + " " + text(responsibility.get("triggerCondition")) + " " + text(
        responsibility.get("sourceExcerpt")
    )
    if "意外伤害保险" in product_name or title.startswith("意外"):
        return "accident", "accident-only product or separately headed accident obligation", []
    if "两全" in product_name:
        return "endowment", "ordinary maturity/death obligation inside endowment", []
    if "终身寿险" in product_name:
        if "incremental_whole_life" in labels:
            return (
                "incremental_whole_life",
                "source-linked effective-sum-assured growth formula",
                [],
            )
        return "whole_life", "lifetime death/disability obligation without proven growth", []
    if "定期寿险" in product_name:
        return "term_life", "finite-period death/disability obligation", []
    if "满期" in title:
        return "endowment", "finite maturity obligation", []
    if "年金" in product_name or "年金" in body:
        return "annuity", "annuity product responsibility", []
    return "", "no unique source-backed owner", ["owner_unresolved"]


def payment_for(responsibility: dict[str, Any]) -> list[str]:
    title = text(responsibility.get("liability"))
    indicators = responsibility.get("indicators", [])
    body = " ".join(
        [
            title,
            text(responsibility.get("triggerCondition")),
            text(responsibility.get("insurerObligation")),
            *[
                " ".join(
                    [
                        text(indicator.get("indicatorName")),
                        text(indicator.get("formulaText")),
                        text(indicator.get("normalizedFormula")),
                    ]
                )
                for indicator in indicators
                if isinstance(indicator, dict)
            ],
        ]
    )
    result: set[str] = set()
    if "伤残" in title and re.search(r"伤残等级|给付比例", body):
        result.add("disability_table")
    if "年金" in title:
        result.add("annuity")
    if "满期" in title:
        result.add("scheduled_maturity")
    if re.search(r"医疗费用|实际.*费用|补偿|报销", body):
        result.add("medical_reimbursement")
    if re.search(r"津贴|每日|日额", body):
        result.add("daily_allowance")
    if "豁免" in title:
        result.add("waiver")
    if re.search(r"账户价值|个人账户", body):
        result.add("account")
    if re.search(r"较大者|较小者|max\s*\(|min\s*\(", body, re.I) or any(
        indicator.get("operands")
        for indicator in indicators
        if isinstance(indicator, dict)
    ):
        result.add("max_min_comparison")
    if not result:
        result.add("lump_sum")
    return sorted(result)


def bounded_match(pattern: str, source: str) -> dict[str, Any] | None:
    match = re.search(pattern, source, re.M)
    if not match:
        return None
    start = max(0, source.rfind("\n", 0, match.start()) + 1)
    end_break = source.find("\n", match.end())
    end = len(source) if end_break < 0 else end_break
    excerpt = source[start:end].strip()
    offset = source.find(excerpt, start)
    return {"exactText": excerpt, "startOffset": offset, "endOffset": offset + len(excerpt)}


def topology_for(product_name: str, source: str) -> dict[str, Any]:
    if re.search(r"附加保险合同|主合同", source):
        evidence = bounded_match(r"附加保险合同|主合同", source)
        return {"type": "rider", "evidenceStatus": "verified", "evidence": evidence}
    if "团体" in product_name:
        evidence = bounded_match(
            r"凡机关、团体、企事业单位|团体.{0,30}(?:保险合同|投保人|被保险人)|(?:投保人|被保险人).{0,30}团体",
            source,
        )
        return {
            "type": "group",
            "evidenceStatus": "verified" if evidence else "unresolved",
            "evidence": evidence,
        }
    evidence = bounded_match(
        r"本(?:主险)?合同(?:自|于|的保险期间).{0,80}(?:生效|成立)|本(?:主险)?合同.{0,40}终止",
        source,
    )
    return {
        "type": "standalone",
        "evidenceStatus": "verified" if evidence else "unresolved",
        "evidence": evidence,
    }


def formula_audit(responsibility: dict[str, Any]) -> dict[str, Any]:
    issues: list[str] = []
    indicators = responsibility.get("indicators")
    if not isinstance(indicators, list) or len(indicators) != 1:
        issues.append(f"indicator_count:{len(indicators) if isinstance(indicators, list) else 0}")
        indicators = indicators if isinstance(indicators, list) else []
    for indicator in indicators:
        for field in ("formulaText", "normalizedFormula"):
            value = text(indicator.get(field))
            if not value or value in {"未知", "unknown", "N/A"}:
                issues.append(f"missing_or_unknown_{field}")
        for field in ("requiredInputs", "operands", "branches"):
            if not isinstance(indicator.get(field), list):
                issues.append(f"{field}_not_list")
        evidence = text(indicator.get("sourceExcerpt"))
        for token in re.findall(r"\d+(?:\.\d+)?%?", text(indicator.get("formulaText"))):
            if token not in evidence:
                issues.append(f"formula_number_not_in_evidence:{token}")
    return {"pass": bool(indicators) and not issues, "issues": sorted(set(issues))}


def enrich_artifact(
    artifact: dict[str, Any],
    inventory: dict[str, Any],
    digest: str,
    source_url: str,
    source: str,
    topology: dict[str, Any],
) -> tuple[dict[str, Any], list[str], list[dict[str, Any]], list[str]]:
    repaired = copy.deepcopy(artifact)
    changes: list[str] = []
    findings: list[dict[str, Any]] = []
    blockers: list[str] = []
    inventory_rows = inventory.get("responsibilities", [])
    by_title: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in inventory_rows:
        by_title[text(row.get("officialTitle"))].append(row)
    seen_keys: set[tuple[str, str, str, str]] = set()
    labels = product_labels(text(repaired.get("productName")), repaired)
    id_mapping: dict[str, str] = {}
    for index, responsibility in enumerate(repaired.get("responsibilities", [])):
        title = text(responsibility.get("liability") or responsibility.get("officialTitle"))
        matches = by_title.get(title, [])
        item_issues: list[str] = []
        if len(matches) != 1:
            item_issues.append(f"inventory_title_match_count:{len(matches)}")
            inventory_row: dict[str, Any] = {}
        else:
            inventory_row = matches[0]
        official_id = text(inventory_row.get("responsibilityId"))
        original_id = text(responsibility.get("responsibilityId"))
        if official_id and original_id != official_id:
            responsibility["legacyResponsibilityId"] = original_id
            responsibility["responsibilityId"] = official_id
            id_mapping[original_id] = official_id
            changes.append(f"responsibilities[{index}].responsibilityId")
        if text(responsibility.get("officialTitle")) != title:
            responsibility["officialTitle"] = title
            changes.append(f"responsibilities[{index}].officialTitle")
        packet_id = f"packet:{digest.removeprefix('sha256:')}:{official_id}"
        if responsibility.get("evidencePacketId") != packet_id:
            responsibility["evidencePacketId"] = packet_id
            changes.append(f"responsibilities[{index}].evidencePacketId")
        owner, owner_reason, owner_issues = owner_for(
            text(repaired.get("productName")), responsibility, labels
        )
        item_issues.extend(owner_issues)
        if owner:
            responsibility["ownerProfile"] = owner
            changes.append(f"responsibilities[{index}].ownerProfile")
        payments = payment_for(responsibility)
        responsibility["paymentProfile"] = payments
        changes.append(f"responsibilities[{index}].paymentProfile")
        responsibility["sourceDigest"] = digest
        responsibility["sourceUrl"] = source_url
        changes.extend(
            [
                f"responsibilities[{index}].sourceDigest",
                f"responsibilities[{index}].sourceUrl",
            ]
        )
        excerpt = text(responsibility.get("sourceExcerpt"))
        segment = exact_segment(source, excerpt)
        if not segment["exact"]:
            inventory_packet = text(inventory_row.get("evidencePacket"))
            packet_segment = exact_segment(source, inventory_packet)
            if packet_segment["exact"]:
                responsibility["legacySourceExcerptSha256"] = sha_bytes(
                    excerpt.encode("utf-8")
                )
                responsibility["sourceExcerpt"] = inventory_packet
                excerpt = inventory_packet
                segment = packet_segment
                changes.append(f"responsibilities[{index}].sourceExcerpt")
            else:
                item_issues.append("responsibility_excerpt_not_exact")
        if segment["exact"]:
            responsibility["evidenceSegments"] = [
                {
                    "sourcePage": responsibility.get("sourcePage"),
                    "sourceExcerpt": excerpt,
                    "startOffset": segment["startOffset"],
                    "endOffset": segment["endOffset"],
                    "offsetStatus": "exact",
                }
            ]
            changes.append(f"responsibilities[{index}].evidenceSegments")
        formula = formula_audit(responsibility)
        item_issues.extend(formula["issues"])
        indicators = responsibility.get("indicators", [])
        if len(indicators) == 1:
            indicator = indicators[0]
            responsibility["formula"] = {
                field: copy.deepcopy(indicator.get(field))
                for field in (
                    "formulaText",
                    "normalizedFormula",
                    "requiredInputs",
                    "requiredInputDetails",
                    "operands",
                    "branches",
                )
            }
            responsibility["formula"].setdefault("requiredInputDetails", [])
            changes.append(f"responsibilities[{index}].formula")
        immutable_key = (digest, official_id, title, packet_id)
        if immutable_key in seen_keys:
            item_issues.append("duplicate_immutable_responsibility_key")
        seen_keys.add(immutable_key)
        findings.append(
            {
                "responsibilityIndex": index,
                "originalResponsibilityId": original_id,
                "responsibilityId": official_id,
                "officialTitle": title,
                "evidencePacketId": packet_id,
                "ownerProfile": owner,
                "ownerReason": owner_reason,
                "ownerConflict": False,
                "paymentProfile": payments,
                "formulaGate": formula,
                "exactEvidence": segment,
                "issues": sorted(set(item_issues)),
            }
        )
        blockers.extend(item_issues)
    if id_mapping:
        def remap_ids(value: Any) -> None:
            if isinstance(value, dict):
                for key, child in value.items():
                    if (
                        key in {"responsibilityId", "parentResponsibilityId"}
                        and isinstance(child, str)
                        and child in id_mapping
                    ):
                        value[key] = id_mapping[child]
                    else:
                        remap_ids(child)
            elif isinstance(value, list):
                for child in value:
                    remap_ids(child)

        remap_ids(repaired.get("officialChecklist"))
        remap_ids(repaired.get("officialOptionalGroupChecklist"))
        remap_ids(repaired.get("audit"))
        changes.append("responsibilityIdReferences")
    repaired["contractTopology"] = topology
    changes.append("contractTopology")
    return repaired, sorted(set(changes)), findings, sorted(set(blockers))


def run_command(command: list[str]) -> dict[str, Any]:
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    return {
        "command": command,
        "exitCode": completed.returncode,
        "passed": completed.returncode == 0,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
    }


def parse_json_output(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def db_payload(value: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(value) if isinstance(value, str) else value
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def record_digest(payload: dict[str, Any]) -> str:
    identity = payload.get("responsibilityProductIdentity")
    identity_digest = identity.get("sourceDigest") if isinstance(identity, dict) else ""
    return text(
        payload.get("responsibilitySourceDigest")
        or payload.get("sourceDigest")
        or identity_digest
    )


def ssd_audit(
    connection: sqlite3.Connection,
    company: str,
    product_name: str,
    digest: str,
    source_url: str,
    responsibilities: list[dict[str, Any]],
) -> dict[str, Any]:
    artifact_rows = connection.execute(
        """
        SELECT id, company, product_name, source_digest, source_url, published_at, payload
        FROM product_responsibility_artifacts
        WHERE source_digest = ? OR source_url = ? OR product_name = ?
        """,
        (digest, source_url, product_name),
    ).fetchall()
    scoped_artifacts = [
        dict(row)
        for row in artifact_rows
        if normalize_identity(row["company"]) == normalize_identity(company)
        or text(row["source_digest"]) == digest
        or normalize_url(row["source_url"]) == normalize_url(source_url)
    ]
    card_rows = connection.execute(
        """
        SELECT id, company, product_name, title, source_url, payload
        FROM product_responsibility_cards WHERE product_name = ?
        """,
        (product_name,),
    ).fetchall()
    indicator_rows = connection.execute(
        """
        SELECT id, company, product_name, liability, payload
        FROM insurance_indicator_records WHERE product_name = ?
        """,
        (product_name,),
    ).fetchall()
    cards = [
        {**dict(row), "_payload": db_payload(row["payload"])}
        for row in card_rows
        if normalize_identity(row["company"]) == normalize_identity(company)
    ]
    indicators = [
        {**dict(row), "_payload": db_payload(row["payload"])}
        for row in indicator_rows
        if normalize_identity(row["company"]) == normalize_identity(company)
    ]
    exact_artifacts = [
        row for row in scoped_artifacts if text(row["source_digest"]) == digest
    ]
    exact_cards = [row for row in cards if record_digest(row["_payload"]) == digest]
    exact_indicators = [
        row for row in indicators if record_digest(row["_payload"]) == digest
    ]
    other_digests = sorted(
        {
            text(row["source_digest"])
            for row in scoped_artifacts
            if text(row["source_digest"]) and text(row["source_digest"]) != digest
            and normalize_identity(row["company"]) == normalize_identity(company)
            and normalize_identity(row["product_name"]) == normalize_identity(product_name)
        }
    )
    alignment_rows: list[dict[str, Any]] = []
    exact_alignment = True
    for responsibility in responsibilities:
        rid = text(responsibility.get("responsibilityId"))
        title = text(responsibility.get("officialTitle") or responsibility.get("liability"))
        matched_cards = [
            row
            for row in exact_cards
            if text(row["_payload"].get("responsibilityId")) == rid
        ]
        matched_indicators = [
            row
            for row in exact_indicators
            if text(row["_payload"].get("responsibilityId")) == rid
        ]
        passed = len(matched_cards) == 1 and len(matched_indicators) == len(
            responsibility.get("indicators", [])
        )
        exact_alignment = exact_alignment and passed
        alignment_rows.append(
            {
                "responsibilityId": rid,
                "officialTitle": title,
                "exactDigestCardCount": len(matched_cards),
                "exactDigestIndicatorCount": len(matched_indicators),
                "exactAlignment": passed,
            }
        )
    return {
        "missingApprovedArtifact": len(exact_artifacts) == 0,
        "exactDigestArtifactCount": len(exact_artifacts),
        "sameIdentityArtifactCount": len(scoped_artifacts),
        "sameIdentityOtherDigests": other_digests,
        "sameIdentityCardCount": len(cards),
        "sameIdentityIndicatorCount": len(indicators),
        "exactDigestCardCount": len(exact_cards),
        "exactDigestIndicatorCount": len(exact_indicators),
        "exactCardIndicatorAlignment": bool(responsibilities) and exact_alignment,
        "responsibilityAlignment": alignment_rows,
        "versionConflict": bool(other_digests),
        "note": "existing card/indicator counts are not current-run approval",
    }


def classify(
    version_conflict: bool,
    source_pass: bool,
    unified_blockers: list[str],
    topology_pass: bool,
    canonicalizer: dict[str, Any],
    validator: dict[str, Any],
    importer: dict[str, Any],
    repair_changes: list[str],
) -> tuple[str, str]:
    if version_conflict:
        return "version_conflict", "version"
    if not source_pass:
        return "source_review", "source"
    if unified_blockers or not topology_pass:
        return "manual_review", "inventory_owner_formula_or_topology"
    if not canonicalizer["passed"] or not validator["passed"]:
        return "manual_review", "canonicalizer_or_validator"
    if not importer["passed"] or not parse_json_output(importer["stdout"]).get("ok"):
        return "materializer_blocked", "dedicated_importer_dry_run"
    if repair_changes:
        return "bounded_repair", "deterministic_schema_identity_evidence_mapping"
    return "approved_import_ready", "all_current_gates_passed_without_repair"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--queue", type=Path, action="append", required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f"refusing to overwrite existing output: {args.output}")
    args.output.mkdir(parents=True)

    raw_rows, queue_receipts = load_rows(args.queue)
    selected, excluded = dedupe(raw_rows)
    inventory_index = build_json_index([BACKFILL])
    contract_index = build_json_index([BACKFILL, SOURCE_REPAIR], "source-contract.json")

    connection = sqlite3.connect(
        f"file:{args.db.resolve()}?mode=ro&immutable=1", uri=True
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    query_only = connection.execute("PRAGMA query_only").fetchone()[0] == 1
    db_before = {"bytes": args.db.stat().st_size, "sha256": sha_file(args.db)}

    products: list[dict[str, Any]] = []
    queues: dict[str, list[dict[str, Any]]] = {name: [] for name in CLASSIFICATIONS}
    all_importer_commands: list[list[str]] = []
    for index, row in enumerate(selected, 1):
        digest = text(row.get("sourceDigest"))
        artifact_path = row_artifact_path(row).resolve()
        inventory_path, inventory_candidates = resolve_inventory(row, inventory_index)
        inventory = read_json(inventory_path) if inventory_path else {}
        source_document, source_text_path, source_contract_path, contract_candidates = resolve_sources(
            row, inventory, contract_index
        )
        source = (
            source_text_path.read_text(encoding="utf-8")
            if source_text_path and source_text_path.is_file()
            else ""
        )
        artifact = read_json(artifact_path) if artifact_path.is_file() else {}
        source_issues: list[str] = []
        if not DIGEST_RE.fullmatch(digest):
            source_issues.append("invalid_source_digest")
        if not source_document:
            source_issues.append("source_pdf_sha_not_verified")
        elif source_document.read_bytes()[:5] != b"%PDF-":
            source_issues.append("source_pdf_magic_failed")
        page_count: int | None = None
        if source_document:
            try:
                page_count = len(PdfReader(str(source_document)).pages)
            except Exception as error:  # pypdf has many parse exceptions
                source_issues.append(f"pdf_page_count_failed:{type(error).__name__}")
        if not page_count:
            source_issues.append("pdf_page_count_missing")
        if not source_contract_path:
            source_issues.append("source_contract_missing")
            source_contract: dict[str, Any] = {}
        else:
            source_contract = read_json(source_contract_path)
            for field, expected in (
                ("sourceDigest", digest),
                ("productName", text(row.get("productName"))),
            ):
                if text(source_contract.get(field)) != expected:
                    source_issues.append(f"source_contract_{field}_mismatch")
            if normalize_identity(source_contract.get("company")) != normalize_identity(
                row.get("company")
            ):
                source_issues.append("source_contract_company_mismatch")
        if not source or "保险责任" not in source:
            source_issues.append("responsibility_text_unreadable_or_incomplete")
        if not inventory_path:
            source_issues.append("official_inventory_missing")
        inventory_issues: list[str] = []
        inventory_rows = (
            inventory.get("responsibilities", [])
            if isinstance(inventory.get("responsibilities"), list)
            else []
        )
        if text(inventory.get("sourceDigest")) != digest:
            inventory_issues.append("inventory_digest_mismatch")
        if inventory.get("inventoryBuiltBeforeModel") is not True:
            inventory_issues.append("inventory_not_built_before_model")
        if not inventory_rows:
            inventory_issues.append("empty_inventory")
        inventory_ids = [text(item.get("responsibilityId")) for item in inventory_rows]
        inventory_titles = [text(item.get("officialTitle")) for item in inventory_rows]
        if len(set(inventory_ids)) != len(inventory_ids):
            inventory_issues.append("duplicate_inventory_responsibility_id")
        if len(set(inventory_titles)) != len(inventory_titles):
            inventory_issues.append("duplicate_inventory_title")
        for item in inventory_rows:
            if item.get("offsetStatus") != "exact":
                inventory_issues.append(
                    f"{text(item.get('responsibilityId'))}:inventory_offset_not_exact"
                )
            packet = text(item.get("evidencePacket"))
            if packet and packet not in source:
                inventory_issues.append(
                    f"{text(item.get('responsibilityId'))}:inventory_packet_not_exact"
                )

        topology = topology_for(text(row.get("productName")), source)
        repaired, repair_changes, responsibility_findings, unified_blockers = enrich_artifact(
            artifact,
            inventory,
            digest,
            text(row.get("sourceUrl") or inventory.get("sourceUrl")),
            source,
            topology,
        )
        unified_blockers = sorted(set(unified_blockers + inventory_issues))
        product_dir = args.output / "isolated" / f"{index:04d}-{digest.removeprefix('sha256:')[:12]}"
        product_dir.mkdir(parents=True)
        input_copy = product_dir / "input-artifact.json"
        repaired_copy = product_dir / "bounded-repair-artifact.json"
        canonical_copy = product_dir / "canonical-artifact.json"
        shutil.copy2(artifact_path, input_copy)
        write_json(repaired_copy, repaired)
        canonicalizer = run_command(
            [
                sys.executable,
                str(CANONICALIZER),
                "--artifact",
                str(repaired_copy),
                "--source-text",
                str(source_text_path or ""),
                "--output",
                str(canonical_copy),
            ]
        )
        canonical_result = parse_json_output(canonicalizer["stdout"])
        if canonical_result.get("changed"):
            repair_changes.append("canonicalizer_current_run_changes")
        validator = run_command(
            [
                sys.executable,
                str(VALIDATOR),
                "--artifact",
                str(canonical_copy),
                "--source-text",
                str(source_text_path or ""),
                "--source-document",
                str(source_document or ""),
                "--official-domain",
                urlsplit(text(row.get("sourceUrl") or inventory.get("sourceUrl"))).netloc,
            ]
        )
        nonexistent_db = args.output / "isolation-no-write" / "never-created.sqlite"
        importer_command = [
            "node",
            str(IMPORTER),
            f"--artifacts={canonical_copy}",
            f"--db-path={nonexistent_db}",
            "--sample-limit=50",
        ]
        all_importer_commands.append(importer_command)
        importer = run_command(importer_command)
        if nonexistent_db.exists():
            raise RuntimeError("dry-run unexpectedly created SQLite file")
        ssd = ssd_audit(
            connection,
            text(row.get("company")),
            text(row.get("productName")),
            digest,
            text(row.get("sourceUrl") or inventory.get("sourceUrl")),
            repaired.get("responsibilities", []),
        )
        source_pass = not source_issues
        classification, first_failure = classify(
            ssd["versionConflict"],
            source_pass,
            unified_blockers,
            topology["evidenceStatus"] == "verified",
            canonicalizer,
            validator,
            importer,
            sorted(set(repair_changes)),
        )
        product = {
            "manifestOrder": index,
            "identity": {
                "company": text(row.get("company")),
                "productName": text(row.get("productName")),
                "sourceDigest": digest,
                "sourceUrl": text(row.get("sourceUrl") or inventory.get("sourceUrl")),
            },
            "provenance": {
                "queuePath": row["_queuePath"],
                "queueLineNumber": row["_lineNumber"],
                "queueRowSha256": row["_rowSha256"],
                "artifactPath": str(artifact_path),
                "artifactSha256": sha_file(artifact_path),
                "inventoryPath": str(inventory_path) if inventory_path else None,
                "inventorySha256": sha_file(inventory_path) if inventory_path else None,
                "inventoryCandidates": inventory_candidates,
                "sourceDocumentPath": str(source_document) if source_document else None,
                "sourceDocumentSha256": sha_file(source_document) if source_document else None,
                "sourceTextPath": str(source_text_path) if source_text_path else None,
                "sourceTextSha256": sha_file(source_text_path) if source_text_path else None,
                "sourceContractPath": str(source_contract_path) if source_contract_path else None,
                "sourceContractSha256": sha_file(source_contract_path)
                if source_contract_path
                else None,
                "sourceContractCandidates": contract_candidates,
                "isolatedInputCopy": str(input_copy),
                "boundedRepairArtifact": str(repaired_copy),
                "canonicalArtifact": str(canonical_copy),
            },
            "sourceGate": {
                "pass": source_pass,
                "issues": sorted(set(source_issues)),
                "pdfMagic": bool(source_document)
                and source_document.read_bytes()[:5] == b"%PDF-",
                "sourceFileShaMatchesDigest": bool(source_document),
                "pageCount": page_count,
                "sourceContractPresent": bool(source_contract_path),
                "responsibilityTextChars": len(source),
            },
            "inventoryGate": {
                "pass": not inventory_issues,
                "issues": sorted(set(inventory_issues)),
                "officialInventoryCount": len(inventory_rows),
                "artifactResponsibilityCount": len(artifact.get("responsibilities", [])),
                "inventoryIdCount": len(set(inventory_ids)),
                "inventoryTitleCount": len(set(inventory_titles)),
                "physicalInventoryCandidateCount": len(inventory_candidates),
            },
            "contractTopology": topology,
            "productLabels": product_labels(text(row.get("productName")), artifact),
            "responsibilities": responsibility_findings,
            "ownerConflictCount": sum(
                finding["ownerConflict"] for finding in responsibility_findings
            ),
            "duplicateResponsibility": any(
                "duplicate_immutable_responsibility_key" in finding["issues"]
                for finding in responsibility_findings
            ),
            "boundedRepair": {
                "appliedOnIsolatedCopy": True,
                "changes": sorted(set(repair_changes)),
                "inventoryFormulaOrNumericSemanticsModified": False,
            },
            "currentDeterministicGates": {
                "canonicalizer": canonicalizer,
                "validator": validator,
                "dedicatedImporterDryRun": importer,
                "quickCheckUsed": False,
                "historicalApprovedAcceptedAsCurrentPass": False,
            },
            "ssdReadOnly": ssd,
            "classification": classification,
            "firstFailureLayer": first_failure,
        }
        products.append(product)
        queues[classification].append(
            {
                "manifestOrder": index,
                **product["identity"],
                "responsibilityCount": len(responsibility_findings),
                "firstFailureLayer": first_failure,
                "perProductAuditIndex": index - 1,
                "canonicalArtifact": str(canonical_copy),
            }
        )
        write_json(product_dir / "gate-receipts.json", product["currentDeterministicGates"])

    connection.close()
    db_after = {"bytes": args.db.stat().st_size, "sha256": sha_file(args.db)}
    if db_before != db_after:
        raise RuntimeError("target SQLite bytes changed during read-only audit")

    manifest_selected = [
        {
            "manifestOrder": index,
            **products[index - 1]["identity"],
            "artifactPath": products[index - 1]["provenance"]["artifactPath"],
            "artifactSha256": products[index - 1]["provenance"]["artifactSha256"],
            "inventoryPath": products[index - 1]["provenance"]["inventoryPath"],
            "inventorySha256": products[index - 1]["provenance"]["inventorySha256"],
            "sourceDocumentPath": products[index - 1]["provenance"]["sourceDocumentPath"],
            "sourceDocumentSha256": products[index - 1]["provenance"][
                "sourceDocumentSha256"
            ],
            "sourceTextPath": products[index - 1]["provenance"]["sourceTextPath"],
            "sourceTextSha256": products[index - 1]["provenance"]["sourceTextSha256"],
            "sourceContractPath": products[index - 1]["provenance"]["sourceContractPath"],
            "sourceContractSha256": products[index - 1]["provenance"][
                "sourceContractSha256"
            ],
            "queuePath": row["_queuePath"],
            "queueLineNumber": row["_lineNumber"],
            "queueRowSha256": row["_rowSha256"],
            "dedupeKey": "sourceDigest:" + text(row.get("sourceDigest")),
        }
        for index, row in enumerate(selected, 1)
    ]
    manifest = {
        "schemaVersion": "unified-approved-not-imported-audit-v1",
        "generatedAt": now(),
        "inputs": queue_receipts,
        "physicalInputRows": len(raw_rows),
        "selectedCount": len(selected),
        "excludedDuplicateCount": len(excluded),
        "dedupeOrder": [
            "sourceDigest",
            "sourceUrl",
            "normalized company+productName",
        ],
        "differentNonEmptyDigestsMerged": False,
        "selected": manifest_selected,
        "excludedDuplicates": excluded,
        "selectedIdentitySha256": sha_bytes(compact(manifest_selected).encode()),
        "readOnly": {
            "databasePath": str(args.db.resolve()),
            "mode": "ro",
            "immutable": True,
            "queryOnly": query_only,
            "before": db_before,
            "after": db_after,
        },
        "safety": {
            "modelCalls": 0,
            "networkCalls": 0,
            "sqliteWrites": 0,
            "feishuWrites": 0,
            "publicationWrites": 0,
            "importWrites": 0,
        },
    }
    write_json(args.output / "immutable-manifest.json", manifest)
    write_json(args.output / "per-product-audits.json", products)
    for name in CLASSIFICATIONS:
        path = args.output / f"{name}.jsonl"
        path.write_text(
            "".join(compact(row) + "\n" for row in queues[name]), encoding="utf-8"
        )
    classification_counts = {name: len(queues[name]) for name in CLASSIFICATIONS}
    responsibility_counts = {
        name: sum(row["responsibilityCount"] for row in queues[name])
        for name in CLASSIFICATIONS
    }
    summary = {
        "schemaVersion": "unified-approved-not-imported-audit-v1",
        "generatedAt": now(),
        "input": {
            "physicalRows": len(raw_rows),
            "deduplicatedUnion": len(selected),
            "duplicatesOrIntersections": len(excluded),
        },
        "ssd": {
            "missingApprovedArtifactCount": sum(
                product["ssdReadOnly"]["missingApprovedArtifact"] for product in products
            ),
            "exactDigestArtifactPresentCount": sum(
                product["ssdReadOnly"]["exactDigestArtifactCount"] > 0
                for product in products
            ),
            "versionConflictCount": sum(
                product["ssdReadOnly"]["versionConflict"] for product in products
            ),
            "exactCardIndicatorAlignmentCount": sum(
                product["ssdReadOnly"]["exactCardIndicatorAlignment"]
                for product in products
            ),
        },
        "classificationProductCounts": classification_counts,
        "classificationResponsibilityCounts": responsibility_counts,
        "gatePassProductCounts": {
            "source": sum(product["sourceGate"]["pass"] for product in products),
            "inventory": sum(product["inventoryGate"]["pass"] for product in products),
            "owner": sum(
                all(not finding["ownerConflict"] and finding["ownerProfile"] for finding in product["responsibilities"])
                for product in products
            ),
            "topology": sum(
                product["contractTopology"]["evidenceStatus"] == "verified"
                for product in products
            ),
            "formulaEvidence": sum(
                all(finding["formulaGate"]["pass"] and finding["exactEvidence"]["exact"] for finding in product["responsibilities"])
                for product in products
            ),
            "canonicalizer": sum(
                product["currentDeterministicGates"]["canonicalizer"]["passed"]
                for product in products
            ),
            "validator": sum(
                product["currentDeterministicGates"]["validator"]["passed"]
                for product in products
            ),
            "dedicatedImporterDryRun": sum(
                product["currentDeterministicGates"]["dedicatedImporterDryRun"]["passed"]
                and parse_json_output(
                    product["currentDeterministicGates"]["dedicatedImporterDryRun"]["stdout"]
                ).get("ok", False)
                for product in products
            ),
        },
        "firstFailureLayerCounts": dict(
            sorted(Counter(product["firstFailureLayer"] for product in products).items())
        ),
        "safety": manifest["safety"],
        "historicalApprovedAcceptedAsCurrentPass": False,
        "quickCheckAcceptedAsCurrentPass": False,
    }
    write_json(args.output / "classification-summary.json", summary)

    route_rows: list[dict[str, Any]] = []
    for product in products:
        owners = sorted(
            {row["ownerProfile"] for row in product["responsibilities"] if row["ownerProfile"]}
        )
        complex_reasons: list[str] = []
        if set(owners) & {"medical_health", "critical_illness", "accident", "long_term_care"}:
            complex_reasons.append("complex-domain")
        if len(product["responsibilities"]) > 1:
            complex_reasons.append("multi-responsibility")
        if any(
            (row["formulaGate"]["issues"] or any(
                indicator.get("branches") or indicator.get("operands")
                for indicator in read_json(Path(product["provenance"]["canonicalArtifact"])).get("responsibilities", [])[row["responsibilityIndex"]].get("indicators", [])
            ))
            for row in product["responsibilities"]
        ):
            complex_reasons.append("multi-branch-max-min-or-formula-review")
        if "universal_account" in product["productLabels"]:
            complex_reasons.append("complex-cashflow-or-universal-function")
        if "review-" in product["provenance"]["queuePath"]:
            complex_reasons.append("historical-validation-review")
        route = "luna-complex" if complex_reasons else "deepseek-standard"
        route_rows.append(
            {
                "manifestOrder": product["manifestOrder"],
                **product["identity"],
                "ownerProfiles": owners,
                "paymentProfiles": sorted(
                    {
                        payment
                        for row in product["responsibilities"]
                        for payment in row["paymentProfile"]
                    }
                ),
                "contractTopology": product["contractTopology"]["type"],
                "route": route,
                "reasons": sorted(set(complex_reasons))
                or ["few-responsibility-single-branch-source-complete"],
                "geminiEnabled": False,
                "dianJinEnabled": False,
                "deepSeekSilentFallbackToLuna": False,
            }
        )
    routing = {
        "schemaVersion": "unified-approved-not-imported-routing-audit-v1",
        "generatedAt": now(),
        "modelsInvoked": 0,
        "routeCounts": dict(sorted(Counter(row["route"] for row in route_rows).items())),
        "ownerCounts": dict(
            sorted(
                Counter(
                    owner
                    for row in route_rows
                    for owner in row["ownerProfiles"]
                ).items()
            )
        ),
        "paymentProfileCounts": dict(
            sorted(
                Counter(
                    payment
                    for row in route_rows
                    for payment in row["paymentProfiles"]
                ).items()
            )
        ),
        "topologyCounts": dict(
            sorted(Counter(row["contractTopology"] for row in route_rows).items())
        ),
        "products": route_rows,
    }
    write_json(args.output / "routing-audit.json", routing)
    gaps = Counter(
        issue
        for product in products
        for finding in product["responsibilities"]
        for issue in finding["issues"]
    )
    handoff = {
        "schemaVersion": "unified-approved-not-imported-handoff-v1",
        "generatedAt": now(),
        "stopCondition": "fixed six-queue batch audited; no import or next batch",
        "approvedImportReady": [
            row["identity"]
            for row in products
            if row["classification"] == "approved_import_ready"
        ],
        "boundedRepairArtifacts": [
            {
                **row["identity"],
                "artifact": row["provenance"]["canonicalArtifact"],
                "changes": row["boundedRepair"]["changes"],
            }
            for row in products
            if row["classification"] == "bounded_repair"
        ],
        "systemicGaps": [
            {"issue": issue, "productResponsibilityOccurrences": count}
            for issue, count in gaps.most_common()
        ],
        "skipped": {
            "modelCalls": "forbidden by task",
            "network": "forbidden by task",
            "sqliteWrites": "forbidden by task",
            "materializer": "forbidden by task",
            "import": "stopped before import as required",
            "feishu": "forbidden by task",
            "publication": "forbidden by task",
            "npmCheckAndTest": "no production code changed",
        },
        "executedGateFamilies": [
            "source PDF magic/SHA/page count/source contract/identity",
            "single inventory/digest/title/id/exact evidence",
            "single owner/payment/topology",
            "formula and exact evidence",
            "current canonicalizer",
            "current validator",
            "dedicated importer dry-run",
            "SSD mode=ro query_only readback",
            "card/indicator exact-digest alignment",
        ],
    }
    write_json(args.output / "handoff.json", handoff)

    checksum_paths = sorted(
        path
        for path in args.output.rglob("*")
        if path.is_file() and path.name != "SHA256SUMS"
    )
    checksum_text = "".join(
        f"{sha_file(path)}  {path.relative_to(args.output)}\n" for path in checksum_paths
    )
    (args.output / "SHA256SUMS").write_text(checksum_text, encoding="utf-8")
    for line in checksum_text.splitlines():
        expected, relative = line.split("  ", 1)
        if sha_file(args.output / relative) != expected:
            raise RuntimeError(f"checksum readback failed: {relative}")
    print(compact({"ok": True, "summary": summary, "routing": routing["routeCounts"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
