#!/usr/bin/env python3
import hashlib, json, re
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path('/Volumes/OCR_ARCHIVE/OCR_insurance')
INPUT = ROOT / '.worktrees/dev-agent-semantic-integration/artifacts/responsibility-alignment-20260729/missing-artifact-secondary-classification/source_not_ready_needs_source_acquisition.jsonl'
OUT = ROOT / 'artifacts/missing-approved-artifact-source-repair-20260729'
SCAN = [ROOT / 'artifacts/global-source-retry-ledger-20260728', ROOT / 'artifacts/source-repair-backlog-204-20260728', ROOT / 'artifacts/source-cache', ROOT / 'artifacts/missing-approved-artifact-source-repair-20260729/canary-001']

def n(v): return re.sub(r'[^0-9a-z\u4e00-\u9fff]+', '', str(v or '').lower())
def u(v):
    try:
        x=urlparse(str(v or '').strip())
        return x._replace(netloc=x.netloc.lower(), fragment='').geturl() if x.scheme in ('http','https') else ''
    except Exception: return ''
def d(v):
    s=str(v or '').lower().strip(); return s if s.startswith('sha256:') else ('sha256:'+s if re.fullmatch(r'[0-9a-f]{64}',s) else '')
def key(r):
    x=u(r.get('sourceUrl') or r.get('source_url') or ((r.get('sourceUrls') or [''])[0]))
    if x: return 'url:'+x
    x=d(r.get('sourceDigest') or r.get('source_digest'))
    if x: return 'digest:'+x
    return 'name:'+n(r.get('company'))+'::'+n(r.get('productName')) if r.get('company') and r.get('productName') else ''
def records(path):
    try:
        if path.suffix=='.jsonl': return [json.loads(x) for x in path.read_text(encoding='utf-8',errors='ignore').splitlines() if x.strip()]
        x=json.loads(path.read_text(encoding='utf-8',errors='ignore')); return x if isinstance(x,list) else [x]
    except Exception: return []

rows=records(INPUT); seen={}; evidence={}
for root in SCAN:
    for p in root.rglob('*'):
        if p.is_file() and p.suffix in ('.json','.jsonl') and p.stat().st_size < 20_000_000:
            for r in records(p):
                if not isinstance(r,dict): continue
                for candidate in (r, r.get('source') if isinstance(r.get('source'),dict) else {}):
                    k=key(candidate)
                    if k: seen.setdefault(k, str(p))
selected=[]; excluded=[]
for r in rows:
    k=key(r)
    if k in seen:
        excluded.append({'company':r['company'],'productName':r['productName'],'sourceUrl':(r.get('sourceUrls') or [''])[0],'dedupeKey':k,'reason':'historical_global_ledger_cache_or_queue','evidencePath':seen[k]})
    else:
        selected.append(r)
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'dedupe-remaining.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in selected),encoding='utf-8')
(OUT/'dedupe-exclusions.jsonl').write_text(''.join(json.dumps(r,ensure_ascii=False)+'\n' for r in excluded),encoding='utf-8')
audit={'schema':'secondary-source-global-dedupe/v1','inputRows':len(rows),'historicalKeys':len(seen),'excluded':len(excluded),'remainingUnique':len(selected),'precedence':'sourceDigest > sourceUrl > company+productName','scannedRoots':[str(x) for x in SCAN],'modelProviderCalled':False,'sqliteWritten':False,'feishuWritten':False,'published':False}
(OUT/'dedupe-audit.json').write_text(json.dumps(audit,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for batch in range(3):
    chunk = selected[batch * 100:(batch + 1) * 100]
    (OUT / f'batch-{batch + 1:03d}-input.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in chunk), encoding='utf-8')
print(json.dumps(audit,ensure_ascii=False))
