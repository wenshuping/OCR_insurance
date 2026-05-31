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
    policyNumber: overrides.policyNumber ?? '',
    reportStatus: overrides.reportStatus ?? 'ready',
    createdAt: overrides.createdAt ?? '2026-05-30T00:00:00.000Z',
    cashflowEntries: overrides.cashflowEntries ?? [],
    scenarioEntries: overrides.scenarioEntries ?? [],
    totalCashflow: overrides.totalCashflow ?? 0,
    cashValues: overrides.cashValues ?? [],
  };
}

function radarScore(series, key) {
  return series.scores.find((score) => score.key === key);
}

function radarMember(report, name) {
  return report.radar.members.find((member) => member.name === name);
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
      policyNumber: '88775671973',
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
  assert.equal(inventory.rows[0].policyNumber, '88775671973');
  assert.equal(inventory.rows[0].typeLabel, '年金');
  assert.equal(inventory.rows[0].cashValueText, '282');
  assert.equal(inventory.rows[0].dataStatus, '现金价值已识别');
  assert.equal(inventory.rows[1].member, '未识别被保人');
  assert.equal(inventory.rows[1].dataStatus, '责任生成中');
  assert.equal(inventory.insuredGroups.length, 2);
  assert.equal(inventory.insuredGroups[0].member, '妈妈');
  assert.equal(inventory.insuredGroups[0].policies[0].beneficiary, '第一顺位');
  assert.equal(inventory.insuredGroups[0].policies[0].totalPremiumText, '196,000');
});

test('buildPolicyInventory separates whole life wealth from annuity label', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      id: 1,
      insured: '温舒萍',
      name: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
      firstPremium: 3000,
      amount: 24410,
    }),
  ]);

  assert.equal(inventory.rows[0].typeLabel, '财富/终身寿');
});

test('buildPolicyInventory computes total premium from payment years', () => {
  const inventory = buildPolicyInventory([
    makePolicy({ id: 1, firstPremium: 8600, paymentPeriod: '10年' }),
    makePolicy({ id: 2, firstPremium: 12000, paymentPeriod: '趸交' }),
    makePolicy({ id: 3, firstPremium: 5000, paymentPeriod: '' }),
  ]);

  assert.equal(inventory.rows[0].totalPremiumText, '86,000');
  assert.equal(inventory.rows[1].totalPremiumText, '12,000');
  assert.equal(inventory.rows[2].totalPremiumText, '待识别');
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

test('buildFamilyReport creates amount-based family radar using real amounts', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 101,
      insured: '妈妈',
      name: '重大疾病保险',
      amount: 500000,
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '重大疾病保险' },
      ],
    }),
    makePolicy({
      id: 102,
      insured: '爸爸',
      name: '综合意外保险',
      amount: 250000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故保险金', value: 250000, unit: '元', basis: '意外身故保额', productName: '综合意外保险' },
      ],
    }),
    makePolicy({
      id: 103,
      insured: '孩子',
      name: '百万医疗保险',
      amount: 0,
      coverageIndicators: [
        { coverageType: '医疗保障', liability: '住院医疗费用保险金', value: 100000, unit: '元', basis: '医疗费用限额', productName: '百万医疗保险' },
      ],
    }),
    makePolicy({
      id: 104,
      insured: '妈妈',
      name: '终身寿险',
      amount: 1000000,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '身故保险金', value: 1000000, unit: '元', basis: '身故保额', productName: '终身寿险' },
      ],
    }),
    makePolicy({
      id: 105,
      insured: '爸爸',
      name: '年金保险',
      amount: 0,
      cashValues: [{ policyYear: 1, cashValue: 80000 }, { policyYear: 2, cashValue: 150000 }],
      cashflowEntries: [
        { year: 2030, age: 42, amount: 30000, cumulative: 30000, liability: '生存金', policyId: 105, productName: '年金保险' },
        { year: 2031, age: 43, amount: 20000, cumulative: 50000, liability: '生存金', policyId: 105, productName: '年金保险' },
      ],
    }),
  ]);

  assert.deepEqual(report.radar.dimensions.map((dimension) => dimension.label), ['重疾', '意外', '医疗', '寿险', '财富']);
  assert.equal(radarScore(report.radar.family, 'critical').amount, 500000);
  assert.equal(radarScore(report.radar.family, 'accident').amount, 250000);
  assert.equal(radarScore(report.radar.family, 'medical').amount, 100000);
  assert.equal(radarScore(report.radar.family, 'life').amount, 1000000);
  assert.equal(radarScore(report.radar.family, 'wealth').amount, 200000);
  assert.equal(radarScore(report.radar.family, 'life').score, 100);
  assert.equal(radarScore(report.radar.family, 'critical').score, 50);
  assert.equal(radarScore(report.radar.family, 'accident').score, 25);
  assert.equal(radarScore(report.radar.family, 'medical').score, 10);
  assert.equal(radarScore(report.radar.family, 'wealth').score, 20);
  assert.match(radarScore(report.radar.family, 'wealth').note, /现金价值150,000/);
  assert.match(radarScore(report.radar.family, 'wealth').note, /未来领取50,000/);
});

