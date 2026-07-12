import crypto from 'node:crypto';
import express from 'express';
import { sendError } from '../http/errors.mjs';
import { sanitizePublicContent } from '../privacy/public-content.service.mjs';

function fail(code, status) { throw Object.assign(new Error(code), { code, status }); }

export function createAdvisorMemoryConfirmationRoutes({ state, authenticateDingtalkServiceRequest, advisorMemoryConfirmationService }) {
  const router = express.Router();
  router.post('/', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (typeof authenticateDingtalkServiceRequest !== 'function' || !await authenticateDingtalkServiceRequest(req)) fail('SERVICE_AUTH_REQUIRED', 401);
      const body = req.body || {};
      const allowed = new Set(['corpId', 'dingUserId', 'conversationType', 'eventType', 'interactionId', 'familyId', 'memoryId', 'expectedVersion', 'action', 'reasonCode', 'replacement']);
      if (Object.keys(body).some((key) => !allowed.has(key)) || body.conversationType !== 'direct' || body.eventType !== 'card_action') fail('INVALID_CARD_CALLBACK', 400);
      const identities = (state.userDingtalkIdentities || []).filter((identity) => identity.corpId === body.corpId && identity.dingUserId === body.dingUserId && identity.status === 'active');
      if (identities.length !== 1) fail('IDENTITY_NOT_BOUND', 403);
      const ownerUserId = Number(identities[0].userId);
      const user = (state.users || []).find((item) => Number(item.id) === ownerUserId && item.status === 'active');
      const family = (state.familyProfiles || []).find((item) => Number(item.id) === Number(body.familyId) && Number(item.ownerUserId) === ownerUserId && String(item.status || 'active') === 'active');
      const memory = (state.familySalesMemories || []).find((item) => Number(item.id) === Number(body.memoryId) && Number(item.familyId) === Number(body.familyId) && Number(item.ownerUserId) === ownerUserId);
      if (!user || !family || !memory || Number(memory.version || 1) !== Number(body.expectedVersion)) fail('MEMORY_NOT_FOUND', 404);
      const replacement = body.replacement ? { content: sanitizePublicContent(body.replacement.content).content } : null;
      const replacementHash = crypto.createHash('sha256').update(JSON.stringify(replacement)).digest('hex');
      const issued = advisorMemoryConfirmationService.issue({ ownerUserId, corpId: body.corpId, dingUserId: body.dingUserId, familyId: Number(body.familyId), memoryId: Number(body.memoryId),
        expectedVersion: Number(body.expectedVersion), action: body.action, reasonCode: body.reasonCode, replacementHash, interactionId: body.interactionId });
      return res.json({ ok: true, confirmationToken: issued.token, expiresAt: issued.expiresAt, interactionId: issued.interactionId });
    } catch (error) { return sendError(res, error); }
  });
  return router;
}
