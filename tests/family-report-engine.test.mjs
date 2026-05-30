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

test('buildFamilyReport includes summary and inventory sections', () => {
  const report = buildFamilyReport([makePolicy({ id: 1, insured: '爸爸' })]);
  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.policyInventory.rows.length, 1);
  assert.equal(report.policyInventory.insuredGroups[0].member, '爸爸');
});
