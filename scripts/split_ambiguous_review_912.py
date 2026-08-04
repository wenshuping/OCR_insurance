#!/usr/bin/env python3
"""Deterministically split ambiguous REVIEW_BACKLOG_912 rows by evidence only."""

from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlsplit


def classify(row: dict) -> tuple[str, str]:
    status = row.get("httpStatus")
    error = str(row.get("error") or "").lower()
    failure_stage = str(row.get("failureStage") or "").lower()
    endpoint = urlsplit(str(row.get("sourceUrl") or "")).netloc.lower()

    # Explicit transport/provider quota signals are model-window evidence,
    # even when the source URL is present in the failed request record.
    if status in {401, 402, 429}:
        return "model", f"explicit model/provider auth-or-quota HTTP status {status}"
    if any(token in error for token in ("model api", "provider", "upstream", "malformed response", "authentication", "api key")):
        return "model", "explicit model/provider transport or response evidence"
    if status == 403 and endpoint:
        return "source", "HTTP 403 against the recorded official insurer source URL"
    if any(token in error for token in ("pdf", "download", "encrypted", "version", "missing text", "forbidden")) and endpoint:
        return "source", "explicit official-source acquisition/PDF/version evidence"
    # A generic timeout/EOF does not prove whether the source endpoint or a
    # model transport failed, so it must not be guessed into either window.
    if any(token in error for token in ("timeout", "timed out", "eof", "remote end closed")):
        return "unresolved", "transport error does not identify source endpoint versus model provider"
    return "unresolved", "insufficient endpoint-layer evidence"


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--classification", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    source = args.classification.resolve()
    out = args.output_dir.resolve()
    out.mkdir(parents=True, exist_ok=True)
    names = {
        "model": "ambiguous-to-model.jsonl",
        "source": "ambiguous-to-source.jsonl",
        "unresolved": "ambiguous-unresolved.jsonl",
    }
    if any((out / name).exists() for name in names.values()) or (out / "classification-summary.json").exists():
        raise SystemExit(f"immutable split output already exists: {out}")
    rows = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines() if line.strip()]
    seen = set()
    buckets = {key: [] for key in names}
    for row in rows:
        key = row["dedupKey"]
        if key in seen:
            raise SystemExit(f"duplicate input dedupKey: {key}")
        seen.add(key)
        bucket, reason = classify(row)
        enriched = dict(row)
        enriched["classification"] = bucket
        enriched["classificationReason"] = reason
        buckets[bucket].append(enriched)
    if set().union(*(set(row["dedupKey"] for row in values) for values in buckets.values())) != seen:
        raise SystemExit("split union does not equal input")
    intersections = {}
    keys = {key: {row["dedupKey"] for row in values} for key, values in buckets.items()}
    for left in keys:
        for right in keys:
            if left < right:
                intersections[f"{left}∩{right}"] = len(keys[left] & keys[right])
    for bucket, name in names.items():
        (out / name).write_text(
            "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in sorted(buckets[bucket], key=lambda item: item["dedupKey"])),
            encoding="utf-8",
        )
    summary = {
        "inputPath": str(source),
        "inputRows": len(rows),
        "inputUniqueDedupKeys": len(seen),
        "counts": {bucket: len(values) for bucket, values in buckets.items()},
        "unionCount": sum(len(values) for values in buckets.values()),
        "intersectionCounts": intersections,
        "unionEqualsInput": sum(len(values) for values in buckets.values()) == len(seen),
        "intersectionFree": all(value == 0 for value in intersections.values()),
        "rules": {
            "model": "explicit provider/auth/quota HTTP401/402/429 or explicit model/upstream/malformed-response evidence",
            "source": "official insurer source URL with HTTP403 or explicit source/PDF/version acquisition evidence",
            "unresolved": "transport error without endpoint-layer proof; no guessing",
        },
    }
    for bucket, name in names.items():
        data = (out / name).read_bytes()
        summary[f"sha256_{bucket}"] = hashlib.sha256(data).hexdigest()
    (out / "classification-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"outputDir": str(out), **summary}, ensure_ascii=False))


if __name__ == "__main__":
    main()
