import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoverageSummary,
  buildExistingRepairAudit,
  buildLocalPingAnIndexes,
  buildMissingSourceCandidates,
  classifyLocalRepairCandidate,
  collectExternalSourceRecords,
  isPingAnIssuer,
  matchExternalToLocal,
  normalizeExternalSourceRecord,
  normalizeExternalSourceRecords,
  normalizeProductName,
  planCodeFromUrl,
} from '../scripts/audit-ping-an-coverage.mjs';

test('normalizeProductName handles spaces and bracket variants conservatively', () => {
  assert.equal(
    normalizeProductName(' 平安智富人生B （ 万能型，2004 ） '),
    '平安智富人生B(万能型,2004)',
  );
  assert.equal(
    normalizeProductName('平安附加少儿大学教育年金保险（分红型，外币版）'),
    '平安附加少儿大学教育年金保险(分红型,外币版)',
  );
});

test('isPingAnIssuer accepts Ping An life issuer names only', () => {
  assert.equal(isPingAnIssuer('中国平安人寿保险股份有限公司'), true);
  assert.equal(isPingAnIssuer('中国平安'), true);
  assert.equal(isPingAnIssuer('平安健康保险股份有限公司'), true);
  assert.equal(isPingAnIssuer('安盛天平财产保险有限公司'), false);
});

test('planCodeFromUrl extracts Ping An plan code query parameter', () => {
  assert.equal(
    planCodeFromUrl('https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=893&versionNo=893-2&attachmentType=1'),
    '893',
  );
  assert.equal(planCodeFromUrl('https://example.test/no-plan-code'), '');
});

test('classifyLocalRepairCandidate recommends concrete repair actions', () => {
  assert.deepEqual(
    classifyLocalRepairCandidate(
      {
        id: 1,
        company: '中国平安',
        productName: '平安示例寿险',
        title: '平安示例寿险产品条款',
        materialType: 'terms',
        url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1&versionNo=1-1&attachmentType=1',
        pageText: '保险责任 被保险人身故，我们按基本保险金额给付身故保险金。'.repeat(5),
        qualityStatus: '',
        pdfLocalPath: '/tmp/missing.pdf',
      },
      { existsFn: () => false },
    ),
    {
      issues: ['short_text_lt_300', 'blank_quality_status', 'missing_archived_pdf'],
      recommendedAction: 'reextract_official_pdf',
    },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      {
        id: 2,
        company: '中国平安',
        productName: '平安示例医疗保险',
        pageText: '保险责任 被保险人发生事故，我们按约定给付。'.repeat(40) + '责任免除 因下列情形之一导致的保险事故，我们不承担责任。',
        qualityStatus: 'valid_complete',
      },
      { existsFn: () => true },
    ),
    {
      issues: ['boundary_overrun_exclusion_section', 'missing_archived_pdf'],
      recommendedAction: 'boundary_cleanup',
    },
  );
});

test('classifyLocalRepairCandidate classifies text length and status issues', () => {
  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: '', qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
      { existsFn: () => true },
    ),
    { issues: ['empty_text'], recommendedAction: 'ocr_official_pdf' },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: '', qualityStatus: 'valid_complete', pdfLocalPath: '' },
      { existsFn: () => false },
    ),
    { issues: ['empty_text', 'missing_archived_pdf'], recommendedAction: 'ocr_official_pdf' },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: 'a'.repeat(99), qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
      { existsFn: () => true },
    ),
    { issues: ['very_short_text_lt_100'], recommendedAction: 'reextract_official_pdf' },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: 'a'.repeat(100), qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
      { existsFn: () => true },
    ),
    { issues: ['short_text_lt_300'], recommendedAction: 'reextract_official_pdf' },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: 'a'.repeat(300), qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
      { existsFn: () => true },
    ),
    { issues: [], recommendedAction: '' },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: '保险责任 '.repeat(80), qualityStatus: 'valid_partial', pdfLocalPath: '/tmp/a.pdf' },
      { existsFn: () => true },
    ),
    { issues: ['flagged_valid_partial'], recommendedAction: 'reextract_official_pdf' },
  );
});

