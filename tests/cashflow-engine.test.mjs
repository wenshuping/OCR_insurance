// tests/cashflow-engine.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseConditionYearRange,
  expandCashflowIndicator,
  buildScenarioEntries,
  buildPolicyCashflowPlans,
  buildMemberAnnualSummaries,
} from '../src/cashflow-engine.mjs';

test('parseConditionYearRange: 生效满5年', () => {
  const result = parseConditionYearRange('生效满5年首个周年日到养老年金开始前', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result.startYear, 2030);
  assert.equal(result.endYear, 2042);
});

test('parseConditionYearRange: 55周岁后首个保单周年日', () => {
  const result = parseConditionYearRange('女性55周岁后首个保单周年日到届满前', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result.startYear, 2043);
  assert.equal(result.endYear, 2072);
});

test('parseConditionYearRange: 保障期满', () => {
  const result = parseConditionYearRange('保障期满', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result.startYear, 2073);
  assert.equal(result.endYear, 2073);
});

test('parseConditionYearRange: 未知 condition 返回 null', () => {
  const result = parseConditionYearRange('完全无法识别的文本', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result, null);
});

test('expandCashflowIndicator: 盛世恒盈年金生存金 13 条', () => {
  const indicator = {
    coverageType: '现金流', liability: '生存保险金',
    value: null, unit: '公式', basis: '基本保额',
    formulaText: '生存保险金 = 基本保额',
    condition: '生效满5年首个周年日到养老年金开始前',
  };
  const policy = {
    id: 1, name: '盛世恒盈年金', company: '新华保险',
    insured: '温舒萍', insuredBirthday: '1988-12-16',
    date: '2025-12-22', amount: 1465, firstPremium: 11000,
    paymentPeriod: '10年', coveragePeriod: '至85周岁',
  };
  const entries = expandCashflowIndicator(indicator, policy);
  assert.equal(entries.length, 13);
  assert.equal(entries[0].year, 2030);
  assert.equal(entries[0].amount, 1465);
  assert.equal(entries[12].year, 2042);
  assert.equal(entries[12].cumulative, 19045);
});

test('expandCashflowIndicator: 满期生存保险金 1 条', () => {
  const indicator = {
    coverageType: '现金流', liability: '满期生存保险金',
    value: null, unit: '公式', basis: '已交保费',
    formulaText: '满期生存保险金 = 实际交纳保险费',
    condition: '保障期满',
  };
  const policy = {
    id: 1, name: '盛世恒盈年金', company: '新华保险',
    insured: '温舒萍', insuredBirthday: '1988-12-16',
    date: '2025-12-22', amount: 1465, firstPremium: 11000,
    paymentPeriod: '10年', coveragePeriod: '至85周岁',
  };
  const entries = expandCashflowIndicator(indicator, policy);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2073);
  assert.equal(entries[0].amount, 110000);
  assert.equal(entries[0].liability, '满期生存保险金');
});

test('buildScenarioEntries: 畅行万里意外场景 9 条', () => {
  const indicators = [
    { coverageType: '意外保障', liability: '一般意外身故/全残', value: 10, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 10', condition: '' },
    { coverageType: '意外保障', liability: '步行/骑行交通意外', value: 15, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 15', condition: '' },
    { coverageType: '意外保障', liability: '客运列车/航空意外', value: 60, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 60', condition: '' },
  ];
  const policy = {
    id: 2, name: '畅行万里智赢版两全保险', company: '新华保险',
    amount: 60000, firstPremium: 3156, paymentPeriod: '10年',
  };
  const entries = buildScenarioEntries(indicators, policy);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].amount, 600000);
  assert.equal(entries[1].amount, 900000);
  assert.equal(entries[2].amount, 3600000);
});

test('buildScenarioEntries: 安鑫护理 3 条含现金价值标记', () => {
  const indicators = [
    { coverageType: '疾病保障', liability: '护理金(18岁前)', value: null, unit: '公式', basis: '已交保费', formulaText: '实际交纳保险费，现金价值不展示', condition: '18岁前' },
    { coverageType: '疾病保障', liability: '护理金(18-61岁)', value: 1.6, unit: '倍', basis: '已交保费', formulaText: '实际交纳保险费 × 160%，现金价值不展示', condition: '18-61岁' },
    { coverageType: '疾病保障', liability: '护理金(61岁后)', value: 1.2, unit: '倍', basis: '已交保费', formulaText: 'max(实际交纳保险费 × 120%, 基本保额)，现金价值不展示', condition: '61岁后' },
  ];
  const policy = {
    id: 4, name: '安鑫优选终身护理', company: '新华保险',
    amount: 60312, firstPremium: 2400, paymentPeriod: '10年',
  };
  const entries = buildScenarioEntries(indicators, policy);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].amount, 24000);
  assert.equal(entries[1].amount, 38400);
  assert.equal(entries[2].amount, 60312);
});

