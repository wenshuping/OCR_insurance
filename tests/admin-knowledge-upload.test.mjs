import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';

import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';
import { createProductKnowledgeRoutes } from '../server/routes/product-knowledge.routes.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function makeApp(options = {}) {
  const db = new DatabaseSync(':memory:');
  const state = { knowledgeRecords: [], nextId: 1 };
  const productKnowledgeStore = createProductKnowledgeStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_records (company TEXT, product_name TEXT);
    CREATE TABLE IF NOT EXISTS insurance_indicator_records (company TEXT, product_name TEXT);
    CREATE TABLE IF NOT EXISTS product_responsibility_cards (company TEXT, product_name TEXT);
    CREATE TABLE IF NOT EXISTS optional_responsibility_records (company TEXT, product_name TEXT);
    CREATE TABLE IF NOT EXISTS product_customer_responsibility_summaries (company TEXT, product_name TEXT);
  `);
  const app = express();
  app.use(express.json({ limit: '24mb' }));
  app.use('/api/admin/product-knowledge', createProductKnowledgeRoutes({
    state,
    db,
    requireAdmin(req, res) {
      if (req.headers.authorization !== 'Bearer admin-token') {
        res.status(401).json({ ok: false, code: 'ADMIN_UNAUTHORIZED', message: '请先登录' });
        return null;
      }
      return { token: 'admin-token' };
    },
    productKnowledgeStore,
    productMaterialFetchImpl: options.productMaterialFetchImpl,
    allocateId(current) { const id = current.nextId; current.nextId += 1; return id; },
    upsertKnowledgeRecords(current, records, { allocateId }) {
      const saved = records.map((record) => ({ ...record, id: allocateId(current) }));
      current.knowledgeRecords.push(...saved);
      return saved;
    },
    async persistResponsibilityLookupArtifacts() {},
  }));
  const running = await listen(app);
  return { ...running, db, state, close: async () => { await running.close(); db.close(); } };
}

test('product catalog searches current knowledge, responsibility and indicator tables with fuzzy terms', async () => {
  const app = await makeApp();
  try {
    app.db.prepare('INSERT INTO knowledge_records (company, product_name) VALUES (?, ?)').run('新华保险', '新华人寿保险股份有限公司医药无忧医疗保险');
    app.db.prepare('INSERT INTO product_responsibility_cards (company, product_name) VALUES (?, ?)').run('新华保险', '新华人寿保险股份有限公司安欣意外伤害保险');
    const response = await fetch(`${app.baseUrl}/api/admin/product-knowledge/catalog/products?company=${encodeURIComponent('新华保险')}&q=${encodeURIComponent('医药安欣')}`, { headers: { authorization: 'Bearer admin-token' } });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.products.some((item) => item.productName.includes('医药无忧')), true);
    assert.equal(payload.products.some((item) => item.productName.includes('安欣意外伤害')), true);
  } finally {
    await app.close();
  }
});

async function request(app, path, body) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: 'Bearer admin-token', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('company product material uploads, parses, publishes and remains queryable', async () => {
  const app = await makeApp();
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      title: '康宁保产品培训',
      materialType: '产品培训课件',
      materialUsages: ['销售建议资料', '产品责任指标补充资料'],
      company: '测试保险公司',
      productName: '康宁保',
      productNames: ['康宁保'],
      versionLabel: '2026版',
      focusTags: ['产品优势', '高净值客户传承需求', '产品优势'],
      specialInstructions: '重点关注流动性异议；人工说明不是条款证据。',
      fileName: '康宁保.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('康宁保产品介绍\n等待期90天，保险责任以条款为准。').toString('base64'),
    });
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.payload.document.sourceAuthority, 'company_material');
    assert.equal(uploaded.payload.document.payload.libraryType, 'company_product');
    assert.deepEqual(uploaded.payload.document.payload.focusTags, ['产品优势', '高净值客户传承需求']);
    assert.deepEqual(
      app.db.prepare('SELECT company, official_name FROM insurance_products ORDER BY official_name').all()
        .map((row) => ({ ...row })),
      [
        { company: '测试保险公司', official_name: '康宁保' },
      ],
    );

    const documentId = uploaded.payload.document.id;
    const processed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/process`, {});
    assert.equal(processed.response.status, 200);
    assert.equal(processed.payload.document.parseStatus, 'indexed_pending_review');
    assert.equal(processed.payload.job.payload.sectionReviewCount > 0, true);
    assert.equal(processed.payload.job.payload.requiresReview, true);

    const published = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review`, { action: 'publish' });
    assert.equal(published.response.status, 200);
    assert.equal(published.payload.document.reviewStatus, 'published');
    assert.deepEqual(published.payload.registeredKnowledgeRecords.map((record) => record.productName), ['康宁保']);
    assert.equal(app.state.knowledgeRecords.length, 1);

    const listed = await request(app, '/api/admin/product-knowledge/documents');
    assert.equal(listed.payload.documents[0].job.status, 'match_required');
    assert.equal(app.db.prepare('SELECT count(*) AS count FROM knowledge_chunks').get().count > 0, true);
    const chunk = app.db.prepare("SELECT contextual_prefix FROM knowledge_chunks WHERE chunk_type = 'child' LIMIT 1").get();
    assert.match(chunk.contextual_prefix, /保险公司：测试保险公司/u);
    assert.match(chunk.contextual_prefix, /产品：康宁保/u);
    assert.doesNotMatch(chunk.contextual_prefix, /本资料涉及产品/u);
    assert.doesNotMatch(chunk.contextual_prefix, /重点关注标签/u);
    assert.doesNotMatch(chunk.contextual_prefix, /人工检索说明/u);
  } finally {
    await app.close();
  }
});

test('publishing refuses product material whose chunks are not uniquely bound', async () => {
  const app = await makeApp();
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      company: '测试保险公司',
      productNames: ['康宁保', '医药安'],
      fileName: '未分产品范围.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('产品培训资料，等待期以正式条款为准。').toString('base64'),
    });
    const documentId = uploaded.payload.document.id;
    const processed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/process`, {});
    assert.equal(processed.response.status, 200);

    const published = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review`, { action: 'publish' });
    assert.equal(published.response.status, 409);
    assert.equal(published.payload.code, 'PRODUCT_DOCUMENT_BINDING_REQUIRED');
    assert.equal(app.db.prepare("SELECT count(*) AS count FROM knowledge_chunks WHERE review_status = 'published'").get().count, 0);
  } finally {
    await app.close();
  }
});

test('admin can fetch a public product link and persist its extracted text', async () => {
  const app = await makeApp({
    productMaterialFetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      async arrayBuffer() { return Buffer.from('<html><body><h1>康宁保</h1><p>保险责任：等待期90天。</p></body></html>'); },
    }),
  });
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents/from-url', {
      libraryType: 'company_product',
      sourceUrl: 'https://example.test/products/kangning',
      company: '测试保险公司',
      productName: '康宁保',
      materialUsages: ['产品责任指标补充资料'],
    });
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.payload.document.extension, 'txt');
    assert.equal(uploaded.payload.document.payload.sourceUrl, 'https://example.test/products/kangning');
    const processed = await request(app, `/api/admin/product-knowledge/documents/${uploaded.payload.document.id}/process`, {});
    assert.equal(processed.response.status, 200);
    assert.match(app.db.prepare('SELECT raw_text FROM product_document_pages LIMIT 1').get().raw_text, /等待期90天/u);
  } finally {
    await app.close();
  }
});

test('linked material rejects localhost and private network targets', async () => {
  const app = await makeApp({ productMaterialFetchImpl: async () => { throw new Error('must not fetch'); } });
  try {
    const result = await request(app, '/api/admin/product-knowledge/documents/from-url', {
      libraryType: 'company_product',
      sourceUrl: 'http://127.0.0.1/private.pdf',
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'PRODUCT_MATERIAL_URL_FORBIDDEN');
  } finally {
    await app.close();
  }
});

test('expert audio is persisted separately and marked for transcription', async () => {
  const app = await makeApp();
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'expert',
      contributorName: '张老师',
      contributorRole: '销售冠军',
      fileName: '培训录音.mp3',
      mediaType: 'audio/mpeg',
      dataBase64: Buffer.from('fake-audio').toString('base64'),
    });
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.payload.document.sourceAuthority, 'expert_training');
    assert.equal(uploaded.payload.document.payload.contributorName, '张老师');

    const processed = await request(app, `/api/admin/product-knowledge/documents/${uploaded.payload.document.id}/process`, {});
    assert.equal(processed.response.status, 422);
    assert.equal(processed.payload.code, 'PRODUCT_DOCUMENT_TRANSCRIPTION_REQUIRED');

    const listed = await request(app, '/api/admin/product-knowledge/documents');
    assert.equal(listed.payload.documents[0].parseStatus, 'transcription_required');
    assert.equal(listed.payload.documents[0].job.status, 'transcription_required');
    assert.equal(app.db.prepare('SELECT length(content) AS size FROM product_document_blobs').get().size > 0, true);
  } finally {
    await app.close();
  }
});

test('the same file can exist independently in company and expert libraries', async () => {
  const app = await makeApp();
  try {
    const shared = {
      fileName: '培训资料.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('共同内容').toString('base64'),
    };
    const company = await request(app, '/api/admin/product-knowledge/documents', { ...shared, libraryType: 'company_product' });
    const expert = await request(app, '/api/admin/product-knowledge/documents', { ...shared, libraryType: 'expert' });
    assert.equal(company.response.status, 201);
    assert.equal(expert.response.status, 201);
    assert.notEqual(company.payload.document.id, expert.payload.document.id);
    assert.equal(app.db.prepare('SELECT count(*) AS count FROM product_documents').get().count, 2);
  } finally {
    await app.close();
  }
});
