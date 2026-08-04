import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
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

test('finalize validates owner, active family, saving phase, product, and both member bindings without mutation', async () => {
  const baseTask = task();
  const cases = [
    [{ current: baseTask, family: { id: 10, ownerUserId: 7, status: 'active' }, owner: { userId: 8 } }, 'POLICY_IMPORT_NOT_FOUND'],
    [{ current: baseTask, family: { id: 11, ownerUserId: 7, status: 'active' }, owner: { userId: 7 } }, 'POLICY_IMPORT_NOT_FOUND'],
    [{ current: baseTask, family: { id: 10, ownerUserId: 7, status: 'archived' }, owner: { userId: 7 } }, 'FAMILY_NOT_FOUND'],
    [{ current: task({ status: 'final_confirmation' }), family: { id: 10, ownerUserId: 7, status: 'active' }, owner: { userId: 7 } }, 'FINAL_CONFIRMATION_REQUIRED'],
    [{ current: task({ productResolution: '' }), family: { id: 10, ownerUserId: 7, status: 'active' }, owner: { userId: 7 } }, 'POLICY_IMPORT_PRODUCT_UNRESOLVED'],
    [{ current: task({ draft: { ...baseTask.draft, productId: 52 } }), family: { id: 10, ownerUserId: 7, status: 'active' }, owner: { userId: 7 } }, 'POLICY_IMPORT_PRODUCT_CHANGED'],
    [{ current: task({ draft: { ...baseTask.draft, insuredMemberId: undefined } }), family: { id: 10, ownerUserId: 7, status: 'active' }, owner: { userId: 7 } }, 'POLICY_IMPORT_MEMBER_UNRESOLVED'],
    [{ current: task({ draft: { ...baseTask.draft, applicantMemberId: undefined } }), family: { id: 10, ownerUserId: 7, status: 'active' }, owner: { userId: 7 } }, 'POLICY_IMPORT_MEMBER_UNRESOLVED'],
  ];
  for (const [{ current, family, owner }, code] of cases) {
    const state = stateFor(current); let creates = 0; let reservations = 0; const before = structuredClone(current);
    const finalize = createAgentPolicyImportFinalizer({ state, findRecord: async () => null, reserve: async () => { reservations += 1; }, createPolicy: async () => { creates += 1; } });
    await assert.rejects(finalize({ task: current, family, owner, requestId: `validation-${code}`, stateVersion: current.stateVersion }), { code });
    assert.deepEqual(current, before); assert.equal(creates, 0); assert.equal(reservations, 0);
  }
});

test('SQLite finalization is idempotent, durable across restart, and records one policy and immutable completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-')); const dbPath = path.join(directory, 'state.sqlite'); const initial = stateFor();
  const store = await createSqliteStateStore({ dbPath }); await store.persist(initial); let creates = 0;
  const finalize = createAgentPolicyImportFinalizer({ state: initial, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, nowIso: () => '2026-07-12T01:00:00.000Z',
    failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask,
    createPolicy: async ({ reservedPolicyId }) => { creates += 1; await new Promise((resolve) => setTimeout(resolve, 5)); return { id: reservedPolicyId, userId: 7, company: '可信保险', name: '安心保', insured: '张三', createdAt: '2026-07-12T01:00:00.000Z', updatedAt: '2026-07-12T01:00:00.000Z' }; } });
  const input = { task: initial.agentPolicyImportTasks[0], family: initial.familyProfiles[0], owner: { userId: 7 }, requestId: 'stable-request', stateVersion: 5 };
  const [first, concurrent] = await Promise.all([finalize(input), finalize(input)]); const duplicate = await finalize(input);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(duplicate, first); assert.equal(creates, 1); assert.deepEqual(Object.keys(first).sort(), ['completedAt', 'policyId', 'summary', 'taskId']);
  assert.doesNotMatch(JSON.stringify(first), /ownerUserId|sourcePolicy|documents|evidence|张三/u);
  store.close(); const restarted = await createSqliteStateStore({ dbPath }); const loaded = await restarted.load();
  assert.equal(loaded.policies.length, 1); assert.equal(loaded.agentPolicyImportTasks[0].status, 'completed');
  assert.equal(loaded.agentPolicyImportTasks[0].events.filter((event) => event.action === 'mark_saved').length, 1);
  assert.equal(restarted.db.prepare(`SELECT COUNT(*) AS count FROM agent_policy_import_finalizations WHERE owner_user_id = 7 AND task_id = 41 AND status = 'completed'`).get().count, 1);
  assert.equal((await restarted.findAgentPolicyImportFinalization({ ownerUserId: 7, taskId: 41, requestId: 'stable-request' })).formalPolicyId, first.policyId); restarted.close();
});

