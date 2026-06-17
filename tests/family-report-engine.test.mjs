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
    familyId: overrides.familyId,
    applicant: overrides.applicant ?? '投保人',
    applicantMemberId: overrides.applicantMemberId,
    applicantMemberName: overrides.applicantMemberName,
    applicantRelationLabel: overrides.applicantRelationLabel,
    beneficiary: overrides.beneficiary ?? '法定',
    applicantRelation: overrides.applicantRelation ?? '本人',
    insuredMemberId: overrides.insuredMemberId,
    insuredMemberName: overrides.insuredMemberName,
    insuredRelationLabel: overrides.insuredRelationLabel,
    insured: overrides.insured ?? '妈妈',
    insuredRelation: overrides.insuredRelation ?? '本人',
    insuredBirthday: overrides.insuredBirthday ?? '1988-12-16',
    date: overrides.date ?? '2025-12-22',
    paymentPeriod: overrides.paymentPeriod ?? '20年',
    coveragePeriod: overrides.coveragePeriod ?? '终身',
    amount: overrides.amount ?? 500000,
    firstPremium: overrides.firstPremium ?? 8600,
    policyStatus: overrides.policyStatus,
    status: overrides.status,
    expired: overrides.expired,
    plans: overrides.plans ?? [],
    ocrText: overrides.ocrText ?? '',
    responsibilities: overrides.responsibilities ?? [],
    coverageIndicators: overrides.coverageIndicators ?? [],
    optionalResponsibilities: overrides.optionalResponsibilities ?? [],
    report: overrides.report ?? '',
    policyNumber: overrides.policyNumber ?? '',
    reportStatus: overrides.reportStatus ?? 'ready',
    createdAt: overrides.createdAt ?? '2026-05-30T00:00:00.000Z',
    cashflowEntries: overrides.cashflowEntries ?? [],
    scenarioEntries: overrides.scenarioEntries ?? [],
    totalCashflow: overrides.totalCashflow ?? 0,
    cashValues: overrides.cashValues ?? [],
    participantReviewStatus: overrides.participantReviewStatus,
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
      coverageIndicators: [{ productType: '年金险', coverageType: '现金流', liability: '生存金', productName: '盛世恒盈年金' }],
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
  assert.equal(inventory.rows[0].typeLabel, '年金险');
  assert.equal(inventory.rows[0].cashValueText, '282');
  assert.equal(inventory.rows[0].dataStatus, '现金价值已识别');
  assert.equal(inventory.rows[1].member, '未识别被保人');
  assert.equal(inventory.rows[1].dataStatus, '责任生成中');
  assert.equal(inventory.insuredGroups.length, 2);
  assert.equal(inventory.insuredGroups[0].member, '妈妈');
  assert.equal(inventory.insuredGroups[0].policies[0].beneficiary, '第一顺位');
  assert.equal(inventory.insuredGroups[0].policies[0].totalPremiumText, '196,000');
});

test('buildPolicyInventory uses indicator product type verbatim without name mapping', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      id: 1,
      insured: '温舒萍',
      name: '新华人寿保险股份有限公司盛世荣耀臻享版终身寿险（分红型）',
      firstPremium: 3000,
      amount: 24410,
      coverageIndicators: [{ productType: '寿险', coverageType: '身故保险金', liability: '身故保险金', productName: '盛世荣耀臻享版终身寿险（分红型）' }],
    }),
  ]);

  assert.equal(inventory.rows[0].typeLabel, '寿险');
});

test('buildPolicyInventory dedupes compound indicator product types without mapping', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      id: 1,
      insured: '温舒萍',
      name: '新华人寿保险股份有限公司盛世恒盈年金保险（分红型）',
      coverageIndicators: [
        { productType: '年金险', coverageType: '现金流', liability: '生存金', productName: '盛世恒盈年金保险（分红型）' },
        { productType: '年金险、万能账户', coverageType: '现金流', liability: '养老年金', productName: '鑫天利卓越版养老年金保险（万能型）' },
      ],
    }),
  ]);

  assert.equal(inventory.rows[0].typeLabel, '年金险、万能账户');
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

test('buildPolicyInventory does not classify policies from responsibility fields', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      name: '基础保障',
      amount: 0,
      responsibilities: [
        { coverageType: '医疗保障', scenario: '住院', payout: '报销', note: '门诊费用' },
      ],
    }),
  ]);

  assert.equal(inventory.rows[0].typeLabel, '');
});

test('buildPolicyInventory falls back to plan product type verbatim', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      name: '新华人寿保险股份有限公司畅行万里智慧版两全保险',
      plans: [{ name: '畅行万里智慧版两全保险', productType: '两全保险' }],
    }),
  ]);

  assert.equal(inventory.rows[0].typeLabel, '两全保险');
});

test('buildPolicyInventory exposes main and rider plans in report rows', () => {
  const inventory = buildPolicyInventory([
    makePolicy({
      id: 500699,
      name: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
      amount: 60000,
      plans: [
        {
          role: 'main',
          name: '畅行万里智赢版两全保险',
          matchedProductName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          productType: '两全保险',
          amount: 60000,
        },
        {
          role: 'rider',
          name: 'i他男性特定疾病保险',
          matchedProductName: '新华人寿保险股份有限公司i他男性特定疾病保险',
          productType: '重疾险',
          amount: 50000,
          premium: 140,
          coveragePeriod: '至2025年09月29日',
        },
      ],
    }),
  ]);

  assert.deepEqual(inventory.rows[0].planItems.map((item) => ({
    roleLabel: item.roleLabel,
    productName: item.productName,
    typeLabel: item.typeLabel,
    coverageText: item.coverageText,
    premiumText: item.premiumText,
    coveragePeriod: item.coveragePeriod,
  })), [
    {
      roleLabel: '主险',
      productName: '畅行万里智赢版两全保险',
      typeLabel: '两全保险',
      coverageText: '6万',
      premiumText: '',
      coveragePeriod: '',
    },
    {
      roleLabel: '附加险',
      productName: 'i他男性特定疾病保险',
      typeLabel: '重疾险',
      coverageText: '5万',
      premiumText: '140',
      coveragePeriod: '至2025年09月29日',
    },
  ]);
});

test('buildFamilyReport includes summary and inventory sections', () => {
  const report = buildFamilyReport([makePolicy({ id: 1, insured: '爸爸' })]);
  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.policyInventory.rows.length, 1);
  assert.equal(report.policyInventory.insuredGroups[0].member, '爸爸');
});

