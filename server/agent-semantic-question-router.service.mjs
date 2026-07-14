import { SEMANTIC_INTENTS, SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';
import { projectAgentSemanticTaskState } from './agent-semantic-conversation.service.mjs';

const QUERY_ASPECTS = new Set(SEMANTIC_QUERY_ASPECTS);
const RESOLVER_DECISIONS = new Set(['execute', 'clarify', 'reject', 'retry_later']);
const CONFLICT_CODE = 'AGENT_SEMANTIC_CONVERSATION_CONFLICT';
const LEGACY_CANDIDATE_FIELDS = new Set([
  'intent', 'question', 'confidence', 'requestedOperation', 'entities', 'contextRefs',
]);
const AUTHORITY_ENTITY_KEYS = new Set([
  'authority', 'authorizedResourceIds', 'familyId', 'internalUserId', 'permissions',
  'resolvedEntities', 'userId',
]);

function clean(value, limit = 200) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= limit ? normalized : '';
}

function stableRetry() {
  return {
    decision: 'clarify',
    interaction: { type: 'clarification', text: '语义解析暂不可用，请稍后重试。' },
  };
}

function productCandidates(result) {
  const candidates = Array.isArray(result?.nextTaskState?.candidateSets?.product)
    ? result.nextTaskState.candidateSets.product.slice(0, 10)
    : [];
  return candidates.map((candidate, index) => ({
    ref: `choice_${index + 1}`,
    label: clean(candidate?.officialName) || `候选产品 ${index + 1}`,
  })).filter((candidate) => candidate.label);
}

function familyCandidates(result) {
  const candidates = Array.isArray(result?.nextTaskState?.candidateSets?.family)
    ? result.nextTaskState.candidateSets.family.slice(0, 10)
    : [];
  return candidates.map((_candidate, index) => ({
    ref: `choice_${index + 1}`,
    label: `候选家庭 ${index + 1}`,
  }));
}

function clarification(result, hasConversation) {
  const reason = clean(result?.decisionReason, 100);
  if (reason === 'entity_ambiguous' && result?.ambiguities?.includes('product')) {
    const candidates = productCandidates(result);
    return {
      decision: 'clarify',
      interaction: {
        type: 'clarification',
        text: hasConversation
          ? '找到多个可能的正式产品，请选择一项。'
          : '找到多个可能的正式产品，请回复完整名称。',
        ...(candidates.length ? { candidates } : {}),
      },
    };
  }
  if (reason === 'entity_ambiguous' && result?.ambiguities?.includes('family')) {
    const candidates = familyCandidates(result);
    return {
      decision: 'clarify',
      interaction: {
        type: 'clarification',
        text: hasConversation
          ? '找到多个已授权家庭，请选择一项。'
          : '找到多个已授权家庭，请回复完整名称。',
        ...(candidates.length ? { candidates } : {}),
      },
    };
  }
  if (reason === 'candidate_selection_expired') {
    return {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '之前的候选已过期，请重新说明要查询的对象。' },
    };
  }
  if (result?.missingFields?.includes('product') || reason === 'product_required') {
    return {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '请补充保险公司和保险产品的正式名称。' },
    };
  }
  if (result?.missingFields?.includes('family') || reason === 'family_required') {
    return {
      decision: 'clarify',
      interaction: { type: 'clarification', text: '请说明要查看哪个家庭。' },
    };
  }
  return {
    decision: 'clarify',
    interaction: { type: 'clarification', text: '请更明确地说明要查询的事项。' },
  };
}

function projectProduct(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const officialName = clean(value.officialName);
  const company = clean(value.company);
  const canonicalProductId = clean(value.canonicalProductId);
  if (!officialName || !company) return null;
  return { canonicalProductId, company, officialName };
}

function semanticContext(result) {
  const product = projectProduct(result?.resolvedEntities?.product);
  const queryAspects = (Array.isArray(result?.proposal?.queryAspects)
    ? result.proposal.queryAspects : [])
    .filter((value) => typeof value === 'string' && QUERY_ASPECTS.has(value));
  return {
    resolvedEntities: { ...(product ? { product } : {}) },
    queryAspects: [...new Set(queryAspects)].slice(0, 8),
  };
}

