import assert from 'node:assert/strict';
import test from 'node:test';

import { enrichPptxWithPaddleVisual } from '../server/product-slide-visual-ingestion.service.mjs';

test('PPT pipeline runs PaddleOCR-VL before DeepSeek and preserves both evidence sources', async () => {
  const calls = [];
  const result = await enrichPptxWithPaddleVisual({
    document: { id: 'pdoc-test' },
    parsed: {
      parser: 'officeparser',
      pages: [{ pageNo: 1, rawText: '原生标题\n计划一 1万元', tables: [], layout: {} }],
    },
    renderPages: async () => [Buffer.from('slide-image')],
    parsePage: async (input) => {
      calls.push(`paddle:${input.pageNo}`);
      return {
        provider: 'paddleocr_vl16_autodl',
        model: 'PaddleOCR-VL-1.6',
        promptVersion: 'product-ppt-paddle-vl16-v1',
        ocrText: '视觉标题\n计划一 1万元',
        markdown: '# 视觉标题',
        boxes: [{ text: '视觉标题', box: [0, 0, 100, 20], confidence: 0.98 }],
        tables: [],
      };
    },
    reconstructPage: async (input) => {
      calls.push(`deepseek:${input.pageNo}`);
      assert.match(input.nativeText, /原生标题/u);
      assert.match(input.paddleOcrText, /视觉标题/u);
      return { model: 'deepseek-v4-flash', canonicalMarkdown: '# 原生标题\n\n视觉标题\n\n计划一 1万元', tables: [], issues: [] };
    },
  });

  assert.deepEqual(calls, ['paddle:1', 'deepseek:1']);
  assert.equal(result.parser, 'officeparser+paddleocr-vl16');
  assert.match(result.pages[0].rawText, /原生标题/u);
  assert.match(result.pages[0].rawText, /视觉标题/u);
  assert.equal(result.pages[0].layout.visualExtraction.provider, 'paddleocr_vl16_autodl');
  assert.equal(result.pages[0].layout.semanticReconstruction.model, 'deepseek-v4-flash');
});

test('PPT pipeline fails closed when DeepSeek reconstruction is unavailable', async () => {
  await assert.rejects(
    enrichPptxWithPaddleVisual({
      document: { id: 'pdoc-test' },
      parsed: { pages: [{ pageNo: 1, rawText: '产品介绍', tables: [], layout: {} }] },
      renderPages: async () => [Buffer.from('slide-image')],
      parsePage: async () => ({ ocrText: '产品介绍' }),
    }),
    (error) => error.code === 'PRODUCT_PPT_PIPELINE_UNAVAILABLE',
  );
});
