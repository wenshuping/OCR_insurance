import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PING_AN_HISTORICAL_SEEDS,
  buildPingAnHistoricalSeedPayload,
  parsePlanCodeFilter,
  selectPingAnHistoricalSeeds,
  summarizeHistoricalSeedResult,
  summarizeSkippedByReason,
  withPingAnHistoricalBrowserOptions,
} from '../scripts/crawl-ping-an-historical-seed.mjs';
import {
  buildExistingPingAnPlanCodes,
  buildPingAnHistoricalAuditDocument,
  buildPingAnHistoricalGapSeeds,
} from '../scripts/audit-ping-an-historical-products.mjs';

test('Ping An historical seeds include directory-external Zhifu plan codes', () => {
  const planCodes = DEFAULT_PING_AN_HISTORICAL_SEEDS.map((seed) => seed.planCode);

  assert.deepEqual(planCodes, ['892', '893', '897', '898']);
});

test('selectPingAnHistoricalSeeds filters by requested plan code', () => {
  const selected = selectPingAnHistoricalSeeds(
    DEFAULT_PING_AN_HISTORICAL_SEEDS,
    parsePlanCodeFilter('893'),
  );

  assert.equal(selected.length, 1);
  assert.equal(selected[0].planCode, '893');
  assert.match(selected[0].seedSourceUrl, /pingan\.com/u);
});

test('buildPingAnHistoricalSeedPayload uses the crawler historical seed mode', () => {
  const payload = buildPingAnHistoricalSeedPayload({
    maxVersion: 5,
    seeds: [{ planCode: '893', seedSource: 'official FAQ' }],
  });

  assert.equal(payload.mode, 'ping_an_historical_seed');
  assert.equal(payload.company, '中国平安');
  assert.equal(payload.maxVersion, 5);
  assert.deepEqual(payload.seeds, [{ planCode: '893', seedSource: 'official FAQ', maxVersion: 5 }]);
});

test('withPingAnHistoricalBrowserOptions adds CDP fields only when configured', () => {
  const payload = withPingAnHistoricalBrowserOptions(
    buildPingAnHistoricalSeedPayload({ seeds: [{ planCode: '738' }] }),
    {
      cdpUrl: 'http://127.0.0.1:9223',
      delayMs: 50,
      pdfRetryCount: 2,
      pdfRetryDelayMs: 1000,
      archivePdf: true,
      pdfArchiveDir: '/tmp/pdfs',
    },
  );

  assert.equal(payload.cdpUrl, 'http://127.0.0.1:9223');
  assert.equal(payload.delayMs, 50);
  assert.equal(payload.pdfRetryCount, 2);
  assert.equal(payload.pdfRetryDelayMs, 1000);
  assert.equal(payload.archivePdf, true);
  assert.equal(payload.pdfArchiveDir, '/tmp/pdfs');
});

test('summarizeSkippedByReason counts crawler skip reasons', () => {
  assert.deepEqual(
    summarizeSkippedByReason([
      { reason: 'human_verification_required' },
      { reason: 'human_verification_required' },
      { reason: 'pdf_unavailable' },
      {},
    ]),
    {
      human_verification_required: 2,
      pdf_unavailable: 1,
      unknown: 1,
    },
  );
});

test('summarizeHistoricalSeedResult keeps trace fields without full page text', () => {
  const summary = summarizeHistoricalSeedResult({
    ok: true,
    company: '中国平安',
    seedCount: 1,
    productCount: 1,
    skippedCount: 0,
    records: [
      {
        productName: '平安智富人生终身寿险（万能型，B，2004）',
        title: '平安智富人生终身寿险（万能型，B，2004）条款',
        url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=893&versionNo=893-2&attachmentType=1',
        planCode: '893',
        versionNo: '893-2',
        catalogStatus: 'missing_from_getProductList',
        parser: 'scrapling_ping_an_historical_seed',
        pageText: '保险责任 被保险人身故，我们按身故当时的保险金额给付身故保险金。',
      },
    ],
  });

  assert.equal(summary.mode, 'dry-run');
  assert.equal(summary.crawledRecordCount, 1);
  assert.equal(summary.records[0].planCode, '893');
  assert.equal(summary.records[0].catalogStatus, 'missing_from_getProductList');
  assert.equal(Object.hasOwn(summary.records[0], 'pageText'), false);
});

test('buildExistingPingAnPlanCodes reads planCode field and official URL query', () => {
  const existing = buildExistingPingAnPlanCodes([
    { company: '中国平安', planCode: '893', url: 'https://example.test/a' },
    { company: '中国平安', url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=738&versionNo=738-1&attachmentType=1' },
    { company: '新华保险', planCode: '404' },
  ]);

  assert.equal(existing.has('893'), true);
  assert.equal(existing.has('738'), true);
  assert.equal(existing.has('404'), false);
});

test('buildPingAnHistoricalGapSeeds keeps official missing numeric plan codes only', () => {
  const seeds = buildPingAnHistoricalGapSeeds({
    officialProducts: [
      { planCode: '738', productName: '平安康泰终身保险（甲）（9906）', productType: '寿险', officialProductType: '普通型' },
      { planCode: '893', productName: '平安智富人生终身寿险（万能型，B，2004）', productType: '万能账户', officialProductType: '万能型' },
      { planCode: '404g1', productName: '平安长寿保险', productType: '寿险', officialProductType: '普通型' },
    ],
    existingPlanCodes: new Set(['893']),
    excludePlanCodes: parsePlanCodeFilter('892,898'),
    maxVersion: 2,
  });

  assert.equal(seeds.length, 1);
  assert.equal(seeds[0].planCode, '738');
  assert.equal(seeds[0].maxVersion, 2);
  assert.equal(seeds[0].seedSource, '平安官网保单贷款利率表');
});

test('buildPingAnHistoricalAuditDocument annotates human verification gaps', () => {
  const audit = buildPingAnHistoricalAuditDocument({
    officialResult: { productCount: 2 },
    existingPlanCodeCount: 1,
    excludedPlanCodes: parsePlanCodeFilter('893'),
    candidates: [
      { planCode: '738', productName: '平安康泰终身保险（甲）（9906）', productType: '寿险', seedSource: '平安官网保单贷款利率表', seedSourceUrl: 'https://life.pingan.com/x.pdf', maxVersion: 1 },
    ],
    crawlResult: {
      seedCount: 1,
      records: [],
      skippedCount: 1,
      skipped: [{ planCode: '738', versionNo: '738-1', reason: 'human_verification_required' }],
    },
  });

  assert.equal(audit.candidateCount, 1);
  assert.deepEqual(audit.crawl.skippedByReason, { human_verification_required: 1 });
  assert.equal(audit.candidates[0].status, 'terms_not_crawled');
  assert.deepEqual(audit.candidates[0].skippedByReason, { human_verification_required: 1 });
});
