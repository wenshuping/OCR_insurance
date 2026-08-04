#!/usr/bin/env python3
"""Parse-only execution for batch-003.json products[62:100]."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
MANIFEST = ROOT / "artifacts/first-parse-backlog-920-20260728/batches/batch-003.json"
OUTPUT = ROOT / "artifacts/first-parse-backlog-920-20260728/execution/luna-shard-3"
PIPELINE = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline"
CANONICALIZER = PIPELINE / "scripts/canonicalize_excerpts.py"
VALIDATOR = PIPELINE / "scripts/validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"
FAST_SKILL = ROOT / ".agents/skills/ocr-insurance-fast-responsibility-pipeline/SKILL.md"
CONTRACT = FAST_SKILL.parent / "references/extraction-contract.md"
QUALITY = FAST_SKILL.parent / "references/quality-gates.md"
THROUGHPUT = FAST_SKILL.parent / "references/high-throughput-batch.md"
MODEL = "gpt-5.6-luna"
PROVIDER = "codex"
WORKERS = 4
ALLOWED = {"approved", "validation-review", "model-retry", "source-retry", "manual-review", "skipped"}


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_name(value: str) -> str:
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", str(value or ""))
    value = re.sub(r"\s+", "-", value).strip(".-")
    return value[:120] or "product"


def meta() -> dict:
    return {"provider": PROVIDER, "modelId": MODEL, "parseOnly": True, "parse_only": True,
            "databaseWrites": False, "sqliteWritten": False, "feishuWrites": False,
            "feishuWritten": False, "publication": False}


def product_dir(item: dict) -> Path:
    short = hashlib.sha256(str(item["sourceUrl"]).encode()).hexdigest()[:12]
    return OUTPUT / "products" / f"{safe_name(item.get('company'))}-{safe_name(item.get('productName'))}-{short}"


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def excerpt_rows(value: object, path: str = "artifact") -> list[dict]:
    rows: list[dict] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            if key == "sourceExcerpt" and isinstance(child, str) and child.strip():
                rows.append({"path": child_path, "sourcePage": value.get("sourcePage"), "sourceExcerpt": child})
            else:
                rows.extend(excerpt_rows(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            rows.extend(excerpt_rows(child, f"{path}[{index}]"))
    return rows


def prompt(item: dict, out: Path, source_digest: str) -> str:
    return f"""You are GPT-5.6 Luna, the sole model for one fixed insurance product in a parse-only batch. Read local files only; do not call Gemini, DianJin, any endpoint, or the network, and do not write files. Return exactly one complete valid JSON object, no Markdown or commentary.

Read these instructions fully before extraction: {FAST_SKILL}, {CONTRACT}, {QUALITY}, {THROUGHPUT}, and {VALIDATOR}={VALIDATOR}.

Product company={item.get('company')}; productName={item.get('productName')}; officialUrl={item.get('sourceUrl')}; sourceDigest={source_digest}.
Read the complete official source text at {item['sourceTextPath']} and the source PDF at {item['sourceDocumentPath']}. Build the official responsibility inventory from this source, preserving separately named responsibilities, all conditions, exclusions affecting the obligation, waiting periods, limits, deductions, formulas, max/min operands, numeric/table branches, and continuation pages. Do not use any other product or prior artifact as evidence.

Return the modern unified artifact schema with company/displayCompany/productName/productIdentity/productOverview/productServices/productRules/currentPolicyInputs/optionalGroups/officialOptionalGroupChecklist/officialChecklist/responsibilities/audit/publication. Each responsibility must have responsibilityId, liability, groupId, parentResponsibilityId, responsibilityKind, coverageAggregation, selectionStatus, triggerCondition, insurerObligation, importantLimits, ruleRefs, sourcePage, sourceExcerpt, evidenceSegments, card, and indicators. Each indicator must correspond one-to-one with its responsibility and preserve formulaText, normalizedFormula, basisKey, calculationKey, calculationStatus, calculationEligible, calculationReason, requiredInputs, ruleRefs, sourcePage, evidenceTokens, basisDefinition, branches, operands, and evidenceSegments as applicable. Every evidence excerpt must be exact contiguous text from the official source and include page/offset data where the schema supports it. Remove extraction markers from final excerpts. Customer wording must not contain internal audit vocabulary. Set publication.sqlite=development_required_after_approval and publication.feishu=not_requested.

