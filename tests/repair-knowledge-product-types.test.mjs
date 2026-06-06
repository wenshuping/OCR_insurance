import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { repairKnowledgeProductTypes } from '../scripts/repair-knowledge-product-types.mjs';

test('repairKnowledgeProductTypes dry-run rolls back and write commits normalized product types', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'repair-knowledge-product-types-'));
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
    `);
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(1, '新华保险', '新华人寿保险股份有限公司i他男性特定疾病保险', 'https://example.test/ci', JSON.stringify({
        company: '新华保险',
        productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
        productType: '健康险',
        pageText: '保险责任包括特定重大疾病保险金、特定轻症疾病保险金。',
        url: 'https://example.test/ci',
      }));
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(2, '中国人寿', '国寿鑫安盈两全保险', 'https://example.test/endowment', JSON.stringify({
        company: '中国人寿',
        productName: '国寿鑫安盈两全保险',
        productType: 'P2',
        url: 'https://example.test/endowment',
      }));
  } finally {
    db.close();
  }

  const dryRun = repairKnowledgeProductTypes(dbPath, { dryRun: true });
  assert.equal(dryRun.updated, 2);
  assert.equal(dryRun.byType['重疾险'], 1);
  assert.equal(dryRun.byType['两全保险'], 1);

  const readBeforeWrite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const payload = JSON.parse(readBeforeWrite.prepare('SELECT payload FROM knowledge_records WHERE id = 2').get().payload);
    assert.equal(payload.productType, 'P2');
  } finally {
    readBeforeWrite.close();
  }

  const write = repairKnowledgeProductTypes(dbPath, { dryRun: false });
  assert.equal(write.updated, 2);

  const readAfterWrite = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row1 = JSON.parse(readAfterWrite.prepare('SELECT payload FROM knowledge_records WHERE id = 1').get().payload);
    const row2 = JSON.parse(readAfterWrite.prepare('SELECT payload FROM knowledge_records WHERE id = 2').get().payload);
    assert.equal(row1.productType, '重疾险');
    assert.equal(row2.productType, '两全保险');
  } finally {
    readAfterWrite.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
