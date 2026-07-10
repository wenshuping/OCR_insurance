import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createInitialState } from '../server/policy-ocr.domain.mjs';
import {
  createProductKnowledgeStore,
  ensureProductKnowledgeTables,
} from '../server/product-knowledge-store.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const EXPECTED_TABLES = [
  'insurance_product_versions',
  'insurance_products',
  'knowledge_chunks',
  'knowledge_chunks_fts',
  'product_claims',
  'product_document_blobs',
  'product_document_links',
  'product_document_pages',
  'product_documents',
  'product_fact_evidence',
  'product_facts',
  'product_ingestion_jobs',
];

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'product-knowledge-store-'));
}

test('ensureProductKnowledgeTables creates the product knowledge schema idempotently', () => {
  const db = new DatabaseSync(':memory:');
  try {
    ensureProductKnowledgeTables(db);
    ensureProductKnowledgeTables(db);

    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
        AND name IN (${EXPECTED_TABLES.map(() => '?').join(', ')})
      ORDER BY name ASC
    `).all(...EXPECTED_TABLES).map((row) => row.name);

    assert.deepEqual(tables, EXPECTED_TABLES);
  } finally {
    db.close();
  }
});

test('legacy full-state persistence leaves product knowledge tables untouched', async () => {
  const dir = await makeTempDir();
  const store = await createSqliteStateStore({
    dbPath: path.join(dir, 'policy-ocr.sqlite'),
  });
  try {
    store.db.prepare(`
      INSERT INTO product_documents (
        id,
        tenant_id,
        content_hash,
        file_name,
        media_type,
        file_extension,
        byte_size,
        created_at,
        updated_at,
        payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'pdoc_test',
      'default',
      'hash-test',
      '产品资料.txt',
      'text/plain',
      'txt',
      4,
      '2026-07-10T00:00:00.000Z',
      '2026-07-10T00:00:00.000Z',
      '{}',
    );

    await store.persist(createInitialState());

    const row = store.db.prepare(`
      SELECT id, file_name
      FROM product_documents
      WHERE id = ?
    `).get('pdoc_test');
    assert.equal(row?.id, 'pdoc_test');
    assert.equal(row?.file_name, '产品资料.txt');
  } finally {
    store.close();
  }
});

test('product knowledge store writes a document blob and ingestion job atomically', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = store.createDocumentUpload({
      tenantId: 'default',
      createdBy: 'admin-session',
      fileName: '产品培训.pptx',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
      bytes: Buffer.from('test deck'),
      contentHash: 'hash-test-deck',
      now: '2026-07-10T00:00:00.000Z',
    });

    assert.equal(created.deduplicated, false);
    assert.match(created.document.id, /^pdoc_/u);
    assert.equal(created.document.parseStatus, 'uploaded');
    assert.equal(created.document.reviewStatus, 'quarantined');
    assert.equal(created.document.byteSize, 9);
    assert.equal(created.job.documentId, created.document.id);
    assert.equal(created.job.status, 'uploaded');
    assert.equal(created.job.currentStep, 'uploaded');
    assert.equal(db.prepare('SELECT count(*) AS count FROM product_documents').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM product_document_blobs').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM product_ingestion_jobs').get().count, 1);

    const detail = store.getDocument({
      tenantId: 'default',
      documentId: created.document.id,
      includeBytes: true,
    });
    assert.equal(detail.bytes.toString('utf8'), 'test deck');
  } finally {
    db.close();
  }
});

