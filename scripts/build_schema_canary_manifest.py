#!/usr/bin/env python3
"""Lock up to three deduplicated modern-schema canary products."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


def read_jsonl(path: Path):
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def url_key(value: str) -> str:
    p = urlsplit(value or "")
    return urlunsplit((p.scheme, p.netloc, p.path, "", ""))


def keys(item: dict) -> set[str]:
    result = set()
    if item.get("sourceDigest"):
        result.add("digest:" + item["sourceDigest"])
    if item.get("sourceUrl"):
        result.add("url:" + url_key(item["sourceUrl"]))
    if item.get("dedupKey"):
        result.add("url:" + url_key(item["dedupKey"].removeprefix("url:")))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--handoff", type=Path, required=True)
    parser.add_argument("--line", type=int, action="append", required=True)
    parser.add_argument("--identity", type=Path, action="append", required=True)
    parser.add_argument("--artifact", type=Path, action="append", default=[])
    parser.add_argument("--outdir", type=Path, required=True)
    args = parser.parse_args()

    source_rows = read_jsonl(args.handoff)
    existing = set()
    for path in args.identity:
        for item in read_jsonl(path):
            existing.update(keys(item))
    for path in args.artifact:
        if path.is_file():
            try:
                existing.update(keys(json.loads(path.read_text(encoding="utf-8"))))
            except json.JSONDecodeError:
                pass
    selected = []
    excluded = []
    seen = set()
    for line in args.line:
        item = source_rows[line - 1]
        item_keys = keys(item)
        collisions = sorted((item_keys & existing) | (item_keys & seen))
        record = {
            "canaryLine": line,
            "company": item["company"],
            "productName": item["productName"],
            "sourceUrl": item["sourceUrl"],
            "sourceDigest": item["sourceDigest"],
            "sourceFile": item["sourceFile"],
            "textFile": item["textFile"],
            "resultPath": item["resultPath"],
            "validatorPath": item["validatorPath"],
            "sourceContract": item["sourceContract"],
            "failureClass": item["failureClass"],
            "validatorCodes": item.get("validatorCodes", []),
            "dedupKey": "url:" + url_key(item["sourceUrl"]),
            "dedupCollisions": collisions,
            "sourceReady": all(Path(item[field]).is_file() for field in ("sourceFile", "textFile")) and item.get("sourceContract") == "source_ready",
            "parseOnly": True,
            "databaseWrites": False,
            "feishuWrites": False,
            "published": False,
        }
        seen.update(item_keys)
        if collisions or not record["sourceReady"]:
            record["manifestStatus"] = "excluded"
            record["exclusionReason"] = "identity_collision" if collisions else "source_not_ready"
            excluded.append(record)
        else:
            record["manifestStatus"] = "added"
            record["exclusionReason"] = ""
            selected.append(record)

    args.outdir.mkdir(parents=True, exist_ok=True)
    manifest = args.outdir / "schema-canary-manifest.jsonl"
    with manifest.open("w", encoding="utf-8") as handle:
        for item in selected:
            handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
    (args.outdir / "schema-canary-exclusions.jsonl").write_text(
        "".join(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n" for item in excluded), encoding="utf-8"
    )
    summary = {
        "task": "FIRST_PARSE_BATCH1_HANDOFF",
        "handoff": str(args.handoff),
        "selectedLines": args.line,
        "added": len(selected),
        "excluded": len(excluded),
        "sourceReadyAdded": sum(item["sourceReady"] for item in selected),
        "dedupUnique": len({item["dedupKey"] for item in selected}) == len(selected),
        "canaryRole": "three structural representatives only; no full 75-row recovery until all canaries pass",
        "parseOnly": True,
        "databaseWrites": False,
        "feishuWrites": False,
        "published": False,
    }
    summary_path = args.outdir / "schema-canary-summary.json"
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    sha = {
        "manifest": hashlib.sha256(manifest.read_bytes()).hexdigest(),
        "exclusions": hashlib.sha256((args.outdir / "schema-canary-exclusions.jsonl").read_bytes()).hexdigest(),
        "summary": hashlib.sha256(summary_path.read_bytes()).hexdigest(),
    }
    (args.outdir / "schema-canary-sha256.json").write_text(json.dumps(sha, indent=2, sort_keys=True) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
