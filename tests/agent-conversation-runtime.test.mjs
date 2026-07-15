import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentConversationRuntime } from '../server/agent-conversation-runtime.service.mjs';
import { createHermesConversationClient } from '../server/hermes-conversation-client.service.mjs';

function createMemoryContext() {
  const rows = new Map();
  const key = (input) => [input.tenantId, input.channel, input.channelUserId, input.internalUserId, input.channelConversationId].join(':');
  return {
    rows,
    async loadContext(input) {
      return structuredClone(rows.get(key(input)) || {
        conversationId: `ref-${key(input)}`, version: 1, hermesSessionId: '', agentLoopSessionId: '', history: [],
        product: null, productCandidates: null, question: null,
      });
    },
    async commitContext(input) {
      const row = {
        conversationId: input.conversationRef,
        version: input.expectedVersion + 1,
        hermesSessionId: input.hermesSessionId,
        agentLoopSessionId: input.agentLoopSessionId,
        history: input.history,
        product: input.product,
        productCandidates: input.productCandidates,
        question: input.question,
      };
      rows.set(key(input), structuredClone(row));
      return row;
    },
  };
}

function envelope(channelUserId, conversationId, messageRef, text) {
  return {
    verifiedIdentity: { tenantId: 'default', internalUserId: channelUserId === 'ding-a' ? 7 : 8 },
    channelEnvelope: {
      channel: 'dingtalk', channelUserId, conversationId, messageRef,
      message: { type: 'text', text },
    },
    runtimeSettings: { fallbackHistoryMessageLimit: 6, productContextTtlMinutes: 30 },
    refreshVerifiedIdentity: async () => ({ internalUserId: channelUserId === 'ding-a' ? 7 : 8 }),
  };
}

test('Hermes CLI client uses strict JSON, resumes the same session, and redacts direct identifiers', async () => {
  const calls = [];
  const client = createHermesConversationClient({
    command: '/fake/hermes',
    env: { HOME: '/tmp' },
    execFile(command, args, options, callback) {
      calls.push({ command, args, options });
      callback(null, JSON.stringify({
        intent: 'coverage_report', question: 'ignored', confidence: 0.95,
        requestedOperation: null, entities: { productBText: '医药安欣' }, contextRefs: ['previous_product'],
      }), '\nsession_id: hermes-session-a\n');
    },
  });
  const first = await client.runTurn({
    question: '他和医药安欣对比呢，手机号13800138000',
    safeRecentContext: { history: [{ role: 'user', content: '身份证110101199001011234' }] },
  });
  assert.equal(first.sessionId, 'hermes-session-a');
  assert.equal(first.candidate.requestedOperation, 'read');
  assert.equal(first.candidate.intent, 'insurance_product_knowledge');
  assert.equal(first.candidate.question, '他和医药安欣对比呢，手机号13800138000');
  const prompt = calls[0].args[calls[0].args.indexOf('-q') + 1];
  assert.doesNotMatch(prompt, /13800138000|110101199001011234/u);
  assert.match(prompt, /手机号已脱敏|身份证号已脱敏/u);
  assert.match(prompt, /保险专业问题.*insurance_product_knowledge.*不得归入 chat/u);
  assert.match(prompt, /销售专业问题.*sales_coaching.*不得归入 chat/u);
  assert.match(prompt, /chat 只用于不需要保险知识或销售判断/u);
  await client.runTurn({ sessionId: first.sessionId, question: '继续', safeRecentContext: {} });
  assert.deepEqual(calls[1].args.slice(-2), ['--resume', 'hermes-session-a']);
  assert.equal(calls[0].options.timeout, 30_000);
});

test('Hermes CLI client opens a short circuit after repeated provider failures', async () => {
  let calls = 0;
  let currentTime = 1_720_000_000_000;
  const client = createHermesConversationClient({
    command: '/fake/hermes',
    env: { HOME: '/tmp' },
    now: () => currentTime,
    execFile(_command, _args, _options, callback) {
      calls += 1;
      callback(new Error('offline'), '', '');
    },
  });
  for (let index = 0; index < 5; index += 1) {
    await assert.rejects(client.runTurn({ question: '你好' }), (error) => error?.code === 'HERMES_PROVIDER_FAILED');
  }
  await assert.rejects(client.runTurn({ question: '你好' }), (error) => error?.code === 'HERMES_CIRCUIT_OPEN');
  assert.equal(calls, 5);
  currentTime += 30_000;
  await assert.rejects(client.runTurn({ question: '你好' }), (error) => error?.code === 'HERMES_PROVIDER_FAILED');
  assert.equal(calls, 6);
});

