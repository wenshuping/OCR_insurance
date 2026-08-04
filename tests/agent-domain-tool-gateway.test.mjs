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

test('domain gateway preserves the sales KYC update for conversation persistence', async () => {
  const salesKyc = {
    caseVersion: 1,
    knownSlots: ['customer_relationship_origin'],
    unknownSlots: [],
    facts: [{ key: 'relationship_origin', value: '公司转交', source: 'advisor_fact' }],
    labels: [{ dimension: 'source', value: 'SRC8', status: 'confirmed' }],
  };
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    questionRouter: { async route() {
      return {
        decision: 'execute',
        interaction: { type: 'answer', text: '销售建议' },
        agentContextUpdate: { salesKyc },
      };
    } },
  });

  const output = await gateway.execute({
    tool: 'ask_sales_champion',
    input: { question: '这个客户怎么跟进', operation: 'sales_coaching' },
    claims: claims(),
  });

  assert.deepEqual(output.agentContextUpdate, { salesKyc });
});

test('domain gateway restores sales history and KYC before the next Agent Loop tool call', async () => {
  const routed = [];
  const storedKyc = {
    caseVersion: 2,
    knownSlots: ['customer_relationship_origin', 'explicit_customer_request'],
    unknownSlots: [],
    facts: [
      { key: 'relationship_origin', value: '公司转交的老保单客户', source: 'advisor_fact' },
      { key: 'service_request', value: '整理保单', source: 'advisor_fact' },
    ],
    labels: [{ dimension: 'source', value: 'SRC8', status: 'confirmed' }],
  };
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    conversationContext: { async loadContext() {
      return {
        history: [
          { role: 'user', content: '客户是公司转交的老保单客户' },
          { role: 'assistant', content: '客户希望你帮他办什么？' },
          { role: 'user', content: '客户让我整理保单' },
        ],
        factBlock: { salesKyc: storedKyc },
      };
    } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '继续跟进建议' } };
    } },
  });

  await gateway.execute({
    tool: 'ask_sales_champion',
    input: { question: '他最近还是很忙', operation: 'sales_coaching' },
    claims: claims(),
  });

  assert.deepEqual(routed[0].conversationHistory.map((message) => message.content), [
    '客户是公司转交的老保单客户',
    '客户希望你帮他办什么？',
    '客户让我整理保单',
  ]);
  assert.deepEqual(routed[0].salesContext.salesKycState, storedKyc);
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

test('domain gateway reuses the exact product bound to the current tool capability', async () => {
  const product = {
    canonicalProductId: 'product-zjy',
    company: '新华保险',
    officialName: '新华人寿保险股份有限公司尊佑金悦庆典版养老年金保险（分红型）',
  };
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve(input) {
      assert.deepEqual(input.confirmedCandidate, product);
      return { status: 'resolved', entity: { ...product, matchType: 'confirmed_candidate', confidence: 1 }, candidates: [] };
    } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '直接回答产品评价。' } };
    } },
  });

  const result = await gateway.execute({
    tool: 'ask_insurance_expert',
    input: { question: '怎么样呀', operation: 'product_knowledge', names: [product.officialName] },
    claims: claims({ confirmedProduct: product }),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.interaction.text, '直接回答产品评价。');
  assert.deepEqual(routed[0].candidate.entities, {
    productName: product.officialName,
    productCanonicalId: product.canonicalProductId,
    productCompany: product.company,
  });
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

test('domain gateway parses the structured insurer and product identity discovered online', async () => {
  const resolverCalls = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve(input) {
      resolverCalls.push(input);
      return { status: 'resolved', entity: {
        canonicalProductId: 'product-online', company: '联合承保机构', officialName: '公开产品正式名称',
      }, candidates: [] };
    } },
    questionRouter: { async route() {
      return { decision: 'execute', interaction: { type: 'answer', text: '保险专家回答' } };
    } },
  });

  await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '公开产品保险责任', operation: 'product_knowledge',
      names: ['联合承保机构《公开产品正式名称》'], searchOnline: true,
    },
    claims: claims({
      onlineProductSearchAllowed: true,
      rejectedProductCandidates: [{
        canonicalProductId: 'rejected-a', company: '中国人寿',
        officialName: '国寿金彩明天两全保险（A款）（分红型）',
      }],
    }),
  });

  assert.deepEqual(resolverCalls[0], {
    mentions: [
      { type: 'insurer', rawText: '联合承保机构' },
      { type: 'product', rawText: '公开产品正式名称' },
    ],
    activeProduct: null,
    allowOnline: true,
    rejectedProductCandidates: [{
      canonicalProductId: 'rejected-a', company: '中国人寿',
      officialName: '国寿金彩明天两全保险（A款）（分红型）',
    }],
  });
});

