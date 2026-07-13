import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductRagService } from '../server/product-rag.service.mjs';

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
