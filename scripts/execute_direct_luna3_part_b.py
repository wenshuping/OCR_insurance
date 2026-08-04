#!/usr/bin/env python3
"""Execute the ten direct-Codex Luna products from luna-3.jsonl lines 11-20."""
from __future__ import annotations

import concurrent.futures
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path('/Volumes/OCR_ARCHIVE/OCR_insurance')
MANIFEST = ROOT / 'artifacts/responsibility-full-backfill-20260731-v2/model-canary-wave-20260801-001-v2/luna-3.jsonl'
OUTPUT = ROOT / 'artifacts/responsibility-full-backfill-20260731-v2/model-canary-wave-20260801-001-v2/execution/luna-3-part-b'
PIPELINE = ROOT / '.worktrees/dev-agent-semantic-integration/.agents/skills/ocr-insurance-product-responsibility-pipeline'
CANONICALIZER = PIPELINE / 'scripts/canonicalize_excerpts.py'
VALIDATOR = PIPELINE / 'scripts/validate_artifact.py'
IMPORTER = ROOT / 'scripts/import-reviewed-responsibility-artifacts.mjs'
MODEL = 'gpt-5.6-luna'
PROVIDER = 'codex'

def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

def safe_name(value: str) -> str:
    value = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '-', str(value or ''))
    return re.sub(r'\s+', '-', value).strip('.-')[:120] or 'product'

def meta() -> dict:
    return {'provider': PROVIDER, 'modelId': MODEL, 'executionMode': 'direct_codex_thread',
            'parseOnly': True, 'modelCallsAllowed': True, 'databaseWrites': False,
            'sqliteWritten': False, 'feishuWrites': False, 'publication': False,
            'repairRounds': 0}

def product_dir(item: dict) -> Path:
    return OUTPUT / 'products' / f"{safe_name(item['company'])}-{safe_name(item['productName'])}-{item['manifestOrder']}"

def sha256(path: Path) -> str:
    return 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()

def prompt(item: dict, source_digest: str) -> str:
    packets = '\n'.join(item.get('evidencePackets') or [])
    return f'''You are GPT-5.6 Luna acting as the complex insurance extractor for exactly one product. This is one authorized model call, parse-only, direct_codex_thread. Read local files only. Do not call any provider or endpoint, do not use another product, and do not write files. Return exactly one complete valid JSON object, with no Markdown.

Read the official source text at {item['extractedTextFile']} and the locked evidence packets below. The manifest's executionPolicy(modelCallsAllowed=true, parseOnly=true) authorizes this parse; historical sourceOnly/modelCallsAllowed metadata is not a restriction and must not be rewritten. Source digest: {source_digest}. Company: {item['company']}; product: {item['productName']}.

Locked evidence packets:
{packets}

Extract every inventory responsibility exactly once, preserving official responsibilityId/title and section boundaries. For each responsibility, produce real triggerCondition, insurerObligation, importantLimits, ruleRefs, sourcePage, exact contiguous sourceExcerpt, evidenceSegments with absoluteStart/absoluteEnd/exactText, customer-facing card wording, and one-to-one indicators. Each indicator must preserve formulaText/normalizedFormula when provable, basisKey/calculationKey/calculationStatus/calculationEligible/calculationReason, canonical requiredInputs only from the approved dictionary, basisDefinition, all branches/operands/table cells, evidenceTokens and evidenceSegments. Use manual_formula plus manualFormulaInputs only where the official expression is not safely computable, while still recording the actual formula and required input details; never use a placeholder or semantic_fields_pending. Preserve every numeric token, percentage, boundary, max/min operand, waiting period, deduction, mutual exclusion and table branch. Omit unknown values. Customer wording must not contain internal audit vocabulary. Set publication.sqlite=development_required_after_approval and publication.feishu=not_requested.

Return the modern unified artifact object with company/displayCompany/productName/productIdentity/productOverview/productServices/productRules/currentPolicyInputs/optionalGroups/officialOptionalGroupChecklist/officialChecklist/responsibilities/audit/publication. The responsibility count and IDs must equal the locked inventory.''' 