test('buildFamilyReport normalizes member radar by dimension and limits displayed members', () => {
  const report = buildFamilyReport([
    makePolicy({ id: 201, insured: '妈妈', name: '妈妈重疾', amount: 1000000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '妈妈重疾' }] }),
    makePolicy({ id: 202, insured: '爸爸', name: '爸爸重疾', amount: 800000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '爸爸重疾' }] }),
    makePolicy({ id: 203, insured: '孩子', name: '孩子重疾', amount: 600000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '孩子重疾' }] }),
    makePolicy({ id: 204, insured: '老人', name: '老人重疾', amount: 400000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '老人重疾' }] }),
    makePolicy({ id: 205, insured: '未成年二', name: '未成年二', amount: 0 }),
  ]);

  assert.equal(report.radar.members.length, 4);
  assert.deepEqual(report.radar.members.map((member) => member.name), ['妈妈', '爸爸', '孩子', '未成年二']);
  assert.deepEqual(report.radar.hiddenMembers.map((member) => member.name), ['老人']);
  assert.equal(radarScore(radarMember(report, '妈妈'), 'critical').score, 100);
  assert.equal(radarScore(radarMember(report, '爸爸'), 'critical').score, 80);
  assert.equal(radarScore(radarMember(report, '孩子'), 'critical').score, 60);
  assert.equal(radarScore(radarMember(report, '未成年二'), 'critical').score, 0);
});

test('buildFamilyReport keeps formula-only radar amounts out of numeric radar value', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 301,
      insured: '妈妈',
      name: '公式型寿险',
      amount: 0,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '身故保险金', unit: '公式', basis: '已交保费', formulaText: '取已交保费、现金价值、基本保额较大者', productName: '公式型寿险' },
      ],
    }),
  ]);

  const life = radarScore(report.radar.family, 'life');
  assert.equal(life.amount, 0);
  assert.equal(life.score, 0);
  assert.equal(life.amountText, '0元');
  assert.match(life.note, /公式型待确认/);
});

test('buildFamilyReport sums distinct accident radar scenarios from one policy', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 401,
      insured: '爸爸',
      name: '综合交通意外保险',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故保险金', value: 100000, unit: '元', basis: '一般意外保额', productName: '综合交通意外保险' },
        { coverageType: '意外保障', liability: '一般意外身故保险金', value: 80000, unit: '元', basis: '一般意外保额', productName: '综合交通意外保险' },
        { coverageType: '意外保障', liability: '航空意外身故保险金', value: 500000, unit: '元', basis: '航空意外保额', productName: '综合交通意外保险' },
        { coverageType: '意外保障', liability: '意外医疗费用保险金', value: 20000, unit: '元', basis: '医疗费用限额', productName: '综合交通意外保险' },
      ],
    }),
  ]);

  const accident = radarScore(report.radar.family, 'accident');
  assert.equal(accident.amount, 600000);
  assert.equal(accident.policyCount, 1);
  assert.match(accident.note, /一般意外身故保险金100,000/);
  assert.match(accident.note, /航空意外身故保险金500,000/);
});

test('buildFamilyReport counts one combined accident liability once even when it matches multiple traffic classes', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 402,
      insured: '爸爸',
      name: '综合交通意外保险',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '航空公共交通意外身故保险金', value: 500000, unit: '元', basis: '航空公共交通意外保额', productName: '综合交通意外保险' },
      ],
    }),
  ]);

  const accident = radarScore(report.radar.family, 'accident');
  assert.equal(accident.amount, 500000);
  assert.equal(accident.policyCount, 1);
  assert.match(accident.note, /航空公共交通意外身故保险金500,000/);
});

