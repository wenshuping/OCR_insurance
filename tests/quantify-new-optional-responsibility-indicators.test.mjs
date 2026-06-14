import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { quantifyNewOptionalResponsibilityIndicators } from '../scripts/quantify-new-optional-responsibility-indicators.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optional-indicators-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE optional_responsibility_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      liability TEXT,
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
  return { dir, dbPath };
}

function insertOptional(dbPath, row) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare(`
      INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(row.id, row.company, row.productName, row.liability, JSON.stringify({
      id: row.id,
      company: row.company,
      productName: row.productName,
      canonicalProductId: row.canonicalProductId || '',
      liability: row.liability,
      title: row.liability,
      responsibilityScope: 'optional',
      quantificationStatus: 'pending_review',
      quantificationReason: '缺少可计算结构化指标',
      indicatorIds: [],
      sourceExcerpt: row.sourceExcerpt,
      sourceRecordId: row.sourceRecordId || 'source_1',
      sourceUrl: row.sourceUrl || 'https://example.com/terms.pdf',
      sourceTitle: row.sourceTitle || `${row.productName}条款`,
    }));
  } finally {
    db.close();
  }
}

test('quantifies high-confidence optional responsibility indicators and leaves weak rows pending', () => {
  const { dir, dbPath } = makeTempDb();
  try {
    insertOptional(dbPath, {
      id: 'opt_cancer',
      company: '测试人寿',
      productName: '测试重大疾病保险',
      liability: '第二次恶性肿瘤保险金',
      sourceExcerpt: '可选责任第二次恶性肿瘤保险金若被保险人再次确诊恶性肿瘤，我们按本主险合同的基本保险金额给付第二次恶性肿瘤保险金。',
    });
    insertOptional(dbPath, {
      id: 'opt_generic',
      company: '测试人寿',
      productName: '测试年金保险',
      liability: '该项责任的基本保险金',
      sourceExcerpt: '可选责任 投保人可以选择可选责任作为合同项下的保险责任，并与本公司约定该项责任的基本保险金额。',
    });
    insertOptional(dbPath, {
      id: 'opt_cancer_duplicate',
      company: '测试人寿',
      productName: '测试重大疾病保险',
      liability: '我们按本主险合同的基本保险金额',
      sourceExcerpt: '可选责任第二次恶性肿瘤保险金若被保险人再次确诊恶性肿瘤，我们按本主险合同的基本保险金额给付第二次恶性肿瘤保险金。',
    });

    const dryRun = quantifyNewOptionalResponsibilityIndicators({ dbPath });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.beforePending, 3);
    assert.equal(dryRun.optionalRecordUpdates, 2);
    assert.equal(dryRun.indicatorUpserts, 1);
    assert.equal(dryRun.afterPending, 1);

    const written = quantifyNewOptionalResponsibilityIndicators({ dbPath, write: true });
    assert.equal(written.beforePending, 3);
    assert.equal(written.afterPending, 1);

    const db = new DatabaseSync(dbPath);
    try {
      const indicator = db.prepare('SELECT liability, payload FROM insurance_indicator_records').get();
      assert.equal(indicator.liability, '第二次恶性肿瘤保险金');
      const payload = JSON.parse(indicator.payload);
      assert.equal(payload.formulaText, '第二次恶性肿瘤保险金 = 基本保险金额 × 100%');
      assert.deepEqual([...payload.optionalResponsibilityIds].sort(), ['opt_cancer', 'opt_cancer_duplicate']);

      const pending = db.prepare(`
        SELECT COUNT(*) AS count
          FROM optional_responsibility_records
         WHERE json_extract(payload, '$.quantificationStatus') = 'pending_review'
      `).get().count;
      assert.equal(pending, 1);
      const duplicateGroups = db.prepare(`
        SELECT COUNT(*) AS count
          FROM (
            SELECT company, product_name, liability
              FROM optional_responsibility_records
             GROUP BY company, product_name, liability
            HAVING COUNT(*) > 1
          )
      `).get().count;
      assert.equal(duplicateGroups, 0);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
