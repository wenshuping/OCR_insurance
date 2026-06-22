import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResponsibilityCardsForPolicy,
  standardizeResponsibilityIndicator,
} from '../server/responsibility-card-standardizer.mjs';

const basePolicy = {
  company: '新华保险',
  name: '尊享人生年金保险（分红型）',
  amount: 100000,
  firstPremium: 12000,
  paymentPeriod: '10年交',
  coveragePeriod: '终身',
};

test('standardizeResponsibilityIndicator keeps first basic responsibility premium distinct and scheduled cashflow', () => {
  const indicator = {
    id: 'ind_annuity_1',
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '关爱年金',
    value: 1,
    valueText: '1',
    unit: '%',
    basis: '首次交纳的基本责任的保险费',
    formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
    condition: '犹豫期结束次日、每年保单生效对应日生存',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
  };

  const result = standardizeResponsibilityIndicator(indicator, { policy: basePolicy });

  assert.equal(result.liability, '关爱年金');
  assert.equal(result.basisKey, 'first_basic_responsibility_premium');
  assert.equal(result.calculationKey, 'percent_of_first_premium');
  assert.equal(result.calculationEligible, true);
  assert.equal(result.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(result.calculationReason, '');
});

test('standardizeResponsibilityIndicator blocks indicators without official source excerpt', () => {
  const result = standardizeResponsibilityIndicator({
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '满期保险金',
    basis: '基本保险金额',
    formulaText: '满期保险金 = 基本保险金额',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '',
  }, { policy: basePolicy });

  assert.equal(result.calculationEligible, false);
  assert.equal(result.cashflowTreatment, 'not_cashflow');
  assert.match(result.calculationReason, /缺少官方来源片段/u);
});

test('standardizeResponsibilityIndicator classifies claim-trigger benefits as claim_contingent even when amount is calculable', () => {
  const result = standardizeResponsibilityIndicator({
    company: '新华保险',
    productName: '测试重大疾病保险',
    coverageType: '疾病保障',
    liability: '重大疾病保险金',
    value: 100,
    unit: '%',
    basis: '基本保险金额',
    formulaText: '重大疾病保险金 = 基本保险金额 × 100%',
    condition: '被保险人确诊合同约定重大疾病',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/ci.pdf',
    sourceExcerpt: '被保险人确诊本合同所指重大疾病，本公司按基本保险金额给付重大疾病保险金。',
  }, { policy: { ...basePolicy, name: '测试重大疾病保险' } });

  assert.equal(result.calculationEligible, true);
  assert.equal(result.cashflowTreatment, 'claim_contingent');
  assert.equal(result.calculationStatus, 'claim_contingent');
  assert.equal(result.calculationKey, 'percent_of_basic_amount');
});

test('standardizeResponsibilityIndicator does not let waiver text in source excerpt override benefit liability', () => {
  const result = standardizeResponsibilityIndicator({
    company: '复星联合健康保险',
    productName: '复星联合妈咪保贝（星耀版）少儿重大疾病保险',
    coverageType: '可选责任',
    liability: '轻度疾病保险金',
    value: 30,
    unit: '%',
    basis: '基本保险金额',
    formulaText: '轻度疾病保险金 = 基本保险金额 × 30%',
    sourceUrl: 'https://www.fosun-uhi.com/upload/pdf/mamibaby.pdf',
    sourceExcerpt: '轻度疾病保险金按基本保险金额的30%给付；中度疾病或轻度疾病豁免保险费责任可选。',
  }, { policy: { ...basePolicy, company: '复星联合健康保险', name: '复星联合妈咪保贝（星耀版）少儿重大疾病保险' } });

  assert.equal(result.category, '疾病保障');
  assert.equal(result.cashflowTreatment, 'claim_contingent');
  assert.equal(result.calculationStatus, 'claim_contingent');
});

test('standardizeResponsibilityIndicator blocks table and expense dependent indicators from direct calculation', () => {
  const medical = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试医疗保险',
    coverageType: '医疗保障',
    liability: '住院医疗保险金',
    basis: '实际医疗费用',
    formulaText: '住院医疗保险金 = (实际合理医疗费用 - 免赔额) × 给付比例',
    sourceUrl: 'https://example.com/medical.pdf',
    sourceExcerpt: '本公司按实际合理医疗费用扣除免赔额后乘以约定给付比例给付住院医疗保险金。',
  }, { policy: basePolicy });

  assert.equal(medical.calculationEligible, false);
  assert.equal(medical.cashflowTreatment, 'claim_contingent');
  assert.equal(medical.calculationStatus, 'needs_table');
  assert.equal(medical.calculationKey, 'medical_formula');

  const cashValue = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试终身寿险',
    coverageType: '人寿保障',
    liability: '身故保险金',
    basis: '现金价值',
    formulaText: '身故保险金 = 现金价值、已交保险费、基本保险金额三者较大者',
    sourceUrl: 'https://example.com/life.pdf',
    sourceExcerpt: '身故保险金为现金价值、已交保险费、基本保险金额三者较大者。',
  }, { policy: basePolicy });

  assert.equal(cashValue.calculationEligible, false);
  assert.equal(cashValue.cashflowTreatment, 'claim_contingent');
  assert.equal(cashValue.calculationStatus, 'needs_table');
  assert.equal(cashValue.calculationKey, 'manual_formula');
});

