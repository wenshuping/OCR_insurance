import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductRagService } from '../server/product-rag.service.mjs';

test('product RAG forwards product version and as-of date as hard search filters', () => {
  const searchInputs = [];
  const service = createProductRagService({
    store: {
      searchChunks(input) {
        searchInputs.push(input);
        return [];
      },
      getChunksByIds() { return []; },
      listProductFacts() { return []; },
    },
  });

  service.retrieve({
    tenantId: 'default',
    query: '等待期多久',
    canonicalProductId: 'product-1',
    productVersionId: 'version-2026',
    asOfDate: '2026-07-18',
  });

  assert.ok(searchInputs.length > 0);
  assert.equal(searchInputs.every((input) => input.productVersionId === 'version-2026'), true);
  assert.equal(searchInputs.every((input) => input.asOfDate === '2026-07-18'), true);
});

test('product RAG preserves a matched table instead of replacing it with flattened parent text', () => {
  const table = {
    id: 'table-1',
    tenantId: 'default',
    documentId: 'doc-1',
    parentChunkId: 'parent-1',
    chunkType: 'table',
    content: '服务项目 | 服务次数 | 计划一\n电话咨询 | 1次/年 | √',
    contextualPrefix: '资料：测试课件.pptx\n页码：第 1 页',
    tokenCount: 20,
    pageStart: 1,
    pageEnd: 1,
    sourceAuthority: 'company_material',
    reviewStatus: 'published',
    fileName: '测试课件.pptx',
  };
  const parent = { ...table, id: 'parent-1', chunkType: 'parent', content: '服务项目\n服务次数\n计划一\n电话咨询\n1\n次\n年\n√' };
  const service = createProductRagService({
    store: {
      searchChunks() { return [table]; },
      getChunksByIds() { return [parent]; },
    },
  });

  const result = service.retrieve({ tenantId: 'default', query: '电话咨询服务次数' });
  assert.equal(result.evidenceChunks.length, 1);
  assert.equal(result.evidenceChunks[0].chunkId, 'table-1');
  assert.match(result.evidenceChunks[0].content, /电话咨询 \| 1次\/年 \| √/u);
});

test('product RAG keeps a cross-page child when its parent does not cover the full page range', () => {
  const child = {
    id: 'child-cross-page',
    tenantId: 'default',
    documentId: 'doc-1',
    parentChunkId: 'parent-page-1',
    chunkType: 'child',
    content: '被保险人身故，我们按保险金额给付。\n给付后本合同终止。',
    contextualPrefix: '',
    tokenCount: 20,
    pageStart: 1,
    pageEnd: 2,
    sourceAuthority: 'insurer_official',
    reviewStatus: 'published',
  };
  const incompleteParent = {
    ...child,
    id: 'parent-page-1',
    chunkType: 'parent',
    content: child.content,
    tokenCount: 20,
    pageEnd: 1,
  };
  const service = createProductRagService({
    store: {
      searchChunks() { return [child]; },
      getChunksByIds() { return [incompleteParent]; },
    },
  });

  const result = service.retrieve({ tenantId: 'default', query: '身故后合同是否终止' });
  assert.equal(result.evidenceChunks.length, 1);
  assert.equal(result.evidenceChunks[0].chunkId, 'child-cross-page');
  assert.match(result.evidenceChunks[0].content, /给付后本合同终止/u);
  assert.equal(result.evidenceChunks[0].pageEnd, 2);
});

test('product RAG keeps a child when its parent page range covers but does not contain the match', () => {
  const child = {
    id: 'child-1', tenantId: 'default', documentId: 'doc-1', parentChunkId: 'parent-1', chunkType: 'child',
    content: '给付后本合同终止。', contextualPrefix: '', tokenCount: 9,
    pageStart: 2, pageEnd: 2, sourceAuthority: 'insurer_official', reviewStatus: 'published',
  };
  const unrelatedParent = {
    ...child, id: 'parent-1', chunkType: 'parent', content: '第二条 保险责任\n被保险人身故。', tokenCount: 20,
    pageStart: 1, pageEnd: 2,
  };
  const service = createProductRagService({
    store: {
      searchChunks() { return [child]; },
      getChunksByIds() { return [unrelatedParent]; },
    },
  });

  const result = service.retrieve({ tenantId: 'default', query: '身故后合同是否终止' });
  assert.equal(result.evidenceChunks[0].chunkId, 'child-1');
  assert.equal(result.evidenceChunks[0].content, '给付后本合同终止。');
});

