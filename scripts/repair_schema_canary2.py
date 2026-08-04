#!/usr/bin/env python3
"""Repair the one non-contiguous evidence token in the accident canary."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
OUT = ROOT / "artifacts/review-backlog-912-20260728/schema-canary/canary-2"
INPUT = OUT / "canonicalized-artifact.json"
REPAIRED = OUT / "repaired-artifact.json"
CANONICAL = OUT / "canonicalized-repaired-artifact.json"
SOURCE_TEXT = ROOT / "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/soochow-bulk-source-repair-20260726T114547Z/texts/380112bb3e6a7ee8.txt"
SOURCE_PDF = ROOT / "artifacts/responsibility-remaining-gemini-20260726-153737/source-repair/soochow-bulk-source-repair-20260726T114547Z/sources/380112bb3e6a7ee8.pdf"
RESP_TOOLS = ROOT / ".worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts"
CANONICALIZER = RESP_TOOLS / "canonicalize_excerpts.py"
VALIDATOR = RESP_TOOLS / "validate_artifact.py"
IMPORTER = ROOT / "scripts/import-reviewed-responsibility-artifacts.mjs"


def run(command: list[str], stdout_path: Path, stderr_path: Path) -> tuple[int, str]:
    result = subprocess.run(command, text=True, capture_output=True, cwd=ROOT)
    stdout_path.write_text(result.stdout, encoding="utf-8")
    stderr_path.write_text(result.stderr, encoding="utf-8")
    return result.returncode, result.stdout


def main() -> None:
    artifact = json.loads(INPUT.read_text(encoding="utf-8"))
    old = "意外身故保险金额给付意外身故保险金"
    new = "给付意外身故保险金"
    changes = []
    for responsibility in artifact.get("responsibilities", []):
        for indicator in responsibility.get("indicators", []):
            tokens = indicator.get("evidenceTokens", [])
            if old in tokens:
                indicator["evidenceTokens"] = [new if token == old else token for token in tokens]
                changes.append(f"{responsibility.get('responsibilityId')}.indicators[0].evidenceTokens")
    if not changes:
        raise SystemExit("expected non-contiguous token was not found")
    REPAIRED.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    c_rc, c_out = run([
        "python3", str(CANONICALIZER), "--artifact", str(REPAIRED), "--source-text", str(SOURCE_TEXT), "--output", str(CANONICAL)
    ], OUT / "repair-canonicalizer.stdout", OUT / "repair-canonicalizer.stderr")
    v_rc, v_out = run([
        "python3", str(VALIDATOR), "--artifact", str(CANONICAL), "--source-document", str(SOURCE_PDF), "--source-text", str(SOURCE_TEXT), "--official-domain", "www.soochowlife.net"
    ], OUT / "repair-validator.stdout", OUT / "repair-validator.stderr")
    input_jsonl = OUT / "repair-import-inputs.jsonl"
    input_jsonl.write_text(json.dumps({"artifactPath": str(CANONICAL)}, ensure_ascii=False) + "\n", encoding="utf-8")
    i_rc, i_out = run([
        "node", str(IMPORTER), "--db-path=" + str(OUT / "should-not-exist.sqlite"), "--artifacts=" + str(input_jsonl), "--sample-limit=10"
    ], OUT / "repair-importer.stdout", OUT / "repair-importer.stderr")
    try:
        validator = json.loads(v_out.strip().splitlines()[-1])
    except (json.JSONDecodeError, IndexError):
        validator = {"ok": False, "raw": v_out}
    try:
        importer = json.loads("\n".join(line for line in i_out.splitlines() if not line.startswith("(node:")))
    except json.JSONDecodeError:
        importer = {"ok": False, "raw": i_out}
    receipt = {
        "task": "FIRST_PARSE_BATCH1_HANDOFF",
        "canary": "canary-2",
        "productName": artifact.get("productName"),
        "deterministicChanges": changes,
        "replacedToken": {"from": old, "to": new, "basis": "exact contiguous official source text"},
        "canonicalizer": {"exitCode": c_rc, "stdout": c_out, "converged": c_rc == 0},
        "validator": {"exitCode": v_rc, **validator},
        "importerDryRun": {"exitCode": i_rc, **importer},
        "candidate": v_rc == 0 and validator.get("ok") is True and i_rc == 0 and importer.get("ok") is True and importer.get("validationIssueCount") == 0,
        "parseOnly": True,
        "databaseWrites": False,
        "feishuWrites": False,
        "published": False,
    }
    (OUT / "canary-repair-receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if (OUT / "should-not-exist.sqlite").exists():
        raise SystemExit("dry-run unexpectedly created a database file")


if __name__ == "__main__":
    main()