test('Hermes CLI client reports a missing resumed session without opening the provider circuit', async () => {
  let calls = 0;
  const client = createHermesConversationClient({
    command: '/fake/hermes',
    env: { HOME: '/tmp' },
    failureThreshold: 1,
    execFile(_command, _args, _options, callback) {
      calls += 1;
      if (calls === 1) {
        callback(new Error('exit 1'), '', 'Session not found: stale-session');
        return;
      }
      callback(null, JSON.stringify({
        intent: 'chat', question: 'ignored', confidence: 1,
        requestedOperation: 'read', entities: {}, contextRefs: [],
      }), '\nsession_id: fresh-session\n');
    },
  });

  await assert.rejects(
    client.runTurn({ sessionId: 'stale-session', question: '你好' }),
    (error) => error?.code === 'HERMES_SESSION_NOT_FOUND',
  );
  const result = await client.runTurn({ question: '你好' });
  assert.equal(result.sessionId, 'fresh-session');
  assert.equal(calls, 2);
});

test('Hermes CLI client distinguishes timeout and missing executable failures', async () => {
  const timeoutClient = createHermesConversationClient({
    command: '/fake/hermes', env: { HOME: '/tmp' },
    execFile(_command, _args, _options, callback) {
      callback(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }), '', '');
    },
  });
  await assert.rejects(
    timeoutClient.runTurn({ question: '尊享人生保险责任' }),
    (error) => error?.code === 'HERMES_TIMEOUT',
  );

  const unavailableClient = createHermesConversationClient({
    command: '/missing/hermes', env: { HOME: '/tmp' },
    execFile(_command, _args, _options, callback) {
      callback(Object.assign(new Error('not found'), { code: 'ENOENT' }), '', '');
    },
  });
  await assert.rejects(
    unavailableClient.runTurn({ question: '尊享人生保险责任' }),
    (error) => error?.code === 'HERMES_CLI_UNAVAILABLE',
  );
});

test('Hermes CLI client accepts the strict semantic proposal contract', async () => {
  const question = '新华人寿康健无忧两全保险主要保什么';
  const client = createHermesConversationClient({
    command: '/fake/hermes',
    env: { HOME: '/tmp' },
    execFile(_command, _args, _options, callback) {
      callback(null, JSON.stringify({
        semanticContractVersion: 1,
        intent: 'insurance_product_knowledge',
        operation: 'read',
        queryAspects: ['main_responsibilities'],
        mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
        references: [],
        requestedSteps: ['lookup'],
        confidence: { intent: 0.99, mentions: 0.98, references: 1 },
      }), '\nsession_id: hermes-semantic-a\n');
    },
  });

  const result = await client.runTurn({ question });

  assert.equal(result.sessionId, 'hermes-semantic-a');
  assert.equal(result.proposal.intent, 'insurance_product_knowledge');
  assert.equal(result.candidate, undefined);
});

test('Hermes CLI client normalizes the unambiguous string semantic contract version', async () => {
  const question = '康健无忧两全保险主要保什么';
  const client = createHermesConversationClient({
    command: '/fake/hermes',
    env: { HOME: '/tmp' },
    execFile(_command, _args, _options, callback) {
      callback(null, JSON.stringify({
        semanticContractVersion: '1',
        intent: 'insurance_product_knowledge',
        operation: 'read',
        queryAspects: ['main_responsibilities'],
        mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
        references: [],
        requestedSteps: ['lookup'],
        confidence: { intent: 0.99, mentions: 0.98, references: 1 },
      }), '\nsession_id: hermes-semantic-string-version\n');
    },
  });

  const result = await client.runTurn({ question });

  assert.equal(result.proposal.semanticContractVersion, 1);
  assert.equal(result.proposal.intent, 'insurance_product_knowledge');
  assert.equal(result.candidate, undefined);
});

test('Hermes semantic proposal is routed through the semantic boundary', async () => {
  const context = createMemoryContext();
  const routed = [];
  const proposal = {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 1, mentions: 1, references: 1 },
  };
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() { return { sessionId: 'semantic-session', proposal }; } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已核验。' } };
    } },
    directInterpreter: async () => { throw new Error('must not use direct'); },
  });

  await runtime.processMessage(envelope('ding-a', 'semantic-conversation', 's-1', '康健无忧两全保险主要保什么'));
  await runtime.processMessage(envelope('ding-a', 'semantic-conversation', 's-2', '身体情况良好'));

  assert.equal(routed.length, 2);
  assert.equal(routed[0].runtime, 'hermes');
  assert.deepEqual(routed[0].proposal, proposal);
  assert.equal(routed[0].candidate, undefined);
  assert.deepEqual(routed[1].conversationHistory, [
    { role: 'user', content: '康健无忧两全保险主要保什么' },
    { role: 'assistant', content: '已核验。' },
  ]);
});