function stateChanged(previous, next) {
  return JSON.stringify(previous || {}) !== JSON.stringify(next || {});
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function projectTaskState(value) {
  if (!isPlainObject(value)) return null;
  try {
    JSON.stringify(value);
    return projectAgentSemanticTaskState(value);
  } catch {
    return null;
  }
}

function projectExecuteCandidate(candidate, proposal) {
  if (!isPlainObject(candidate) || !isPlainObject(proposal) || !isPlainObject(proposal.confidence)
    || Object.keys(candidate).some((key) => !LEGACY_CANDIDATE_FIELDS.has(key))) return null;
  const intent = clean(candidate.intent, 80);
  const question = clean(candidate.question, 1_000);
  const operation = clean(candidate.requestedOperation, 20);
  const confidence = candidate.confidence;
  if (!SEMANTIC_INTENTS.includes(intent) || intent !== proposal.intent || !question
    || !['read', 'write'].includes(operation) || operation !== proposal.operation
    || typeof confidence !== 'number' || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || confidence !== proposal.confidence.intent) return null;

  const projected = { intent, question, confidence, requestedOperation: operation };
  if (candidate.entities !== undefined) {
    if (!isPlainObject(candidate.entities) || Object.keys(candidate.entities).length > 12) return null;
    const entities = {};
    for (const [rawKey, rawValue] of Object.entries(candidate.entities)) {
      const key = clean(rawKey, 40);
      const value = clean(rawValue, 200);
      if (!key || key !== rawKey || AUTHORITY_ENTITY_KEYS.has(key) || !value
        || typeof rawValue !== 'string' || Object.hasOwn(entities, key)) return null;
      entities[key] = value;
    }
    projected.entities = entities;
  }
  if (candidate.contextRefs !== undefined) {
    if (!Array.isArray(candidate.contextRefs) || candidate.contextRefs.length > 10) return null;
    const contextRefs = candidate.contextRefs.map((value) => clean(value, 100));
    if (contextRefs.some((value, index) => !value || value !== candidate.contextRefs[index])) return null;
    projected.contextRefs = contextRefs;
  }
  return projected;
}

function normalizedResolution(value) {
  if (!isPlainObject(value) || !RESOLVER_DECISIONS.has(value.decision)) return null;
  const candidate = value.decision === 'execute'
    ? projectExecuteCandidate(value.candidate, value.proposal)
    : null;
  if (value.decision === 'execute' && !candidate) return null;
  const nextTaskState = projectTaskState(value.nextTaskState);
  return nextTaskState ? { ...value, ...(candidate ? { candidate } : {}), nextTaskState } : null;
}

function persistenceError(error) {
  const code = clean(error?.code, 80) || 'UNKNOWN';
  return { code, conflict: code === CONFLICT_CODE };
}

export function createAgentSemanticQuestionRouter({
  legacyRouter,
  semanticResolver,
  conversationService,
  onPersistenceError,
} = {}) {
  if (typeof legacyRouter?.route !== 'function') throw new TypeError('legacyRouter.route is required');
  if (typeof semanticResolver?.resolve !== 'function') throw new TypeError('semanticResolver.resolve is required');
  if (typeof conversationService?.load !== 'function'
    || typeof conversationService?.save !== 'function') {
    throw new TypeError('conversationService load/save is required');
  }

  async function loadConversation(input) {
    try {
      const conversation = await conversationService.load({
        internalUserId: input.internalUserId,
        channel: 'dingtalk',
        conversationId: input.conversationId,
      });
      const taskState = projectTaskState(conversation?.taskState);
      if (!Number.isSafeInteger(conversation?.version) || conversation.version < 0 || !taskState) return null;
      return { version: conversation.version, taskState };
    } catch {
      return null;
    }
  }

  async function resolve(input, conversation) {
    try {
      return normalizedResolution(await semanticResolver.resolve({
        internalUserId: input.internalUserId,
        question: input.question,
        runtime: input.runtime,
        proposal: input.proposal,
        context: { taskState: conversation.taskState },
      }));
    } catch {
      return null;
    }
  }

  async function save(input, conversation, taskState) {
    return conversationService.save({
      internalUserId: input.internalUserId,
      channel: 'dingtalk',
      conversationId: input.conversationId,
      expectedVersion: conversation.version,
      taskState,
    });
  }

  async function reportPostExecutePersistenceError(error) {
    if (typeof onPersistenceError !== 'function') return;
    try {
      await onPersistenceError({ ...persistenceError(error), phase: 'post_execute' });
    } catch {
      // Observability hooks must not change an already completed read result.
    }
  }

  async function processSemantic(input, conversation, { retryConflict }) {
    const resolved = await resolve(input, conversation);
    if (!resolved) return stableRetry();
    const shouldSave = stateChanged(conversation.taskState, resolved.nextTaskState);

    if (resolved.decision !== 'execute') {
      if (shouldSave) {
        try {
          await save(input, conversation, resolved.nextTaskState);
        } catch (error) {
          if (persistenceError(error).conflict && retryConflict) {
            const reloaded = await loadConversation(input);
            return reloaded
              ? processSemantic(input, reloaded, { retryConflict: false })
              : stableRetry();
          }
          return stableRetry();
        }
      }
      if (resolved.decision === 'retry_later') return stableRetry();
      if (resolved.decision === 'reject') {
        return { decision: 'deny', interaction: { type: 'denied', text: '该请求不能执行。' } };
      }
      return clarification(resolved, Boolean(clean(input.conversationId, 200)));
    }

    const result = await legacyRouter.route({
      internalUserId: input.internalUserId,
      messageRef: input.messageRef,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      candidate: resolved.candidate,
      semanticContext: semanticContext(resolved),
    });
    if (shouldSave) {
      try {
        await save(input, conversation, resolved.nextTaskState);
      } catch (error) {
        await reportPostExecutePersistenceError(error);
      }
    }
    return result;
  }

  return {
    async route(input = {}) {
      if (input.candidate) return legacyRouter.route(input);

      const conversation = await loadConversation(input);
      if (!conversation) return stableRetry();
      return processSemantic(input, conversation, { retryConflict: true });
    },
  };
}
