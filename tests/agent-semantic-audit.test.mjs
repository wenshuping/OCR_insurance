import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createAgentSemanticAuditService } from '../server/agent-semantic-audit.service.mjs';
import { projectAgentSemanticAuditPayload } from '../server/agent-semantic-audit-contract.mjs';
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
    'id', 'user_id', 'message_ref', 'runtime', 'fallback_reason', 'intent', 'operation', 'decision',
    'decision_reason', 'created_at', 'payload',
  ]);
  assert.equal(row.runtime, 'hermes');
  assert.equal(row.fallbackReason, 'none');
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
  const rawPayload = store.db.prepare('SELECT payload FROM agent_semantic_audit_events').get().payload;
  for (const probe of Object.values(probes)) assert.equal(rawPayload.includes(probe), false, probe);
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
    messageRef: 'msg', runtime: 'rule', fallbackReason: 'rule_preparse', intent: 'chat', operation: 'read',
    decision: 'clarify', decisionReason: 'low_intent_confidence', createdAt: 100,
    payload: projectAgentSemanticAuditPayload({
      runtime: 'rule', fallbackReason: 'rule_preparse',
      proposal: {
        semanticContractVersion: 1, intent: 'chat', operation: 'read', queryAspects: [],
        confidence: { intent: 0.5, mentions: 1, references: 1 }, mentions: [], references: [],
      },
      resolution: {
        decision: 'clarify', decisionReason: 'low_intent_confidence',
        missingFields: [], ambiguities: [], resolvedEntities: {}, nextTaskState: {},
      },
    }),
  };
  await store.recordAgentSemanticAudit({ ...valid, userId: 7 });
  await store.recordAgentSemanticAudit({ ...valid, userId: 8, messageRef: 'msg-2' });
  assert.deepEqual((await store.listAgentSemanticAuditEvents({ userId: 7 })).map((row) => row.userId), [7]);

  for (const invalid of [
    { ...valid, userId: 0 },
    { ...valid, userId: '7' },
    { ...valid, userId: 7, runtime: 'shell' },
    { ...valid, userId: 7, fallbackReason: 'private_name' },
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

test('direct store payloads cannot add sensitive fields or disagree with indexed columns', async () => {
  const { store } = await makeStore();
  const payload = projectAgentSemanticAuditPayload({
    runtime: 'hermes', proposal: null,
    resolution: {
      decision: 'retry_later', decisionReason: 'unknown', missingFields: [], ambiguities: [],
      resolvedEntities: {}, nextTaskState: {},
    },
  });
  const event = {
    userId: 7, messageRef: 'strict', runtime: 'hermes', fallbackReason: 'none',
    intent: 'unknown', operation: 'unknown', decision: 'retry_later', decisionReason: 'unknown',
    createdAt: 100, payload,
  };
  await assert.rejects(
    store.recordAgentSemanticAudit({ ...event, payload: { ...payload, question: '张三家庭' } }),
    /AGENT_SEMANTIC_AUDIT_INVALID/u,
  );
  await assert.rejects(
    store.recordAgentSemanticAudit({ ...event, intent: 'chat' }),
    /AGENT_SEMANTIC_AUDIT_INVALID/u,
  );
  assert.equal(store.db.prepare('SELECT count(*) count FROM agent_semantic_audit_events').get().count, 0);
  assert.doesNotMatch(JSON.stringify(store.db.prepare('SELECT * FROM agent_semantic_audit_events').all()), /张三/u);
  store.close();
});

test('semantic audit rejects oversized and sparse arrays before traversal', async () => {
  const { store } = await makeStore();
  const audit = createAgentSemanticAuditService({ store, clock: () => 100 });
  let indexedReads = 0;
  const oversized = new Proxy([], {
    get(target, property, receiver) {
      if (property === 'length') return 1_000_000;
      if (typeof property === 'string' && /^\d+$/u.test(property)) indexedReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  await assert.rejects(audit.record({
    internalUserId: 7, messageRef: 'oversized', runtime: 'hermes',
    proposal: {
      semanticContractVersion: 1, intent: 'chat', operation: 'read',
      queryAspects: oversized, mentions: [], references: [],
      confidence: { intent: 1, mentions: 1, references: 1 },
    },
    resolution: {
      decision: 'execute', decisionReason: 'semantic_ready', missingFields: [], ambiguities: [],
      resolvedEntities: {}, nextTaskState: {},
    },
  }), /AGENT_SEMANTIC_AUDIT_INVALID/u);
  assert.equal(indexedReads, 0);

  const sparse = [];
  sparse.length = 2;
  sparse[1] = 'main_responsibilities';
  await assert.rejects(audit.record({
    internalUserId: 7, messageRef: 'sparse', runtime: 'hermes',
    proposal: {
      semanticContractVersion: 1, intent: 'chat', operation: 'read',
      queryAspects: sparse, mentions: [], references: [],
      confidence: { intent: 1, mentions: 1, references: 1 },
    },
    resolution: {
      decision: 'execute', decisionReason: 'semantic_ready', missingFields: [], ambiguities: [],
      resolvedEntities: {}, nextTaskState: {},
    },
  }), /AGENT_SEMANTIC_AUDIT_INVALID/u);
  store.close();
});

test('semantic audit schema migrates existing rows with a none fallback reason', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-semantic-audit-migration-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE agent_semantic_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, message_ref TEXT NOT NULL,
      runtime TEXT NOT NULL, intent TEXT NOT NULL, operation TEXT NOT NULL,
      decision TEXT NOT NULL, decision_reason TEXT NOT NULL, created_at INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  const legacyPayload = projectAgentSemanticAuditPayload({
    runtime: 'hermes',
    resolution: {
      decision: 'retry_later', decisionReason: 'unknown', missingFields: [], ambiguities: [],
      resolvedEntities: {}, nextTaskState: {},
    },
  });
  delete legacyPayload.fallbackReason;
  legacy.prepare(`
    INSERT INTO agent_semantic_audit_events
      (user_id, message_ref, runtime, intent, operation, decision, decision_reason, created_at, payload)
    VALUES (7, 'legacy', 'hermes', 'unknown', 'unknown', 'retry_later', 'unknown', 100, ?)
  `).run(JSON.stringify(legacyPayload));
  legacy.close();
  const store = await createSqliteStateStore({ dbPath });
  const column = store.db.prepare('PRAGMA table_info(agent_semantic_audit_events)').all()
    .find((item) => item.name === 'fallback_reason');
  assert.equal(column.notnull, 1);
  assert.equal(column.dflt_value, "'none'");
  const [migrated] = await store.listAgentSemanticAuditEvents({ userId: 7 });
  assert.equal(migrated.fallbackReason, 'none');
  assert.equal(migrated.payload.fallbackReason, 'none');
  store.close();
});

test('semantic retry final is a controlled persisted phase', async () => {
  const { store } = await makeStore();
  const audit = createAgentSemanticAuditService({ store, clock: () => 100 });
  const input = {
    internalUserId: 7, messageRef: 'retry-final', runtime: 'hermes',
    proposal: {
      semanticContractVersion: 1, intent: 'chat', operation: 'read', queryAspects: [],
      mentions: [], references: [], confidence: { intent: 1, mentions: 1, references: 1 },
    },
    resolution: {
      decision: 'reject', decisionReason: 'unsupported_intent', missingFields: [],
      ambiguities: [], resolvedEntities: {}, nextTaskState: {},
    },
  };
  await audit.record({ ...input, phase: 'semantic_retry_final' });
  const [row] = await store.listAgentSemanticAuditEvents({ userId: 7 });
  assert.equal(row.payload.phase, 'semantic_retry_final');
  await assert.rejects(
    audit.record({ ...input, phase: 'retry_private' }),
    /AGENT_SEMANTIC_AUDIT_INVALID/u,
  );
  store.close();
});
