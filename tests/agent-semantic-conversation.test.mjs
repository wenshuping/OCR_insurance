import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createAgentSemanticConversationService,
  projectAgentSemanticTaskState,
} from '../server/agent-semantic-conversation.service.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

async function createStore(dbPath) {
  return createSqliteStateStore({ dbPath });
}

async function tempDbPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-semantic-conversation-'));
  return path.join(dir, 'state.sqlite');
}

function proposal(question = '查一下康健无忧保险') {
  return {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [{ type: 'product', rawText: '康健无忧保险' }],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 0.98, mentions: 0.96, references: 0.9 },
  };
}

function typedState() {
  return {
    activeIntent: 'insurance_product_knowledge',
    activeEntities: {
      product: {
        canonicalProductId: 'product_1',
        company: '新华人寿保险股份有限公司',
        officialName: '康健无忧两全保险',
        matchType: 'exact_official_name',
        confidence: 1,
        updatedAt: 100,
        expiresAt: 1_000,
        secret: 'drop-me',
      },
      family: {
        familyId: 7,
        displayName: '张三家庭',
        matchType: 'contextual',
        confidence: 1,
        updatedAt: 100,
        expiresAt: 1_000,
        mobile: '18616135811',
      },
    },
    candidateSets: {
      product: [{
        canonicalProductId: '',
        company: '新华人寿保险股份有限公司',
        officialName: '康健无忧重大疾病保险',
        matchType: 'unique_high_confidence',
        confidence: 0.82,
      }],
      family: [{ familyId: 8, displayName: '张三二家庭', matchType: 'prefix', confidence: 0.8 }],
    },
    pendingClarification: {
      entityType: 'product',
      proposal: proposal(),
      originalQuestion: '查一下康健无忧保险',
      expiresAt: 2_000,
      hermesText: 'drop-me',
    },
    lastCompletedAction: { intent: 'family_summary', entityType: 'family', extra: 'drop-me' },
    rawQuestion: '身份证 330000000000000000',
    phone: '18616135811',
  };
}

test('semantic conversation round trips typed product and family state without unknown fields', async () => {
  const store = await createStore(await tempDbPath());
  const service = createAgentSemanticConversationService({ store, clock: () => 500 });

  const saved = await service.save({
    internalUserId: 1,
    channel: 'dingtalk',
    conversationId: 'conversation-1',
    expectedVersion: 0,
    taskState: typedState(),
  });
  assert.equal(saved.persisted, true);
  assert.equal(saved.version, 1);

  const loaded = await service.load({ internalUserId: 1, channel: 'dingtalk', conversationId: 'conversation-1' });
  assert.equal(loaded.version, 1);
  assert.deepEqual(loaded.taskState.activeEntities.product, {
    canonicalProductId: 'product_1',
    company: '新华人寿保险股份有限公司',
    officialName: '康健无忧两全保险',
    matchType: 'exact_official_name',
    confidence: 1,
    updatedAt: 100,
    expiresAt: 1_000,
  });
  assert.deepEqual(loaded.taskState.activeEntities.family, {
    familyId: 7,
    displayName: '张三家庭',
    matchType: 'contextual',
    confidence: 1,
    updatedAt: 100,
    expiresAt: 1_000,
  });
  assert.equal(loaded.taskState.pendingClarification.proposal.question, undefined);

  const storedJson = store.db.prepare(`
    SELECT task_state_json FROM agent_semantic_conversations
    WHERE user_id = 1 AND channel = 'dingtalk' AND conversation_id = 'conversation-1'
  `).get().task_state_json;
  for (const sensitive of ['18616135811', '330000000000000000', 'hermesText', 'drop-me', 'rawQuestion']) {
    assert.equal(storedJson.includes(sensitive), false);
  }
  store.close();
});

test('semantic conversation isolates identical conversation ids by internal user', async () => {
  const store = await createStore(await tempDbPath());
  const service = createAgentSemanticConversationService({ store, clock: () => 600 });
  const first = { ...typedState(), activeIntent: 'family_summary' };
  const second = { ...typedState(), activeIntent: 'coverage_report' };
  await service.save({ internalUserId: 1, channel: 'dingtalk', conversationId: 'same', expectedVersion: 0, taskState: first });
  await service.save({ internalUserId: 2, channel: 'dingtalk', conversationId: 'same', expectedVersion: 0, taskState: second });
  assert.equal((await service.load({ internalUserId: 1, channel: 'dingtalk', conversationId: 'same' })).taskState.activeIntent, 'family_summary');
  assert.equal((await service.load({ internalUserId: 2, channel: 'dingtalk', conversationId: 'same' })).taskState.activeIntent, 'coverage_report');
  store.close();
});

