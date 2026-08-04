#!/usr/bin/env python3
"""Parse the locked 23-product Luna complex pool from inventory wave 003."""
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
WAVE = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/inventory-wave-20260801-003"
MANIFEST = WAVE / "routing/luna-complex.jsonl"
OUTPUT = WAVE / "execution/luna-complex-23-20260801"
PIPELINE = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline"
CANONICALIZER = PIPELINE / "scripts/canonicalize_excerpts.py"
VALIDATOR = PIPELINE / "scripts/validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"
MODEL = "gpt-5.6-luna"
PROVIDER = "codex"
BATCH_SIZES = (10, 10, 3)


VALIDATOR_SCHEMA_CONTRACT = r'''
The production validator contract below is mandatory. Do not invent enum values
or use a structurally similar alternative.

- responsibilityKind: benefit | waiver | waiting_period_refund
- coverageAggregation: include | exclude
- selectionStatus: included | not_included | unknown
- calculationStatus, including every branch: calculable | display_only |
  needs_table | needs_claim_facts | not_quantitative
- requiredInputs may contain only the canonical input names supplied by this
  task. A quantitative branch or comparison operand must have a non-empty list.
- productRules[] requires ruleId, title, and exact source evidence. ruleRefs may
  contain only ruleIds actually present in productRules[].
- Use branches only for condition-based piecewise formulas. A piecewise
  indicator must use basisKey=piecewise and each branch must contain branchId,
  exact conditionText, formulaText, a non-ambiguous basisKey,
  calculationStatus, requiredInputs, and source-supported evidenceTokens.
- Use operands only for max/min comparisons. A comparison indicator or branch
  must use an exact max_of_* or min_of_* composite basisKey and at least two
  operands. Each operand must contain operandId, formulaText, a non-piecewise
  basisKey, requiredInputs, and source-supported evidenceTokens.
- Never put operands on a non-comparison formula, never put top-level operands
  on a piecewise formula, and never represent an ordinary medical deduction
  formula as branches or as a list of its scalar variables in operands.
- optionalGroups and officialOptionalGroupChecklist must describe exactly the
  same groups and child responsibility IDs. Non-optional responsibilities use
  selectionStatus=included and no groupId.
- officialChecklist, responsibilities, and audit.matrix must contain exactly
  the locked responsibility IDs. Audit counts equal the locked responsibility
  count. Every audit matrix gate and audit.status must be approved/pass only
  when supported by the returned artifact; the external validator remains the
  authority.

If the locked evidence cannot support every required field without guessing,
preserve the locked inventory and return a candidate with an explicit blocker;
do not fabricate schema fields, formulas, rule references, evidence, or a
different responsibility inventory.
'''.strip()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def safe_name(value: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "-", str(value or ""))
    return re.sub(r"\s+", "-", cleaned).strip(".-")[:100] or "product"


def meta() -> dict:
    return {
        "provider": PROVIDER,
        "modelId": MODEL,
        "executionMode": "direct_codex_thread",
        "parseOnly": True,
        "repairRounds": 0,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    }


def product_dir(item: dict, batch: int, batch_order: int) -> Path:
    name = f"{batch_order:02d}-{safe_name(item['company'])}-{safe_name(item['productName'])}-{item['selectedOrder']}"
    return OUTPUT / f"batch-{batch:03d}" / "products" / name


