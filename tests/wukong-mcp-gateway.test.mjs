import assert from 'node:assert/strict';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createWukongMcpGateway } from '../server/wukong-mcp-gateway.service.mjs';

const PRINCIPAL = { corpId: 'corp-1', dingUserId: 'ding-1' };
const PUBLIC_TOOL_NAMES = [
  'resolve_advisor_identity',
  'list_accessible_families',
  'start_policy_import',
  'append_policy_import_files',
  'get_policy_import',
  'apply_policy_import_action',
  'finalize_policy_import',
  'ask_sales_champion',
  'ask_insurance_expert',
  'get_sales_memories',
  'apply_memory_action',
];

function stateFor(identity = { ...PRINCIPAL, userId: 7, status: 'active' }) {
  return {
    users: [{ id: 7, mobile: '13800138000', name: '张三', status: 'active' }],
    userDingtalkIdentities: identity ? [identity] : [],
    familyProfiles: [
      { id: 11, ownerUserId: 7, familyName: '张三家庭', name: '错误名称', status: 'active' },
      { id: 12, ownerUserId: 8, name: '王五家庭', status: 'active' },
    ],
    familyMembers: [
      { id: 21, familyId: 11, name: '张三', status: 'active' },
      { id: 22, familyId: 11, name: '李四', status: 'archived' },
      { id: 23, familyId: 12, name: '王五', status: 'active' },
    ],
  };
}

function call(gateway, overrides = {}) {
  return gateway.invoke({
    ...PRINCIPAL,
    requestId: 'req-1',
    conversationType: 'direct',
    tool: 'resolve_advisor_identity',
    input: {},
    ...overrides,
  });
}

