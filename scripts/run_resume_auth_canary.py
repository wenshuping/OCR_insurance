#!/usr/bin/env python3
"""Run the single locked resume-auth canary, offline and parse-only."""

from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


INPUT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/health-critical-fresh-window-5-20260727/"
    "resume-auth-recovered-20260728/canary-shard-1.json"
)
OUTPUT = INPUT.parent / "canary-agent"
CANONICALIZER = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration/"
    ".agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/canonicalize_excerpts.py"
)
VALIDATOR = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/.worktrees/dev-agent-semantic-integration/"
    ".agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/validate_artifact.py"
)
MODEL_META = {
    "provider": "codex",
    "modelId": "gpt-5.6-luna",
    "parseOnly": True,
    "parse_only": True,
    "databaseWrites": False,
    "sqliteWritten": False,
    "feishuWrites": False,
    "feishuWritten": False,
    "publication": False,
}


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def main() -> int:
    rows = json.loads(INPUT.read_text(encoding="utf-8"))
    if len(rows) != 1:
        raise SystemExit(f"canary scope violation: expected exactly one row, got {len(rows)}")
    row = rows[0]
    locked = Path(row["lockedProductDir"])
    if Path(row["productDir"]).resolve() != locked.resolve():
        raise SystemExit("canary scope violation: productDir is not lockedProductDir")
    source_text = locked / "official-source.pages.txt"
    source_pdf = locked / "official-source.pdf"
    base_artifact = locked / "round-1-canonical.json"
    if not all(path.is_file() for path in (source_text, source_pdf, base_artifact)):
        raise SystemExit("locked source/artifact files are incomplete")

    product_out = OUTPUT / locked.name
    product_out.mkdir(parents=True, exist_ok=True)
    draft = product_out / "artifact.draft.json"
    canonical = product_out / "artifact.json"
    shutil.copy2(source_text, product_out / "official-source.pages.txt")
    shutil.copy2(source_pdf, product_out / "official-source.pdf")
    artifact = json.loads(base_artifact.read_text(encoding="utf-8"))
    # Preserve the full medical comparison instead of the incomplete prior retry.
    medical = artifact["responsibilities"][0]["indicators"][0]
    medical["basisKey"] = (
        "min_of_actual_medical_expense_net_of_third_party_and_deductible_reimbursementRate_"
        "liabilityLimit_actual_medical_expense_net_of_third_party"
    )
    medical["operands"] = [
        {
            "operandId": "reimbursed_amount",
            "formulaText": "(actualMedicalExpense-thirdPartyPaid-deductible)×reimbursementRate",
            "basisKey": "actual_medical_expense_net_of_third_party_and_deductible",
            "calculationKey": "medical_reimbursement",
            "requiredInputs": ["actualMedicalExpense", "thirdPartyPaid", "deductible", "reimbursementRate"],
            "evidenceTokens": ["超过本附加合同约定的免赔额的部分", "按约定的给付比例"],
        },
        {
            "operandId": "remaining_medical_expense",
            "formulaText": "actualMedicalExpense-thirdPartyPaid",
            "basisKey": "actual_medical_expense_net_of_third_party",
            "calculationKey": "remaining_medical_expense",
            "requiredInputs": ["actualMedicalExpense", "thirdPartyPaid"],
            "evidenceTokens": ["实际发生并支付的", "已经补偿或给付的部分"],
        },
        {
            "operandId": "liability_limit",
            "formulaText": "liabilityLimit",
            "basisKey": "liability_limit",
            "calculationKey": "liability_limit",
            "requiredInputs": ["liabilityLimit"],
            "evidenceTokens": ["最高以该被保险人本项保险责任相对应的基本保险金额为限"],
        },
    ]
    artifact.setdefault("runMetadata", {}).update({**MODEL_META, "scope": "resume-auth-recovered-20260728-canary"})
    artifact.setdefault("publication", {}).update({"sqlite": "not_requested_parse_only", "feishu": "not_requested", "published": False})
    write_json(draft, artifact)

    canonical_run = subprocess.run(
        ["python3", str(CANONICALIZER), "--artifact", str(draft), "--source-text", str(source_text), "--output", str(canonical)],
        capture_output=True, text=True, check=False,
    )
    write_json(product_out / "canonicalize-receipt.json", {**MODEL_META, "status": "completed" if canonical_run.returncode == 0 else "failed", "command": canonical_run.args, "exitCode": canonical_run.returncode, "stdout": canonical_run.stdout, "stderr": canonical_run.stderr})
    if canonical_run.returncode != 0:
        raise SystemExit(canonical_run.stderr or canonical_run.stdout)

    validator_run = subprocess.run(
        ["python3", str(VALIDATOR), "--artifact", str(canonical), "--source-text", str(source_text), "--source-document", str(source_pdf), "--official-domain", "obs-shlife-website-prd.obs.cn-east-201.jrzq.huaweicloud.com"],
        capture_output=True, text=True, check=False,
    )
    approved = validator_run.returncode == 0 and '"status": "approved"' in validator_run.stdout
    receipt = {**MODEL_META, "status": "approved" if approved else "validation-review", "failureLayer": None if approved else "validation", "command": validator_run.args, "exitCode": validator_run.returncode, "stdout": validator_run.stdout, "stderr": validator_run.stderr, "company": row["company"], "productName": row["productName"], "sourceDigest": row["sourceDigest"]}
    write_json(product_out / "validator-receipt.json", receipt)
    digest = hashlib.sha256(canonical.read_bytes()).hexdigest()
    result = {**MODEL_META, "status": "approved" if approved else "validation-review", "company": row["company"], "productName": row["productName"], "lockedProductDir": str(locked), "artifactPath": str(canonical), "canonicalizerReceiptPath": str(product_out / "canonicalize-receipt.json"), "validatorReceiptPath": str(product_out / "validator-receipt.json"), "artifactSha256": f"sha256:{digest}", "sourceDigest": row["sourceDigest"], "responsibilityCount": len(artifact.get("responsibilities", [])), "updatedAt": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")}
    write_json(product_out / "result.json", result)
    write_jsonl(OUTPUT / ("approved.jsonl" if approved else "validation-review.jsonl"), result)
    write_json(OUTPUT / "manifest.json", {"scope": "resume-auth-recovered-20260728", "input": str(INPUT), "processed": 1, "selectedProduct": row["productName"], "lockedProductDir": str(locked), **MODEL_META})
    write_json(OUTPUT / "summary.json", {"scope": "resume-auth-recovered-20260728", "total": 1, "processed": 1, "approved": int(approved), "validationReview": int(not approved), "modelRetry": 0, "sourceRetry": 0, "productName": row["productName"], **MODEL_META})
    print(json.dumps(result, ensure_ascii=False))
    return 0 if approved else 2


if __name__ == "__main__":
    raise SystemExit(main())
