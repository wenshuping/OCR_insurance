import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createProductKnowledgeStore } from '../server/product-knowledge-store.mjs';
import { evaluateProductRagBaseline } from '../server/product-rag-evaluation.service.mjs';
import { createProductRagService } from '../server/product-rag.service.mjs';

function evidence(chunkId, productVersionId) {
  return {
    chunkId,
    matchedChunkId: chunkId,
    productVersionId,
    citation: { documentId: 'document-1', chunkId, pageStart: 1 },
  };
}

test('golden evaluation rejects wrong-version or uncited evidence', async () => {
  const cases = [
    {
      id: 'waiting-period-current',
      question: '安心医疗保险2026版等待期多久？',
      canonicalProductId: 'product-1',
      productVersionId: 'version-2026',
      requiredChunkIds: ['current-waiting-period'],
      forbiddenChunkIds: ['old-waiting-period'],
    },
    {
      id: 'coverage-current',
      question: '安心医疗保险2026版承担哪些保险责任？',
      canonicalProductId: 'product-1',
      productVersionId: 'version-2026',
      requiredChunkIds: ['current-coverage'],
      forbiddenChunkIds: ['old-coverage'],
    },
  ];
  const seenInputs = [];
  const report = await evaluateProductRagBaseline({
    cases,
    retrieve(input) {
      seenInputs.push(input);
      const chunkId = input.query.includes('等待期') ? 'current-waiting-period' : 'current-coverage';
      return { evidenceChunks: [evidence(chunkId, input.productVersionId)] };
    },
  });

  assert.equal(report.metrics.casePassRate, 1);
  assert.equal(report.metrics.requiredEvidenceRecall, 1);
  assert.equal(report.metrics.wrongVersionEvidenceCount, 0);
  assert.equal(report.metrics.forbiddenEvidenceCount, 0);
  assert.equal(report.metrics.citationCompleteness, 1);
  assert.equal(seenInputs.every((input) => input.productVersionId === 'version-2026'), true);

  const polluted = await evaluateProductRagBaseline({
    cases: [cases[0]],
    retrieve() {
      return { evidenceChunks: [evidence('old-waiting-period', 'version-2022')] };
    },
  });
  assert.equal(polluted.metrics.casePassRate, 0);
  assert.equal(polluted.metrics.wrongVersionEvidenceCount, 1);
  assert.equal(polluted.metrics.forbiddenEvidenceCount, 1);
});

test('current BM25 retrieval passes a strict product-version golden case', async () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductKnowledgeStore(db);
  try {
    const upload = store.createDocumentUpload({
      tenantId: 'default', contentHash: 'bm25-golden', fileName: '安心医疗条款.txt',
      bytes: Buffer.from('source'), sourceAuthority: 'insurer_official',
    });
    store.replaceParsedArtifacts({
      tenantId: 'default', documentId: upload.document.id, documentType: 'terms',
      pages: [{ pageNo: 1, rawText: '等待期', tables: [], headings: [], sourceLabel: '第 1 页' }],
      chunks: [
        {
          id: 'current', canonicalProductId: 'product-1', productVersionId: 'version-2026',
          chunkType: 'child', pageStart: 1, pageEnd: 1, content: '疾病等待期为90天。',
          contentHash: 'current-hash', sourceAuthority: 'insurer_official', indexStatus: 'ready',
        },
        {
          id: 'old', canonicalProductId: 'product-1', productVersionId: 'version-2022',
          chunkType: 'child', pageStart: 1, pageEnd: 1, content: '疾病等待期为180天。',
          contentHash: 'old-hash', sourceAuthority: 'insurer_official', indexStatus: 'ready',
        },
      ],
      facts: [],
    });
    store.reviewDocument({ tenantId: 'default', documentId: upload.document.id, action: 'publish' });
    const storedChunks = store.listDocumentChunks({ tenantId: 'default', documentId: upload.document.id });
    const current = storedChunks.find((chunk) => chunk.productVersionId === 'version-2026');
    const old = storedChunks.find((chunk) => chunk.productVersionId === 'version-2022');
    const rag = createProductRagService({ store });
    const report = await evaluateProductRagBaseline({
      cases: [{
        id: 'bm25-current-waiting-period', question: '等待期多久',
        canonicalProductId: 'product-1', productVersionId: 'version-2026',
        requiredChunkIds: [current.id], forbiddenChunkIds: [old.id],
      }],
      retrieve: (input) => rag.retrieve(input),
    });

    assert.equal(report.metrics.casePassRate, 1);
    assert.equal(report.metrics.requiredEvidenceRecall, 1);
    assert.equal(report.metrics.wrongVersionEvidenceCount, 0);
    assert.equal(report.metrics.citationCompleteness, 1);
  } finally {
    db.close();
  }
});