test('semantic conversation save uses optimistic versions', async () => {
  const store = await createStore(await tempDbPath());
  const service = createAgentSemanticConversationService({ store, clock: () => 700 });
  await service.save({ internalUserId: 1, channel: 'dingtalk', conversationId: 'conflict', expectedVersion: 0, taskState: typedState() });
  const updated = await service.save({ internalUserId: 1, channel: 'dingtalk', conversationId: 'conflict', expectedVersion: 1, taskState: typedState() });
  assert.equal(updated.version, 2);
  await assert.rejects(
    service.save({ internalUserId: 1, channel: 'dingtalk', conversationId: 'conflict', expectedVersion: 1, taskState: typedState() }),
    (error) => error.code === 'AGENT_SEMANTIC_CONVERSATION_CONFLICT',
  );
  await assert.rejects(
    service.save({ internalUserId: 1, channel: 'dingtalk', conversationId: 'missing', expectedVersion: 2, taskState: typedState() }),
    (error) => error.code === 'AGENT_SEMANTIC_CONVERSATION_CONFLICT',
  );
  store.close();
});

test('semantic conversation survives reopening sqlite', async () => {
  const dbPath = await tempDbPath();
  const firstStore = await createStore(dbPath);
  const firstService = createAgentSemanticConversationService({ store: firstStore, clock: () => 800 });
  await firstService.save({ internalUserId: 3, channel: 'dingtalk', conversationId: 'reopen', expectedVersion: 0, taskState: typedState() });
  firstStore.close();

  const reopenedStore = await createStore(dbPath);
  const reopenedService = createAgentSemanticConversationService({ store: reopenedStore });
  const loaded = await reopenedService.load({ internalUserId: 3, channel: 'dingtalk', conversationId: 'reopen' });
  assert.equal(loaded.version, 1);
  assert.equal(loaded.taskState.activeEntities.product.canonicalProductId, 'product_1');
  reopenedStore.close();
});

test('semantic conversation rejects invalid persistence keys and timestamps', async () => {
  const store = await createStore(await tempDbPath());
  const valid = { userId: 1, channel: 'dingtalk', conversationId: 'valid' };
  for (const input of [
    { ...valid, userId: 0 },
    { ...valid, userId: '1' },
    { ...valid, userId: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, channel: 'DingTalk' },
    { ...valid, channel: 'bad/channel' },
    { ...valid, conversationId: '' },
    { ...valid, conversationId: 'x'.repeat(201) },
  ]) {
    await assert.rejects(store.getAgentSemanticConversation(input), TypeError);
  }
  await assert.rejects(store.saveAgentSemanticConversation({ ...valid, expectedVersion: -1, updatedAt: 1, taskState: {} }), TypeError);
  await assert.rejects(store.saveAgentSemanticConversation({ ...valid, expectedVersion: 0, updatedAt: -1, taskState: {} }), TypeError);
  store.close();
});

test('service rejects non-string conversation ids instead of silently becoming stateless', async () => {
  const store = await createStore(await tempDbPath());
  const service = createAgentSemanticConversationService({ store });
  await assert.rejects(
    service.load({ internalUserId: 1, channel: 'dingtalk', conversationId: 123 }),
    TypeError,
  );
  store.close();
});

