import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  backfillProductCustomerResponsibilitySummaries,
  parseBackfillArgs,
  selectBackfillProducts,
} from '../scripts/backfill-product-customer-responsibility-summaries.mjs';

test('parseBackfillArgs resolves v25 alias and options', () => {
  const args = parseBackfillArgs([
    '--version',
    'v25',
    '--limit',
    '10',
    '--company',
    '新华保险',
    '--db',
    '/tmp/policy-ocr.sqlite',
    '--category',
    'incremental_whole_life',
    '--dry-run',
  ]);

  assert.equal(args.summaryVersion, 'customer-summary-v25-planner-routing');
  assert.equal(args.limit, 10);
  assert.equal(args.company, '新华保险');
  assert.equal(args.dbPath, '/tmp/policy-ocr.sqlite');
  assert.equal(args.category, 'incremental_whole_life');
  assert.equal(args.dryRun, true);
});

test('parseBackfillArgs rejects unsupported summary versions', () => {
  assert.throws(
    () => parseBackfillArgs(['--version', 'v21']),
    /Only customer-summary-v25-planner-routing is supported/,
  );
  assert.throws(
    () => parseBackfillArgs(['--version', 'customer-summary-v21']),
    /Only customer-summary-v25-planner-routing is supported/,
  );
  assert.equal(
    parseBackfillArgs(['--version', 'customer-summary-v25-planner-routing']).summaryVersion,
    'customer-summary-v25-planner-routing',
  );
});

test('parseBackfillArgs rejects invalid limits', () => {
  assert.throws(() => parseBackfillArgs(['--limit', '0']), /--limit must be a positive integer/);
  assert.throws(() => parseBackfillArgs(['--limit', '-1']), /--limit must be a positive integer/);
  assert.throws(() => parseBackfillArgs(['--limit', 'abc']), /--limit must be a positive integer/);
});

test('selectBackfillProducts deduplicates by company and product name', () => {
  const products = selectBackfillProducts({
    knowledgeRecords: [
      { company: '新华保险', productName: '产品A' },
      { company: '新华保险', productName: '产品A' },
      { company: '新华保险', productName: '产品B' },
      { company: '平安人寿', productName: '产品B' },
      { company: '', productName: '缺公司' },
      { company: '新华保险', productName: '' },
    ],
    limit: 2,
  });

  assert.deepEqual(products, [
    { company: '新华保险', productName: '产品A' },
    { company: '新华保险', productName: '产品B' },
  ]);
});

test('selectBackfillProducts filters by category fields', () => {
  const products = selectBackfillProducts({
    knowledgeRecords: [
      { company: '新华保险', productName: '产品A', productCategory: 'incremental_whole_life' },
      { company: '新华保险', productName: '产品B', product_type: 'critical_illness' },
      { company: '新华保险', productName: '产品C', category: 'annuity' },
      { company: '新华保险', productName: '产品D' },
    ],
    category: 'whole_life',
    limit: 10,
  });

  assert.deepEqual(products, [
    { company: '新华保险', productName: '产品A' },
  ]);
});

test('selectBackfillProducts filters by company and supports fallback product fields', () => {
  const products = selectBackfillProducts({
    knowledgeRecords: [
      { company: '新华保险', title: '标题产品' },
      { company: '平安人寿', product_name: '平安产品' },
      { company: '新华保险', product_name: '字段产品' },
    ],
    company: '新华保险',
    limit: 10,
  });

  assert.deepEqual(products, [
    { company: '新华保险', productName: '标题产品' },
    { company: '新华保险', productName: '字段产品' },
  ]);
});

test('backfill dry-run returns empty report when database is missing without opening store', async () => {
  let storeFactoryCalls = 0;
  const missingDbPath = path.join(os.tmpdir(), `missing-policy-ocr-${Date.now()}`, 'policy-ocr.sqlite');

  const report = await backfillProductCustomerResponsibilitySummaries({
    dbPath: missingDbPath,
    dryRun: true,
    storeFactory: async () => {
      storeFactoryCalls += 1;
      throw new Error('storeFactory should not be called');
    },
  });

  assert.equal(storeFactoryCalls, 0);
  assert.equal(report.databaseMissing, true);
  assert.equal(report.total, 0);
  assert.deepEqual(report.products, []);
  await assert.rejects(fs.stat(missingDbPath), /ENOENT/);
});

test('backfill dry-run does not initialize an existing empty database file', async () => {
  let storeFactoryCalls = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'customer-summary-empty-db-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  await fs.writeFile(dbPath, '');

  try {
    const before = await fs.stat(dbPath);
    const report = await backfillProductCustomerResponsibilitySummaries({
      dbPath,
      dryRun: true,
      storeFactory: async () => {
        storeFactoryCalls += 1;
        throw new Error('storeFactory should not be called');
      },
    });
    const after = await fs.stat(dbPath);

    assert.equal(storeFactoryCalls, 0);
    assert.equal(report.databaseUninitialized, true);
    assert.equal(report.total, 0);
    assert.equal(before.size, 0);
    assert.equal(after.size, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('backfill dry-run reports candidates without calling generator', async () => {
  let generateCalls = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'customer-summary-backfill-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT INTO app_meta (key, value)
    VALUES ('state_initialized_at', '2026-07-01T00:00:00.000Z');
  `);
  db.close();
  const store = {
    async load() {
      return {
        knowledgeRecords: [
          { company: '新华保险', productName: '产品A' },
          { company: '新华保险', productName: '产品B' },
        ],
      };
    },
    close() {},
  };

  try {
    const report = await backfillProductCustomerResponsibilitySummaries({
      storeFactory: async () => store,
      dbPath,
      dryRun: true,
      limit: 1,
      generateSummary: async () => {
        generateCalls += 1;
        return { ok: true };
      },
    });

    assert.equal(generateCalls, 0);
    assert.equal(report.dbPath, dbPath);
    assert.equal(report.dryRun, true);
    assert.equal(report.total, 1);
    assert.equal(report.generated, 0);
    assert.equal(report.failed, 0);
    assert.equal(report.skippedDryRun, 1);
    assert.deepEqual(report.products, [{ company: '新华保险', productName: '产品A' }]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
