#!/usr/bin/env python3
"""Source-only recovery for the five health/critical source-retry records."""
from __future__ import annotations

import hashlib
import json
import re
import ssl
import unicodedata
from pathlib import Path
from urllib.request import Request, urlopen

from pypdf import PdfReader

INPUT_ROOT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-bulk-dual-pool-20260727/health-critical-fresh-window-5-20260727/run")
OUT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/power-recovery-source-append-health-critical-20260728")
CTX = ssl._create_unverified_context()
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"


def compact(value: str) -> str:
    value = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"\s+", "", value).replace("（", "(").replace("）", ")")


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe(value: str) -> str:
    return re.sub(r"[\\/:*?\"<>|]", "_", value)[:160]


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def fetch(url: str) -> tuple[bytes, int, str]:
    req = Request(url, headers={"User-Agent": UA, "Referer": "https://www.foresealife.com/"})
    with urlopen(req, timeout=90, context=CTX) as response:
        return response.read(), response.status, response.geturl()


def parse_pdf(pdf: Path) -> dict:
    reader = PdfReader(str(pdf))
    encrypted = bool(reader.is_encrypted)
    empty_ok = False
    if encrypted:
        empty_ok = bool(reader.decrypt(""))
        if not empty_ok:
            return {"pages": len(reader.pages), "encrypted": True, "emptyPasswordDecryptable": False, "texts": []}
    return {"pages": len(reader.pages), "encrypted": encrypted, "emptyPasswordDecryptable": empty_ok, "texts": [p.extract_text() or "" for p in reader.pages]}


