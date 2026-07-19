import assert from 'node:assert/strict';
import test from 'node:test';

import { assessProductChunksQuality } from '../server/product-chunk-quality.service.mjs';
import { assessProductDocumentQuality, assessProductPublishReadiness } from '../server/product-document-quality.service.mjs';

test('document quality allows ordinary product material without requiring terms-only fields', () => {
  const quality = assessProductDocumentQuality({
    document: { sourceAuthority: 'company_material' },
    parsed: {
      documentType: 'product_intro',
      pages: [{ pageNo: 1, rawText: '康宁保产品介绍，等待期为90天。' }],
      warnings: [],
    },
  });

  assert.equal(quality.decision, 'pass');
  assert.equal(quality.blockingReasons.length, 0);
});

test('document quality requests review for suspected personal data instead of rejecting useful material', () => {
  const quality = assessProductDocumentQuality({
    document: { sourceAuthority: 'company_material' },
    parsed: {
      documentType: 'product_intro',
      pages: [{ pageNo: 1, rawText: '联系电话：13800138000，产品等待期为90天。' }],
      warnings: [],
    },
  });

  assert.equal(quality.decision, 'review_required');
  assert.ok(quality.warnings.some((item) => item.code === 'personal_data'));
});

test('document quality blocks text with severe parser corruption', () => {
  const quality = assessProductDocumentQuality({
    document: { sourceAuthority: 'insurer_official' },
    parsed: {
      documentType: 'terms',
      pages: [{ pageNo: 1, rawText: '\uFFFD\uFFFD\uFFFD保险\uFFFD\uFFFD' }],
      warnings: [],
    },
  });

  assert.equal(quality.decision, 'reprocess_required');
  assert.ok(quality.blockingReasons.some((item) => item.code === 'text_integrity'));
});

test('document quality blocks a PPTX page with visibly incomplete comparison extraction', () => {
  const quality = assessProductDocumentQuality({
    document: { sourceAuthority: 'company_material' },
    parsed: {
      documentType: 'training_deck',
      pages: [{
        pageNo: 17,
        rawText: '三档保障计划的3点区别',
        layout: { extraction: { incomplete: true, needsVisualOcr: true } },
      }],
      warnings: [],
    },
  });

  assert.equal(quality.decision, 'reprocess_required');
  assert.deepEqual(quality.blockingReasons.find((item) => item.code === 'page_extraction_incomplete')?.pageNumbers, [17]);
});

test('chunk quality blocks only unusable chunks and keeps valid siblings ready', () => {
  const quality = assessProductChunksQuality([
    {
      id: 'valid',
      chunkType: 'child',
      pageStart: 1,
      pageEnd: 1,
      content: '被保险人符合约定条件时，保险公司给付重大疾病保险金。',
      tokenCount: 26,
      contentHash: 'hash-valid',
      indexStatus: 'ready',
      payload: {},
    },
    {
      id: 'bad-table',
      chunkType: 'table',
      pageStart: 2,
      pageEnd: 2,
      content: '100 | 200 | 300',
      tokenCount: 3,
      contentHash: 'hash-table',
      indexStatus: 'ready',
      payload: {},
    },
  ]);

  assert.equal(quality.chunks[0].indexStatus, 'ready');
  assert.equal(quality.chunks[1].indexStatus, 'blocked');
  assert.equal(quality.blockedChunkCount, 1);
});

test('chunk quality blocks later duplicate without discarding the first copy', () => {
  const base = {
    chunkType: 'child',
    pageStart: 1,
    pageEnd: 1,
    content: '等待期为九十日，具体约定以保险条款为准。',
    tokenCount: 20,
    contentHash: 'same-hash',
    indexStatus: 'ready',
    payload: {},
  };
  const quality = assessProductChunksQuality([
    { ...base, id: 'first' },
    { ...base, id: 'second', pageStart: 2, pageEnd: 2 },
  ]);

  assert.equal(quality.chunks[0].indexStatus, 'ready');
  assert.equal(quality.chunks[1].indexStatus, 'blocked');
});

