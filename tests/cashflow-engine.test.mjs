// tests/cashflow-engine.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMemberAnnualSummaries,
} from '../src/cashflow-engine.mjs';

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