test('semantic Hermes takes precedence over the legacy Agent Loop so expert output is not rewritten', async () => {
  const context = createMemoryContext();
  const calls = { semantic: 0, loop: 0, route: 0 };
  const proposal = {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 1, mentions: 1, references: 1 },
  };
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() {
      calls.semantic += 1;
      return { sessionId: 'semantic-session', proposal };
    } },
    agentLoopClient: { async runTurn() {
      calls.loop += 1;
      return { sessionId: 'legacy-loop-session', finalReply: 'Hermes 二次摘要' };
    } },
    questionRouter: { async route() {
      calls.route += 1;
      return { decision: 'execute', interaction: { type: 'answer', text: '保险专家完整结果' } };
    } },
  });

  const result = await runtime.processMessage(envelope(
    'ding-a', 'semantic-over-loop', 'semantic-over-loop-1', '康健无忧两全保险主要保什么',
  ));

  assert.equal(result.interaction.text, '保险专家完整结果');
  assert.deepEqual(calls, { semantic: 1, loop: 0, route: 1 });
  assert.equal(result.runtime, 'hermes');
});

test('Hermes primary path resolves previous_product and keeps users isolated', async () => {
  const context = createMemoryContext();
  const hermesCalls = [];
  const routed = [];
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: {
      async runTurn(input) {
        hermesCalls.push(input);
        const productA = input.question.includes('甲产品') ? '甲产品' : input.question.includes('乙产品') ? '乙产品' : '';
        return productA
          ? { sessionId: `session-${productA}`, candidate: {
            intent: 'insurance_product_knowledge', question: input.question, confidence: 1,
            requestedOperation: 'read', entities: { productName: productA },
          } }
          : { sessionId: input.sessionId, candidate: {
            intent: 'insurance_product_knowledge', question: input.question, confidence: 0.96,
            requestedOperation: 'read', entities: { productBText: '医药安欣' }, contextRefs: ['previous_product'],
          } };
      },
    },
    questionRouter: {
      async route(input) {
        routed.push(input);
        const name = input.candidate.entities?.productName;
        return { decision: 'execute', interaction: { type: 'answer', text: name ? `公司《${name}》：已核验。` : '已完成对比。' } };
      },
    },
    directInterpreter: async () => { throw new Error('must not use direct'); },
    now: () => 1_720_000_000_000,
  });
  await runtime.processMessage(envelope('ding-a', 'same-conversation', 'a-1', '甲产品保险责任'));
  await runtime.processMessage(envelope('ding-b', 'same-conversation', 'b-1', '乙产品保险责任'));
  await runtime.processMessage(envelope('ding-a', 'same-conversation', 'a-2', '他和医药安欣对比呢'));
  await runtime.processMessage(envelope('ding-b', 'same-conversation', 'b-2', '他和医药安欣对比呢'));
  assert.equal(routed[2].candidate.question, '甲产品 对比 医药安欣');
  assert.equal(routed[3].candidate.question, '乙产品 对比 医药安欣');
  assert.equal(hermesCalls[2].sessionId, 'session-甲产品');
  assert.equal(hermesCalls[3].sessionId, 'session-乙产品');
  assert.doesNotMatch(JSON.stringify(hermesCalls[2].safeRecentContext), /乙产品/u);
  assert.doesNotMatch(JSON.stringify(hermesCalls[3].safeRecentContext), /甲产品/u);
});

test('Agent Loop receives the previous verified product as structured active context', async () => {
  const context = createMemoryContext();
  const firstRuntime = createAgentConversationRuntime({
    conversationContext: context,
    runtimeMode: 'direct',
    directInterpreter: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1,
      requestedOperation: 'read', entities: { productName: '荣耀鑫享终身寿险' },
    }),
    questionRouter: { async route() {
      return {
        decision: 'execute',
        interaction: { type: 'answer', text: '新华保险《新华人寿保险股份有限公司荣耀鑫享终身寿险》：已核验。' },
      };
    } },
  });
  await firstRuntime.processMessage(envelope(
    'ding-a', 'elliptical-comparison', 'ellipsis-1', '荣耀鑫享终身寿险保险责任',
  ));

  const agentLoopCalls = [];
  const secondRuntime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn(input) {
      agentLoopCalls.push(input);
      return { sessionId: 'context-aware-agent', finalReply: '已按上下文完成产品对比。' };
    } },
    toolCapabilityService: { inspect() { return { callCount: 1 }; } },
    directInterpreter: async () => { throw new Error('offline'); },
    questionRouter: { async route() { throw new Error('Agent Loop should use the insurance expert tool'); } },
  });
  const result = await secondRuntime.processMessage({
    ...envelope('ding-a', 'elliptical-comparison', 'ellipsis-2', '和 荣耀鑫享赢家版对比呢'),
    toolCapability: 'opaque-capability',
  });

  assert.equal(result.interaction.text, '已按上下文完成产品对比。');
  assert.equal(agentLoopCalls.length, 1);
  assert.deepEqual(agentLoopCalls[0].safeRecentContext.activeEntities, {
    product: { officialName: '新华人寿保险股份有限公司荣耀鑫享终身寿险' },
  });
});

