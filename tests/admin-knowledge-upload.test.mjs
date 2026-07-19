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
    productIngestionService: options.productIngestionService,
    productDocumentPreviewService: options.productDocumentPreviewService,
    productDocumentReviewService: options.productDocumentReviewService,
    productMaterialFetchImpl: options.productMaterialFetchImpl,
    recognizeDocumentText: options.recognizeDocumentText,
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

async function request(app, path, body, options = {}) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method: options.method || (body === undefined ? 'GET' : 'POST'),
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
    const chunk = app.db.prepare("SELECT content, contextual_prefix, payload FROM knowledge_chunks WHERE chunk_type = 'child' LIMIT 1").get();
    assert.match(chunk.contextual_prefix, /保险公司：测试保险公司/u);
    assert.match(chunk.contextual_prefix, /产品：康宁保/u);
    assert.match(chunk.contextual_prefix, /资料标题：康宁保产品培训/u);
    assert.match(chunk.contextual_prefix, /资料用途：销售建议资料、产品责任指标补充资料/u);
    assert.match(chunk.contextual_prefix, /重点关注标签：产品优势、高净值客户传承需求/u);
    assert.match(chunk.contextual_prefix, /资料备注（非原文证据）：重点关注流动性异议/u);
    assert.doesNotMatch(chunk.content, /重点关注流动性异议/u);
    const metadata = JSON.parse(chunk.payload).documentMetadata;
    assert.equal(metadata.title, '康宁保产品培训');
    assert.deepEqual(metadata.focusTags, ['产品优势', '高净值客户传承需求']);
    assert.equal(metadata.specialInstructions, '重点关注流动性异议；人工说明不是条款证据。');
  } finally {
    await app.close();
  }
});

