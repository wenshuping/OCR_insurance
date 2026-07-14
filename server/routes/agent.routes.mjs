import express from 'express';

import { DEFAULT_AGENT_RUNTIME_SETTINGS, normalizeAgentRuntimeSettings } from '../agent-question-policy.service.mjs';

const ATTACHMENT_FIELDS = new Set([
  'attachment', 'attachments', 'file', 'files', 'image', 'images', 'pdf', 'document', 'documents',
  'media', 'mediaUrl', 'downloadUrl', 'fileUrl', 'contentBase64', 'base64',
]);
const CANDIDATE_FIELDS = new Set([
  'intent', 'question', 'confidence', 'requestedOperation', 'entities', 'contextRefs',
]);
const UNTRUSTED_AUTHORITY_FIELDS = new Set(['userId', 'internalUserId', 'familyId', 'permissions']);
const QUESTION_BODY_FIELDS = new Set(['channel', 'channelUserId', 'channelMobile', 'messageRef', 'conversationId', 'candidate']);
const CONFIRM_BODY_FIELDS = new Set(['channel', 'channelUserId', 'channelMobile', 'messageRef', 'conversationId']);
const CONTEXT_LOAD_BODY_FIELDS = new Set([...CONFIRM_BODY_FIELDS, 'productContextTtlMinutes']);
const CONTEXT_COMMIT_BODY_FIELDS = new Set([...CONTEXT_LOAD_BODY_FIELDS, 'conversationRef', 'expectedVersion', 'context']);
const MESSAGE_BODY_FIELDS = new Set(['protocolVersion', 'channel', 'channelUserId', 'channelMobile', 'messageRef', 'conversationId', 'message']);
const PUBLIC_DECISIONS = new Set(['execute', 'clarify', 'confirm', 'deny', 'open_web']);
const PUBLIC_INTERACTIONS = new Set(['answer', 'clarification', 'confirmation', 'progress', 'secure_link', 'denied']);
const SECURE_LINK_ACTIONS = new Set(['open_web', 'register_or_login', 'policy_upload']);

function text(value, maxLength) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : '';
}

function safeLink(value, allowedOrigins) {
  const raw = text(value, 2048);
  if (!raw || raw.includes('\\') || /%5c/iu.test(raw) || raw.startsWith('//')) return '';
  try {
    const trustedBases = (Array.isArray(allowedOrigins) ? allowedOrigins : []).map((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol === 'https:' && !url.username && !url.password ? `${url.origin}/` : '';
      } catch {
        return '';
      }
    }).filter(Boolean);
    if (!trustedBases.length) return '';
    const isRelative = raw.startsWith('/');
    const url = new URL(raw, trustedBases[0]);
    const origins = new Set(trustedBases.map((base) => new URL(base).origin));
    if (url.protocol !== 'https:' || url.username || url.password || !origins.has(url.origin)) return '';
    return isRelative ? `${url.pathname}${url.search}${url.hash}` : url.toString();
  } catch {
    return '';
  }
}

function safeAction(secureUploadLinkFactory, allowedOrigins, input) {
  let url = '';
  try {
    url = safeLink(secureUploadLinkFactory?.(input), allowedOrigins);
  } catch {
    // A missing link must not weaken authentication or identity checks.
  }
  return { type: 'secure_link', ...(url ? { url } : {}) };
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return undefined;
  const options = value.slice(0, 20).map((option) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) return null;
    const id = text(option.id, 100);
    const label = text(option.label, 200);
    const ref = text(option.ref, 200);
    if (!id || !label) return null;
    return { id, label, ...(ref ? { ref } : {}) };
  }).filter(Boolean);
  return options.length ? options : undefined;
}

function normalizeCandidates(value) {
  if (!Array.isArray(value)) return undefined;
  const candidates = value.slice(0, 20).map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const ref = text(candidate.ref, 200);
    const label = text(candidate.label, 200);
    return ref && label ? { ref, label } : null;
  }).filter(Boolean);
  return candidates.length ? candidates : undefined;
}

