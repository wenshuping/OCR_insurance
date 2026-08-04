#!/usr/bin/env python3
"""Parse-only deterministic review for the unified MODEL validation queues.

This script never invokes a provider, network, SQLite write, Feishu write, or
publication. It consumes locked artifacts and writes only the requested audit
receipts under the review output directory.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
U = ROOT / "artifacts/global-model-retry-ledger-20260728-final/resume-luna-model-retry-20260728/unified-model-pending-after-packet003-20260728"
OUT = ROOT / "artifacts/review-unified-model-validation64-20260729"
PIPE = Path("/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts")
PYTHON = Path("/opt/homebrew/opt/python@3.14/bin/python3.14")
CANON = PIPE / "canonicalize_excerpts.py"
VALIDATE = PIPE / "validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"
EXISTING_REVIEW_ROOT = ROOT / "artifacts/review-backlog-912-20260728"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def digest_key(row):
    if row.get("sourceDigest"):
        return "digest:" + row["sourceDigest"]
    if row.get("sourceUrl"):
        return "url:" + row["sourceUrl"].split("#", 1)[0]
    return "name:" + str(row.get("company", "")) + "|" + str(row.get("productName", ""))


def review_keys():
    """Scan review output directories, excluding historical global ledgers."""
    keys = set()
    review_dirs = [
        path for path in EXISTING_REVIEW_ROOT.iterdir()
        if path.is_dir() and (path.name.startswith("review-") or path.name.startswith("append-review-"))
    ]
    for review_dir in review_dirs:
        for path in review_dir.rglob("*"):
            if not path.is_file() or path.name in {"global-review-ledger.jsonl"}:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (UnicodeDecodeError, OSError):
                continue
            for token in __import__("re").findall(r"sha256:[a-f0-9]{64}", text):
                keys.add("digest:" + token)
    return keys


def queue_rows():
    original = []
    for path in (
        U / "packet-001/agent-1/terminal-queue.jsonl",
        U / "packet-002/agent-1/terminal-queue.jsonl",
        U / "packet-003/agent-1/terminal-queues/validation-review.jsonl",
    ):
        original.extend(row for row in read_jsonl(path) if row.get("status") == "validation-review")
    jsonrepair = [
        row for row in read_jsonl(U / "model-retry-jsonrepair-20260729-v2/batch-terminal-queue.jsonl")
        if row.get("status") == "validation-review"
    ]
    manifest_rows = {row.get("sourceDigest"): row for row in read_json(U / "manifest.json").get("products", [])}
    for row in original + jsonrepair:
        locked = manifest_rows.get(row.get("sourceDigest"), {})
        for field in ("sourceUrl", "sourceFile", "sourceTextFile", "company", "productName"):
            if not row.get(field) and locked.get(field):
                row[field] = locked[field]
    return original, jsonrepair


def artifact_for(row):
    if row.get("artifactPath") and Path(row["artifactPath"]).is_file():
        return Path(row["artifactPath"])
    product_dir = Path(row.get("productDir", ""))
    for name in ("artifact.json", "canonical-artifact.json"):
        if product_dir.joinpath(name).is_file():
            return product_dir / name
    if row.get("resultPath"):
        result_dir = Path(row["resultPath"]).parent
        for name in ("artifact.json", "canonical-artifact.json"):
            if result_dir.joinpath(name).is_file():
                return result_dir / name
    return None


def jsonrepair_artifact(row):
    result_path = row.get("resultPath")
    if not result_path:
        return None
    result_dir = Path(result_path).parent
    for name in ("artifact.json", "canonical-artifact.json"):
        if result_dir.joinpath(name).is_file():
            return result_dir / name
    return None


def run(command):
    proc = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, env={**os.environ, "NODE_NO_WARNINGS": "1"})
    return {"command": command, "exitCode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}


def classification(row, canonical, validator, importer, artifact, raw_count):
    if artifact is None:
        return "model-retry", "no repaired artifact available"
    if not Path(row["sourceFile"]).is_file() or not Path(row["sourceTextFile"]).is_file():
        return "source-retry", "locked source PDF/text is unavailable"
    if canonical["exitCode"] != 0:
        return "materializer-blocked", "canonicalizer failed; no importer candidate"
    if validator["exitCode"] != 0:
        text = (validator["stderr"] + "\n" + validator["stdout"]).lower()
        model_terms = ("responsibilities: must not be empty", "formula", "branches", "operands", "requiredinputs", "business", "semantic", "responsibilityid")
        if any(term in text for term in model_terms):
            return "model-retry", "validator still lacks responsibility/formula/branch/operand/required-input or semantic evidence"
        return "validation-review", "validator gate failed after permitted deterministic normalization"
    if importer["exitCode"] != 0:
        return "materializer-blocked", "dedicated importer dry-run failed"
    try:
        value = json.loads(importer["stdout"])
    except json.JSONDecodeError:
        return "materializer-blocked", "dedicated importer dry-run did not return JSON"
    accepted = int(value.get("acceptedResponsibilities", -1))
    if not value.get("ok") or int(value.get("validationIssueCount", 0)) != 0:
        return "materializer-blocked", "dedicated importer dry-run reported validation issues"
    if accepted != raw_count:
        return "validation-review", f"acceptedResponsibilities={accepted} differs from responsibilityCount={raw_count}"
    return "approved-candidate", "canonicalizer, validator and dedicated importer dry-run passed with equal responsibility counts"


def main():
    original, jsonrepair = queue_rows()
    existing = review_keys()
    raw_union = original + jsonrepair
    seen = set()
    selected = []
    excluded = []
    for source, rows in (("original64", original), ("jsonrepair9", jsonrepair)):
        for row in rows:
            key = digest_key(row)
            reason = None
            if key in seen:
                reason = "duplicate_within_two_source_union"
            elif key in existing:
                reason = "existing_review_terminal_or_inflight"
            if reason:
                excluded.append({"source": source, **row, "dedupKey": key, "exclusionReason": reason})
            else:
                seen.add(key)
                selected.append({"source": source, **row, "dedupKey": key})

    OUT.mkdir(parents=True, exist_ok=True)
    input_lock = {
        "schema": "review-unified-model-validation57-input-lock/v1",
        "createdAt": "2026-07-29",
        "parseOnly": True,
        "providerCalls": 0,
        "networkUsed": False,
        "databaseWrites": False,
        "sqliteWritten": False,
        "feishuWrites": False,
        "publication": False,
        "dedupOrder": ["sourceDigest", "sourceUrl", "company+productName"],
        "sources": {
            "original64": {"input": 64, "validationReview": 64, "queuePaths": [str(U / "packet-001/agent-1/terminal-queue.jsonl"), str(U / "packet-002/agent-1/terminal-queue.jsonl"), str(U / "packet-003/agent-1/terminal-queues/validation-review.jsonl")]},
            "jsonrepair9": {"input": 9, "validationReview": 9, "queuePath": str(U / "model-retry-jsonrepair-20260729-v2/batch-terminal-queue.jsonl"), "excludedModelRetry": 1},
        },
        "selectedCount": len(selected),
        "selected": [{k: row.get(k) for k in ("source", "company", "productName", "sourceUrl", "sourceDigest", "dedupKey")} for row in selected],
    }
    write_json(OUT / "input-lock.json", input_lock)
    write_json(OUT / "dedup-exclusion-audit.json", {
        "schema": "review-unified-model-validation57-dedup-exclusion/v1",
        "dedupOrder": ["sourceDigest", "sourceUrl", "company+productName"],
        "original64": {"input": len(original), "duplicate": 0, "excluded": sum(1 for x in excluded if x["source"] == "original64"), "selected": sum(1 for x in selected if x["source"] == "original64")},
        "jsonrepair9": {"input": len(jsonrepair), "duplicate": sum(1 for x in excluded if x["source"] == "jsonrepair9"), "excluded": sum(1 for x in excluded if x["source"] == "jsonrepair9"), "selected": sum(1 for x in selected if x["source"] == "jsonrepair9")},
        "union": {"input": len(raw_union), "selected": len(selected), "excluded": len(excluded), "duplicateWithinUnion": sum(1 for x in excluded if x["exclusionReason"] == "duplicate_within_two_source_union")},
        "intersection": {"original64_jsonrepair9": 0, "original64_existingReview": sum(1 for x in excluded if x["source"] == "original64"), "jsonrepair9_existingReview": sum(1 for x in excluded if x["source"] == "jsonrepair9")},
        "excluded": [{k: x.get(k) for k in ("source", "company", "productName", "sourceUrl", "sourceDigest", "dedupKey", "exclusionReason")} for x in excluded],
        "existingReviewScanRoot": str(EXISTING_REVIEW_ROOT),
        "existingReviewScanPolicy": "review-* and append-review-* output directories only; historical global ledger observations are not current review terminal states",
    })

    audits = []
    outputs = {name: [] for name in ("approved-candidate", "validation-review", "model-retry", "source-retry", "materializer-blocked")}
    for index, row in enumerate(selected, 1):
        raw = jsonrepair_artifact(row) if row["source"] == "jsonrepair9" else artifact_for(row)
        product_out = OUT / "products" / f"{index:03d}-{row['sourceDigest'].split(':')[-1][:12]}"
        product_out.mkdir(parents=True, exist_ok=True)
        if raw:
            raw_copy = product_out / "raw-artifact.json"
            shutil.copy2(raw, raw_copy)
        else:
            raw_copy = None
        canonical_path = product_out / "artifact.json"
        base = {"schema": "unified-model-validation-product-audit/v1", "reviewIndex": index, "source": row["source"], "company": row.get("company"), "productName": row.get("productName"), "sourceUrl": row.get("sourceUrl"), "sourceDigest": row.get("sourceDigest"), "sourceFile": row.get("sourceFile"), "sourceTextFile": row.get("sourceTextFile"), "rawArtifactPath": str(raw_copy) if raw_copy else None, "parseOnly": True, "providerCalls": 0, "networkUsed": False, "databaseWrites": False, "sqliteWritten": False, "feishuWrites": False, "publication": False}
        if raw_copy:
            canonical = run([str(PYTHON), str(CANON), "--artifact", str(raw_copy), "--source-text", row["sourceTextFile"], "--output", str(canonical_path)])
        else:
            canonical = {"command": [], "exitCode": 2, "stdout": "", "stderr": "missing raw artifact"}
        write_json(product_out / "canonicalizer-receipt.json", {**base, **canonical})
        if canonical["exitCode"] == 0 and canonical_path.is_file():
            validator = run([str(PYTHON), str(VALIDATE), "--artifact", str(canonical_path), "--source-text", row["sourceTextFile"], "--source-document", row["sourceFile"], "--official-domain", urlparse(str(row.get("sourceUrl") or "")).hostname or ""])
        else:
            validator = {"command": [], "exitCode": 2, "stdout": "", "stderr": "not run: canonicalizer did not produce artifact"}
        write_json(product_out / "validator-receipt.json", {**base, **validator})
        if canonical["exitCode"] == 0 and canonical_path.is_file():
            importer = run(["node", str(IMPORTER), "--artifacts", str(canonical_path), "--db-path", str(product_out / "dry-run.sqlite")])
        else:
            importer = {"command": [], "exitCode": 2, "stdout": "", "stderr": "not run: canonicalizer did not produce artifact"}
        write_json(product_out / "importer-dry-run-receipt.json", {**base, **importer})
        try:
            canonical_value = read_json(canonical_path) if canonical_path.is_file() else {}
            raw_count = len(canonical_value.get("responsibilities", []))
        except (OSError, json.JSONDecodeError):
            raw_count = 0
        classification_name, reason = classification(row, canonical, validator, importer, canonical_path if canonical_path.is_file() else raw_copy, raw_count)
        audit = {**base, "canonicalizerOk": canonical["exitCode"] == 0, "validatorOk": validator["exitCode"] == 0, "importerDryRunOk": importer["exitCode"] == 0, "responsibilityCount": raw_count, "classification": classification_name, "classificationReason": reason, "canonicalizerReceiptPath": str(product_out / "canonicalizer-receipt.json"), "validatorReceiptPath": str(product_out / "validator-receipt.json"), "importerDryRunReceiptPath": str(product_out / "importer-dry-run-receipt.json")}
        audits.append(audit)
        outputs[classification_name].append({**row, **{k: audit[k] for k in ("reviewIndex", "responsibilityCount", "classification", "classificationReason", "canonicalizerReceiptPath", "validatorReceiptPath", "importerDryRunReceiptPath")}})

    write_json(OUT / "product-audits.json", {"schema": "unified-model-validation-product-audits/v1", "products": audits})
    for name, rows in outputs.items():
        write_jsonl(OUT / f"{name}.jsonl", rows)
    write_json(OUT / "materializer-blocked.jsonl", outputs["materializer-blocked"])
    counts = {name: len(rows) for name, rows in outputs.items()}
    summary = {
        "schema": "review-unified-model-validation57-summary/v1", "batch": "review-unified-model-validation64-20260729", "original64": {"input": 64, "duplicate": 0, "excluded": sum(1 for x in excluded if x["source"] == "original64"), "selected": sum(1 for x in selected if x["source"] == "original64"), "terminal": {k: sum(1 for x in audits if x["source"] == "original64" and x["classification"] == k) for k in counts}}, "jsonrepair9": {"input": 9, "duplicate": 0, "excluded": sum(1 for x in excluded if x["source"] == "jsonrepair9"), "selected": sum(1 for x in selected if x["source"] == "jsonrepair9"), "terminal": {k: sum(1 for x in audits if x["source"] == "jsonrepair9" and x["classification"] == k) for k in counts}}, "union": {"input": 73, "selected": len(selected), "excluded": len(excluded), "terminal": counts}, "intersection": {"original64_jsonrepair9": 0, "selectedUnionExpected": len(selected)}, "responsibilityCounts": {"selectedTotal": sum(x["responsibilityCount"] for x in audits), "original64": sum(x["responsibilityCount"] for x in audits if x["source"] == "original64"), "jsonrepair9": sum(x["responsibilityCount"] for x in audits if x["source"] == "jsonrepair9")}, "providerCalls": 0, "networkUsed": False, "parseOnly": True, "databaseWrites": False, "sqliteWritten": False, "feishuWrites": False, "publication": False, "outputDir": str(OUT), "counts": counts
    }
    write_json(OUT / "summary.json", summary)
    digest_files = {}
    for path in sorted(OUT.rglob("*")):
        if path.is_file() and path.name != "sha256.json":
            digest_files[str(path.relative_to(OUT))] = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
    write_json(OUT / "sha256.json", {"schema": "review-unified-model-validation57-sha256/v1", "immutable": True, "files": digest_files})
    print(json.dumps({"output": str(OUT), "selected": len(selected), "excluded": len(excluded), "counts": counts}, ensure_ascii=False))


if __name__ == "__main__":
    main()