test('classifyLocalRepairCandidate classifies invalid, boundary, and archive issues', () => {
  for (const qualityStatus of ['invalid_empty', 'invalid_responsibility']) {
    assert.deepEqual(
      classifyLocalRepairCandidate(
        { pageText: '保险责任 '.repeat(80), qualityStatus, pdfLocalPath: '/tmp/a.pdf' },
        { existsFn: () => true },
      ),
      { issues: ['flagged_invalid'], recommendedAction: 'ocr_official_pdf' },
    );
  }

  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: '保险责任 '.repeat(80) + '现金价值', qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
      { existsFn: () => true },
    ),
    { issues: ['boundary_overrun_policy_benefit_section'], recommendedAction: 'boundary_cleanup' },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      { pageText: '保险责任 '.repeat(80), qualityStatus: 'valid_complete', pdfLocalPath: '' },
      { existsFn: () => true },
    ),
    { issues: ['missing_archived_pdf'], recommendedAction: 'reextract_official_pdf' },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      {
        pageText: '保险责任 '.repeat(80) + '责任免除',
        qualityStatus: 'invalid_responsibility',
        pdfLocalPath: '/tmp/missing.pdf',
      },
      { existsFn: () => false },
    ),
    {
      issues: ['flagged_invalid', 'boundary_overrun_exclusion_section', 'missing_archived_pdf'],
      recommendedAction: 'ocr_official_pdf',
    },
  );
});

