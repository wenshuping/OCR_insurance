import express from 'express';

const ATTACHMENT_FIELDS = new Set([
  'attachment', 'attachments', 'file', 'files', 'image', 'images', 'pdf', 'document', 'documents',
  'media', 'mediaUrl', 'downloadUrl', 'fileUrl', 'contentBase64', 'base64',
]);
const CANDIDATE_FIELDS = new Set([
  'intent', 'question', 'confidence', 'requestedOperation', 'entities', 'contextRefs',
]);
const UNTRUSTED_AUTHORITY_FIELDS = new Set(['userId', 'internalUserId', 'familyId', 'permissions']);
const BASE_BODY_FIELDS = new Set(['channel', 'channelUserId', 'messageRef', 'conversationId', 'candidate']);

function text(value, maxLength) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized.length <= maxLength ? normalized : '';
}

function safeAction(secureUploadLinkFactory, input) {
  let url = '';
  try {
    url = text(secureUploadLinkFactory?.(input), 2048);
  } catch {
    // A missing link must not weaken authentication or identity checks.
  }
  return { type: 'secure_link', ...(url ? { url } : {}) };
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

function normalizeBaseBody(body, { requireCandidate = false } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (Object.keys(body).some((key) => !BASE_BODY_FIELDS.has(key) && !UNTRUSTED_AUTHORITY_FIELDS.has(key))) return null;
  const channel = text(body.channel, 20).toLowerCase();
  const channelUserId = text(body.channelUserId, 200);
  const messageRef = text(body.messageRef, 200);
  const conversationId = body.conversationId === undefined ? '' : text(body.conversationId, 200);
  if (!channel || !channelUserId || !messageRef || (body.conversationId !== undefined && !conversationId)) return null;
  const candidate = requireCandidate ? normalizeCandidate(body.candidate) : undefined;
  if (requireCandidate && !candidate) return null;
  return { channel, channelUserId, messageRef, conversationId, candidate };
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
  secureUploadLinkFactory,
  maxBodyBytes = 16 * 1024,
} = {}) {
  const router = express.Router();

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

  async function resolveIdentity(input, res) {
    let identity = null;
    try {
      identity = typeof resolveChannelIdentity === 'function'
        ? await resolveChannelIdentity({ channel: input.channel, channelUserId: input.channelUserId })
        : null;
    } catch {
      identity = null;
    }
    const internalUserId = Number(identity?.internalUserId);
    if (!Number.isInteger(internalUserId) || internalUserId <= 0) {
      send(res, 403, 'AGENT_REGISTRATION_REQUIRED', {
        action: safeAction(secureUploadLinkFactory, { purpose: 'register_or_login', channel: input.channel }),
      });
      return null;
    }
    return internalUserId;
  }

  async function prepare(req, res, options) {
    if (!await authenticate(req, res)) return null;
    if (rawBodyBytes(req) > maxBodyBytes) {
      send(res, 413, 'AGENT_REQUEST_TOO_LARGE');
      return null;
    }
    if (hasAttachmentField(req.body)) {
      send(res, 400, 'DINGTALK_POLICY_UPLOAD_DISABLED', {
        action: safeAction(secureUploadLinkFactory, { purpose: 'policy_upload', channel: 'dingtalk' }),
      });
      return null;
    }
    const input = normalizeBaseBody(req.body, options);
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
      res.json({ ok: true, ...result });
    } catch (error) {
      if (Number(error?.status) === 429) {
        send(res, 429, text(error?.code, 80) || 'AGENT_RATE_LIMITED');
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
      res.json({ ok: true, ...result });
    } catch (error) {
      if (Number(error?.status) === 429) {
        send(res, 429, text(error?.code, 80) || 'AGENT_RATE_LIMITED');
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

  return router;
}
