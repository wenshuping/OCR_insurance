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

test('imported basic_sum_insured indicators use the policy basic amount', () => {
  const indicator = {
    coverageType: '意外保障',
    liability: '身故保险金',
    triggerCondition: '被保险人在保险责任有效期内身故',
    basis: '按本合同载明的该被保险人对应的基本保险金额给付身故保险金，同时对该被保险人的保险责任终止。',
    formulaText: '基本保险金额由投保时约定，并在保险单中载明。',
    normalizedFormula: 'basic_sum_insured',
    unit: '公式',
    calculationKey: 'direct_value',
    calculationEligible: false,
  };

  const result = resolveIndicatorAmountFromCalculation(indicator, { baseAmount: 10000 });

  assert.equal(result.resolved, true);
  assert.equal(result.amount, 10000);
  assert.match(result.calculationText, /10,000/u);
});

test('policy-parameter payout branches select an official payment-period ratio', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '关爱金',
    formulaText: '关爱金 = 首次交纳保险费的金额 × 关爱金给付比例',
    normalizedFormula: 'benefit_amount = first_premium * payout_ratio',
    branchSemanticContract: 'official-policy-parameter-branches',
    branches: [
      { condition: '保险单载明的交费方式为一次交清', normalizedFormula: 'benefit_amount = first_premium * 0.2' },
      { condition: '保险单载明的交费期间为3年', normalizedFormula: 'benefit_amount = first_premium * 0.6' },
      { condition: '保险单载明的交费期间为5年', normalizedFormula: 'benefit_amount = first_premium * 1' },
    ],
  }, { firstPremium: 10000, paymentPeriod: '3年交' });

  assert.equal(result.resolved, true);
  assert.equal(result.amount, 6000);
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

test('monthly premium frequency expands cumulative premium periods without changing annual premium formulas', () => {
  const monthly = resolveIndicatorAmountFromCalculation({
    coverageType: '现金流',
    liability: '满期保险金',
    basis: '已交保险费',
    formulaText: '满期保险金 = 已交保险费',
  }, { firstPremium: 1000, paymentYears: 10, paymentFrequency: 'monthly' });
  assert.equal(monthly.amount, 120000);

  const annual = resolveIndicatorAmountFromCalculation({
    coverageType: '现金流',
    liability: '满期保险金',
    basis: '已交保险费',
    formulaText: '满期保险金 = 已交保险费',
  }, { firstPremium: 1000, paymentYears: 10, paymentFrequency: 'annual' });
  assert.equal(annual.amount, 10000);
});

test('policy-anniversary basic responsibility amount is not reduced to the initial basic amount', () => {
  const indicator = {
    coverageType: '现金流',
    liability: '生存保险金',
    value: 9,
    unit: '%',
    basis: '基本责任保险金额',
    formulaText: '生存保险金 = 基本责任保险金额 × 9%',
    sourceExcerpt: '被保险人生存，本公司按该保单生效对应日基本责任的保险金额的9%给付生存保险金。',
  };

  const meta = normalizeIndicatorCalculation(indicator);
  assert.equal(meta.basisKey, 'policy_anniversary_basic_amount');
  assert.equal(meta.calculationKey, 'schedule_or_policy_table');
  assert.equal(meta.calculationEligible, false);
  assert.match(meta.calculationReason, /分红型.*增额红利/u);
  assert.deepEqual(requiredCalculationInputsForMeta(meta), ['policyScheduleTable', 'policyYearOrAge']);

  const result = resolveIndicatorAmountFromCalculation(indicator, { baseAmount: 88998 });
  assert.equal(result.resolved, false);
  assert.equal(result.amount, 0);
});

test('scheduled cashflow branches are not treated as claim-event branches', () => {
  const meta = normalizeIndicatorCalculation({
    liability: '生存保险金',
    formulaText: '生存保险金 = 该保单生效对应日基本责任保险金额 × 9%',
    sourceExcerpt: '被保险人生存，本公司按该保单生效对应日基本责任的保险金额的9%给付生存保险金。',
    branches: [{
      branchId: 'before_age_60',
      formulaText: '该保单生效对应日基本责任保险金额 × 9%',
    }],
  });

  assert.equal(meta.basisKey, 'policy_anniversary_basic_amount');
  assert.equal(meta.calculationKey, 'schedule_or_policy_table');
  assert.equal(meta.calculationEligible, false);
});

