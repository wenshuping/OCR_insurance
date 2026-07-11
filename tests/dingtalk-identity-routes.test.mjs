import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';

const NOW = '2026-07-12T08:00:00.000Z';
const PRINCIPAL = { corpId: 'corp-1', dingUserId: 'ding-1', requestId: 'request-1' };

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      baseUrl: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function request(baseUrl, path, { token, service = true, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(service ? { 'x-test-dingtalk-service': 'valid' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  return { response, payload: await response.json() };
}

function createHarness(users = [{ id: 7, mobile: '13800138000', status: 'active' }], overrides = {}) {
  const state = {
    ...createInitialState(),
    users,
    sessions: [{ token: 'customer-token', userId: 7, createdAt: NOW }],
  };
  const persisted = [];
  const profiles = [];
  const appOptions = {
    state,
    now: () => NOW,
    dingtalkAllowedUserIds: users.map((user) => user.id),
    authenticateDingtalkServiceRequest: (req) => req.get('x-test-dingtalk-service') === 'valid',
    getDingtalkUserProfile: async (principal) => {
      profiles.push(principal);
      return { mobile: '13800138000', name: 'Raw DingTalk Name', department: [42] };
    },
    persistDingtalkIdentityState: async (input) => persisted.push(structuredClone(input)),
    ...overrides,
  };
  if (overrides.persistDingtalkIdentityState === null) delete appOptions.persistDingtalkIdentityState;
  const app = createPolicyOcrApp(appOptions);
  return { app, state, persisted, profiles };
}

function identityStateSnapshot(state) {
  return JSON.stringify({
    userDingtalkIdentities: state.userDingtalkIdentities,
    dingtalkBindingChallenges: state.dingtalkBindingChallenges,
  });
}

function assertSafeResponse(result) {
  assert.equal(result.response.headers.get('cache-control'), 'no-store');
  const serialized = JSON.stringify(result.payload);
  for (const secret of ['13800138000', 'Raw DingTalk Name', 'tokenHash', 'dingtalkBindingChallenges', 'userDingtalkIdentities']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
}

test('candidate masks a unique match, starts a challenge, and never exposes sensitive state', async () => {
  const harness = createHarness();
  const server = await listen(harness.app);
  try {
    const result = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      method: 'POST', body: JSON.stringify(PRINCIPAL),
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.payload.status, 'confirmation_required');
    assert.equal(result.payload.maskedMobile, '138****8000');
    assert.equal(typeof result.payload.challenge.token, 'string');
    assert.equal(result.payload.challenge.expiresAt, '2026-07-12T08:05:00.000Z');
    assert.deepEqual(harness.profiles, [{ corpId: 'corp-1', dingUserId: 'ding-1' }]);
    const serialized = JSON.stringify(result.payload);
    for (const secret of ['13800138000', 'Raw DingTalk Name', 'tokenHash', 'dingtalkBindingChallenges', 'userId']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
  } finally { await server.close(); }
});

test('candidate returns binding required without leaking whether no or duplicate account matched', async () => {
  for (const users of [[], [
    { id: 7, mobile: '13800138000', status: 'active' },
    { id: 8, mobile: '13800138000', status: 'active' },
  ]]) {
    const harness = createHarness(users);
    const server = await listen(harness.app);
    try {
      const result = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
        method: 'POST', body: JSON.stringify(PRINCIPAL),
      });
      assert.equal(result.response.status, 200);
      assert.deepEqual(result.payload, { ok: true, status: 'binding_required' });
    } finally { await server.close(); }
  }
});

test('service routes reject missing service authentication and invalid input', async () => {
  const harness = createHarness();
  const server = await listen(harness.app);
  try {
    const unauthenticated = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      service: false, method: 'POST', body: JSON.stringify(PRINCIPAL),
    });
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.payload.code, 'UNAUTHORIZED');
    const invalid = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      method: 'POST', body: JSON.stringify({ corpId: 'corp-1' }),
    });
    assert.equal(invalid.response.status, 400);
  } finally { await server.close(); }
});

test('confirm enforces the challenge principal and atomically persists identity plus changed challenge', async () => {
  const harness = createHarness();
  const server = await listen(harness.app);
  try {
    const candidate = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      method: 'POST', body: JSON.stringify(PRINCIPAL),
    });
    const token = candidate.payload.challenge.token;
    const wrong = await request(server.baseUrl, '/api/dingtalk/identity/confirm', {
      method: 'POST',
      body: JSON.stringify({ corpId: 'corp-1', dingUserId: 'ding-2', requestId: 'request-2', token }),
    });
    assert.equal(wrong.response.status, 403);
    assert.equal(wrong.payload.code, 'CHALLENGE_PRINCIPAL_MISMATCH');
    assertSafeResponse(wrong);
    assert.equal(JSON.stringify(wrong.payload).includes(token), false);

    const confirmed = await request(server.baseUrl, '/api/dingtalk/identity/confirm', {
      method: 'POST', body: JSON.stringify({ ...PRINCIPAL, token }),
    });
    assert.equal(confirmed.response.status, 200);
    assert.deepEqual(confirmed.payload, { ok: true, status: 'bound', maskedMobile: '138****8000' });
    assertSafeResponse(confirmed);
    assert.equal(JSON.stringify(confirmed.payload).includes(token), false);
    const persisted = harness.persisted.at(-1);
    assert.equal(persisted.identity.status, 'active');
    assert.equal(persisted.challenges.length, 1);
    assert.equal(persisted.challenges[0].usedAt, NOW);
  } finally { await server.close(); }
});