def prompt(item: dict, digest: str) -> str:
    packets = "\n".join(
        f"- {responsibility['responsibilityId']} | {responsibility['officialTitle']} | {responsibility['evidencePacket']}"
        for responsibility in item["responsibilities"]
    )
    inventory = json.dumps(
        [
            {
                "responsibilityId": responsibility["responsibilityId"],
                "officialTitle": responsibility["officialTitle"],
            }
            for responsibility in item["responsibilities"]
        ],
        ensure_ascii=False,
    )
    return f'''You are GPT-5.6 Luna acting as the complex insurance responsibility extractor for exactly one locked product. This is one authorized model call, parse-only, direct_codex_thread. Read local files only. Do not call any provider or endpoint, do not use another product, and do not write files. Return exactly one complete valid JSON object with no Markdown.

Company: {item['company']}
Product: {item['productName']}
Official source digest: {digest}
Official source PDF: {item['sourceFile']}
Official source text: {item['sourceTextFile']}
Source contract: {item['sourceContract']}
Locked inventory: {inventory}
Locked evidence packets:
{packets}

Read every listed evidence packet and the directly referenced official source ranges. Extract every locked responsibility exactly once. Never add a waiting period, exclusion, claim procedure, service, definition, group heading, disease list, or table row as a responsibility. Keep formula tiers, conditions, optional branches and table rows under their locked parent responsibility unless the inventory names a separate obligation.

{VALIDATOR_SCHEMA_CONTRACT}

For each responsibility preserve the exact responsibilityId and official title, triggerCondition, insurerObligation, importantLimits, ruleRefs, sourcePage, one exact contiguous sourceExcerpt, exact evidenceSegments with absoluteStart/absoluteEnd/exactText, customerSummary, benefitExplanation, and one or more source-supported indicators. Preserve legal multi-indicator responsibilities. Each indicator must include stable ID/liability, formulaText and normalizedFormula when provable, basis/basisKey, calculationKey/calculationStatus/calculationEligible/calculationReason, canonical requiredInputs, requiredInputDetails, basisDefinition, every structured operand/branch/table cell, evidenceTokens and evidenceSegments. Do not invent inputs, numbers, formulas, offsets or evidence. Use manual_formula plus manualFormulaInputs only when the official expression is real but cannot safely be represented by another canonical calculation key. Omit unknown values.

Return the modern unified artifact object with company, displayCompany, productName, productIdentity, productOverview, productServices, productRules, currentPolicyInputs, optionalGroups, officialOptionalGroupChecklist, officialChecklist, responsibilities, audit and publication. The responsibility count and IDs must exactly equal the locked inventory. Set publication.sqlite=development_required_after_approval and publication.feishu=not_requested.'''


def bounded_repair_prompt(item: dict, digest: str, artifact_path: Path, validator_issues: list[str]) -> str:
    packets = "\n".join(
        f"- {responsibility['responsibilityId']} | {responsibility['officialTitle']} | {responsibility['evidencePacket']}"
        for responsibility in item["responsibilities"]
    )
    inventory = json.dumps(
        [
            {
                "responsibilityId": responsibility["responsibilityId"],
                "officialTitle": responsibility["officialTitle"],
            }
            for responsibility in item["responsibilities"]
        ],
        ensure_ascii=False,
    )
    issues = json.dumps(validator_issues, ensure_ascii=False)
    return f'''You are GPT-5.6 Luna acting as a bounded insurance artifact verifier for exactly one locked product. This is one authorized model call, parse-only, direct_codex_thread. Read local files only. Do not call another provider or endpoint, do not use another product, and do not write files. Return exactly one complete valid JSON object with no Markdown.

Company: {item['company']}
Product: {item['productName']}
Official source digest: {digest}
Official source PDF: {item['sourceFile']}
Official source text: {item['sourceTextFile']}
Source contract: {item['sourceContract']}
Current artifact: {artifact_path}
Locked inventory: {inventory}
Locked evidence packets:
{packets}
Validator issues to repair: {issues}

Repair only the listed validator failures and the minimum parent structures required by them. Preserve every locked responsibility ID and official title exactly once. Preserve every source-supported business fact, formula, normalized formula, required input, numeric token, branch meaning, and responsibility topology unless the validator issue explicitly proves its current representation is invalid. Never broaden or shrink the responsibility inventory. Do not add a waiting period, exclusion, procedure, service, definition, group heading, disease list, or table row as a responsibility. If a field cannot be repaired from the locked evidence, keep it unresolved rather than inventing a value.

{VALIDATOR_SCHEMA_CONTRACT}

Return the complete repaired modern unified artifact object. The external canonicalizer and validator, not your self-assessment, determine whether it is approved.'''


def decode_single_json_object(response: str) -> dict:
    start = response.find("{")
    if start < 0:
        raise ValueError("model response has no JSON object")
    artifact, end = json.JSONDecoder().raw_decode(response[start:])
    if response[start + end:].strip():
        raise ValueError("model response contains trailing non-whitespace after the JSON object")
    if not isinstance(artifact, dict):
        raise ValueError("model response root is not an object")
    return artifact


