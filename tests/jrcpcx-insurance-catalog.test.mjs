import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildJrcpcxCatalogPayload,
  buildJrcpcxUiQueries,
  buildPingAnLifeShardQueries,
  hasJrcpcxQueryField,
  summarizeJrcpcxCatalogResult,
  summarizeJrcpcxShardResults,
} from '../scripts/crawl-jrcpcx-insurance-catalog.mjs';
import {
  JRCPCX_TERMS_EVIDENCE_LABEL,
  JRCPCX_TERMS_EVIDENCE_LEVEL,
  jrcpcxProductCandidateRecord,
  jrcpcxSourceReviewMessage,
  normalizeKnowledgeRecord,
} from '../server/policy-knowledge.service.mjs';

test('buildJrcpcxCatalogPayload targets insurance catalog with broad filters by default', () => {
  const payload = buildJrcpcxCatalogPayload({
    cdpUrl: 'http://127.0.0.1:9224',
    maxPages: 3,
    pageSize: 20,
  });

  assert.equal(payload.mode, 'jrcpcx_insurance_catalog');
  assert.equal(payload.cdpUrl, 'http://127.0.0.1:9224');
  assert.equal(payload.maxPages, 3);
  assert.equal(payload.pageSize, 20);
  assert.equal(payload.productType, '00');
  assert.equal(payload.productState, '00');
  assert.equal(payload.fetchDetails, '1');
  assert.equal(hasJrcpcxQueryField(payload), false);
  assert.equal(hasJrcpcxQueryField({ ...payload, deptName: '安诚财产保险股份有限公司' }), true);
  assert.equal(hasJrcpcxQueryField({ ...payload, queries: [{ productName: '个人住院医疗保险' }] }), true);
});

test('buildJrcpcxUiQueries creates type and status shards per department', () => {
  const queries = buildJrcpcxUiQueries({
    deptNames: ['中国人寿保险股份有限公司'],
    productTypeLabels: ['人身保险类', '财产保险类'],
    productStateLabels: ['在售', '停售'],
  });

  assert.equal(queries.length, 4);
  assert.deepEqual(queries[0], {
    deptName: '中国人寿保险股份有限公司',
    productTypeLabel: '人身保险类',
    productTermLabel: '全部',
    productStateLabel: '在售',
  });
  assert.equal(queries.at(-1).productTypeLabel, '财产保险类');
  assert.equal(queries.at(-1).productStateLabel, '停售');
});

test('buildPingAnLifeShardQueries creates Ping An Life product keyword shards', () => {
  const queries = buildPingAnLifeShardQueries({
    keywords: ['年金', '终身'],
    statuses: ['在售', '停售'],
  });

  assert.equal(queries.length, 4);
  assert.deepEqual(queries[0], {
    deptName: '中国平安人寿保险股份有限公司',
    productName: '年金',
    productTypeLabel: '人身保险类',
    productTermLabel: '全部',
    productStateLabel: '在售',
  });
  assert.deepEqual(queries.at(-1), {
    deptName: '中国平安人寿保险股份有限公司',
    productName: '终身',
    productTypeLabel: '人身保险类',
    productTermLabel: '全部',
    productStateLabel: '停售',
  });
});

test('summarizeJrcpcxShardResults preserves unresolved truncated shards', () => {
  const summary = summarizeJrcpcxShardResults({
    queries: [
      {
        deptName: '中国平安人寿保险股份有限公司',
        productName: '年金',
        productStateLabel: '在售',
        rowCount: 50,
        truncated: true,
      },
      {
        deptName: '中国平安人寿保险股份有限公司',
        productName: '护理',
        productStateLabel: '停售',
        rowCount: 12,
        truncated: false,
      },
    ],
  });

  assert.equal(summary.queryCount, 2);
  assert.equal(summary.truncatedCount, 1);
  assert.deepEqual(summary.unresolvedShards, [
    {
      deptName: '中国平安人寿保险股份有限公司',
      productName: '年金',
      status: '在售',
      rowCount: 50,
      nextAction: 'split_keyword',
    },
  ]);
});

