import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import express from 'express';

import { createPolicyOcrApp, resolveAgentSemanticMode } from '../server/app.mjs';
import { createAgentQuestionHandlers } from '../server/agent-question-handlers.service.mjs';
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

function semanticBody(extra = {}) {
  return {
    channel: 'dingtalk',
    channelUserId: 'registered',
    messageRef: 'msg-semantic-1',
    conversationId: 'conv-1',
    question: '新华人寿康健无忧两全保险主要保什么',
    runtime: 'hermes',
    proposal: {
      semanticContractVersion: 1,
      intent: 'insurance_product_knowledge',
      operation: 'read',
      queryAspects: ['main_responsibilities'],
      mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
      references: [],
      requestedSteps: ['lookup'],
      confidence: { intent: 1, mentions: 1, references: 1 },
    },
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

test('semantic question route forwards only the proposal contract fields', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const body = semanticBody({ internalUserId: 999, permissions: ['admin'] });
  const { response } = await post(server, '/api/agent/questions/route', body);

  assert.equal(response.status, 200);
  assert.deepEqual(server.calls.route[0], {
    internalUserId: 7,
    messageRef: 'msg-semantic-1',
    conversationId: 'conv-1',
    question: body.question,
    runtime: 'hermes',
    proposal: body.proposal,
  });
});

test('semantic fallback reason is allowlisted and rule preparse is explicit', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const direct = await post(server, '/api/agent/questions/route', semanticBody({
    runtime: 'direct', fallbackReason: 'hermes_unavailable',
  }));
  assert.equal(direct.response.status, 200);
  assert.equal(server.calls.route[0].fallbackReason, 'hermes_unavailable');

  const rule = await post(server, '/api/agent/questions/route', semanticBody({
    question: '上传保单', runtime: 'rule', proposal: null,
  }));
  assert.equal(rule.response.status, 200);
  assert.equal(server.calls.route[1].runtime, 'rule');
  assert.equal(server.calls.route[1].fallbackReason, 'rule_preparse');

  const invalid = await post(server, '/api/agent/questions/route', semanticBody({
    fallbackReason: 'private_customer_name',
  }));
  assert.equal(invalid.response.status, 400);
});

test('semantic fallback reasons must match runtime and proposal shape', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const invalidBodies = [
    semanticBody({ fallbackReason: 'candidate_selection' }),
    semanticBody({ fallbackReason: 'rule_preparse' }),
    semanticBody({ runtime: 'direct', fallbackReason: 'rule_preparse' }),
    semanticBody({ runtime: 'rule', fallbackReason: 'hermes_unavailable', proposal: null, question: '上传保单' }),
  ];
  for (const [index, body] of invalidBodies.entries()) {
    body.messageRef = `invalid-fallback-${index}`;
    const result = await post(server, '/api/agent/questions/route', body);
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  }
  assert.equal(server.calls.route.length, 0);
});

test('HTTP candidate selection projects local rule runtime and fallback provenance', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const result = await post(server, '/api/agent/questions/route', semanticBody({
    question: '选择2', runtime: 'hermes', proposal: null,
  }));
  assert.equal(result.response.status, 200);
  assert.equal(server.calls.route[0].runtime, 'rule');
  assert.equal(server.calls.route[0].fallbackReason, 'candidate_selection');
  assert.equal(server.calls.route[0].proposal, null);
});

test('HTTP accepts trusted Direct-to-rule fallback provenance', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const fallbackReason of ['direct_unavailable', 'direct_invalid_output']) {
    const result = await post(server, '/api/agent/questions/route', semanticBody({
      messageRef: `rule-${fallbackReason}`,
      question: '请继续处理', runtime: 'rule', proposal: null, fallbackReason,
    }));
    assert.equal(result.response.status, 200);
    assert.equal(server.calls.route.at(-1).runtime, 'rule');
    assert.equal(server.calls.route.at(-1).fallbackReason, fallbackReason);
  }
});

test('HTTP candidate selection rejects proposal-free direct and rule runtimes', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const runtime of ['direct', 'rule']) {
    for (const proposal of [null, undefined]) {
      const result = await post(server, '/api/agent/questions/route', semanticBody({
        messageRef: `invalid-selection-${runtime}-${String(proposal)}`,
        question: '选择2',
        runtime,
        proposal,
      }));
      assert.equal(result.response.status, 400);
      assert.equal(result.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
    }
  }
  assert.equal(server.calls.route.length, 0);
});

test('semantic proposals are strictly normalized at the HTTP boundary', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const normalized = semanticBody();
  normalized.proposal.queryAspects.push('main_responsibilities');
  const accepted = await post(server, '/api/agent/questions/route', normalized);
  assert.equal(accepted.response.status, 200);
  assert.deepEqual(server.calls.route[0].proposal.queryAspects, ['main_responsibilities']);
  assert.notStrictEqual(server.calls.route[0].proposal, normalized.proposal);

  const invalidProposals = [
    { ...semanticBody().proposal, internalUserId: 7 },
    {
      ...semanticBody().proposal,
      mentions: [{
        ...semanticBody().proposal.mentions[0],
        productCanonicalId: 'forged-product',
      }],
    },
    {
      ...semanticBody().proposal,
      mentions: [{ type: 'product', rawText: '原问题中不存在的产品' }],
    },
  ];
  for (const [index, proposal] of invalidProposals.entries()) {
    const result = await post(server, '/api/agent/questions/route', semanticBody({
      messageRef: `invalid-proposal-${index}`,
      proposal,
    }));
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  }
  const invalidRule = await post(server, '/api/agent/questions/route', semanticBody({
    messageRef: 'invalid-rule-proposal', runtime: 'rule', proposal: invalidProposals[0],
  }));
  assert.equal(invalidRule.response.status, 400);
  assert.equal(invalidRule.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  assert.equal(server.calls.route.length, 1);
});

test('semantic route rejects mixed modes, invalid runtimes, and missing model proposals', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const body of [
    semanticBody({ candidate: validBody().candidate }),
    semanticBody({ runtime: 'shell' }),
    semanticBody({ proposal: null }),
    semanticBody({ runtime: 'direct', proposal: undefined }),
    semanticBody({ question: 'x'.repeat(1_001) }),
  ]) {
    const result = await post(server, '/api/agent/questions/route', body);
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  }
  assert.equal(server.calls.route.length, 0);
});

