import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';

function chunk(id, productVersionId, validFrom, validTo) {
  return {
    id,
    canonicalProductId: 'product-1',
    productVersionId,
    chunkType: 'child',
    pageStart: 1,
    pageEnd: 1,
    content: `住院责任 ${id}`,
    contentHash: `hash-${id}`,
    sourceAuthority: 'insurer_official',
    validFrom,
    validTo,
    indexStatus: 'ready',
  };
}

test('product knowledge search filters inclusive chunk validity dates and keeps strict version filtering', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const upload = store.createDocumentUpload({
      tenantId: 'default',
      contentHash: 'version-filter',
      fileName: '版本过滤.txt',
      bytes: Buffer.from('source'),
      sourceAuthority: 'insurer_official',
    });
    store.replaceParsedArtifacts({
      tenantId: 'default',
      documentId: upload.document.id,
      indexVersion: 'v1',
      documentType: 'terms',
      pages: [{ pageNo: 1, rawText: '住院责任', tables: [], headings: [], sourceLabel: '第 1 页' }],
      chunks: [
        chunk('old', 'version-2022', '2022-01-01', '2023-12-31'),
        chunk('current', 'version-2024', '2024-01-01', ''),
        chunk('timeless', '', '', ''),
      ],
      facts: [],
    });
    store.reviewDocument({ tenantId: 'default', documentId: upload.document.id, action: 'publish' });

    assert.deepEqual(store.searchChunks({
      tenantId: 'default', query: '住院责任', asOfDate: '2023-12-31',
    }).map((item) => item.productVersionId).sort(), ['', 'version-2022']);
    assert.deepEqual(store.searchChunks({
      tenantId: 'default', query: '住院责任', asOfDate: '2024-01-01',
    }).map((item) => item.productVersionId).sort(), ['', 'version-2024']);
    assert.deepEqual(store.searchChunks({
      tenantId: 'default', query: '住院责任', productVersionId: 'version-2022', asOfDate: '2024-01-01',
    }), []);
    assert.deepEqual(store.searchChunks({
      tenantId: 'default', query: '住院责任', productVersionId: 'version-2024', asOfDate: '2024-01-01',
    }).map((item) => item.productVersionId), ['version-2024']);
    assert.throws(() => store.searchChunks({
      tenantId: 'default', query: '住院责任', asOfDate: '2024/01/01',
    }), /YYYY-MM-DD/u);
  } finally {
    db.close();
  }
});

test('product knowledge store exposes version master records for deterministic resolution', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    db.prepare(`
      INSERT INTO insurance_products (
        canonical_product_id, tenant_id, company, official_name, status, created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, '{}')
    `).run('product-1', 'default', '测试保险', '测试产品', '2024-01-01', '2024-01-01');
    db.prepare(`
      INSERT INTO insurance_product_versions (
        id, tenant_id, canonical_product_id, version_label, filing_code,
        effective_from, effective_to, sale_status, review_status, created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'on_sale', 'approved', ?, ?, '{}')
    `).run('version-2024', 'default', 'product-1', '2024版', '备案-2024', '2024-01-01', null, '2024-01-01', '2024-01-01');

    assert.deepEqual(store.listProductVersions({ tenantId: 'default', canonicalProductId: 'product-1' }), [{
      id: 'version-2024',
      tenantId: 'default',
      canonicalProductId: 'product-1',
      versionLabel: '2024版',
      filingCode: '备案-2024',
      effectiveFrom: '2024-01-01',
      effectiveTo: '',
      saleStatus: 'on_sale',
      reviewStatus: 'approved',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
      payload: {},
    }]);
  } finally {
    db.close();
  }
});