test('buildPolicyCashflowPlans: 盛世恒盈年金完整计划', () => {
  const policies = [{
    id: 1, name: '盛世恒盈年金', company: '新华保险',
    insured: '温舒萍', insuredBirthday: '1988-12-16',
    date: '2025-12-22', amount: 1465, firstPremium: 11000,
    paymentPeriod: '10年', coveragePeriod: '至85周岁',
    coverageIndicators: [
      { coverageType: '现金流', liability: '生存保险金', value: null, unit: '公式', basis: '基本保额', formulaText: '生存保险金 = 基本保额', condition: '生效满5年首个周年日到养老年金开始前' },
      { coverageType: '现金流', liability: '养老年金', value: null, unit: '公式', basis: '基本保额', formulaText: '养老年金 = 基本保额', condition: '女性55周岁后首个保单周年日到届满前' },
      { coverageType: '现金流', liability: '满期生存保险金', value: null, unit: '公式', basis: '已交保费', formulaText: '满期生存保险金 = 实际交纳保险费', condition: '保障期满' },
    ],
    responsibilities: [],
  }];
  const plans = buildPolicyCashflowPlans(policies);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].annualEntries.length, 44); // 13 + 30 + 1
  assert.equal(plans[0].totalDeterministicCashflow, 172995);
  assert.equal(plans[0].expired, false);
});

test('buildMemberAnnualSummaries: 合并同年领取', () => {
  const plans = [
    {
      policyId: 1, productName: 'A', company: 'X', insured: '温舒萍',
      insuredBirthday: '1988-12-16', effectiveDate: '2025-12-22', expired: false,
      annualEntries: [
        { year: 2030, age: 42, amount: 1000, cumulative: 1000, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
        { year: 2031, age: 43, amount: 1000, cumulative: 2000, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
      ],
      scenarioEntries: [], totalDeterministicCashflow: 2000,
    },
    {
      policyId: 2, productName: 'B', company: 'X', insured: '温舒萍',
      insuredBirthday: '1988-12-16', effectiveDate: '2025-01-01', expired: false,
      annualEntries: [
        { year: 2030, age: 42, amount: 500, cumulative: 500, liability: '年金', policyId: 2, productName: 'B', calculationText: '' },
      ],
      scenarioEntries: [], totalDeterministicCashflow: 500,
    },
  ];
  const summaries = buildMemberAnnualSummaries(plans);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].member, '温舒萍');
  assert.equal(summaries[0].entries.length, 2);
  assert.equal(summaries[0].entries[0].totalAmount, 1500); // 1000 + 500
  assert.equal(summaries[0].entries[0].details.length, 2);
  assert.equal(summaries[0].entries[1].totalAmount, 1000);
  assert.equal(summaries[0].entries[1].cumulative, 2500); // 1500 + 1000
});

test('buildMemberAnnualSummaries: 排除已过期保单', () => {
  const plans = [
    {
      policyId: 3, productName: 'Expired', company: 'X', insured: '冯力',
      insuredBirthday: '1987-12-07', effectiveDate: '2020-01-01', expired: true,
      annualEntries: [
        { year: 2025, age: 38, amount: 100, cumulative: 100, liability: 'x', policyId: 3, productName: 'Expired', calculationText: '' },
      ],
      scenarioEntries: [], totalDeterministicCashflow: 100,
    },
  ];
  const summaries = buildMemberAnnualSummaries(plans);
  assert.equal(summaries.length, 0);
});
