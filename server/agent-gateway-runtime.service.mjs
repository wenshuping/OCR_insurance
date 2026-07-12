import { createHmac, timingSafeEqual } from 'node:crypto';

const DEFAULT_MAX_SKEW_MS = 5 * 60_000;

function header(req, name) {
  if (typeof req?.get === 'function') return String(req.get(name) || '').trim();
  return String(req?.headers?.[name] || '').trim();
}

function normalizedChinaMobile(value) {
  let mobile = String(value || '').trim().replace(/[\s()-]/gu, '');
  if (mobile.startsWith('+86')) mobile = mobile.slice(3);
  else if (mobile.startsWith('0086')) mobile = mobile.slice(4);
  return /^1[3-9]\d{9}$/u.test(mobile) ? mobile : '';
}

export function createAgentServiceRequestVerifier({ secret, clock = Date.now, maxSkewMs = DEFAULT_MAX_SKEW_MS } = {}) {
  const key = String(secret || '');
  const skew = Math.max(1, Number(maxSkewMs) || DEFAULT_MAX_SKEW_MS);
  const accepted = new Map();
  return async function verifyAgentServiceRequest(req) {
    if (!key || typeof req?.rawBody !== 'string') return false;
    const timestampText = header(req, 'x-agent-timestamp');
    const timestamp = Number(timestampText);
    if (!/^\d{13}$/u.test(timestampText) || !Number.isSafeInteger(timestamp)) return false;
    const current = Number(typeof clock === 'function' ? clock() : Date.now());
    if (!Number.isFinite(current) || Math.abs(current - timestamp) > skew) return false;
    for (const [fingerprint, expiresAt] of accepted) {
      if (expiresAt < current) accepted.delete(fingerprint);
    }
    const suppliedText = header(req, 'x-agent-signature').replace(/^sha256=/iu, '');
    if (!/^[a-f0-9]{64}$/iu.test(suppliedText)) return false;
    const expected = createHmac('sha256', key).update(`${timestampText}.${req.rawBody}`).digest();
    const supplied = Buffer.from(suppliedText, 'hex');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return false;
    const fingerprint = `${timestampText}:${suppliedText.toLowerCase()}`;
    if (accepted.has(fingerprint)) return false;
    accepted.set(fingerprint, timestamp + skew);
    return true;
  };
}

export function createDingTalkMobileIdentityResolver({ loadState } = {}) {
  return async function resolveDingTalkIdentity(input = {}) {
    if (input.channel !== 'dingtalk' || typeof loadState !== 'function') return null;
    const channelUserId = String(input.channelUserId || '').trim();
    const mobile = normalizedChinaMobile(input.channelMobile);
    if (!channelUserId || !mobile) return null;
    const state = await loadState();
    const matches = (Array.isArray(state?.users) ? state.users : []).filter((user) => (
      String(user?.status || 'active') === 'active' && normalizedChinaMobile(user?.mobile) === mobile
    ));
    if (matches.length !== 1) return null;
    const internalUserId = Number(matches[0]?.id);
    if (!Number.isInteger(internalUserId) || internalUserId <= 0) return null;
    const identities = Array.isArray(state?.agentChannelIdentities) ? state.agentChannelIdentities : [];
    const existingBindings = identities.filter((identity) => (
      Number(identity?.userId || identity?.internalUserId) === internalUserId
      && String(identity?.channel || '').trim().toLowerCase() === 'dingtalk'
      && String(identity?.status || 'active') === 'active'
    ));
    if (existingBindings.length && !existingBindings.some((identity) => String(identity?.channelUserId || '').trim() === channelUserId)) return null;
    return { internalUserId };
  };
}

export function createAgentSecureLinkFactory({ publicAppUrl } = {}) {
  let origin = '';
  try {
    const url = new URL(String(publicAppUrl || '').trim());
    if (url.protocol === 'https:' && !url.username && !url.password) origin = url.origin;
  } catch {
    origin = '';
  }
  const paths = { register_or_login: '/agent/register', policy_upload: '/customer/policies/upload' };
  return ({ purpose } = {}) => origin && paths[purpose] ? `${origin}${paths[purpose]}` : '';
}

export function createProductionAgentGatewayOptions({ env = process.env, loadState, clock = Date.now } = {}) {
  const publicAppUrl = String(env.POLICY_OCR_PUBLIC_APP_URL || env.PUBLIC_APP_URL || '').trim();
  let allowedOrigin = '';
  try {
    const url = new URL(publicAppUrl);
    if (url.protocol === 'https:' && !url.username && !url.password) allowedOrigin = url.origin;
  } catch {
    allowedOrigin = '';
  }
  return {
    verifyAgentServiceRequest: createAgentServiceRequestVerifier({ secret: env.AGENT_GATEWAY_HMAC_SECRET, clock }),
    resolveDingTalkIdentity: createDingTalkMobileIdentityResolver({ loadState }),
    agentSecureUploadLinkFactory: createAgentSecureLinkFactory({ publicAppUrl }),
    agentSecureLinkAllowedOrigins: allowedOrigin ? [allowedOrigin] : [],
  };
}
