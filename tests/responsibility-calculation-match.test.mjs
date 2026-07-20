import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mergeCalculatedResponsibilityTitles,
  responsibilityTitlesMatch,
} from '../src/shared/responsibility-calculation-match.mjs';

test('responsibilityTitlesMatch ignores an optional-responsibility suffix', () => {
  assert.equal(
    responsibilityTitlesMatch('轻度疾病保险金（可选责任一）', '轻度疾病保险金'),
    true,
  );
  assert.equal(
    responsibilityTitlesMatch('中度疾病保险金（可选责任一）', '中度疾病保险金'),
    true,
  );
});

test('responsibilityTitlesMatch keeps distinct numbered benefits separate', () => {
  assert.equal(responsibilityTitlesMatch('第一次重度疾病保险金', '第二次重度疾病保险金'), false);
});

test('responsibilityTitlesMatch recognizes common disease-severity aliases', () => {
  assert.equal(responsibilityTitlesMatch('轻症疾病保险金', '轻度疾病保险金'), true);
  assert.equal(responsibilityTitlesMatch('中症疾病保险金', '中度疾病保险金'), true);
  assert.equal(responsibilityTitlesMatch('重疾保险金', '重度疾病保险金'), true);
  assert.equal(responsibilityTitlesMatch('重大疾病保险金', '第二至第六次重度疾病保险金'), true);
});

test('mergeCalculatedResponsibilityTitles keeps summary cards and appends every unmatched calculated indicator', () => {
  assert.deepEqual(
    mergeCalculatedResponsibilityTitles(
      ['轻症疾病保险金', '重大疾病保险金', '身故保险金'],
      [],
      [
        { scenario: '轻度疾病保险金', amount: 34_000 },
        { scenario: '中度疾病保险金', amount: 85_000 },
        { scenario: '第二至第六次重度疾病保险金', amount: 170_000 },
        { scenario: '重度恶性肿瘤多次给付保险金', amount: 170_000 },
      ],
    ),
    [
      '轻症疾病保险金',
      '重大疾病保险金',
      '身故保险金',
      '中度疾病保险金',
      '重度恶性肿瘤多次给付保险金',
    ],
  );
});