test('rule upload fallback accepts a null or omitted proposal', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const proposal of [null, undefined]) {
    const result = await post(server, '/api/agent/questions/route', semanticBody({
      messageRef: `upload-${String(proposal)}`,
      question: '上传保单',
      runtime: 'rule',
      proposal,
    }));
    assert.equal(result.response.status, 200);
  }
  assert.equal(server.calls.route.length, 2);
  assert.equal(server.calls.route[0].proposal, null);
  assert.equal(Object.hasOwn(server.calls.route[1], 'proposal'), false);
  assert.equal(server.calls.route.every((call) => (
    call.runtime === 'rule' && call.fallbackReason === 'rule_preparse'
  )), true);

  const inferred = await post(server, '/api/agent/questions/route', semanticBody({
    messageRef: 'upload-hermes-inferred', question: '上传保单', runtime: 'hermes', proposal: null,
  }));
  assert.equal(inferred.response.status, 200);
  assert.equal(server.calls.route[2].runtime, 'rule');
  assert.equal(server.calls.route[2].fallbackReason, 'rule_preparse');
});

test('legacy candidate strips semantic authority entities before routing', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const result = await post(server, '/api/agent/questions/route', validBody({
    candidate: {
      ...validBody().candidate,
      entities: {
        familyRef: 'family_opaque',
        ' productCanonicalId ': 'forged-product',
        'productCompany ': 'forged-company',
        ' familyId': '71',
        resolvedEntities: 'forged',
      },
    },
  }));

  assert.equal(result.response.status, 200);
  assert.deepEqual(server.calls.route[0].candidate.entities, { familyRef: 'family_opaque' });
});

test('legacy candidate rejects entity keys that collide after trimming', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const result = await post(server, '/api/agent/questions/route', validBody({
    candidate: {
      ...validBody().candidate,
      entities: { familyRef: 'first', ' familyRef ': 'second' },
    },
  }));

  assert.equal(result.response.status, 400);
  assert.equal(result.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  assert.equal(server.calls.route.length, 0);
});

test('legacy candidate accepts only read or write requestedOperation', async (t) => {
  const server = await startServer();
  t.after(server.close);
  for (const requestedOperation of ['delete', 'execute', 'READ']) {
    const result = await post(server, '/api/agent/questions/route', validBody({
      candidate: { ...validBody().candidate, requestedOperation },
    }));
    assert.equal(result.response.status, 400);
    assert.equal(result.payload.code, 'AGENT_REQUEST_SCHEMA_INVALID');
  }
  assert.equal(server.calls.route.length, 0);
});

test('channel mobile is available only to the authenticated identity resolver', async (t) => {
  const identityInputs = [];
  const server = await startServer({
    resolveChannelIdentity: async (input) => { identityInputs.push(input); return { internalUserId: 7 }; },
  });
  t.after(server.close);
  const result = await post(server, '/api/agent/questions/route', validBody({ channelMobile: '+86 138-0013-8000' }));
  assert.equal(result.response.status, 200);
  assert.deepEqual(identityInputs, [{ channel: 'dingtalk', channelUserId: 'registered', channelMobile: '+86 138-0013-8000' }]);
  assert.equal(JSON.stringify(server.calls.route).includes('13800138000'), false);
  assert.equal(JSON.stringify(result.payload).includes('13800138000'), false);
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
    '/\\evil.example/x',
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

test('malformed encoded action paths return the stable JSON schema error', async (t) => {
  const server = await startServer();
  t.after(server.close);
  const response = await fetch(`${server.baseUrl}/api/agent/actions/%E0%A4%A/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-signature': 'valid' },
    body: JSON.stringify({ channel: 'dingtalk', channelUserId: 'registered', messageRef: 'msg-confirm' }),
  });
  assert.equal(response.status, 400);
  assert.match(response.headers.get('content-type') || '', /^application\/json/u);
  assert.deepEqual(await response.json(), { ok: false, code: 'AGENT_REQUEST_SCHEMA_INVALID' });
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

test('createPolicyOcrApp isolates a disabled or failing Hermes route from application health', async (t) => {
  for (const agentQuestionRouter of [null, { async route() { throw new Error('Hermes unavailable 13800138000'); } }]) {
    const app = createPolicyOcrApp({
      recomputeCashflowOnStartup: false,
      agentQuestionRouter,
      verifyAgentServiceRequest: async () => true,
      resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
      runtimeStartedAt: '2026-07-13T00:00:00.000Z',
      runtimeSessionId: 'acceptance-session',
    });
    const listener = await new Promise((resolve) => {
      const running = app.listen(0, '127.0.0.1', () => resolve(running));
    });
    t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
    const baseUrl = `http://127.0.0.1:${listener.address().port}`;

    const routed = await fetch(`${baseUrl}/api/agent/questions/route`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validBody()),
    });
    assert.equal(routed.status, 502);
    assert.deepEqual(await routed.json(), { ok: false, code: 'AGENT_GATEWAY_UPSTREAM_ERROR' });

    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      ok: true, service: 'policy-ocr-app', startedAt: '2026-07-13T00:00:00.000Z', sessionId: 'acceptance-session',
    });
  }
});

