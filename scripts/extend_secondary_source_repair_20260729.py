import json
from pathlib import Path

root = Path('/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/missing-approved-artifact-source-repair-20260729')
audit_path = root / 'final-audit.json'
audit = json.loads(audit_path.read_text())
new_ready, new_blocked = [], []
for n in ['004', '005', '006']:
    summary = json.loads((root / f'batch-{n}/canary-summary.json').read_text())
    ready = [json.loads(x) for x in (root / f'batch-{n}/source-ready-return-first-parse.jsonl').read_text().splitlines() if x.strip()]
    blocked = [json.loads(x) for x in (root / f'batch-{n}/source-blocked.jsonl').read_text().splitlines() if x.strip()]
    new_ready.extend(ready)
    new_blocked.extend(blocked)
    audit['batches'].append({'batch': n, 'selected': summary['selected'], 'statusCounts': summary['statusCounts'], 'ready': len(ready), 'blocked': len(blocked)})
with (root / 'FIRST_PARSE-return-queue.jsonl').open('a') as f:
    f.write(''.join(json.dumps({**r, 'queue': 'FIRST_PARSE', 'origin': 'secondary_source_repair_20260729'}, ensure_ascii=False) + '\n' for r in new_ready))
with (root / 'SOURCE-blocked-return-queue.jsonl').open('a') as f:
    f.write(''.join(json.dumps({**r, 'queue': 'SOURCE', 'origin': 'secondary_source_repair_20260729'}, ensure_ascii=False) + '\n' for r in new_blocked))
audit['selectedAcrossBatches'] = sum(x['selected'] for x in audit['batches'])
audit['source_ready'] = sum(x['ready'] for x in audit['batches'])
audit['source_blocked'] = sum(x['blocked'] for x in audit['batches'])
audit['remainingUniqueAfterBatches'] = audit['dedupedRemainingBeforeBatches'] - audit['selectedAcrossBatches']
audit['returnCounts'] = {'FIRST_PARSE': audit['source_ready'], 'SOURCE': audit['source_blocked'], 'MODEL': 0, 'REVIEW': 0}
audit['resumePoint'] = 'next unselected row after batch-006-input.jsonl; do not retry SOURCE-blocked at same ladder without changed route'
audit.pop('providerRouting', None)
audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'selected': audit['selectedAcrossBatches'], 'ready': audit['source_ready'], 'blocked': audit['source_blocked'], 'remaining': audit['remainingUniqueAfterBatches']}, ensure_ascii=False))
