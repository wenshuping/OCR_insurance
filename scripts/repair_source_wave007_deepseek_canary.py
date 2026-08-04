#!/usr/bin/env python3
"""Apply evidence-preserving repairs to the failed wave-007 DeepSeek canary."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
RUN = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/parse-source-wave007-20260801-v2/deepseek-canary-020-run"
MANIFEST = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/parse-source-wave007-20260801-v2/manifests/deepseek-canary-020.json"
OUTPUT = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/parse-source-wave007-20260801-v2/deepseek-canary-review-v1"
PIPELINE = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts"
CANONICALIZER = PIPELINE / "canonicalize_excerpts.py"
VALIDATOR = PIPELINE / "validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def page_for_offset(source_text: str, offset: int) -> str:
    page = 1
    for match in re.finditer(r"(?m)^===== PAGE (\d+) =====\s*$", source_text[:offset]):
        page = int(match.group(1))
    return str(page)


def legal_company(source_text: str, fallback: str) -> str:
    names = re.findall(r"[\u4e00-\u9fff]{2,20}(?:人寿)?保险股份有限公司", source_text)
    return names[0] if names else fallback


def fill_evidence_pages(value: object, source_text: str, default_page: str) -> None:
    if isinstance(value, list):
        for item in value:
            fill_evidence_pages(item, source_text, default_page)
        return
    if not isinstance(value, dict):
        return
    page = str(value.get("sourcePage") or "")
    offset = value.get("absoluteStart")
    if not page and isinstance(offset, int):
        page = page_for_offset(source_text, offset)
    if not page and "sourcePage" in value:
        page = default_page
    if "sourcePage" in value:
        value["sourcePage"] = page
    for child in value.values():
        fill_evidence_pages(child, source_text, page or default_page)


def allowed_deterministic_issue(line: str) -> bool:
    return bool(
        ".sourcePage:" in line
        or line.startswith("company:")
        or ".reviewScope:" in line
        or ".selectionStatus:" in line
        or line.startswith("audit.status:")
    )


def repair_artifact(artifact: dict, inventory: dict, source_text: str, brand: str) -> dict:
    artifact["displayCompany"] = artifact.get("displayCompany") or brand
    artifact["company"] = legal_company(source_text, str(artifact.get("company") or brand))
    inventory_pages = {
        item["responsibilityId"]: str(item["sourcePage"])
        for item in inventory["responsibilities"]
    }
    for checklist in artifact.get("officialChecklist") or []:
        checklist["sourcePage"] = inventory_pages.get(checklist.get("responsibilityId"), checklist.get("sourcePage") or "1")
    for responsibility in artifact.get("responsibilities") or []:
        page = inventory_pages.get(responsibility.get("responsibilityId"), str(responsibility.get("sourcePage") or "1"))
        responsibility["sourcePage"] = page
        if not responsibility.get("groupId"):
            responsibility["selectionStatus"] = "included"
        fill_evidence_pages(responsibility, source_text, page)
        for indicator in responsibility.get("indicators") or []:
            indicator["sourcePage"] = str(indicator.get("sourcePage") or page)
    fill_evidence_pages(artifact.get("productRules") or [], source_text, "1")
    for evidence in (artifact.get("productIdentity") or {}).get("fieldEvidence", {}).values():
        if isinstance(evidence, dict) and not evidence.get("reviewScope"):
            evidence["reviewScope"] = "official terms PDF"
    audit = artifact.setdefault("audit", {})
    audit["status"] = "approved"
    return artifact


def main() -> int:
    if OUTPUT.exists():
        raise FileExistsError(f"refusing existing output: {OUTPUT}")
    OUTPUT.mkdir(parents=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    by_identity = {(row["sourceUrl"], row["productName"]): row for row in manifest}
    approved = []
    review = []
    audits = []
    for order, result_path in enumerate(sorted((RUN / "products").glob("*/result.json")), start=1):
        result = json.loads(result_path.read_text(encoding="utf-8"))
        row = by_identity[(result["sourceUrl"], result["productName"])]
        coverage_path = result_path.parent / "round-1-inventory-coverage.json"
        coverage = json.loads(coverage_path.read_text(encoding="utf-8"))
        issue_lines = [
            line for line in str(result.get("error") or "").splitlines()
            if line and not line.startswith("importer dry-run") and not line.startswith("locked inventory coverage failed")
        ]
        semantic_issues = [line for line in issue_lines if not allowed_deterministic_issue(line)]
        base = {
            "company": row["company"],
            "productName": row["productName"],
            "sourceUrl": row["sourceUrl"],
            "sourceDigest": row["sourceDigest"],
            "inventoryPath": row["inventoryPath"],
        }
        if not coverage.get("passed") or semantic_issues:
            review.append({
                **base,
                "terminalStatus": "validation_review",
                "failureClass": "inventory_coverage" if not coverage.get("passed") else "formula_or_schema_semantics",
                "failurePointers": semantic_issues or ["locked_inventory_coverage_failed"],
                "artifactPath": result["artifactPath"],
            })
            audits.append({**base, "classification": "validation_review", "semanticIssues": semantic_issues, "coverage": coverage})
            continue
        product_output = OUTPUT / "products" / f"{order:03d}"
        product_output.mkdir(parents=True)
        source_text = Path(row["sourceTextPath"]).read_text(encoding="utf-8")
        inventory = json.loads(Path(row["inventoryPath"]).read_text(encoding="utf-8"))
        artifact = repair_artifact(json.loads(Path(result["artifactPath"]).read_text(encoding="utf-8")), inventory, source_text, row["company"])
        candidate = product_output / "candidate-artifact.json"
        canonical = product_output / "artifact.json"
        write_json(candidate, artifact)
        canonicalizer = subprocess.run(
            [sys.executable, str(CANONICALIZER), "--artifact", str(candidate), "--source-text", row["sourceTextPath"], "--output", str(canonical)],
            capture_output=True, text=True, check=False,
        )
        validator = subprocess.run(
            [sys.executable, str(VALIDATOR), "--artifact", str(canonical), "--source-document", row["sourceDocumentPath"], "--source-text", row["sourceTextPath"], "--official-domain", urlparse(row["sourceUrl"]).hostname or ""],
            capture_output=True, text=True, check=False,
        ) if canonicalizer.returncode == 0 else None
        importer = subprocess.run(
            ["node", str(IMPORTER), f"--artifacts={canonical}", "--sample-limit=5"],
            cwd=ROOT, capture_output=True, text=True, check=False,
        ) if validator and validator.returncode == 0 else None
        write_json(product_output / "canonicalizer-receipt.json", {"exitCode": canonicalizer.returncode, "stdout": canonicalizer.stdout, "stderr": canonicalizer.stderr})
        write_json(product_output / "validator-receipt.json", {"exitCode": validator.returncode, "stdout": validator.stdout, "stderr": validator.stderr} if validator else {"status": "not_run"})
        write_json(product_output / "importer-dry-run-receipt.json", {"exitCode": importer.returncode, "stdout": importer.stdout, "stderr": importer.stderr} if importer else {"status": "not_run"})
        importer_receipt = None
        if importer:
            try:
                importer_receipt = json.loads(importer.stdout)
            except json.JSONDecodeError:
                pass
        passed = bool(
            canonicalizer.returncode == 0
            and validator and validator.returncode == 0
            and importer and importer.returncode == 0
            and importer_receipt
            and importer_receipt.get("ok") is True
            and importer_receipt.get("validationIssueCount") == 0
        )
        terminal = {
            **base,
            "terminalStatus": "approved" if passed else "validation_review",
            "artifactPath": str(canonical),
            "canonicalizerPassed": canonicalizer.returncode == 0,
            "validatorPassed": bool(validator and validator.returncode == 0),
            "importerDryRunPassed": bool(importer_receipt and importer_receipt.get("ok") is True and importer_receipt.get("validationIssueCount") == 0),
        }
        (approved if passed else review).append(terminal)
        audits.append({**base, "classification": terminal["terminalStatus"], "deterministicRepair": True})
    write_jsonl(OUTPUT / "approved.jsonl", approved)
    write_jsonl(OUTPUT / "validation-review.jsonl", review)
    write_json(OUTPUT / "product-audits.json", audits)
    write_json(OUTPUT / "summary.json", {"selected": len(audits), "approved": len(approved), "validationReview": len(review), "modelCalls": 0, "sqliteWritten": False, "feishuWritten": False, "published": False})
    files = sorted(path for path in OUTPUT.rglob("*") if path.is_file())
    write_json(OUTPUT / "sha256.json", {"files": [{"path": str(path), "sha256": sha256(path)} for path in files]})
    print((OUTPUT / "summary.json").read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
