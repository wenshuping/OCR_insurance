import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentDomainToolGateway } from '../server/agent-domain-tool-gateway.service.mjs';

function claims(overrides = {}) {
  return {
    tenant: 'default', channel: 'dingtalk', channelUserId: 'ding-a', channelMobile: '13800138000',
    internalUserId: 7, conversationId: 'conversation-a', messageRef: 'message-a', callCount: 1,
    ...overrides,
  };
}

test('domain gateway turns an explicit Hermes operation into a trusted domain request', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    questionRouter: { async route(input) {
      routed.push(input);
      return {
        decision: 'execute',
        interaction: { type: 'answer', text: '已核验。' },
        semanticContext: { resolvedEntities: { products: [
          { canonicalProductId: 'product-a', company: '甲公司', officialName: '甲产品' },
          { canonicalProductId: 'product-b', company: '乙公司', officialName: '乙产品' },
        ] } },
      };
    } },
  });
  const result = await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '比较甲产品和乙产品', operation: 'product_knowledge', names: ['甲产品', '乙产品'],
      queryAspects: ['comparison'],
    },
    claims: claims(),
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.interaction.delivery, 'verbatim');
  assert.deepEqual(result.resolvedEntities.products, [
    { canonicalProductId: 'product-a', company: '甲公司', officialName: '甲产品' },
    { canonicalProductId: 'product-b', company: '乙公司', officialName: '乙产品' },
  ]);
  assert.deepEqual(routed[0], {
    internalUserId: 7,
    messageRef: 'message-a:tool:1',
    conversationId: 'conversation-a',
    question: '比较甲产品和乙产品',
    runtime: 'hermes',
    proposal: {
      semanticContractVersion: 1,
      intent: 'insurance_product_knowledge', operation: 'read', queryAspects: ['comparison'],
      mentions: [{ type: 'product', rawText: '甲产品' }, { type: 'product', rawText: '乙产品' }],
      references: [], requestedSteps: ['compare'],
      confidence: { intent: 1, mentions: 1, references: 1 },
    },
  });
});

test('domain gateway rechecks the current account before every tool execution', async () => {
  let routeCalls = 0;
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 8 }; },
    questionRouter: { async route() { routeCalls += 1; } },
  });
  const result = await gateway.execute({
    tool: 'ask_sales_champion',
    input: { question: '怎么沟通', operation: 'sales_coaching', names: ['张先生家庭'] },
    claims: claims(),
  });
  assert.equal(result.status, 'forbidden');
  assert.equal(routeCalls, 0);
});

test('domain gateway preserves a product advantage query instead of turning it into responsibilities', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '优势回答' } };
    } },
  });

  await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '他有什么优势', operation: 'product_knowledge', names: ['尊享人生年金保险（分红型）'],
      queryAspects: ['product_advantages'],
    },
    claims: claims(),
  });

  assert.deepEqual(routed[0].proposal.queryAspects, ['product_advantages']);
});

test('domain gateway preserves an unspecified aspect instead of inventing responsibilities', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '保险专家回答' } };
    } },
  });

  await gateway.execute({
    tool: 'ask_insurance_expert',
    input: { question: '这个产品好在哪里', operation: 'product_knowledge', names: ['安心产品'] },
    claims: claims(),
  });

  assert.deepEqual(routed[0].proposal.queryAspects, []);
});

test('domain gateway rejects model-supplied authority and cross-domain operations', async () => {
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    questionRouter: { async route() { throw new Error('must not route'); } },
  });
  await assert.rejects(gateway.execute({
    tool: 'ask_insurance_expert',
    input: { question: '查询', operation: 'coverage_report', familyId: 99 },
    claims: claims(),
  }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
  await assert.rejects(gateway.execute({
    tool: 'ask_sales_champion',
    input: { question: '查询', operation: 'coverage_report' },
    claims: claims(),
  }), (error) => error.code === 'OCR_AGENT_TOOL_INPUT_INVALID');
});
