import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { normalizeKnowledgeProductType, normalizeKnowledgeRecord } from '../server/policy-knowledge.service.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

test('normalizeKnowledgeRecord upgrades generic health type to critical illness when product text is explicit', () => {
  const record = normalizeKnowledgeRecord({
    id: 379,
    company: '新华保险',
    productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
    productType: '健康险',
    title: '保险条款',
    pageText: '保险责任包括特定重大疾病保险金、特定轻症疾病保险金、特定重度恶性肿瘤保险金。',
    url: 'https://www.newchinalife.com/products/ithe-male-ci',
  });

  assert.equal(record?.productType, '重疾险');
});

test('normalizeKnowledgeRecord preserves historical official seed trace fields', () => {
  const record = normalizeKnowledgeRecord({
    company: '中国平安',
    productName: '平安智富人生终身寿险（万能型，B，2004）',
    title: '平安智富人生终身寿险（万能型，B，2004）条款',
    url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=893&versionNo=893-2&attachmentType=1',
    planCode: '893',
    versionNo: '893-2',
    catalogStatus: 'missing_from_getProductList',
    seedSource: '平安官网保单E服务FAQ：万能险智富人生892/893',
    seedSourceUrl: 'https://www.pingan.com/campaign/efuwu/questions.jsp',
  });

  assert.equal(record?.planCode, '893');
  assert.equal(record?.versionNo, '893-2');
  assert.equal(record?.catalogStatus, 'missing_from_getProductList');
  assert.equal(record?.seedSourceUrl, 'https://www.pingan.com/campaign/efuwu/questions.jsp');
});

test('normalizeKnowledgeRecord preserves archived PDF metadata', () => {
  const record = normalizeKnowledgeRecord({
    company: '中国平安',
    productName: '平安康泰终身保险（甲）（9906）',
    title: '平安康泰终身保险（甲）（9906）条款',
    url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=738&versionNo=738-1&attachmentType=1',
    pageText: '保险责任 被保险人身故，我们按约定给付身故保险金。',
    sourceType: 'pdf',
    pages: 12,
    bytes: 2048,
    contentType: 'application/pdf',
    pdfLocalPath: '/tmp/policy-material-pdfs/ab/cd/sample.pdf',
    pdfSha256: 'abcd'.repeat(16),
    pdfBytes: 2048,
    pdfOriginalUrl: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=738&versionNo=738-1&attachmentType=1',
    pdfArchivedAt: '2026-06-18T00:00:00Z',
  });

  assert.equal(record?.pages, 12);
  assert.equal(record?.bytes, 2048);
  assert.equal(record?.contentType, 'application/pdf');
  assert.equal(record?.pdfLocalPath, '/tmp/policy-material-pdfs/ab/cd/sample.pdf');
  assert.equal(record?.pdfSha256, 'abcd'.repeat(16));
  assert.equal(record?.pdfBytes, 2048);
  assert.equal(record?.pdfArchivedAt, '2026-06-18T00:00:00Z');
});

test('normalizeKnowledgeProductType keeps specific disease insurance separate from critical illness', () => {
  assert.equal(
    normalizeKnowledgeProductType({
      company: '新华保险',
      productName: '新华人寿保险股份有限公司i她A款女性特定疾病保险',
      productType: '健康险',
    }),
    '疾病保险',
  );
});

test('normalizeKnowledgeProductType converts generic aliases and invalid placeholders', () => {
  assert.equal(
    normalizeKnowledgeProductType({
      company: '中国人寿',
      productName: '国寿鑫益年年年金保险（分红型）',
      productType: '',
    }),
    '年金险',
  );
  assert.equal(
    normalizeKnowledgeProductType({
      company: '中国人寿',
      productName: '国寿鑫安盈两全保险',
      productType: 'P2',
    }),
    '两全保险',
  );
  assert.equal(
    normalizeKnowledgeProductType({
      company: '新华保险',
      productName: '新华人寿保险股份有限公司康护无忧护理保险',
      productType: '健康险',
    }),
    '护理险',
  );
  assert.equal(
    normalizeKnowledgeProductType({
      company: '新华保险',
      productName: '新华人寿保险股份有限公司附加安欣意外伤害医疗保险',
      productType: '健康险',
    }),
    '医疗险',
  );
});

test('sqlite state store normalizes loaded knowledge record product types', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-knowledge-normalization-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const store = await createSqliteStateStore({ dbPath });

  await store.persist({
    users: [],
    sessions: [],
    adminSessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [
      {
        id: 379,
        company: '新华保险',
        productName: '新华人寿保险股份有限公司i他男性特定疾病保险',
        productType: '健康险',
        title: '保险条款',
        pageText: '保险责任包括特定重大疾病保险金、特定轻症疾病保险金、特定重度恶性肿瘤保险金。',
        url: 'https://www.newchinalife.com/products/ithe-male-ci',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    officialDomainProfiles: [],
    familyProfiles: [],
    familyMembers: [],
    familyReportShares: [],
    nextId: 380,
  });

  const loaded = await store.load();
  assert.equal(loaded.knowledgeRecords[0]?.productType, '重疾险');

  store.close();
});