test('buildFamilyReport groups by insuredMemberId and exposes member metadata', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 501,
      insured: 'OCR妈妈',
      insuredMemberId: 10,
      insuredMemberName: '温舒萍',
      insuredRelationLabel: '本人',
      applicantMemberId: 20,
      applicantMemberName: '冯力',
      applicantRelationLabel: '配偶',
      participantReviewStatus: 'name_mismatch',
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', productName: '健康无忧重大疾病保险' },
      ],
    }),
    makePolicy({
      id: 502,
      insured: 'OCR别名',
      insuredMemberId: 10,
      insuredMemberName: '温舒萍',
      insuredRelationLabel: '本人',
      applicantMemberId: 20,
      applicantMemberName: '冯力',
      applicantRelationLabel: '配偶',
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '轻症疾病保险金', value: 30, unit: '%', basis: '基本保险金额', productName: '健康无忧重大疾病保险' },
      ],
    }),
  ]);

  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.policyInventory.insuredGroups.length, 1);
  assert.equal(report.policyInventory.insuredGroups[0].memberKey, 'member:10');
  assert.equal(report.policyInventory.insuredGroups[0].memberId, 10);
  assert.equal(report.policyInventory.insuredGroups[0].member, '温舒萍');
  assert.equal(report.policyInventory.insuredGroups[0].relationLabel, '本人');
  assert.equal(report.policyInventory.insuredGroups[0].policies.length, 2);
  assert.equal(report.policyInventory.rows[0].applicant, '冯力');
  assert.equal(report.policyInventory.rows[0].applicantMemberId, 20);
  assert.equal(report.policyInventory.rows[0].applicantRelationLabel, '配偶');
  assert.equal(report.policyInventory.rows[0].participantReviewStatus, 'name_mismatch');
  assert.equal(report.criticalIllness.members.length, 1);
  assert.equal(report.criticalIllness.members[0].memberKey, 'member:10');
  assert.equal(report.criticalIllness.members[0].memberId, 10);
  assert.equal(report.criticalIllness.members[0].member, '温舒萍');
  assert.equal(report.criticalIllness.members[0].relationLabel, '本人');
  assert.equal(report.radar.members.length, 1);
  assert.equal(report.radar.members[0].memberKey, 'member:10');
  assert.equal(report.radar.members[0].name, '温舒萍');
  assert.equal(report.radar.members[0].relationLabel, '本人');
});

test('buildFamilyReport filters by selected family id', () => {
  const report = buildFamilyReport([
    makePolicy({ id: 601, familyId: 10, insured: '爸爸', firstPremium: 1000 }),
    makePolicy({ id: 602, familyId: 11, insured: '妈妈', firstPremium: 2000 }),
    makePolicy({ id: 603, familyId: 10, insured: '孩子', firstPremium: 3000 }),
  ], null, { familyId: 10 });

  assert.equal(report.summary.policyCount, 2);
  assert.equal(report.summary.annualPremium, 4000);
  assert.deepEqual(report.policyInventory.rows.map((row) => row.policyId), [601, 603]);
  assert.deepEqual(report.appendix.policies.map((policy) => policy.policyId), [601, 603]);
  assert.equal(report.radar.members.some((member) => member.name === '妈妈'), false);
});

test('buildFamilyReport separates inactive policies from counted values and marks them inactive', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 91,
      insured: '爸爸',
      name: '有效重疾险',
      amount: 100000,
      firstPremium: 2000,
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', productName: '有效重疾险' },
      ],
    }),
    makePolicy({
      id: 92,
      insured: '妈妈',
      name: '失效重疾险',
      amount: 500000,
      firstPremium: 8000,
      policyStatus: '失效',
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', productName: '失效重疾险' },
      ],
    }),
  ]);

  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.summary.policyCount, 1);
  assert.equal(report.summary.annualPremium, 2000);
  assert.equal(report.summary.totalCoverage, 100000);
  assert.equal(radarScore(report.radar.family, 'critical').amount, 100000);
  assert.equal(report.policyInventory.rows.find((row) => row.policyId === 92).dataStatus, '失效');
  assert.equal(report.policyInventory.rows.find((row) => row.policyId === 92).isInactive, true);

  const inactiveMember = report.criticalIllness.members.find((member) => member.member === '妈妈');
  const inactiveRow = inactiveMember.rows.find((row) => row.key === 'critical_first');
  assert.equal(inactiveRow.status, 'inactive');
  assert.equal(inactiveRow.amount, 0);
  assert.equal(inactiveRow.amountText, '50万');
  assert.match(inactiveRow.conditionText, /未计入当前保障/);
});

test('buildFamilyReport excludes coverage-period expired policies from radar and counted values', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 93,
      insured: '爸爸',
      name: '有效重疾险',
      amount: 100000,
      firstPremium: 2000,
      coveragePeriod: '终身',
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', productName: '有效重疾险' },
      ],
    }),
    makePolicy({
      id: 94,
      insured: '妈妈',
      name: '保障期已过重疾险',
      amount: 500000,
      firstPremium: 8000,
      coveragePeriod: '至2025年09月29日',
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', productName: '保障期已过重疾险' },
      ],
    }),
  ]);

  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.summary.policyCount, 1);
  assert.equal(report.summary.annualPremium, 2000);
  assert.equal(report.summary.totalCoverage, 100000);
  assert.equal(radarScore(report.radar.family, 'critical').amount, 100000);
  assert.equal(radarScore(report.radar.family, 'critical').policyCount, 1);
  assert.equal(report.radar.members.some((member) => member.name === '妈妈'), false);

  const inactiveRow = report.policyInventory.rows.find((row) => row.policyId === 94);
  assert.equal(inactiveRow.isInactive, true);
  assert.equal(inactiveRow.dataStatus, '失效');
});

test('buildFamilyReport excludes inactive-only members from attention gaps', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 95,
      insured: '爸爸',
      name: '有效重疾险',
      amount: 100000,
      coveragePeriod: '终身',
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', productName: '有效重疾险' },
      ],
    }),
    makePolicy({
      id: 96,
      insured: '妈妈',
      name: '保障期已过意外险',
      amount: 500000,
      coveragePeriod: '至2025年09月29日',
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故保险金', value: 500000, unit: '元', basis: '意外身故保额', productName: '保障期已过意外险' },
      ],
    }),
  ]);

  const inactiveCriticalMember = report.criticalIllness.members.find((member) => member.member === '妈妈');
  const inactiveAccidentMember = report.accident.members.find((member) => member.member === '妈妈');

  assert.deepEqual(inactiveCriticalMember.attentionItems, []);
  assert.deepEqual(inactiveAccidentMember.attentionItems, []);
});

test('buildFamilyReport creates structure radar with compressed display scores and real amounts', () => {
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
  assert.equal(radarScore(report.radar.family, 'wealth').amount, 50000);
  assert.equal(radarScore(report.radar.family, 'life').score, 100);
  assert.equal(radarScore(report.radar.family, 'critical').score, 71);
  assert.equal(radarScore(report.radar.family, 'accident').score, 50);
  assert.equal(radarScore(report.radar.family, 'medical').score, 32);
  assert.equal(radarScore(report.radar.family, 'wealth').score, 22);
  assert.match(radarScore(report.radar.family, 'critical').amountDetails[0].calculationText, /基本保险金额500,000元 × 100% = 500,000元/);
  assert.match(radarScore(report.radar.family, 'wealth').note, /未来领取50,000/);
  assert.match(radarScore(report.radar.family, 'wealth').note, /现金价值参考150,000未计入合计/);
  assert.match(radarScore(report.radar.family, 'wealth').amountDetails[0].calculationText, /未来确定领取合计 = 生存金30,000元\(2030\) \+ 生存金20,000元\(2031\) = 50,000元/);
});