test('product knowledge store deduplicates uploads by tenant and content hash', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const input = {
      tenantId: 'default',
      createdBy: 'admin-session',
      fileName: '产品培训.pptx',
      mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
      bytes: Buffer.from('test deck'),
      contentHash: 'hash-test-deck',
      now: '2026-07-10T00:00:00.000Z',
    };
    const first = store.createDocumentUpload(input);
    const second = store.createDocumentUpload({
      ...input,
      fileName: '重命名资料.pptx',
      now: '2026-07-10T00:01:00.000Z',
    });

    assert.equal(second.deduplicated, true);
    assert.equal(second.document.id, first.document.id);
    assert.equal(second.document.fileName, '产品培训.pptx');
    assert.equal(second.job.id, first.job.id);
    assert.equal(db.prepare('SELECT count(*) AS count FROM product_documents').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM product_document_blobs').get().count, 1);
    assert.equal(db.prepare('SELECT count(*) AS count FROM product_ingestion_jobs').get().count, 1);

    const otherTenant = store.createDocumentUpload({ ...input, tenantId: 'other' });
    assert.equal(otherTenant.deduplicated, false);
    assert.notEqual(otherTenant.document.id, first.document.id);
    assert.equal(db.prepare('SELECT count(*) AS count FROM product_documents').get().count, 2);
  } finally {
    db.close();
  }
});

test('product knowledge store lists metadata without blobs and enforces tenant scope', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = store.createDocumentUpload({
      tenantId: 'default',
      createdBy: 'admin-session',
      fileName: '产品介绍.pdf',
      mediaType: 'application/pdf',
      extension: 'pdf',
      bytes: Buffer.from('pdf bytes'),
      contentHash: 'hash-pdf',
      now: '2026-07-10T00:00:00.000Z',
    });

    const listed = store.listDocuments({ tenantId: 'default' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, created.document.id);
    assert.equal('bytes' in listed[0], false);
    assert.equal(store.getDocument({ tenantId: 'other', documentId: created.document.id }), null);
    assert.equal(store.getIngestionJob({ tenantId: 'other', documentId: created.document.id }), null);
  } finally {
    db.close();
  }
});

test('product knowledge store updates one ingestion job and records attempts', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = store.createDocumentUpload({
      tenantId: 'default',
      createdBy: 'admin-session',
      fileName: '产品介绍.pdf',
      mediaType: 'application/pdf',
      extension: 'pdf',
      bytes: Buffer.from('pdf bytes'),
      contentHash: 'hash-pdf',
      now: '2026-07-10T00:00:00.000Z',
    });
    const updated = store.updateIngestionJob({
      tenantId: 'default',
      jobId: created.job.id,
      status: 'processing',
      currentStep: 'parsing',
      incrementAttempt: true,
      payload: { parserVersion: 'test-v1' },
      now: '2026-07-10T00:02:00.000Z',
    });

    assert.equal(updated.status, 'processing');
    assert.equal(updated.currentStep, 'parsing');
    assert.equal(updated.attemptCount, 1);
    assert.deepEqual(updated.payload, { parserVersion: 'test-v1' });
    assert.equal(updated.updatedAt, '2026-07-10T00:02:00.000Z');
    assert.equal(store.updateIngestionJob({ tenantId: 'other', jobId: created.job.id }), null);
  } finally {
    db.close();
  }
});

function createUploadedDocument(store, tenantId = 'default') {
  return store.createDocumentUpload({
    tenantId,
    createdBy: 'admin-session',
    fileName: '产品介绍.txt',
    mediaType: 'text/plain',
    extension: 'txt',
    bytes: Buffer.from(`document-${tenantId}`),
    contentHash: `hash-${tenantId}`,
    now: '2026-07-10T00:00:00.000Z',
  });
}

function parsedArtifacts(documentId, content = '等待期为90天，保险责任以正式条款为准。') {
  return {
    documentType: 'product_intro',
    pages: [{ pageNo: 1, rawText: content, headings: ['产品介绍'], tables: [], sourceLabel: '第 1 页' }],
    chunks: [
      {
        id: `${documentId}_parent`,
        chunkType: 'parent',
        pageStart: 1,
        pageEnd: 1,
        content,
        contextualPrefix: '资料：产品介绍.txt',
        tokenCount: 20,
        contentHash: 'parent-hash',
        sourceAuthority: 'company_material',
        reviewStatus: 'pending',
        indexStatus: 'ready',
      },
      {
        id: `${documentId}_child`,
        parentChunkId: `${documentId}_parent`,
        chunkType: 'child',
        pageStart: 1,
        pageEnd: 1,
        content,
        contextualPrefix: '资料：产品介绍.txt\n页码：第 1 页',
        tokenCount: 20,
        contentHash: 'child-hash',
        sourceAuthority: 'company_material',
        reviewStatus: 'pending',
        indexStatus: 'ready',
      },
    ],
  };
}