test('missing conversation id remains explicitly stateless and writes no row', async () => {
  const store = await createStore(await tempDbPath());
  const service = createAgentSemanticConversationService({ store, clock: () => 900 });
  const empty = await service.load({ internalUserId: 1, channel: 'dingtalk', conversationId: '' });
  assert.equal(empty.version, 0);
  const result = await service.save({ internalUserId: 1, channel: 'dingtalk', conversationId: '', expectedVersion: 0, taskState: typedState() });
  assert.equal(result.persisted, false);
  assert.equal(result.version, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM agent_semantic_conversations').get().count, 0);
  store.close();
});

test('task state projection strictly bounds candidates and pending proposal', () => {
  const projected = projectAgentSemanticTaskState(typedState());
  assert.deepEqual(projected.candidateSets.product[0], {
    canonicalProductId: '',
    company: '新华人寿保险股份有限公司',
    officialName: '康健无忧重大疾病保险',
    matchType: 'unique_high_confidence',
    confidence: 0.82,
  });
  assert.deepEqual(projected.candidateSets.family[0], {
    familyId: 8,
    displayName: '张三二家庭',
    matchType: 'prefix',
    confidence: 0.8,
  });
  assert.equal(projected.pendingClarification.entityType, 'product');

  const invalidPending = projectAgentSemanticTaskState({
    ...typedState(),
    pendingClarification: { ...typedState().pendingClarification, proposal: { intent: 'invented' } },
  });
  assert.equal(invalidPending.pendingClarification, null);
  assert.deepEqual(invalidPending.candidateSets.product, []);

  assert.throws(() => projectAgentSemanticTaskState({
    ...typedState(),
    candidateSets: { product: Array.from({ length: 11 }, () => typedState().candidateSets.product[0]), family: [] },
  }), RangeError);
});

test('projection drops invalid active facts and constrains last action', () => {
  const projected = projectAgentSemanticTaskState({
    activeIntent: 'invented',
    activeEntities: {
      product: { ...typedState().activeEntities.product, confidence: 0.89 },
      family: { ...typedState().activeEntities.family, confidence: 0.99 },
    },
    candidateSets: { product: [], family: [] },
    lastCompletedAction: { intent: 'invented', entityType: 'product' },
  });
  assert.equal(projected.activeIntent, '');
  assert.equal(projected.activeEntities.product, null);
  assert.equal(projected.activeEntities.family, null);
  assert.equal(projected.lastCompletedAction, null);
});

test('store rejects oversized state and malformed persisted payload fails closed', async () => {
  const store = await createStore(await tempDbPath());
  await assert.rejects(store.saveAgentSemanticConversation({
    userId: 1,
    channel: 'dingtalk',
    conversationId: 'oversized',
    expectedVersion: 0,
    updatedAt: 1,
    taskState: { candidateSets: { product: Array.from({ length: 11 }, () => ({})), family: [] } },
  }), RangeError);

  store.db.prepare(`
    INSERT INTO agent_semantic_conversations
      (user_id, channel, conversation_id, version, updated_at, task_state_json)
    VALUES (1, 'dingtalk', 'oversized', 1, 1, ?)
  `).run(JSON.stringify({ value: 'x'.repeat(33_000) }));
  await assert.rejects(
    store.getAgentSemanticConversation({ userId: 1, channel: 'dingtalk', conversationId: 'oversized' }),
    (error) => error.code === 'AGENT_SEMANTIC_CONVERSATION_CORRUPT',
  );

  store.db.prepare(`
    INSERT INTO agent_semantic_conversations
      (user_id, channel, conversation_id, version, updated_at, task_state_json)
    VALUES (1, 'dingtalk', 'corrupt', 1, 1, '{')
  `).run();
  await assert.rejects(
    store.getAgentSemanticConversation({ userId: 1, channel: 'dingtalk', conversationId: 'corrupt' }),
    (error) => error.code === 'AGENT_SEMANTIC_CONVERSATION_CORRUPT',
  );

  store.db.prepare(`
    INSERT INTO agent_semantic_conversations
      (user_id, channel, conversation_id, version, updated_at, task_state_json)
    VALUES (1, 'dingtalk', 'semantic-corrupt', 1, 1, ?)
  `).run(JSON.stringify({
    activeIntent: 'invented',
    activeEntities: { product: { confidence: 1, phone: '18616135811' } },
    arbitrarySensitivePayload: '330000000000000000',
  }));
  const safelyProjected = await store.getAgentSemanticConversation({
    userId: 1,
    channel: 'dingtalk',
    conversationId: 'semantic-corrupt',
  });
  assert.equal(safelyProjected.taskState.activeIntent, '');
  assert.equal(JSON.stringify(safelyProjected.taskState).includes('18616135811'), false);
  store.close();
});

test('store defense-in-depth projects direct writes instead of accepting arbitrary json', async () => {
  const store = await createStore(await tempDbPath());
  await store.saveAgentSemanticConversation({
    userId: 1,
    channel: 'dingtalk',
    conversationId: 'direct',
    expectedVersion: 0,
    updatedAt: 1,
    taskState: { activeIntent: 'chat', mobile: '18616135811', nested: { secret: 'raw-hermes' } },
  });
  const raw = store.db.prepare(`
    SELECT task_state_json FROM agent_semantic_conversations WHERE conversation_id = 'direct'
  `).get().task_state_json;
  assert.equal(raw.includes('18616135811'), false);
  assert.equal(raw.includes('raw-hermes'), false);
  assert.equal(JSON.parse(raw).activeIntent, 'chat');
  store.close();
});

test('semantic narrow writes do not touch insurance knowledge tables', async () => {
  const store = await createStore(await tempDbPath());
  store.db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (99, '测试保险', '哨兵产品', 'https://example.test', '{}')
  `).run();
  const service = createAgentSemanticConversationService({ store, clock: () => 1_000 });
  await service.save({ internalUserId: 1, channel: 'dingtalk', conversationId: 'sentinel', expectedVersion: 0, taskState: typedState() });
  assert.equal(store.db.prepare('SELECT product_name FROM knowledge_records WHERE id = 99').get().product_name, '哨兵产品');
  store.close();
});
