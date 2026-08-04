#!/usr/bin/env python3
"""Audit review candidates without approving or importing them into production."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def jsonl(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def load(path: Path | None) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8")) if path and path.is_file() else {}


def stdout_json(value: Any) -> dict[str, Any]:
    if not isinstance(value, str):
        return {}
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return {}


def resolve(path_value: str | None, root: Path) -> Path | None:
    if not isinstance(path_value, (str, Path)) or not path_value:
        return None
    path = Path(path_value)
    return path if path.is_absolute() else root / path


def candidate_records(root: Path, receipt_paths: list[Path]):
    for receipt_path in receipt_paths:
        for record in jsonl(receipt_path):
            if not (record.get("status") == "approved-candidate" or record.get("category") == "approved-candidate" or record.get("classification") == "approved-candidate"):
                continue
            if "candidatePath" in record:
                candidate_root = Path(record["candidatePath"])
                artifact = next(
                    (candidate_root / name for name in ("repaired-artifact.json", "artifact.json", "canonicalized-artifact.json") if (candidate_root / name).is_file()),
                    candidate_root / "artifact.json",
                )
                source_pdf = Path(record["candidatePath"]) / "official-source.pdf"
                source_text = Path(record["candidatePath"]) / "official-source.pages.txt"
            elif record.get("artifact"):
                artifact = resolve(record.get("artifact"), root)
                source_pdf = resolve(record.get("officialSourceDocument"), root)
                source_text = resolve(record.get("officialSourceText"), root)
            else:
                artifact = resolve(record.get("candidateArtifactPath") or record.get("candidateArtifact"), root)
                source_pdf = resolve(record.get("officialSourceDocument"), root)
                source_text = resolve(record.get("officialSourceText"), root)
            yield record, artifact, source_pdf, source_text


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, action="append", required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--approved", type=Path, required=True)
    args = parser.parse_args()

    audits: list[dict[str, Any]] = []
    approved: list[dict[str, Any]] = []
    for record, artifact_path, source_pdf, source_text in candidate_records(args.root, args.receipt):
        artifact = load(artifact_path)
        identity = artifact.get("productIdentity") or {}
        digest = identity.get("sourceDigest") or record.get("sourceDigest") or ""
        responsibilities = artifact.get("responsibilities") or []
        official_checklist = artifact.get("officialChecklist") or []
        audit_block = artifact.get("audit") or {}
        matrix = audit_block.get("matrix") or []
        matrix_pass = bool(matrix) and all(
            all(item.get(key) == "pass" for key in ("inventory", "card", "indicatorDecision", "formulaEvidence", "selectionEvidence", "productVersion"))
            and item.get("result") == "pass" and not item.get("issues")
            for item in matrix
        )
        evidence_complete = all(
            item.get("sourcePage")
            and (item.get("sourceExcerpt") or item.get("evidenceSegments"))
            and all(segment.get("sourcePage") and segment.get("sourceExcerpt") for segment in item.get("evidenceSegments", []))
            for item in responsibilities
        )
        one_to_one = bool(responsibilities) and len(matrix) == len(responsibilities) == int(audit_block.get("indicatorDecisionCount", -1)) and len({item.get("responsibilityId") for item in matrix}) == len(responsibilities)
        numeric_coverage = matrix_pass and all(
            item.get("indicators") and all(
                indicator.get("formulaText") and indicator.get("normalizedFormula")
                and (indicator.get("evidenceTokens") or indicator.get("evidenceSegments"))
                for indicator in item.get("indicators", [])
            )
            for item in responsibilities
        )
        source_ready = bool(artifact_path and artifact_path.is_file() and source_pdf and source_pdf.is_file() and source_text and source_text.is_file())
        official_inventory = bool(responsibilities) and len(official_checklist) == len(responsibilities) == int(audit_block.get("inventoryCount", -1))
        validator = load(resolve(record.get("validatorReceipt") or (record.get("validatorGate") or {}).get("receipt"), args.root))
        validator_stdout = stdout_json(validator.get("stdout"))
        validator_ok = validator.get("exitCode") == 0 and (
            validator.get("status") == "passed" or validator_stdout.get("ok") is True
        )
        embedded_validator = record.get("validator") or record.get("validatorGate") or {}
        validator_ok = validator_ok or (
            embedded_validator.get("ok") is True
            and (embedded_validator.get("exitCode", 0) == 0 or embedded_validator.get("ran") is True)
        ) or (
            embedded_validator.get("exitCode") == 0
            and stdout_json(embedded_validator.get("stdout")).get("ok") is True
        )
        importer_ref = record.get("importerDryRun")
        if not isinstance(importer_ref, (str, dict)):
            importer_ref = (record.get("importerGate") or {}).get("receipt")
        importer = load(resolve(importer_ref if isinstance(importer_ref, str) else None, args.root))
        importer_stdout = importer_ref if isinstance(importer_ref, dict) else {}
        importer_json_stdout = stdout_json(importer.get("stdout"))
        importer_ok = importer.get("exitCode") == 0 and (
            (importer.get("dryRun") is True and importer.get("status") == "passed")
            or (importer_json_stdout.get("dryRun") is True and importer_json_stdout.get("ok") is True and importer_json_stdout.get("validationIssueCount") == 0)
        )
        importer_ok = importer_ok or (importer_stdout.get("ok") is True and importer_stdout.get("validationIssueCount") == 0)
        importer_ok = importer_ok or (
            importer_stdout.get("ok") is True
            and (importer_stdout.get("validationIssueCount") == 0 or importer_stdout.get("parsed", {}).get("validationIssueCount") == 0)
        )
        if not importer_ok and isinstance(importer_ref, dict):
            importer_ok = importer_ref.get("ok") is True and importer_ref.get("validationIssueCount") == 0
        checks = {
            "source_ready": source_ready,
            "sourceDigest": bool(isinstance(digest, str) and digest.startswith("sha256:") and len(digest) == 71),
            "official_inventory": official_inventory,
            "exact_evidence": evidence_complete and matrix_pass,
            "numeric_coverage": numeric_coverage,
            "responsibility_indicator_one_to_one": one_to_one,
            "validator_ok": validator_ok,
            "dedicated_importer_dry_run_ok_zero_issues": importer_ok,
        }
        audit = {
            "row": record.get("row") or record.get("packetRow"),
            "company": record.get("company") or artifact.get("company"),
            "productName": record.get("productName") or artifact.get("productName"),
            "dedupKey": record.get("dedupKey") or f"url:{identity.get('sourceUrl', '')}",
            "sourceUrl": identity.get("sourceUrl") or record.get("sourceUrl", ""),
            "sourceDigest": digest,
            "artifactPath": str(artifact_path) if artifact_path else None,
            "officialSourceDocument": str(source_pdf) if source_pdf else None,
            "officialSourceText": str(source_text) if source_text else None,
            "checks": checks,
            "allChecksPassed": all(checks.values()),
            "validatorReceipt": record.get("validatorReceipt"),
            "importerDryRun": record.get("importerDryRun"),
            "parseOnly": True,
            "databaseWrites": False,
            "feishuWrites": False,
            "published": False,
        }
        audits.append(audit)
        if audit["allChecksPassed"]:
            approved.append({
                "row": audit["row"], "company": audit["company"], "productName": audit["productName"],
                "dedupKey": audit["dedupKey"], "sourceUrl": audit["sourceUrl"], "sourceDigest": audit["sourceDigest"],
                "artifactPath": audit["artifactPath"], "officialSourceDocument": audit["officialSourceDocument"],
                "officialSourceText": audit["officialSourceText"], "status": "approved-candidate-audit-pass",
                "productionApproved": False, "parseOnly": True,
            })

    args.audit.parent.mkdir(parents=True, exist_ok=True)
    args.audit.write_text(json.dumps({
        "task": "REVIEW_BACKLOG_912", "batch": "batch-001", "candidateCount": len(audits),
        "approvedAuditPassCount": len(approved), "failedCount": len(audits) - len(approved),
        "allCandidatesAudited": bool(audits), "audits": audits,
        "productionApproval": False, "parseOnly": True, "databaseWrites": False,
        "feishuWrites": False, "published": False,
    }, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    with args.approved.open("w", encoding="utf-8") as handle:
        for item in approved:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