test('buildFamilyReport marks wealth coverage by wealth insurance type, not cash value amount', () => {
  const annuityReport = buildFamilyReport([
    makePolicy({
      id: 106,
      insured: '妈妈',
      name: '养老年金保险',
      amount: 0,
      cashValues: [],
      cashflowEntries: [],
    }),
  ]);
  const annuityWealth = radarScore(annuityReport.radar.family, 'wealth');
  assert.equal(annuityWealth.amount, 0);
  assert.equal(annuityWealth.coveragePresent, true);

  const cashValueOnlyReport = buildFamilyReport([
    makePolicy({
      id: 107,
      insured: '爸爸',
      name: '健康无忧重大疾病保险',
      amount: 100000,
      cashValues: [{ policyYear: 1, cashValue: 1000 }],
    }),
  ]);
  const cashValueOnlyWealth = radarScore(cashValueOnlyReport.radar.family, 'wealth');
  assert.equal(cashValueOnlyWealth.amount, 1000);
  assert.equal(cashValueOnlyWealth.coveragePresent, false);
});

test('buildFamilyReport explains the raw critical radar amount before chart scoring', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 106,
      insured: '爸爸',
      name: '新华健康无忧重大疾病保险',
      amount: 60312,
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保险金额', productName: '新华健康无忧重大疾病保险' },
      ],
    }),
  ]);

  const critical = radarScore(report.radar.family, 'critical');
  assert.equal(critical.amount, 60312);
  assert.equal(critical.amountText, '60,312元');
  assert.equal(critical.amountDetails.length, 1);
  assert.equal(critical.amountDetails[0].amount, 60312);
  assert.equal(critical.amountDetails[0].company, '新华保险');
  assert.equal(critical.amountDetails[0].productName, '新华健康无忧重大疾病保险');
  assert.equal(critical.amountDetails[0].liability, '重大疾病保险金');
  assert.match(critical.amountDetails[0].calculationText, /基本保险金额60,312元 × 100% = 60,312元/);
});

test('buildFamilyReport keeps high accident amounts from flattening other structure dimensions', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 106,
      insured: '爸爸',
      name: '高额意外保险',
      amount: 10000000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故保险金', value: 10000000, unit: '元', basis: '意外身故保额', productName: '高额意外保险' },
      ],
    }),
    makePolicy({
      id: 107,
      insured: '妈妈',
      name: '重大疾病保险',
      amount: 500000,
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '重大疾病保险' },
      ],
    }),
  ]);

  assert.equal(radarScore(report.radar.family, 'accident').score, 100);
  assert.equal(radarScore(report.radar.family, 'critical').score, 22);
  assert.equal(radarScore(report.radar.family, 'critical').amount, 500000);
});

test('buildFamilyReport switches family radar to target adequacy when planning profile is provided', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 111,
      insured: '妈妈',
      name: '重大疾病保险',
      amount: 500000,
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '重大疾病保险' },
      ],
    }),
    makePolicy({
      id: 112,
      insured: '爸爸',
      name: '综合意外保险',
      amount: 250000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故保险金', value: 250000, unit: '元', basis: '意外身故保额', productName: '综合意外保险' },
      ],
    }),
    makePolicy({
      id: 113,
      insured: '孩子',
      name: '百万医疗保险',
      amount: 0,
      coverageIndicators: [
        { coverageType: '医疗保障', liability: '住院医疗费用保险金', value: 100000, unit: '元', basis: '医疗费用限额', productName: '百万医疗保险' },
      ],
    }),
    makePolicy({
      id: 114,
      insured: '妈妈',
      name: '终身寿险',
      amount: 1000000,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '身故保险金', value: 1000000, unit: '元', basis: '身故保额', productName: '终身寿险' },
      ],
    }),
  ], {
    annualExpense: 300000,
    debt: 2000000,
    educationGoal: 800000,
    retirementGoal: 1000000,
    availableAssets: 500000,
  });

  const critical = radarScore(report.radar.family, 'critical');
  const accident = radarScore(report.radar.family, 'accident');
  const medical = radarScore(report.radar.family, 'medical');
  const life = radarScore(report.radar.family, 'life');
  const wealth = radarScore(report.radar.family, 'wealth');

  assert.equal(report.radar.mode, 'planning');
  assert.equal(critical.target, 1100000);
  assert.equal(accident.target, 3000000);
  assert.equal(medical.target, 3000000);
  assert.equal(life.target, 5300000);
  assert.equal(wealth.target, 1800000);
  assert.equal(critical.score, 45);
  assert.equal(life.score, 19);
  assert.equal(critical.gap, 600000);
  assert.equal(life.gap, 4300000);
  assert.equal(critical.adequacyText, '45%');
});

test('buildFamilyReport weights scenario-only accident coverages for planning adequacy', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 115,
      insured: '爸爸',
      name: '航空意外保险',
      amount: 0,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '航空意外身故保险金', value: 1000000, unit: '元', basis: '航空意外保额', productName: '航空意外保险' },
      ],
    }),
  ], {
    annualExpense: 100000,
  });

  const accident = radarScore(report.radar.family, 'accident');
  assert.equal(accident.amount, 1000000);
  assert.equal(accident.effectiveAmount, 200000);
  assert.equal(accident.target, 500000);
  assert.equal(accident.score, 40);
});

test('buildFamilyReport discounts future wealth payouts for planning adequacy', () => {
  const payoutYear = new Date().getFullYear() + 10;
  const report = buildFamilyReport([
    makePolicy({
      id: 116,
      insured: '妈妈',
      name: '年金保险',
      amount: 0,
      cashflowEntries: [
        { year: payoutYear, age: 55, amount: 100000, cumulative: 100000, liability: '生存金', policyId: 116, productName: '年金保险' },
      ],
    }),
  ], {
    retirementGoal: 1000000,
  });

  const wealth = radarScore(report.radar.family, 'wealth');
  assert.equal(wealth.amount, 100000);
  assert.ok(wealth.effectiveAmount < 100000);
  assert.equal(wealth.target, 1000000);
  assert.equal(wealth.score, 7);
});

test('buildFamilyReport shows member radar as each member own amount structure and limits displayed members', () => {
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
  assert.equal(radarScore(radarMember(report, '爸爸'), 'critical').score, 100);
  assert.equal(radarScore(radarMember(report, '孩子'), 'critical').score, 100);
  assert.equal(radarScore(radarMember(report, '未成年二'), 'critical').score, 0);
  assert.equal(radarMember(report, '妈妈').role, 'adult');
  assert.equal(radarMember(report, '孩子').role, 'child');
});

test('buildFamilyReport allocates family planning targets to member estimated radar without personal inputs', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 211,
      insured: '爸爸',
      insuredRelation: '本人',
      insuredBirthday: '1988-01-01',
      name: '爸爸寿险',
      amount: 1000000,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '身故保险金', value: 1000000, unit: '元', basis: '身故保额', productName: '爸爸寿险' },
      ],
    }),
    makePolicy({
      id: 212,
      insured: '孩子',
      insuredRelation: '子女',
      insuredBirthday: '2018-01-01',
      name: '孩子重疾',
      amount: 300000,
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '孩子重疾' },
      ],
    }),
  ], {
    annualExpense: 300000,
    debt: 2000000,
    educationGoal: 800000,
    retirementGoal: 1000000,
    availableAssets: 500000,
  });

  const father = radarMember(report, '爸爸');
  const child = radarMember(report, '孩子');
  assert.equal(report.radar.mode, 'planning');
  assert.equal(father.targetSource, 'system_estimate');
  assert.equal(father.role, 'adult');
  assert.equal(child.role, 'child');
  assert.equal(radarScore(father, 'life').target, 5300000);
  assert.equal(radarScore(child, 'life').target, 0);
  assert.equal(radarScore(child, 'wealth').target, 800000);
  assert.equal(radarScore(father, 'wealth').target, 1000000);
  assert.equal(radarScore(father, 'life').score, 19);
  assert.equal(radarScore(child, 'medical').target, 3000000);
});