test('buildFamilyReport keeps same accident liability with different scenarios separate', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 403,
      insured: '爸爸',
      name: '综合交通意外保险',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '交通意外身故保险金', scenario: '航空', value: 500000, unit: '元', basis: '航空交通意外保额', productName: '综合交通意外保险' },
        { coverageType: '意外保障', liability: '交通意外身故保险金', scenario: '轨道交通', value: 300000, unit: '元', basis: '轨道交通意外保额', productName: '综合交通意外保险' },
      ],
    }),
  ]);

  const accident = radarScore(report.radar.family, 'accident');
  assert.equal(accident.amount, 800000);
  assert.equal(accident.policyCount, 1);
});

test('buildFamilyReport counts distinct radar policies without policy ids', () => {
  const report = buildFamilyReport([
    makePolicy({ id: '', insured: '妈妈', name: '百万医疗保险', amount: 100000, coverageIndicators: [] }),
    makePolicy({ id: '', insured: '爸爸', name: '百万医疗保险', amount: 200000, coverageIndicators: [] }),
  ]);

  const medical = radarScore(report.radar.family, 'medical');
  assert.equal(medical.amount, 300000);
  assert.equal(medical.policyCount, 2);
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

test('buildFamilyReport keeps accident indicators out of critical death and disability row', () => {
  const xinhuaNursing = '新华人寿保险股份有限公司安鑫优选终身护理保险';
  const xinhuaWholeLife = '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）';
  const report = buildFamilyReport([
    makePolicy({
      id: 500534,
      insured: '温舒萍',
      name: xinhuaNursing,
      amount: 60312,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '疾病身故', value: 160, unit: '%', basis: '基本保额', productName: xinhuaNursing },
      ],
    }),
    makePolicy({
      id: 500557,
      insured: '温舒萍',
      name: xinhuaWholeLife,
      amount: 24441,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '疾病全残', unit: '公式', basis: '已交保费', formulaText: '疾病全残 = 现金价值', productName: xinhuaWholeLife },
        {
          coverageType: '意外保障',
          liability: '交通/航空等给付倍数',
          value: 1.5,
          unit: '倍',
          basis: '特定意外额外给付倍数',
          productName: xinhuaWholeLife,
          sourceExcerpt: '特定公共交通工具意外伤害身故或身体全残保险金，金额为基本保险金额的1.5倍。',
        },
        { coverageType: '意外保障', liability: '意外全残', value: 1.5, unit: '倍', basis: '基本保额', productName: xinhuaWholeLife },
        { coverageType: '意外保障', liability: '特定意外身故/全残', value: 1.5, unit: '倍', basis: '基本保额', productName: xinhuaWholeLife },
      ],
    }),
  ]);

  const criticalMember = report.criticalIllness.members.find((item) => item.member === '温舒萍');
  const deathRow = criticalMember.rows.find((row) => row.key === 'death_disability');
  const wholeLifeSourceCount = deathRow.sourcePolicies.filter((policy) => policy.productName === xinhuaWholeLife).length;

  assert.equal(Number(deathRow.amount.toFixed(1)), 96499.2);
  assert.equal(wholeLifeSourceCount, 1);
  assert.deepEqual(deathRow.sourcePolicies.map((policy) => policy.productName), [xinhuaNursing, xinhuaWholeLife]);

  const accidentMember = report.accident.members.find((item) => item.member === '温舒萍');
  assert.equal(accidentMember.rows.find((row) => row.key === 'general_accident').status, 'covered');
  assert.equal(accidentMember.rows.find((row) => row.key === 'aviation').status, 'covered');
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

test('buildFamilyReport uses matched rider amount for critical illness indicator percentages', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 35,
      insured: '妈妈',
      name: '家庭保障计划',
      amount: 500000,
      plans: [
        { role: 'main', name: '家庭保障计划', matchedProductName: '家庭保障计划', amount: 500000 },
        { role: 'rider', name: '附加重大疾病保险', matchedProductName: '新华人寿附加重大疾病保险', amount: 100000 },
      ],
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', formulaText: '基本保额100%', productName: '附加重大疾病保险' },
      ],
    }),
  ]);

  const mother = report.criticalIllness.members.find((item) => item.member === '妈妈');

  assert.equal(mother.rows.find((row) => row.key === 'critical_first').amount, 100000);
  assert.equal(mother.rows.find((row) => row.key === 'critical_first').amountText, '10万');
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