test('domain gateway separates a spaced insurer prefix from the requested product', async () => {
  const resolverCalls = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve(input) {
      resolverCalls.push(input);
      return { status: 'not_found', entity: null, candidates: [] };
    } },
    questionRouter: { async route() { throw new Error('must not route'); } },
  });

  await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '平安保险 的 平安鸿利两全保险', operation: 'product_knowledge',
      names: ['平安鸿利两全保险'],
    },
    claims: claims(),
  });

  assert.deepEqual(resolverCalls[0].mentions, [
    { type: 'insurer', rawText: '平安保险' },
    { type: 'product', rawText: '平安鸿利两全保险' },
  ]);
});

test('domain gateway reserves the tenth local candidate slot for online search', async () => {
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve() {
      return {
        status: 'ambiguous', entity: null,
        candidates: Array.from({ length: 10 }, (_value, index) => ({
          canonicalProductId: `product-${index + 1}`,
          company: `保险公司${index + 1}`,
          officialName: `两全保险${index + 1}`,
        })),
      };
    } },
    questionRouter: { async route() { throw new Error('must not route'); } },
  });

  const result = await gateway.execute({
    tool: 'ask_insurance_expert',
    input: { question: '平安鸿利两全保险', operation: 'product_knowledge', names: ['平安鸿利两全保险'] },
    claims: claims(),
  });

  assert.equal(result.interaction.candidates.length, 10);
  assert.deepEqual(result.interaction.candidates.at(-1), {
    ref: 'search_online', label: '以上都不是，联网查询',
  });
});

test('domain gateway returns product candidates without sending the question through semantic classification', async () => {
  let routeCalls = 0;
  const resolverCalls = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve(input) {
      resolverCalls.push(input);
      return { status: 'ambiguous', entity: null, candidates: [
        { canonicalProductId: 'product-a', company: '甲公司', officialName: '甲产品' },
        { canonicalProductId: 'product-b', company: '乙公司', officialName: '乙产品' },
      ] };
    } },
    questionRouter: { async route() { routeCalls += 1; } },
  });

  const result = await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '尊享人生保什么', operation: 'product_knowledge', names: ['尊享人生'], searchOnline: true,
    },
    claims: claims({ onlineProductSearchAllowed: true }),
  });

  assert.equal(result.status, 'needs_clarification');
  assert.equal(routeCalls, 0);
  assert.equal(resolverCalls[0].allowOnline, true);
  assert.deepEqual(result.interaction.candidates.map((item) => item.label), [
    '甲公司《甲产品》', '乙公司《乙产品》',
  ]);
  assert.equal(result.interaction.text, '联网找到以下可能的正式产品，请选择一项。');
});

test('domain gateway does not offer the same online search action after an online miss', async () => {
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve() {
      return { status: 'not_found', entity: null, candidates: [] };
    } },
    questionRouter: { async route() { throw new Error('must not route'); } },
  });

  const result = await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '公开产品保险责任', operation: 'product_knowledge',
      names: ['公开产品'], searchOnline: true,
    },
    claims: claims({ onlineProductSearchAllowed: true }),
  });

  assert.equal(result.status, 'needs_clarification');
  assert.deepEqual(result.interaction.candidates, []);
  assert.match(result.interaction.text, /联网查询后仍未找到/u);
});

test('domain gateway ignores model-requested online search without server authority', async () => {
  const resolverCalls = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve(input) {
      resolverCalls.push(input);
      return { status: 'not_found', entity: null, candidates: [] };
    } },
    questionRouter: { async route() { throw new Error('must not route'); } },
  });

  const result = await gateway.execute({
    tool: 'ask_insurance_expert',
    input: {
      question: '公开产品保险责任', operation: 'product_knowledge',
      names: ['公开产品'], searchOnline: true,
    },
    claims: claims(),
  });

  assert.equal(resolverCalls[0].allowOnline, undefined);
  assert.deepEqual(result.interaction.candidates, [
    { ref: 'search_online', label: '以上都不是，联网查询' },
  ]);
  assert.match(result.interaction.text, /本地产品库暂未找到/u);
});

