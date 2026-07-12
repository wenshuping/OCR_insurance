import assert from 'node:assert/strict';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createFamilySalesMemoryApi } from '../server/family-sales-memory-api.service.mjs';
import { applyFamilySalesMemoryAction } from '../server/family-sales-memory.service.mjs';
import { createWukongMcpGateway } from '../server/wukong-mcp-gateway.service.mjs';

const NOW = '2026-07-12T08:00:00.000Z';
const owner = { ownerUserId: 7, ownerGuestId: '' };

function memory(overrides = {}) {
  return { id: 31, familyId: 11, ownerUserId: 7, ownerGuestId: '', kind: 'objection', status: 'candidate', content: '联系 13800138000，预算异议', version: 1, createdAt: NOW, updatedAt: NOW, ...overrides };
}

function baseState() {
  return {
    users: [{ id: 7, name: '张三', status: 'active' }, { id: 8, name: '李四', status: 'active' }],
    sessions: [{ token: 'token-7', userId: 7, createdAt: NOW }, { token: 'token-8', userId: 8, createdAt: NOW }],
    familyProfiles: [{ id: 11, ownerUserId: 7, familyName: '张三家庭', status: 'active' }, { id: 12, ownerUserId: 8, familyName: '李四家庭', status: 'active' }],
    familySalesMemories: [memory(), memory({ id: 32, status: 'confirmed', content: '先解释等待期' }), memory({ id: 33, kind: 'todo', status: 'confirmed', content: '周五回访' }), memory({ id: 34, status: 'expired', content: '旧异议' }), memory({ id: 41, familyId: 12, ownerUserId: 8, content: '其他客户秘密' })],
  };
}

function transitionStore(state, { fail = false } = {}) {
  const events = [];
  return {
    events,
    persist: async (input) => {
      if (fail) throw Object.assign(new Error('disk failed'), { code: 'PERSIST_FAILED', status: 503 });
      const current = state.familySalesMemories.find((item) => Number(item.id) === Number(input.memoryId));
      if (!current || Number(current.familyId) !== Number(input.familyId) || Number(current.ownerUserId) !== Number(input.owner.ownerUserId)) throw new Error('cross-scope memory transition');
      const replacement = input.replacement ? { ...input.replacement, id: 100 + events.length } : null;
      const result = applyFamilySalesMemoryAction({ memory: current, existingMemories: state.familySalesMemories.filter((item) => item.familyId === current.familyId), ...input, replacement });
      const memories = result.replacement ? [result.memory, result.replacement] : [result.memory];
      state.familySalesMemories = state.familySalesMemories.filter((item) => !memories.some((next) => next.id === item.id)).concat(memories);
      events.push(...result.events.map((event) => ({ ...event, createdAt: event.time })));
      return { memories, events: result.events };
    },
    history: ({ cursor = '', limit = 50 }) => {
      const offset = Number(cursor || 0);
      return { items: events.slice(offset, offset + Number(limit)), nextCursor: offset + Number(limit) < events.length ? String(offset + Number(limit)) : '' };
    },
  };
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) }));
  });
}

test('web list is authenticated, exactly owner/family scoped, sectioned, paged, and sanitized', async () => {
  const state = baseState();
  const store = transitionStore(state);
  const app = createPolicyOcrApp({ state, persistFamilySalesMemoryTransition: store.persist, listFamilySalesMemoryEvents: store.history, recomputeCashflowOnStartup: false });
  const server = await listen(app);
  try {
    const unauthenticated = await fetch(`${server.baseUrl}/api/family-profiles/11/sales-memories`);
    assert.equal(unauthenticated.status, 401);
    const foreign = await fetch(`${server.baseUrl}/api/family-profiles/11/sales-memories`, { headers: { authorization: 'Bearer token-8' } });
    assert.equal(foreign.status, 404);
    const response = await fetch(`${server.baseUrl}/api/family-profiles/11/sales-memories?limit=4`, { headers: { authorization: 'Bearer token-7' } });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(payload.sections), ['current', 'candidates', 'openTodos', 'history']);
    assert.deepEqual(payload.sections.current.map((item) => item.id), [32]);
    assert.deepEqual(payload.sections.openTodos.map((item) => item.id), [33]);
    assert.equal(JSON.stringify(payload).includes('13800138000'), false);
    assert.equal(JSON.stringify(payload).includes('其他客户秘密'), false);
    assert.equal(JSON.stringify(payload).includes('ownerUserId'), false);
  } finally { await server.close(); }
});