test('payout-frequency branches substitute the basic amount without inventing a monthly factor', () => {
  const result = resolveIndicatorAmountFromCalculation({
    coverageType: '现金流',
    liability: '养老年金',
    formulaText: '养老年金：按年领取，每年领取金额为基本保险金额；按月领取，每月领取金额为基本保险金额 × 月领折算系数。',
    basis: '基本保险金额',
    normalizedFormula: 'benefit_amount = basic_insured_amount',
    branches: [
      {
        branchId: 'annual',
        condition: '按年领取',
        formulaText: '每年领取金额 = 基本保险金额',
        normalizedFormula: 'benefit_amount = basic_insured_amount',
      },
      {
        branchId: 'monthly',
        condition: '按月领取',
        formulaText: '每月领取金额 = 基本保险金额 × 月领折算系数',
        normalizedFormula: 'benefit_amount = basic_insured_amount * monthly_conversion_factor',
      },
    ],
    branchSemanticContract: 'official-payout-frequency-branches',
  }, { baseAmount: 98878 });

  assert.equal(result.resolved, false);
  assert.equal(result.partial, true);
  assert.equal(result.hasBranchScenarios, true);
  assert.match(result.calculationText, /按年领取.*98,878/u);
  assert.match(result.calculationText, /按月领取.*每月领取金额/u);
  assert.match(result.calculationText, /月领折算系数（待补充）/u);
  assert.doesNotMatch(result.calculationText, /benefit amount/iu);
});

test('payout-frequency branches use an explicitly evidenced monthly conversion factor', () => {
  const result = resolveIndicatorAmountFromCalculation({
    coverageType: '现金流',
    liability: '养老年金',
    formulaText: '养老年金：按年领取，每年领取金额为基本保险金额；按月领取，每月领取金额为基本保险金额 × 0.085。',
    normalizedFormula: 'benefit_amount = basic_insured_amount',
    branches: [
      { condition: '按年领取', normalizedFormula: 'benefit_amount = basic_insured_amount' },
      { condition: '按月领取', normalizedFormula: 'benefit_amount = basic_insured_amount * 0.085' },
    ],
    branchSemanticContract: 'official-payout-frequency-branches',
  }, { baseAmount: 98878 });

  assert.equal(result.isMinimumEstimate, true);
  assert.equal(result.amount, 8404.63);
  assert.match(result.calculationText, /按月领取.*8,404\.63/u);
  assert.match(result.calculationText, /最低可确认金额 8,404\.63元/u);
  assert.match(result.calculationText, /98,878.*0\.085/u);
  assert.doesNotMatch(result.calculationText, /= 8,404\.63元 = 8,404\.63元/u);
});

test('selected benefit frequency resolves only the requested payout branch', () => {
  const indicator = {
    coverageType: '现金流',
    liability: '养老年金',
    normalizedFormula: 'benefit_amount = basic_insured_amount',
    branches: [
      { condition: '按年领取', normalizedFormula: 'benefit_amount = basic_insured_amount' },
      { condition: '按月领取', normalizedFormula: 'benefit_amount = basic_insured_amount * 0.085' },
    ],
    branchSemanticContract: 'official-payout-frequency-branches',
  };

  const monthly = resolveIndicatorAmountFromCalculation(indicator, { baseAmount: 98878, benefitFrequency: 'monthly' });
  assert.equal(monthly.resolved, true);
  assert.equal(monthly.amount, 8404.63);
  assert.match(monthly.calculationText, /按月领取/u);

  const annual = resolveIndicatorAmountFromCalculation(indicator, { baseAmount: 98878, benefitFrequency: 'annual' });
  assert.equal(annual.resolved, true);
  assert.equal(annual.amount, 98878);
  assert.match(annual.calculationText, /按年领取/u);
});

test('payout-frequency summary prose preserves its official annual and monthly calculation branches', () => {
  const indicator = {
    liability: '养老年金',
    formulaText: '养老年金：按年领取，每年领取金额为基本保险金额；按月领取，每月领取金额为基本保险金额 × 月领折算系数。上述月领折算系数的数值为0.085。',
    basis: '养老年金：按年领取，每年领取金额为基本保险金额；按月领取，每月领取金额为基本保险金额 × 月领折算系数。上述月领折算系数的数值为0.085。',
    calculationEligible: false,
  };

  const minimum = resolveIndicatorAmountFromCalculation(indicator, { baseAmount: 89998 });
  assert.equal(minimum.resolved, false);
  assert.equal(minimum.isMinimumEstimate, true);
  assert.equal(minimum.amount, 7649.83);
  assert.match(minimum.calculationText, /按年领取.*89,998/u);
  assert.match(minimum.calculationText, /按月领取.*7,649\.83/u);

  const annual = resolveIndicatorAmountFromCalculation(indicator, { baseAmount: 89998, benefitFrequency: 'annual' });
  assert.equal(annual.resolved, true);
  assert.equal(annual.amount, 89998);

  const monthly = resolveIndicatorAmountFromCalculation(indicator, { baseAmount: 89998, benefitFrequency: 'monthly' });
  assert.equal(monthly.resolved, true);
  assert.equal(monthly.amount, 7649.83);
});

