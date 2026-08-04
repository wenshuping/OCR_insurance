#!/usr/bin/env python3
"""Parse-only Luna recovery using previously locked official source files."""
import concurrent.futures
import hashlib
import importlib.util
import json
import os
import shutil
import sys
import time
from pathlib import Path

TEMPLATE = Path(__file__).with_name("run_luna_window4_shard3_direct.py")

def load_template():
    spec = importlib.util.spec_from_file_location("auth_recovery_template", TEMPLATE)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load Luna template")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def main():
    if len(sys.argv) != 3:
        raise SystemExit("usage: run_luna_auth_recovery.py SHARD_JSON OUTPUT_DIR")
    mod = load_template()
    mod.INPUT = Path(sys.argv[1]).resolve()
    mod.OUTPUT = Path(sys.argv[2]).resolve()
    mod.MAX_WORKERS = int(os.environ.get("LUNA_WORKERS", "1"))
    items = json.loads(mod.INPUT.read_text(encoding="utf-8"))
    if not isinstance(items, list) or any(x.get("route") not in (None, "luna_review") for x in items):
        raise SystemExit("recovery shard must be a JSON list")
    mod.OUTPUT.mkdir(parents=True, exist_ok=True)
    locked = {x.get("sourceUrl"): Path(x["lockedProductDir"]) for x in items}

    def discover(item):
        return item.get("sourceUrl"), {"discoveryUrl": "locked-source-reuse", "locked": True}

    def download(url, destination):
        src = locked[url] / "official-source.pdf"
        shutil.copy2(src, destination)
        digest = json.loads((locked[url] / "sourceDigest.json").read_text(encoding="utf-8"))["sourceDigest"]
        return digest, {"locked": True, "sourcePath": str(src), "network": False}

    def extract(pdf, pages, report):
        src = locked[next(k for k,v in locked.items() if v / "official-source.pdf" == pdf)] if False else None
        # The locked pages/report are selected by matching the copied PDF hash.
        pdf_hash = hashlib.sha256(pdf.read_bytes()).hexdigest()
        for base in locked.values():
            if hashlib.sha256((base / "official-source.pdf").read_bytes()).hexdigest() == pdf_hash:
                shutil.copy2(base / "official-source.pages.txt", pages)
                report_src = base / "official-source-layout-report.json"
                if report_src.exists(): shutil.copy2(report_src, report)
                else: report.write_text(json.dumps({"locked": True}), encoding="utf-8")
                return
        raise FileNotFoundError("locked PDF hash not found")

    mod.discover_soochow_url = discover
    mod.download_source = download
    mod.extract_source = extract
    for filename in ("approved.jsonl", "validation-review.jsonl", "model-retry.jsonl", "source-retry.jsonl"):
        (mod.OUTPUT / filename).touch(exist_ok=True)
    if not (mod.OUTPUT / "manifest.json").exists():
        mod.write_json(mod.OUTPUT / "manifest.json", {"scope": "resume-auth-recovered-20260728", "input": str(mod.INPUT), "selected": items, "sourceMode": "locked-reuse-no-network", **mod.model_meta()})
    pending=[]; resumed=[]
    for item in items:
        key=hashlib.sha256(item["sourceUrl"].encode()).hexdigest()[:12]
        pdir=mod.OUTPUT / "products" / f"{mod.safe_name(item.get('company'))}-{mod.safe_name(item.get('productName'))}-{key}"
        rp=pdir/"result.json"
        if rp.exists():
            try:
                val=json.loads(rp.read_text(encoding="utf-8"))
                if val.get("status") in {"approved","validation-review","model-retry","source-retry"}:
                    resumed.append(val); continue
            except Exception: pass
        pending.append(item)
    started=time.time(); results=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=mod.MAX_WORKERS) as pool:
        fs={pool.submit(mod.process,i,item):(i,item) for i,item in enumerate(pending,1)}
        for f in concurrent.futures.as_completed(fs):
            i,item=fs[f]; row=f.result(); results.append(row); print(json.dumps({"index":i,"total":len(items),"productName":item.get("productName"),"status":row.get("status")},ensure_ascii=False),flush=True)
    results.extend(resumed)
    counts={}
    for row in results: counts[row.get("status","unknown")]=counts.get(row.get("status","unknown"),0)+1
    summary={"status":"completed","scope":"resume-auth-recovered-20260728","selected":len(items),"counts":counts,"sourceMode":"locked-reuse-no-network","parseOnly":True,"databaseWrites":False,"feishuWrites":False,"publication":False,"elapsedSeconds":round(time.time()-started,2),"products":sorted([{"company":r.get("company"),"productName":r.get("productName"),"status":r.get("status"),"sourceDigest":r.get("sourceDigest"),"resultPath":r.get("resultPath")} for r in results],key=lambda x:(x["company"] or "",x["productName"] or ""))}
    mod.write_json(mod.OUTPUT/"summary.json",summary)
    print("SUMMARY "+json.dumps(summary,ensure_ascii=False),flush=True)

if __name__ == "__main__": main()
