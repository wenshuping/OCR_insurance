#!/usr/bin/env python3
"""Run the fixed window-4 shard-3 through direct Codex Luna, parse-only."""

from __future__ import annotations

import concurrent.futures
import hashlib
import html
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen

from pypdf import PdfReader


INPUT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/"
    "run-window-4/luna-shards/shard-3.json"
)
OUTPUT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/"
    "run-window-4/luna-shard-3"
)
PIPELINE = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/"
    "dev-agent-semantic-integration/.agents/skills/"
    "ocr-insurance-product-responsibility-pipeline"
)
SCRIPTS = PIPELINE / "scripts"
CANONICALIZER = SCRIPTS / "canonicalize_excerpts.py"
VALIDATOR = SCRIPTS / "validate_artifact.py"
FORMULA_RULES = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/.agents/skills/"
    "ocr-insurance-responsibility-merge/references/formula-rule-packs.md"
)
FAST_SKILL = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/.agents/skills/"
    "ocr-insurance-fast-responsibility-pipeline/SKILL.md"
)
QUALITY_GATES = FAST_SKILL.parent / "references/quality-gates.md"
EXTRACTION_CONTRACT = FAST_SKILL.parent / "references/extraction-contract.md"
EXTRACTOR = SCRIPTS / "extract_pdf_layout.py"
MODEL = "gpt-5.6-luna"
PROVIDER = "codex"
MAX_WORKERS = 4
DOWNLOAD_UA = "Mozilla/5.0 OCRInsuranceLunaWindow4Shard3/1.0"
EXPECTED_COUNT = 34
RUN_SCOPE = "rolling-wave-next-20260727/window-4/luna-shard-3"
WRITE_LOCK = threading.Lock()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def append_jsonl(path: Path, value: object) -> None:
    with WRITE_LOCK:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(value, ensure_ascii=False) + "\n")


def safe_name(value: str) -> str:
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", str(value or ""))
    value = re.sub(r"\s+", "-", value).strip(".-")
    return value[:120] or "product"


def model_meta() -> dict:
    return {
        "provider": PROVIDER,
        "modelId": MODEL,
        "parseOnly": True,
        "parse_only": True,
        "databaseWrites": False,
        "sqliteWritten": False,
        "feishuWrites": False,
        "feishuWritten": False,
        "publication": False,
    }


def discover_soochow_url(item: dict) -> tuple[str, dict]:
    original = item["sourceUrl"]
    host = (urlparse(original).hostname or "").lower()
    if host != "www.soochowlife.net" or "/eportal/fileDir/cs/resource/" not in original:
        return original, {"discoveryUrl": "", "retrievalMethod": "direct", "originalUrl": original}
    discovery_url = "https://www.soochowlife.net/cs/gkxxpl/jbxx/cpjbxx/index.html"
    request = Request(discovery_url, headers={"User-Agent": DOWNLOAD_UA, "Accept": "text/html,*/*"})
    with urlopen(request, timeout=120) as response:
        page = response.read().decode("utf-8", errors="replace")
    product = re.escape(str(item.get("productName") or ""))
    match = re.search(
        product + r".*?href=\"([^\"]+?\.pdf)\"[^>]*>\s*保险条款",
        page,
        flags=re.IGNORECASE | re.DOTALL,
    )
    if not match:
        raise ValueError(f"Soochow official disclosure page did not expose an exact insurance-clause PDF for {item.get('productName')}")
    discovered = urljoin(discovery_url, html.unescape(match.group(1)))
    return discovered, {"discoveryUrl": discovery_url, "retrievalMethod": "direct_official_disclosure", "originalUrl": original, "discoveredUrl": discovered}


