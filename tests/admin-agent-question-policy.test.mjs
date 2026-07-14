import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';
import { createAdminRoutes } from '../server/routes/admin.routes.mjs';
import { AGENT_QUESTION_POLICIES } from '../server/agent-question-policy.service.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function harness() {
  const store = await createSqliteStateStore({ dbPath: ':memory:' });
  const app = express();
  app.use(express.json({ limit: '300kb' }));
  app.use('/api/admin', createAdminRoutes({
    state: {}, agentQuestionPolicyStore: store, adminPassword: 'secret', nowIso: () => '2026-07-13T01:00:00.000Z',
    requireAdmin(req, res) {
      if (req.headers.authorization !== 'Bearer admin') { res.status(401).json({ ok: false }); return null; }
      return { userId: 7, token: 'admin' };
    },
  }));
  app.use((error, _req, res, _next) => res.status(400).json({ ok: false, message: error.message }));
  const running = await listen(app);
  return { ...running, store, close: async () => { await running.close(); store.close(); } };
}

async function call(h, path, { method = 'GET', body, auth = true, raw } = {}) {
  const response = await fetch(`${h.baseUrl}${path}`, { method, headers: { ...(auth ? { authorization: 'Bearer admin' } : {}), ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  return { status: response.status, body: await response.json() };
}

test('admin policy API requires auth and manages validated immutable versions', async () => {
  const h = await harness();
  try {
    assert.equal((await call(h, '/api/admin/agent-question-policies', { auth: false })).status, 401);
    const invalid = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: [{ key: 'x' }] } });
    assert.equal(invalid.status, 400);
    const first = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES, runtimeSettings: { fallbackHistoryMessageLimit: 12, productContextTtlMinutes: 90 } } });
    assert.equal(first.status, 201);
    assert.deepEqual(first.body.draft.runtimeSettings, { fallbackHistoryMessageLimit: 12, productContextTtlMinutes: 90 });
    const changed = AGENT_QUESTION_POLICIES.map((p) => p.key === 'chat' ? { ...p, enabled: false } : p);
    assert.equal((await call(h, `/api/admin/agent-question-policies/drafts/${first.body.draft.id}`, { method: 'PATCH', body: { policies: changed } })).status, 200);
    assert.equal((await call(h, `/api/admin/agent-question-policies/drafts/${first.body.draft.id}/publish`, { method: 'POST', body: {} })).status, 200);
    assert.equal((await call(h, `/api/admin/agent-question-policies/drafts/${first.body.draft.id}`, { method: 'PATCH', body: { policies: AGENT_QUESTION_POLICIES } })).status, 409);
    const second = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES } });
    await call(h, `/api/admin/agent-question-policies/drafts/${second.body.draft.id}/publish`, { method: 'POST', body: {} });
    const rolled = await call(h, `/api/admin/agent-question-policies/versions/${first.body.draft.id}/rollback`, { method: 'POST', body: {} });
    assert.equal(rolled.status, 200);
    assert.notEqual(rolled.body.published.id, first.body.draft.id);
    assert.deepEqual(rolled.body.published.runtimeSettings, { fallbackHistoryMessageLimit: 12, productContextTtlMinutes: 90 });
    const listed = await call(h, '/api/admin/agent-question-policies');
    assert.equal(listed.body.published.id, rolled.body.published.id);
    assert.equal(listed.body.history.filter((row) => row.status === 'published').length, 1);
    assert.ok(Array.isArray(listed.body.templates));
    assert.deepEqual(listed.body.defaultRuntimeSettings, { fallbackHistoryMessageLimit: 6, productContextTtlMinutes: 30 });
  } finally { await h.close(); }
});

test('admin runtime settings reject unsupported fields and unsafe ranges', async () => {
  const h = await harness();
  try {
    for (const runtimeSettings of [
      { fallbackHistoryMessageLimit: 0, productContextTtlMinutes: 30 },
      { fallbackHistoryMessageLimit: 6, productContextTtlMinutes: 1_441 },
      { fallbackHistoryMessageLimit: 6, productContextTtlMinutes: 30, sharedMemory: true },
    ]) {
      const result = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES, runtimeSettings } });
      assert.equal(result.status, 400);
    }
  } finally { await h.close(); }
});

