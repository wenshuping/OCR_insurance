import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildExistingRepairAudit,
  classifyLocalRepairCandidate,
  isPingAnIssuer,
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
    ],
    { existsFn: (filePath) => filePath === '/tmp/a.pdf' || filePath === '/tmp/b.pdf' },
  );

  assert.equal(audit.records.length, 2);
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
  assert.equal(audit.summary.recordCount, 2);
  assert.equal(audit.summary.productCount, 2);
  assert.equal(audit.summary.byRecommendedAction.reextract_official_pdf, 2);
  assert.deepEqual(audit.summary.byIssue, {
    very_short_text_lt_100: 1,
    blank_quality_status: 1,
    missing_archived_pdf: 1,
    flagged_valid_partial: 1,
  });
});
