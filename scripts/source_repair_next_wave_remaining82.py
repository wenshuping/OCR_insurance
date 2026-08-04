#!/usr/bin/env python3
"""Source-only repair for the remaining products in the next-wave manifest.

This script intentionally stops at source contracts: no model calls and no DB writes.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import ssl
import sys
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pypdf import PdfReader

INPUT = Path("/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/responsibility-bulk-dual-pool-20260727/next-wave-600-20260727-20260727-203421/window-next-1-standard-gemini.json")
CANARY = Path("/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/source-canary-next-wave-600-20260727/selected-products.json")
ROOT = Path(os.environ.get("SOURCE_REPAIR_ROOT", "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/source-repair-next-wave-600-remaining82-20260727"))
API = "https://life.pingan.com/ilife-home/product/getProductList"
PDF = "https://life.pingan.com/ilife-home/product/getPlanClausePdf"
HEADERS = {
    "Content-Type": "application/json",
    "Referer": "https://life.pingan.com/p/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}
CTX = ssl._create_unverified_context()


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKC", str(value or ""))
    return re.sub(r"[\s\u3000]+", "", value).replace("（", "(").replace("）", ")")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_name(value: str) -> str:
    value = re.sub(r"[\\/:*?\"<>|]", "_", value)
    return value[:180]


def get_json(url: str, payload: dict) -> tuple[dict, int, int]:
    req = Request(url, data=json.dumps(payload, ensure_ascii=False).encode(), headers=HEADERS, method="POST")
    with urlopen(req, timeout=60, context=CTX) as response:
        body = response.read()
        return json.loads(body.decode("utf-8")), response.status, len(body)


def get_bytes(url: str) -> tuple[bytes, int, str]:
    req = Request(url, headers={k: v for k, v in HEADERS.items() if k != "Content-Type"})
    with urlopen(req, timeout=90, context=CTX) as response:
        body = response.read()
        return body, response.status, response.geturl()


def extract_pdf(pdf_path: Path) -> dict:
    reader = PdfReader(str(pdf_path))
    encrypted = bool(reader.is_encrypted)
    empty_ok = False
    if encrypted:
        empty_ok = bool(reader.decrypt(""))
        if not empty_ok:
            return {"pages": len(reader.pages), "encrypted": True, "emptyPasswordDecryptable": False, "texts": []}
    texts = [(page.extract_text() or "") for page in reader.pages]
    return {
        "pages": len(reader.pages),
        "encrypted": encrypted,
        "emptyPasswordDecryptable": empty_ok,
        "texts": texts,
    }


def responsibility_pages(texts: list[str]) -> list[int]:
    pages: list[int] = []
    for idx, text in enumerate(texts, 1):
        compact = re.sub(r"\s+", "", text)
        if "保险责任" in compact and re.search(r"保险金|给付|赔付|承担|我们按", compact):
            pages.append(idx)
    return pages


def title_present(texts: list[str], title: str) -> bool:
    target = norm(title)
    joined = norm("\n".join(texts))
    return bool(target and target in joined)


def write_json(path: Path, obj: object) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    if ROOT.exists():
        raise SystemExit(f"refusing to overwrite existing immutable directory: {ROOT}")
    ROOT.mkdir(parents=True)
    products = json.loads(INPUT.read_text(encoding="utf-8"))
    canary = json.loads(CANARY.read_text(encoding="utf-8"))
    canary_products = canary.get("products", canary) if isinstance(canary, (dict, list)) else []
    excluded = {int(item.get("selectionIndex")) for item in canary_products if item.get("selectionIndex") is not None}
    remaining = []
    for original_index, item in enumerate(products):
        if original_index in excluded:
            continue
        item = dict(item)
        item["selectionIndex"] = original_index
        remaining.append(item)
    if len(remaining) != 82:
        raise SystemExit(f"expected 82 remaining products, got {len(remaining)}")
    write_json(ROOT / "selected-products.json", {
        "inputManifest": str(INPUT),
        "excludedCanaryManifest": str(CANARY),
        "selectedCount": len(remaining),
        "excludedCanaryCount": len(excluded),
        "modelCalls": False,
        "databaseWrites": False,
        "products": remaining,
    })

    api_attempts = []
    catalogs: list[dict] = []
    for sale, status in (("Y", "Y"), ("N", "N")):
        payload = {"isOrNotSale": sale, "planSalesStatus": status, "sourceCode": "ilife-core", "planCode": "", "planDesc": "", "isOnlyNew": "Y"}
        try:
            data, http_status, byte_len = get_json(API, payload)
            rows = data.get("DATA") if isinstance(data, dict) else []
            rows = rows if isinstance(rows, list) else []
            catalogs.extend(rows)
            api_attempts.append({"saleType": sale, "payload": payload, "httpStatus": http_status, "responseBytes": byte_len, "code": data.get("CODE"), "rowCount": len(rows), "status": "success"})
            write_json(ROOT / f"official-pingan-api-{sale}.json", {"endpoint": API, "payload": payload, "response": data})
        except Exception as exc:
            api_attempts.append({"saleType": sale, "payload": payload, "status": "failed", "error": repr(exc)})
    write_json(ROOT / "official-pingan-api-attempts.json", api_attempts)

    by_name: dict[str, list[dict]] = {}
    for row in catalogs:
        by_name.setdefault(norm(row.get("clauseName") or row.get("planName")), []).append(row)

    results = []
    for pos, item in enumerate(remaining, 1):
        idx = int(item["selectionIndex"])
        product = str(item["productName"])
        company = str(item.get("company") or "中国平安人寿保险股份有限公司")
        folder = ROOT / f"{idx:03d}-{safe_name(product)}"
        folder.mkdir()
        attempts = [{"layer": "official_api", "endpoint": API, "status": "queried"}]
        matches = by_name.get(norm(product), [])
        contract = {
            "selectionIndex": idx,
            "company": company,
            "productName": product,
            "sourceUrl": item.get("sourceUrl", ""),
            "officialDomain": "life.pingan.com",
            "retrievalMethod": "official_api_static_pdf",
            "evidenceLevel": "official_insurer",
            "route": "official_api_static_pdf",
            "sourceStatus": "source_blocked",
            "sourceFile": None,
            "extractedTextFile": None,
            "sourceDigest": None,
            "sourceByteLength": None,
            "pdf": {"pages": 0, "encrypted": False, "encryption": "", "emptyPasswordDecryptable": False},
            "exactProductVerified": False,
            "exactVersionVerified": False,
            "responsibilityPages": [],
            "blockers": [],
        }
        if not matches:
            contract["blockers"].append("official_api_no_exact_product_match; headless/JRCPCX fallback required")
            attempts.append({"layer": "official_api", "status": "no_exact_match"})
            write_json(folder / "attempts.json", attempts)
            write_json(folder / "source-contract.json", contract)
            results.append(contract)
            continue
        if len(matches) > 1:
            versions = [{"planCode": r.get("planCode"), "versionNo": r.get("versionNo"), "startDate": r.get("startDate"), "endDate": r.get("endDate")} for r in matches]
            contract["sourceStatus"] = "version_conflict"
            contract["blockers"].append("official_api_multiple_exact_name_versions_without_input_version")
            contract["apiCandidates"] = versions
            attempts.append({"layer": "official_api", "status": "multiple_exact_versions", "candidates": versions})
            write_json(folder / "attempts.json", attempts)
            write_json(folder / "source-contract.json", contract)
            results.append(contract)
            continue
        row = matches[0]
        contract["apiProduct"] = row
        plan_code, version_no = str(row.get("planCode") or ""), str(row.get("versionNo") or "")
        contract["exactProductVerified"] = norm(row.get("clauseName") or row.get("planName")) == norm(product)
        contract["exactVersionVerified"] = bool(version_no)
        if not plan_code or not version_no or str(row.get("clauseContent")) != "1":
            contract["blockers"].append("official_api_missing_terms_or_version")
            attempts.append({"layer": "official_api", "status": "missing_terms_or_version", "planCode": plan_code, "versionNo": version_no})
            write_json(folder / "attempts.json", attempts)
            write_json(folder / "source-contract.json", contract)
            results.append(contract)
            continue
        url = PDF + "?" + urlencode({"planCode": plan_code, "versionNo": version_no, "attachmentType": "1"})
        contract["sourceUrl"] = url
        try:
            body, http_status, final_url = get_bytes(url)
            (folder / "official-source.pdf").write_bytes(body)
            digest = sha256(body)
            contract["sourceDigest"] = f"sha256:{digest}"
            contract["sourceByteLength"] = len(body)
            attempts.append({"layer": "official_api_static_pdf", "url": url, "finalUrl": final_url, "httpStatus": http_status, "byteLength": len(body), "sha256": digest, "pdfMagic": body.startswith(b"%PDF-")})
            if not body.startswith(b"%PDF-"):
                contract["blockers"].append("response_not_pdf_magic")
            else:
                info = extract_pdf(folder / "official-source.pdf")
                texts = info.pop("texts")
                pages_file = folder / "official-source.pages.txt"
                pages_file.write_text("\n\n".join(f"===== PAGE {i} =====\n{text}" for i, text in enumerate(texts, 1)), encoding="utf-8")
                resp_pages = responsibility_pages(texts)
                contract["pdf"] = {"pages": info["pages"], "encrypted": info["encrypted"], "encryption": "AES/standard" if info["encrypted"] else "", "emptyPasswordDecryptable": info["emptyPasswordDecryptable"]}
                contract["extractedTextFile"] = str(pages_file)
                contract["sourceFile"] = str(folder / "official-source.pdf")
                contract["responsibilityPages"] = resp_pages
                contract["exactProductVerified"] = contract["exactProductVerified"] and title_present(texts, product)
                attempts.append({"layer": "pdf_validation", "pages": info["pages"], "encrypted": info["encrypted"], "emptyPasswordDecryptable": info["emptyPasswordDecryptable"], "titlePresent": contract["exactProductVerified"], "responsibilityPages": resp_pages})
                if not contract["exactProductVerified"]:
                    contract["blockers"].append("exact_product_title_not_found_in_pdf_text")
                    contract["sourceStatus"] = "version_conflict"
                elif not resp_pages:
                    contract["blockers"].append("responsibility_chapter_not_readable_in_text_layer")
                    contract["sourceStatus"] = "ocr_needs_review"
                elif info["encrypted"] and not info["emptyPasswordDecryptable"]:
                    contract["blockers"].append("encrypted_pdf_requires_authorized_password")
                else:
                    contract["sourceStatus"] = "source_ready"
        except Exception as exc:
            contract["blockers"].append(f"official_pdf_fetch_or_parse_failed:{type(exc).__name__}:{exc}")
            attempts.append({"layer": "official_api_static_pdf", "url": url, "status": "failed", "error": repr(exc)})
        write_json(folder / "attempts.json", attempts)
        write_json(folder / "source-contract.json", contract)
        results.append(contract)
        if pos % 10 == 0:
            write_json(ROOT / "progress.json", {"processed": pos, "total": len(remaining), "statusCounts": {s: sum(1 for r in results if r["sourceStatus"] == s) for s in ("source_ready", "version_conflict", "source_blocked", "ocr_needs_review")}})
        time.sleep(0.05)

    write_json(ROOT / "source-repair-manifest.json", {"inputManifest": str(INPUT), "selectedProducts": str(ROOT / "selected-products.json"), "products": [{"selectionIndex": r["selectionIndex"], "productName": r["productName"], "sourceStatus": r["sourceStatus"], "sourceContract": str(ROOT / f"{r['selectionIndex']:03d}-{safe_name(r['productName'])}" / "source-contract.json")} for r in results], "noModelCalls": True, "noDatabaseWrites": True})
    counts = {s: sum(1 for r in results if r["sourceStatus"] == s) for s in ("source_ready", "version_conflict", "source_blocked", "ocr_needs_review")}
    write_json(ROOT / "summary.json", {"selectedCount": len(results), "excludedCanaryCount": len(excluded), "statusCounts": counts, "officialApiRows": len(catalogs), "jrcpcxFallbackRequired": sum(1 for r in results if any("fallback required" in b for b in r["blockers"])), "noModelCalls": True, "noDatabaseWrites": True})
    print(json.dumps({"root": str(ROOT), "counts": counts, "apiRows": len(catalogs)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
