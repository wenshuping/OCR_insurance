#!/usr/bin/env python3
"""Create disjoint packet inputs for a locked actionable review batch."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--outdir", type=Path, required=True)
    args = parser.parse_args()
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(rows) <= 34:
        first = (len(rows) + 2) // 3
        second = first + (len(rows) - first + 1) // 2
        ranges = {"packet-a": (0, first), "packet-b": (first, second), "packet-c": (second, len(rows))}
    else:
        ranges = {"packet-a": (0, 34), "packet-b": (34, 67), "packet-c": (67, 100)}
    args.outdir.mkdir(parents=True, exist_ok=True)
    summary = {"input": str(args.input), "total": len(rows), "packets": {}}
    for name, (start, end) in ranges.items():
        selected = rows[start:end]
        path = args.outdir / f"{name}.jsonl"
        with path.open("w", encoding="utf-8") as handle:
            for row in selected:
                handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        summary["packets"][name] = {"rows": f"{start + 1}-{end}", "count": len(selected), "path": str(path)}
    keys = [row["dedupKey"] for row in rows]
    summary.update({"sumCheck": sum(item["count"] for item in summary["packets"].values()) == len(rows), "dedupKeysUnique": len(keys) == len(set(keys)), "parseOnly": True})
    (args.outdir / "packet-plan.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