test('explicit Direct mode binds an omitted product role from verified conversation context', async () => {
  const context = createMemoryContext();
  context.rows.set('default:dingtalk:ding-a:7:contextual-direct', {
    conversationId: 'contextual-direct-ref',
    version: 1,
    hermesSessionId: '',
    agentLoopSessionId: '',
    history: [
      { role: 'user', content: '荣耀鑫享终身寿险保险责任' },
      { role: 'assistant', content: '新华保险《新华人寿保险股份有限公司荣耀鑫享终身寿险》：已核验。' },
    ],
    product: null,
    productCandidates: null,
    question: null,
  });
  const routed = [];
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    runtimeMode: 'direct',
    directInterpreter: async () => ({
      semanticContractVersion: 1,
      intent: 'insurance_product_knowledge',
      operation: 'read',
      queryAspects: ['comparison'],
      mentions: [{ type: 'product', rawText: '荣耀鑫享赢家版' }],
      references: [
        { type: 'comparison_left', rawText: '' },
        { type: 'comparison_right', rawText: '荣耀鑫享赢家版' },
      ],
      requestedSteps: ['compare'],
      confidence: { intent: 1, mentions: 1, references: 1 },
    }),
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已完成两款产品对比。' } };
    } },
  });

  await runtime.processMessage(envelope(
    'ding-a', 'contextual-direct', 'contextual-direct-2', '和 荣耀鑫享赢家版对比呢',
  ));

  assert.equal(
    routed[0].question,
    '新华人寿保险股份有限公司荣耀鑫享终身寿险 和 荣耀鑫享赢家版对比呢',
  );
  assert.deepEqual(routed[0].proposal.mentions, [
    { type: 'product', rawText: '新华人寿保险股份有限公司荣耀鑫享终身寿险' },
    { type: 'product', rawText: '荣耀鑫享赢家版' },
  ]);
  assert.deepEqual(routed[0].proposal.references, [
    { type: 'comparison_right', rawText: '荣耀鑫享赢家版' },
  ]);
  assert.equal(
    context.rows.get('default:dingtalk:ding-a:7:contextual-direct').product.productName,
    '新华人寿保险股份有限公司荣耀鑫享终身寿险',
  );
});

test('Hermes provider failure returns unavailable without Direct fallback or routing', async () => {
  const context = createMemoryContext();
  let hermesCalls = 0;
  let directCalls = 0;
  let routeCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() {
      hermesCalls += 1;
      throw Object.assign(new Error('offline'), { code: 'HERMES_PROVIDER_FAILED' });
    } },
    directInterpreter: async ({ question }) => {
      directCalls += 1;
      return {
        intent: 'insurance_product_knowledge', question, confidence: 1,
        requestedOperation: 'read', entities: { productName: 'A产品' },
      };
    },
    questionRouter: { async route() {
      routeCalls += 1;
      return { decision: 'execute', interaction: { type: 'answer', text: '已通过安全降级核验。' } };
    } },
    now: () => 1_720_000_000_000,
  });
  const result = await runtime.processMessage(envelope('ding-a', 'retry-conversation', 'f-1', 'A产品保险责任'));
  assert.equal(hermesCalls, 2);
  assert.equal(directCalls, 0);
  assert.equal(routeCalls, 0);
  assert.equal(result.runtime, 'hermes');
  assert.equal(result.decision, 'deny');
  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
  assert.equal(context.rows.has('default:dingtalk:ding-a:7:retry-conversation'), false);
});

test('invalid Hermes output returns unavailable without calling another model', async () => {
  const context = createMemoryContext();
  let hermesCalls = 0;
  let directCalls = 0;
  const routed = [];
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() {
      hermesCalls += 1;
      throw Object.assign(new Error('invalid'), { code: 'HERMES_RESPONSE_INVALID' });
    } },
    directInterpreter: async () => { directCalls += 1; },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已核验。' } };
    } },
  });
  const result = await runtime.processMessage(envelope('ding-a', 'retry-success', 'f-2', 'A产品保险责任'));
  assert.equal(hermesCalls, 2);
  assert.equal(directCalls, 0);
  assert.equal(routed.length, 0);
  assert.equal(result.decision, 'deny');
  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
});

