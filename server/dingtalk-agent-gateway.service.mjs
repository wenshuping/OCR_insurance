import { createHmac, randomUUID } from 'node:crypto';

import { DEFAULT_AGENT_RUNTIME_SETTINGS, normalizeAgentRuntimeSettings } from './agent-question-policy.service.mjs';

const DIRECT_CONVERSATION = '1';
const MAX_TEXT_LENGTH = 1_000;
const MAX_REPLY_TEXT_LENGTH = 6_000;
const PRODUCT_PRONOUN_PATTERN = /(?:这个|那个|该|上述|刚才(?:说的)?)(?:保险)?产品|它(?:有|的|是|适合|保)/u;
const PRODUCT_SCOPE_FOLLOWUP_PATTERN = /在售|停售|销售中|还(?:在)?卖|还能买|可以买/u;
const PRODUCT_COMPARISON_PATTERN = /对比|比较|区别|差异|哪款|哪个好|\bVS\.?\b/iu;
const PRODUCT_DISCOVERY_PATTERN = /(?:(?:在售|停售|销售中).*(?:保险|医疗|重疾|年金|寿险)|(?:保险|医疗|重疾|年金|寿险).*(?:在售|停售|销售中|有哪些))/u;
const UNDERSTANDING_CHALLENGE_PATTERN = /(?:你)?(?:听懂|看懂|明白|理解)(?:我)?(?:说|问|意思).*(?:吗|没|没有)|我(?:说|问)的是/u;
const MARKDOWN_CONTENT_PATTERN = /(?:^|\n)\s*(?:#{1,6}\s|[-*]\s|\d+\.\s|>\s|\|.*\|)|\*\*[^*]+\*\*/u;
const RESPONSIBILITY_ANSWER_PATTERN = /(?:^|\n)### 责任明细（(\d+)项）/u;
const COMPARISON_PRODUCT_PRONOUN_PATTERN = /^(?:他|它|这个产品|该产品|上述产品)(?=\s*(?:和|与|对比|比较|VS\.?))/iu;

function gatewayError(code, status = 502) {
  return Object.assign(new Error(code), { code, status });
}

function required(value, code) {
  const normalized = String(value || '').trim();
  if (!normalized) throw gatewayError(code, 503);
  return normalized;
}

function questionText(message) {
  if (message?.msgtype !== 'text') return '';
  return String(message?.text?.content || '').trim().slice(0, MAX_TEXT_LENGTH);
}

function normalizeMobile(value) {
  let mobile = String(value || '').trim().replace(/[\s()-]/gu, '');
  if (mobile.startsWith('+86')) mobile = mobile.slice(3);
  else if (mobile.startsWith('0086')) mobile = mobile.slice(4);
  return /^1[3-9]\d{9}$/u.test(mobile) ? mobile : '';
}

function familyNameFromText(text) {
  const matched = String(text).match(/([\p{Script=Han}A-Za-z0-9·]{1,20}家庭)/u)?.[1] || '';
  return matched.replace(/^(?:请|帮我|帮忙|查询|查一下|查查|查看|看看|看下|分析)/u, '');
}

function productNameFromText(value) {
  const valueText = String(value || '').trim();
  if (PRODUCT_PRONOUN_PATTERN.test(valueText)) return '';
  return valueText
    .replace(/^(?:请问|帮我|帮忙|查一下|查询|看看|介绍一下)/u, '')
    .replace(/(?:目前|现在)?(?:有|都)?哪些(?:是)?/gu, '')
    .replace(/(?:目前|现在)?(?:在售|停售|销售中)的?/gu, '')
    .replace(/(?:的)?(?:这个)?(?:产品)?(?:保险责任|保障责任|责任|条款|优势|缺点|等待期|免责|保什么|有啥|是什么).*$/u, '')
    .replace(/\s+/gu, '')
    .trim().slice(0, 200);
}

function selectedCandidateIndex(value) {
  const match = String(value || '').trim().match(/^(?:选择|选|第)?\s*(\d{1,2})(?:\s*(?:个|项|款|号))?$/u);
  return match ? Number(match[1]) - 1 : -1;
}

export function createInMemoryAgentConversationContext() {
  const contexts = new Map();
  const key = ({ channelUserId, channelConversationId }) => `${channelUserId}:${channelConversationId || 'direct'}`;
  return {
    async loadContext(input) {
      const context = contexts.get(key(input));
      return context ? structuredClone(context) : {
        conversationId: key(input), version: 1, history: [], product: null, productCandidates: null, question: null,
      };
    },
    async commitContext(input) {
      const context = {
        conversationId: input.conversationRef || key(input),
        version: Number(input.expectedVersion || 1) + 1,
        history: input.history || [],
        product: input.product || null,
        productCandidates: input.productCandidates || null,
        question: input.question || null,
      };
      contexts.set(key(input), structuredClone(context));
      return context;
    },
  };
}

export function candidateFromText(text) {
  const asksForFamilyList = /(?:几|多少)(?:个|户)?家庭|家庭(?:总数|数量)/u.test(text);
  const familyName = asksForFamilyList ? '' : familyNameFromText(text);
  const familyEntities = familyName ? { entities: { familyName } } : {};
  let intent = 'chat';
  if (asksForFamilyList) intent = 'family_list';
  else if (/保障报告|保障分析|保障缺口/u.test(text)) intent = 'coverage_report';
  else if (/销售建议报告|销售报告/u.test(text)) intent = 'sales_report';
  else if (/销售建议|怎么(?:聊|沟通|跟进)|话术/u.test(text) && familyName) intent = 'sales_coaching';
  else if (/保单/u.test(text) && familyName) intent = 'family_summary';
  else if (/上传|录入/u.test(text) && /保单|资料/u.test(text)) intent = 'upload_link';
  else if (/产品|条款|保险责任|等待期|免责/iu.test(text) || PRODUCT_COMPARISON_PATTERN.test(text) || PRODUCT_DISCOVERY_PATTERN.test(text)) intent = 'insurance_product_knowledge';
  const productName = intent === 'insurance_product_knowledge' ? productNameFromText(text) : '';
  return {
    intent, question: text, confidence: 1, requestedOperation: 'read', ...familyEntities,
    ...(productName ? { entities: { productName } } : {}),
  };
}

function publicReply(payload) {
  const interaction = payload?.interaction || {};
  const lines = [];
  if (interaction.text) lines.push(String(interaction.text));
  if (Array.isArray(interaction.candidates)) {
    lines.push(...interaction.candidates.map((candidate, index) => `${index + 1}. ${candidate.label}`));
  }
  if (interaction.url) lines.push(String(interaction.url));
  return lines.filter(Boolean).join('\n') || '请求已处理。';
}

function markdownCells(line) {
  const value = String(line || '').trim();
  if (!value.includes('|')) return [];
  return value.replace(/^\|/u, '').replace(/\|$/u, '').split('|').map((cell) => cell.trim());
}

function markdownTableSeparator(cells) {
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s/gu, '')));
}

