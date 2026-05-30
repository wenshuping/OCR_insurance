import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFamilyReport,
  buildFamilyReportSummary,
  buildPolicyInventory,
} from '../src/family-report-engine.mjs';

function makePolicy(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    company: overrides.company ?? '新华保险',
    name: overrides.name ?? '健康无忧重大疾病保险',
    applicant: overrides.applicant ?? '投保人',
    beneficiary: overrides.beneficiary ?? '法定',
    applicantRelation: overrides.applicantRelation ?? '本人',
    insured: overrides.insured ?? '妈妈',
    insuredRelation: overrides.insuredRelation ?? '本人',
    insuredBirthday: overrides.insuredBirthday ?? '1988-12-16',
    date: overrides.date ?? '2025-12-22',
    paymentPeriod: overrides.paymentPeriod ?? '20年',
    coveragePeriod: overrides.coveragePeriod ?? '终身',
    amount: overrides.amount ?? 500000,
    firstPremium: overrides.firstPremium ?? 8600,
    plans: overrides.plans ?? [],
    ocrText: overrides.ocrText ?? '',
    responsibilities: overrides.responsibilities ?? [],
    coverageIndicators: overrides.coverageIndicators ?? [],
    report: overrides.report ?? '',
    reportStatus: overrides.reportStatus ?? 'ready',
    createdAt: overrides.createdAt ?? '2026-05-30T00:00:00.000Z',
    cashflowEntries: overrides.cashflowEntries ?? [],
    scenarioEntries: overrides.scenarioEntries ?? [],
    totalCashflow: overrides.totalCashflow ?? 0,
    cashValues: overrides.cashValues ?? [],
  };
}

test('buildFamilyReportSummary counts members, policies, premiums, coverage, cash value, and payouts', () => {
  const policies = [
    makePolicy({
      id: 1,
      insured: '爸爸',
      amount: 500000,
      firstPremium: 8600,
      cashValues: [{ policyYear: 1, age: 38, cashValue: 1000 }, { policyYear: 2, age: 39, cashValue: 2300 }],
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
      ],
    }),
    makePolicy({
      id: 2,
      insured: '妈妈',
      amount: 300000,
      firstPremium: 19600,
      cashValues: [{ policyYear: 1, age: 37, cashValue: 282 }, { policyYear: 2, age: 38, cashValue: 663 }],
      cashflowEntries: [
        { year: 2073, age: 85, amount: 110100, cumulative: 173095, liability: '满期金', policyId: 2, productName: 'B', calculationText: '' },
      ],
    }),
  ];

  const summary = buildFamilyReportSummary(policies);
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.policyCount, 2);
  assert.equal(summary.annualPremium, 28200);
  assert.equal(summary.totalCoverage, 800000);
  assert.equal(summary.cashValueTotal, 2963);
  assert.equal(summary.futurePayoutTotal, 111565);
  assert.deepEqual(summary.attentionItems, []);
});

test('buildPolicyInventory creates top inventory rows and insured detail groups', () => {
  const policies = [
    makePolicy({
      id: 1,
      insured: '妈妈',
      company: '新华保险',
      name: '盛世恒盈年金',
      firstPremium: 19600,
      amount: 0,
      paymentPeriod: '10年',
      coveragePeriod: '至85岁',
      date: '2025-12-22',
      beneficiary: '第一顺位',
      cashValues: [{ policyYear: 1, age: 37, cashValue: 282 }],
      cashflowEntries: [{ year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存金', policyId: 1, productName: '盛世恒盈年金', calculationText: '' }],
    }),
    makePolicy({
      id: 2,
      insured: '',
      company: '太平人寿',
      name: '意外险',
      firstPremium: 800,
      amount: 100000,
      reportStatus: 'generating',
    }),
  ];

  const inventory = buildPolicyInventory(policies);
  assert.equal(inventory.rows.length, 2);
  assert.equal(inventory.rows[0].member, '妈妈');
  assert.equal(inventory.rows[0].typeLabel, '财富/年金');
  assert.equal(inventory.rows[0].cashValueText, '282');
  assert.equal(inventory.rows[0].dataStatus, '现金价值已识别');
  assert.equal(inventory.rows[1].member, '未识别被保人');
  assert.equal(inventory.rows[1].dataStatus, '责任生成中');
  assert.equal(inventory.insuredGroups.length, 2);
  assert.equal(inventory.insuredGroups[0].member, '妈妈');
  assert.equal(inventory.insuredGroups[0].policies[0].beneficiary, '第一顺位');
});

test('buildPolicyInventory uses cumulative payout for coverage fallback', () => {
  const policy = makePolicy({
    amount: 0,
    cashflowEntries: [
      { year: 2030, age: 42, amount: 1000, cumulative: 1000, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
      { year: 2031, age: 43, amount: 500, cumulative: 1200, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
    ],
  });

  const summary = buildFamilyReportSummary([policy]);
  const inventory = buildPolicyInventory([policy]);

  assert.equal(summary.futurePayoutTotal, 1500);
  assert.equal(inventory.rows[0].coverageText, '累计领取1,200');
});

test('buildPolicyInventory ignores malformed cash value rows', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      id: 1,
      name: '基础保障',
      cashValues: [
        { policyYear: 1, age: 37, cashValue: 500 },
        { policyYear: 2, age: 38 },
      ],
    }),
    makePolicy({
      id: 2,
      name: '基础保障',
      amount: 0,
      cashValues: [
        { policyYear: '', age: 37, cashValue: 100 },
        { age: 38, cashValue: 'invalid' },
      ],
    }),
  ]);

  assert.equal(inventory.rows[0].cashValueText, '500');
  assert.equal(inventory.rows[0].dataStatus, '现金价值已识别');
  assert.equal(inventory.rows[1].cashValueText, '');
  assert.equal(inventory.rows[1].dataStatus, '待补充责任');
});

