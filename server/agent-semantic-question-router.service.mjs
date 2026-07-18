import {
  normalizeSemanticProposal,
  SEMANTIC_CONTRACT_VERSION,
  SEMANTIC_INTENTS,
  SEMANTIC_QUERY_ASPECTS,
} from './agent-semantic-contract.mjs';
import { projectAgentSemanticTaskState } from './agent-semantic-conversation.service.mjs';
import {
  AGENT_SEMANTIC_AUDIT_FALLBACK_REASONS,
  normalizeAgentSemanticPersistenceErrorCode,
} from './agent-semantic-audit-contract.mjs';
import { preparseAgentMessage } from './agent-semantic-preparser.mjs';

const QUERY_ASPECTS = new Set(SEMANTIC_QUERY_ASPECTS);
const FALLBACK_REASONS = new Set(AGENT_SEMANTIC_AUDIT_FALLBACK_REASONS);
const RESOLVER_DECISIONS = new Set(['execute', 'clarify', 'reject', 'retry_later']);
const CONFLICT_CODE = 'AGENT_SEMANTIC_CONVERSATION_CONFLICT';
const LEGACY_CANDIDATE_FIELDS = new Set([
  'intent', 'question', 'confidence', 'requestedOperation', 'entities', 'contextRefs',
]);
const AUTHORITY_ENTITY_KEYS = new Set([
  'authority', 'authorizedResourceIds', 'familyId', 'internalUserId', 'permissions',
  'resolvedEntities', 'userId',
]);
const RULE_UPLOAD_PROPOSAL = Object.freeze({
  semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
  intent: 'upload_link',
  operation: 'read',
  queryAspects: Object.freeze(['upload']),
  mentions: Object.freeze([]),
  references: Object.freeze([]),
  requestedSteps: Object.freeze(['upload']),
  confidence: Object.freeze({ intent: 1, mentions: 1, references: 1 }),
});

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

function resolveFallbackReason(input, preparsed) {
  if ((preparsed.candidateSelection || preparsed.candidateRejection) && !input.proposal) {
    return 'candidate_selection';
  }
  const explicit = clean(input.fallbackReason, 40);
  if (input.runtime === 'rule') {
    if (['direct_unavailable', 'direct_invalid_output'].includes(explicit)) return explicit;
    if (preparsed.operationHint === 'upload_link' && (!explicit || explicit === 'rule_preparse')) {
      return 'rule_preparse';
    }
    return !explicit || explicit === 'none' ? 'none' : 'invalid_runtime_fallback';
  }
  if (input.runtime === 'direct') {
    return ['hermes_unavailable', 'hermes_invalid_output'].includes(explicit)
      ? explicit
      : 'invalid_runtime_fallback';
  }
  return !explicit || explicit === 'none' ? 'none' : 'invalid_runtime_fallback';
}

