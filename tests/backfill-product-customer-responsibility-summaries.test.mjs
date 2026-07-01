import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillProductCustomerResponsibilitySummaries,
  parseBackfillArgs,
  selectBackfillProducts,
} from '../scripts/backfill-product-customer-responsibility-summaries.mjs';

test('parseBackfillArgs resolves v22 alias and options', () => {
  const args = parseBackfillArgs([
    '--version',
    'v22',
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

  assert.equal(args.summaryVersion, 'customer-summary-v22-structured-rag');
  assert.equal(args.limit, 10);
  assert.equal(args.company, '新华保险');
  assert.equal(args.dbPath, '/tmp/policy-ocr.sqlite');
  assert.equal(args.category, 'incremental_whole_life');
  assert.equal(args.dryRun, true);
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

test('backfill dry-run reports candidates without calling generator', async () => {
  let generateCalls = 0;
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

  const report = await backfillProductCustomerResponsibilitySummaries({
    storeFactory: async () => store,
    dbPath: '/tmp/test.sqlite',
    dryRun: true,
    limit: 1,
    generateSummary: async () => {
      generateCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(generateCalls, 0);
  assert.equal(report.dbPath, '/tmp/test.sqlite');
  assert.equal(report.dryRun, true);
  assert.equal(report.total, 1);
  assert.equal(report.generated, 0);
  assert.equal(report.failed, 0);
  assert.equal(report.skippedDryRun, 1);
  assert.deepEqual(report.products, [{ company: '新华保险', productName: '产品A' }]);
});
