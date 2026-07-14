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

function chatProposal(question, overrides = {}) {
  return {
    semanticContractVersion: 1,
    intent: 'chat',
    operation: 'read',
    queryAspects: [],
    mentions: [],
    references: [],
    requestedSteps: ['continue'],
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

function wrapperHarness({ semanticResolver, conversationService, auditService } = {}) {
  const calls = [];
  const audits = [];
  const legacyRouter = {
    async route(input) {
      calls.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: 'authorized answer' } };
    },
  };
  return {
    calls,
    audits,
    router: createAgentSemanticQuestionRouter({
      legacyRouter,
      semanticResolver,
      conversationService,
      auditService: auditService || { async record(input) { audits.push(input); } },
    }),
  };
}

test('semantic decisions are audited before execution or state persistence', async () => {
  const order = [];
  const question = '你好';
  const router = createAgentSemanticQuestionRouter({
    legacyRouter: { async route() { order.push('legacy'); return { decision: 'execute' }; } },
    semanticResolver: { async resolve() { return {
      decision: 'execute', decisionReason: 'semantic_ready', missingFields: [], ambiguities: [],
      proposal: chatProposal(question), resolvedEntities: {},
      candidate: { intent: 'chat', question, confidence: 1, requestedOperation: 'read' },
      nextTaskState: { activeIntent: 'chat' },
    }; } },
    conversationService: {
      async load() { return { version: 0, taskState: {} }; },
      async save() { order.push('save'); },
    },
    auditService: { async record(input) {
      order.push('audit');
      assert.equal(input.phase, 'semantic_resolution');
      assert.equal(input.resolution.decision, 'execute');
    } },
  });

  await router.route({
    internalUserId: 7, conversationId: 'conv', messageRef: 'audit-order',
    question, runtime: 'hermes', proposal: chatProposal(question),
  });

  assert.deepEqual(order, ['audit', 'legacy', 'save']);
});

test('semantic audit failure prevents execution and state persistence', async () => {
  let saves = 0;
  const question = '你好';
  const { router, calls } = wrapperHarness({
    semanticResolver: { async resolve() { return {
      decision: 'execute', decisionReason: 'semantic_ready', missingFields: [], ambiguities: [],
      proposal: chatProposal(question), resolvedEntities: {},
      candidate: { intent: 'chat', question, confidence: 1, requestedOperation: 'read' },
      nextTaskState: { activeIntent: 'chat' },
    }; } },
    conversationService: {
      async load() { return { version: 0, taskState: {} }; },
      async save() { saves += 1; },
    },
    auditService: { async record() { throw new Error('audit unavailable'); } },
  });

  const result = await router.route({
    internalUserId: 7, conversationId: 'conv', messageRef: 'audit-failure',
    question, runtime: 'hermes', proposal: chatProposal(question),
  });

  assert.match(result.interaction.text, /语义解析暂不可用/u);
  assert.equal(calls.length, 0);
  assert.equal(saves, 0);
});

test('clarifications are audited and legacy candidates are not', async () => {
  const { router, audits } = wrapperHarness({
    semanticResolver: { async resolve() { return {
      decision: 'clarify', decisionReason: 'product_required', missingFields: ['product'],
      ambiguities: [], proposal: chatProposal('查询'), resolvedEntities: {}, candidate: null,
      nextTaskState: {},
    }; } },
    conversationService: memoryConversationService(),
  });

  await router.route({
    internalUserId: 7, conversationId: 'conv', messageRef: 'clarify-audit',
    question: '查询', runtime: 'hermes', proposal: chatProposal('查询'),
  });
  await router.route({
    internalUserId: 7, messageRef: 'legacy-no-semantic-audit',
    candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read' },
  });

  assert.equal(audits.length, 1);
  assert.equal(audits[0].resolution.decision, 'clarify');
});