test('buildFamilyReport keeps formula-only radar amounts out of numeric radar value', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 301,
      insured: '妈妈',
      name: '公式型寿险',
      amount: 0,
      firstPremium: 58000,
      cashValues: [
        { policyYear: 1, age: 30, cashValue: 42000 },
        { policyYear: 2, age: 31, cashValue: 116280 },
      ],
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '身故保险金', unit: '公式', basis: '已交保费', formulaText: '取已交保费、现金价值、基本保额较大者', productName: '公式型寿险' },
      ],
    }),
  ]);

  const life = radarScore(report.radar.family, 'life');
  assert.equal(life.amount, 0);
  assert.equal(life.score, 0);
  assert.equal(life.amountText, '≥116,280元参考');
  assert.match(life.note, /固定保额不可量化/u);
  assert.equal(life.amountDetails.length, 1);
  assert.equal(life.amountDetails[0].amount, 116280);
  assert.equal(life.amountDetails[0].referenceOnly, true);
  assert.match(life.amountDetails[0].calculationText, /现金价值116,280元/u);
});

test('buildFamilyReport shows reference lower bound for unquantifiable life responsibility', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 3030,
      insured: '翟宸彬',
      insuredMemberId: 3031,
      name: '成长阳光少儿两全保险(A款)（分红型）',
      amount: 38760,
      firstPremium: 5475,
      coverageIndicators: [{
        coverageType: '规则参数',
        liability: '赔付方式',
        valueText: '定额给付型',
        unit: '方式',
        basis: '保险责任赔付机制',
        productName: '成长阳光少儿两全保险(A款)（分红型）',
        sourceExcerpt: '被保险人于十八周岁生效对应日前身故，本公司按您所交保险费及累计红利保险金额对应的现金价值两者之和给付身故保险金。被保险人于十八周岁生效对应日后身故，本公司按本合同有效保险金额的三倍给付身故保险金。',
        quantificationStatus: 'not_quantifiable',
        calculationEligible: false,
        excludeFromCalculation: true,
      }],
    }),
  ]);

  const life = radarScore(report.radar.family, 'life');
  const member = radarMember(report, '翟宸彬');
  assert.equal(life.amount, 0);
  assert.equal(life.score, 0);
  assert.equal(life.coveragePresent, true);
  assert.equal(life.amountText, '≥116,280元参考');
  assert.equal(life.policyCount, 1);
  assert.match(life.note, /参考下限/u);
  assert.equal(life.amountDetails.length, 1);
  assert.equal(life.amountDetails[0].amount, 116280);
  assert.equal(life.amountDetails[0].referenceOnly, true);
  assert.match(life.amountDetails[0].calculationText, /保险金额38,760元 × 3倍 = 116,280元/u);
  assert.deepEqual(member.notes, ['缺口维度: 重疾、意外、医疗']);
});

test('buildFamilyReport uses post-waiting-period whole life responsibility for life radar', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 303,
      insured: '顾晨妍',
      name: '福如东海A款终身寿险（分红型）',
      amount: 100000,
      coverageIndicators: [
        {
          coverageType: '人寿保障',
          liability: '疾病全残',
          value: 10,
          unit: '%',
          basis: '基本保额',
          condition: '合同生效之日起一年内因疾病导致身故或身体全残',
          productName: '福如东海A款终身寿险（分红型）',
        },
        {
          coverageType: '现金流',
          liability: '增额/利率',
          value: 100,
          unit: '%',
          basis: '保险金额',
          condition: '被保险人因意外伤害或合同生效一年后因疾病导致身故或身体全残',
          formulaText: '身故或全残保险金 = 基本保险金额与累积红利保险金额之和',
          productName: '福如东海A款终身寿险（分红型）',
          sourceExcerpt: '被保险人因意外伤害或于本合同生效之日起一年后因疾病导致身故或身体全残，本公司按基本保险金额与累积红利保险金额之和给付身故或全残保险金。',
        },
      ],
    }),
  ]);

  const life = radarScore(report.radar.family, 'life');
  assert.equal(life.amount, 100000);
  assert.equal(life.policyCount, 1);
  assert.match(life.note, /身故\/全残100,000/u);
  assert.equal(life.amountDetails.length, 1);
  assert.equal(life.amountDetails[0].liability, '身故/全残');
  assert.match(life.amountDetails[0].calculationText, /基本保险金额100,000元 \+ 累积红利保险金额/);
  assert.match(life.amountDetails[0].calculationText, /至少100,000元/u);
});

test('buildFamilyReport excludes non-calculable rule parameters from medical radar', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 304,
      insured: '顾晨妍',
      name: '住院费用医疗保险（2007）',
      amount: 10000,
      coverageIndicators: [
        {
          coverageType: '医疗保障',
          liability: '医疗保障限额',
          value: 20,
          unit: '元',
          basis: '实际医疗费用',
          productName: '住院费用医疗保险（2007）',
          sourceExcerpt: '住院床位费保险金每日给付限额为20元，每次住院最长给付天数为180天。',
        },
        {
          coverageType: '规则参数',
          liability: '等待期',
          value: 60,
          unit: '日',
          basis: '合同等待期',
          productName: '住院费用医疗保险（2007）',
          sourceExcerpt: '自本合同生效之日起60日为等待期。',
        },
        {
          coverageType: '规则参数',
          liability: '赔付方式',
          valueText: '费用报销型+津贴给付型',
          unit: '方式',
          basis: '保险责任赔付机制',
          productName: '住院费用医疗保险（2007）',
          excludeFromCalculation: true,
          calculationEligible: false,
        },
      ],
    }),
  ]);

  const medical = radarScore(report.radar.family, 'medical');
  assert.equal(medical.amount, 0);
  assert.equal(medical.policyCount, 0);
  assert.match(medical.note, /报销型|不可量化/u);
});

test('buildFamilyReport excludes payout method rule parameters from life radar fallback', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 305,
      insured: '温舒萍',
      name: '盛世恒盈年金保险（分红型）',
      amount: 1465,
      coverageIndicators: [
        {
          coverageType: '规则参数',
          liability: '赔付方式',
          valueText: '定额给付型',
          unit: '方式',
          basis: '保险责任赔付机制',
          productName: '盛世恒盈年金保险（分红型）',
          sourceExcerpt: '生存保险金：被保险人在每个保单周年日零时生存，我们按基本保险金额给付生存保险金。身故保险金：被保险人身故，我们按已交保险费与现金价值较大者给付身故保险金。',
          quantificationStatus: 'not_quantifiable',
          calculationEligible: false,
          excludeFromCalculation: true,
          qualityStatus: 'non_calculable_rule_parameter',
        },
      ],
    }),
  ]);

  const life = radarScore(report.radar.family, 'life');
  assert.equal(life.amount, 0);
  assert.equal(life.policyCount, 0);
  assert.match(life.note, /不可量化/u);
});

