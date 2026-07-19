import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  annotatePagesWithSourceElements,
  attachChunkSourceRegions,
} from '../server/product-document-source-elements.service.mjs';
import {
  applyChunkCorrectionOperations,
  buildProductDocumentCorrectionPlan,
} from '../server/product-document-correction.service.mjs';
import { createProductDocumentReviewService } from '../server/product-document-review.service.mjs';
import { createProductIngestionService } from '../server/product-ingestion.service.mjs';
import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';

test('source elements remain stable and connect candidate chunks to page evidence', () => {
  const pages = annotatePagesWithSourceElements([{
    pageNo: 8,
    rawText: '保障计划表\n未经基本医疗保险结算的，给付比例为60%。',
    headings: ['保障计划表'],
    tables: [{ rows: [['保障项目', '计划一'], ['年度限额', '100万元']] }],
    layout: { sourceType: 'pdf' },
  }]);
  const repeated = annotatePagesWithSourceElements([{
    pageNo: 8,
    rawText: '保障计划表\n未经基本医疗保险结算的，给付比例为60%。',
    headings: ['保障计划表'],
    tables: [{ rows: [['保障项目', '计划一'], ['年度限额', '100万元']] }],
    layout: { sourceType: 'pdf' },
  }]);

  assert.deepEqual(pages[0].layout.elements, repeated[0].layout.elements);
  assert.equal(pages[0].layout.elements.some((element) => element.kind === 'table'), true);

  const chunks = attachChunkSourceRegions([{
    id: 'chunk-1',
    chunkType: 'child',
    pageStart: 8,
    pageEnd: 8,
    content: '未经基本医疗保险结算的，给付比例为60%。',
    payload: {},
  }], pages);
  assert.equal(chunks[0].payload.sourceRegions[0].pageNo, 8);
  assert.equal(chunks[0].payload.sourceRegions[0].elementIds.length, 1);
});

test('AI pre-review keeps valid source-linked issues and rejects invented references', async () => {
  const pages = annotatePagesWithSourceElements([{
    pageNo: 1,
    rawText: '未经基本医疗保险结算的，给付比例为60%。',
    headings: [],
    tables: [],
    layout: {},
  }]);
  const chunks = attachChunkSourceRegions([{
    id: 'chunk-1',
    chunkType: 'child',
    pageStart: 1,
    pageEnd: 1,
    content: '给付比例为60%。',
    indexStatus: 'ready',
    payload: {},
  }], pages);
  const elementId = pages[0].layout.elements[0].id;
  const service = createProductDocumentReviewService({
    reviewModel: async () => ({
      model: 'test-review-model',
      issues: [
        {
          type: 'semantic_incomplete',
          severity: 'high',
          confidence: 0.94,
          pageNos: [1],
          sourceRegions: [{ pageNo: 1, elementIds: [elementId] }],
          affectedChunkIds: ['chunk-1'],
          reason: '60%缺少未经医保结算的适用条件',
          proposedOperations: [{ type: 'add_source_elements', targetChunkId: 'chunk-1', elementIds: [elementId] }],
        },
        {
          type: 'missing_content',
          severity: 'high',
          pageNos: [99],
          sourceRegions: [{ pageNo: 99, elementIds: ['invented'] }],
          affectedChunkIds: ['invented-chunk'],
          reason: '不存在的证据',
        },
      ],
    }),
  });

  const result = await service.reviewDocument({
    document: { id: 'doc-1', payload: { candidateIndexVersion: 'v1' } },
    pages,
    chunks,
  });
  assert.equal(result.model, 'test-review-model');
  assert.equal(result.issues.some((issue) => issue.reason === '不存在的证据'), false);
  assert.equal(result.issues.some((issue) => issue.type === 'semantic_incomplete'), true);
  assert.equal(result.summary.highRiskCount > 0, true);
});

