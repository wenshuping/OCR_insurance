import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCoveragePeriodEndDate,
  resolvePolicyValidityStatus,
} from '../src/policy-validity.mjs';

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
