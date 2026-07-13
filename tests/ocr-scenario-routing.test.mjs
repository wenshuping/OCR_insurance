import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getOcrScenarioRoutingConfig,
  normalizeOcrScenarioRoutingConfig,
  resolveOcrProviderForScenario,
} from '../server/ocr-scenario-routing.service.mjs';
import {
  recognizeGlmOcrUpload,
  recognizePaddleOcrVl16Upload,
  recognizeUnlimitedOcrUpload,
} from '../ocr-service/insurance-ocr.service.mjs';

test('OCR scenario routing keeps independent model choices per business scene', () => {
  const state = {
    ocrScenarioRouting: normalizeOcrScenarioRoutingConfig({
      routes: {
        policy_entry: 'deepseek_ocr_vllm',
        insurance_material: 'unlimited_ocr_vllm',
        cash_value: 'paddle_local',
      },
    }),
  };

  assert.equal(resolveOcrProviderForScenario(state, 'policy_entry'), 'deepseek_ocr_vllm');
  assert.equal(resolveOcrProviderForScenario(state, 'insurance_material'), 'unlimited_ocr_vllm');
  assert.equal(resolveOcrProviderForScenario(state, 'cash_value'), 'paddle_local');
  assert.equal(resolveOcrProviderForScenario(state, 'unknown'), '');
  assert.deepEqual(getOcrScenarioRoutingConfig(state).routes, state.ocrScenarioRouting.routes);
});

test('Unlimited-OCR request uses the required vLLM decoding recipe', async () => {
  let requestUrl = '';
  let requestBody = null;
  const result = await recognizeUnlimitedOcrUpload(
    { name: 'policy.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    {
      env: {
        POLICY_OCR_UNLIMITED_OCR_BASE_URL: 'http://127.0.0.1:6009',
        POLICY_OCR_UNLIMITED_OCR_MODEL: 'baidu/Unlimited-OCR',
      },
      fetchImpl: async (url, options) => {
        requestUrl = String(url);
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          choices: [{ message: { content: '保险公司：新华保险\n产品名称：终身寿险' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  );

  assert.equal(requestUrl, 'http://127.0.0.1:6009/v1/chat/completions');
  assert.equal(requestBody.model, 'baidu/Unlimited-OCR');
  assert.equal(requestBody.messages[0].content[0].text, '<image>document parsing.');
  assert.equal(requestBody.skip_special_tokens, false);
  assert.deepEqual(requestBody.vllm_xargs, { ngram_size: 35, window_size: 128 });
  assert.match(result.ocrText, /新华保险/);
});

test('GLM-OCR request uses its supported recognition prompt and image order', async () => {
  let requestBody = null;
  const result = await recognizeGlmOcrUpload(
    { name: 'policy.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    {
      env: {
        POLICY_OCR_GLM_OCR_BASE_URL: 'http://127.0.0.1:6010',
        POLICY_OCR_GLM_OCR_MODEL: 'glm-ocr',
      },
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          choices: [{ message: { content: '保险公司：新华保险\n产品名称：终身寿险' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  );

  assert.equal(requestBody.model, 'glm-ocr');
  assert.equal(requestBody.messages[0].content[0].type, 'image_url');
  assert.equal(requestBody.messages[0].content[1].text, 'Text Recognition:');
  assert.match(result.ocrText, /新华保险/);
});

test('PaddleOCR-VL-1.6 request targets the local AutoDL service', async () => {
  let requestBody = null;
  const result = await recognizePaddleOcrVl16Upload(
    { name: 'policy.png', type: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    {
      env: {
        POLICY_OCR_PADDLEOCR_VL16_BASE_URL: 'http://127.0.0.1:6011',
        POLICY_OCR_PADDLEOCR_VL16_MODEL: 'PaddleOCR-VL-1.6',
      },
      fetchImpl: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return new Response(JSON.stringify({
          paddle_blocks: [
            { text: '投保人：张三', box: [10, 20, 180, 50], confidence: 0.98, label: 'text', order: 1 },
          ],
          choices: [{ message: { content: '保险公司：中国人寿\n产品名称：养老年金保险' } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  );

  assert.equal(requestBody.model, 'PaddleOCR-VL-1.6');
  assert.equal(requestBody.messages[0].content[0].type, 'image_url');
  assert.equal(requestBody.messages[0].content[1].text, 'OCR:');
  assert.match(result.ocrText, /中国人寿/);
  assert.deepEqual(result.boxes, [
    { text: '投保人：张三', box: [10, 20, 180, 50], confidence: 0.98, label: 'text', order: 1 },
  ]);
});
