#!/usr/bin/env python3
"""Run only Luna stable entries 50..99 from window-1 using local sources."""

from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse


ARCHIVE = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
INPUT = ARCHIVE / "artifacts/responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/window-1.json"
OUTPUT = ARCHIVE / "artifacts/responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/run-window-11/luna-run-1-50-99"
LOCAL_GEMINI = OUTPUT.parent / "gemini-run-1/products"
SOURCE_REPAIR = ARCHIVE / "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/sources"
PIPELINE = ARCHIVE / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline"
FAST = ARCHIVE / ".agents/skills/ocr-insurance-fast-responsibility-pipeline"
VALIDATOR = PIPELINE / "scripts/validate_artifact.py"
CANONICALIZER = PIPELINE / "scripts/canonicalize_excerpts.py"
MERGE_RULES = ARCHIVE / ".agents/skills/ocr-insurance-responsibility-merge/references/formula-rule-packs.md"
QUALITY_GATES = FAST / "references/quality-gates.md"
EXTRACTION_CONTRACT = FAST / "references/extraction-contract.md"
MODEL = "gpt-5.6-luna"
PROVIDER = "codex"
MAX_WORKERS = 2


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_jsonl(path: Path, value: object) -> None:
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False) + "\n")


def safe_name(value: object) -> str:
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", str(value or ""))
    value = re.sub(r"\s+", "-", value).strip(".-")
    return value[:120] or "product"


def norm(value: object) -> str:
    value = str(value or "").lower()
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]", "", value)


def meta() -> dict:
    return {
        "provider": PROVIDER,
        "modelId": MODEL,
        "parseOnly": True,
        "databaseWrites": False,
        "sqliteWritten": False,
        "feishuWrites": False,
        "feishuWritten": False,
        "publication": False,
    }


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


def load_items() -> list[dict]:
    data = json.loads(INPUT.read_text(encoding="utf-8"))
    items = [row for row in data if isinstance(row, dict) and row.get("route") == "luna_review"]
    if len(items) != 100:
        raise RuntimeError(f"expected 100 luna_review entries in window-1, got {len(items)}")
    selected = items[50:100]
    if len(selected) != 50:
        raise RuntimeError(f"expected 50 selected entries, got {len(selected)}")
    return selected