test('missing semantic audit dependency disables semantic routing but preserves legacy routing', async () => {
  const legacyCalls = [];
  const router = createAgentSemanticQuestionRouter({
    legacyRouter: { async route(input) { legacyCalls.push(input); return { decision: 'execute' }; } },
    semanticResolver: { async resolve() { throw new Error('must not run'); } },
    conversationService: { async load() { throw new Error('must not load'); }, async save() {} },
  });
  const semantic = await router.route({
    internalUserId: 7, messageRef: 'no-audit', question: '你好', runtime: 'hermes',
    proposal: chatProposal('你好'),
  });
  assert.match(semantic.interaction.text, /语义解析暂不可用/u);
  await router.route({
    internalUserId: 7, messageRef: 'legacy',
    candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read' },
  });
  assert.equal(legacyCalls.length, 1);
});

test('conversation load failures attempt a redacted semantic error audit', async () => {
  const audits = [];
  const { router } = wrapperHarness({
    semanticResolver: { async resolve() { throw new Error('must not run'); } },
    conversationService: { async load() { throw new Error('private conversation'); }, async save() {} },
    auditService: { async record(input) { audits.push(input); } },
  });
  await router.route({
    internalUserId: 7, messageRef: 'load-error', question: '你好', runtime: 'hermes',
    proposal: chatProposal('你好'),
  });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].phase, 'semantic_error');
  assert.equal(audits[0].errorCode, 'SEMANTIC_CONVERSATION_LOAD_FAILED');
  assert.equal(audits[0].resolution.decisionReason, 'semantic_load_failed');
  assert.doesNotMatch(JSON.stringify(audits), /private conversation/u);
});

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
      activeIntent: '',
      activeEntities: { product: null, family: null },
      candidateSets: { product: [], family: [
        { familyId: 71, displayName: '张三家庭', matchType: 'exact', confidence: 1 },
        { familyId: 72, displayName: '李四家庭', matchType: 'exact', confidence: 1 },
      ] },
      pendingClarification: {
        entityType: 'family', originalQuestion: '查看家庭', expiresAt: 10_000,
        proposal: {
          semanticContractVersion: 1, intent: 'family_summary', operation: 'read',
          queryAspects: ['family_overview'], mentions: [{ type: 'family', rawText: '家庭' }],
          references: [], requestedSteps: ['lookup'],
          confidence: { intent: 1, mentions: 1, references: 1 },
        },
      },
      lastCompletedAction: null,
    },
  };
  resolved.proposal = resolved.nextTaskState.pendingClarification.proposal;
  const { router } = wrapperHarness({
    semanticResolver: { async resolve() { return resolved; } },
    conversationService: memoryConversationService(),
  });

  const result = await router.route({
    internalUserId: 7, messageRef: 'family-1', question: '查看家庭', runtime: 'hermes',
    proposal: resolved.proposal,
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
      question: '查询', runtime: 'hermes', proposal: null,
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
      question: '查询', runtime: 'hermes', proposal: null,
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
    ambiguities: [], resolvedEntities: {}, candidate: null, nextTaskState: { activeIntent: 'chat' },
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
      }, nextTaskState: { activeIntent: 'chat' }, proposal: chatProposal('你好'),
    }; } },
    conversationService: {
      async load() { return { version: 1, taskState: {} }; },
      async save() { throw Object.assign(new Error('conflict'), { code: 'AGENT_SEMANTIC_CONVERSATION_CONFLICT' }); },
    },
  });

  const result = await router.route({
    internalUserId: 7, conversationId: 'conv', messageRef: 'execute-conflict',
    question: '你好', runtime: 'hermes', proposal: chatProposal('你好'),
  });

  assert.equal(result.interaction.text, 'authorized answer');
  assert.equal(calls.length, 1);
});

