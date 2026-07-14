import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentQuestionRouter, simulateAgentQuestionDecision } from '../server/agent-question-router.service.mjs';
import { createAgentQuestionHandlers } from '../server/agent-question-handlers.service.mjs';

const NOW = '2026-07-12T08:00:00.000Z';

function createHarness({ families = [], policies = [], published = null, handlers = {}, familyResolver } = {}) {
  const calls = { audits: [], unknown: [], handlers: [] };
  const wrappedHandlers = Object.fromEntries(Object.entries(handlers).map(([key, handler]) => [
    key,
    async (input) => {
      calls.handlers.push({ key, input });
      return handler(input);
    },
  ]));
  const store = {
    async load() { return { familyProfiles: families, policies }; },
    async getPublishedAgentQuestionPolicyVersion() { return published; },
    async appendAgentUnknownQuestion(input) { calls.unknown.push(input); },
    async appendAgentRouteAuditEvent(input) { calls.audits.push(input); },
    async recordAgentRouteAudit(input) { calls.audits.push(input); },
  };
  return {
    calls,
    store,
    router: createAgentQuestionRouter({ store, handlers: wrappedHandlers, familyResolver, clock: () => new Date(NOW) }),
  };
}

test('published execute-write policy is confirmation-only in route and simulation', async () => {
  const writePolicy = { key: 'write-now', intent: 'write_now', decision: 'execute', handler: 'system', operation: 'write', confirmation: 'required', outputMode: 'preview', tool: 'propose_memory' };
  const harness = createHarness({ published: { version: 50, status: 'published', policies: [writePolicy] }, handlers: { system: async () => ({ interaction: { type: 'answer', text: 'must not run' } }) } });
  const candidate = { intent: 'write_now', requestedOperation: 'write', confidence: 1 };
  const routed = await harness.router.route(routeInput(candidate));
  const simulated = await simulateAgentQuestionDecision({ store: harness.store, internalUserId: 7, candidate });
  assert.equal(routed.decision, 'confirm');
  assert.equal(simulated.decision, 'confirm');
  assert.equal(simulated.result, 'write_preview');
  assert.equal(harness.calls.handlers.length, 0);
});

test('route and simulation share read and low-confidence execution decisions', async () => {
  const harness = createHarness({ published: { version: 51, status: 'published', policies: [readPolicy] }, families: [{ id: 11, ownerUserId: 7, familyName: '张三家庭', status: 'active' }], handlers: { insurance_expert: async () => ({ interaction: { type: 'answer', text: 'ok' } }) } });
  for (const confidence of [0.6, 1]) {
    const candidate = routeInput({ confidence }).candidate;
    const routed = await harness.router.route(routeInput({ confidence }, { messageRef: `msg-${confidence}` }));
    const simulated = await simulateAgentQuestionDecision({ store: harness.store, internalUserId: 7, candidate });
    assert.equal(simulated.decision, routed.decision);
  }
});

const readPolicy = {
  key: 'family_summary',
  intent: 'family_summary',
  decision: 'execute',
  handler: 'insurance_expert',
  operation: 'read',
  confirmation: 'not_required',
  outputMode: 'structured',
  tool: 'family_summary',
  confidenceThreshold: 0.7,
};

function routeInput(candidate, overrides = {}) {
  return {
    internalUserId: 7,
    messageRef: 'msg-1',
    candidate: {
      intent: 'family_summary',
      question: '查看张三家庭摘要',
      entities: { familyName: '张三家庭' },
      contextRefs: [],
      confidence: 0.95,
      requestedOperation: 'read',
      ...candidate,
    },
    ...overrides,
  };
}