def download_source(url: str, target: Path) -> tuple[str, dict]:
    retrieval = {"requestedUrl": url, "retrievalMethod": "direct"}
    try:
        request = Request(url, headers={"User-Agent": DOWNLOAD_UA, "Accept": "application/pdf,*/*"})
        with urlopen(request, timeout=180) as response:
            body = response.read()
            final_url = response.geturl()
            status = getattr(response, "status", 200)
            content_type = response.headers.get("Content-Type", "")
        retrieval.update({"finalUrl": final_url, "httpStatus": status, "contentType": content_type})
    except Exception as first_error:
        # A few insurer assets require a browser-like Referer or expose legacy TLS.
        # Keep the host and PDF magic-byte checks; never accept an HTML challenge page.
        host = urlparse(url).hostname or ""
        part = target.with_suffix(target.suffix + ".curl-part")
        curl = ["curl", "--location", "--fail", "--silent", "--show-error", "--max-time", "180", "--retry", "1", "-A", DOWNLOAD_UA, "-e", f"https://{host}/", "-H", "Accept: application/pdf,*/*", "-o", str(part), url]
        insecure_tls = isinstance(first_error, OSError) and any(token in str(first_error).lower() for token in ("certificate", "renegotiation", "ssl"))
        if insecure_tls:
            curl.insert(1, "--insecure")
            retrieval["tlsVerification"] = "insecure_fallback_for_legacy_official_host"
        completed = subprocess.run(curl, capture_output=True, text=True, check=False)
        if completed.returncode != 0:
            raise first_error
        body = part.read_bytes()
        part.unlink()
        retrieval["retrievalMethod"] = "direct_curl_referer" if not insecure_tls else "direct_curl_legacy_tls"
        retrieval["curlStderr"] = completed.stderr[-1000:]
        final_url = url
        status = None
        content_type = ""
    if not body.startswith(b"%PDF"):
        raise ValueError(f"official URL did not return PDF magic bytes: status={status} contentType={content_type}")
    digest = "sha256:" + hashlib.sha256(body).hexdigest()
    partial = target.with_suffix(target.suffix + ".part")
    partial.write_bytes(body)
    partial.replace(target)
    retrieval.update({"requestedUrl": url, "finalUrl": final_url, "httpStatus": status, "contentType": content_type, "bytes": len(body)})
    return digest, retrieval