test('product image material runs OCR before chunking and keeps the original image as source', async () => {
  let recognizedUpload = null;
  const app = await makeApp({
    async recognizeDocumentText(uploadItem) {
      recognizedUpload = uploadItem;
      return '康宁保产品介绍\n等待期为90天，保险责任以条款为准。';
    },
  });
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      company: '测试保险公司',
      productName: '康宁保',
      productNames: ['康宁保'],
      fileName: '康宁保.png',
      mediaType: 'image/png',
      dataBase64: Buffer.from('image-bytes').toString('base64'),
    });
    const documentId = uploaded.payload.document.id;
    const processed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/process`, {});

    assert.equal(processed.response.status, 200);
    assert.equal(recognizedUpload.name, '康宁保.png');
    assert.equal(recognizedUpload.type, 'image/png');
    assert.match(recognizedUpload.dataUrl, /^data:image\/png;base64,/u);
    const page = app.db.prepare('SELECT raw_text, layout_json FROM product_document_pages WHERE document_id = ?').get(documentId);
    assert.match(page.raw_text, /等待期为90天/u);
    assert.equal(JSON.parse(page.layout_json).sourceType, 'image');
    assert.equal(app.db.prepare('SELECT COUNT(*) AS count FROM knowledge_chunks WHERE document_id = ?').get(documentId).count > 0, true);
  } finally {
    await app.close();
  }
});

test('admin pre-reviews candidate chunks, previews a controlled correction, and persists confirmation', async () => {
  let reviewedInput = null;
  const app = await makeApp({
    productDocumentReviewService: {
      async reviewDocument(input) {
        reviewedInput = input;
        return {
          decision: 'human_review_required',
          model: 'injected-review-model',
          reviewVersion: 'test-review-v1',
          summary: { issueCount: 1, highRiskCount: 1 },
          issues: [{
            type: 'semantic_incomplete',
            severity: 'high',
            confidence: 0.95,
            pageNos: [1],
            affectedChunkIds: [input.chunks.find((chunk) => chunk.chunkType !== 'parent')?.id],
            reason: '60%给付比例缺少适用条件',
            proposedOperations: [],
          }],
        };
      },
      async planCorrection(input) {
        return {
          model: 'injected-correction-model', correctionVersion: 'test-correction-v1', issues: [],
          operations: [{
            type: 'edit_chunk', targetChunkId: input.request.targetChunkIds[0],
            content: '未经基本医疗保险结算的，给付比例为60%。',
          }],
        };
      },
    },
  });
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      company: '测试保险公司',
      productName: '安心医疗',
      fileName: '安心医疗.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('未经基本医疗保险结算的，给付比例为60%。').toString('base64'),
    });
    const documentId = uploaded.payload.document.id;
    const processed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/process`, {});
    assert.equal(processed.response.status, 200);
    assert.equal(processed.payload.preReview.status, 'completed');
    assert.equal(processed.payload.preReview.review.model, 'injected-review-model');

    const preReview = await request(app, `/api/admin/product-knowledge/documents/${documentId}/pre-review`, {});
    assert.equal(preReview.response.status, 200);
    assert.equal(preReview.payload.review.model, 'injected-review-model');
    assert.equal(preReview.payload.issues[0].reason, '60%给付比例缺少适用条件');
    assert.equal(reviewedInput.document.id, documentId);
    assert.equal(reviewedInput.pages.length, 1);
    assert.equal(reviewedInput.chunks.length > 0, true);

    const workspace = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review-workspace`);
    assert.equal(workspace.response.status, 200);
    assert.equal(workspace.payload.reviewRuns.length, 2);
    assert.equal(workspace.payload.issues.length, 1);
    assert.equal(workspace.payload.issues[0].runId, workspace.payload.reviewRuns[0].id);
    assert.equal(workspace.payload.pages.length, 1);
    assert.equal(workspace.payload.indexReview.candidateChunks.length > 0, true);
    const targetChunkId = workspace.payload.indexReview.candidateChunks.find((chunk) => chunk.chunkType !== 'parent').id;

    const correctionNote = '对应年度免赔额与50%赔付条件未解析完整';
    const needsCorrection = await request(app, `/api/admin/product-knowledge/documents/${documentId}/pages/1/review`, {
      status: 'needs_correction',
      note: correctionNote,
      indexVersion: workspace.payload.indexReview.candidateIndexVersion,
    });
    assert.equal(needsCorrection.response.status, 200);
    assert.equal(needsCorrection.payload.review.note, correctionNote);
    const notedWorkspace = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review-workspace`);
    assert.equal(notedWorkspace.payload.pageReviews[0].note, correctionNote);

    const pageReviewed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/pages/1/review`, {
      status: 'passed',
      indexVersion: workspace.payload.indexReview.candidateIndexVersion,
    });
    assert.equal(pageReviewed.response.status, 200);
    assert.equal(pageReviewed.payload.review.status, 'passed');
    assert.equal(pageReviewed.payload.publishedChunkCount > 0, true);
    assert.equal(app.db.prepare(`
      SELECT count(*) AS count FROM knowledge_chunks
      WHERE document_id = ? AND chunk_type != 'parent' AND review_status = 'published'
    `).get(documentId).count > 0, true);
    const reviewedWorkspace = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review-workspace`);
    assert.equal(reviewedWorkspace.payload.pageReviews.length, 1);
    assert.equal(reviewedWorkspace.payload.pageReviews[0].pageNo, 1);

    const excluded = await request(app, `/api/admin/product-knowledge/documents/${documentId}/pages/1/review`, {
      status: 'excluded',
      note: '封面不参与检索',
      indexVersion: workspace.payload.indexReview.candidateIndexVersion,
    });
    assert.equal(excluded.response.status, 200);
    assert.equal(excluded.payload.review.status, 'excluded');
    assert.equal(app.db.prepare(`
      SELECT count(*) AS count FROM knowledge_chunks
      WHERE document_id = ? AND review_status = 'published'
    `).get(documentId).count, 0);
    const excludedWorkspace = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review-workspace`);
    assert.equal(excludedWorkspace.payload.pageReviews[0].note, '封面不参与检索');
    assert.equal(excludedWorkspace.payload.indexReview.candidateChunks
      .filter((chunk) => chunk.pageStart <= 1 && chunk.pageEnd >= 1)
      .every((chunk) => chunk.indexStatus === 'blocked'), true);
    assert.deepEqual(excludedWorkspace.payload.indexReview.candidateChunks
      .find((chunk) => chunk.id === targetChunkId).payload.pageExclusion.pageNos, [1]);

    const restored = await request(app, `/api/admin/product-knowledge/documents/${documentId}/pages/1/review`, {
      status: 'passed',
      indexVersion: workspace.payload.indexReview.candidateIndexVersion,
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.payload.publishedChunkCount > 0, true);
    const restoredWorkspace = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review-workspace`);
    assert.equal(restoredWorkspace.payload.indexReview.candidateChunks
      .find((chunk) => chunk.id === targetChunkId).indexStatus, 'ready');
    assert.equal(restoredWorkspace.payload.indexReview.candidateChunks
      .find((chunk) => chunk.id === targetChunkId).payload.pageExclusion, undefined);

    const aiPlanned = await request(app, `/api/admin/product-knowledge/documents/${documentId}/corrections/plan`, {
      pageNo: 1, reasonCode: 'semantic_incomplete', note: '自动补全给付比例的适用条件',
      scope: 'current_chunk', targetChunkIds: [targetChunkId],
    });
    assert.equal(aiPlanned.response.status, 200);
    assert.equal(aiPlanned.payload.plan.model, 'injected-correction-model');
    assert.equal(aiPlanned.payload.plan.operations[0].type, 'edit_chunk');

    const planned = await request(app, `/api/admin/product-knowledge/documents/${documentId}/corrections/plan`, {
      reasonCode: 'semantic_incomplete',
      note: '把适用条件保留在比例切片中',
      operations: [{ type: 'edit_chunk', targetChunkId, content: '未经基本医疗保险结算的，给付比例为60%。' }, { type: 'publish_directly' }],
    });
    assert.equal(planned.response.status, 200);
    assert.deepEqual(planned.payload.plan.operations, [{
      type: 'edit_chunk',
      targetChunkId,
      content: '未经基本医疗保险结算的，给付比例为60%。',
    }]);
    assert.equal(planned.payload.plan.requiresConfirmation, true);

    const confirmed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/corrections/confirm`, {
      sourceIssueId: workspace.payload.issues[0].id,
      pageNo: 1,
      plan: planned.payload.plan,
    });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.payload.correction.status, 'approved');
    assert.equal(confirmed.payload.correction.note, '把适用条件保留在比例切片中');
    assert.equal(confirmed.payload.reprocessed.document.id, documentId);

    const refreshed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review-workspace`);
    assert.equal(refreshed.payload.corrections.length, 1);
    assert.equal(refreshed.payload.issues.find((issue) => issue.id === workspace.payload.issues[0].id).status, 'correction_planned');
    assert.equal(refreshed.payload.pageReviews[0].status, 'pending_confirmation');

    const rejected = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review`, {
      action: 'reject',
      note: '脚注仍然缺失，请重新切分后复核。',
    });
    assert.equal(rejected.response.status, 200);
    assert.equal(rejected.payload.document.payload.review.note, '脚注仍然缺失，请重新切分后复核。');
  } finally {
    await app.close();
  }
});

test('document source requires admin authorization and returns the original bytes inline', async () => {
  const app = await makeApp();
  try {
    const source = Buffer.from('原始保险资料');
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      fileName: '原始资料.txt',
      mediaType: 'text/plain',
      dataBase64: source.toString('base64'),
    });
    const path = `/api/admin/product-knowledge/documents/${uploaded.payload.document.id}/source`;
    const unauthorized = await fetch(`${app.baseUrl}${path}`);
    assert.equal(unauthorized.status, 401);

    const response = await fetch(`${app.baseUrl}${path}`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/u);
    assert.match(response.headers.get('content-disposition'), /^inline;/u);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source);
  } finally {
    await app.close();
  }
});

test('document page preview requires admin authorization and returns an image', async () => {
  const app = await makeApp({
    productDocumentPreviewService: {
      async getPagePreview({ pageNo }) {
        assert.equal(pageNo, 1);
        return Buffer.from('preview-image');
      },
    },
  });
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      company: '测试保险公司',
      productName: '页面预览产品',
      fileName: '页面预览.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('第一页内容').toString('base64'),
    });
    const documentId = uploaded.payload.document.id;
    await request(app, `/api/admin/product-knowledge/documents/${documentId}/process`, {});
    const unauthorized = await fetch(`${app.baseUrl}/api/admin/product-knowledge/documents/${documentId}/pages/1/preview`);
    assert.equal(unauthorized.status, 401);
    const preview = await fetch(`${app.baseUrl}/api/admin/product-knowledge/documents/${documentId}/pages/1/preview`, {
      headers: { authorization: 'Bearer admin-token' },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('content-type'), 'image/png');
    assert.equal(Buffer.from(await preview.arrayBuffer()).toString(), 'preview-image');
  } finally {
    await app.close();
  }
});

test('document processing keeps candidate chunks when automatic pre-review fails', async () => {
  const app = await makeApp({
    productDocumentReviewService: {
      async reviewDocument() {
        const error = new Error('模型暂不可用');
        error.code = 'REVIEW_MODEL_UNAVAILABLE';
        throw error;
      },
    },
  });
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      company: '测试保险公司',
      productName: '安心医疗',
      fileName: '降级预审.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('等待期为90天。').toString('base64'),
    });
    const documentId = uploaded.payload.document.id;
    const processed = await request(app, `/api/admin/product-knowledge/documents/${documentId}/process`, {});
    assert.equal(processed.response.status, 200);
    assert.equal(processed.payload.preReview.status, 'failed');
    assert.equal(processed.payload.preReview.degraded, true);
    assert.equal(processed.payload.preReview.code, 'REVIEW_MODEL_UNAVAILABLE');

    const workspace = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review-workspace`);
    assert.equal(workspace.payload.indexReview.candidateChunks.length > 0, true);
    assert.equal(workspace.payload.reviewRuns[0].status, 'failed');
  } finally {
    await app.close();
  }
});

