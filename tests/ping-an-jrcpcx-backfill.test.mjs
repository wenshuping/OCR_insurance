import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCoverageGapReport,
  buildKnowledgeRecordFromJrcpcx,
  dedupeCatalogRows,
  eligibleForAutoInsert,
  materialIdentityKey,
  mergeDetailRowsPreferEvidence,
} from '../scripts/ping-an-jrcpcx-backfill.mjs';

const pdfFixturePath = path.join(os.tmpdir(), 'ping-an-jrcpcx-backfill-fixture.pdf');

function ensurePdfFixture() {
  fs.writeFileSync(pdfFixturePath, '%PDF-1.4\n% test fixture\n');
  return pdfFixturePath;
}

test('materialIdentityKey prefers terms PDF URL and terms text code', () => {
  const key = materialIdentityKey({
    productName: '平安示例年金保险',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    detailFields: { 产品条款文字编码: '平安人寿〔2026〕年金保险001号' },
  });

  assert.equal(
    key,
    '平安示例年金保险\u001f平安人寿〔2026〕年金保险001号\u001fhttps://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
  );
});

test('dedupeCatalogRows keeps one row per issuer product industry code and detail URL', () => {
  const rows = dedupeCatalogRows([
    {
      deptName: '中国平安人寿保险股份有限公司',
      productName: '平安示例年金保险',
      industryCode: '平安人寿〔2026〕年金保险001号',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    },
    {
      deptName: '中国平安人寿保险股份有限公司',
      productName: '平安示例年金保险',
      industryCode: '平安人寿〔2026〕年金保险001号',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    },
  ]);

  assert.equal(rows.length, 1);
});

test('mergeDetailRowsPreferEvidence keeps the row with PDF and page text', () => {
  const rows = mergeDetailRowsPreferEvidence([
    {
      productName: '平安示例年金保险',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    },
    {
      productName: '平安示例年金保险',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
      clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
      pdfLocalPath: ensurePdfFixture(),
      pageText: '保险责任 年金给付',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].clauseUrl, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
});

test('eligibleForAutoInsert allows valid complete and valid partial with PDF evidence', () => {
  const base = {
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '人身保险类',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
  };

  assert.equal(eligibleForAutoInsert({ ...base, qualityStatus: 'valid_complete' }).eligible, true);
  assert.equal(eligibleForAutoInsert({ ...base, qualityStatus: 'valid_partial' }).eligible, true);
  assert.equal(eligibleForAutoInsert({ ...base, qualityStatus: 'suspect_needs_source_check' }).eligible, false);
});

test('eligibleForAutoInsert rejects blank and property insurance product types', () => {
  const base = {
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_complete',
  };

  const blank = eligibleForAutoInsert({ ...base, productType: '' });
  const propertyClass = eligibleForAutoInsert({ ...base, productType: '财产保险类' });
  const property = eligibleForAutoInsert({ ...base, productType: '财产保险' });

  assert.equal(blank.eligible, false);
  assert.deepEqual(blank.reasons, ['missing_product_type']);
  assert.equal(propertyClass.eligible, false);
  assert.deepEqual(propertyClass.reasons, ['not_human_insurance']);
  assert.equal(property.eligible, false);
  assert.deepEqual(property.reasons, ['not_human_insurance']);
});

test('buildCoverageGapReport separates represented and insertable material gaps', () => {
  const report = buildCoverageGapReport({
    localRecords: [
      {
        id: 1,
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old',
      },
    ],
    detailRows: [
      {
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=new',
        pdfLocalPath: ensurePdfFixture(),
        pdfSha256: 'abc123',
        qualityStatus: 'valid_partial',
        pageText: '保险责任 年金给付',
      },
    ],
  });

  assert.equal(report.summary.insertableCount, 1);
  assert.equal(report.insertable[0].productName, '平安示例年金保险');
});

test('buildKnowledgeRecordFromJrcpcx maps detail rows to knowledge record fields', () => {
  const record = buildKnowledgeRecordFromJrcpcx({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '年金保险',
    salesStatus: '停售',
    title: '平安示例年金保险条款',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pdfBytes: 100,
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_partial',
    detailFields: { 产品条款文字编码: '平安人寿〔2026〕年金保险001号' },
  });

  assert.equal(record.url, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
  assert.equal(record.seedSourceUrl, 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1');
  assert.equal(record.evidenceLevel, 'regulatory_industry_terms');
  assert.equal(record.versionNo, '平安人寿〔2026〕年金保险001号');
});