test('all governed actions enforce versions, reasons, replacement shape, ordering, and persistence rollback', async () => {
  const cases = [
    ['confirm', memory(), 'advisor_confirmation'], ['reject', memory(), 'advisor_rejection'],
    ['supersede', memory({ status: 'confirmed' }), 'advisor_correction', { replacement: { content: '新异议处理方式' } }],
    ['complete', memory({ kind: 'todo', status: 'confirmed' }), 'todo_completed'],
    ['expire', memory({ status: 'confirmed' }), 'expired_by_date'], ['restore', memory({ status: 'expired' }), 'restored_after_review'],
  ];
  for (const [action, initial, reasonCode, extra = {}] of cases) {
    const state = { familySalesMemories: [initial] };
    const store = transitionStore(state);
    const api = createFamilySalesMemoryApi({ state, persistFamilySalesMemoryTransition: store.persist, listFamilySalesMemoryEvents: store.history, nowIso: () => NOW });
    const result = await api.action({ familyId: 11, memoryId: 31, owner, action, input: { expectedVersion: 1, reasonCode, ...extra } });
    assert.equal(result.memories[0].version, 2, action);
    const history = api.history({ familyId: 11, memoryId: 31, owner, limit: 1 });
    assert.equal(history.items[0].action, action);
    if (action === 'supersede') {
      assert.ok(history.nextCursor);
      const next = api.history({ familyId: 11, memoryId: 31, owner, cursor: history.nextCursor, limit: 1 });
      assert.equal(next.items[0].action, 'confirm');
    }
  }
  const original = memory();
  const failedState = { familySalesMemories: [original] };
  const failed = transitionStore(failedState, { fail: true });
  const api = createFamilySalesMemoryApi({ state: failedState, persistFamilySalesMemoryTransition: failed.persist, nowIso: () => NOW });
  await assert.rejects(api.action({ familyId: 11, memoryId: 31, owner, action: 'confirm', input: { expectedVersion: 1, reasonCode: 'advisor_confirmation' } }), { code: 'PERSIST_FAILED' });
  assert.strictEqual(failedState.familySalesMemories[0], original);
  await assert.rejects(api.action({ familyId: 11, memoryId: 31, owner, action: 'reject', input: { expectedVersion: 1, reasonCode: 'advisor_confirmation' } }), { code: 'INVALID_MEMORY_REASON' });
  await assert.rejects(api.action({ familyId: 11, memoryId: 31, owner, action: 'confirm', input: { reasonCode: 'advisor_confirmation' } }), { code: 'EXPECTED_VERSION_REQUIRED' });
  const staleApi = createFamilySalesMemoryApi({ state: failedState, persistFamilySalesMemoryTransition: async () => { throw Object.assign(new Error('stale'), { code: 'STALE_INTERACTION', status: 409 }); }, nowIso: () => NOW });
  await assert.rejects(staleApi.action({ familyId: 11, memoryId: 31, owner, action: 'confirm', input: { expectedVersion: 2, reasonCode: 'advisor_confirmation' } }), { code: 'STALE_INTERACTION', status: 409 });
});

test('MCP memory tools derive owner, reject forged fields, cross-owner access, and leakage', async () => {
  const state = baseState();
  state.userDingtalkIdentities = [{ corpId: 'corp', dingUserId: 'ding', userId: 7, status: 'active' }];
  const store = transitionStore(state);
  const api = createFamilySalesMemoryApi({ state, persistFamilySalesMemoryTransition: store.persist, listFamilySalesMemoryEvents: store.history, nowIso: () => NOW });
  const gateway = createWukongMcpGateway({ state, familySalesMemoryApi: api });
  const invoke = (requestId, tool, input) => gateway.invoke({ corpId: 'corp', dingUserId: 'ding', requestId, conversationType: 'direct', tool, input });
  const listed = await invoke('list', 'get_sales_memories', { familyRef: 11 });
  assert.equal(JSON.stringify(listed).includes('13800138000'), false);
  assert.equal(JSON.stringify(listed).includes('其他客户秘密'), false);
  await assert.rejects(invoke('forge-owner', 'apply_memory_action', { familyRef: 11, memoryId: 31, action: 'confirm', expectedVersion: 1, reasonCode: 'advisor_confirmation', ownerUserId: 8 }), { code: 'INVALID_TOOL_INPUT' });
  await assert.rejects(invoke('forge-time', 'apply_memory_action', { familyRef: 11, memoryId: 31, action: 'confirm', expectedVersion: 1, reasonCode: 'advisor_confirmation', createdAt: NOW }), { code: 'INVALID_TOOL_INPUT' });
  await assert.rejects(invoke('foreign', 'get_sales_memories', { familyRef: 12 }), { code: 'FAMILY_NOT_FOUND' });
});
