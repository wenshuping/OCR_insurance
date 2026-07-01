import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStructuredResponsibilityPrompt,
  requiredKeywordsForCategory,
} from '../server/responsibility-summary-templates.mjs';

test('critical illness prompt includes complete checklist and disease expansion warning', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company: '新华保险', productName: '多倍保障少儿重大疾病保险（超越版）' },
    routing: { productCategory: 'critical_illness', categoryLabel: '重大疾病保险', featureTags: ['children'] },
    sourceSections: { mainResponsibilityText: '第五条 保险责任 等待期 轻度疾病保险金 中度疾病保险金 重度疾病保险金' },
  });

  assert.match(prompt, /少儿前10年关爱保险金/u);
  assert.match(prompt, /成人意外伤害特定疾病或身故关爱保险金/u);
  assert.match(prompt, /豁免保险费/u);
  assert.match(prompt, /不要展开全部疾病名称/u);
});

test('incremental whole life prompt covers compound growth, coefficients, cash value, and traffic extra', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company: '新华保险', productName: '鑫荣耀终身寿险' },
    routing: {
      productCategory: 'incremental_whole_life',
      categoryLabel: '增额终身寿险',
      featureTags: ['compound_growth', 'traffic_accident_extra'],
    },
    sourceSections: {
      mainResponsibilityText: '有效保险金额为基本保险金额×(1+3.5%)^(n-1)，含公共交通意外额外给付。',
    },
  });

  assert.match(prompt, /每年X%复利递增/u);
  assert.match(prompt, /不等于现金价值按X%增长/u);
  assert.match(prompt, /给付系数和年龄段/u);
  assert.match(prompt, /交通意外额外给付/u);
  assert.deepEqual(
    requiredKeywordsForCategory('incremental_whole_life').slice(2, 5),
    ['基本保险金额', '现金价值', '给付系数'],
  );
});

test('participating annuity prompt separates dividends from responsibilities and annuity keywords are ordered', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company: '测试保险', productName: '尊贵人生年金保险（分红型）' },
    routing: { productCategory: 'annuity', categoryLabel: '年金保险（分红型）', featureTags: ['participating'] },
    sourceSections: {
      mainResponsibilityText: '关爱年金 生存保险金 身故保险金 累积红利保险金额 红利分配是不确定的。',
    },
  });

  assert.match(prompt, /红利.*不是独立保险责任/u);
  assert.match(prompt, /红利不保证/u);
  assert.deepEqual(requiredKeywordsForCategory('annuity').slice(0, 3), ['年金', '生存保险金', '身故保险金']);
});

test('prompt requires JSON only and contains expected schema keys', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'medical', categoryLabel: '医疗保险' },
  });

  assert.match(prompt, /只输出合法 JSON/u);
  assert.match(prompt, /JSON only/u);
  assert.match(prompt, /不要 Markdown/u);
  for (const key of [
    'productCategory',
    'categoryLabel',
    'headline',
    'responsibilities',
    'title',
    'plainText',
    'triggerCondition',
    'paymentRule',
    'calculationStatus',
    'productFunctions',
    'importantNotes',
    'missingOrUnclear',
  ]) {
    assert.match(prompt, new RegExp(`"${key}"`, 'u'));
  }
});

test('unknown category gets generic instruction separating responsibilities and functions', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'other', categoryLabel: '其他' },
  });

  assert.match(prompt, /通用模板/u);
  assert.match(prompt, /保险责任、产品功能、重要提示必须分开/u);
  assert.deepEqual(requiredKeywordsForCategory('unknown'), []);
});

test('prompt includes sourceSections, cards, and indicators payload', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    product: { company: '测试保险', productName: '测试医疗保险' },
    routing: { productCategory: 'medical', categoryLabel: '医疗保险' },
    sourceSections: { mainResponsibilityText: '住院医疗保险金 免赔额 赔付比例 年度限额' },
    cards: [{ title: '住院医疗保险金', sourceExcerpt: '按约定赔付' }],
    indicators: [{ coverageType: '医疗', formulaText: '年度限额100万元' }],
  });

  assert.match(prompt, /"sourceSections"/u);
  assert.match(prompt, /"cards"/u);
  assert.match(prompt, /"indicators"/u);
  assert.match(prompt, /住院医疗保险金/u);
  assert.match(prompt, /年度限额100万元/u);
});