test('buildFamilyReport uses matched rider amount for accident indicator multiples', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 25,
      insured: '爸爸',
      name: '家庭保障计划',
      amount: 500000,
      plans: [
        { role: 'main', name: '家庭保障计划', matchedProductName: '家庭保障计划', amount: 500000 },
        { role: 'rider', name: '附加综合意外伤害保险', matchedProductName: '新华人寿附加综合意外伤害保险', amount: 100000 },
      ],
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故/全残', value: 10, unit: '倍', basis: '基本保险金额', formulaText: '基本保额10倍', productName: '综合意外伤害保险' },
      ],
    }),
  ]);

  const father = report.accident.members.find((item) => item.member === '爸爸');

  assert.equal(father.rows.find((row) => row.key === 'general_accident').amount, 1000000);
  assert.equal(father.rows.find((row) => row.key === 'general_accident').amountText, '100万');
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

test('buildFamilyReport routes policy-text-only accident fallback by scenario', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 60,
      insured: '爸爸',
      name: '航空意外险',
      amount: 5000000,
      coverageIndicators: [],
      responsibilities: [],
    }),
  ]);

  const father = report.accident.members.find((item) => item.member === '爸爸');
  const aviation = father.rows.find((row) => row.key === 'aviation');
  const generalAccident = father.rows.find((row) => row.key === 'general_accident');

  assert.equal(aviation.amountText, '500万');
  assert.equal(generalAccident.status, 'missing');
});

test('buildFamilyReport routes rail and ship accident responsibilities', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 70,
      insured: '妈妈',
      name: '轨道交通意外保障',
      amount: 100000,
      responsibilities: [
        { coverageType: '意外保障', scenario: '轨道交通意外', payout: '300万' },
        { coverageType: '意外保障', scenario: '客运轮船意外', payout: '100万' },
      ],
    }),
  ]);

  const mother = report.accident.members.find((item) => item.member === '妈妈');
  const railShip = mother.rows.find((row) => row.key === 'rail_ship');

  assert.equal(railShip.amountText, '400万');
});

test('buildFamilyReport fans out combined accident liability labels', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 75,
      insured: '妈妈',
      name: '综合交通意外险',
      amount: 100000,
      coverageIndicators: [
        {
          coverageType: '意外保障',
          liability: '客运列车/航空意外身故保险金',
          value: 1000000,
          unit: '元',
          basis: '保险金额',
          formulaText: '列车或航空意外100万元',
          productName: '综合交通意外险',
        },
      ],
    }),
  ]);

  const mother = report.accident.members.find((item) => item.member === '妈妈');
  const railShip = mother.rows.find((row) => row.key === 'rail_ship');
  const aviation = mother.rows.find((row) => row.key === 'aviation');

  assert.equal(railShip.amountText, '100万');
  assert.equal(aviation.amountText, '100万');
});

test('buildFamilyReport lets responsibility amount improve unresolved accident indicator', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 80,
      insured: '爸爸',
      name: '航空意外险',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '航空意外', formulaText: '按条款给付', productName: '航空意外险' },
      ],
      responsibilities: [
        { coverageType: '意外保障', scenario: '航空意外', payout: '500万' },
      ],
    }),
  ]);

  const father = report.accident.members.find((item) => item.member === '爸爸');
  const aviation = father.rows.find((row) => row.key === 'aviation');

  assert.equal(aviation.amountText, '500万');
});

test('buildFamilyReport creates per-member wealth policies and calendar-year aggregate rows', () => {
  const policies = [
    makePolicy({
      id: 30,
      insured: '妈妈',
      name: '盛世恒盈年金',
      firstPremium: 19600,
      date: '2025-12-22',
      paymentPeriod: '2年',
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存金', policyId: 30, productName: '盛世恒盈年金', calculationText: '' },
        { year: 2073, age: 85, amount: 110100, cumulative: 173095, liability: '满期金', policyId: 30, productName: '盛世恒盈年金', calculationText: '' },
      ],
      cashValues: [
        { policyYear: 1, age: 37, cashValue: 282 },
        { policyYear: 2, age: 38, cashValue: 663 },
        { policyYear: 49, age: 85, cashValue: 56208 },
      ],
    }),
    makePolicy({
      id: 31,
      insured: '孩子',
      name: '教育年金',
      firstPremium: 20000,
      date: '2026-01-01',
      paymentPeriod: '1年',
      cashflowEntries: [
        { year: 2044, age: 18, amount: 30000, cumulative: 30000, liability: '教育金', policyId: 31, productName: '教育年金', calculationText: '' },
      ],
      cashValues: [{ policyYear: 1, age: 0, cashValue: 1000 }],
    }),
  ];

  const report = buildFamilyReport(policies);
  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const row2025 = report.wealth.aggregateRows.find((row) => row.year === 2025);
  const row2030 = report.wealth.aggregateRows.find((row) => row.year === 2030);
  const row2073 = report.wealth.aggregateRows.find((row) => row.year === 2073);

  assert.equal(mother.policies[0].productName, '盛世恒盈年金');
  assert.equal(mother.policies[0].cashValueRows[0].calendarYear, 2025);
  assert.equal(row2025.premiumOutflow, 19600);
  assert.equal(row2025.cashValueTotal, 282);
  assert.equal(row2030.payoutInflow, 1465);
  assert.equal(row2073.payoutInflow, 110100);
  assert.ok(report.wealth.keyPoints.some((point) => point.label === '领取高峰年' && point.value === '2073'));
});

