import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  createAgentSecureLinkFactory,
  createAgentServiceRequestVerifier,
  createDingTalkMobileIdentityResolver,
  createProductionAgentGatewayOptions,
} from '../server/agent-gateway-runtime.service.mjs';

const NOW = 1_784_000_000_000;

function request(rawBody, timestamp, signature) {
  const headers = { 'x-agent-timestamp': String(timestamp), 'x-agent-signature': signature };
  return { rawBody, get(name) { return headers[name.toLowerCase()] || ''; } };
}

function sign(secret, timestamp, rawBody) {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

test('agent HMAC verifier authenticates timestamp dot rawBody and rejects tampering, expiry, replay, and missing secret', async () => {
  const secret = 'runtime-test-secret';
  const rawBody = '{"channelMobile":"13800138000"}';
  const signature = sign(secret, NOW, rawBody);
  const verifier = createAgentServiceRequestVerifier({ secret, clock: () => NOW, maxSkewMs: 60_000 });

  assert.equal(await verifier(request(rawBody, NOW, signature)), true);
  assert.equal(await verifier(request(rawBody, NOW, signature)), false);
  assert.equal(await createAgentServiceRequestVerifier({ secret, clock: () => NOW })(request(`${rawBody} `, NOW, signature)), false);
  assert.equal(await createAgentServiceRequestVerifier({ secret, clock: () => NOW, maxSkewMs: 1000 })(request(rawBody, NOW - 1001, sign(secret, NOW - 1001, rawBody))), false);
  assert.equal(await createAgentServiceRequestVerifier({ secret: '', clock: () => NOW })(request(rawBody, NOW, signature)), false);
});

test('DingTalk mobile resolver returns only a unique active platform user and enforces an existing channel binding', async () => {
  let state = { users: [{ id: 7, mobile: '13800138000', status: 'active' }] };
  const resolve = createDingTalkMobileIdentityResolver({ loadState: async () => state });
  assert.deepEqual(await resolve({ channel: 'dingtalk', channelUserId: 'ding-7', channelMobile: '+86 138-0013-8000' }), { internalUserId: 7 });
  assert.equal(JSON.stringify(await resolve({ channel: 'dingtalk', channelUserId: 'ding-7', channelMobile: '+86 138-0013-8000' })).includes('13800138000'), false);
  assert.equal(await resolve({ channel: 'dingtalk', channelUserId: 'ding-7', channelMobile: '13900139000' }), null);

  state = { users: [{ id: 7, mobile: '13800138000' }, { id: 8, mobile: '13800138000' }] };
  assert.equal(await resolve({ channel: 'dingtalk', channelUserId: 'ding-7', channelMobile: '13800138000' }), null);
  state = { users: [{ id: 7, mobile: '13800138000', status: 'disabled' }] };
  assert.equal(await resolve({ channel: 'dingtalk', channelUserId: 'ding-7', channelMobile: '13800138000' }), null);
  state = {
    users: [{ id: 7, mobile: '13800138000', status: 'active' }],
    agentChannelIdentities: [{ userId: 7, channel: 'dingtalk', channelUserId: 'other-ding-id', status: 'active' }],
  };
  assert.equal(await resolve({ channel: 'dingtalk', channelUserId: 'ding-7', channelMobile: '13800138000' }), null);
});

test('secure link factory and production option builder require an HTTPS public origin', () => {
  const links = createAgentSecureLinkFactory({ publicAppUrl: 'https://app.example.test/base' });
  assert.equal(links({ purpose: 'register_or_login' }), 'https://app.example.test/agent/register');
  assert.equal(links({ purpose: 'policy_upload' }), 'https://app.example.test/customer/policies/upload');
  assert.equal(createAgentSecureLinkFactory({ publicAppUrl: 'http://app.example.test' })({ purpose: 'policy_upload' }), '');
  const options = createProductionAgentGatewayOptions({
    env: { AGENT_GATEWAY_HMAC_SECRET: 'secret', POLICY_OCR_PUBLIC_APP_URL: 'https://app.example.test' },
    loadState: async () => ({ users: [] }), clock: () => NOW,
  });
  assert.equal(typeof options.verifyAgentServiceRequest, 'function');
  assert.equal(typeof options.resolveDingTalkIdentity, 'function');
  assert.equal(typeof options.agentSecureUploadLinkFactory, 'function');
  assert.deepEqual(options.agentSecureLinkAllowedOrigins, ['https://app.example.test']);
});
