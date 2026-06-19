import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCatalogArtifact,
  buildCliArtifact,
  buildCoverageGapReport,
  buildKnowledgeRecordFromJrcpcx,
  buildResponsibilitiesArtifact,
  buildShardPlanArtifact,
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

test('materialIdentityKey normalizes volatile clauseInfo timestamps', () => {
  const first = materialIdentityKey({
    productName: '平安示例年金保险',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc&t=111&data=1',
    detailFields: { 产品条款文字编码: '平安人寿〔2026〕年金保险001号' },
  });
  const second = materialIdentityKey({
    productName: '平安示例年金保险',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=222&data=1&info=abc',
    detailFields: { 产品条款文字编码: '平安人寿〔2026〕年金保险001号' },
  });

  assert.equal(first, second);
  assert.equal(
    first,
    '平安示例年金保险\u001f平安人寿〔2026〕年金保险001号\u001fhttps://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?data=1&info=abc',
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

test('eligibleForAutoInsert does not treat detail url as clause url', () => {
  const result = eligibleForAutoInsert({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '人身保险类',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    url: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_complete',
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, ['missing_clause_url']);
});

test('eligibleForAutoInsert does not treat generic source as detail url', () => {
  const result = eligibleForAutoInsert({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '人身保险类',
    source: 'https://www.jrcpcx.cn/#/query',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_complete',
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, ['missing_detail_url']);
});

test('eligibleForAutoInsert does not treat generic detailUrl as detail url', () => {
  const result = eligibleForAutoInsert({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '人身保险类',
    detailUrl: 'https://www.jrcpcx.cn/#/query',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_complete',
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, ['missing_detail_url']);
});

test('eligibleForAutoInsert does not treat generic sourceUrl as detail url', () => {
  const result = eligibleForAutoInsert({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '人身保险类',
    sourceUrl: 'https://www.jrcpcx.cn/#/query',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_complete',
  });

  assert.equal(result.eligible, false);
  assert.deepEqual(result.reasons, ['missing_detail_url']);
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

test('buildCoverageGapReport uses normalized clause URL for represented materials', () => {
  const report = buildCoverageGapReport({
    localRecords: [
      {
        id: 1,
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc&t=111',
      },
    ],
    detailRows: [
      {
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=222&info=abc',
        pdfLocalPath: ensurePdfFixture(),
        pdfSha256: 'abc123',
        qualityStatus: 'valid_partial',
        pageText: '保险责任 年金给付',
      },
    ],
  });

  assert.equal(report.summary.representedCount, 1);
  assert.equal(report.summary.insertableCount, 0);
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

test('buildShardPlanArtifact includes Ping An Life filters and unresolved shards', () => {
  const artifact = buildShardPlanArtifact({
    generatedAt: '2026-06-19T00:00:00.000Z',
    shardSummary: {
      queryCount: 2,
      truncatedCount: 1,
      completeCount: 1,
      unresolvedShards: [
        {
          deptName: '中国平安人寿保险股份有限公司',
          productName: '年金',
          status: '在售',
          rowCount: 50,
          nextAction: 'split_keyword',
        },
      ],
    },
  });

  assert.equal(artifact.company, '中国平安人寿保险股份有限公司');
  assert.equal(artifact.productTypeLabel, '人身保险类');
  assert.equal(artifact.humanInsuranceFilter.productTypeLabel, '人身保险类');
  assert.equal(artifact.summary.shardCount, 2);
  assert.equal(artifact.summary.unresolvedShardCount, 1);
  assert.equal(artifact.unresolvedShards[0].productName, '年金');
});

test('buildCatalogArtifact dedupes catalog rows, merges details, and reports coverage gaps', () => {
  const pdfPath = ensurePdfFixture();
  const artifact = buildCatalogArtifact({
    generatedAt: '2026-06-19T00:00:00.000Z',
    rows: [
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
    ],
    detailRows: [
      {
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
      },
      {
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
        pdfLocalPath: pdfPath,
        pdfSha256: 'abc123',
        qualityStatus: 'valid_partial',
        pageText: '保险责任 年金给付',
      },
    ],
    localRecords: [],
  });

  assert.equal(artifact.summary.rowCount, 2);
  assert.equal(artifact.summary.dedupedCatalogRowCount, 1);
  assert.equal(artifact.summary.mergedDetailRowCount, 1);
  assert.equal(artifact.summary.uniqueProductCount, 1);
  assert.equal(artifact.summary.uniqueMaterialCandidateCount, 1);
  assert.equal(artifact.coverageGapSummary.insertableCount, 1);
  assert.equal(artifact.dedupedCatalogRows[0].productName, '平安示例年金保险');
  assert.equal(artifact.mergedDetailRows[0].pdfSha256, 'abc123');
});

test('buildCliArtifact catalog mode maps crawler products as catalog and records as detail rows', () => {
  const pdfPath = ensurePdfFixture();
  const artifact = buildCliArtifact('catalog', {
    generatedAt: '2026-06-19T00:00:00.000Z',
    products: [
      {
        deptName: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        industryCode: '平安人寿〔2026〕年金保险001号',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
      },
    ],
    records: [
      {
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
        pdfLocalPath: pdfPath,
        pdfSha256: 'abc123',
        qualityStatus: 'valid_partial',
        pageText: '保险责任 年金给付',
      },
    ],
  });

  assert.equal(artifact.summary.rowCount, 1);
  assert.equal(artifact.summary.detailRowCount, 1);
  assert.equal(artifact.coverageGapSummary.insertableCount, 1);
  assert.equal(artifact.dedupedCatalogRows[0].industryCode, '平安人寿〔2026〕年金保险001号');
  assert.equal(artifact.mergedDetailRows[0].pdfSha256, 'abc123');
});

test('buildResponsibilitiesArtifact extracts only insurance responsibility text and reports quality', () => {
  const artifact = buildResponsibilitiesArtifact({
    generatedAt: '2026-06-19T00:00:00.000Z',
    rows: [
      {
        productName: '平安示例年金保险',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
        pageText: [
          '产品简介 本产品为长期年金保险。',
          '保险责任',
          '在本合同保险期间内，我们承担生存保险金、满期保险金和身故保险金责任。',
          '责任免除',
          '因下列情形导致保险事故的，我们不承担给付责任。',
        ].join('\n'),
      },
      {
        productName: '平安空白条款',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=empty',
        pageText: '',
      },
    ],
  });

  assert.equal(artifact.summary.recordCount, 2);
  assert.equal(artifact.summary.byQualityStatus.valid_partial, 1);
  assert.equal(artifact.summary.byQualityStatus.invalid_empty, 1);
  assert.match(artifact.records[0].pageText, /^保险责任/u);
  assert.doesNotMatch(artifact.records[0].pageText, /产品简介/u);
  assert.doesNotMatch(artifact.records[0].pageText, /责任免除/u);
});

test('buildResponsibilitiesArtifact ignores text fallback when pageText is missing', () => {
  const artifact = buildResponsibilitiesArtifact({
    rows: [
      {
        productName: '平安示例年金保险',
        text: '保险责任 年金给付',
        responsibilityText: '保险责任 身故保险金',
      },
    ],
  });

  assert.equal(artifact.records[0].pageText, '');
  assert.equal(artifact.records[0].responsibilityText, '');
  assert.equal(artifact.records[0].qualityStatus, 'invalid_empty');
  assert.equal(artifact.summary.byQualityStatus.invalid_empty, 1);
});

test('buildResponsibilitiesArtifact starts from responsibility headings and stops at numbered exclusions', () => {
  const artifact = buildResponsibilitiesArtifact({
    rows: [
      {
        productName: '平安示例年金保险',
        pageText: [
          '产品简介',
          '本产品的保险责任包括生存、满期、身故等多项保障，具体以条款为准。',
          '第六条 保险责任',
          '在本合同保险期间内，我们承担生存保险金、满期保险金和身故保险金责任。',
          '第七条 责任免除',
          '因下列情形导致保险事故的，我们不承担给付责任。',
        ].join('\n'),
      },
    ],
  });

  assert.match(artifact.records[0].pageText, /^第六条 保险责任/u);
  assert.doesNotMatch(artifact.records[0].pageText, /产品简介/u);
  assert.doesNotMatch(artifact.records[0].pageText, /本产品的保险责任包括/u);
  assert.doesNotMatch(artifact.records[0].pageText, /第七条 责任免除/u);
});

test('buildResponsibilitiesArtifact derives quality from current pageText extraction', () => {
  const artifact = buildResponsibilitiesArtifact({
    rows: [
      {
        productName: '平安示例年金保险',
        qualityStatus: 'valid_complete',
        pageText: '产品简介 本产品提供多项保障。',
      },
    ],
  });

  assert.equal(artifact.records[0].sourceQualityStatus, 'valid_complete');
  assert.equal(artifact.records[0].qualityStatus, 'invalid_non_responsibility');
  assert.equal(artifact.summary.byQualityStatus.invalid_non_responsibility, 1);
  assert.equal(artifact.summary.byQualityStatus.valid_complete, undefined);
});