test('a unique authorized family executes without listing other families', async () => {
  const { router, calls } = createHarness({
    families: [
      { id: 11, ownerUserId: 7, familyName: '张三家庭', status: 'active' },
      { id: 12, ownerUserId: 7, familyName: '李四家庭', status: 'active' },
    ],
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer', text: 'ok' } }) },
  });

  const result = await router.route(routeInput({ familyId: 12, permission: 'admin' }));

  assert.equal(result.decision, 'execute');
  assert.equal(calls.handlers[0].input.familyId, 11);
  assert.equal(JSON.stringify(calls.handlers[0].input).includes('李四家庭'), false);
  assert.deepEqual(Object.keys(calls.handlers[0].input).sort(), ['familyId', 'intent', 'internalUserId', 'question']);
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].policySource, 'built_in');
});

test('semantic product context is projected only when it matches the routed candidate', async () => {
  const { router, calls } = createHarness({
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer', text: 'ok' } }) },
  });
  const product = {
    canonicalProductId: 'product-1',
    company: '新华人寿保险股份有限公司',
    officialName: '康健无忧两全保险',
  };
  const base = routeInput({
    intent: 'insurance_product_knowledge', question: '主要保什么', entities: {
      productName: product.officialName,
      productCompany: product.company,
      productCanonicalId: product.canonicalProductId,
    },
  });

  await router.route({
    ...base,
    semanticContext: { resolvedEntities: { product }, queryAspects: ['main_responsibilities', 'not_allowed'] },
  });
  const mismatch = await router.route({
    ...base,
    messageRef: 'product-mismatch',
    semanticContext: { resolvedEntities: { product: { ...product, officialName: '另一产品' } }, queryAspects: ['renewal'] },
  });
  const missingCandidateId = await router.route({
    ...base,
    messageRef: 'product-id-missing',
    candidate: {
      ...base.candidate,
      entities: {
        productName: product.officialName,
        productCompany: product.company,
      },
    },
    semanticContext: { resolvedEntities: { product }, queryAspects: ['renewal'] },
  });

  assert.deepEqual(calls.handlers[0].input.resolvedProduct, product);
  assert.deepEqual(calls.handlers[0].input.queryAspects, ['main_responsibilities']);
  assert.equal(mismatch.decision, 'deny');
  assert.equal(missingCandidateId.decision, 'deny');
  assert.equal(calls.handlers.length, 1);
});

test('semantic family ids never bypass the legacy authorized family resolution', async () => {
  const { router, calls } = createHarness({
    families: [
      { id: 71, ownerUserId: 7, familyName: '本人家庭', status: 'active' },
      { id: 99, ownerUserId: 8, familyName: '他人家庭', status: 'active' },
    ],
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer', text: 'ok' } }) },
  });

  await router.route({
    ...routeInput({ entities: { familyName: '本人家庭' } }),
    semanticContext: {
      resolvedEntities: { family: { familyId: 99, displayName: '他人家庭' } },
      queryAspects: ['family_overview'],
    },
  });

  assert.equal(calls.handlers[0].input.familyId, 71);
  assert.equal(JSON.stringify(calls.handlers[0].input).includes('99'), false);
});

test('duplicate names clarify with matching candidates only', async () => {
  const { router } = createHarness({ families: [
    { id: 21, ownerUserId: 7, familyName: '张三家庭', status: 'active' },
    { id: 22, ownerUserId: 7, familyName: '张三家庭', status: 'active' },
    { id: 23, ownerUserId: 7, familyName: '李四家庭', status: 'active' },
  ] });

  const result = await router.route(routeInput({}));

  assert.equal(result.decision, 'clarify');
  assert.equal(result.interaction.type, 'clarification');
  assert.equal(result.interaction.candidates.length, 2);
  assert.equal(JSON.stringify(result).includes('李四'), false);
  assert.equal(JSON.stringify(result).includes('张三家庭'), false);
  assert.deepEqual(Object.keys(result.interaction.candidates[0]).sort(), ['label', 'ref']);
  assert.notEqual(result.interaction.candidates[0].label, result.interaction.candidates[1].label);
  assert.notEqual(result.interaction.candidates[0].ref, result.interaction.candidates[1].ref);
  assert.doesNotMatch(result.interaction.candidates[0].ref, /21|22/);
});

