import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { syncStateKnowledgeIndicatorsToSqlite } from '../scripts/sync-state-knowledge-indicators-to-sqlite.mjs';

function makeTempFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-to-sqlite-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const statePath = path.join(dir, 'state.json');
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
  db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
    .run(1, '已有公司', '已有产品', 'https://db.test/old', JSON.stringify({ id: 1, company: '已有公司', productName: '数据库版本' }));
  db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
    .run(10, '其他公司', '占用ID产品', 'https://db.test/collision', JSON.stringify({ id: 10, company: '其他公司', productName: '占用ID产品' }));
  db.close();
  fs.writeFileSync(statePath, JSON.stringify({
    nextId: 100,
    knowledgeRecords: [
      { id: 1, company: '已有公司', productName: '已有产品', url: 'https://db.test/old' },
      { id: 2, company: '新增公司', productName: '新增产品', url: 'https://state.test/new' },
      { id: 10, company: '新增公司', productName: 'ID冲突产品', url: 'https://state.test/collision' },
    ],
    insuranceIndicatorRecords: [
      {
        id: 'ind_new',
        company: '新增公司',
        productName: '新增产品',
        coverageType: '身故保障',
        liability: '身故保险金',
      },
    ],
  }), 'utf8');
  return { dir, dbPath, statePath };
}

test('syncStateKnowledgeIndicatorsToSqlite inserts missing rows without overwriting existing rows', () => {
  const { dir, dbPath, statePath } = makeTempFixture();
  try {
    const dryRun = syncStateKnowledgeIndicatorsToSqlite({ dbPath, statePath, companies: ['新增公司'] });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.stateKnowledgeRows, 2);
    assert.equal(dryRun.missingKnowledgeRows, 2);
    assert.equal(dryRun.idCollisionRows, 1);
    assert.equal(dryRun.missingIndicatorRows, 1);

    const written = syncStateKnowledgeIndicatorsToSqlite({ dbPath, statePath, companies: ['新增公司'], write: true });
    assert.equal(written.dryRun, false);
    assert.equal(written.missingKnowledgeRows, 2);
    assert.equal(written.idCollisionRows, 1);
    assert.equal(written.missingIndicatorRows, 1);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const existing = JSON.parse(db.prepare('SELECT payload FROM knowledge_records WHERE id = 1').get().payload);
      assert.equal(existing.productName, '数据库版本');
      const inserted = db.prepare('SELECT company, product_name FROM knowledge_records WHERE id = 2').get();
      assert.equal(inserted.company, '新增公司');
      assert.equal(inserted.product_name, '新增产品');
      const collision = db.prepare('SELECT id, payload FROM knowledge_records WHERE product_name = ?').get('ID冲突产品');
      assert.notEqual(collision.id, 10);
      assert.equal(JSON.parse(collision.payload).originalStateId, 10);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count, 1);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