def run_model(item: dict, out: Path, digest: str, prompt_text: str | None = None) -> dict:
    raw_path = out / "model-response.txt"
    log_path = out / "model-call.log"
    command = [
        "codex", "exec", "--model", MODEL, "--skip-git-repo-check",
        "--sandbox", "read-only", "--ephemeral", "-C", str(ROOT),
        "-o", str(raw_path), "-",
    ]
    with log_path.open("w", encoding="utf-8") as log:
        completed = subprocess.run(
            command,
            input=prompt_text or prompt(item, digest),
            text=True,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=3600,
        )
    if completed.returncode != 0:
        raise RuntimeError(f"codex exited {completed.returncode}")
    response = raw_path.read_text(encoding="utf-8")
    return decode_single_json_object(response)


def not_run_receipt(out: Path, name: str, reason: str, base: dict) -> None:
    write_json(out / name, {**meta(), **base, "status": "not_run", "reason": reason})


def run_gates(item: dict, out: Path, digest: str, base: dict) -> tuple[str, str, dict]:
    raw = out / "raw-artifact.json"
    canonical = out / "canonical-artifact.json"
    canonicalizer_command = [
        sys.executable, str(CANONICALIZER), "--artifact", str(raw),
        "--source-text", item["sourceTextFile"], "--output", str(canonical),
    ]
    canonicalizer = subprocess.run(canonicalizer_command, capture_output=True, text=True)
    write_json(
        out / "canonicalizer-receipt.json",
        {
            **meta(), **base, "stage": "canonicalizer", "command": canonicalizer_command,
            "exitCode": canonicalizer.returncode, "stdout": canonicalizer.stdout,
            "stderr": canonicalizer.stderr,
            "status": "passed" if canonicalizer.returncode == 0 else "failed",
        },
    )
    if canonicalizer.returncode != 0:
        not_run_receipt(out, "validator-receipt.json", "canonicalizer_failed", base)
        not_run_receipt(out, "importer-dry-run-receipt.json", "canonicalizer_failed", base)
        return "validation-review", canonicalizer.stderr or canonicalizer.stdout, {
            "canonicalizer": "failed", "validator": "not_run", "importerDryRun": "not_run"
        }

    (out / "artifact.json").write_text(canonical.read_text(encoding="utf-8"), encoding="utf-8")
    validator_command = [
        sys.executable, str(VALIDATOR), "--artifact", str(out / "artifact.json"),
        "--source-document", item["sourceFile"], "--source-text", item["sourceTextFile"],
        "--official-domain", urlparse(item["sourceUrl"]).hostname or "",
    ]
    validator = subprocess.run(validator_command, capture_output=True, text=True)
    validator_ok = validator.returncode == 0 and '"status": "approved"' in validator.stdout
    write_json(
        out / "validator-receipt.json",
        {
            **meta(), **base, "stage": "validator", "command": validator_command,
            "exitCode": validator.returncode, "stdout": validator.stdout,
            "stderr": validator.stderr, "status": "approved" if validator_ok else "failed",
        },
    )
    if not validator_ok:
        not_run_receipt(out, "importer-dry-run-receipt.json", "validator_failed", base)
        return "validation-review", validator.stderr or validator.stdout, {
            "canonicalizer": "passed", "validator": "failed", "importerDryRun": "not_run"
        }

    importer_command = [
        "node", str(IMPORTER), f"--artifacts={out / 'artifact.json'}", "--sample-limit=10"
    ]
    importer = subprocess.run(importer_command, cwd=ROOT, capture_output=True, text=True)
    try:
        parsed = json.loads(importer.stdout)
    except json.JSONDecodeError:
        parsed = {}
    importer_ok = (
        importer.returncode == 0
        and parsed.get("ok") is True
        and parsed.get("validationIssueCount", 0) == 0
        and parsed.get("materialized", 0) == 0
    )
    write_json(
        out / "importer-dry-run-receipt.json",
        {
            **meta(), **base, "stage": "dedicated-importer-dry-run",
            "command": importer_command, "exitCode": importer.returncode,
            "stdout": importer.stdout, "stderr": importer.stderr, "parsed": parsed,
            "status": "passed" if importer_ok else "failed",
        },
    )
    return (
        ("approved", "", {"canonicalizer": "passed", "validator": "passed", "importerDryRun": "passed"})
        if importer_ok
        else ("validation-review", importer.stderr or importer.stdout, {
            "canonicalizer": "passed", "validator": "passed", "importerDryRun": "failed"
        })
    )


