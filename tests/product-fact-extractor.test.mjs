import assert from 'node:assert/strict';
import test from 'node:test';

import { extractProductFactCandidates } from '../server/product-fact-extractor.service.mjs';

function factChunk(content, factKeys) {
  return {
    id: 'chunk-1', chunkType: 'table', indexStatus: 'ready',
    canonicalProductId: 'product-1', productVersionId: 'version-1', content,
    payload: { semantic: { factKeys, responsibility: '一般医疗费用保险金' } },
  };
}

test('fact extractor keeps plan-scoped deductible values separate', () => {
  const facts = extractProductFactCandidates({
    chunks: [factChunk('年度免赔额 | 计划一 1万元 | 计划二 2万元', ['annual_deductible'])],
  });
  assert.deepEqual(facts.map((fact) => ({
    plan: fact.scope.plan,
    value: fact.normalizedValue.value,
    unit: fact.normalizedValue.unit,
    status: fact.status,
  })), [
    { plan: '计划一', value: 10_000, unit: 'CNY', status: 'candidate' },
    { plan: '计划二', value: 20_000, unit: 'CNY', status: 'candidate' },
  ]);
});

test('fact extractor normalizes waiting periods, ratios and benefit limits', () => {
  const facts = extractProductFactCandidates({
    chunks: [factChunk('等待期为60日，赔付比例为80%，年度限额200万元。', [
      'waiting_period', 'reimbursement_ratio', 'benefit_limit',
    ])],
  });
  assert.deepEqual(facts.map((fact) => [fact.fieldKey, fact.normalizedValue]), [
    ['waiting_period', { value: 60, unit: 'DAY' }],
    ['reimbursement_ratio', { value: 80, unit: 'PERCENT' }],
    ['benefit_limit', { value: 2_000_000, unit: 'CNY' }],
  ]);
});

test('fact extractor keeps plan comparison dimensions and responsibilities separate', () => {
  const content = [
    '保障项目 | 计划一 | 计划二 | 计划三',
    '年度免赔额 | 计划一 1万元 | 计划二 2万元 | 计划三 3万元',
    '小额医疗（可选责任）年度给付限额 | 计划一 0.5万元 | 计划二 1万元 | 计划三 1.5万元',
    '小额医疗对应年度免赔额后50%赔付 |  |  | ',
    '康护责任年度给付限额 | 计划一 10万元 | 计划二 5万元 | 计划三 2万元',
  ].join('\n');
  const facts = extractProductFactCandidates({
    chunks: [factChunk(content, ['annual_deductible', 'benefit_limit', 'reimbursement_ratio'])],
  });

  assert.equal(facts.length, 10);
  assert.deepEqual(facts.filter((fact) => fact.fieldKey === 'annual_deductible')
    .map((fact) => [fact.scope.plan, fact.normalizedValue.value]), [
    ['计划一', 10_000], ['计划二', 20_000], ['计划三', 30_000],
  ]);
  assert.deepEqual(facts.filter((fact) => fact.fieldKey === 'benefit_limit')
    .map((fact) => [fact.scope.responsibility, fact.scope.plan, fact.normalizedValue.value]), [
    ['小额医疗（可选责任）', '计划一', 5_000],
    ['小额医疗（可选责任）', '计划二', 10_000],
    ['小额医疗（可选责任）', '计划三', 15_000],
    ['康护责任', '计划一', 100_000],
    ['康护责任', '计划二', 50_000],
    ['康护责任', '计划三', 20_000],
  ]);
  assert.deepEqual(facts.find((fact) => fact.fieldKey === 'reimbursement_ratio')?.scope, {
    plan: '', responsibility: '小额医疗（可选责任）', period: '对应年度免赔额后',
  });
});
