#!/usr/bin/env python3
"""Run the fixed window-4 shard-2 through the direct Codex Luna runner."""

from __future__ import annotations

import importlib.util
import concurrent.futures
import hashlib
import json
from json import JSONDecoder
from pathlib import Path
from pypdf import PdfReader


TEMPLATE = Path(__file__).with_name("run_luna_window4_shard3_direct.py")
INPUT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/"
    "run-window-4/luna-shards/shard-2.json"
)
OUTPUT = Path(
    "/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/"
    "responsibility-bulk-dual-pool-20260727/rolling-wave-next-20260727/"
    "run-window-4/luna-shard-2"
)


def main() -> int:
    spec = importlib.util.spec_from_file_location("luna_window4_runner", TEMPLATE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load runner template: {TEMPLATE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.INPUT = INPUT
    module.OUTPUT = OUTPUT
    module.DOWNLOAD_UA = "Mozilla/5.0 OCRInsuranceLunaWindow4Shard2/1.0"

    original_download = module.download_source

    def download_cached(url: str, target: Path):
        if target.exists() and target.read_bytes().startswith(b"%PDF"):
            digest = "sha256:" + hashlib.sha256(target.read_bytes()).hexdigest()
            return digest, {"requestedUrl": url, "finalUrl": url, "retrieval": "cached-from-this-run", "bytes": target.stat().st_size}
        return original_download(url, target)

    def extract_with_pypdf(pdf: Path, text_path: Path, report_path: Path) -> None:
        pages = []
        report = []
        for number, page in enumerate(PdfReader(str(pdf)).pages, start=1):
            text = page.extract_text() or ""
            pages.append(f"PDF_PAGE_{number}\n{text}")
            report.append({"page": number, "layoutAvailable": False, "tableLike": False, "ordinaryCharacters": len(text), "layoutCharacters": 0})
        source_text = "\n\n".join(pages)
        if "保险责任" not in source_text:
            raise ValueError("extracted PDF text does not contain 保险责任")
        text_path.write_text(source_text, encoding="utf-8")
        report_path.write_text(json.dumps({"extractor": "pypdf-ordinary-text-fallback", "pages": report, "tablePages": [], "crossPageTableRanges": []}, ensure_ascii=False, indent=2), encoding="utf-8")

    module.download_source = download_cached
    module.extract_source = extract_with_pypdf

    def parse_model_json_robust(path: Path) -> dict:
        raw = path.read_text(encoding="utf-8")
        decoder = JSONDecoder()
        candidates = []
        for offset, character in enumerate(raw):
            if character != "{":
                continue
            try:
                value, _ = decoder.raw_decode(raw[offset:])
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                candidates.append((len(value.get("responsibilities") or []), -offset, value))
        if not candidates:
            raise ValueError("Codex Luna response did not contain a complete JSON object")
        return max(candidates, key=lambda item: (item[0], item[1]))[2]

    module.parse_model_json = parse_model_json_robust
    items = [row for row in json.loads(INPUT.read_text(encoding="utf-8")) if isinstance(row, dict)]
    if len(items) != 34 or any(item.get("route") != "luna_review" for item in items):
        raise SystemExit(f"unexpected shard-2 manifest: count={len(items)} or non-luna route")
    OUTPUT.mkdir(parents=True, exist_ok=True)
    module.write_json(OUTPUT / "manifest.json", {"input": str(INPUT), "selected": items, **module.model_meta(), "scope": "rolling-wave-next-20260727/window-4/luna-shard-2", "resume": True, "extractor": "pypdf-ordinary-text-fallback"})
    for filename in ("approved.jsonl", "validation-review.jsonl", "model-retry.jsonl", "source-retry.jsonl"):
        (OUTPUT / filename).touch()
    def prior_status(item: dict) -> str:
        url_id = hashlib.sha256(item["sourceUrl"].encode("utf-8")).hexdigest()[:12]
        product_dir = OUTPUT / "products" / f"{module.safe_name(item.get('company'))}-{module.safe_name(item.get('productName'))}-{url_id}"
        try:
            return json.loads((product_dir / "result.json").read_text(encoding="utf-8")).get("status", "")
        except (OSError, json.JSONDecodeError):
            return ""

    pending = [(index, item) for index, item in enumerate(items, 1) if prior_status(item) != "approved"]
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(module.process, index, item): (index, item) for index, item in pending}
        for future in concurrent.futures.as_completed(futures):
            index, item = futures[future]
            row = future.result()
            results.append(row)
            print(json.dumps({"index": index, "total": len(items), "company": item.get("company"), "productName": item.get("productName"), "status": row.get("status"), "attempts": row.get("attempts"), "responsibilityCount": row.get("responsibilityCount"), "error": str(row.get("error", ""))[-500:]}, ensure_ascii=False), flush=True)
    counts = {}
    for row in results:
        counts[row.get("status", "unknown")] = counts.get(row.get("status", "unknown"), 0) + 1
    all_results = []
    for item in items:
        url_id = hashlib.sha256(item["sourceUrl"].encode("utf-8")).hexdigest()[:12]
        product_dir = OUTPUT / "products" / f"{module.safe_name(item.get('company'))}-{module.safe_name(item.get('productName'))}-{url_id}"
        try:
            all_results.append(json.loads((product_dir / "result.json").read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            pass
    all_counts = {}
    for row in all_results:
        all_counts[row.get("status", "unknown")] = all_counts.get(row.get("status", "unknown"), 0) + 1
    module.write_json(OUTPUT / "summary.json", {"status": "completed", "scope": "rolling-wave-next-20260727/window-4/luna-shard-2", "inputManifest": str(INPUT), "outputDir": str(OUTPUT), "selected": len(items), "counts": all_counts, "provider": module.PROVIDER, "modelId": module.MODEL, "parseOnly": True, "databaseWrites": False, "feishuWrites": False, "publication": False, "extractor": "pypdf-ordinary-text-fallback", "pendingProcessed": len(pending), "products": sorted([{"company": row.get("company"), "productName": row.get("productName"), "status": row.get("status"), "sourceDigest": row.get("sourceDigest"), "resultPath": row.get("resultPath")} for row in all_results], key=lambda value: (value["company"] or "", value["productName"] or ""))})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