test('malformed or cyclic resolver results never execute or clear conversation state', async () => {
  const validProposal = {
    intent: 'chat', operation: 'read', queryAspects: [],
    confidence: { intent: 1, mentions: 1, references: 1 },
  };
  const malformedResults = [
    { decision: 'execute', candidate: { intent: 'chat' } },
    { decision: 'unknown', candidate: {}, nextTaskState: {} },
    { decision: 'execute', candidate: [], proposal: validProposal, nextTaskState: {} },
    {
      decision: 'execute', proposal: validProposal, nextTaskState: {},
      candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'delete' },
    },
    {
      decision: 'execute', proposal: validProposal, nextTaskState: {},
      candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'write' },
    },
    {
      decision: 'execute', proposal: { ...validProposal, operation: 'write' }, nextTaskState: {},
      candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read' },
    },
    {
      decision: 'execute', proposal: validProposal, nextTaskState: {},
      candidate: { intent: 'family_list', question: '你好', confidence: 1, requestedOperation: 'read' },
    },
    {
      decision: 'execute', proposal: validProposal, nextTaskState: {},
      candidate: { intent: 'chat', question: '你好', confidence: 0.9, requestedOperation: 'read' },
    },
    {
      decision: 'execute', proposal: validProposal, nextTaskState: {},
      candidate: {
        intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read',
        entities: { familyId: '71' },
      },
    },
  ];
  const cyclicState = {};
  cyclicState.self = cyclicState;
  malformedResults.push({ decision: 'execute', candidate: {}, proposal: validProposal, nextTaskState: cyclicState });

  for (const resolved of malformedResults) {
    let saves = 0;
    const { router, calls } = wrapperHarness({
      semanticResolver: { async resolve() { return resolved; } },
      conversationService: {
        async load() { return { version: 3, taskState: { activeIntent: 'chat' } }; },
        async save() { saves += 1; },
      },
    });
    const result = await router.route({
      internalUserId: 7, conversationId: 'conv', messageRef: 'malformed',
      question: '继续', runtime: 'hermes', proposal: null,
    });
    assert.deepEqual(result, {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '语义解析暂不可用，请稍后重试。' },
    });
    assert.equal(calls.length, 0);
    assert.equal(saves, 0);
  }
});

test('resolver results remain bound to the normalized input proposal and question', async () => {
  const question = '修改新华资料';
  const inputProposal = chatProposal(question, { operation: 'write' });
  const cases = [
    {
      proposal: { ...inputProposal, operation: 'read' },
      candidate: { intent: 'chat', question, confidence: 1, requestedOperation: 'read' },
    },
    {
      proposal: inputProposal,
      candidate: { intent: 'chat', question: '改写后的问题', confidence: 1, requestedOperation: 'write' },
    },
    {
      proposal: { ...inputProposal, confidence: { ...inputProposal.confidence, intent: 0.8 } },
      candidate: { intent: 'chat', question, confidence: 0.8, requestedOperation: 'write' },
    },
    {
      proposal: { ...inputProposal, mentions: [{ type: 'insurer', rawText: '新华' }] },
      candidate: { intent: 'chat', question, confidence: 1, requestedOperation: 'write' },
    },
    {
      proposal: { ...inputProposal, queryAspects: ['upload'] },
      candidate: { intent: 'chat', question, confidence: 1, requestedOperation: 'write' },
    },
    {
      decision: 'clarify',
      proposal: { ...inputProposal, queryAspects: ['upload'] },
      candidate: null,
    },
  ];

  for (const item of cases) {
    let saves = 0;
    const { router, calls } = wrapperHarness({
      semanticResolver: { async resolve() { return {
        decision: item.decision || 'execute',
        decisionReason: item.decision ? 'product_required' : 'semantic_ready',
        missingFields: item.decision ? ['product'] : [], ambiguities: [], resolvedEntities: {},
        proposal: item.proposal, candidate: item.candidate,
        nextTaskState: { activeIntent: 'chat' },
      }; } },
      conversationService: {
        async load() { return { version: 0, taskState: {} }; },
        async save() { saves += 1; },
      },
    });

    const result = await router.route({
      internalUserId: 7, conversationId: 'bound', messageRef: 'bound-result',
      question: `  ${question}  `, runtime: 'hermes', proposal: inputProposal,
    });
    assert.deepEqual(result, {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '语义解析暂不可用，请稍后重试。' },
    });
    assert.equal(calls.length, 0);
    assert.equal(saves, 0);
  }
});

