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
        conversationId: `ref-${key(input)}`, version: 1, hermesSessionId: '', history: [],
        product: null, productCandidates: null, question: null,
      });
    },
    async commitContext(input) {
      const row = {
        conversationId: input.conversationRef,
        version: input.expectedVersion + 1,
        hermesSessionId: input.hermesSessionId,
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
  await client.runTurn({ sessionId: first.sessionId, question: '继续', safeRecentContext: {} });
  assert.deepEqual(calls[1].args.slice(-2), ['--resume', 'hermes-session-a']);
  assert.equal(calls[0].options.timeout, 20_000);
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

  assert.equal(routed.length, 1);
  assert.equal(routed[0].runtime, 'hermes');
  assert.deepEqual(routed[0].proposal, proposal);
  assert.equal(routed[0].candidate, undefined);
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

test('Hermes provider failure retries once and never invokes Direct', async () => {
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
    directInterpreter: async () => { directCalls += 1; throw new Error('must not use direct'); },
    questionRouter: { async route() { routeCalls += 1; throw new Error('must not route'); } },
    now: () => 1_720_000_000_000,
  });
  const result = await runtime.processMessage(envelope('ding-a', 'retry-conversation', 'f-1', 'A产品保险责任'));
  assert.equal(hermesCalls, 2);
  assert.equal(directCalls, 0);
  assert.equal(routeCalls, 0);
  assert.equal(result.runtime, 'hermes');
  assert.match(result.interaction.text, /Hermes 暂不可用/u);
});

test('Hermes retry can recover and route the second semantic proposal', async () => {
  const context = createMemoryContext();
  let hermesCalls = 0;
  const routed = [];
  const proposal = {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge', operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [{ type: 'product', rawText: 'A产品' }], references: [], requestedSteps: ['lookup'],
    confidence: { intent: 1, mentions: 1, references: 1 },
  };
  const runtime = createAgentConversationRuntime({
    conversationContext: context,
    hermesClient: { async runTurn() {
      hermesCalls += 1;
      if (hermesCalls === 1) throw Object.assign(new Error('invalid'), { code: 'HERMES_RESPONSE_INVALID' });
      return { sessionId: 'session-recovered', proposal };
    } },
    directInterpreter: async () => { throw new Error('must not use direct'); },
    questionRouter: { async route(input) {
      routed.push(input);
      return { decision: 'execute', interaction: { type: 'answer', text: '已核验。' } };
    } },
  });
  const result = await runtime.processMessage(envelope('ding-a', 'retry-success', 'f-2', 'A产品保险责任'));
  assert.equal(hermesCalls, 2);
  assert.equal(routed.length, 1);
  assert.equal(routed[0].runtime, 'hermes');
  assert.equal(result.interaction.text, '已核验。');
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