test('standardizeResponsibilityIndicator blocks yuan values that depend on account, schedule, or daily data', () => {
  const accountValue = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试万能险',
    coverageType: '现金流',
    liability: '部分领取金额',
    value: 1000,
    unit: '元',
    basis: '账户价值',
    formulaText: '部分领取金额 = 账户价值中保单载明的可领取金额1000元',
    sourceUrl: 'https://example.com/account.pdf',
    sourceExcerpt: '部分领取金额以个人账户价值中保单载明的可领取金额为准。',
  }, { policy: basePolicy });

  assert.equal(accountValue.calculationEligible, false);
  assert.equal(accountValue.calculationStatus, 'needs_table');
  assert.equal(accountValue.calculationKey, 'account_value');

  const dailyAllowance = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试医疗保险',
    coverageType: '医疗保障',
    liability: '住院日津贴保险金',
    value: 100,
    unit: '元',
    basis: '日津贴额',
    formulaText: '住院日津贴保险金 = 日津贴额100元 × 给付天数',
    sourceUrl: 'https://example.com/daily.pdf',
    sourceExcerpt: '本公司按日津贴额100元乘以实际给付天数给付住院日津贴保险金。',
  }, { policy: basePolicy });

  assert.equal(dailyAllowance.calculationEligible, false);
  assert.equal(dailyAllowance.calculationStatus, 'needs_table');
  assert.equal(dailyAllowance.calculationKey, 'daily_allowance');

  const scheduleAmount = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试年金保险',
    coverageType: '现金流',
    liability: '养老年金',
    value: 2000,
    unit: '元',
    basis: '保单载明金额',
    formulaText: '养老年金 = 保单载明金额2000元，按领取计划表给付',
    sourceUrl: 'https://example.com/schedule.pdf',
    sourceExcerpt: '养老年金金额以保险单载明金额和领取计划表为准。',
  }, { policy: basePolicy });

  assert.equal(scheduleAmount.calculationEligible, false);
  assert.equal(scheduleAmount.calculationStatus, 'needs_table');
  assert.equal(scheduleAmount.calculationKey, 'schedule_or_policy_table');
});

test('standardizeResponsibilityIndicator keeps truly fixed yuan benefits calculable', () => {
  const fixedBenefit = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试固定给付保险',
    coverageType: '其他',
    liability: '固定给付金',
    value: 500,
    unit: '元',
    basis: '固定金额',
    formulaText: '固定给付金 = 500元',
    sourceUrl: 'https://example.com/fixed.pdf',
    sourceExcerpt: '固定给付金为500元。',
  }, { policy: basePolicy });

  assert.equal(fixedBenefit.calculationEligible, true);
  assert.equal(fixedBenefit.calculationKey, 'fixed_amount');
  assert.notEqual(fixedBenefit.calculationStatus, 'needs_table');
});

