#!/usr/bin/env python3
"""Batch responsibility parsing with a replaceable model and deterministic gates."""

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib import parse, request

from pypdf import PdfReader

from extract_responsibility_candidates import load_rules as load_retrieval_rules, retrieve
from model_client import ModelRequestError, call_model
from test_deepseek_samples import extract_json, load_env


SHADOW_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "insurance_responsibility_shadow",
        "schema": {
            "type": "object",
            "properties": {
                "responsibilities": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "title": {"type": "string"},
                            "formulaBranches": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "condition": {"type": "string"},
                                        "formula": {"type": "string"},
                                        "numericTokens": {"type": "array", "items": {"type": "string"}},
                                    },
                                    "required": ["condition", "formula", "numericTokens"],
                                    "additionalProperties": False,
                                },
                            },
                            "limits": {"type": "array", "items": {"type": "string"}},
                        },
                        "required": ["title", "formulaBranches", "limits"],
                        "additionalProperties": False,
                    },
                },
                "riskSignals": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "age_branch", "policy_year_branch", "waiting_period",
                            "accident_exception", "max_formula", "min_formula",
                            "table_reference", "mutual_exclusion", "cross_page_continuation",
                            "optional_package",
                        ],
                    },
                },
            },
            "required": ["responsibilities", "riskSignals"],
            "additionalProperties": False,
        },
    },
}


def text(value):
    return str(value or "").strip()


def safe_name(value):
    compact = re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]+", "-", text(value)).strip("-")
    digest = hashlib.sha1(text(value).encode("utf-8")).hexdigest()[:10]
    return f"{compact[:60] or 'product'}-{digest}"


def json_line(path, value):
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")


def select_from_database(db_path, limit, company_filter="", offset=0):
    connection = sqlite3.connect(db_path)
    try:
        rows = connection.execute(
            "SELECT company, product_name, url, payload FROM knowledge_records "
            "WHERE COALESCE(TRIM(url), '') <> '' ORDER BY company, product_name, id"
        ).fetchall()
    finally:
        connection.close()
    selected = {}
    for company, product_name, url, payload_text in rows:
        try:
            payload = json.loads(payload_text or "{}")
        except json.JSONDecodeError:
            continue
        source_url = text(payload.get("url") or url)
        parsed = parse.urlparse(source_url)
        if parsed.scheme != "https" or not parsed.netloc or not parsed.path.lower().endswith(".pdf"):
            continue
        if payload.get("official") is not True or "保险责任" not in text(payload.get("pageText")):
            continue
        company_name = text(payload.get("company") or company)
        product = text(payload.get("productName") or product_name)
        if not company_name or not product or (company_filter and company_filter not in company_name):
            continue
        key = (company_name, product)
        candidate = {
            "company": company_name,
            "productName": product,
            "sourceUrl": source_url,
            "discoveryUrl": text(
                payload.get("discoveryUrl")
                or payload.get("detailUrl")
                or payload.get("sourcePage")
                or payload.get("productUrl")
            ),
            "officialDomain": text(payload.get("officialDomain")) or parsed.netloc,
            "sourceTextHintLength": len(text(payload.get("pageText"))),
            "existingResponsibilityHint": text(payload.get("pageText"))[:12000],
        }
        current = selected.get(key)
        if current is None or candidate["sourceTextHintLength"] > current["sourceTextHintLength"]:
            selected[key] = candidate
    products = sorted(selected.values(), key=lambda item: (item["company"], item["productName"]))
    products = products[max(0, offset):]
    return products[:limit] if limit > 0 else products


def load_manifest(path):
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, list):
        raise ValueError("manifest must be a JSON array")
    return value


def load_published_source_digests(db_path):
    connection = sqlite3.connect(db_path)
    try:
        table_exists = connection.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_responsibility_artifacts'"
        ).fetchone()
        if not table_exists:
            return set()
        return {
            text(row[0])
            for row in connection.execute(
                "SELECT DISTINCT source_digest FROM product_responsibility_artifacts "
                "WHERE COALESCE(TRIM(source_digest), '') <> ''"
            )
        }
    finally:
        connection.close()