test('buildExistingRepairAudit returns only Ping An records with detected issues', () => {
  const shortText = '保险责任 身故给付。';
  const partialText = '保险责任 ' + '我们按约定给付。'.repeat(80);
  const audit = buildExistingRepairAudit(
    [
      { id: 1, company: '中国平安', productName: '平安短文本', title: '短文本条款', materialType: 'terms', url: 'https://example.test/1', pageText: shortText, qualityStatus: '' },
      { id: 2, company: '新华保险', productName: '新华短文本', pageText: '', qualityStatus: '' },
      { id: 3, company: '中国平安', productName: '平安完整文本', pageText: '保险责任 ' + '我们按约定给付。'.repeat(80), qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
      { id: 4, company: '中国平安', productName: '平安部分文本', pageText: partialText, qualityStatus: 'valid_partial', pdfLocalPath: '/tmp/b.pdf' },
      { id: 5, company: '中国平安人寿保险股份有限公司', productName: '平安人寿短文本', pageText: shortText, qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/c.pdf' },
    ],
    { existsFn: (filePath) => filePath === '/tmp/a.pdf' || filePath === '/tmp/b.pdf' },
  );

  assert.equal(audit.records.length, 3);
  assert.equal(audit.records[0].id, 1);
  assert.deepEqual(audit.records[0], {
    id: 1,
    company: '中国平安',
    productName: '平安短文本',
    title: '短文本条款',
    materialType: 'terms',
    url: 'https://example.test/1',
    currentQualityStatus: '',
    pageTextChars: shortText.length,
    hasArchivedPdf: false,
    pdfLocalPath: '',
    issues: ['very_short_text_lt_100', 'blank_quality_status', 'missing_archived_pdf'],
    recommendedAction: 'reextract_official_pdf',
  });
  assert.equal(audit.records[1].id, 4);
  assert.equal(audit.records[1].currentQualityStatus, 'valid_partial');
  assert.equal(audit.records[1].pageTextChars, partialText.length);
  assert.equal(audit.records[1].hasArchivedPdf, true);
  assert.equal(audit.records[2].id, 5);
  assert.equal(audit.records[2].company, '中国平安人寿保险股份有限公司');
  assert.equal(audit.summary.recordCount, 3);
  assert.equal(audit.summary.productCount, 3);
  assert.equal(audit.summary.byRecommendedAction.reextract_official_pdf, 3);
  assert.deepEqual(audit.summary.byIssue, {
    very_short_text_lt_100: 2,
    blank_quality_status: 1,
    missing_archived_pdf: 2,
    flagged_valid_partial: 1,
  });
});

test('normalizeExternalSourceRecord preserves JRCPCX Ping An evidence fields', () => {
  const normalized = normalizeExternalSourceRecord({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安金宝贝少儿教育年金保险（分红型）',
    productType: '年金保险-非养老年金保险',
    salesStatus: '停用',
    sourceLevel: 'regulatory_industry_terms',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=abc',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pageText: '保险责任 大学教育金 被保险人生存至18周岁，我们给付大学教育金。',
    qualityStatus: 'valid_complete',
    pdfLocalPath: '/tmp/terms.pdf',
    pdfSha256: 'abc123',
    pdfBytes: 123,
  }, { sourceName: 'jrcpcx' });

  assert.equal(normalized.issuerFullName, '中国平安人寿保险股份有限公司');
  assert.equal(normalized.normalizedProductName, '平安金宝贝少儿教育年金保险(分红型)');
  assert.equal(normalized.sourceName, 'jrcpcx');
  assert.equal(normalized.responsibilityPreview.includes('大学教育金'), true);
});

test('normalizeExternalSourceRecords filters non Ping An issuers', () => {
  const records = normalizeExternalSourceRecords([
    { company: '中国平安人寿保险股份有限公司', productName: '平安产品', pageText: '保险责任 身故给付。' },
    { company: '新华保险股份有限公司', productName: '新华产品', pageText: '保险责任 身故给付。' },
  ], { sourceName: 'sample' });

  assert.equal(records.length, 1);
  assert.equal(records[0].productName, '平安产品');
});

test('normalizeExternalSourceRecord preserves existing normalized fields', () => {
  const normalized = normalizeExternalSourceRecord({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安产品（分红型）',
    normalizedProductName: '已有标准产品名',
    responsibilityPreview: '已有责任预览',
    responsibilityQualityStatus: 'valid_reviewed',
    qualityStatus: 'valid_complete',
    pageText: '保险责任 '.repeat(200),
    rawId: 'external-123',
    id: 'local-456',
  });

  assert.equal(normalized.normalizedProductName, '已有标准产品名');
  assert.equal(normalized.responsibilityPreview, '已有责任预览');
  assert.equal(normalized.responsibilityQualityStatus, 'valid_reviewed');
  assert.equal(normalized.rawId, 'external-123');
});

test('buildLocalPingAnIndexes indexes Ping An issuer variants and excludes non Ping An issuers', () => {
  const indexes = buildLocalPingAnIndexes([
    {
      id: 10,
      company: '中国平安人寿保险股份有限公司',
      productName: '平安金宝贝少儿教育年金保险（分红型）',
      url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=901&versionNo=901-1&attachmentType=1',
    },
    {
      id: 11,
      company: '新华保险股份有限公司',
      productName: '新华金宝贝少儿教育年金保险（分红型）',
      url: 'https://example.test/non-ping-an?planCode=902',
    },
  ]);

  assert.equal(indexes.records.length, 1);
  assert.equal(indexes.records[0].id, 10);
  assert.equal(indexes.byProductName.get('平安金宝贝少儿教育年金保险(分红型)')[0].id, 10);
  assert.equal(indexes.byPlanCode.get('901')[0].id, 10);
  assert.equal(indexes.byPlanCode.has('902'), false);
});

test('matchExternalToLocal treats exact normalized local product as represented', () => {
  const indexes = buildLocalPingAnIndexes([
    {
      id: 10,
      company: '中国平安人寿保险股份有限公司',
      productName: '平安金宝贝少儿教育年金保险（分红型）',
      url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=901&versionNo=901-1&attachmentType=1',
    },
  ]);
  const match = matchExternalToLocal(
    normalizeExternalSourceRecord({
      company: '中国平安人寿保险股份有限公司',
      productName: '平安金宝贝少儿教育年金保险(分红型)',
      clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
      pageText: '保险责任 大学教育金。',
    }),
    indexes,
  );

  assert.equal(match.status, 'represented_by_product_name');
  assert.equal(match.missingReason, '');
  assert.deepEqual(match.localMatches.map((row) => row.id), [10]);
});

test('matchExternalToLocal represents URL and plan code matches before product name', () => {
  const indexes = buildLocalPingAnIndexes([
    {
      id: 20,
      company: '中国平安',
      productName: '平安URL匹配产品',
      url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=820&versionNo=820-1&attachmentType=1',
    },
    {
      id: 21,
      company: '中国平安',
      productName: '平安计划代码产品',
      url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=821&versionNo=821-1&attachmentType=1',
    },
  ]);

  const urlMatch = matchExternalToLocal(
    normalizeExternalSourceRecord({
      company: '中国平安人寿保险股份有限公司',
      productName: '外部URL产品名称不同',
      clauseUrl: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=820&versionNo=820-1&attachmentType=1',
    }),
    indexes,
  );
  const planCodeMatch = matchExternalToLocal(
    normalizeExternalSourceRecord({
      company: '中国平安人寿保险股份有限公司',
      productName: '外部计划代码产品名称不同',
      clauseUrl: 'https://external.test/terms.pdf',
      planCode: '821',
    }),
    indexes,
  );

  assert.equal(urlMatch.status, 'represented_by_url');
  assert.deepEqual(urlMatch.localMatches.map((row) => row.id), [20]);
  assert.equal(planCodeMatch.status, 'represented_by_plan_code');
  assert.deepEqual(planCodeMatch.localMatches.map((row) => row.id), [21]);
});

test('buildMissingSourceCandidates keeps duplicate plan code matches under manual review', () => {
  const localRecords = [
    {
      id: 22,
      company: '中国平安',
      productName: '平安计划代码重复产品A',
      url: 'https://life.pingan.com/terms/plan-code-a.pdf',
      planCode: '822',
    },
    {
      id: 23,
      company: '中国平安人寿保险股份有限公司',
      productName: '平安计划代码重复产品B',
      url: 'https://life.pingan.com/terms/plan-code-b.pdf',
      planCode: '822',
    },
  ];
  const externalRecords = normalizeExternalSourceRecords([
    {
      company: '中国平安人寿保险股份有限公司',
      productName: '外部计划代码重复产品',
      clauseUrl: 'https://external.test/822.pdf',
      planCode: '822',
      pageText: '保险责任 身故保险金。',
      qualityStatus: 'valid_complete',
    },
  ], { sourceName: 'sample' });

  const candidates = buildMissingSourceCandidates(externalRecords, localRecords);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].matchStatus, 'ambiguous_local_match');
  assert.equal(candidates[0].missingReason, 'ambiguous_local_match');
  assert.equal(candidates[0].recommendedAction, 'manual_review');
  assert.deepEqual(candidates[0].localMatchCandidates.map((row) => row.id), [22, 23]);
});

