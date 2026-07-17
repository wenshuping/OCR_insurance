import assert from 'node:assert/strict';
import test from 'node:test';

import { generateFamilySalesChatReply } from '../server/family-sales-chat.service.mjs';
import { buildFamilySalesReviewInput } from '../server/family-sales-review.service.mjs';

test('family sales chat sanitizes new salesperson messages before every DeepSeek request', async () => {
  const familyInput = buildFamilySalesReviewInput({
    family: { id: 1, coreMemberId: 10, status: 'active' },
    members: [{ id: 10, name: '王小明', relationLabel: '本人', relationToCore: 'self', role: 'core', status: 'active' }],
  });
  const requestBodies = [];
  const reply = await generateFamilySalesChatReply({
    context: { familyInput },
    history: [{ role: 'user', content: '王小明之前住址：浙江省杭州市西湖区文三路88号。', createdAt: '2026-07-11T00:00:00.000Z' }],
    question: '王小明手机号13812345678，38岁，甲状腺结节3级，预算2万元，怎么沟通？',
    env: { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_BASE_URL: 'https://deepseek.test' },
    fetchImpl: async (_url, options = {}) => {
      const body = JSON.parse(options.body);
      requestBodies.push(body);
      return {
        ok: true,
        json: async () => ({
          model: body.max_tokens === 300 ? 'deepseek-v4-flash' : 'deepseek-v4-pro',
          choices: [{ message: { content: body.max_tokens === 300
            ? JSON.stringify({ intent: 'general', skills: [], reason: '一般咨询' })
            : '建议先确认预算和核保资料。' } }],
        }),
      };
    },
  });

  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    const payload = JSON.stringify(body);
    assert.doesNotMatch(payload, /王小明|13812345678|文三路88号/u);
  }
  const mainPayload = JSON.stringify(requestBodies[1]);
  assert.match(mainPayload, /38岁/u);
  assert.match(mainPayload, /甲状腺结节3级/u);
  assert.match(mainPayload, /预算2万元/u);
  assert.match(mainPayload, /浙江省杭州市西湖区/u);
  assert.match(reply.content, /确认预算/u);
});
