import crypto from 'node:crypto';

const ACTIONS = new Set(['confirm', 'reject', 'supersede', 'complete', 'expire', 'restore']);
const REASONS = { confirm: new Set(['user_confirmation', 'advisor_confirmation']), reject: new Set(['advisor_rejection', 'user_correction']), supersede: new Set(['advisor_correction', 'user_correction']), complete: new Set(['todo_completed']), expire: new Set(['expired_by_date', 'system_expiration']), restore: new Set(['restored_after_review']) };
const MAX_TTL_MS = 5 * 60 * 1000;

function fail(code, status = 403) { throw Object.assign(new Error(code), { code, status }); }
function bounded(value, max = 160) { const text = String(value || ''); return text && text.length <= max ? text : ''; }
function canonical(value) { return JSON.stringify(value); }

export function createAdvisorMemoryConfirmationService({ key, version = 'v1', now = Date.now } = {}) {
  if (typeof key !== 'string' || key.length < 32) fail('MEMORY_CONFIRMATION_NOT_CONFIGURED', 503);
  if (!bounded(version, 16)) fail('MEMORY_CONFIRMATION_NOT_CONFIGURED', 503);
  const sign = (payload) => crypto.createHmac('sha256', key).update(payload).digest('base64url');

  function normalizeClaims(input, { issuing = false } = {}) {
    const issuedAt = Number(input.issuedAt ?? now());
    const expiresAt = Number(input.expiresAt ?? issuedAt + MAX_TTL_MS);
    const claims = {
      version, ownerUserId: Number(input.ownerUserId), corpId: bounded(input.corpId), dingUserId: bounded(input.dingUserId),
      familyId: Number(input.familyId), memoryId: Number(input.memoryId), expectedVersion: Number(input.expectedVersion),
      action: bounded(input.action, 32), reasonCode: bounded(input.reasonCode, 80), replacementHash: bounded(input.replacementHash, 64),
      interactionId: bounded(input.interactionId), issuedAt, expiresAt,
    };
    if (![claims.ownerUserId, claims.familyId, claims.memoryId, claims.expectedVersion].every(Number.isSafeInteger)
      || claims.ownerUserId < 1 || claims.familyId < 1 || claims.memoryId < 1 || claims.expectedVersion < 1
      || !claims.corpId || !claims.dingUserId || !ACTIONS.has(claims.action) || !REASONS[claims.action]?.has(claims.reasonCode) || !/^[a-f0-9]{64}$/u.test(claims.replacementHash)
      || !claims.interactionId || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)
      || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_TTL_MS || (!issuing && (issuedAt > Number(now()) + 30_000 || expiresAt <= Number(now())))) fail('ADVISOR_CONFIRMATION_INVALID');
    return claims;
  }

  function issue(input) {
    const claims = normalizeClaims(input, { issuing: true });
    const payload = Buffer.from(canonical(claims)).toString('base64url');
    return { token: `${payload}.${sign(payload)}`, expiresAt: claims.expiresAt, interactionId: claims.interactionId };
  }

  function verify({ token, ...expected }) {
    try {
      const [payload, signature, extra] = String(token || '').split('.');
      const actual = Buffer.from(signature || '');
      const wanted = Buffer.from(payload ? sign(payload) : '');
      if (!payload || !signature || extra || actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) fail('ADVISOR_CONFIRMATION_INVALID');
      const claims = normalizeClaims(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      const mappings = { ownerScopeKey: `u:${claims.ownerUserId}`, ownerUserId: claims.ownerUserId };
      for (const [name, value] of Object.entries(expected)) {
        const actualValue = Object.hasOwn(mappings, name) ? mappings[name] : claims[name];
        if (actualValue !== value) fail('ADVISOR_CONFIRMATION_INVALID');
      }
      return { valid: true, ...claims, ownerScopeKey: `u:${claims.ownerUserId}` };
    } catch (error) { if (error?.code) throw error; fail('ADVISOR_CONFIRMATION_INVALID'); }
  }
  return Object.freeze({ issue, verify });
}