test('a transient Hermes failure retries once with a fresh session and succeeds', async () => {
  const context = createMemoryContext();
  context.rows.set('default:dingtalk:ding-a:7:transient-hermes', {
    conversationId: 'transient-hermes-ref', version: 1, hermesSessionId: 'stale-session', agentLoopSessionId: '',
    history: [], product: null, productCandidates: null, question: null,
  });
  const sessions = [];
  let routeCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn(input) {
      sessions.push(input.sessionId);
      if (sessions.length === 1) {
        throw Object.assign(new Error('temporary provider failure'), { code: 'HERMES_PROVIDER_FAILED' });
      }
      return { sessionId: 'fresh-session', candidate: {
        intent: 'insurance_product_knowledge', question: input.question, confidence: 1,
        requestedOperation: 'read', entities: { productName: '尊贵人生年金保险' },
      } };
    } },
    directInterpreter: async () => { throw new Error('must not use Direct after a successful retry'); },
    questionRouter: { async route() {
      routeCalls += 1;
      return { decision: 'execute', interaction: { type: 'answer', text: 'Hermes 重试后已核验。' } };
    } },
  });

  const result = await runtime.processMessage(envelope(
    'ding-a', 'transient-hermes', 'transient-1', '尊贵人生保险责任',
  ));

  assert.deepEqual(sessions, ['stale-session', '']);
  assert.equal(routeCalls, 1);
  assert.equal(result.runtime, 'hermes');
  assert.equal(context.rows.get('default:dingtalk:ding-a:7:transient-hermes').hermesSessionId, 'fresh-session');
});

test('missing Hermes client returns unavailable without Direct fallback', async () => {
  const context = createMemoryContext();
  const routed = [];
  let directCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    runtimeMode: 'hermes',
    directInterpreter: async () => {
      directCalls += 1;
      return ({
      semanticContractVersion: 1,
      intent: 'insurance_product_knowledge', operation: 'read',
      queryAspects: ['comparison'],
      mentions: [{ type: 'product', rawText: 'A产品' }], references: [], requestedSteps: ['compare'],
      confidence: { intent: 1, mentions: 1, references: 1 },
      });
    },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已核验。' } };
    } },
  });

  const result = await runtime.processMessage(envelope('ding-a', 'missing-hermes', 'f-3', 'A产品对比'));

  assert.equal(directCalls, 0);
  assert.equal(routed.length, 0);
  assert.equal(result.decision, 'deny');
  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
  assert.equal(context.rows.size, 0);
});

test('identity rebind during Hermes wait rejects before routing or context commit', async () => {
  const context = createMemoryContext();
  let routeCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() {
      return { sessionId: 'session-old', candidate: { intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read' } };
    } },
    questionRouter: { async route() { routeCalls += 1; return { decision: 'execute', interaction: { type: 'answer', text: 'ok' } }; } },
  });
  const input = envelope('ding-a', 'rebind', 'r-1', '你好');
  input.refreshVerifiedIdentity = async () => ({ internalUserId: 8 });
  await assert.rejects(runtime.processMessage(input), (error) => error?.code === 'AGENT_CONVERSATION_IDENTITY_CHANGED');
  assert.equal(routeCalls, 0);
  assert.equal(context.rows.size, 0);
});

test('Hermes Agent Loop returns its final reply without invoking the backend question router', async () => {
  const context = createMemoryContext();
  const calls = [];
  let routeCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn(input) {
      calls.push(input);
      return { sessionId: 'agent-session-1', finalReply: '计划一和计划二的区别如下。' };
    } },
    toolCapabilityService: { inspect() { return { callCount: 1 }; } },
    toolGatewayUrl: 'http://127.0.0.1:4207/api/agent/hermes-tools',
    questionRouter: { async route() { routeCalls += 1; } },
    directInterpreter: async () => { throw new Error('must not use direct'); },
  });
  const result = await runtime.processMessage({
    ...envelope('ding-a', 'agent-loop', 'loop-1', '医药安欣计划一计划二分别是啥'),
    toolCapability: 'opaque-capability',
  });
  assert.equal(result.interaction.text, '计划一和计划二的区别如下。');
  assert.equal(routeCalls, 0);
  assert.equal(calls[0].capability, 'opaque-capability');
  assert.equal(calls[0].gatewayUrl, 'http://127.0.0.1:4207/api/agent/hermes-tools');
  const stored = [...context.rows.values()][0];
  assert.equal(stored.agentLoopSessionId, 'agent-session-1');
});