function normalizeInteraction(interaction, type, allowedOrigins) {
  const interactionText = typeof interaction?.text === 'string'
    ? interaction.text.trim().slice(0, 2000)
    : '';
  const normalized = { type, ...(interactionText ? { text: interactionText } : {}) };
  if (type === 'clarification') {
    const candidates = normalizeCandidates(interaction?.candidates);
    return { ...normalized, ...(candidates ? { candidates } : {}) };
  }
  if (type === 'secure_link') {
    const url = safeLink(interaction?.url, allowedOrigins);
    const action = SECURE_LINK_ACTIONS.has(interaction?.action) ? interaction.action : '';
    return { ...normalized, ...(url ? { url } : {}), ...(action ? { action } : {}) };
  }
  if (type === 'confirmation') {
    const confirmationId = text(interaction?.confirmationId, 200);
    const summary = text(interaction?.summary, 500);
    const options = normalizeOptions(interaction?.options);
    return {
      ...normalized,
      ...(confirmationId ? { confirmationId } : {}),
      ...(summary ? { summary } : {}),
      ...(options ? { options } : {}),
    };
  }
  if (type === 'progress') {
    const jobId = text(interaction?.jobId, 200);
    const status = text(interaction?.status, 40);
    const message = text(interaction?.message, 500);
    const progress = Number(interaction?.progress);
    return {
      ...normalized,
      ...(jobId ? { jobId } : {}),
      ...(status ? { status } : {}),
      ...(message ? { message } : {}),
      ...(Number.isFinite(progress) && progress >= 0 && progress <= 100 ? { progress } : {}),
    };
  }
  return normalized;
}

function normalizePublicResult(result, allowedOrigins) {
  const decision = PUBLIC_DECISIONS.has(result?.decision) ? result.decision : 'deny';
  const interactionType = PUBLIC_INTERACTIONS.has(result?.interaction?.type)
    ? result.interaction.type
    : 'denied';
  const requestRef = text(result?.requestRef, 200);
  const confirmationId = text(result?.confirmationId, 200);
  return {
    decision,
    interaction: normalizeInteraction(result?.interaction, interactionType, allowedOrigins),
    ...(requestRef ? { requestRef } : {}),
    ...(confirmationId ? { confirmationId } : {}),
  };
}

function send(res, status, code, extra = {}) {
  return res.status(status).json({ ok: false, code, ...extra });
}

function hasAttachmentField(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 3) return false;
  if (Array.isArray(value)) return value.some((item) => hasAttachmentField(item, depth + 1));
  return Object.entries(value).some(([key, nested]) => (
    ATTACHMENT_FIELDS.has(key) || hasAttachmentField(nested, depth + 1)
  ));
}

function normalizeCandidate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !CANDIDATE_FIELDS.has(key) && !UNTRUSTED_AUTHORITY_FIELDS.has(key))) return null;
  const intent = text(value.intent, 80);
  const question = text(value.question, 1000);
  const requestedOperation = text(value.requestedOperation, 20);
  const confidence = Number(value.confidence);
  if (!intent || !question || !requestedOperation || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const candidate = { intent, question, confidence, requestedOperation };
  if (value.entities !== undefined) {
    if (!value.entities || typeof value.entities !== 'object' || Array.isArray(value.entities)) return null;
    const entries = Object.entries(value.entities);
    if (entries.length > 12 || entries.some(([key, item]) => !text(key, 40) || !text(item, 200))) return null;
    candidate.entities = Object.fromEntries(entries.map(([key, item]) => [key.trim(), item.trim()]));
  }
  if (value.contextRefs !== undefined) {
    if (!Array.isArray(value.contextRefs) || value.contextRefs.length > 10) return null;
    const refs = value.contextRefs.map((item) => text(item, 100));
    if (refs.some((item) => !item)) return null;
    candidate.contextRefs = refs;
  }
  return candidate;
}

function normalizeBaseBody(body, { requireCandidate = false, allowedFields } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const fields = allowedFields || (requireCandidate ? QUESTION_BODY_FIELDS : CONFIRM_BODY_FIELDS);
  if (Object.keys(body).some((key) => !fields.has(key) && !UNTRUSTED_AUTHORITY_FIELDS.has(key))) return null;
  const channel = text(body.channel, 20).toLowerCase();
  const channelUserId = text(body.channelUserId, 200);
  const channelMobile = body.channelMobile === undefined ? '' : text(body.channelMobile, 40);
  const messageRef = text(body.messageRef, 200);
  const conversationId = body.conversationId === undefined ? '' : text(body.conversationId, 200);
  if (!channel || !channelUserId || !messageRef || (body.channelMobile !== undefined && !channelMobile) || (body.conversationId !== undefined && !conversationId)) return null;
  const candidate = requireCandidate ? normalizeCandidate(body.candidate) : undefined;
  if (requireCandidate && !candidate) return null;
  return { channel, channelUserId, channelMobile, messageRef, conversationId, candidate };
}

