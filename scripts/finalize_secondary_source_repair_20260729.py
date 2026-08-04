import hashlib, json
from pathlib import Path

root = Path('/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/missing-approved-artifact-source-repair-20260729')
dedupe = json.loads((root / 'dedupe-audit.json').read_text())
all_ready, all_blocked, batch_rows = [], [], []
for n in ['001', '002', '003']:
    d = json.loads((root / f'batch-{n}/canary-summary.json').read_text())
    ready = [json.loads(x) for x in (root / f'batch-{n}/source-ready-return-first-parse.jsonl').read_text().splitlines() if x.strip()]
    blocked = [json.loads(x) for x in (root / f'batch-{n}/source-blocked.jsonl').read_text().splitlines() if x.strip()]
    all_ready.extend(ready); all_blocked.extend(blocked)
    batch_rows.append({'batch': n, 'selected': d['selected'], 'statusCounts': d['statusCounts'], 'ready': len(ready), 'blocked': len(blocked)})
(root / 'FIRST_PARSE-return-queue.jsonl').write_text(''.join(json.dumps({**r, 'queue': 'FIRST_PARSE', 'origin': 'secondary_source_repair_20260729'}, ensure_ascii=False) + '\n' for r in all_ready), encoding='utf-8')
(root / 'SOURCE-blocked-return-queue.jsonl').write_text(''.join(json.dumps({**r, 'queue': 'SOURCE', 'origin': 'secondary_source_repair_20260729'}, ensure_ascii=False) + '\n' for r in all_blocked), encoding='utf-8')
audit = {
    'schema': 'secondary-source-repair-final-audit/v1',
    'inputRows': dedupe['inputRows'], 'historicalExcluded': dedupe['excluded'],
    'dedupedRemainingBeforeBatches': dedupe['remainingUnique'], 'batches': batch_rows,
    'selectedAcrossBatches': sum(x['selected'] for x in batch_rows), 'source_ready': len(all_ready),
    'source_blocked': len(all_blocked), 'ocr_needs_review': 0,
    'remainingUniqueAfterBatches': dedupe['remainingUnique'] - sum(x['selected'] for x in batch_rows),
    'returnCounts': {'FIRST_PARSE': len(all_ready), 'SOURCE': len(all_blocked), 'MODEL': 0, 'REVIEW': 0},
    'resumePoint': 'next unselected row after batch-003-input.jsonl; do not retry SOURCE-blocked at same ladder without changed route',
    'modelProviderCalled': False, 'sqliteWritten': False, 'feishuWritten': False, 'published': False,
}
(root / 'final-audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
files = {}
for p in sorted(root.rglob('*')):
    if p.is_file() and p.name != 'final-sha256.json':
        files[str(p.relative_to(root))] = 'sha256:' + hashlib.sha256(p.read_bytes()).hexdigest()
(root / 'final-sha256.json').write_text(json.dumps({'files': files}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(audit, ensure_ascii=False))
