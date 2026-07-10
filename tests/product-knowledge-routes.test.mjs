import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';
import { createProductKnowledgeRoutes } from '../server/routes/product-knowledge.routes.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function requireTestAdmin(req, res) {
  if (req.headers.authorization !== 'Bearer admin-token') {
    res.status(401).json({ ok: false, code: 'ADMIN_UNAUTHORIZED', message: '请先登录管理后台' });
    return null;
  }
  return { token: 'admin-token' };
}

async function makeApp() {
  const db = new DatabaseSync(':memory:');
  const productKnowledgeStore = createProductKnowledgeStore(db);
  const app = express();
  app.use(express.json({ limit: '24mb' }));
  app.use('/api/admin/product-knowledge', createProductKnowledgeRoutes({
    state: {},
    adminPassword: 'test-password',
    requireAdmin: requireTestAdmin,
    productKnowledgeStore,
  }));
  const running = await listen(app);
  return {
    ...running,
    db,
    close: async () => {
      await running.close();
      db.close();
    },
  };
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return { response, payload: await response.json() };
}

function validUploadBody() {
  return {
    fileName: '公司产品介绍.txt',
    mediaType: 'text/plain',
    dataBase64: Buffer.from('产品A\n等待期90天').toString('base64'),
  };
}

test('product knowledge routes require an admin session', async () => {
  const app = await makeApp();
  try {
    const { response, payload } = await jsonRequest(
      app.baseUrl,
      '/api/admin/product-knowledge/documents',
      { method: 'GET' },
    );
    assert.equal(response.status, 401);
    assert.equal(payload.code, 'ADMIN_UNAUTHORIZED');
  } finally {
    await app.close();
  }
});

test('product knowledge routes upload, deduplicate, list, and show document metadata', async () => {
  const app = await makeApp();
  const headers = { authorization: 'Bearer admin-token' };
  try {
    const first = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify(validUploadBody()),
    });
    assert.equal(first.response.status, 201);
    assert.equal(first.payload.ok, true);
    assert.equal(first.payload.deduplicated, false);
    assert.equal(first.payload.document.fileName, '公司产品介绍.txt');
    assert.equal(first.payload.document.reviewStatus, 'quarantined');
    assert.equal(first.payload.job.status, 'uploaded');
    assert.equal('bytes' in first.payload.document, false);

    const second = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify(validUploadBody()),
    });
    assert.equal(second.response.status, 200);
    assert.equal(second.payload.deduplicated, true);
    assert.equal(second.payload.document.id, first.payload.document.id);

    const listed = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/documents', { headers });
    assert.equal(listed.response.status, 200);
    assert.equal(listed.payload.documents.length, 1);
    assert.equal('bytes' in listed.payload.documents[0], false);

    const detail = await jsonRequest(
      app.baseUrl,
      `/api/admin/product-knowledge/documents/${first.payload.document.id}`,
      { headers },
    );
    assert.equal(detail.response.status, 200);
    assert.equal(detail.payload.document.id, first.payload.document.id);
    assert.equal(detail.payload.job.documentId, first.payload.document.id);
    assert.equal('bytes' in detail.payload.document, false);
  } finally {
    await app.close();
  }
});

test('product knowledge routes return stable validation and not-found errors', async () => {
  const app = await makeApp();
  const headers = { authorization: 'Bearer admin-token' };
  try {
    const invalid = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify({ fileName: 'malware.exe', dataBase64: 'dGVzdA==' }),
    });
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.code, 'PRODUCT_DOCUMENT_UNSUPPORTED_TYPE');

    const missing = await jsonRequest(
      app.baseUrl,
      '/api/admin/product-knowledge/documents/pdoc_missing',
      { headers },
    );
    assert.equal(missing.response.status, 404);
    assert.equal(missing.payload.code, 'PRODUCT_DOCUMENT_NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('full app mounts the product knowledge upload API and persists through the sqlite store', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-knowledge-route-app-'));
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'policy-ocr.sqlite') });
  const state = await store.load();
  const app = createPolicyOcrApp({
    state,
    db: store.db,
    adminPassword: 'test-password',
    persist: store.persist,
    persistAdminSession: store.persistAdminSession,
  });
  const running = await listen(app);
  try {
    const login = await jsonRequest(running.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'test-password' }),
    });
    assert.equal(login.response.status, 200);
    const headers = { authorization: `Bearer ${login.payload.token}` };
    const uploaded = await jsonRequest(running.baseUrl, '/api/admin/product-knowledge/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify(validUploadBody()),
    });

    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.payload.document.fileName, '公司产品介绍.txt');
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM product_documents').get().count, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM product_document_blobs').get().count, 1);
    assert.equal(store.db.prepare('SELECT count(*) AS count FROM product_ingestion_jobs').get().count, 1);
  } finally {
    await running.close();
    store.close();
  }
});

