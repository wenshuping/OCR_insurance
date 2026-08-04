#!/usr/bin/env python3
"""Run one immutable fresh-window shard through the existing Luna coordinator."""

import concurrent.futures
import hashlib
import importlib.util
import json
import os
import sys
import time
from pathlib import Path


TEMPLATE = Path(__file__).with_name("run_luna_window4_shard3_direct.py")


def load_template():
    spec = importlib.util.spec_from_file_location("fresh_luna_template", TEMPLATE)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {TEMPLATE}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_luna_fresh_window5.py SHARD_JSON OUTPUT_DIR")
    module = load_template()
    module.INPUT = Path(sys.argv[1]).resolve()
    module.OUTPUT = Path(sys.argv[2]).resolve()
    module.MAX_WORKERS = int(os.environ.get("LUNA_WORKERS", "4"))
    items = json.loads(module.INPUT.read_text(encoding="utf-8"))
    if not isinstance(items, list) or any(item.get("route") != "luna_review" for item in items):
        raise SystemExit("shard must be a JSON list of luna_review products")
    module.OUTPUT.mkdir(parents=True, exist_ok=True)
    module.write_json(module.OUTPUT / "manifest.json", {
        "input": str(module.INPUT),
        "selected": items,
        **module.model_meta(),
        "scope": "health-critical-fresh-window-5-20260727",
    })
    for filename in ("approved.jsonl", "validation-review.jsonl", "model-retry.jsonl", "source-retry.jsonl"):
        (module.OUTPUT / filename).touch()
    # A prior coordinator may have left a raw model response without a final
    # result when it was stopped at a shard boundary. Preserve it as a model
    # retry receipt; never submit the same started product twice in this run.
    pending = []
    resumed = []
    for item in items:
        product_key = hashlib.sha256(item["sourceUrl"].encode("utf-8")).hexdigest()[:12]
        product_dir = module.OUTPUT / "products" / f"{module.safe_name(item.get('company'))}-{module.safe_name(item.get('productName'))}-{product_key}"
        result_path = product_dir / "result.json"
        if result_path.exists():
            try:
                value = json.loads(result_path.read_text(encoding="utf-8"))
                if value.get("status") in {"approved", "validation-review", "model-retry", "source-retry"}:
                    resumed.append(value)
                    continue
            except Exception:
                pass
        if any(product_dir.glob("round-*-model-response.txt")) or any(product_dir.glob("codex-round-*.log")):
            recovered = module.finalize_saved_response(item, product_dir)
            if recovered is not None:
                module.append_jsonl(module.OUTPUT / f"{recovered['status']}.jsonl", recovered)
                resumed.append(recovered)
                continue
            row = {
                **module.model_meta(),
                "status": "model-retry",
                "company": item.get("company"),
                "productName": item.get("productName"),
                "sourceUrl": item.get("sourceUrl"),
                "productDir": str(product_dir),
                "resultPath": str(result_path),
                "error": "coordinator_interrupted_or_started_without_final_result; preserved raw output",
            }
            module.write_json(result_path, row)
            module.append_jsonl(module.OUTPUT / "model-retry.jsonl", row)
            resumed.append(row)
            continue
        pending.append(item)
    started = time.time()
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=module.MAX_WORKERS) as pool:
        futures = {pool.submit(module.process, index, item): (index, item) for index, item in enumerate(pending, 1)}
        for future in concurrent.futures.as_completed(futures):
            index, item = futures[future]
            result = future.result()
            results.append(result)
            print(json.dumps({
                "index": index,
                "total": len(items),
                "company": item.get("company"),
                "productName": item.get("productName"),
                "status": result.get("status"),
                "error": str(result.get("error", ""))[-500:],
            }, ensure_ascii=False), flush=True)
    results.extend(resumed)
    counts = {}
    for result in results:
        counts[result.get("status", "unknown")] = counts.get(result.get("status", "unknown"), 0) + 1
    summary = {
        "status": "completed",
        "scope": "health-critical-fresh-window-5-20260727",
        "inputManifest": str(module.INPUT),
        "outputDir": str(module.OUTPUT),
        "selected": len(items),
        "counts": counts,
        **module.model_meta(),
        "elapsedSeconds": round(time.time() - started, 2),
        "products": sorted([
            {key: result.get(key) for key in ("company", "productName", "status", "sourceDigest", "resultPath")}
            for result in results
        ], key=lambda value: (value["company"] or "", value["productName"] or "")),
    }
    module.write_json(module.OUTPUT / "summary.json", summary)
    print("SUMMARY " + json.dumps(summary, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
