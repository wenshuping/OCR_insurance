#!/usr/bin/env python3
"""Parse-only executor for FIRST_PARSE_EXECUTE_300 Luna shard-1.

The two input manifests and the immutable ledger are read-only.  Sources are
read only from the paths recorded in the selected rows; no acquisition or
network fallback is performed.
"""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import time
from pathlib import Path
from typing import Any


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
BACKLOG = ROOT / "artifacts/first-parse-backlog-920-20260728"
BATCH_002 = BACKLOG / "batches/batch-002.json"
BATCH_003 = BACKLOG / "batches/batch-003.json"
OUTPUT = BACKLOG / "execution/luna-shard-1"
PIPELINE = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline"
CANONICALIZER = PIPELINE / "scripts/canonicalize_excerpts.py"
VALIDATOR = PIPELINE / "scripts/validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"
READ_ONLY_DB = ROOT / ".runtime/local/policy-ocr.sqlite"
MODEL = "gpt-5.6-luna"
PROVIDER = "codex"
TERMINAL = ("approved", "validation-review", "model-retry", "source-retry", "manual-review", "skipped")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_name(value: object) -> str:
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", str(value or ""))
    return re.sub(r"\s+", "-", value).strip(".-")[:120] or "product"


def meta() -> dict[str, Any]:
    return {
        "provider": PROVIDER,
        "modelId": MODEL,
        "parseOnly": True,
        "databaseWrites": False,
        "sqliteWritten": False,
        "feishuWrites": False,
        "publication": False,
    }


def file_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load_rows() -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    batch = json.loads(BATCH_002.read_text(encoding="utf-8"))
    rows.extend({**row, "manifest": str(BATCH_002), "manifestIndex": index} for index, row in enumerate(batch["products"]) if row.get("route") == "luna")
    batch = json.loads(BATCH_003.read_text(encoding="utf-8"))
    rows.extend({**row, "manifest": str(BATCH_003), "manifestIndex": index} for index, row in enumerate(batch["products"][:23]))
    if len(rows) != 39:
        raise RuntimeError(f"selected {len(rows)} products, expected 39")
    if len({row.get("sourceDigest") for row in rows}) != len(rows):
        raise RuntimeError("selected manifests contain duplicate source digests")
    return rows


def prompt_for(row: dict[str, Any], product_dir: Path) -> str:
    return f"""You are {MODEL}, executing one fixed parse-only insurance product through Codex.
Do not call any network, browser, Gemini, DianJin, Feishu, SQLite, or other model.
Do not write files. Read only the local official source files listed below, and read
the complete source text before answering. Do not use any old artifact or manifest
as evidence. Return exactly one complete JSON object and no Markdown or commentary.

Read these local instruction files before parsing:
- {ROOT / '.agents/skills/ocr-insurance-fast-responsibility-pipeline/SKILL.md'}
- {ROOT / '.agents/skills/ocr-insurance-fast-responsibility-pipeline/references/extraction-contract.md'}
- {ROOT / '.agents/skills/ocr-insurance-fast-responsibility-pipeline/references/high-throughput-batch.md'}
- {ROOT / '.agents/skills/ocr-insurance-fast-responsibility-pipeline/references/quality-gates.md'}
- {ROOT / '.agents/skills/ocr-insurance-responsibility-merge/references/formula-rule-packs.md'}

Product: company={row.get('company')}; productName={row.get('productName')}
Locked sourceDigest: {row.get('sourceDigest')}
sourceDocumentPath: {row.get('sourceDocumentPath')}
sourceTextPath: {row.get('sourceTextPath')}
The sourceTextPath is the authoritative extracted text for exact evidence. Read it
fully. The PDF is the official source document for version/source verification.

Rebuild the complete official responsibility inventory. Preserve separately named
responsibilities; retain all conditions, branches, tables, numbers, formulas,
percentages, multipliers, caps, deductibles, waiting periods, reimbursement rules,
counts, intervals, exclusions that affect responsibility, and termination effects.
Every responsibility must have exactly one indicator and every indicator exactly one
responsibility. Evidence must be exact, contiguous, same-page source text with
sourcePage; never paraphrase, use ellipses, or join pages. Use the modern schema:
company, displayCompany, productName, productIdentity, productOverview,
productServices, productRules, currentPolicyInputs, optionalGroups,
officialOptionalGroupChecklist, officialChecklist, responsibilities, audit,
publication. Each responsibility needs responsibilityId, liability, groupId,
parentResponsibilityId, responsibilityKind, coverageAggregation, selectionStatus,
triggerCondition, insurerObligation, importantLimits, ruleRefs, sourcePage,
sourceExcerpt, evidenceSegments, card, indicators. Each indicator needs the
calculation/evidence fields required by the extraction contract. Unknown values are
omitted; unsupported calculations use manual_formula with canonical requiredInputs.
Customer wording must contain no internal audit vocabulary. Set publication.sqlite=
development_required_after_approval and publication.feishu=not_requested.

The output will be canonicalized and deterministically validated, so do not invent
offsets or excerpts. Return only the complete JSON object.
"""


