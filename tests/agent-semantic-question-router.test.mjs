import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentSemanticQuestionRouter } from '../server/agent-semantic-question-router.service.mjs';
import { createAgentSemanticResolver } from '../server/agent-semantic-resolver.service.mjs';

function proposal(question, overrides = {}) {
  return {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [{ type: 'product', rawText: question }],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 1, mentions: 1, references: 1 },
    ...overrides,
  };
}

function memoryConversationService() {
  const rows = new Map();
  return {
    rows,
    async load({ conversationId }) {
      return rows.get(conversationId) || { version: 0, taskState: {} };
    },
    async save({ conversationId, expectedVersion, taskState }) {
      const current = rows.get(conversationId);
      if ((current?.version || 0) !== expectedVersion) {
        throw Object.assign(new Error('conflict'), { code: 'AGENT_SEMANTIC_CONVERSATION_CONFLICT' });
      }
      const saved = { version: expectedVersion + 1, taskState };
      rows.set(conversationId, saved);
      return { persisted: true, ...saved };
    },
  };
}

function wrapperHarness({ semanticResolver, conversationService } = {}) {
  const calls = [];
  const legacyRouter = {
    async route(input) {
      calls.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: 'authorized answer' } };
    },
  };
  return {
    calls,
    router: createAgentSemanticQuestionRouter({ legacyRouter, semanticResolver, conversationService }),
  };
}

test('legacy candidates delegate without semantic loading or mutation', async () => {
  let loads = 0;
  const { router, calls } = wrapperHarness({
    semanticResolver: { async resolve() { throw new Error('must not run'); } },
    conversationService: { async load() { loads += 1; }, async save() {} },
  });
  const input = {
    internalUserId: 7,
    messageRef: 'legacy-1',
    candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read' },
  };

  const result = await router.route(input);

  assert.equal(result.interaction.text, 'authorized answer');
  assert.deepEqual(calls, [input]);
  assert.equal(loads, 0);
});

test('confirmed product is reused by a current-product reference on the next request', async () => {
  const conversations = memoryConversationService();
  const product = {
    canonicalProductId: 'product-1', company: '新华人寿保险股份有限公司',
    officialName: '康健无忧两全保险', matchType: 'exact_official_name', confidence: 1,
  };
  const semanticResolver = createAgentSemanticResolver({
    productResolver: { resolve({ mentions }) {
      assert.equal(mentions.some((item) => item.rawText === product.officialName), true);
      return { status: 'resolved', entity: product, candidates: [] };
    } },
    familyResolver: { async resolve() { return { status: 'missing', entity: null, candidates: [] }; } },
    clock: () => 1_000,
  });
  const { router, calls } = wrapperHarness({ semanticResolver, conversationService: conversations });
  const base = { internalUserId: 7, conversationId: 'conv-1', runtime: 'hermes' };

  await router.route({
    ...base, messageRef: 'product-1', question: product.officialName,
    proposal: proposal(product.officialName),
  });
  const followupQuestion = '这个保险主要保什么';
  await router.route({
    ...base, messageRef: 'product-2', question: followupQuestion,
    proposal: proposal(followupQuestion, {
      mentions: [], references: [{ type: 'current_product', rawText: '这个保险' }],
    }),
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].candidate.entities.productName, product.officialName);
  assert.deepEqual(calls[1].semanticContext, {
    resolvedEntities: { product: {
      canonicalProductId: product.canonicalProductId,
      company: product.company,
      officialName: product.officialName,
    } },
    queryAspects: ['main_responsibilities'],
  });
  assert.equal(conversations.rows.get('conv-1').version, 1);
});

test('ambiguous products are persisted and choice two executes without exposing authority refs', async () => {
  const conversations = memoryConversationService();
  const candidates = [1, 2].map((index) => ({
    canonicalProductId: `private-${index}`,
    company: '测试保险', officialName: `正式产品${index}`,
    matchType: 'company_scoped_normalized', confidence: 1,
  }));
  const semanticResolver = createAgentSemanticResolver({
    productResolver: { resolve({ mentions }) {
      const selected = candidates.find((item) => mentions.some((mention) => mention.rawText === item.officialName));
      return selected
        ? { status: 'resolved', entity: selected, candidates: [] }
        : { status: 'ambiguous', entity: null, candidates };
    } },
    familyResolver: { async resolve() { return { status: 'missing', entity: null, candidates: [] }; } },
    clock: () => 2_000,
  });
  const { router, calls } = wrapperHarness({ semanticResolver, conversationService: conversations });
  const question = '康健无忧';
  const first = await router.route({
    internalUserId: 7, conversationId: 'conv-2', messageRef: 'ambiguous-1', runtime: 'hermes',
    question, proposal: proposal(question),
  });

  assert.equal(first.decision, 'clarify');
  assert.deepEqual(first.interaction.candidates, [
    { ref: 'choice_1', label: '正式产品1' },
    { ref: 'choice_2', label: '正式产品2' },
  ]);
  assert.doesNotMatch(JSON.stringify(first), /private-/u);

  const selected = await router.route({
    internalUserId: 7, conversationId: 'conv-2', messageRef: 'ambiguous-2', runtime: 'hermes',
    question: '选择2', proposal: null,
  });
  assert.equal(selected.decision, 'execute');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidate.entities.productName, '正式产品2');
});