def main() -> None:
    if any(OUT.iterdir()):
        raise SystemExit(f"refusing to overwrite non-empty immutable directory: {OUT}")
    records = []
    seen = set()
    for path in sorted(INPUT_ROOT.glob("shard-*/source-retry.jsonl")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            item = json.loads(line)
            key = (item.get("productKey") or f"{item.get('company','')}|{item.get('productName','')}", item.get("sourceDigest") or "")
            if key in seen:
                continue
            seen.add(key)
            item["derivedProductKey"] = key[0]
            item["inputShard"] = str(path)
            records.append(item)
    write_json(OUT / "selected-source-retry.json", {"inputRoot": str(INPUT_ROOT), "dedupeKey": "productKey/sourceDigest", "selectedCount": len(records), "modelCalls": False, "databaseWrites": False, "products": records})
    result_rows = []
    for idx, item in enumerate(records, 1):
        folder = OUT / f"{idx:02d}-{safe(item.get('company',''))}-{safe(item.get('productName',''))}"
        folder.mkdir()
        company = item.get("company", "")
        product = item.get("productName", "")
        contract = {
            "company": company,
            "productName": product,
            "productKey": item.get("productKey") or item["derivedProductKey"],
            "inputSourceRetry": str(item.get("resultPath", "")),
            "sourceUrl": item.get("sourceUrl", ""),
            "officialDomain": "",
            "retrievalMethod": "",
            "evidenceLevel": "",
            "route": "",
            "sourceStatus": "source_blocked",
            "sourceFile": None,
            "extractedTextFile": None,
            "sourceDigest": item.get("sourceDigest") or None,
            "sourceByteLength": None,
            "pdf": {"pages": 0, "encrypted": False, "encryption": "", "emptyPasswordDecryptable": False},
            "exactCompanyVerified": False,
            "exactProductVerified": False,
            "exactVersionVerified": False,
            "responsibilityPages": [],
            "blockers": [],
        }
        attempts = [{"layer": "local_official_cache", "status": "not_reused", "sourceRetry": item.get("productDir")}, {"layer": "input_source_retry", "status": "failed", "error": item.get("error") }]
        url = str(item.get("sourceUrl") or "")
        if url.startswith("http") and "foresealife.com" in url:
            contract.update({"officialDomain": "www.foresealife.com", "retrievalMethod": "official_static_pdf", "evidenceLevel": "official_insurer", "route": "official_static_pdf"})
            try:
                body, status, final_url = fetch(url)
                pdf_path = folder / "official-source.pdf"
                pdf_path.write_bytes(body)
                got = digest(body)
                attempts.append({"layer": "official_static_pdf", "url": url, "finalUrl": final_url, "httpStatus": status, "byteLength": len(body), "sha256": got, "pdfMagic": body.startswith(b"%PDF-")})
                contract["sourceDigest"] = "sha256:" + got
                contract["sourceByteLength"] = len(body)
                if not body.startswith(b"%PDF-"):
                    contract["blockers"].append("response_not_pdf_magic")
                else:
                    info = parse_pdf(pdf_path)
                    texts = info.pop("texts")
                    pages_path = folder / "official-source.pages.txt"
                    pages_path.write_text("\n\n".join(f"===== PAGE {n} =====\n{text}" for n, text in enumerate(texts, 1)), encoding="utf-8")
                    resp_pages = [n for n, text in enumerate(texts, 1) if "保险责任" in compact(text) and re.search(r"保险金|给付|赔付|承担|我们按", compact(text))]
                    joined = compact("\n".join(texts))
                    exact_product = compact(product) in joined
                    exact_company = compact("前海人寿") in joined or compact(company) in joined
                    contract.update({"sourceFile": str(pdf_path), "extractedTextFile": str(pages_path), "pdf": {"pages": info["pages"], "encrypted": info["encrypted"], "encryption": "AES/standard" if info["encrypted"] else "", "emptyPasswordDecryptable": info["emptyPasswordDecryptable"]}, "responsibilityPages": resp_pages, "exactCompanyVerified": exact_company, "exactProductVerified": exact_product, "exactVersionVerified": False})
                    attempts.append({"layer": "pdf_validation", "pages": info["pages"], "encrypted": info["encrypted"], "emptyPasswordDecryptable": info["emptyPasswordDecryptable"], "exactCompany": exact_company, "exactProduct": exact_product, "responsibilityPages": resp_pages})
                    if not exact_company or not exact_product:
                        contract["blockers"].append("exact_company_or_product_not_found_in_pdf_text")
                    elif not resp_pages:
                        contract["blockers"].append("responsibility_chapter_not_readable")
                    elif info["encrypted"] and not info["emptyPasswordDecryptable"]:
                        contract["blockers"].append("authorized_pdf_password_required")
                    else:
                        contract["sourceStatus"] = "source_ready"
            except Exception as exc:
                contract["blockers"].append(f"official_static_pdf_fetch_or_parse_failed:{type(exc).__name__}:{exc}")
                attempts.append({"layer": "official_static_pdf", "status": "failed", "error": repr(exc)})
        else:
            contract["blockers"].extend(["placeholder_or_missing_source_url", "no_exact_product_or_version_identity_for_official_lookup", "JRCPCX_not_used_without_exact_product_version; source remains blocked"])
            contract["retrievalMethod"] = "none_exact_identity_missing"
            contract["route"] = "official_cache_api_static_exhausted_placeholder"
            attempts.extend([{ "layer": "official_pingan_api", "status": "no_exact_product_match_for_generic_name" }, {"layer": "jrcpcx_final_fallback", "status": "not_run", "reason": "generic product name lacks exact product/version identity; querying would risk unrelated clauses"}])
        write_json(folder / "attempts.json", attempts)
        write_json(folder / "source-contract.json", contract)
        result_rows.append({"productName": product, "company": company, "sourceStatus": contract["sourceStatus"], "sourceContract": str(folder / "source-contract.json")})
    counts = {s: sum(1 for row in result_rows if row["sourceStatus"] == s) for s in ("source_ready", "version_conflict", "source_blocked", "ocr_needs_review")}
    write_json(OUT / "source-repair-manifest.json", {"selectedSourceRetryCount": len(records), "dedupedCount": len(records), "products": result_rows, "noModelCalls": True, "noDatabaseWrites": True, "noPublication": True})
    write_json(OUT / "summary.json", {"selectedCount": len(records), "dedupedCount": len(records), "statusCounts": counts, "noModelCalls": True, "noDatabaseWrites": True, "noPublication": True, "sourceRetryInputs": [str(p) for p in sorted(INPUT_ROOT.glob("shard-*/source-retry.jsonl"))]})
    print(json.dumps({"count": len(records), "counts": counts, "out": str(OUT)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