test('summarizeJrcpcxCatalogResult keeps samples but not raw detail payloads', () => {
  const summary = summarizeJrcpcxCatalogResult({
    ok: true,
    cdpUrl: 'http://127.0.0.1:9224',
    pageCount: 1,
    productCount: 1,
    pages: [{ page: 1, rowCount: 1 }],
    products: [
      {
        catalogId: 'jrcpcx_123',
        productName: '个人住院医疗保险',
        industryCode: 'ABC123',
        deptName: '示例保险公司',
        productType: '人身保险类',
        productState: '停售',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=abc',
        raw: { id: '123', large: 'raw' },
        detail: { large: 'detail' },
      },
    ],
    records: [
      {
        company: '示例保险公司',
        productName: '个人住院医疗保险',
        qualityStatus: 'valid_complete',
        pageText: '保险责任正文',
        pdfLocalPath: '/tmp/example.pdf',
      },
    ],
  });

  assert.equal(summary.productCount, 1);
  assert.equal(summary.recordCount, 1);
  assert.equal(summary.responsibilityCount, 1);
  assert.equal(summary.samples[0].productName, '个人住院医疗保险');
  assert.equal(summary.samples[0].detailUrl, 'https://inspdinfo.iachina.cn/lifeIns/detail?data=abc');
  assert.equal(summary.recordSamples[0].pageTextChars, 6);
  assert.equal(Object.hasOwn(summary.samples[0], 'raw'), false);
  assert.equal(Object.hasOwn(summary.samples[0], 'detail'), false);
  assert.equal(Object.hasOwn(summary.recordSamples[0], 'pageText'), false);
});

test('JRCPCX candidate records keep regulatory industry terms evidence markers', () => {
  const record = jrcpcxProductCandidateRecord({
    catalogId: 'jrcpcx_demo',
    productName: '个人住院医疗保险',
    deptName: '示例保险公司',
    productType: '人身保险类',
    productState: '停售',
    industryCode: 'ABC123',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=abc',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
  });

  assert.equal(record.sourceKind, 'jrcpcx');
  assert.equal(record.evidenceLevel, JRCPCX_TERMS_EVIDENCE_LEVEL);
  assert.equal(record.evidenceLabel, JRCPCX_TERMS_EVIDENCE_LABEL);
  assert.equal(record.officialDomain, 'inspdinfo.iachina.cn');
  assert.equal(record.detailUrl, 'https://inspdinfo.iachina.cn/lifeIns/detail?data=abc');
  assert.equal(record.clauseUrl, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
});

test('normalizeKnowledgeRecord preserves JRCPCX clause PDF metadata', () => {
  const record = normalizeKnowledgeRecord({
    company: '示例保险公司',
    productName: '个人住院医疗保险',
    title: '个人住院医疗保险条款',
    url: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=abc',
    sourceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
    sourceUrl: 'https://www.jrcpcx.cn/#/query',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pageText: '保险责任 本公司给付住院医疗保险金。',
  });

  assert.equal(record.sourceKind, 'jrcpcx');
  assert.equal(record.evidenceLevel, JRCPCX_TERMS_EVIDENCE_LEVEL);
  assert.equal(record.evidenceLabel, JRCPCX_TERMS_EVIDENCE_LABEL);
  assert.equal(record.clauseUrl, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
});

test('JRCPCX source review message hides crawler tracebacks', () => {
  const message = jrcpcxSourceReviewMessage({
    code: 'SCRAPLING_OUTPUT_MISSING',
    message: 'Traceback BrowserType.connect_over_cdp: connect ECONNREFUSED 127.0.0.1:9224',
  });

  assert.match(message, /浏览器未连接|人工验证/u);
  assert.doesNotMatch(message, /Traceback|ECONNREFUSED|connect_over_cdp/u);
});
