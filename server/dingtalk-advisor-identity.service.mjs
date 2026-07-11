import { createHash, randomBytes } from 'node:crypto';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export class DingtalkAdvisorIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DingtalkAdvisorIdentityError';
    this.code = code;
  }
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function normalizedMobile(value) {
  const mobile = String(value || '').trim();
  return /^1[3-9]\d{9}$/.test(mobile) ? mobile : null;
}

export function mobileFingerprint(value) {
  const mobile = normalizedMobile(value);
  return mobile ? createHash('sha256').update(mobile).digest('hex') : null;
}

function maskMobile(mobile) {
  return `${mobile.slice(0, 3)}****${mobile.slice(-4)}`;
}

function activeUser(state, userId) {
  return (state.users ?? []).find((user) => user.id === userId && user.status === 'active');
}

function principalIdentities(state, corpId, dingUserId) {
  return (state.userDingtalkIdentities ?? []).filter((row) => (
    row.corpId === corpId && row.dingUserId === dingUserId
  ));
}

function uniquePrincipalIdentity(state, corpId, dingUserId) {
  const identities = principalIdentities(state, corpId, dingUserId);
  if (identities.length > 1) {
    throw new DingtalkAdvisorIdentityError(
      'AMBIGUOUS_PRINCIPAL',
      'Multiple DingTalk identities exist for this principal',
    );
  }
  return identities[0] ?? null;
}

export function findAdvisorBindingCandidate(state, { mobile, allowedUserIds }) {
  const normalized = normalizedMobile(mobile);
  if (!normalized) return { status: 'verification_required' };
  const matches = (state.users ?? []).filter((user) => (
    normalizedMobile(user.mobile) === normalized && user.status === 'active'
  ));
  if (matches.length > 1) return { status: 'ambiguous' };
  if (matches.length === 0 || !allowedUserIds.includes(matches[0].id)) {
    return { status: 'not_found' };
  }

  return {
    status: 'confirmation_required',
    userId: matches[0].id,
    maskedMobile: maskMobile(normalized),
    mobileFingerprint: mobileFingerprint(normalized),
  };
}

export function createAdvisorBindingChallenge(state, {
  corpId,
  dingUserId,
  userId,
  mobileFingerprint: verifiedMobileFingerprint,
  now = new Date().toISOString(),
}) {
  if (!/^[a-f0-9]{64}$/.test(String(verifiedMobileFingerprint || ''))) {
    throw new DingtalkAdvisorIdentityError(
      'MOBILE_VERIFICATION_REQUIRED',
      'Exact mobile verification is required',
    );
  }
  if (!activeUser(state, userId)) {
    throw new DingtalkAdvisorIdentityError('ADVISOR_ACCOUNT_INACTIVE', 'Advisor account is not active');
  }

  const existingIdentity = uniquePrincipalIdentity(state, corpId, dingUserId);
  if (existingIdentity?.status === 'active') {
    const code = existingIdentity.userId === userId ? 'ALREADY_BOUND' : 'REBIND_REQUIRES_REVOKE';
    throw new DingtalkAdvisorIdentityError(
      code,
      code === 'ALREADY_BOUND'
        ? 'DingTalk principal is already bound'
        : 'Active DingTalk principal must be revoked before rebinding',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(new Date(now).getTime() + CHALLENGE_TTL_MS).toISOString();
  const identity = existingIdentity ?? { corpId, dingUserId, createdAt: now };
  identity.userId = userId;
  identity.status = 'pending';
  identity.updatedAt = now;
  delete identity.activatedAt;
  delete identity.revokedAt;
  delete identity.reason;
  const challenge = {
    corpId,
    dingUserId,
    userId,
    mobileFingerprint: verifiedMobileFingerprint,
    tokenHash: tokenHash(token),
    createdAt: now,
    expiresAt,
    usedAt: null,
  };

  if (!existingIdentity) (state.userDingtalkIdentities ??= []).push(identity);
  for (const prior of state.dingtalkBindingChallenges ?? []) {
    if (prior.corpId === corpId && prior.dingUserId === dingUserId && !prior.usedAt) {
      prior.invalidatedAt = now;
    }
  }
  (state.dingtalkBindingChallenges ??= []).push(challenge);
  return { token, expiresAt };
}

export function confirmAdvisorBinding(state, {
  corpId,
  dingUserId,
  token,
  expectedUserId,
  expectedMobileFingerprint,
  now = new Date().toISOString(),
}) {
  const challenge = (state.dingtalkBindingChallenges ?? []).find((row) => (
    row.tokenHash === tokenHash(token)
  ));
  if (!challenge) {
    throw new DingtalkAdvisorIdentityError('CHALLENGE_NOT_FOUND', 'Binding challenge not found');
  }
  if (challenge.corpId !== corpId || challenge.dingUserId !== dingUserId) {
    throw new DingtalkAdvisorIdentityError(
      'CHALLENGE_PRINCIPAL_MISMATCH',
      'Binding challenge principal does not match',
    );
  }
  if (expectedUserId !== undefined && Number(challenge.userId) !== Number(expectedUserId)) {
    throw new DingtalkAdvisorIdentityError(
      'CHALLENGE_USER_MISMATCH',
      'Binding challenge does not belong to the authenticated user',
    );
  }
  if (!challenge.mobileFingerprint) {
    throw new DingtalkAdvisorIdentityError('MOBILE_VERIFICATION_REQUIRED', 'Exact mobile verification is required');
  }
  if (expectedMobileFingerprint !== undefined
    && challenge.mobileFingerprint !== expectedMobileFingerprint) {
    throw new DingtalkAdvisorIdentityError('MOBILE_MISMATCH', 'Verified mobiles do not match');
  }
  if (challenge.invalidatedAt) {
    throw new DingtalkAdvisorIdentityError('CHALLENGE_INVALIDATED', 'Binding challenge was invalidated');
  }
  if (challenge.usedAt) {
    throw new DingtalkAdvisorIdentityError('CHALLENGE_USED', 'Binding challenge was already used');
  }
  if (new Date(now).getTime() >= new Date(challenge.expiresAt).getTime()) {
    throw new DingtalkAdvisorIdentityError('CHALLENGE_EXPIRED', 'Binding challenge expired');
  }
  if (!activeUser(state, challenge.userId)) {
    throw new DingtalkAdvisorIdentityError('ADVISOR_ACCOUNT_INACTIVE', 'Advisor account is not active');
  }

  const identity = uniquePrincipalIdentity(state, corpId, dingUserId);
  if (identity?.userId !== challenge.userId || identity.status !== 'pending') {
    throw new DingtalkAdvisorIdentityError(
      'PENDING_IDENTITY_NOT_FOUND',
      'Pending DingTalk identity not found',
    );
  }

  challenge.usedAt = now;
  identity.status = 'active';
  identity.activatedAt = now;
  identity.updatedAt = now;
  return identity;
}

export function resolveDingtalkAdvisor(state, { corpId, dingUserId }) {
  const identities = principalIdentities(state, corpId, dingUserId);
  if (identities.length !== 1) return null;
  const identity = identities[0];
  if (!identity || !activeUser(state, identity.userId)) return null;
  if (identity.status !== 'active') return null;
  return identity;
}

export function revokeAdvisorBinding(state, {
  corpId,
  dingUserId,
  reason,
  now = new Date().toISOString(),
}) {
  const identity = uniquePrincipalIdentity(state, corpId, dingUserId);
  if (!identity || identity.status !== 'active') return null;

  identity.status = 'revoked';
  identity.revokedAt = now;
  identity.reason = reason;
  identity.updatedAt = now;
  return identity;
}