test('product RAG replaces a child only with a parent that covers and contains it', () => {
  const child = {
    id: 'child-cross-page',
    tenantId: 'default',
    documentId: 'doc-1',
    parentChunkId: 'parent-section',
    chunkType: 'child',
    content: '给付后本合同终止。',
    contextualPrefix: '',
    tokenCount: 9,
    pageStart: 2,
    pageEnd: 2,
    sourceAuthority: 'insurer_official',
    reviewStatus: 'published',
  };
  const sectionParent = {
    ...child,
    id: 'parent-section',
    chunkType: 'parent',
    content: '第二条 保险责任\n被保险人身故，我们按保险金额给付。\n给付后本合同终止。',
    tokenCount: 35,
    pageStart: 1,
    pageEnd: 2,
  };
  const service = createProductRagService({
    store: {
      searchChunks() { return [child]; },
      getChunksByIds() { return [sectionParent]; },
    },
  });

  const result = service.retrieve({ tenantId: 'default', query: '身故后合同是否终止' });
  assert.equal(result.evidenceChunks.length, 1);
  assert.equal(result.evidenceChunks[0].chunkId, 'parent-section');
  assert.equal(result.evidenceChunks[0].matchedChunkId, 'child-cross-page');
  assert.equal(result.evidenceChunks[0].pageStart, 1);
  assert.equal(result.evidenceChunks[0].pageEnd, 2);
});

test('product RAG searches business topics instead of repeating a bound product name', () => {
  const queries = [];
  const service = createProductRagService({
    store: {
      searchChunks(input) {
        queries.push(input.query);
        return [];
      },
      getChunksByIds() { return []; },
    },
  });

  const result = service.retrieve({
    tenantId: 'default',
    query: '医药安欣有什么优势？',
    canonicalProductId: 'product_medical_anxin',
    products: [{ productName: '医药安欣（易核版）医疗保险' }],
  });

  assert.deepEqual(result.retrievalMeta.searchTerms, ['产品优势', '产品特色', '适用人群', '投保规则', '健康服务', '保障责任']);
  assert.deepEqual(queries, ['产品优势', '产品特色', '适用人群', '投保规则', '健康服务', '保障责任']);
});

test('product RAG maps suitable-customer questions to target audience and underwriting topics', () => {
  const service = createProductRagService({
    store: {
      searchChunks() { return []; },
      getChunksByIds() { return []; },
    },
  });

  const result = service.retrieve({
    tenantId: 'default',
    query: '这款产品适合哪些人？',
    canonicalProductId: 'product_medical_anxin',
  });

  assert.deepEqual(result.retrievalMeta.searchTerms, ['适用人群', '投保规则']);
});