test('an ambiguous supporting product does not block a customer follow-up sales task', async () => {
  const routed = [];
  const question = '我昨天见了一个客户，他买了新华保险的康健华尊，然后他自己在那个平安有几个年金险或者增额终身寿险，问怎么去跟进这个客户';
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve({ mentions }) {
      assert.deepEqual(mentions, [
        { type: 'insurer', rawText: '新华保险' },
        { type: 'product', rawText: '康健华尊' },
      ]);
      return { status: 'ambiguous', entity: null, candidates: [
        { canonicalProductId: 'product-a', company: '新华保险', officialName: '候选产品甲' },
        { canonicalProductId: 'product-b', company: '新华保险', officialName: '候选产品乙' },
      ] };
    } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '先围绕养老目标和夫妻决策关系做需求访谈。' } };
    } },
  });

  const result = await gateway.execute({
    tool: 'ask_sales_champion',
    input: {
      question,
      operation: 'sales_coaching',
      productMentions: ['新华保险的康健华尊'],
    },
    claims: claims(),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.interaction.text, '先围绕养老目标和夫妻决策关系做需求访谈。');
  assert.equal(routed[0].candidate.question, question);
  assert.deepEqual(routed[0].salesContext, {
    productMentions: ['新华保险的康健华尊'],
    officialFactNeeds: [],
    resolvedProducts: [],
  });
});

test('an ambiguous sales product still requires confirmation when advice needs official product facts', async () => {
  let routeCalls = 0;
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve() {
      return { status: 'ambiguous', entity: null, candidates: [
        { canonicalProductId: 'product-a', company: '新华保险', officialName: '康健华尊医疗保险A款' },
        { canonicalProductId: 'product-b', company: '新华保险', officialName: '康健华尊医疗保险B款' },
      ] };
    } },
    questionRouter: { async route() { routeCalls += 1; } },
  });

  const result = await gateway.execute({
    tool: 'ask_sales_champion',
    input: {
      question: '客户问康健华尊续保时，我下一步怎么沟通？',
      operation: 'sales_coaching',
      productMentions: ['康健华尊'],
      officialFactNeeds: ['renewal'],
    },
    claims: claims(),
  });

  assert.equal(result.status, 'needs_clarification');
  assert.equal(result.candidateType, 'product');
  assert.equal(result.interaction.candidates.length, 3);
  assert.equal(routeCalls, 0);
});

test('sales coaching carries a uniquely resolved product only as optional insurance evidence context', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve() {
      return resolvedProduct('康健华尊医疗保险');
    } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '销冠回答' } };
    } },
  });

  await gateway.execute({
    tool: 'ask_sales_champion',
    input: {
      question: '客户问康健华尊续保时，我下一步怎么沟通？',
      operation: 'sales_coaching',
      productMentions: ['康健华尊医疗保险'],
      officialFactNeeds: ['renewal'],
    },
    claims: claims(),
  });

  assert.deepEqual(routed[0].salesContext, {
    productMentions: ['康健华尊医疗保险'],
    officialFactNeeds: ['renewal'],
    resolvedProducts: [{
      canonicalProductId: 'product-康健华尊医疗保险',
      company: '甲公司',
      officialName: '康健华尊医疗保险',
    }],
  });
});

test('a uniquely resolved supporting product does not invent official fact needs', async () => {
  const routed = [];
  const gateway = createAgentDomainToolGateway({
    async resolveChannelIdentity() { return { internalUserId: 7 }; },
    productResolver: { async resolve() { return resolvedProduct('康健华尊医疗保险'); } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '销冠回答' } };
    } },
  });

  await gateway.execute({
    tool: 'ask_sales_champion',
    input: {
      question: '客户买了康健华尊医疗保险，我怎么跟进？',
      operation: 'sales_coaching',
      productMentions: ['康健华尊医疗保险'],
    },
    claims: claims(),
  });

  assert.deepEqual(routed[0].salesContext.officialFactNeeds, []);
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