test('matchExternalToLocal returns ambiguous candidates for duplicate local product names', () => {
  const indexes = buildLocalPingAnIndexes([
    {
      id: 30,
      company: '中国平安',
      productName: '平安重复产品（分红型）',
      url: 'https://life.pingan.com/terms/first.pdf',
    },
    {
      id: 31,
      company: '中国平安健康保险股份有限公司',
      productName: '平安重复产品(分红型)',
      url: 'https://life.pingan.com/terms/second.pdf',
    },
  ]);
  const match = matchExternalToLocal(
    normalizeExternalSourceRecord({
      company: '中国平安人寿保险股份有限公司',
      productName: '平安重复产品（分红型）',
      clauseUrl: 'https://external.test/repeated.pdf',
    }),
    indexes,
  );

  assert.equal(match.status, 'ambiguous_local_match');
  assert.equal(match.missingReason, 'ambiguous_local_match');
  assert.deepEqual(match.localMatches.map((row) => row.id), [30, 31]);
});

test('buildMissingSourceCandidates keeps missing and ambiguous records reviewable with source evidence', () => {
  const localRecords = [
    {
      id: 10,
      company: '中国平安',
      productName: '平安智盈人生终身寿险（万能型）',
      url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=810&versionNo=810-2&attachmentType=1',
    },
    {
      id: 11,
      company: '中国平安',
      productName: '平安重复产品（分红型）',
      url: 'https://life.pingan.com/terms/repeated-a.pdf',
    },
    {
      id: 12,
      company: '中国平安',
      productName: '平安重复产品(分红型)',
      url: 'https://life.pingan.com/terms/repeated-b.pdf',
    },
  ];
  const externalRecords = normalizeExternalSourceRecords([
    {
      company: '中国平安人寿保险股份有限公司',
      productName: '平安智盈人生终身寿险（万能型）',
      clauseUrl: 'https://external.test/810.pdf',
      pageText: '保险责任 身故保险金。',
      qualityStatus: 'valid_complete',
    },
    {
      company: '中国平安人寿保险股份有限公司',
      productName: '平安康泰终身保险（甲）（9906）',
      sourceLevel: 'regulatory_industry_terms',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=missing',
      clauseUrl: 'https://external.test/738.pdf',
      planCode: '738',
      pageText: '保险责任 身故保险金。',
      qualityStatus: 'valid_complete',
      pdfLocalPath: '/tmp/ping-an-738.pdf',
      pdfSha256: 'sha-738',
      pdfBytes: 7380,
    },
    {
      company: '中国平安人寿保险股份有限公司',
      productName: '平安重复产品（分红型）',
      clauseUrl: 'https://external.test/repeated.pdf',
      pageText: '保险责任 生存保险金。',
      qualityStatus: 'valid_complete',
    },
  ], { sourceName: 'sample' });

  const candidates = buildMissingSourceCandidates(externalRecords, localRecords);

  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((row) => row.productName), [
    '平安康泰终身保险（甲）（9906）',
    '平安重复产品（分红型）',
  ]);
  assert.deepEqual(candidates[0], {
    productName: '平安康泰终身保险（甲）（9906）',
    normalizedProductName: '平安康泰终身保险(甲)(9906)',
    issuerFullName: '中国平安人寿保险股份有限公司',
    productType: '',
    salesStatus: '',
    sourceName: 'sample',
    sourceLevel: 'regulatory_industry_terms',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=missing',
    clauseUrl: 'https://external.test/738.pdf',
    url: 'https://external.test/738.pdf',
    planCode: '738',
    materialType: 'terms',
    pdfLocalPath: '/tmp/ping-an-738.pdf',
    pdfSha256: 'sha-738',
    pdfBytes: 7380,
    responsibilityPreview: '保险责任 身故保险金。',
    responsibilityQualityStatus: 'valid_complete',
    localMatchCandidates: [],
    matchStatus: 'missing',
    missingReason: 'no_local_product_match',
    recommendedAction: 'review_then_insert',
  });
  assert.equal(candidates[1].matchStatus, 'ambiguous_local_match');
  assert.equal(candidates[1].missingReason, 'ambiguous_local_match');
  assert.equal(candidates[1].recommendedAction, 'manual_review');
  assert.deepEqual(candidates[1].localMatchCandidates.map((row) => row.id), [11, 12]);
});

