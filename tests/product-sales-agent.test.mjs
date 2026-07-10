import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createProductAgentStore } from '../server/product-agent-store.mjs';
import { createProductSalesAgent } from '../server/product-sales-agent.service.mjs';

function setup(modelAdapter) {
  const db = new DatabaseSync(':memory:'); const agentStore = createProductAgentStore(db);
  const thread = agentStore.createThread({ tenantId: 'default', userId: 'u1', customerId: 'c1' });
  agentStore.saveTaskState({ tenantId: 'default', userId: 'u1', threadId: thread.id, candidateProducts: [{ canonicalProductId: 'p1', productName: '康宁保' }] });
  const evidencePackage = { evidenceChunks: [{ chunkId: 'c1', content: '等待期为90天。', matchedContent: '', reviewStatus: 'published', sourceAuthority: 'official_terms', citation: { fileName: '条款.pdf', pageStart: 3 } }], conflicts: [] };
  const ragService = { retrieve: () => evidencePackage };
  return { db, agentStore, thread, service: createProductSalesAgent({ agentStore, ragService, modelAdapter }) };
}

test('sales agent persists a validated turn and its evidence snapshot', async () => {
  const env = setup(async () => ({ answer: '等待期为90天。', claims: [{ text: '等待期为90天。', productId: 'p1', evidenceChunkIds: ['c1'], claimType: 'objective_fact', certainty: 'confirmed' }] }));
  try {
    const result = await env.service.runTurn({ tenantId: 'default', userId: 'u1', threadId: env.thread.id, query: '等待期是多少' });
    assert.equal(result.validation.valid, true);
    assert.equal(result.run.status, 'validated');
    assert.equal(env.agentStore.listMessages({ tenantId: 'default', userId: 'u1', threadId: env.thread.id }).length, 2);
  } finally { env.db.close(); }
});

test('sales agent downgrades hallucinated output to evidence and human review', async () => {
  const env = setup(async () => ({ answer: '等待期为30天。', claims: [{ text: '等待期为30天。', productId: 'p2', evidenceChunkIds: ['missing'], claimType: 'objective_fact', certainty: 'confirmed' }] }));
  try {
    const result = await env.service.runTurn({ tenantId: 'default', userId: 'u1', threadId: env.thread.id, query: '等待期是多少' });
    assert.equal(result.validation.valid, false);
    assert.equal(result.run.status, 'human_review_required');
    assert.equal(result.response.requiresHumanReview, true);
    assert.match(result.assistantMessage.content, /证据不足/u);
  } finally { env.db.close(); }
});

test('sales agent rejects cross-user thread access before model invocation', async () => {
  let called = false; const env = setup(async () => { called = true; return {}; });
  try {
    await assert.rejects(() => env.service.runTurn({ tenantId: 'default', userId: 'u2', threadId: env.thread.id, query: '问题' }), (error) => error.code === 'AGENT_THREAD_NOT_FOUND');
    assert.equal(called, false);
  } finally { env.db.close(); }
});