def verify_input(item: dict) -> str:
    source_file = Path(item["sourceFile"])
    source_text = Path(item["sourceTextFile"])
    source_contract = Path(item["sourceContract"])
    if not source_file.is_file() or not source_text.is_file() or not source_contract.is_file():
        raise ValueError("locked source file, text, or contract is missing")
    digest = sha256(source_file)
    if digest != item["sourceDigest"]:
        raise ValueError(f"source digest mismatch: expected {item['sourceDigest']}, actual {digest}")
    contract = json.loads(source_contract.read_text(encoding="utf-8"))
    contract_status = contract.get("status") or contract.get("sourceStatus") or contract.get("source_status")
    if contract_status not in {"source_ready", "ready"}:
        raise ValueError(f"source contract is not ready: {contract_status}")
    if len(item["responsibilities"]) != item["responsibilityCount"]:
        raise ValueError("locked responsibility count mismatch")
    for responsibility in item["responsibilities"]:
        packet = Path(responsibility["evidencePacket"])
        if not packet.is_file() or sha256(packet) != responsibility["evidencePacketSha256"]:
            raise ValueError(f"evidence packet mismatch: {packet}")
    return digest


def write_product_sums(out: Path) -> None:
    rows = []
    for path in sorted(candidate for candidate in out.iterdir() if candidate.is_file() and candidate.name != "sha256.json"):
        rows.append({"path": str(path), "bytes": path.stat().st_size, "sha256": sha256(path)})
    write_json(out / "sha256.json", {"schema": "luna-product-sha256/v1", "files": rows})


def run_one(batch: int, batch_order: int, global_order: int, item: dict) -> dict:
    started = time.time()
    out = product_dir(item, batch, batch_order)
    out.mkdir(parents=True, exist_ok=False)
    base = {
        "batch": batch, "batchOrder": batch_order, "globalOrder": global_order,
        "selectedOrder": item["selectedOrder"], "company": item["company"],
        "productName": item["productName"], "sourceUrl": item["sourceUrl"],
        "lockedResponsibilityCount": item["responsibilityCount"], "productDir": str(out),
    }
    status = "model-retry"
    digest = item.get("sourceDigest")
    artifact_count = 0
    error = ""
    gates = {"canonicalizer": "not_run", "validator": "not_run", "importerDryRun": "not_run"}
    provider_status = "not_run"
    try:
        digest = verify_input(item)
        write_json(out / "source-verification.json", {**meta(), **base, "sourceDigest": digest, "verified": True})
        artifact = run_model(item, out, digest)
        provider_status = "completed"
        write_json(out / "raw-artifact.json", artifact)
        artifact_count = len(artifact.get("responsibilities") or [])
        status, error, gates = run_gates(item, out, digest, base)
    except ValueError as exc:
        error = str(exc)
        if not (out / "source-verification.json").exists():
            status = "source-retry"
        not_run_receipt(out, "canonicalizer-receipt.json", status, base)
        not_run_receipt(out, "validator-receipt.json", status, base)
        not_run_receipt(out, "importer-dry-run-receipt.json", status, base)
    except (RuntimeError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        error = str(exc)
        status = "model-retry"
        not_run_receipt(out, "canonicalizer-receipt.json", status, base)
        not_run_receipt(out, "validator-receipt.json", status, base)
        not_run_receipt(out, "importer-dry-run-receipt.json", status, base)

    provider = {
        **meta(), **base, "sourceDigest": digest, "callCount": 1 if provider_status == "completed" else 0,
        "status": provider_status, "error": error if provider_status != "completed" else "",
    }
    write_json(out / "provider-receipt.json", provider)
    result = {
        **meta(), **base, "sourceDigest": digest, "status": status,
        "responsibilityCount": artifact_count, "artifactPath": str(out / "artifact.json") if (out / "artifact.json").exists() else None,
        "gates": gates, "error": error, "elapsedSeconds": round(time.time() - started, 2),
    }
    write_json(out / "result.json", result)
    write_json(out / "terminal.json", {**result, "terminal": status, "materialized": 0})
    write_product_sums(out)
    return result


def write_tree_sums(root: Path, output_name: str) -> None:
    rows = []
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file() and candidate.name != output_name):
        rows.append({"path": str(path.relative_to(root)), "bytes": path.stat().st_size, "sha256": sha256(path)})
    write_json(root / output_name, {"schema": "luna-batch-sha256/v1", "files": rows})