test('chunk quality enforces aggregated evidence confidence decisions', () => {
  const base = {
    chunkType: 'child', pageStart: 1, pageEnd: 1, content: '给付比例为60%。',
    tokenCount: 8, contentHash: 'confidence-hash', indexStatus: 'ready',
  };
  const quality = assessProductChunksQuality([
    { ...base, id: 'critical', payload: { confidence: { decision: 'blocked' } } },
    { ...base, id: 'review', contentHash: 'confidence-review', payload: { confidence: { decision: 'review_required' } } },
  ]);

  assert.equal(quality.chunks[0].indexStatus, 'blocked');
  assert.ok(quality.chunks[0].payload.quality.checks.some((item) => item.code === 'low_critical_fact_confidence'));
  assert.equal(quality.chunks[1].indexStatus, 'ready');
  assert.equal(quality.chunks[1].payload.quality.decision, 'review_required');
  assert.equal(quality.qualityRuleVersion, 'product-chunk-quality-v2');
});

test('publish readiness requires a bound usable chunk and isolates unbound siblings', () => {
  const base = {
    chunkType: 'child', indexStatus: 'ready', pageStart: 1, pageEnd: 1,
    canonicalProductId: 'product-1', productVersionId: '',
  };
  const ready = assessProductPublishReadiness({
    document: { payload: {} },
    links: [{ canonicalProductId: 'product-1', pageStart: 1, pageEnd: 1 }],
    chunks: [base],
  });
  assert.equal(ready.decision, 'pass');

  const unbound = assessProductPublishReadiness({
    document: { payload: {} },
    links: [{ canonicalProductId: '', pageStart: 1, pageEnd: 1 }],
    chunks: [{ ...base, canonicalProductId: '' }],
  });
  assert.equal(unbound.decision, 'blocked');
  assert.ok(unbound.blockingReasons.some((item) => item.code === 'product_binding_missing'));

  const partiallyBound = assessProductPublishReadiness({
    document: { payload: {} },
    links: [{ canonicalProductId: 'product-1', pageStart: 1, pageEnd: 1 }],
    chunks: [base, { ...base, pageStart: 2, pageEnd: 2, canonicalProductId: '' }],
  });
  assert.equal(partiallyBound.decision, 'pass');
  assert.equal(partiallyBound.publishableChunkCount, 1);
  assert.equal(partiallyBound.isolatedChunkCount, 1);
  assert.ok(partiallyBound.checks.some((item) => item.code === 'chunk_product_binding_missing' && item.status === 'warning'));

  const ambiguous = assessProductPublishReadiness({
    document: { payload: {} },
    links: [
      { canonicalProductId: 'product-1', pageStart: 1, pageEnd: 1 },
      { canonicalProductId: 'product-2', pageStart: 1, pageEnd: 1 },
    ],
    chunks: [base],
  });
  assert.equal(ambiguous.decision, 'blocked');
  assert.ok(ambiguous.blockingReasons.some((item) => item.code === 'product_boundary_ambiguous'));

  const unresolvedVersion = assessProductPublishReadiness({
    document: { payload: { versionLabel: '2026版' } },
    links: [{ canonicalProductId: 'product-1', pageStart: 1, pageEnd: 1 }],
    chunks: [base],
  });
  assert.equal(unresolvedVersion.decision, 'blocked');
  assert.ok(unresolvedVersion.blockingReasons.some((item) => item.code === 'product_version_resolution_missing'));

  const boundVersion = assessProductPublishReadiness({
    document: { payload: { versionLabel: '2026版', productVersionId: 'version-2026' } },
    links: [{ canonicalProductId: 'product-1', pageStart: 1, pageEnd: 1 }],
    chunks: [{ ...base, productVersionId: 'version-2026' }],
  });
  assert.equal(boundVersion.decision, 'pass');

  const awaitingCorrectionConfirmation = assessProductPublishReadiness({
    document: { payload: {
      candidateIndexVersion: 'candidate-v2',
      pageReviews: { 'candidate-v2:1': { pageNo: 1, indexVersion: 'candidate-v2', status: 'pending_confirmation' } },
    } },
    links: [{ canonicalProductId: 'product-1', pageStart: 1, pageEnd: 1 }],
    chunks: [base],
  });
  assert.equal(awaitingCorrectionConfirmation.decision, 'blocked');
  assert.ok(awaitingCorrectionConfirmation.blockingReasons.some((item) => item.code === 'page_correction_unconfirmed'));
});
