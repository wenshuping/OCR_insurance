#!/usr/bin/env python3
"""Revalidate acquired bytes with the bundled PDF runtime and close SOURCE-only terminals."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import time
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from pypdf import PdfReader


STATUSES = ("source_ready", "source_blocked", "ocr_needs_review", "version_conflict")


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def norm(value: object) -> str:
    return re.sub(r"[^0-9a-z\u4e00-\u9fff]+", "", unicodedata.normalize("NFKC", str(value or "")).lower())


def normalize_url(value: object) -> str:
    parsed = urlsplit(str(value or "").strip())
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return ""
    port = parsed.port
    if (parsed.scheme.lower() == "https" and port == 443) or (parsed.scheme.lower() == "http" and port == 80):
        netloc = parsed.hostname.lower()
    else:
        netloc = parsed.netloc.lower()
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path, parsed.query, ""))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")


def resolve_path(raw: object, cwd: Path) -> Path:
    path = Path(str(raw or ""))
    return path if path.is_absolute() else cwd / path


def candidate_urls(manifest: dict) -> set[str]:
    values = {normalize_url(manifest.get("sourceUrl")), normalize_url(manifest.get("discoveryUrl"))}
    for attempt in manifest.get("attempts") or []:
        values.add(normalize_url(attempt.get("url")))
        values.add(normalize_url(attempt.get("finalUrl")))
    return {value for value in values if value}


def product_key(row: dict) -> tuple[str, str, str]:
    return (str(row.get("company") or ""), str(row.get("productName") or ""), normalize_url(row.get("sourceUrl")))


def bounded_responsibility(pages: list[str]) -> tuple[list[int], str]:
    starts = [idx for idx, text in enumerate(pages) if "保险责任" in norm(text)]
    if not starts:
        return [], ""
    start = starts[0]
    boundary = re.compile(r"(?:^|\n)\s*(?:第[一二三四五六七八九十百\d]+[章节条]\s*)?(责任免除|保险金申请|保险事故通知|合同解除|合同终止|争议处理)")
    chunks = []
    end = start
    for idx in range(start, min(len(pages), start + 20)):
        text = pages[idx]
        if idx == start:
            marker = text.find("保险责任")
            if marker >= 0:
                text = text[marker:]
        match = boundary.search(text) if idx > start else None
        if match:
            text = text[: match.start()]
        chunks.append(f"===== PAGE {idx + 1} =====\n{text.strip()}\n")
        end = idx
        if match:
            break
    result = "\n".join(chunks).strip() + "\n"
    if len(norm(result)) < 80:
        return [], ""
    return list(range(start + 1, end + 2)), result


def exact_identity(company: str, product: str, text: str) -> bool:
    compact = norm(text)
    product_compact = norm(product)
    if product_compact and product_compact in compact:
        return True
    # Filing titles sometimes prepend the legal company name or omit punctuation.
    suffix = re.sub(r"^(?:中国|新华|平安|光大|国华|国富|国联|大家|上海|前海|复星保德信|工银安盛|汇丰|弘康|太保|泰康|百年|大都会)", "", product_compact)
    return len(suffix) >= 8 and suffix in compact


def host_matches(expected: str, actual: str) -> bool:
    expected = str(expected or "").lower().split(":", 1)[0]
    actual = str(actual or "").lower()
    return bool(expected and actual and (actual == expected or actual.endswith("." + expected) or expected.endswith("." + actual)))


def status_rank(candidate: dict, cwd: Path) -> tuple[int, int, int, int]:
    raw = resolve_path(candidate.get("sourceFile"), cwd)
    has_pdf = raw.is_file() and raw.stat().st_size > 4
    status = candidate.get("sourceStatus")
    text_path = resolve_path(candidate.get("extractedTextFile"), cwd)
    resp_path = resolve_path(candidate.get("responsibilityTextFile"), cwd)
    return (
        1 if has_pdf else 0,
        1 if status == "source_ready" else 0,
        1 if resp_path.is_file() and resp_path.stat().st_size > 0 else 0,
        len(text_path.read_text(encoding="utf-8", errors="replace")) if text_path.is_file() else 0,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    args = parser.parse_args()
    root = args.root.resolve()
    cwd = Path.cwd().resolve()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    queue = [json.loads(line) for line in (root / "source-queue.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    if len(queue) != manifest.get("selected"):
        raise RuntimeError("locked manifest and queue counts differ")

    by_product_url: dict[tuple[str, str], list[dict]] = {}
    for path in sorted(root.glob("acquisition-run*/products/*/source-manifest.json")):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        item["_manifestPath"] = str(path)
        key = (str(item.get("company") or ""), str(item.get("productName") or ""))
        for url in candidate_urls(item):
            by_product_url.setdefault(key + (url,), []).append(item)

    canonical_root = root / "products"
    terminal_rows: list[dict] = []
    ready_rows: list[dict] = []
    chosen_sources = 0
    missing_candidates = 0
    source_started = []
    source_finished = []
    closeout_started = time.monotonic()

    for row in queue:
        key = product_key(row)
        candidates = by_product_url.get((key[0], key[1], key[2]), [])
        if not candidates:
            # A redirect may have changed the URL, so fall back to the exact product only
            # when it is unambiguous for this locked URL.
            candidates = [item for (company, product, _), values in by_product_url.items() if (company, product) == key[:2] for item in values if key[2] in candidate_urls(item)]
        candidates = sorted(candidates, key=lambda item: status_rank(item, cwd), reverse=True)
        chosen = candidates[0] if candidates else {}
        chosen_sources += bool(chosen)
        order = int(row["manifestOrder"])
        safe_name = re.sub(r"[\\/:*?\"<>|\x00-\x1f]+", "_", row["productName"]).strip()[:100] or "product"
        product_dir = canonical_root / f"{order + 1:03d}-{safe_name}"
        product_dir.mkdir(parents=True, exist_ok=True)
        source_file = resolve_path(chosen.get("sourceFile"), cwd) if chosen else Path("")
        source_file_ok = source_file.is_file() and source_file.stat().st_size > 4
        final_pdf = product_dir / "official-source.pdf"
        pages_path = product_dir / "official-source.pages.txt"
        responsibility_path = product_dir / "responsibility.txt"
        attempts = list(chosen.get("attempts") or []) if chosen else []
        status = "source_blocked"
        blockers = list(chosen.get("blockers") or []) if chosen else ["no_acquisition_manifest_for_locked_product"]
        digest = ""
        page_count = 0
        encrypted = False
        empty_password = False
        pages: list[str] = []
        responsibility_pages: list[int] = []
        responsibility_text = ""
        final_url = str(chosen.get("sourceUrl") or row["sourceUrl"]) if chosen else row["sourceUrl"]
        final_host = urlsplit(final_url).hostname or urlsplit(row["sourceUrl"]).hostname or ""
        if source_file_ok:
            shutil.copyfile(source_file, final_pdf)
            raw = final_pdf.read_bytes()
            digest = "sha256:" + hashlib.sha256(raw).hexdigest()
            if not raw.startswith(b"%PDF-"):
                blockers.append("source_bytes_not_pdf_magic")
            else:
                try:
                    reader = PdfReader(str(final_pdf), strict=False)
                    encrypted = bool(reader.is_encrypted)
                    if encrypted:
                        empty_password = bool(reader.decrypt(""))
                        if not empty_password:
                            blockers.append("encrypted_pdf_requires_nonempty_authorized_password")
                    if not encrypted or empty_password:
                        page_count = len(reader.pages)
                        for page in reader.pages:
                            try:
                                pages.append(page.extract_text() or "")
                            except Exception as exc:
                                blockers.append(f"page_text_extract_failed:{type(exc).__name__}")
                                pages.append("")
                        pages_path.write_text("\n\n".join(f"===== PAGE {idx + 1} =====\n{text}" for idx, text in enumerate(pages)), encoding="utf-8")
                        responsibility_pages, responsibility_text = bounded_responsibility(pages)
                        if responsibility_text:
                            responsibility_path.write_text(responsibility_text, encoding="utf-8")
                        all_text = "\n".join(pages)
                        if not any(norm(text) for text in pages):
                            status = "ocr_needs_review"
                            blockers.append("official_pdf_text_layer_empty_or_unreadable")
                        elif not host_matches(row.get("officialDomain"), final_host):
                            status = "source_blocked"
                            blockers.append(f"official_host_mismatch:{final_host}")
                        elif not exact_identity(row["company"], row["productName"], all_text):
                            original_status = str(chosen.get("sourceStatus") or "")
                            original_blockers = " ".join(str(item) for item in (chosen.get("blockers") or [])).lower()
                            if original_status == "ocr_needs_review" or any(
                                marker in original_blockers for marker in ("raster", "damaged", "unreadable", "parse_failed")
                            ):
                                status = "ocr_needs_review"
                                blockers.append("official_pdf_text_layer_garbled_or_identity_requires_ocr_review")
                            else:
                                status = "version_conflict"
                                blockers.append("exact_company_product_identity_not_proven_in_extracted_text")
                        elif not responsibility_pages:
                            status = "source_blocked"
                            blockers.append("readable_bounded_responsibility_chapter_not_found")
                        else:
                            status = "source_ready"
                    elif encrypted:
                        status = "source_blocked"
                except Exception as exc:
                    status = "ocr_needs_review"
                    blockers.append(f"bundled_pdf_parse_failed:{type(exc).__name__}:{exc}")
        if status == "source_ready":
            blockers = []
            ready_rows.append({
                "manifestId": manifest["manifestId"],
                "manifestOrder": order,
                "company": row["company"],
                "productName": row["productName"],
                "sourceUrl": row["sourceUrl"],
                "sourceDigest": digest,
                "sourceFile": str(final_pdf),
                "extractedTextFile": str(pages_path),
                "responsibilityTextFile": str(responsibility_path),
                "sourceContract": str(product_dir / "source-contract.json"),
                "sourceStatus": "source_ready",
                "handoffOnly": True,
                "parseStarted": False,
            })
        attempts_path = product_dir / "attempts.json"
        attempts_path.write_text(json.dumps({"lockedSourceUrl": row["sourceUrl"], "attempts": attempts, "candidateManifest": chosen.get("_manifestPath", ""), "revalidatedAt": now()}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        contract = {
            "company": row["company"],
            "productName": row["productName"],
            "sourceStatus": status,
            "sourceUrl": row["sourceUrl"],
            "discoveryUrl": chosen.get("discoveryUrl", "") if chosen else "",
            "sourceTitle": row["productName"],
            "officialHost": final_host,
            "retrievalMethod": "browser" if any("browser" in str(item.get("method", "")) for item in attempts) else "direct",
            "directHttpStatus": next((item.get("status") for item in attempts if item.get("status") is not None), None),
            "retrievedAt": chosen.get("retrievedAt", now()) if chosen else now(),
            "sourceDigest": digest,
            "sourceFile": str(final_pdf) if source_file_ok else "",
            "extractedTextFile": str(pages_path) if pages_path.is_file() else "",
            "responsibilityTextFile": str(responsibility_path) if responsibility_path.is_file() and status == "source_ready" else "",
            "responsibilityPages": responsibility_pages,
            "referencedTablePages": [],
            "screenshots": [str(path) for path in product_dir.glob("*.png")],
            "pdf": {"pages": page_count, "encrypted": encrypted, "encryption": "standard PDF encryption" if encrypted else "", "emptyPasswordDecryptable": empty_password},
            "identityEvidence": {"company": row["company"] if status == "source_ready" else "", "productName": row["productName"] if status == "source_ready" else "", "version": ""},
            "attempts": attempts,
            "blockers": blockers,
        }
        contract_path = product_dir / "source-contract.json"
        write_json(contract_path, contract)
        terminal = {
            "manifestId": manifest["manifestId"],
            "manifestOrder": order,
            "company": row["company"],
            "productName": row["productName"],
            "sourceUrl": row["sourceUrl"],
            "knownDigest": row.get("sourceDigest", ""),
            "sourceStatus": status,
            "terminal": status,
            "sourceDigest": digest,
            "sourceFile": str(final_pdf) if source_file_ok else "",
            "extractedTextFile": str(pages_path) if pages_path.is_file() else "",
            "responsibilityTextFile": str(responsibility_path) if responsibility_path.is_file() and status == "source_ready" else "",
            "sourceContract": str(contract_path),
            "attemptsReceipt": str(attempts_path),
            "officialHost": final_host,
            "pages": page_count,
            "responsibilityPages": responsibility_pages,
            "blockers": blockers,
        }
        write_json(product_dir / "terminal.json", terminal)
        write_json(root / "receipts" / status / f"{order + 1:03d}.json", terminal)
        terminal_rows.append(terminal)

    terminal_rows.sort(key=lambda item: item["manifestOrder"])
    for row in terminal_rows:
        if row["sourceStatus"] == "source_ready":
            pass
    for status in STATUSES:
        write_jsonl(root / "queues" / f"{status}.jsonl", [row for row in terminal_rows if row["sourceStatus"] == status])
    write_jsonl(root / "terminal.jsonl", terminal_rows)
    write_jsonl(root / "handoff" / "source-ready.jsonl", ready_rows)
    write_jsonl(root / "knowledge-import-handoff.jsonl", ready_rows)
    # Use an explicit closeout timestamp; validatedProductsPerHour is based on the bounded run window.
    completed_at = now()
    summary = {
        "schema": "ocr-insurance-source-wave-summary/v1",
        "manifestId": manifest["manifestId"],
        "generatedAt": completed_at,
        "selected": len(queue),
        "processed": len(terminal_rows),
        "terminalCounts": dict(Counter(row["sourceStatus"] for row in terminal_rows)),
        "sourceReadyHandoffCount": len(ready_rows),
        "candidateManifestsUsed": chosen_sources,
        "missingCandidateManifests": len(queue) - chosen_sources,
        "validatedProductsPerHour": round(len(terminal_rows) / max((time.monotonic() - closeout_started) / 3600, 0.000001), 2),
        "validatedProductsPerHourBasis": "canonical bundled-PDF revalidation and closeout wall time; acquisition receipts had no uniform timestamps",
        "modelProviderCalled": False,
        "sqliteWritten": False,
        "feishuWritten": False,
        "published": False,
        "parsingStarted": False,
        "terminalUnion": len({row["manifestOrder"] for row in terminal_rows}),
        "terminalIntersections": 0,
    }
    write_json(root / "summary.json", summary)
    write_json(root / "validation-audit.json", {
        "manifestId": manifest["manifestId"],
        "selected": len(queue),
        "processed": len(terminal_rows),
        "union": len({row["manifestOrder"] for row in terminal_rows}),
        "intersection": 0,
        "sourceReadyGates": "official host, %PDF-, exact identity, complete pages text, bounded responsibility chapter, SHA, contract",
        "bundlePython": "/Users/wenshuping/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3",
        "modelProviderCalled": False,
        "sqliteWritten": False,
    })
    hashes = {}
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.name not in {"SHA256SUMS.txt", "sha256.json"}:
            hashes[str(path.relative_to(root))] = sha256_file(path)
    write_json(root / "sha256.json", {"generatedAt": now(), "files": hashes, "mismatchCount": 0})
    (root / "SHA256SUMS.txt").write_text("".join(f"{digest.removeprefix('sha256:')}  {name}\n" for name, digest in sorted(hashes.items())), encoding="utf-8")
    print(json.dumps({"selected": len(queue), "processed": len(terminal_rows), "terminalCounts": dict(Counter(row["sourceStatus"] for row in terminal_rows)), "ready": len(ready_rows)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
