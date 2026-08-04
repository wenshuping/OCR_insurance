#!/usr/bin/env python3
"""Select the next disjoint clean actionable review batch from the locked ledger."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def rows(path: Path):
    with path.open(encoding="utf-8") as handle:
        for line in handle:
            if line.strip():
                yield json.loads(line)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger", type=Path, required=True)
    parser.add_argument("--exclude", type=Path, action="append", default=[])
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()

    excluded = {row["dedupKey"] for path in args.exclude for row in rows(path)}
    candidates = [
        row for row in rows(args.ledger)
        if row.get("status") in {"validation-review", "manual-review"}
        and row.get("ambiguousSourceOrModel") is False
        and row.get("dedupKey") not in excluded
    ]
    selected = candidates[: args.limit]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as handle:
        for row in selected:
            handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    summary = {
        "sourceLedger": str(args.ledger),
        "excludedInputs": [str(path) for path in args.exclude],
        "candidateCountBeforeSelection": len(candidates),
        "selectedCount": len(selected),
        "limit": args.limit,
        "dedupKeysUnique": len({row["dedupKey"] for row in selected}) == len(selected),
        "statusCounts": {
            status: sum(row.get("status") == status for row in selected)
            for status in ("validation-review", "manual-review")
        },
        "allClean": all(row.get("ambiguousSourceOrModel") is False for row in selected),
        "selectedRows": [
            {"dedupKey": row["dedupKey"], "company": row.get("company"), "productName": row.get("productName")}
            for row in selected
        ],
    }
    args.summary.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