test('buildFamilyReport keeps unquantifiable life without death evidence out of coverage', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 3051,
      insured: '温舒萍',
      name: '盛世恒盈年金保险（分红型）',
      amount: 1465,
      coverageIndicators: [{
        coverageType: '规则参数',
        liability: '赔付方式',
        valueText: '定额给付型',
        unit: '方式',
        basis: '保险责任赔付机制',
        productName: '盛世恒盈年金保险（分红型）',
        sourceExcerpt: '生存保险金：被保险人在每个保单周年日零时生存，我们按基本保险金额给付生存保险金。',
        quantificationStatus: 'not_quantifiable',
        calculationEligible: false,
        excludeFromCalculation: true,
      }],
    }),
  ]);

  const life = radarScore(report.radar.family, 'life');
  assert.equal(life.amount, 0);
  assert.equal(life.coveragePresent, false);
  assert.equal(life.amountDetails.length, 0);
});

test('buildFamilyReport only treats pending optional responsibilities as report gaps', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 306,
      insured: '妈妈',
      name: '测试重疾',
      optionalResponsibilities: [
        {
          id: 'opt_pending',
          productName: '测试重疾',
          liability: '待复核可选责任',
          responsibilityScope: 'optional',
          selectionStatus: 'selected',
          quantificationStatus: 'pending_review',
          quantificationReason: '缺少可计算结构化指标',
        },
        {
          id: 'opt_not_quantifiable',
          productName: '测试重疾',
          liability: '不进入量化责任',
          responsibilityScope: 'optional',
          selectionStatus: 'selected',
          quantificationStatus: 'not_quantifiable',
          quantificationReason: '后台确认不进入金额计算',
        },
      ],
    }),
  ]);

  assert.deepEqual(report.optionalResponsibilityGaps.map((gap) => gap.liability), ['待复核可选责任']);
});

test('buildFamilyReport applies trusted medical corrections to remove fixed amount false positives', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 901,
      insured: '顾晨妍',
      insuredMemberId: 902,
      name: '住院费用医疗保险（2007）',
      amount: 60,
      coverageIndicators: [{
        coverageType: '医疗保障',
        liability: '住院床位费',
        value: 60,
        unit: '元',
        productName: '住院费用医疗保险（2007）',
      }],
    }),
  ], null, {
    corrections: [{
      status: 'auto_applied',
      action: 'mark_unquantifiable',
      dimension: 'medical',
      policyId: 901,
      memberId: 902,
      productName: '住院费用医疗保险（2007）',
    }],
  });

  const medical = radarScore(report.radar.family, 'medical');
  assert.equal(medical.amount, 0);
  assert.equal(medical.amountText, '0元');
  assert.equal(medical.policyCount, 0);
  assert.match(medical.note, /报销型|不可量化/u);
});

test('buildFamilyReport applies trusted life replacement corrections to radar amounts', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 911,
      insured: '翟卿',
      insuredMemberId: 912,
      name: '国寿鑫颐宝两全保险（2024版）',
      amount: 159948,
      coverageIndicators: [{
        coverageType: '人寿保障',
        liability: '身故保险金',
        value: 159948,
        unit: '元',
        productName: '国寿鑫颐宝两全保险（2024版）',
      }],
    }),
  ], null, {
    corrections: [{
      status: 'auto_applied',
      action: 'replace_amount',
      dimension: 'life',
      policyId: 911,
      memberId: 912,
      productName: '国寿鑫颐宝两全保险（2024版）',
      correctedValue: 0,
    }],
  });

  const life = radarScore(report.radar.family, 'life');
  assert.equal(life.amount, 0);
  assert.equal(life.amountText, '0元');
  assert.match(life.note, /不可量化|公式型/u);
});

test('buildFamilyReport applies trusted critical replacements to detail rows', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 921,
      insured: '顾晨妍',
      insuredMemberId: 922,
      name: '福如东海A款终身寿险（分红型）',
      amount: 100000,
      plans: [{
        role: 'rider',
        name: '附加安康提前给付重大疾病保险',
        matchedProductName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
        amount: 100000,
      }],
      coverageIndicators: [
        {
          coverageType: '疾病保障',
          liability: '重疾(首次给付)',
          value: 110,
          unit: '%',
          basis: '已交保费',
          productName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
          sourceExcerpt: '一年内确诊初次发生重大疾病，给付本保险实际交纳的保险费的110%。',
        },
        {
          coverageType: '疾病保障',
          liability: '防癌/恶性肿瘤(首次给付)',
          value: 50,
          unit: '%',
          basis: '基本保额',
          productName: '新华人寿保险股份有限公司附加安康提前给付重大疾病保险',
          sourceExcerpt: '癌症特别关爱保险金：一年后确诊初次发生本合同所指的重大疾病中的恶性肿瘤，除按前款规定给付重大疾病保险金外，还按主险合同基本保险金额的50%给付。',
        },
      ],
    }),
  ], null, {
    corrections: [{
      status: 'auto_applied',
      action: 'replace_amount',
      dimension: 'critical',
      policyId: 921,
      memberId: 922,
      productName: '福如东海A款终身寿险（分红型）',
      correctedValue: 100000,
      reason: '一年后确诊重疾按主险基本保险金额给付',
      evidence: '条款约定按主险合同基本保险金额给付重大疾病保险金',
    }],
  });

  const member = report.criticalIllness.members.find((item) => item.member === '顾晨妍');
  const criticalFirst = member.rows.find((item) => item.key === 'critical_first');
  const specificDisease = member.rows.find((item) => item.key === 'specific_disease');
  const criticalRadar = radarScore(report.radar.family, 'critical');

  assert.equal(criticalFirst.amount, 100000);
  assert.equal(criticalFirst.amountText, '10万');
  assert.equal(criticalFirst.sourcePolicies[0].amount, 100000);
  assert.match(criticalFirst.conditionText, /基本保险金额/u);
  assert.equal(specificDisease.amount, 50000);
  assert.equal(specificDisease.amountText, '5万');
  assert.match(specificDisease.conditionText, /癌症特别关爱/u);
  assert.equal(criticalRadar.amount, 100000);
});

test('buildFamilyReport keeps formula critical illness amounts out of radar fallback', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 302,
      insured: '妈妈',
      name: '公式型重疾',
      amount: 500000,
      coverageIndicators: [
        {
          coverageType: '重大疾病保障',
          liability: '重大疾病保险金',
          unit: '公式',
          formulaText: '取已交保费、现金价值、基本保额较大者',
          productName: '公式型重疾',
        },
      ],
    }),
  ]);

  const critical = radarScore(report.radar.family, 'critical');
  assert.equal(critical.amount, 0);
  assert.equal(critical.score, 0);
  assert.equal(critical.amountText, '0元');
  assert.match(critical.note, /公式型待确认/);
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