def main() -> int:
    rows = [json.loads(line) for line in MANIFEST.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(rows) != 23 or len({row["sourceDigest"] for row in rows}) != 23:
        raise RuntimeError("locked Luna manifest must contain exactly 23 unique source digests")
    if OUTPUT.exists():
        raise RuntimeError(f"output directory must be new: {OUTPUT}")

    started = time.time()
    OUTPUT.mkdir(parents=True)
    input_lock = {
        "schema": "inventory-wave-luna-input-lock/v1", "manifest": str(MANIFEST),
        "manifestSha256": sha256(MANIFEST), "inventorySummary": str(WAVE / "summary.json"),
        "inventorySummarySha256": sha256(WAVE / "summary.json"), "selected": 23,
        "batchSizes": list(BATCH_SIZES), "sourceDigestsUnique": True, **meta(),
    }
    write_json(OUTPUT / "input-lock.json", input_lock)

    all_results: list[dict] = []
    cursor = 0
    for batch, size in enumerate(BATCH_SIZES, start=1):
        batch_rows = rows[cursor:cursor + size]
        cursor += size
        batch_root = OUTPUT / f"batch-{batch:03d}"
        batch_root.mkdir()
        write_jsonl(batch_root / "immutable-manifest.jsonl", batch_rows)
        write_json(
            batch_root / "manifest-lock.json",
            {"batch": batch, "selected": size, "manifestSha256": sha256(batch_root / "immutable-manifest.jsonl"), **meta()},
        )
        batch_started = time.time()
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = [
                pool.submit(run_one, batch, order, len(all_results) + order, item)
                for order, item in enumerate(batch_rows, start=1)
            ]
            batch_results = [future.result() for future in futures]
        batch_results.sort(key=lambda row: row["batchOrder"])
        all_results.extend(batch_results)
        write_jsonl(batch_root / "terminal.jsonl", batch_results)
        counts = {status: sum(row["status"] == status for row in batch_results) for status in (
            "approved", "validation-review", "model-retry", "source-retry", "manual-review"
        )}
        write_json(
            batch_root / "summary.json",
            {
                **meta(), "batch": batch, "selected": size, "processed": len(batch_results),
                "counts": counts, "responsibilityCount": sum(row["responsibilityCount"] for row in batch_results),
                "elapsedSeconds": round(time.time() - batch_started, 2),
            },
        )
        write_tree_sums(batch_root, "batch-sha256.json")

    write_jsonl(OUTPUT / "terminal.jsonl", all_results)
    counts = {status: sum(row["status"] == status for row in all_results) for status in (
        "approved", "validation-review", "model-retry", "source-retry", "manual-review"
    )}
    elapsed = time.time() - started
    approved = counts["approved"]
    summary = {
        **meta(), "status": "completed", "selected": 23, "processed": len(all_results),
        "counts": counts, "responsibilityCount": sum(row["responsibilityCount"] for row in all_results),
        "lockedResponsibilityCount": sum(row["lockedResponsibilityCount"] for row in all_results),
        "providerReceipts": len(all_results),
        "providerCalls": sum(json.loads((Path(row["productDir"]) / "provider-receipt.json").read_text())["callCount"] for row in all_results),
        "canonicalizerPassed": sum(row["gates"]["canonicalizer"] == "passed" for row in all_results),
        "validatorPassed": sum(row["gates"]["validator"] == "passed" for row in all_results),
        "importerDryRunPassed": sum(row["gates"]["importerDryRun"] == "passed" for row in all_results),
        "elapsedSeconds": round(elapsed, 2),
        "validatedProductsPerHour": round(approved * 3600 / elapsed, 2) if elapsed else 0,
    }
    write_json(OUTPUT / "summary.json", summary)
    write_tree_sums(OUTPUT, "sha256.json")
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
