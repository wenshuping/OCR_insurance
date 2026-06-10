import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { auditOcrReplay } from '../scripts/audit-ocr-replay.mjs';

function createAuditDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-ocr-replay-audit-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE policies (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE pending_scans (
      row_id INTEGER PRIMARY KEY AUTOINCREMENT,
      guest_id TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE knowledge_records (
      id INTEGER PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
  `);
  return { dir, dbPath, db };
}

test('OCR replay audit passes formal policies and reports pending warnings by default', () => {
  const { dir, dbPath, db } = createAuditDb();
  try {
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)').run(
      1,
      '新华保险',
      '新华人寿保险股份有限公司荣耀鑫享赢家版终身寿险',
      '',
      JSON.stringify({
        id: 1,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司荣耀鑫享赢家版终身寿险',
        productType: '寿险',
        official: true,
      }),
    );
    db.prepare('INSERT INTO policies (id, payload) VALUES (?, ?)').run(
      500001,
      JSON.stringify({
        id: 500001,
        ocrText: `
NCI新华保险
保险单
保险合同号:990163781859
合同成立日期:2024年06月06日
合同生效日期:2024年06月07日
投保人:冯力
被保险人:冯力
保险利益表
险种名称
基本保险金额/保险金额
保险期间
交费方式
保险费约定支付日
/交费期间
/交费期满日
保险费
荣耀鑫享赢家版
165020.00元
终身
年交
每年06月07日
每年20000.00元
终身寿险
/10年
/2033年06月07日
首期保险费合计:（大写）贰万元整
￥20000.00
        `,
      }),
    );
    db.prepare('INSERT INTO pending_scans (guest_id, payload) VALUES (?, ?)').run(
      'pending-short',
      JSON.stringify({
        scan: {
          ocrText: 'PINGAN中国平安保单信息平安福重大疾病保险基本保险金额50万 20年交保障期间终身',
        },
      }),
    );
    db.close();

    const report = auditOcrReplay({ dbPath });
    assert.equal(report.ok, true);
    assert.equal(report.policies.count, 1);
    assert.equal(report.policies.issueCount, 0);
    assert.equal(report.pendingScans.count, 1);
    assert.equal(report.pendingScans.issueCount, 1);

    const strictReport = auditOcrReplay({ dbPath, strictPending: true });
    assert.equal(strictReport.ok, false);
  } finally {
    try {
      db.close();
    } catch {
      // Already closed by the test path.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
