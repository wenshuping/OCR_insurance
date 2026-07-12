import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentPolicyImportFinalizer } from '../server/agent-policy-import-finalize.service.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

function task(overrides = {}) {
  return { id: 41, familyId: 10, ownerUserId: 7, ownerGuestId: '', status: 'saving', stateVersion: 5,
    draft: { company: '可信保险', name: '安心保', insured: '张三', applicant: '李四', productId: 51, insuredMemberId: 31, applicantMemberId: 32, plans: [] },
    documents: [{ documentId: 'doc', sha256: 'a'.repeat(64), name: 'policy.jpg', mediaType: 'image/jpeg', size: 10, status: 'recognized', scanAttempt: 1 }], fieldConflicts: [], productResolution: 'trusted_match',
    events: [{ action: 'confirm', status: 'saving', stateVersion: 5, createdAt: '2026-07-12T00:00:00.000Z' }],
    createdAt: '2026-07-12T00:00:00.000Z', updatedAt: '2026-07-12T00:00:00.000Z', ...overrides };
}

function stateFor(current = task()) {
  return { ...createInitialState(), nextId: 100, users: [{ id: 7, status: 'active' }], familyProfiles: [{ id: 10, ownerUserId: 7, status: 'active' }],
    familyMembers: [{ id: 31, familyId: 10, name: '张三', status: 'active' }, { id: 32, familyId: 10, name: '李四', status: 'active' }],
    knowledgeRecords: [{ id: 51, company: '可信保险', productName: '安心保' }], agentPolicyImportTasks: [current], policies: [] };
}

test('finalize rejects incomplete, changed permission, absent confirmation, stale, pending and conflict states', async () => {
  const cases = [[task({ draft: { ...task().draft, insured: '' } }), 'POLICY_IMPORT_INCOMPLETE'], [task({ events: [] }), 'FINAL_CONFIRMATION_REQUIRED'], [task({ documents: [{ ...task().documents[0], status: 'failed' }] }), 'POLICY_IMPORT_DOCUMENTS_PENDING'], [task({ fieldConflicts: ['insured'] }), 'POLICY_IMPORT_CONFLICT']];
  for (const [current, code] of cases) {
    const state = stateFor(current);
    const finalize = createAgentPolicyImportFinalizer({ state, findRecord: async () => null, reserve: async () => assert.fail('reserve') });
    await assert.rejects(finalize({ task: current, family: state.familyProfiles[0], owner: { userId: 7 }, requestId: `req-${code}`, stateVersion: 5 }), { code });
  }
  const current = task(); const state = stateFor(current); state.familyMembers[0].status = 'archived';
  const finalize = createAgentPolicyImportFinalizer({ state, findRecord: async () => null });
  await assert.rejects(finalize({ task: current, family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'permission', stateVersion: 5 }), { code: 'POLICY_IMPORT_PERMISSION_CHANGED' });
  await assert.rejects(finalize({ task: current, family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'stale', stateVersion: 4 }), { code: 'STALE_INTERACTION' });
});

test('SQLite finalization is idempotent, durable across restart, and records one policy and immutable completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-')); const dbPath = path.join(directory, 'state.sqlite'); const initial = stateFor();
  const store = await createSqliteStateStore({ dbPath }); await store.persist(initial); let creates = 0;
  const finalize = createAgentPolicyImportFinalizer({ state: initial, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, nowIso: () => '2026-07-12T01:00:00.000Z',
    createPolicy: async () => { creates += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { id: 99, userId: 7, company: '可信保险', name: '安心保', insured: '张三', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' }; } });
  const input = { task: initial.agentPolicyImportTasks[0], family: initial.familyProfiles[0], owner: { userId: 7 }, requestId: 'stable-request', stateVersion: 5 };
  const [first, concurrent] = await Promise.all([finalize(input), finalize(input)]); const duplicate = await finalize(input);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(duplicate, first); assert.equal(creates, 1); assert.deepEqual(Object.keys(first).sort(), ['completedAt', 'policyId', 'summary', 'taskId']);
  assert.doesNotMatch(JSON.stringify(first), /ownerUserId|sourcePolicy|documents|evidence|张三/u);
  store.close(); const restarted = await createSqliteStateStore({ dbPath }); const loaded = await restarted.load();
  assert.equal(loaded.policies.length, 1); assert.equal(loaded.agentPolicyImportTasks[0].status, 'completed');
  assert.equal((await restarted.findAgentPolicyImportFinalization({ ownerUserId: 7, taskId: 41, requestId: 'stable-request' })).formalPolicyId, 99); restarted.close();
});

test('reserved unknown outcomes reconcile by source task marker and never create again', async () => {
  const current = task(); const state = stateFor(current); state.policies.push({ id: 77, userId: 7, sourcePolicyImportTaskId: 41 }); let creates = 0; let completed;
  const finalize = createAgentPolicyImportFinalizer({ state, findRecord: async ({ requestId }) => requestId ? { ownerUserId: 7, taskId: 41, requestId, status: 'failed_unknown' } : null,
    complete: async (value) => { completed = value; }, createPolicy: async () => { creates += 1; }, nowIso: () => '2026-07-12T02:00:00.000Z' });
  const result = await finalize({ task: current, family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'retry', stateVersion: 5 });
  assert.equal(result.policyId, 77); assert.equal(creates, 0); assert.equal(completed.task.status, 'completed');
});
