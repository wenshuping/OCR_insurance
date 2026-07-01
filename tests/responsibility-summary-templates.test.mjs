import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStructuredResponsibilityPrompt,
  categoryKeywordRules,
  requiredKeywordsForCategory,
} from '../server/responsibility-summary-templates.mjs';

function assertIncludesAll(actual, expected) {
  for (const item of expected) assert.ok(actual.includes(item), `expected ${JSON.stringify(actual)} to include ${item}`);
}

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
  assertIncludesAll(requiredKeywordsForCategory('incremental_whole_life'), ['基本保险金额', '现金价值', '给付系数']);
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
  assert.match(prompt, /claim_contingent\|scheduled_cashflow\|needs_table\|waiver_only\|not_calculable/u);
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

test('required keyword arrays include spec quality keywords', () => {
  const expectedByCategory = {
    annuity: ['年金', '生存保险金', '身故保险金', '领取日', '保单周年日', '可选责任', '累积红利保险金额'],
    critical_illness: ['等待期', '轻度疾病保险金', '中度疾病保险金', '重度疾病保险金', '身故保险金', '豁免保险费', '关爱保险金', '给付特别约定', '累计给付限额'],
    medical: ['医疗保险金', '住院', '门诊', '免赔额', '赔付比例', '年度限额', '社保', '等待期'],
    accident: ['意外身故', '意外伤残', '意外医疗', '伤残等级', '交通工具', '猝死'],
    endowment: ['满期保险金', '身故保险金', '全残保险金', '生存保险金', '已交保险费', '基本保险金额'],
    term_life: ['身故', '全残', '等待期', '基本保险金额', '已交保险费', '现金价值'],
    ordinary_whole_life: ['身故', '全残', '等待期', '基本保险金额', '已交保险费', '现金价值'],
    universal_life: ['账户价值', '身故保险金', '结算利率', '保证利率', '费用', '投资风险'],
    investment_linked: ['账户价值', '身故保险金', '结算利率', '保证利率', '费用', '投资风险'],
  };

  for (const [category, expected] of Object.entries(expectedByCategory)) {
    assertIncludesAll(requiredKeywordsForCategory(category), expected);
  }
});

test('keyword rules distinguish product-function keywords from responsibility keywords', () => {
  const annuity = categoryKeywordRules('annuity');
  assert.ok(annuity.responsibility.includes('年金'));
  assert.ok(annuity.productFunctionOrNote.includes('累积红利保险金额'));
  assert.equal(annuity.responsibility.includes('累积红利保险金额'), false);

  const universal = categoryKeywordRules('universal_life');
  assert.ok(universal.responsibility.includes('身故保险金'));
  assertIncludesAll(universal.productFunctionOrNote, ['账户价值', '结算利率', '保证利率', '费用', '投资风险']);
});

test('participating life prompt says dividends are not responsibilities and not guaranteed', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'participating_life', categoryLabel: '人寿保险（分红型）', featureTags: ['participating'] },
    sourceSections: { mainResponsibilityText: '本合同为分红保险，身故保险金，红利分配是不确定的。' },
  });

  assert.match(prompt, /红利.*不是独立保险责任/u);
  assert.match(prompt, /红利不保证/u);
});

test('universal and investment-linked prompts keep account risk and fees out of responsibilities', () => {
  const universal = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'universal_life', categoryLabel: '万能保险' },
    sourceSections: { mainResponsibilityText: '身故保险金 账户价值 结算利率 保证利率 费用 投资风险' },
  });
  const investmentLinked = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'investment_linked', categoryLabel: '投资连结保险' },
    sourceSections: { mainResponsibilityText: '身故保险金 账户价值 投资账户 单位价格 费用 投资风险' },
  });

  assert.match(universal, /账户\/利率\/费用\/风险出现则放入 productFunctions 或 importantNotes/u);
  assert.match(universal, /未出现不得编造/u);
  assert.match(investmentLinked, /账户\/利率\/费用\/风险出现则放入 productFunctions 或 importantNotes/u);
  assert.match(investmentLinked, /未出现不得编造/u);
});

test('incremental whole life scalar formula instruction translates 1.035 to 3.5 percent', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'incremental_whole_life', categoryLabel: '增额终身寿险' },
    sourceSections: { mainResponsibilityText: '基本保险金额×1.035^(n-1)' },
  });

  assert.match(prompt, /基本保险金额×1\.035\^\(n-1\)/u);
  assert.match(prompt, /将其翻译为每年3\.5%复利递增/u);
});

test('incremental whole life without traffic signal tells model not to invent traffic coverage', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'incremental_whole_life', categoryLabel: '增额终身寿险' },
    sourceSections: { mainResponsibilityText: '身故保险金 身体全残保险金' },
  });

  assert.match(prompt, /不要编造交通责任/u);
});

test('prompt safety wording says absent source responsibilities must not be invented', () => {
  const prompt = buildStructuredResponsibilityPrompt({
    routing: { productCategory: 'critical_illness', categoryLabel: '重大疾病保险' },
    sourceSections: { mainResponsibilityText: '等待期 轻度疾病保险金' },
  });

  assert.match(prompt, /检查来源是否出现；出现则写入 responsibilities；未出现不得编造/u);
  assert.match(prompt, /未出现不得编造，可写 missingOrUnclear only if该类产品通常需要核验\/来源不清/u);
});
