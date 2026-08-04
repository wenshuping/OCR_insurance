#!/usr/bin/env python3
"""Build an immutable, deduplicated manifest for source-ready review returns."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from typing import Any


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def url_key(value: str) -> str:
    if not value:
        return ""
    parsed = urlsplit(value)
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, "", ""))


def identity_keys(item: dict[str, Any]) -> set[str]:
    keys: set[str] = set()
    digest = item.get("sourceDigest")
    if digest:
        keys.add(f"digest:{digest}")
    for field in ("sourceUrl", "originKey", "dedupKey"):
        value = item.get(field, "")
        if value.startswith("url:"):
            value = value[4:]
        if value:
            keys.add(f"url:{url_key(value)}")
    return keys


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--identity", type=Path, action="append", required=True)
    parser.add_argument("--artifact", type=Path, action="append", default=[])
    parser.add_argument("--outdir", type=Path, required=True)
    args = parser.parse_args()

    existing: dict[str, list[str]] = {}
    for path in args.identity:
        for item in read_jsonl(path):
            for key in identity_keys(item):
                existing.setdefault(key, []).append(str(path))
    for path in args.artifact:
        if not path.is_file():
            continue
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        for key in identity_keys(item):
            existing.setdefault(key, []).append(str(path))

    records = read_jsonl(args.input)
    manifest: list[dict[str, Any]] = []
    added = duplicate = 0
    seen: set[str] = set()
    for line_number, item in enumerate(records, 1):
        keys = identity_keys(item)
        collisions = sorted({source for key in keys if key in existing for source in existing[key]})
        duplicate_within = sorted(key for key in keys if key in seen)
        is_duplicate = bool(collisions or duplicate_within)
        if is_duplicate:
            duplicate += 1
            status = "duplicate"
            reason = "duplicate_existing_or_source_return" 
        else:
            added += 1
            status = "added"
            reason = "unique_sourceDigest_and_sourceUrl"
        seen.update(keys)
        source_pdf = Path(item.get("sourceFile", ""))
        source_text = Path(item.get("textFile", ""))
        source_contract = Path(item.get("sourceContract") or item.get("source-contract", ""))
        if not source_pdf.is_absolute():
            source_pdf = args.root / source_pdf
        if not source_text.is_absolute():
            source_text = args.root / source_text
        manifest.append({
            "manifestStatus": status,
            "exclusionReason": "" if status == "added" else reason,
            "inputPath": str(args.input),
            "line": line_number,
            "origin": item.get("origin", "review"),
            "originKey": item.get("originKey", ""),
            "company": item.get("company", ""),
            "productName": item.get("productName", ""),
            "dedupKey": f"url:{url_key(item.get('sourceUrl', ''))}",
            "sourceUrl": item.get("sourceUrl", ""),
            "sourceDigest": item.get("sourceDigest", ""),
            "sourceContract": item.get("sourceContract", ""),
            "sourceFile": str(source_pdf),
            "textFile": str(source_text),
            "sourceReady": source_pdf.is_file() and source_text.is_file() and source_contract.is_file(),
            "existingCollisionPaths": collisions,
            "parseOnly": True,
            "databaseWrites": False,
            "feishuWrites": False,
            "published": False,
        })

    args.outdir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.outdir / "source-return-review-manifest.jsonl"
    with manifest_path.open("w", encoding="utf-8") as handle:
        for item in manifest:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
    summary = {
        "task": "REVIEW_BACKLOG_912",
        "inputPath": str(args.input),
        "inputCount": len(records),
        "added": added,
        "duplicate": duplicate,
        "excluded": duplicate,
        "sourceReadyCount": sum(item["sourceReady"] for item in manifest if item["manifestStatus"] == "added"),
        "addedPath": str(manifest_path),
        "ordering": "after current actionable review batches; bounded repair only, no first parse",
        "dedupBasis": ["sourceDigest", "sourceUrl"],
        "dedupWithinManifestUnique": len({item["dedupKey"] for item in manifest}) == len(manifest),
        "parseOnly": True,
        "databaseWrites": False,
        "feishuWrites": False,
        "published": False,
    }
    summary_path = args.outdir / "source-return-review-summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    sha = {
        "manifest": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "summary": hashlib.sha256(summary_path.read_bytes()).hexdigest(),
    }
    (args.outdir / "source-return-review-sha256.json").write_text(json.dumps(sha, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