test('missing or unauthorized family gives the same non-disclosing clarification', async () => {
  const families = [{ id: 31, ownerUserId: 8, familyName: '秘密家庭', status: 'active' }];
  const { router } = createHarness({ families });
  const unauthorized = await router.route(routeInput({ question: '查看秘密家庭', entities: { familyName: '秘密家庭' } }));
  const absent = await router.route(routeInput({ question: '查看不存在家庭', entities: { familyName: '不存在家庭' } }));

  assert.deepEqual(unauthorized, absent);
  assert.equal(JSON.stringify(unauthorized).includes('秘密家庭'), false);
});

test('published confidence threshold causes clarification and is audited', async () => {
  const { router, calls } = createHarness({
    families: [{ id: 11, ownerUserId: 7, familyName: '张三家庭', status: 'active' }],
    published: { version: 4, policies: [readPolicy] },
  });

  const result = await router.route(routeInput({ confidence: 0.69 }));

  assert.equal(result.decision, 'clarify');
  assert.equal(result.interaction.type, 'clarification');
  assert.equal(calls.audits.length, 1);
  assert.equal(calls.audits[0].policyVersion, 4);
});

test('disabled published policy falls back safely without calling its handler', async () => {
  const { router, calls } = createHarness({
    families: [{ id: 11, ownerUserId: 7, familyName: '张三家庭', status: 'active' }],
    published: { version: 5, policies: [{ ...readPolicy, enabled: false }] },
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer' } }) },
  });

  const result = await router.route(routeInput({}));

  assert.equal(result.decision, 'open_web');
  assert.equal(result.interaction.type, 'secure_link');
  assert.equal(calls.handlers.length, 0);
});

test('confirmed unexpired pronoun context is reauthorized and executes', async () => {
  const { router, calls } = createHarness({
    families: [{ id: 41, ownerUserId: 7, familyName: '王家', status: 'active' }],
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer' } }) },
  });
  const result = await router.route(routeInput(
    { question: '查看这个家庭', entities: {} },
    { conversationContext: { familyId: 41, explicitlyConfirmed: true, expiresAt: '2026-07-12T08:05:00.000Z' } },
  ));

  assert.equal(result.decision, 'execute');
  assert.equal(calls.handlers[0].input.familyId, 41);
});

test('expired or unauthorized pronoun context clarifies without disclosure', async () => {
  const families = [{ id: 41, ownerUserId: 7, familyName: '王家', status: 'active' }];
  const { router, calls } = createHarness({ families, handlers: { insurance_expert: async () => ({}) } });
  const expired = await router.route(routeInput(
    { question: '查看刚才那家', entities: {} },
    { conversationContext: { familyId: 41, explicitlyConfirmed: true, expiresAt: '2026-07-12T07:59:59.000Z' } },
  ));
  const switched = await router.route(routeInput(
    { question: '查看这个家庭', entities: {} },
    { conversationContext: { familyId: 99, explicitlyConfirmed: true, expiresAt: '2026-07-12T08:05:00.000Z' } },
  ));

  assert.equal(expired.decision, 'clarify');
  assert.deepEqual(expired, switched);
  assert.equal(calls.handlers.length, 0);
});

test('unknown write is denied, recorded, and never invokes a handler', async () => {
  const { router, calls } = createHarness({ handlers: {
    system: async () => ({ interaction: { type: 'answer' } }),
  } });
  const result = await router.route(routeInput({
    intent: 'delete_everything',
    question: '删除资料',
    entities: {},
    requestedOperation: 'write',
  }));

  assert.equal(result.decision, 'deny');
  assert.equal(result.interaction.type, 'denied');
  assert.equal(calls.handlers.length, 0);
  assert.equal(calls.unknown.length, 1);
  assert.equal(calls.unknown[0].question, '删除资料');
});

