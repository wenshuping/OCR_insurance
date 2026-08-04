import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  listEquivalentResponsibilityProductRows,
  productIdentityMatches,
  responsibilityProductIdentity,
  sameResponsibilityProduct,
} from '../server/product-responsibility-identity.mjs';

const shortIdentity = {
  company: '新华保险',
  productName: '医药安欣（易核版）医疗保险',
};
const fullIdentity = {
  company: '新华人寿保险股份有限公司',
  productName: '新华人寿保险股份有限公司医药安欣（易核版）医疗保险',
};

test('maps insurer aliases and company-prefixed product names to one identity', () => {
  assert.equal(sameResponsibilityProduct(shortIdentity, fullIdentity), true);
  assert.equal(
    responsibilityProductIdentity(shortIdentity)?.productKey,
    responsibilityProductIdentity({ company: '新华人寿保险', productName: '医药安欣（易核版）医疗保险' })?.productKey,
  );
});

test('keeps product versions separate', () => {
  assert.equal(sameResponsibilityProduct(shortIdentity, {
    company: '新华人寿保险',
    productName: '医药安欣医疗保险',
  }), false);
  assert.equal(sameResponsibilityProduct({
    company: '新华保险',
    productName: '多倍保障重大疾病保险',
  }, {
    company: '新华人寿保险股份有限公司',
    productName: '多倍保障重大疾病保险（智嬴版）',
  }), false);
});

test('uses product keys before names and rejects a conflicting keyed product', () => {
  const sameKeyDifferentName = productIdentityMatches(
    { canonicalProductId: 'product-a', company: '甲', productName: '旧名称' },
    { canonicalProductId: 'product-a', company: '乙', productName: '新名称' },
  );
  const conflictingKeySameName = productIdentityMatches(
    { canonicalProductId: 'product-a', company: '甲', productName: '同名产品' },
    { canonicalProductId: 'product-b', company: '甲', productName: '同名产品' },
  );

  assert.equal(sameKeyDifferentName, true);
  assert.equal(conflictingKeySameName, false);
});

test('finds every legacy alias row that an approved artifact must replace', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE insurance_indicator_records (company TEXT, product_name TEXT);
      CREATE TABLE product_responsibility_cards (company TEXT, product_name TEXT, product_key TEXT);
      CREATE TABLE optional_responsibility_records (company TEXT, product_name TEXT);
      CREATE TABLE product_responsibility_artifacts (company TEXT, product_name TEXT);
      CREATE TABLE product_customer_responsibility_summaries (company TEXT, product_name TEXT, product_key TEXT);
    `);
    db.prepare('INSERT INTO product_responsibility_cards VALUES (?, ?, ?)').run(
      '新华保险', '医药安欣（易核版）医疗保险', 'company_product:legacy',
    );
    db.prepare('INSERT INTO insurance_indicator_records VALUES (?, ?)').run(
      '新华人寿保险股份有限公司', '新华人寿保险股份有限公司医药安欣（易核版）医疗保险',
    );
    db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?)').run(
      '新华人寿保险', '医药安欣（易核版）医疗保险', 'company_product:old-summary',
    );
    db.prepare('INSERT INTO product_responsibility_cards VALUES (?, ?, ?)').run(
      '新华保险', '医药安欣医疗保险', 'company_product:other-version',
    );

    const rows = listEquivalentResponsibilityProductRows(db, fullIdentity);
    assert.deepEqual(new Set(rows.map((row) => row.table)), new Set([
      'insurance_indicator_records',
      'product_responsibility_cards',
      'product_customer_responsibility_summaries',
    ]));
    assert.equal(rows.some((row) => row.productKey === 'company_product:other-version'), false);
  } finally {
    db.close();
  }
});
