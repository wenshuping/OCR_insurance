import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';
import { createProductKnowledgeRoutes } from '../server/routes/product-knowledge.routes.mjs';

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
