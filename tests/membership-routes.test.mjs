import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { defaultMembershipConfig } from '../server/membership.domain.mjs';
import { signWechatPayMessage } from '../server/wechat-pay.service.mjs';

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

function encryptWechatPayResource({ apiV3Key, nonce, associatedData, payload }) {
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64');
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
    assert.equal(Object.hasOwn(confirmed.payload.order, 'payload'), false);
    assert.equal(Object.hasOwn(confirmed.payload.order, 'prepayId'), false);
    assert.equal(Object.hasOwn(confirmed.payload.order, 'userId'), false);

    const orderDetail = await jsonFetch(server.baseUrl, `/api/membership/orders/${created.payload.order.id}`, { headers: auth });
    assert.equal(orderDetail.response.status, 200);
    assert.equal(Object.hasOwn(orderDetail.payload.order, 'payload'), false);
    assert.equal(Object.hasOwn(orderDetail.payload.order, 'prepayId'), false);
    assert.equal(Object.hasOwn(orderDetail.payload.order, 'userId'), false);

    const refreshed = await jsonFetch(server.baseUrl, '/api/membership/me', { headers: auth });
    assert.equal(refreshed.payload.membership.active, true);
    assert.equal(persisted.length >= 2, true);
  } finally {
    await server.close();
  }
});

test('mock payment actions are unavailable outside mock mode', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    membershipOrders: [{ id: 9, outTradeNo: 'order-9', userId: 1, amountCents: 30000, status: 'prepay_created' }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({ state, now: () => '2026-06-11T08:00:00.000Z' });
  const server = await listen(app);
  try {
    const auth = { authorization: 'Bearer token-1' };
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', { headers: auth, method: 'POST', body: '{}' });
    assert.equal(created.response.status, 503);
    assert.equal(created.payload.code, 'WECHAT_PAY_NOT_CONFIGURED');
    assert.equal(state.memberships.length, 0);

    const confirmed = await jsonFetch(server.baseUrl, '/api/membership/orders/9/mock-confirm', { headers: auth, method: 'POST', body: '{}' });
    assert.equal(confirmed.response.status, 404);
    assert.equal(confirmed.payload.code, 'ORDER_NOT_FOUND');
    assert.equal(state.memberships.length, 0);
  } finally {
    await server.close();
  }
});

test('production mock payment is unavailable unless explicitly allowed', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    membershipOrders: [{ id: 9, outTradeNo: 'order-9', userId: 1, amountCents: 30000, status: 'prepay_created' }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({
      mode: 'mock',
      ready: true,
      nodeEnv: 'production',
      allowMockInProduction: false,
      appId: 'wx123',
    }),
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const auth = { authorization: 'Bearer token-1' };
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', { headers: auth, method: 'POST', body: '{}' });
    assert.equal(created.response.status, 503);
    assert.equal(created.payload.code, 'WECHAT_PAY_NOT_CONFIGURED');
    assert.equal(state.membershipOrders.length, 1);
    assert.equal(state.memberships.length, 0);

    const confirmed = await jsonFetch(server.baseUrl, '/api/membership/orders/9/mock-confirm', { headers: auth, method: 'POST', body: '{}' });
    assert.equal(confirmed.response.status, 404);
    assert.equal(confirmed.payload.code, 'ORDER_NOT_FOUND');
    assert.equal(state.memberships.length, 0);
  } finally {
    await server.close();
  }
});

test('membership order creation respects admin purchase flag', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    membershipConfig: { ...defaultMembershipConfig('2026-06-11T08:00:00.000Z'), enabled: false },
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    wechatPayMode: 'mock',
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', {
      headers: { authorization: 'Bearer token-1' },
      method: 'POST',
      body: '{}',
    });
    assert.equal(created.response.status, 403);
    assert.equal(created.payload.code, 'MEMBERSHIP_PURCHASE_DISABLED');
    assert.equal(state.membershipOrders.length, 0);
  } finally {
    await server.close();
  }
});

test('live membership order requires openid before creating prepay', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({ mode: 'live', ready: true, appId: 'wx123', mchId: 'mch123' }),
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', {
      headers: { authorization: 'Bearer token-1' },
      method: 'POST',
      body: '{}',
    });
    assert.equal(created.response.status, 400);
    assert.equal(created.payload.code, 'WECHAT_OPENID_REQUIRED');
    assert.equal(state.membershipOrders.length, 0);
  } finally {
    await server.close();
  }
});