test('product advantage RAG limits repeated topics and keeps one primary chunk per page', () => {
  const chunks = [
    ['adv-1', 1, '产品优势', '优势一'],
    ['adv-1-duplicate', 1, '产品优势', '同页重复优势'],
    ['adv-2', 2, '产品优势', '优势二'],
    ['adv-3', 3, '产品优势', '优势三'],
    ['adv-4', 4, '产品优势', '优势四'],
    ['audience-1', 5, '适用人群', '适合人群'],
    ['service-1', 6, '健康服务', '健康服务'],
    ['coverage-1', 7, '保障责任', '保障责任'],
  ].map(([id, page, topic, content]) => ({
    id,
    tenantId: 'default',
    documentId: 'doc-1',
    chunkType: 'child',
    content,
    contextualPrefix: `切片主题：${topic}`,
    tokenCount: 10,
    pageStart: page,
    pageEnd: page,
    sourceAuthority: 'company_material',
    reviewStatus: 'published',
    fileName: '测试课件.pptx',
  }));
  const service = createProductRagService({
    store: {
      searchChunks() { return chunks; },
      getChunksByIds() { return []; },
    },
  });

  const result = service.retrieve({
    tenantId: 'default',
    query: '这个产品有什么优势？',
    canonicalProductId: 'product-1',
  });

  assert.equal(result.evidenceChunks.length, 6);
  assert.equal(result.evidenceChunks.filter((chunk) => chunk.contextualPrefix.includes('产品优势')).length, 3);
  assert.equal(result.evidenceChunks.filter((chunk) => chunk.pageStart === 1).length, 1);
  assert.deepEqual(result.evidenceChunks.map((chunk) => chunk.evidenceId), ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']);
});

test('exact field RAG returns confirmed facts and limits uploaded primary evidence', () => {
  const searchInputs = [];
  const chunks = [1, 2, 3].map((index) => ({
    id: `fact-${index}`, tenantId: 'default', documentId: 'doc-1', chunkType: 'child',
    content: `免赔额证据${index}`, contextualPrefix: '切片主题：计划与价格', tokenCount: 10,
    pageStart: index, pageEnd: index, sourceAuthority: 'company_material', reviewStatus: 'published',
    payload: { semantic: { evidenceKind: 'fact', factKeys: ['annual_deductible'] } },
  }));
  const service = createProductRagService({
    store: {
      searchChunks(input) { searchInputs.push(input); return chunks; },
      getChunksByIds() { return []; },
      listProductFacts() {
        return [{ fieldKey: 'annual_deductible', normalizedValue: { value: 10_000, unit: 'CNY' }, status: 'confirmed' }];
      },
    },
  });

  const result = service.retrieve({
    tenantId: 'default', query: '计划一免赔额是多少？', canonicalProductId: 'product-1',
    sourceAuthorities: ['company_material'],
  });

  assert.equal(result.evidenceChunks.length, 2);
  assert.equal(result.structuredFacts.length, 1);
  assert.deepEqual(searchInputs[0].semanticKinds, ['fact', 'clause', 'formula']);
  assert.deepEqual(searchInputs[0].factKeys, ['annual_deductible']);
  assert.deepEqual(searchInputs[0].sourceAuthorities, ['company_material']);
});

test('RAG appends required limitation context when the parent exceeds the token budget', () => {
  const primary = {
    id: 'primary', tenantId: 'default', documentId: 'doc-1', parentChunkId: 'parent', chunkType: 'child',
    content: '一般医疗年度限额200万元。', contextualPrefix: '', tokenCount: 10,
    pageStart: 1, pageEnd: 1, sourceAuthority: 'company_material', reviewStatus: 'published',
    payload: { semantic: { evidenceKind: 'fact', factKeys: ['benefit_limit'], requiredContextChunkIds: ['limit'] } },
  };
  const limitation = {
    ...primary, id: 'limit', content: '但未经医保结算时赔付比例为60%。', tokenCount: 12,
    payload: { semantic: { evidenceKind: 'clause', factKeys: ['reimbursement_ratio'], requiredContextChunkIds: [] } },
  };
  const parent = { ...primary, id: 'parent', chunkType: 'parent', content: '很长的父章节', tokenCount: 5_000 };
  const service = createProductRagService({
    store: {
      searchChunks() { return [primary]; },
      getChunksByIds({ chunkIds }) {
        if (chunkIds.includes('limit')) return [limitation];
        if (chunkIds.includes('parent')) return [parent];
        return [];
      },
      listProductFacts() { return []; },
    },
  });

  const result = service.retrieve({
    tenantId: 'default', query: '年度限额是多少？', canonicalProductId: 'product-1', tokenBudget: 200,
  });
  assert.deepEqual(result.evidenceChunks.map((item) => item.chunkId), ['primary', 'limit']);
  assert.equal(result.retrievalMeta.requiredContextCount, 1);
});