function normalizeMessageBody(body) {
  const base = normalizeBaseBody(body, { allowedFields: MESSAGE_BODY_FIELDS });
  if (!base || body.protocolVersion !== '1' || !body.message || typeof body.message !== 'object'
    || Array.isArray(body.message) || Object.keys(body.message).some((key) => !['type', 'text'].includes(key))
    || body.message.type !== 'text') return null;
  const messageText = text(body.message.text, 1_000);
  return messageText ? { ...base, message: { type: 'text', text: messageText } } : null;
}

function normalizeConversationContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['history', 'product', 'productCandidates', 'question', 'hermesSessionId', 'updatedAt'].includes(key))) return null;
  const history = Array.isArray(value.history) ? value.history.slice(-40).map((message) => {
    const role = ['user', 'assistant'].includes(message?.role) ? message.role : '';
    const content = text(message?.content, 2_000);
    return role && content ? { role, content } : null;
  }).filter(Boolean) : [];
  const remembered = (item) => {
    if (item == null) return null;
    const productName = text(item?.productName, 200);
    const updatedAt = Number(item?.updatedAt);
    return productName && Number.isFinite(updatedAt) ? { productName, updatedAt } : undefined;
  };
  const product = remembered(value.product);
  if (product === undefined) return null;
  let productCandidates = null;
  if (value.productCandidates != null) {
    const products = Array.isArray(value.productCandidates?.products)
      ? value.productCandidates.products.slice(0, 20).map((item) => text(item, 200)).filter(Boolean)
      : [];
    const question = text(value.productCandidates?.question, 1_000);
    const updatedAt = Number(value.productCandidates?.updatedAt);
    if (!products.length || !question || !Number.isFinite(updatedAt)) return null;
    productCandidates = { products, question, updatedAt };
  }
  let question = null;
  if (value.question != null) {
    const candidate = normalizeCandidate(value.question?.candidate);
    const updatedAt = Number(value.question?.updatedAt);
    if (!candidate || !Number.isFinite(updatedAt)) return null;
    question = { candidate, updatedAt };
  }
  const updatedAt = Number(value.updatedAt);
  const hermesSessionId = value.hermesSessionId === undefined ? '' : text(value.hermesSessionId, 200);
  if (value.hermesSessionId !== undefined && !hermesSessionId) return null;
  return Number.isFinite(updatedAt) ? { history, product, productCandidates, question, hermesSessionId, updatedAt } : null;
}

function rawBodyBytes(req) {
  if (typeof req.rawBody === 'string') return Buffer.byteLength(req.rawBody);
  return Buffer.byteLength(JSON.stringify(req.body || {}));
}

