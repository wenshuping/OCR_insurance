#!/usr/bin/env python3
"""Add parse-only review classification metadata to a locked REVIEW_BACKLOG_912 ledger."""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path


def read_line(path: str, line_number: int) -> dict:
    with Path(path).open("r", encoding="utf-8", errors="replace") as handle:
        for index, line in enumerate(handle, 1):
            if index == line_number:
                return json.loads(line)
    return {}


def first_value(row: dict, *fields: str):
    for field in fields:
        value = row.get(field)
        if value not in (None, ""):
            return value
    return None


def http_status(row: dict):
    value = first_value(row, "httpStatus", "statusCode")
    if value not in (None, ""):
        try:
            return int(value)
        except (TypeError, ValueError):
            pass
    error = str(row.get("error") or "")
    match = re.search(r"\b([1-5]\d\d)\b", error)
    return int(match.group(1)) if match else None


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--ledger-dir", type=Path, required=True)
    args = parser.parse_args()
    ledger_dir = args.ledger_dir.resolve()
    ledger_path = ledger_dir / "global-review-ledger.jsonl"
    summary_path = ledger_dir / "summary.json"
    classification_path = ledger_dir / "ambiguous-review-classification.jsonl"
    if not ledger_path.exists() or not summary_path.exists():
        raise SystemExit("locked ledger and summary are required")
    if classification_path.exists():
        raise SystemExit(f"immutable classification already exists: {classification_path}")

    ledger = [json.loads(line) for line in ledger_path.read_text(encoding="utf-8").splitlines() if line.strip()]
    final_review = [row for row in ledger if row.get("status") in {"validation-review", "manual-review"}]
    final_manual = [row for row in ledger if row.get("status") == "manual-review"]
    final_validation = [row for row in ledger if row.get("status") == "validation-review"]
    ambiguous_final_manual = [row for row in final_manual if row.get("ambiguousSourceOrModel")]
    ambiguous_final_validation = [row for row in final_validation if row.get("ambiguousSourceOrModel")]
    actionable = [row for row in final_review if not row.get("ambiguousSourceOrModel")]

    classified = []
    for ledger_row in ambiguous_final_manual:
        evidence = None
        for observation in ledger_row.get("allStatusObservations", []):
            if observation.get("status") != "manual-review" or not observation.get("ambiguousSourceOrModel"):
                continue
            candidate = read_line(observation["inputPath"], observation["line"])
            if candidate.get("stage") == "source_or_model":
                evidence = (observation, candidate)
                break
        if evidence is None:
            continue
        observation, source_row = evidence
        result = first_value(source_row, "resultPath", "artifactPath")
        main_result = source_row.get("mainResult")
        if result in (None, "") and isinstance(main_result, dict):
            result = first_value(main_result, "resultPath", "artifactPath")
        classified.append({
            "dedupKey": ledger_row["dedupKey"],
            "company": ledger_row.get("company"),
            "productName": ledger_row.get("productName"),
            "sourceUrl": ledger_row.get("sourceUrl") or source_row.get("sourceUrl"),
            "sourceDigest": ledger_row.get("sourceDigest") or source_row.get("sourceDigest"),
            "origin": first_value(source_row, "origin", "source", "provider"),
            "error": source_row.get("error"),
            "httpStatus": http_status(source_row),
            "failureStage": first_value(source_row, "failureStage", "stage"),
            "resultPath": result,
            "inputPath": observation["inputPath"],
            "line": observation["line"],
            "finalStatus": ledger_row["status"],
            "statusSource": ledger_row.get("statusSource"),
        })
    classified.sort(key=lambda row: row["dedupKey"])
    classification_path.write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in classified),
        encoding="utf-8",
    )

    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    summary["reviewLayerCounts"] = {
        "rawFinalReview": len(final_review),
        "rawFinalValidationReview": len(final_validation),
        "rawFinalManualReview": len(final_manual),
        "ambiguousFinalManualStageSourceOrModel": len(ambiguous_final_manual),
        "ambiguousFinalValidationStageSourceOrModel": len(ambiguous_final_validation),
        "ambiguousFinalNonReviewStatus": sum(
            1 for row in ledger
            if row.get("ambiguousSourceOrModel") and row.get("status") not in {"validation-review", "manual-review"}
        ),
        "ambiguousAllFinalStatuses": sum(1 for row in ledger if row.get("ambiguousSourceOrModel")),
        "actionableValidationReview": len(final_validation) - len(ambiguous_final_validation),
        "actionableManualReview": len(final_manual) - len(ambiguous_final_manual),
        "actionableReview": len(actionable),
        "excludedFromActionableBySourceOrModel": len(final_review) - len(actionable),
        "layerCheck": {
            "rawReviewEqualsValidationPlusManual": len(final_review) == len(final_validation) + len(final_manual),
            "actionableEqualsCleanValidationPlusCleanManual": len(actionable) == (len(final_validation) - len(ambiguous_final_validation)) + (len(final_manual) - len(ambiguous_final_manual)),
            "reviewMinusActionableEqualsAmbiguousReview": len(final_review) - len(actionable) == len(ambiguous_final_validation) + len(ambiguous_final_manual),
        },
    }
    summary["ambiguousClassificationPath"] = str(classification_path)
    summary["ambiguousClassificationRows"] = len(classified)
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "classificationPath": str(classification_path),
        "classificationRows": len(classified),
        "reviewLayerCounts": summary["reviewLayerCounts"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
