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
  assert.equal(result.calculationKey, 'percent_of_basic_amount');
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
  assert.equal(cashValue.calculationKey, 'manual_formula');
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
  assert.equal(cards[0].indicators.length, 1);
  assert.equal(cards[0].indicators[0].basisKey, 'first_basic_responsibility_premium');
});