test('publish rejects conflicts and simulation explains routing without mutation', async () => {
  const h = await harness();
  try {
    const bad = [...AGENT_QUESTION_POLICIES, { ...AGENT_QUESTION_POLICIES[0], key: 'duplicate', intent: AGENT_QUESTION_POLICIES[0].intent }];
    const draft = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: bad } });
    assert.equal((await call(h, `/api/admin/agent-question-policies/drafts/${draft.body.draft.id}/publish`, { method: 'POST', body: {} })).status, 400);
    const valid = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES } });
    const before = h.store.db.prepare("SELECT (SELECT count(*) FROM agent_unknown_questions) unknowns, (SELECT count(*) FROM agent_route_audit_events) audits, (SELECT count(*) FROM agent_action_confirmations) confirmations, (SELECT count(*) FROM agent_policy_transfer_regeneration_outbox) outbox").get();
    const simulated = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: valid.body.draft.id, candidate: { intent: 'transfer_preview', requestedOperation: 'write', confidence: 1, question: '转移' } } });
    assert.equal(simulated.status, 200);
    assert.equal(simulated.body.previewOnly, true);
    assert.equal(simulated.body.decision.policyKey, 'transfer_preview');
    assert.equal(simulated.body.decision.confirmationRequired, true);
    const after = h.store.db.prepare("SELECT (SELECT count(*) FROM agent_unknown_questions) unknowns, (SELECT count(*) FROM agent_route_audit_events) audits, (SELECT count(*) FROM agent_action_confirmations) confirmations, (SELECT count(*) FROM agent_policy_transfer_regeneration_outbox) outbox").get();
    assert.deepEqual(after, before);
    assert.equal((await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', raw: '{bad' })).status, 400);
  } finally { await h.close(); }
});

test('unknown question list is paginated and redacted, and concurrent publish keeps one published row', async () => {
  const h = await harness();
  try {
    await h.store.appendAgentUnknownQuestion({ userId: 123, messageRef: 'secret-message', question: '我的身份证 330102199001011234 手机 13812345678', actor: 'router', payload: { token: 'secret', intent: 'unknown' } });
    await h.store.appendAgentUnknownQuestion({ userId: 456, messageRef: 'other', question: '第二条', actor: 'router' });
    const page = await call(h, '/api/admin/agent-unknown-questions?limit=1&offset=0');
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.total, 2);
    assert.equal(JSON.stringify(page.body).includes('13812345678'), false);
    assert.equal(JSON.stringify(page.body).includes('secret-message'), false);
    assert.equal(JSON.stringify(page.body).includes('secret'), false);
    await h.store.appendAgentUnknownQuestion({ userId: 789, messageRef: 'mixed', question: '身份证 11010519491231002X，旧证 110105491231002，电话 13812345678', actor: 'router' });
    await h.store.appendAgentUnknownQuestion({ userId: 790, messageRef: 'private', question: '张三 北京市朝阳区 name@example.com 银行卡 6222020202020202', actor: 'router' });
    const redacted = await call(h, '/api/admin/agent-unknown-questions?limit=100&offset=999999');
    assert.equal(redacted.body.offset, 100000);
    const firstPage = await call(h, '/api/admin/agent-unknown-questions?limit=100');
    const serialized = JSON.stringify(firstPage.body);
    assert.equal(serialized.includes('11010519491231002X'), false);
    assert.equal(serialized.includes('110105491231002'), false);
    assert.equal(serialized.includes('13812345678'), false);
    for (const sensitive of ['张三', '北京市朝阳区', 'name@example.com', '6222020202020202']) assert.equal(serialized.includes(sensitive), false);
    assert.equal(Object.hasOwn(firstPage.body.items[0], 'question'), false);
    assert.equal(Object.hasOwn(firstPage.body.items[0], 'normalizedQuestion'), false);
    const a = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES } });
    const b = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES } });
    await Promise.all([a, b].map((row) => call(h, `/api/admin/agent-question-policies/drafts/${row.body.draft.id}/publish`, { method: 'POST', body: {} })));
    assert.equal(h.store.db.prepare("SELECT count(*) count FROM agent_question_policy_versions WHERE status='published'").get().count, 1);
  } finally { await h.close(); }
});

