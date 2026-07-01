import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractStructuredResponsibilitySections,
} from '../server/responsibility-section-extractor.mjs';

test('extractStructuredResponsibilitySections ignores inline 第六条 references', () => {
  const pageText = [
    '第一条 合同构成',
    '第五条 保险责任',
    '1.等待期 自合同生效起90日为等待期。',
    '轻度疾病、中度疾病或重度疾病（详见本合同利益条款第六条）。',
    '2.身故保险金 18周岁后按三者较大者给付。',
    '3.豁免保险费 累计给付达到基本保险金额时豁免。',
    '第六条 本合同保障的疾病列表',
    '轻度疾病共40项，中度疾病共20项，重度疾病共130项，所有疾病分为5组。',
    '以下疾病名称及定义如下：',
    '1.轻度疾病定义 长篇定义不应进入概览。',
  ].join('\n');

  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{ title: '条款', url: 'https://example.test/terms.pdf', pageText }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /身故保险金/u);
  assert.match(result.mainResponsibilityText, /豁免保险费/u);
  assert.doesNotMatch(result.mainResponsibilityText, /疾病列表/u);
  assert.equal(result.sourceUrl, 'https://example.test/terms.pdf');
  assert.equal(result.sourceTitle, '条款');
  assert.equal(result.supplementSections[0].type, 'disease_list_overview');
  assert.match(result.supplementSections[0].text, /轻度疾病共40项/u);
  assert.match(result.supplementSections[0].text, /分为5组/u);
  assert.doesNotMatch(result.supplementSections[0].text, /长篇定义/u);
});

test('extractStructuredResponsibilitySections flags missing responsibility chapter', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{ title: '条款', pageText: '这是产品简介，没有保险责任正文。' }],
  });

  assert.equal(result.quality.status, 'needs_extraction_review');
  assert.equal(result.mainResponsibilityText, '');
  assert.deepEqual(result.quality.warnings, ['responsibility_chapter_missing']);
});

test('extractStructuredResponsibilitySections bounds decimal responsibility chapter', () => {
  const result = extractStructuredResponsibilitySections({
    records: [{
      title: '条款',
      pageText: [
        '2.2 投保范围',
        '2.3 保险责任',
        '在本合同保险期间内，本公司承担身故保险金责任。',
        '2.4 责任免除',
        '因下列情形导致的保险事故，本公司不承担给付责任。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /身故保险金/u);
  assert.doesNotMatch(result.mainResponsibilityText, /责任免除/u);
});

test('extractStructuredResponsibilitySections combines useful text fields after full text', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'critical_illness',
    records: [{
      title: '官方条款',
      source_url: 'https://example.test/full.pdf',
      fullText: [
        '第五条 保险责任',
        '本公司按约定给付重大疾病保险金。',
        '第六条 责任免除',
      ].join('\n'),
      source_excerpt: [
        '第七条 本合同保障的疾病列表',
        '本合同保障重度疾病120项，轻度疾病40项，疾病分为6组。',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.match(result.mainResponsibilityText, /重大疾病保险金/u);
  assert.equal(result.sourceUrl, 'https://example.test/full.pdf');
  assert.equal(result.supplementSections[0].type, 'disease_list_overview');
  assert.match(result.supplementSections[0].text, /重度疾病120项/u);
});

test('extractStructuredResponsibilitySections keeps annuity optional responsibility supplement', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'annuity',
    records: [{
      title: '年金条款',
      pageText: [
        '第五条 保险责任',
        '本合同基本责任包括养老年金和身故保险金。',
        '第六条 可选责任',
        '投保人可以选择附加护理年金责任。',
        '第七条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.equal(result.supplementSections[0].type, 'optional_responsibility');
  assert.match(result.supplementSections[0].text, /可选责任/u);
  assert.match(result.supplementSections[0].text, /护理年金/u);
});

test('extractStructuredResponsibilitySections keeps participating dividend supplement', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'participating_life',
    records: [{
      title: '分红险条款',
      pageText: [
        '第五条 保险责任',
        '本公司承担身故保险金责任。',
        '第六条 保单分红',
        '本合同为分红保险，红利分配是不确定的。',
        '累积红利保险金额用于增加保险金额，红利不保证。',
        '第七条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.equal(result.supplementSections[0].type, 'dividend');
  assert.match(result.supplementSections[0].text, /红利分配是不确定/u);
  assert.match(result.supplementSections[0].text, /红利不保证/u);
});

test('extractStructuredResponsibilitySections keeps universal account rate fee risk supplement', () => {
  const result = extractStructuredResponsibilitySections({
    productCategory: 'universal_life',
    records: [{
      title: '万能险条款',
      pageText: [
        '第五条 保险责任',
        '本公司承担身故保险金责任。',
        '第六条 账户价值',
        '个人账户价值按结算利率累积，最低保证利率为2%。',
        '本公司收取初始费用和保单管理费，投资收益存在风险。',
        '第七条 责任免除',
      ].join('\n'),
    }],
  });

  assert.equal(result.quality.status, 'complete');
  assert.equal(result.supplementSections[0].type, 'account_value');
  assert.match(result.supplementSections[0].text, /账户价值/u);
  assert.match(result.supplementSections[0].text, /结算利率/u);
  assert.match(result.supplementSections[0].text, /费用/u);
  assert.match(result.supplementSections[0].text, /风险/u);
});