def source_index(items: list[dict]) -> dict[tuple[str, str], dict]:
    index: dict[tuple[str, str], dict] = {}
    target_keys = {(norm(item.get("company")), norm(item.get("productName"))) for item in items}
    for manifest in SOURCE_REPAIR.glob("*/source-manifest.json"):
        try:
            value = json.loads(manifest.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        pdf = Path(value.get("sourceFile") or "")
        pages = Path(value.get("extractedTextFile") or value.get("responsibilityTextFile") or "")
        if value.get("sourceStatus") == "source_ready" and pdf.is_file() and pages.is_file():
            index[(norm(value.get("company")), norm(value.get("productName")))] = {
                "pdf": pdf,
                "pages": pages,
                "manifest": manifest,
                "sourceDigest": value.get("sourceDigest"),
            }
    for product_dir in LOCAL_GEMINI.glob("*"):
        pdf = product_dir / "official-source.pdf"
        pages = product_dir / "official-source.pages.txt"
        if not (pdf.is_file() and pages.is_file()):
            continue
        name = norm(product_dir.name)
        for company, product in target_keys:
            if company in name and product in name:
                index[(company, product)] = {"pdf": pdf, "pages": pages, "manifest": None}
    return index


def historical_approved() -> dict[tuple[str, str, str], dict]:
    index: dict[tuple[str, str, str], dict] = {}
    root = ARCHIVE / "artifacts/responsibility-bulk-dual-pool-20260727"
    for path in root.glob("**/approved.jsonl"):
        try:
            lines = path.read_text(encoding="utf-8", errors="ignore").splitlines()
        except OSError:
            continue
        for line in lines:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("status") != "approved":
                continue
            artifact_path = Path(row.get("artifactPath") or "")
            artifact: dict = {}
            if artifact_path.is_file():
                try:
                    artifact = json.loads(artifact_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
            company = artifact.get("company") or artifact.get("displayCompany") or row.get("company")
            product = artifact.get("productName") or row.get("productName")
            digest = (artifact.get("productIdentity") or {}).get("sourceDigest") or row.get("sourceDigest")
            if company and product and digest and artifact_path.is_file():
                index[(str(company), str(product), str(digest))] = {"row": row, "artifactPath": str(artifact_path)}
    return index


def copy_source(source: dict, product_dir: Path) -> str:
    pdf = product_dir / "official-source.pdf"
    pages = product_dir / "official-source.pages.txt"
    shutil.copy2(source["pdf"], pdf)
    shutil.copy2(source["pages"], pages)
    digest = "sha256:" + hashlib.sha256(pdf.read_bytes()).hexdigest()
    expected = source.get("sourceDigest")
    if expected and expected != digest:
        raise RuntimeError(f"source digest mismatch: expected={expected} actual={digest}")
    return digest


def source_digest_receipt(item: dict, product_dir: Path, digest: str | None, source: dict | None, status: str, error: str = "") -> None:
    value = {
        **meta(),
        "status": status,
        "company": item.get("company"),
        "productName": item.get("productName"),
        "sourceUrl": item.get("sourceUrl"),
        "officialDomain": item.get("officialDomain") or urlparse(item.get("sourceUrl", "")).hostname,
        "sourceDigest": digest,
        "sourceDocumentPath": str(product_dir / "official-source.pdf") if (product_dir / "official-source.pdf").is_file() else "",
        "sourceTextPath": str(product_dir / "official-source.pages.txt") if (product_dir / "official-source.pages.txt").is_file() else "",
    }
    if source and source.get("manifest"):
        value["sourceManifestPath"] = str(source["manifest"])
    if error:
        value["error"] = error[-20000:]
    write_json(product_dir / "sourceDigest.json", value)


def parse_model_json(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    start = raw.find("{")
    if start < 0:
        raise ValueError("Luna response did not contain a JSON object")
    value, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not isinstance(value, dict):
        raise ValueError("Luna response root was not an object")
    return value


def prompt_for(item: dict, product_dir: Path, digest: str, error: str = "") -> str:
    repair = f"\nPrevious validator output:\n{error[-18000:]}\nReturn a complete replacement object repairing every issue.\n" if error else ""
    return f"""You are GPT-5.6 Luna running directly through Codex for one fixed insurance product. You are the only model permitted. Do not call Gemini, DianJin, any OpenAI-compatible endpoint, the network, or another model. Read local files only. Do not write files. Return exactly one complete JSON object and no Markdown or explanation.

Read and follow these local instructions and schemas:
- {FAST / 'SKILL.md'}
- {QUALITY_GATES}
- {EXTRACTION_CONTRACT}
- {MERGE_RULES}
- {VALIDATOR}

Product: company={item.get('company')}; productName={item.get('productName')}; officialDomain={item.get('officialDomain')}; sourceUrl={item.get('sourceUrl')}; sourceDigest={digest}
Official PDF: {product_dir / 'official-source.pdf'}
Official page text: {product_dir / 'official-source.pages.txt'}

Read the complete local page text and rebuild the complete official responsibility inventory from the actual source. Keep independently named responsibilities separate. Preserve every condition, branch, table row, percentage, multiplier, cap, deductible, waiting-period consequence, reimbursement rule, payment count, interval, mutual exclusion, deduction, and termination effect. Do not use the manifest hint as evidence. Do not invent identity fields; use empty values with status not_present_in_source when unproven.

Use the validator modern schema: company/displayCompany/productName/productIdentity/productOverview/productServices/productRules/currentPolicyInputs/optionalGroups/officialOptionalGroupChecklist/officialChecklist/responsibilities/audit/publication. Every responsibility needs responsibilityId, liability, groupId, parentResponsibilityId, responsibilityKind, coverageAggregation, selectionStatus, triggerCondition, insurerObligation, importantLimits, ruleRefs, sourcePage, sourceExcerpt, evidenceSegments, card, and indicators. Quantitative indicators need formulaText, normalizedFormula, basisKey, calculationKey, calculationStatus, calculationEligible, calculationReason, requiredInputs, ruleRefs, sourcePage, evidenceTokens, basisDefinition, branches, operands, and evidenceSegments as applicable. Every sourceExcerpt/evidenceSegments value must be an exact contiguous substring of the local page text and include sourcePage; do not join pages or use ellipses. Keep customerSummary free of internal audit vocabulary. Set publication.sqlite=development_required_after_approval and publication.feishu=not_requested.

Recall-only hint (never evidence):
{str(item.get('existingResponsibilityHint') or '')[:8000]}
{repair}"""


def call_luna(prompt: str, raw: Path, log: Path) -> dict:
    command = ["codex", "exec", "--model", MODEL, "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "-C", str(ARCHIVE), "-o", str(raw), "-"]
    with log.open("w", encoding="utf-8") as handle:
        completed = subprocess.run(command, input=prompt, text=True, stdout=handle, stderr=subprocess.STDOUT, timeout=1800)
    if completed.returncode != 0:
        raise RuntimeError(f"codex Luna exited with {completed.returncode}; see {log}")
    return parse_model_json(raw)


def validate(item: dict, product_dir: Path, digest: str, round_number: int) -> tuple[bool, str]:
    raw = product_dir / f"round-{round_number}-raw-artifact.json"
    canonical = product_dir / f"round-{round_number}-canonical.json"
    canon_cmd = [sys.executable, str(CANONICALIZER), "--artifact", str(raw), "--source-text", str(product_dir / "official-source.pages.txt"), "--output", str(canonical)]
    canon = subprocess.run(canon_cmd, capture_output=True, text=True)
    write_json(product_dir / f"canonicalize-receipt-round-{round_number}.json", {**meta(), "sourceDigest": digest, "command": canon_cmd, "exitCode": canon.returncode, "stdout": canon.stdout, "stderr": canon.stderr})
    if canon.returncode != 0:
        return False, "canonicalizer: " + (canon.stderr or canon.stdout)
    shutil.copy2(canonical, product_dir / "artifact.json")
    validator_cmd = [sys.executable, str(VALIDATOR), "--artifact", str(product_dir / "artifact.json"), "--source-document", str(product_dir / "official-source.pdf"), "--source-text", str(product_dir / "official-source.pages.txt"), "--official-domain", item.get("officialDomain") or (urlparse(item.get("sourceUrl", "")).hostname or "")]
    result = subprocess.run(validator_cmd, capture_output=True, text=True)
    approved = result.returncode == 0 and '"status": "approved"' in result.stdout
    write_json(product_dir / "validator-receipt.json", {**meta(), "sourceDigest": digest, "command": validator_cmd, "exitCode": result.returncode, "stdout": result.stdout, "stderr": result.stderr, "round": round_number, "status": "approved" if approved else "rejected"})
    return approved, result.stderr or result.stdout


def result_row(item: dict, product_dir: Path, digest: str | None, status: str, attempts: int, error: str = "") -> dict:
    row = {**meta(), "status": status, "company": item.get("company"), "productName": item.get("productName"), "sourceUrl": item.get("sourceUrl"), "sourceDigest": digest, "route": "luna_review", "windowIndex": item.get("_windowIndex"), "productDir": str(product_dir), "artifactPath": str(product_dir / "artifact.json") if (product_dir / "artifact.json").is_file() else "", "resultPath": str(product_dir / "result.json"), "evidencePath": str(product_dir / "evidence.json"), "validatorReceiptPath": str(product_dir / "validator-receipt.json"), "sourceDigestPath": str(product_dir / "sourceDigest.json"), "attempts": attempts}
    if (product_dir / "artifact.json").is_file():
        try:
            artifact = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8"))
            row["responsibilityCount"] = len(artifact.get("responsibilities") or [])
            row["artifactSha256"] = "sha256:" + hashlib.sha256((product_dir / "artifact.json").read_bytes()).hexdigest()
        except (OSError, json.JSONDecodeError):
            pass
    if error:
        row["error"] = error[-20000:]
    return row


def process(index: int, item: dict, sources: dict, approved: dict) -> dict:
    item = {**item, "_windowIndex": index}
    product_dir = OUTPUT / "products" / f"{safe_name(item.get('company'))}-{safe_name(item.get('productName'))}-{hashlib.sha256(item['sourceUrl'].encode()).hexdigest()[:12]}"
    product_dir.mkdir(parents=True, exist_ok=True)
    source = sources.get((norm(item.get("company")), norm(item.get("productName"))))
    digest: str | None = None
    attempts = 0
    try:
        if not source:
            error = "no local official-source.pdf and official-source.pages.txt available for this product"
            source_digest_receipt(item, product_dir, None, None, "source-retry", error)
            write_json(product_dir / "validator-receipt.json", {**meta(), "sourceDigest": None, "status": "not_run", "failureLayer": "source-retry", "error": error})
            write_json(product_dir / "evidence.json", {**meta(), "status": "source-retry", "sourceDigest": None, "excerpts": [], "error": error})
            row = result_row(item, product_dir, None, "source-retry", attempts, error)
            write_json(product_dir / "result.json", row)
            return row
        attempts = 1
        digest = copy_source(source, product_dir)
        source_digest_receipt(item, product_dir, digest, source, "source_ready")
        previous = approved.get((str(item.get("company")), str(item.get("productName")), digest))
        if previous:
            shutil.copy2(previous["artifactPath"], product_dir / "artifact.json")
            write_json(product_dir / "validator-receipt.json", {**meta(), "sourceDigest": digest, "status": "approved", "reused": True, "historicalApprovedPath": previous["artifactPath"]})
            artifact = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8"))
            write_json(product_dir / "evidence.json", {**meta(), "status": "skipped-existing", "sourceDigest": digest, "historicalApprovedPath": previous["artifactPath"], "excerpts": excerpt_rows(artifact)})
            row = result_row(item, product_dir, digest, "skipped-existing", 0, "trusted historical approved matched company+productName+sourceDigest")
            row["historicalApprovedPath"] = previous["artifactPath"]
            write_json(product_dir / "result.json", row)
            return row
        for round_number in (1, 2):
            if round_number == 1:
                artifact = call_luna(prompt_for(item, product_dir, digest), product_dir / "round-1-model-response.txt", product_dir / "codex-round-1.log")
            else:
                previous_error = json.loads((product_dir / "validator-receipt.json").read_text(encoding="utf-8")).get("stderr", "")
                attempts = 2
                artifact = call_luna(prompt_for(item, product_dir, digest, previous_error), product_dir / "round-2-model-response.txt", product_dir / "codex-round-2.log")
            write_json(product_dir / f"round-{round_number}-raw-artifact.json", artifact)
            ok, detail = validate(item, product_dir, digest, round_number)
            if ok:
                value = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8"))
                write_json(product_dir / "evidence.json", {**meta(), "status": "approved", "sourceDigest": digest, "sourceDocumentPath": str(product_dir / "official-source.pdf"), "sourceTextPath": str(product_dir / "official-source.pages.txt"), "excerpts": excerpt_rows(value)})
                row = result_row(item, product_dir, digest, "approved", attempts)
                write_json(product_dir / "result.json", row)
                return row
            if round_number == 2:
                error = detail
                value = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8")) if (product_dir / "artifact.json").is_file() else {}
                write_json(product_dir / "evidence.json", {**meta(), "status": "validation-review", "sourceDigest": digest, "excerpts": excerpt_rows(value), "error": error[-20000:]})
                row = result_row(item, product_dir, digest, "validation-review", attempts, error)
                write_json(product_dir / "result.json", row)
                return row
        raise RuntimeError("unreachable")
    except Exception as exc:
        status = "source-retry" if digest is None else "model-retry"
        error = str(exc)
        source_digest_receipt(item, product_dir, digest, source, status, error)
        write_json(product_dir / "validator-receipt.json", {**meta(), "sourceDigest": digest, "status": "not_run", "failureLayer": status, "error": error})
        write_json(product_dir / "evidence.json", {**meta(), "status": status, "sourceDigest": digest, "excerpts": [], "error": error})
        row = result_row(item, product_dir, digest, status, attempts, error)
        write_json(product_dir / "result.json", row)
        return row


def main() -> int:
    items = load_items()
    for index, item in enumerate(items, 50):
        item["_windowIndex"] = index
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write_json(OUTPUT / "manifest.json", {"inputManifest": str(INPUT), "scope": "rolling-wave-next-20260727/window-1/route=luna_review/stable-index=50..99", "selected": items, **meta()})
    for name in ("approved", "validation-review", "model-retry", "source-retry", "skipped-existing"):
        (OUTPUT / f"{name}.jsonl").touch()
    sources = source_index(items)
    approved = historical_approved()
    started = time.time()
    rows: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(process, index, item, sources, approved): (index, item) for index, item in enumerate(items, 50)}
        for future in concurrent.futures.as_completed(futures):
            index, item = futures[future]
            row = future.result()
            rows.append(row)
            print(json.dumps({"windowIndex": index, "productName": item.get("productName"), "status": row.get("status"), "sourceDigest": row.get("sourceDigest"), "error": str(row.get("error", ""))[-300:]}, ensure_ascii=False), flush=True)
    from collections import Counter
    for row in rows:
        append_jsonl(OUTPUT / f"{row['status']}.jsonl", row)
    counts = dict(Counter(row.get("status") for row in rows))
    summary = {"status": "completed", "scope": "rolling-wave-next-20260727/window-1/route=luna_review/stable-index=50..99", "inputManifest": str(INPUT), "outputDir": str(OUTPUT), "selected": 50, "processed": len(rows), "counts": counts, **meta(), "elapsedSeconds": round(time.time() - started, 2), "products": sorted([{k: row.get(k) for k in ("windowIndex", "company", "productName", "status", "sourceDigest", "resultPath")} for row in rows], key=lambda x: x["windowIndex"])}
    write_json(OUTPUT / "summary.json", summary)
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
