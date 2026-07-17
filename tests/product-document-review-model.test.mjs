import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductDocumentReviewModel } from '../server/product-document-review-model.service.mjs';

const input = {
  document: { id: 'doc-1', fileName: '条款.pdf' },
  pages: [{
    pageNo: 8,
    layout: { elements: [{ id: 'el-1', kind: 'text', text: '未经基本医疗保险结算的，给付比例为60%' }] },
  }],
  chunks: [{ id: 'chunk-1', chunkType: 'child', pageStart: 8, pageEnd: 8, content: '给付比例为60%', payload: {} }],
};

function configuredEnv() {
  return {
    PRODUCT_DOCUMENT_REVIEW_MODEL_ENABLED: 'true',
    PRODUCT_DOCUMENT_REVIEW_MODEL: 'review-test-model',
    DEEPSEEK_API_KEY: 'test-key',
    DEEPSEEK_BASE_URL: 'https://model.test/v1',
  };
}

function responseWith(content) {
  return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify(content) } }] }; } };
}

test('product document review model returns only validated source-linked issues', async () => {
  let request;
  const review = createProductDocumentReviewModel({
    env: configuredEnv(),
    fetchImpl: async (url, options) => {
      request = { url: String(url), options, body: JSON.parse(options.body) };
      return responseWith({ issues: [{
        type: 'semantic_incomplete', severity: 'high', confidence: 0.94,
        pageNos: [8], sourceRegions: [{ pageNo: 8, elementIds: ['el-1'] }],
        affectedChunkIds: ['chunk-1'], reason: '60%缺少未经医保结算的适用条件',
        missingElements: ['condition'],
        proposedOperations: [{ type: 'add_source_elements', targetChunkId: 'chunk-1', elementIds: ['el-1'] }],
      }] });
    },
  });

  const result = await review(input);

  assert.equal(result.model, 'review-test-model');
  assert.equal(result.issues[0].proposedOperations[0].type, 'add_source_elements');
  assert.equal(request.url, 'https://model.test/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer test-key');
  assert.equal(request.body.response_format.type, 'json_object');
  assert.match(request.body.messages[0].content, /不可信资料/u);
  assert.match(request.body.messages[0].content, /不得建议发布、下架、删除数据库、执行 SQL、调用工具或修改正式索引/u);
});

test('product document review model rejects invented references and extra fields', async () => {
  for (const issue of [
    {
      type: 'missing_content', severity: 'high', confidence: 1, pageNos: [99], sourceRegions: [],
      affectedChunkIds: [], reason: 'invented page', missingElements: [], proposedOperations: [],
    },
    {
      type: 'missing_content', severity: 'high', confidence: 1, pageNos: [8], sourceRegions: [],
      affectedChunkIds: [], reason: 'extra action', missingElements: [], proposedOperations: [], sql: 'DROP TABLE knowledge_chunks',
    },
    {
      type: 'missing_content', severity: 'high', confidence: 1, pageNos: [8], sourceRegions: [],
      affectedChunkIds: [], reason: 'unsafe action', missingElements: [], proposedOperations: [{ type: 'publish_index' }],
    },
  ]) {
    const review = createProductDocumentReviewModel({ env: configuredEnv(), fetchImpl: async () => responseWith({ issues: [issue] }) });
    await assert.rejects(review(input), (error) => ['PRODUCT_DOCUMENT_REVIEW_MODEL_INVALID_REFERENCE', 'PRODUCT_DOCUMENT_REVIEW_MODEL_INVALID_OUTPUT'].includes(error.code));
  }
});

test('product document review model rejects non-JSON output', async () => {
  const review = createProductDocumentReviewModel({
    env: configuredEnv(),
    fetchImpl: async () => ({ ok: true, async json() { return { choices: [{ message: { content: '```json\n{"issues":[]}\n```' } }] }; } }),
  });

  await assert.rejects(review(input), { code: 'PRODUCT_DOCUMENT_REVIEW_MODEL_INVALID_JSON' });
});

test('product document review model is unavailable unless explicitly enabled and configured', async () => {
  for (const env of [{ DEEPSEEK_API_KEY: 'test-key' }, { PRODUCT_DOCUMENT_REVIEW_MODEL_ENABLED: 'true' }]) {
    const review = createProductDocumentReviewModel({ env, fetchImpl: async () => { throw new Error('must not call'); } });
    await assert.rejects(review(input), { code: 'PRODUCT_DOCUMENT_REVIEW_MODEL_UNAVAILABLE' });
  }
});