test('Agent Loop zero-tool insurance output returns unavailable without Direct fallback', async () => {
  const context = createMemoryContext();
  const routed = [];
  const proposal = {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [{ type: 'product', rawText: '荣耀鑫享赢家版终身寿险' }],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 1, mentions: 1, references: 1 },
  };
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn() {
      return { sessionId: 'agent-session-zero-tool', finalReply: '仅包含一项身故责任。' };
    } },
    toolCapabilityService: { inspect() { return { callCount: 0, toolResults: [] }; } },
    directInterpreter: async () => proposal,
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '完整保险责任助手内容' } };
    } },
  });

  const result = await runtime.processMessage({
    ...envelope('ding-a', 'agent-loop-zero-tool', 'loop-zero-tool-1', '荣耀鑫享赢家版终身寿险保险责任'),
    toolCapability: 'opaque-capability',
  });

  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
  assert.equal(result.runtime, 'hermes');
  assert.equal(routed.length, 0);
  assert.equal(context.rows.size, 0);
});

test('Agent Loop zero-tool chat returns unavailable without Direct fallback', async () => {
  const context = createMemoryContext();
  const routed = [];
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn() {
      return { sessionId: 'agent-session-chat', finalReply: '你好，有什么可以帮你？' };
    } },
    toolCapabilityService: { inspect() { return { callCount: 0, toolResults: [] }; } },
    directInterpreter: async () => ({
      semanticContractVersion: 1,
      intent: 'chat', operation: 'read', queryAspects: [], mentions: [], references: [],
      requestedSteps: [], confidence: { intent: 1, mentions: 1, references: 1 },
    }),
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '销冠回复：你好。' } };
    } },
  });

  const result = await runtime.processMessage({
    ...envelope('ding-a', 'agent-loop-chat', 'loop-chat-1', '你好'),
    toolCapability: 'opaque-capability',
  });

  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
  assert.equal(result.runtime, 'hermes');
  assert.equal(routed.length, 0);
  assert.equal(context.rows.size, 0);
});

test('Hermes Agent Loop preserves a complete authoritative product answer instead of its lossy rewrite', async () => {
  const context = createMemoryContext();
  const authoritative = [
    '荣耀鑫享终身寿险的保险责任如下：',
    '### 责任明细（1项）',
    '1. **身故保险金**',
    '触发条件：被保险人身故',
    'calculationStatus: claim_contingent',
    '来源：src_1',
    '计算所需保单信息：基本保险金额',
  ].join('\n');
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn() {
      return { sessionId: 'agent-session-verbatim', finalReply: '身故时按合同约定给付。' };
    } },
    toolCapabilityService: { inspect() { return { callCount: 1, toolResults: [{
      tool: 'ask_insurance_expert',
      result: { status: 'ok', decision: 'execute', interaction: {
        type: 'answer', text: authoritative, delivery: 'verbatim',
      }, resolvedEntities: { product: {
        canonicalProductId: 'product-glory',
        company: '新华人寿保险股份有限公司',
        officialName: '新华人寿保险股份有限公司荣耀鑫享终身寿险',
      } } },
    }] }; } },
    toolGatewayUrl: 'http://127.0.0.1:4207/api/agent/hermes-tools',
    questionRouter: { async route() { throw new Error('must not route'); } },
  });

  const result = await runtime.processMessage({
    ...envelope('ding-a', 'agent-loop-verbatim', 'loop-verbatim-1', '荣耀鑫享终身寿险保险责任'),
    toolCapability: 'opaque-capability',
  });

  assert.equal(result.interaction.text, authoritative);
  const stored = [...context.rows.values()][0];
  assert.equal(stored.history.at(-1).content, authoritative);
  assert.equal(stored.product.productName, '新华人寿保险股份有限公司荣耀鑫享终身寿险');
});

test('Agent Loop never resumes a legacy Hermes classifier session', async () => {
  const context = createMemoryContext();
  const legacyRuntime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() {
      return { sessionId: 'legacy-classifier-session', candidate: {
        intent: 'chat', question: '你好', confidence: 1, requestedOperation: 'read',
      } };
    } },
    questionRouter: { async route() {
      return { decision: 'execute', interaction: { type: 'answer', text: '旧路径回复' } };
    } },
  });
  await legacyRuntime.processMessage(envelope('ding-a', 'session-migration', 'old-1', '你好'));

  const calls = [];
  const agentRuntime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn(input) {
      calls.push(input);
      return { sessionId: 'agent-loop-session', finalReply: '新路径回复' };
    } },
    toolCapabilityService: { inspect() { return { callCount: 1 }; } },
    toolGatewayUrl: 'http://127.0.0.1:4207/api/agent/hermes-tools',
    questionRouter: { async route() { throw new Error('must not route'); } },
  });
  await agentRuntime.processMessage({
    ...envelope('ding-a', 'session-migration', 'new-1', '继续'),
    toolCapability: 'opaque-capability',
  });

  assert.equal(calls[0].sessionId, '');
  const stored = [...context.rows.values()][0];
  assert.equal(stored.hermesSessionId, 'legacy-classifier-session');
  assert.equal(stored.agentLoopSessionId, 'agent-loop-session');
});

