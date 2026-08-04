import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createProductIngestionService } from '../server/product-ingestion.service.mjs';
import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';

function upload(store, name = '产品资料.txt') {
  return store.createDocumentUpload({
    tenantId: 'default',
    fileName: name,
    extension: 'txt',
    bytes: Buffer.from('source'),
    contentHash: `hash-${name}`,
  });
}

test('ingestion persists pages, product candidates and pending chunks', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = upload(store);
    const service = createProductIngestionService({
      store,
      parseDocument: async () => ({
        parser: 'test',
        documentType: 'product_intro',
        metadata: {},
        warnings: [],
        pages: [{
          pageNo: 1,
          rawText: '新华保险\n康宁保终身重大疾病保险\n产品代码：KNB2026\n等待期90天',
          headings: ['产品介绍'],
          tables: [],
          sourceLabel: '第 1 页',
        }],
      }),
    });
    const result = await service.ingestDocument({
      tenantId: 'default',
      documentId: created.document.id,
      catalogProducts: [{
        canonicalProductId: 'cp_knb',
        company: '新华保险',
        officialName: '康宁保终身重大疾病保险',
        productCode: 'KNB2026',
      }],
    });

    assert.equal(result.pages.length, 1);
    assert.ok(result.chunks.some((chunk) => chunk.chunkType === 'child'));
    assert.equal(result.links[0].canonicalProductId, 'cp_knb');
    assert.equal(result.job.status, 'match_required');
    assert.equal(result.job.attemptCount, 1);
    assert.equal(result.document.reviewStatus, 'quarantined');
  } finally {
    db.close();
  }
});

test('ambiguous product matching is quarantined for manual review', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = upload(store, '对比.txt');
    const service = createProductIngestionService({
      store,
      parseDocument: async () => ({
        parser: 'test', documentType: 'product_intro', metadata: {}, warnings: [],
        pages: [{ pageNo: 1, rawText: '守护星医疗保险与福满家年金保险产品对比', headings: [], tables: [] }],
      }),
    });
    const result = await service.ingestDocument({ tenantId: 'default', documentId: created.document.id });
    assert.equal(result.job.status, 'match_required');
    assert.equal(result.links.length, 2);
    assert.ok(result.links.every((link) => !link.canonicalProductId));
  } finally {
    db.close();
  }
});

test('failed retries keep the last complete artifacts and increment attempts once', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = upload(store, '重试.txt');
    let shouldFail = false;
    const service = createProductIngestionService({
      store,
      parseDocument: async () => {
        if (shouldFail) {
          const error = new Error('解析器失败');
          error.code = 'PRODUCT_DOCUMENT_PARSE_FAILED';
          throw error;
        }
        return {
          parser: 'test', documentType: 'product_intro', metadata: {}, warnings: [],
          pages: [{ pageNo: 1, rawText: '原始完整内容等待期90天', headings: [], tables: [] }],
        };
      },
    });
    await service.ingestDocument({ tenantId: 'default', documentId: created.document.id });
    shouldFail = true;
    await assert.rejects(() => service.ingestDocument({ tenantId: 'default', documentId: created.document.id }));

    assert.match(store.listDocumentPages({ tenantId: 'default', documentId: created.document.id })[0].rawText, /原始完整/u);
    assert.equal(store.getIngestionJob({ tenantId: 'default', documentId: created.document.id }).attemptCount, 2);
    assert.equal(store.getDocument({ tenantId: 'default', documentId: created.document.id }).parseStatus, 'parse_failed');
  } finally {
    db.close();
  }
});
