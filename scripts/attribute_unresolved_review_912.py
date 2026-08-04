#!/usr/bin/env python3
"""Attribute unresolved review rows using local receipts only; never fetches sources."""

from __future__ import annotations

import json
from pathlib import Path


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f"immutable output already exists: {args.output}")

    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    output = []
    for row in rows:
        input_path = Path(row["inputPath"])
        run_dir = input_path.parent
        summary = run_dir / "summary.json"
        summary_value = None
        if summary.exists():
            try:
                summary_value = json.loads(summary.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                summary_value = None
        failure_class = str(summary_value.get("failureCounts", {}).get("pipeline_error", 0)) if isinstance(summary_value, dict) else "0"
        if failure_class != "0" and "gemini-continuation-3/run" in str(run_dir):
            attribution = "pipeline_or_unknown"
            detail = "local run summary records pipeline_error; no model/provider receipt exists"
            evidence = [str(input_path), str(summary)]
        else:
            attribution = "pipeline_or_unknown"
            detail = "generic timeout/EOF in a source_or_model row; no endpoint-layer or attempt receipt proves model versus source"
            evidence = [str(input_path)]
        output.append({
            "dedupKey": row["dedupKey"],
            "company": row.get("company"),
            "productName": row.get("productName"),
            "sourceUrl": row.get("sourceUrl"),
            "sourceDigest": row.get("sourceDigest"),
            "originalError": row.get("error"),
            "inputPath": row.get("inputPath"),
            "line": row.get("line"),
            "resultPath": row.get("resultPath"),
            "statusSource": row.get("statusSource"),
            "attribution": attribution,
            "attributionDetail": detail,
            "evidencePaths": evidence,
            "attemptReceiptPaths": [],
            "modelOrSourceWindowEligible": False,
        })
    output.sort(key=lambda item: item["dedupKey"])
    args.output.write_text("".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in output), encoding="utf-8")
    print(json.dumps({
        "output": str(args.output),
        "rows": len(output),
        "attributionCounts": {key: sum(row["attribution"] == key for row in output) for key in ("model", "source", "pipeline_or_unknown")},
        "networkCalled": False,
        "modelCalled": False,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
