#!/usr/bin/env python3
"""Acquire and validate official PDFs for the immutable 306-candidate ledger.

This script is deliberately source-only: it never opens SQLite for writing and
never treats an existing card, indicator, or artifact as source evidence.
"""
import concurrent.futures
import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "artifacts/disease-full-disability-dedup-20260731/ledger-final.json"
OUT = ROOT / "artifacts/disease-full-disability-dedup-20260731/source-acquisition-final"
OUT.mkdir(parents=True, exist_ok=True)

HEADINGS = ("身故或身体全残保险金", "身故和身体全残保险金", "身故或全残保险金", "身故和全残保险金")
UA = "Mozilla/5.0 (compatible; OCR-insurance-source-audit/1.0)"

def compact(value):
    return re.sub(r"[\s\u3000\-—_·、，。；：:,.!?！？（）()【】\[\]{}<>《》/\\]+", "", str(value or "")).lower()

def digest_bytes(data):
    return "sha256:" + hashlib.sha256(data).hexdigest()

def product_candidates():
    ledger = json.loads(LEDGER.read_text())
    rows = []
    for p in ledger["products"]:
        c = p.get("classification", {})
        raw = c.get("rawSameSourceKeys") or []
        if not raw:
            continue
        urls = p.get("sourceUrls") or []
        url = next((u for u in urls if u), None)
        if not url:
            rows.append((p, None))
        else:
            rows.append((p, url))
    return rows

def fetch(url):
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/pdf,*/*;q=0.8"})
    started = time.time()
    with urlopen(req, timeout=30) as response:
        data = response.read()
        return {
            "httpStatus": getattr(response, "status", None),
            "finalUrl": response.geturl(),
            "contentType": response.headers.get("Content-Type", ""),
            "elapsedMs": round((time.time() - started) * 1000),
            "bytes": data,
        }

def inspect_pdf(data, product_name, aggregate_titles):
    result = {"pdfMagic": data.startswith(b"%PDF-"), "byteLength": len(data)}
    if not result["pdfMagic"]:
        result.update({"valid": False, "blocker": "not_pdf_magic"})
        return result
    try:
        import io
        reader = PdfReader(io.BytesIO(data), strict=False)
        texts = []
        for page in reader.pages:
            texts.append(page.extract_text() or "")
        text = "\n".join(texts)
        norm = compact(text)
        heading_hits = sorted(set(h for h in HEADINGS if compact(h) in norm))
        expected_hits = sorted(set(h for h in aggregate_titles if h and compact(h) in norm))
        product_hit = compact(product_name) in norm
        company_hint = any(x in norm for x in ("保险", "人寿", "保险公司"))
        body_hit = any(
            any(token in norm[pos:pos + 2200] for token in ("给付", "承担保险责任", "保险责任", "按被保险人"))
            for h in heading_hits
            for pos in [m.start() for m in re.finditer(re.escape(compact(h)), norm)]
        )
        result.update({
            "valid": bool(heading_hits and product_hit and body_hit),
            "pageCount": len(reader.pages),
            "encrypted": bool(reader.is_encrypted),
            "productNameHit": product_hit,
            "companyOrInsuranceTextHit": company_hint,
            "aggregateHeadingHits": heading_hits,
            "expectedHeadingHits": expected_hits,
            "responsibilityBodyHit": body_hit,
            "textLength": len(text),
            "textSha256": hashlib.sha256(text.encode("utf-8", "ignore")).hexdigest(),
        })
        if not heading_hits:
            result["blocker"] = "aggregate_heading_not_found"
        elif not product_hit:
            result["blocker"] = "product_name_not_found"
        elif not body_hit:
            result["blocker"] = "aggregate_heading_without_responsibility_body"
        else:
            result["blocker"] = None
        return result
    except Exception as exc:
        result.update({"valid": False, "blocker": "pdf_parse_error", "error": f"{type(exc).__name__}: {exc}"})
        return result

def one(item):
    p, url = item
    base = {"productKey": p["productKey"], "company": p["company"], "productName": p["productName"], "sourceUrl": url,
            "attemptedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "officialSourceRequired": True}
    if not url:
        base.update({"status": "source_blocked", "blocker": "missing_source_url"})
        return base
    try:
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname:
            base.update({"status": "source_blocked", "blocker": "non_https_or_invalid_source_url"})
            return base
        file_name = hashlib.sha256(url.encode()).hexdigest() + ".pdf"
        cache_path = OUT / file_name
        if cache_path.exists():
            data = cache_path.read_bytes()
            got = {"httpStatus": 200, "finalUrl": url, "contentType": "application/pdf", "elapsedMs": 0, "bytes": data, "cacheHit": True}
        else:
            got = fetch(url)
        final_host = (urlparse(got["finalUrl"]).hostname or "").lower()
        source_host = parsed.hostname.lower()
        inspect = inspect_pdf(got["bytes"], p["productName"], [x.get("aggregateTitle") for x in (p.get("aggregateIndicators") or [])] + [x.get("aggregateTitle") for x in (p.get("diseaseBranchIndicators") or [])])
        sha = digest_bytes(got["bytes"])
        if not cache_path.exists():
            cache_path.write_bytes(got["bytes"])
        base.update({"httpStatus": got["httpStatus"], "finalUrl": got["finalUrl"], "sourceHost": source_host, "finalHost": final_host,
                     "contentType": got["contentType"], "elapsedMs": got["elapsedMs"], "cacheHit": got.get("cacheHit", False), "sourceDigest": sha,
                     "sourceFile": str((OUT / file_name).relative_to(ROOT)), "inspection": inspect})
        official_host_ok = final_host == source_host or final_host.endswith("." + source_host)
        if got["httpStatus"] != 200:
            base.update({"status": "source_blocked", "blocker": "http_status"})
        elif not official_host_ok:
            base.update({"status": "source_blocked", "blocker": "redirected_official_host"})
        elif not inspect.get("valid"):
            base.update({"status": "source_blocked", "blocker": inspect.get("blocker")})
        elif inspect.get("encrypted"):
            base.update({"status": "source_blocked", "blocker": "encrypted_pdf_requires_empty_password_check"})
        else:
            base.update({"status": "source_ready", "blocker": None})
    except Exception as exc:
        base.update({"status": "source_blocked", "blocker": "fetch_error", "error": f"{type(exc).__name__}: {exc}"})
    return base

def main():
    rows = product_candidates()
    # Preserve one receipt per product. The file cache is keyed by URL below;
    # repeated URLs are still independently validated against each product.
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        receipts = list(pool.map(one, rows))
    receipts.sort(key=lambda x: x["productKey"])
    payload = {"auditVersion": "official-source-acquisition-20260731-v1", "ledger": str(LEDGER), "candidateCount": len(receipts), "receipts": receipts}
    out = OUT / "acquisition-receipts.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    counts = {}
    for r in receipts: counts[r["status"]] = counts.get(r["status"], 0) + 1
    summary = {"candidateCount": len(receipts), "counts": counts, "receiptFile": str(out), "receiptSha256": hashlib.sha256(out.read_bytes()).hexdigest()}
    (OUT / "acquisition-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(summary, ensure_ascii=False))

if __name__ == "__main__":
    main()
