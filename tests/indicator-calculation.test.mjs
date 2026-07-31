import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hasQuantifiedCalculationSignal,
  indicatorCalculationPayloadFields,
  formulaVariablesFromIndicators,
  normalizeIndicatorCalculation,
  requiredCalculationInputsForMeta,
  resolveIndicatorAmountFromCalculation,
} from '../src/indicator-calculation.mjs';

test('quantified calculation signals include formula inputs even when a final amount needs claim data', () => {
  assert.equal(hasQuantifiedCalculationSignal('保险金额 × 伤残程度等级对应的给付比例'), true);
  assert.equal(hasQuantifiedCalculationSignal('保险金额扣减已给付残疾保险金后的余额'), true);
  assert.equal(hasQuantifiedCalculationSignal('实际医疗费用扣除免赔额后按80%给付'), true);
  assert.equal(hasQuantifiedCalculationSignal('被保险人发生意外伤害'), false);
});

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

test('model semantic decision can select a calculation basis while code performs the arithmetic', () => {
  const indicator = {
    coverageType: '疾病保障',
    liability: '中度疾病保险金',
    formulaText: '按约定基准的50%给付',
    value: 50,
    unit: '%',
    basisKey: 'basic_amount',
    calculationKey: 'percent_of_basic_amount',
    calculationEligible: true,
    calculationDecisionSource: 'model_semantic',
  };

  const result = resolveIndicatorAmountFromCalculation(indicator, {
    baseAmount: 170000,
    firstPremium: 10000,
    paymentYears: 20,
  });

  assert.equal(result.resolved, true);
  assert.equal(result.amount, 85000);
  assert.equal(result.meta.decisionSource, 'model_semantic');
  assert.match(result.calculationText, /170,000元 × 50% = 85,000元/u);
});

test('model semantic decision cannot override a high-risk medical dependency', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '医疗保障',
    liability: '住院医疗保险金',
    formulaText: '实际医疗费用扣除免赔额后按比例报销',
    value: 100,
    unit: '%',
    basisKey: 'basic_amount',
    calculationKey: 'percent_of_basic_amount',
    calculationEligible: true,
    calculationDecisionSource: 'model_semantic',
  });

  assert.equal(meta.calculationEligible, false);
  assert.equal(meta.calculationKey, 'medical_formula');
  assert.equal(meta.decisionSource, 'code_safety_rule');
});

test('validated legacy structured decisions use the same guarded calculation path', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '中度疾病保险金',
    formulaText: '按约定基准的50%给付',
    value: 50,
    unit: '%',
    basisKey: 'basic_amount',
    calculationKey: 'percent_of_basic_amount',
  }, { baseAmount: 170000 });

  assert.equal(result.amount, 85000);
  assert.equal(result.meta.decisionSource, 'structured_semantic');
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
  assert.equal(meta.calculationKey, 'claim_event_facts');
  assert.match(meta.calculationReason, /出险原因和出险日期/u);
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

test('resolves a stored normalized formula with parentheses, division, powers, and square roots', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '公式给付金',
    normalizedFormula: 'benefit_amount = (basic_insured_amount + first_premium / 10) ^ 2 + sqrt(payment_years)',
    formulaText: '按条款公式给付',
    basisKey: 'basic_amount',
    calculationKey: 'manual_formula',
    calculationEligible: true,
  }, {
    baseAmount: 100,
    firstPremium: 50,
    paymentYears: 9,
  });

  assert.equal(result.resolved, true);
  assert.equal(result.amount, 11028);
  assert.match(result.calculationText, /\(100 \+ 50 ÷ 10\) \^ 2 \+ sqrt\(9\) = 11,028元/u);
});

test('keeps the known lower bound for an unresolved normalized formula', () => {
  const formulaVariables = formulaVariablesFromIndicators([{
    normalizedFormula: 'effective_insured_amount = basic_insured_amount + accumulated_dividend_insured_amount',
  }]);
  const result = resolveIndicatorAmountFromCalculation({
    liability: '养老金',
    normalizedFormula: 'pension_amount = effective_insured_amount * 1.0',
    formulaText: '按该保单生效对应日有效保险金额给付养老金',
  }, {
    baseAmount: 99888,
    formulaVariables,
  });

  assert.equal(result.resolved, false);
  assert.equal(result.partial, true);
  assert.equal(result.amount, 0);
  assert.equal(result.minimumAmount, 99888);
  assert.equal(result.isMinimumEstimate, true);
  assert.match(result.calculationText, /养老金 = \(99,888 \+ 累计红利保险金额（待补充）\) × 1/u);
  assert.match(result.calculationText, /累计红利保险金额（待补充）/u);
  assert.match(result.calculationText, /最低可确认金额 99,888元/u);
});

test('does not treat effective insured amount as the policy basic amount', () => {
  const meta = normalizeIndicatorCalculation({
    liability: '婚嫁金',
    formulaText: '按该保单生效对应日有效保险金额的50%给付婚嫁金',
    value: 50,
    unit: '%',
  });

  assert.equal(meta.basisKey, 'effective_insured_amount');
  assert.notEqual(meta.calculationKey, 'percent_of_basic_amount');
  assert.deepEqual(requiredCalculationInputsForMeta(meta), ['effectiveInsuranceAmount', 'policyYearOrAge']);
});