test('simulation uses router confidence and authorized-family decisions without writes', async () => {
  const h = await harness();
  try {
    const policies = AGENT_QUESTION_POLICIES.map((policy) => policy.key === 'coverage_report' ? { ...policy, confidenceThreshold: 0.8 } : policy);
    const draft = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies } });
    const low = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: draft.body.draft.id, candidate: { intent: 'coverage_report', requestedOperation: 'read', confidence: 0.2, entities: { familyName: '甲家庭' } } } });
    assert.equal(low.body.decision.decision, 'clarify');
    assert.equal(low.body.decision.result, 'low_confidence');
    const unauthorized = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: draft.body.draft.id, candidate: { intent: 'coverage_report', requestedOperation: 'read', confidence: 1, entities: { familyName: '甲家庭' } } } });
    assert.equal(unauthorized.body.decision.decision, 'clarify');
    assert.equal(unauthorized.body.decision.familyResolved, false);
    const state = await h.store.load();
    state.familyProfiles.push({ id: 91, ownerUserId: 7, familyName: '甲家庭', status: 'active', members: [] });
    await h.store.persist(state);
    const tableCounts = () => Object.fromEntries(h.store.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(({ name }) => [name, Number(h.store.db.prepare(`SELECT count(*) count FROM ${name}`).get().count)]));
    const before = tableCounts();
    const authorized = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: draft.body.draft.id, candidate: { intent: 'coverage_report', requestedOperation: 'read', confidence: 1, entities: { familyName: '甲家庭' } } } });
    assert.equal(authorized.body.decision.decision, 'execute');
    assert.equal(authorized.body.decision.familyResolved, true);
    const write = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: draft.body.draft.id, candidate: { intent: 'transfer_preview', requestedOperation: 'write', confidence: 1 } } });
    assert.equal(write.body.decision.result, 'write_preview');
    assert.equal(write.body.decision.decision, 'confirm');
    assert.deepEqual(tableCounts(), before);
  } finally { await h.close(); }
});

test('draft policy items reject extra fields and non-boolean enabled values', async () => {
  const h = await harness();
  try {
    for (const policy of [
      { ...AGENT_QUESTION_POLICIES[0], injected: 'no' },
      { ...AGENT_QUESTION_POLICIES[0], enabled: 'false' },
    ]) {
      const created = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: [policy] } });
      assert.equal(created.status, 400);
    }
    const valid = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES } });
    const patched = await call(h, `/api/admin/agent-question-policies/drafts/${valid.body.draft.id}`, { method: 'PATCH', body: { policies: [{ ...AGENT_QUESTION_POLICIES[0], extra: true }] } });
    assert.equal(patched.status, 400);
  } finally { await h.close(); }
});

test('simulation requires a positive draft id and an existing draft version', async () => {
  const h = await harness();
  try {
    const candidate = { intent: 'chat', requestedOperation: 'read' };
    for (const draftId of [0, -1, 1.5, '1']) {
      assert.equal((await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId, candidate } })).status, 400);
    }
    assert.equal((await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: 999, candidate } })).status, 404);
    const draft = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES } });
    const draftFallback = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: draft.body.draft.id, candidate: { intent: 'missing', requestedOperation: 'read' } } });
    assert.equal(draftFallback.body.decision.policySource, 'draft');
    assert.match(draftFallback.body.decision.explanation, /draft policy/iu);
    await call(h, `/api/admin/agent-question-policies/drafts/${draft.body.draft.id}/publish`, { method: 'POST', body: {} });
    assert.equal((await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { draftId: draft.body.draft.id, candidate } })).status, 409);
    const publishedFallback = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { candidate: { intent: 'missing', requestedOperation: 'read' } } });
    assert.equal(publishedFallback.body.decision.policySource, 'published');
    assert.match(publishedFallback.body.decision.explanation, /published policy/iu);
  } finally { await h.close(); }
});

test('rollback rejects drafts and fallback explanation identifies operation and built-in source', async () => {
  const h = await harness();
  try {
    const draft = await call(h, '/api/admin/agent-question-policies/drafts', { method: 'POST', body: { policies: AGENT_QUESTION_POLICIES } });
    assert.equal((await call(h, `/api/admin/agent-question-policies/versions/${draft.body.draft.id}/rollback`, { method: 'POST', body: {} })).status, 409);
    const fallback = await call(h, '/api/admin/agent-question-policies/simulate', { method: 'POST', body: { candidate: { intent: 'missing', requestedOperation: 'write' } } });
    assert.equal(fallback.body.decision.policyKey, 'unknown_write');
    assert.equal(fallback.body.decision.policySource, 'built_in');
    assert.match(fallback.body.decision.explanation, /unknown_write.*write.*built-in/iu);
    assert.doesNotMatch(fallback.body.decision.explanation, /matched/iu);
  } finally { await h.close(); }
});
