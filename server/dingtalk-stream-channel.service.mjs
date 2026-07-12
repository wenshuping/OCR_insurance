import { randomUUID } from 'node:crypto';

const DIRECT_CONVERSATION = '1';
const MAX_TEXT_LENGTH = 2_000;
const UPLOAD_CONSENT_TTL_MS = 10 * 60 * 1000;

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
    REGISTRATION_REQUIRED: '当前手机号尚未注册 OCR Insurance。请回复“注册”获取短信验证码。',
    IDENTITY_NOT_BOUND: '无法确认当前钉钉账号，请确认钉钉手机号与平台注册手机号一致。',
    IDENTITY_REVOKED: '当前绑定已失效，请联系管理员。',
    ADVISOR_ACCOUNT_INACTIVE: '平台账号当前不可用，请联系管理员。',
    DOCUMENT_SIZE_EXCEEDED: '附件超过 16MiB，请压缩后重试。',
    UNSUPPORTED_DOCUMENT_SIGNATURE: '仅支持 JPEG、PNG 或 PDF 保单文件。',
    DOCUMENT_TYPE_MISMATCH: '附件类型与实际内容不一致，请重新上传。',
    UNAUTHORIZED: '身份服务未授权，请联系管理员。',
  };
  return replies[code] || '服务暂时不可用，请稍后重试。';
}

function commandText(message) {
  if (message?.msgtype !== 'text') return '';
  return String(message.text?.content || '').trim().slice(0, MAX_TEXT_LENGTH);
}

function isAttachment(message) {
  if (message?.msgtype === 'picture' || message?.msgtype === 'file') return true;
  if (message?.msgtype !== 'richText') return false;
  let content = message?.content;
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch { return false; }
  }
  return Array.isArray(content?.richText) && content.richText.some((item) => item?.downloadCode);
}

function familyChoiceText(families) {
  return ['检测到多个家庭，请先选择：', ...families.map((family, index) => `${index + 1}. ${family.displayLabel}`), '请回复“选择家庭 1”（按实际编号填写）。'].join('\n');
}

function importSummary(task) {
  const draft = task?.policyDraft || {};
  const lines = [
    `附件识别完成，共 ${Number(task?.documentSummary?.count || 0)} 份。`,
    `保险公司：${draft.company || '待补充'}`,
    `产品：${draft.productName || '待补充'}`,
    `被保险人：${draft.insured || '待补充'}`,
  ];
  if (Array.isArray(task?.missingFields) && task.missingFields.length) lines.push(`待补充字段：${task.missingFields.join('、')}`);
  const nextType = task?.nextInteraction?.type;
  if (nextType === 'confirm') lines.push('请核对以上脱敏摘要；正式保存功能将在下一步接入确认指令。');
  else if (nextType === 'select_product') lines.push('识别到多个相似产品，产品选择交互将在下一步接入。');
  else if (nextType === 'bind_member') lines.push('需要确认家庭成员，成员选择交互将在下一步接入。');
  return lines.join('\n');
}

