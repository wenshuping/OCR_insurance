import { randomUUID } from 'node:crypto';

const DIRECT_CONVERSATION = '1';
const MAX_TEXT_LENGTH = 2_000;

function channelError(code, status = 500) {
  return Object.assign(new Error(code), { code, status });
}

function required(value, code) {
  const result = String(value || '').trim();
  if (!result) throw channelError(code, 503);
  return result;
}

function safeReply(code) {
  const replies = {
    MOBILE_MISMATCH: '当前钉钉手机号与平台注册手机号不一致，无法登录。',
    MOBILE_VERIFICATION_REQUIRED: '无法验证当前钉钉手机号，请联系管理员。',
    UNAUTHORIZED: '身份服务未授权，请联系管理员。',
  };
  return replies[code] || '服务暂时不可用，请稍后重试。';
}

function commandText(message) {
  if (message?.msgtype !== 'text') return '';
  return String(message.text?.content || '').trim().slice(0, MAX_TEXT_LENGTH);
}

export function createDingtalkStreamChannel({
  corpId,
  serviceToken,
  apiBaseUrl = 'http://127.0.0.1:4207',
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  const configuredCorpId = required(corpId, 'DINGTALK_CORP_ID_REQUIRED');
  const configuredServiceToken = required(serviceToken, 'DINGTALK_IDENTITY_SERVICE_TOKEN_REQUIRED');
  const pending = new Map();

  async function identityRequest(path, body) {
    const response = await fetchImpl(`${apiBaseUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${configuredServiceToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw channelError(String(payload?.code || 'DINGTALK_IDENTITY_FAILED'), response.status);
    return payload;
  }

  async function reply(sessionWebhook, text) {
    const response = await fetchImpl(required(sessionWebhook, 'DINGTALK_SESSION_WEBHOOK_REQUIRED'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
    });
    if (!response.ok) throw channelError('DINGTALK_REPLY_FAILED', 502);
  }

  async function handle(message) {
    const sessionWebhook = message?.sessionWebhook;
    if (String(message?.senderCorpId || '') !== configuredCorpId) return;
    if (String(message?.conversationType || '') !== DIRECT_CONVERSATION) {
      await reply(sessionWebhook, '当前仅支持单聊，请直接打开机器人对话。');
      return;
    }

    const dingUserId = required(message?.senderStaffId, 'DINGTALK_SENDER_REQUIRED');
    const text = commandText(message);
    if (!text) {
      await reply(sessionWebhook, '当前先支持文字消息。发送“绑定”验证平台账号。');
      return;
    }

    if (text === '绑定') {
      try {
        const requestId = randomUUID();
        const result = await identityRequest('/api/dingtalk/identity/candidate', {
          corpId: configuredCorpId,
          dingUserId,
          requestId,
        });
        pending.set(dingUserId, {
          token: result.challenge.token,
          expiresAt: Date.parse(result.challenge.expiresAt),
        });
        await reply(sessionWebhook, `检测到平台注册手机号 ${result.maskedMobile}。如为本人，请回复“确认绑定”。`);
      } catch (error) {
        await reply(sessionWebhook, safeReply(error?.code));
      }
      return;
    }

    if (text === '确认绑定') {
      const challenge = pending.get(dingUserId);
      if (!challenge || !Number.isFinite(challenge.expiresAt) || challenge.expiresAt <= now()) {
        pending.delete(dingUserId);
        await reply(sessionWebhook, '绑定确认已过期，请重新发送“绑定”。');
        return;
      }
      try {
        const result = await identityRequest('/api/dingtalk/identity/confirm', {
          corpId: configuredCorpId,
          dingUserId,
          requestId: randomUUID(),
          token: challenge.token,
        });
        pending.delete(dingUserId);
        await reply(sessionWebhook, `绑定成功（${result.maskedMobile}）。现在可以发送文字问题；文档上传正在接入安全处理流程。`);
      } catch (error) {
        await reply(sessionWebhook, safeReply(error?.code));
      }
      return;
    }

    await reply(sessionWebhook, '你好，我是企业智能文档助手。首次使用请发送“绑定”。');
  }

  return { handle };
}