test('live membership order requires WeChat browser before prepay', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    userWechatIdentities: [{ userId: 1, appId: 'wx123', openid: 'openid-1', scope: 'snsapi_base', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 10,
  };
  const prepayCalls = [];
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({ mode: 'live', ready: true, appId: 'wx123', mchId: 'mch123' }),
    createWechatPayJsapiPrepay: async (input) => {
      prepayCalls.push(input);
      return { prepayId: 'wx-prepay-live', payParams: {} };
    },
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', {
      headers: { authorization: 'Bearer token-1' },
      method: 'POST',
      body: '{}',
    });
    assert.equal(created.response.status, 400);
    assert.equal(created.payload.code, 'WECHAT_BROWSER_REQUIRED');
    assert.equal(prepayCalls.length, 0);
    assert.equal(state.membershipOrders.length, 0);
  } finally {
    await server.close();
  }
});

test('live membership order creates jsapi prepay with bound openid', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    userWechatIdentities: [{ userId: 1, appId: 'wx123', openid: 'openid-1', scope: 'snsapi_base', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 10,
  };
  const prepayCalls = [];
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({ mode: 'live', ready: true, appId: 'wx123', mchId: 'mch123' }),
    createWechatPayJsapiPrepay: async (input) => {
      prepayCalls.push(input);
      return {
        prepayId: 'wx-prepay-live',
        payParams: {
          appId: 'wx123',
          timeStamp: '1790000000',
          nonceStr: 'nonce-1',
          package: 'prepay_id=wx-prepay-live',
          signType: 'RSA',
          paySign: 'signed',
        },
      };
    },
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', {
      headers: { authorization: 'Bearer token-1', 'user-agent': 'MicroMessenger' },
      method: 'POST',
      body: '{}',
    });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.order.status, 'prepay_created');
    assert.equal(created.payload.payParams.appId, 'wx123');
    assert.equal(created.payload.payParams.package, 'prepay_id=wx-prepay-live');
    assert.equal(prepayCalls.length, 1);
    assert.equal(prepayCalls[0].openid, 'openid-1');
    assert.equal(prepayCalls[0].order.outTradeNo, created.payload.order.outTradeNo);
    assert.equal(state.membershipOrders[0].prepayId, 'wx-prepay-live');
  } finally {
    await server.close();
  }
});

test('live prepay failure removes the local membership order', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    userWechatIdentities: [{ userId: 1, appId: 'wx123', openid: 'openid-1', scope: 'snsapi_base', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({ mode: 'live', ready: true, appId: 'wx123', mchId: 'mch123' }),
    createWechatPayJsapiPrepay: async () => {
      const error = new Error('WECHAT_PAY_PREPAY_FAILED');
      error.code = 'WECHAT_PAY_PREPAY_FAILED';
      error.status = 502;
      throw error;
    },
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', {
      headers: { authorization: 'Bearer token-1', 'user-agent': 'MicroMessenger' },
      method: 'POST',
      body: '{}',
    });
    assert.equal(created.response.status, 502);
    assert.equal(created.payload.code, 'WECHAT_PAY_PREPAY_FAILED');
    assert.equal(state.membershipOrders.length, 0);
  } finally {
    await server.close();
  }
});

test('wechat oauth start rejects off-site redirects and callback binds openid', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({ mode: 'live', ready: true, appId: 'wx123', mchId: 'mch123' }),
    fetchWechatOAuthOpenid: async (code) => {
      assert.equal(code, 'code-1');
      return 'openid-1';
    },
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const auth = { authorization: 'Bearer token-1' };
    const rejected = await jsonFetch(server.baseUrl, '/api/membership/wechat-oauth/start', {
      headers: auth,
      method: 'POST',
      body: JSON.stringify({ redirectUrl: 'https://evil.example/#/member' }),
    });
    assert.equal(rejected.response.status, 400);
    assert.equal(rejected.payload.code, 'WECHAT_OAUTH_REDIRECT_URL_INVALID');

    const started = await jsonFetch(server.baseUrl, '/api/membership/wechat-oauth/start', {
      headers: auth,
      method: 'POST',
      body: JSON.stringify({ redirectUrl: '/#/member' }),
    });
    assert.equal(started.response.status, 200);
    assert.match(started.payload.authorizeUrl, /^https:\/\/open\.weixin\.qq\.com\/connect\/oauth2\/authorize\?/);
    assert.match(started.payload.authorizeUrl, /appid=wx123/);
    assert.match(started.payload.authorizeUrl, /response_type=code/);
    assert.equal(started.payload.authorizeUrl.includes('token-1'), false);
    assert.equal(state.wechatOAuthStates.length, 1);

    const stateToken = state.wechatOAuthStates[0].state;
    const callbackResponse = await fetch(`${server.baseUrl}/api/membership/wechat-oauth/callback?code=code-1&state=${stateToken}`, {
      redirect: 'manual',
    });
    assert.equal(callbackResponse.status, 302);
    assert.equal(callbackResponse.headers.get('location'), '/#/member');
    assert.equal(state.wechatOAuthStates[0].usedAt, '2026-06-11T08:00:00.000Z');
    assert.equal(state.userWechatIdentities[0].openid, 'openid-1');
  } finally {
    await server.close();
  }
});