test('buildFamilyReport combines same-year policy cashflow rows for annual wealth table', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 44,
      insured: '妈妈',
      name: '盛世恒盈年金',
      firstPremium: 19600,
      date: '2025-12-22',
      paymentPeriod: '2年',
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1000, cumulative: 1000, liability: '生存金', policyId: 44, productName: '盛世恒盈年金', calculationText: '' },
        { year: 2030, age: 42, amount: 2000, cumulative: 3000, liability: '特别生存金', policyId: 44, productName: '盛世恒盈年金', calculationText: '' },
      ],
      cashValues: [
        { policyYear: 6, age: null, cashValue: 6009 },
      ],
    }),
  ]);

  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const policy = mother.policies.find((item) => item.policyId === 44);
  const row2030 = policy.annualCashflowRows.find((row) => row.year === 2030);

  assert.equal(row2030.amount, 3000);
  assert.equal(row2030.cumulative, 3000);
  assert.equal(row2030.cashValue, 6009);
  assert.deepEqual(row2030.liabilities, ['生存金', '特别生存金']);
  assert.equal(row2030.age, 42);
});

test('buildFamilyReport keeps unknown wealth cash value dates out of aggregate rows', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 40,
      insured: '妈妈',
      name: '盛世恒盈年金',
      date: '',
      paymentPeriod: '1年',
      cashValues: [{ policyYear: 1, age: 37, cashValue: 282 }],
    }),
  ]);

  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');

  assert.equal(mother.policies[0].cashValueRows[0].calendarYear, 0);
  assert.equal(report.wealth.aggregateRows.some((row) => row.year === 0 || row.year === 1), false);
  assert.ok(mother.attentionItems.includes('生效日待补充'));
  assert.ok(mother.policies[0].attentionItems.includes('生效日待补充'));
});

test('buildFamilyReport skips wealth premium rows when payment period is unknown', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 41,
      insured: '妈妈',
      name: '教育年金',
      date: '2025-12-22',
      paymentPeriod: '',
      firstPremium: 20000,
      cashValues: [{ policyYear: 1, age: 37, cashValue: 1000 }],
    }),
  ]);

  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const row2025 = report.wealth.aggregateRows.find((row) => row.year === 2025);

  assert.equal(row2025.premiumOutflow, 0);
  assert.equal(row2025.details.some((detail) => detail.type === 'premium'), false);
  assert.ok(mother.attentionItems.includes('缴费期待补充'));
  assert.ok(mother.policies[0].attentionItems.includes('缴费期待补充'));
});

test('buildFamilyReport does not classify protection policy as wealth from OCR cash value text only', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 42,
      insured: '爸爸',
      name: '健康无忧重大疾病保险',
      cashValues: [],
      cashflowEntries: [],
      ocrText: '本页示例说明现金价值对应退保金额。',
      report: '现金价值仅为通用说明。',
    }),
  ]);

  assert.equal(report.wealth.memberReports.length, 0);
});

test('buildFamilyReport includes calendar year and age in aggregate cash value details', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 43,
      insured: '妈妈',
      name: '盛世恒盈年金',
      date: '2025-12-22',
      paymentPeriod: '1年',
      cashValues: [{ policyYear: 1, age: 37, cashValue: 282 }],
    }),
  ]);

  const row2025 = report.wealth.aggregateRows.find((row) => row.year === 2025);
  const cashValueDetail = row2025.details.find((detail) => detail.type === 'cashValue');

  assert.equal(cashValueDetail.calendarYear, 2025);
  assert.equal(cashValueDetail.age, 37);
});