test('candidate fields and lengths are bounded before reaching handlers', async () => {
  const { router, calls } = createHarness({
    handlers: { sales_champion: async () => ({ interaction: { type: 'answer' } }) },
  });
  await router.route(routeInput({
    intent: 'chat',
    question: '问'.repeat(5000),
    entities: { topic: '字'.repeat(2000), ignored: { nested: true } },
    contextRefs: Array.from({ length: 100 }, (_, index) => `ref-${index}`),
    requestedOperation: 'read',
  }));

  const normalized = calls.handlers[0].input;
  assert.ok(normalized.question.length <= 1000);
  assert.deepEqual(Object.keys(normalized).sort(), ['intent', 'internalUserId', 'question']);
});

test('every built-in finish path records a redacted audit contract', async () => {
  const { router, calls } = createHarness({ handlers: {
    sales_champion: async () => ({ interaction: { type: 'answer', text: 'ok' } }),
  } });
  await router.route(routeInput({
    intent: 'chat',
    question: '身份证 310000000000000000',
    entities: { personName: '张三', secret: '310000000000000000' },
  }));
  await router.route(routeInput({ intent: 'missing', question: '未知查询', entities: {} }));

  assert.equal(calls.audits.length, 2);
  for (const audit of calls.audits) {
    assert.equal(audit.policyVersion, null);
    assert.equal(audit.policySource, 'built_in');
    assert.equal(typeof audit.candidate.intent, 'string');
    assert.equal(typeof audit.candidate.confidence, 'number');
    assert.equal(Array.isArray(audit.authorizedResourceIds), true);
    assert.equal(JSON.stringify(audit).includes('310000000000000000'), false);
    assert.equal(['execute', 'open_web'].includes(audit.decision), true);
  }
});

test('low confidence non-family questions ask for intent instead of a family', async () => {
  const { router } = createHarness({
    published: { version: 8, policies: [{
      key: 'chat', intent: 'chat', decision: 'execute', handler: 'sales_champion', operation: 'read',
      confirmation: 'not_required', outputMode: 'direct', tool: null, confidenceThreshold: 0.8,
    }] },
  });
  const result = await router.route(routeInput({ intent: 'chat', question: '你好', entities: {}, confidence: 0.2 }));

  assert.equal(result.decision, 'clarify');
  assert.doesNotMatch(result.interaction.text, /家庭/u);
});

test('configured read deny is audited but not recorded as unknown write', async () => {
  const { router, calls } = createHarness({ published: { version: 9, policies: [{
    key: 'blocked_read', intent: 'blocked_read', decision: 'reject', handler: 'system', operation: 'read',
    confirmation: 'not_required', outputMode: 'direct', tool: null,
  }] } });
  const result = await router.route(routeInput({ intent: 'blocked_read', question: '受控查询', entities: {} }));

  assert.equal(result.decision, 'deny');
  assert.equal(calls.unknown.length, 0);
  assert.equal(calls.audits[0].operation, 'read');
  assert.equal(calls.audits[0].result, 'policy_rejected');
});

test('disabled or invalid published writes cannot be disguised as Hermes reads', async () => {
  const writePolicy = {
    key: 'memory_proposal', intent: 'memory_proposal', decision: 'propose', handler: 'sales_champion',
    operation: 'write', confirmation: 'required', outputMode: 'preview', tool: 'propose_memory',
  };
  for (const policy of [
    { ...writePolicy, enabled: false },
    { ...writePolicy, tool: 'shell' },
  ]) {
    const { router, calls } = createHarness({
      published: { version: 11, policies: [policy] },
      handlers: { sales_champion: async () => ({ interaction: { type: 'answer' } }) },
    });
    const result = await router.route(routeInput({
      intent: 'memory_proposal',
      question: '保存这条记忆',
      entities: {},
      requestedOperation: 'read',
    }));

    assert.equal(result.decision, 'deny');
    assert.equal(result.interaction.type, 'denied');
    assert.equal(calls.handlers.length, 0);
    assert.equal(calls.unknown.length, 1);
    assert.equal(calls.audits[0].policySource, 'built_in');
    assert.equal(calls.audits[0].policyVersion, null);
    assert.equal(calls.audits[0].operation, 'write');
    assert.equal(calls.audits[0].policyKey, 'unknown_write');
  }
});