test('admin can process, preview, publish and search document evidence', async () => {
  const app = await makeApp();
  const headers = { authorization: 'Bearer admin-token' };
  try {
    const uploaded = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify(validUploadBody()),
    });
    const documentId = uploaded.payload.document.id;
    const processed = await jsonRequest(
      app.baseUrl,
      `/api/admin/product-knowledge/documents/${documentId}/process`,
      { method: 'POST', headers, body: '{}' },
    );
    assert.equal(processed.response.status, 200);
    assert.equal(processed.payload.document.parseStatus, 'indexed_pending_review');
    assert.ok(processed.payload.chunks.some((chunk) => chunk.chunkType === 'child'));

    const hidden = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/search', {
      method: 'POST', headers, body: JSON.stringify({ query: '等待期' }),
    });
    assert.equal(hidden.payload.results.length, 0);

    const preview = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/search', {
      method: 'POST', headers, body: JSON.stringify({ query: '等待期', includeQuarantined: true }),
    });
    assert.equal(preview.payload.previewMode, true);
    assert.equal(preview.payload.results.length, 1);
    assert.equal(preview.payload.results[0].pageStart, 1);

    const candidates = await jsonRequest(
      app.baseUrl,
      `/api/admin/product-knowledge/documents/${documentId}/candidates`,
      { headers },
    );
    assert.equal(candidates.response.status, 200);
    assert.equal(candidates.payload.summary.count, 0);

    const published = await jsonRequest(
      app.baseUrl,
      `/api/admin/product-knowledge/documents/${documentId}/review`,
      { method: 'POST', headers, body: JSON.stringify({ action: 'publish', note: '测试审核' }) },
    );
    assert.equal(published.response.status, 200);
    assert.equal(published.payload.document.reviewStatus, 'published');

    const visible = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/search', {
      method: 'POST', headers, body: JSON.stringify({ query: '等待期' }),
    });
    assert.equal(visible.payload.results.length, 1);
    assert.equal(visible.payload.results[0].reviewStatus, 'published');
  } finally {
    await app.close();
  }
});

test('review rejects invalid actions and unprocessed publishing', async () => {
  const app = await makeApp();
  const headers = { authorization: 'Bearer admin-token' };
  try {
    const uploaded = await jsonRequest(app.baseUrl, '/api/admin/product-knowledge/documents', {
      method: 'POST', headers, body: JSON.stringify(validUploadBody()),
    });
    const documentId = uploaded.payload.document.id;
    const invalid = await jsonRequest(
      app.baseUrl,
      `/api/admin/product-knowledge/documents/${documentId}/review`,
      { method: 'POST', headers, body: JSON.stringify({ action: 'approve' }) },
    );
    assert.equal(invalid.response.status, 400);
    assert.equal(invalid.payload.code, 'PRODUCT_DOCUMENT_REVIEW_ACTION_INVALID');
    const notReady = await jsonRequest(
      app.baseUrl,
      `/api/admin/product-knowledge/documents/${documentId}/review`,
      { method: 'POST', headers, body: JSON.stringify({ action: 'publish' }) },
    );
    assert.equal(notReady.response.status, 409);
    assert.equal(notReady.payload.code, 'PRODUCT_DOCUMENT_NOT_READY');
  } finally {
    await app.close();
  }
});
