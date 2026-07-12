import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

async function fixture({ ambiguous = false, noProducts = false, scanner, rejectPersistAt = 0 } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-import-e2e-'));
  const store = await createSqliteStateStore({ dbPath: path.join(dir, 'state.sqlite') });
  const state = createInitialState();
  Object.assign(state, {
    nextId: 100,
    users: [{ id: 1, name: '顾问', status: 'active' }, { id: 2, name: '他人', status: 'active' }],
    sessions: [{ token: 'owner-token', userId: 1 }, { token: 'other-token', userId: 2 }],
    userDingtalkIdentities: [
      { corpId: 'corp', dingUserId: 'ding', userId: 1, status: 'active' },
      { corpId: 'corp', dingUserId: 'ding-other', userId: 2, status: 'active' },
    ],
    familyProfiles: [{ id: 10, ownerUserId: 1, status: 'active', familyName: '家庭一' }, { id: 20, ownerUserId: 2, status: 'active', familyName: '家庭二' }],
    familyMembers: [
      { id: 31, familyId: 10, name: '张三', status: 'active' },
      ...(ambiguous ? [{ id: 32, familyId: 10, name: '张 三', status: 'active' }] : []),
      { id: 33, familyId: 10, name: '李四', status: 'active' },
      { id: 41, familyId: 20, name: '王五', status: 'active' },
    ],
    knowledgeRecords: noProducts ? [] : [
      { id: 51, company: '可信保险', productName: '安心保', url: 'https://example.test/p1' },
      ...(ambiguous ? [{ id: 52, company: '可信保险', productName: '安心保', url: 'https://example.test/p2' }] : []),
    ],
  });
  await store.persist(state);
  const loaded = await store.load();
  let persistCount = 0;
  const persistTask = async (input) => {
    persistCount += 1;
    if (persistCount === rejectPersistAt) throw Object.assign(new Error('persist rejected'), { code: 'PERSIST_REJECTED', status: 503 });
    return store.persistAgentPolicyImportTask(input);
  };
  const app = createPolicyOcrApp({
    state: loaded,
    scanner: scanner || (async () => ({ data: { company: '可信保险', name: '安心保', insured: '张三', applicant: '李四' }, ocrText: 'RAW_SECRET_OCR' })),
    persistAgentPolicyImportTask: persistTask,
    findAgentPolicyImportTask: store.findAgentPolicyImportTask,
    authenticateDingtalkServiceRequest: () => true,
    recomputeCashflowOnStartup: false,
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(url, { token = 'owner-token', method = 'GET', body } = {}) {
    const response = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, payload: await response.json() };
  }
  return { store, loaded, request, close: async () => { await new Promise((resolve) => server.close(resolve)); store.close(); await fs.rm(dir, { recursive: true, force: true }); } };
}

const image = (text) => `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from(text), Buffer.from([0xff, 0xd9])]).toString('base64')}`;

test('family policy import E2E hashes, merges, dedupes, auto-resolves trusted exact matches, and never leaks OCR', async () => {
  const ctx = await fixture();
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    assert.equal(started.status, 201);
    const appended = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, {
      method: 'POST', body: { stateVersion: 1, files: [{ uploadItem: image('one'), name: 'one.jpg' }, { uploadItem: image('two'), name: 'two.jpg' }] },
    });
    assert.equal(appended.status, 200);
    assert.equal(appended.payload.task.documentSummary.count, 2);
    assert.equal(appended.payload.task.status, 'final_confirmation');
    assert.deepEqual(appended.payload.task.resolution, { product: 'trusted_match', insuredMember: 'resolved', applicantMember: 'resolved' });
    const serialized = JSON.stringify(appended.payload);
    for (const secret of ['RAW_SECRET_OCR', image('one'), 'uploadItem', 'fieldEvidence', 'dataURL']) assert.equal(serialized.includes(secret), false, secret);
    const duplicate = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, {
      method: 'POST', body: { stateVersion: appended.payload.task.stateVersion, files: [{ uploadItem: image('one'), name: 'copy.jpg' }] },
    });
    assert.equal(duplicate.payload.task.documentSummary.count, 2);
    assert.equal(duplicate.payload.task.stateVersion, appended.payload.task.stateVersion);
    const stale = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: 1, action: 'confirm' } });
    assert.equal(stale.status, 409);
    assert.equal(stale.payload.code, 'STALE_INTERACTION');
    assert.equal((await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}`, { token: 'other-token' })).status, 404);
  } finally { await ctx.close(); }
});

test('ambiguous product and member matches require only legal option actions', async () => {
  const ctx = await fixture({ ambiguous: true });
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    let result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, { method: 'POST', body: { stateVersion: 1, files: [{ uploadItem: image('ambiguous') }] } });
    assert.equal(result.payload.task.status, 'candidate_selection');
    assert.equal(result.payload.task.legalOptions.products.length, 2);
    const forged = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: result.payload.task.stateVersion, action: 'select_product', optionId: 'invented' } });
    assert.equal(forged.status, 400);
    result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: result.payload.task.stateVersion, action: 'select_product', optionId: result.payload.task.legalOptions.products[0].optionId } });
    assert.equal(result.payload.task.status, 'member_binding');
    const member = result.payload.task.legalOptions.members.find((option) => option.optionId === 'member_31');
    result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: result.payload.task.stateVersion, action: 'bind_member', role: 'insured', optionId: member.optionId } });
    assert.equal(result.payload.task.status, 'final_confirmation');
  } finally { await ctx.close(); }
});

test('no trusted product match requires explicit manual product confirmation', async () => {
  const ctx = await fixture({ noProducts: true });
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    let result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, { method: 'POST', body: { stateVersion: 1, files: [{ uploadItem: image('manual') }] } });
    assert.equal(result.payload.task.nextInteraction.type, 'confirm_product_manual');
    result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: result.payload.task.stateVersion, action: 'confirm_product_manual' } });
    assert.equal(result.payload.task.status, 'final_confirmation');
    assert.equal(result.payload.task.resolution.product, 'manual_confirmed');
  } finally { await ctx.close(); }
});

test('OCR failure and persistence rejection preserve durable and in-memory transition boundaries', async () => {
  const ctx = await fixture({ scanner: async () => { throw new Error('ocr failed'); } });
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    const result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, { method: 'POST', body: { stateVersion: 1, files: [{ uploadItem: image('bad') }] } });
    assert.equal(result.payload.task.documentSummary.statuses.failed, 1);
    const reloaded = await ctx.store.load();
    assert.equal(reloaded.agentPolicyImportTasks[0].documents[0].status, 'failed');
  } finally { await ctx.close(); }
});

test('persistence rejection rolls back the in-memory append', async () => {
  const ctx = await fixture({ rejectPersistAt: 2 });
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    const rejected = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, { method: 'POST', body: { stateVersion: 1, files: [{ uploadItem: image('rollback') }] } });
    assert.equal(rejected.status, 503);
    const current = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}`);
    assert.equal(current.payload.task.stateVersion, 1);
    assert.equal(current.payload.task.documentSummary.count, 0);
  } finally { await ctx.close(); }
});