test('proposal-free requests cannot synthesize chat proposals or mutate conversation state', async () => {
  for (const runtime of ['rule', 'direct', 'hermes']) {
    let saves = 0;
    const question = '普通问候';
    const { router, calls } = wrapperHarness({
      semanticResolver: { async resolve() { return {
        decision: 'execute', decisionReason: 'semantic_ready', resolvedEntities: {},
        proposal: chatProposal(question),
        candidate: { intent: 'chat', question, confidence: 1, requestedOperation: 'read' },
        nextTaskState: { activeIntent: 'chat' },
      }; } },
      conversationService: {
        async load() { return { version: 0, taskState: {} }; },
        async save() { saves += 1; },
      },
    });

    const result = await router.route({
      internalUserId: 7, conversationId: 'no-source', messageRef: `no-source-${runtime}`,
      question, runtime, proposal: null,
    });
    assert.deepEqual(result, {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '语义解析暂不可用，请稍后重试。' },
    });
    assert.equal(calls.length, 0);
    assert.equal(saves, 0);
  }

  let stateOnlySaves = 0;
  const { router: stateOnlyRouter, calls: stateOnlyCalls } = wrapperHarness({
    semanticResolver: { async resolve() { return {
      decision: 'retry_later', decisionReason: 'resolver_unavailable', proposal: null,
      resolvedEntities: {}, candidate: null, nextTaskState: { activeIntent: 'chat' },
    }; } },
    conversationService: {
      async load() { return { version: 0, taskState: {} }; },
      async save() { stateOnlySaves += 1; },
    },
  });
  const stateOnly = await stateOnlyRouter.route({
    internalUserId: 7, conversationId: 'state-only', messageRef: 'state-only',
    question: '普通问候', runtime: 'rule', proposal: null,
  });
  assert.match(stateOnly.interaction.text, /语义解析暂不可用/u);
  assert.equal(stateOnlyCalls.length, 0);
  assert.equal(stateOnlySaves, 0);
});

test('proposal-free rule upload is the only locally synthesized execution', async () => {
  const semanticResolver = createAgentSemanticResolver({
    productResolver: { async resolve() { throw new Error('must not resolve product'); } },
    familyResolver: { async resolve() { throw new Error('must not resolve family'); } },
    clock: () => 5_000,
  });
  const { router, calls } = wrapperHarness({
    semanticResolver,
    conversationService: memoryConversationService(),
  });

  const result = await router.route({
    internalUserId: 7, conversationId: 'upload', messageRef: 'upload-rule',
    question: '我要上传保单资料', runtime: 'rule', proposal: null,
  });

  assert.equal(result.decision, 'execute');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].candidate.intent, 'upload_link');
});

test('expired pending selection remains a clarification without extending state', async () => {
  const conversations = memoryConversationService();
  const pendingProposal = proposal('康健无忧');
  conversations.rows.set('expired-selection', {
    version: 1,
    taskState: {
      candidateSets: { product: [{
        canonicalProductId: 'product-1', company: '新华人寿保险股份有限公司',
        officialName: '康健无忧两全保险', matchType: 'exact_official_name', confidence: 1,
      }] },
      pendingClarification: {
        entityType: 'product', proposal: pendingProposal,
        originalQuestion: '康健无忧', expiresAt: 9_000,
      },
    },
  });
  const semanticResolver = createAgentSemanticResolver({
    productResolver: { async resolve() { throw new Error('expired selection must not resolve'); } },
    familyResolver: { async resolve() { throw new Error('expired selection must not resolve'); } },
    clock: () => 10_000,
  });
  const { router, calls } = wrapperHarness({ semanticResolver, conversationService: conversations });

  const result = await router.route({
    internalUserId: 7, conversationId: 'expired-selection', messageRef: 'expired-selection',
    question: '选择1', runtime: 'hermes', proposal: null,
  });

  assert.equal(result.decision, 'clarify');
  assert.match(result.interaction.text, /重新说明/u);
  assert.equal(calls.length, 0);
  assert.equal(conversations.rows.get('expired-selection').taskState.pendingClarification, null);
});

