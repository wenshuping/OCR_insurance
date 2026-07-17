import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentConversationContextService } from '../server/agent-conversation-context.service.mjs';
import { createDingtalkAgentGateway } from '../server/dingtalk-agent-gateway.service.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

async function createStore(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-conversation-context-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'state.sqlite');
  const store = await createSqliteStateStore({ dbPath });
  await store.load();
  return { dbPath, store };
}

function identity(overrides = {}) {
  return {
    tenantId: 'default', channel: 'dingtalk', channelUserId: 'ding-7',
    channelConversationId: 'conversation-7', internalUserId: 7,
    productContextTtlMinutes: 30, ...overrides,
  };
}

test('agent conversation context survives a SQLite store restart', async (t) => {
  const { dbPath, store } = await createStore(t);
  const service = createAgentConversationContextService({ store, clock: () => 1_720_000_000_000 });
  const loaded = await service.loadContext(identity());
  await service.commitContext({
    ...identity(), conversationRef: loaded.conversationId, expectedVersion: loaded.version,
    history: [{ role: 'user', content: '国寿惠享保保险责任' }],
    hermesSessionId: 'hermes-session-user-7',
    agentLoopSessionId: 'agent-loop-session-user-7',
    product: {
      productName: '国寿惠享保（免健告）百万医疗险',
      company: '中国人寿财险',
      canonicalProductId: 'product_hxb',
      updatedAt: 1_720_000_000_000,
    },
    productCandidates: null,
    question: {
      candidate: { intent: 'insurance_product_knowledge', question: '国寿惠享保保险责任', confidence: 1, requestedOperation: 'read' },
      updatedAt: 1_720_000_000_000,
    },
    factBlock: {
      version: 1,
      goal: { question: '国寿惠享保保险责任', status: 'completed', owner: 'insurance_expert' },
      verifiedEntities: {
        product: { officialName: '国寿惠享保（免健告）百万医疗险', source: 'domain_agent', verifiedAt: 1_720_000_000_000 },
      },
      conflicts: [],
    },
    updatedAt: 1_720_000_000_000,
  });
  store.close();

  const reopened = await createSqliteStateStore({ dbPath });
  t.after(() => reopened.close());
  const restored = await createAgentConversationContextService({ store: reopened, clock: () => 1_720_000_001_000 })
    .loadContext(identity());
  assert.deepEqual(restored.history, [{ role: 'user', content: '国寿惠享保保险责任' }]);
  assert.equal(restored.hermesSessionId, 'hermes-session-user-7');
  assert.equal(restored.agentLoopSessionId, 'agent-loop-session-user-7');
  assert.equal(restored.product.productName, '国寿惠享保（免健告）百万医疗险');
  assert.equal(restored.product.company, '中国人寿财险');
  assert.equal(restored.product.canonicalProductId, 'product_hxb');
  assert.equal(restored.factBlock.goal.owner, 'insurance_expert');
  assert.equal(restored.factBlock.verifiedEntities.product.source, 'domain_agent');
  assert.equal(restored.version, 2);
});

test('agent conversation context recovers a confirmed product identity from a legacy question', async () => {
  const now = 1_720_000_000_000;
  const store = {
    async resolveAgentConversation() {
      return { id: 'legacy-conversation', contextVersion: 2 };
    },
    async findAgentConversation() {
      return { id: 'legacy-conversation', contextVersion: 2 };
    },
    async loadAgentConversationContext() {
      return {
        version: 2,
        history: [],
        product: { productName: '尊佑金悦庆典版养老年金保险（分红型）', updatedAt: now },
        productCandidates: null,
        question: {
          candidate: {
            intent: 'insurance_product_knowledge',
            question: '尊佑金悦庆典版养老年金保险（分红型）怎么样',
            confidence: 1,
            requestedOperation: 'read',
            entities: {
              productName: '尊佑金悦庆典版养老年金保险（分红型）',
              productCompany: '新华保险',
              productCanonicalId: 'product_zjy',
            },
          },
          updatedAt: now,
        },
      };
    },
    async saveAgentConversationContext() {},
  };
  const context = await createAgentConversationContextService({ store, clock: () => now })
    .loadContext(identity());

  assert.deepEqual(context.product, {
    productName: '尊佑金悦庆典版养老年金保险（分红型）',
    company: '新华保险',
    canonicalProductId: 'product_zjy',
    updatedAt: now,
  });
});

test('agent conversation context isolates users and channel conversations', async (t) => {
  const { store } = await createStore(t);
  t.after(() => store.close());
  const service = createAgentConversationContextService({ store, clock: () => 1_720_000_000_000 });
  const first = await service.loadContext(identity());
  await service.commitContext({
    ...identity(), conversationRef: first.conversationId, expectedVersion: first.version,
    history: [{ role: 'user', content: '只属于用户7会话7' }], updatedAt: 1_720_000_000_000,
  });

  const otherUser = await service.loadContext(identity({ internalUserId: 8 }));
  const otherConversation = await service.loadContext(identity({ channelConversationId: 'conversation-8' }));
  assert.notEqual(otherUser.conversationId, first.conversationId);
  assert.notEqual(otherConversation.conversationId, first.conversationId);
  assert.deepEqual(otherUser.history, []);
  assert.deepEqual(otherConversation.history, []);
});