function mobileMarkdownTables(value) {
  const lines = String(value || '').replace(/\r\n?/gu, '\n').split('\n');
  const output = [];
  for (let index = 0; index < lines.length; index += 1) {
    const headers = markdownCells(lines[index]);
    const separator = markdownCells(lines[index + 1]);
    if (!headers.length || headers.length !== separator.length || !markdownTableSeparator(separator)) {
      output.push(lines[index]);
      continue;
    }
    index += 2;
    while (index < lines.length) {
      const cells = markdownCells(lines[index]);
      if (cells.length !== headers.length) break;
      if (headers.length === 2) {
        output.push(`- **${cells[0]}**：${cells[1]}`);
      } else {
        output.push(`#### ${cells[0] || headers[0]}`);
        for (let column = 1; column < headers.length; column += 1) {
          output.push(`- **${headers[column]}**：${cells[column]}`);
        }
      }
      output.push('');
      index += 1;
    }
    index -= 1;
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function safeMarkdownLinks(value) {
  return String(value || '').replace(/\[([^\]\n]{1,200})\]\(([^)\s]+)\)/gu, (matched, label, target) => {
    try {
      const url = new URL(target);
      return url.protocol === 'https:' && !url.username && !url.password ? matched : label;
    } catch {
      return label;
    }
  });
}