test('non-execute conversation conflict reloads and retries resolution once', async () => {
  let loads = 0;
  let resolves = 0;
  let saves = 0;
  const { router, calls } = wrapperHarness({
    semanticResolver: { async resolve({ context }) {
      resolves += 1;
      return {
        decision: 'clarify', decisionReason: 'product_required', missingFields: ['product'],
        ambiguities: [], candidate: null, resolvedEntities: {}, proposal: chatProposal('查询'),
        nextTaskState: { ...context.taskState, activeIntent: resolves === 1 ? 'chat' : 'insurance_product_knowledge' },
      };
    } },
    conversationService: {
      async load() {
        loads += 1;
        return { version: loads - 1, taskState: {} };
      },
      async save() {
        saves += 1;
        if (saves === 1) {
          throw Object.assign(new Error('conflict'), { code: 'AGENT_SEMANTIC_CONVERSATION_CONFLICT' });
        }
        return { persisted: true, version: 2, taskState: {} };
      },
    },
  });

  const result = await router.route({
    internalUserId: 7, conversationId: 'conv', messageRef: 'conflict-retry',
    question: '查询', runtime: 'hermes', proposal: chatProposal('查询'),
  });

  assert.equal(result.decision, 'clarify');
  assert.match(result.interaction.text, /保险公司/u);
  assert.equal(loads, 2);
  assert.equal(resolves, 2);
  assert.equal(saves, 2);
  assert.equal(calls.length, 0);
});

test('non-conflict clarification save failure returns stable retry without a second attempt', async () => {
  let loads = 0;
  let saves = 0;
  const { router, calls } = wrapperHarness({
    semanticResolver: { async resolve() { return {
      decision: 'clarify', decisionReason: 'product_required', missingFields: ['product'],
      ambiguities: [], candidate: null, resolvedEntities: {}, proposal: chatProposal('查询'),
      nextTaskState: { activeIntent: 'chat' },
    }; } },
    conversationService: {
      async load() { loads += 1; return { version: 0, taskState: {} }; },
      async save() { saves += 1; throw Object.assign(new Error('disk'), { code: 'SQLITE_IOERR' }); },
    },
  });

  const result = await router.route({
    internalUserId: 7, conversationId: 'conv', messageRef: 'save-error',
    question: '查询', runtime: 'hermes', proposal: chatProposal('查询'),
  });

  assert.deepEqual(result, {
    decision: 'clarify',
    interaction: { type: 'clarification', text: '语义解析暂不可用，请稍后重试。' },
  });
  assert.equal(loads, 1);
  assert.equal(saves, 1);
  assert.equal(calls.length, 0);
});

test('post-execute persistence hook receives redacted conflict classification', async () => {
  for (const [code, conflict] of [
    ['AGENT_SEMANTIC_CONVERSATION_CONFLICT', true],
    ['SQLITE_IOERR', false],
  ]) {
    const persistenceErrors = [];
    const legacyCalls = [];
    const router = createAgentSemanticQuestionRouter({
      legacyRouter: { async route(input) {
        legacyCalls.push(input);
        return { decision: 'execute', interaction: { type: 'answer', text: 'ok' } };
      } },
      semanticResolver: { async resolve() { return {
        decision: 'execute', proposal: chatProposal('你好'), resolvedEntities: {},
        candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read' },
        nextTaskState: { activeIntent: 'chat' },
      }; } },
      conversationService: {
        async load() { return { version: 0, taskState: {} }; },
        async save() { throw Object.assign(new Error('private database path'), { code }); },
      },
      auditService: { async record() {} },
      onPersistenceError(input) { persistenceErrors.push(input); },
    });

    const result = await router.route({
      internalUserId: 7, conversationId: 'conv', messageRef: `hook-${code}`,
      question: '你好', runtime: 'hermes', proposal: chatProposal('你好'),
    });
    assert.equal(result.interaction.text, 'ok');
    assert.equal(legacyCalls.length, 1);
    assert.deepEqual(persistenceErrors, [{ code, conflict, phase: 'post_execute' }]);
    assert.doesNotMatch(JSON.stringify(persistenceErrors), /private database path/u);
  }
});