test('buildPolicyInventory classifies policies from responsibility fields', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      name: '基础保障',
      amount: 0,
      responsibilities: [
        { coverageType: '医疗保障', scenario: '住院', payout: '报销', note: '门诊费用' },
      ],
    }),
  ]);

  assert.equal(inventory.rows[0].typeLabel, '医疗');
});

test('buildFamilyReport includes summary and inventory sections', () => {
  const report = buildFamilyReport([makePolicy({ id: 1, insured: '爸爸' })]);
  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.policyInventory.rows.length, 1);
  assert.equal(report.policyInventory.insuredGroups[0].member, '爸爸');
});

test('buildFamilyReport creates critical illness rows per family member', () => {
  const policies = [
    makePolicy({
      id: 10,
      insured: '爸爸',
      name: '健康无忧重大疾病保险',
      amount: 500000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重疾(首次给付)', value: 100, unit: '%', basis: '基本保险金额', formulaText: '基本保额100%', productName: '健康无忧重大疾病保险' },
        { coverageType: '疾病保障', liability: '中症(首次给付)', value: 60, unit: '%', basis: '基本保险金额', formulaText: '基本保额60%', productName: '健康无忧重大疾病保险' },
        { coverageType: '疾病保障', liability: '轻症(首次给付)', value: 30, unit: '%', basis: '基本保险金额', formulaText: '基本保额30%', productName: '健康无忧重大疾病保险' },
        { coverageType: '疾病保障', liability: '特定疾病', value: 2, unit: '倍', basis: '基本保险金额', formulaText: '基本保额2倍', productName: '健康无忧重大疾病保险' },
      ],
    }),
    makePolicy({ id: 11, insured: '老人', name: '老人意外险', amount: 100000 }),
  ];

  const report = buildFamilyReport(policies);
  const father = report.criticalIllness.members.find((item) => item.member === '爸爸');
  const elder = report.criticalIllness.members.find((item) => item.member === '老人');

  assert.equal(father.rows.find((row) => row.key === 'critical_first').amountText, '50万');
  assert.equal(father.rows.find((row) => row.key === 'moderate').amountText, '30万');
  assert.equal(father.rows.find((row) => row.key === 'mild').amountText, '15万');
  assert.equal(father.rows.find((row) => row.key === 'specific_disease').amountText, '100万');
  assert.equal(elder.rows.find((row) => row.key === 'critical_first').status, 'missing');
  assert.ok(elder.attentionItems.includes('重疾首次给付缺失'));
});

test('buildFamilyReport aggregates matching critical illness indicators for one member', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 20,
      insured: '妈妈',
      name: '健康无忧重大疾病保险',
      amount: 300000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重疾首次给付', value: 100, unit: '%', basis: '基本保险金额', formulaText: '基本保额100%', productName: '健康无忧重大疾病保险' },
      ],
    }),
    makePolicy({
      id: 21,
      insured: '妈妈',
      name: '守护重大疾病保险',
      amount: 200000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', formulaText: '基本保额100%', productName: '守护重大疾病保险' },
      ],
    }),
  ]);

  const mother = report.criticalIllness.members.find((item) => item.member === '妈妈');
  const row = mother.rows.find((item) => item.key === 'critical_first');

  assert.equal(row.amountText, '50万');
  assert.equal(row.sourcePolicies.length, 2);
});

