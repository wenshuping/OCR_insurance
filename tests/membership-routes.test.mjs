import assert from 'node:assert/strict';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { defaultMembershipConfig } from '../server/membership.domain.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function jsonFetch(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  return { response, payload };
}

test('membership routes expose status, create mock order, and confirm mock payment', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    membershipConfig: { ...defaultMembershipConfig('2026-06-11T08:00:00.000Z'), registeredFreePolicyQuota: 2 },
    policies: [{ id: 2, userId: 1, guestId: '', name: '已保存保单' }],
    nextId: 10,
  };
  const persisted = [];
  const app = createPolicyOcrApp({
    state,
    persist: async (nextState) => persisted.push(JSON.parse(JSON.stringify(nextState))),
    wechatPayMode: 'mock',
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const auth = { authorization: 'Bearer token-1' };
    const status = await jsonFetch(server.baseUrl, '/api/membership/me', { headers: auth });
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.quota.savedPolicyCount, 1);
    assert.equal(status.payload.quota.freeQuota, 2);
    assert.equal(status.payload.membership.active, false);

    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', { headers: auth, method: 'POST', body: '{}' });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.order.status, 'prepay_created');
    assert.equal(created.payload.payParams.package.startsWith('prepay_id=mock_'), true);

    const confirmed = await jsonFetch(server.baseUrl, `/api/membership/orders/${created.payload.order.id}/mock-confirm`, { headers: auth, method: 'POST', body: '{}' });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.payload.membership.active, true);

    const refreshed = await jsonFetch(server.baseUrl, '/api/membership/me', { headers: auth });
    assert.equal(refreshed.payload.membership.active, true);
    assert.equal(persisted.length >= 2, true);
  } finally {
    await server.close();
  }
});

test('membership order creation requires login', async () => {
  const app = createPolicyOcrApp({ state: createInitialState(), wechatPayMode: 'mock' });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', { method: 'POST', body: '{}' });
    assert.equal(created.response.status, 401);
    assert.equal(created.payload.code, 'UNAUTHORIZED');
  } finally {
    await server.close();
  }
});
