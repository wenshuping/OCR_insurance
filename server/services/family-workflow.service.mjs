export function resolveFamilyRequestOwner(req, res, { resolveAuthUser, requestOwner, state }) {
  const user = resolveAuthUser(req, state);
  const owner = requestOwner(req, user);
  if (!owner.userId && !owner.guestId) {
    res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
    return null;
  }
  return owner;
}

export function findOwnedFamily(state, familyId, owner, { familyOwnerMatches }) {
  return (state.familyProfiles || []).find((family) => (
    Number(family.id) === Number(familyId) &&
    String(family.status || 'active') === 'active' &&
    familyOwnerMatches(family, owner)
  )) || null;
}

export function familyWithMembers(state, family, { listFamilyMembers }) {
  return {
    ...family,
    members: listFamilyMembers(state, family.id),
  };
}

export function cloneFamilySharePayload(payload) {
  return JSON.parse(JSON.stringify(payload || {}));
}

const FAMILY_SHARE_PRIVATE_KEYS = new Set([
  'adminSession',
  'adminSessions',
  'adminToken',
  'authorization',
  'guestId',
  'idCard',
  'idNumber',
  'idNumberTail',
  'identityNumber',
  'mobile',
  'ownerGuestId',
  'ownerUserId',
  'password',
  'session',
  'sessions',
  'token',
  'tokens',
  'userId',
  'userMobile',
]);

export function sanitizeFamilyShareValue(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeFamilyShareValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !FAMILY_SHARE_PRIVATE_KEYS.has(key))
      .map(([key, item]) => [key, sanitizeFamilyShareValue(item)]),
  );
}

export function familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId }) {
  if (owner.userId) return Number(policy?.userId || 0) === Number(owner.userId);
  if (owner.guestId) return normalizeGuestId(policy?.guestId) === owner.guestId && !Number(policy?.userId || 0);
  return false;
}

export function buildFamilySharePayload(state, family, owner, snapshotAt, {
  attachPolicyFamilyDisplay,
  listFamilyMembers,
  normalizeGuestId,
}) {
  const members = listFamilyMembers(state, family.id).map((member) => sanitizeFamilyShareValue(member));
  const policies = (state.policies || [])
    .filter((policy) => (
      Number(policy?.familyId || 0) === Number(family.id) &&
      familySharePolicyMatchesOwner(policy, owner, { normalizeGuestId })
    ))
    .map((policy) => sanitizeFamilyShareValue(attachPolicyFamilyDisplay(policy, state)));
  return {
    family: sanitizeFamilyShareValue(family),
    members,
    policies,
    snapshotAt,
  };
}
