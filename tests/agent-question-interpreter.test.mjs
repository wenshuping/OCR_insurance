import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeepSeekAgentQuestionInterpreter } from '../server/agent-question-interpreter.service.mjs';

test('DeepSeek question interpreter uses recent conversation and returns only the controlled candidate', async () => {
  let requestBody;
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test', DEEPSEEK_MODEL: 'test-model' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: '{"intent":"family_summary","familyName":"余贵祥家庭","confidence":0.98,"userId":7}' } }] }; } };
    },
  });

  const candidate = await interpret({
    question: '为啥0份有效',
    history: [{ role: 'user', content: '余贵祥家庭有几个保单' }, { role: 'assistant', content: '共有2份，其中0份有效。' }],
  });

  assert.deepEqual(candidate, {
    intent: 'family_summary', question: '为啥0份有效', confidence: 0.98, requestedOperation: 'read', entities: { familyName: '余贵祥家庭' },
  });
  assert.equal(requestBody.model, 'test-model');
  assert.match(JSON.stringify(requestBody.messages), /余贵祥家庭有几个保单/u);
  assert.equal(JSON.stringify(candidate).includes('userId'), false);
});

test('DeepSeek question interpreter restores a product name for a product follow-up', async () => {
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: '{"intent":"insurance_product_knowledge","productName":"尊享人生年金保险（分红型）","confidence":0.99}' } }] };
      },
    }),
  });

  const candidate = await interpret({
    question: '这个产品有啥优势呀',
    history: [
      { role: 'user', content: '新华保险 尊享人生的产品保险责任啥啊' },
      { role: 'assistant', content: '新华保险《尊享人生年金保险（分红型）》提供关爱年金和生存保险金。' },
    ],
  });

  assert.deepEqual(candidate.entities, { productName: '尊享人生年金保险（分红型）' });
});

test('DeepSeek question interpreter honors the configured fallback history limit', async () => {
  let requestBody;
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: '{"intent":"chat","confidence":1}' } }] }; } };
    },
  });
  await interpret({
    question: '继续',
    recentMessageLimit: 2,
    history: [
      { role: 'user', content: '丢弃一' },
      { role: 'assistant', content: '丢弃二' },
      { role: 'user', content: '保留一' },
      { role: 'assistant', content: '保留二' },
    ],
  });
  const serialized = JSON.stringify(requestBody.messages);
  assert.doesNotMatch(serialized, /丢弃/u);
  assert.match(serialized, /保留一/u);
  assert.match(serialized, /保留二/u);
});