export function createAgentRouter({
  questionRouter,
  confirmationService,
  resolveChannelIdentity,
  verifyAgentServiceRequest,
  getRuntimeSettings,
  conversationContext,
  conversationRuntime,
  secureUploadLinkFactory,
  secureLinkAllowedOrigins = [],
  maxBodyBytes: requestedMaxBodyBytes = 16 * 1024,
} = {}) {
  const router = express.Router();
  const maxBodyBytes = Math.min(16 * 1024, Math.max(1, Number(requestedMaxBodyBytes) || 16 * 1024));
  router.use(express.json({
    limit: maxBodyBytes,
    verify(req, _res, buffer) { req.rawBody = buffer.toString('utf8'); },
  }));
  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large' || Number(error?.status) === 413) {
      send(res, 413, 'AGENT_REQUEST_TOO_LARGE');
      return;
    }
    if (error instanceof SyntaxError || error?.type === 'entity.parse.failed') {
      send(res, 400, 'AGENT_REQUEST_SCHEMA_INVALID');
      return;
    }
    next(error);
  });

  async function authenticate(req, res) {
    let valid = false;
    try {
      valid = typeof verifyAgentServiceRequest === 'function'
        && await verifyAgentServiceRequest(req) === true;
    } catch {
      valid = false;
    }
    if (!valid) send(res, 401, 'AGENT_SERVICE_UNAUTHORIZED');
    return valid;
  }

  async function lookupIdentity(input) {
    let identity = null;
    try {
      identity = typeof resolveChannelIdentity === 'function'
        ? await resolveChannelIdentity({ channel: input.channel, channelUserId: input.channelUserId, channelMobile: input.channelMobile })
        : null;
    } catch {
      identity = null;
    }
    const internalUserId = Number(identity?.internalUserId);
    return Number.isInteger(internalUserId) && internalUserId > 0 ? { internalUserId } : null;
  }

  async function resolveIdentity(input, res) {
    const identity = await lookupIdentity(input);
    const internalUserId = Number(identity?.internalUserId);
    if (!Number.isInteger(internalUserId) || internalUserId <= 0) {
      send(res, 403, 'AGENT_REGISTRATION_REQUIRED', {
        action: safeAction(secureUploadLinkFactory, secureLinkAllowedOrigins, { purpose: 'register_or_login', channel: input.channel }),
      });
      return null;
    }
    return internalUserId;
  }

  router.post('/runtime-config', async (req, res) => {
    if (!await authenticate(req, res)) return;
    if (rawBodyBytes(req) > maxBodyBytes) {
      send(res, 413, 'AGENT_REQUEST_TOO_LARGE');
      return;
    }
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['channel', 'messageRef'].includes(key))
      || text(body.channel, 20).toLowerCase() !== 'dingtalk'
      || !text(body.messageRef, 200)) {
      send(res, 400, 'AGENT_REQUEST_SCHEMA_INVALID');
      return;
    }
    try {
      const configured = typeof getRuntimeSettings === 'function' ? await getRuntimeSettings() : null;
      res.json({ ok: true, runtimeSettings: normalizeAgentRuntimeSettings(configured || DEFAULT_AGENT_RUNTIME_SETTINGS) });
    } catch {
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
    }
  });

  async function prepare(req, res, options = {}) {
    if (!await authenticate(req, res)) return null;
    if (rawBodyBytes(req) > maxBodyBytes) {
      send(res, 413, 'AGENT_REQUEST_TOO_LARGE');
      return null;
    }
    if (hasAttachmentField(req.body)) {
      send(res, 400, 'DINGTALK_POLICY_UPLOAD_DISABLED', {
        action: safeAction(secureUploadLinkFactory, secureLinkAllowedOrigins, { purpose: 'policy_upload', channel: 'dingtalk' }),
      });
      return null;
    }
    const input = typeof options.normalizeInput === 'function'
      ? options.normalizeInput(req.body)
      : normalizeBaseBody(req.body, options);
    if (!input) {
      send(res, 400, 'AGENT_REQUEST_SCHEMA_INVALID');
      return null;
    }
    if (input.channel !== 'dingtalk') {
      send(res, 400, 'AGENT_CHANNEL_UNSUPPORTED');
      return null;
    }
    const internalUserId = await resolveIdentity(input, res);
    return internalUserId ? { ...input, internalUserId } : null;
  }

  router.post('/messages', async (req, res) => {
    const input = await prepare(req, res, { normalizeInput: normalizeMessageBody });
    if (!input) return;
    if (!conversationRuntime || typeof conversationRuntime.processMessage !== 'function') {
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
      return;
    }
    try {
      const configured = typeof getRuntimeSettings === 'function' ? await getRuntimeSettings() : null;
      const result = await conversationRuntime.processMessage({
        verifiedIdentity: { tenantId: 'default', internalUserId: input.internalUserId },
        channelEnvelope: {
          protocolVersion: '1', channel: input.channel, channelUserId: input.channelUserId,
          conversationId: input.conversationId || 'direct', messageRef: input.messageRef,
          message: input.message,
        },
        runtimeSettings: normalizeAgentRuntimeSettings(configured || DEFAULT_AGENT_RUNTIME_SETTINGS),
        refreshVerifiedIdentity: () => lookupIdentity(input),
      });
      res.json({ ok: true, ...normalizePublicResult(result, secureLinkAllowedOrigins) });
    } catch (error) {
      if (Number(error?.status) === 409) {
        send(res, 409, 'AGENT_CONVERSATION_IDENTITY_CHANGED');
        return;
      }
      if (Number(error?.status) === 429) {
        send(res, 429, 'AGENT_RATE_LIMITED');
        return;
      }
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
    }
  });

  router.post('/conversation-context/load', async (req, res) => {
    const input = await prepare(req, res, { allowedFields: CONTEXT_LOAD_BODY_FIELDS });
    const ttlMinutes = Number(req.body?.productContextTtlMinutes);
    if (!input) return;
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1_440) {
      send(res, 400, 'AGENT_REQUEST_SCHEMA_INVALID');
      return;
    }
    try {
      const context = await conversationContext.loadContext({
        tenantId: 'default', channel: input.channel, channelUserId: input.channelUserId,
        channelConversationId: input.conversationId || 'direct', internalUserId: input.internalUserId,
        productContextTtlMinutes: ttlMinutes,
      });
      res.json({ ok: true, context });
    } catch {
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
    }
  });

  router.post('/conversation-context/commit', async (req, res) => {
    const input = await prepare(req, res, { allowedFields: CONTEXT_COMMIT_BODY_FIELDS });
    const ttlMinutes = Number(req.body?.productContextTtlMinutes);
    const expectedVersion = Number(req.body?.expectedVersion);
    const conversationRef = text(req.body?.conversationRef, 200);
    const context = normalizeConversationContext(req.body?.context);
    if (!input) return;
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1_440
      || !conversationRef || !Number.isInteger(expectedVersion) || expectedVersion <= 0 || !context) {
      send(res, 400, 'AGENT_REQUEST_SCHEMA_INVALID');
      return;
    }
    try {
      const committed = await conversationContext.commitContext({
        tenantId: 'default', channel: input.channel, channelUserId: input.channelUserId,
        channelConversationId: input.conversationId || 'direct', internalUserId: input.internalUserId,
        productContextTtlMinutes: ttlMinutes, conversationRef, expectedVersion, ...context,
      });
      res.json({ ok: true, context: committed });
    } catch (error) {
      if (Number(error?.status) === 409) {
        send(res, 409, error?.code === 'AGENT_CONVERSATION_IDENTITY_CHANGED'
          ? 'AGENT_CONVERSATION_IDENTITY_CHANGED'
          : 'AGENT_CONVERSATION_VERSION_CONFLICT');
        return;
      }
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
    }
  });

  router.post('/questions/route', async (req, res) => {
    const input = await prepare(req, res, { requireCandidate: true });
    if (!input) return;
    if (!questionRouter || typeof questionRouter.route !== 'function') {
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
      return;
    }
    try {
      const result = await questionRouter.route({
        internalUserId: input.internalUserId,
        messageRef: input.messageRef,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        candidate: input.candidate,
      });
      res.json({ ok: true, ...normalizePublicResult(result, secureLinkAllowedOrigins) });
    } catch (error) {
      if (Number(error?.status) === 429) {
        send(res, 429, 'AGENT_RATE_LIMITED');
        return;
      }
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
    }
  });

  router.post('/actions/:confirmationId/confirm', async (req, res) => {
    const input = await prepare(req, res);
    if (!input) return;
    const confirmationId = text(req.params.confirmationId, 200);
    if (!confirmationId) {
      send(res, 400, 'AGENT_REQUEST_SCHEMA_INVALID');
      return;
    }
    if (!confirmationService || typeof confirmationService.confirm !== 'function') {
      send(res, 501, 'AGENT_CONFIRMATION_NOT_SUPPORTED');
      return;
    }
    try {
      const result = await confirmationService.confirm({
        confirmationId,
        internalUserId: input.internalUserId,
        messageRef: input.messageRef,
        channel: input.channel,
      });
      res.json({ ok: true, ...normalizePublicResult(result, secureLinkAllowedOrigins) });
    } catch (error) {
      if (Number(error?.status) === 429) {
        send(res, 429, 'AGENT_RATE_LIMITED');
        return;
      }
      const status = Number(error?.status);
      if (status === 403 || status === 404 || error?.code === 'AGENT_CONFIRMATION_NOT_OWNED') {
        send(res, 403, 'AGENT_CONFIRMATION_FORBIDDEN');
        return;
      }
      send(res, 502, 'AGENT_GATEWAY_UPSTREAM_ERROR');
    }
  });

  router.use((error, _req, res, next) => {
    if (error?.type === 'entity.too.large' || Number(error?.status) === 413) {
      send(res, 413, 'AGENT_REQUEST_TOO_LARGE');
      return;
    }
    if (error instanceof URIError || error instanceof SyntaxError || error?.type === 'entity.parse.failed') {
      send(res, 400, 'AGENT_REQUEST_SCHEMA_INVALID');
      return;
    }
    next(error);
  });

  return router;
}