function productCandidates(result, { includeOnlineSearch = false } = {}) {
  const candidates = Array.isArray(result?.nextTaskState?.candidateSets?.product)
    ? result.nextTaskState.candidateSets.product.slice(0, 10)
    : [];
  const projected = candidates.map((candidate, index) => ({
      ref: `choice_${index + 1}`,
      label: clean(candidate?.officialName)
        ? `${clean(candidate?.company) ? `${clean(candidate.company)} ` : ''}《${clean(candidate.officialName)}》`
        : `候选产品 ${index + 1}`,
    })).filter((candidate) => candidate.label);
  return includeOnlineSearch
    ? [...projected, { ref: 'search_online', label: '以上都不是，联网查询' }]
    : projected;
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
    const candidates = productCandidates(result, { includeOnlineSearch: true });
    const productChoiceCount = candidates.filter((candidate) => candidate.ref !== 'search_online').length;
    return {
      decision: 'clarify',
      interaction: {
        type: 'clarification',
        text: hasConversation
          ? productChoiceCount === 0
            ? '本地产品库暂未找到匹配项，可选择“以上都不是，联网查询”继续查找。'
            : productChoiceCount === 1
            ? '你是不是想查询以下产品？请选择；如果不是，请选择“以上都不是，联网查询”。'
            : '找到多个可能的正式产品，请选择一项；如果都不是，请选择最后一项联网查询。'
          : productChoiceCount
            ? '找到多个可能的正式产品，请回复完整名称。'
            : '本地产品库暂未找到匹配项，请回复“都不是”联网查询。',
        ...(hasConversation ? { candidates } : {}),
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
  if (reason === 'product_comparison_unsupported') {
    const candidates = productCandidates(result);
    const selectedCount = Array.isArray(result?.nextTaskState?.pendingClarification?.selectedProducts)
      ? result.nextTaskState.pendingClarification.selectedProducts.length
      : 0;
    return {
      decision: 'clarify',
      interaction: {
        type: 'clarification',
        text: candidates.length
          ? selectedCount > 0
            ? '已确认第一款产品，请选择要比较的第二款。'
            : '找到多个可能的正式产品，请先选择要比较的第一款。'
          : result?.proposal?.queryAspects?.includes('sales_guidance')
            ? '你想在具体哪些产品之间为客户做选择？请回复产品正式名称；确认产品后，我会再根据保障目标、预算、期限、已有保障及必要的投保条件补充提问。'
            : '目前无法唯一确定两款产品，请补充保险公司或回复两款产品的正式名称，我会继续比较。',
        ...(candidates.length ? { candidates } : {}),
      },
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
  const products = Array.isArray(result?.resolvedEntities?.products)
    && result.resolvedEntities.products.length === 2
    ? result.resolvedEntities.products.map(projectProduct)
    : [];
  const queryAspects = (Array.isArray(result?.proposal?.queryAspects)
    ? result.proposal.queryAspects : [])
    .filter((value) => typeof value === 'string' && QUERY_ASPECTS.has(value));
  return {
    resolvedEntities: {
      ...(product ? { product } : {}),
      ...(products.length === 2 && products.every(Boolean) ? { products } : {}),
    },
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

function projectExecuteCandidate(candidate, proposal, expectedQuestion) {
  if (!isPlainObject(candidate) || !isPlainObject(proposal) || !isPlainObject(proposal.confidence)
    || Object.keys(candidate).some((key) => !LEGACY_CANDIDATE_FIELDS.has(key))) return null;
  const intent = clean(candidate.intent, 80);
  const question = clean(candidate.question, 1_000);
  const operation = clean(candidate.requestedOperation, 20);
  const confidence = candidate.confidence;
  if (!SEMANTIC_INTENTS.includes(intent) || intent !== proposal.intent || question !== expectedQuestion
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

function normalizedResolution(value, {
  expectedProposal,
  inputQuestion,
  originalTaskState,
  pendingSelection,
  proposalQuestion,
}) {
  if (!isPlainObject(value) || !RESOLVER_DECISIONS.has(value.decision)) return null;
  const expiredSelection = pendingSelection
    && value.decision === 'clarify'
    && value.decisionReason === 'candidate_selection_expired'
    && (value.proposal === null || value.proposal === undefined);
  let proposal = null;
  if (value.proposal !== null && value.proposal !== undefined) {
    if (!expectedProposal) return null;
    try {
      proposal = normalizeSemanticProposal(value.proposal, proposalQuestion);
    } catch {
      return null;
    }
  }
  if (expectedProposal && !expiredSelection
    && JSON.stringify(proposal) !== JSON.stringify(expectedProposal)) return null;
  const candidate = value.decision === 'execute'
    ? projectExecuteCandidate(
      value.candidate,
      proposal,
      pendingSelection ? proposalQuestion : inputQuestion,
    )
    : null;
  if (value.decision === 'execute' && !candidate) return null;
  const nextTaskState = projectTaskState(value.nextTaskState);
  if (expiredSelection) {
    const cleared = projectTaskState({
      ...originalTaskState,
      candidateSets: { product: [], family: [] },
      pendingClarification: null,
    });
    if (!nextTaskState || stateChanged(cleared, nextTaskState)) return null;
  }
  if (!expectedProposal && (value.decision === 'execute'
    || !nextTaskState || stateChanged(originalTaskState, nextTaskState))) return null;
  return nextTaskState
    ? { ...value, proposal, ...(candidate ? { candidate } : {}), nextTaskState }
    : null;
}

function persistenceError(error) {
  const code = normalizeAgentSemanticPersistenceErrorCode(clean(error?.code, 80) || 'UNKNOWN');
  return { code, conflict: code === CONFLICT_CODE };
}

export function createAgentSemanticQuestionRouter({
  legacyRouter,
  semanticResolver,
  conversationService,
  auditService,
  onPersistenceError,
} = {}) {
  if (typeof legacyRouter?.route !== 'function') throw new TypeError('legacyRouter.route is required');
  if (typeof semanticResolver?.resolve !== 'function') throw new TypeError('semanticResolver.resolve is required');
  if (typeof conversationService?.load !== 'function'
    || typeof conversationService?.save !== 'function') {
    throw new TypeError('conversationService load/save is required');
  }
  const auditAvailable = typeof auditService?.record === 'function';

  async function audit(input, proposal, resolution, phase = 'semantic_resolution', errorCode = '') {
    if (!auditAvailable) return false;
    try {
      await auditService.record({
        internalUserId: input.internalUserId,
        messageRef: input.messageRef,
        runtime: input.runtime,
        fallbackReason: input.fallbackReason || 'none',
        proposal,
        resolution,
        phase,
        errorCode,
      });
      return true;
    } catch {
      return false;
    }
  }

  function errorResolution(decisionReason) {
    return {
      decision: 'retry_later',
      decisionReason,
      missingFields: [],
      ambiguities: [],
      resolvedEntities: {},
      nextTaskState: {},
    };
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

  async function resolve(input, conversation, trustedInputProposal) {
    try {
      const preparsed = preparseAgentMessage(input.question);
      const pending = !trustedInputProposal
        && (preparsed.candidateSelection || preparsed.candidateRejection)
        ? conversation.taskState?.pendingClarification
        : null;
      const pendingProposal = pending?.proposal || null;
      const expectedProposal = trustedInputProposal
        || pendingProposal
        || (input.runtime === 'rule' && preparsed.operationHint === 'upload_link'
          ? RULE_UPLOAD_PROPOSAL
          : null);
      const proposalQuestion = pendingProposal
        ? pending.originalQuestion
        : input.question;
      const rawResolution = await semanticResolver.resolve({
        internalUserId: input.internalUserId,
        question: input.question,
        runtime: input.runtime,
        proposal: pendingProposal ? trustedInputProposal : expectedProposal,
        context: { taskState: conversation.taskState },
      });
      const normalized = normalizedResolution(rawResolution, {
        expectedProposal,
        inputQuestion: input.question,
        originalTaskState: conversation.taskState,
        pendingSelection: Boolean(pendingProposal),
        proposalQuestion,
      });
      return normalized
        ? { resolution: normalized, errorReason: '' }
        : { resolution: null, errorReason: 'semantic_validation_failed' };
    } catch {
      return { resolution: null, errorReason: 'semantic_resolution_failed' };
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

  async function auditPersistenceError(input, resolved, error, { postExecute = false } = {}) {
    const classified = persistenceError(error);
    const auditResolution = postExecute
      ? { ...resolved, decisionReason: 'semantic_persistence_failed' }
      : {
        ...resolved,
        decision: 'retry_later',
        decisionReason: 'semantic_persistence_failed',
        missingFields: [],
        ambiguities: [],
        candidate: null,
      };
    await audit(
      input,
      auditResolution?.proposal,
      auditResolution,
      'persistence_error',
      classified.code,
    );
    return classified;
  }

  async function processSemantic(input, conversation, trustedInputProposal, {
    retryConflict,
    primaryAuditRecorded = false,
    conflictRetry = false,
  }) {
    const outcome = await resolve(input, conversation, trustedInputProposal);
    const resolved = outcome.resolution;
    if (!resolved) {
      await audit(
        input,
        trustedInputProposal,
        errorResolution(outcome.errorReason),
        'semantic_error',
        outcome.errorReason === 'semantic_validation_failed'
          ? 'SEMANTIC_RESULT_INVALID'
          : 'SEMANTIC_RESOLUTION_FAILED',
      );
      return stableRetry();
    }
    if (conflictRetry) {
      const retryFinal = resolved.decision === 'execute'
        ? {
          ...resolved,
          decision: 'retry_later',
          decisionReason: 'conflict_retry_execute_blocked',
          missingFields: [],
          ambiguities: [],
          candidate: null,
        }
        : resolved;
      if (!await audit(input, retryFinal.proposal, retryFinal, 'semantic_retry_final')) return stableRetry();
      if (resolved.decision === 'execute') return stableRetry();
    } else if (!primaryAuditRecorded && !await audit(input, resolved.proposal, resolved)) {
      return stableRetry();
    }
    const shouldSave = stateChanged(conversation.taskState, resolved.nextTaskState);

    if (resolved.decision !== 'execute') {
      if (shouldSave) {
        try {
          await save(input, conversation, resolved.nextTaskState);
        } catch (error) {
          const classified = await auditPersistenceError(input, resolved, error);
          if (classified.conflict && retryConflict) {
            const reloaded = await loadConversation(input);
            if (!reloaded) {
              await audit(
                input,
                resolved.proposal,
                {
                  ...resolved,
                  decision: 'retry_later',
                  decisionReason: 'semantic_load_failed',
                  missingFields: [],
                  ambiguities: [],
                  candidate: null,
                },
                'semantic_retry_final',
                'SEMANTIC_LOAD_FAILED',
              );
              return stableRetry();
            }
            return processSemantic(input, reloaded, trustedInputProposal, {
              retryConflict: false,
              primaryAuditRecorded: true,
              conflictRetry: true,
            });
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

    const resolvedSemanticContext = semanticContext(resolved);
    const result = await legacyRouter.route({
      internalUserId: input.internalUserId,
      messageRef: input.messageRef,
      conversationHistory: input.conversationHistory,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      candidate: resolved.candidate,
      semanticContext: resolvedSemanticContext,
    });
    if (shouldSave) {
      try {
        await save(input, conversation, resolved.nextTaskState);
      } catch (error) {
        await auditPersistenceError(input, resolved, error, { postExecute: true });
        await reportPostExecutePersistenceError(error);
      }
    }
    return { ...result, semanticContext: resolvedSemanticContext };
  }

  return {
    async route(input = {}) {
      if (input.candidate) return legacyRouter.route(input);

      if (!auditAvailable) return stableRetry();

      const question = clean(input.question, 1_000);
      if (!question) {
        await audit(
          input,
          null,
          errorResolution('semantic_validation_failed'),
          'semantic_error',
          'SEMANTIC_INPUT_INVALID',
        );
        return stableRetry();
      }
      let trustedInputProposal = null;
      if (input.proposal !== null && input.proposal !== undefined) {
        try {
          trustedInputProposal = normalizeSemanticProposal(input.proposal, question);
        } catch {
          await audit(
            { ...input, question },
            null,
            errorResolution('semantic_validation_failed'),
            'semantic_error',
            'SEMANTIC_PROPOSAL_INVALID',
          );
          return stableRetry();
        }
      }
      const preparsed = preparseAgentMessage(question);
      const localRuleRuntime = Boolean(
        (preparsed.candidateSelection || preparsed.candidateRejection) && !trustedInputProposal,
      )
        || (!trustedInputProposal && preparsed.operationHint === 'upload_link' && input.runtime === 'hermes');
      const runtimeInput = localRuleRuntime
        ? {
          ...input,
          runtime: 'rule',
          fallbackReason: (preparsed.candidateSelection || preparsed.candidateRejection)
            && !trustedInputProposal
            ? 'candidate_selection' : 'rule_preparse',
        }
        : input;
      const fallbackReason = resolveFallbackReason(runtimeInput, preparsed);
      if (!FALLBACK_REASONS.has(fallbackReason)) {
        await audit(
          { ...runtimeInput, question, fallbackReason: 'none' },
          trustedInputProposal,
          errorResolution('semantic_validation_failed'),
          'semantic_error',
          'SEMANTIC_INPUT_INVALID',
        );
        return stableRetry();
      }
      const normalizedInput = { ...runtimeInput, question, fallbackReason };
      const conversation = await loadConversation(normalizedInput);
      if (!conversation) {
        await audit(
          normalizedInput,
          trustedInputProposal,
          errorResolution('semantic_load_failed'),
          'semantic_error',
          'SEMANTIC_CONVERSATION_LOAD_FAILED',
        );
        return stableRetry();
      }
      return processSemantic(normalizedInput, conversation, trustedInputProposal, { retryConflict: true });
    },
  };
}
