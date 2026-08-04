#!/usr/bin/env python3
"""Build a deterministic remainder queue without changing the locked manifest."""

import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--queue", type=Path, required=True)
    parser.add_argument("--completed-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    completed = set()
    for path in args.completed_root.glob("products/*/source-manifest.json"):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        completed.add((row.get("company", ""), row.get("productName", ""), row.get("sourceUrl", "")))
    rows = [json.loads(line) for line in args.queue.read_text(encoding="utf-8").splitlines() if line.strip()]
    remaining = [row for row in rows if (row.get("company", ""), row.get("productName", ""), row.get("sourceUrl", "")) not in completed]
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in remaining), encoding="utf-8")
    print(json.dumps({"locked": len(rows), "completed": len(rows) - len(remaining), "remaining": len(remaining)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