test('premium-waiver conditions remain rule parameters instead of claim-event calculations', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '豁免',
    liability: '投保人意外伤害身故或意外伤害身体全残豁免保险费',
    formulaText: '豁免保险费 = 事故日起基本责任后续应交保险费',
    sourceExcerpt: '投保人因意外伤害身故或身体全残，可免交事故日起基本责任的续期保险费。',
  });

  assert.equal(meta.basisKey, 'rule_parameter');
  assert.equal(meta.calculationKey, 'not_calculable');
  assert.equal(meta.calculationEligible, false);
});

test('normalizeIndicatorCalculation keeps policy-anniversary amount separate from initial basic amount', () => {
  const indicator = {
    coverageType: '现金流',
    liability: '生存保险金',
    value: 9,
    unit: '%',
    basis: '保单生效对应日基本责任保险金额',
    formulaText: '生存保险金 = 保单生效对应日基本责任保险金额 × 9%',
    sourceExcerpt: '本公司按该保单生效对应日基本责任的保险金额的9%给付生存保险金。',
  };

  const meta = normalizeIndicatorCalculation(indicator);
  assert.equal(meta.basisKey, 'policy_anniversary_basic_amount');
  assert.equal(meta.calculationKey, 'schedule_or_policy_table');
  assert.equal(meta.calculationEligible, false);
  assert.match(meta.calculationReason, /分红型增额红利/u);

  const result = resolveIndicatorAmountFromCalculation(indicator, {
    baseAmount: 88998,
    firstPremium: 12000,
    paymentYears: 10,
  });
  assert.equal(result.resolved, false);
  assert.equal(result.amount, 0);
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

test('normalizeIndicatorCalculation does not collapse tiered percentages into one value', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '人寿保障',
    liability: '身故或高残保险金',
    basis: '累计已交保险费、现金价值和年龄分段比例',
    formulaText: '18至41周岁前取累计已交保险费160%与现金价值较大者；41至61周岁前取140%与现金价值较大者；61周岁后取120%与现金价值较大者。',
  });

  assert.equal(meta.value, null);
  assert.equal(meta.calculationEligible, false);
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

test('normalizeIndicatorCalculation does not classify scheduled survival branches as claim events', () => {
  const meta = normalizeIndicatorCalculation({
    coverageType: '意外保障',
    liability: '生存保险金',
    triggerCondition: '被保险人在每一保单生效对应日零时生存',
    formulaText: '基本责任的保险金额×给付比例（5%或10%）',
    sourceExcerpt: '被保险人于本合同生效满三年起至60周岁保单生效对应日之前，在每一保单生效对应日零时生存，按基本责任的保险金额的5%给付；被保险人于60周岁保单生效对应日起至80周岁期间，按基本责任的保险金额的10%给付。',
    branches: [{
      branchId: 'surv_branch_1',
      conditionText: '本合同生效满三年起至60周岁保单生效对应日之前',
      formulaText: '基本责任的保险金额的5%',
    }, {
      branchId: 'surv_branch_2',
      conditionText: '60周岁保单生效对应日起至80周岁保单生效对应日期间',
      formulaText: '基本责任的保险金额的10%',
    }],
  });

  assert.notEqual(meta.calculationKey, 'claim_event_facts');
  assert.doesNotMatch(meta.calculationReason, /出险原因|出险日期/u);
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

test('substitutes known rider inputs into a display-only formula without inventing a prior paid benefit', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '意外身故保险金',
    formulaText: '意外身故保险金 = 基本保险金额 - 已给付伤残保险金',
  }, { baseAmount: 200000 });

  assert.equal(result.resolved, false);
  assert.equal(result.partial, true);
  assert.match(result.calculationText, /意外身故保险金 = 200,000 - 已给付保险金（待补充）/u);
  assert.match(result.calculationText, /暂不计算/u);
});

test('evaluates a display-only rider formula with all known arithmetic inputs', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '示例附加险保险金',
    formulaText: '示例附加险保险金 = (基本保险金额 + 首期保费 ÷ 10) ^ 2 + √(缴费年期)',
  }, { baseAmount: 100, firstPremium: 50, paymentYears: 9 });

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

