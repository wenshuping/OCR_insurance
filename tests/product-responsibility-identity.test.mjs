import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  listEquivalentResponsibilityProductRows,
  productIdentityMatches,
  responsibilityProductIdentity,
  sameResponsibilityProduct,
} from '../server/product-responsibility-identity.mjs';
import { replaceApprovedArtifactRowsInDevelopmentDb } from '../.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/publish_development_artifact.mjs';

const shortIdentity = {
  company: '新华保险',
  productName: '医药安欣（易核版）医疗保险',
};
const fullIdentity = {
  company: '新华人寿保险股份有限公司',
  productName: '新华人寿保险股份有限公司医药安欣（易核版）医疗保险',
};

test('maps insurer aliases and company-prefixed product names to one responsibility product identity', () => {
  assert.equal(sameResponsibilityProduct(shortIdentity, fullIdentity), true);
  assert.equal(
    responsibilityProductIdentity(shortIdentity)?.productKey,
    responsibilityProductIdentity({
      company: '新华人寿保险',
      productName: '医药安欣（易核版）医疗保险',
    })?.productKey,
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

test('approved artifact replacement deletes alias rows and binds cards to the selected canonical product', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE insurance_products (
        canonical_product_id TEXT, company TEXT, official_name TEXT
      );
      CREATE TABLE insurance_indicator_records (
        id TEXT PRIMARY KEY, company TEXT, product_name TEXT, coverage_type TEXT, liability TEXT, payload TEXT NOT NULL
      );
      CREATE TABLE product_responsibility_cards (
        id TEXT PRIMARY KEY, product_key TEXT NOT NULL, company TEXT, product_name TEXT, title TEXT,
        category TEXT, cashflow_treatment TEXT, calculation_status TEXT, calculation_reason TEXT,
        responsibility_scope TEXT, selection_status TEXT, source_url TEXT, generated_at TEXT,
        updated_at TEXT, payload TEXT NOT NULL
      );
      CREATE TABLE optional_responsibility_records (
        id TEXT PRIMARY KEY, company TEXT, product_name TEXT, liability TEXT, payload TEXT NOT NULL
      );
      CREATE TABLE product_responsibility_artifacts (
        id TEXT PRIMARY KEY, company TEXT NOT NULL, product_name TEXT NOT NULL, source_digest TEXT NOT NULL,
        source_url TEXT, published_at TEXT NOT NULL, publisher_version TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE product_customer_responsibility_summaries (
        id TEXT PRIMARY KEY, product_key TEXT, company TEXT, product_name TEXT
      );
    `);
    db.prepare('INSERT INTO insurance_products VALUES (?, ?, ?)').run(
      'product-medical-anxin', '新华保险', '医药安欣（易核版）医疗保险',
    );
    db.prepare('INSERT INTO product_responsibility_cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'legacy-card', 'company_product:legacy', '新华保险', '医药安欣（易核版）医疗保险', '旧责任',
      '', '', '', '', '', '', '', '', '', '{}',
    );
    db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?, ?, ?)').run(
      'legacy-summary', 'company_product:legacy', '新华保险', '医药安欣（易核版）医疗保险',
    );
    const artifact = {
      company: fullIdentity.company,
      productName: fullIdentity.productName,
      productIdentity: { sourceDigest: 'sha256:test', sourceUrl: 'https://example.test/terms.pdf' },
      audit: { status: 'approved' },
      responsibilities: [{
        responsibilityId: 'medical-1',
        liability: '一般医疗费用保险金',
        responsibilityKind: 'benefit',
        selectionStatus: 'included',
        triggerCondition: '发生合同约定医疗费用',
        insurerObligation: '按约定报销',
        card: { title: '医疗费用怎么赔', customerSummary: '提供医疗费用保障。' },
        indicators: [{ indicatorName: '一般医疗费用保险金', calculationStatus: 'needs_claim_facts' }],
      }],
    };

    const result = replaceApprovedArtifactRowsInDevelopmentDb({
      db,
      artifact,
      now: '2026-07-23T00:00:00.000Z',
    });

    assert.equal(result.previous.cards, 1);
    assert.equal(result.previous.customerSummaries, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM product_responsibility_cards').get().n, 1);
    const card = db.prepare('SELECT product_key, title, payload FROM product_responsibility_cards').get();
    assert.equal(card.product_key, 'canonical:product-medical-anxin');
    assert.equal(card.title, '一般医疗费用保险金');
    assert.equal(JSON.parse(card.payload).title, '医疗费用怎么赔');
    assert.equal(JSON.parse(card.payload).canonicalProductId, 'product-medical-anxin');
  } finally {
    db.close();
  }
});
