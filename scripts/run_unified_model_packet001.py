#!/usr/bin/env python3
"""Run only packet-001 of the unified GPT-5.6 Luna model-retry ledger."""

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
MANIFEST = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/global-model-retry-ledger-20260728-final/"
    "resume-luna-model-retry-20260728/unified-model-pending-after-packet003-20260728/"
    "packet-001/manifest.json"
)
OUTPUT = MANIFEST.parent / "agent-1"
CANONICALIZER = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/"
CANONICALIZER = CANONICALIZER / "ocr-insurance-product-responsibility-pipeline/scripts/canonicalize_excerpts.py"
VALIDATOR = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/"
VALIDATOR = VALIDATOR / "ocr-insurance-product-responsibility-pipeline/scripts/validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"
MODEL = "gpt-5.6-luna"
PROVIDER = "gpt-5.6-luna"
CLIENT = "codex"
WORKERS = 2
CALL_TIMEOUT_SECONDS = 3600
TERMINAL_STATES = {"approved", "validation-review", "model-retry", "source-retry"}


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def safe_name(value: str) -> str:
    cleaned = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "-", str(value or ""))
    cleaned = re.sub(r"\s+", "-", cleaned).strip(".-")
    return cleaned[:120] or "product"


def meta() -> dict:
    return {
        "provider": PROVIDER,
        "providerClient": CLIENT,
        "modelId": MODEL,
        "parseOnly": True,
        "databaseWrites": False,
        "sqliteWritten": False,
        "feishuWrites": False,
        "publication": False,
    }


def source_digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def product_dir(item: dict) -> Path:
    index = int(item["packetIndex"])
    return OUTPUT / "products" / f"{index:03d}-{safe_name(item.get('company'))}-{safe_name(item.get('productName'))}"


def parse_model_json(path: Path) -> dict:
    raw = path.read_text(encoding="utf-8")
    start = raw.find("{")
    if start < 0:
        raise ValueError("provider response has no JSON object")
    value, _ = json.JSONDecoder().raw_decode(raw[start:])
    if not isinstance(value, dict):
        raise ValueError("provider response root is not an object")
    return value


def prompt(item: dict, expected_digest: str) -> str:
    metadata = {
        key: item.get(key)
        for key in ("company", "productName", "sourceUrl", "sourceDigest", "sourceFile", "sourceTextFile")
    }
    return f"""You are GPT-5.6 Luna, the sole model call for one fixed insurance product.
Return exactly one complete valid JSON object and no Markdown or commentary.

Read only these two locked source files as evidence:
sourceFile={item['sourceFile']}
sourceTextFile={item['sourceTextFile']}
Do not open any other product, queue, packet, artifact, database, URL, or network resource.
Do not call another provider. Do not write files. This is parse-only.

The immutable source digest is {expected_digest}; preserve it in productIdentity.sourceDigest.
Build a complete official responsibility inventory from the locked source. Keep separately
named responsibilities separate. Preserve conditions, obligations, waiting periods, limits,
deductions, formulas, max/min operands, numeric/table branches, continuation pages, and
responsibility-to-indicator one-to-one alignment. Evidence excerpts must be exact contiguous
text from sourceTextFile; remove page extraction markers from final excerpts.

Return the unified artifact object with these top-level fields:
company, displayCompany, productName, productIdentity, productOverview, productServices,
productRules, currentPolicyInputs, optionalGroups, officialOptionalGroupChecklist,
officialChecklist, responsibilities, audit, publication.
Each responsibility must include responsibilityId, liability, groupId, parentResponsibilityId,
responsibilityKind, coverageAggregation, selectionStatus, triggerCondition,
insurerObligation, importantLimits, ruleRefs, sourcePage, sourceExcerpt, evidenceSegments,
card, and indicators. Each indicator must preserve formulaText, normalizedFormula, basisKey,
calculationKey, calculationStatus, calculationEligible, calculationReason, requiredInputs,
ruleRefs, sourcePage, evidenceTokens, basisDefinition, branches, operands, and
evidenceSegments as applicable. Customer wording must not contain internal audit vocabulary.
Set publication.sqlite=development_required_after_approval, publication.feishu=not_requested,
and publication.published=false.

Manifest metadata, never evidence: {json.dumps(metadata, ensure_ascii=False)}
Expected digest check value: {expected_digest}
"""