test('family ambiguity labels are generic and no-conversation choices require a full name', async () => {
  const resolved = {
    decision: 'clarify', decisionReason: 'entity_ambiguous', missingFields: [], ambiguities: ['family'],
    resolvedEntities: {}, candidate: null,
    nextTaskState: {
      candidateSets: { product: [], family: [
        { familyId: 71, displayName: '张三家庭' },
        { familyId: 72, displayName: '李四家庭' },
      ] },
    },
  };
  const { router } = wrapperHarness({
    semanticResolver: { async resolve() { return resolved; } },
    conversationService: memoryConversationService(),
  });

  const result = await router.route({
    internalUserId: 7, messageRef: 'family-1', question: '查看家庭', runtime: 'hermes', proposal: {},
  });

  assert.match(result.interaction.text, /完整名称/u);
  assert.deepEqual(result.interaction.candidates.map((item) => item.label), ['候选家庭 1', '候选家庭 2']);
  assert.doesNotMatch(JSON.stringify(result), /张三|李四|71|72/u);
});

test('non-execute decisions are stable and never call the legacy router', async () => {
  for (const [decision, expectedDecision, expectedType] of [
    ['clarify', 'clarify', 'clarification'],
    ['retry_later', 'clarify', 'clarification'],
    ['reject', 'deny', 'denied'],
  ]) {
    const { router, calls } = wrapperHarness({
      semanticResolver: { async resolve() {
        return {
          decision, decisionReason: decision === 'clarify' ? 'product_required' : decision,
          missingFields: decision === 'clarify' ? ['product'] : [], ambiguities: [],
          resolvedEntities: {}, candidate: null, nextTaskState: {},
        };
      } },
      conversationService: memoryConversationService(),
    });
    const result = await router.route({
      internalUserId: 7, conversationId: 'conv', messageRef: `decision-${decision}`,
      question: '查询', runtime: 'hermes', proposal: {},
    });
    assert.equal(result.decision, expectedDecision);
    assert.equal(result.interaction.type, expectedType);
    assert.equal(calls.length, 0);
  }
});

test('load, resolver, and clarification save failures return stable retry text', async () => {
  const stable = async (semanticResolver, conversationService) => {
    const { router, calls } = wrapperHarness({ semanticResolver, conversationService });
    const result = await router.route({
      internalUserId: 7, conversationId: 'conv', messageRef: 'failure',
      question: '查询', runtime: 'hermes', proposal: {},
    });
    assert.deepEqual(result, {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '语义解析暂不可用，请稍后重试。' },
    });
    assert.equal(calls.length, 0);
  };

  await stable({ async resolve() { throw new Error('private resolver payload'); } }, {
    async load() { return { version: 0, taskState: {} }; },
    async save() {},
  });
  await stable({ async resolve() { return {
    decision: 'clarify', decisionReason: 'product_required', missingFields: ['product'],
    ambiguities: [], resolvedEntities: {}, candidate: null, nextTaskState: { activeIntent: 'x' },
  }; } }, {
    async load() { return { version: 1, taskState: {} }; },
    async save() { throw Object.assign(new Error('conflict'), { code: 'AGENT_SEMANTIC_CONVERSATION_CONFLICT' }); },
  });
  await stable({ async resolve() { throw new Error('must not run'); } }, {
    async load() { throw new Error('private row'); },
    async save() {},
  });
});

test('execute save conflict preserves the successful read result', async () => {
  const { router, calls } = wrapperHarness({
    semanticResolver: { async resolve() { return {
      decision: 'execute', decisionReason: 'semantic_ready', missingFields: [], ambiguities: [],
      resolvedEntities: {}, candidate: {
        intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read',
      }, nextTaskState: { activeIntent: 'chat' }, proposal: { queryAspects: [] },
    }; } },
    conversationService: {
      async load() { return { version: 1, taskState: {} }; },
      async save() { throw Object.assign(new Error('conflict'), { code: 'AGENT_SEMANTIC_CONVERSATION_CONFLICT' }); },
    },
  });

  const result = await router.route({
    internalUserId: 7, conversationId: 'conv', messageRef: 'execute-conflict',
    question: '你好', runtime: 'hermes', proposal: {},
  });

  assert.equal(result.interaction.text, 'authorized answer');
  assert.equal(calls.length, 1);
});
