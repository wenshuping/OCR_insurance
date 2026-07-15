import { randomUUID } from 'node:crypto';

const DEFAULT_TENANT_ID = 'default';

function requiredText(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function validUserId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new TypeError('internalUserId is required');
  return id;
}

function validTtlMinutes(value) {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1_440) {
    throw new TypeError('productContextTtlMinutes must be an integer between 1 and 1440');
  }
  return minutes;
}

function isFresh(value, asOf, ttlMs) {
  return value && Number.isFinite(Number(value.updatedAt)) && asOf - Number(value.updatedAt) <= ttlMs;
}

export function createAgentConversationContextService({ store, clock = Date.now, createId = randomUUID } = {}) {
  if (!store || typeof store.resolveAgentConversation !== 'function'
    || typeof store.findAgentConversation !== 'function'
    || typeof store.loadAgentConversationContext !== 'function'
    || typeof store.saveAgentConversationContext !== 'function') {
    throw new TypeError('Agent conversation context store is required');
  }

  function identity(input = {}) {
    return {
      tenantId: requiredText(input.tenantId || DEFAULT_TENANT_ID, 'tenantId'),
      channel: requiredText(input.channel, 'channel'),
      channelUserId: requiredText(input.channelUserId, 'channelUserId'),
      channelConversationId: requiredText(input.channelConversationId || 'direct', 'channelConversationId'),
      internalUserId: validUserId(input.internalUserId),
    };
  }

  async function resolve(input = {}) {
    return store.resolveAgentConversation({
      id: createId(),
      ...identity(input),
      now: new Date(Number(clock())).toISOString(),
    });
  }

  async function loadContext(input = {}) {
    const conversation = await resolve(input);
    const stored = await store.loadAgentConversationContext({ conversationId: conversation.id });
    const asOf = Number(input.asOf ?? clock());
    const ttlMs = validTtlMinutes(input.productContextTtlMinutes) * 60_000;
    return {
      conversationId: conversation.id,
      version: Number(stored?.version || conversation.contextVersion || 1),
      hermesSessionId: String(stored?.hermesSessionId || ''),
      agentLoopSessionId: String(stored?.agentLoopSessionId || ''),
      history: Array.isArray(stored?.history) ? stored.history : [],
      product: isFresh(stored?.product, asOf, ttlMs) ? stored.product : null,
      productCandidates: isFresh(stored?.productCandidates, asOf, ttlMs) ? stored.productCandidates : null,
      question: isFresh(stored?.question, asOf, ttlMs) ? stored.question : null,
    };
  }

  async function commitContext(input = {}) {
    const conversation = await store.findAgentConversation(identity(input));
    const conversationRef = requiredText(input.conversationRef, 'conversationRef');
    if (!conversation || conversation.id !== conversationRef) {
      const error = new Error('AGENT_CONVERSATION_IDENTITY_CHANGED');
      error.code = 'AGENT_CONVERSATION_IDENTITY_CHANGED';
      error.status = 409;
      throw error;
    }
    const updatedAt = Number(input.updatedAt ?? clock());
    const ttlMinutes = validTtlMinutes(input.productContextTtlMinutes);
    return store.saveAgentConversationContext({
      conversationId: conversation.id,
      expectedVersion: Number(input.expectedVersion || conversation.contextVersion || 1),
      history: Array.isArray(input.history) ? input.history : [],
      hermesSessionId: String(input.hermesSessionId || '').trim().slice(0, 200),
      agentLoopSessionId: String(input.agentLoopSessionId || '').trim().slice(0, 200),
      product: input.product || null,
      productCandidates: input.productCandidates || null,
      question: input.question || null,
      updatedAt,
      activeContextExpiresAt: new Date(updatedAt + ttlMinutes * 60_000).toISOString(),
    });
  }

  return { loadContext, commitContext };
}
