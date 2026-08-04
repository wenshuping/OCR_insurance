import assert from 'node:assert/strict';
import test from 'node:test';

import {
  detectProductBoundaries,
  matchProductCandidates,
} from '../server/product-boundary.service.mjs';

function page(pageNo, rawText) {
  return { pageNo, rawText, headings: [], tables: [], sourceLabel: `第 ${pageNo} 页` };
}

test('detects one product and preserves its page range and code', () => {
  const result = detectProductBoundaries([
    page(1, '新华保险\n康宁保终身重大疾病保险 产品介绍\n产品代码：KNB2026'),
    page(2, '康宁保终身重大疾病保险 保险责任与投保规则'),
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].company, '新华保险');
  assert.equal(result.candidates[0].productName, '康宁保终身重大疾病保险');
  assert.equal(result.candidates[0].productCodes[0], 'KNB2026');
  assert.deepEqual([result.candidates[0].pageStart, result.candidates[0].pageEnd], [1, 2]);
  assert.equal(result.candidates[0].relationType, 'primary');
});

test('detects multiple products and marks a shared comparison page', () => {
  const result = detectProductBoundaries([
    page(1, '平安人寿\n守护星医疗保险 产品介绍'),
    page(2, '平安人寿\n福满家年金保险 产品介绍'),
    page(3, '守护星医疗保险与福满家年金保险产品对比'),
  ]);
  assert.deepEqual(result.candidates.map((item) => item.productName).sort(), ['守护星医疗保险', '福满家年金保险']);
  assert.ok(result.candidates.every((item) => item.evidencePages.includes(3)));
  assert.ok(result.candidates.every((item) => item.relationType === 'comparison'));
});

test('generic insurance prose does not become a product candidate', () => {
  const result = detectProductBoundaries([page(1, '本页介绍保险责任、责任免除和客户服务流程。')]);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.requiresReview, true);
});

test('matches by product code before product name', () => {
  const detected = [{
    company: '新华保险',
    productName: '康宁保重大疾病保险（培训简称）',
    productCodes: ['KNB2026'],
  }];
  const matches = matchProductCandidates(detected, [{
    canonicalProductId: 'cp_knb',
    company: '新华保险',
    officialName: '康宁保终身重大疾病保险',
    productCode: 'KNB2026',
  }]);
  assert.equal(matches[0].matches[0].canonicalProductId, 'cp_knb');
  assert.equal(matches[0].matches[0].reason, 'exact_product_code');
  assert.equal(matches[0].autoLinkEligible, true);
});

test('name-only fuzzy matches remain review candidates', () => {
  const matches = matchProductCandidates([
    { company: '平安人寿', productName: '守护星医疗险', productCodes: [] },
  ], [{
    canonicalProductId: 'cp_shouxing',
    company: '平安人寿',
    productName: '守护星医疗保险',
  }]);
  assert.equal(matches[0].matches[0].canonicalProductId, 'cp_shouxing');
  assert.equal(matches[0].autoLinkEligible, false);
});
