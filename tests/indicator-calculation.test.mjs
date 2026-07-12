import assert from 'node:assert/strict';
import test from 'node:test';
import {
  indicatorCalculationPayloadFields,
  normalizeIndicatorCalculation,
  resolveIndicatorAmountFromCalculation,
} from '../src/indicator-calculation.mjs';

test('normalizeIndicatorCalculation classifies first basic responsibility premium separately from total paid premium', () => {
  const indicator = {
    coverageType: '现金流',
    liability: '关爱年金',
    value: 1,
    unit: '%',
    basis: '首次交纳的基本责任的保险费',
    formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
  };

  const meta = normalizeIndicatorCalculation(indicator);
  assert.equal(meta.basisKey, 'first_basic_responsibility_premium');
  assert.equal(meta.calculationKey, 'percent_of_first_premium');
  assert.equal(meta.calculationEligible, true);

  const result = resolveIndicatorAmountFromCalculation(indicator, {
    baseAmount: 100000,
    firstPremium: 12000,
    paymentYears: 10,
  });
  assert.equal(result.resolved, true);
  assert.equal(result.amount, 120);
  assert.match(result.calculationText, /首期\/首年保费12,000元 × 1% = 120元/u);
});

test('normalizeIndicatorCalculation treats paid premium as cumulative paid premium', () => {
  const indicator = {
    coverageType: '现金流',
    liability: '满期保险金',
    basis: '已交保险费',
    formulaText: '满期保险金 = 已交保险费',
  };

  const result = resolveIndicatorAmountFromCalculation(indicator, {
    baseAmount: 100000,
    firstPremium: 12000,
    paymentYears: 10,
  });
  assert.equal(result.resolved, true);
  assert.equal(result.amount, 120000);
  assert.equal(result.meta.basisKey, 'total_paid_premium');
  assert.equal(result.meta.calculationKey, 'total_paid_premium');
});

test('normalizeIndicatorCalculation blocks cash value and rule parameter calculations', () => {
  const cashValue = normalizeIndicatorCalculation({
    coverageType: '现金流',
    liability: '满期返还',
    basis: '保单账户价值',
    formulaText: '满期返还 = 保单账户价值',
  });
  assert.equal(cashValue.calculationEligible, false);
  assert.equal(cashValue.calculationKey, 'account_value');

  const ruleParameter = indicatorCalculationPayloadFields({
    coverageType: '规则参数',
    liability: '赔付方式',
    basis: '保险责任赔付机制',
  });
  assert.equal(ruleParameter.calculationEligible, false);
  assert.equal(ruleParameter.calculationKey, 'not_calculable');
});

test('normalizeIndicatorCalculation preserves structured non-calculable metadata', () => {
  const scheduleAmount = normalizeIndicatorCalculation({
    coverageType: '现金流',
    liability: '年金',
    basis: '保险合同载明的领取金额',
    formulaText: '年金 = 保险合同载明的领取金额',
    basisKey: 'schedule_or_policy_table',
    calculationKey: 'schedule_or_policy_table',
    calculationEligible: false,
  });

  assert.equal(scheduleAmount.basisKey, 'schedule_or_policy_table');
  assert.equal(scheduleAmount.calculationKey, 'schedule_or_policy_table');
  assert.equal(scheduleAmount.calculationEligible, false);
});

test('normalizeIndicatorCalculation treats expense reimbursement with insured amount cap as table dependent', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '医疗保障',
    liability: '重大疾病异地转诊住宿费用',
    basis: '实际合理住宿费用，扣除单次免赔额后按给付比例赔付，累计以保险金额为限',
    formulaText: '住宿费用保险金 = min((实际合理住宿费用 - 单次免赔额) × 给付比例, 剩余保险金额)',
  });

  assert.equal(meta.basisKey, 'medical_expense');
  assert.equal(meta.calculationKey, 'medical_formula');
  assert.equal(meta.calculationEligible, false);
  assert.match(meta.calculationReason, /实际费用/u);
});

test('normalizeIndicatorCalculation treats personal contribution account benefits as account dependent', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '人寿保障',
    liability: '身故、全残保险金给付',
    basis: '个人缴费账户金额与单位缴费已归属账户金额之和',
    formulaText: '给付金额 = 个人缴费账户金额 + 单位缴费已归属账户金额',
  });

  assert.equal(meta.basisKey, 'account_value');
  assert.equal(meta.calculationKey, 'account_value');
  assert.equal(meta.calculationEligible, false);
  assert.match(meta.calculationReason, /账户价值/u);
});

test('normalizeIndicatorCalculation treats disability compensation percentage tables as table dependent', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '意外保障',
    liability: '伤残等级赔偿限额比例调整',
    basis: '附加条款表列比例',
    formulaText: '伤残赔偿比例 = 附加条款表列比例',
  });

  assert.equal(meta.basisKey, 'schedule_or_policy_table');
  assert.equal(meta.calculationKey, 'schedule_or_policy_table');
  assert.equal(meta.calculationEligible, false);
});

test('normalizeIndicatorCalculation blocks conditional early or late payout formulas', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '重大疾病保障',
    liability: '重大疾病保险金',
    basis: '初始基本保险金额、有效保险金额、所交保险费、合同生效时间/事故原因',
    formulaText: '重大疾病保险金 = 条件给付（早期约定情形：初始基本保险金额 × 10% + 无息返还所交保险费；后续/意外约定情形：有效保险金额）',
  });

  assert.equal(meta.calculationEligible, false);
  assert.equal(meta.calculationKey, 'manual_formula');
  assert.match(meta.calculationReason, /条件化给付/u);
});

test('normalizeIndicatorCalculation treats basic-amount day-count benefits as daily allowance dependent', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '医疗保障',
    liability: '特定流感住院给付金',
    basis: '给付天数、基本保险金额',
    formulaText: '特定流感住院给付金 = 给付天数 × 基本保险金额',
    sourceExcerpt: '本公司按本合同基本保险金额乘以实际住院日数给付特定流感住院给付金。',
  });

  assert.equal(meta.basisKey, 'daily_allowance');
  assert.equal(meta.calculationKey, 'daily_allowance');
  assert.equal(meta.calculationEligible, false);
});
