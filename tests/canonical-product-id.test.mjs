import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  buildCanonicalProductId,
  canonicalProductIdFromOfficialProduct,
  normalizeCanonicalProductPart,
  withCanonicalProductId,
} from '../server/canonical-product-id.mjs';
import {
  backfillDatabase,
  backfillCanonicalProductIdsInObject,
} from '../scripts/backfill-canonical-product-ids.mjs';

const officialProductName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';

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

test('backfill helper treats whitespace-only canonical id as missing', () => {
  const output = backfillCanonicalProductIdsInObject({
    company: '新华保险',
    productName: officialProductName,
    canonicalProductId: '   ',
  });

  assert.match(output.canonicalProductId, /^product_[a-f0-9]{16}$/u);
});

test('backfill database dry-run rolls back, write commits, and second write is idempotent', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'canonical-product-id-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE knowledge_records (
        id INTEGER,
        company TEXT,
        product_name TEXT,
        url TEXT,
        payload TEXT
      );
      CREATE TABLE insurance_indicator_records (
        id TEXT,
        company TEXT,
        product_name TEXT,
        coverage_type TEXT,
        liability TEXT,
        payload TEXT
      );
      CREATE TABLE optional_responsibility_records (
        id TEXT,
        company TEXT,
        product_name TEXT,
        liability TEXT,
        payload TEXT
      );
      CREATE TABLE policies (
        id INTEGER,
        company TEXT,
        name TEXT,
        payload TEXT
      );
    `);

    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(1, '新华保险', officialProductName, 'https://example.test/product', '{ }');
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(2, '新华保险', officialProductName, 'https://example.test/product-array', '[]');
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(3, '新华保险', officialProductName, 'https://example.test/product-null', null);
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(4, '新华保险', officialProductName, 'https://example.test/product-string', '"not-an-object"');
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(5, '新华保险', officialProductName, 'https://example.test/product-broken', '{broken');
    db.prepare(`
      INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('ind_1', '新华保险', officialProductName, '疾病保障', '重大疾病保险金', '{"liability":"重大疾病保险金"}');
    db.prepare(`
      INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run('opt_1', '新华保险', officialProductName, '可选责任', '{"liability":"可选责任"}');
    db.prepare('INSERT INTO policies (id, company, name, payload) VALUES (?, ?, ?, ?)')
      .run(1, '新华保险', officialProductName, JSON.stringify({
        plans: [
          {
            role: 'main',
            company: '新华保险',
            name: officialProductName,
          },
        ],
      }));
  } finally {
    db.close();
  }

  const readState = () => {
    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const knowledge = readDb.prepare('SELECT company, product_name, payload FROM knowledge_records WHERE id = 1').get();
      const knowledgeArrayPayload = readDb.prepare('SELECT payload FROM knowledge_records WHERE id = 2').get().payload;
      const knowledgeNullPayload = readDb.prepare('SELECT payload FROM knowledge_records WHERE id = 3').get().payload;
      const knowledgeStringPayload = readDb.prepare('SELECT payload FROM knowledge_records WHERE id = 4').get().payload;
      const knowledgeBrokenPayload = readDb.prepare('SELECT payload FROM knowledge_records WHERE id = 5').get().payload;
      const indicator = readDb.prepare('SELECT company, product_name, payload FROM insurance_indicator_records WHERE id = ?').get('ind_1');
      const optional = readDb.prepare('SELECT company, product_name, payload FROM optional_responsibility_records WHERE id = ?').get('opt_1');
      const policy = readDb.prepare('SELECT company, name, payload FROM policies WHERE id = 1').get();
      return {
        knowledge,
        knowledgeArrayPayload,
        knowledgeNullPayload,
        knowledgeStringPayload,
        knowledgeBrokenPayload,
        indicator,
        optional,
        policy,
        payloads: {
          knowledge: JSON.parse(knowledge.payload),
          indicator: JSON.parse(indicator.payload),
          optional: JSON.parse(optional.payload),
          policy: JSON.parse(policy.payload),
        },
      };
    } finally {
      readDb.close();
    }
  };

  try {
    const dryRun = backfillDatabase(dbPath, { dryRun: true });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.knowledgeRecords.updated, 1);
    assert.equal(dryRun.knowledgeRecords.skippedInvalidJson, 4);
    assert.ok(dryRun.insuranceIndicatorRecords.updated > 0);
    assert.ok(dryRun.optionalResponsibilityRecords.updated > 0);
    assert.ok(dryRun.policies.updated > 0);

    const afterDryRun = readState();
    assert.equal(afterDryRun.payloads.knowledge.canonicalProductId, undefined);
    assert.equal(afterDryRun.knowledgeArrayPayload, '[]');
    assert.equal(afterDryRun.knowledgeNullPayload, null);
    assert.equal(afterDryRun.knowledgeStringPayload, '"not-an-object"');
    assert.equal(afterDryRun.knowledgeBrokenPayload, '{broken');
    assert.equal(afterDryRun.payloads.indicator.canonicalProductId, undefined);
    assert.equal(afterDryRun.payloads.optional.canonicalProductId, undefined);
    assert.equal(afterDryRun.payloads.policy.canonicalProductId, undefined);
    assert.equal(afterDryRun.payloads.policy.plans[0].canonicalProductId, undefined);

    const write = backfillDatabase(dbPath, { dryRun: false });
    assert.equal(write.dryRun, false);
    assert.equal(write.knowledgeRecords.updated, 1);
    assert.equal(write.knowledgeRecords.skippedInvalidJson, 4);
    assert.ok(write.insuranceIndicatorRecords.updated > 0);
    assert.ok(write.optionalResponsibilityRecords.updated > 0);
    assert.ok(write.policies.updated > 0);

    const afterWrite = readState();
    assert.match(afterWrite.payloads.knowledge.canonicalProductId, /^product_[a-f0-9]{16}$/u);
    assert.equal(afterWrite.knowledgeArrayPayload, '[]');
    assert.equal(afterWrite.knowledgeNullPayload, null);
    assert.equal(afterWrite.knowledgeStringPayload, '"not-an-object"');
    assert.equal(afterWrite.knowledgeBrokenPayload, '{broken');
    assert.match(afterWrite.payloads.indicator.canonicalProductId, /^product_[a-f0-9]{16}$/u);
    assert.match(afterWrite.payloads.optional.canonicalProductId, /^product_[a-f0-9]{16}$/u);
    assert.match(afterWrite.payloads.policy.canonicalProductId, /^product_[a-f0-9]{16}$/u);
    assert.equal(afterWrite.payloads.policy.canonicalProductId, afterWrite.payloads.policy.plans[0].canonicalProductId);

    assert.equal(afterWrite.knowledge.company, '新华保险');
    assert.equal(afterWrite.knowledge.product_name, officialProductName);
    assert.equal(afterWrite.indicator.company, '新华保险');
    assert.equal(afterWrite.indicator.product_name, officialProductName);
    assert.equal(afterWrite.optional.company, '新华保险');
    assert.equal(afterWrite.optional.product_name, officialProductName);
    assert.equal(afterWrite.policy.company, '新华保险');
    assert.equal(afterWrite.policy.name, officialProductName);

    const secondWrite = backfillDatabase(dbPath, { dryRun: false });
    assert.equal(secondWrite.knowledgeRecords.updated, 0);
    assert.equal(secondWrite.knowledgeRecords.skippedInvalidJson, 4);
    assert.equal(secondWrite.insuranceIndicatorRecords.updated, 0);
    assert.equal(secondWrite.optionalResponsibilityRecords.updated, 0);
    assert.equal(secondWrite.policies.updated, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