test('cross-instance same and different request IDs serialize to one policy create', async () => {
  for (const requestIds of [['same', 'same'], ['first', 'different']]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-race-')); const dbPath = path.join(directory, 'state.sqlite');
    const seed = stateFor(); const firstStore = await createSqliteStateStore({ dbPath }); await firstStore.persist(seed);
    const secondStore = await createSqliteStateStore({ dbPath }); const firstState = await firstStore.load(); const secondState = await secondStore.load(); let creates = 0;
    firstState.knowledgeRecords = seed.knowledgeRecords; secondState.knowledgeRecords = seed.knowledgeRecords;
    const make = (store, state) => createAgentPolicyImportFinalizer({ state, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask,
      waitIntervalMs: 2, waitTimeoutMs: 2_000,
      createPolicy: async ({ reservedPolicyId }) => { creates += 1; await new Promise((resolve) => setTimeout(resolve, 30)); return { id: reservedPolicyId, userId: 7, company: '可信保险', name: '安心保', insured: '张三' }; } });
    const base = (state, requestId) => ({ task: state.agentPolicyImportTasks[0], family: state.familyProfiles[0], owner: { userId: 7 }, requestId, stateVersion: 5 });
    const results = await Promise.allSettled([make(firstStore, firstState)(base(firstState, requestIds[0])), make(secondStore, secondState)(base(secondState, requestIds[1]))]);
    assert.equal(creates, 1, JSON.stringify(results.map((row) => row.status === 'rejected' ? { code: row.reason?.code, message: row.reason?.message } : row)));
    assert.equal(results.filter((row) => row.status === 'fulfilled').length, 2);
    assert.deepEqual(results[0].value, results[1].value);
    const retryState = await secondStore.load();
    const retry = await make(secondStore, retryState)({ ...base(retryState, 'third'), stateVersion: retryState.agentPolicyImportTasks[0].stateVersion });
    assert.equal(retry.policyId, results[0].value.policyId); assert.equal(creates, 1);
    firstStore.close(); secondStore.close();
  }
});

test('policy source marker reconciles a crash after save and unknown without marker fails closed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-reconcile-')); const dbPath = path.join(directory, 'state.sqlite'); const state = stateFor();
  const store = await createSqliteStateStore({ dbPath }); await store.persist(state);
  const reservation = await store.reserveAgentPolicyImportFinalization({ state, task: state.agentPolicyImportTasks[0], ownerUserId: 7, requestId: 'crash', expectedVersion: 5, now: '2026-07-12T02:00:00.000Z', leaseUntil: '2026-07-12T02:01:00.000Z' });
  assert.equal(reservation.task.stateVersion, 6); assert.equal(reservation.task.finalizeRequestId, 'crash');
  const policy = { id: reservation.record.reservedPolicyId, userId: 7, company: '可信保险', name: '安心保', insured: '张三', sourcePolicyImportTaskId: 41, sourcePolicyImportRequestId: 'crash' };
  state.policies.push(policy); await store.persistPolicyState({ state, policy });
  const restarted = await store.load(); let creates = 0;
  const finalize = createAgentPolicyImportFinalizer({ state: restarted, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask, createPolicy: async () => { creates += 1; } });
  const result = await finalize({ task: restarted.agentPolicyImportTasks[0], family: restarted.familyProfiles[0], owner: { userId: 7 }, requestId: 'crash', stateVersion: 6 });
  assert.equal(result.policyId, policy.id); assert.equal(creates, 0);
  const sourceRow = store.db.prepare('SELECT source_policy_import_task_id, source_policy_import_request_id FROM policies WHERE id = ?').get(policy.id);
  assert.equal(sourceRow.source_policy_import_task_id, 41); assert.equal(sourceRow.source_policy_import_request_id, 'crash');
  store.close();
});

