import { createHash, timingSafeEqual } from 'node:crypto';
import { createMobileFingerprint } from './dingtalk-advisor-identity.service.mjs';

const DEFAULT_API_BASE_URL = 'https://api.dingtalk.com';
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 50;
const MAX_TIMEOUT_MS = 30_000;
const MOBILE_FINGERPRINT_VERSION = 'v1';

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
  if (!left || !right) return false;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function allowedUserIds(value) {
  return trim(value).split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

function boundedTimeoutMs(value) {
  if (!trim(value)) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(parsed)));
}

async function fetchJson(fetchImpl, url, options, failureCode, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(runtimeError('DINGTALK_REQUEST_TIMEOUT', 504));
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(url, { ...options, signal: controller.signal }),
      timeoutPromise,
    ]);
    if (!response?.ok) throw runtimeError(failureCode, 502);
    const payload = await Promise.race([
      response.json().catch(() => null),
      timeoutPromise,
    ]);
    if (!payload) throw runtimeError(failureCode, 502);
    return payload;
  } catch (error) {
    if (controller.signal.aborted) throw runtimeError('DINGTALK_REQUEST_TIMEOUT', 504);
    if (error?.code === failureCode) throw error;
    throw runtimeError(failureCode, 502);
  } finally {
    clearTimeout(timeout);
  }
}

// Runtime environment names: DINGTALK_IDENTITY_SERVICE_TOKEN,
// DINGTALK_IDENTITY_ALLOWED_USER_IDS, DINGTALK_CORP_ID, DINGTALK_APP_KEY,
// DINGTALK_APP_SECRET, and optional DINGTALK_API_BASE_URL and
// DINGTALK_IDENTITY_TIMEOUT_MS (50-30000 ms, default 10000 ms).
export function createDingtalkIdentityRuntime({ env = process.env, fetchImpl = fetch, timeoutMs } = {}) {
  const serviceToken = trim(env.DINGTALK_IDENTITY_SERVICE_TOKEN);
  const corpId = trim(env.DINGTALK_CORP_ID);
  const appKey = trim(env.DINGTALK_APP_KEY);
  const appSecret = trim(env.DINGTALK_APP_SECRET);
  const apiBaseUrl = trim(env.DINGTALK_API_BASE_URL) || DEFAULT_API_BASE_URL;
  const requestTimeoutMs = boundedTimeoutMs(timeoutMs ?? env.DINGTALK_IDENTITY_TIMEOUT_MS);
  const fingerprintDingtalkMobile = createMobileFingerprint(env.DINGTALK_MOBILE_FINGERPRINT_KEY);

  return {
    dingtalkAllowedUserIds: allowedUserIds(env.DINGTALK_IDENTITY_ALLOWED_USER_IDS),
    ...(fingerprintDingtalkMobile ? {
      fingerprintDingtalkMobile,
      dingtalkMobileFingerprintVersion: MOBILE_FINGERPRINT_VERSION,
    } : {}),
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
      }, 'DINGTALK_ACCESS_TOKEN_FAILED', requestTimeoutMs);
      const accessToken = trim(access.accessToken);
      if (!accessToken) throw runtimeError('DINGTALK_ACCESS_TOKEN_FAILED', 502);
      const profile = await fetchJson(
        fetchImpl,
        `${apiBaseUrl}/v1.0/contact/users/${encodeURIComponent(trim(dingUserId))}`,
        { headers: { 'x-acs-dingtalk-access-token': accessToken } },
        'DINGTALK_PROFILE_LOOKUP_FAILED',
        requestTimeoutMs,
      );
      const mobile = trim(profile.mobile);
      return { mobile };
    },
  };
}