def call_luna(prompt: str, raw_path: Path, log_path: Path) -> dict[str, Any]:
    command = ["codex", "exec", "--model", MODEL, "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "-C", str(ROOT), "-o", str(raw_path), "-"]
    with log_path.open("w", encoding="utf-8") as log:
        run = subprocess.run(command, input=prompt, text=True, stdout=log, stderr=subprocess.STDOUT, timeout=1800, check=False)
    if run.returncode != 0:
        raise RuntimeError(f"Codex Luna exited with {run.returncode}; see {log_path}")
    raw = raw_path.read_text(encoding="utf-8")
    start = raw.find("{")
    if start < 0:
        raise ValueError("Luna response did not contain JSON")
    value, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not isinstance(value, dict):
        raise ValueError("Luna response root was not an object")
    return value


def receipt_base(row: dict[str, Any], status: str) -> dict[str, Any]:
    return {**meta(), "status": status, "terminalStatus": status, "company": row.get("company"), "productName": row.get("productName"), "sourceDigest": row.get("sourceDigest"), "manifest": row.get("manifest"), "manifestIndex": row.get("manifestIndex")}


def excerpt_rows(value: object, path: str = "artifact") -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key == "sourceExcerpt" and isinstance(child, str) and child.strip():
                found.append({"path": child_path, "sourcePage": value.get("sourcePage"), "sourceExcerpt": child})
            else:
                found.extend(excerpt_rows(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found.extend(excerpt_rows(child, f"{path}[{index}]"))
    return found


def result(row: dict[str, Any], product_dir: Path, status: str, **extra: Any) -> dict[str, Any]:
    value = {**receipt_base(row, status), "productDir": str(product_dir), "artifactPath": str(product_dir / "artifact.json"), "resultPath": str(product_dir / "result.json"), "sourceDigestPath": str(product_dir / "sourceDigest.json"), "evidencePath": str(product_dir / "evidence"), "validatorReceiptPath": str(product_dir / "validator-receipt.json"), "importerDryRunReceiptPath": str(product_dir / "importer-dry-run-receipt.json")}
    value.update(extra)
    return value


def not_run_importer(row: dict[str, Any], reason: str) -> dict[str, Any]:
    return {**receipt_base(row, "not_run"), "status": "not_run", "reason": reason, "writeFlagUsed": False, "databaseWrites": False}


def process(row: dict[str, Any]) -> dict[str, Any]:
    product_dir = OUTPUT / "products" / f"{safe_name(row.get('company'))}-{safe_name(row.get('productName'))}-{row.get('sourceDigest', '').split(':')[-1][:12]}"
    evidence_dir = product_dir / "evidence"
    product_dir.mkdir(parents=True, exist_ok=True)
    existing_result = product_dir / "result.json"
    if existing_result.is_file():
        value = json.loads(existing_result.read_text(encoding="utf-8"))
        if value.get("status") in TERMINAL:
            return value
    source_text = Path(row.get("sourceTextPath", ""))
    source_document = Path(row.get("sourceDocumentPath", ""))
    expected = row.get("sourceDigest")
    base_artifact = {"company": row.get("company"), "productName": row.get("productName"), "productIdentity": {"sourceDigest": expected}, "responsibilities": [], "audit": {"parseOnly": True, "status": "not_completed"}, "publication": {"sqlite": "development_required_after_approval", "feishu": "not_requested"}}
    try:
        if not source_text.is_file() or not source_document.is_file():
            raise FileNotFoundError(f"missing sourceTextPath/sourceDocumentPath: {source_text} / {source_document}")
        actual = file_digest(source_document)
        if expected and actual != expected:
            raise ValueError(f"source digest mismatch expected={expected} actual={actual}")
        source_digest = {**receipt_base(row, "source_ready"), "sourceDigest": actual, "sourceTextPath": str(source_text), "sourceDocumentPath": str(source_document), "sourceTextBytes": source_text.stat().st_size, "sourceDocumentBytes": source_document.stat().st_size, "networkUsed": False}
        write_json(product_dir / "sourceDigest.json", source_digest)
        artifact = call_luna(prompt_for(row, product_dir), product_dir / "round-1-model-response.txt", product_dir / "codex-round-1.log")
        write_json(product_dir / "round-1-raw-artifact.json", artifact)
        canonical_cmd = ["python3", str(CANONICALIZER), "--artifact", str(product_dir / "round-1-raw-artifact.json"), "--source-text", str(source_text), "--output", str(product_dir / "artifact.json")]
        canonical = subprocess.run(canonical_cmd, capture_output=True, text=True, check=False)
        write_json(product_dir / "canonicalizer-receipt.json", {**receipt_base(row, "completed" if canonical.returncode == 0 else "failed"), "command": canonical_cmd, "exitCode": canonical.returncode, "stdout": canonical.stdout, "stderr": canonical.stderr})
        if canonical.returncode != 0:
            raise ValueError("canonicalizer failed: " + (canonical.stderr or canonical.stdout)[-6000:])
        validator_cmd = ["python3", str(VALIDATOR), "--artifact", str(product_dir / "artifact.json"), "--source-text", str(source_text), "--source-document", str(source_document), "--official-domain", "www.soochowlife.net"]
        validator = subprocess.run(validator_cmd, capture_output=True, text=True, check=False)
        approved = validator.returncode == 0 and '"status": "approved"' in validator.stdout
        write_json(product_dir / "validator-receipt.json", {**receipt_base(row, "approved" if approved else "rejected"), "command": validator_cmd, "exitCode": validator.returncode, "stdout": validator.stdout, "stderr": validator.stderr})
        value = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8"))
        evidence_dir.mkdir(exist_ok=True)
        write_json(evidence_dir / "evidence.json", {**receipt_base(row, "approved" if approved else "validation-review"), "sourceTextPath": str(source_text), "sourceDigest": actual, "excerpts": excerpt_rows(value)})
        if not approved:
            write_json(product_dir / "importer-dry-run-receipt.json", not_run_importer(row, "validator_not_approved"))
            row_result = result(row, product_dir, "validation-review", failureClass="artifact_validation_failed")
            write_json(product_dir / "result.json", row_result)
            return row_result
        before = file_digest(READ_ONLY_DB) if READ_ONLY_DB.is_file() else None
        importer_cmd = ["node", str(IMPORTER), f"--artifacts={product_dir / 'artifact.json'}", f"--db-path={READ_ONLY_DB}"]
        importer = subprocess.run(importer_cmd, capture_output=True, text=True, check=False)
        try:
            importer_value = json.loads(importer.stdout)
        except json.JSONDecodeError:
            importer_value = {}
        after = file_digest(READ_ONLY_DB) if READ_ONLY_DB.is_file() else None
        importer_ok = importer.returncode == 0 and importer_value.get("ok") is True and importer_value.get("dryRun") is True and importer_value.get("validationIssueCount") == 0 and before == after
        importer_receipt = {**receipt_base(row, "passed" if importer_ok else "failed"), "command": importer_cmd, "exitCode": importer.returncode, "result": importer_value, "writeFlagUsed": False, "databaseWrites": False, "dbDigestBefore": before, "dbDigestAfter": after, "databaseUnchanged": before == after}
        write_json(product_dir / "importer-dry-run-receipt.json", importer_receipt)
        status = "approved" if importer_ok else "validation-review"
        row_result = result(row, product_dir, status, responsibilityCount=len(value.get("responsibilities", [])), **({} if importer_ok else {"failureClass": "importer_dry_run_failed"}))
        write_json(product_dir / "result.json", row_result)
        return row_result
    except FileNotFoundError as error:
        write_json(product_dir / "artifact.json", base_artifact)
        write_json(product_dir / "sourceDigest.json", {**receipt_base(row, "source-retry"), "sourceDigest": expected, "error": str(error), "networkUsed": False})
        write_json(product_dir / "validator-receipt.json", {**receipt_base(row, "not_run"), "status": "not_run", "failureLayer": "source-retry", "error": str(error)})
        write_json(product_dir / "importer-dry-run-receipt.json", not_run_importer(row, "source_not_ready"))
        evidence_dir.mkdir(exist_ok=True)
        write_json(evidence_dir / "evidence.json", {**receipt_base(row, "source-retry"), "excerpts": [], "error": str(error)})
        row_result = result(row, product_dir, "source-retry", error=str(error))
        write_json(product_dir / "result.json", row_result)
        return row_result
    except Exception as error:
        write_json(product_dir / "artifact.json", base_artifact)
        write_json(product_dir / "sourceDigest.json", {**receipt_base(row, "model-retry"), "sourceDigest": expected, "error": f"{type(error).__name__}: {error}", "networkUsed": False})
        write_json(product_dir / "validator-receipt.json", {**receipt_base(row, "not_run"), "status": "not_run", "failureLayer": "model-retry", "error": f"{type(error).__name__}: {error}"})
        write_json(product_dir / "importer-dry-run-receipt.json", not_run_importer(row, "model_or_canonicalizer_not_ready"))
        evidence_dir.mkdir(exist_ok=True)
        write_json(evidence_dir / "evidence.json", {**receipt_base(row, "model-retry"), "excerpts": [], "error": f"{type(error).__name__}: {error}"})
        row_result = result(row, product_dir, "model-retry", error=f"{type(error).__name__}: {error}")
        write_json(product_dir / "result.json", row_result)
        return row_result


def main() -> int:
    rows = load_rows()
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write_json(OUTPUT / "selection.json", {**meta(), "selected": 39, "sourceManifests": [str(BATCH_002), str(BATCH_003)], "rules": ["batch-002 route=luna", "batch-003 products[0:23]"]})
    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(process, rows))
    results.sort(key=lambda item: (item.get("manifest", ""), item.get("manifestIndex", 0)))
    for status in TERMINAL:
        (OUTPUT / f"{status}.jsonl").write_text("\n".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) for item in results if item.get("status") == status) + ("\n" if any(item.get("status") == status for item in results) else ""), encoding="utf-8")
    counts = {status: sum(item.get("status") == status for item in results) for status in TERMINAL}
    write_json(OUTPUT / "validator-receipts.jsonl", "")
    with (OUTPUT / "validator-receipts.jsonl").open("w", encoding="utf-8") as handle:
        for item in results:
            handle.write(json.dumps({"productName": item.get("productName"), "validatorReceiptPath": item.get("validatorReceiptPath"), "status": item.get("status")}, ensure_ascii=False) + "\n")
    with (OUTPUT / "importer-dry-run-receipts.jsonl").open("w", encoding="utf-8") as handle:
        for item in results:
            handle.write(json.dumps({"productName": item.get("productName"), "importerDryRunReceiptPath": item.get("importerDryRunReceiptPath"), "status": item.get("status")}, ensure_ascii=False) + "\n")
    summary = {**meta(), "status": "completed", "scope": "FIRST_PARSE_EXECUTE_300/luna-shard-1", "selected": len(rows), "processed": len(results), "counts": counts, "elapsedSeconds": round(time.time() - started, 2), "outputDir": str(OUTPUT), "networkUsed": False, "sqliteWritten": False}
    write_json(OUTPUT / "summary.json", summary)
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