test('wechat oauth callback failure does not consume state or bind openid', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({ mode: 'live', ready: true, appId: 'wx123', mchId: 'mch123' }),
    fetchWechatOAuthOpenid: async () => {
      const error = new Error('WECHAT_OPENID_NOT_FOUND');
      error.code = 'WECHAT_OPENID_NOT_FOUND';
      error.status = 502;
      throw error;
    },
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const started = await jsonFetch(server.baseUrl, '/api/membership/wechat-oauth/start', {
      headers: { authorization: 'Bearer token-1' },
      method: 'POST',
      body: JSON.stringify({ redirectUrl: '/#/member' }),
    });
    assert.equal(started.response.status, 200);
    const stateToken = state.wechatOAuthStates[0].state;
    const callback = await jsonFetch(
      server.baseUrl,
      `/api/membership/wechat-oauth/callback?code=bad-code&state=${stateToken}`,
      { headers: {} },
    );
    assert.equal(callback.response.status, 502);
    assert.equal(callback.payload.code, 'WECHAT_OPENID_NOT_FOUND');
    assert.equal(state.wechatOAuthStates[0].usedAt, '');
    assert.equal(state.userWechatIdentities.length, 0);
  } finally {
    await server.close();
  }
});

test('wechat pay notify verifies signature, decrypts resource, and activates membership', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiV3Key = '12345678901234567890123456789012';
  const state = {
    ...createInitialState(),
    membershipOrders: [{
      id: 9,
      outTradeNo: 'order-9',
      userId: 1,
      productCode: 'annual_membership',
      amountCents: 30000,
      currency: 'CNY',
      status: 'prepay_created',
      prepayId: 'wx-prepay',
      transactionId: '',
      paidAt: '',
      expiresAt: '2026-06-11T08:30:00.000Z',
      createdAt: '2026-06-11T08:00:00.000Z',
      updatedAt: '2026-06-11T08:00:00.000Z',
      payload: {},
    }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({
      mode: 'live',
      ready: true,
      appId: 'wx123',
      mchId: 'mch123',
      apiV3Key,
      platformPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      platformPublicKeyId: 'PUB_KEY_ID_1',
    }),
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const resourcePayload = {
      appid: 'wx123',
      mchid: 'mch123',
      out_trade_no: 'order-9',
      transaction_id: '4200001',
      trade_state: 'SUCCESS',
      success_time: '2026-06-11T08:01:00+08:00',
      amount: { total: 30000 },
    };
    const body = JSON.stringify({
      id: 'notify-1',
      resource: {
        nonce: '0123456789ab',
        associated_data: 'transaction',
        ciphertext: encryptWechatPayResource({
          apiV3Key,
          nonce: '0123456789ab',
          associatedData: 'transaction',
          payload: resourcePayload,
        }),
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = 'notify-nonce';
    const signature = signWechatPayMessage(`${timestamp}\n${nonce}\n${body}\n`, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const notified = await fetch(`${server.baseUrl}/api/membership/wechatpay/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'wechatpay-timestamp': timestamp,
        'wechatpay-nonce': nonce,
        'wechatpay-signature': signature,
        'wechatpay-serial': 'PUB_KEY_ID_1',
      },
      body,
    });
    const payload = await notified.json();
    assert.equal(notified.status, 200);
    assert.deepEqual(payload, { code: 'SUCCESS', message: '成功' });
    assert.equal(state.membershipOrders[0].status, 'paid');
    assert.equal(state.membershipOrders[0].transactionId, '4200001');
    assert.equal(state.memberships[0].userId, 1);
    assert.equal(state.memberships[0].expiresAt, '2027-06-11T00:01:00.000Z');
  } finally {
    await server.close();
  }
});

test('wechat pay notify rejects mismatched serial and stale timestamp', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const apiV3Key = '12345678901234567890123456789012';
  const state = {
    ...createInitialState(),
    membershipOrders: [{
      id: 9,
      outTradeNo: 'order-9',
      userId: 1,
      productCode: 'annual_membership',
      amountCents: 30000,
      currency: 'CNY',
      status: 'prepay_created',
      prepayId: 'wx-prepay',
      transactionId: '',
      paidAt: '',
      expiresAt: '2026-06-11T08:30:00.000Z',
      createdAt: '2026-06-11T08:00:00.000Z',
      updatedAt: '2026-06-11T08:00:00.000Z',
      payload: {},
    }],
    nextId: 10,
  };
  const app = createPolicyOcrApp({
    state,
    resolveWechatPayConfig: () => ({
      mode: 'live',
      ready: true,
      appId: 'wx123',
      mchId: 'mch123',
      apiV3Key,
      platformPublicKey: publicKey.export({ type: 'spki', format: 'pem' }),
      platformPublicKeyId: 'PUB_KEY_ID_1',
    }),
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const resourcePayload = {
      appid: 'wx123',
      mchid: 'mch123',
      out_trade_no: 'order-9',
      transaction_id: '4200001',
      trade_state: 'SUCCESS',
      success_time: '2026-06-11T08:01:00+08:00',
      amount: { total: 30000 },
    };
    const body = JSON.stringify({
      id: 'notify-1',
      resource: {
        nonce: '0123456789ab',
        associated_data: 'transaction',
        ciphertext: encryptWechatPayResource({
          apiV3Key,
          nonce: '0123456789ab',
          associatedData: 'transaction',
          payload: resourcePayload,
        }),
      },
    });
    const currentTimestamp = String(Math.floor(Date.now() / 1000));
    const currentNonce = 'notify-nonce';
    const currentSignature = signWechatPayMessage(`${currentTimestamp}\n${currentNonce}\n${body}\n`, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const wrongSerial = await fetch(`${server.baseUrl}/api/membership/wechatpay/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'wechatpay-timestamp': currentTimestamp,
        'wechatpay-nonce': currentNonce,
        'wechatpay-signature': currentSignature,
        'wechatpay-serial': 'PUB_KEY_ID_2',
      },
      body,
    });
    const wrongSerialPayload = await wrongSerial.json();
    assert.equal(wrongSerial.status, 401);
    assert.equal(wrongSerialPayload.code, 'WECHAT_NOTIFY_SERIAL_MISMATCH');
    assert.equal(state.membershipOrders[0].status, 'prepay_created');

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const staleNonce = 'stale-nonce';
    const staleSignature = signWechatPayMessage(`${staleTimestamp}\n${staleNonce}\n${body}\n`, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const stale = await fetch(`${server.baseUrl}/api/membership/wechatpay/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'wechatpay-timestamp': staleTimestamp,
        'wechatpay-nonce': staleNonce,
        'wechatpay-signature': staleSignature,
        'wechatpay-serial': 'PUB_KEY_ID_1',
      },
      body,
    });
    const stalePayload = await stale.json();
    assert.equal(stale.status, 401);
    assert.equal(stalePayload.code, 'WECHAT_NOTIFY_SIGNATURE_INVALID');
    assert.equal(state.membershipOrders[0].status, 'prepay_created');
    assert.equal(state.memberships.length, 0);
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

test('admin can update membership purchase flag and free quota only', async () => {
  const state = { ...createInitialState(), membershipConfig: defaultMembershipConfig('2026-06-11T08:00:00.000Z') };
  const app = createPolicyOcrApp({
    state,
    adminPassword: 'admin123456',
    wechatPayMode: 'mock',
    now: () => '2026-06-11T09:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const login = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'admin123456' }),
    });
    const auth = { authorization: `Bearer ${login.payload.token}` };
    const updated = await jsonFetch(server.baseUrl, '/api/admin/membership-config', {
      headers: auth,
      method: 'PATCH',
      body: JSON.stringify({
        enabled: false,
        registeredFreePolicyQuota: 6,
        annualPriceCents: 1,
        annualDurationDays: 1,
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.config.enabled, false);
    assert.equal(updated.payload.config.registeredFreePolicyQuota, 6);
    assert.equal(updated.payload.config.annualPriceCents, 30000);
    assert.equal(updated.payload.config.annualDurationDays, 365);

    const fetched = await jsonFetch(server.baseUrl, '/api/admin/membership-config', { headers: auth });
    assert.deepEqual(fetched.payload.config, updated.payload.config);

    const quotaOnly = await jsonFetch(server.baseUrl, '/api/admin/membership-config', {
      headers: auth,
      method: 'PATCH',
      body: JSON.stringify({ registeredFreePolicyQuota: 7 }),
    });
    assert.equal(quotaOnly.response.status, 200);
    assert.equal(quotaOnly.payload.config.enabled, false);
    assert.equal(quotaOnly.payload.config.registeredFreePolicyQuota, 7);

    const enabledOnly = await jsonFetch(server.baseUrl, '/api/admin/membership-config', {
      headers: auth,
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(enabledOnly.response.status, 200);
    assert.equal(enabledOnly.payload.config.enabled, true);
    assert.equal(enabledOnly.payload.config.registeredFreePolicyQuota, 7);
  } finally {
    await server.close();
  }
});
