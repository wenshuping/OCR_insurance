import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createInitialState } from '../server/policy-ocr.domain.mjs';
import {
  ensureProductKnowledgeTables,
} from '../server/product-knowledge-store.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const EXPECTED_TABLES = [
  'insurance_product_versions',
  'insurance_products',
  'knowledge_chunks',
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
