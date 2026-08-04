#!/usr/bin/env python3
"""Build source-backed, single-responsibility artifact JSONL from read-only SSD rows."""
import hashlib
import io
import json
import re
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parents[1]
LEDGER = ROOT / "artifacts/disease-full-disability-dedup-20260731/ledger-final.json"
RECEIPTS = ROOT / "artifacts/disease-full-disability-dedup-20260731/source-acquisition-final/acquisition-receipts.json"
DB = Path("/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite")
OUT = ROOT / "artifacts/disease-full-disability-dedup-20260731/source-acquisition-final"
ARTIFACT = OUT / "source-ready-responsibility-artifacts.jsonl"

def txt(x): return str(x or "").strip()
def uniq(values):
    out=[]; seen=set()
    for x in values:
        k=json.dumps(x, ensure_ascii=False, sort_keys=True)
        if k not in seen: seen.add(k); out.append(x)
    return out
def excerpt(pdf, title):
    text="\n".join((p.extract_text() or "") for p in PdfReader(io.BytesIO(pdf), strict=False).pages)
    compact=re.sub(r"\s+", "", text)
    needle=re.sub(r"\s+", "", title)
    pos=compact.find(needle)
    if pos < 0: return ""
    # Keep the extracted source text as a contiguous, human-auditable excerpt.
    return text[max(0, min(len(text), pos)):max(0, min(len(text), pos))+1600].strip()

def main():
    ledger=json.loads(LEDGER.read_text())
    receipts={x["productKey"]:x for x in json.loads(RECEIPTS.read_text())["receipts"] if x.get("status")=="source_ready"}
    conn=sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.execute("PRAGMA query_only=ON")
    lines=[]; contracts=[]
    for p in ledger["products"]:
        r=receipts.get(p["productKey"])
        if not r: continue
        rows=[json.loads(row[0]) for row in conn.execute("SELECT payload FROM insurance_indicator_records WHERE company=? AND product_name=?", (p["company"],p["productName"]))]
        agg=next((x for x in rows if x.get("id")==((p.get("aggregateIndicators") or [{}])[0].get("id"))), None)
        disease=next((x for x in rows if x.get("id")==((p.get("diseaseBranchIndicators") or [{}])[0].get("id"))), None)
        if not agg or not disease:
            continue
        pdf=(ROOT / r["sourceFile"]).read_bytes()
        heading=((p.get("aggregateIndicators") or [{}])[0].get("aggregateTitle") or agg.get("liability") or "身故或全残保险金")
        source_excerpt=excerpt(pdf, heading)
        if not source_excerpt: continue
        branch={"branchType":"trigger_condition","title":"疾病全残","condition":"疾病导致本合同约定的全残","sourceExcerpt":disease.get("sourceExcerpt", ""),"sourceUrl":r["finalUrl"],"sourceDigest":r["sourceDigest"],"responsibilityId":disease.get("responsibilityId") or disease.get("id"),"operands":disease.get("operands") or [],"evidenceTokens":disease.get("evidenceTokens") or []}
        canonical=dict(agg)
        canonical.update({"liability":heading,"sourceUrl":r["finalUrl"],"sourceDigest":r["sourceDigest"],"sourceExcerpt":source_excerpt,"responsibilityId":agg.get("responsibilityId") or agg.get("id"),"normalizedFormula":agg.get("normalizedFormula") or "","requiredInputs":agg.get("requiredInputs") if isinstance(agg.get("requiredInputs"),list) else ((agg.get("indicatorDefinition") or {}).get("requiredInputs") or (agg.get("basisDefinition") or {}).get("requiredInputs") or []),"branches":uniq((agg.get("branches") or [])+[branch]),"operands":uniq((agg.get("operands") or [])+(disease.get("operands") or [])),"evidenceTokens":uniq((agg.get("evidenceTokens") or [])+(disease.get("evidenceTokens") or [])),"sourceProvenance":{"sourceType":"official_insurer_pdf","officialDomain":r["finalHost"],"sourceUrl":r["finalUrl"],"sourceDigest":r["sourceDigest"],"sourceFile":r["sourceFile"],"pageCount":r["inspection"].get("pageCount"),"aggregateHeading":heading,"responsibilityEvidence":"exact extracted responsibility-body excerpt"}})
        product={"company":p["company"],"productName":p["productName"],"sourceRecords":[{"sourceUrl":r["finalUrl"],"sourceDigest":r["sourceDigest"],"sourceTitle":heading}],"acceptedResponsibilities":[canonical],"blockers":[]}
        lines.append(json.dumps(product, ensure_ascii=False))
        contracts.append({"company":p["company"],"productName":p["productName"],"sourceUrl":r["finalUrl"],"officialDomain":r["finalHost"],"sourceStatus":"source_ready","sourceFile":r["sourceFile"],"sourceDigest":r["sourceDigest"],"pdf":{"pageCount":r["inspection"].get("pageCount"),"encrypted":r["inspection"].get("encrypted"),"byteLength":r["inspection"].get("byteLength")},"responsibilityPages":"pypdf extracted body; page-level locator pending dedicated parser","responsibilityHeading":heading,"responsibilityExcerpt":source_excerpt})
    conn.close()
    ARTIFACT.write_text("\n".join(lines)+"\n")
    (OUT/"source-contracts.json").write_text(json.dumps(contracts,ensure_ascii=False,indent=2)+"\n")
    print(json.dumps({"sourceReadyArtifacts":len(lines),"artifact":str(ARTIFACT),"artifactSha256":hashlib.sha256(ARTIFACT.read_bytes()).hexdigest(),"contracts":len(contracts),"contractSha256":hashlib.sha256((OUT/"source-contracts.json").read_bytes()).hexdigest()} ,ensure_ascii=False))
if __name__=="__main__": main()
