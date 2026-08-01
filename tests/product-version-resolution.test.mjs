import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProductVersionResolutionService,
  resolveProductVersion,
} from '../server/product-version-resolution.service.mjs';

const versions = [
  {
    id: 'version-2022',
    canonicalProductId: 'product-1',
    versionLabel: '2022版',
    filingCode: '备案-2022',
    effectiveFrom: '2022-01-01',
    effectiveTo: '2023-12-31',
  },
  {
    id: 'version-2024',
    canonicalProductId: 'product-1',
    versionLabel: '2024版',
    filingCode: '备案-2024',
    effectiveFrom: '2024-01-01',
    effectiveTo: '',
  },
];

test('product version resolution uses exact metadata and inclusive effective dates', () => {
  assert.deepEqual(resolveProductVersion({
    canonicalProductId: 'product-1',
    filingCode: '备案-2022',
    versions,
  }), {
    canonicalProductId: 'product-1',
    productVersionId: 'version-2022',
    resolution: 'exact',
    confidence: 1,
    reasons: ['filing_code_exact'],
    effectiveFrom: '2022-01-01',
    effectiveTo: '2023-12-31',
    candidates: ['version-2022'],
  });
  assert.equal(resolveProductVersion({
    canonicalProductId: 'product-1',
    asOfDate: '2023-12-31',
    versions,
  }).productVersionId, 'version-2022');
  assert.equal(resolveProductVersion({
    canonicalProductId: 'product-1',
    asOfDate: '2024-01-01',
    versions,
  }).productVersionId, 'version-2024');
  assert.equal(resolveProductVersion({
    canonicalProductId: 'product-1',
    versionLabel: '2024版',
    effectiveFrom: '2024-01-01',
    versions,
  }).productVersionId, 'version-2024');
});

test('product version resolution does not guess when no match or multiple versions remain', () => {
  const overlapping = [
    ...versions,
    {
      id: 'version-special',
      canonicalProductId: 'product-1',
      versionLabel: '特别版',
      filingCode: '备案-special',
      effectiveFrom: '2024-06-01',
      effectiveTo: '',
    },
  ];
  assert.equal(resolveProductVersion({
    canonicalProductId: 'product-1',
    asOfDate: '2024-07-01',
    versions: overlapping,
  }).resolution, 'unresolved');
  assert.deepEqual(resolveProductVersion({
    canonicalProductId: 'product-1',
    filingCode: '不存在',
    versions,
  }).reasons, ['no_version_match']);
  assert.deepEqual(resolveProductVersion({
    canonicalProductId: 'product-1',
    asOfDate: '2024/01/01',
    versions,
  }).reasons, ['invalid_asOfDate']);
  assert.deepEqual(resolveProductVersion({ versions }).reasons, ['missing_canonical_product_id']);
});

test('product version resolution service loads only the requested product versions', () => {
  const calls = [];
  const service = createProductVersionResolutionService({
    store: {
      listProductVersions(input) {
        calls.push(input);
        return versions;
      },
    },
  });
  const result = service.resolve({
    tenantId: 'default',
    canonicalProductId: 'product-1',
    versionLabel: '2022版',
  });
  assert.deepEqual(calls, [{ tenantId: 'default', canonicalProductId: 'product-1' }]);
  assert.equal(result.productVersionId, 'version-2022');
  assert.deepEqual(service.resolve({ canonicalProductId: 'product-1' }).reasons, ['missing_tenant_id']);
});