test('buildFamilyReport resolves critical illness amounts from formula text', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 30,
      insured: '孩子',
      name: '少儿重大疾病保险',
      amount: 500000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '中症保险金', formulaText: '基本保额60%', productName: '少儿重大疾病保险' },
        { coverageType: '疾病保障', liability: '轻症保险金', formulaText: '基本保险金额的30%', productName: '少儿重大疾病保险' },
        { coverageType: '疾病保障', liability: '特定疾病保险金', formulaText: '基本保额2倍', productName: '少儿重大疾病保险' },
      ],
    }),
  ]);

  const child = report.criticalIllness.members.find((item) => item.member === '孩子');

  assert.equal(child.rows.find((row) => row.key === 'moderate').amountText, '30万');
  assert.equal(child.rows.find((row) => row.key === 'mild').amountText, '15万');
  assert.equal(child.rows.find((row) => row.key === 'specific_disease').amountText, '100万');
});

test('buildFamilyReport classifies ordinal critical disease payouts as multiple', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 40,
      insured: '爸爸',
      name: '多倍保障计划',
      amount: 400000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '第二次重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', formulaText: '基本保额100%', productName: '多倍保障计划' },
        { coverageType: '疾病保障', liability: '再次重大疾病保险金', value: 50, unit: '%', basis: '基本保险金额', formulaText: '基本保额50%', productName: '多倍保障计划' },
      ],
    }),
  ]);

  const father = report.criticalIllness.members.find((item) => item.member === '爸爸');

  assert.equal(father.rows.find((row) => row.key === 'critical_multiple').amountText, '60万');
  assert.equal(father.rows.find((row) => row.key === 'critical_first').status, 'missing');
});

test('buildFamilyReport falls back to critical policy amount when unrelated indicators exist', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 50,
      insured: '妈妈',
      name: '康健重大疾病保险',
      amount: 250000,
      coverageIndicators: [
        { coverageType: '医疗保障', liability: '住院津贴', formulaText: '每日100元', productName: '康健重大疾病保险' },
      ],
    }),
  ]);

  const mother = report.criticalIllness.members.find((item) => item.member === '妈妈');
  const row = mother.rows.find((item) => item.key === 'critical_first');

  assert.equal(row.amountText, '25万');
  assert.equal(row.conditionText, '按保单基础保额估算');
  assert.equal(row.status, 'covered');
});

test('buildFamilyReport aggregates fallback amounts across critical illness policies', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 60,
      insured: '爸爸',
      name: '健康无忧重大疾病保险',
      amount: 300000,
      coverageIndicators: [],
    }),
    makePolicy({
      id: 61,
      insured: '爸爸',
      name: '守护重大疾病保险',
      amount: 200000,
      coverageIndicators: [],
    }),
  ]);

  const father = report.criticalIllness.members.find((item) => item.member === '爸爸');
  const row = father.rows.find((item) => item.key === 'critical_first');

  assert.equal(row.amountText, '50万');
  assert.equal(row.sourcePolicies.length, 2);
  assert.equal(row.status, 'covered');
});

test('buildFamilyReport keeps ordinal mild payouts in mild row', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 70,
      insured: '孩子',
      name: '轻症保障计划',
      amount: 200000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '第二次轻症保险金', value: 30, unit: '%', basis: '基本保险金额', formulaText: '基本保额30%', productName: '轻症保障计划' },
      ],
    }),
  ]);

  const child = report.criticalIllness.members.find((item) => item.member === '孩子');

  assert.equal(child.rows.find((row) => row.key === 'mild').amountText, '6万');
  assert.equal(child.rows.find((row) => row.key === 'critical_multiple').status, 'missing');
});

test('buildFamilyReport uses fallback amount when critical first indicator is unresolved', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 80,
      insured: '妈妈',
      name: '安心重大疾病保险',
      amount: 350000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重大疾病保险金', formulaText: '按条款给付', productName: '安心重大疾病保险' },
      ],
    }),
  ]);

  const mother = report.criticalIllness.members.find((item) => item.member === '妈妈');
  const row = mother.rows.find((item) => item.key === 'critical_first');

  assert.equal(row.amountText, '35万');
  assert.equal(row.status, 'covered');
  assert.equal(row.conditionText, '按保单基础保额估算');
});