test('an approximate family-name match requires opaque selection before execution', async () => {
  const { router, calls } = createHarness({
    families: [
      { id: 51, ownerUserId: 7, familyName: '张三丰家庭', status: 'active' },
      { id: 52, ownerUserId: 7, familyName: '李四家庭', status: 'active' },
    ],
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer' } }) },
  });
  const result = await router.route(routeInput({ question: '查看张三', entities: { familyName: '张三' } }));

  assert.equal(result.decision, 'clarify');
  assert.equal(result.interaction.candidates.length, 1);
  assert.equal(JSON.stringify(result).includes('张三丰'), false);
  assert.equal(calls.handlers.length, 0);
  const selected = await router.route(routeInput({ entities: { familyRef: result.interaction.candidates[0].ref } }));
  assert.equal(selected.decision, 'execute');
  assert.equal(calls.handlers[0].input.familyId, 51);
});

test('truncated approximate collisions disclose no family names and never execute', async () => {
  const { router, calls } = createHarness({ families: [
    { id: 53, ownerUserId: 7, familyName: '欧阳明珠家庭', status: 'active' },
    { id: 54, ownerUserId: 7, familyName: '欧阳明月家庭', status: 'active' },
  ] });
  const result = await router.route(routeInput({ question: '查看欧阳明', entities: { familyName: '欧阳明' } }));

  assert.equal(result.decision, 'clarify');
  assert.equal(result.interaction.candidates.length, 2);
  assert.equal(JSON.stringify(result).includes('欧阳'), false);
  assert.equal(calls.handlers.length, 0);
});

test('default authorization includes policy-linked families and injected resolver is honored', async () => {
  const linked = createHarness({
    families: [{ id: 61, ownerUserId: null, familyName: '保单关联家庭', status: 'active' }],
    policies: [{ id: 1, userId: 7, familyId: 61 }],
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer' } }) },
  });
  const injected = createHarness({
    families: [{ id: 62, ownerUserId: 99, familyName: '注入授权家庭', status: 'active' }],
    familyResolver: async ({ state }) => state.familyProfiles,
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer' } }) },
  });

  assert.equal((await linked.router.route(routeInput({ entities: { familyName: '保单关联家庭' } }))).decision, 'execute');
  assert.equal((await injected.router.route(routeInput({ entities: { familyName: '注入授权家庭' } }))).decision, 'execute');
});

test('opaque family candidate selection is reauthorized before execution', async () => {
  const families = [
    { id: 71, ownerUserId: 7, familyName: '同名家庭', status: 'active' },
    { id: 72, ownerUserId: 7, familyName: '同名家庭', status: 'active' },
  ];
  const harness = createHarness({
    families,
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer' } }) },
  });
  const clarified = await harness.router.route(routeInput({ entities: { familyName: '同名家庭' } }));
  const selectedRef = clarified.interaction.candidates[0].ref;
  const authorized = await harness.router.route(routeInput({ entities: { familyRef: selectedRef } }));
  assert.equal(authorized.decision, 'execute');
  families[0].ownerUserId = 99;
  const selected = await harness.router.route(routeInput({ entities: { familyRef: selectedRef } }));

  assert.equal(selected.decision, 'clarify');
  assert.equal(harness.calls.handlers.length, 1);
});

