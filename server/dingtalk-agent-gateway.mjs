import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';

import { createDingtalkAgentGateway, createSignedAgentRequest } from './dingtalk-agent-gateway.service.mjs';

function requiredEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

async function getUserMobile({ client, dingUserId, fetchImpl = fetch }) {
  const accessToken = String(await client.getAccessToken() || '').trim();
  if (!accessToken) throw new Error('DINGTALK_ACCESS_TOKEN_FAILED');
  const response = await fetchImpl(`https://oapi.dingtalk.com/topapi/v2/user/get?access_token=${encodeURIComponent(accessToken)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userid: String(dingUserId || '').trim() }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || Number(payload?.errcode || 0) !== 0) throw new Error('DINGTALK_PROFILE_LOOKUP_FAILED');
  return String(payload?.result?.mobile || '').trim();
}

export function createDingtalkMobileResolver({ client, fetchImpl = fetch, now = Date.now, cacheTtlMs = 5 * 60_000 } = {}) {
  const cache = new Map();
  return async function resolveDingtalkMobile(dingUserId) {
    const userId = String(dingUserId || '').trim();
    const cached = cache.get(userId);
    if (cached && Number(now()) - cached.cachedAt < cacheTtlMs) return cached.mobile;
    const mobile = await getUserMobile({ client, dingUserId: userId, fetchImpl });
    cache.set(userId, { mobile, cachedAt: Number(now()) });
    return mobile;
  };
}

export function createDingtalkRuntimeSettingsLoader({ apiBaseUrl, hmacSecret, fetchImpl = fetch, now = Date.now } = {}) {
  const endpoint = `${String(apiBaseUrl || '').replace(/\/$/u, '')}/api/agent/runtime-config`;
  return async ({ messageRef } = {}) => {
    const body = { channel: 'dingtalk', messageRef: String(messageRef || '').trim() };
    const signed = createSignedAgentRequest({ secret: hmacSecret, timestamp: now(), body });
    const response = await fetchImpl(endpoint, { method: 'POST', headers: signed.headers, body: signed.rawBody });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.runtimeSettings) throw new Error('DINGTALK_RUNTIME_CONFIG_FAILED');
    return payload.runtimeSettings;
  };
}

export function createDingtalkConversationContextClient({ apiBaseUrl, hmacSecret, fetchImpl = fetch, now = Date.now } = {}) {
  const baseUrl = String(apiBaseUrl || '').replace(/\/$/u, '');
  async function request(action, input) {
    const body = {
      channel: 'dingtalk',
      channelUserId: String(input.channelUserId || '').trim(),
      channelMobile: String(input.channelMobile || '').trim(),
      conversationId: String(input.channelConversationId || 'direct').trim(),
      messageRef: String(input.messageRef || '').trim(),
      productContextTtlMinutes: Number(input.productContextTtlMinutes),
      ...(action === 'commit' ? {
        conversationRef: String(input.conversationRef || '').trim(),
        expectedVersion: Number(input.expectedVersion),
        context: {
          history: input.history || [], product: input.product || null,
          productCandidates: input.productCandidates || null, question: input.question || null,
          updatedAt: Number(input.updatedAt),
        },
      } : {}),
    };
    const signed = createSignedAgentRequest({ secret: hmacSecret, timestamp: now(), body });
    const response = await fetchImpl(`${baseUrl}/api/agent/conversation-context/${action}`, {
      method: 'POST', headers: signed.headers, body: signed.rawBody,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.context) throw new Error(`DINGTALK_CONTEXT_${action.toUpperCase()}_FAILED`);
    return payload.context;
  }
  return {
    loadContext: (input) => request('load', input),
    commitContext: (input) => request('commit', input),
  };
}

export function installDingtalkShutdownHandlers({ gateway, client, processLike = process } = {}) {
  if (typeof gateway?.shutdown !== 'function' || typeof client?.disconnect !== 'function'
    || typeof processLike?.once !== 'function') {
    throw new TypeError('DingTalk shutdown dependencies are required');
  }
  let stopping = null;
  const stop = () => {
    if (stopping) return stopping;
    client.disconnect();
    stopping = gateway.shutdown();
    return stopping;
  };
  const onSignal = () => { void stop().catch(() => {}); };
  processLike.once('SIGTERM', onSignal);
  processLike.once('SIGINT', onSignal);
  return stop;
}

export async function startDingtalkAgentGateway({ env = process.env, Client = DWClient } = {}) {
  const hmacSecret = requiredEnv(env, 'AGENT_GATEWAY_HMAC_SECRET');
  const apiBaseUrl = String(env.DINGTALK_CHANNEL_API_BASE_URL || '').trim() || 'http://127.0.0.1:4207';
  const client = new Client({
    clientId: requiredEnv(env, 'DINGTALK_APP_KEY'),
    clientSecret: requiredEnv(env, 'DINGTALK_APP_SECRET'),
    keepAlive: true,
  });
  const getDingtalkMobile = createDingtalkMobileResolver({ client });
  const gateway = createDingtalkAgentGateway({
    corpId: requiredEnv(env, 'DINGTALK_CORP_ID'),
    hmacSecret,
    apiBaseUrl,
    getDingtalkMobile,
    useMessagesApi: true,
  });
  client.registerCallbackListener(TOPIC_ROBOT, (event) => {
    client.socketCallBackResponse(event.headers.messageId, 'OK');
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    void gateway.handle(message).catch(() => {
      console.warn('[dingtalk-agent-gateway] UNHANDLED_MESSAGE_ERROR');
    });
  });
  await client.connect();
  return { client, gateway };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startDingtalkAgentGateway()
    .then(({ client, gateway }) => installDingtalkShutdownHandlers({ client, gateway }))
    .catch((error) => {
      console.error(`[dingtalk-agent-gateway] ${error?.message || 'START_FAILED'}`);
      process.exitCode = 1;
    });
}