The following manifest fields are metadata only and never evidence: {json.dumps({k: item.get(k) for k in ('company','productName','sourceDigest','sourceUrl','sourceDocumentPath','sourceTextPath')}, ensure_ascii=False)}
"""


def parse_json(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    start = raw.find("{")
    if start < 0:
        raise ValueError("model response has no JSON object")
    value, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not isinstance(value, dict):
        raise ValueError("model response root is not an object")
    return value


def model_call(item: dict, out: Path, source_digest: str) -> dict:
    raw = out / "model-response.txt"
    log = out / "model-call.log"
    command = ["codex", "exec", "--model", MODEL, "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "-C", str(ROOT), "-o", str(raw), "-"]
    with log.open("w", encoding="utf-8") as handle:
        result = subprocess.run(command, input=prompt(item, out, source_digest), text=True, stdout=handle, stderr=subprocess.STDOUT, timeout=3600, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"codex exited {result.returncode}")
    return parse_json(raw)


def receipt(out: Path, source_digest: str, name: str, command: list[str], run: subprocess.CompletedProcess, status: str) -> None:
    write_json(out / name, {**meta(), "sourceDigest": source_digest, "command": command, "exitCode": run.returncode, "stdout": run.stdout, "stderr": run.stderr, "status": status})


def run_gates(item: dict, out: Path, source_digest: str) -> tuple[str, str]:
    raw_artifact = out / "raw-artifact.json"
    canonical = out / "canonical-artifact.json"
    canonical_command = [sys.executable, str(CANONICALIZER), "--artifact", str(raw_artifact), "--source-text", item["sourceTextPath"], "--output", str(canonical)]
    can = subprocess.run(canonical_command, capture_output=True, text=True, check=False)
    receipt(out, source_digest, "canonicalizer-receipt.json", canonical_command, can, "passed" if can.returncode == 0 else "failed")
    if can.returncode != 0:
        return "validation-review", can.stderr or can.stdout
    (out / "artifact.json").write_text(canonical.read_text(encoding="utf-8"), encoding="utf-8")
    validator_command = [sys.executable, str(VALIDATOR), "--artifact", str(out / "artifact.json"), "--source-document", item["sourceDocumentPath"], "--source-text", item["sourceTextPath"], "--official-domain", (item.get("officialDomain") or urlparse(item["sourceUrl"]).hostname or "")]
    val = subprocess.run(validator_command, capture_output=True, text=True, check=False)
    status = "approved" if val.returncode == 0 and '"status": "approved"' in val.stdout else "rejected"
    receipt(out, source_digest, "validator-receipt.json", validator_command, val, status)
    if status != "approved":
        return "validation-review", val.stderr or val.stdout
    importer_command = ["node", str(IMPORTER), f"--artifacts={out / 'artifact.json'}", "--sample-limit=10"]
    imp = subprocess.run(importer_command, capture_output=True, text=True, check=False, cwd=ROOT)
    imp_status = "passed"
    try:
        imp_json = json.loads(imp.stdout)
        if not imp_json.get("ok") or imp_json.get("validationIssueCount", 0) != 0:
            imp_status = "failed"
    except json.JSONDecodeError:
        imp_status = "failed"
    receipt(out, source_digest, "importer-dry-run-receipt.json", importer_command, imp, imp_status)
    if imp_status != "passed":
        return "validation-review", imp.stderr or imp.stdout
    return "approved", ""


def run_one(index: int, item: dict) -> dict:
    out = product_dir(item)
    out.mkdir(parents=True, exist_ok=True)
    source_pdf = Path(item["sourceDocumentPath"])
    source_text = Path(item["sourceTextPath"])
    base = {**meta(), "index": index, "company": item.get("company"), "productName": item.get("productName"), "sourceUrl": item.get("sourceUrl"), "sourceDocumentPath": str(source_pdf), "sourceTextPath": str(source_text), "productDir": str(out)}
    try:
        if not source_pdf.is_file() or not source_text.is_file():
            raise FileNotFoundError("manifest source path missing")
        actual_digest = digest(source_pdf)
        expected = str(item.get("sourceDigest") or "")
        if expected and actual_digest != expected:
            raise ValueError(f"source digest mismatch: expected {expected}, actual {actual_digest}")
        source_digest = actual_digest
        write_json(out / "sourceDigest.json", {**base, "sourceDigest": source_digest, "expectedSourceDigest": expected, "verified": True})
        artifact = model_call(item, out, source_digest)
        write_json(out / "raw-artifact.json", artifact)
        status, error = run_gates(item, out, source_digest)
        value = json.loads((out / "artifact.json").read_text(encoding="utf-8")) if (out / "artifact.json").exists() else {}
        write_json(out / "evidence.json", {**base, "sourceDigest": source_digest, "status": status, "excerpts": excerpt_rows(value), **({"error": error[-20000:]} if error else {})})
        result = {**base, "sourceDigest": source_digest, "status": status, "artifactPath": str(out / "artifact.json"), "resultPath": str(out / "result.json"), "validatorReceiptPath": str(out / "validator-receipt.json"), "importerDryRunReceiptPath": str(out / "importer-dry-run-receipt.json"), "responsibilityCount": len(value.get("responsibilities") or []), "error": error}
    except FileNotFoundError as exc:
        source_digest = ""
        write_json(out / "sourceDigest.json", {**base, "sourceDigest": None, "status": "source-retry", "error": str(exc)})
        write_json(out / "validator-receipt.json", {**meta(), "status": "not_run", "failureLayer": "source-retry", "error": str(exc)})
        write_json(out / "importer-dry-run-receipt.json", {**meta(), "status": "not_run", "reason": "source-retry"})
        write_json(out / "evidence.json", {**base, "status": "source-retry", "excerpts": [], "error": str(exc)})
        result = {**base, "sourceDigest": None, "status": "source-retry", "error": str(exc)}
    except Exception as exc:
        source_digest = locals().get("source_digest", "")
        status = "model-retry" if (out / "sourceDigest.json").exists() else "source-retry"
        write_json(out / "validator-receipt.json", {**meta(), "sourceDigest": source_digest or None, "status": "not_run", "failureLayer": status, "error": str(exc)})
        write_json(out / "importer-dry-run-receipt.json", {**meta(), "sourceDigest": source_digest or None, "status": "not_run", "reason": status})
        write_json(out / "evidence.json", {**base, "sourceDigest": source_digest or None, "status": status, "excerpts": [], "error": str(exc)})
        result = {**base, "sourceDigest": source_digest or None, "status": status, "error": str(exc)}
    if result["status"] not in ALLOWED:
        raise RuntimeError(f"illegal terminal status: {result['status']}")
    write_json(out / "result.json", result)
    return result


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    items = manifest["products"][62:100]
    if len(items) != 38:
        raise RuntimeError(f"expected 38 products, got {len(items)}")
    if any(item.get("status") != "unprocessed" for item in items):
        raise RuntimeError("selected products are not all unprocessed")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    started = time.time()
    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(run_one, index + 62, item): item for index, item in enumerate(items)}
        for future in concurrent.futures.as_completed(futures):
            row = future.result()
            results.append(row)
            print(json.dumps({"index": row["index"], "productName": row["productName"], "status": row["status"]}, ensure_ascii=False), flush=True)
    results.sort(key=lambda row: row["index"])
    terminal = OUTPUT / "terminal.jsonl"
    terminal.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in results), encoding="utf-8")
    counts = {status: sum(row["status"] == status for row in results) for status in sorted(ALLOWED)}
    summary = {**meta(), "status": "completed", "scope": "batch-003.json products[62..99]", "inputManifest": str(MANIFEST), "outputDir": str(OUTPUT), "selected": 38, "counts": counts, "elapsedSeconds": round(time.time() - started, 2), "terminalJsonl": str(terminal)}
    write_json(OUTPUT / "summary.json", summary)
    write_json(OUTPUT / "validator-receipts.jsonl", "")
    write_json(OUTPUT / "importer-dry-run-receipts.jsonl", "")
    (OUTPUT / "validator-receipts.jsonl").write_text("".join(json.dumps(json.loads((product_dir(item) / "validator-receipt.json").read_text()), ensure_ascii=False) + "\n" for item in items), encoding="utf-8")
    (OUTPUT / "importer-dry-run-receipts.jsonl").write_text("".join(json.dumps(json.loads((product_dir(item) / "importer-dry-run-receipt.json").read_text()), ensure_ascii=False) + "\n" for item in items), encoding="utf-8")
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