test('web bind requires customer auth, binds only the session user, and returns a safe task reference', async () => {
  const harness = createHarness();
  harness.state.users.push({ id: 8, mobile: '13900139000', status: 'active' });
  harness.state.sessions.push({ token: 'other-customer-token', userId: 8, createdAt: NOW });
  const server = await listen(harness.app);
  try {
    const candidate = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      method: 'POST', body: JSON.stringify(PRINCIPAL),
    });
    const body = JSON.stringify({ ...PRINCIPAL, token: candidate.payload.challenge.token, taskRef: 'task_AbC-123' });
    const unauthenticated = await request(server.baseUrl, '/api/dingtalk/identity/web-bind', {
      service: false, method: 'POST', body,
    });
    assert.equal(unauthenticated.response.status, 401);
    assert.equal(unauthenticated.payload.code, 'UNAUTHORIZED');
    assertSafeResponse(unauthenticated);
    assert.equal(JSON.stringify(unauthenticated.payload).includes(candidate.payload.challenge.token), false);
    const wrongCustomer = await request(server.baseUrl, '/api/dingtalk/identity/web-bind', {
      service: false, token: 'other-customer-token', method: 'POST', body,
    });
    assert.equal(wrongCustomer.response.status, 403);
    assert.equal(wrongCustomer.payload.code, 'CHALLENGE_USER_MISMATCH');
    assertSafeResponse(wrongCustomer);
    const bound = await request(server.baseUrl, '/api/dingtalk/identity/web-bind', {
      service: false, token: 'customer-token', method: 'POST', body,
    });
    assert.equal(bound.response.status, 200);
    assert.deepEqual(bound.payload, { ok: true, status: 'bound', taskRef: 'task_AbC-123' });
    assertSafeResponse(bound);
    assert.equal(JSON.stringify(bound.payload).includes(candidate.payload.challenge.token), false);
  } finally { await server.close(); }
});

test('binding deletion revokes only the authenticated user own matching principal', async () => {
  const harness = createHarness();
  harness.state.userDingtalkIdentities = [{ corpId: 'corp-1', dingUserId: 'ding-1', userId: 7, status: 'active' }];
  const server = await listen(harness.app);
  try {
    const other = await request(server.baseUrl, '/api/dingtalk/identity/binding', {
      service: false, token: 'customer-token', method: 'DELETE',
      body: JSON.stringify({ corpId: 'corp-1', dingUserId: 'other' }),
    });
    assert.equal(other.response.status, 404);
    assert.equal(other.payload.code, 'BINDING_NOT_FOUND');
    assertSafeResponse(other);
    const own = await request(server.baseUrl, '/api/dingtalk/identity/binding', {
      service: false, token: 'customer-token', method: 'DELETE',
      body: JSON.stringify({ corpId: 'corp-1', dingUserId: 'ding-1' }),
    });
    assert.equal(own.response.status, 200);
    assert.deepEqual(own.payload, { ok: true, status: 'revoked' });
    assertSafeResponse(own);
    assert.equal(harness.persisted.at(-1).identity.status, 'revoked');
  } finally { await server.close(); }
});

test('confirm returns stable codes for expired, used, and active-binding conflicts', async () => {
  const harness = createHarness();
  const server = await listen(harness.app);
  try {
    const expiredCandidate = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      method: 'POST', body: JSON.stringify(PRINCIPAL),
    });
    harness.state.dingtalkBindingChallenges.at(-1).expiresAt = NOW;
    const expired = await request(server.baseUrl, '/api/dingtalk/identity/confirm', {
      method: 'POST', body: JSON.stringify({ ...PRINCIPAL, token: expiredCandidate.payload.challenge.token }),
    });
    assert.equal(expired.response.status, 409);
    assert.equal(expired.payload.code, 'CHALLENGE_EXPIRED');
    assertSafeResponse(expired);

    const freshCandidate = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      method: 'POST', body: JSON.stringify(PRINCIPAL),
    });
    const confirmationBody = JSON.stringify({ ...PRINCIPAL, token: freshCandidate.payload.challenge.token });
    const first = await request(server.baseUrl, '/api/dingtalk/identity/confirm', {
      method: 'POST', body: confirmationBody,
    });
    assert.equal(first.response.status, 200);
    const used = await request(server.baseUrl, '/api/dingtalk/identity/confirm', {
      method: 'POST', body: confirmationBody,
    });
    assert.equal(used.response.status, 409);
    assert.equal(used.payload.code, 'CHALLENGE_USED');
    assertSafeResponse(used);

    const conflict = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
      method: 'POST', body: JSON.stringify(PRINCIPAL),
    });
    assert.equal(conflict.response.status, 409);
    assert.equal(conflict.payload.code, 'ALREADY_BOUND');
    assertSafeResponse(conflict);
  } finally { await server.close(); }
});