test('buildResponsibilityCardsForPolicy writes readable cards and re-checks existing indicators', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: basePolicy,
    responsibilities: [{
      coverageType: '保险责任',
      scenario: '关爱年金 如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
      payout: '按首次交纳的基本责任的保险费的1%给付',
      note: '尊享人生年金保险（分红型）',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceTitle: '尊享人生年金保险（分红型）条款',
    }],
    coverageIndicators: [{
      id: 'ind_annuity_1',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 1,
      unit: '%',
      basis: '首次交纳的基本责任的保险费',
      formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
      condition: '犹豫期结束次日、每年保单生效对应日生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '关爱年金');
  assert.equal(cards[0].category, '现金流');
  assert.equal(cards[0].cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards[0].calculationStatus, 'calculable');
  assert.equal(cards[0].indicators.length, 1);
  assert.equal(cards[0].indicators[0].basisKey, 'first_basic_responsibility_premium');
});

test('buildResponsibilityCardsForPolicy ignores malformed rows and still builds valid cards', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: basePolicy,
    responsibilities: [
      null,
      'bad responsibility row',
      {
        coverageType: '保险责任',
        scenario: '关爱年金 如被保险人每年保单生效对应日生存，本公司给付关爱年金。',
        payout: '按首次交纳的基本责任的保险费的1%给付',
        sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
        sourceTitle: '尊享人生年金保险（分红型）条款',
      },
    ],
    optionalResponsibilityRecords: [undefined, 42],
    coverageIndicators: [
      null,
      'bad indicator row',
      {
        id: 'ind_annuity_1',
        company: '新华保险',
        productName: '尊享人生年金保险（分红型）',
        coverageType: '现金流',
        liability: '关爱年金',
        value: 1,
        unit: '%',
        basis: '首次交纳的基本责任的保险费',
        formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
        condition: '每年保单生效对应日生存',
        sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
        sourceExcerpt: '被保险人每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
      },
    ],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '关爱年金');
  assert.equal(cards[0].indicators.length, 1);
  assert.equal(cards[0].indicators[0].id, 'ind_annuity_1');
});

test('buildResponsibilityCardsForPolicy merges same product and responsibility indicators into one card', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: basePolicy,
    coverageIndicators: [{
      id: 'ind_annuity_first_premium',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 1,
      unit: '%',
      basis: '首次交纳的基本责任的保险费',
      formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
      condition: '每年保单生效对应日生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '被保险人每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
    }, {
      id: 'ind_annuity_basic_amount',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 2,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '关爱年金 = 基本保险金额 × 2%',
      condition: '每年保单生效对应日生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '被保险人每年保单生效对应日生存，本公司按基本保险金额的2%给付关爱年金。',
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '关爱年金');
  assert.equal(cards[0].calculationStatus, 'calculable');
  assert.equal(cards[0].cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards[0].indicators.length, 2);
  assert.deepEqual(cards[0].indicators.map((indicator) => indicator.id), [
    'ind_annuity_first_premium',
    'ind_annuity_basic_amount',
  ]);
});

test('buildResponsibilityCardsForPolicy keeps rider responsibility-only cards separate by product', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: {
      company: '测试保险',
      name: '主险产品',
    },
    optionalResponsibilityRecords: [{
      company: '测试保险',
      productName: '主险产品',
      coverageType: '可选责任',
      liability: '可选责任一',
      scenario: '主险可选责任一按主险条款给付。',
      sourceUrl: 'https://official.example-life.test/main.pdf',
      sourceExcerpt: '主险可选责任一按主险条款给付。',
    }, {
      company: '测试保险',
      productName: '附加险产品',
      coverageType: '可选责任',
      liability: '可选责任一',
      scenario: '附加险可选责任一按附加险条款给付。',
      sourceUrl: 'https://official.example-life.test/rider.pdf',
      sourceExcerpt: '附加险可选责任一按附加险条款给付。',
    }],
  });

  assert.equal(cards.length, 2);
  assert.deepEqual(
    cards.map((card) => [card.productName, card.title, card.sourceUrl]),
    [
      ['主险产品', '可选责任一', 'https://official.example-life.test/main.pdf'],
      ['附加险产品', '可选责任一', 'https://official.example-life.test/rider.pdf'],
    ],
  );
});
