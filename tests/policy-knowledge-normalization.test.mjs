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
