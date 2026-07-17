import assert from 'node:assert/strict';
import test from 'node:test';

import { annotateProductChunks } from '../server/product-chunk-semantics.service.mjs';

function chunk(id, content, payload = {}) {
  return {
    id, documentId: 'doc-1', parentChunkId: 'parent-1', chunkType: 'child',
    content, headingPath: [], pageStart: 1, pageEnd: 1, payload,
  };
}

test('semantic annotation independently labels contract facts and training claims', () => {
  const terms = annotateProductChunks({
    document: { documentType: 'terms', sourceAuthority: 'insurer_official' },
    chunks: [chunk('fact-1', '计划一年度免赔额为1万元，给付比例为100%。')],
  });
  assert.equal(terms[0].payload.semantic.evidenceKind, 'fact');
  assert.equal(terms[0].payload.semantic.contractual, true);
  assert.deepEqual(terms[0].payload.semantic.factKeys, ['annual_deductible', 'reimbursement_ratio']);
  assert.deepEqual(terms[0].payload.semantic.planNames, ['计划一']);

  const training = annotateProductChunks({
    document: { documentType: 'training_deck', sourceAuthority: 'company_material' },
    chunks: [chunk('claim-1', '适合人群：关注医疗品质的客户。', { businessTopics: ['target_audience'] })],
  });
  assert.equal(training[0].payload.semantic.evidenceKind, 'claim');
  assert.equal(training[0].payload.semantic.contractual, false);
  assert.equal(training[0].payload.semantic.nonContractual, true);
});

test('semantic annotation links only the adjacent required limitation context', () => {
  const chunks = annotateProductChunks({
    document: { documentType: 'terms', sourceAuthority: 'insurer_official' },
    chunks: [
      chunk('coverage-1', '一般医疗费用保险金年度限额200万元。', { sequence: 0 }),
      chunk('limit-1', '但未经基本医疗保险结算的，赔付比例为60%。', { sequence: 1 }),
      chunk('other-1', '本合同其他约定。', { sequence: 2 }),
    ],
  });
  assert.deepEqual(chunks[0].payload.semantic.requiredContextChunkIds, ['limit-1']);
  assert.deepEqual(chunks[1].payload.semantic.requiredContextChunkIds, []);
});