def download_pdf(url, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 1000:
        return
    try:
        http_request = request.Request(url, headers={"User-Agent": "Mozilla/5.0 OCRInsuranceBackfill/1.0"})
        with request.urlopen(http_request, timeout=120) as response:
            body = response.read()
    except Exception as urllib_error:
        temporary = target.with_suffix(target.suffix + ".download")
        completed = subprocess.run([
            "curl", "--fail", "--location", "--retry", "2", "--connect-timeout", "20", "--max-time", "120",
            "--user-agent", "Mozilla/5.0 OCRInsuranceBackfill/1.0", "--output", str(temporary), url,
        ], capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(f"PDF download failed: {urllib_error}; curl: {text(completed.stderr)}") from urllib_error
        body = temporary.read_bytes()
        temporary.unlink(missing_ok=True)
    if not body.startswith(b"%PDF"):
        raise ValueError("official URL did not return a PDF")
    target.write_bytes(body)


def extract_pdf_text(pdf_path, text_path):
    report_path = text_path.with_name("official-source-layout-report.json")
    layout_script = Path(__file__).with_name("extract_pdf_layout.py")
    candidates = [Path(sys.executable)]
    bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"
    if bundled.exists() and bundled not in candidates:
        candidates.append(bundled)
    for python in candidates:
        probe = subprocess.run(
            [str(python), "-c", "import pdfplumber, pypdf"],
            capture_output=True, text=True, check=False,
        )
        if probe.returncode != 0:
            continue
        completed = subprocess.run([
            str(python), str(layout_script), "--pdf", str(pdf_path),
            "--output-text", str(text_path), "--report", str(report_path),
        ], capture_output=True, text=True, check=False)
        if completed.returncode == 0:
            return report_path
    pages = []
    reader = PdfReader(str(pdf_path))
    for index, page in enumerate(reader.pages, start=1):
        pages.append(f"PDF_PAGE_{index}\n{page.extract_text() or ''}")
    source_text = "\n\n".join(pages)
    if "保险责任" not in source_text:
        raise ValueError("extracted PDF text does not contain 保险责任")
    text_path.write_text(source_text, encoding="utf-8")
    report_path.write_text(json.dumps({
        "extractor": "pypdf-fallback",
        "pages": len(pages),
        "tablePages": [],
        "crossPageTableRanges": [],
        "warning": "pdfplumber layout extraction unavailable",
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    return report_path


def validate(skill_dir, artifact_path, source_document, source_text, official_domain):
    command = [
        sys.executable, str(skill_dir / "scripts" / "validate_artifact.py"),
        "--artifact", str(artifact_path),
        "--source-document", str(source_document),
        "--source-text", str(source_text),
        "--official-domain", official_domain,
    ]
    return command, subprocess.run(command, capture_output=True, text=True, check=False)


class ResponsibilityInventoryGateError(RuntimeError):
    pass


def load_locked_inventory(product, source_digest, source_text):
    if product.get("requireLockedInventory") is not True:
        return None, None
    inventory_path = Path(text(product.get("inventoryPath")))
    expected_sha = text(product.get("inventorySha256"))
    if not inventory_path.is_file():
        raise ResponsibilityInventoryGateError("locked responsibility inventory is missing")
    actual_sha = "sha256:" + hashlib.sha256(inventory_path.read_bytes()).hexdigest()
    if not expected_sha or expected_sha != actual_sha:
        raise ResponsibilityInventoryGateError("locked responsibility inventory SHA mismatch")
    if text(product.get("sourceDigest")) != source_digest:
        raise ResponsibilityInventoryGateError("manifest source digest does not match official PDF")
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    if inventory.get("inventoryBuiltBeforeModel") is not True:
        raise ResponsibilityInventoryGateError("responsibility inventory was not built before model")
    if inventory.get("status") != "inventory_ready" or inventory.get("blockers"):
        raise ResponsibilityInventoryGateError("responsibility inventory is not ready")
    if text(inventory.get("sourceDigest")) != source_digest:
        raise ResponsibilityInventoryGateError("responsibility inventory source digest mismatch")
    responsibilities = inventory.get("responsibilities")
    if not isinstance(responsibilities, list) or not responsibilities:
        raise ResponsibilityInventoryGateError("responsibility inventory is empty")
    seen_ids = set()
    seen_titles = set()
    for item in responsibilities:
        responsibility_id = text(item.get("responsibilityId"))
        title = text(item.get("officialTitle"))
        if not responsibility_id or responsibility_id in seen_ids:
            raise ResponsibilityInventoryGateError("responsibility inventory IDs are missing or duplicated")
        if not title or title in seen_titles:
            raise ResponsibilityInventoryGateError("responsibility inventory titles are missing or duplicated")
        seen_ids.add(responsibility_id)
        seen_titles.add(title)
        if item.get("offsetStatus") != "exact" or item.get("packetGate") != "pass":
            raise ResponsibilityInventoryGateError("responsibility inventory contains an unverified packet")
        packet = text(item.get("evidencePacket"))
        packet_chars = item.get("evidencePacketChars")
        packet_limit = item.get("evidencePacketLimit")
        if (
            not packet
            or not isinstance(packet_chars, int)
            or not isinstance(packet_limit, int)
            or packet_chars != len(packet)
            or packet_chars > packet_limit
            or packet_limit > 12000
        ):
            raise ResponsibilityInventoryGateError("responsibility inventory packet length gate failed")
        offsets = [
            item.get("titleStartOffset"),
            item.get("titleEndOffset"),
            item.get("clauseStartOffset"),
            item.get("clauseEndOffset"),
        ]
        if not all(isinstance(value, int) for value in offsets):
            raise ResponsibilityInventoryGateError("responsibility inventory offsets are invalid")
        title_start, title_end, clause_start, clause_end = offsets
        title_is_exact = (
            0 <= title_start < title_end <= len(source_text)
            and re.sub(r"\s+", "", source_text[title_start:title_end]) == title
        )
        clause_is_exact = (
            0 <= clause_start < clause_end <= len(source_text)
            and source_text[clause_start:clause_end].strip() == packet
        )
        title_is_inside_clause = clause_start <= title_start < title_end <= clause_end
        cross_section_title = item.get("detectedBy") == "cross_section_official_title"
        if not (
            title_is_exact
            and clause_is_exact
            and (title_is_inside_clause or cross_section_title)
        ):
            raise ResponsibilityInventoryGateError("responsibility inventory exact source offsets failed")
    receipt = {
        "status": "passed",
        "inventoryPath": str(inventory_path),
        "inventorySha256": actual_sha,
        "sourceDigest": source_digest,
        "inventoryBuiltBeforeModel": True,
        "responsibilityCount": len(responsibilities),
        "packetLimit": 12000,
        "allOffsetsExact": True,
        "allPacketGatesPassed": True,
    }
    return inventory, receipt


def locked_inventory_source_text(inventory):
    if not inventory:
        return ""
    packets = []
    for index, item in enumerate(inventory.get("responsibilities") or [], start=1):
        packets.append(
            f"LOCKED_RESPONSIBILITY_{index}\n"
            f"responsibilityId: {text(item.get('responsibilityId'))}\n"
            f"officialTitle: {text(item.get('officialTitle'))}\n"
            f"sourcePage: {item.get('sourcePage')}\n"
            f"clauseStartOffset: {item.get('clauseStartOffset')}\n"
            f"clauseEndOffset: {item.get('clauseEndOffset')}\n"
            f"EVIDENCE_PACKET:\n{text(item.get('evidencePacket'))}"
        )
    return "\n\n".join(packets)


def responsibility_title_key(value):
    return re.sub(
        r"(?:保险责任|保险金)$",
        "",
        re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", text(value)),
    )


def verify_locked_inventory_coverage(inventory, artifact):
    if not inventory:
        return {"status": "not_required", "passed": True}
    expected = [
        {
            "responsibilityId": text(item.get("responsibilityId")),
            "title": text(item.get("officialTitle")),
            "key": responsibility_title_key(item.get("officialTitle")),
        }
        for item in inventory.get("responsibilities") or []
    ]
    actual = [
        {
            "responsibilityId": text(item.get("responsibilityId")),
            "title": text(item.get("liability")),
            "key": responsibility_title_key(item.get("liability")),
        }
        for item in artifact.get("responsibilities") or []
    ]
    expected_keys = [item["key"] for item in expected]
    actual_keys = [item["key"] for item in actual]
    missing = [
        item for item in expected
        if actual_keys.count(item["key"]) == 0
    ]
    unexpected = [
        item for item in actual
        if expected_keys.count(item["key"]) == 0
    ]
    duplicated = sorted({
        key for key in actual_keys
        if key and actual_keys.count(key) > 1
    })
    passed = (
        len(expected) == len(actual)
        and not missing
        and not unexpected
        and not duplicated
        and all(expected_keys)
        and all(actual_keys)
    )
    return {
        "status": "passed" if passed else "failed",
        "passed": passed,
        "expectedCount": len(expected),
        "actualCount": len(actual),
        "missing": missing,
        "unexpected": unexpected,
        "duplicatedKeys": duplicated,
    }


def run_importer_dry_run(artifact_path):
    project_root = Path(__file__).resolve().parents[4]
    importer = project_root / "scripts" / "import-reviewed-responsibility-artifacts.mjs"
    command = [
        "node",
        str(importer),
        f"--artifacts={artifact_path}",
        "--sample-limit=5",
    ]
    completed = subprocess.run(
        command,
        cwd=project_root,
        capture_output=True,
        text=True,
        check=False,
    )
    parsed = None
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError:
        parsed = None
    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
    responsibilities = artifact.get("responsibilities") or []
    responsibility_count = len(responsibilities)
    expected_indicator_count = sum(
        max(1, len(item.get("indicators") or []))
        for item in responsibilities
    )
    passed = bool(
        completed.returncode == 0
        and parsed
        and parsed.get("dryRun") is True
        and parsed.get("ok") is True
        and parsed.get("validationIssueCount") == 0
        and parsed.get("acceptedResponsibilities") == expected_indicator_count
        and not parsed.get("validationFailures")
        and not parsed.get("blockerProducts")
        and parsed.get("materializedProducts") == 0
        and parsed.get("materializedCards") == 0
    )
    return {
        "status": "passed" if passed else "failed",
        "passed": passed,
        "command": command,
        "exitCode": completed.returncode,
        "stdout": completed.stdout,
        "stderr": completed.stderr,
        "responsibilityCount": responsibility_count,
        "expectedAcceptedIndicators": expected_indicator_count,
        "receipt": parsed,
    }


def classify_failure(error):
    if isinstance(error, ResponsibilityInventoryGateError):
        return {
            "failureClass": "responsibility_inventory_gate",
            "failureLayer": "pipeline",
            "retryable": False,
        }
    if isinstance(error, ModelRequestError):
        return {
            "failureClass": error.failure_class,
            "failureLayer": "model",
            "httpStatus": error.status_code,
            "retryable": error.retryable,
            "provider": error.provider,
        }
    message = str(error)
    if "timed out" in message.lower():
        return {
            "failureClass": "model_timeout",
            "failureLayer": "model",
            "retryable": True,
        }
    if "model output incomplete" in message.lower() or "json" in message.lower():
        return {
            "failureClass": "model_invalid_output",
            "failureLayer": "model",
            "retryable": True,
        }
    if message.startswith("PDF download failed:"):
        status_match = re.search(r"(?:HTTP Error|returned error:)\s*(403|404|405|412)", message)
        status_code = int(status_match.group(1)) if status_match else None
        if status_code == 404:
            source_failure_class = "pdf_download_404"
            next_action = "official_detail_rediscovery"
        elif status_code in {403, 405, 412}:
            source_failure_class = f"pdf_download_{status_code}"
            next_action = "browser_session_download"
        elif re.search(r"certificate|ssl", message, flags=re.I):
            source_failure_class = "pdf_download_ssl"
            next_action = "certificate_or_company_adapter_review"
        else:
            source_failure_class = "pdf_download_other"
            next_action = "direct_once_then_browser"
        return {
            "failureClass": "source_acquisition",
            "failureLayer": "source",
            "sourceFailureClass": source_failure_class,
            "nextSourceAction": next_action,
            "httpStatus": status_code,
            "retryable": True,
        }
    if message == "official URL did not return a PDF":
        return {
            "failureClass": "source_acquisition",
            "failureLayer": "source",
            "sourceFailureClass": "official_url_not_pdf",
            "nextSourceAction": "official_detail_rediscovery",
            "retryable": True,
        }
    if "extracted PDF text does not contain 保险责任" in message:
        return {"failureClass": "source_text", "failureLayer": "source", "retryable": False}
    if re.fullmatch(r"HTTP Error (402|403|429):.*", message):
        status_code = int(re.search(r"\d{3}", message).group())
        failure_class = {
            402: "model_billing",
            403: "model_auth_or_permission",
            429: "model_rate_limit",
        }[status_code]
        return {
            "failureClass": failure_class,
            "failureLayer": "model",
            "httpStatus": status_code,
            "retryable": status_code == 429,
        }
    return {"failureClass": "pipeline_error", "failureLayer": "pipeline", "retryable": False}


def should_retry(previous, retry_manual, retry_failure_classes, retry_failure_layers):
    if previous.get("status") != "manual_review":
        return False
    if retry_manual:
        return True
    failure_class = text(previous.get("failureClass"))
    failure_layer = text(previous.get("failureLayer"))
    if not failure_class:
        inferred = classify_failure(previous.get("error", ""))
        failure_class = inferred.get("failureClass", "")
        failure_layer = inferred.get("failureLayer", "")
    return failure_class in retry_failure_classes or failure_layer in retry_failure_layers


def bounded_shadow_text(candidate_text, max_chars):
    if len(candidate_text) <= max_chars:
        return candidate_text, False
    responsibility_index = candidate_text.find("保险责任")
    if responsibility_index < 0:
        return candidate_text[:max_chars], True
    marker_matches = list(re.finditer(r"(?m)^PDF_(?:LAYOUT_)?PAGE_\d+\s*$", candidate_text[:responsibility_index]))
    start = marker_matches[-1].start() if marker_matches else responsibility_index
    return candidate_text[start:start + max_chars], True


def shadow_complexity_reasons(candidate_text, retrieval_report):
    compact = re.sub(r"\s+", "", candidate_text)
    reasons = []
    ages = set(re.findall(r"(\d{1,3})周岁", compact))
    percentages = set(re.findall(r"\d+(?:\.\d+)?[%％]", compact))
    if len(ages) >= 2:
        reasons.append("multiple_age_boundaries")
    if re.search(r"第?[一二三四五六七八九十百\d]+(?:个)?保单年度", compact):
        reasons.append("policy_year_branches")
    if any(value in compact for value in ["较大者", "max("]):
        reasons.append("max_formula")
    if any(value in compact for value in ["较小者", "min("]):
        reasons.append("min_formula")
    if len(percentages) >= 2:
        reasons.append("multiple_percentages")
    if retrieval_report.get("selectedTablePages") or any(
        value in compact for value in ["保险计划表", "给付比例表", "现金价值表", "附表", "附录"]
    ):
        reasons.append("table_or_schedule")
    if any(value in compact for value in ["仅给付其中一项", "不重复给付", "二者给付其一"]):
        reasons.append("mutual_exclusion")
    if any(value in compact for value in ["可选责任", "保险计划", "任选一项"]):
        reasons.append("optional_package")
    return reasons


def normalized_title(value):
    return re.sub(r"[^0-9A-Za-z\u4e00-\u9fff]", "", text(value)).replace("保险金", "")


def match_shadow_responsibility(title, responsibilities):
    target = normalized_title(title)
    if not target:
        return None
    normalized = [
        (responsibility, normalized_title(responsibility.get("liability")))
        for responsibility in responsibilities
    ]
    exact = next(
        (responsibility for responsibility, candidate in normalized if target == candidate),
        None,
    )
    if exact:
        return exact
    contains = [
        (responsibility, candidate)
        for responsibility, candidate in normalized
        if target in candidate or candidate in target
    ]
    if contains:
        return max(
            contains,
            key=lambda item: min(len(target), len(item[1])) / max(len(target), len(item[1]), 1),
        )[0]
    if "等待期" in target:
        return next(
            (item for item in responsibilities if item.get("responsibilityKind") == "waiting_period_refund"),
            None,
        )
    return None


def artifact_formula_text(responsibility):
    values = [
        text(responsibility.get("triggerCondition")),
        text(responsibility.get("insurerObligation")),
        " ".join(text(value) for value in responsibility.get("importantLimits") or []),
    ]
    for indicator in responsibility.get("indicators") or []:
        values.extend([
            text(indicator.get("formulaText")),
            text(indicator.get("normalizedFormula")),
        ])
        for branch in indicator.get("branches") or []:
            values.extend([
                text(branch.get("conditionText")),
                text(branch.get("formulaText")),
            ])
    return re.sub(r"\s+", "", "\n".join(values))


def compare_shadow_to_artifact(shadow, artifact):
    responsibilities = artifact.get("responsibilities") or []
    comparisons = []
    conflicts = []
    for candidate in shadow.get("responsibilities") or []:
        matched = match_shadow_responsibility(candidate.get("title"), responsibilities)
        shadow_branches = candidate.get("formulaBranches") or []
        if not matched:
            numeric_tokens = [
                token for branch in shadow_branches for token in branch.get("numericTokens") or []
            ]
            status = "unmatched_with_formula" if numeric_tokens else "unmatched_non_formula"
            comparisons.append({
                "shadowTitle": text(candidate.get("title")),
                "status": status,
                "numericTokens": numeric_tokens,
            })
            if numeric_tokens:
                conflicts.append({
                    "type": "unmatched_shadow_responsibility",
                    "shadowTitle": text(candidate.get("title")),
                    "numericTokens": numeric_tokens,
                })
            continue
        artifact_text = artifact_formula_text(matched)
        missing_tokens = [
            token
            for branch in shadow_branches
            for token in branch.get("numericTokens") or []
            if re.sub(r"\s+", "", token) not in artifact_text
        ]
        artifact_branch_count = max(
            [len(indicator.get("branches") or []) for indicator in matched.get("indicators") or []] or [0]
        )
        branch_count_mismatch = (
            artifact_branch_count > 0
            and len(shadow_branches) > 0
            and artifact_branch_count != len(shadow_branches)
        )
        comparison = {
            "shadowTitle": text(candidate.get("title")),
            "responsibilityId": text(matched.get("responsibilityId")),
            "artifactLiability": text(matched.get("liability")),
            "shadowBranchCount": len(shadow_branches),
            "artifactBranchCount": artifact_branch_count,
            "missingNumericTokens": missing_tokens,
            "status": "conflict" if missing_tokens or branch_count_mismatch else "aligned",
        }
        comparisons.append(comparison)
        if missing_tokens:
            conflicts.append({
                "type": "numeric_tokens_missing_from_artifact",
                "responsibilityId": comparison["responsibilityId"],
                "tokens": missing_tokens,
            })
        if branch_count_mismatch:
            conflicts.append({
                "type": "formula_branch_count_mismatch",
                "responsibilityId": comparison["responsibilityId"],
                "shadowBranchCount": len(shadow_branches),
                "artifactBranchCount": artifact_branch_count,
            })
    return {
        "status": "review_required" if conflicts else "aligned",
        "modelRole": "local_candidate_assistant",
        "comparedResponsibilities": len(comparisons),
        "comparisons": comparisons,
        "materialConflicts": conflicts,
    }


def source_window_for_title(source_text, title, radius=1200):
    compact_title = text(title).replace("保险金", "")
    index = source_text.find(text(title))
    if index < 0 and compact_title:
        index = source_text.find(compact_title)
    if index < 0:
        return ""
    return source_text[max(0, index - radius):min(len(source_text), index + len(title) + radius)]


def build_high_capability_review_packet(product, artifact, shadow, comparison, source_text):
    artifact_by_id = {
        text(item.get("responsibilityId")): item
        for item in artifact.get("responsibilities") or []
    }
    shadow_by_title = {
        text(item.get("title")): item
        for item in shadow.get("responsibilities") or []
    }
    review_items = []
    for item in comparison.get("comparisons") or []:
        if item.get("status") != "conflict" and item.get("status") != "unmatched_with_formula":
            continue
        responsibility_id = text(item.get("responsibilityId"))
        shadow_title = text(item.get("shadowTitle"))
        review_items.append({
            "responsibilityId": responsibility_id,
            "artifactLiability": text(item.get("artifactLiability")),
            "shadowTitle": shadow_title,
            "comparison": item,
            "validatedArtifactResponsibility": artifact_by_id.get(responsibility_id),
            "validatedShadowCandidate": shadow_by_title.get(shadow_title),
            "officialSourceWindow": source_window_for_title(
                source_text,
                text(item.get("artifactLiability")) or shadow_title,
            ),
        })
    return {
        "schemaVersion": "insurance-responsibility-high-capability-review-v1",
        "role": "high_capability_responsibility_reviewer",
        "company": text(product.get("company")),
        "productName": text(product.get("productName")),
        "sourceDigest": text((artifact.get("productIdentity") or {}).get("sourceDigest")),
        "authority": (
            "Only officialSourceWindow and exact sourceExcerpt/evidenceSegments inside the "
            "validated artifact are authoritative. Model agreement is not evidence."
        ),
        "reviewItems": review_items,
        "requiredOutput": {
            "decisions": [{
                "responsibilityId": "stable responsibility ID or empty for unmatched candidate",
                "decision": "keep_artifact|repair_artifact|source_repair_required",
                "materialIssue": "concise conflict description",
                "supportedNumericTokens": ["exact official tokens"],
                "unsupportedNumericTokens": ["tokens absent from official evidence"],
                "requiredRepair": "empty when keeping artifact",
                "officialEvidence": ["exact short official excerpts"],
            }],
            "overallDecision": "resolved|repair_required|source_repair_required",
        },
    }


def validate_high_capability_review_result(packet, result):
    issues = []
    review_items = packet.get("reviewItems") or []
    decisions = result.get("decisions") or []
    if len(decisions) != len(review_items):
        issues.append("decision_count_mismatch")
    allowed = {"keep_artifact", "repair_artifact", "source_repair_required"}
    for index, item in enumerate(review_items):
        if index >= len(decisions):
            break
        decision = decisions[index]
        if text(decision.get("responsibilityId")) != text(item.get("responsibilityId")):
            issues.append(f"responsibility_id_mismatch:{index}")
        if decision.get("decision") not in allowed:
            issues.append(f"invalid_decision:{index}")
        evidence_scope = re.sub(r"\s+", "", json.dumps({
            "officialSourceWindow": item.get("officialSourceWindow"),
            "validatedArtifactResponsibility": item.get("validatedArtifactResponsibility"),
        }, ensure_ascii=False))
        for excerpt in decision.get("officialEvidence") or []:
            if re.sub(r"\s+", "", text(excerpt)) not in evidence_scope:
                issues.append(f"unsupported_official_evidence:{index}")
    overall = result.get("overallDecision")
    if overall not in {"resolved", "repair_required", "source_repair_required"}:
        issues.append("invalid_overall_decision")
    return {"ok": not issues, "issues": issues}


def validate_shadow_result(parsed, source_text):
    compact_source = re.sub(r"\s+", "", source_text)
    responsibility_text = json.dumps(parsed.get("responsibilities") or [], ensure_ascii=False)
    branch_conditions = "\n".join(
        text(branch.get("condition"))
        for responsibility in parsed.get("responsibilities") or []
        for branch in responsibility.get("formulaBranches") or []
    )
    branch_formulas = "\n".join(
        text(branch.get("formula"))
        for responsibility in parsed.get("responsibilities") or []
        for branch in responsibility.get("formulaBranches") or []
    )
    signal_checks = {
        "age_branch": lambda: "周岁" in branch_conditions and "周岁" in source_text,
        "policy_year_branch": lambda: "保单年度" in branch_conditions and "保单年度" in source_text,
        "waiting_period": lambda: "等待期" in responsibility_text and "等待期" in source_text,
        "accident_exception": lambda: "意外伤害" in responsibility_text and "意外伤害" in source_text,
        "max_formula": lambda: (
            ("较大者" in branch_formulas or "max(" in branch_formulas.lower())
            and ("较大者" in source_text or "max(" in source_text.lower())
        ),
        "min_formula": lambda: (
            ("较小者" in branch_formulas or "min(" in branch_formulas.lower())
            and ("较小者" in source_text or "min(" in source_text.lower())
        ),
        "table_reference": lambda: (
            any(value in responsibility_text for value in ["表", "附表", "附录"])
            and any(value in source_text for value in ["表", "附表", "附录"])
        ),
        "mutual_exclusion": lambda: any(
            value in re.sub(r"\s+", "", responsibility_text) and value in compact_source
            for value in ["仅给付其中一项", "不重复给付", "二者给付其一"]
        ),
        "cross_page_continuation": lambda: len(re.findall(
            r"(?m)^(?:PDF_(?:LAYOUT_)?PAGE_\d+|===== PAGE \d+ =====)\s*$",
            source_text,
        )) > 1,
        "optional_package": lambda: (
            any(value in responsibility_text for value in ["可选责任", "保险计划", "任选"])
            and any(value in source_text for value in ["可选责任", "保险计划", "任选"])
        ),
    }
    proposed_signals = parsed.get("riskSignals") or []
    accepted_signals = [signal for signal in proposed_signals if signal_checks.get(signal, lambda: False)()]
    rejected_signals = [signal for signal in proposed_signals if signal not in accepted_signals]
    rejected_tokens = []
    for responsibility in parsed.get("responsibilities") or []:
        for branch in responsibility.get("formulaBranches") or []:
            accepted_tokens = []
            for token in branch.get("numericTokens") or []:
                compact_token = re.sub(r"\s+", "", text(token))
                if re.search(r"\d|[%％]", compact_token) and compact_token in compact_source:
                    accepted_tokens.append(token)
                else:
                    rejected_tokens.append(token)
            branch["numericTokens"] = accepted_tokens
    parsed["riskSignals"] = accepted_signals
    return parsed, {
        "rejectedRiskSignals": rejected_signals,
        "rejectedNumericTokens": rejected_tokens,
    }


def start_shadow_assistant(
    product,
    candidate_text,
    product_dir,
    *,
    base_url,
    model,
    api_key,
    timeout_ms,
    max_tokens,
    max_input_chars,
    routing_reasons,
):
    receipt_path = product_dir / "shadow-receipt.json"
    started = time.monotonic()
    shadow_text, input_truncated = bounded_shadow_text(candidate_text, max_input_chars)
    receipt_path.write_text(json.dumps({
        "status": "running",
        "provider": "openai-compatible",
        "model": model,
        "baseUrl": base_url,
        "capabilityRoles": ["formula_branches", "risk_signals"],
        "timeoutMs": timeout_ms,
        "routingReasons": routing_reasons,
        "inputChars": len(shadow_text),
        "inputTruncated": input_truncated,
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    def run():
        try:
            messages = [
                {
                    "role": "system",
                    "content": (
                        "你是保险条款公式与风险信号候选助手。官方原文是唯一依据。"
                        "你无权决定最终责任清单；等待期、除外责任和分组标题不得新增为保险责任。"
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"公司：{text(product.get('company'))}\n"
                        f"产品：{text(product.get('productName'))}\n"
                        "仅提取正式责任下的完整公式分支、年龄或保单年度边界、百分比、"
                        "max/min关系、互斥与跨页风险信号。不得补充原文没有的信息。\n\n"
                        f"官方候选原文：\n{shadow_text}"
                    ),
                },
            ]
            model_response = call_model(
                api_key,
                model,
                messages,
                provider="openai-compatible",
                base_url=base_url,
                max_tokens=max_tokens,
                response_format=SHADOW_RESPONSE_FORMAT,
                timeout=max(1, timeout_ms / 1000),
            )
            content = model_response
            (product_dir / "shadow-raw.txt").write_text(content, encoding="utf-8")
            parsed = extract_json(content)
            (product_dir / "shadow-unvalidated.json").write_text(
                json.dumps(parsed, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            parsed, validation = validate_shadow_result(parsed, shadow_text)
            (product_dir / "shadow.json").write_text(
                json.dumps(parsed, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            receipt = {
                "status": "completed",
                "provider": "openai-compatible",
                "model": model,
                "baseUrl": base_url,
                "capabilityRoles": ["formula_branches", "risk_signals"],
                "latencyMs": round((time.monotonic() - started) * 1000),
                "routingReasons": routing_reasons,
                "inputChars": len(shadow_text),
                "inputTruncated": input_truncated,
                "responsibilityCandidates": len(parsed.get("responsibilities") or []),
                "riskSignals": parsed.get("riskSignals") or [],
                **validation,
                "resultPath": str(product_dir / "shadow.json"),
            }
        except Exception as error:
            receipt = {
                "status": "failed",
                "provider": "openai-compatible",
                "model": model,
                "baseUrl": base_url,
                "capabilityRoles": ["formula_branches", "risk_signals"],
                "latencyMs": round((time.monotonic() - started) * 1000),
                "routingReasons": routing_reasons,
                "inputChars": len(shadow_text),
                "inputTruncated": input_truncated,
                "error": str(error),
            }
        receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")

    thread = threading.Thread(target=run, name=f"shadow-{safe_name(product.get('productName'))}", daemon=True)
    thread.start()
    return thread, receipt_path


def process_product(product, *, skill_dir, skill_text, api_key, provider, base_url, model, shadow_config, repair_rounds, request_timeout_ms, max_output_tokens, max_prompt_candidate_chars, max_prompt_skill_chars, max_prompt_hint_chars, run_dir, published_source_digests, retry_manual, retry_failure_classes, retry_failure_layers):
    product_key = safe_name(f"{product.get('company')}--{product.get('productName')}")
    product_dir = run_dir / "products" / product_key
    product_dir.mkdir(parents=True, exist_ok=True)
    result_path = product_dir / "result.json"
    shadow_thread = None
    shadow_receipt_path = None
    if result_path.exists():
        previous = json.loads(result_path.read_text(encoding="utf-8"))
        if previous.get("status") in {"published", "skipped", "approved"} or not should_retry(
            previous, retry_manual, retry_failure_classes, retry_failure_layers
        ):
            return previous
    try:
        source_url = text(product.get("sourceUrl"))
        official_domain = text(product.get("officialDomain")) or parse.urlparse(source_url).netloc
        source_document = Path(product["sourceDocumentPath"]) if product.get("sourceDocumentPath") else product_dir / "official-source.pdf"
        source_text_path = Path(product["sourceTextPath"]) if product.get("sourceTextPath") else product_dir / "official-source.pages.txt"
        if not product.get("sourceDocumentPath"):
            download_pdf(source_url, source_document)
        if not product.get("sourceTextPath"):
            extract_pdf_text(source_document, source_text_path)
        source_text = source_text_path.read_text(encoding="utf-8")
        source_digest = "sha256:" + hashlib.sha256(source_document.read_bytes()).hexdigest()
        if source_digest in published_source_digests:
            result = {
                "status": "skipped", "reason": "current_source_digest_already_published",
                "company": text(product.get("company")), "productName": text(product.get("productName")),
                "sourceUrl": source_url, "sourceDigest": source_digest,
                "sourceDocumentPath": str(source_document), "sourceTextPath": str(source_text_path),
            }
            result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            return result
        try:
            locked_inventory, inventory_receipt = load_locked_inventory(
                product,
                source_digest,
                source_text,
            )
        except ResponsibilityInventoryGateError as inventory_error:
            (product_dir / "locked-responsibility-inventory-receipt.json").write_text(
                json.dumps({
                    "status": "failed",
                    "inventoryPath": text(product.get("inventoryPath")),
                    "inventorySha256": text(product.get("inventorySha256")),
                    "sourceDigest": source_digest,
                    "providerCallStarted": False,
                    "error": str(inventory_error),
                }, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            raise
        if inventory_receipt:
            (product_dir / "locked-responsibility-inventory-receipt.json").write_text(
                json.dumps(inventory_receipt, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        retrieval_rules = load_retrieval_rules(Path(__file__).with_name("responsibility_retrieval_rules.json"))
        candidate_text, retrieval_report = retrieve(source_text, text(product.get("productName")), retrieval_rules)
        candidate_text_path = product_dir / "responsibility-candidate.pages.txt"
        retrieval_report_path = product_dir / "responsibility-retrieval-report.json"
        layout_report_path = product_dir / "official-source-layout-report.json"
        candidate_text_path.write_text(candidate_text, encoding="utf-8")
        retrieval_report_path.write_text(json.dumps(retrieval_report, ensure_ascii=False, indent=2), encoding="utf-8")
        initial_source_mode = retrieval_report["mode"]
        complexity_reasons = shadow_complexity_reasons(candidate_text, retrieval_report)
        shadow_routed = bool(
            shadow_config
            and shadow_config["routing"] != "off"
            and (shadow_config["routing"] == "all" or complexity_reasons)
        )
        if shadow_config and not shadow_routed:
            shadow_receipt_path = product_dir / "shadow-receipt.json"
            shadow_receipt_path.write_text(json.dumps({
                "status": "skipped_not_complex",
                "provider": "openai-compatible",
                "model": shadow_config["model"],
                "routing": shadow_config["routing"],
                "routingReasons": complexity_reasons,
            }, ensure_ascii=False, indent=2), encoding="utf-8")
        if shadow_routed:
            shadow_thread, shadow_receipt_path = start_shadow_assistant(
                product,
                candidate_text,
                product_dir,
                **{key: value for key, value in shadow_config.items() if key != "routing"},
                routing_reasons=complexity_reasons,
            )
        prompt_skill_text = skill_text
        prompt_candidate_text = (
            locked_inventory_source_text(locked_inventory)
            if locked_inventory
            else candidate_text
        )
        prompt_hint = text(product.get('existingResponsibilityHint')) or 'not_available'
        if max_prompt_skill_chars > 0:
            prompt_skill_text = skill_text[:max_prompt_skill_chars]
        if max_prompt_candidate_chars > 0 and not locked_inventory:
            prompt_candidate_text = candidate_text[:max_prompt_candidate_chars]
        if max_prompt_hint_chars > 0:
            prompt_hint = prompt_hint[:max_prompt_hint_chars]
        prompt = f"""
Use the pipeline contract below to parse exactly one insurance product. Return one complete JSON object only.
You are the artifact-generation stage inside a host process. The host process will run the canonicalizer, validator,
renderer, publisher, and readback. Do not return deterministic_gate_not_executed and do not attempt publication.
Use only RETRIEVED_OFFICIAL_SOURCE_TEXT as responsibility and formula evidence. The retrieval code only narrows
the first-pass search area; it does not decide which responsibilities exist. Derive the legal insurer name and exact
product title from the source; the database identity is only a lookup hint. Prefer one exact contiguous sourceExcerpt.
If PDF columns, page breaks, or separated clauses require multiple passages, use ordered evidenceSegments and copy
each sourceExcerpt exactly; never synthesize a concatenated excerpt. Define cross-cutting deductibles, reimbursement
ratios, annual limits, compensation principles, and their piecewise branches once in productRules.calculation, then
link every affected responsibility and indicator with ruleRefs. Keep responsibility-specific bases in their own
indicators and do not duplicate shared rule branches. Do not merge independently named benefits. Keep all optional groups and formula branches.
PDF_LAYOUT_PAGE blocks are deterministic coordinate-preserving text from the same official PDF. Use them for table
column/row relationships. A table continued on another page must use one exact evidenceSegment per page; never join
two pages into one claimed contiguous excerpt. Repeated table headers are context, not separate responsibilities.
Copy conditionText and evidenceTokens literally from their own evidence passage, including PDF footnote numbers and
the source's comparison wording. Never replace 不超过 with ≤ or otherwise introduce shorthand absent from the source.
Set publication.sqlite to development_required_after_approval and publication.feishu to not_requested.

Database identity hint:
- company: {text(product.get('company'))}
- productName: {text(product.get('productName'))}
- official source URL: {source_url}
- official source digest: {source_digest}

EXISTING_DATABASE_RESPONSIBILITY_HINT (recall and comparison only; never official evidence):
{prompt_hint}

Use the database hint only to notice possible omissions. Re-establish every responsibility, optional group, formula,
and indicator from RETRIEVED_OFFICIAL_SOURCE_TEXT or the complete official source supplied during repair. Never cite,
copy evidence from, or approve a responsibility solely because it appears in the database hint.

LOCKED_DETERMINISTIC_RESPONSIBILITY_INVENTORY:
{json.dumps(locked_inventory or {"status": "not_required"}, ensure_ascii=False)}

When the locked inventory is present, it is the immutable coverage floor built before this model call. Emit every
listed responsibility exactly once and use only its bounded evidence packet for that responsibility. Do not omit,
merge, rename, or invent responsibility titles. If the evidence packet cannot support a required semantic field,
leave the artifact unapproved for the validator instead of guessing. The host has already verified source digest,
packet length, exact offsets, and inventory uniqueness.

PIPELINE_SKILL:
{prompt_skill_text}

RETRIEVAL_REPORT:
{json.dumps(retrieval_report, ensure_ascii=False)}

RETRIEVED_OFFICIAL_SOURCE_TEXT:
{prompt_candidate_text}
""".strip()
        messages = [
            {"role": "system", "content": "You are the JSON generation stage of a host-controlled Chinese insurance pipeline. The host runs all tools and gates. Always output the complete artifact JSON only; never return deterministic_gate_not_executed."},
            {"role": "user", "content": prompt},
        ]
        artifact_path = product_dir / "artifact.json"
        final_validation = None
        full_source_supplied = bool(locked_inventory) or initial_source_mode == "full_text_fallback"
        final_gate_errors = []
        for round_index in range(repair_rounds + 1):
            model_response = call_model(
                api_key,
                model,
                messages,
                provider=provider,
                base_url=base_url,
                max_tokens=max_output_tokens,
                timeout=max(1, request_timeout_ms / 1000),
                return_metadata=True,
            )
            if model_response.get("finish_reason") == "length":
                raise RuntimeError("model output incomplete: finish_reason=length")
            content = model_response["content"]
            (product_dir / f"round-{round_index + 1}-raw.txt").write_text(content, encoding="utf-8")
            artifact = extract_json(content)
            artifact_path.write_text(json.dumps(artifact, ensure_ascii=False, indent=2), encoding="utf-8")
            canonical_path = product_dir / f"round-{round_index + 1}-canonical.json"
            canonical = subprocess.run([
                sys.executable, str(skill_dir / "scripts" / "canonicalize_excerpts.py"),
                "--artifact", str(artifact_path), "--source-text", str(source_text_path), "--output", str(canonical_path),
            ], capture_output=True, text=True, check=False)
            if canonical.returncode != 0:
                raise RuntimeError(canonical.stderr or "canonicalizer failed")
            artifact_path.write_text(canonical_path.read_text(encoding="utf-8"), encoding="utf-8")
            artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
            inventory_coverage = verify_locked_inventory_coverage(locked_inventory, artifact)
            (product_dir / f"round-{round_index + 1}-inventory-coverage.json").write_text(
                json.dumps(inventory_coverage, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            command, validation = validate(skill_dir, artifact_path, source_document, source_text_path, official_domain)
            final_validation = validation
            receipt = {"command": command, "exitCode": validation.returncode, "stdout": validation.stdout, "stderr": validation.stderr}
            (product_dir / f"round-{round_index + 1}-validator.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
            if validation.returncode == 0 and inventory_coverage["passed"]:
                importer_dry_run = run_importer_dry_run(artifact_path)
            else:
                importer_dry_run = {
                    "status": "blocked",
                    "passed": False,
                    "reason": (
                        "validator_gate_failed"
                        if validation.returncode != 0
                        else "locked_inventory_coverage_failed"
                    ),
                }
            (product_dir / f"round-{round_index + 1}-importer-dry-run.json").write_text(
                json.dumps(importer_dry_run, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            final_gate_errors = []
            if validation.returncode != 0:
                final_gate_errors.append(validation.stderr or "validator gate failed")
            if not inventory_coverage["passed"]:
                final_gate_errors.append(
                    "locked inventory coverage failed: "
                    + json.dumps(inventory_coverage, ensure_ascii=False)
                )
            if not importer_dry_run["passed"]:
                final_gate_errors.append(
                    "importer dry-run failed or blocked: "
                    + json.dumps(importer_dry_run, ensure_ascii=False)
                )
            if not final_gate_errors:
                shadow_comparison_path = product_dir / "shadow-comparison.json"
                shadow_comparison_status = "not_available"
                if shadow_thread and not shadow_thread.is_alive() and (product_dir / "shadow.json").exists():
                    shadow_result = json.loads(
                        (product_dir / "shadow.json").read_text(encoding="utf-8")
                    )
                    artifact_result = json.loads(artifact_path.read_text(encoding="utf-8"))
                    comparison = compare_shadow_to_artifact(
                        shadow_result,
                        artifact_result,
                    )
                    shadow_comparison_path.write_text(
                        json.dumps(comparison, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    shadow_comparison_status = comparison["status"]
                    if shadow_comparison_status == "review_required":
                        review_packet_path = product_dir / "high-capability-review-packet.json"
                        review_packet_path.write_text(json.dumps(
                            build_high_capability_review_packet(
                                product,
                                artifact_result,
                                shadow_result,
                                comparison,
                                source_text,
                            ),
                            ensure_ascii=False,
                            indent=2,
                        ), encoding="utf-8")
                    else:
                        review_packet_path = None
                else:
                    review_packet_path = None
                result = {
                    "status": "approved", "company": text(artifact.get("company")), "productName": text(artifact.get("productName")),
                    "sourceUrl": source_url, "officialDomain": official_domain, "artifactPath": str(artifact_path),
                    "sourceDigest": source_digest,
                    "sourceDocumentPath": str(source_document), "sourceTextPath": str(source_text_path),
                    "candidateTextPath": str(candidate_text_path), "retrievalReportPath": str(retrieval_report_path),
                    "layoutReportPath": str(layout_report_path),
                    "initialSourceMode": initial_source_mode,
                    "lockedInventoryPath": text(product.get("inventoryPath")),
                    "lockedInventoryReceiptPath": (
                        str(product_dir / "locked-responsibility-inventory-receipt.json")
                        if inventory_receipt else ""
                    ),
                    "provider": provider, "model": model,
                    "shadowReceiptPath": str(shadow_receipt_path) if shadow_receipt_path else "",
                    "shadowJoinedBeforeApproval": bool(shadow_thread and not shadow_thread.is_alive()),
                    "shadowComparisonPath": (
                        str(shadow_comparison_path) if shadow_comparison_path.exists() else ""
                    ),
                    "shadowComparisonStatus": shadow_comparison_status,
                    "highCapabilityReviewRequired": shadow_comparison_status == "review_required",
                    "highCapabilityReviewPacketPath": (
                        str(review_packet_path) if review_packet_path else ""
                    ),
                    "responsibilityCount": len(artifact.get("responsibilities") or []), "attempts": round_index + 1,
                    "inventoryCoverageReceiptPath": str(
                        product_dir / f"round-{round_index + 1}-inventory-coverage.json"
                    ),
                    "importerDryRunReceiptPath": str(
                        product_dir / f"round-{round_index + 1}-importer-dry-run.json"
                    ),
                }
                result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
                return result
            repair_prompt = """Repair the complete JSON evidence-first. Keep every real responsibility, optional group,
shared rule, and formula branch. Never delete data to silence validation. For every exact-contiguous failure, replace
the invalid excerpt with an exact official passage; use ordered exact evidenceSegments when one passage cannot prove
the claim. For unsupported conditionText or evidenceTokens, copy the exact source wording from that item's evidence,
including PDF footnote numbers and literal comparison wording; do not invent symbols such as ≤ for 不超过. Expand the
item's evidence when the branch is real but its passage is missing. For group-medical optional packages, include the
exact package label and every child heading in ordered evidence. Use operands only for literal max/min comparisons;
ordinary conditional branches must not contain operands. Classify waiting-period premium returns as
waiting_period_refund with coverageAggregation exclude and keep optional child mappings synchronized. For table
branches, copy exact row wording from PDF_LAYOUT_PAGE evidence; for cross-page continuations use separate exact
evidenceSegments and ignore repeated headers as responsibility titles. Return JSON only.
Gate issues:\n""" + "\n".join(final_gate_errors)
            if not full_source_supplied:
                repair_prompt += "\n\nThe candidate-page pass did not validate. Re-audit against the COMPLETE official source below; do not assume the retrieval pass was complete.\n\nFULL_OFFICIAL_SOURCE_TEXT:\n" + source_text
                full_source_supplied = True
            messages.extend([{"role": "assistant", "content": content}, {"role": "user", "content": repair_prompt}])
        result = {
            "status": "manual_review", "stage": "validation", "company": text(product.get("company")),
            "productName": text(product.get("productName")), "sourceUrl": source_url, "artifactPath": str(artifact_path),
            "sourceDocumentPath": str(source_document), "sourceTextPath": str(source_text_path),
            "candidateTextPath": str(candidate_text_path), "retrievalReportPath": str(retrieval_report_path),
            "layoutReportPath": str(layout_report_path),
            "initialSourceMode": initial_source_mode,
            "provider": provider, "model": model,
            "shadowReceiptPath": str(shadow_receipt_path) if shadow_receipt_path else "",
            "shadowJoinedBeforeApproval": bool(shadow_thread and not shadow_thread.is_alive()),
            "failureClass": "validation", "failureLayer": "validation", "retryable": True,
            "attempts": repair_rounds + 1,
            "error": text("\n".join(final_gate_errors)) or text(
                final_validation.stderr if final_validation else "validator did not run"
            ),
        }
    except Exception as error:
        failure = classify_failure(error)
        result = {
            "status": "manual_review", "stage": "source_or_model", "company": text(product.get("company")),
            "productName": text(product.get("productName")), "sourceUrl": text(product.get("sourceUrl")),
            "provider": provider, "model": model, **failure, "error": str(error),
            "shadowReceiptPath": str(shadow_receipt_path) if shadow_receipt_path else "",
            "shadowJoinedBeforeResult": bool(shadow_thread and not shadow_thread.is_alive()),
        }
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def create_batch_backup(db_path, backup_path):
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    source = sqlite3.connect(db_path)
    target = sqlite3.connect(backup_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()


def publish_approved(skill_dir, db_path, backup_path, result):
    command = [
        "node", str(skill_dir / "scripts" / "publish_development_artifact.mjs"),
        f"--artifact={result['artifactPath']}", f"--source-document={result['sourceDocumentPath']}",
        f"--source-text={result['sourceTextPath']}", f"--official-domain={result['officialDomain']}",
        f"--db-path={db_path.absolute()}", f"--backup-path={backup_path.absolute()}", "--write",
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        return {**result, "status": "manual_review", "stage": "publication", "error": completed.stderr or completed.stdout}
    receipt = json.loads(completed.stdout)
    return {**result, "status": "published", "publicationReceipt": receipt}


def launch_offline_packetized_shadow(args, approved):
    if not args.offline_packetized_shadow or not approved:
        return {"enabled": bool(args.offline_packetized_shadow), "status": "not_started"}
    required = {
        "--offline-shadow-packet-runner": args.offline_shadow_packet_runner,
        "--offline-shadow-base-url": args.offline_shadow_base_url,
        "--offline-shadow-model": args.offline_shadow_model,
    }
    missing = [name for name, value in required.items() if not value]
    if missing:
        raise ValueError(
            "offline packetized shadow requires " + ", ".join(missing)
        )
    shadow_dir = args.output_dir / "offline-packetized-shadow"
    shadow_dir.mkdir(parents=True, exist_ok=True)
    summary_path = shadow_dir / "summary.json"
    if summary_path.exists():
        summary = json.loads(summary_path.read_text(encoding="utf-8"))
        if summary.get("failedProducts") == 0:
            return {
                "enabled": True,
                "status": "completed",
                "summaryPath": str(summary_path),
            }
    manifest_path = shadow_dir / "approved-manifest.json"
    manifest_path.write_text(json.dumps([
        {
            "artifactPath": item["artifactPath"],
            "company": item.get("company", ""),
            "productName": item.get("productName", ""),
        }
        for item in approved
    ], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    command = [
        sys.executable,
        str(Path(__file__).with_name("run_offline_packetized_shadow.py")),
        f"--manifest={manifest_path}",
        f"--output-dir={shadow_dir}",
        f"--packet-runner={args.offline_shadow_packet_runner}",
        f"--batch-runner={Path(__file__).resolve()}",
        f"--base-url={args.offline_shadow_base_url}",
        f"--model={args.offline_shadow_model}",
        f"--api-key={args.offline_shadow_api_key}",
        f"--max-active-generations={max(1, args.offline_shadow_max_active_generations)}",
        f"--timeout-ms={max(1000, args.offline_shadow_timeout_ms)}",
        f"--max-tokens={max(64, args.offline_shadow_max_tokens)}",
    ]
    stdout_path = shadow_dir / "coordinator.stdout.log"
    stderr_path = shadow_dir / "coordinator.stderr.log"
    try:
        with stdout_path.open("ab") as stdout, stderr_path.open("ab") as stderr:
            process = subprocess.Popen(
                command,
                stdout=stdout,
                stderr=stderr,
                start_new_session=True,
            )
    except OSError as error:
        receipt = {
            "enabled": True,
            "status": "launch_failed",
            "error": str(error),
            "command": command,
            "manifestPath": str(manifest_path),
            "summaryPath": str(summary_path),
            "reviewQueuePath": str(shadow_dir / "review-required.jsonl"),
        }
        (shadow_dir / "launch-receipt.json").write_text(
            json.dumps(receipt, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        return receipt
    receipt = {
        "enabled": True,
        "status": "launched",
        "pid": process.pid,
        "command": command,
        "manifestPath": str(manifest_path),
        "summaryPath": str(summary_path),
        "reviewQueuePath": str(shadow_dir / "review-required.jsonl"),
    }
    (shadow_dir / "launch-receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-path", type=Path, default=Path(".runtime/local/policy-ocr.sqlite"))
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--env-file", type=Path, default=Path(".env.local"))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--company", default="")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--offset", type=int, default=0)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--repair-rounds", type=int, default=3)
    parser.add_argument("--request-timeout-ms", type=int, default=300000)
    parser.add_argument("--max-output-tokens", type=int, default=65536)
    parser.add_argument("--max-prompt-candidate-chars", type=int, default=0)
    parser.add_argument("--max-prompt-skill-chars", type=int, default=0)
    parser.add_argument("--max-prompt-hint-chars", type=int, default=0)
    parser.add_argument("--provider", choices=["deepseek", "gemini", "openai-compatible"], default="")
    parser.add_argument("--model", default="")
    parser.add_argument("--base-url", default="")
    parser.add_argument("--shadow-base-url", default="")
    parser.add_argument("--shadow-model", default="")
    parser.add_argument("--shadow-api-key", default="")
    parser.add_argument("--shadow-timeout-ms", type=int, default=45000)
    parser.add_argument("--shadow-max-tokens", type=int, default=1024)
    parser.add_argument("--shadow-max-input-chars", type=int, default=10000)
    parser.add_argument("--shadow-routing", choices=["auto", "all", "off"], default="auto")
    parser.add_argument("--offline-packetized-shadow", action="store_true")
    parser.add_argument("--offline-shadow-packet-runner", type=Path)
    parser.add_argument("--offline-shadow-base-url", default="")
    parser.add_argument("--offline-shadow-model", default="")
    parser.add_argument("--offline-shadow-api-key", default="")
    parser.add_argument("--offline-shadow-max-active-generations", type=int, default=4)
    parser.add_argument("--offline-shadow-timeout-ms", type=int, default=90000)
    parser.add_argument("--offline-shadow-max-tokens", type=int, default=768)
    parser.add_argument("--retry-failure-class", action="append", default=[])
    parser.add_argument("--retry-failure-layer", choices=["model", "source", "validation", "pipeline"], action="append", default=[])
    parser.add_argument("--retry-manual", action="store_true")
    parser.add_argument("--parse-only", action="store_true")
    parser.add_argument("--plan-only", action="store_true")
    parser.add_argument(
        "--skip-published-source-digest-db-scan",
        action="store_true",
        help=(
            "Skip the full SQLite published-source-digest scan. Use only for an "
            "immutable coordinator manifest that already excluded published products."
        ),
    )
    args = parser.parse_args(argv)

    skill_dir = Path(__file__).resolve().parent.parent
    args.output_dir.mkdir(parents=True, exist_ok=True)
    products = load_manifest(args.manifest) if args.manifest else select_from_database(
        args.db_path,
        args.limit,
        args.company,
        args.offset,
    )
    (args.output_dir / "selected-products.json").write_text(json.dumps(products, ensure_ascii=False, indent=2), encoding="utf-8")
    if args.plan_only:
        print(json.dumps({"status": "planned", "products": len(products), "manifest": str(args.output_dir / 'selected-products.json')}, ensure_ascii=False))
        return 0

    env = load_env(args.env_file) if args.env_file.exists() else {}
    provider = args.provider or os.environ.get("RESPONSIBILITY_PARSE_PROVIDER") or env.get("RESPONSIBILITY_PARSE_PROVIDER") or "deepseek"
    provider_prefix = provider.replace("-", "_").upper()
    api_key = (
        os.environ.get("RESPONSIBILITY_PARSE_API_KEY")
        or env.get("RESPONSIBILITY_PARSE_API_KEY")
        or os.environ.get(f"{provider_prefix}_API_KEY")
        or env.get(f"{provider_prefix}_API_KEY")
        or (os.environ.get("GOOGLE_API_KEY") or env.get("GOOGLE_API_KEY") if provider == "gemini" else "")
    )
    if not api_key:
        print(f"API key is not configured for responsibility provider {provider}", file=sys.stderr)
        return 2
    base_url = (
        args.base_url
        or os.environ.get("RESPONSIBILITY_PARSE_BASE_URL")
        or env.get("RESPONSIBILITY_PARSE_BASE_URL")
        or os.environ.get(f"{provider_prefix}_BASE_URL")
        or env.get(f"{provider_prefix}_BASE_URL")
        or ""
    )
    default_models = {"deepseek": "deepseek-v4-flash", "gemini": "gemini-flash-latest"}
    model = (
        args.model
        or os.environ.get("RESPONSIBILITY_PARSE_MODEL")
        or env.get("RESPONSIBILITY_PARSE_MODEL")
        or os.environ.get(f"{provider_prefix}_MODEL")
        or env.get(f"{provider_prefix}_MODEL")
        or default_models.get(provider)
    )
    if not model:
        print(f"model is not configured for responsibility provider {provider}", file=sys.stderr)
        return 2
    shadow_base_url = (
        args.shadow_base_url
        or os.environ.get("RESPONSIBILITY_SHADOW_BASE_URL")
        or env.get("RESPONSIBILITY_SHADOW_BASE_URL")
        or ""
    )
    shadow_model = (
        args.shadow_model
        or os.environ.get("RESPONSIBILITY_SHADOW_MODEL")
        or env.get("RESPONSIBILITY_SHADOW_MODEL")
        or ""
    )
    if not args.offline_packetized_shadow and bool(shadow_base_url) != bool(shadow_model):
        print("--shadow-base-url and --shadow-model must be configured together", file=sys.stderr)
        return 2
    shadow_config = None
    if shadow_base_url and not args.offline_packetized_shadow:
        shadow_config = {
            "base_url": shadow_base_url,
            "model": shadow_model,
            "api_key": (
                args.shadow_api_key
                or os.environ.get("RESPONSIBILITY_SHADOW_API_KEY")
                or env.get("RESPONSIBILITY_SHADOW_API_KEY")
                or ""
            ),
            "timeout_ms": max(1000, args.shadow_timeout_ms),
            "max_tokens": max(64, args.shadow_max_tokens),
            "max_input_chars": max(1000, args.shadow_max_input_chars),
            "routing": args.shadow_routing,
        }
    skill_text = (skill_dir / "SKILL.md").read_text(encoding="utf-8")
    published_source_digests = (
        set()
        if args.skip_published_source_digest_db_scan
        else load_published_source_digests(args.db_path)
    )
    worker_args = {
        "skill_dir": skill_dir, "skill_text": skill_text, "api_key": api_key, "provider": provider,
        "base_url": base_url, "model": model,
        "shadow_config": shadow_config,
        "repair_rounds": args.repair_rounds,
        "request_timeout_ms": max(1000, args.request_timeout_ms),
        "max_output_tokens": max(256, args.max_output_tokens),
        "max_prompt_candidate_chars": max(0, args.max_prompt_candidate_chars),
        "max_prompt_skill_chars": max(0, args.max_prompt_skill_chars),
        "max_prompt_hint_chars": max(0, args.max_prompt_hint_chars),
        "run_dir": args.output_dir,
        "published_source_digests": published_source_digests,
        "retry_manual": args.retry_manual,
        "retry_failure_classes": set(args.retry_failure_class),
        "retry_failure_layers": set(args.retry_failure_layer),
    }
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        parsed = list(executor.map(lambda product: process_product(product, **worker_args), products))

    approved = [item for item in parsed if item.get("status") == "approved"]
    skipped = [item for item in parsed if item.get("status") == "skipped"]
    published = [item for item in parsed if item.get("status") == "published"]
    manual = [item for item in parsed if item.get("status") not in {"approved", "published", "skipped"}]
    backup_path = None
    if approved and not args.parse_only:
        existing_backups = sorted(args.output_dir.glob("development-db-before-batch-*.sqlite"))
        if existing_backups:
            backup_path = existing_backups[-1]
        else:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            backup_path = args.output_dir / f"development-db-before-batch-{stamp}.sqlite"
            create_batch_backup(args.db_path, backup_path)
        for item in approved:
            publication = publish_approved(skill_dir, args.db_path, backup_path, item)
            if publication.get("status") == "published":
                published.append(publication)
                result_path = Path(publication["artifactPath"]).parent / "result.json"
                result_path.write_text(json.dumps(publication, ensure_ascii=False, indent=2), encoding="utf-8")
            else:
                manual.append(publication)

    queue_paths = {
        "model": args.output_dir / "model-retry.jsonl",
        "source": args.output_dir / "source-retry.jsonl",
        "validation": args.output_dir / "validation-review.jsonl",
        "high_capability": args.output_dir / "high-capability-review.jsonl",
    }
    for path in [
        args.output_dir / "approved.jsonl", args.output_dir / "published.jsonl",
        args.output_dir / "manual-review.jsonl", args.output_dir / "skipped.jsonl",
        *queue_paths.values(),
    ]:
        path.write_text("", encoding="utf-8")
    for item in approved:
        json_line(args.output_dir / "approved.jsonl", item)
        if item.get("highCapabilityReviewRequired"):
            json_line(queue_paths["high_capability"], item)
    for item in published:
        json_line(args.output_dir / "published.jsonl", item)
    for item in manual:
        json_line(args.output_dir / "manual-review.jsonl", item)
        queue_path = queue_paths.get(item.get("failureLayer"))
        if queue_path:
            json_line(queue_path, item)
    for item in skipped:
        json_line(args.output_dir / "skipped.jsonl", item)
    failure_counts = {}
    for item in manual:
        failure_class = item.get("failureClass") or "unclassified"
        failure_counts[failure_class] = failure_counts.get(failure_class, 0) + 1
    summary = {
        "status": "completed", "selected": len(products), "approved": len(approved), "published": len(published),
        "parseOnly": args.parse_only, "provider": provider, "model": model,
        "shadow": {
            "enabled": bool(shadow_config),
            "model": shadow_model,
            "baseUrl": shadow_base_url,
            "timeoutMs": max(1000, args.shadow_timeout_ms) if shadow_config else 0,
            "maxInputChars": max(1000, args.shadow_max_input_chars) if shadow_config else 0,
        },
        "skipped": len(skipped), "manualReview": len(manual),
        "failureCounts": failure_counts,
        "highCapabilityReview": sum(
            1 for item in approved if item.get("highCapabilityReviewRequired")
        ),
        "backupPath": str(backup_path) if backup_path else "", "publishedPath": str(args.output_dir / "published.jsonl"),
        "skippedPath": str(args.output_dir / "skipped.jsonl"),
        "manualReviewPath": str(args.output_dir / "manual-review.jsonl"),
        "modelRetryPath": str(queue_paths["model"]),
        "sourceRetryPath": str(queue_paths["source"]),
        "validationReviewPath": str(queue_paths["validation"]),
        "highCapabilityReviewPath": str(queue_paths["high_capability"]),
    }
    summary["offlinePacketizedShadow"] = launch_offline_packetized_shadow(
        args,
        approved,
    )
    (args.output_dir / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
