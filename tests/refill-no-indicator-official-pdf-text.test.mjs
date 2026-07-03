import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { loadTargetRows } from '../scripts/refill-no-indicator-official-pdf-text.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'official-pdf-refill-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
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
    CREATE TABLE product_responsibility_cards (
      id TEXT PRIMARY KEY,
      product_key TEXT NOT NULL,
      company TEXT,
      product_name TEXT,
      title TEXT,
      payload TEXT NOT NULL
    );
  `);
  db.close();
  return { dir, dbPath };
}

function insertKnowledge(db, { id, company, productName, pageText = '短文本' }) {
  const url = `https://www.aia.com.cn/content/dam/cn/zh-cn/docs/public-disclosure/${id}.pdf`;
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, company, productName, url, JSON.stringify({
    id,
    company,
    productName,
    url,
    official: true,
    evidenceLevel: 'insurer_official',
    pageText,
  }));
}

function insertIndicator(db, { id, company, productName }) {
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, company, productName, '规则参数', '赔付方式', JSON.stringify({
    id,
    company,
    productName,
    coverageType: '规则参数',
    liability: '赔付方式',
  }));
}

function insertCard(db, { id, company, productName }) {
  db.prepare(`
    INSERT INTO product_responsibility_cards (id, product_key, company, product_name, title, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, `company_product:${company}:${productName}`, company, productName, '身故保险金', '{}');
}

test('loadTargetRows can include products that have indicators but are missing responsibility cards', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    const db = new DatabaseSync(dbPath);
    try {
      insertKnowledge(db, { id: 1, company: '友邦人寿', productName: '已有指标缺责任卡保险' });
      insertIndicator(db, { id: 'ind_1', company: '友邦人寿', productName: '已有指标缺责任卡保险' });

      insertKnowledge(db, { id: 2, company: '友邦人寿', productName: '责任指标都完整保险' });
      insertIndicator(db, { id: 'ind_2', company: '友邦人寿', productName: '责任指标都完整保险' });
      insertCard(db, { id: 'card_2', company: '友邦人寿', productName: '责任指标都完整保险' });

      insertKnowledge(db, { id: 3, company: '友邦人寿', productName: '缺指标保险' });
    } finally {
      db.close();
    }

    const readDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        loadTargetRows(readDb, { companies: ['友邦人寿'] }).map((row) => row.productName),
        ['缺指标保险'],
      );
      assert.deepEqual(
        loadTargetRows(readDb, {
          companies: ['友邦人寿'],
          targetScope: 'missing-cards-or-indicators',
        }).map((row) => row.productName),
        ['已有指标缺责任卡保险', '缺指标保险'],
      );
    } finally {
      readDb.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
