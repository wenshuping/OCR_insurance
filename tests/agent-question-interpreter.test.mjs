import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeepSeekAgentQuestionInterpreter } from '../server/agent-question-interpreter.service.mjs';

function semantic(overrides = {}) {
  return JSON.stringify({
    semanticContractVersion: 1,
    intent: 'chat',
    operation: 'read',
    queryAspects: [],
    mentions: [],
    references: [],
    requestedSteps: [],
    confidence: { intent: 1, mentions: 1, references: 1 },
    ...overrides,
  });
}

test('DeepSeek question interpreter uses recent conversation and returns a controlled semantic proposal', async () => {
  let requestBody;
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test', DEEPSEEK_MODEL: 'test-model' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: semantic({
        intent: 'family_summary',
        queryAspects: ['family_overview'],
        references: [{ type: 'current_family', rawText: '为啥0份有效' }],
        requestedSteps: ['lookup'],
        confidence: { intent: 0.98, mentions: 1, references: 0.98 },
        userId: 7,
      }) } }] }; } };
    },
  });

  const proposal = await interpret({
    question: '为啥0份有效',
    history: [{ role: 'user', content: '余贵祥家庭有几个保单' }, { role: 'assistant', content: '共有2份，其中0份有效。' }],
  });

  assert.deepEqual(proposal, {
    semanticContractVersion: 1,
    intent: 'family_summary',
    operation: 'read',
    queryAspects: ['family_overview'],
    mentions: [],
    references: [{ type: 'current_family', rawText: '为啥0份有效' }],
    requestedSteps: ['lookup'],
    confidence: { intent: 0.98, mentions: 1, references: 0.98 },
  });
  assert.equal(requestBody.model, 'test-model');
  assert.equal(requestBody.max_tokens, 2_000);
  assert.match(JSON.stringify(requestBody.messages), /余贵祥家庭有几个保单/u);
  assert.equal(JSON.stringify(proposal).includes('userId'), false);
});

test('DeepSeek question interpreter keeps a product follow-up as a current-product reference', async () => {
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: semantic({
          intent: 'coverage_report',
          queryAspects: ['product_advantages'],
          references: [{ type: 'current_product', rawText: '这个产品' }],
          requestedSteps: ['lookup'],
        }) } }] };
      },
    }),
  });

  const proposal = await interpret({
    question: '这个产品有啥优势呀',
    history: [
      { role: 'user', content: '新华保险 尊享人生的产品保险责任啥啊' },
      { role: 'assistant', content: '新华保险《尊享人生年金保险（分红型）》提供关爱年金和生存保险金。' },
    ],
  });

  assert.deepEqual(proposal.references, [{ type: 'current_product', rawText: '这个产品' }]);
  assert.deepEqual(proposal.mentions, []);
  assert.equal(proposal.intent, 'insurance_product_knowledge');
  assert.deepEqual(proposal.queryAspects, ['product_advantages']);
});

test('DeepSeek question interpreter corrects a product responsibility query mislabeled as a family coverage report', async () => {
  const question = '荣耀鑫享赢家版保险责任';
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: semantic({
          intent: 'coverage_report',
          queryAspects: ['main_responsibilities'],
          mentions: [{ type: 'product', rawText: '荣耀鑫享赢家版' }],
          requestedSteps: ['lookup'],
          confidence: { intent: 0.95, mentions: 0.98, references: 0.95 },
        }) } }] };
      },
    }),
  });

  const proposal = await interpret({ question, history: [] });

  assert.equal(proposal.intent, 'insurance_product_knowledge');
  assert.deepEqual(proposal.mentions, [{ type: 'product', rawText: '荣耀鑫享赢家版' }]);
});

test('DeepSeek question interpreter represents an omitted comparison side without inventing a product', async () => {
  const question = '和 荣耀鑫享赢家版对比呢';
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { choices: [{ message: { content: semantic({
          intent: 'insurance_product_knowledge',
          queryAspects: ['comparison'],
          mentions: [{ type: 'product', rawText: '荣耀鑫享赢家版' }],
          references: [{ type: 'current_product', rawText: '' }],
          requestedSteps: ['compare'],
        }) } }] };
      },
    }),
  });

  const proposal = await interpret({ question, history: [] });

  assert.deepEqual(proposal.mentions, [{ type: 'product', rawText: '荣耀鑫享赢家版' }]);
  assert.deepEqual(proposal.references, [{ type: 'current_product', rawText: '' }]);
  assert.equal(proposal.intent, 'insurance_product_knowledge');
});

test('DeepSeek question interpreter honors the configured fallback history limit', async () => {
  let requestBody;
  const interpret = createDeepSeekAgentQuestionInterpreter({
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://model.test' },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { choices: [{ message: { content: semantic() } }] }; } };
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
