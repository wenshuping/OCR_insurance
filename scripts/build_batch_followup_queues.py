#!/usr/bin/env python3
"""Normalize batch-001 follow-up queues and verify their partition."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def value(record: dict[str, Any], *names: str, default: Any = "") -> Any:
    for name in names:
        if record.get(name) not in (None, ""):
            return record[name]
    return default


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--batch", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, action="append", required=True)
    parser.add_argument("--outdir", type=Path, required=True)
    parser.add_argument("--batch-offset", type=int, default=0)
    args = parser.parse_args()

    batch_rows = read_jsonl(args.batch)
    normalized: list[dict[str, Any]] = []
    for receipt_path in args.receipt:
        for receipt in read_jsonl(receipt_path):
            classification = value(receipt, "category", "classification", "status")
            if classification == "approved-candidate":
                continue
            row = int(value(receipt, "row", "packetRow", default=0) or 0)
            global_row = int(value(receipt, "globalActionableRow", "globalReviewRow", "globalRow", default=0) or 0)
            selection_row = global_row - args.batch_offset if global_row else row
            batch = batch_rows[selection_row - 1] if 1 <= selection_row <= len(batch_rows) else {}
            normalized.append({
                "row": selection_row,
                "packetRow": row,
                "company": value(batch, "company", default=value(receipt, "company", default="")),
                "productName": value(batch, "productName", default=value(receipt, "productName", default="")),
                "dedupKey": value(batch, "dedupKey", default=value(receipt, "dedupKey", default="")),
                "sourceDigest": value(batch, "sourceDigest", default=value(receipt, "sourceDigest", default="")),
                "sourceUrl": value(batch, "sourceUrl", default=value(receipt, "sourceUrl", default="")),
                "resultPath": value(receipt, "resultPath", default=batch.get("resultPath", "")),
                "artifactPath": value(receipt, "artifactPath", "artifact", "originArtifact", default=batch.get("artifactPath", "")),
                "statusSource": value(receipt, "statusSource", default=batch.get("statusSource", "")),
                "classification": classification,
                "blocker": value(receipt, "reason", "error", default=""),
                "failureStage": value(receipt, "failureLayer", "stage", default=""),
                "originalReceiptPath": str(receipt_path),
                "originalReceipt": receipt,
                "parseOnly": True,
                "databaseWrites": False,
                "feishuWrites": False,
                "published": False,
            })

    groups = {
        "source-retry-handoff.jsonl": [item for item in normalized if item["classification"] == "source-blocked"],
        "unresolved-bounded-repair.jsonl": [item for item in normalized if item["classification"] == "unresolved"],
        "validation-importer-bounded-repair.jsonl": [item for item in normalized if item["classification"] in {"validation-failure", "validation/importer failure", "validation/importer-failure", "validation-or-importer-failure"}],
    }
    args.outdir.mkdir(parents=True, exist_ok=True)
    for filename, items in groups.items():
        with (args.outdir / filename).open("w", encoding="utf-8") as handle:
            for item in items:
                if filename == "source-retry-handoff.jsonl":
                    output = {
                        "row": item["row"], "company": item["company"], "productName": item["productName"],
                        "dedupKey": item["dedupKey"], "sourceDigest": item["sourceDigest"], "sourceUrl": item["sourceUrl"],
                        "blocker": item["blocker"], "resultPath": item["resultPath"], "artifactPath": item["artifactPath"],
                        "statusSource": item["statusSource"], "route": "SOURCE", "parseOnly": True,
                    }
                else:
                    output = {
                        **item,
                        "repairScope": "bounded exact failing responsibility/field only; do not rerun the whole product",
                    }
                handle.write(json.dumps(output, ensure_ascii=False, sort_keys=True) + "\n")
    counts = {name: len(items) for name, items in groups.items()}
    keys = [item["dedupKey"] for items in groups.values() for item in items]
    summary = {
        "task": "REVIEW_BACKLOG_912", "batch": args.outdir.name, "inputRows": len(batch_rows),
        "sourceRetryCount": counts["source-retry-handoff.jsonl"],
        "unresolvedCount": counts["unresolved-bounded-repair.jsonl"],
        "validationImporterFailureCount": counts["validation-importer-bounded-repair.jsonl"],
        "partitionTotal": sum(counts.values()), "expectedPartitionTotal": sum(counts.values()),
        "dedupKeysUnique": len(keys) == len(set(keys)),
        "pairwiseIntersections": 0,
        "parseOnly": True, "databaseWrites": False, "feishuWrites": False, "published": False,
    }
    (args.outdir / "followup-queue-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
