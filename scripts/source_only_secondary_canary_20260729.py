#!/usr/bin/env python3
"""Read-only official-source canary for the 2026-07-29 secondary queue.

This script writes only the user-authorized source-repair output directory. It
does not call models, SQLite, Feishu, or publication paths.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import urllib.parse
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from pypdf import PdfReader


def norm(value: object) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", str(value or "").lower())


def sha(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--max-domains", type=int, default=10)
    ap.add_argument("--offset", type=int, default=0)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    rows = [json.loads(line) for line in args.input.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.limit:
        rows = rows[args.offset:args.offset + args.limit]
    by_domain: dict[str, dict] = {}
    for row in rows:
        url = (row.get("sourceUrls") or [""])[0]
        host = urllib.parse.urlparse(url).netloc.lower()
        if host and host not in by_domain:
            by_domain[host] = row
    domains = [host for host, _ in Counter(
        urllib.parse.urlparse((row.get("sourceUrls") or [""])[0]).netloc.lower() for row in rows
    ).most_common(args.max_domains)]
    selected = rows if args.limit else [by_domain[host] for host in domains]
    run = args.output
    run.mkdir(parents=True, exist_ok=True)
    results = []
    for index, row in enumerate(selected, 1):
        url = (row.get("sourceUrls") or [""])[0]
        host = urllib.parse.urlparse(url).netloc.lower()
        key = hashlib.sha256(f"{row['company']}\x1f{row['productName']}\x1f{url}".encode()).hexdigest()[:16]
        product_dir = run / "canary" / f"{index:02d}-{host}-{key}"
        product_dir.mkdir(parents=True, exist_ok=True)
        response = product_dir / "response.bin"
        headers = product_dir / "headers.txt"
        attempts = [{"method": "direct", "url": url, "startedAt": datetime.now(timezone.utc).isoformat()}]
        cmd = ["curl", "-L", "--fail-with-body", "--connect-timeout", "15", "--max-time", "45", "-D", str(headers), "-o", str(response), url]
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        attempt = {**attempts[0], "exitCode": proc.returncode, "stderr": proc.stderr[-2000:]}
        result = {"company": row["company"], "productName": row["productName"], "sourceUrl": url, "officialHost": host, "sourceStatus": "source_blocked", "retrievalMethod": "direct", "attempts": [attempt], "origin": "secondary_classification_20260729_canary"}
        if proc.returncode == 0 and response.is_file() and response.read_bytes()[:5] == b"%PDF-":
            source = product_dir / "source.pdf"
            response.replace(source)
            text_path = product_dir / "pages.txt"
            reader = PdfReader(str(source))
            pages = len(reader.pages)
            page_text = []
            for page_no, page in enumerate(reader.pages, 1):
                page_text.append(f"\n===== PAGE {page_no} =====\n{page.extract_text() or ''}")
            text = "".join(page_text)
            text_path.write_text(text, encoding="utf-8")
            company_ok = norm(row["company"]) in norm(text) or norm(text) in norm(row["company"])
            product_ok = norm(row["productName"]) in norm(text)
            responsibility_ok = bool(re.search(r"保险责任|给付|赔偿责任", text))
            status = "source_ready" if pages > 0 and company_ok and product_ok and responsibility_ok else "source_blocked"
            if not company_ok:
                result["blocker"] = "PDF identity does not contain exact ledger company"
            elif not product_ok:
                result["blocker"] = "PDF identity does not contain exact ledger product"
            elif not responsibility_ok:
                result["blocker"] = "readable responsibility chapter not found in extracted text"
            result.update({"sourceStatus": status, "sourceFile": str(source), "extractedTextFile": str(text_path), "sourceDigest": sha(source), "bytes": source.stat().st_size, "pages": pages, "magic": True, "companyInPdf": company_ok, "productInPdf": product_ok, "responsibilityEvidence": responsibility_ok})
            if status == "source_ready":
                result["responsibilityTextFile"] = str(text_path)
            contract = {"company": row["company"], "productName": row["productName"], "sourceStatus": status, "sourceUrl": url, "discoveryUrl": url, "sourceTitle": row["productName"], "officialHost": host, "retrievalMethod": "direct", "retrievedAt": datetime.now(timezone.utc).isoformat(), "sourceDigest": result["sourceDigest"], "sourceFile": str(source), "extractedTextFile": str(text_path), "responsibilityTextFile": str(text_path) if status == "source_ready" else "", "responsibilityPages": [], "referencedTablePages": [], "screenshots": [], "pdf": {"pages": pages, "encrypted": False, "encryption": "", "emptyPasswordDecryptable": False}, "identityEvidence": {"company": row["company"], "productName": row["productName"], "version": ""}, "attempts": [attempt], "blockers": [] if status == "source_ready" else [result.get("blocker", "source validation failed")]}
            write_json(product_dir / "source-contract.json", contract)
        else:
            result["blocker"] = "direct request failed or response is not PDF magic"
        results.append(result)
    ready = [r for r in results if r["sourceStatus"] == "source_ready"]
    blocked = [r for r in results if r["sourceStatus"] == "source_blocked"]
    for r in ready:
        r["returnQueue"] = "FIRST_PARSE"
        r["sourceContract"] = str(next((Path(r["sourceFile"]).parent / "source-contract.json" for _ in [0]), ""))
    write_json(run / "canary-selection.json", {"input": str(args.input), "maxDomains": args.max_domains, "mutuallyExclusiveByDomain": True, "selected": [{"company": r["company"], "productName": r["productName"], "sourceUrl": r["sourceUrl"], "domain": r["officialHost"]} for r in results]})
    write_json(run / "canary-summary.json", {"schema": "secondary-source-canary/v1", "inputRows": len(rows), "selected": len(results), "statusCounts": Counter(r["sourceStatus"] for r in results), "results": results, "modelProviderCalled": False, "sqliteWritten": False, "feishuWritten": False, "published": False})
    (run / "source-ready-return-first-parse.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in ready), encoding="utf-8")
    (run / "source-blocked.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in blocked), encoding="utf-8")
    files = {}
    for p in sorted(run.rglob("*")):
        if p.is_file() and p.name != "sha256.json":
            files[str(p.relative_to(run))] = sha(p)
    write_json(run / "sha256.json", {"files": files})


if __name__ == "__main__":
    main()