test('collectExternalSourceRecords reads mixed source payload arrays', () => {
  const records = collectExternalSourceRecords([
    {
      sourceName: 'records-source',
      payload: {
        records: [
          { company: '中国平安人寿保险股份有限公司', productName: '平安A', pageText: '保险责任 A' },
          { company: '新华保险股份有限公司', productName: '新华A', pageText: '保险责任 A' },
        ],
      },
    },
    {
      sourceName: 'products-source',
      payload: {
        products: [
          { issuerFullName: '中国平安', productName: '平安B', pageText: '保险责任 B' },
        ],
      },
    },
    {
      sourceName: 'suspects-source',
      payload: {
        suspects: [
          { companyName: '平安健康保险股份有限公司', productName: '平安C', pageText: '保险责任 C' },
        ],
      },
    },
    {
      sourceName: 'candidates-source',
      payload: {
        candidates: [
          { deptName: '中国平安人寿保险股份有限公司', productName: '平安D', pageText: '保险责任 D' },
        ],
      },
    },
    {
      sourceName: 'array-source',
      payload: [
        { company: '中国平安人寿保险股份有限公司', productName: '平安E', pageText: '保险责任 E' },
      ],
    },
  ]);

  assert.deepEqual(records.map((row) => row.productName), ['平安A', '平安B', '平安C', '平安D', '平安E']);
  assert.deepEqual(records.map((row) => row.sourceName), [
    'records-source',
    'products-source',
    'suspects-source',
    'candidates-source',
    'array-source',
  ]);
});