test('agent conversation context applies the configured product TTL', async (t) => {
  const { store } = await createStore(t);
  t.after(() => store.close());
  let now = 1_720_000_000_000;
  const service = createAgentConversationContextService({ store, clock: () => now });
  const loaded = await service.loadContext(identity({ productContextTtlMinutes: 1 }));
  await service.commitContext({
    ...identity({ productContextTtlMinutes: 1 }), conversationRef: loaded.conversationId,
    expectedVersion: loaded.version, history: [],
    product: { productName: '测试医疗险', updatedAt: now },
    factBlock: {
      goal: { question: '它保什么', status: 'completed', owner: 'insurance_expert' },
      verifiedEntities: {
        product: { officialName: '测试医疗险', source: 'domain_agent', verifiedAt: now },
      },
    },
    updatedAt: now,
  });
  now += 59_000;
  const fresh = await service.loadContext(identity({ productContextTtlMinutes: 1 }));
  assert.equal(fresh.product.productName, '测试医疗险');
  assert.equal(fresh.factBlock.verifiedEntities.product.officialName, '测试医疗险');
  now += 2_000;
  const expired = await service.loadContext(identity({ productContextTtlMinutes: 1 }));
  assert.equal(expired.product, null);
  assert.equal(expired.factBlock, null);
});

test('commit rejects a conversation loaded before the channel identity was rebound', async (t) => {
  const { store } = await createStore(t);
  t.after(() => store.close());
  const service = createAgentConversationContextService({ store, clock: () => 1_720_000_000_000 });
  const beforeRebind = await service.loadContext(identity({ internalUserId: 7 }));
  await assert.rejects(service.commitContext({
    ...identity({ internalUserId: 8 }), conversationRef: beforeRebind.conversationId,
    expectedVersion: beforeRebind.version, history: [{ role: 'user', content: '旧用户上下文' }],
    updatedAt: 1_720_000_000_000,
  }), (error) => error?.code === 'AGENT_CONVERSATION_IDENTITY_CHANGED' && error?.status === 409);
  assert.equal(store.db.prepare('SELECT count(*) count FROM agent_conversations WHERE internal_user_id = 8').get().count, 0);
  assert.deepEqual((await service.loadContext(identity({ internalUserId: 8 }))).history, []);
});

test('numbered product candidates remain selectable after gateway restart', async (t) => {
  const { dbPath, store } = await createStore(t);
  const service = createAgentConversationContextService({ store, clock: () => 1_720_000_000_000 });
  const adapter = (contextService) => ({
    loadContext: (input) => contextService.loadContext({ ...input, internalUserId: 7 }),
    commitContext: (input) => contextService.commitContext({ ...input, internalUserId: 7 }),
  });
  const routed = [];
  const gatewayOptions = (conversationContext) => ({
    corpId: 'corp-1', hmacSecret: 'test-secret', conversationContext,
    getDingtalkMobile: async () => '13800138000',
    interpretQuestion: async ({ question }) => ({
      intent: 'insurance_product_knowledge', question, confidence: 1, requestedOperation: 'read',
      entities: { productName: '荣耀鑫享' },
    }),
    fetchImpl: async (url, options) => {
      if (String(url).includes('/api/agent/questions/route')) {
        routed.push(JSON.parse(options.body));
        return routed.length === 1
          ? { ok: true, json: async () => ({ interaction: { type: 'clarification', text: '请选择：', candidates: [
            { ref: 'one', label: '新华保险《荣耀鑫享赢家版终身寿险》' },
            { ref: 'two', label: '新华保险《荣耀鑫享智赢版终身寿险》' },
          ] } }) }
          : { ok: true, json: async () => ({ interaction: { type: 'answer', text: '新华保险《荣耀鑫享智赢版终身寿险》：已查询。' } }) };
      }
      return { ok: true, json: async () => ({}) };
    },
  });
  const message = {
    senderCorpId: 'corp-1', conversationType: '1', senderStaffId: 'ding-7', conversationId: 'choice-restart',
    sessionWebhook: 'https://api.dingtalk.com/session', msgtype: 'text',
  };
  await createDingtalkAgentGateway(gatewayOptions(adapter(service))).handle({
    ...message, msgId: 'choice-1', text: { content: '荣耀鑫享保险责任' },
  });
  const persistedCandidate = store.db.prepare(`
    SELECT payload FROM agent_conversation_entities WHERE role = 'candidate' AND ordinal = 1
  `).get();
  assert.equal(JSON.parse(persistedCandidate.payload).officialName, '荣耀鑫享智赢版终身寿险');
  assert.match(JSON.parse(persistedCandidate.payload).canonicalProductId, /^product_[a-f0-9]{16}$/u);
  store.close();

  const reopened = await createSqliteStateStore({ dbPath });
  t.after(() => reopened.close());
  const restartedService = createAgentConversationContextService({ store: reopened, clock: () => 1_720_000_001_000 });
  await createDingtalkAgentGateway(gatewayOptions(adapter(restartedService))).handle({
    ...message, msgId: 'choice-2', text: { content: '2' },
  });
  assert.equal(routed[1].candidate.question, '荣耀鑫享智赢版终身寿险保险责任');
  assert.equal(routed[1].candidate.entities.productName, '荣耀鑫享智赢版终身寿险');
  const saved = await restartedService.loadContext({
    ...identity({ internalUserId: 7 }),
    channelConversationId: 'choice-restart',
  });
  assert.equal(saved.productCandidates, null);
});
