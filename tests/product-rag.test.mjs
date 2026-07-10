import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyProductKnowledgeQuery,
  createProductRagService,
} from '../server/product-rag.service.mjs';

test('classifies product knowledge questions deterministically', () => {
  assert.equal(classifyProductKnowledgeQuery('两款产品有什么区别'), 'product_comparison');
  assert.equal(classifyProductKnowledgeQuery('这款产品等待期多少天'), 'exact_field');
  assert.equal(classifyProductKnowledgeQuery('客户嫌贵该怎么讲'), 'sales_guidance');
  assert.equal(classifyProductKnowledgeQuery('普通介绍'), 'general_product_knowledge');
});

function fakeStore() {
  const parent = {
    id: 'parent_1', tenantId: 'default', documentId: 'doc_1', chunkType: 'parent',
    content: '完整章节：本产品等待期为90天。等待期内发生约定疾病按条款处理。',
    tokenCount: 30, pageStart: 3, pageEnd: 3,
  };
  const child = {
    id: 'child_1', tenantId: 'default', documentId: 'doc_1', parentChunkId: 'parent_1',
    content: '等待期为90天。', contextualPrefix: '产品：康宁保\n页码：第3页', tokenCount: 8,
    pageStart: 3, pageEnd: 3, sourceAuthority: 'official_terms', reviewStatus: 'published',
    fileName: '康宁保条款.pdf', canonicalProductId: 'cp_knb', productVersionId: 'pv_2026',
  };
  return {
    searches: [],
    searchChunks(input) {
      this.searches.push(input);
      return input.query === '等待期' ? [child] : [];
    },
    getChunksByIds({ chunkIds }) {
      return chunkIds.includes(parent.id) ? [parent] : [];
    },
  };
}

test('retrieves children, expands parents and emits complete citations', () => {
  const store = fakeStore();
  const rag = createProductRagService({ store });
  const result = rag.retrieve({ tenantId: 'default', query: '这款产品等待期是多少？' });
  assert.equal(result.queryType, 'exact_field');
  assert.equal(result.evidenceChunks.length, 1);
  assert.equal(result.evidenceChunks[0].chunkId, 'parent_1');
  assert.equal(result.evidenceChunks[0].matchedChunkId, 'child_1');
  assert.equal(result.evidenceChunks[0].citation.fileName, '康宁保条款.pdf');
  assert.equal(result.evidenceChunks[0].citation.pageStart, 3);
  assert.deepEqual(result.missingInformation, []);
  assert.equal(store.searches[0].includeQuarantined, false);
});

test('preview mode is explicit and forwarded to retrieval', () => {
  const store = fakeStore();
  const result = createProductRagService({ store }).retrieve({
    tenantId: 'default', query: '等待期', includeQuarantined: true,
  });
  assert.equal(result.previewMode, true);
  assert.equal(store.searches[0].includeQuarantined, true);
});

test('missing evidence returns a gap instead of a fabricated answer', () => {
  const store = { searchChunks: () => [], getChunksByIds: () => [] };
  const result = createProductRagService({ store }).retrieve({ query: '停售版本有什么责任' });
  assert.equal(result.evidenceChunks.length, 0);
  assert.match(result.missingInformation[0], /没有找到/u);
});

test('evidence obeys the token budget and deduplicates the same parent', () => {
  const children = Array.from({ length: 3 }, (_, index) => ({
    id: `child_${index}`, tenantId: 'default', documentId: 'doc', parentChunkId: index < 2 ? 'parent_a' : 'parent_b',
    content: `等待期证据${index}`, contextualPrefix: '', tokenCount: 10, pageStart: index + 1, pageEnd: index + 1,
    sourceAuthority: 'company_material', reviewStatus: 'published', fileName: '资料.txt',
  }));
  const store = {
    searchChunks: () => children,
    getChunksByIds: () => [
      { id: 'parent_a', content: 'A'.repeat(50), tokenCount: 150, pageStart: 1, pageEnd: 2 },
      { id: 'parent_b', content: 'B'.repeat(50), tokenCount: 150, pageStart: 3, pageEnd: 3 },
    ],
  };
  const result = createProductRagService({ store }).retrieve({ query: '等待期', tokenBudget: 200 });
  assert.equal(result.evidenceChunks.length, 2);
  assert.equal(new Set(result.evidenceChunks.map((item) => item.parentChunkId)).size, 2);
  assert.ok(result.evidenceChunks.reduce((sum, item) => sum + item.tokenCount, 0) <= 200);
});