export function createDingtalkStreamChannel({
  corpId,
  serviceToken,
  apiBaseUrl = 'http://127.0.0.1:4207',
  fetchImpl = fetch,
  downloadAttachment,
  answerText,
  policyUploadEnabled = false,
  now = () => Date.now(),
  reportError = (code) => console.warn(`[dingtalk-stream] ${code}`),
} = {}) {
  const configuredCorpId = required(corpId, 'DINGTALK_CORP_ID_REQUIRED');
  const configuredServiceToken = required(serviceToken, 'DINGTALK_IDENTITY_SERVICE_TOKEN_REQUIRED');
  const authenticated = new Set();
  const registrationPending = new Set();
  const intake = new Map();

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

  async function invokeTool(principal, tool, input) {
    const payload = await identityRequest('/api/wukong/mcp', {
      corpId: configuredCorpId,
      dingUserId: principal,
      conversationType: 'direct',
      requestId: randomUUID(),
      tool,
      input,
    });
    return payload.result;
  }

  async function ensureIdentity(dingUserId) {
    if (authenticated.has(dingUserId)) return;
    await identityRequest('/api/dingtalk/identity/auto', {
      corpId: configuredCorpId,
      dingUserId,
      requestId: randomUUID(),
    });
    authenticated.add(dingUserId);
  }

  async function prepareUpload(dingUserId) {
    const result = await invokeTool(dingUserId, 'list_accessible_families', {});
    const families = Array.isArray(result?.families) ? result.families : [];
    if (!families.length) throw channelError('FAMILY_NOT_FOUND', 404);
    const current = intake.get(dingUserId) || {};
    current.families = families;
    if (families.length === 1) current.familyRef = Number(families[0].id);
    intake.set(dingUserId, current);
    return current;
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

    if (isAttachment(message)) {
      if (!policyUploadEnabled) {
        await reply(sessionWebhook, '当前企业尚未启用钉钉原件上传，请使用网页上传。');
        return;
      }
      if (typeof downloadAttachment !== 'function') {
        await reply(sessionWebhook, '附件处理服务暂时不可用，请稍后重试。');
        return;
      }
      try {
        await ensureIdentity(dingUserId);
        const current = intake.get(dingUserId) || await prepareUpload(dingUserId);
        if (!current.familyRef) {
          await reply(sessionWebhook, familyChoiceText(current.families));
          return;
        }
        if (!Number.isFinite(current.consentExpiresAt) || current.consentExpiresAt <= now()) {
          await reply(sessionWebhook, '上传的保单可能包含客户敏感信息，文件将经过钉钉传输并由 OCR Insurance 受控 OCR 服务识别，不会自动保存为正式保单。如已获得客户授权，请回复“同意上传”，再重新发送附件。');
          return;
        }
        await reply(sessionWebhook, '已收到附件，正在安全下载并识别，请稍候。');
        const file = await downloadAttachment(message);
        let taskId = current.taskId;
        let stateVersion = current.stateVersion;
        if (!taskId) {
          const started = await invokeTool(dingUserId, 'start_policy_import', { familyRef: current.familyRef });
          taskId = started.taskId;
          stateVersion = started.stateVersion;
        }
        const task = await invokeTool(dingUserId, 'append_policy_import_files', {
          familyRef: current.familyRef,
          taskId,
          stateVersion,
          files: [file],
        });
        current.taskId = task.taskId;
        current.stateVersion = task.stateVersion;
        intake.set(dingUserId, current);
        await reply(sessionWebhook, importSummary(task));
      } catch (error) {
        reportError(String(error?.code || 'DINGTALK_POLICY_UPLOAD_FAILED'));
        await reply(sessionWebhook, safeReply(error?.code));
      }
      return;
    }

    const text = commandText(message);
    if (!text) {
      await reply(sessionWebhook, '当前支持文字消息以及 JPEG、PNG、PDF 保单附件。发送“上传保单”开始录入。');
      return;
    }

    if (text === '注册') {
      try {
        const profile = await identityRequest('/api/dingtalk/identity/registration/mobile', {
          corpId: configuredCorpId, dingUserId, requestId: randomUUID(),
        });
        await identityRequest('/api/auth/send-code', { mobile: profile.mobile });
        registrationPending.add(dingUserId);
        await reply(sessionWebhook, '验证码已发送到当前钉钉手机号，请在 10 分钟内直接回复短信中的 6 位验证码。');
      } catch (error) {
        reportError(String(error?.code || 'DINGTALK_REGISTRATION_FAILED'));
        await reply(sessionWebhook, safeReply(error?.code));
      }
      return;
    }

    if (/^\d{6}$/u.test(text) && registrationPending.has(dingUserId)) {
      try {
        const profile = await identityRequest('/api/dingtalk/identity/registration/mobile', {
          corpId: configuredCorpId, dingUserId, requestId: randomUUID(),
        });
        await identityRequest('/api/auth/register', { mobile: profile.mobile, code: text, includePolicies: false });
        await identityRequest('/api/dingtalk/identity/auto', {
          corpId: configuredCorpId, dingUserId, requestId: randomUUID(),
        });
        registrationPending.delete(dingUserId);
        authenticated.add(dingUserId);
        await reply(sessionWebhook, '注册验证成功。现在可以直接提问，或发送“上传保单”开始录入。');
      } catch (error) {
        reportError(String(error?.code || 'DINGTALK_REGISTRATION_FAILED'));
        await reply(sessionWebhook, error?.code === 'INVALID_CODE' ? '验证码不正确或已过期，请回复“注册”重新获取。' : safeReply(error?.code));
      }
      return;
    }

    if (text === '上传保单' || text === '录入保单') {
      if (!policyUploadEnabled) {
        await reply(sessionWebhook, '当前企业尚未启用钉钉原件上传，请使用网页上传。');
        return;
      }
      try {
        await ensureIdentity(dingUserId);
        const current = await prepareUpload(dingUserId);
        if (!current.familyRef) await reply(sessionWebhook, familyChoiceText(current.families));
        else await reply(sessionWebhook, '上传的保单可能包含客户敏感信息，文件将经过钉钉传输并由 OCR Insurance 受控 OCR 服务识别，不会自动保存为正式保单。如已获得客户授权，请回复“同意上传”。');
      } catch (error) {
        reportError(String(error?.code || 'DINGTALK_POLICY_UPLOAD_FAILED'));
        await reply(sessionWebhook, safeReply(error?.code));
      }
      return;
    }

    const familySelection = /^选择家庭\s+(\d{1,2})$/u.exec(text);
    if (familySelection) {
      const current = intake.get(dingUserId);
      const selected = current?.families?.[Number(familySelection[1]) - 1];
      if (!selected) {
        await reply(sessionWebhook, '家庭编号无效，请先发送“上传保单”重新查看列表。');
        return;
      }
      current.familyRef = Number(selected.id);
      delete current.taskId;
      delete current.stateVersion;
      await reply(sessionWebhook, '家庭已选择。确认已获得客户授权后，请回复“同意上传”。');
      return;
    }

    if (text === '同意上传') {
      const current = intake.get(dingUserId);
      if (!current?.familyRef) {
        await reply(sessionWebhook, '请先发送“上传保单”选择家庭。');
        return;
      }
      current.consentExpiresAt = now() + UPLOAD_CONSENT_TTL_MS;
      await reply(sessionWebhook, '授权确认已记录，10 分钟内请发送 JPEG、PNG 或 PDF 保单文件。文件只用于本次录入，识别后仍需你确认。');
      return;
    }

    try {
      await ensureIdentity(dingUserId);
      if (typeof answerText !== 'function') throw channelError('HERMES_AGENT_NOT_CONFIGURED', 503);
      await reply(sessionWebhook, await answerText({ dingUserId, text }));
    } catch (error) {
      reportError(String(error?.code || 'DINGTALK_AGENT_FAILED'));
      if (error?.code === 'REGISTRATION_REQUIRED') registrationPending.add(dingUserId);
      await reply(sessionWebhook, safeReply(error?.code));
    }
  }

  return { handle };
}
