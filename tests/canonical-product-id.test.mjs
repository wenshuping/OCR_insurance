import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalProductId,
  canonicalProductIdFromOfficialProduct,
  normalizeCanonicalProductPart,
  withCanonicalProductId,
} from '../server/canonical-product-id.mjs';
import {
  backfillCanonicalProductIdsInObject,
} from '../scripts/backfill-canonical-product-ids.mjs';

test('canonical product id is stable for the same official company and product', () => {
  const left = buildCanonicalProductId({
    company: ' 新华保险 ',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });
  const right = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });

  assert.match(left, /^product_[a-f0-9]{16}$/u);
  assert.equal(left, right);
});

test('canonical product id preserves product edition words', () => {
  const xiang = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });
  const ying = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
  });
  const qingdian = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（庆典版）',
  });

  assert.notEqual(xiang, ying);
  assert.notEqual(xiang, qingdian);
  assert.notEqual(ying, qingdian);
});

test('canonical product id helper returns empty id without official product source', () => {
  assert.equal(canonicalProductIdFromOfficialProduct({ company: '新华保险', productName: '' }), '');
  assert.equal(canonicalProductIdFromOfficialProduct({ company: '', productName: '测试产品' }), '');
});

test('normalize canonical product part removes spacing but keeps version markers', () => {
  assert.equal(
    normalizeCanonicalProductPart(' 多 倍 保障 重大疾病保险（智享版） '),
    '多倍保障重大疾病保险(智享版)',
  );
});

test('withCanonicalProductId fills missing id and preserves existing id', () => {
  const filled = withCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });
  const preserved = withCanonicalProductId({
    company: '新华保险',
    productName: '不同产品',
    canonicalProductId: 'product_existing',
  });

  assert.match(filled.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(preserved.canonicalProductId, 'product_existing');
});

test('withCanonicalProductId ignores ambiguous external productId values', () => {
  const filled = withCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
    productId: 'external_123',
  });

  assert.match(filled.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(filled.canonicalProductId, 'external_123');
});

test('backfill helper adds ids to policy and plan payload without changing names', () => {
  const input = {
    company: '新华保险',
    name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
    plans: [
      {
        role: 'main',
        company: '新华保险',
        name: '多倍保障重大疾病保险（智享版）',
        matchedProductName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      },
    ],
  };

  const output = backfillCanonicalProductIdsInObject(input);

  assert.equal(output.name, input.name);
  assert.match(output.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(output.canonicalProductId, output.plans[0].canonicalProductId);
});

test('backfill helper ignores external productId values', () => {
  const output = backfillCanonicalProductIdsInObject({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
    productId: 'external_123',
  });

  assert.match(output.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(output.canonicalProductId, 'external_123');
});

test('backfill helper adds ids to plans that only have official name', () => {
  const output = backfillCanonicalProductIdsInObject({
    company: '新华保险',
    plans: [
      {
        role: 'main',
        company: '新华保险',
        name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      },
    ],
  });

  assert.match(output.plans[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(output.canonicalProductId, output.plans[0].canonicalProductId);
});
