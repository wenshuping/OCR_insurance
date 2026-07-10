import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createProductAgentStore } from '../server/product-agent-store.mjs';

test('agent store isolates threads and preserves immutable messages', () => {
  const db = new DatabaseSync(':memory:');
  const store = createProductAgentStore(db);
  try {
    const thread = store.createThread({ tenantId: 'default', userId: 'u1', customerId: 'c1' });
    store.appendMessage({ tenantId: 'default', userId: 'u1', threadId: thread.id, role: 'user', content: '预算每年1万元' });
    assert.equal(store.listMessages({ tenantId: 'default', userId: 'u1', threadId: thread.id }).length, 1);
    assert.equal(store.listMessages({ tenantId: 'default', userId: 'u2', threadId: thread.id }).length, 0);
    assert.equal(db.prepare('SELECT content FROM agent_messages').get().content, '预算每年1万元');
  } finally { db.close(); }
});

test('task state uses optimistic versions and keeps structured progress', () => {
  const db = new DatabaseSync(':memory:'); const store = createProductAgentStore(db);
  try {
    const thread = store.createThread({ tenantId: 'default', userId: 'u1' });
    const first = store.saveTaskState({ tenantId: 'default', userId: 'u1', threadId: thread.id, confirmedFacts: { budget: 10000 }, pendingQuestions: ['健康情况'] });
    assert.equal(first.stateVersion, 1);
    const second = store.saveTaskState({ tenantId: 'default', userId: 'u1', threadId: thread.id, expectedVersion: 1, stage: 'matching_products' });
    assert.equal(second.stateVersion, 2);
    assert.deepEqual(second.confirmedFacts, { budget: 10000 });
    assert.throws(() => store.saveTaskState({ tenantId: 'default', userId: 'u1', threadId: thread.id, expectedVersion: 1 }), (error) => error.code === 'AGENT_STATE_VERSION_CONFLICT');
  } finally { db.close(); }
});

test('memory transitions retain an audit event history and customer scope', () => {
  const db = new DatabaseSync(':memory:'); const store = createProductAgentStore(db);
  try {
    const memory = store.createMemory({ tenantId: 'default', userId: 'u1', customerId: 'c1', memoryType: 'customer_fact', content: { budget: 10000 }, sourceType: 'user_explicit', actor: 'u1' });
    const confirmed = store.transitionMemory({ tenantId: 'default', userId: 'u1', memoryId: memory.id, status: 'confirmed', actor: 'u1' });
    assert.equal(confirmed.status, 'confirmed');
    assert.equal(store.listMemories({ tenantId: 'default', userId: 'u1', customerId: 'c1', status: 'confirmed' }).length, 1);
    assert.equal(store.listMemories({ tenantId: 'default', userId: 'u1', customerId: 'c2', status: 'confirmed' }).length, 0);
    assert.equal(db.prepare('SELECT count(*) count FROM agent_memory_events').get().count, 2);
  } finally { db.close(); }
});

test('recommendation runs persist evidence and validation snapshots', () => {
  const db = new DatabaseSync(':memory:'); const store = createProductAgentStore(db);
  try {
    const thread = store.createThread({ tenantId: 'default', userId: 'u1' });
    const run = store.recordRecommendationRun({ tenantId: 'default', threadId: thread.id, status: 'validated', request: { query: '推荐产品' }, evidence: { chunks: ['c1'] }, response: { answer: '建议' }, validation: { valid: true } });
    assert.match(run.id, /^arun_/u);
    const row = db.prepare('SELECT * FROM recommendation_runs WHERE id=?').get(run.id);
    assert.equal(JSON.parse(row.validation_json).valid, true);
  } finally { db.close(); }
});