def command_receipt(command: list[str], run: subprocess.CompletedProcess | None, *, timed_out: bool, elapsed: float, status: str, error: str | None = None) -> dict:
    return {
        **meta(),
        "command": command,
        "status": status,
        "timedOut": timed_out,
        "elapsedSeconds": round(elapsed, 3),
        "exitCode": None if run is None else run.returncode,
        "stdout": "" if run is None else run.stdout,
        "stderr": "" if run is None else run.stderr,
        **({"error": error} if error else {}),
    }


def run_capture(command: list[str], *, cwd: Path | None = None, timeout: int = 300) -> tuple[subprocess.CompletedProcess | None, bool, float, str | None]:
    started = time.time()
    try:
        run = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=timeout, check=False)
        return run, False, time.time() - started, None
    except subprocess.TimeoutExpired as exc:
        return None, True, time.time() - started, f"command timed out after {timeout}s: {exc}"
    except OSError as exc:
        return None, False, time.time() - started, f"command could not start: {exc}"


def write_not_run_receipts(out: Path, expected_digest: str, reason: str, *, stages: tuple[str, ...] = ("canonicalizer", "validator", "dedicated-importer-dry-run")) -> None:
    for filename, stage in (
        ("canonicalizer-receipt.json", "canonicalizer"),
        ("validator-receipt.json", "validator"),
        ("importer-dry-run-receipt.json", "dedicated-importer-dry-run"),
    ):
        if stage not in stages:
            continue
        write_json(out / filename, {**meta(), "stage": stage, "status": "not_run", "sourceDigest": expected_digest, "reason": reason})


def result_row(item: dict, out: Path, status: str, expected_digest: str, *, reason: str | None = None, provider_calls: int = 0, gates: dict | None = None) -> dict:
    return {
        **meta(),
        "packet": "packet-001",
        "packetIndex": item["packetIndex"],
        "company": item.get("company"),
        "productName": item.get("productName"),
        "sourceDigest": expected_digest,
        "sourceFile": item.get("sourceFile"),
        "sourceTextFile": item.get("sourceTextFile"),
        "status": status,
        "terminalState": status,
        "providerCallCount": provider_calls,
        "productDir": str(out),
        "resultPath": str(out / "result.json"),
        "providerReceiptPath": str(out / "provider-receipt.json"),
        "canonicalizerReceiptPath": str(out / "canonicalizer-receipt.json"),
        "validatorReceiptPath": str(out / "validator-receipt.json"),
        "importerDryRunReceiptPath": str(out / "importer-dry-run-receipt.json"),
        **({"gates": gates} if gates is not None else {}),
        **({"reason": reason} if reason else {}),
    }


def finish(out: Path, row: dict) -> dict:
    write_json(out / "result.json", row)
    return row


