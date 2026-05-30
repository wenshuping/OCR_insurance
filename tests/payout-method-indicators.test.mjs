import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPayoutMethodIndicator,
  inferPayoutMethods,
} from '../scripts/backfill-payout-method-indicators.mjs';

test('inferPayoutMethods classifies fixed, reimbursement, and allowance mechanisms', () => {
  assert.deepEqual(
    inferPayoutMethods({
      productName: '终身寿险',
      text: '被保险人身故或全残，我们按基本保险金额、现金价值或实际交纳的保险费较大者给付保险金。',
    }),
    ['定额给付型'],
  );
  assert.deepEqual(
    inferPayoutMethods({
      productName: '医疗保险',
      text: '对符合当地基本医疗保险规定的医疗费用，在扣除补偿后按赔付比例给付。',
    }),
    ['费用报销型'],
  );
  assert.deepEqual(
    inferPayoutMethods({
      productName: '住院津贴保险',
      text: '被保险人住院治疗的，我们按每日住院津贴日额乘以实际住院日数给付。',
    }),
    ['津贴给付型'],
  );
});

test('inferPayoutMethods returns empty when no payout evidence exists', () => {
  assert.deepEqual(
    inferPayoutMethods({
      productName: '产品条款',
      text: '本资料仅说明投保年龄、保险期间和犹豫期，未载明保险责任赔付机制。',
    }),
    [],
  );
});

test('buildPayoutMethodIndicator creates a policy-matchable direct indicator', () => {
  const indicator = buildPayoutMethodIndicator({
    company: '新华保险',
    productName: '测试医疗津贴保险',
    productType: '医疗险',
    salesStatus: '在售',
    sourceRecordId: '123',
    sourceUrl: 'https://example.test/terms.pdf',
    sourceText: '医疗费用按赔付比例给付，另按每日住院津贴日额给付。',
  }, '2026-05-30T00:00:00.000Z');

  assert.equal(indicator.coverageType, '规则参数');
  assert.equal(indicator.liability, '赔付方式');
  assert.equal(indicator.unit, '方式');
  assert.equal(indicator.valueText, '费用报销型+津贴给付型');
  assert.equal(indicator.company, '新华保险');
  assert.equal(indicator.productName, '测试医疗津贴保险');
});

test('buildPayoutMethodIndicator skips products without payout method evidence', () => {
  assert.equal(
    buildPayoutMethodIndicator({
      company: '新华保险',
      productName: '测试保险',
      sourceText: '投保年龄为出生满30天至60周岁。',
    }),
    null,
  );
});