test('missing handler and unknown tool fail safely', async () => {
  const families = [{ id: 11, ownerUserId: 7, familyName: '张三家庭', status: 'active' }];
  const missing = createHarness({ families, published: { version: 6, policies: [readPolicy] } });
  const unknownTool = createHarness({
    families,
    published: { version: 7, policies: [{ ...readPolicy, tool: 'shell' }] },
    handlers: { insurance_expert: async () => ({ interaction: { type: 'answer' } }) },
  });

  assert.equal((await missing.router.route(routeInput({}))).decision, 'deny');
  assert.equal((await unknownTool.router.route(routeInput({}))).decision, 'open_web');
  assert.equal(unknownTool.calls.handlers.length, 0);
});

test('all router outputs stay within public interaction and decision enums', async () => {
  const allowedInteractions = new Set(['answer', 'clarification', 'confirmation', 'progress', 'secure_link', 'denied']);
  const allowedDecisions = new Set(['execute', 'clarify', 'confirm', 'deny', 'open_web']);
  const { router } = createHarness({ handlers: {
    system: async () => ({ decision: 'root', interaction: { type: 'unsafe' } }),
  } });
  const results = [
    await router.route(routeInput({ intent: 'chat', entities: {} })),
    await router.route(routeInput({ intent: 'missing', requestedOperation: 'write', entities: {} })),
  ];

  for (const result of results) {
    assert.equal(allowedInteractions.has(result.interaction.type), true);
    assert.equal(allowedDecisions.has(result.decision), true);
  }
});

test('transfer preview invokes its authorized preview handler while other writes remain side-effect free', async () => {
  const calls = [];
  const { router } = createHarness({ handlers: {
    system: async (input) => {
      calls.push(input);
      return { interaction: { type: 'confirmation', confirmationId: 'cfm-1', summary: '转移保单尾号 1234', options: [{ id: 'confirm', label: '确认' }] } };
    },
  } });
  const transfer = await router.route(routeInput({
    intent: 'transfer_preview', requestedOperation: 'write',
    entities: { sourceFamilyName: '来源家庭', targetFamilyName: '目标家庭', policyHint: 'PX-1234' },
  }));
  assert.equal(transfer.decision, 'confirm');
  assert.equal(transfer.interaction.confirmationId, 'cfm-1');
  assert.equal(calls.length, 1);

  await router.route(routeInput({ intent: 'memory_proposal', requestedOperation: 'write', entities: {} }));
  assert.equal(calls.length, 1);
});

test('sales coaching resolves an authorized family before calling the existing sales chat flow', async () => {
  const families = [{ id: 11, ownerUserId: 7, familyName: '张三家庭', status: 'active' }];
  const state = { familyProfiles: families, familyMembers: [], policies: [], familyReports: [], familySalesReviews: [] };
  const calls = [];
  const store = {
    async load() { return state; },
    async getPublishedAgentQuestionPolicyVersion() { return null; },
    async recordAgentRouteAudit() {},
  };
  const handlers = createAgentQuestionHandlers({
    store,
    authorizedFamilyDataLoader: async ({ familyId }) => ({ family: families[0], state }),
    authorizedFamilySalesDataLoader: async ({ familyId }) => ({ family: families[0], members: [], policies: [], familyReports: [], familySalesReviews: [], history: [], input: { familyId } }),
    buildFamilySalesChatContext: (input) => ({ familyId: input.family.id }),
    generateFamilySalesChatReply: async (input) => { calls.push(input); return { content: '现有续聊回答' }; },
  });
  const router = createAgentQuestionRouter({ store, handlers });

  const answered = await router.route(routeInput({ intent: 'sales_coaching', question: '张三家庭怎么继续沟通' }));
  const emptyStore = {
    async load() { return { familyProfiles: [], policies: [] }; },
    async getPublishedAgentQuestionPolicyVersion() { return null; },
    async recordAgentRouteAudit() {},
  };
  const missing = await createAgentQuestionRouter({ store: emptyStore, handlers }).route(
    routeInput({ intent: 'sales_coaching', question: '怎么继续沟通', entities: {} }),
  );

  assert.equal(answered.decision, 'execute');
  assert.equal(calls[0].context.familyId, 11);
  assert.equal(missing.decision, 'clarify');
});