test('candidate rolls identity state back when persistence is missing or rejects', async () => {
  for (const persistDingtalkIdentityState of [null, async () => { throw new Error('database secret'); }]) {
    const harness = createHarness(undefined, { persistDingtalkIdentityState });
    const before = identityStateSnapshot(harness.state);
    const server = await listen(harness.app);
    try {
      const result = await request(server.baseUrl, '/api/dingtalk/identity/candidate', {
        method: 'POST', body: JSON.stringify(PRINCIPAL),
      });
      assert.equal(result.response.status, persistDingtalkIdentityState === null ? 503 : 500);
      assert.equal(identityStateSnapshot(harness.state), before);
      assert.equal(JSON.stringify(result.payload).includes('database secret'), false);
    } finally { await server.close(); }
  }
});

test('confirm, web-bind, and revoke roll identity state back when persistence is missing or rejects', async () => {
  for (const route of ['confirm', 'web-bind', 'binding']) {
    for (const persistDingtalkIdentityState of [null, async () => { throw new Error('database secret'); }]) {
      const harness = createHarness(undefined, { persistDingtalkIdentityState });
      const token = 'route-test-token';
      harness.state.userDingtalkIdentities = [{
        ...PRINCIPAL,
        userId: 7,
        status: route === 'binding' ? 'active' : 'pending',
      }];
      harness.state.dingtalkBindingChallenges = route === 'binding' ? [] : [{
        ...PRINCIPAL,
        userId: 7,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: '2026-07-12T08:05:00.000Z',
        usedAt: null,
      }];
      const before = identityStateSnapshot(harness.state);
      const server = await listen(harness.app);
      try {
        const result = route === 'binding'
          ? await request(server.baseUrl, '/api/dingtalk/identity/binding', {
              service: false, token: 'customer-token', method: 'DELETE',
              body: JSON.stringify(PRINCIPAL),
            })
          : await request(server.baseUrl, `/api/dingtalk/identity/${route}`, {
              service: route !== 'web-bind',
              token: route === 'web-bind' ? 'customer-token' : undefined,
              method: 'POST',
              body: JSON.stringify({ ...PRINCIPAL, token }),
            });
        assert.equal(result.response.status, persistDingtalkIdentityState === null ? 503 : 500);
        assert.equal(identityStateSnapshot(harness.state), before, route);
        assert.equal(JSON.stringify(result.payload).includes('database secret'), false);
      } finally { await server.close(); }
    }
  }
});

test('web bind validates ownership of the exact submitted token before mutation', async () => {
  const harness = createHarness([
    { id: 7, mobile: '13800138000', status: 'active' },
    { id: 8, mobile: '13900139000', status: 'active' },
  ]);
  const ownToken = 'own-token';
  const otherToken = 'other-token';
  harness.state.userDingtalkIdentities = [{ ...PRINCIPAL, userId: 7, status: 'pending' }];
  harness.state.dingtalkBindingChallenges = [
    { ...PRINCIPAL, userId: 7, tokenHash: createHash('sha256').update(ownToken).digest('hex'), expiresAt: '2026-07-12T08:05:00.000Z', usedAt: null },
    { ...PRINCIPAL, userId: 8, tokenHash: createHash('sha256').update(otherToken).digest('hex'), expiresAt: '2026-07-12T08:05:00.000Z', usedAt: null },
  ];
  const before = identityStateSnapshot(harness.state);
  const server = await listen(harness.app);
  try {
    const result = await request(server.baseUrl, '/api/dingtalk/identity/web-bind', {
      service: false, token: 'customer-token', method: 'POST',
      body: JSON.stringify({ ...PRINCIPAL, token: otherToken }),
    });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.code, 'CHALLENGE_USER_MISMATCH');
    assert.equal(identityStateSnapshot(harness.state), before);
  } finally { await server.close(); }
});

test('frontend API re-exports the four DingTalk identity client calls', async () => {
  const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
  assert.match(source, /contracts\/dingtalk/);
  for (const name of ['getDingtalkIdentityCandidate', 'confirmDingtalkIdentity', 'bindDingtalkIdentityFromWeb', 'revokeDingtalkIdentity']) {
    assert.match(source, new RegExp(name));
  }
});
