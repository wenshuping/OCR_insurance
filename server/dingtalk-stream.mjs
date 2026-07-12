import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import { createDingtalkStreamChannel } from './dingtalk-stream-channel.service.mjs';
import { createDingtalkMediaDownloader } from './dingtalk-media-runtime.mjs';

function requiredEnv(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

export async function startDingtalkStream({ env = process.env, Client = DWClient } = {}) {
  const clientId = requiredEnv(env, 'DINGTALK_APP_KEY');
  const clientSecret = requiredEnv(env, 'DINGTALK_APP_SECRET');
  const client = new Client({ clientId, clientSecret, keepAlive: true });
  const channel = createDingtalkStreamChannel({
    corpId: String(env.DINGTALK_CORP_ID || '').trim(),
    serviceToken: String(env.DINGTALK_IDENTITY_SERVICE_TOKEN || '').trim(),
    apiBaseUrl: String(env.DINGTALK_CHANNEL_API_BASE_URL || '').trim() || 'http://127.0.0.1:4207',
    policyUploadEnabled: String(env.DINGTALK_POLICY_UPLOAD_MODE || '').trim() === 'raw_allowed',
    downloadAttachment: createDingtalkMediaDownloader({
      client,
      apiBaseUrl: String(env.DINGTALK_API_BASE_URL || '').trim() || 'https://api.dingtalk.com',
      maxBytes: Number(env.DINGTALK_POLICY_MAX_DOCUMENT_BYTES) || undefined,
    }),
  });
  client.registerCallbackListener(TOPIC_ROBOT, (event) => {
    client.socketCallBackResponse(event.headers.messageId, 'OK');
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    void channel.handle(message).catch(() => {});
  });
  await client.connect();
  return client;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  startDingtalkStream().catch((error) => {
    console.error(`[dingtalk-stream] ${error?.message || 'START_FAILED'}`);
    process.exitCode = 1;
  });
}
