import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrateOldRuntimeExtraProductsToDev } from '../scripts/migrate-old-runtime-extra-products-to-dev.mjs';

function makeDb(dir, name) {
  const dbPath = path.join(dir, name);
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE knowledge_records (
      id INTEGER PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
  `);
  db.close();
  return dbPath;
}

function insertKnowledge(db, row) {
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.url, JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    url: row.url,
    pageText: row.pageText,
  }));
}

function insertIndicator(db, row) {
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.coverageType, row.liability, JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    coverageType: row.coverageType,
    liability: row.liability,
    formulaText: row.formulaText,
  }));
}

test('migrates old runtime products missing from dev by product name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-old-extra-products-'));
  try {
    const oldDbPath = makeDb(dir, 'old.sqlite');
    const devDbPath = makeDb(dir, 'dev.sqlite');

    const oldDb = new DatabaseSync(oldDbPath);
    try {
      insertKnowledge(oldDb, {
        id: 100,
        company: '旧库保险',
        productName: '新增年金保险',
        url: 'https://official.example.com/new.pdf',
        pageText: '保险责任 生存保险金 被保险人生存的，本公司按基本保险金额给付生存保险金。',
      });
      insertKnowledge(oldDb, {
        id: 101,
        company: '旧库保险',
        productName: '新增年金保险',
        url: 'https://official.example.com/new-2.pdf',
        pageText: '身故保险金 被保险人身故的，本公司给付身故保险金。',
      });
      insertKnowledge(oldDb, {
        id: 102,
        company: '旧库保险',
        productName: '开发库已有产品',
        url: 'https://official.example.com/existing.pdf',
        pageText: '不应迁移。',
      });
      insertIndicator(oldDb, {
        id: 'old_ind_1',
        company: '旧库保险',
        productName: '新增年金保险',
        coverageType: '现金流',
        liability: '生存保险金',
        formulaText: '生存保险金 = 基本保险金额',
      });
    } finally {
      oldDb.close();
    }

    const devDb = new DatabaseSync(devDbPath);
    try {
      insertKnowledge(devDb, {
        id: 5,
        company: '开发库保险',
        productName: '开发库已有产品',
        url: 'https://official.example.com/dev-existing.pdf',
        pageText: '已有产品名。',
      });
    } finally {
      devDb.close();
    }

    const dryRun = migrateOldRuntimeExtraProductsToDev({
      oldDbPath,
      devDbPath,
      now: '2026-06-29T00:00:00.000Z',
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.selectedProducts, 1);
    assert.equal(dryRun.selectedKnowledgeRows, 2);
    assert.equal(dryRun.selectedIndicatorRows, 1);

    const backupPath = path.join(dir, 'before.sqlite');
    const write = migrateOldRuntimeExtraProductsToDev({
      oldDbPath,
      devDbPath,
      write: true,
      backupPath,
      now: '2026-06-29T00:00:00.000Z',
    });
    assert.equal(write.insertedKnowledgeRows, 2);
    assert.equal(write.insertedIndicatorRows, 1);
    assert.equal(fs.existsSync(backupPath), true);

    const readDb = new DatabaseSync(devDbPath, { readOnly: true });
    try {
      const products = readDb.prepare('SELECT company, product_name, COUNT(*) AS count FROM knowledge_records GROUP BY company, product_name ORDER BY product_name, company').all()
        .map((row) => ({ ...row }));
      assert.deepEqual(products, [
        { company: '开发库保险', product_name: '开发库已有产品', count: 1 },
        { company: '旧库保险', product_name: '新增年金保险', count: 2 },
      ]);
      const migratedPayload = JSON.parse(readDb.prepare('SELECT payload FROM knowledge_records WHERE product_name = ? ORDER BY id LIMIT 1').get('新增年金保险').payload);
      assert.equal(migratedPayload.originalKnowledgeRecordId, 100);
      assert.equal(migratedPayload.migrationVersion, '2026-06-29-old-runtime-extra-products-migration');
      assert.notEqual(migratedPayload.id, 100);

      const indicator = readDb.prepare('SELECT id, payload FROM insurance_indicator_records WHERE product_name = ?').get('新增年金保险');
      assert.match(indicator.id, /^ind_old_extra_/u);
      assert.equal(JSON.parse(indicator.payload).originalIndicatorRecordId, 'old_ind_1');
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
