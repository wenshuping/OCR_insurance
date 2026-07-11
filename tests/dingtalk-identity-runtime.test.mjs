import assert from 'node:assert/strict';
import test from 'node:test';

import { createDingtalkIdentityRuntime } from '../server/dingtalk-identity-runtime.mjs';

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

test('server entry wires DingTalk store persistence and runtime adapters', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) => readFile(new URL('../server/index.mjs', import.meta.url), 'utf8'));
  assert.match(source, /persistDingtalkIdentityState:\s*store\.persistDingtalkIdentityState/);
  assert.match(source, /createDingtalkIdentityRuntime\(\{ env: process\.env \}\)/);
  assert.match(source, /\.\.\.dingtalkIdentityRuntime/);
});
