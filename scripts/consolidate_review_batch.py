#!/usr/bin/env python3
"""Consolidate disjoint REVIEW packet receipts into a parse-only batch summary."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch", type=Path, required=True)
    ap.add_argument("--packet-summary", type=Path, action="append", required=True)
    ap.add_argument("--receipt", type=Path, action="append", required=True)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    batch_rows = read_jsonl(args.batch)
    summaries = [json.loads(p.read_text(encoding="utf-8")) for p in args.packet_summary]
    receipts = [record for p in args.receipt for record in read_jsonl(p)]
    counts = {"approved-candidate": 0, "source-blocked": 0, "unresolved": 0, "validation-or-importer-failure": 0}
    candidate_rows: list[int] = []
    seen_rows: list[int] = []
    for rec in receipts:
        row = int(rec.get("globalActionableRow") or rec.get("globalReviewRow") or rec.get("globalRow") or 0)
        if row:
            seen_rows.append(row)
        category = rec.get("category") or rec.get("classification") or rec.get("status")
        if category in counts:
            counts[category] += 1
        if category == "approved-candidate":
            candidate_rows.append(row)
    expected_rows = list(range(301, 327))
    if sorted(seen_rows) != expected_rows or len(seen_rows) != len(set(seen_rows)):
        raise SystemExit(f"packet row coverage mismatch: {sorted(seen_rows)}")
    result = {
        "task": "REVIEW_BACKLOG_912",
        "batch": "batch-004",
        "inputPath": str(args.batch),
        "inputRowCount": len(batch_rows),
        "inputSha256": sha256(args.batch),
        "globalActionableRows": "301-326 inclusive",
        "packetSummaries": [{"path": str(p), "sha256": sha256(p)} for p in args.packet_summary],
        "receiptFiles": [{"path": str(p), "sha256": sha256(p)} for p in args.receipt],
        "counts": counts,
        "processedRowCount": len(seen_rows),
        "approvedCandidateGlobalRows": sorted(candidate_rows),
        "partitionCheck": {
            "sum": sum(counts.values()),
            "expected": len(batch_rows),
            "rowsUnique": len(seen_rows) == len(set(seen_rows)),
            "rowsExact": sorted(seen_rows) == expected_rows,
        },
        "parseOnly": True,
        "modelCalls": False,
        "networkCalls": False,
        "sqliteWrites": False,
        "feishuWrites": False,
        "published": False,
        "productionApproval": False,
    }
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