def run_one(item: dict) -> dict:
    out = product_dir(item)
    out.mkdir(parents=True, exist_ok=True)
    existing = out / "result.json"
    if existing.is_file():
        row = json.loads(existing.read_text(encoding="utf-8"))
        if row.get("status") not in TERMINAL_STATES:
            raise RuntimeError(f"existing result has illegal terminal state: {existing}")
        return row

    expected_digest = str(item.get("sourceDigest") or "")
    source_pdf = Path(str(item.get("sourceFile") or ""))
    source_text = Path(str(item.get("sourceTextFile") or ""))
    base = {
        **meta(),
        "packet": "packet-001",
        "packetIndex": item["packetIndex"],
        "company": item.get("company"),
        "productName": item.get("productName"),
        "sourceUrl": item.get("sourceUrl"),
        "sourceDigest": expected_digest,
        "sourceFile": str(source_pdf),
        "sourceTextFile": str(source_text),
        "productDir": str(out),
    }

    if not source_pdf.is_file() or not source_text.is_file():
        missing = [str(path) for path in (source_pdf, source_text) if not path.is_file()]
        write_json(out / "source-digest-receipt.json", {**base, "status": "source-retry", "verified": False, "missing": missing})
        write_json(out / "provider-receipt.json", {**base, "status": "not_run", "callCount": 0, "reason": "locked source file/text missing"})
        write_not_run_receipts(out, expected_digest, "source-retry: locked source file/text missing")
        return finish(out, result_row(item, out, "source-retry", expected_digest, reason="locked source file/text missing"))

    actual_digest = source_digest(source_pdf)
    digest_ok = actual_digest.lower() == expected_digest.lower()
    write_json(out / "source-digest-receipt.json", {**base, "actualSourceDigest": actual_digest, "expectedSourceDigest": expected_digest, "verified": digest_ok, "status": "ready" if digest_ok else "source-retry"})
    if not digest_ok:
        write_json(out / "provider-receipt.json", {**base, "status": "not_run", "callCount": 0, "reason": "locked source digest mismatch", "actualSourceDigest": actual_digest})
        write_not_run_receipts(out, expected_digest, "source-retry: locked source digest mismatch")
        return finish(out, result_row(item, out, "source-retry", expected_digest, reason="locked source digest mismatch"))

    raw_response = out / "provider-response.txt"
    call_log = out / "provider-call.log"
    command = ["codex", "exec", "--model", MODEL, "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "-C", str(ROOT), "-o", str(raw_response), "-"]
    started = time.time()
    timed_out = False
    run: subprocess.CompletedProcess | None = None
    provider_error: str | None = None
    try:
        with call_log.open("w", encoding="utf-8") as handle:
            run = subprocess.run(command, input=prompt(item, expected_digest), stdout=handle, stderr=subprocess.STDOUT, text=True, timeout=CALL_TIMEOUT_SECONDS, check=False)
    except subprocess.TimeoutExpired as exc:
        timed_out = True
        provider_error = f"provider command timed out after {CALL_TIMEOUT_SECONDS}s: {exc}"
    except OSError as exc:
        provider_error = f"provider command could not start: {exc}"
    elapsed = time.time() - started
    provider_status = "completed" if run is not None and run.returncode == 0 and not timed_out else "failed"
    write_json(out / "provider-receipt.json", {
        **base,
        "status": provider_status,
        "callCount": 1,
        "timedOut": timed_out,
        "exitCode": None if run is None else run.returncode,
        "elapsedSeconds": round(elapsed, 3),
        "command": command,
        "promptSourceDigest": expected_digest,
        "responsePath": str(raw_response),
        "logPath": str(call_log),
        **({"error": provider_error} if provider_error else {}),
    })
    if provider_error or run is None or run.returncode != 0:
        write_not_run_receipts(out, expected_digest, "model-retry: provider command failure or timeout")
        return finish(out, result_row(item, out, "model-retry", expected_digest, reason=provider_error or f"provider exited {run.returncode}", provider_calls=1))

    try:
        artifact = parse_model_json(raw_response)
    except Exception as exc:
        write_not_run_receipts(out, expected_digest, "model-retry: malformed provider JSON")
        return finish(out, result_row(item, out, "model-retry", expected_digest, reason=f"malformed provider JSON: {exc}", provider_calls=1))
    write_json(out / "raw-artifact.json", artifact)

    canonical_command = [sys.executable, str(CANONICALIZER), "--artifact", str(out / "raw-artifact.json"), "--source-text", str(source_text), "--output", str(out / "canonical-artifact.json")]
    can, can_timeout, can_elapsed, can_error = run_capture(canonical_command, timeout=300)
    can_status = "passed" if can is not None and can.returncode == 0 and not can_timeout and (out / "canonical-artifact.json").is_file() else "failed"
    write_json(out / "canonicalizer-receipt.json", {**command_receipt(canonical_command, can, timed_out=can_timeout, elapsed=can_elapsed, status=can_status, error=can_error), "sourceDigest": expected_digest})
    if can_status != "passed":
        write_not_run_receipts(out, expected_digest, "model-retry: canonicalizer command failure or timeout", stages=("validator", "dedicated-importer-dry-run"))
        return finish(out, result_row(item, out, "model-retry", expected_digest, reason=can_error or "canonicalizer command failed", provider_calls=1, gates={"provider": "passed", "canonicalizer": "failed", "validator": "not_run", "dedicatedImporterDryRun": "not_run"}))
    (out / "artifact.json").write_text((out / "canonical-artifact.json").read_text(encoding="utf-8"), encoding="utf-8")

    domain = urlparse(str(item.get("sourceUrl") or "")).hostname or ""
    validator_command = [sys.executable, str(VALIDATOR), "--artifact", str(out / "artifact.json"), "--source-text", str(source_text), "--source-document", str(source_pdf), "--official-domain", domain]
    val, val_timeout, val_elapsed, val_error = run_capture(validator_command, timeout=300)
    validator_json = None
    if val is not None and val.stdout:
        try:
            validator_json = json.loads(val.stdout.strip().splitlines()[-1])
        except json.JSONDecodeError:
            validator_json = None
    validator_passed = val is not None and not val_timeout and val.returncode == 0 and isinstance(validator_json, dict) and validator_json.get("status") == "approved"
    validator_status = "passed" if validator_passed else ("failed" if val_timeout or val_error else "gate_failed")
    write_json(out / "validator-receipt.json", {**command_receipt(validator_command, val, timed_out=val_timeout, elapsed=val_elapsed, status=validator_status, error=val_error), "sourceDigest": expected_digest, "parsed": validator_json})
    if not validator_passed:
        if val_timeout or val_error:
            write_not_run_receipts(out, expected_digest, "model-retry: validator command failure or timeout", stages=("dedicated-importer-dry-run",))
            return finish(out, result_row(item, out, "model-retry", expected_digest, reason=val_error or "validator command failed", provider_calls=1, gates={"provider": "passed", "canonicalizer": "passed", "validator": "failed", "dedicatedImporterDryRun": "not_run"}))
        write_json(out / "importer-dry-run-receipt.json", {**meta(), "stage": "dedicated-importer-dry-run", "status": "not_run", "sourceDigest": expected_digest, "reason": "validation-review: validator gate failed"})
        return finish(out, result_row(item, out, "validation-review", expected_digest, reason="validator gate failed", provider_calls=1, gates={"provider": "passed", "canonicalizer": "passed", "validator": "gate_failed", "dedicatedImporterDryRun": "not_run"}))

    importer_command = ["node", str(IMPORTER), f"--artifacts={out / 'artifact.json'}", "--sample-limit=10"]
    imp, imp_timeout, imp_elapsed, imp_error = run_capture(importer_command, cwd=ROOT, timeout=300)
    importer_json = None
    if imp is not None and imp.stdout:
        try:
            importer_json = json.loads(imp.stdout)
        except json.JSONDecodeError:
            importer_json = None
    importer_passed = imp is not None and not imp_timeout and imp.returncode == 0 and isinstance(importer_json, dict) and importer_json.get("ok") is True and importer_json.get("validationIssueCount") == 0 and importer_json.get("dryRun") is True
    importer_status = "passed" if importer_passed else ("failed" if imp_timeout or imp_error else "gate_failed")
    write_json(out / "importer-dry-run-receipt.json", {**command_receipt(importer_command, imp, timed_out=imp_timeout, elapsed=imp_elapsed, status=importer_status, error=imp_error), "stage": "dedicated-importer-dry-run", "sourceDigest": expected_digest, "parsed": importer_json})
    if not importer_passed:
        if imp_timeout or imp_error:
            return finish(out, result_row(item, out, "model-retry", expected_digest, reason=imp_error or "dedicated importer command failed", provider_calls=1, gates={"provider": "passed", "canonicalizer": "passed", "validator": "passed", "dedicatedImporterDryRun": "failed"}))
        return finish(out, result_row(item, out, "validation-review", expected_digest, reason="dedicated importer dry-run gate failed", provider_calls=1, gates={"provider": "passed", "canonicalizer": "passed", "validator": "passed", "dedicatedImporterDryRun": "gate_failed"}))

    return finish(out, result_row(item, out, "approved", expected_digest, provider_calls=1, gates={"provider": "passed", "canonicalizer": "passed", "validator": "passed", "dedicatedImporterDryRun": "passed"}))


def hash_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def finalize(items: list[dict], rows: list[dict], started: float) -> None:
    rows.sort(key=lambda row: int(row["packetIndex"]))
    terminal = OUTPUT / "terminal-queue.jsonl"
    terminal.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    for status in ("approved", "validation-review", "model-retry", "source-retry"):
        (OUTPUT / f"{status}.jsonl").write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows if row["status"] == status), encoding="utf-8")
    counts = {status: sum(row["status"] == status for row in rows) for status in sorted(TERMINAL_STATES)}
    write_json(OUTPUT / "summary.json", {
        **meta(),
        "status": "completed",
        "manifest": str(MANIFEST),
        "outputDir": str(OUTPUT),
        "packet": "packet-001",
        "selected": len(items),
        "counts": counts,
        "providerCalls": sum(int(row.get("providerCallCount", 0)) for row in rows),
        "elapsedSeconds": round(time.time() - started, 3),
        "terminalQueue": str(terminal),
        "sourceReuse": "locked-source-only",
        "excludedPackets": ["packet-002", "packet-003", "other queues"],
        "products": [{"packetIndex": row["packetIndex"], "productName": row["productName"], "status": row["status"], "sourceDigest": row["sourceDigest"], "resultPath": row["resultPath"]} for row in rows],
    })

    indexes = [row["packetIndex"] for row in rows]
    status_counts = {index: sum(row["packetIndex"] == index for row in rows) for index in indexes}
    audit = {
        "status": "pass" if len(rows) == 25 and sorted(indexes) == list(range(1, 26)) and all(count == 1 for count in status_counts.values()) and all(row["status"] in TERMINAL_STATES for row in rows) else "fail",
        "manifest": str(MANIFEST),
        "selected": len(items),
        "terminalRows": len(rows),
        "uniquePacketIndexes": len(set(indexes)),
        "packetIndexes": indexes,
        "mutuallyExclusive": all(count == 1 for count in status_counts.values()),
        "counts": counts,
        "providerCalls": sum(int(row.get("providerCallCount", 0)) for row in rows),
    }
    write_json(OUTPUT / "terminal-queue-audit.json", audit)

    digest_rows = {str(path.relative_to(OUTPUT)): hash_file(path) for path in sorted(OUTPUT.rglob("*")) if path.is_file() and path.name not in {"sha256.json", "SHA256SUMS"}}
    write_json(OUTPUT / "sha256.json", {"algorithm": "SHA-256", "manifest": {"path": str(MANIFEST), "sha256": hash_file(MANIFEST)}, "files": digest_rows})
    sums = [f"{digest}  {relative}" for relative, digest in digest_rows.items()]
    sums.append(f"{hash_file(OUTPUT / 'sha256.json')}  sha256.json")
    (OUTPUT / "SHA256SUMS").write_text("\n".join(sums) + "\n", encoding="utf-8")


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("packet") != "packet-001" or manifest.get("provider") != MODEL or manifest.get("retryLayer") != "model":
        raise RuntimeError("manifest scope/provider/retry layer mismatch")
    items = manifest.get("products")
    if not isinstance(items, list) or len(items) != 25 or [item.get("packetIndex") for item in items] != list(range(1, 26)):
        raise RuntimeError("manifest must contain exactly packet-001 indexes 1..25")
    if any(item.get("sourceFile") is None or item.get("sourceTextFile") is None for item in items):
        raise RuntimeError("manifest source lock fields must be present for every product")

    write_json(OUTPUT / "manifest-scope.json", {
        "manifest": str(MANIFEST),
        "packet": "packet-001",
        "selected": 25,
        "provider": PROVIDER,
        "modelId": MODEL,
        "retryLayer": "model",
        "sourceReuse": "locked-source-only",
        "parseOnly": True,
        "databaseWrites": False,
        "sqliteWritten": False,
        "feishuWrites": False,
        "publication": False,
        "excludedPackets": ["packet-002", "packet-003", "other queues"],
    })
    started = time.time()
    rows: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(run_one, item): item for item in items}
        for future in concurrent.futures.as_completed(futures):
            row = future.result()
            rows.append(row)
            print(json.dumps({"packetIndex": row["packetIndex"], "productName": row["productName"], "status": row["status"]}, ensure_ascii=False), flush=True)
    finalize(items, rows, started)
    print(json.dumps(json.loads((OUTPUT / "summary.json").read_text(encoding="utf-8")), ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