test('buildFamilyReport combines parsed critical first and fallback policy amounts', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 90,
      insured: '爸爸',
      name: '健康无忧重大疾病保险',
      amount: 300000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重疾(首次给付)', value: 100, unit: '%', basis: '基本保险金额', formulaText: '基本保额100%', productName: '健康无忧重大疾病保险' },
      ],
    }),
    makePolicy({
      id: 91,
      insured: '爸爸',
      name: '守护重大疾病保险',
      amount: 200000,
      coverageIndicators: [],
    }),
  ]);

  const father = report.criticalIllness.members.find((item) => item.member === '爸爸');
  const row = father.rows.find((item) => item.key === 'critical_first');

  assert.equal(row.amountText, '50万');
  assert.deepEqual(
    row.sourcePolicies.map((policy) => policy.productName),
    ['健康无忧重大疾病保险', '守护重大疾病保险'],
  );
});

test('buildFamilyReport creates accident rows per family member without merging scenarios', () => {
  const policies = [
    makePolicy({
      id: 20,
      insured: '爸爸',
      name: '综合意外险',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故/全残', value: 10, unit: '倍', basis: '基本保险金额', formulaText: '基本保额10倍', productName: '综合意外险' },
        { coverageType: '意外保障', liability: '交通意外', value: 20, unit: '倍', basis: '基本保险金额', formulaText: '基本保额20倍', condition: '公共交通/自驾/网约车分别列', productName: '综合意外险' },
        { coverageType: '意外保障', liability: '航空意外', value: 50, unit: '倍', basis: '基本保险金额', formulaText: '基本保额50倍', productName: '综合意外险' },
        { coverageType: '意外保障', liability: '意外医疗', value: 20000, unit: '元', basis: '医疗费用', formulaText: '限额2万元', productName: '综合意外险' },
      ],
    }),
    makePolicy({ id: 21, insured: '妈妈', name: '年金保险', amount: 0 }),
  ];

  const report = buildFamilyReport(policies);
  const father = report.accident.members.find((item) => item.member === '爸爸');
  const mother = report.accident.members.find((item) => item.member === '妈妈');

  assert.equal(father.rows.find((row) => row.key === 'general_accident').amountText, '100万');
  assert.equal(father.rows.find((row) => row.key === 'traffic').amountText, '200万');
  assert.equal(father.rows.find((row) => row.key === 'aviation').amountText, '500万');
  assert.equal(father.rows.find((row) => row.key === 'accident_medical').amountText, '2万');
  assert.equal(mother.rows.find((row) => row.key === 'general_accident').status, 'missing');
});

test('buildFamilyReport keeps traffic and public transport accident rows separate', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 30,
      insured: '爸爸',
      name: '综合交通意外险',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '交通意外', value: 20, unit: '倍', basis: '基本保险金额', formulaText: '基本保额20倍', productName: '综合交通意外险' },
        { coverageType: '意外保障', liability: '公共交通', value: 30, unit: '倍', basis: '基本保险金额', formulaText: '基本保额30倍', productName: '综合交通意外险' },
      ],
    }),
  ]);

  const father = report.accident.members.find((item) => item.member === '爸爸');
  const traffic = father.rows.find((row) => row.key === 'traffic');
  const publicTransport = father.rows.find((row) => row.key === 'public_transport');

  assert.equal(traffic.amountText, '200万');
  assert.equal(publicTransport.amountText, '300万');
  assert.equal(traffic.sourcePolicies.length, 1);
  assert.equal(publicTransport.sourcePolicies.length, 1);
});

test('buildFamilyReport classifies accident responsibilities when indicators are unrelated', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 40,
      insured: '爸爸',
      name: '综合保障计划',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '医疗保障', liability: '住院医疗', value: 10000, unit: '元', basis: '医疗费用', formulaText: '限额1万元', productName: '综合保障计划' },
      ],
      responsibilities: [
        { coverageType: '意外保障', scenario: '航空意外', payout: '500万' },
      ],
    }),
  ]);

  const father = report.accident.members.find((item) => item.member === '爸爸');
  const aviation = father.rows.find((row) => row.key === 'aviation');
  const generalAccident = father.rows.find((row) => row.key === 'general_accident');

  assert.equal(aviation.amountText, '500万');
  assert.equal(generalAccident.status, 'missing');
});

test('buildFamilyReport classifies public transport and driving accident responsibilities', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 50,
      insured: '妈妈',
      name: '出行意外保障',
      amount: 100000,
      responsibilities: [
        { coverageType: '意外保障', scenario: '公共交通', payout: '200万' },
        { coverageType: '意外保障', scenario: '驾乘意外', payout: '100万' },
      ],
    }),
  ]);

  const mother = report.accident.members.find((item) => item.member === '妈妈');
  const publicTransport = mother.rows.find((row) => row.key === 'public_transport');
  const driving = mother.rows.find((row) => row.key === 'driving');

  assert.equal(publicTransport.amountText, '200万');
  assert.equal(driving.amountText, '100万');
});