def extract_source(pdf: Path, text_path: Path, report_path: Path) -> None:
    completed = subprocess.run(
        [sys.executable, str(EXTRACTOR), "--pdf", str(pdf), "--output-text", str(text_path), "--report", str(report_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode == 0:
        return
    # The project extractor's optional pdfplumber dependency is unavailable in
    # this environment. pypdf still preserves page boundaries and exact text,
    # which is sufficient for the canonicalizer and validator.
    reader = PdfReader(str(pdf))
    pages = []
    report = {"extractor": "pypdf-fallback", "pages": [], "tablePages": [], "crossPageTableRanges": []}
    for page_number, page in enumerate(reader.pages, 1):
        value = page.extract_text() or ""
        pages.append(f"PDF_PAGE_{page_number}\n{value}")
        report["pages"].append({"page": page_number, "layoutAvailable": False, "tableLike": False, "ordinaryCharacters": len(value), "layoutCharacters": 0})
    source = "\n\n".join(pages)
    if len(source.strip()) < 80:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "official PDF text is empty; OCR/source repair required")
    text_path.write_text(source, encoding="utf-8")
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def parse_model_json(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    start = raw.find("{")
    if start < 0:
        raise ValueError("Codex Luna response did not contain a JSON object")
    value, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not isinstance(value, dict):
        raise ValueError("Codex Luna response root was not an object")
    return value


def invalid_json_retry_prompt(prompt: str, error: Exception) -> str:
    return (
        prompt
        + "\n\nYour previous response was not valid JSON and was rejected before "
        "validation. Return a complete replacement JSON object from the same "
        "official source. Do not continue the previous response and do not add "
        f"commentary. Parser error: {str(error)[-1000:]}"
    )


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


def prompt_for(item: dict, product_dir: Path, digest: str, repair: bool = False, error: str = "") -> str:
    repair_block = f"\nExisting artifact to repair: {product_dir / 'artifact.json'}\nRead it and return a complete replacement object. The previous validator output was:\n{error[-18000:]}\nRepair every issue and return a complete replacement object.\n" if repair else ""
    return f"""You are GPT-5.6 Luna running directly through Codex for one fixed insurance product. You are the only model permitted for this task. Do not call Gemini, DianJin, any OpenAI-compatible endpoint, any network endpoint, or another model. Read local files only. Do not write files. Return exactly one complete, syntactically valid JSON object and no Markdown or explanation. Keep the JSON compact. Use the shortest contiguous excerpt that still proves each clause and formula; do not copy whole pages when a clause-level excerpt is sufficient. Do not emit a second object, trailing commentary, or an unfinished object.

Read these instructions and schemas before parsing:
- {FAST_SKILL}
- {QUALITY_GATES}
- {EXTRACTION_CONTRACT}
- {FORMULA_RULES}
- {VALIDATOR}

Product: company={item.get('company')}; productName={item.get('productName')}; officialDomain={item.get('officialDomain')}; sourceUrl={item.get('sourceUrl')}; sourceDigest={digest}
Fresh official PDF: {product_dir / 'official-source.pdf'}
Fresh official page text: {product_dir / 'official-source.pages.txt'}

Read the fresh official page text fully and rebuild the complete responsibility inventory from the actual official source. Do not use the old manifest, old directories, old artifacts, or the recall-only hint as evidence. Preserve independently named responsibilities separately; retain every condition, branch, table row, percentage, multiplier, cap, deductible, waiting-period consequence, reimbursement rule, payment count, interval, mutual exclusion, deduction, and termination effect. Do not invent identity fields: use empty values with status not_present_in_source when unproven.

Use the validator's modern schema with company/displayCompany/productName/productIdentity/productOverview/productServices/productRules/currentPolicyInputs/optionalGroups/officialOptionalGroupChecklist/officialChecklist/responsibilities/audit/publication. Every responsibility needs responsibilityId, liability, groupId, parentResponsibilityId, responsibilityKind, coverageAggregation, selectionStatus, triggerCondition, insurerObligation, importantLimits, ruleRefs, sourcePage, sourceExcerpt, evidenceSegments, card, and indicators. Every quantitative indicator needs formulaText, normalizedFormula, basisKey, calculationKey, calculationStatus, calculationEligible, calculationReason, requiredInputs, ruleRefs, sourcePage, evidenceTokens, basisDefinition, branches, operands, and evidenceSegments as applicable. Keep customerSummary free of internal audit vocabulary. Use exact contiguous official text for sourceExcerpt/evidenceSegments and include sourcePage. Do not join pages or use ellipses. Set publication.sqlite=development_required_after_approval and publication.feishu=not_requested.

Recall-only hint (never evidence):
{str(item.get('existingResponsibilityHint') or '')[:8000]}
{repair_block}"""


def call_luna(prompt: str, raw_path: Path, log_path: Path) -> dict:
    command = [
        "codex", "exec", "--model", MODEL, "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
        "-C", "/Volumes/OCR_ARCHIVE/OCR_insurance", "-o", str(raw_path), "-",
    ]
    with log_path.open("w", encoding="utf-8") as log:
        completed = subprocess.run(command, input=prompt, text=True, stdout=log, stderr=subprocess.STDOUT, timeout=1800)
    if completed.returncode != 0:
        raise RuntimeError(f"Codex Luna exited with {completed.returncode}; see {log_path}")
    return parse_model_json(raw_path)


def finalize_saved_response(item: dict, product_dir: Path) -> dict | None:
    """Validate a completed raw response left behind by a stopped coordinator."""
    pdf = product_dir / "official-source.pdf"
    pages = product_dir / "official-source.pages.txt"
    digest_path = product_dir / "sourceDigest.json"
    if not pdf.exists() or not pages.exists() or not digest_path.exists():
        return None
    try:
        digest_row = json.loads(digest_path.read_text(encoding="utf-8"))
        digest = str(digest_row.get("sourceDigest") or "")
    except (OSError, json.JSONDecodeError):
        return None
    if not digest:
        return None
    responses = sorted(product_dir.glob("round-*-model-response.txt"), reverse=True)
    for raw_path in responses:
        match = re.search(r"round-(\d+)-model-response\.txt$", raw_path.name)
        if not match:
            continue
        round_number = int(match.group(1))
        try:
            artifact = parse_model_json(raw_path)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
        write_json(product_dir / f"round-{round_number}-raw-artifact.json", artifact)
        run_item = {**item, "sourceUrl": digest_row.get("sourceUrl") or item.get("sourceUrl")}
        ok, detail = run_validation(product_dir, run_item, round_number)
        status = "approved" if ok else "validation-review"
        value = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8")) if (product_dir / "artifact.json").exists() else {}
        write_json(product_dir / "evidence.json", {
            **model_meta(),
            "sourceDigest": digest,
            "status": status,
            "excerpts": excerpt_rows(value),
            **({"error": detail[-20000:]} if not ok else {}),
        })
        row = result_row(item, product_dir, digest, status, round_number, "" if ok else detail)
        write_json(product_dir / "result.json", row)
        return row
    return None


def run_validation(product_dir: Path, item: dict, round_number: int) -> tuple[bool, str]:
    artifact = product_dir / "artifact.json"
    canonical = product_dir / f"round-{round_number}-canonical.json"
    canonical_command = [sys.executable, str(CANONICALIZER), "--artifact", str(product_dir / f"round-{round_number}-raw-artifact.json"), "--source-text", str(product_dir / "official-source.pages.txt"), "--output", str(canonical)]
    canonical_run = subprocess.run(canonical_command, capture_output=True, text=True, check=False)
    write_json(product_dir / f"canonicalize-receipt-round-{round_number}.json", {**model_meta(), "sourceDigest": json.loads((product_dir / "sourceDigest.json").read_text()) ["sourceDigest"], "command": canonical_command, "exitCode": canonical_run.returncode, "stdout": canonical_run.stdout, "stderr": canonical_run.stderr})
    if canonical_run.returncode != 0:
        return False, "canonicalizer: " + (canonical_run.stderr or canonical_run.stdout)
    artifact.write_text(canonical.read_text(encoding="utf-8"), encoding="utf-8")
    validator_command = [sys.executable, str(VALIDATOR), "--artifact", str(artifact), "--source-document", str(product_dir / "official-source.pdf"), "--source-text", str(product_dir / "official-source.pages.txt"), "--official-domain", item.get("officialDomain") or (urlparse(item["sourceUrl"]).hostname or "")]
    validator_run = subprocess.run(validator_command, capture_output=True, text=True, check=False)
    receipt = {**model_meta(), "sourceDigest": json.loads((product_dir / "sourceDigest.json").read_text())["sourceDigest"], "command": validator_command, "exitCode": validator_run.returncode, "stdout": validator_run.stdout, "stderr": validator_run.stderr, "round": round_number, "status": "approved" if validator_run.returncode == 0 and '"status": "approved"' in validator_run.stdout else "rejected"}
    write_json(product_dir / "validator-receipt.json", receipt)
    if receipt["status"] == "approved":
        return True, validator_run.stdout
    return False, validator_run.stderr or validator_run.stdout


def result_row(item: dict, product_dir: Path, digest: str, status: str, attempts: int, error: str = "") -> dict:
    row = {**model_meta(), "status": status, "company": item.get("company"), "productName": item.get("productName"), "sourceUrl": item.get("sourceUrl"), "sourceDigest": digest, "productDir": str(product_dir), "artifactPath": str(product_dir / "artifact.json"), "resultPath": str(product_dir / "result.json"), "evidencePath": str(product_dir / "evidence.json"), "validatorReceiptPath": str(product_dir / "validator-receipt.json"), "sourceDigestPath": str(product_dir / "sourceDigest.json"), "attempts": attempts}
    artifact = product_dir / "artifact.json"
    if artifact.exists():
        try:
            value = json.loads(artifact.read_text(encoding="utf-8"))
            row["responsibilityCount"] = len(value.get("responsibilities") or [])
            row["artifactSha256"] = "sha256:" + hashlib.sha256(artifact.read_bytes()).hexdigest()
        except (OSError, json.JSONDecodeError):
            pass
    if error:
        row["error"] = error[-20000:]
    return row


def write_failure_receipts(item: dict, product_dir: Path, digest: str | None, status: str, error: str, attempts: int) -> dict:
    if digest is None:
        digest = ""
    write_json(product_dir / "sourceDigest.json", {**model_meta(), "sourceDigest": digest or None, "sourceUrl": item.get("sourceUrl"), "officialDomain": item.get("officialDomain"), "status": status, "error": error})
    write_json(product_dir / "validator-receipt.json", {**model_meta(), "sourceDigest": digest or None, "status": "not_run", "failureLayer": status, "error": error})
    write_json(product_dir / "evidence.json", {**model_meta(), "sourceDigest": digest or None, "status": status, "error": error, "excerpts": []})
    row = result_row(item, product_dir, digest, status, attempts, error)
    write_json(product_dir / "result.json", row)
    return row


def process(index: int, item: dict) -> dict:
    url_id = hashlib.sha256(item["sourceUrl"].encode("utf-8")).hexdigest()[:12]
    product_dir = OUTPUT / "products" / f"{safe_name(item.get('company'))}-{safe_name(item.get('productName'))}-{url_id}"
    product_dir.mkdir(parents=True, exist_ok=True)
    pdf = product_dir / "official-source.pdf"
    pages = product_dir / "official-source.pages.txt"
    report = product_dir / "official-source-layout-report.json"
    digest = ""
    attempts = 0
    try:
        attempts = 1
        effective_url, discovery = discover_soochow_url(item)
        digest, retrieval = download_source(effective_url, pdf)
        retrieval.update(discovery)
        extract_source(pdf, pages, report)
        run_item = {**item, "sourceUrl": effective_url}
        write_json(product_dir / "sourceDigest.json", {**model_meta(), "sourceDigest": digest, "sourceUrl": effective_url, "originalSourceUrl": item.get("sourceUrl"), "discoveryUrl": discovery.get("discoveryUrl", ""), "officialDomain": item.get("officialDomain"), "retrieval": retrieval, "sourceDocumentPath": str(pdf), "sourceTextPath": str(pages)})
        initial_prompt = prompt_for(run_item, product_dir, digest)
        model_round = 1
        try:
            artifact = call_luna(initial_prompt, product_dir / "round-1-model-response.txt", product_dir / "codex-round-1.log")
        except (ValueError, json.JSONDecodeError) as parse_error:
            attempts = 2
            model_round = 2
            artifact = call_luna(
                invalid_json_retry_prompt(initial_prompt, parse_error),
                product_dir / "round-2-model-response.txt",
                product_dir / "codex-round-2.log",
            )
        write_json(product_dir / f"round-{model_round}-raw-artifact.json", artifact)
        ok, detail = run_validation(product_dir, run_item, model_round)
        if not ok and attempts < 2:
            attempts = 2
            model_round = 2
            artifact = call_luna(prompt_for(run_item, product_dir, digest, repair=True, error=detail), product_dir / "round-2-model-response.txt", product_dir / "codex-round-2.log")
            write_json(product_dir / "round-2-raw-artifact.json", artifact)
            ok, detail = run_validation(product_dir, run_item, model_round)
        if not ok:
            row = result_row(item, product_dir, digest, "validation-review", attempts, detail)
            value = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8")) if (product_dir / "artifact.json").exists() else {}
            write_json(product_dir / "evidence.json", {**model_meta(), "sourceDigest": digest, "status": "validation-review", "excerpts": excerpt_rows(value), "error": detail[-20000:]})
            write_json(product_dir / "result.json", row)
            append_jsonl(OUTPUT / "validation-review.jsonl", row)
            return row
        value = json.loads((product_dir / "artifact.json").read_text(encoding="utf-8"))
        write_json(product_dir / "evidence.json", {**model_meta(), "sourceDigest": digest, "sourceDocumentPath": str(pdf), "sourceTextPath": str(pages), "status": "approved", "excerpts": excerpt_rows(value)})
        row = result_row(item, product_dir, digest, "approved", attempts)
        write_json(product_dir / "result.json", row)
        append_jsonl(OUTPUT / "approved.jsonl", row)
        return row
    except Exception as exc:
        row = write_failure_receipts(item, product_dir, digest or None, "source-retry" if not pdf.exists() or not pages.exists() else "model-retry", str(exc), attempts)
        append_jsonl(OUTPUT / ("source-retry.jsonl" if row["status"] == "source-retry" else "model-retry.jsonl"), row)
        return row


def main() -> int:
    rows = json.loads(INPUT.read_text(encoding="utf-8"))
    items = [row for row in rows if isinstance(row, dict)]
    if len(items) != EXPECTED_COUNT or any(item.get("route") != "luna_review" for item in items):
        raise SystemExit(f"unexpected manifest: count={len(items)} expected={EXPECTED_COUNT} or non-luna route")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write_json(OUTPUT / "manifest.json", {"input": str(INPUT), "selected": items, **model_meta(), "scope": RUN_SCOPE})
    for filename in ("approved.jsonl", "validation-review.jsonl", "model-retry.jsonl", "source-retry.jsonl"):
        (OUTPUT / filename).touch()
    started = time.time()
    results: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
        futures = {pool.submit(process, index, item): (index, item) for index, item in enumerate(items, 1)}
        for future in concurrent.futures.as_completed(futures):
            index, item = futures[future]
            row = future.result()
            results.append(row)
            print(json.dumps({"index": index, "total": len(items), "company": item.get("company"), "productName": item.get("productName"), "status": row.get("status"), "attempts": row.get("attempts"), "responsibilityCount": row.get("responsibilityCount"), "error": str(row.get("error", ""))[-500:]}, ensure_ascii=False), flush=True)
    counts: dict[str, int] = {}
    for row in results:
        counts[row.get("status", "unknown")] = counts.get(row.get("status", "unknown"), 0) + 1
    summary = {"status": "completed", "scope": RUN_SCOPE, "inputManifest": str(INPUT), "outputDir": str(OUTPUT), "selected": len(items), "counts": counts, "provider": PROVIDER, "modelId": MODEL, "parseOnly": True, "databaseWrites": False, "feishuWrites": False, "publication": False, "elapsedSeconds": round(time.time() - started, 2), "products": sorted([{"company": row.get("company"), "productName": row.get("productName"), "status": row.get("status"), "sourceDigest": row.get("sourceDigest"), "resultPath": row.get("resultPath")} for row in results], key=lambda value: (value["company"] or "", value["productName"] or ""))}
    write_json(OUTPUT / "summary.json", summary)
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
