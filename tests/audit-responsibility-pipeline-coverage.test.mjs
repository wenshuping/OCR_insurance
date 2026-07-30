import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { auditResponsibilityPipelineCoverage } from '../scripts/audit-responsibility-pipeline-coverage.mjs';

test('responsibility pipeline coverage audit separates approved reusable products from legacy data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`
      CREATE TABLE product_responsibility_artifacts (company TEXT, product_name TEXT, source_digest TEXT, publisher_version TEXT, payload TEXT);
      CREATE TABLE product_responsibility_cards (company TEXT, product_name TEXT);
      CREATE TABLE insurance_indicator_records (company TEXT, product_name TEXT);
      CREATE TABLE product_customer_responsibility_summaries (company TEXT, product_name TEXT);
    `);
    const artifact = {
      audit: { status: 'approved' },
      responsibilities: [{ responsibilityId: 'death', indicators: [{ indicatorName: '身故保险金' }] }],
    };
    db.prepare('INSERT INTO product_responsibility_artifacts VALUES (?, ?, ?, ?, ?)').run('测试保险', '合格产品', 'sha256:test', 'v1', JSON.stringify(artifact));
    db.prepare('INSERT INTO product_responsibility_cards VALUES (?, ?)').run('测试保险', '合格产品');
    db.prepare('INSERT INTO insurance_indicator_records VALUES (?, ?)').run('测试保险', '合格产品');
    db.prepare('INSERT INTO product_responsibility_cards VALUES (?, ?)').run('测试保险', '旧产品');
    db.prepare('INSERT INTO insurance_indicator_records VALUES (?, ?)').run('测试保险', '旧产品');
    db.prepare('INSERT INTO product_customer_responsibility_summaries VALUES (?, ?)').run('测试保险', '旧产品');

    const report = auditResponsibilityPipelineCoverage(db);
    assert.equal(report.ok, true);
    assert.equal(report.counts.approvedReusableProducts, 1);
    assert.equal(report.counts.legacyOrUnreviewedProducts, 1);
    assert.equal(report.approvedReusable[0].productName, '合格产品');
    assert.equal(report.legacyOrUnreviewed[0].productName, '旧产品');
    assert.equal(report.legacyOrUnreviewed[0].action, 'regenerate_and_validate_before_replace');
  } finally {
    db.close();
  }
});
