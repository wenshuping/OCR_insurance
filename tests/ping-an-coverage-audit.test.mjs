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

test('buildExistingRepairAudit returns only Ping An records with detected issues', () => {
  const audit = buildExistingRepairAudit(
    [
      { id: 1, company: '中国平安', productName: '平安短文本', pageText: '保险责任 身故给付。', qualityStatus: '' },
      { id: 2, company: '新华保险', productName: '新华短文本', pageText: '', qualityStatus: '' },
      { id: 3, company: '中国平安', productName: '平安完整文本', pageText: '保险责任 ' + '我们按约定给付。'.repeat(80), qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
    ],
    { existsFn: (filePath) => filePath === '/tmp/a.pdf' },
  );

  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0].id, 1);
  assert.equal(audit.summary.recordCount, 1);
  assert.equal(audit.summary.byRecommendedAction.reextract_official_pdf, 1);
});
