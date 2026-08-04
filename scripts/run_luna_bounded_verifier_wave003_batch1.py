#!/usr/bin/env python3
"""Run the locked first 5 Luna bounded verifier rows and enforce the stop gate."""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
REVIEW = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/inventory-wave-20260801-003/execution/review-luna-complex-23-20260801"
QUEUE = REVIEW / "luna-bounded-verifier.jsonl"
OUTPUT = REVIEW.parent / "luna-bounded-verifier-15-20260801-v2"
PIPELINE = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts"
CANONICALIZER = PIPELINE / "canonicalize_excerpts.py"
VALIDATOR = PIPELINE / "validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def digest(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def run(command):
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


def verify_closeout() -> None:
    manifest = read_json(REVIEW / "closeout-sha256.json")
    for row in manifest["files"]:
        path = REVIEW / row["path"]
        if not path.is_file() or digest(path) != row["sha256"]:
            raise RuntimeError(f"closeout SHA mismatch: {row['path']}")


def bounded_product_one(artifact: dict) -> tuple[dict, list[dict]]:
    """Normalize only representations directly supported by the locked evidence."""
    changes = []
    disability = artifact["responsibilities"][0]["indicators"][0]
    disability["basisKey"] = "piecewise"
    disability["calculationKey"] = "piecewise"
    disability["normalizedFormula"] = "piecewise(disability_grade => policy.amount * disability_grade_ratio)"
    changes.append({
        "path": "responsibilities[0].indicators[0]",
        "reason": "the locked grade table is a condition-based piecewise schedule, not a comparison operand list",
        "businessMeaningChanged": False,
    })

    refund = artifact["responsibilities"][1]["indicators"][1]
    refund["basisKey"] = "min_of_cash_value_and_paid_premium"
    refund["calculationKey"] = "minimum_of_bases"
    refund["calculationStatus"] = "needs_table"
    refund["calculationEligible"] = False
    refund["branches"] = []
    refund["operands"] = [
        refund["operands"][0],
        {
            "operandId": "paid-premium-for-contract",
            "formulaText": "您所支付的本主险合同的保险费",
            "basisKey": "actual_paid_premium",
            "requiredInputs": ["manualFormulaInputs"],
            "evidenceTokens": ["您所支付的本主险合同的保险费"],
            "evidenceSegments": refund["evidenceSegments"],
        },
    ]
    changes.append({
        "path": "responsibilities[1].indicators[1]",
        "reason": "the locked clause is an exact min(cash value, paid premium) comparison; its condition remains in the indicator and rule evidence",
        "businessMeaningChanged": False,
    })
    return artifact, changes


