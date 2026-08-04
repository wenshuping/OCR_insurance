#!/usr/bin/env python3
"""Run one locked wave-007 Luna product through the existing direct runner."""

from __future__ import annotations

import importlib.util
import json
import time
from pathlib import Path


ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance")
PARSER_MANIFEST = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/parse-source-wave007-20260801-v2/manifests/luna-canary-020.json"
OUTPUT = ROOT / "artifacts/responsibility-full-backfill-20260731-v2/parse-source-wave007-20260801-v2/luna-single-canary-001"
RUNNER = ROOT / "scripts/execute_inventory_wave003_luna_complex.py"


def load_runner():
    spec = importlib.util.spec_from_file_location("wave003_luna_runner", RUNNER)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load runner: {RUNNER}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def direct_item(row: dict) -> dict:
    inventory = json.loads(Path(row["inventoryPath"]).read_text(encoding="utf-8"))
    responsibilities = []
    for responsibility in inventory["responsibilities"]:
        responsibilities.append(
            {
                "responsibilityId": responsibility["responsibilityId"],
                "officialTitle": responsibility["officialTitle"],
                "evidencePacket": responsibility["sourceEvidencePacketPath"],
                "evidencePacketSha256": responsibility["sourceEvidencePacketSha256"],
            }
        )
    return {
        "selectedOrder": 1,
        "company": row["company"],
        "productName": row["productName"],
        "sourceUrl": row["sourceUrl"],
        "sourceDigest": row["sourceDigest"],
        "sourceFile": row["sourceDocumentPath"],
        "sourceTextFile": row["sourceTextPath"],
        "sourceContract": row["sourceContract"],
        "responsibilityCount": len(responsibilities),
        "responsibilities": responsibilities,
        "route": "luna",
        "routeReasons": row.get("routeReasons") or [],
    }


def main() -> int:
    if OUTPUT.exists():
        raise FileExistsError(f"refusing existing output: {OUTPUT}")
    rows = json.loads(PARSER_MANIFEST.read_text(encoding="utf-8"))
    item = direct_item(rows[0])
    runner = load_runner()
    runner.OUTPUT = OUTPUT
    OUTPUT.mkdir(parents=True)
    manifest = OUTPUT / "immutable-manifest.jsonl"
    runner.write_jsonl(manifest, [item])
    runner.write_json(
        OUTPUT / "input-lock.json",
        {
            "schema": "source-wave007-luna-single-canary/v1",
            "sourceManifest": str(PARSER_MANIFEST),
            "sourceManifestSha256": runner.sha256(PARSER_MANIFEST),
            "manifest": str(manifest),
            "manifestSha256": runner.sha256(manifest),
            "selected": 1,
            **runner.meta(),
        },
    )
    started = time.time()
    result = runner.run_one(1, 1, 1, item)
    runner.write_jsonl(OUTPUT / "terminal.jsonl", [result])
    runner.write_json(
        OUTPUT / "summary.json",
        {
            **runner.meta(),
            "selected": 1,
            "processed": 1,
            "approved": int(result["status"] == "approved"),
            "validationReview": int(result["status"] == "validation-review"),
            "modelRetry": int(result["status"] == "model-retry"),
            "sourceRetry": int(result["status"] == "source-retry"),
            "responsibilityCount": result["responsibilityCount"],
            "elapsedSeconds": round(time.time() - started, 2),
        },
    )
    runner.write_tree_sums(OUTPUT, "sha256.json")
    print((OUTPUT / "summary.json").read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
