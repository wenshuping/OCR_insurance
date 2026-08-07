import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('backfill detects a compound product and runs each selected Skill as an independent worker', () => {
  const script = String.raw`
import json
import sys
from pathlib import Path

root = Path.cwd()
script_dir = root / '.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts'
sys.path.insert(0, str(script_dir))
import batch_deepseek_backfill as batch

source = '''富德生命测试两全保险（万能型）条款
第四条 保险责任 若被保险人在合同期满日仍生存，按个人账户价值给付满期保险金。
第五条 个人账户 本合同最低保证利率为年利率2%，每月结算并按日复利。
趸交保险费和追加保险费的初始费用均为3%，保单管理费为每月0元，并按月收取风险保险费。
部分领取和退保手续费率在第一个保单年度为5%，第二个保单年度为4%。账户价值按已计入保险费和结算利息增加，按费用及领取金额减少。'''
product = {'company': '测试保险', 'productName': '测试两全保险（万能型）', 'domainSkills': []}
names = batch.resolve_domain_skill_names(product, source)
specs = batch.load_domain_skill_specs(root, names)

def fake_call(_api_key, _model, messages, **_kwargs):
    prompt = messages[-1]['content']
    if 'ocr-insurance-universal-account-responsibility' in prompt:
        facts = [
            {'kind': 'product_function', 'title': '最低保证利率与结算', 'sourceExcerpt': '第五条 个人账户 本合同最低保证利率为年利率2%，每月结算并按日复利。'},
        ]
    else:
        facts = [{'kind': 'responsibility', 'title': '满期保险金', 'sourceExcerpt': '第四条 保险责任 若被保险人在合同期满日仍生存，按个人账户价值给付满期保险金。'}]
    return {'content': json.dumps({'facts': facts}, ensure_ascii=False), 'finish_reason': 'stop'}

results = batch.run_domain_skill_workers(
    specs=specs,
    product=product,
    source_text=source,
    source_digest='sha256:' + ('a' * 64),
    api_key='test',
    provider='deepseek',
    base_url='',
    model='test',
    timeout=1,
    max_tokens=2048,
    call_model_fn=fake_call,
)
artifact = batch.merge_domain_worker_results({'productOverview': {'importantLimits': []}}, results)
version_checks = {
    'oldVersionRequiresReparse': not batch.published_source_is_current(
        {'sha256:source': {'v2'}}, 'sha256:source', 'v3'
    ),
    'currentVersionSkips': batch.published_source_is_current(
        {'sha256:source': {'v3'}}, 'sha256:source', 'v3'
    ),
}
print(json.dumps({
    'names': names,
    'results': results,
    'artifact': artifact,
    'versionChecks': version_checks,
    'allSourceBacked': all(
        fact['sourceExcerpt'] in source
        for worker in results
        for fact in worker['facts']
    ),
}, ensure_ascii=False))
`;
  const output = execFileSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  const result = JSON.parse(output);
  assert.deepEqual(result.names, [
    'ocr-insurance-universal-account-responsibility',
    'ocr-insurance-endowment-responsibility',
  ]);
  assert.deepEqual(result.results.map((worker) => worker.status), ['passed', 'passed']);
  assert.match(result.artifact.productFunctions.join('\n'), /年利率2%/u);
  assert.match(result.artifact.productFunctions.join('\n'), /初始费用均为3%/u);
  assert.match(result.artifact.productFunctions.join('\n'), /第一个保单年度为5%/u);
  assert.match(result.artifact.productFunctions.join('\n'), /风险保险费/u);
  assert.equal(result.allSourceBacked, true);
  assert.equal(result.artifact.domainAnalysis.length, 2);
  assert.deepEqual(result.versionChecks, {
    oldVersionRequiresReparse: true,
    currentVersionSkips: true,
  });
});

test('backfill accepts the configured production database without treating it as the development SSD', () => {
  const script = String.raw`
import json
import os
import sys
import tempfile
from pathlib import Path

root = Path.cwd()
script_dir = root / '.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts'
sys.path.insert(0, str(script_dir))
import batch_deepseek_backfill as batch

with tempfile.TemporaryDirectory() as directory:
    project_root = Path(directory) / 'project'
    production_db = Path(directory) / 'data' / 'policy-ocr.sqlite'
    project_root.mkdir(parents=True)
    production_db.parent.mkdir(parents=True)
    production_db.touch()
    os.environ['POLICY_OCR_PROFILE'] = 'prod'
    os.environ['POLICY_OCR_APP_DB_PATH'] = str(production_db)
    resolved = batch.resolve_database_path(str(production_db), project_root)
    print(json.dumps({'resolved': str(resolved), 'expected': str(production_db.resolve())}))
`;
  const output = execFileSync('python3', ['-c', script], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  const result = JSON.parse(output);
  assert.equal(result.resolved, result.expected);
});