test('admin manually binds an ambiguous candidate chunk before publishing', async () => {
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

    const listed = await request(app, '/api/admin/product-knowledge/documents?includeChunks=review');
    const listedDocument = listed.payload.documents.find((document) => document.id === documentId);
    assert.equal(listedDocument.publishReadiness.decision, 'blocked');
    assert.equal(listedDocument.publishReadiness.blockingReasons[0].code, 'product_binding_missing');
    assert.equal(listedDocument.bindingProducts.length, 2);

    const published = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review`, { action: 'publish' });
    assert.equal(published.response.status, 409);
    assert.equal(published.payload.code, 'PRODUCT_DOCUMENT_BINDING_REQUIRED');
    assert.match(published.payload.message, /修正产品绑定后再发布/);
    assert.equal(app.db.prepare("SELECT count(*) AS count FROM knowledge_chunks WHERE review_status = 'published'").get().count, 0);

    const candidateChunk = listedDocument.reviewChunks.find((chunk) => chunk.chunkType !== 'parent' && chunk.indexStatus === 'ready');
    const selectedProduct = listedDocument.bindingProducts[0];
    const bound = await request(app, `/api/admin/product-knowledge/documents/${documentId}/chunks/${candidateChunk.id}/binding`, {
      action: 'bind',
      canonicalProductId: selectedProduct.canonicalProductId,
    }, { method: 'PATCH' });
    assert.equal(bound.response.status, 200);
    assert.equal(bound.payload.chunk.canonicalProductId, selectedProduct.canonicalProductId);
    assert.equal(bound.payload.chunk.payload.manualBinding.action, 'bind');
    assert.equal(bound.payload.publishReadiness.decision, 'pass');

    const publishedAfterBinding = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review`, { action: 'publish' });
    assert.equal(publishedAfterBinding.response.status, 200);
    assert.equal(publishedAfterBinding.payload.document.reviewStatus, 'published');
  } finally {
    await app.close();
  }
});

