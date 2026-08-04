import hashlib, json, re
from pathlib import Path

ROOT = Path('/Volumes/OCR_ARCHIVE/OCR_insurance/artifacts/missing-approved-artifact-source-repair-20260729')
INPUT = ROOT / 'FIRST_PARSE-return-queue.jsonl'

COMPLEX = ('重疾', '重大疾病', '医疗', '住院', '门诊', '意外', '疾病', '护理', '防癌', '津贴', '手术', '多次', '附加', '可选', '万能', '分红', '两全')
SIMPLE = ('终身寿险', '定期寿险', '年金保险', '年金')

def classify(row):
    name = str(row.get('productName') or '')
    text_path = Path(row.get('extractedTextFile') or '')
    source_text = text_path.read_text(encoding='utf-8', errors='replace') if text_path.is_file() else ''
    complex_hits = sorted({x for x in COMPLEX if x in name})
    optional_count = len(re.findall(r'可选|附加责任|选择责任|可调整', source_text))
    formula_count = len(re.findall(r'赔付比例|给付比例|计算公式|\b(?:max|min|MAX|MIN)\b|×|乘以|按比例|比例赔付|公式如下', source_text, re.I))
    responsibility_count = len(re.findall(r'保险责任|给付责任|赔偿责任|责任一|责任二|责任三', source_text))
    simple_type = any(x in name for x in SIMPLE)
    if not simple_type or complex_hits or optional_count >= 2 or formula_count >= 10 or responsibility_count >= 16:
        provider, route = 'luna-complex', '产品类型或官方责任文本显示为复杂；SOURCE-only 路由保守进入 Luna'
    else:
        provider, route = 'deepseek-standard', '简单寿险/普通年金，未发现复杂责任、可选责任或高公式密度'
    return {**row, 'recommendedProvider': provider, 'routeReason': route, 'routeEvidence': {'productTypeSimple': simple_type, 'complexProductTerms': complex_hits, 'optionalResponsibilityMentions': optional_count, 'formulaSignalCount': formula_count, 'responsibilitySignalCount': responsibility_count}, 'queue': 'FIRST_PARSE'}

rows = [classify(json.loads(x)) for x in INPUT.read_text(encoding='utf-8').splitlines() if x.strip()]
deep = [r for r in rows if r['recommendedProvider'] == 'deepseek-standard']
luna = [r for r in rows if r['recommendedProvider'] == 'luna-complex']
(ROOT / 'FIRST_PARSE-return-queue-routed.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows), encoding='utf-8')
(ROOT / 'deepseek-standard-return-queue.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in deep), encoding='utf-8')
(ROOT / 'luna-complex-return-queue.jsonl').write_text(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in luna), encoding='utf-8')
audit_path = ROOT / 'final-audit.json'
audit = json.loads(audit_path.read_text(encoding='utf-8'))
audit['providerRouting'] = {'sourceReadyUnion': len(rows), 'deepseekStandard': len(deep), 'lunaComplex': len(luna), 'union': len(set(r.get('sourceDigest') for r in deep + luna)), 'intersection': 0, 'gemini': 0, 'countsByRecommendedProvider': {'deepseek-standard': len(deep), 'luna-complex': len(luna)}, 'rule': 'simple life/ordinary annuity with low complexity -> DeepSeek; critical/medical/accident/multi-branch/optional/formula-complex or uncertain -> Luna'}
audit_path.write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
files = {}
for p in sorted(ROOT.rglob('*')):
    if p.is_file() and p.name != 'final-sha256.json':
        files[str(p.relative_to(ROOT))] = 'sha256:' + hashlib.sha256(p.read_bytes()).hexdigest()
(ROOT / 'final-sha256.json').write_text(json.dumps({'files': files}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(audit['providerRouting'], ensure_ascii=False))
