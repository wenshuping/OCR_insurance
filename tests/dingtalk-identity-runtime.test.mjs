import assert from 'node:assert/strict';
import test from 'node:test';

import { createDingtalkIdentityRuntime } from '../server/dingtalk-identity-runtime.mjs';

const CONFIGURED_ENV = {
  DINGTALK_IDENTITY_SERVICE_TOKEN: 'service-secret',
  DINGTALK_CORP_ID: 'corp-1',
  DINGTALK_APP_KEY: 'app-key',
  DINGTALK_APP_SECRET: 'app-secret',
};

async function assertRuntimeError(operation, code, status) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.equal(error.message, code);
    const serialized = JSON.stringify({ code: error.code, message: error.message });
    for (const secret of ['app-secret', 'access-secret', 'raw profile', 'upstream body']) {
      assert.equal(serialized.includes(secret), false);
    }
    return true;
  });
}

test('DingTalk runtime is fail-closed when configuration is incomplete', async () => {
  const runtime = createDingtalkIdentityRuntime({ env: {} });
  assert.deepEqual(runtime.dingtalkAllowedUserIds, []);
  assert.equal(await runtime.authenticateDingtalkServiceRequest({ get: () => '' }), false);
  await assert.rejects(() => runtime.getDingtalkUserProfile({ corpId: 'corp-1', dingUserId: 'ding-1' }), (error) => {
    assert.equal(error.code, 'DINGTALK_PROFILE_NOT_CONFIGURED');
    return true;
  });
});

test('configured DingTalk runtime authenticates service requests and fetches a user mobile', async () => {
  const requests = [];
  const runtime = createDingtalkIdentityRuntime({
    env: {
      DINGTALK_IDENTITY_SERVICE_TOKEN: 'service-secret',
      DINGTALK_IDENTITY_ALLOWED_USER_IDS: '7, 8',
      DINGTALK_CORP_ID: 'corp-1',
      DINGTALK_APP_KEY: 'app-key',
      DINGTALK_APP_SECRET: 'app-secret',
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/v1.0/oauth2/accessToken')) {
        return { ok: true, json: async () => ({ accessToken: 'access-secret' }) };
      }
      return { ok: true, json: async () => ({ mobile: '13800138000', name: 'raw name' }) };
    },
  });
  assert.deepEqual(runtime.dingtalkAllowedUserIds, [7, 8]);
  assert.equal(await runtime.authenticateDingtalkServiceRequest({
    get: (name) => name === 'authorization' ? 'Bearer service-secret' : '',
  }), true);
  assert.deepEqual(await runtime.getDingtalkUserProfile({ corpId: 'corp-1', dingUserId: 'ding-1' }), {
    mobile: '13800138000',
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].options.headers['x-acs-dingtalk-access-token'], 'access-secret');
});

test('service authentication accepts valid token and safely rejects different token lengths', () => {
  const runtime = createDingtalkIdentityRuntime({ env: CONFIGURED_ENV });
  const request = (token) => ({ get: () => `Bearer ${token}` });
  assert.equal(runtime.authenticateDingtalkServiceRequest(request('service-secret')), true);
  assert.equal(runtime.authenticateDingtalkServiceRequest(request('wrong-secret-x')), false);
  assert.equal(runtime.authenticateDingtalkServiceRequest(request('x')), false);
});

test('DingTalk HTTP timeout aborts the request and returns a sanitized 504', async () => {
  let aborted = false;
  const runtime = createDingtalkIdentityRuntime({
    env: CONFIGURED_ENV,
    timeoutMs: 50,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new DOMException('app-secret timeout detail', 'AbortError'));
      }, { once: true });
    }),
  });
  await assertRuntimeError(
    () => runtime.getDingtalkUserProfile({ corpId: 'corp-1', dingUserId: 'ding-1' }),
    'DINGTALK_REQUEST_TIMEOUT',
    504,
  );
  assert.equal(aborted, true);
});

test('DingTalk token transport, JSON, and HTTP failures use a sanitized stable 502', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('app-secret network detail'); },
    async () => ({ ok: true, json: async () => { throw new Error('upstream body'); } }),
    async () => ({ ok: false, status: 401, json: async () => ({ message: 'app-secret upstream body' }) }),
  ]) {
    const runtime = createDingtalkIdentityRuntime({ env: CONFIGURED_ENV, fetchImpl });
    await assertRuntimeError(
      () => runtime.getDingtalkUserProfile({ corpId: 'corp-1', dingUserId: 'ding-1' }),
      'DINGTALK_ACCESS_TOKEN_FAILED',
      502,
    );
  }
});

test('DingTalk profile non-JSON and non-2xx failures use a sanitized stable 502', async () => {
  for (const profileResponse of [
    { ok: true, json: async () => { throw new Error('raw profile'); } },
    { ok: true, json: async () => ({}) },
    { ok: false, status: 403, json: async () => ({ detail: 'access-secret raw profile' }) },
  ]) {
    let requestCount = 0;
    const runtime = createDingtalkIdentityRuntime({
      env: CONFIGURED_ENV,
      fetchImpl: async () => {
        requestCount += 1;
        return requestCount === 1
          ? { ok: true, json: async () => ({ accessToken: 'access-secret' }) }
          : profileResponse;
      },
    });
    await assertRuntimeError(
      () => runtime.getDingtalkUserProfile({ corpId: 'corp-1', dingUserId: 'ding-1' }),
      'DINGTALK_PROFILE_LOOKUP_FAILED',
      502,
    );
  }
});

test('server entry wires DingTalk store persistence and runtime adapters', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../server/index.mjs', import.meta.url), 'utf8'));
  assert.match(source, /persistDingtalkIdentityState:\s*store\.persistDingtalkIdentityState/);
  assert.match(source, /createDingtalkIdentityRuntime\(\{ env: process\.env \}\)/);
  assert.match(source, /\.\.\.dingtalkIdentityRuntime/);
});