test('buildFamilyReport keeps long accident responsibility text out of radar notes', () => {
  const longScenario = '保险责任 在本合同保险期间内，我们按以下约定承担保险责任并给付保险金。被保险人以乘客身份乘坐公共交通工具期间遭受意外伤害事故。';
  const report = buildFamilyReport([
    makePolicy({
      id: 403,
      insured: '爸爸',
      name: '综合交通意外保险',
      amount: 0,
      responsibilities: [
        {
          coverageType: '意外保障',
          scenario: longScenario,
          payout: '航空意外身故保险金 500000元',
        },
      ],
    }),
  ]);

  const accident = radarScore(report.radar.family, 'accident');
  assert.equal(accident.amount, 500000);
  assert.ok(accident.note.length < 80);
  assert.doesNotMatch(accident.note, /本合同保险期间|我们按以下约定/u);
  assert.match(accident.note, /公共交通|航空意外|意外/u);
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

test('buildFamilyReport excludes unselected optional indicators from critical totals', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 901,
      insured: '妈妈',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重疾首次给付', value: 100, unit: '%', basis: '基本保额', responsibilityScope: 'optional', selectionStatus: 'unknown' },
        { coverageType: '疾病保障', liability: '重疾首次给付', value: 50, unit: '%', basis: '基本保额', responsibilityScope: 'optional', selectionStatus: 'selected', quantificationStatus: 'quantified' },
      ],
    }),
  ]);

  const criticalMember = report.criticalIllness.members.find((item) => item.member === '妈妈');
  const row = criticalMember.rows.find((item) => item.key === 'critical_first');

  assert.equal(row.amount, 50000);
  assert.equal(row.sourcePolicies.length, 1);
});

test('buildFamilyReport reports selected optional responsibilities that are not quantified as gaps', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 90,
      insured: '妈妈',
      name: '测试重疾',
      optionalResponsibilities: [
        {
          id: 'opt_gap',
          productName: '测试重疾',
          liability: '可选责任一',
          responsibilityScope: 'optional',
          selectionStatus: 'selected',
          quantificationStatus: 'pending_review',
          quantificationReason: '缺少可计算结构化指标',
        },
      ],
      coverageIndicators: [
        {
          coverageType: '疾病保障',
          liability: '轻症保险金',
          value: 30,
          unit: '%',
          basis: '基本保额',
          responsibilityScope: 'optional',
          selectionStatus: 'selected',
          quantificationStatus: 'pending_review',
        },
      ],
    }),
  ]);

  assert.equal(report.optionalResponsibilityGaps.length, 1);
  assert.equal(report.optionalResponsibilityGaps[0].member, '妈妈');
  assert.equal(report.optionalResponsibilityGaps[0].liability, '可选责任一');
  assert.equal(report.criticalIllness.members[0].rows.find((row) => row.key === 'mild').amount, 0);
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

test('buildFamilyReport excludes inactive rider plan indicators while keeping active main policy', () => {
  const riderName = '新华人寿保险股份有限公司i他男性特定疾病保险';
  const report = buildFamilyReport([
    makePolicy({
      id: 36,
      insured: '冯力',
      name: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
      amount: 60000,
      firstPremium: 3296,
      plans: [
        {
          role: 'main',
          name: '畅行万里智赢版两全保险',
          matchedProductName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          amount: 60000,
          coveragePeriod: '至2068年9月30日零时',
          status: '有效',
        },
        {
          role: 'rider',
          name: 'i他男性特定疾病保险',
          matchedProductName: riderName,
          amount: 50000,
          coveragePeriod: '至2025年09月29日',
          status: '失效',
        },
      ],
      coverageIndicators: [
        {
          coverageType: '疾病保障',
          liability: '防癌/恶性肿瘤(首次给付)',
          unit: '公式',
          basis: '已交保费',
          formulaText: '防癌/恶性肿瘤(首次给付) = 基本保险金额',
          sourceExcerpt: '等待期内给付本保险实际交纳的保险费，本合同终止。被保险人于本合同生效之日起30日后确诊初次发生特定重度恶性肿瘤，本公司按基本保险金额给付特定重度恶性肿瘤保险金，本合同终止。',
          productName: riderName,
        },
      ],
    }),
  ]);

  const inventoryRow = report.policyInventory.rows.find((row) => row.policyId === 36);
  assert.equal(inventoryRow.isInactive, false);
  assert.equal(report.summary.policyCount, 1);
  assert.equal(radarScore(report.radar.family, 'critical').amount, 0);

  const member = report.criticalIllness.members.find((item) => item.member === '冯力');
  const row = member.rows.find((item) => item.key === 'specific_disease');
  assert.equal(row.status, 'inactive');
  assert.equal(row.amount, 0);
  assert.equal(row.amountText, '5万');
  assert.match(row.countText, /基本保险金额/);
  assert.match(row.conditionText, /对应险种已失效/);
  assert.equal(row.sourcePolicies[0].productName, riderName);
  assert.equal(row.sourcePolicies[0].amount, 50000);
});

