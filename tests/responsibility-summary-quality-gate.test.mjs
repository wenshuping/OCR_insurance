import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateResponsibilitySummaryQuality } from '../server/responsibility-summary-quality-gate.mjs';

function evaluate(summary) {
  return evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'critical_illness' },
    sourceSections: { mainResponsibilityText: '' },
    summary,
  });
}

function assertFailedWith(result, code, predicate = () => true) {
  assert.equal(result.status, 'failed');
  assert.ok(result.issues.some((issue) => issue.code === code && predicate(issue)), result.issues);
}

test('evaluateResponsibilitySummaryQuality passes renderable structured summaries', () => {
  const result = evaluate({
    productCategory: 'ordinary_whole_life',
    categoryLabel: '终身寿险',
    headline: '客户可读摘要。',
    responsibilities: [
      {
        title: '身故保险金',
        plainText: '被保险人身故时按条款约定给付。',
      },
    ],
    productFunctions: [],
    importantNotes: [],
    missingOrUnclear: [],
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.issues, []);
});

test('semantic quality rules are disabled for now', () => {
  const result = evaluateResponsibilitySummaryQuality({
    routing: { productCategory: 'incremental_whole_life' },
    sourceSections: {
      mainResponsibilityText: '来源只写了身故保险金，没有交通额外给付、复利递增解释或红利说明。',
      responsibilityItems: [{
        itemId: 'resp_1',
        title: '身故保险金',
        sourceRefs: [{ sourceRefId: 'src_1#resp_1' }],
      }],
    },
    summary: {
      responsibilities: [
        {
          title: '公共交通工具意外额外给付',
          plainText: '额外给付基本保险金额。',
          sourceRefs: ['made_up_ref'],
        },
        {
          title: '年度红利',
          plainText: '保证获得红利。',
        },
      ],
      productFunctions: 'not an array',
      importantNotes: 'not an array',
      missingOrUnclear: 'not an array',
    },
  });

  assert.equal(result.status, 'passed');
  assert.deepEqual(result.issues, []);
});

test('empty and malformed summaries still fail readiness', () => {
  const empty = evaluate({
    responsibilities: [],
    productFunctions: [],
    importantNotes: [],
    missingOrUnclear: [],
  });
  assertFailedWith(empty, 'empty_responsibilities');

  const malformed = evaluate({
    responsibilities: [{ title: '等待期' }],
  });
  assertFailedWith(malformed, 'missing_responsibility_render_text');

  const missingArray = evaluate({});
  assertFailedWith(missingArray, 'invalid_responsibilities_shape');
});
