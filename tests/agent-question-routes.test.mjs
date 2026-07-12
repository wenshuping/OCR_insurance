import assert from 'node:assert/strict';
import test from 'node:test';

import express from 'express';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createAgentQuestionRouter } from '../server/agent-question-router.service.mjs';
import { createAgentRouter } from '../server/routes/agent.routes.mjs';

async function startServer(overrides = {}) {
  const calls = { route: [], confirm: [] };
  const app = express();
  app.use('/api/agent', createAgentRouter({
    questionRouter: {
      async route(input) {
        calls.route.push(input);
        return { decision: 'execute', interaction: { type: 'answer', text: 'ok' } };
      },
    },
    verifyAgentServiceRequest: async (req) => req.get('x-agent-signature') === 'valid',
    resolveChannelIdentity: async ({ channelUserId }) => (
      channelUserId === 'registered' ? { internalUserId: 7 } : null
    ),
    secureUploadLinkFactory: () => 'https://app.example.test/agent/continue',
    secureLinkAllowedOrigins: ['https://app.example.test'],
    confirmationService: {
      async confirm(input) {
        calls.confirm.push(input);
        return { decision: 'execute', interaction: { type: 'answer', text: 'confirmed' } };
      },
    },
    ...overrides,
  }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  return {
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function validBody(extra = {}) {
  return {
    channel: 'dingtalk',
    channelUserId: 'registered',
    messageRef: 'msg-1',
    conversationId: 'conv-1',
    candidate: { intent: 'chat', question: '查一下保障', confidence: 0.9, requestedOperation: 'read' },
    ...extra,
  };
}

async function post(server, path, body, signature = 'valid') {
  const response = await fetch(`${server.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(signature == null ? {} : { 'x-agent-signature': signature }) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

test('question route requires valid service authentication', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const signature of [null, 'invalid']) {
    const { response, payload } = await post(server, '/api/agent/questions/route', validBody(), signature);
    assert.equal(response.status, 401);
    assert.deepEqual(payload, { ok: false, code: 'AGENT_SERVICE_UNAUTHORIZED' });
  }
  assert.equal(server.calls.route.length, 0);
});

test('unregistered DingTalk identity returns the same safe registration action', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const body = validBody({ channelUserId: 'not-linked' });
  const { response, payload } = await post(server, '/api/agent/questions/route', body);
  assert.equal(response.status, 403);
  assert.equal(payload.code, 'AGENT_REGISTRATION_REQUIRED');
  assert.deepEqual(payload.action, { type: 'secure_link', url: 'https://app.example.test/agent/continue' });
  assert.equal(JSON.stringify(payload).includes('mobile'), false);
});

test('valid identity routes only normalized trusted fields', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const { response, payload } = await post(server, '/api/agent/questions/route', validBody({
    userId: 999,
    familyId: 888,
    permissions: ['admin'],
    candidate: { intent: 'chat', question: '查一下保障', confidence: 0.9, requestedOperation: 'read', familyId: 888, permissions: ['admin'] },
  }));
  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(server.calls.route[0], {
    internalUserId: 7,
    messageRef: 'msg-1',
    conversationId: 'conv-1',
    candidate: { intent: 'chat', question: '查一下保障', confidence: 0.9, requestedOperation: 'read' },
  });
});

test('upstream results are reduced to bounded public interaction fields', async (t) => {
  const server = await startServer({
    questionRouter: {
      async route() {
        return {
          ok: false,
          secret: '13800138000',
          internalUserId: 99,
          decision: 'execute',
          requestRef: 'request-1',
          interaction: {
            type: 'answer',
            text: `${'答'.repeat(2000)}secret-tail`,
            secret: 'identity-card',
            options: [{ id: 'choice-1', label: '家庭一', secret: 'private' }],
          },
        };
      },
    },
  });
  t.after(server.close);
  const result = await post(server, '/api/agent/questions/route', validBody());
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload, {
    ok: true,
    decision: 'execute',
    requestRef: 'request-1',
    interaction: {
      type: 'answer',
      text: '答'.repeat(2000),
    },
  });
  assert.equal(JSON.stringify(result.payload).includes('secret'), false);
  assert.equal(JSON.stringify(result.payload).includes('13800138000'), false);
});

test('real family router preserves opaque clarification candidates for the authorized next turn', async (t) => {
  const handled = [];
  const questionRouter = createAgentQuestionRouter({
    store: {
      async load() {
        return {
          familyProfiles: [
            { id: 71, ownerUserId: 7, familyName: '同名家庭', status: 'active' },
            { id: 72, ownerUserId: 7, familyName: '同名家庭', status: 'active' },
          ],
          policies: [],
        };
      },
      async getPublishedAgentQuestionPolicyVersion() { return null; },
      async recordAgentRouteAudit() {},
    },
    handlers: {
      async insurance_expert(input) {
        handled.push(input);
        return { interaction: { type: 'answer', text: '已授权查询' } };
      },
    },
  });
  const server = await startServer({ questionRouter });
  t.after(server.close);
  const first = await post(server, '/api/agent/questions/route', validBody({
    candidate: {
      intent: 'family_summary', question: '查看同名家庭', confidence: 1, requestedOperation: 'read',
      entities: { familyName: '同名家庭' },
    },
  }));
  assert.equal(first.payload.decision, 'clarify');
  assert.equal(first.payload.interaction.candidates.length, 2);
  assert.deepEqual(Object.keys(first.payload.interaction.candidates[0]).sort(), ['label', 'ref']);
  assert.match(first.payload.interaction.candidates[0].ref, /^family_[a-f0-9]{16}$/u);
  assert.equal(JSON.stringify(first.payload).includes('同名家庭'), false);

  const second = await post(server, '/api/agent/questions/route', validBody({
    messageRef: 'msg-2',
    candidate: {
      intent: 'family_summary', question: '查看所选家庭', confidence: 1, requestedOperation: 'read',
      entities: { familyRef: first.payload.interaction.candidates[0].ref },
    },
  }));
  assert.equal(second.payload.decision, 'execute');
  assert.equal(second.payload.interaction.text, '已授权查询');
  assert.equal(handled.length, 1);
  assert.ok([71, 72].includes(handled[0].familyId));
});

test('secure-link and confirmation interactions retain only their type-specific public fields', async (t) => {
  const results = [
    {
      decision: 'open_web',
      interaction: {
        type: 'secure_link', text: '继续', url: 'https://app.example.test/continue', action: 'open_web',
        secret: 'private',
      },
    },
    {
      decision: 'confirm',
      confirmationId: 'cfm-top',
      interaction: {
        type: 'confirmation', text: '请确认', confirmationId: 'cfm-inner', summary: '生成家庭报告',
        options: [{ id: 'approve', label: '确认', secret: 'private' }], secret: 'private',
      },
    },
  ];
  const server = await startServer({ questionRouter: { route: async () => results.shift() } });
  t.after(server.close);
  const secure = await post(server, '/api/agent/questions/route', validBody());
  assert.deepEqual(secure.payload, {
    ok: true,
    decision: 'open_web',
    interaction: {
      type: 'secure_link', text: '继续', url: 'https://app.example.test/continue', action: 'open_web',
    },
  });
  const confirmation = await post(server, '/api/agent/questions/route', validBody({ messageRef: 'msg-2' }));
  assert.deepEqual(confirmation.payload, {
    ok: true,
    decision: 'confirm',
    confirmationId: 'cfm-top',
    interaction: {
      type: 'confirmation', text: '请确认', confirmationId: 'cfm-inner', summary: '生成家庭报告',
      options: [{ id: 'approve', label: '确认' }],
    },
  });
  assert.equal(JSON.stringify([secure.payload, confirmation.payload]).includes('private'), false);
});

test('progress interaction retains bounded job status fields only', async (t) => {
  const server = await startServer({
    questionRouter: {
      async route() {
        return {
          decision: 'execute',
          interaction: {
            type: 'progress', jobId: 'job-1', status: 'processing', message: '正在生成', progress: 45,
            internalQueue: 'private',
          },
        };
      },
    },
  });
  t.after(server.close);
  const result = await post(server, '/api/agent/questions/route', validBody());
  assert.deepEqual(result.payload, {
    ok: true,
    decision: 'execute',
    interaction: {
      type: 'progress', jobId: 'job-1', status: 'processing', message: '正在生成', progress: 45,
    },
  });
});

test('malformed and oversized question payloads have stable errors', async (t) => {
  const server = await startServer({ maxBodyBytes: 512 });
  t.after(server.close);
  const malformed = await post(server, '/api/agent/questions/route', { channel: 'dingtalk' });
  assert.equal(malformed.response.status, 400);
  assert.equal(malformed.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  const unknownField = await post(server, '/api/agent/questions/route', validBody({ unexpected: 'value' }));
  assert.equal(unknownField.response.status, 400);
  assert.equal(unknownField.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  const oversized = await post(server, '/api/agent/questions/route', validBody({ candidate: { intent: 'chat', question: 'x'.repeat(1000) } }));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.payload.code, 'AGENT_REQUEST_TOO_LARGE');
});

test('configured body limit cannot exceed the 16KiB gateway ceiling', async (t) => {
  const server = await startServer({ maxBodyBytes: 64 * 1024 });
  t.after(server.close);
  const oversized = await post(server, '/api/agent/questions/route', validBody({
    candidate: { intent: 'chat', question: 'x', requestedOperation: 'read', confidence: 1 },
    padding: 'x'.repeat(17 * 1024),
  }));
  assert.equal(oversized.response.status, 413);
  assert.equal(oversized.payload.code, 'AGENT_REQUEST_TOO_LARGE');
});

test('raw attachments are rejected with a customer secure upload action', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const field of ['attachment', 'image', 'pdf']) {
    const result = await post(server, '/api/agent/questions/route', validBody({ [field]: 'raw-private-content' }));
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'DINGTALK_POLICY_UPLOAD_DISABLED');
    assert.equal(result.payload.action.url, 'https://app.example.test/agent/continue');
  }
  assert.equal(server.calls.route.length, 0);
});

test('confirmation requires the resolved owner and delegates ownership enforcement', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const result = await post(server, '/api/agent/actions/cfm-1/confirm', {
    channel: 'dingtalk', channelUserId: 'registered', messageRef: 'msg-confirm', userId: 999,
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(server.calls.confirm[0], {
    confirmationId: 'cfm-1', internalUserId: 7, messageRef: 'msg-confirm', channel: 'dingtalk',
  });
});

test('confirmation schema rejects question-only and nested fields', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const extra of [
    { candidate: validBody().candidate },
    { unexpected: { nested: true } },
  ]) {
    const result = await post(server, '/api/agent/actions/cfm-1/confirm', {
      channel: 'dingtalk', channelUserId: 'registered', messageRef: 'msg-confirm', ...extra,
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  }
  assert.equal(server.calls.confirm.length, 0);
});

test('confirmation ownership failures do not reveal whether an action exists', async (t) => {
  const server = await startServer({
    confirmationService: {
      async confirm() {
        throw Object.assign(new Error('confirmation belongs to user 99'), { status: 404, code: 'NOT_FOUND' });
      },
    },
  });
  t.after(server.close);
  const result = await post(server, '/api/agent/actions/private-confirmation/confirm', {
    channel: 'dingtalk', channelUserId: 'registered', messageRef: 'msg-confirm',
  });
  assert.equal(result.response.status, 403);
  assert.deepEqual(result.payload, { ok: false, code: 'AGENT_CONFIRMATION_FORBIDDEN' });
  assert.equal(JSON.stringify(result.payload).includes('99'), false);
});

test('missing confirmation service is stable not_supported', async (t) => {
  const server = await startServer({ confirmationService: null });
  t.after(server.close);
  const result = await post(server, '/api/agent/actions/cfm-1/confirm', {
    channel: 'dingtalk', channelUserId: 'registered', messageRef: 'msg-confirm',
  });
  assert.equal(result.response.status, 501);
  assert.equal(result.payload.code, 'AGENT_CONFIRMATION_NOT_SUPPORTED');
});

test('unconfigured resolver fails safely and non-DingTalk channels are rejected', async (t) => {
  const server = await startServer({ resolveChannelIdentity: undefined });
  t.after(server.close);
  const missingResolver = await post(server, '/api/agent/questions/route', validBody());
  assert.equal(missingResolver.response.status, 403);
  assert.equal(missingResolver.payload.code, 'AGENT_REGISTRATION_REQUIRED');
  const wrongChannel = await post(server, '/api/agent/questions/route', validBody({ channel: 'wechat' }));
  assert.equal(wrongChannel.response.status, 400);
  assert.equal(wrongChannel.payload.code, 'AGENT_CHANNEL_UNSUPPORTED');
});

test('router failures are redacted while rate limits pass through', async (t) => {
  const secret = '13800138000 internal stack';
  const failing = await startServer({ questionRouter: { route: async () => { throw Object.assign(new Error(secret), { stack: secret }); } } });
  t.after(failing.close);
  const internal = await post(failing, '/api/agent/questions/route', validBody());
  assert.equal(internal.response.status, 502);
  assert.deepEqual(internal.payload, { ok: false, code: 'AGENT_GATEWAY_UPSTREAM_ERROR' });
  assert.equal(JSON.stringify(internal.payload).includes('13800138000'), false);

  const limited = await startServer({ questionRouter: { route: async () => { throw Object.assign(new Error('secret'), { status: 429, code: 'PRIVATE_LIMITER_NAME' }); } } });
  t.after(limited.close);
  const rateLimit = await post(limited, '/api/agent/questions/route', validBody());
  assert.equal(rateLimit.response.status, 429);
  assert.deepEqual(rateLimit.payload, { ok: false, code: 'AGENT_RATE_LIMITED' });
});

test('secure actions accept only relative paths or allowlisted HTTPS origins', async (t) => {
  for (const unsafeUrl of [
    'javascript:alert(1)',
    'http://app.example.test/upload',
    'https://user@app.example.test/upload',
    '//app.example.test/upload',
    'https://evil.example.test/upload',
  ]) {
    const server = await startServer({ secureUploadLinkFactory: () => unsafeUrl });
    t.after(server.close);
    const result = await post(server, '/api/agent/questions/route', validBody({ channelUserId: 'not-linked' }));
    assert.deepEqual(result.payload.action, { type: 'secure_link' });
  }
  const server = await startServer({ secureUploadLinkFactory: () => '/agent/continue' });
  t.after(server.close);
  const safe = await post(server, '/api/agent/questions/route', validBody({ channelUserId: 'not-linked' }));
  assert.equal(safe.payload.action.url, '/agent/continue');
});

test('createPolicyOcrApp maps malformed and oversized agent JSON before the global parser', async (t) => {
  const app = createPolicyOcrApp({
    recomputeCashflowOnStartup: false,
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const sendRaw = async (body) => {
    const response = await fetch(`${baseUrl}/api/agent/questions/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    });
    return { response, payload: await response.json() };
  };
  const malformed = await sendRaw('{bad json');
  assert.equal(malformed.response.status, 400);
  assert.deepEqual(malformed.payload, { ok: false, code: 'AGENT_REQUEST_SCHEMA_INVALID' });
  const oversized = await sendRaw(JSON.stringify({ payload: 'x'.repeat(17 * 1024) }));
  assert.equal(oversized.response.status, 413);
  assert.deepEqual(oversized.payload, { ok: false, code: 'AGENT_REQUEST_TOO_LARGE' });
});
