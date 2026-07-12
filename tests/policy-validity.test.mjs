import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCoveragePeriodEndDate,
  resolvePolicyRecordValidity,
  resolvePolicyValidityStatus,
} from '../src/policy-validity.mjs';

test('resolvePolicyRecordValidity requires confirmed active status and effective coverage dates', () => {
  const now = new Date('2026-07-12T08:00:00.000Z');
  assert.equal(resolvePolicyRecordValidity({ status: 'active', coveragePeriod: '终身' }, { now }).valid, true);
  assert.equal(resolvePolicyRecordValidity({ status: 'unknown', coveragePeriod: '终身' }, { now }).valid, false);
  assert.equal(resolvePolicyRecordValidity({ status: 'active', effectiveDate: '2026-07-13', coveragePeriod: '终身' }, { now }).status, 'future');
  assert.equal(resolvePolicyRecordValidity({ status: 'active', effectiveDate: '2020-01-01', coveragePeriod: '至2026年07月11日' }, { now }).status, 'expired');
  assert.equal(resolvePolicyRecordValidity({ status: 'active', policyState: 'pending', coveragePeriod: '终身' }, { now }).valid, false);
});

test('resolvePolicyValidityStatus marks an exact past coverage end date as expired', () => {
  const status = resolvePolicyValidityStatus('至2025年09月29日', {
    now: new Date(2026, 4, 31, 12, 0, 0),
  });

  assert.equal(status.label, '失效');
  assert.equal(status.tone, 'expired');
});

test('resolvePolicyValidityStatus keeps an exact future coverage end date active', () => {
  const status = resolvePolicyValidityStatus('至2026年06月01日', {
    now: new Date(2026, 4, 31, 12, 0, 0),
  });

  assert.equal(status.label, '有效');
  assert.equal(status.tone, 'active');
});

test('resolvePolicyValidityStatus treats date-only coverage as active through that day', () => {
  const noonStatus = resolvePolicyValidityStatus('至2026年05月31日', {
    now: new Date(2026, 4, 31, 12, 0, 0),
  });
  const nextDayStatus = resolvePolicyValidityStatus('至2026年05月31日', {
    now: new Date(2026, 5, 1, 0, 0, 0),
  });

  assert.equal(noonStatus.label, '有效');
  assert.equal(nextDayStatus.label, '失效');
});

test('parseCoveragePeriodEndDate derives fixed-year coverage from effective date', () => {
  const endDate = parseCoveragePeriodEndDate('1年', { effectiveDate: '2025-06-01' });

  assert.ok(endDate);
  assert.equal(endDate.getFullYear(), 2026);
  assert.equal(endDate.getMonth(), 4);
  assert.equal(endDate.getDate(), 31);
});