test('Wukong-created and appended task is readable and actionable through web family auth', async () => {
  const ctx = await fixture();
  try {
    const invoke = (requestId, tool, input) => ctx.request('/api/wukong/mcp', {
      method: 'POST', body: { corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', requestId, tool, input },
    });
    const started = await invoke('mcp-start', 'start_policy_import', { familyRef: 10 });
    const taskId = started.payload.result.taskId;
    const appended = await invoke('mcp-append', 'append_policy_import_files', { familyRef: 10, taskId, stateVersion: 1, files: [{ uploadItem: image('mcp') }] });
    assert.equal(appended.payload.result.status, 'final_confirmation');
    const retrieved = await invoke('mcp-get', 'get_policy_import', { familyRef: 10, taskId });
    assert.equal(retrieved.status, 200);
    assert.deepEqual(retrieved.payload.result, appended.payload.result);
    const retrievedJson = JSON.stringify(retrieved.payload.result);
    for (const secret of ['RAW_SECRET_OCR', image('mcp'), 'uploadItem', 'fieldEvidence', 'evidence', 'ownerUserId']) assert.equal(retrievedJson.includes(secret), false, secret);
    const forged = await ctx.request('/api/wukong/mcp', {
      method: 'POST',
      body: { corpId: 'corp', dingUserId: 'ding-other', conversationType: 'direct', requestId: 'mcp-forged-get', tool: 'get_policy_import', input: { familyRef: 10, taskId } },
    });
    assert.equal(forged.status, 404);
    assert.equal(forged.payload.code, 'FAMILY_NOT_FOUND');
    const read = await ctx.request(`/api/family-profiles/10/policy-imports/${taskId}`);
    assert.equal(read.payload.task.taskId, taskId);
    assert.equal(read.payload.task.channel, 'wukong');
    assert.equal(JSON.stringify(read.payload).includes('RAW_SECRET_OCR'), false);
    const action = await invoke('mcp-action', 'apply_policy_import_action', { familyRef: 10, taskId, stateVersion: read.payload.task.stateVersion, action: 'confirm' });
    assert.equal(action.payload.result.status, 'saving');
  } finally { await ctx.close(); }
});

test('strict upload validation rejects invalid base64 and spoofed signatures before mutation', async () => {
  const ctx = await fixture();
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    for (const uploadItem of ['data:image/jpeg;base64,%%%=', `data:image/png;base64,${Buffer.from('%PDF-fake').toString('base64')}`]) {
      const result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, { method: 'POST', body: { stateVersion: 1, files: [{ uploadItem }] } });
      assert.equal(result.status, 400);
    }
    const current = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}`);
    assert.equal(current.payload.task.documentSummary.count, 0);
  } finally { await ctx.close(); }
});

test('expired scanning lease is durably recovered and the same hash can be retried', async () => {
  const ctx = await fixture();
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    const task = ctx.loaded.agentPolicyImportTasks[0];
    const bytes = Buffer.from([0xff, 0xd8, 1, 0xff, 0xd9]);
    const sha256 = (await import('node:crypto')).default.createHash('sha256').update(bytes).digest('hex');
    const scanning = structuredClone(task);
    scanning.documents = [{ documentId: 'doc_expired', sha256, name: 'expired.jpg', mediaType: 'image/jpeg', size: bytes.length, status: 'scanning', scanAttempt: 1, scanLeaseUntil: '2020-01-01T00:00:00.000Z' }];
    scanning.status = 'recognizing';
    scanning.stateVersion = 2;
    await ctx.store.persistAgentPolicyImportTask({ state: ctx.loaded, task: scanning, expectedVersion: 1 });
    ctx.loaded.agentPolicyImportTasks[0] = scanning;
    const recovered = await ctx.request(`/api/family-profiles/10/policy-imports/${task.id}`);
    assert.equal(recovered.payload.task.documentSummary.statuses.failed, 1);
    const retried = await ctx.request(`/api/family-profiles/10/policy-imports/${task.id}/files`, { method: 'POST', body: { stateVersion: recovered.payload.task.stateVersion, files: [{ uploadItem: `data:image/jpeg;base64,${bytes.toString('base64')}` }] } });
    assert.equal(retried.payload.task.documentSummary.statuses.recognized, 1);
    assert.equal((await ctx.store.load()).agentPolicyImportTasks[0].documents[0].scanAttempt, 1);
  } finally { await ctx.close(); }
});

test('restart recovery converts a durable received document to retryable and same-hash reupload completes it', async () => {
  const ctx = await fixture();
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    const task = ctx.loaded.agentPolicyImportTasks[0];
    const bytes = Buffer.from([0xff, 0xd8, 2, 0xff, 0xd9]);
    const sha256 = (await import('node:crypto')).default.createHash('sha256').update(bytes).digest('hex');
    const received = { ...structuredClone(task), documents: [{ documentId: 'doc_received', sha256, name: 'queued.jpg', mediaType: 'image/jpeg', size: bytes.length, status: 'received', scanAttempt: 0 }], status: 'recognizing', stateVersion: 2 };
    await ctx.store.persistAgentPolicyImportTask({ state: ctx.loaded, task: received, expectedVersion: 1 });
    ctx.loaded.agentPolicyImportTasks[0] = received;
    const recovered = await ctx.request(`/api/family-profiles/10/policy-imports/${task.id}`);
    assert.equal(recovered.payload.task.documentSummary.statuses.failed, 1);
    const retried = await ctx.request(`/api/family-profiles/10/policy-imports/${task.id}/files`, { method: 'POST', body: { stateVersion: recovered.payload.task.stateVersion, files: [{ uploadItem: `data:image/jpeg;base64,${bytes.toString('base64')}` }] } });
    assert.equal(retried.payload.task.documentSummary.statuses.recognized, 1);
    assert.equal(retried.payload.task.status, 'final_confirmation');
  } finally { await ctx.close(); }
});

test('equal-confidence conflicting OCR values produce stable evidence and an explicit field conflict', async () => {
  async function run(order) {
    const ctx = await fixture({ scanner: async ({ uploadItem }) => ({ data: { company: '可信保险', name: '安心保', insured: Buffer.from(uploadItem.split(',')[1], 'base64').includes(65) ? '甲' : '乙' }, fieldConfidence: { insured: 0.8 } }) });
    try {
      const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
      const result = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, { method: 'POST', body: { stateVersion: 1, files: order.map((value) => ({ uploadItem: image(value) })) } });
      const stored = (await ctx.store.load()).agentPolicyImportTasks[0];
      return { status: result.payload.task.status, conflicts: stored.fieldConflicts, candidates: stored.documents.flatMap((document) => document.evidence?.candidates || []).filter((candidate) => candidate.field === 'insured').map(({ documentId, ...candidate }) => candidate).sort((a, b) => a.sha256.localeCompare(b.sha256)) };
    } finally { await ctx.close(); }
  }
  const forward = await run(['A', 'B']);
  const reverse = await run(['B', 'A']);
  assert.equal(forward.status, 'field_completion');
  assert.deepEqual(forward.conflicts, ['insured']);
  assert.deepEqual(forward.candidates, reverse.candidates);
});

test('action options are refreshed so archived members and removed products cannot be selected', async () => {
  const ctx = await fixture({ ambiguous: true });
  try {
    const started = await ctx.request('/api/family-profiles/10/policy-imports', { method: 'POST', body: {} });
    const scanned = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/files`, { method: 'POST', body: { stateVersion: 1, files: [{ uploadItem: image('fresh') }] } });
    const oldProduct = scanned.payload.task.legalOptions.products[0].optionId;
    ctx.loaded.knowledgeRecords = [];
    const staleProduct = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: scanned.payload.task.stateVersion, action: 'select_product', optionId: oldProduct } });
    assert.equal(staleProduct.status, 400);
    ctx.loaded.knowledgeRecords = [{ id: 51, company: '可信保险', productName: '安心保' }];
    const selected = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: scanned.payload.task.stateVersion, action: 'select_product', optionId: oldProduct } });
    ctx.loaded.familyMembers.find((member) => member.id === 31).status = 'archived';
    const staleMember = await ctx.request(`/api/family-profiles/10/policy-imports/${started.payload.task.taskId}/actions`, { method: 'POST', body: { stateVersion: selected.payload.task.stateVersion, action: 'bind_member', role: 'insured', optionId: 'member_31' } });
    assert.equal(staleMember.status, 400);
  } finally { await ctx.close(); }
});