test('registry exposes only approved identity, family, and policy intake tools with private schemas', async () => {
  const gateway = createWukongMcpGateway({ state: stateFor() });
  assert.deepEqual(gateway.toolNames, PUBLIC_TOOL_NAMES);
  assert.equal(gateway.registry, undefined);
  assert.deepEqual(gateway.toolMetadata.map((tool) => tool.name), gateway.toolNames);
  assert.deepEqual(gateway.toolMetadata[0].inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  for (const tool of gateway.toolMetadata) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(Object.isFrozen(gateway.toolMetadata), true);
  assert.equal(Object.isFrozen(gateway.toolMetadata[0]), true);
  assert.equal(Object.isFrozen(gateway.toolMetadata[0].inputSchema), true);
  assert.equal(Object.isFrozen(gateway.toolMetadata[0].inputSchema.properties), true);
  await assert.rejects(call(gateway, { tool: 'delete_family' }), { code: 'TOOL_NOT_ALLOWED' });
  await assert.rejects(call(gateway, { requestId: 'req-2', input: { ownerUserId: 7 } }), { code: 'INVALID_TOOL_INPUT' });
  await assert.rejects(call(gateway, { requestId: 'req-3', tool: 'list_accessible_families', input: { familyId: 12 } }), { code: 'INVALID_TOOL_INPUT' });
  await assert.rejects(call(gateway, { requestId: 'req-4', input: [] }), { code: 'INVALID_TOOL_INPUT' });
});

test('server-owned allowlist rejects private, unknown, case, prototype, and forged selector variants', async () => {
  const gateway = createWukongMcpGateway({ state: stateFor() });
  const forbidden = [
    'terminal', 'read_file', 'write_file', 'sql_query', 'http_request',
    'search_policy_evidence', 'mutate_policy', 'get_hidden_prompt',
    'sales_champion.search_memories', 'insurance_expert.search_evidence',
    'ASK_SALES_CHAMPION', 'ask_sales_champion ', '__proto__', 'constructor', 'toString',
  ];
  for (const [index, tool] of forbidden.entries()) {
    await assert.rejects(call(gateway, { requestId: `forbidden-${index}`, tool }), { code: 'TOOL_NOT_ALLOWED' });
  }
  await assert.rejects(call(gateway, {
    requestId: 'forged-selection',
    tool: 'ask_sales_champion',
    input: { familyRef: 11, question: '问题' },
    skills: ['terminal'],
    selectedTool: 'terminal',
    role: 'insurance_expert',
  }), { code: 'INVALID_TOOL_INPUT' });
  const prototypeInput = Object.create({ hiddenPrompt: true });
  await assert.rejects(call(gateway, { requestId: 'prototype-input', input: prototypeInput }), { code: 'INVALID_TOOL_INPUT' });
});

test('public metadata contains only names and schemas and keeps executables private', () => {
  const gateway = createWukongMcpGateway({ state: stateFor() });
  assert.deepEqual(gateway.toolMetadata.map(({ name }) => name), PUBLIC_TOOL_NAMES);
  for (const metadata of gateway.toolMetadata) {
    assert.deepEqual(Object.keys(metadata).sort(), metadata.name === 'apply_memory_action' ? ['durableIdempotency', 'inputSchema', 'name'] : ['inputSchema', 'name']);
    assert.equal('execute' in metadata, false);
    assert.equal('authorize' in metadata, false);
  }
  assert.equal(Object.isFrozen(gateway.toolNames), true);
});

test('durably idempotent memory actions bypass process replay and permit transient retry', async () => {
  let calls = 0;
  let failFirst = false;
  const familySalesMemoryApi = {
    list: () => ({ section: 'current', items: [], count: 0, nextCursor: '' }),
    action: async () => {
      calls += 1;
      if (failFirst && calls === 1) throw new Error('transient');
      return { memories: [{ id: 31, kind: 'objection', status: 'confirmed', content: 'ok', version: 2 }], idempotent: calls > 1 };
    },
  };
  const gateway = createWukongMcpGateway({ state: stateFor(), familySalesMemoryApi, rateLimit: 10 });
  const request = { ...PRINCIPAL, requestId: 'durable-1', conversationType: 'direct', tool: 'apply_memory_action', input: { familyRef: 11, memoryId: 31, action: 'confirm', expectedVersion: 1, reasonCode: 'advisor_confirmation', confirmationToken: 'token', interactionId: 'card' } };
  const first = await gateway.invoke(request);
  const duplicate = await gateway.invoke(request);
  assert.deepEqual(duplicate.memories, first.memories);
  assert.equal(calls, 2);
  assert.equal(gateway.replaySize, 0);
  calls = 0;
  failFirst = true;
  const retryRequest = { ...request, requestId: 'durable-retry' };
  await assert.rejects(gateway.invoke(retryRequest), /transient/);
  const retried = await gateway.invoke(retryRequest);
  assert.equal(retried.memories[0].status, 'confirmed');
  assert.equal(calls, 2);
});

test('policy intake tools derive owner and reject forged family or owner input', async () => {
  const calls = [];
  const policyImports = {
    start: async (input) => { calls.push(input); return { taskId: 1 }; },
    append: async () => ({ taskId: 1 }), get: () => ({ taskId: 1 }), action: async () => ({ taskId: 1 }),
  };
  const gateway = createWukongMcpGateway({ state: stateFor(), policyImports });
  const result = await call(gateway, { requestId: 'start-policy', tool: 'start_policy_import', input: { familyRef: 11 } });
  assert.deepEqual(result, { taskId: 1 });
  assert.equal(calls[0].owner.userId, 7);
  assert.equal(calls[0].family.id, 11);
  await assert.rejects(call(gateway, { requestId: 'foreign-family', tool: 'start_policy_import', input: { familyRef: 12 } }), { code: 'FAMILY_NOT_FOUND' });
  await assert.rejects(call(gateway, { requestId: 'forged-owner', tool: 'start_policy_import', input: { familyRef: 11, ownerUserId: 8 } }), { code: 'INVALID_TOOL_INPUT' });
});

test('identity resolution rejects missing, revoked, ambiguous, and inactive bindings with stable codes', async () => {
  await assert.rejects(call(createWukongMcpGateway({ state: stateFor(null) })), { code: 'IDENTITY_NOT_BOUND' });
  await assert.rejects(call(createWukongMcpGateway({ state: stateFor({ ...PRINCIPAL, userId: 7, status: 'revoked' }) })), { code: 'IDENTITY_REVOKED' });
  const ambiguous = stateFor();
  ambiguous.userDingtalkIdentities.push({ ...PRINCIPAL, userId: 8, status: 'active' });
  await assert.rejects(call(createWukongMcpGateway({ state: ambiguous })), { code: 'IDENTITY_AMBIGUOUS' });
  const inactive = stateFor();
  inactive.users[0].status = 'disabled';
  await assert.rejects(call(createWukongMcpGateway({ state: inactive })), { code: 'ADVISOR_ACCOUNT_INACTIVE' });
});

test('identity capability response is masked and contains no raw account or binding data', async () => {
  const result = await call(createWukongMcpGateway({ state: stateFor() }));
  assert.deepEqual(result, { status: 'active', displayLabel: '张**' });
  const serialized = JSON.stringify(result);
  for (const secret of ['13800138000', 'userId', 'tokenHash', 'userDingtalkIdentities', 'corp-1', 'ding-1']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('family listing uses the derived owner and ignores forged owner fields by rejecting them', async () => {
  const gateway = createWukongMcpGateway({ state: stateFor() });
  const result = await call(gateway, {
    requestId: 'families-1', tool: 'list_accessible_families', input: {},
  });
  assert.deepEqual(result, { families: [{ id: 11, displayLabel: '张**庭', memberCount: 1 }] });
  assert.equal(JSON.stringify(result).includes('王五'), false);
  await assert.rejects(call(gateway, {
    requestId: 'families-2', tool: 'list_accessible_families', input: { ownerUserId: 8, familyId: 12 },
  }), { code: 'INVALID_TOOL_INPUT' });
});

test('family listing includes missing status as active and excludes every non-active status', async () => {
  const state = stateFor();
  state.familyProfiles = [
    { id: 31, ownerUserId: 7, name: '默认家庭' },
    { id: 32, ownerUserId: 7, name: '启用家庭', status: 'active' },
    { id: 33, ownerUserId: 7, name: '停用家庭', status: 'disabled' },
    { id: 34, ownerUserId: 7, name: '非活跃家庭', status: 'inactive' },
    { id: 35, ownerUserId: 7, name: '未知家庭', status: 'mystery' },
  ];
  const result = await call(createWukongMcpGateway({ state }), {
    requestId: 'family-statuses', tool: 'list_accessible_families', input: {},
  });
  assert.deepEqual(result.families.map((family) => family.id), [31, 32]);
});

test('replay cache prevents duplicate execution and expires deterministically without growing unbounded', async () => {
  let now = 1_000;
  let executions = 0;
  const gateway = createWukongMcpGateway({
    state: stateFor(), now: () => now, replayTtlMs: 100, replayMaxEntries: 2,
    onExecute: () => { executions += 1; },
  });
  await call(gateway);
  await assert.rejects(call(gateway), { code: 'REQUEST_REPLAYED' });
  assert.equal(executions, 1);
  now = 1_101;
  await call(gateway);
  assert.equal(executions, 2);
  await call(gateway, { requestId: 'req-2' });
  await assert.rejects(call(gateway, { requestId: 'req-3' }), { code: 'REPLAY_CACHE_CAPACITY' });
  assert.ok(gateway.replaySize <= 2);
});

test('live oldest and newest replay IDs remain protected at exact capacity', async () => {
  let executions = 0;
  const gateway = createWukongMcpGateway({
    state: stateFor(), replayMaxEntries: 2, onExecute: () => { executions += 1; },
  });
  await call(gateway, { requestId: 'oldest' });
  await call(gateway, { requestId: 'newest' });
  await assert.rejects(call(gateway, { requestId: 'oldest' }), { code: 'REQUEST_REPLAYED' });
  await assert.rejects(call(gateway, { requestId: 'newest' }), { code: 'REQUEST_REPLAYED' });
  await assert.rejects(call(gateway, { requestId: 'new-at-capacity' }), { code: 'REPLAY_CACHE_CAPACITY' });
  assert.equal(executions, 2);
});

test('request ID remains reserved when execution fails', async () => {
  let executions = 0;
  const gateway = createWukongMcpGateway({
    state: stateFor(),
    onExecute: () => {
      executions += 1;
      throw new Error('simulated execution failure');
    },
  });
  await assert.rejects(call(gateway), /simulated execution failure/);
  await assert.rejects(call(gateway), { code: 'REQUEST_REPLAYED' });
  assert.equal(executions, 1);
});

test('duplicate request remains a replay error at the rate ceiling', async () => {
  const gateway = createWukongMcpGateway({ state: stateFor(), rateLimit: 1 });
  await call(gateway);
  await assert.rejects(call(gateway), { code: 'REQUEST_REPLAYED' });
});

test('rate limiting is per advisor, clock-driven, bounded, and fail-closed', async () => {
  let now = 1_000;
  const gateway = createWukongMcpGateway({ state: stateFor(), now: () => now, rateLimit: 2, rateWindowMs: 100 });
  await call(gateway, { requestId: 'a' });
  await call(gateway, { requestId: 'b' });
  await assert.rejects(call(gateway, { requestId: 'c' }), { code: 'RATE_LIMITED' });
  now = 1_101;
  await call(gateway, { requestId: 'd' });
  await assert.rejects(call(createWukongMcpGateway({ state: stateFor(), rateLimit: 0 })), { code: 'RATE_LIMITED' });
});

test('two DingTalk principals bound to one advisor share one business quota', async () => {
  const state = stateFor();
  state.userDingtalkIdentities.push({ corpId: 'corp-1', dingUserId: 'ding-alias', userId: 7, status: 'active' });
  const gateway = createWukongMcpGateway({ state, rateLimit: 1 });
  await call(gateway, { requestId: 'primary' });
  await assert.rejects(call(gateway, { dingUserId: 'ding-alias', requestId: 'alias' }), { code: 'RATE_LIMITED' });
  assert.equal(gateway.ratePrincipalCount, 1);
});

test('duplicate active bindings cannot bypass advisor replay protection', async () => {
  const state = stateFor();
  state.userDingtalkIdentities.push({ corpId: 'corp-1', dingUserId: 'ding-alias', userId: 7, status: 'active' });
  let executions = 0;
  const gateway = createWukongMcpGateway({ state, onExecute: () => { executions += 1; } });
  await call(gateway, { requestId: 'shared-request' });
  await assert.rejects(call(gateway, {
    dingUserId: 'ding-alias', requestId: 'shared-request',
  }), { code: 'REQUEST_REPLAYED' });
  assert.equal(executions, 1);
  assert.equal(gateway.replaySize, 1);
});

test('unbound and revoked principal guesses do not allocate or consume advisor quota', async () => {
  const state = stateFor();
  state.userDingtalkIdentities.push({ corpId: 'corp-1', dingUserId: 'ding-revoked', userId: 7, status: 'revoked' });
  const gateway = createWukongMcpGateway({ state, rateLimit: 1, rateMaxPrincipals: 1 });
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(call(gateway, { dingUserId: `unknown-${index}`, requestId: `unknown-${index}` }), { code: 'IDENTITY_NOT_BOUND' });
  }
  await assert.rejects(call(gateway, { dingUserId: 'ding-revoked', requestId: 'revoked' }), { code: 'IDENTITY_REVOKED' });
  assert.equal(gateway.ratePrincipalCount, 0);
  assert.equal(gateway.replaySize, 0);
  await call(gateway, { requestId: 'valid' });
  assert.equal(gateway.ratePrincipalCount, 1);
});

test('rate limiter bounds tracked principals', async () => {
  const state = stateFor();
  state.users.push({ id: 8, name: '李四', status: 'active' }, { id: 9, name: '王五', status: 'active' });
  state.userDingtalkIdentities.push(
    { corpId: 'corp-1', dingUserId: 'ding-2', userId: 8, status: 'active' },
    { corpId: 'corp-1', dingUserId: 'ding-3', userId: 9, status: 'active' },
  );
  const gateway = createWukongMcpGateway({ state, rateMaxPrincipals: 2 });
  await call(gateway, { requestId: 'one' });
  await call(gateway, { dingUserId: 'ding-2', requestId: 'two' });
  await assert.rejects(call(gateway, { dingUserId: 'ding-3', requestId: 'three' }), { code: 'RATE_LIMITED' });
  assert.ok(gateway.ratePrincipalCount <= 2);
});

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function post(baseUrl, body, authenticated = true) {
  const response = await fetch(`${baseUrl}/api/wukong/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authenticated ? { authorization: 'Bearer service-secret' } : {}),
    },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('HTTP transport authenticates service, requires direct complete principals, and sends safe no-store errors', async () => {
  const app = createPolicyOcrApp({
    state: stateFor(),
    authenticateDingtalkServiceRequest: (req) => req.get('authorization') === 'Bearer service-secret',
  });
  const server = await listen(app);
  const body = { ...PRINCIPAL, requestId: 'http-1', conversationType: 'direct', tool: 'resolve_advisor_identity', input: {} };
  try {
    const unauthenticated = await post(server.baseUrl, body, false);
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.payload.code, 'SERVICE_AUTH_REQUIRED');
    const group = await post(server.baseUrl, { ...body, requestId: 'http-2', conversationType: 'group' });
    assert.equal(group.response.status, 403);
    assert.equal(group.payload.code, 'GROUP_CHAT_FORBIDDEN');
    const incomplete = await post(server.baseUrl, { tool: 'resolve_advisor_identity', input: {} });
    assert.equal(incomplete.response.status, 400);
    assert.equal(incomplete.payload.code, 'INVALID_TOOL_INPUT');
    const success = await post(server.baseUrl, body);
    assert.equal(success.response.status, 200);
    assert.deepEqual(success.payload, { ok: true, result: { status: 'active', displayLabel: '张**' } });
    for (const result of [unauthenticated, group, incomplete, success]) {
      assert.equal(result.response.headers.get('cache-control'), 'no-store');
      const serialized = JSON.stringify(result.payload);
      for (const secret of ['13800138000', 'tokenHash', 'userDingtalkIdentities']) assert.equal(serialized.includes(secret), false);
    }
  } finally {
    await server.close();
  }
});

test('HTTP transport invokes Insurance Expert with server-derived owner context', async () => {
  let received;
  const app = createPolicyOcrApp({
    state: stateFor(),
    authenticateDingtalkServiceRequest: (req) => req.get('authorization') === 'Bearer service-secret',
    askInsuranceExpertTool: async (input) => { received = input; return { agent: 'insurance_expert', answer: '安全回答' }; },
  });
  const server = await listen(app);
  try {
    const result = await post(server.baseUrl, {
      ...PRINCIPAL, requestId: 'expert-http', conversationType: 'direct', tool: 'ask_insurance_expert',
      input: { policyRef: 31, question: '保障什么？' },
    });
    assert.equal(result.response.status, 200);
    assert.equal(received.owner.userId, 7);
    assert.equal(received.requestId, 'expert-http');
    assert.deepEqual(result.payload.result, { agent: 'insurance_expert', answer: '安全回答' });
  } finally {
    await server.close();
  }
});
