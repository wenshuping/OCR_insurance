import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  confirmAdvisorBinding,
  createAdvisorBindingChallenge,
  findAdvisorBindingCandidate,
  resolveDingtalkAdvisor,
  revokeAdvisorBinding,
} from '../server/dingtalk-advisor-identity.service.mjs';

const NOW = '2026-07-12T08:00:00.000Z';
const LATER = '2026-07-12T08:01:00.000Z';
const PRINCIPAL = { corpId: 'corp-1', dingUserId: 'ding-1' };

function makeState(users = [{ id: 7, mobile: '13800138000', status: 'active' }]) {
  return { users, userDingtalkIdentities: [], dingtalkBindingChallenges: [] };
}

test('unique active whitelisted mobile match returns only a masked confirmation candidate', () => {
  const result = findAdvisorBindingCandidate(makeState(), {
    mobile: '13800138000',
    allowedUserIds: [7],
  });

  assert.deepEqual(result, {
    status: 'confirmation_required',
    userId: 7,
    maskedMobile: '138****8000',
  });
  assert.equal(JSON.stringify(result).includes('13800138000'), false);
});

test('no mobile match does not select an account', () => {
  assert.deepEqual(findAdvisorBindingCandidate(makeState(), {
    mobile: '13900139000',
    allowedUserIds: [7],
  }), { status: 'not_found' });
});

test('duplicate active mobile matches do not select an account', () => {
  const state = makeState([
    { id: 7, mobile: '13800138000', status: 'active' },
    { id: 8, mobile: '13800138000', status: 'active' },
  ]);

  assert.deepEqual(findAdvisorBindingCandidate(state, {
    mobile: '13800138000',
    allowedUserIds: [7, 8],
  }), { status: 'ambiguous' });
});

test('non-whitelisted mobile match does not select an account', () => {
  assert.deepEqual(findAdvisorBindingCandidate(makeState(), {
    mobile: '13800138000',
    allowedUserIds: [8],
  }), { status: 'not_found' });
});

test('challenge stores a token hash and confirmation activates binding for the same principal', () => {
  const state = makeState();
  const created = createAdvisorBindingChallenge(state, {
    ...PRINCIPAL,
    userId: 7,
    now: NOW,
  });

  assert.equal(typeof created.token, 'string');
  assert.equal(created.expiresAt, '2026-07-12T08:05:00.000Z');
  assert.equal(state.dingtalkBindingChallenges[0].token, undefined);
  assert.equal(state.dingtalkBindingChallenges[0].tokenHash, createHash('sha256').update(created.token).digest('hex'));
  assert.equal(state.userDingtalkIdentities[0].status, 'pending');

  const binding = confirmAdvisorBinding(state, { ...PRINCIPAL, token: created.token, now: LATER });

  assert.equal(binding.status, 'active');
  assert.equal(binding.userId, 7);
  assert.equal(state.dingtalkBindingChallenges[0].usedAt, LATER);
  assert.equal(resolveDingtalkAdvisor(state, PRINCIPAL)?.userId, 7);
});

test('expired challenge cannot be confirmed', () => {
  const state = makeState();
  const created = createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, now: NOW });

  assert.throws(() => confirmAdvisorBinding(state, {
    ...PRINCIPAL,
    token: created.token,
    now: '2026-07-12T08:05:00.000Z',
  }), /expired/i);
});

test('used challenge cannot be confirmed again', () => {
  const state = makeState();
  const created = createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, now: NOW });
  confirmAdvisorBinding(state, { ...PRINCIPAL, token: created.token, now: LATER });

  assert.throws(() => confirmAdvisorBinding(state, {
    ...PRINCIPAL,
    token: created.token,
    now: '2026-07-12T08:02:00.000Z',
  }), /used/i);
});

test('challenge cannot be confirmed by a different DingTalk principal', () => {
  const state = makeState();
  const created = createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, now: NOW });

  assert.throws(() => confirmAdvisorBinding(state, {
    corpId: 'corp-1',
    dingUserId: 'ding-2',
    token: created.token,
    now: LATER,
  }), /principal/i);
});

test('active binding does not resolve a disabled internal account', () => {
  const state = makeState([{ id: 7, mobile: '13800138000', status: 'disabled' }]);
  state.userDingtalkIdentities.push({ ...PRINCIPAL, userId: 7, status: 'active' });

  assert.equal(resolveDingtalkAdvisor(state, PRINCIPAL), null);
});

test('revoked binding is auditable and no longer resolves', () => {
  const state = makeState();
  state.userDingtalkIdentities.push({ ...PRINCIPAL, userId: 7, status: 'active' });

  const revoked = revokeAdvisorBinding(state, {
    ...PRINCIPAL,
    now: LATER,
    reason: 'advisor left company',
  });

  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revokedAt, LATER);
  assert.equal(revoked.reason, 'advisor left company');
  assert.equal(resolveDingtalkAdvisor(state, PRINCIPAL), null);
});