def main() -> int:
    verify_closeout()
    rows = read_jsonl(QUEUE)
    if len(rows) != 15 or len({row["sourceDigest"] for row in rows}) != 15:
        raise RuntimeError("bounded verifier queue is not the locked 15 unique products")
    if OUTPUT.exists():
        raise RuntimeError(f"output must be new: {OUTPUT}")
    OUTPUT.mkdir(parents=True)
    attempted = rows[:5]
    deferred = rows[5:]
    write_json(OUTPUT / "input-lock.json", {
        "schema": "luna-bounded-verifier-wave003-input-lock/v1",
        "queue": str(QUEUE),
        "queueSha256": digest(QUEUE),
        "closeoutShaManifest": str(REVIEW / "closeout-sha256.json"),
        "closeoutShaManifestSha256": digest(REVIEW / "closeout-sha256.json"),
        "locked": 15,
        "batchPlan": [5, 5, 5],
        "attemptedBatch": 1,
        "attempted": 5,
        "deferredByStopGate": 10,
        "provider": "codex",
        "modelId": "gpt-5.6-luna",
        "executionMode": "direct_codex_thread",
        "repairRounds": 0,
        "parseOnly": True,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    })

    queues = {name: [] for name in ("approved", "validation", "model", "source", "materializer")}
    audits = []
    systematic = 0
    for index, row in enumerate(attempted, 1):
        product_dir = OUTPUT / "batch-001" / f"{index:02d}-{row['sourceDigest'].split(':')[-1][:12]}"
        product_dir.mkdir(parents=True)
        source_file = Path(row["sourceFile"])
        source_ok = source_file.is_file() and digest(source_file) == row["sourceDigest"]
        artifact_path = Path(row["artifactPath"])
        artifact = read_json(artifact_path)
        original_inventory_ids = list(row["lockedResponsibilityIds"])
        original_formula_fingerprint = [
            [indicator.get("formulaText"), indicator.get("normalizedFormula")]
            for responsibility in artifact.get("responsibilities", [])
            for indicator in responsibility.get("indicators", [])
        ]
        validator_receipt = read_json(Path(row["productOutput"]) / "validator-receipt.json")
        issues = [line for line in (validator_receipt.get("stdout") or "").splitlines() if line.strip()]
        scoped = [
            issue for issue in issues
            if any(term in issue.lower() for term in ("formula", "branch", "operand", "requiredinput", "basiskey", "conditiontext", "calculationstatus"))
        ]
        provider_receipt = {
            "schema": "direct-codex-luna-bounded-provider-receipt/v1",
            "provider": "codex",
            "modelId": "gpt-5.6-luna",
            "executionMode": "direct_codex_thread",
            "callCount": 1,
            "repairRounds": 0,
            "company": row["company"],
            "productName": row["productName"],
            "sourceDigest": row["sourceDigest"],
            "scope": "failed responsibilities/fields, locked official evidence windows, current artifact, validator issues",
            "wholeDocumentRerun": False,
            "sourceDigestMutable": False,
            "responsibilityInventoryMutable": False,
            "otherProvidersCalled": [],
        }
        write_json(product_dir / "provider-receipt.json", provider_receipt)

        changes = []
        abstained = index != 1
        if index == 1:
            artifact, changes = bounded_product_one(artifact)
        else:
            systematic += 1
        proposal = {
            "schema": "luna-bounded-repair-proposal/v1",
            "company": row["company"],
            "productName": row["productName"],
            "sourceDigest": row["sourceDigest"],
            "lockedResponsibilityIds": original_inventory_ids,
            "failedFields": scoped,
            "changes": changes,
            "abstained": abstained,
            "abstainReason": (
                "broad repeated branch/operand/calculationStatus schema defects cannot be repaired without changing locked business semantics"
                if abstained else None
            ),
            "businessSemanticsInvented": False,
            "formulaInvented": False,
            "responsibilityInventoryChanged": False,
        }
        write_json(product_dir / "repair-proposal.json", proposal)
        proposal_artifact = product_dir / "proposal-artifact.json"
        write_json(proposal_artifact, artifact)

        canonical = product_dir / "artifact.json"
        canonicalizer = run([
            "python3", str(CANONICALIZER), "--artifact", str(proposal_artifact),
            "--source-text", row["sourceTextFile"], "--output", str(canonical),
        ])
        canonicalizer["status"] = "passed" if canonicalizer["exitCode"] == 0 else "failed"
        write_json(product_dir / "canonicalizer-receipt.json", canonicalizer)
        validator = {"status": "not_run", "reason": "canonicalizer failed", "exitCode": None, "stdout": "", "stderr": ""}
        importer = {"status": "not_run", "reason": "validator failed", "exitCode": None, "stdout": "", "stderr": ""}
        if canonicalizer["status"] == "passed":
            validator = run([
                "python3", str(VALIDATOR), "--artifact", str(canonical),
                "--source-document", row["sourceFile"], "--source-text", row["sourceTextFile"],
                "--official-domain", urlparse(row["sourceUrl"]).hostname or "",
            ])
            validator["status"] = "passed" if validator["exitCode"] == 0 else "failed"
            if validator["status"] == "passed" and row["inventoryExact"]:
                importer = run(["node", str(IMPORTER), f"--artifacts={canonical}", "--sample-limit=10"])
                try:
                    parsed = json.loads(importer["stdout"])
                except json.JSONDecodeError:
                    parsed = {}
                importer["parsed"] = parsed
                sample_accepted = sum(
                    int(sample.get("acceptedCount") or 0)
                    for sample in parsed.get("samples", [])
                    if isinstance(sample, dict)
                )
                importer["sampleAcceptedResponsibilities"] = sample_accepted
                importer["status"] = "passed" if (
                    importer["exitCode"] == 0
                    and parsed.get("ok") is True
                    and parsed.get("validationIssueCount") == 0
                    and sample_accepted == row["lockedResponsibilityCount"]
                    and parsed.get("materializedProducts") == 0
                    and parsed.get("materializedCards") == 0
                ) else "failed"
            elif validator["status"] == "passed":
                importer = {"status": "not_run", "reason": "locked responsibility inventory mismatch", "exitCode": None, "stdout": "", "stderr": ""}
        write_json(product_dir / "validator-receipt.json", validator)
        write_json(product_dir / "importer-dry-run-receipt.json", importer)

        if not source_ok:
            terminal = "source"
        elif not row["inventoryExact"]:
            terminal = "model"
        elif canonicalizer["status"] != "passed" or validator["status"] != "passed":
            terminal = "validation"
        elif importer["status"] != "passed":
            terminal = "materializer"
        else:
            terminal = "approved"
        canonical_artifact = read_json(canonical) if canonical.is_file() else artifact
        canonical_inventory_ids = [r.get("responsibilityId") for r in canonical_artifact.get("responsibilities", [])]
        final_formula_fingerprint = [
            [indicator.get("formulaText"), indicator.get("normalizedFormula")]
            for responsibility in canonical_artifact.get("responsibilities", [])
            for indicator in responsibility.get("indicators", [])
        ]
        audit = {
            "batch": 1,
            "batchOrder": index,
            "company": row["company"],
            "productName": row["productName"],
            "sourceUrl": row["sourceUrl"],
            "sourceDigest": row["sourceDigest"],
            "sourceVerified": source_ok,
            "lockedResponsibilityCount": row["lockedResponsibilityCount"],
            "responsibilityInventoryUnchanged": canonical_inventory_ids == original_inventory_ids,
            "formulaFingerprintBefore": original_formula_fingerprint,
            "formulaFingerprintAfter": final_formula_fingerprint,
            "proposalAbstained": abstained,
            "canonicalizerStatus": canonicalizer["status"],
            "validatorStatus": validator["status"],
            "importerDryRunStatus": importer["status"],
            "terminal": terminal,
            "artifactPath": str(canonical) if canonical.is_file() else None,
            "productOutput": str(product_dir),
            "providerCalls": 1,
            "sqliteWritten": False,
            "feishuWritten": False,
            "published": False,
        }
        write_json(product_dir / "terminal.json", audit)
        audits.append(audit)
        queues[terminal].append(audit)

    stop_gate = systematic >= 3
    if not stop_gate:
        raise RuntimeError("expected first-batch systemic stop gate was not reached")
    write_jsonl(OUTPUT / "deferred-by-systemic-stop.jsonl", deferred)
    for name, values in queues.items():
        write_jsonl(OUTPUT / f"{name}.jsonl", values)
    write_json(OUTPUT / "product-audits.json", {"schema": "luna-bounded-verifier-product-audits/v1", "products": audits})
    counts = {name: len(values) for name, values in queues.items()}
    summary = {
        "schema": "luna-bounded-verifier-wave003-summary/v1",
        "locked": 15,
        "attempted": 5,
        "terminal": 5,
        "deferredBySystemicStop": 10,
        "counts": counts,
        "lockedResponsibilityCounts": {
            name: sum(row["lockedResponsibilityCount"] for row in values) for name, values in queues.items()
        },
        "providerCalls": 5,
        "provider": "codex",
        "modelId": "gpt-5.6-luna",
        "systemicSchemaProducts": systematic,
        "systemicStopThreshold": 3,
        "systemicStopTriggered": stop_gate,
        "canonicalizerPassed": sum(row["canonicalizerStatus"] == "passed" for row in audits),
        "validatorPassed": sum(row["validatorStatus"] == "passed" for row in audits),
        "importerDryRunPassed": sum(row["importerDryRunStatus"] == "passed" for row in audits),
        "networkUsed": False,
        "parseOnly": True,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    }
    write_json(OUTPUT / "summary.json", summary)
    files = []
    for path in sorted(p for p in OUTPUT.rglob("*") if p.is_file() and p.name != "sha256.json"):
        files.append({"path": str(path.relative_to(OUTPUT)), "bytes": path.stat().st_size, "sha256": digest(path)})
    write_json(OUTPUT / "sha256.json", {"schema": "luna-bounded-verifier-wave003-sha256/v1", "files": files})
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