test('parsed pages, chunks and FTS rows are replaced idempotently', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = createUploadedDocument(store);
    const input = parsedArtifacts(created.document.id);
    store.replaceParsedArtifacts({ tenantId: 'default', documentId: created.document.id, ...input });
    store.replaceParsedArtifacts({ tenantId: 'default', documentId: created.document.id, ...input });

    assert.equal(store.listDocumentPages({ tenantId: 'default', documentId: created.document.id }).length, 1);
    assert.equal(store.listDocumentChunks({ tenantId: 'default', documentId: created.document.id }).length, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_chunks_fts').get().count, 1);
    assert.equal(store.getDocument({ tenantId: 'default', documentId: created.document.id }).parseStatus, 'indexed_pending_review');
  } finally {
    db.close();
  }
});

test('artifact replacement rolls back pages, chunks and FTS together', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = createUploadedDocument(store);
    const original = parsedArtifacts(created.document.id, '原始等待期为90天。');
    store.replaceParsedArtifacts({ tenantId: 'default', documentId: created.document.id, ...original });
    assert.throws(() => store.replaceParsedArtifacts({
      tenantId: 'default',
      documentId: created.document.id,
      pages: [{ pageNo: 2, rawText: '新内容' }],
      chunks: [{ id: '', content: '' }],
    }));

    assert.match(store.listDocumentPages({ tenantId: 'default', documentId: created.document.id })[0].rawText, /原始/u);
    assert.match(store.listDocumentChunks({ tenantId: 'default', documentId: created.document.id })[1].content, /原始/u);
    assert.equal(db.prepare('SELECT count(*) AS count FROM knowledge_chunks_fts').get().count, 1);
  } finally {
    db.close();
  }
});

test('search is tenant-scoped and published-only by default', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const first = createUploadedDocument(store, 'default');
    const second = createUploadedDocument(store, 'other');
    store.replaceParsedArtifacts({ tenantId: 'default', documentId: first.document.id, ...parsedArtifacts(first.document.id) });
    store.replaceParsedArtifacts({ tenantId: 'other', documentId: second.document.id, ...parsedArtifacts(second.document.id) });

    assert.equal(store.searchChunks({ tenantId: 'default', query: '等待期' }).length, 0);
    assert.equal(store.searchChunks({ tenantId: 'default', query: '等待期', includeQuarantined: true }).length, 1);
    store.reviewDocument({
      tenantId: 'default',
      documentId: first.document.id,
      action: 'publish',
      reviewer: 'admin',
      now: '2026-07-10T01:00:00.000Z',
    });
    const results = store.searchChunks({ tenantId: 'default', query: '等待期' });
    assert.equal(results.length, 1);
    assert.equal(results[0].documentId, first.document.id);
    assert.equal(results[0].reviewStatus, 'published');
    assert.equal(store.searchChunks({ tenantId: 'missing', query: '等待期', includeQuarantined: true }).length, 0);
  } finally {
    db.close();
  }
});

test('product candidates and review decisions are persisted without creating products', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const created = createUploadedDocument(store);
    const links = store.saveDocumentProductLinks({
      tenantId: 'default',
      documentId: created.document.id,
      links: [{
        pageStart: 1,
        pageEnd: 2,
        relationType: 'candidate',
        matchConfidence: 0.72,
        payload: { company: '新华保险', productName: '康宁保终身重大疾病保险' },
      }],
    });
    assert.equal(links.length, 1);
    assert.equal(links[0].canonicalProductId, '');
    assert.equal(store.listProducts({ tenantId: 'default' }).length, 0);
    assert.throws(
      () => store.reviewDocument({ tenantId: 'default', documentId: created.document.id, action: 'publish' }),
      (error) => error.code === 'PRODUCT_DOCUMENT_NOT_READY',
    );
  } finally {
    db.close();
  }
});
