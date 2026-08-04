import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { cleanupExactResponsibilityIndicators } from '../scripts/cleanup-exact-responsibility-indicators.mjs';

function createDb(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE insurance_indicator_records (
        id TEXT PRIMARY KEY,
        company TEXT,
        product_name TEXT,
        coverage_type TEXT,
        liability TEXT,
        payload TEXT NOT NULL
      );
    `);
    const insert = db.prepare(`
      INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const company = '中邮人寿';
    const productName = '中邮年年好邮保一生A款终身寿险';
    const expectedSourceUrl = 'https://www.chinapost-life.com/publish/publish1/publish1_3/publish1_3_2/202306/P020230629441661283125.pdf';
    insert.run('good', company, productName, '责任', '疾病全残', JSON.stringify({ sourceUrl: expectedSourceUrl }));
    insert.run('bad-2022-a', company, productName, '责任', '您在指定和变更身故保险金', JSON.stringify({ sourceUrl: 'https://www.chinapost-life.com/2022.pdf' }));
    insert.run('bad-2022-b', company, productName, '责任', '申请(一)保险金', JSON.stringify({ sourceUrl: 'https://www.chinapost-life.com/2022.pdf' }));
    insert.run('bad-2023', company, productName, '规则参数', '赔付方式', JSON.stringify({ sourceUrl: 'https://www.chinapost-life.com/2023-other.pdf' }));
    return { company, productName, expectedSourceUrl };
  } finally {
    db.close();
  }
}

test('exact responsibility cleanup only removes the reviewed conflicting indicator IDs after backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-responsibility-cleanup-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  try {
    const { company, productName, expectedSourceUrl } = createDb(dbPath);
    const args = {
      dbPath,
      company,
      productName,
      expectedSourceUrl,
      expectedLiabilities: ['疾病全残'],
      removeIds: ['bad-2022-a', 'bad-2022-b', 'bad-2023'],
    };

    const dryRun = cleanupExactResponsibilityIndicators(args);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.deletedIndicatorIds.length, 0);
    assert.equal(dryRun.candidates.length, 3);

    const before = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(before.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count, 4);
    } finally {
      before.close();
    }

    const written = cleanupExactResponsibilityIndicators({ ...args, backupPath, write: true });
    assert.equal(written.ok, true);
    assert.equal(written.dryRun, false);
    assert.deepEqual(written.deletedIndicatorIds, args.removeIds);
    assert.equal(written.quickCheck, 'ok');
    assert.equal(written.foreignKeyIssueCount, 0);
    assert.equal(written.backup.path, backupPath);
    assert.match(written.backup.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(backupPath).size > 0, true);

    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      assert.equal(backup.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count, 4);
    } finally {
      backup.close();
    }

    const after = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.deepEqual(
        after.prepare('SELECT id, liability FROM insurance_indicator_records ORDER BY id').all().map((row) => ({ ...row })),
        [{ id: 'good', liability: '疾病全残' }],
      );
    } finally {
      after.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exact responsibility cleanup refuses an unreviewed indicator ID', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exact-responsibility-cleanup-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  try {
    const { company, productName, expectedSourceUrl } = createDb(dbPath);
    const result = cleanupExactResponsibilityIndicators({
      dbPath,
      company,
      productName,
      expectedSourceUrl,
      expectedLiabilities: ['疾病全残'],
      removeIds: ['bad-2022-a', 'bad-2022-b', 'unknown'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.validationIssues.includes('remove_indicator_missing:unknown'), true);
    assert.equal(result.deletedIndicatorIds.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
