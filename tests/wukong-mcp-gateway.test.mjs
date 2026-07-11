import assert from 'node:assert/strict';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createWukongMcpGateway } from '../server/wukong-mcp-gateway.service.mjs';

const PRINCIPAL = { corpId: 'corp-1', dingUserId: 'ding-1' };

function stateFor(identity = { ...PRINCIPAL, userId: 7, status: 'active' }) {
  return {
    users: [{ id: 7, mobile: '13800138000', name: '张三', status: 'active' }],
    userDingtalkIdentities: identity ? [identity] : [],
    familyProfiles: [
      { id: 11, ownerUserId: 7, name: '张三家庭', status: 'active' },
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

test('registry exposes only the two approved tools and validates exact input schemas', async () => {
  const gateway = createWukongMcpGateway({ state: stateFor() });
  assert.deepEqual(gateway.toolNames, ['resolve_advisor_identity', 'list_accessible_families']);
  await assert.rejects(call(gateway, { tool: 'delete_family' }), { code: 'TOOL_NOT_ALLOWED' });
  await assert.rejects(call(gateway, { requestId: 'req-2', input: { ownerUserId: 7 } }), { code: 'INVALID_TOOL_INPUT' });
  await assert.rejects(call(gateway, { requestId: 'req-3', tool: 'list_accessible_families', input: { familyId: 12 } }), { code: 'INVALID_TOOL_INPUT' });
  await assert.rejects(call(gateway, { requestId: 'req-4', input: [] }), { code: 'INVALID_TOOL_INPUT' });
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
  await call(gateway, { requestId: 'req-3' });
  assert.ok(gateway.replaySize <= 2);
});

test('duplicate request remains a replay error at the rate ceiling', async () => {
  const gateway = createWukongMcpGateway({ state: stateFor(), rateLimit: 1 });
  await call(gateway);
  await assert.rejects(call(gateway), { code: 'REQUEST_REPLAYED' });
});

test('rate limiting is per principal, clock-driven, bounded, and fail-closed', async () => {
  let now = 1_000;
  const gateway = createWukongMcpGateway({ state: stateFor(), now: () => now, rateLimit: 2, rateWindowMs: 100 });
  await call(gateway, { requestId: 'a' });
  await call(gateway, { requestId: 'b' });
  await assert.rejects(call(gateway, { requestId: 'c' }), { code: 'RATE_LIMITED' });
  now = 1_101;
  await call(gateway, { requestId: 'd' });
  await assert.rejects(call(createWukongMcpGateway({ state: stateFor(), rateLimit: 0 })), { code: 'RATE_LIMITED' });
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