function circledNumber(value) {
  return ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'][Number(value) - 1] || String(value);
}

function responsibilityCardMarkdown(value) {
  const source = String(value || '').replace(/\r\n?/gu, '\n').trim();
  const count = source.match(RESPONSIBILITY_ANSWER_PATTERN)?.[1] || '';
  const output = ['### 🛡️ 保险责任助手', count ? `> 已生成 **${count} 项责任摘要**` : '', ''].filter(Boolean);
  let inResponsibilityCard = false;
  let cardCount = 0;
  for (const rawLine of source.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const detailHeading = line.match(/^### 责任明细（(\d+)项）$/u);
    if (detailHeading) {
      inResponsibilityCard = false;
      output.push('', `### 责任明细　${detailHeading[1]} 项`, '');
      continue;
    }
    const responsibilityTitle = line.match(/^(\d+)\.\s+\*\*([^*]+)\*\*$/u);
    if (responsibilityTitle) {
      if (cardCount) output.push('', '---', '');
      cardCount += 1;
      inResponsibilityCard = true;
      output.push(`> **${circledNumber(responsibilityTitle[1])}　${responsibilityTitle[2]}**`);
      continue;
    }
    if (/^###\s/u.test(line)) {
      inResponsibilityCard = false;
      output.push('', line.replace(/^###\s/u, '#### '), '');
      continue;
    }
    if (inResponsibilityCard) {
      if (line.startsWith('触发条件：')) output.push(`> **触发条件：** ${line.slice(5).trim()}`);
      else if (line.startsWith('calculationStatus:')) output.push(`> \`${line}\``);
      else if (line.startsWith('来源：')) output.push(`> **来源：** ${line.slice(3).split('、').map((item) => `\`${item.trim()}\``).join(' ')}`);
      else if (line.startsWith('计算所需保单信息：')) output.push(`> **所需保单信息：** ${line.slice(9).split('、').map((item) => `\`${item.trim()}\``).join(' ')}`);
      else if (/^给付/u.test(line)) output.push(`> **${line}**`);
      else output.push(`> ${line}`);
      continue;
    }
    if (/^[^#].*《[^》]+》：$/u.test(line)) output.push(`#### ${line.slice(0, -1)}`);
    else output.push(line);
  }
  return output.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function splitReplyText(value, limit = MAX_REPLY_TEXT_LENGTH) {
  const chunks = [];
  let remaining = String(value || '').trim();
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const boundaries = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n')]
      .filter((index) => index >= Math.floor(limit / 2));
    const boundary = boundaries.length ? Math.max(...boundaries) : limit;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function dingtalkReplyMessages({ payload, candidate, replyText }) {
  const interaction = payload?.interaction || {};
  const isComparison = candidate?.intent === 'insurance_product_knowledge' && PRODUCT_COMPARISON_PATTERN.test(candidate?.question || '');
  const isResponsibilityAnswer = RESPONSIBILITY_ANSWER_PATTERN.test(replyText);
  const useMarkdown = isComparison
    || isResponsibilityAnswer
    || MARKDOWN_CONTENT_PATTERN.test(replyText)
    || (interaction.type === 'clarification' && Array.isArray(interaction.candidates) && interaction.candidates.length > 0);
  if (!useMarkdown) {
    const chunks = splitReplyText(replyText, MAX_REPLY_TEXT_LENGTH - 40);
    return chunks.map((content, index) => ({
      msgtype: 'text',
      text: { content: index ? `（续 ${index + 1}/${chunks.length}）\n${content}` : content },
    }));
  }
  const title = isComparison
    ? '保险产品对比'
    : isResponsibilityAnswer
      ? '保险责任助手'
    : candidate?.intent === 'insurance_product_knowledge'
      ? '保险产品解读'
      : interaction.type === 'clarification'
        ? '请选择查询对象'
        : 'OCR Insurance';
  const renderedText = isResponsibilityAnswer ? responsibilityCardMarkdown(replyText) : mobileMarkdownTables(replyText);
  const markdown = safeMarkdownLinks(renderedText)
    .replace(/^#{1,2}\s+/gmu, '### ');
  const chunks = splitReplyText(markdown, MAX_REPLY_TEXT_LENGTH - 60);
  return chunks.map((text, index) => ({
    msgtype: 'markdown',
    markdown: {
      title: index ? `${title}（续 ${index + 1}/${chunks.length}）` : title,
      text: index ? `### ${title}（续 ${index + 1}/${chunks.length}）\n\n${text}` : text,
    },
  }));
}

function productNameFromReply(value) {
  return String(value || '').match(/《([^》\n]{2,200})》/u)?.[1]?.trim() || '';
}

function candidateProduct(value) {
  const label = String(value || '').trim();
  if (!label) return null;
  const productName = productNameFromReply(label) || label;
  const company = productNameFromReply(label) ? label.split('《', 1)[0].trim() : '';
  return { label, productName, company };
}

function errorReply(payload) {
  if (payload?.code === 'AGENT_REGISTRATION_REQUIRED') {
    const url = String(payload?.action?.url || '').trim();
    return url
      ? `当前钉钉手机号尚未注册或与平台账号不一致，请先登录/注册：${url}`
      : '当前钉钉手机号尚未注册或与平台账号不一致，请先在 OCR Insurance 网页完成注册。';
  }
  if (payload?.code === 'AGENT_RATE_LIMITED') return '请求较多，请稍后再试。';
  if (payload?.code === 'DINGTALK_POLICY_UPLOAD_DISABLED') {
    const url = String(payload?.action?.url || '').trim();
    return url ? `客户保单请通过安全网页上传：${url}` : '客户保单请通过 OCR Insurance 安全网页上传。';
  }
  return '服务暂时不可用，请稍后重试。';
}

export function createSignedAgentRequest({ secret, timestamp, body }) {
  const key = required(secret, 'AGENT_GATEWAY_HMAC_SECRET_REQUIRED');
  const timestampText = String(timestamp);
  const rawBody = JSON.stringify(body);
  const signature = createHmac('sha256', key).update(`${timestampText}.${rawBody}`).digest('hex');
  return {
    rawBody,
    headers: {
      'content-type': 'application/json',
      'x-agent-timestamp': timestampText,
      'x-agent-signature': signature,
    },
  };
}

export function createDingtalkAgentGateway({
  corpId,
  hmacSecret,
  apiBaseUrl = 'http://127.0.0.1:4207',
  fetchImpl = fetch,
  getDingtalkMobile,
  getRuntimeSettings,
  interpretQuestion,
  conversationContext = createInMemoryAgentConversationContext(),
  now = Date.now,
  createMessageRef = randomUUID,
  reportError = (code) => console.warn(`[dingtalk-agent-gateway] ${code}`),
  replyTimeoutMs = 8_000,
  progressDelayMs = 5_000,
  agentRequestTimeoutMs = 120_000,
  useMessagesApi = false,
} = {}) {
  const configuredCorpId = required(corpId, 'DINGTALK_CORP_ID_REQUIRED');
  const configuredSecret = required(hmacSecret, 'AGENT_GATEWAY_HMAC_SECRET_REQUIRED');
  const endpoint = `${String(apiBaseUrl).replace(/\/$/u, '')}/api/agent/questions/route`;
  const messagesEndpoint = `${String(apiBaseUrl).replace(/\/$/u, '')}/api/agent/messages`;
  const activeHandles = new Set();
  const activeRequestControllers = new Set();
  let draining = false;
  let shutdownPromise = null;

  async function reply(sessionWebhook, message) {
    const body = typeof message === 'string'
      ? { msgtype: 'text', text: { content: message } }
      : message;
    const url = required(sessionWebhook, 'DINGTALK_SESSION_WEBHOOK_REQUIRED');
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(replyTimeoutMs) || 8_000));
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw gatewayError('DINGTALK_REPLY_FAILED');
        const payload = await response.json().catch(() => ({}));
        if (Number(payload?.errcode || 0) !== 0) throw gatewayError('DINGTALK_REPLY_FAILED');
        return;
      } catch (error) {
        lastError = controller.signal.aborted ? gatewayError('DINGTALK_REPLY_TIMEOUT') : error;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError;
  }

  async function replyAll(sessionWebhook, messages) {
    for (const message of messages) await reply(sessionWebhook, message);
  }

  async function handleMessage(message) {
    const sessionWebhook = message?.sessionWebhook;
    if (String(message?.senderCorpId || '') !== configuredCorpId) return;
    if (String(message?.conversationType || '') !== DIRECT_CONVERSATION) {
      await reply(sessionWebhook, '当前仅支持与机器人单聊。');
      return;
    }
    const text = questionText(message);
    if (!text) {
      await reply(sessionWebhook, '客户保单请通过 OCR Insurance 安全网页上传；这里可以直接发送文字问题。');
      return;
    }

    try {
      if (typeof getDingtalkMobile !== 'function') throw gatewayError('DINGTALK_PROFILE_NOT_CONFIGURED', 503);
      const channelUserId = required(message?.senderStaffId, 'DINGTALK_SENDER_REQUIRED');
      const channelMobile = normalizeMobile(await getDingtalkMobile(channelUserId));
      if (!channelMobile) throw gatewayError('DINGTALK_MOBILE_UNAVAILABLE', 403);
      const conversationId = String(message?.conversationId || '').trim();
      const messageRef = String(message?.msgId || message?.messageId || createMessageRef());
      if (useMessagesApi) {
        const body = {
          protocolVersion: '1', channel: 'dingtalk', channelUserId, channelMobile, messageRef,
          ...(conversationId ? { conversationId } : {}),
          message: { type: 'text', text },
        };
        const signed = createSignedAgentRequest({ secret: configuredSecret, timestamp: now(), body });
        let progressPromise = null;
        const progressTimer = setTimeout(() => {
          progressPromise = reply(sessionWebhook, '正在理解并查询，请稍候…').catch((error) => {
            reportError(String(error?.code || 'DINGTALK_PROGRESS_REPLY_FAILED'));
          });
        }, Math.max(1, Number(progressDelayMs) || 5_000));
        const controller = new AbortController();
        activeRequestControllers.add(controller);
        const requestTimer = setTimeout(
          () => controller.abort(),
          Math.max(1_000, Number(agentRequestTimeoutMs) || 120_000),
        );
        let response;
        try {
          response = await fetchImpl(messagesEndpoint, {
            method: 'POST', signal: controller.signal, headers: signed.headers, body: signed.rawBody,
          });
        } catch (error) {
          if (controller.signal.aborted) throw gatewayError('DINGTALK_AGENT_REQUEST_TIMEOUT');
          throw error;
        } finally {
          clearTimeout(progressTimer);
          clearTimeout(requestTimer);
          activeRequestControllers.delete(controller);
          if (progressPromise) await progressPromise;
        }
        const payload = await response.json().catch(() => ({}));
        const replyText = response.ok ? publicReply(payload) : errorReply(payload);
        await replyAll(sessionWebhook, response.ok
          ? dingtalkReplyMessages({ payload, candidate: null, replyText })
          : [replyText]);
        return;
      }
      let runtimeSettings = DEFAULT_AGENT_RUNTIME_SETTINGS;
      if (typeof getRuntimeSettings === 'function') {
        try {
          runtimeSettings = normalizeAgentRuntimeSettings(await getRuntimeSettings({ messageRef }));
        } catch {
          reportError('DINGTALK_RUNTIME_CONFIG_FALLBACK');
        }
      }
      let context = { version: 1, history: [], product: null, productCandidates: null, question: null };
      try {
        context = await conversationContext.loadContext({
          channel: 'dingtalk', channelUserId, channelMobile,
          channelConversationId: conversationId || 'direct', messageRef,
          productContextTtlMinutes: runtimeSettings.productContextTtlMinutes,
        });
      } catch {
        reportError('DINGTALK_CONTEXT_LOAD_FALLBACK');
      }
      const history = Array.isArray(context?.history) ? context.history : [];
      const productContextTtlMs = runtimeSettings.productContextTtlMinutes * 60_000;
      const selectedIndex = selectedCandidateIndex(text);
      const rememberedCandidates = context?.productCandidates;
      const rememberedQuestion = context?.question;
      const selectedProduct = selectedIndex >= 0
        && rememberedCandidates
        && now() - rememberedCandidates.updatedAt <= productContextTtlMs
        ? candidateProduct(rememberedCandidates.products[selectedIndex])
        : null;
      let candidate;
      if (selectedProduct) {
        candidate = {
          intent: 'insurance_product_knowledge', question: rememberedCandidates.question || text, confidence: 1, requestedOperation: 'read',
          entities: {
            productName: selectedProduct.productName,
            ...(selectedProduct.company ? { productCompany: selectedProduct.company } : {}),
          },
        };
      } else if (
        UNDERSTANDING_CHALLENGE_PATTERN.test(text)
        && rememberedQuestion
        && now() - rememberedQuestion.updatedAt <= productContextTtlMs
      ) {
        candidate = rememberedQuestion.candidate;
      } else if (typeof interpretQuestion === 'function') {
        try {
          candidate = await interpretQuestion({ question: text, history, recentMessageLimit: runtimeSettings.fallbackHistoryMessageLimit });
        } catch {
          reportError('DINGTALK_INTERPRETER_FALLBACK');
          candidate = candidateFromText(text);
        }
      } else {
        candidate = candidateFromText(text);
      }
      if (PRODUCT_COMPARISON_PATTERN.test(text) && candidate?.intent !== 'insurance_product_knowledge') {
        candidate = candidateFromText(text);
      }
      const rememberedProduct = context?.product;
      const rememberedComparisonProductName = rememberedProduct
        && now() - rememberedProduct.updatedAt <= productContextTtlMs
        ? rememberedProduct.productName
          : rememberedQuestion
          && now() - rememberedQuestion.updatedAt <= productContextTtlMs
          ? String(rememberedQuestion.candidate?.entities?.productName || '').trim()
          : '';
      if (
        candidate?.intent === 'insurance_product_knowledge'
        && PRODUCT_COMPARISON_PATTERN.test(text)
        && COMPARISON_PRODUCT_PRONOUN_PATTERN.test(text)
        && rememberedComparisonProductName
      ) {
        candidate = {
          ...candidate,
          question: text.replace(COMPARISON_PRODUCT_PRONOUN_PATTERN, rememberedComparisonProductName),
        };
      }
      if (
        candidate?.intent === 'insurance_product_knowledge'
        && PRODUCT_SCOPE_FOLLOWUP_PATTERN.test(text)
        && !candidate?.entities?.productName
        && rememberedQuestion?.candidate?.intent === 'insurance_product_knowledge'
        && rememberedQuestion?.candidate?.entities?.productName
      ) {
        candidate = {
          ...candidate,
          entities: { ...(candidate.entities || {}), productName: rememberedQuestion.candidate.entities.productName },
        };
      }
      if (
        candidate?.intent === 'insurance_product_knowledge'
        && PRODUCT_PRONOUN_PATTERN.test(text)
        && rememberedProduct
        && now() - rememberedProduct.updatedAt <= productContextTtlMs
      ) {
        candidate = {
          ...candidate,
          entities: { ...(candidate.entities || {}), productName: rememberedProduct.productName },
        };
      }
      const body = {
        channel: 'dingtalk',
        channelUserId,
        channelMobile,
        messageRef,
        ...(conversationId ? { conversationId } : {}),
        candidate,
      };
      const signed = createSignedAgentRequest({ secret: configuredSecret, timestamp: now(), body });
      const response = await fetchImpl(endpoint, { method: 'POST', headers: signed.headers, body: signed.rawBody });
      const payload = await response.json().catch(() => ({}));
      const replyText = response.ok ? publicReply(payload) : errorReply(payload);
      if (response.ok) {
        let nextQuestion = rememberedQuestion || null;
        let nextProduct = rememberedProduct || null;
        let nextProductCandidates = rememberedCandidates || null;
        if (!UNDERSTANDING_CHALLENGE_PATTERN.test(text) && candidate?.intent !== 'chat') {
          nextQuestion = { candidate, updatedAt: now() };
        }
        if (payload?.interaction?.type === 'clarification' && Array.isArray(payload.interaction.candidates)) {
          const products = payload.interaction.candidates.map((item) => String(item?.label || '').trim()).filter(Boolean);
          if (products.length) {
            nextProductCandidates = { products, question: text, updatedAt: now() };
            nextProduct = null;
          }
        } else {
          const canonicalProductName = productNameFromReply(replyText);
          if (canonicalProductName) {
            nextProduct = { productName: canonicalProductName, updatedAt: now() };
            nextProductCandidates = null;
          } else if (selectedProduct) {
            nextProductCandidates = null;
          }
        }
        const nextHistory = [...history,
          { role: 'user', content: text },
          { role: 'assistant', content: replyText },
        ].slice(-runtimeSettings.fallbackHistoryMessageLimit);
        try {
          await conversationContext.commitContext({
            channel: 'dingtalk', channelUserId, channelMobile,
            channelConversationId: conversationId || 'direct', messageRef,
            conversationRef: String(context?.conversationId || ''),
            expectedVersion: Number(context?.version || 1), history: nextHistory,
            product: nextProduct, productCandidates: nextProductCandidates, question: nextQuestion,
            productContextTtlMinutes: runtimeSettings.productContextTtlMinutes, updatedAt: now(),
          });
        } catch {
          reportError('DINGTALK_CONTEXT_COMMIT_FAILED');
        }
      }
      await replyAll(sessionWebhook, response.ok
        ? dingtalkReplyMessages({ payload, candidate, replyText })
        : [replyText]);
    } catch (error) {
      reportError(String(error?.code || 'DINGTALK_AGENT_REQUEST_FAILED'));
      if (/^DINGTALK_REPLY_/u.test(String(error?.code || ''))) throw error;
      if (draining) {
        await reply(sessionWebhook, '服务正在更新，本次查询已中断，请稍后重新发送。');
        return;
      }
      await reply(sessionWebhook, error?.code === 'DINGTALK_MOBILE_UNAVAILABLE'
        ? '无法读取当前钉钉手机号，请确认企业已授权成员手机号权限。'
        : '服务暂时不可用，请稍后重试。');
    }
  }

  async function handle(message) {
    if (draining) {
      await reply(message?.sessionWebhook, '服务正在更新，请稍后重新发送。');
      return;
    }
    const task = handleMessage(message);
    activeHandles.add(task);
    try {
      await task;
    } finally {
      activeHandles.delete(task);
    }
  }

  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    draining = true;
    shutdownPromise = (async () => {
      for (const controller of activeRequestControllers) controller.abort();
      await Promise.allSettled([...activeHandles]);
    })();
    return shutdownPromise;
  }

  return { handle, shutdown };
}
