import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aggregateChunkEvidenceConfidence,
  aggregatePageEvidenceConfidence,
  aggregateProductEvidenceConfidence,
} from '../server/product-evidence-confidence.service.mjs';

test('confidence aggregation uses evidence length and source regions', () => {
  const pages = [{
    pageNo: 1,
    layout: { sourceType: 'ocr', elements: [
      { id: 'short', text: '保障', ocrConfidence: 0.8 },
      { id: 'long', text: '这是较长的普通正文内容', ocrConfidence: 1 },
    ] },
  }];
  const chunk = { payload: { sourceRegions: [{ pageNo: 1, elementIds: ['short', 'long'] }] } };

  const page = aggregatePageEvidenceConfidence(pages[0]);
  const result = aggregateChunkEvidenceConfidence(chunk, pages);

  assert.equal(page.source, 'ocr');
  assert.equal(result.minimum, 0.8);
  assert.equal(result.average, 0.9);
  assert.equal(result.weighted > result.average, true);
  assert.equal(result.decision, 'pass');
});

test('low-confidence critical facts block while missing non-native confidence requires review', () => {
  const pages = [
    { pageNo: 1, layout: { sourceType: 'handwriting', elements: [{ id: 'ratio', text: '给付比例为60%', confidence: 0.82 }] } },
    { pageNo: 2, layout: { sourceType: 'transcription', elements: [{ id: 'speech', text: '等待期以合同约定为准' }] } },
  ];
  const result = aggregateProductEvidenceConfidence({
    pages,
    chunks: [
      { id: 'ratio-chunk', payload: { sourceRegions: [{ pageNo: 1, elementIds: ['ratio'] }] } },
      { id: 'speech-chunk', payload: { sourceRegions: [{ pageNo: 2, elementIds: ['speech'] }] } },
    ],
  });

  assert.equal(result.pages[0].evidenceConfidence.source, 'handwriting_ocr');
  assert.equal(result.chunks[0].payload.confidence.criticalFactMinimum, 0.82);
  assert.equal(result.chunks[0].payload.confidence.decision, 'blocked');
  assert.equal(result.chunks[1].payload.confidence.source, 'transcription');
  assert.equal(result.chunks[1].payload.confidence.decision, 'review_required');
  assert.deepEqual(result.chunks[1].payload.confidence.reasons, ['missing_non_native_confidence']);
});

test('native text without model confidence passes with an explicit source', () => {
  const result = aggregatePageEvidenceConfidence({
    pageNo: 1,
    layout: { sourceType: 'native_text', elements: [{ id: 'native', text: '保险责任' }] },
  });

  assert.equal(result.source, 'native_text');
  assert.equal(result.minimum, null);
  assert.equal(result.decision, 'pass');
});

test('page-level OCR confidence gates derived critical evidence', () => {
  const result = aggregatePageEvidenceConfidence({
    pageNo: 1,
    ocrConfidence: 0.8,
    layout: { elements: [{ id: 'derived', text: '等待期为90天。', source: 'derived_line' }] },
  });

  assert.equal(result.source, 'ocr');
  assert.equal(result.criticalFactMinimum, 0.8);
  assert.equal(result.decision, 'blocked');
});