test('derives a minimum from an official basis definition when the unresolved term can only increase the payout', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '养老金',
    formulaText: '该保单生效对应日有效保险金额 × 100%',
    value: 100,
    unit: '%',
    basisDefinition: {
      key: 'contract_defined_effective_insured_amount',
      label: '有效保险金额',
      formulaText: '基本保险金额 + 累计红利保险金额',
      requiredInputs: ['policy.basicInsuredAmount', 'policy.accumulatedDividendInsuredAmount'],
      sourceExcerpt: '有效保险金额：指基本保险金额与累计红利保险金额两部分之和。',
    },
  }, { baseAmount: 99888 });

  assert.equal(result.resolved, false);
  assert.equal(result.minimumAmount, 99888);
  assert.equal(result.isMinimumEstimate, true);
  assert.match(result.calculationText, /最低可确认金额 99,888元/u);
  assert.match(result.calculationText, /累计红利保险金额（待补充）/u);
});

test('derives a minimum from a plain multiplication formula when a legacy record omits the multiplier unit', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '身故保险金',
    formulaText: '身故时有效保险金额 × 6',
    basisDefinition: {
      label: '有效保险金额',
      formulaText: '基本保险金额 + 累计红利保险金额',
    },
  }, { baseAmount: 99888 });

  assert.equal(result.resolved, false);
  assert.equal(result.isMinimumEstimate, true);
  assert.equal(result.minimumAmount, 599328);
  assert.match(result.calculationText, /累计红利保险金额（待补充）.*× 6/u);
  assert.match(result.calculationText, /最低可确认金额 599,328元/u);
});

test('repairs a leaked adjacent liability formula from the official clause before calculating', () => {
  const sourceUrl = 'https://example.test/official-terms.pdf';
  const sourceExcerpt = '保险责任：1、满期生存保险金 被保险人生存至保险期间届满，本公司按基本保险金额与累积红利保险金额二者之和给付满期生存保险金，本合同效力即行终止。2、身故或全残保险金 (1)被保险人于本合同生效之日起一年内因疾病导致身故或身体全残，本公司按本合同基本保险金额的10%与本合同项下所实际交纳的保险费二者之和给付身故或全残保险金，本合同终止。被保险人于本合同生效之日起一年后因疾病导致身故或身体全残，本公司按基本保险金额与累积红利保险金额二者之和的两倍给付身故或全残保险金，本合同终止。(2)被保险人因意外伤害导致身故或身体全残，本公司按基本保险金额与累积红利保险金额二者之和的两倍给付身故或全残保险金，本合同终止。';
  const maturity = resolveIndicatorAmountFromCalculation({
    liability: '满期生存保险金',
    formulaText: '满期生存保险金 = 有效保险金额 × 10%',
    value: 10,
    unit: '%',
    basis: '有效保险金额',
    sourceUrl,
    sourceExcerpt,
  }, { baseAmount: 200000 });
  const death = resolveIndicatorAmountFromCalculation({
    liability: '身故或全残保险金',
    formulaText: '身故或全残保险金 = 有效保险金额 × 10%',
    value: 10,
    unit: '%',
    basis: '有效保险金额',
    sourceUrl,
    sourceExcerpt,
  }, { baseAmount: 200000, firstPremium: 0, paymentYears: 1 });

  assert.equal(maturity.isMinimumEstimate, true);
  assert.equal(maturity.minimumAmount, 200000);
  assert.match(maturity.calculationText, /满期生存保险金 = 200,000 \+ 累计红利保险金额（待补充）/u);
  assert.equal(death.resolved, false);
  assert.equal(death.partial, true);
  assert.equal(death.isMinimumEstimate, undefined);
  assert.match(death.calculationText, /需根据出险原因和出险日期选择条款给付分支/u);
  assert.match(death.calculationText, /暂不计算/u);
  assert.deepEqual(requiredCalculationInputsForMeta(death.meta), ['eventCause', 'eventDate']);
});

test('resolves a normalized formula stored as a bare basic-responsibility expression', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '满期保险金',
    normalizedFormula: 'basic_sum_assured',
    formulaText: '按基本责任的保险金额给付满期保险金',
  }, { baseAmount: 89877 });

  assert.equal(result.resolved, true);
  assert.equal(result.amount, 89877);
  assert.match(result.calculationText, /89,877元/u);
});

test('calculates a basic responsibility amount when unified evidence stores a null basis definition', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '满期保险金',
    formulaText: '基本责任的保险金额',
    normalizedFormula: 'basic_insurance_amount',
    basis: '基本责任的保险金额',
    basisKey: 'basic_insurance_amount',
    calculationKey: 'flat_amount',
    calculationEligible: false,
    basisDefinition: null,
  }, { baseAmount: 89877 });

  assert.equal(result.resolved, true);
  assert.equal(result.amount, 89877);
  assert.match(result.calculationText, /89,877元/u);
});

test('projects every display-only formula with known policy inputs without inventing missing operands', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '测试给付金',
    formulaText: '测试给付金 = 基本保险金额 × 给付比例',
    basis: '基本保险金额、给付比例',
    basisKey: 'basic_amount',
    calculationKey: 'basic_amount',
    calculationEligible: false,
    calculationReason: '缺少给付比例',
  }, { baseAmount: 100000 });

  assert.equal(result.resolved, false);
  assert.equal(result.partial, true);
  assert.equal(result.amount, 0);
  assert.match(result.calculationText, /基本保险金额100,000元/u);
  assert.match(result.calculationText, /条款公式：测试给付金 = 基本保险金额 × 给付比例/u);
  assert.match(result.calculationText, /缺少给付比例/u);
});
