import { timingSafeEqual } from 'node:crypto';

const DEFAULT_API_BASE_URL = 'https://api.dingtalk.com';

function trim(value) {
  return String(value || '').trim();
}

function runtimeError(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function bearerToken(req) {
  const authorization = trim(req?.get?.('authorization'));
  return authorization.startsWith('Bearer ') ? trim(authorization.slice(7)) : '';
}

function secretsEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function allowedUserIds(value) {
  return trim(value).split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

async function fetchJson(fetchImpl, url, options, failureCode) {
  const response = await fetchImpl(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload) throw runtimeError(failureCode, 502);
  return payload;
}

// Runtime environment names: DINGTALK_IDENTITY_SERVICE_TOKEN,
// DINGTALK_IDENTITY_ALLOWED_USER_IDS, DINGTALK_CORP_ID, DINGTALK_APP_KEY,
// DINGTALK_APP_SECRET, and optional DINGTALK_API_BASE_URL.
export function createDingtalkIdentityRuntime({ env = process.env, fetchImpl = fetch } = {}) {
  const serviceToken = trim(env.DINGTALK_IDENTITY_SERVICE_TOKEN);
  const corpId = trim(env.DINGTALK_CORP_ID);
  const appKey = trim(env.DINGTALK_APP_KEY);
  const appSecret = trim(env.DINGTALK_APP_SECRET);
  const apiBaseUrl = trim(env.DINGTALK_API_BASE_URL) || DEFAULT_API_BASE_URL;

  return {
    dingtalkAllowedUserIds: allowedUserIds(env.DINGTALK_IDENTITY_ALLOWED_USER_IDS),
    authenticateDingtalkServiceRequest(req) {
      const supplied = bearerToken(req);
      return Boolean(serviceToken && supplied && secretsEqual(serviceToken, supplied));
    },
    async getDingtalkUserProfile({ corpId: requestedCorpId, dingUserId }) {
      if (!corpId || !appKey || !appSecret) {
        throw runtimeError('DINGTALK_PROFILE_NOT_CONFIGURED', 503);
      }
      if (trim(requestedCorpId) !== corpId) throw runtimeError('DINGTALK_CORP_MISMATCH', 403);
      const access = await fetchJson(fetchImpl, `${apiBaseUrl}/v1.0/oauth2/accessToken`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appKey, appSecret }),
      }, 'DINGTALK_ACCESS_TOKEN_FAILED');
      const accessToken = trim(access.accessToken);
      if (!accessToken) throw runtimeError('DINGTALK_ACCESS_TOKEN_FAILED', 502);
      const profile = await fetchJson(
        fetchImpl,
        `${apiBaseUrl}/v1.0/contact/users/${encodeURIComponent(trim(dingUserId))}`,
        { headers: { 'x-acs-dingtalk-access-token': accessToken } },
        'DINGTALK_PROFILE_LOOKUP_FAILED',
      );
      return { mobile: trim(profile.mobile) };
    },
  };
}