test('unknown outcome without a source marker fails closed and precommit failure returns to confirmation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-failure-')); const dbPath = path.join(directory, 'state.sqlite'); const state = stateFor();
  const store = await createSqliteStateStore({ dbPath }); await store.persist(state);
  const options = { state, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask };
  const precommit = createAgentPolicyImportFinalizer({ ...options, createPolicy: async () => { throw Object.assign(new Error('validation failed'), { code: 'CREATE_REJECTED' }); } });
  await assert.rejects(precommit({ task: state.agentPolicyImportTasks[0], family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'precommit', stateVersion: 5 }), { code: 'CREATE_REJECTED' });
  const retryTask = await store.findAgentPolicyImportTask(41);
  assert.equal(retryTask.status, 'final_confirmation');
  assert.equal(retryTask.events.filter((event) => event.action === 'finalize_precommit_failed').length, 1);

  retryTask.status = 'saving'; retryTask.stateVersion += 1; retryTask.events.push({ action: 'confirm', status: 'saving', stateVersion: retryTask.stateVersion, createdAt: retryTask.updatedAt });
  await store.persistAgentPolicyImportTask({ state, task: retryTask, expectedVersion: retryTask.stateVersion - 1 });
  const reservation = await store.reserveAgentPolicyImportFinalization({ state, task: retryTask, ownerUserId: 7, requestId: 'unknown', expectedVersion: retryTask.stateVersion, now: '2026-07-12T03:00:00.000Z', leaseUntil: '2026-07-12T03:01:00.000Z' });
  const expired = await store.reserveAgentPolicyImportFinalization({ state, task: reservation.task, ownerUserId: 7, requestId: 'unknown', expectedVersion: reservation.task.stateVersion, now: '2026-07-12T03:02:00.000Z', leaseUntil: '2026-07-12T03:03:00.000Z' });
  assert.equal(expired.outcome, 'unknown');
  const unknownState = await store.load(); let creates = 0;
  const unknown = createAgentPolicyImportFinalizer({ ...options, state: unknownState, createPolicy: async () => { creates += 1; } });
  await assert.rejects(unknown({ task: unknownState.agentPolicyImportTasks[0], family: unknownState.familyProfiles[0], owner: { userId: 7 }, requestId: 'unknown', stateVersion: reservation.task.stateVersion }), { code: 'FINALIZATION_OUTCOME_UNKNOWN' });
  assert.equal(creates, 0);
  store.close();
});

test('reserved policy id collision never overwrites an unrelated policy', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-collision-')); const dbPath = path.join(directory, 'state.sqlite'); const state = stateFor();
  const store = await createSqliteStateStore({ dbPath }); await store.persist(state);
  let unrelated;
  const finalize = createAgentPolicyImportFinalizer({ state, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask,
    createPolicy: async ({ reservedPolicyId }) => {
      unrelated = { id: reservedPolicyId, userId: 99, company: '其他保险', name: '不得覆盖', insured: '王五', createdAt: '2026-07-12T04:00:00.000Z', updatedAt: '2026-07-12T04:00:00.000Z' };
      const writer = await createSqliteStateStore({ dbPath }); const writerState = await writer.load(); writerState.policies.push(unrelated); await writer.persistPolicyState({ state: writerState, policy: unrelated }); writer.close();
      return { id: reservedPolicyId, userId: 7, company: '可信保险', name: '安心保', insured: '张三' };
    } });
  await assert.rejects(finalize({ task: state.agentPolicyImportTasks[0], family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'collision', stateVersion: 5 }), { code: 'FINALIZATION_OUTCOME_UNKNOWN' });
  const stored = store.db.prepare('SELECT payload FROM policies WHERE id = ?').get(unrelated.id);
  assert.deepEqual(JSON.parse(stored.payload), unrelated);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM policies').get().count, 1);
  store.close();
});