test('deterministic review ignores intentionally excluded noise and groups missing elements by page', async () => {
  const pages = [{
    pageNo: 8,
    excludedElementIds: ['footer-page'],
    layout: { elements: [
      { id: 'covered', kind: 'text', text: '附加长期护理' },
      { id: 'missing-amount', kind: 'text', text: '45192' },
      { id: 'missing-unit', kind: 'text', text: '元' },
      { id: 'footer-page', kind: 'text', text: '8' },
    ] },
  }];
  const chunks = [{
    id: 'chunk-8', chunkType: 'child', indexStatus: 'ready', pageStart: 8, pageEnd: 8,
    content: '附加长期护理', payload: { sourceRegions: [{ pageNo: 8, elementIds: ['covered'] }] },
  }];

  const result = await createProductDocumentReviewService().reviewDocument({ pages, chunks });

  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].type, 'missing_content');
  assert.deepEqual(result.issues[0].sourceRegions, [{ pageNo: 8, elementIds: ['missing-amount', 'missing-unit'] }]);
  assert.deepEqual(result.issues[0].missingElements, ['45192', '元']);
  assert.equal(result.issues[0].sourceRegions[0].elementIds.includes('footer-page'), false);
});

test('AI correction planning returns only operations inside the requested chunk scope', async () => {
  const pages = annotatePagesWithSourceElements([{
    pageNo: 1, rawText: '未经基本医疗保险结算的，给付比例为60%。', layout: {},
  }]);
  const elementId = pages[0].layout.elements[0].id;
  const chunks = [
    { id: 'chunk-1', pageStart: 1, pageEnd: 1, content: '给付比例为60%。', payload: {} },
    { id: 'chunk-2', pageStart: 2, pageEnd: 2, content: '其他责任', payload: {} },
  ];
  const service = createProductDocumentReviewService({
    reviewModel: async (input) => {
      assert.equal(input.correctionRequest.note, '补全给付比例的适用条件');
      return {
        model: 'test-correction-model',
        issues: [{
          type: 'semantic_incomplete', severity: 'high', confidence: 0.95,
          pageNos: [1], sourceRegions: [{ pageNo: 1, elementIds: [elementId] }],
          affectedChunkIds: ['chunk-1'], reason: '给付条件缺失',
          proposedOperations: [
            { type: 'add_source_elements', targetChunkId: 'chunk-1', elementIds: [elementId] },
            { type: 'exclude_chunk', targetChunkId: 'chunk-2' },
          ],
        }],
      };
    },
  });
  const result = await service.planCorrection({
    document: { id: 'doc-1' }, pages, chunks,
    request: {
      pageNo: 1, reasonCode: 'semantic_incomplete', note: '补全给付比例的适用条件',
      scope: 'current_chunk', targetChunkIds: ['chunk-1'], sourceElementIds: [elementId],
    },
  });
  assert.equal(result.model, 'test-correction-model');
  assert.deepEqual(result.operations, [
    { type: 'add_source_elements', targetChunkId: 'chunk-1', elementIds: [elementId] },
  ]);
});

test('correction instructions become allowlisted operations and can create corrected chunks', () => {
  const plan = buildProductDocumentCorrectionPlan({
    reasonCode: 'semantic_incomplete',
    note: '把未经医保结算的条件补入60%比例切片，不要合并免赔额。',
    targetChunkIds: ['chunk-1'],
    sourceElementIds: ['el-1'],
  });
  assert.deepEqual(plan.operations, [{
    type: 'add_source_elements',
    targetChunkId: 'chunk-1',
    elementIds: ['el-1'],
  }]);

  const corrected = applyChunkCorrectionOperations({
    chunks: [{ id: 'chunk-1', content: '给付比例为60%。', payload: {} }],
    pages: [{ pageNo: 1, layout: { elements: [{ id: 'el-1', kind: 'text', text: '未经基本医疗保险结算的' }] } }],
    operations: plan.operations,
  });
  assert.equal(corrected[0].content, '未经基本医疗保险结算的\n给付比例为60%。');
  assert.deepEqual(corrected[0].payload.manualCorrection.elementIds, ['el-1']);
});

