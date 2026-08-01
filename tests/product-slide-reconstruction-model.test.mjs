import assert from 'node:assert/strict';
import test from 'node:test';

import { createProductSlideReconstructionModel } from '../server/product-slide-reconstruction-model.service.mjs';

function response(content) {
  return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) };
}

test('DeepSeek reconstructs a PPT page from native and PaddleOCR-VL evidence', async () => {
  let requestBody;
  const reconstruct = createProductSlideReconstructionModel({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test/v1', DEEPSEEK_MODEL: 'deepseek-test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response({
        canonicalMarkdown: '# 三档保障计划\n\n|保障项目|计划一|计划二|\n|---|---|---|\n|年度免赔额|1万元|2万元|',
        tables: [{ headers: ['保障项目', '计划一', '计划二'], rows: [['年度免赔额', '1万元', '2万元']] }],
        issues: [],
      });
    },
  });

  const result = await reconstruct({
    pageNo: 17,
    nativeText: '三档保障计划 年度免赔额 计划一 1万元 计划二 2万元',
    paddleOcrText: '三档保障计划\n年度免赔额\n计划一 1万元\n计划二 2万元',
    paddleMarkdown: '|保障项目|计划一|计划二|',
    paddleTables: [{ headers: ['保障项目', '计划一', '计划二'], rows: [['年度免赔额', '1万元', '2万元']] }],
  });

  assert.equal(requestBody.model, 'deepseek-test');
  assert.match(requestBody.messages[0].content, /PaddleOCR-VL 1.6/u);
  assert.match(requestBody.messages[1].content, /paddleOcrText/u);
  assert.equal(result.tables[0].rows[0][2], '2万元');
});

test('DeepSeek reconstruction rejects critical values absent from source evidence', async () => {
  const reconstruct = createProductSlideReconstructionModel({
    env: { DEEPSEEK_API_KEY: 'test-key' },
    fetchImpl: async () => response({ canonicalMarkdown: '年度免赔额为5万元', tables: [], issues: [] }),
  });

  await assert.rejects(
    reconstruct({ pageNo: 1, nativeText: '年度免赔额为1万元', paddleOcrText: '年度免赔额为1万元' }),
    (error) => error.code === 'PRODUCT_PPT_DEEPSEEK_UNSUPPORTED_FACT',
  );
});