test('durable family and member changes block reservation and completion', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-toctou-')); const dbPath = path.join(directory, 'state.sqlite'); const state = stateFor();
  const store = await createSqliteStateStore({ dbPath }); await store.persist(state);
  const archivedFamily = { ...state.familyProfiles[0], status: 'archived' };
  store.db.prepare(`UPDATE family_profiles SET status = 'archived', payload = ? WHERE id = 10`).run(JSON.stringify(archivedFamily));
  const baseOptions = { state, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask };
  let creates = 0;
  await assert.rejects(createAgentPolicyImportFinalizer({ ...baseOptions, createPolicy: async () => { creates += 1; } })({ task: state.agentPolicyImportTasks[0], family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'archived-before', stateVersion: 5 }), { code: 'POLICY_IMPORT_PERMISSION_CHANGED' });
  assert.equal(creates, 0);
  store.db.prepare(`UPDATE family_profiles SET status = 'active', payload = ? WHERE id = 10`).run(JSON.stringify(state.familyProfiles[0]));
  const finalize = createAgentPolicyImportFinalizer({ ...baseOptions, createPolicy: async ({ reservedPolicyId }) => {
    const archived = { ...state.familyMembers[0], status: 'archived' };
    store.db.prepare(`UPDATE family_members SET status = 'archived', payload = ? WHERE id = 31`).run(JSON.stringify(archived));
    return { id: reservedPolicyId, userId: 7, company: '可信保险', name: '安心保', insured: '张三' };
  } });
  await assert.rejects(finalize({ task: state.agentPolicyImportTasks[0], family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'archived-during', stateVersion: 5 }), { code: 'POLICY_IMPORT_PERMISSION_CHANGED' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM policies').get().count, 0);
  store.close();
});

test('aborting a finalize wait stops polling promptly', async () => {
  const current = task(); const state = stateFor(current); let polls = 0;
  const controller = new AbortController();
  const finalize = createAgentPolicyImportFinalizer({ state, waitIntervalMs: 50, waitTimeoutMs: 2_000,
    findRecord: async ({ requestId }) => { polls += 1; return requestId ? { ownerUserId: 7, taskId: 41, requestId, status: 'reserved', leaseUntil: '2999-01-01T00:00:00.000Z' } : null; },
    findPolicyBySource: async () => null, loadTask: async () => ({ ...current, finalizeRequestId: 'wait' }) });
  const startedAt = Date.now(); const pending = finalize({ task: current, family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'wait', stateVersion: 5, signal: controller.signal });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, { code: 'FINALIZE_WAIT_ABORTED' });
  assert.ok(Date.now() - startedAt < 500);
  const stoppedAt = polls; await new Promise((resolve) => setTimeout(resolve, 80)); assert.equal(polls, stoppedAt);
});