test('buildCoverageSummary reports local, repair, missing, and pdf counts', () => {
  const summary = buildCoverageSummary({
    generatedAt: '2026-06-18T00:00:00.000Z',
    localRecords: [
      { company: '中国平安', productName: '平安A' },
      { company: '中国平安人寿保险股份有限公司', productName: '平安B' },
      { company: '平安健康保险股份有限公司', productName: '平安C' },
      { company: '新华保险', productName: '新华A' },
    ],
    externalRecords: [
      { productName: '平安D', normalizedProductName: '平安D', pdfLocalPath: '/tmp/d.pdf', responsibilityQualityStatus: 'valid_complete' },
      { productName: '平安D', normalizedProductName: '平安D', responsibilityQualityStatus: 'invalid_empty' },
    ],
    existingRepairRecords: [
      { productName: '平安A', recommendedAction: 'reextract_official_pdf' },
      { productName: '平安B', recommendedAction: 'boundary_cleanup' },
    ],
    missingCandidates: [
      {
        productName: '平安D',
        normalizedProductName: '平安D',
        pdfLocalPath: '/tmp/d.pdf',
        responsibilityPreview: '保险责任 D',
        responsibilityQualityStatus: 'valid_complete',
        missingReason: 'no_local_product_match',
      },
      {
        productName: '平安E',
        normalizedProductName: '平安E',
        pdfLocalPath: '',
        responsibilityPreview: '',
        responsibilityQualityStatus: 'invalid_empty',
        missingReason: 'ambiguous_local_match',
      },
    ],
  });

  assert.equal(summary.generatedAt, '2026-06-18T00:00:00.000Z');
  assert.equal(summary.localPingAnRecordCount, 3);
  assert.equal(summary.localPingAnProductCount, 3);
  assert.equal(summary.externalSourceRecordCount, 2);
  assert.equal(summary.externalSourceProductCount, 1);
  assert.equal(summary.existingRepairCount, 2);
  assert.equal(summary.existingRepairProductCount, 2);
  assert.equal(summary.missingCandidateCount, 2);
  assert.equal(summary.missingCandidateProductCount, 2);
  assert.equal(summary.missingCandidatesWithPdfCount, 1);
  assert.equal(summary.missingCandidatesWithResponsibilityCount, 1);
  assert.deepEqual(summary.missingCandidatesByReason, {
    no_local_product_match: 1,
    ambiguous_local_match: 1,
  });
  assert.deepEqual(summary.missingCandidatesByQuality, {
    valid_complete: 1,
    invalid_empty: 1,
  });
  assert.deepEqual(summary.repairCandidatesByAction, {
    reextract_official_pdf: 1,
    boundary_cleanup: 1,
  });
});