test('pasting an exact displayed candidate confirms it without a new search', async () => {
  const context = createMemoryContext();
  const product = '新华人寿保险股份有限公司荣耀鑫享终身寿险';
  const firstRuntime = createAgentConversationRuntime({
    conversationContext: context,
    runtimeMode: 'direct',
    directInterpreter: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
      entities: { productName: '荣耀鑫享' },
    }),
    questionRouter: { async route() {
      return { decision: 'clarify', interaction: {
        type: 'clarification', text: '请选择产品', candidates: [{ label: `新华保险《${product}》` }],
      } };
    } },
  });
  await firstRuntime.processMessage(envelope('ding-a', 'exact-candidate', 'candidate-1', '新华的荣耀鑫享产品责任'));

  const routed = [];
  const secondRuntime = createAgentConversationRuntime({
    conversationContext: context,
    runtimeMode: 'direct',
    directInterpreter: async () => { throw new Error('must not reinterpret an exact candidate'); },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已查询正式产品。' } };
    } },
  });
  await secondRuntime.processMessage(envelope('ding-a', 'exact-candidate', 'candidate-2', `新华保险《${product}》`));

  assert.equal(routed.length, 1);
  assert.equal(routed[0].candidate.entities.productName, product);
  assert.equal(routed[0].candidate.entities.productCompany, '新华保险');
  assert.equal(routed[0].candidate.question, '新华的荣耀鑫享产品责任');
  assert.equal(context.rows.get('default:dingtalk:ding-a:7:exact-candidate').productCandidates, null);
});

test('selecting a numbered product candidate keeps its company and original question', async () => {
  const context = createMemoryContext();
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    runtimeMode: 'direct',
    directInterpreter: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
      entities: { productName: '尊享人生' },
    }),
    questionRouter: { async route(input) {
      if (input.candidate.entities.productName === '尊享人生') {
        return { decision: 'clarify', interaction: {
          type: 'clarification', text: '请选择产品', candidates: [
            { label: '横琴人寿《横琴尊享人生医疗保险》' },
            { label: '新华保险《尊享人生年金保险（分红型）》' },
          ],
        } };
      }
      assert.equal(input.candidate.question, '尊享人生保险责任');
      assert.deepEqual(input.candidate.entities, {
        productName: '尊享人生年金保险（分红型）',
        productCompany: '新华保险',
      });
      return { decision: 'execute', interaction: { type: 'answer', text: '已查询新华保险正式产品。' } };
    } },
  });

  await runtime.processMessage(envelope('ding-a', 'numbered-candidate', 'candidate-1', '尊享人生保险责任'));
  const result = await runtime.processMessage(envelope('ding-a', 'numbered-candidate', 'candidate-2', '2'));

  assert.equal(result.interaction.text, '已查询新华保险正式产品。');
  const stored = context.rows.get('default:dingtalk:ding-a:7:numbered-candidate');
  assert.equal(stored.productCandidates, null);
  assert.equal(stored.question.candidate.entities.productCompany, '新华保险');
});

test('an imperative comparison does not fall back when Hermes is unavailable', async () => {
  const context = createMemoryContext();
  context.rows.set('default:dingtalk:ding-a:7:imperative-comparison', {
    conversationId: 'imperative-comparison-ref', version: 1, hermesSessionId: '', agentLoopSessionId: '', history: [],
    product: { productName: '尊享人生年金保险（分红型）', updatedAt: 1_720_000_000_000 },
    productCandidates: null, question: null,
  });
  const routed = [];
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() {
      throw Object.assign(new Error('offline'), { code: 'HERMES_PROVIDER_FAILED' });
    } },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已完成对比。' } };
    } },
  });

  const result = await runtime.processMessage(envelope(
    'ding-a', 'imperative-comparison', 'imperative-1', '你对比一下尊贵人生',
  ));

  assert.equal(routed.length, 0);
  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
});