test('buildFamilyReport does not fall back to active main policy amount from inactive critical rider text', () => {
  const riderName = '新华人寿保险股份有限公司i他男性特定疾病保险';
  const report = buildFamilyReport([
    makePolicy({
      id: 37,
      insured: '冯力',
      name: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
      amount: 60000,
      plans: [
        {
          role: 'main',
          name: '畅行万里智赢版两全保险',
          matchedProductName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
          amount: 60000,
          coveragePeriod: '至2068年9月30日零时',
          status: '有效',
        },
        {
          role: 'rider',
          name: 'i他男性特定疾病保险',
          matchedProductName: riderName,
          amount: 50000,
          coveragePeriod: '至2025年09月29日',
          status: '失效',
        },
      ],
      responsibilities: [
        {
          coverageType: '保险责任',
          note: riderName,
          scenario: '特定重大疾病保险金：本公司按基本保险金额给付特定重大疾病保险金，本合同终止。',
          payout: '以正式条款为准',
        },
      ],
    }),
  ]);

  const critical = radarScore(report.radar.family, 'critical');
  assert.equal(critical.amount, 0);
  assert.match(critical.note, /未识别到可落地金额/);

  const member = report.criticalIllness.members.find((item) => item.member === '冯力');
  const row = member.rows.find((item) => item.key === 'critical_first');
  assert.equal(row.amount, 0);
  assert.equal(row.status, 'missing');
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

test('buildFamilyReport calculates aggregate wealth from confirmed payouts without premium or cash value stock', () => {
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
  const row2026 = report.wealth.aggregateRows.find((row) => row.year === 2026);
  const row2027 = report.wealth.aggregateRows.find((row) => row.year === 2027);
  const row2030 = report.wealth.aggregateRows.find((row) => row.year === 2030);
  const row2073 = report.wealth.aggregateRows.find((row) => row.year === 2073);

  assert.equal(mother.policies[0].productName, '盛世恒盈年金');
  assert.equal(mother.policies[0].cashValueRows[0].calendarYear, 2026);
  assert.equal(mother.policies[0].cashValueRows[0].cashValueDate, '2026-12-22');
  assert.equal(mother.policies[0].cashValueRows[0].cashValueDateLabel, '2026-12-22');
  assert.equal(row2025, undefined);
  assert.equal(row2026, undefined);
  assert.equal(row2027, undefined);
  assert.equal(row2030.payoutInflow, 1465);
  assert.equal(row2030.cashValueIncrease, 0);
  assert.equal(row2030.netCashflow, 1465);
  assert.equal(row2030.details.some((detail) => detail.type === 'premium'), false);
  assert.equal(row2030.details.some((detail) => detail.type === 'cashValue'), false);
  assert.equal(row2073.payoutInflow, 110100);
  assert.equal(report.wealth.aggregateRows.some((row) => row.details.some((detail) => detail.type === 'premium')), false);
  assert.equal(report.wealth.aggregateRows.some((row) => row.details.some((detail) => detail.type === 'cashValue')), false);
  assert.ok(report.wealth.keyPoints.some((point) => point.label === '领取高峰年' && point.value === '2073'));
});

test('buildFamilyReport keeps dividend and universal account uncertainty out of wealth statistics', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 32,
      insured: '妈妈',
      name: '盛世恒盈年金保险（分红型）',
      date: '2026-01-01',
      firstPremium: 19600,
      cashValues: [
        { policyYear: 1, age: 38, cashValue: 5000 },
      ],
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1000, cumulative: 1000, liability: '生存金', policyId: 32, productName: '盛世恒盈年金保险（分红型）', calculationText: '' },
        { year: 2031, age: 43, amount: 2000, cumulative: 3000, liability: '年度红利', policyId: 32, productName: '盛世恒盈年金保险（分红型）', calculationText: '' },
        { year: 2032, age: 44, amount: 3000, cumulative: 6000, liability: '养老年金', policyId: 32, productName: '鑫天利卓越版养老年金保险（万能型）', calculationText: '' },
      ],
      coverageIndicators: [
        { productType: '年金险', coverageType: '现金流', liability: '生存金', productName: '盛世恒盈年金保险（分红型）' },
        { productType: '万能账户', coverageType: '现金流', liability: '养老年金', productName: '鑫天利卓越版养老年金保险（万能型）' },
      ],
    }),
  ]);

  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const policy = mother.policies.find((item) => item.policyId === 32);
  const row2030 = report.wealth.aggregateRows.find((row) => row.year === 2030);

  assert.equal(policy.hasUncertainWealthFactors, true);
  assert.deepEqual(policy.uncertaintyItems.map((item) => item.key), ['dividend', 'universal_account']);
  assert.equal(policy.cashflowRows.length, 1);
  assert.equal(policy.excludedCashflowRows.length, 2);
  assert.equal(policy.cashValueRows.length, 1);
  assert.equal(policy.excludedCashValueRows.length, 0);
  assert.ok(policy.attentionItems.some((item) => /分红\/红利、万能账户存在不确定因素，未进入财富统计/u.test(item)));
  assert.equal(row2030.payoutInflow, 1000);
  assert.equal(report.wealth.aggregateRows.some((row) => row.year === 2031 || row.year === 2032), false);
  assert.equal(report.wealth.excludedPolicies.length, 1);
  assert.deepEqual(report.wealth.excludedPolicies[0].reasons, ['分红/红利', '万能账户']);
  assert.match(report.wealth.statisticsScopeNote, /分红、万能账户存在收益或账户价值不确定因素/);

  const wealth = radarScore(report.radar.family, 'wealth');
  assert.equal(wealth.amount, 1000);
  assert.equal(wealth.policyCount, 1);
  assert.match(wealth.note, /分红、万能账户不确定金额未统计/);
  assert.match(wealth.note, /现金价值参考5,000未计入合计/);

  const universalReport = buildFamilyReport([
    makePolicy({
      id: 33,
      insured: '爸爸',
      name: '鑫天利卓越版养老年金保险（万能型）',
      date: '2026-01-01',
      cashValues: [
        { policyYear: 1, age: 40, cashValue: 30000 },
      ],
      coverageIndicators: [
        { productType: '万能账户', coverageType: '现金流', liability: '账户价值', productName: '鑫天利卓越版养老年金保险（万能型）' },
      ],
    }),
  ]);
  const father = universalReport.wealth.memberReports.find((item) => item.member === '爸爸');
  const universalPolicy = father.policies.find((item) => item.policyId === 33);
  assert.equal(universalPolicy.cashValueRows.length, 0);
  assert.equal(universalPolicy.excludedCashValueRows.length, 1);
  assert.equal(universalReport.wealth.aggregateRows.length, 0);
  assert.equal(radarScore(universalReport.radar.family, 'wealth').amount, 0);
  assert.equal(universalPolicy.attentionItems.some((item) => /缺少现金价值表/u.test(item)), false);
});

test('buildFamilyReport explains future deterministic payout totals by liability and year range', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 321,
      insured: '妈妈',
      name: '测试年金保险',
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存保险金', policyId: 321, productName: '测试年金保险' },
        { year: 2031, age: 43, amount: 1465, cumulative: 2930, liability: '生存保险金', policyId: 321, productName: '测试年金保险' },
        { year: 2032, age: 44, amount: 1465, cumulative: 4395, liability: '生存保险金', policyId: 321, productName: '测试年金保险' },
        { year: 2033, age: 45, amount: 1465, cumulative: 5860, liability: '养老年金', policyId: 321, productName: '测试年金保险' },
        { year: 2034, age: 46, amount: 1465, cumulative: 7325, liability: '养老年金', policyId: 321, productName: '测试年金保险' },
        { year: 2035, age: 47, amount: 110100, cumulative: 117425, liability: '满期生存保险金', policyId: 321, productName: '测试年金保险' },
      ],
    }),
  ]);

  const wealth = radarScore(report.radar.family, 'wealth');
  assert.equal(wealth.amount, 117425);
  assert.match(
    wealth.amountDetails[0].calculationText,
    /未来确定领取合计 = 生存保险金1,465元 × 3年\(2030-2032\) \+ 养老年金1,465元 × 2年\(2033-2034\) \+ 满期生存保险金110,100元\(2035\) = 117,425元/u,
  );
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
  const row2031 = policy.annualCashflowRows.find((row) => row.year === 2031);

  assert.equal(row2030.amount, 3000);
  assert.equal(row2030.cumulative, 3000);
  assert.equal(row2030.cashValue, null);
  assert.deepEqual(row2030.liabilities, ['生存金', '特别生存金']);
  assert.equal(row2030.age, 42);
  assert.equal(row2031.cashValue, 6009);
});

