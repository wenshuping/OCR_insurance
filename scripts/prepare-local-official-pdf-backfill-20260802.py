#!/usr/bin/env python3
"""Freeze a read-only, source-only official-PDF backfill selection."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


def normalize_identity(value: object) -> str:
    return re.sub(
        r"[^0-9A-Za-z\u4e00-\u9fff]+",
        "",
        unicodedata.normalize("NFKC", str(value or "")),
    ).lower().replace("条款", "")


def normalize_url(value: object) -> str:
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    return urlunsplit((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.query, ""))


def sqlite_lines(db_uri: str, sql: str):
    process = subprocess.Popen(
        ["sqlite3", db_uri, sql], stdout=subprocess.PIPE, text=True
    )
    assert process.stdout is not None
    for line in process.stdout:
        if line.strip():
            yield line.rstrip("\n")
    status = process.wait()
    if status:
        raise RuntimeError(f"sqlite3 exited with status {status}")


def canonical_digest(value: object) -> str:
    raw = str(value or "").strip().lower()
    if not raw:
        return ""
    raw = raw.removeprefix("sha256:")
    if not re.fullmatch(r"[0-9a-f]{64}", raw):
        return ""
    return f"sha256:{raw}"


def is_incremental_whole_life(name: str) -> bool:
    return bool(re.search(r"增额.{0,8}终身寿险|终身寿险.{0,8}增额|增额终身", name))


def load_terminal_index(root: Path):
    keys: set[str] = set()
    urls: set[str] = set()
    digests: set[str] = set()
    files = sorted(root.glob("source-wave-*/terminal.jsonl"))
    for path in files:
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            keys.add(
                normalize_identity(row.get("company"))
                + "\x1f"
                + normalize_identity(row.get("productName"))
            )
            url = normalize_url(row.get("sourceUrl"))
            digest = canonical_digest(row.get("sourceDigest"))
            if url:
                urls.add(url)
            if digest:
                digests.add(digest)
    return keys, urls, digests, files


def load_responsibility_indexes(db_uri: str):
    indexes: dict[str, set[str]] = {"artifact": set(), "card": set(), "indicator": set()}
    tables = {
        "artifact": "product_responsibility_artifacts",
        "card": "product_responsibility_cards",
        "indicator": "insurance_indicator_records",
    }
    for label, table in tables.items():
        sql = f"SELECT json_object('company',company,'productName',product_name) FROM {table}"
        for line in sqlite_lines(db_uri, sql):
            row = json.loads(line)
            indexes[label].add(
                normalize_identity(row["company"])
                + "\x1f"
                + normalize_identity(row["productName"])
            )
    return indexes


def select_rows(db_uri: str, terminal_root: Path, limit: int):
    terminal_keys, terminal_urls, terminal_digests, terminal_files = load_terminal_index(terminal_root)
    indexes = load_responsibility_indexes(db_uri)
    sql = (
        "SELECT json_object(" 
        "'id',id,'company',company,'productName',product_name,'url',url," 
        "'pageText',json_extract(payload,'$.pageText')," 
        "'pages',json_extract(payload,'$.pages')," 
        "'bytes',json_extract(payload,'$.bytes')," 
        "'pdfSha256',json_extract(payload,'$.pdfSha256')," 
        "'pdfLocalPath',json_extract(payload,'$.pdfLocalPath')," 
        "'pdfFilePath',json_extract(payload,'$.pdfFilePath')," 
        "'officialDomain',json_extract(payload,'$.officialDomain')," 
        "'productType',json_extract(payload,'$.productType')) " 
        "FROM knowledge_records " 
        "WHERE url LIKE '%.pdf%' " 
        "AND json_extract(payload,'$.official')=1 " 
        "AND COALESCE(json_extract(payload,'$.pdfLocalPath'),'')='' " 
        "AND COALESCE(json_extract(payload,'$.pdfFilePath'),'')=''"
    )
    excluded = {
        "archive_or_non_pdf_url": 0,
        "incremental_whole_life": 0,
        "terminal": 0,
        "duplicate": 0,
        "local_path_present": 0,
    }
    raw = []
    for line in sqlite_lines(db_uri, sql):
        row = json.loads(line)
        url = normalize_url(row.get("url"))
        path = urlsplit(url).path.lower()
        if not path.endswith(".pdf"):
            excluded["archive_or_non_pdf_url"] += 1
            continue
        name = str(row.get("productName") or "")
        if is_incremental_whole_life(name):
            excluded["incremental_whole_life"] += 1
            continue
        if row.get("pdfLocalPath") or row.get("pdfFilePath"):
            excluded["local_path_present"] += 1
            continue
        key = normalize_identity(row.get("company")) + "\x1f" + normalize_identity(name)
        digest = canonical_digest(row.get("pdfSha256"))
        if key in terminal_keys or url in terminal_urls or (digest and digest in terminal_digests):
            excluded["terminal"] += 1
            continue
        missing = {
            "artifact": key not in indexes["artifact"],
            "card": key not in indexes["card"],
            "indicator": key not in indexes["indicator"],
        }
        raw.append(
            {
                "knowledgeRecordId": row["id"],
                "company": row["company"],
                "productName": name,
                "productType": row.get("productType") or "",
                "sourceUrl": url,
                "officialDomain": row.get("officialDomain") or (urlsplit(url).hostname or ""),
                "sourceDigest": digest,
                "pageTextLength": len(row.get("pageText") or ""),
                "pagesInKnowledge": row.get("pages") or 0,
                "bytesInKnowledge": row.get("bytes") or 0,
                "localPdfPath": "",
                "missing": missing,
                "allResponsibilitiesMissing": all(missing.values()),
                "normalizedProductIdentity": key,
            }
        )
    seen: set[str] = set()
    selected = []
    for row in sorted(
        raw,
        key=lambda item: (
            0 if item["allResponsibilitiesMissing"] else 1,
            item["pageTextLength"],
            item["knowledgeRecordId"],
        ),
    ):
        identity = (
            "digest:" + row["sourceDigest"]
            if row["sourceDigest"]
            else "url:" + row["sourceUrl"]
            if row["sourceUrl"]
            else "product:" + row["normalizedProductIdentity"]
        )
        if identity in seen:
            excluded["duplicate"] += 1
            continue
        seen.add(identity)
        row["selectionIdentity"] = identity
        row["selectionReason"] = (
            "missing_artifact_card_indicator_and_no_local_pdf"
            if row["allResponsibilitiesMissing"]
            else "no_local_pdf_and_official_pageText_under_3000_or_missing"
        )
        row["manifestOrder"] = len(selected)
        selected.append(row)
        if len(selected) == limit:
            break
    if len(selected) != limit:
        raise RuntimeError(f"only {len(selected)} unique candidates available; required {limit}")
    return selected, raw, excluded, indexes, terminal_files


def write_json(path: Path, value: object):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--terminal-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--limit", type=int, default=100)
    args = parser.parse_args()
    if args.output.exists() and any(args.output.iterdir()):
        raise RuntimeError("output directory must be new or empty")
    args.output.mkdir(parents=True, exist_ok=True)
    selected, raw, excluded, indexes, terminal_files = select_rows(args.db, args.terminal_root, args.limit)
    manifest_id = "local-official-pdf-backfill-20260802-batch-001"
    manifest = {
        "schema": "ocr-insurance-source-manifest/v1",
        "manifestId": manifest_id,
        "createdAt": "2026-08-02T00:00:00Z",
        "physicalWorkdir": "/Volumes/OCR_ARCHIVE/OCR_insurance",
        "phase": "SOURCE-only",
        "selected": len(selected),
        "products": selected,
        "identityDedupPriority": ["sourceDigest", "sourceUrl", "normalizedCompanyProduct"],
        "selectionPolicy": {
            "officialPdfUrl": "URL path must end in .pdf; archive #entry URLs excluded",
            "noValidLocalPdfPath": "SSD pdfLocalPath and pdfFilePath are empty at selection time",
            "pageTextRule": "official pageText under 3000 characters is eligible; no local PDF is the hard exclusion gate",
            "responsibilityPriority": "artifact/card/indicator all missing first",
            "excludedProductRule": "增额终身寿专项产品",
            "excludedTerminalRule": "all known source-wave terminal identities, including blocked/review/conflict",
        },
        "sqlite": {
            "path": args.db.replace("file:", "").split("?", 1)[0],
            "uriMode": "ro",
            "queryOnly": True,
        },
        "terminalIndexFiles": [str(path) for path in terminal_files],
    }
    write_json(args.output / "manifest.json", manifest)
    write_json(args.output / "selected-products.json", selected)
    queue_lines = []
    for row in selected:
        queue_lines.append(
            json.dumps(
                {
                    "manifestId": manifest_id,
                    "manifestOrder": row["manifestOrder"],
                    "company": row["company"],
                    "productName": row["productName"],
                    "sourceUrl": row["sourceUrl"],
                    "normalizedSourceUrl": row["sourceUrl"],
                    "officialDomain": row["officialDomain"],
                    "sourceDigest": row["sourceDigest"],
                    "discoveryUrl": "",
                    "selectionIdentity": row["selectionIdentity"],
                },
                ensure_ascii=False,
            )
        )
    (args.output / "source-queue.jsonl").write_text("\n".join(queue_lines) + "\n", encoding="utf-8")
    audit = {
        "schema": "ocr-insurance-source-selection-audit/v1",
        "manifestId": manifest_id,
        "selected": len(selected),
        "candidatePoolAfterOfficialPdfAndEmptyLocalPath": len(raw),
        "selectedAllResponsibilitiesMissing": sum(row["allResponsibilitiesMissing"] for row in selected),
        "selectedPartialResponsibilitiesMissing": sum(not row["allResponsibilitiesMissing"] for row in selected),
        "selectedPageTextUnder3000": sum(row["pageTextLength"] < 3000 for row in selected),
        "responsibilityIndexCounts": {key: len(value) for key, value in indexes.items()},
        "excluded": excluded,
        "terminalIndex": {
            "files": len(terminal_files),
            "identitySource": "terminal product key plus sourceUrl plus non-empty sourceDigest",
        },
        "allTerminalQueuesDisjointAtSelection": True,
        "sourceOnlyNoModelNoSqlWrites": True,
        "notes": [
            "Rows with any SSD local PDF path were excluded conservatively before selection.",
            "The selection is immutable after manifest SHA is recorded.",
        ],
    }
    write_json(args.output / "selection-audit.json", audit)
    lock = {
        "schema": "ocr-insurance-source-input-lock/v1",
        "manifestId": manifest_id,
        "lockedAt": "2026-08-02T00:00:00Z",
        "physicalWorkdir": "/Volumes/OCR_ARCHIVE/OCR_insurance",
        "database": {
            "path": args.db.replace("file:", "").split("?", 1)[0],
            "uri": args.db,
            "mode": "ro",
            "queryOnly": True,
            "writesPermitted": False,
        },
        "selectionSource": str(args.output / "manifest.json"),
        "selectedProducts": len(selected),
        "terminalIndexFiles": [str(path) for path in terminal_files],
        "phaseBoundary": {"models": False, "sqlite": False, "feishu": False, "publication": False},
    }
    write_json(args.output / "input-lock.json", lock)
    for path in sorted(args.output.glob("*.json")):
        if path.name == "sha256.json":
            continue
    hashes = {path.name: sha256_file(path) for path in sorted(args.output.iterdir()) if path.is_file() and path.name != "SHA256SUMS.txt"}
    write_json(args.output / "sha256.json", hashes)
    sums = "".join(f"{digest.removeprefix('sha256:')}  {name}\n" for name, digest in sorted(hashes.items()))
    (args.output / "SHA256SUMS.txt").write_text(sums, encoding="utf-8")
    print(json.dumps({"manifest": str(args.output / "manifest.json"), "selected": len(selected), "allMissing": sum(row["allResponsibilitiesMissing"] for row in selected), "candidatePool": len(raw)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
