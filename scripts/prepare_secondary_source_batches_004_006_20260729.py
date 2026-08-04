import json
from pathlib import Path

root = Path('/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/missing-approved-artifact-source-repair-20260729')
rows = [json.loads(x) for x in (root / 'dedupe-remaining.jsonl').read_text().splitlines() if x.strip()]
for batch_no in range(4, 7):
    start = (batch_no - 1) * 100
    chunk = rows[start:start + 100]
    (root / f'batch-{batch_no:03d}-input.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in chunk), encoding='utf-8')
    print(batch_no, start + 1, start + len(chunk), len(chunk))
