import { createHmac, timingSafeEqual } from 'node:crypto';

function fail(code, status = 400) { throw Object.assign(new Error(code), { code, status }); }

export function createPolicyUploadLinkService({ key, publicBaseUrl = 'https://ocr.joyhive.cn', now = Date.now, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  if (Buffer.byteLength(String(key || '')) < 32) return null;
  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');
  return {
    issue({ familyId, taskId, userId }) {
      const claims = { f: Number(familyId), t: Number(taskId), u: Number(userId), e: Number(now()) + ttlMs };
      if (!claims.f || !claims.t || !claims.u) fail('INVALID_UPLOAD_LINK_CLAIMS');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const token = `${payload}.${sign(payload)}`;
      return { token, expiresAt: new Date(claims.e).toISOString(), url: `${publicBaseUrl.replace(/\/$/, '')}/#/policy-upload/${token}` };
    },
    verify(token) {
      const [payload, signature] = String(token || '').split('.');
      if (!payload || !signature) fail('UPLOAD_LINK_INVALID', 403);
      const expected = Buffer.from(sign(payload));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) fail('UPLOAD_LINK_INVALID', 403);
      let claims;
      try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { fail('UPLOAD_LINK_INVALID', 403); }
      if (!claims?.f || !claims?.t || !claims?.u || Number(claims.e) <= Number(now())) fail('UPLOAD_LINK_EXPIRED', 410);
      return { familyId: Number(claims.f), taskId: Number(claims.t), userId: Number(claims.u), expiresAt: new Date(claims.e).toISOString() };
    },
  };
}
