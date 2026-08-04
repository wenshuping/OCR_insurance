#!/usr/bin/env python3
"""Re-run shard-2 products after body-heading/evidence boundary repairs."""

from __future__ import annotations

import json
from pathlib import Path

import process_luna_shard2_verified as runner


def main() -> int:
    rows = json.loads(runner.SHARD.read_text(encoding="utf-8"))
    results = []
    for index, row in enumerate(rows):
        if index < 2:
            product_dir = runner.OUT / Path(row["localProductDir"]).name
            result = json.loads((product_dir / "result.json").read_text(encoding="utf-8"))
        else:
            result = runner.process_one_verified(row)
        results.append(result)
        runner.json_write(runner.OUT / "summary.json", {
            "scope": "shard-2",
            "total": len(rows),
            "processed": len(results),
            "approved": sum(r.get("status") == "approved" for r in results),
            "review": sum(r.get("status") == "validation-review" for r in results),
            "retry": sum(r.get("status") in {"model-retry", "source-retry"} for r in results),
            "validationReview": sum(r.get("status") == "validation-review" for r in results),
            "modelRetry": sum(r.get("status") == "model-retry" for r in results),
            "sourceRetry": sum(r.get("status") == "source-retry" for r in results),
            **runner.MODEL_META,
            "updatedAt": runner.now_iso(),
            "products": [{"productName": r.get("productName"), "status": r.get("status")} for r in results],
        })
        print(json.dumps({"processed": len(results), "total": len(rows), "status": result.get("status"), "productName": result.get("productName"), "responsibilityCount": result.get("responsibilityCount")}, ensure_ascii=False), flush=True)

    # Replace append logs with one authoritative row per product after rerun.
    by_status = {"approved": [], "validation-review": [], "model-retry": [], "source-retry": []}
    receipts = []
    for result in results:
        by_status[result["status"]].append(result)
        product_dir = Path(result["productDir"])
        receipt_path = product_dir / "validator-receipt.json"
        if receipt_path.exists():
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
            receipts.append({"status": receipt.get("status"), "company": result.get("company"), "productName": result.get("productName"), "sourceDigest": result.get("sourceDigest"), **runner.MODEL_META, "failureClass": receipt.get("failureClass"), "exitCode": receipt.get("exitCode"), "responsibilityCount": result.get("responsibilityCount")})
    for filename, status in (("approved.jsonl", "approved"), ("validation-review.jsonl", "validation-review"), ("model-retry.jsonl", "model-retry"), ("source-retry.jsonl", "source-retry")):
        (runner.OUT / filename).write_text("".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in by_status[status]), encoding="utf-8")
    (runner.OUT / "validator-receipts.jsonl").write_text("".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in receipts), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
