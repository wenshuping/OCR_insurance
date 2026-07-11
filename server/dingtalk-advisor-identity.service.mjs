import { createHash, randomBytes } from 'node:crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function maskMobile(mobile) {
  return `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;
}

function activeUser(state, userId) {
  return (state.users ?? []).find((user) => user.id === userId && user.status === 'active');
}

export function findAdvisorBindingCandidate(state, { mobile, allowedUserIds }) {
  const matches = (state.users ?? []).filter((user) => (
    user.mobile === mobile && user.status === 'active'
  ));
  if (matches.length > 1) return { status: 'ambiguous' };
  if (matches.length === 0 || !allowedUserIds.includes(matches[0].id)) {
    return { status: 'not_found' };
  }

  return {
    status: 'confirmation_required',
    userId: matches[0].id,
    maskedMobile: maskMobile(matches[0].mobile),
  };
}

export function createAdvisorBindingChallenge(state, {
  corpId,
  dingUserId,
  userId,
  now = new Date().toISOString(),
}) {
  if (!activeUser(state, userId)) throw new Error('Advisor account is not active');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(new Date(now).getTime() + CHALLENGE_TTL_MS).toISOString();
  const identity = {
    corpId,
    dingUserId,
    userId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  const challenge = {
    corpId,
    dingUserId,
    userId,
    tokenHash: tokenHash(token),
    createdAt: now,
    expiresAt,
    usedAt: null,
  };

  (state.userDingtalkIdentities ??= []).push(identity);
  (state.dingtalkBindingChallenges ??= []).push(challenge);
  return { token, expiresAt };
}

export function confirmAdvisorBinding(state, {
  corpId,
  dingUserId,
  token,
  now = new Date().toISOString(),
}) {
  const challenge = (state.dingtalkBindingChallenges ?? []).find((row) => (
    row.tokenHash === tokenHash(token)
  ));
  if (!challenge) throw new Error('Binding challenge not found');
  if (challenge.corpId !== corpId || challenge.dingUserId !== dingUserId) {
    throw new Error('Binding challenge principal does not match');
  }
  if (challenge.usedAt) throw new Error('Binding challenge was already used');
  if (new Date(now).getTime() >= new Date(challenge.expiresAt).getTime()) {
    throw new Error('Binding challenge expired');
  }
  if (!activeUser(state, challenge.userId)) throw new Error('Advisor account is not active');

  const identity = (state.userDingtalkIdentities ?? []).find((row) => (
    row.corpId === corpId
      && row.dingUserId === dingUserId
      && row.userId === challenge.userId
      && row.status === 'pending'
  ));
  if (!identity) throw new Error('Pending DingTalk identity not found');

  challenge.usedAt = now;
  identity.status = 'active';
  identity.activatedAt = now;
  identity.updatedAt = now;
  return identity;
}

export function resolveDingtalkAdvisor(state, { corpId, dingUserId }) {
  const identity = (state.userDingtalkIdentities ?? []).find((row) => (
    row.corpId === corpId && row.dingUserId === dingUserId && row.status === 'active'
  ));
  if (!identity || !activeUser(state, identity.userId)) return null;
  return identity;
}

export function revokeAdvisorBinding(state, {
  corpId,
  dingUserId,
  reason,
  now = new Date().toISOString(),
}) {
  const identity = (state.userDingtalkIdentities ?? []).find((row) => (
    row.corpId === corpId && row.dingUserId === dingUserId && row.status === 'active'
  ));
  if (!identity) return null;

  identity.status = 'revoked';
  identity.revokedAt = now;
  identity.reason = reason;
  identity.updatedAt = now;
  return identity;
}