test('publishing releases bound usable chunks while keeping unbound chunks isolated', async () => {
  const app = await makeApp();
  try {
    const uploaded = await request(app, '/api/admin/product-knowledge/documents', {
      libraryType: 'company_product',
      company: '测试保险公司',
      productName: '康宁保',
      fileName: '部分可发布资料.txt',
      mediaType: 'text/plain',
      dataBase64: Buffer.from('康宁保产品培训资料，等待期90天。').toString('base64'),
    });
    const documentId = uploaded.payload.document.id;
    await request(app, `/api/admin/product-knowledge/documents/${documentId}/process`, {});
    const original = app.db.prepare(`
      SELECT id FROM knowledge_chunks
      WHERE document_id = ? AND chunk_type != 'parent' AND index_status = 'ready'
        AND canonical_product_id IS NOT NULL
      LIMIT 1
    `).get(documentId);
    assert.ok(original?.id);
    app.db.prepare(`
      INSERT INTO knowledge_chunks (
        id, tenant_id, document_id, canonical_product_id, product_version_id,
        parent_chunk_id, chunk_type, heading_path_json, page_start, page_end,
        content, contextual_prefix, token_count, content_hash, source_authority,
        review_status, valid_from, valid_to, ocr_confidence, embedding_version,
        index_status, created_at, updated_at, payload
      )
      SELECT id || '_bound_copy', tenant_id, document_id, canonical_product_id, product_version_id,
        parent_chunk_id, chunk_type, heading_path_json, page_start, page_end,
        content || '\n补充', contextual_prefix, token_count, content_hash || '_bound_copy', source_authority,
        review_status, valid_from, valid_to, ocr_confidence, embedding_version,
        index_status, created_at, updated_at, payload
      FROM knowledge_chunks WHERE id = ?
    `).run(original.id);
    app.db.prepare('UPDATE knowledge_chunks SET canonical_product_id = NULL, product_version_id = NULL WHERE id = ?').run(original.id);

    const published = await request(app, `/api/admin/product-knowledge/documents/${documentId}/review`, { action: 'publish' });
    assert.equal(published.response.status, 200);
    assert.equal(app.db.prepare('SELECT review_status FROM knowledge_chunks WHERE id = ?').get(`${original.id}_bound_copy`).review_status, 'published');
    assert.equal(app.db.prepare('SELECT review_status FROM knowledge_chunks WHERE id = ?').get(original.id).review_status, 'rejected');
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