test('createPolicyOcrApp default composition routes family facts, report regeneration, and sales coaching', async (t) => {
  const state = {
    nextId: 900,
    familyProfiles: [{
      id: 71, ownerUserId: 7, familyName: '余贵祥家庭', mobile: '13800138000', status: 'active',
      planningProfile: { annualIncome: 240000, premiumBudget: 36000 }, updatedAt: '2026-07-12T00:00:00.000Z',
    }],
    familyMembers: [{ id: 711, familyId: 71, name: '余贵祥', idNumber: '110101199001011234', status: 'active' }],
    policies: [{
      id: 712, userId: 7, familyId: 71, policyNo: 'SECRET-0001', name: '测试终身寿险', company: '测试保险',
      insuredMemberId: 711, applicantMemberId: 711, coveragePeriod: '终身', amount: '100000', status: 'active',
    }],
    familyReports: [], familySalesReviews: [],
    familySalesChatThreads: [{ id: 801, familyId: 71, ownerUserId: 7, status: 'active' }],
    familySalesChatMessages: [{ id: 802, threadId: 801, familyId: 71, role: 'user', content: '给我销售建议' }],
  };
  const calls = { audits: [], generated: [], persistedReports: [] };
  const store = {
    async load() { return state; },
    async getPublishedAgentQuestionPolicyVersion() { return null; },
    async recordAgentRouteAudit(input) { calls.audits.push(input); },
  };
  const app = createPolicyOcrApp({
    state, agentStore: store,
    recomputeCashflowOnStartup: false,
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
    persistFamilyReportState: async ({ state: snapshot }) => { calls.persistedReports.push(snapshot.familyReports.at(-1)); },
    persistFamilyState: async () => {},
    generateFamilySalesChatReply: async (input) => {
      calls.generated.push(input);
      return { content: '先确认预算，再讨论保障优先级。', model: 'stub-external-model' };
    },
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const server = { baseUrl: `http://127.0.0.1:${listener.address().port}` };

  const summary = await post(server, '/api/agent/questions/route', validBody({ messageRef: 'msg-summary', candidate: {
    intent: 'family_summary', question: '余贵祥家庭有几个保单', confidence: 1, requestedOperation: 'read',
    entities: { familyName: '余贵祥家庭' },
  } }));
  assert.equal(summary.response.status, 200);
  assert.equal(summary.payload.interaction.text, '该家庭共有 1 份保单，其中 1 份当前有效。');

  const report = await post(server, '/api/agent/questions/route', validBody({ candidate: {
    intent: 'coverage_report', question: '看余贵祥家庭保障报告', confidence: 1, requestedOperation: 'read',
    entities: { familyName: '余贵祥家庭' },
  } }));
  assert.equal(report.response.status, 200);
  assert.equal(report.payload.interaction.type, 'progress', JSON.stringify({ report: report.payload, audits: calls.audits, persisted: calls.persistedReports }));
  assert.equal(report.payload.interaction.status, 'processing');
  assert.equal(report.payload.interaction.progress, 100);
  assert.equal(calls.persistedReports.length, 1);
  assert.equal(calls.persistedReports[0].familyId, 71);

  const sales = await post(server, '/api/agent/questions/route', validBody({ messageRef: 'msg-sales', candidate: {
    intent: 'sales_coaching', question: '那我该怎么跟他聊', confidence: 1, requestedOperation: 'read',
    entities: { familyName: '余贵祥家庭' },
  } }));
  assert.equal(sales.response.status, 200);
  assert.equal(sales.payload.interaction.text, '先确认预算，再讨论保障优先级。');
  assert.deepEqual(calls.generated[0].context.familyInput.family.planningProfile, {
    annualIncome: 240000, annualExpense: 0, debt: 0, educationGoal: 0,
    parentSupportGoal: 0, availableAssets: 0, premiumBudget: 36000,
  });
  assert.equal(Object.hasOwn(calls.generated[0].context.familyInput.dataQuality, 'pendingFields'), false);
  assert.deepEqual(calls.generated[0].history, [{ role: 'user', content: '给我销售建议' }]);
  assert.equal(calls.generated[0].question, '那我该怎么跟他聊');
  assert.deepEqual(calls.audits.map((row) => row.authorizedResourceIds), [['family:71'], ['family:71'], ['family:71']]);
  const publicPayloads = JSON.stringify([summary.payload, report.payload, sales.payload, calls.audits]);
  assert.doesNotMatch(publicPayloads, /余贵祥|13800138000|110101199001011234|SECRET-0001/);
});

test('createPolicyOcrApp composes semantic resolution before the legacy policy router', async (t) => {
  const saved = [];
  const semanticAudits = [];
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE policies (id INTEGER PRIMARY KEY);
    CREATE TABLE product_customer_responsibility_summaries (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, status TEXT, headline TEXT,
      summary_json TEXT, source_urls_json TEXT, updated_at TEXT
    )
  `);
  const product = {
    canonicalProductId: 'product-1',
    company: '新华人寿保险股份有限公司',
    officialName: '康健无忧两全保险',
  };
  db.prepare(`
    INSERT INTO product_customer_responsibility_summaries
      (id, company, product_name, status, headline, summary_json, source_urls_json, updated_at)
    VALUES (?, ?, ?, 'ready', ?, ?, ?, ?)
  `).run(
    'summary-1', product.company, product.officialName, '兼顾身故与满期责任',
    JSON.stringify({
      headline: '兼顾身故与满期责任',
      mainResponsibilities: [{ title: '身故保险金', plainText: '符合约定时按条款给付。' }],
    }),
    JSON.stringify(['https://newchinalife.com/terms']),
    '2026-07-14T00:00:00.000Z',
  );
  const app = createPolicyOcrApp({
    db,
    recomputeCashflowOnStartup: false,
    agentStore: {
      async load() { return { familyProfiles: [], policies: [] }; },
      async getPublishedAgentQuestionPolicyVersion() { return null; },
      async recordAgentRouteAudit() {},
      async recordAgentSemanticAudit(input) { semanticAudits.push(input); return input; },
    },
    agentSemanticResolver: {
      async resolve() {
        return {
          decision: 'execute',
          proposal: {
            semanticContractVersion: 1,
            intent: 'insurance_product_knowledge', operation: 'read',
            queryAspects: ['main_responsibilities'],
            mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
            references: [], requestedSteps: ['lookup'],
            confidence: { intent: 1, mentions: 1, references: 1 },
          },
          resolvedEntities: { product },
          candidate: {
            intent: 'insurance_product_knowledge',
            question: '新华人寿康健无忧两全保险主要保什么', confidence: 1,
            requestedOperation: 'read', entities: {
              productName: product.officialName,
              productCompany: product.company,
              productCanonicalId: product.canonicalProductId,
            },
          },
          nextTaskState: { activeIntent: 'insurance_product_knowledge' },
        };
      },
    },
    agentSemanticConversationService: {
      async load() { return { version: 0, taskState: {} }; },
      async save(input) { saved.push(input); return { persisted: true, version: 1, taskState: input.taskState }; },
    },
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const server = { baseUrl: `http://127.0.0.1:${listener.address().port}` };

  const result = await post(server, '/api/agent/questions/route', semanticBody());

  assert.equal(result.response.status, 200);
  assert.match(result.payload.interaction.text, /兼顾身故与满期责任/u);
  assert.match(result.payload.interaction.text, /身故保险金/u);
  assert.doesNotMatch(result.payload.interaction.text, /当前没有可核验来源/u);
  assert.equal(saved.length, 1);
  assert.equal(semanticAudits.length, 1);
  assert.equal(semanticAudits[0].decision, 'execute');
  assert.doesNotMatch(
    JSON.stringify(semanticAudits),
    /新华人寿康健无忧两全保险主要保什么|康健无忧两全保险|product-1/u,
  );
});

test('default semantic composition preserves the canonical product across a follow-up reference', async (t) => {
  const company = '新华人寿保险股份有限公司';
  const officialName = '康健无忧两全保险';
  const formalProductName = `${company}${officialName}`;
  const canonicalProductId = 'product-nci-kangjian-wuyou';
  const conversationId = 'conv-semantic-follow-up';
  const conversations = new Map();
  const semanticAudits = [];
  const saveAttempts = [];
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE policies (id INTEGER PRIMARY KEY);
    CREATE TABLE insurance_products (
      canonical_product_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      company TEXT NOT NULL, official_name TEXT NOT NULL, product_code TEXT,
      product_type TEXT, product_group_key TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE product_customer_responsibility_summaries (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, status TEXT, headline TEXT,
      summary_json TEXT, source_urls_json TEXT, updated_at TEXT
    );
  `);
  db.prepare(`INSERT INTO insurance_products
    (canonical_product_id, tenant_id, company, official_name, status, created_at, updated_at, payload)
    VALUES (?, 'default', ?, ?, 'active', '2026-07-14', '2026-07-14', '{}')`)
    .run(canonicalProductId, company, officialName);
  db.prepare(`INSERT INTO insurance_products
    (canonical_product_id, tenant_id, company, official_name, status, created_at, updated_at, payload)
    VALUES ('other-tenant-product', 'other', ?, ?, 'active', '2026-07-14', '2026-07-14', '{}')`)
    .run(company, officialName);
  db.prepare(`INSERT INTO product_customer_responsibility_summaries
    (id, company, product_name, status, headline, summary_json, source_urls_json, updated_at)
    VALUES ('summary-nci-kangjian', ?, ?, 'ready', ?, ?, ?, '2026-07-14')`)
    .run(
      company,
      officialName,
      '兼顾身故与满期责任',
      JSON.stringify({
        headline: '兼顾身故与满期责任',
        mainResponsibilities: [{ title: '身故保险金', plainText: '符合约定时按条款给付。' }],
      }),
      JSON.stringify(['https://newchinalife.com/terms/kangjian-wuyou']),
    );

  const state = {
    familyProfiles: [],
    policies: [],
    officialDomainProfiles: [{
      company,
      companyAliases: [company],
      officialDomains: ['newchinalife.com'],
      siteDomains: ['newchinalife.com'],
    }],
  };
  const agentStore = {
    async load() { return state; },
    async getPublishedAgentQuestionPolicyVersion() { return null; },
    async recordAgentRouteAudit() {},
    async recordAgentSemanticAudit(input) {
      semanticAudits.push(structuredClone(input));
      return input;
    },
    async getAgentSemanticConversation({ userId, channel, conversationId: id }) {
      const row = conversations.get(`${userId}:${channel}:${id}`);
      return row ? structuredClone(row) : null;
    },
    async saveAgentSemanticConversation({
      userId, channel, conversationId: id, expectedVersion, updatedAt, taskState,
    }) {
      const key = `${userId}:${channel}:${id}`;
      const current = conversations.get(key);
      saveAttempts.push({ expectedVersion, previousVersion: current?.version || 0 });
      if ((current?.version || 0) !== expectedVersion) {
        const error = new Error('Agent semantic conversation version conflict');
        error.code = 'AGENT_SEMANTIC_CONVERSATION_CONFLICT';
        throw error;
      }
      const saved = {
        userId, channel, conversationId: id, version: expectedVersion + 1,
        updatedAt, taskState: structuredClone(taskState),
      };
      conversations.set(key, saved);
      return structuredClone(saved);
    },
  };
  const app = createPolicyOcrApp({
    state,
    db,
    agentStore,
    recomputeCashflowOnStartup: false,
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(async () => {
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    db.close();
  });
  const server = { baseUrl: `http://127.0.0.1:${listener.address().port}` };

  const firstQuestion = `${formalProductName} 这个保险主要保啥的`;
  const firstProposal = {
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [
      { type: 'insurer', rawText: company },
      { type: 'product', rawText: formalProductName },
    ],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 1, mentions: 1, references: 1 },
  };
  assert.equal(JSON.stringify(firstProposal).includes(canonicalProductId), false);
  const first = await post(server, '/api/agent/questions/route', semanticBody({
    messageRef: 'msg-semantic-follow-up-1',
    conversationId,
    question: firstQuestion,
    proposal: firstProposal,
  }));

  assert.equal(first.response.status, 200);
  assert.equal(first.payload.decision, 'execute');
  assert.equal(first.payload.interaction.type, 'answer');
  assert.match(first.payload.interaction.text, /兼顾身故与满期责任/u);
  assert.match(first.payload.interaction.text, /身故保险金/u);
  assert.doesNotMatch(first.payload.interaction.text, /暂时无法确认|当前没有可核验来源/u);
  const afterFirst = conversations.get(`7:dingtalk:${conversationId}`);
  assert.equal(afterFirst.version, 1);
  assert.equal(afterFirst.taskState.activeEntities.product.canonicalProductId, canonicalProductId);
  assert.equal(
    `${afterFirst.taskState.activeEntities.product.company}${afterFirst.taskState.activeEntities.product.officialName}`,
    formalProductName,
  );

  const secondQuestion = '主要保啥的呀 这个保险';
  const second = await post(server, '/api/agent/questions/route', semanticBody({
    messageRef: 'msg-semantic-follow-up-2',
    conversationId,
    question: secondQuestion,
    proposal: {
      semanticContractVersion: 1,
      intent: 'insurance_product_knowledge',
      operation: 'read',
      queryAspects: ['main_responsibilities'],
      mentions: [],
      references: [{ type: 'current_product', rawText: '这个保险' }],
      requestedSteps: ['lookup'],
      confidence: { intent: 1, mentions: 1, references: 1 },
    },
  }));

  assert.equal(second.response.status, 200);
  assert.equal(second.payload.decision, 'execute');
  assert.equal(second.payload.interaction.type, 'answer');
  assert.match(second.payload.interaction.text, /兼顾身故与满期责任/u);
  assert.match(second.payload.interaction.text, /身故保险金/u);
  assert.doesNotMatch(second.payload.interaction.text, /暂时无法确认|当前没有可核验来源/u);
  const afterSecond = conversations.get(`7:dingtalk:${conversationId}`);
  assert.equal(afterSecond.version, 2);
  assert.equal(afterSecond.taskState.activeEntities.product.canonicalProductId, canonicalProductId);
  assert.equal(afterSecond.taskState.activeEntities.product.officialName, officialName);
  assert.notEqual(afterSecond.taskState.activeEntities.product.officialName, secondQuestion);
  assert.deepEqual(saveAttempts, [
    { expectedVersion: 0, previousVersion: 0 },
    { expectedVersion: 1, previousVersion: 1 },
  ]);

  assert.equal(semanticAudits.length, 2);
  assert.deepEqual(semanticAudits.map((audit) => audit.decision), ['execute', 'execute']);
  assert.doesNotMatch(JSON.stringify(semanticAudits), new RegExp([
    firstQuestion, secondQuestion, company, officialName, formalProductName, canonicalProductId,
  ].join('|'), 'u'));
});

test('agent semantic mode defaults to enforced, honors option precedence, and rejects invalid values', () => {
  assert.equal(resolveAgentSemanticMode({}, {}), 'enforced');
  assert.equal(resolveAgentSemanticMode({}, { POLICY_AGENT_SEMANTIC_MODE: 'enforced' }), 'enforced');
  assert.equal(resolveAgentSemanticMode({}, { POLICY_AGENT_SEMANTIC_MODE: 'off' }), 'off');
  assert.equal(resolveAgentSemanticMode({}, { POLICY_AGENT_SEMANTIC_MODE: ' off ' }), 'off');
  assert.equal(
    resolveAgentSemanticMode({ agentSemanticMode: 'enforced' }, { POLICY_AGENT_SEMANTIC_MODE: 'off' }),
    'enforced',
  );
  assert.equal(
    resolveAgentSemanticMode({ agentSemanticMode: ' off ' }, { POLICY_AGENT_SEMANTIC_MODE: 'enforced' }),
    'off',
  );
  for (const invalid of ['', '   ']) {
    assert.throws(
      () => resolveAgentSemanticMode({ agentSemanticMode: invalid }, { POLICY_AGENT_SEMANTIC_MODE: 'off' }),
      /must be "enforced" or "off"/u,
    );
  }
  const sentinel = 'db-password=SECRET';
  assert.throws(
    () => resolveAgentSemanticMode({}, { POLICY_AGENT_SEMANTIC_MODE: sentinel }),
    (error) => /must be "enforced" or "off"/u.test(error.message) && !error.message.includes(sentinel),
  );
  assert.throws(
    () => resolveAgentSemanticMode({}, { POLICY_AGENT_SEMANTIC_MODE: 'invalid' }),
    /must be "enforced" or "off"/u,
  );
  assert.throws(
    () => createPolicyOcrApp({ agentSemanticMode: 'invalid' }),
    /must be "enforced" or "off"/u,
  );
});

test('agent semantic off skips semantic dependency composition', () => {
  const agentStore = {
    async load() { return { familyProfiles: [], policies: [] }; },
    get getAgentSemanticConversation() { throw new Error('semantic conversation composition must not run'); },
    get saveAgentSemanticConversation() { throw new Error('semantic conversation composition must not run'); },
    get recordAgentSemanticAudit() { throw new Error('semantic audit composition must not run'); },
  };
  assert.doesNotThrow(() => createPolicyOcrApp({
    agentSemanticMode: 'off', agentStore, recomputeCashflowOnStartup: false,
    agentLegacyQuestionRouter: { async route() {} },
  }));
});

test('agent semantic off returns a safe clarification without semantic side effects and preserves legacy routing', async (t) => {
  const calls = { legacy: [], resolve: 0, load: 0, save: 0, audit: 0 };
  const app = createPolicyOcrApp({
    agentSemanticMode: 'off',
    recomputeCashflowOnStartup: false,
    agentLegacyQuestionRouter: {
      async route(input) {
        calls.legacy.push(input);
        return { decision: 'execute', interaction: { type: 'answer', text: 'legacy-ok' } };
      },
    },
    agentSemanticResolver: {
      async resolve() { calls.resolve += 1; throw new Error('must not run'); },
    },
    agentSemanticConversationService: {
      async load() { calls.load += 1; throw new Error('must not run'); },
      async save() { calls.save += 1; throw new Error('must not run'); },
    },
    agentSemanticAuditService: {
      async record() { calls.audit += 1; throw new Error('must not run'); },
    },
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const server = { baseUrl: `http://127.0.0.1:${listener.address().port}` };

  const semantic = await post(server, '/api/agent/questions/route', semanticBody());
  assert.equal(semantic.response.status, 200);
  assert.equal(semantic.payload.decision, 'clarify');
  assert.equal(semantic.payload.interaction.type, 'clarification');
  assert.match(semantic.payload.interaction.text, /语义解析暂不可用/u);
  assert.deepEqual(calls, { legacy: [], resolve: 0, load: 0, save: 0, audit: 0 });

  const legacy = await post(server, '/api/agent/questions/route', validBody());
  assert.equal(legacy.response.status, 200);
  assert.equal(legacy.payload.interaction.text, 'legacy-ok');
  assert.equal(calls.legacy.length, 1);
  assert.equal(calls.resolve, 0);
  assert.equal(calls.load, 0);
  assert.equal(calls.save, 0);
  assert.equal(calls.audit, 0);
});

test('agent semantic off preserves an explicitly injected question router for candidate and semantic requests', async (t) => {
  const calls = [];
  const app = createPolicyOcrApp({
    agentSemanticMode: 'off',
    recomputeCashflowOnStartup: false,
    agentQuestionRouter: {
      async route(input) {
        calls.push(input);
        return { decision: 'execute', interaction: { type: 'answer', text: 'injected-ok' } };
      },
    },
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const server = { baseUrl: `http://127.0.0.1:${listener.address().port}` };

  const candidate = await post(server, '/api/agent/questions/route', validBody());
  const semantic = await post(server, '/api/agent/questions/route', semanticBody());

  assert.equal(candidate.payload.interaction.text, 'injected-ok');
  assert.equal(semantic.payload.interaction.text, 'injected-ok');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].candidate);
  assert.equal(calls[1].question, semanticBody().question);
  assert.ok(calls[1].proposal);
});

test('createPolicyOcrApp wires the real semantic mode environment without leaking it', { concurrency: false }, async (t) => {
  const previous = process.env.POLICY_AGENT_SEMANTIC_MODE;
  t.after(() => {
    if (previous === undefined) delete process.env.POLICY_AGENT_SEMANTIC_MODE;
    else process.env.POLICY_AGENT_SEMANTIC_MODE = previous;
  });

  process.env.POLICY_AGENT_SEMANTIC_MODE = 'off';
  let legacyCalls = 0;
  const app = createPolicyOcrApp({
    recomputeCashflowOnStartup: false,
    agentLegacyQuestionRouter: {
      async route() {
        legacyCalls += 1;
        return { decision: 'execute', interaction: { type: 'answer', text: 'legacy-ok' } };
      },
    },
    agentSemanticResolver: { async resolve() { throw new Error('must not run'); } },
    agentSemanticConversationService: {
      async load() { throw new Error('must not run'); },
      async save() { throw new Error('must not run'); },
    },
    agentSemanticAuditService: { async record() { throw new Error('must not run'); } },
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const semantic = await post(
    { baseUrl: `http://127.0.0.1:${listener.address().port}` },
    '/api/agent/questions/route',
    semanticBody(),
  );
  assert.equal(semantic.response.status, 200);
  assert.equal(semantic.payload.decision, 'clarify');
  assert.equal(legacyCalls, 0);

  process.env.POLICY_AGENT_SEMANTIC_MODE = 'invalid';
  assert.throws(
    () => createPolicyOcrApp({ recomputeCashflowOnStartup: false }),
    /must be "enforced" or "off"/u,
  );
  assert.doesNotThrow(() => createPolicyOcrApp({
    agentSemanticMode: 'enforced',
    recomputeCashflowOnStartup: false,
  }));
});

test('Hermes semantic chat writes are denied instead of executing a read handler', async (t) => {
  let handlerCalls = 0;
  const app = createPolicyOcrApp({
    recomputeCashflowOnStartup: false,
    agentStore: {
      async load() { return { familyProfiles: [], policies: [] }; },
      async getPublishedAgentQuestionPolicyVersion() { return null; },
      async recordAgentRouteAudit() {},
      async recordAgentSemanticAudit(input) { return input; },
      async appendAgentUnknownQuestion() {},
    },
    agentQuestionHandlers: {
      async sales_champion() { handlerCalls += 1; return { interaction: { type: 'answer', text: 'unsafe' } }; },
    },
    agentSemanticResolver: {
      async resolve() {
        return {
          decision: 'execute', resolvedEntities: {},
          proposal: {
            semanticContractVersion: 1,
            intent: 'chat', operation: 'write', queryAspects: [],
            mentions: [], references: [], requestedSteps: ['continue'],
            confidence: { intent: 1, mentions: 1, references: 1 },
          },
          candidate: {
            intent: 'chat', question: '替我修改资料', confidence: 1, requestedOperation: 'write',
          },
          nextTaskState: { activeIntent: 'chat' },
        };
      },
    },
    agentSemanticConversationService: {
      async load() { return { version: 0, taskState: {} }; },
      async save(input) { return { persisted: true, version: 1, taskState: input.taskState }; },
    },
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));

  const result = await post(
    { baseUrl: `http://127.0.0.1:${listener.address().port}` },
    '/api/agent/questions/route',
    semanticBody({
      question: '替我修改资料',
      proposal: {
        semanticContractVersion: 1, intent: 'chat', operation: 'write', queryAspects: [],
        mentions: [], references: [], requestedSteps: ['continue'],
        confidence: { intent: 1, mentions: 1, references: 1 },
      },
    }),
  );

  assert.equal(result.response.status, 200);
  assert.equal(result.payload.decision, 'deny');
  assert.equal(handlerCalls, 0);
});

test('default semantic product resolver reloads custom official company aliases', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE policies (id INTEGER PRIMARY KEY);
    CREATE TABLE insurance_products (
      canonical_product_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      company TEXT NOT NULL, official_name TEXT NOT NULL, product_code TEXT,
      product_type TEXT, product_group_key TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE product_customer_responsibility_summaries (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, status TEXT, headline TEXT,
      summary_json TEXT, source_urls_json TEXT, updated_at TEXT
    );
  `);
  db.prepare(`INSERT INTO insurance_products
    (canonical_product_id, tenant_id, company, official_name, status, created_at, updated_at, payload)
    VALUES ('custom-product', 'default', '测试保险有限公司', '安心产品', 'active',
      '2026-07-14', '2026-07-14', '{}')`).run();
  db.prepare(`INSERT INTO product_customer_responsibility_summaries
    (id, company, product_name, status, headline, summary_json, source_urls_json, updated_at)
    VALUES ('summary-custom', '测试保险有限公司', '安心产品', 'ready', '自定义责任摘要', ?, ?, '2026-07-14')`)
    .run(
      JSON.stringify({ headline: '自定义责任摘要', mainResponsibilities: [{ title: '约定责任', plainText: '以正式资料为准。' }] }),
      JSON.stringify(['https://old.insurance.example/terms']),
    );
  const state = {
    familyProfiles: [], policies: [],
    officialDomainProfiles: [{
      id: 'custom_insurer', company: '测试保险有限公司',
      aliases: ['自定义保司'], companyAliases: ['测试保险有限公司', '自定义保司'],
      officialDomains: ['old.insurance.example'], siteDomains: ['old.insurance.example'],
    }],
  };
  const store = {
    async load() { return state; },
    async getPublishedAgentQuestionPolicyVersion() { return null; },
    async recordAgentRouteAudit() {},
    async recordAgentSemanticAudit(input) { return input; },
  };
  const app = createPolicyOcrApp({
    state, db, agentStore: store, recomputeCashflowOnStartup: false,
    agentSemanticConversationService: {
      async load() { return { version: 0, taskState: {} }; },
      async save(input) { return { persisted: true, version: 1, taskState: input.taskState }; },
    },
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));
  const question = '自定义保司安心产品主要保什么';
  const request = () => post(
    { baseUrl: `http://127.0.0.1:${listener.address().port}` },
    '/api/agent/questions/route',
    semanticBody({
      question,
      proposal: {
        semanticContractVersion: 1, intent: 'insurance_product_knowledge', operation: 'read',
        queryAspects: ['main_responsibilities'],
        mentions: [
          { type: 'insurer', rawText: '自定义保司' },
          { type: 'product', rawText: '安心产品' },
        ],
        references: [], requestedSteps: ['lookup'],
        confidence: { intent: 1, mentions: 1, references: 1 },
      },
    }),
  );

  const first = await request();
  assert.equal(first.response.status, 200);
  assert.match(first.payload.interaction.text, /自定义责任摘要/u);
  assert.doesNotMatch(first.payload.interaction.text, /当前没有可核验来源/u);

  state.officialDomainProfiles = [{
    ...state.officialDomainProfiles[0],
    officialDomains: ['new.insurance.example'], siteDomains: ['new.insurance.example'],
  }];
  db.prepare(`UPDATE product_customer_responsibility_summaries
    SET source_urls_json = ? WHERE id = 'summary-custom'`)
    .run(JSON.stringify(['https://new.insurance.example/terms']));
  const updated = await request();
  assert.doesNotMatch(updated.payload.interaction.text, /当前没有可核验来源/u);

  db.prepare(`UPDATE product_customer_responsibility_summaries
    SET source_urls_json = ? WHERE id = 'summary-custom'`)
    .run(JSON.stringify(['https://old.insurance.example/terms']));
  const retired = await request();
  assert.match(retired.payload.interaction.text, /当前没有可核验来源/u);
});

test('default semantic resolver scans the full question when Hermes omits a second product mention', async (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE policies (id INTEGER PRIMARY KEY);
    CREATE TABLE insurance_products (
      canonical_product_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
      company TEXT NOT NULL, official_name TEXT NOT NULL, product_code TEXT,
      product_type TEXT, product_group_key TEXT, status TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE TABLE product_customer_responsibility_summaries (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, status TEXT, headline TEXT,
      summary_json TEXT, source_urls_json TEXT, updated_at TEXT
    );
  `);
  const insertProduct = db.prepare(`INSERT INTO insurance_products
    (canonical_product_id, tenant_id, company, official_name, status, created_at, updated_at, payload)
    VALUES (?, 'default', ?, ?, 'active', '2026-07-14', '2026-07-14', '{}')`);
  insertProduct.run('product-a', '甲保险', '甲保障计划');
  insertProduct.run('product-b', '乙保险', '乙保障计划');
  const state = {
    familyProfiles: [], policies: [],
    officialDomainProfiles: [
      { company: '甲保险', aliases: ['共同保司'] },
      { company: '乙保险', aliases: ['共同保司'] },
    ],
  };
  const store = {
    async load() { return state; },
    async getPublishedAgentQuestionPolicyVersion() { return null; },
    async recordAgentRouteAudit() {},
    async recordAgentSemanticAudit(input) { return input; },
  };
  let handlerCalls = 0;
  const app = createPolicyOcrApp({
    state, db, agentStore: store, recomputeCashflowOnStartup: false,
    agentQuestionHandlers: {
      async insurance_expert() {
        handlerCalls += 1;
        return { interaction: { type: 'answer', text: 'must not execute' } };
      },
    },
    agentSemanticConversationService: {
      async load() { return { version: 0, taskState: {} }; },
      async save(input) { return { persisted: true, version: 1, taskState: input.taskState }; },
    },
    verifyAgentServiceRequest: async () => true,
    resolveDingTalkIdentity: async () => ({ internalUserId: 7 }),
  });
  const listener = await new Promise((resolve) => {
    const running = app.listen(0, '127.0.0.1', () => resolve(running));
  });
  t.after(() => new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve())));

  const result = await post(
    { baseUrl: `http://127.0.0.1:${listener.address().port}` },
    '/api/agent/questions/route',
    semanticBody({
      question: '甲保险甲保障计划和乙保险乙保障计划主要保什么',
      proposal: {
        semanticContractVersion: 1, intent: 'insurance_product_knowledge', operation: 'read',
        queryAspects: ['main_responsibilities'],
        mentions: [
          { type: 'insurer', rawText: '甲保险' },
          { type: 'product', rawText: '甲保障计划' },
        ],
        references: [], requestedSteps: ['lookup'],
        confidence: { intent: 1, mentions: 1, references: 1 },
      },
    }),
  );

  assert.equal(result.response.status, 200);
  assert.equal(result.payload.decision, 'clarify');
  assert.match(result.payload.interaction.text, /产品比较暂不支持直接执行/u);
  assert.equal(handlerCalls, 0);

  for (const [messageRef, secondInsurer] of [
    ['msg-invalid-unknown', '未知保险'],
    ['msg-invalid-ambiguous', '共同保司'],
  ]) {
    const invalid = await post(
      { baseUrl: `http://127.0.0.1:${listener.address().port}` },
      '/api/agent/questions/route',
      semanticBody({
        messageRef,
        conversationId: `conv-${messageRef}`,
        question: `甲保险甲保障计划和${secondInsurer}主要保什么`,
        proposal: {
          semanticContractVersion: 1, intent: 'insurance_product_knowledge', operation: 'read',
          queryAspects: ['main_responsibilities'],
          mentions: [
            { type: 'insurer', rawText: '甲保险' },
            { type: 'insurer', rawText: secondInsurer },
            { type: 'product', rawText: '甲保障计划' },
          ],
          references: [], requestedSteps: ['lookup'],
          confidence: { intent: 1, mentions: 1, references: 1 },
        },
      }),
    );
    assert.equal(invalid.response.status, 200, secondInsurer);
    assert.equal(invalid.payload.decision, 'clarify', secondInsurer);
    assert.match(invalid.payload.interaction.text, /产品比较暂不支持直接执行/u);
    assert.equal(handlerCalls, 0, secondInsurer);
  }
});

test('authorized family count resolves once and preserves exact safe facts without PII', async () => {
  const state = {
    familyProfiles: [
      { id: 71, ownerUserId: 7, familyName: '余贵祥家庭', status: 'active' },
      { id: 72, ownerUserId: 8, familyName: '余贵祥家庭', status: 'active' },
    ],
    familyMembers: [{ id: 711, familyId: 71, name: '余贵祥', mobile: '13800138000', status: 'active' }],
    policies: [
      { id: 1, userId: 7, familyId: 71, policyNo: 'SECRET-0001', status: 'active' },
      { id: 2, userId: 7, familyId: 71, policyNo: 'SECRET-0002', status: '失效' },
      { id: 3, userId: 8, familyId: 72, policyNo: 'OTHER-0003', status: 'active' },
    ],
  };
  let familyLoads = 0;
  let handled;
  const domain = createAgentQuestionHandlers({
    store: { async load() { return state; } },
    authorizedFamilyDataLoader: async ({ familyId, internalUserId }) => {
      familyLoads += 1;
      const family = state.familyProfiles.find((row) => row.id === familyId && row.ownerUserId === internalUserId);
      return family ? { family, state } : null;
    },
    clock: () => new Date('2026-07-13T00:00:00.000Z'),
  });
  const router = createAgentQuestionRouter({
    store: {
      async load() { return state; },
      async getPublishedAgentQuestionPolicyVersion() { return null; },
      async recordAgentRouteAudit() {},
    },
    handlers: {
      async insurance_expert(input) {
        handled = await domain.insurance_expert(input);
        return { interaction: { type: 'answer', text: `共有 ${handled.facts.policyCount} 份保单` } };
      },
    },
  });

  const result = await router.route({
    internalUserId: 7,
    messageRef: 'msg-count',
    candidate: {
      intent: 'family_summary', requestedOperation: 'read', confidence: 1,
      question: '余贵祥家庭有几个保单', entities: { familyName: '余贵祥家庭' },
    },
  });

  assert.equal(result.decision, 'execute');
  assert.equal(result.interaction.text, '共有 2 份保单');
  assert.deepEqual(handled.facts, { familyId: 71, activeMemberCount: 1, policyCount: 2, validPolicyCount: 1 });
  assert.equal(familyLoads, 1);
  assert.doesNotMatch(JSON.stringify({ result, handled }), /13800138000|SECRET-0001|余贵祥/);
});

test('report freshness and sales follow-up use the existing domain handlers with explicit family context', async () => {
  const state = {
    familyProfiles: [{ id: 71, ownerUserId: 7, familyName: '余贵祥家庭', status: 'active', updatedAt: '2026-07-10T00:00:00.000Z' }],
    familyMembers: [],
    policies: [],
    familyReports: [{
      id: 90, familyId: 71, status: 'active', generatedAt: '2026-07-11T00:00:00.000Z',
      report: { familyPolicyAnalysisReport: { status: 'complete', generatedAt: '2026-07-11T00:00:00.000Z' } },
      summary: { policyCount: 0, mobile: 13800138000 },
    }],
    familySalesReviews: [],
  };
  const calls = { queued: [], chat: [] };
  const authorized = async ({ familyId, internalUserId }) => {
    const family = state.familyProfiles.find((row) => row.id === familyId && row.ownerUserId === internalUserId);
    return family ? { family, state } : null;
  };
  const handlers = createAgentQuestionHandlers({
    store: { async load() { return state; } },
    authorizedFamilyDataLoader: authorized,
    authorizedFamilySalesDataLoader: async ({ familyId, internalUserId }) => ({
      family: (await authorized({ familyId, internalUserId })).family,
      input: { dataQuality: { pendingFields: ['budget'] } }, members: [], policies: [],
      familyReports: state.familyReports, familySalesReviews: [],
      history: [{ role: 'assistant', content: '上一轮已确认保障缺口' }],
    }),
    links: { familyReport: ({ familyId }) => `/customer/families/${familyId}/report` },
    reportQueue: { async enqueue(input) { calls.queued.push(input); return { jobId: 'job-71', progress: 0 }; } },
    buildFamilySalesChatContext: (input) => ({ familyId: input.family.id, pendingFields: input.input.dataQuality.pendingFields }),
    generateFamilySalesChatReply: async (input) => { calls.chat.push(input); return { content: '先确认预算，再讨论保障优先级。', model: 'stub-model' }; },
    clock: () => new Date('2026-07-13T00:00:00.000Z'),
  });

  const fresh = await handlers.insurance_expert({ intent: 'coverage_report', familyId: 71, internalUserId: 7 });
  assert.equal(fresh.facts.status, 'fresh');
  assert.equal(fresh.presentation.secureLink, '/customer/families/71/report');
  assert.deepEqual(fresh.facts.summary, { policyCount: 0 });
  assert.equal(calls.queued.length, 0);

  state.familyProfiles[0].updatedAt = '2026-07-12T00:00:00.000Z';
  const stale = await handlers.insurance_expert({ intent: 'coverage_report', familyId: 71, internalUserId: 7 });
  assert.equal(stale.facts.status, 'processing');
  assert.equal(stale.facts.jobId, 'job-71');
  assert.equal(calls.queued.length, 1);

  const coached = await handlers.sales_champion({
    intent: 'sales_coaching', familyId: 71, internalUserId: 7, question: '那我该怎么跟他聊',
  });
  assert.equal(coached.provenance.agent, 'existing_family_sales_chat');
  assert.deepEqual(calls.chat[0], {
    context: { familyId: 71, pendingFields: ['budget'] },
    history: [{ role: 'assistant', content: '上一轮已确认保障缺口' }],
    question: '那我该怎么跟他聊',
  });
  assert.doesNotMatch(JSON.stringify({ fresh, stale, coached }), /13800138000/);
});

test('unknown read falls back safely and unknown write denies before any handler', async () => {
  let handlerCalls = 0;
  const unknowns = [];
  const router = createAgentQuestionRouter({
    store: {
      async load() { return { familyProfiles: [], policies: [] }; },
      async getPublishedAgentQuestionPolicyVersion() { return null; },
      async appendAgentUnknownQuestion(input) { unknowns.push(input); },
      async recordAgentRouteAudit() {},
    },
    handlers: { system: async () => { handlerCalls += 1; return { interaction: { type: 'answer', text: 'unsafe' } }; } },
  });
  const read = await router.route({ internalUserId: 7, messageRef: 'unknown-read', candidate: {
    intent: 'not_configured', requestedOperation: 'read', confidence: 1, question: '一个未知的公开问题',
  } });
  const write = await router.route({ internalUserId: 7, messageRef: 'unknown-write', candidate: {
    intent: 'not_configured', requestedOperation: 'write', confidence: 1, question: '替我修改未知字段 mobile=13800138000',
  } });
  assert.equal(read.decision, 'open_web');
  assert.equal(read.interaction.type, 'secure_link');
  assert.equal(write.decision, 'deny');
  assert.equal(write.interaction.type, 'denied');
  assert.equal(handlerCalls, 0);
  assert.equal(unknowns.length, 1);
  assert.doesNotMatch(JSON.stringify({ read, write }), /13800138000|mobile/);
});