def model_call(item: dict, out: Path, source_digest: str) -> dict:
    raw = out / 'model-response.txt'
    log = out / 'model-call.log'
    command = ['codex', 'exec', '--model', MODEL, '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '-C', str(ROOT), '-o', str(raw), '-']
    with log.open('w', encoding='utf-8') as handle:
        run = subprocess.run(command, input=prompt(item, source_digest), text=True, stdout=handle, stderr=subprocess.STDOUT, timeout=3600)
    if run.returncode != 0:
        raise RuntimeError(f'codex exited {run.returncode}')
    text = raw.read_text(encoding='utf-8'); start = text.find('{')
    if start < 0: raise ValueError('model response has no JSON object')
    value, _ = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(value, dict): raise ValueError('model response root is not an object')
    return value

def run_gates(item: dict, out: Path, source_digest: str) -> tuple[str, str]:
    raw = out / 'raw-artifact.json'; canonical = out / 'canonical-artifact.json'
    ccmd = [sys.executable, str(CANONICALIZER), '--artifact', str(raw), '--source-text', item['extractedTextFile'], '--output', str(canonical)]
    can = subprocess.run(ccmd, capture_output=True, text=True); write_json(out / 'canonicalizer-receipt.json', {**meta(), 'stage':'canonicalizer', 'sourceDigest':source_digest, 'command':ccmd, 'exitCode':can.returncode, 'stdout':can.stdout, 'stderr':can.stderr, 'status':'passed' if can.returncode == 0 else 'failed'})
    if can.returncode != 0: return 'validation-review', can.stderr or can.stdout
    (out / 'artifact.json').write_text(canonical.read_text(encoding='utf-8'), encoding='utf-8')
    vcmd = [sys.executable, str(VALIDATOR), '--artifact', str(out / 'artifact.json'), '--source-document', item['sourceFile'], '--source-text', item['extractedTextFile'], '--official-domain', urlparse(item['sourceUrl']).hostname or '']
    val = subprocess.run(vcmd, capture_output=True, text=True); vok = val.returncode == 0 and '"status": "approved"' in val.stdout
    write_json(out / 'validator-receipt.json', {**meta(), 'stage':'validator', 'sourceDigest':source_digest, 'command':vcmd, 'exitCode':val.returncode, 'stdout':val.stdout, 'stderr':val.stderr, 'status':'approved' if vok else 'validation-review'})
    if not vok: return 'validation-review', val.stderr or val.stdout
    icmd = ['node', str(IMPORTER), f'--artifacts={out / "artifact.json"}', '--sample-limit=10']
    imp = subprocess.run(icmd, cwd=ROOT, capture_output=True, text=True)
    try: parsed = json.loads(imp.stdout); iok = parsed.get('ok') is True and parsed.get('validationIssueCount', 0) == 0
    except json.JSONDecodeError: parsed = {}; iok = False
    write_json(out / 'importer-dry-run-receipt.json', {**meta(), 'stage':'dedicated-importer-dry-run', 'sourceDigest':source_digest, 'command':icmd, 'exitCode':imp.returncode, 'stdout':imp.stdout, 'stderr':imp.stderr, 'parsed':parsed, 'status':'passed' if iok else 'failed'})
    return ('approved', '') if iok else ('validation-review', imp.stderr or imp.stdout)

def run_one(index: int, item: dict) -> dict:
    out = product_dir(item); out.mkdir(parents=True, exist_ok=True); base = {**meta(), 'line': index + 1, 'manifestOrder':item['manifestOrder'], 'company':item['company'], 'productName':item['productName'], 'sourceUrl':item['sourceUrl'], 'productDir':str(out)}
    try:
        actual = sha256(Path(item['sourceFile']))
        if actual != item['sourceDigest']: raise ValueError(f'source digest mismatch: expected {item["sourceDigest"]}, actual {actual}')
        write_json(out / 'source-digest.json', {**base, 'sourceDigest':actual, 'verified':True})
        artifact = model_call(item, out, actual); write_json(out / 'raw-artifact.json', artifact)
        status, error = run_gates(item, out, actual)
        result = {**base, 'sourceDigest':actual, 'status':status, 'artifactPath':str(out / 'artifact.json'), 'resultPath':str(out / 'result.json'), 'responsibilityCount':len(artifact.get('responsibilities') or []), 'error':error}
    except Exception as exc:
        status = 'model-retry' if (out / 'source-digest.json').exists() else 'source-retry'; result = {**base, 'status':status, 'error':str(exc)}
        write_json(out / 'validator-receipt.json', {**meta(), 'status':'not_run', 'failureLayer':status, 'error':str(exc)})
        write_json(out / 'importer-dry-run-receipt.json', {**meta(), 'status':'not_run', 'reason':status})
    write_json(out / 'provider-receipt.json', {**base, 'sourceDigest':result.get('sourceDigest'), 'callCount':1, 'status':'completed' if status != 'source-retry' else 'not_started'})
    write_json(out / 'result.json', result); write_json(out / 'terminal.json', {**result, 'terminal':status, 'validatorOk':status == 'approved', 'importerDryRunOk':status == 'approved', 'materialized':0})
    return result

def main() -> int:
    rows = [json.loads(line) for line in MANIFEST.read_text(encoding='utf-8').splitlines() if line.strip()]
    rows = rows[10:20]
    if len(rows) != 10: raise RuntimeError(f'expected 10 rows, got {len(rows)}')
    if OUTPUT.exists(): raise RuntimeError(f'output must be new: {OUTPUT}')
    started = time.time(); OUTPUT.mkdir(parents=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: results = list(pool.map(lambda p: run_one(*p), enumerate(rows, start=10)))
    results.sort(key=lambda r: r['line']); (OUTPUT / 'terminal.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in results), encoding='utf-8')
    counts = {s: sum(r['status'] == s for r in results) for s in ('approved','validation-review','model-retry','source-retry')}
    summary = {**meta(), 'status':'completed', 'manifest':str(MANIFEST), 'selected':10, 'processed':len(results), 'counts':counts, 'elapsedSeconds':round(time.time()-started,2), 'sqliteWrites':0, 'feishuWrites':0, 'published':0}
    write_json(OUTPUT / 'summary.json', summary)
    sums = []
    for f in sorted(p for p in OUTPUT.rglob('*') if p.is_file() and p.name != 'SHA256SUMS'):
        sums.append(f'{sha256(f)}  {f.relative_to(OUTPUT)}')
    (OUTPUT / 'SHA256SUMS').write_text('\n'.join(sums) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False)); return 0

if __name__ == '__main__': raise SystemExit(main())
