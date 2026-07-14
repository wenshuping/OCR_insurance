import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentSemanticAuditService } from '../server/agent-semantic-audit.service.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-semantic-audit-'));
  const dbPath = path.join(dir, 'state.sqlite');
  return { dbPath, store: await createSqliteStateStore({ dbPath }) };
}

test('semantic audit persists a bounded redacted projection and survives reopen', async () => {
  const { dbPath, store } = await makeStore();
  const audit = createAgentSemanticAuditService({ store, clock: () => 1_721_000_000_000 });
  const probes = {
    question: '张三的家庭查康健无忧两全保险 13800138000',
    family: '张三家庭',
    product: '康健无忧两全保险',
    canonical: 'canonical-secret-product',
    mobile: '13800138000',
  };

  await audit.record({
    internalUserId: 7,
    messageRef: 'msg-semantic-audit',
    runtime: 'hermes',
    proposal: {
      semanticContractVersion: 1,
      intent: 'insurance_product_knowledge', operation: 'read',
      queryAspects: ['main_responsibilities', 'main_responsibilities'],
      mentions: [{ type: 'product', rawText: probes.product }, { type: 'family', rawText: probes.family }],
      references: [{ type: 'current_product', rawText: '这个保险' }],
      confidence: { intent: 0.98, mentions: 0.9, references: 0.8 },
      injected: probes,
    },
    resolution: {
      decision: 'execute', decisionReason: 'unique_authorized_entity',
      missingFields: [], ambiguities: [],
      resolvedEntities: {
        product: {
          canonicalProductId: probes.canonical, officialName: probes.product,
          company: '新华人寿保险股份有限公司', matchType: 'exact_official_name', confidence: 1,
        },
      },
      nextTaskState: {
        candidateSets: {
          product: [{ officialName: probes.product }, { officialName: '另一个产品' }],
          family: [{ familyId: 71, displayName: probes.family }],
        },
      },
      question: probes.question,
    },
  });

  const [row] = await store.listAgentSemanticAuditEvents({ userId: 7 });
  const columns = store.db.prepare('PRAGMA table_info(agent_semantic_audit_events)').all()
    .map((column) => column.name);
  assert.deepEqual(columns, [
    'id', 'user_id', 'message_ref', 'runtime', 'intent', 'operation', 'decision',
    'decision_reason', 'created_at', 'payload',
  ]);
  assert.equal(row.runtime, 'hermes');
  assert.equal(row.intent, 'insurance_product_knowledge');
  assert.equal(row.decision, 'execute');
  assert.deepEqual(row.payload.queryAspects, ['main_responsibilities']);
  assert.deepEqual(row.payload.mentionTypes, ['product', 'family']);
  assert.deepEqual(row.payload.referenceTypes, ['current_product']);
  assert.deepEqual(row.payload.candidateCounts, { product: 2, family: 1 });
  assert.deepEqual(row.payload.resolvedEntityTypes.product, {
    status: 'resolved', matchType: 'exact_official_name', confidence: 1, hasCanonicalId: true,
  });
  const serialized = JSON.stringify(row);
  for (const probe of Object.values(probes)) assert.equal(serialized.includes(probe), false, probe);
  assert.equal(store.db.prepare('SELECT count(*) count FROM agent_route_audit_events').get().count, 0);
  assert.equal(store.db.prepare('SELECT count(*) count FROM knowledge_records').get().count, 0);
  store.close();

  const reopened = await createSqliteStateStore({ dbPath });
  const [persisted] = await reopened.listAgentSemanticAuditEvents({ userId: 7 });
  assert.equal(persisted.messageRef, 'msg-semantic-audit');
  assert.equal(persisted.createdAt, 1_721_000_000_000);
  reopened.close();
});

test('semantic audit filters by user and rejects invalid or corrupted events', async () => {
  const { store } = await makeStore();
  const valid = {
    messageRef: 'msg', runtime: 'rule', intent: 'chat', operation: 'read',
    decision: 'clarify', decisionReason: 'low_intent_confidence', createdAt: 100,
    payload: { semanticContractVersion: 1 },
  };
  await store.recordAgentSemanticAudit({ ...valid, userId: 7 });
  await store.recordAgentSemanticAudit({ ...valid, userId: 8, messageRef: 'msg-2' });
  assert.deepEqual((await store.listAgentSemanticAuditEvents({ userId: 7 })).map((row) => row.userId), [7]);

  for (const invalid of [
    { ...valid, userId: 0 },
    { ...valid, userId: '7' },
    { ...valid, userId: 7, runtime: 'shell' },
    { ...valid, userId: 7, intent: 'private_intent' },
    { ...valid, userId: 7, operation: 'delete' },
    { ...valid, userId: 7, decision: 'open_web' },
    { ...valid, userId: 7, decisionReason: '包含敏感中文' },
    { ...valid, userId: 7, messageRef: 'x'.repeat(201) },
    { ...valid, userId: 7, createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, userId: 7, payload: { text: 'x'.repeat(9_000) } },
  ]) await assert.rejects(store.recordAgentSemanticAudit(invalid));

  store.db.prepare('UPDATE agent_semantic_audit_events SET payload = ? WHERE user_id = ?').run('{broken', 7);
  await assert.rejects(store.listAgentSemanticAuditEvents({ userId: 7 }), /payload/i);
  store.close();
});
