#!/usr/bin/env python3
"""Run one immutable Luna canary with the production validator schema contract."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
WAVE = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/inventory-wave-20260801-003"
DEFERRED = WAVE / "execution/luna-bounded-verifier-15-20260801-v2/deferred-by-systemic-stop.jsonl"
ROUTING = WAVE / "routing/luna-complex.jsonl"
OUTPUT = WAVE / "execution/luna-bounded-verifier-schema-contract-canary-20260801"
DRIVER = ROOT / "scripts/execute_inventory_wave003_luna_complex.py"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def load_driver():
    spec = importlib.util.spec_from_file_location("inventory_wave003_luna", DRIVER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load driver: {DRIVER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    if OUTPUT.exists():
        raise RuntimeError(f"immutable output already exists: {OUTPUT}")
    deferred = read_jsonl(DEFERRED)
    routing = {row["sourceDigest"]: row for row in read_jsonl(ROUTING)}
    selected = deferred[0]
    item = routing[selected["sourceDigest"]]
    if not selected.get("inventoryExact"):
        raise RuntimeError("schema canary must use an inventory-exact deferred product")
    if [row["responsibilityId"] for row in item["responsibilities"]] != selected["lockedResponsibilityIds"]:
        raise RuntimeError("locked inventory mismatch")

    driver = load_driver()
    digest = driver.verify_input(item)
    artifact_path = Path(selected["artifactPath"])
    validator_receipt_path = Path(selected["productOutput"]) / "validator-receipt.json"
    validator_receipt = read_json(validator_receipt_path)
    issue_text = "\n".join(
        value for value in (validator_receipt.get("stdout"), validator_receipt.get("stderr"))
        if isinstance(value, str) and value.strip()
    )
    issues = [line.strip() for line in issue_text.splitlines() if line.strip()]
    if not issues:
        raise RuntimeError("deferred canary has no locked validator issues")

    OUTPUT.mkdir(parents=True)
    base = {
        "company": item["company"],
        "productName": item["productName"],
        "sourceUrl": item["sourceUrl"],
        "sourceDigest": digest,
        "lockedResponsibilityCount": item["responsibilityCount"],
    }
    write_json(OUTPUT / "input-lock.json", {
        "schema": "luna-bounded-schema-contract-canary-input-lock/v1",
        **base,
        "deferredQueue": str(DEFERRED),
        "deferredQueueSha256": sha256(DEFERRED),
        "routingManifest": str(ROUTING),
        "routingManifestSha256": sha256(ROUTING),
        "artifactPath": str(artifact_path),
        "artifactSha256": sha256(artifact_path),
        "validatorReceipt": str(validator_receipt_path),
        "validatorReceiptSha256": sha256(validator_receipt_path),
        "lockedResponsibilityIds": selected["lockedResponsibilityIds"],
        "provider": "codex",
        "modelId": driver.MODEL,
        "callLimit": 1,
        "repairRounds": 0,
        "parseOnly": True,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    })
    prompt_text = driver.bounded_repair_prompt(item, digest, artifact_path, issues)
    artifact = driver.run_model(item, OUTPUT, digest, prompt_text=prompt_text)
    write_json(OUTPUT / "raw-artifact.json", artifact)
    provider_receipt = {
        "schema": "luna-bounded-schema-contract-canary-provider-receipt/v1",
        **base,
        "provider": "codex",
        "modelId": driver.MODEL,
        "executionMode": "direct_codex_thread",
        "callCount": 1,
        "repairRounds": 0,
        "scope": "locked validator failures and exact evidence packets only",
        "wholeDocumentRerun": False,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    }
    write_json(OUTPUT / "provider-receipt.json", provider_receipt)

    actual_ids = [row.get("responsibilityId") for row in artifact.get("responsibilities", [])]
    locked_ids = selected["lockedResponsibilityIds"]
    if actual_ids != locked_ids:
        driver.not_run_receipt(OUTPUT, "canonicalizer-receipt.json", "locked_inventory_changed", base)
        driver.not_run_receipt(OUTPUT, "validator-receipt.json", "locked_inventory_changed", base)
        driver.not_run_receipt(OUTPUT, "importer-dry-run-receipt.json", "locked_inventory_changed", base)
        terminal_status = "model"
        gate_status = {"canonicalizer": "not_run", "validator": "not_run", "importerDryRun": "not_run"}
        error = "locked responsibility inventory changed"
    else:
        terminal_status, error, gate_status = driver.run_gates(item, OUTPUT, digest, base)

    write_json(OUTPUT / "terminal.json", {
        "schema": "luna-bounded-schema-contract-canary-terminal/v1",
        **base,
        "terminalStatus": terminal_status,
        "lockedResponsibilityIds": locked_ids,
        "artifactResponsibilityIds": actual_ids,
        "responsibilityInventoryUnchanged": actual_ids == locked_ids,
        "gates": gate_status,
        "error": error,
        "providerCalls": 1,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
    })
    files = []
    for path in sorted(candidate for candidate in OUTPUT.iterdir() if candidate.is_file() and candidate.name != "sha256.json"):
        files.append({"path": path.name, "bytes": path.stat().st_size, "sha256": sha256(path)})
    write_json(OUTPUT / "sha256.json", {"schema": "luna-bounded-schema-contract-canary-sha256/v1", "files": files})
    print(json.dumps({"output": str(OUTPUT), "terminalStatus": terminal_status, "gates": gate_status}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
