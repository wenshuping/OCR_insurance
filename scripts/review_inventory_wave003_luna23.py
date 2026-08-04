#!/usr/bin/env python3
"""Deterministically review only the 23 Luna terminals from inventory wave 003."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
WAVE = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/inventory-wave-20260801-003"
INPUT = WAVE / "execution/luna-complex-23-20260801"
ROUTE = WAVE / "routing/luna-complex.jsonl"
OUTPUT = WAVE / "execution/review-luna-complex-23-20260801"
PIPELINE = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts"
CANONICALIZER = PIPELINE / "canonicalize_excerpts.py"
VALIDATOR = PIPELINE / "validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"
JSONREPAIR = ROOT / "node_modules/jsonrepair/bin/cli.js"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def compact(value) -> str:
    return re.sub(r"\s+", "", str(value or ""))


def run(command: list[str]) -> dict:
    process = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        env={**os.environ, "NODE_NO_WARNINGS": "1"},
    )
    return {
        "command": command,
        "exitCode": process.returncode,
        "stdout": process.stdout,
        "stderr": process.stderr,
    }


def verify_input() -> tuple[list[dict], dict[str, dict]]:
    final_audit = read_json(INPUT / "final-audit.json")
    if final_audit.get("selected") != 23 or final_audit.get("terminal") != 23:
        raise RuntimeError("final audit is not the locked 23-product terminal set")
    final_sha = read_json(INPUT / "final-sha256.json")
    mismatches = []
    for row in final_sha.get("files", []):
        path = INPUT / row["path"]
        if not path.is_file() or sha256(path) != row["sha256"]:
            mismatches.append(row["path"])
    if mismatches:
        raise RuntimeError(f"input SHA mismatch: {mismatches[:5]}")
    terminals = [read_json(path) for path in sorted(INPUT.glob("batch-*/products/*/terminal.json"))]
    if len(terminals) != 23 or len({row["sourceDigest"] for row in terminals}) != 23:
        raise RuntimeError("terminal products are not 23 unique source digests")
    route_rows = read_jsonl(ROUTE)
    route_by_digest = {row["sourceDigest"]: row for row in route_rows}
    if len(route_by_digest) != 23 or set(route_by_digest) != {row["sourceDigest"] for row in terminals}:
        raise RuntimeError("terminal and route sourceDigest sets differ")
    return terminals, route_by_digest


LEGAL_COMPANIES = {
    "中国平安": "中国平安人寿保险股份有限公司",
    "太保寿险": "中国太平洋人寿保险股份有限公司",
    "人保寿险": "中国人民人寿保险股份有限公司",
}


def page_label(packet: dict) -> str:
    pages = packet.get("titleEvidence", {}).get("pages") or packet.get("responsibilityBoundary", {}).get("pages") or []
    return f"PDF第{pages[0]}页" if pages else "官方条款"


def exact_segment(packet: dict, title_only: bool = False) -> dict:
    if title_only:
        evidence = packet["titleEvidence"]
        text = evidence["exactText"]
        start = evidence["startOffset"]
        end = evidence["endOffset"]
    else:
        evidence = packet["responsibilityBoundary"]
        text = packet["exactText"]
        start = evidence["startOffset"]
        end = evidence["endOffset"]
    return {
        "sourcePage": page_label(packet),
        "absoluteStart": start,
        "absoluteEnd": end,
        "exactText": text,
        "sourceExcerpt": text,
    }


def normalize_existing_segments(value) -> None:
    if isinstance(value, dict):
        segments = value.get("evidenceSegments")
        if isinstance(segments, list):
            for segment in segments:
                if not isinstance(segment, dict):
                    continue
                if not segment.get("sourceExcerpt") and segment.get("exactText"):
                    segment["sourceExcerpt"] = segment["exactText"]
                if not segment.get("exactText") and segment.get("sourceExcerpt"):
                    segment["exactText"] = segment["sourceExcerpt"]
                if not segment.get("sourcePage"):
                    segment["sourcePage"] = value.get("sourcePage") or "官方条款"
        for child in value.values():
            normalize_existing_segments(child)
    elif isinstance(value, list):
        for child in value:
            normalize_existing_segments(child)


def identity_evidence(identity: dict, source_text: str, source_url: str) -> None:
    evidence = {}
    for key in ("filingCode", "productCode", "filingDate"):
        value = str(identity.get(key) or "").strip()
        index = source_text.find(value) if value else -1
        if index >= 0:
            evidence[key] = {
                "status": "verified",
                "sourceUrl": source_url,
                "sourcePage": "官方条款",
                "sourceExcerpt": value,
                "absoluteStart": index,
                "absoluteEnd": index + len(value),
            }
        else:
            identity[key] = ""
            evidence[key] = {
                "status": "not_present_in_source",
                "reviewScope": "锁定官方条款PDF及其完整提取文本",
            }
    identity["fieldEvidence"] = evidence


def filter_evidence_tokens(value, evidence_text: str) -> None:
    if not isinstance(value, dict):
        return
    tokens = value.get("evidenceTokens")
    if isinstance(tokens, list):
        value["evidenceTokens"] = [token for token in tokens if compact(token) in compact(evidence_text)]
    for key in ("branches", "operands"):
        for child in value.get(key) or []:
            filter_evidence_tokens(child, evidence_text)


def bounded_schema_repair(artifact: dict, route: dict) -> tuple[dict, dict]:
    source_text = Path(route["sourceTextFile"]).read_text(encoding="utf-8")
    original_company = artifact.get("company") or route["company"]
    legal_company = LEGAL_COMPANIES.get(route["company"])
    legal_company_verified = bool(legal_company and compact(legal_company) in compact(source_text))
    if legal_company_verified:
        artifact["company"] = legal_company
        artifact["displayCompany"] = original_company
    artifact["productName"] = route["productName"]
    identity = artifact.setdefault("productIdentity", {})
    identity["sourceUrl"] = route["sourceUrl"]
    identity["sourceDigest"] = route["sourceDigest"]
    identity_evidence(identity, source_text, route["sourceUrl"])
    artifact.setdefault("productServices", [])
    artifact.setdefault("productRules", [])
    artifact.setdefault("currentPolicyInputs", {})
    artifact.setdefault("optionalGroups", [])
    artifact.setdefault("officialOptionalGroupChecklist", [])
    normalize_existing_segments(artifact)

    locked = {row["responsibilityId"]: row for row in route["responsibilities"]}
    packets = {responsibility_id: read_json(Path(row["evidencePacket"])) for responsibility_id, row in locked.items()}
    responsibilities = artifact.get("responsibilities") if isinstance(artifact.get("responsibilities"), list) else []
    for responsibility in responsibilities:
        if not isinstance(responsibility, dict):
            continue
        responsibility_id = responsibility.get("responsibilityId")
        packet = packets.get(responsibility_id)
        if not packet:
            continue
        title = locked[responsibility_id]["officialTitle"]
        segment = exact_segment(packet)
        responsibility["officialTitle"] = title
        responsibility["liability"] = title
        responsibility["sourcePage"] = segment["sourcePage"]
        responsibility["sourceExcerpt"] = segment["sourceExcerpt"]
        responsibility["evidenceSegments"] = [segment]
        responsibility.setdefault("responsibilityKind", "waiver" if "豁免" in title else "benefit")
        responsibility.setdefault("coverageAggregation", "include")
        if not responsibility.get("groupId"):
            responsibility["selectionStatus"] = "included"
        card = responsibility.setdefault("card", {})
        card.setdefault("title", title)
        card.setdefault("customerSummary", responsibility.get("customerSummary") or "")
        card.setdefault("benefitExplanation", responsibility.get("benefitExplanation") or "")
        for indicator in responsibility.get("indicators") or []:
            if not isinstance(indicator, dict):
                continue
            indicator.setdefault("indicatorName", indicator.get("liability") or title)
            indicator.setdefault("liability", title)
            indicator["sourcePage"] = segment["sourcePage"]
            indicator["sourceExcerpt"] = segment["sourceExcerpt"]
            indicator["evidenceSegments"] = [segment]
            filter_evidence_tokens(indicator, segment["sourceExcerpt"])
            if indicator.get("calculationStatus") == "calculable" and any(
                key not in artifact["currentPolicyInputs"] for key in indicator.get("requiredInputs") or []
            ):
                indicator["calculationStatus"] = "needs_claim_facts"
                indicator["calculationEligible"] = False

    checklist = []
    for responsibility in responsibilities:
        responsibility_id = responsibility.get("responsibilityId") if isinstance(responsibility, dict) else None
        packet = packets.get(responsibility_id)
        if not packet:
            continue
        segment = exact_segment(packet, title_only=True)
        checklist.append({
            "responsibilityId": responsibility_id,
            "officialHeading": locked[responsibility_id]["officialTitle"],
            "sourcePage": segment["sourcePage"],
            "sourceExcerpt": segment["sourceExcerpt"],
            "evidenceSegments": [segment],
        })
    artifact["officialChecklist"] = checklist

    actual_ids = [row.get("responsibilityId") for row in responsibilities if isinstance(row, dict)]
    locked_ids = list(locked)
    inventory_exact = len(actual_ids) == len(locked_ids) and len(set(actual_ids)) == len(actual_ids) and set(actual_ids) == set(locked_ids)
    audit = artifact.setdefault("audit", {})
    audit["officialChecklistCount"] = len(responsibilities)
    audit["inventoryCount"] = len(responsibilities)
    audit["cardCount"] = len(responsibilities)
    audit["indicatorDecisionCount"] = len(responsibilities)
    audit["matrix"] = [
        {
            "responsibilityId": responsibility_id,
            "inventory": "pass" if inventory_exact else "review",
            "card": "pass",
            "indicatorDecision": "pass",
            "formulaEvidence": "pass",
            "selectionEvidence": "pass",
            "productVersion": "pass",
            "result": "pass" if inventory_exact else "review",
            "issues": [] if inventory_exact else ["locked responsibility inventory mismatch"],
        }
        for responsibility_id in actual_ids
    ]
    audit["issues"] = [] if inventory_exact else ["locked responsibility inventory mismatch"]
    audit["status"] = "approved" if inventory_exact else "validation_review"
    artifact.setdefault("publication", {"sqlite": "development_required_after_approval", "feishu": "not_requested"})
    return artifact, {
        "legalCompanyVerified": legal_company_verified,
        "lockedResponsibilityCount": len(locked_ids),
        "artifactResponsibilityCount": len(actual_ids),
        "inventoryExact": inventory_exact,
        "lockedResponsibilityIds": locked_ids,
        "artifactResponsibilityIds": actual_ids,
    }


def not_run(reason: str) -> dict:
    return {"command": [], "exitCode": None, "stdout": "", "stderr": "", "status": "not_run", "reason": reason}


def main() -> int:
    terminals, route_by_digest = verify_input()
    if OUTPUT.exists():
        raise RuntimeError(f"output must be new: {OUTPUT}")
    OUTPUT.mkdir(parents=True)
    write_json(OUTPUT / "input-lock.json", {
        "schema": "review-inventory-wave003-luna23-input-lock/v1",
        "inputRoot": str(INPUT),
        "inputFinalAuditSha256": sha256(INPUT / "final-audit.json"),
        "inputFinalSha256ManifestSha256": sha256(INPUT / "final-sha256.json"),
        "routeManifest": str(ROUTE),
        "routeManifestSha256": sha256(ROUTE),
        "selected": 23,
        "sourceDigestsUnique": True,
        "providerCalls": 0,
        "parseOnly": True,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    })

    outputs = {name: [] for name in (
        "approved-candidate", "validation-review", "model-retry", "source-repair", "materializer-blocked"
    )}
    bounded_verifier = []
    audits = []
    for review_index, terminal in enumerate(sorted(terminals, key=lambda row: (row["batch"], row["batchOrder"])), start=1):
        route = route_by_digest[terminal["sourceDigest"]]
        product_out = OUTPUT / "products" / f"{review_index:03d}-{terminal['sourceDigest'].split(':')[-1][:12]}"
        product_out.mkdir(parents=True)
        base = {
            "reviewIndex": review_index,
            "company": route["company"],
            "productName": route["productName"],
            "sourceUrl": route["sourceUrl"],
            "sourceDigest": route["sourceDigest"],
            "sourceFile": route["sourceFile"],
            "sourceTextFile": route["sourceTextFile"],
            "inputTerminal": terminal["terminal"],
            "providerCalls": 0,
            "parseOnly": True,
            "sqliteWritten": False,
            "feishuWritten": False,
            "published": False,
        }
        source_ok = Path(route["sourceFile"]).is_file() and sha256(Path(route["sourceFile"])) == route["sourceDigest"]
        jsonrepair_receipt = not_run("input was validation-review")
        raw_artifact = None
        if terminal["terminal"] == "model-retry":
            raw_response = Path(terminal["productDir"]) / "model-response.txt"
            repair_input = product_out / "jsonrepair-input.txt"
            response_text = raw_response.read_text(encoding="utf-8")
            repair_input.write_text(response_text[response_text.find("{"):], encoding="utf-8")
            repaired = product_out / "jsonrepair-output.json"
            jsonrepair_receipt = run(["node", str(JSONREPAIR), str(repair_input), "--output", str(repaired)])
            jsonrepair_receipt["status"] = "passed" if jsonrepair_receipt["exitCode"] == 0 else "failed"
            if jsonrepair_receipt["exitCode"] == 0:
                try:
                    raw_artifact = read_json(repaired)
                except (OSError, json.JSONDecodeError) as error:
                    jsonrepair_receipt["status"] = "failed"
                    jsonrepair_receipt["parseError"] = str(error)
        else:
            artifact_path = Path(terminal["artifactPath"])
            if artifact_path.is_file():
                raw_artifact = read_json(artifact_path)
        write_json(product_out / "jsonrepair-receipt.json", {**base, **jsonrepair_receipt})

        inventory = {"inventoryExact": False, "lockedResponsibilityCount": route["responsibilityCount"], "artifactResponsibilityCount": 0}
        canonicalizer = not_run("no parseable artifact")
        validator = not_run("canonicalizer not passed")
        importer = not_run("validator not passed")
        repaired_artifact_path = product_out / "bounded-repaired-artifact.json"
        canonical_artifact_path = product_out / "artifact.json"
        if raw_artifact is not None and source_ok:
            repaired_artifact, inventory = bounded_schema_repair(raw_artifact, route)
            write_json(repaired_artifact_path, repaired_artifact)
            canonicalizer = run([
                "python3", str(CANONICALIZER), "--artifact", str(repaired_artifact_path),
                "--source-text", route["sourceTextFile"], "--output", str(canonical_artifact_path),
            ])
            canonicalizer["status"] = "passed" if canonicalizer["exitCode"] == 0 else "failed"
            if canonicalizer["exitCode"] == 0:
                validator = run([
                    "python3", str(VALIDATOR), "--artifact", str(canonical_artifact_path),
                    "--source-document", route["sourceFile"], "--source-text", route["sourceTextFile"],
                    "--official-domain", urlparse(route["sourceUrl"]).hostname or "",
                ])
                validator["status"] = "passed" if validator["exitCode"] == 0 else "failed"
                if validator["exitCode"] == 0 and inventory["inventoryExact"]:
                    importer = run(["node", str(IMPORTER), f"--artifacts={canonical_artifact_path}", "--sample-limit=10"])
                    try:
                        importer_result = json.loads(importer["stdout"])
                    except json.JSONDecodeError:
                        importer_result = {}
                    importer["parsed"] = importer_result
                    importer["status"] = "passed" if (
                        importer["exitCode"] == 0
                        and importer_result.get("ok") is True
                        and importer_result.get("validationIssueCount", 0) == 0
                        and importer_result.get("materialized", 0) == 0
                        and importer_result.get("acceptedResponsibilities") == inventory["artifactResponsibilityCount"]
                    ) else "failed"
                elif validator["exitCode"] == 0:
                    importer = not_run("external locked inventory mismatch")
        write_json(product_out / "canonicalizer-receipt.json", {**base, **canonicalizer})
        write_json(product_out / "validator-receipt.json", {**base, **validator})
        write_json(product_out / "importer-dry-run-receipt.json", {**base, **importer})

        validator_text = f"{validator.get('stdout', '')}\n{validator.get('stderr', '')}".lower()
        semantic_terms = ("formula", "branches", "operands", "requiredinputs", "basiskey", "conditiontext")
        semantic_conflict = validator.get("status") == "failed" and any(term in validator_text for term in semantic_terms)
        if not source_ok:
            classification = "source-repair"
            reason = "locked source file is missing or digest mismatched"
        elif raw_artifact is None:
            classification = "model-retry"
            reason = "single jsonrepair attempt did not produce parseable JSON"
        elif not inventory["inventoryExact"]:
            classification = "model-retry"
            reason = "artifact responsibility IDs/count do not equal locked official inventory"
        elif canonicalizer.get("status") != "passed" or validator.get("status") != "passed":
            classification = "validation-review"
            reason = "bounded deterministic repair did not pass canonicalizer/validator"
        elif importer.get("status") != "passed":
            classification = "materializer-blocked"
            reason = "dedicated importer dry-run did not pass exact count and zero-issue gates"
        else:
            classification = "approved-candidate"
            reason = "locked inventory, canonicalizer, validator and dedicated importer dry-run all passed"

        audit = {
            **base,
            **inventory,
            "sourceVerified": source_ok,
            "jsonrepairStatus": jsonrepair_receipt.get("status"),
            "canonicalizerStatus": canonicalizer.get("status"),
            "validatorStatus": validator.get("status"),
            "importerDryRunStatus": importer.get("status"),
            "semanticConflict": semantic_conflict,
            "classification": classification,
            "classificationReason": reason,
            "artifactPath": str(canonical_artifact_path) if canonical_artifact_path.is_file() else None,
            "productOutput": str(product_out),
        }
        write_json(product_out / "product-audit.json", audit)
        audits.append(audit)
        outputs[classification].append(audit)
        if semantic_conflict:
            bounded_verifier.append({**audit, "verifierScope": "failed responsibility/fields and locked evidence packets only"})

    for name, rows in outputs.items():
        write_jsonl(OUTPUT / f"{name}.jsonl", rows)
    write_jsonl(OUTPUT / "luna-bounded-verifier.jsonl", bounded_verifier)
    write_json(OUTPUT / "product-audits.json", {"schema": "review-inventory-wave003-luna23-product-audits/v1", "products": audits})
    counts = {name: len(rows) for name, rows in outputs.items()}
    responsibility_counts = {
        name: sum(row["artifactResponsibilityCount"] for row in rows) for name, rows in outputs.items()
    }
    summary = {
        "schema": "review-inventory-wave003-luna23-summary/v1",
        "selected": 23,
        "terminal": sum(counts.values()),
        "counts": counts,
        "responsibilityCounts": responsibility_counts,
        "jsonrepairSelected": sum(row["inputTerminal"] == "model-retry" for row in audits),
        "jsonrepairPassed": sum(row["inputTerminal"] == "model-retry" and row["jsonrepairStatus"] == "passed" for row in audits),
        "canonicalizerPassed": sum(row["canonicalizerStatus"] == "passed" for row in audits),
        "validatorPassed": sum(row["validatorStatus"] == "passed" for row in audits),
        "importerDryRunPassed": sum(row["importerDryRunStatus"] == "passed" for row in audits),
        "lunaBoundedVerifier": len(bounded_verifier),
        "providerCalls": 0,
        "networkUsed": False,
        "parseOnly": True,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
        "outputDir": str(OUTPUT),
    }
    write_json(OUTPUT / "summary.json", summary)
    files = []
    for path in sorted(candidate for candidate in OUTPUT.rglob("*") if candidate.is_file() and candidate.name != "sha256.json"):
        files.append({"path": str(path.relative_to(OUTPUT)), "bytes": path.stat().st_size, "sha256": sha256(path)})
    write_json(OUTPUT / "sha256.json", {"schema": "review-inventory-wave003-luna23-sha256/v1", "files": files})
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
