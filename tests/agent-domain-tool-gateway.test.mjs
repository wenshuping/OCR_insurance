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

function resolvedProduct(rawText) {
  return {
    status: 'resolved',
    entity: {
      canonicalProductId: `product-${rawText}`,
      company: rawText.startsWith('乙') ? '乙公司' : '甲公司',
      officialName: rawText,
    },
    candidates: [],
  };
}

test('domain gateway turns an explicit Hermes operation into a trusted domain request', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve({ mentions }) {
      return resolvedProduct(mentions.find((item) => item.type === 'product').rawText);
    } },
    questionRouter: { async route(input) {
      routed.push(input);
      return {
        decision: 'execute',
        interaction: { type: 'answer', text: '已核验。' },
        rawEvidence: Array.from({ length: 40 }, (_, index) => ({ field: index, content: '不应进入 Hermes 上下文' })),
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
  assert.equal(result.rawEvidence, undefined);
  assert.deepEqual(result.resolvedEntities.products, [
    { canonicalProductId: 'product-甲产品', company: '甲公司', officialName: '甲产品' },
    { canonicalProductId: 'product-乙产品', company: '乙公司', officialName: '乙产品' },
  ]);
  assert.deepEqual(routed[0], {
    internalUserId: 7,
    messageRef: 'message-a:tool:1',
    conversationId: 'conversation-a',
    candidate: {
      intent: 'insurance_product_knowledge',
      question: '比较甲产品和乙产品',
      confidence: 1,
      requestedOperation: 'read',
      entities: {
        product1Name: '甲产品', product1CanonicalId: 'product-甲产品', product1Company: '甲公司',
        product2Name: '乙产品', product2CanonicalId: 'product-乙产品', product2Company: '乙公司',
      },
    },
    semanticContext: {
      resolvedEntities: { products: [
        { canonicalProductId: 'product-甲产品', company: '甲公司', officialName: '甲产品' },
        { canonicalProductId: 'product-乙产品', company: '乙公司', officialName: '乙产品' },
      ] },
      queryAspects: ['comparison'],
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
    productResolver: { async resolve() {
      return { status: 'resolved', entity: {
        canonicalProductId: 'product-zxrs', company: '新华保险',
        officialName: '尊享人生年金保险（分红型）',
      }, candidates: [] };
    } },
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

  assert.equal(routed[0].candidate.question, '他有什么优势');
  assert.equal(routed[0].candidate.entities.productName, '尊享人生年金保险（分红型）');
  assert.deepEqual(routed[0].semanticContext.queryAspects, ['product_advantages']);
});

test('domain gateway preserves an unspecified aspect instead of inventing responsibilities', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve() {
      return { status: 'resolved', entity: {
        canonicalProductId: 'product-anxin', company: '安心保险', officialName: '安心产品',
      }, candidates: [] };
    } },
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

  assert.deepEqual(routed[0].semanticContext.queryAspects, []);
});

test('domain gateway separates a natural insurer prefix from the product name chosen by Hermes', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve({ mentions }) {
      assert.deepEqual(mentions, [
        { type: 'insurer', rawText: '新华保险' },
        { type: 'product', rawText: '寰宇尊悦高端医疗保险' },
      ]);
      return { status: 'resolved', entity: {
        canonicalProductId: 'product-hyzy', company: '新华保险',
        officialName: '新华人寿保险股份有限公司寰宇尊悦高端医疗保险',
      }, candidates: [] };
    } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '保险专家回答' } };
    } },
  });

  await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '新华保险的寰宇尊悦高端医疗保险，计划一、计划二、计划三分别是啥',
      operation: 'product_knowledge',
      names: ['新华保险寰宇尊悦高端医疗保险'],
    },
    claims: claims(),
  });

  assert.equal(routed[0].candidate.question, '新华保险的寰宇尊悦高端医疗保险，计划一、计划二、计划三分别是啥');
  assert.equal(
    routed[0].candidate.entities.productName,
    '新华人寿保险股份有限公司寰宇尊悦高端医疗保险',
  );
  assert.equal(routed[0].proposal, undefined);
});

test('domain gateway returns product candidates without sending the question through semantic classification', async () => {
  let routeCalls = 0;
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve() {
      return { status: 'ambiguous', entity: null, candidates: [
        { canonicalProductId: 'product-a', company: '甲公司', officialName: '甲产品' },
        { canonicalProductId: 'product-b', company: '乙公司', officialName: '乙产品' },
      ] };
    } },
    questionRouter: { async route() { routeCalls += 1; } },
  });

  const result = await gateway.execute({
    tool: 'ask_insurance_expert',
    input: { question: '尊享人生保什么', operation: 'product_knowledge', names: ['尊享人生'] },
    claims: claims(),
  });

  assert.equal(result.status, 'needs_clarification');
  assert.equal(routeCalls, 0);
  assert.deepEqual(result.interaction.candidates.map((item) => item.label), [
    '甲公司《甲产品》', '乙公司《乙产品》',
  ]);
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