test('buildFamilyReport uses exact policy-year age for Changxing final cash value row', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 500552,
      insured: '冯力',
      insuredBirthday: '1987-12-07',
      name: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
      date: '2024-09-29',
      paymentPeriod: '10年交',
      coveragePeriod: '至2068年9月30日零时',
      amount: 60000,
      firstPremium: 3296,
      cashflowEntries: [
        {
          year: 2068,
          age: 81,
          amount: 32960,
          cumulative: 32960,
          liability: '满期生存保险金',
          policyId: 500552,
          productName: '新华人寿保险股份有限公司畅行万里智赢版两全保险',
        },
      ],
      cashValues: [
        { policyYear: 44, age: 0, cashValue: 31560 },
      ],
    }),
  ]);

  const member = report.wealth.memberReports.find((item) => item.member === '冯力');
  const policy = member.policies.find((item) => item.policyId === 500552);
  const cashValueRow = policy.cashValueRows.find((row) => row.policyYear === 44);
  const annualRow = policy.annualCashflowRows.find((row) => row.year === 2068);

  assert.equal(cashValueRow.calendarYear, 2068);
  assert.equal(cashValueRow.age, 80);
  assert.equal(cashValueRow.cashValue, 31560);
  assert.equal(annualRow.age, 80);
  assert.equal(annualRow.cashValue, 31560);
  assert.equal(annualRow.isMaturityPayout, true);
  assert.equal(annualRow.isContractTerminatingPayout, true);
  assert.equal(annualRow.cashValueReferenceType, 'pre_maturity');
  assert.equal(annualRow.cashValueIsNonAdditiveReference, true);
  assert.equal(annualRow.cashValueIsPreMaturityReference, true);
  assert.match(annualRow.cashValueNote, /不与现金价值叠加领取/u);
  assert.equal(policy.keyPoints.find((item) => item.amount === 31560)?.label, '期满前现金价值参考');
  assert.match(policy.keyPoints.find((item) => item.amount === 31560)?.note, /合同终止/u);
  assert.equal(radarScore(report.radar.family, 'wealth').amount, 32960);
  assert.match(radarScore(report.radar.family, 'wealth').note, /现金价值参考31,560未计入合计/u);
});

test('buildFamilyReport marks any terminating payout cash value as non-additive reference', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 47,
      insured: '爸爸',
      insuredBirthday: '1988-01-01',
      name: '终身寿险',
      date: '2026-01-01',
      cashflowEntries: [
        {
          year: 2030,
          age: 42,
          amount: 100000,
          cumulative: 100000,
          liability: '身故保险金',
          calculationText: '身故保险金给付后，本合同终止。',
          policyId: 47,
          productName: '终身寿险',
        },
      ],
      cashValues: [
        { policyYear: 4, age: 42, cashValue: 30000 },
      ],
    }),
  ]);

  const father = report.wealth.memberReports.find((item) => item.member === '爸爸');
  const policy = father.policies.find((item) => item.policyId === 47);
  const annualRow = policy.annualCashflowRows.find((row) => row.year === 2030);

  assert.equal(annualRow.isContractTerminatingPayout, true);
  assert.equal(annualRow.isMaturityPayout, false);
  assert.equal(annualRow.cashValueReferenceType, 'pre_termination');
  assert.equal(annualRow.cashValueIsNonAdditiveReference, true);
  assert.match(annualRow.cashValueNote, /给付后合同终止/u);
  assert.equal(policy.keyPoints.find((item) => item.amount === 30000)?.label, '终止前现金价值参考');
});

test('buildFamilyReport marks same-year non-terminal cash value as surrender reference', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 48,
      insured: '妈妈',
      insuredBirthday: '1988-01-01',
      name: '年金保险',
      date: '2026-01-01',
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1000, cumulative: 1000, liability: '生存金', policyId: 48, productName: '年金保险' },
      ],
      cashValues: [
        { policyYear: 4, age: 42, cashValue: 30000 },
      ],
    }),
  ]);

  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const policy = mother.policies.find((item) => item.policyId === 48);
  const annualRow = policy.annualCashflowRows.find((row) => row.year === 2030);

  assert.equal(annualRow.isContractTerminatingPayout, false);
  assert.equal(annualRow.cashValueReferenceType, 'surrender');
  assert.equal(annualRow.cashValueIsNonAdditiveReference, true);
  assert.match(annualRow.cashValueNote, /不与当年领取金额叠加领取/u);
  assert.equal(policy.keyPoints.find((item) => item.amount === 30000)?.label, '末期现金价值参考');
});

test('buildFamilyReport does not synthesize blank cash value years for incomplete OCR rows', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 46,
      insured: '妈妈',
      insuredBirthday: '1988-12-16',
      name: '新华人寿保险股份有限公司安鑫优选终身护理保险',
      date: '2026-03-26',
      cashValues: [
        { policyYear: 1, age: 0, cashValue: 336 },
        { policyYear: 2, age: 0, cashValue: 1272 },
        { policyYear: 4, age: 0, cashValue: 3432 },
      ],
    }),
  ]);

  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const policy = mother.policies.find((item) => item.policyId === 46);

  assert.deepEqual(policy.annualCashflowRows.map((row) => row.year), [2027, 2028, 2030]);
  assert.equal(policy.annualCashflowRows.some((row) => row.year === 2029), false);
  assert.equal(policy.annualCashflowRows[0].age, 38);
  assert.ok(policy.attentionItems.includes('现金价值表缺少第3年'));
});

test('buildFamilyReport keeps cash value stock out of annual aggregate wealth totals', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 45,
      applicant: '温舒萍',
      insured: '妈妈',
      name: '现金流年金',
      date: '2025-01-01',
      paymentPeriod: '1年',
      cashflowEntries: [
        { year: 2027, age: 39, amount: 20, cumulative: 20, liability: '生存金', policyId: 45, productName: '现金流年金', calculationText: '' },
        { year: 2028, age: 40, amount: 30, cumulative: 50, liability: '生存金', policyId: 45, productName: '现金流年金', calculationText: '' },
      ],
      cashValues: [
        { policyYear: 1, age: 38, cashValue: 100 },
        { policyYear: 2, age: 39, cashValue: 130 },
        { policyYear: 3, age: 40, cashValue: 160 },
      ],
    }),
  ]);

  const row2026 = report.wealth.aggregateRows.find((row) => row.year === 2026);
  const row2027 = report.wealth.aggregateRows.find((row) => row.year === 2027);
  const row2028 = report.wealth.aggregateRows.find((row) => row.year === 2028);

  assert.equal(row2026, undefined);
  assert.equal(row2027.cashValueTotal, 0);
  assert.equal(row2027.cumulativePayoutInflow, 20);
  assert.equal(row2027.totalValue, 20);
  assert.equal(row2028.cashValueTotal, 0);
  assert.equal(row2028.cumulativePayoutInflow, 50);
  assert.equal(row2028.totalValue, 50);
  assert.equal(report.wealth.aggregateRows.some((row) => row.details.some((detail) => detail.type === 'cashValue')), false);
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
  const row2026 = report.wealth.aggregateRows.find((row) => row.year === 2026);

  assert.equal(row2026, undefined);
  assert.equal(report.wealth.aggregateRows.length, 0);
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

test('buildFamilyReport keeps cash value date and age on policy rows, not aggregate rows', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 43,
      applicant: '温舒萍',
      insured: '妈妈',
      name: '盛世恒盈年金',
      date: '2025-12-22',
      paymentPeriod: '1年',
      cashValues: [{ policyYear: 1, age: 37, cashValue: 282 }],
    }),
  ]);

  const row2026 = report.wealth.aggregateRows.find((row) => row.year === 2026);
  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const policy = mother.policies.find((item) => item.policyId === 43);
  const cashValueRow = policy.cashValueRows[0];

  assert.equal(row2026, undefined);
  assert.equal(cashValueRow.calendarYear, 2026);
  assert.equal(cashValueRow.age, 37);
});