test('evaluates effective insured amount when the official dividend operand is supplied', () => {
  const formulaVariables = formulaVariablesFromIndicators([{
    normalizedFormula: 'effective_insured_amount = basic_insured_amount + accumulated_dividend_insured_amount',
  }]);
  const result = resolveIndicatorAmountFromCalculation({
    liability: '养老金',
    normalizedFormula: 'pension_amount = effective_insured_amount * 1.0',
    formulaText: '按该保单生效对应日有效保险金额给付养老金',
  }, {
    baseAmount: 200000,
    accumulatedDividendInsuredAmount: 18000,
    formulaVariables,
  });

  assert.equal(result.resolved, true);
  assert.equal(result.amount, 218000);
  assert.match(result.calculationText, /200,000 \+ 18,000/u);
});

test('projects a plain effective insured amount clause as a one-times operand', () => {
  const pending = resolveIndicatorAmountFromCalculation({
    liability: '养老年金',
    formulaText: '按该保单生效对应日有效保险金额给付养老年金',
  }, { baseAmount: 200000 });
  assert.equal(pending.resolved, false);
  assert.equal(pending.isMinimumEstimate, true);
  assert.equal(pending.minimumAmount, 200000);

  const resolved = resolveIndicatorAmountFromCalculation({
    liability: '养老年金',
    formulaText: '按该保单生效对应日有效保险金额给付养老年金',
  }, { effectiveInsuranceAmount: 218000 });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.amount, 218000);
});

test('keeps effective insured amount pending instead of displaying a false zero when its operand is absent', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '养老金',
    formulaText: '有效保险金额 × 100%给付养老金',
    value: 100,
    unit: '%',
    basisDefinition: {
      formulaText: '基本保险金额 + 累计红利保险金额',
    },
  }, { baseAmount: 200000 });

  assert.equal(result.resolved, false);
  assert.equal(result.amount, 0);
  assert.equal(result.minimumAmount, 200000);
  assert.equal(result.isMinimumEstimate, true);
  assert.match(result.calculationText, /最低可确认金额 200,000元/u);
  assert.doesNotMatch(result.calculationText, /已按本保单计算：?¥?0/u);
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
  assert.match(maturity.calculationText, /满期生存保险金 = \(200,000 \+ 累计红利保险金额（待补充）\)/u);
  assert.equal(death.resolved, false);
  assert.equal(death.partial, true);
  assert.equal(death.isMinimumEstimate, undefined);
  assert.equal(death.hasBranchScenarios, true);
  assert.match(death.calculationText, /首年疾病导致身故或全残：基本保险金额200,000元 × 10% \+ 当前累计已交保费0元 = 20,000元/u);
  assert.match(death.calculationText, /满一年后疾病导致身故或全残：（基本保险金额200,000元 \+ 累计红利保险金额（待补充））× 2；最低可确认金额 400,000元/u);
  assert.match(death.calculationText, /未计入统计/u);
  assert.deepEqual(requiredCalculationInputsForMeta(death.meta), ['eventCause', 'eventDate']);
});

test('scheduled survival branches are calculated as age-stage scenarios without claim-event inputs', () => {
  const result = resolveIndicatorAmountFromCalculation({
    liability: '生存保险金',
    formulaText: '基本责任的保险金额×给付比例（5%或10%）',
    basisKey: 'piecewise',
    calculationKey: 'piecewise',
    branches: [
      {
        branchId: 'surv_branch_1',
        conditionText: '本合同生效满三年起至60周岁保单生效对应日之前',
        formulaText: '基本责任的保险金额的5%',
        basisKey: 'basic_sum_assured',
      },
      {
        branchId: 'surv_branch_2',
        conditionText: '60周岁保单生效对应日起至80周岁保单生效对应日期间',
        formulaText: '基本责任的保险金额的10%',
        basisKey: 'basic_sum_assured',
      },
    ],
  }, { baseAmount: 89877 });

  assert.equal(result.resolved, false);
  assert.equal(result.partial, true);
  assert.equal(result.hasBranchScenarios, true);
  assert.equal(result.scenarioKind, 'scheduled_benefit');
  assert.match(result.calculationText, /领取阶段测算/u);
  assert.match(result.calculationText, /89,877元 × 5% = 4,493\.85元/u);
  assert.match(result.calculationText, /89,877元 × 10% = 8,987\.7元/u);
  assert.doesNotMatch(result.calculationText, /出险/u);
  assert.doesNotMatch(result.uncertaintyNote, /出险原因|出险日期/u);
  assert.deepEqual(requiredCalculationInputsForMeta(result.meta), ['policy.amount', 'policyYearOrAge']);
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
  assert.match(result.calculationText, /测试给付金 = 100,000 × 给付比例（待补充）/u);
  assert.match(result.calculationText, /缺少给付比例/u);
});