test('review runs, issues, and corrections persist through the product knowledge store', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  const upload = store.createDocumentUpload({
    tenantId: 'default',
    contentHash: 'review-document',
    fileName: 'review.txt',
    bytes: Buffer.from('source'),
  });
  const documentId = upload.document.id;
  const saved = store.saveDocumentReviewResult({
    tenantId: 'default',
    documentId,
    indexVersion: 'v1',
    reviewType: 'ai_pre_review',
    model: 'test-review-model',
    status: 'completed',
    issues: [{ type: 'missing_content', severity: 'high', reason: '脚注遗漏', confidence: 0.9 }],
    summary: { highRiskCount: 1 },
  });
  assert.equal(saved.issues.length, 1);
  assert.equal(store.listDocumentReviewRuns({ tenantId: 'default', documentId }).length, 1);
  assert.equal(store.listDocumentReviewIssues({ tenantId: 'default', documentId })[0].reason, '脚注遗漏');

  const correction = store.saveDocumentCorrection({
    tenantId: 'default',
    documentId,
    sourceIssueId: saved.issues[0].id,
    reasonCode: 'missing_content',
    note: '补入脚注',
    operations: [{ type: 'add_source_elements', targetChunkId: 'chunk-1', elementIds: ['el-1'] }],
    createdBy: 'admin',
  });
  assert.equal(correction.status, 'approved');
  assert.equal(store.listDocumentCorrections({ tenantId: 'default', documentId })[0].note, '补入脚注');
  db.close();
});

test('approved corrections rebuild a candidate version without replacing the active index', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  const upload = store.createDocumentUpload({
    tenantId: 'default',
    contentHash: 'correction-reprocess',
    fileName: 'correction.txt',
    extension: 'txt',
    bytes: Buffer.from('保险责任\n给付比例为60%。'),
    payload: { company: '测试保险公司', productName: '测试医疗险', productNames: ['测试医疗险'] },
  });
  const service = createProductIngestionService({ store });
  const first = await service.ingestDocument({ tenantId: 'default', documentId: upload.document.id });
  store.reviewDocument({ tenantId: 'default', documentId: upload.document.id, action: 'publish' });
  const activeVersion = first.indexVersion;
  const child = store.getDocumentIndexReview({ tenantId: 'default', documentId: upload.document.id }).activeChunks
    .find((chunk) => chunk.chunkType === 'child');

  const correction = store.saveDocumentCorrection({
    tenantId: 'default',
    documentId: upload.document.id,
    reasonCode: 'ocr_error',
    note: '修正比例条件',
    operations: [{ type: 'edit_chunk', targetChunkId: child.id, content: '未经基本医疗保险结算的，给付比例为60%。' }],
    createdBy: 'admin',
  });
  const second = await service.ingestDocument({ tenantId: 'default', documentId: upload.document.id });
  const review = store.getDocumentIndexReview({ tenantId: 'default', documentId: upload.document.id });
  assert.equal(review.activeIndexVersion, activeVersion);
  assert.equal(review.candidateIndexVersion, second.indexVersion);
  assert.match(review.candidateChunks.find((chunk) => chunk.chunkType === 'child').content, /未经基本医疗保险结算/u);
  assert.equal(store.searchChunks({ tenantId: 'default', query: '未经基本医疗保险结算' }).length, 0);
  assert.equal(store.listDocumentCorrections({ tenantId: 'default', documentId: upload.document.id })[0].status, 'applied');
  assert.equal(store.listDocumentCorrections({ tenantId: 'default', documentId: upload.document.id })[0].appliedIndexVersion, second.indexVersion);
  assert.equal(correction.status, 'approved');
  db.close();
});
