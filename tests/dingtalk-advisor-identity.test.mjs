import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  DingtalkAdvisorIdentityError,
  confirmAdvisorBinding,
  createAdvisorBindingChallenge,
  findAdvisorBindingCandidate,
  resolveDingtalkAdvisor,
  revokeAdvisorBinding,
  mobileFingerprint,
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
    mobileFingerprint: mobileFingerprint('13800138000'),
  });
  assert.equal(JSON.stringify(result).includes('13800138000'), false);
});

test('no mobile match does not select an account', () => {
  assert.deepEqual(findAdvisorBindingCandidate(makeState(), {
    mobile: '13900139000',
    allowedUserIds: [7],
  }), { status: 'not_found' });
});

test('mobile matching permits surrounding whitespace but rejects missing, masked, partial, and tail values', () => {
  assert.equal(findAdvisorBindingCandidate(makeState(), {
    mobile: ' 13800138000 ', allowedUserIds: [7],
  }).status, 'confirmation_required');
  for (const mobile of ['', '138****8000', '8000', '00138000']) {
    assert.equal(findAdvisorBindingCandidate(makeState(), {
      mobile, allowedUserIds: [7],
    }).status, 'verification_required', mobile);
  }
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
    mobileFingerprint: mobileFingerprint('13800138000'),
    now: NOW,
  });

  assert.equal(typeof created.token, 'string');
  assert.equal(created.expiresAt, '2026-07-12T08:05:00.000Z');
  assert.equal(state.dingtalkBindingChallenges[0].token, undefined);
  assert.equal(state.dingtalkBindingChallenges[0].tokenHash, createHash('sha256').update(created.token).digest('hex'));
  assert.equal(state.dingtalkBindingChallenges[0].mobileFingerprint, mobileFingerprint('13800138000'));
  assert.equal(JSON.stringify(state.dingtalkBindingChallenges).includes('13800138000'), false);
  assert.equal(state.userDingtalkIdentities[0].status, 'pending');

  const binding = confirmAdvisorBinding(state, { ...PRINCIPAL, token: created.token, now: LATER });

  assert.equal(binding.status, 'active');
  assert.equal(binding.userId, 7);
  assert.equal(state.dingtalkBindingChallenges[0].usedAt, LATER);
  assert.equal(resolveDingtalkAdvisor(state, PRINCIPAL)?.userId, 7);
});

test('expired challenge cannot be confirmed', () => {
  const state = makeState();
  const created = createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, mobileFingerprint: mobileFingerprint('13800138000'), now: NOW });

  assert.throws(() => confirmAdvisorBinding(state, {
    ...PRINCIPAL,
    token: created.token,
    now: '2026-07-12T08:05:00.000Z',
  }), /expired/i);
});

test('used challenge cannot be confirmed again', () => {
  const state = makeState();
  const created = createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, mobileFingerprint: mobileFingerprint('13800138000'), now: NOW });
  confirmAdvisorBinding(state, { ...PRINCIPAL, token: created.token, now: LATER });

  assert.throws(() => confirmAdvisorBinding(state, {
    ...PRINCIPAL,
    token: created.token,
    now: '2026-07-12T08:02:00.000Z',
  }), /used/i);
});

test('challenge cannot be confirmed by a different DingTalk principal', () => {
  const state = makeState();
  const created = createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, mobileFingerprint: mobileFingerprint('13800138000'), now: NOW });

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

test('reissuing a pending challenge reuses the identity and invalidates the old challenge', () => {
  const state = makeState();
  const first = createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, mobileFingerprint: mobileFingerprint('13800138000'), now: NOW });
  const second = createAdvisorBindingChallenge(state, {
    ...PRINCIPAL,
    userId: 7,
    mobileFingerprint: mobileFingerprint('13800138000'),
    now: '2026-07-12T08:00:30.000Z',
  });

  assert.equal(state.userDingtalkIdentities.length, 1);
  assert.equal(state.dingtalkBindingChallenges[0].invalidatedAt, '2026-07-12T08:00:30.000Z');
  assert.throws(() => confirmAdvisorBinding(state, {
    ...PRINCIPAL,
    token: first.token,
    now: LATER,
  }), (error) => error instanceof DingtalkAdvisorIdentityError && error.code === 'CHALLENGE_INVALIDATED');
  assert.equal(confirmAdvisorBinding(state, { ...PRINCIPAL, token: second.token, now: LATER }).status, 'active');
});

test('active principal cannot be silently rebound to another user', () => {
  const state = makeState([
    { id: 7, mobile: '13800138000', status: 'active' },
    { id: 8, mobile: '13900139000', status: 'active' },
  ]);
  state.userDingtalkIdentities.push({ ...PRINCIPAL, userId: 7, status: 'active' });

  assert.throws(() => createAdvisorBindingChallenge(state, {
    ...PRINCIPAL,
    userId: 8,
    mobileFingerprint: mobileFingerprint('13900139000'),
    now: NOW,
  }), (error) => error instanceof DingtalkAdvisorIdentityError && error.code === 'REBIND_REQUIRES_REVOKE');
  assert.equal(state.userDingtalkIdentities.length, 1);
});

test('revoked principal can start a new confirmation flow without adding an identity row', () => {
  const state = makeState();
  state.userDingtalkIdentities.push({
    ...PRINCIPAL,
    userId: 7,
    status: 'revoked',
    revokedAt: NOW,
    reason: 'old binding retired',
  });

  createAdvisorBindingChallenge(state, { ...PRINCIPAL, userId: 7, mobileFingerprint: mobileFingerprint('13800138000'), now: LATER });

  assert.equal(state.userDingtalkIdentities.length, 1);
  assert.equal(state.userDingtalkIdentities[0].status, 'pending');
  assert.equal(state.userDingtalkIdentities[0].revokedAt, undefined);
  assert.equal(state.userDingtalkIdentities[0].reason, undefined);
});

test('legacy duplicate principal fails closed for resolution and revoke', () => {
  const state = makeState();
  state.userDingtalkIdentities.push(
    { ...PRINCIPAL, userId: 7, status: 'active' },
    { ...PRINCIPAL, userId: 7, status: 'active' },
  );

  assert.equal(resolveDingtalkAdvisor(state, PRINCIPAL), null);
  assert.throws(() => revokeAdvisorBinding(state, {
    ...PRINCIPAL,
    now: LATER,
    reason: 'security cleanup',
  }), (error) => error instanceof DingtalkAdvisorIdentityError && error.code === 'AMBIGUOUS_PRINCIPAL');
  assert.equal(state.userDingtalkIdentities.every((row) => row.status === 'active'), true);
});