test('a natural-language correction during product clarification cannot fall back to chat', async () => {
  const context = createMemoryContext();
  context.rows.set('default:dingtalk:ding-a:7:natural-correction', {
    conversationId: 'natural-correction-ref', version: 1, hermesSessionId: '', agentLoopSessionId: '', history: [],
    product: { productName: '尊享人生年金保险（分红型）', updatedAt: 1_720_000_000_000 },
    productCandidates: {
      products: ['中荷人寿《中荷与你童行终身寿险》'],
      question: '你对比一下尊贵人生',
      updatedAt: 1_720_000_000_000,
    },
    question: null,
  });
  const routed = [];
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    runtimeMode: 'direct',
    directInterpreter: async ({ question }) => ({
      intent: 'chat', question, confidence: 1, requestedOperation: 'read', entities: {},
    }),
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已按纠正后的产品查询。' } };
    } },
  });

  const result = await runtime.processMessage(envelope(
    'ding-a', 'natural-correction', 'correction-1', '新华保险的 尊贵人生 呀',
  ));

  assert.equal(result.interaction.text, '已按纠正后的产品查询。');
  assert.equal(routed[0].candidate.intent, 'insurance_product_knowledge');
  assert.equal(
    routed[0].candidate.question,
    '尊享人生年金保险（分红型） 对比 新华保险的 尊贵人生 呀',
  );
  assert.equal(context.rows.get('default:dingtalk:ding-a:7:natural-correction').productCandidates, null);
});

test('Agent Loop failure after a tool call does not rerun the request through Direct', async () => {
  const context = createMemoryContext();
  let directCalls = 0;
  let routeCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn() {
      throw Object.assign(new Error('reply failed'), { code: 'HERMES_PROVIDER_FAILED' });
    } },
    toolCapabilityService: { inspect() { return { callCount: 1 }; } },
    toolGatewayUrl: 'http://127.0.0.1:4207/api/agent/hermes-tools',
    directInterpreter: async () => { directCalls += 1; },
    questionRouter: { async route() { routeCalls += 1; } },
  });
  const result = await runtime.processMessage({
    ...envelope('ding-a', 'agent-loop-failed', 'loop-2', '查询保障'),
    toolCapability: 'opaque-capability',
  });
  assert.equal(result.decision, 'deny');
  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
  assert.equal(directCalls, 0);
  assert.equal(routeCalls, 0);
  assert.equal(context.rows.size, 0);
});

test('Agent Loop final generation failure does not return a tool-result fallback', async () => {
  const context = createMemoryContext();
  const authoritative = '荣耀鑫享终身寿险包含身故或身体全残保险金。';
  let directCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn() {
      throw Object.assign(new Error('reply failed'), { code: 'HERMES_PROVIDER_FAILED' });
    } },
    toolCapabilityService: { inspect() { return { callCount: 2, toolResults: [{
      tool: 'ask_insurance_expert',
      result: { status: 'ok', decision: 'execute', interaction: {
        type: 'answer', text: authoritative, delivery: 'verbatim',
      }, resolvedEntities: { product: {
        officialName: '新华人寿保险股份有限公司荣耀鑫享终身寿险',
      } } },
    }] }; } },
    toolGatewayUrl: 'http://127.0.0.1:4207/api/agent/hermes-tools',
    directInterpreter: async () => { directCalls += 1; },
    questionRouter: { async route() { throw new Error('must not route'); } },
  });

  const result = await runtime.processMessage({
    ...envelope('ding-a', 'agent-loop-recovered', 'loop-recovered-1', '荣耀鑫享终身寿险保险责任'),
    toolCapability: 'opaque-capability',
  });

  assert.equal(result.decision, 'deny');
  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
  assert.equal(directCalls, 0);
  assert.equal(context.rows.size, 0);
});

test('Agent Loop startup failure before tool execution returns unavailable without Direct fallback', async () => {
  const context = createMemoryContext();
  let routeCalls = 0;
  let directCalls = 0;
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    agentLoopClient: { async runTurn() {
      throw Object.assign(new Error('offline'), { code: 'HERMES_PROVIDER_FAILED' });
    } },
    toolCapabilityService: { inspect() { return { callCount: 0 }; } },
    toolGatewayUrl: 'http://127.0.0.1:4207/api/agent/hermes-tools',
    directInterpreter: async ({ question }) => {
      directCalls += 1;
      return { intent: 'chat', question, confidence: 1, requestedOperation: 'read' };
    },
    questionRouter: { async route() {
      routeCalls += 1;
      return { decision: 'execute', interaction: { type: 'answer', text: '安全降级回复' } };
    } },
  });
  const result = await runtime.processMessage({
    ...envelope('ding-a', 'agent-loop-direct', 'loop-3', '你好'),
    toolCapability: 'opaque-capability',
  });
  assert.equal(result.interaction.text, '语义服务暂不可用，请稍后重试。');
  assert.equal(result.runtime, 'hermes');
  assert.equal(result.decision, 'deny');
  assert.equal(directCalls, 0);
  assert.equal(routeCalls, 0);
});
