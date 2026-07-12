import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createPolicyOcrApp } from '../server/app.mjs';
import { createAdvisorMemoryConfirmationService } from '../server/advisor-memory-confirmation.service.mjs';
import { createFamilySalesMemoryApi } from '../server/family-sales-memory-api.service.mjs';
import { createWukongMcpGateway } from '../server/wukong-mcp-gateway.service.mjs';

const KEY = 'advisor-memory-confirmation-test-key-123456789';
const BASE = { ownerUserId: 7, corpId: 'corp', dingUserId: 'ding', familyId: 11, memoryId: 31, expectedVersion: 1, action: 'confirm', reasonCode: 'advisor_confirmation', replacementHash: crypto.createHash('sha256').update('null').digest('hex'), interactionId: 'card-1' };

test('confirmation service signs bounded exact claims and rejects tamper, mismatch, expiry, and weak keys', () => {
  let now = 1_000_000;
  const service = createAdvisorMemoryConfirmationService({ key: KEY, now: () => now });
  const issued = service.issue(BASE);
  assert.equal(service.verify({ token: issued.token, ...BASE }).valid, true);
  assert.throws(() => service.verify({ token: `${issued.token}x`, ...BASE }), { code: 'ADVISOR_CONFIRMATION_INVALID' });
  assert.throws(() => service.verify({ token: issued.token, ...BASE, familyId: 12 }), { code: 'ADVISOR_CONFIRMATION_INVALID' });
  assert.throws(() => service.verify({ token: issued.token, ...BASE, expectedVersion: 2 }), { code: 'ADVISOR_CONFIRMATION_INVALID' });
  now += 5 * 60 * 1000 + 1;
  assert.throws(() => service.verify({ token: issued.token, ...BASE }), { code: 'ADVISOR_CONFIRMATION_INVALID' });
  assert.throws(() => createAdvisorMemoryConfirmationService({ key: 'weak' }), { code: 'MEMORY_CONFIRMATION_NOT_CONFIGURED' });
});

function listen(app) { return new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((done) => server.close(done)) })); }); }

test('service-authenticated card callback issues a non-MCP confirmation for exact active scope', async () => {
  const service = createAdvisorMemoryConfirmationService({ key: KEY });
  const state = { users: [{ id: 7, name: '顾问', status: 'active' }], userDingtalkIdentities: [{ corpId: 'corp', dingUserId: 'ding', userId: 7, status: 'active' }], familyProfiles: [{ id: 11, ownerUserId: 7, status: 'active' }], familySalesMemories: [{ id: 31, familyId: 11, ownerUserId: 7, kind: 'objection', status: 'candidate', version: 1, content: '异议' }] };
  const app = createPolicyOcrApp({ state, recomputeCashflowOnStartup: false, authenticateDingtalkServiceRequest: (req) => req.get('authorization') === 'Bearer service', advisorMemoryConfirmationService: service, verifyAdvisorMemoryConfirmation: service.verify });
  const server = await listen(app);
  const body = { corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', eventType: 'card_action', interactionId: 'card-1', familyId: 11, memoryId: 31, expectedVersion: 1, action: 'confirm', reasonCode: 'advisor_confirmation' };
  try {
    const response = await fetch(`${server.baseUrl}/api/wukong/memory-action-confirmations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer service' }, body: JSON.stringify(body) });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(service.verify({ token: payload.confirmationToken, ...BASE }).valid, true);
    const foreign = await fetch(`${server.baseUrl}/api/wukong/memory-action-confirmations`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer service' }, body: JSON.stringify({ ...body, familyId: 12 }) });
    assert.equal(foreign.status, 404);
    const unauthenticated = await fetch(`${server.baseUrl}/api/wukong/memory-action-confirmations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(unauthenticated.status, 401);
  } finally { await server.close(); }
});

test('server entry wires the production confirmation key, issuer, and verifier', async () => {
  const source = await fs.readFile(new URL('../server/index.mjs', import.meta.url), 'utf8');
  assert.match(source, /WUKONG_MEMORY_CONFIRMATION_KEY/u);
  assert.match(source, /advisorMemoryConfirmationService/u);
  assert.match(source, /verifyAdvisorMemoryConfirmation/u);
});

test('a valid production token applies once and a different request cannot replay it', async () => {
  let now = 1_000_000;
  const service = createAdvisorMemoryConfirmationService({ key: KEY, now: () => now });
  const issued = service.issue(BASE);
  const state = { users: [{ id: 7, name: '顾问', status: 'active' }], userDingtalkIdentities: [{ corpId: 'corp', dingUserId: 'ding', userId: 7, status: 'active' }], familyProfiles: [{ id: 11, ownerUserId: 7, status: 'active' }], familySalesMemories: [{ id: 31, familyId: 11, ownerUserId: 7, kind: 'objection', status: 'candidate', version: 1, content: '异议' }] };
  const consumed = new Set();
  const completed = new Map();
  let writes = 0;
  const api = createFamilySalesMemoryApi({ state, cursorKey: 'cursor-key-for-confirmation-integration-123', verifyAdvisorConfirmation: service.verify,
    findFamilySalesMemoryActionResult: ({ requestId, reasonCode }) => {
      const stored = completed.get(requestId);
      if (stored && stored.reasonCode !== reasonCode) throw Object.assign(new Error('conflict'), { code: 'REQUEST_ID_CONFLICT' });
      return stored?.bundle || null;
    }, persistFamilySalesMemoryTransition: async ({ confirmationTokenHash, requestId, reasonCode }) => {
    if (consumed.has(confirmationTokenHash)) throw Object.assign(new Error('replayed'), { code: 'CONFIRMATION_TOKEN_REPLAYED' });
    consumed.add(confirmationTokenHash); writes += 1;
    const bundle = { memories: [{ ...state.familySalesMemories[0], status: 'confirmed', version: 2 }] };
    completed.set(requestId, { reasonCode, bundle });
    return bundle;
  } });
  const gateway = createWukongMcpGateway({ state, familySalesMemoryApi: api, rateLimit: 10 });
  const call = (requestId, reasonCode = 'advisor_confirmation') => gateway.invoke({ corpId: 'corp', dingUserId: 'ding', conversationType: 'direct', requestId, tool: 'apply_memory_action', input: {
    familyRef: 11, memoryId: 31, action: 'confirm', expectedVersion: 1, reasonCode, confirmationToken: issued.token, interactionId: 'card-1',
  } });
  const original = await call('request-1');
  assert.equal(original.memories[0].status, 'confirmed');
  now += 5 * 60 * 1000 + 1;
  assert.deepEqual((await call('request-1')).memories, original.memories);
  await assert.rejects(call('request-2'), { code: 'ADVISOR_CONFIRMATION_INVALID' });
  await assert.rejects(call('request-1', 'user_confirmation'), { code: 'REQUEST_ID_CONFLICT' });
  assert.equal(writes, 1);
});
