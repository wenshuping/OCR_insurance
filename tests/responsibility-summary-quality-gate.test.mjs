import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateResponsibilitySummaryQuality } from '../server/responsibility-summary-quality-gate.mjs';

function evaluate(overrides = {}) {
  return evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'critical_illness' },
    sourceSections: { mainResponsibilityText: '' },
    summary: {
      responsibilities: [{ title: '身故保险金', plainText: '按条款给付。' }],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
    ...overrides,
  });
}

function assertFailedWith(result, code, predicate = () => true) {
  assert.equal(result.status, 'failed');
  assert.ok(result.issues.some((issue) => issue.code === code && predicate(issue)), result.issues);
}

test('evaluateResponsibilitySummaryQuality passes complete critical illness summary', () => {
  const result = evaluate({
    routing: { productCategory: 'critical_illness' },
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金 少儿前10年关爱保险金 成人意外伤害特定疾病或身故关爱保险金 豁免保险费',
    },
    summary: {
      headline: '少儿重疾保障',
      responsibilities: [
        { title: '等待期', plainText: '90日' },
        { title: '轻度疾病保险金', plainText: '20%' },
        { title: '中度疾病保险金', plainText: '50%' },
        { title: '重度疾病保险金', plainText: '基本保额与已交保费较大者' },
        { title: '身故保险金', plainText: '18岁前后分情形' },
        { title: '少儿前10年关爱保险金', plainText: '额外给付基本保额' },
        { title: '成人意外伤害特定疾病或身故关爱保险金', plainText: '给付50%基本保额' },
        { title: '豁免保险费', plainText: '累计疾病金达到基本保额后豁免' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.issues, []);
});

test('evaluateResponsibilitySummaryQuality fails when critical illness care and waiver responsibilities are missing', () => {
  const result = evaluate({
    routing: { productCategory: 'critical_illness' },
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金 少儿前10年关爱保险金 豁免保险费',
    },
    summary: {
      responsibilities: [
        { title: '等待期', plainText: '90日' },
        { title: '轻度疾病保险金', plainText: '20%' },
        { title: '中度疾病保险金', plainText: '50%' },
        { title: '重度疾病保险金', plainText: '100%' },
        { title: '身故保险金', plainText: '身故赔付' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assertFailedWith(result, 'missing_required_keyword', (issue) => issue.keyword === '少儿前10年关爱保险金');
  assertFailedWith(result, 'missing_required_keyword', (issue) => issue.keyword === '豁免保险费');
});

test('evaluateResponsibilitySummaryQuality rejects product functions inside responsibilities', () => {
  const result = evaluate({
    routing: { productCategory: 'incremental_whole_life' },
    sourceSections: { mainResponsibilityText: '身故 全残 现金价值 保单贷款' },
    summary: {
      responsibilities: [
        { title: '保单贷款', plainText: '可以贷款' },
        { title: '身故或身体全残保险金', plainText: '按条款给付' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assertFailedWith(result, 'function_mixed_into_responsibilities', (issue) => issue.term === '保单贷款');
});

test('incremental whole life passes when annual compound growth formula is explained', () => {
  const result = evaluate({
    routing: { productCategory: 'incremental_whole_life' },
    sourceSections: {
      mainResponsibilityText: '身故 身体全残保险金 有效保险金额为基本保险金额×(1+3.5%)^(n-1)，给付系数按年龄确定。',
    },
    summary: {
      responsibilities: [
        {
          title: '身故或身体全残保险金',
          plainText: '有效保险金额按基本保险金额每年3.5%复利递增，作为身故或全残给付基准。',
          paymentRule: '结合年龄给付系数，按有效保险金额、已交保费和现金价值三者较大者给付。',
        },
      ],
      productFunctions: [],
      importantNotes: ['3.5%复利递增是保险责任给付基准递增，不代表现金价值增长或保证收益。'],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.issues, []);
});

test('incremental whole life fails when 3.5 percent compound growth explanation is missing', () => {
  const result = evaluate({
    routing: { productCategory: 'incremental_whole_life' },
    sourceSections: {
      mainResponsibilityText: '身故 身体全残保险金 有效保险金额为基本保险金额×(1+3.5%)^(n-1)。',
    },
    summary: {
      responsibilities: [
        { title: '身故或身体全残保险金', plainText: '按基本保险金额给付。' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assertFailedWith(result, 'compound_growth_rate_missing');
  assertFailedWith(result, 'compound_growth_not_explained');
});

test('incremental whole life scalar 1.035 formula requires 3.5 percent compound explanation', () => {
  const result = evaluate({
    routing: { productCategory: 'incremental_whole_life' },
    sourceSections: {
      mainResponsibilityText: '身故 身体全残保险金 有效保险金额为基本保险金额×1.035^(n-1)。',
    },
    summary: {
      responsibilities: [
        {
          title: '身故或身体全残保险金',
          plainText: '有效保险金额按基本保险金额每年3.5%复利递增，作为给付基准。',
        },
      ],
      productFunctions: [],
      importantNotes: ['该递增不代表现金价值增长或保证收益。'],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'passed');
});

test('cash value in payment comparison does not fail, but policy loan title does fail', () => {
  const cashValueComparison = evaluate({
    routing: { productCategory: 'ordinary_whole_life' },
    sourceSections: { mainResponsibilityText: '身故 全残 基本保险金额 现金价值' },
    summary: {
      responsibilities: [
        {
          title: '身故或身体全残保险金',
          plainText: '按基本保险金额、已交保费和现金价值三者较大者给付。',
        },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });
  assert.equal(cashValueComparison.status, 'passed');

  const policyLoanTitle = evaluate({
    routing: { productCategory: 'ordinary_whole_life' },
    sourceSections: { mainResponsibilityText: '身故 全残 基本保险金额 现金价值 保单贷款' },
    summary: {
      responsibilities: [
        { title: '保单贷款', plainText: '可按现金价值申请贷款。' },
        { title: '身故或身体全残保险金', plainText: '按基本保险金额给付。' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });
  assertFailedWith(policyLoanTitle, 'function_mixed_into_responsibilities', (issue) => issue.term === '保单贷款');
});

test('participating summary fails if dividend is a responsibility title', () => {
  const result = evaluate({
    routing: { productCategory: 'participating_life', featureTags: ['participating'] },
    sourceSections: { mainResponsibilityText: '本合同为分红型保险，身故保险金，红利分配是不确定的。' },
    summary: {
      responsibilities: [
        { title: '身故保险金', plainText: '按条款给付。' },
        { title: '年度红利', plainText: '每年分配红利。' },
      ],
      productFunctions: [],
      importantNotes: ['红利不保证。'],
      missingOrUnclear: [],
    },
  });

  assertFailedWith(result, 'function_mixed_into_responsibilities', (issue) => issue.term === '红利');
});

test('participating summary fails if dividends are described as guaranteed', () => {
  const result = evaluate({
    routing: { productCategory: 'participating_life', featureTags: ['participating'] },
    sourceSections: { mainResponsibilityText: '本合同为分红型保险，身故保险金，红利分配是不确定的。' },
    summary: {
      responsibilities: [{ title: '身故保险金', plainText: '按条款给付。' }],
      productFunctions: ['红利分配'],
      importantNotes: ['保证获得红利。'],
      missingOrUnclear: [],
    },
  });

  assertFailedWith(result, 'missing_dividend_uncertainty_note');
  assertFailedWith(result, 'unsupported_guaranteed_dividend');
});

test('participating summary passes when dividend is product function or note and not guaranteed', () => {
  const result = evaluate({
    routing: { productCategory: 'participating_life', featureTags: ['participating'] },
    sourceSections: { mainResponsibilityText: '本合同为分红型保险，身故保险金，红利分配是不确定的。' },
    summary: {
      responsibilities: [{ title: '身故保险金', plainText: '按条款给付。' }],
      productFunctions: ['红利分配属于产品功能。'],
      importantNotes: ['红利不保证，取决于保险公司实际经营和分配。'],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.issues, []);
});

test('source absent optional responsibility does not require it', () => {
  const result = evaluate({
    routing: { productCategory: 'critical_illness' },
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金',
    },
    summary: {
      responsibilities: [
        { title: '等待期', plainText: '90日' },
        { title: '轻度疾病保险金', plainText: '20%' },
        { title: '中度疾病保险金', plainText: '50%' },
        { title: '重度疾病保险金', plainText: '100%' },
        { title: '身故保险金', plainText: '身故赔付' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assert.equal(result.status, 'passed');
});

test('empty and malformed summaries fail readiness', () => {
  const empty = evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'critical_illness' },
    sourceSections: { mainResponsibilityText: '等待期' },
    summary: { responsibilities: [], productFunctions: [], importantNotes: [], missingOrUnclear: [] },
  });
  assertFailedWith(empty, 'empty_responsibilities');

  const malformed = evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'critical_illness' },
    sourceSections: { mainResponsibilityText: '等待期' },
    summary: { responsibilities: [{ title: '等待期' }] },
  });
  assertFailedWith(malformed, 'missing_responsibility_render_text');

  const missingArray = evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'critical_illness' },
    sourceSections: { mainResponsibilityText: '等待期' },
    summary: {},
  });
  assertFailedWith(missingArray, 'invalid_responsibilities_shape');
});

test('unsupported invented traffic responsibility fails when source lacks traffic extra', () => {
  const result = evaluate({
    routing: { productCategory: 'incremental_whole_life' },
    sourceSections: { mainResponsibilityText: '身故 身体全残保险金 基本保险金额。' },
    summary: {
      responsibilities: [
        { title: '身故或身体全残保险金', plainText: '按基本保险金额给付。' },
        { title: '公共交通工具意外额外给付', plainText: '额外给付基本保险金额。' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: [],
    },
  });

  assertFailedWith(result, 'unsupported_responsibility_claim', (issue) => issue.keyword === '交通意外额外给付');
});

test('missingOrUnclear with explanation can satisfy source-present responsibility coverage', () => {
  const result = evaluate({
    routing: { productCategory: 'critical_illness' },
    sourceSections: {
      mainResponsibilityText: '等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金 身故保险金 豁免保险费',
    },
    summary: {
      responsibilities: [
        { title: '等待期', plainText: '90日' },
        { title: '轻度疾病保险金', plainText: '20%' },
        { title: '中度疾病保险金', plainText: '50%' },
        { title: '重度疾病保险金', plainText: '100%' },
        { title: '身故保险金', plainText: '身故赔付' },
      ],
      productFunctions: [],
      importantNotes: [],
      missingOrUnclear: ['豁免保险费触发条件来源未载明，需要核验条款。'],
    },
  });

  assert.equal(result.status, 'passed');
});
