import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildPolicyDerivedResult,
  deriveIndicatorProductKeys,
  derivePolicyProductKeys,
  mergePolicyDerivedResult,
  productKeyFromParts,
} from '../server/policy-derived-results.service.mjs';

test('product key prefers canonical product id and normalizes company product fallback', () => {
  assert.equal(productKeyFromParts({ canonicalProductId: 'product_abc' }), 'canonical:product_abc');
  assert.equal(
    productKeyFromParts({ company: ' 新华保险 ', productName: ' 多倍保障重大疾病保险 ' }),
    'company_product:新华保险:多倍保障重大疾病保险',
  );
});

test('policy product keys include main policy and plan products', () => {
  const keys = derivePolicyProductKeys({
    company: '新华保险',
    name: '多倍保障重大疾病保险',
    canonicalProductId: 'product_main',
    plans: [
      { name: '附加住院医疗', company: '新华保险' },
      { matchedProductName: '附加重疾豁免', canonicalProductId: 'product_rider' },
    ],
  });

  assert.deepEqual(keys, [
    'canonical:product_main',
    'company_product:新华保险:多倍保障重大疾病保险',
    'company_product:新华保险:附加住院医疗',
    'canonical:product_rider',
    'company_product:新华保险:附加重疾豁免',
  ]);
});

test('indicator product keys mirror policy key priority', () => {
  assert.deepEqual(
    deriveIndicatorProductKeys({
      canonicalProductId: 'product_main',
      company: '新华保险',
      productName: '多倍保障重大疾病保险',
    }),
    [
      'canonical:product_main',
      'company_product:新华保险:多倍保障重大疾病保险',
    ],
  );
});

test('buildPolicyDerivedResult stores attached indicators and status metadata', () => {
  const policy = { id: 10, company: '新华保险', name: '多倍保障重大疾病保险', amount: 500000 };
  const indicator = {
    id: 'ind_1',
    company: '新华保险',
    productName: '多倍保障重大疾病保险',
    coverageType: '重疾',
    liability: '重大疾病保险金',
  };
  const row = buildPolicyDerivedResult({
    policy,
    indicatorRecords: [indicator],
    knowledgeRecords: [],
    optionalResponsibilityRecords: [],
    productIndicatorVersions: [{ productKey: 'company_product:新华保险:多倍保障重大疾病保险', version: 3 }],
    now: '2026-06-15T00:00:00.000Z',
  });

  assert.equal(row.policyId, 10);
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.productKeys, ['company_product:新华保险:多倍保障重大疾病保险']);
  assert.equal(row.coverageIndicators.length, 1);
  assert.deepEqual(row.indicatorVersions, { 'company_product:新华保险:多倍保障重大疾病保险': 3 });
});

test('mergePolicyDerivedResult attaches persisted payload and derived status without recomputing', () => {
  const policy = { id: 10, company: '新华保险', name: '多倍保障重大疾病保险' };
  const merged = mergePolicyDerivedResult(policy, {
    policyId: 10,
    status: 'ready',
    staleReason: '',
    coverageIndicators: [{ id: 'ind_1' }],
    optionalResponsibilities: [{ id: 'opt_1' }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });

  assert.deepEqual(merged.coverageIndicators, [{ id: 'ind_1' }]);
  assert.deepEqual(merged.optionalResponsibilities, [{ id: 'opt_1' }]);
  assert.equal(merged.derivedStatus, 'ready');
});
