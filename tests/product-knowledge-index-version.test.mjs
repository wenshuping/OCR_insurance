import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';

function artifacts(content) {
  return {
    documentType: 'terms',
    pages: [{ pageNo: 1, rawText: content, tables: [], headings: [], sourceLabel: '第 1 页' }],
    chunks: [
      { id: 'parent', chunkType: 'parent', pageStart: 1, pageEnd: 1, content, contentHash: `parent-${content}`, indexStatus: 'ready' },
      { id: 'child', parentChunkId: 'parent', chunkType: 'child', pageStart: 1, pageEnd: 1, content, contentHash: `child-${content}`, indexStatus: 'ready' },
    ],
  };
}

function facts(value) {
  return [{
    canonicalProductId: 'product-1',
    fieldKey: 'annual_deductible',
    normalizedValue: { value, unit: 'CNY' },
    displayValue: `${value}元`,
    scope: { plan: '计划一' },
    exceptions: [],
    completeness: 'complete',
    evidenceChunkIds: ['child'],
    confidence: 0.95,
    extractorVersion: 'test-v1',
  }];
}

test('product knowledge index versions publish atomically and roll back without overwriting active chunks', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  const tenantId = 'default';
  const upload = store.createDocumentUpload({
    tenantId,
    contentHash: 'version-test',
    fileName: '版本测试.txt',
    bytes: Buffer.from('source'),
    sourceAuthority: 'insurer_official',
  });
  const documentId = upload.document.id;

  store.replaceParsedArtifacts({ tenantId, documentId, indexVersion: 'v1', ...artifacts('旧版责任内容'), facts: facts(10_000) });
  store.reviewDocument({ tenantId, documentId, action: 'publish' });
  assert.equal(store.searchChunks({ tenantId, query: '旧版责任' }).length, 1);
  assert.equal(store.listProductFacts({ tenantId, canonicalProductId: 'product-1', statuses: ['confirmed'] })[0].normalizedValue.value, 10_000);

  store.replaceParsedArtifacts({ tenantId, documentId, indexVersion: 'v2', ...artifacts('候选责任内容'), facts: facts(20_000) });
  let review = store.getDocumentIndexReview({ tenantId, documentId });
  assert.equal(review.activeIndexVersion, 'v1');
  assert.equal(review.candidateIndexVersion, 'v2');
  assert.deepEqual(review.diff, { added: 1, removed: 1, unchanged: 0 });
  assert.equal(store.searchChunks({ tenantId, query: '旧版责任' }).length, 1);
  assert.equal(store.searchChunks({ tenantId, query: '候选责任' }).length, 0);

  store.reviewDocument({ tenantId, documentId, action: 'reject' });
  assert.equal(store.searchChunks({ tenantId, query: '旧版责任' }).length, 1);
  assert.equal(store.listProductFacts({ tenantId, indexVersion: 'v2' })[0].status, 'rejected');
  assert.equal(store.listProductFacts({ tenantId, indexVersion: 'v1' })[0].status, 'confirmed');

  store.replaceParsedArtifacts({ tenantId, documentId, indexVersion: 'v3', ...artifacts('新版责任内容'), facts: facts(30_000) });
  store.reviewDocument({ tenantId, documentId, action: 'publish' });
  assert.equal(store.searchChunks({ tenantId, query: '旧版责任' }).length, 0);
  assert.equal(store.searchChunks({ tenantId, query: '新版责任' }).length, 1);
  assert.equal(store.listProductFacts({ tenantId, indexVersion: 'v1' })[0].status, 'expired');
  assert.equal(store.listProductFacts({ tenantId, indexVersion: 'v3' })[0].status, 'confirmed');

  store.reviewDocument({ tenantId, documentId, action: 'rollback' });
  assert.equal(store.searchChunks({ tenantId, query: '旧版责任' }).length, 1);
  assert.equal(store.searchChunks({ tenantId, query: '新版责任' }).length, 0);
  assert.equal(store.listProductFacts({ tenantId, indexVersion: 'v1' })[0].status, 'confirmed');
  assert.equal(store.listProductFacts({ tenantId, indexVersion: 'v3' })[0].status, 'expired');
  db.close();
});