test('durable quota reservation lets only one of two tasks consume the last free slot', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-quota-')); const dbPath = path.join(directory, 'state.sqlite');
  const firstTask = task(); const secondTask = task({ id: 42, documents: [{ ...task().documents[0], documentId: 'doc2', sha256: 'b'.repeat(64) }] });
  const seed = stateFor(firstTask); seed.agentPolicyImportTasks.push(secondTask); seed.membershipConfig = { registeredFreePolicyQuota: 1, enabled: true };
  const firstStore = await createSqliteStateStore({ dbPath }); await firstStore.persist(seed); const secondStore = await createSqliteStateStore({ dbPath });
  const firstState = await firstStore.load(); const secondState = await secondStore.load(); firstState.knowledgeRecords = seed.knowledgeRecords; secondState.knowledgeRecords = seed.knowledgeRecords; let creates = 0;
  const make = (store, state) => createAgentPolicyImportFinalizer({ state, reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask,
    createPolicy: async ({ reservedPolicyId }) => { creates += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { id: reservedPolicyId, userId: 7, company: '可信保险', name: '安心保', insured: '张三' }; } });
  const calls = [make(firstStore, firstState)({ task: firstState.agentPolicyImportTasks.find((row) => row.id === 41), family: firstState.familyProfiles[0], owner: { userId: 7 }, requestId: 'quota-one', stateVersion: 5 }), make(secondStore, secondState)({ task: secondState.agentPolicyImportTasks.find((row) => row.id === 42), family: secondState.familyProfiles[0], owner: { userId: 7 }, requestId: 'quota-two', stateVersion: 5 })];
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1); assert.equal(results.find((row) => row.status === 'rejected').reason.code, 'MEMBERSHIP_REQUIRED');
  assert.equal(creates, 1); assert.equal(firstStore.db.prepare('SELECT COUNT(*) AS count FROM policies WHERE user_id = 7').get().count, 1);
  firstStore.close(); secondStore.close();
});

test('membership expiry between reservation and completion blocks policy insert', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-membership-')); const dbPath = path.join(directory, 'state.sqlite'); const state = stateFor();
  state.membershipConfig = { registeredFreePolicyQuota: 0, enabled: true }; state.memberships = [{ userId: 7, status: 'active', expiresAt: '2026-07-13T00:00:00.000Z' }];
  const store = await createSqliteStateStore({ dbPath }); await store.persist(state);
  const finalize = createAgentPolicyImportFinalizer({ state, nowIso: () => '2026-07-12T00:00:00.000Z', reserve: store.reserveAgentPolicyImportFinalization, complete: store.completeAgentPolicyImportFinalization, findRecord: store.findAgentPolicyImportFinalization, failRecord: store.failAgentPolicyImportFinalization, findPolicyBySource: store.findPolicyByImportSource, loadTask: store.findAgentPolicyImportTask,
    createPolicy: async ({ reservedPolicyId }) => {
      const expired = { userId: 7, status: 'expired', expiresAt: '2026-07-11T00:00:00.000Z' };
      store.db.prepare(`UPDATE memberships SET status = 'expired', expires_at = ?, payload = ? WHERE user_id = 7`).run(expired.expiresAt, JSON.stringify(expired));
      return { id: reservedPolicyId, userId: 7, company: '可信保险', name: '安心保', insured: '张三' };
    } });
  await assert.rejects(finalize({ task: state.agentPolicyImportTasks[0], family: state.familyProfiles[0], owner: { userId: 7 }, requestId: 'expires', stateVersion: 5 }), { code: 'MEMBERSHIP_REQUIRED' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM policies').get().count, 0); store.close();
});

test('v3 duplicate policy import source markers fail migration with a controlled error', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'policy-finalize-migration-')); const dbPath = path.join(directory, 'state.sqlite'); const legacy = new DatabaseSync(dbPath);
  legacy.exec(`CREATE TABLE policies (id INTEGER PRIMARY KEY, user_id INTEGER, guest_id TEXT, company TEXT, name TEXT, insured TEXT, created_at TEXT, updated_at TEXT, payload TEXT NOT NULL)`);
  const insert = legacy.prepare('INSERT INTO policies (id, user_id, payload) VALUES (?, 7, ?)');
  insert.run(1, JSON.stringify({ id: 1, userId: 7, sourcePolicyImportTaskId: 41, sourcePolicyImportRequestId: 'one' }));
  insert.run(2, JSON.stringify({ id: 2, userId: 7, sourcePolicyImportTaskId: 41, sourcePolicyImportRequestId: 'two' })); legacy.close();
  await assert.rejects(createSqliteStateStore({ dbPath }), (error) => error.code === 'SQLITE_POLICY_IMPORT_SOURCE_DUPLICATE' && /count=2/u.test(error.message) && /ids=1,2/u.test(error.message));
});
