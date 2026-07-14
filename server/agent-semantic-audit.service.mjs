import {
  SEMANTIC_INTENTS,
  SEMANTIC_MENTION_TYPES,
  SEMANTIC_QUERY_ASPECTS,
  SEMANTIC_REFERENCE_TYPES,
} from './agent-semantic-contract.mjs';

const RUNTIMES = new Set(['hermes', 'direct', 'rule']);
const OPERATIONS = new Set(['read', 'write']);
const DECISIONS = new Set(['execute', 'clarify', 'reject', 'retry_later']);
const PHASES = new Set(['semantic_resolution', 'semantic_error', 'persistence_error']);
const ENTITY_TYPES = ['product', 'family'];
const ENTITY_STATUSES = new Set(['resolved', 'ambiguous', 'not_found', 'missing', 'unknown']);
const MATCH_TYPES = new Set([
  'exact_official_name', 'filing_name', 'approved_alias', 'company_scoped_normalized',
  'unique_high_confidence', 'exact', 'contextual', 'ambiguous', 'not_found', 'unknown',
]);
const REASONS = new Set([
  'semantic_ready', 'unique_authorized_entity', 'entity_ambiguous', 'product_required',
  'family_required', 'low_intent_confidence', 'semantic_proposal_unavailable',
  'unsupported_intent', 'unsupported_runtime', 'unsupported_operation',
  'unsafe_fallback_operation', 'candidate_selection_expired', 'entity_resolver_unavailable',
  'semantic_load_failed', 'semantic_resolution_failed', 'semantic_validation_failed',
  'semantic_persistence_failed', 'unknown',
]);

function controlled(value, allowed, fallback = 'unknown') {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function confidence(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function controlledTypes(entries, allowed) {
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries
    .map((entry) => controlled(entry?.type, allowed, ''))
    .filter(Boolean))].slice(0, 8);
}

function controlledList(value, allowed, limit = 8) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && allowed.has(item)))].slice(0, limit);
}

function candidateCount(resolution, entityType) {
  const candidates = resolution?.nextTaskState?.candidateSets?.[entityType];
  return Array.isArray(candidates) ? Math.min(10, candidates.length) : 0;
}

function entityProjection(resolution, entityType) {
  const entity = resolution?.resolvedEntities?.[entityType];
  const candidates = candidateCount(resolution, entityType);
  const ambiguous = Array.isArray(resolution?.ambiguities)
    && resolution.ambiguities.includes(entityType);
  const missing = Array.isArray(resolution?.missingFields)
    && resolution.missingFields.includes(entityType);
  if (!entity && !candidates && !ambiguous && !missing) return null;
  const status = entity ? 'resolved' : ambiguous || candidates ? 'ambiguous' : missing ? 'missing' : 'unknown';
  return {
    status: controlled(status, ENTITY_STATUSES),
    matchType: controlled(entity?.matchType, MATCH_TYPES),
    confidence: confidence(entity?.confidence),
    hasCanonicalId: entityType === 'product'
      && typeof entity?.canonicalProductId === 'string'
      && entity.canonicalProductId.trim().length > 0,
  };
}

function safeErrorCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,80}$/u.test(value) ? value : '';
}

function projectPayload({ runtime, proposal, resolution, phase, errorCode }) {
  const normalizedRuntime = controlled(runtime, RUNTIMES);
  const intent = controlled(proposal?.intent, new Set(SEMANTIC_INTENTS));
  const operation = controlled(proposal?.operation, OPERATIONS);
  const decision = controlled(resolution?.decision, DECISIONS, 'retry_later');
  const decisionReason = controlled(resolution?.decisionReason, REASONS);
  const resolvedEntityTypes = {};
  for (const entityType of ENTITY_TYPES) {
    const projected = entityProjection(resolution, entityType);
    if (projected) resolvedEntityTypes[entityType] = projected;
  }
  return {
    semanticContractVersion: proposal?.semanticContractVersion === 1 ? 1 : null,
    runtime: normalizedRuntime,
    phase: controlled(phase, PHASES, 'semantic_error'),
    errorCode: safeErrorCode(errorCode),
    intent,
    operation,
    queryAspects: controlledList(proposal?.queryAspects, new Set(SEMANTIC_QUERY_ASPECTS)),
    confidence: {
      intent: confidence(proposal?.confidence?.intent),
      mentions: confidence(proposal?.confidence?.mentions),
      references: confidence(proposal?.confidence?.references),
    },
    mentionTypes: controlledTypes(proposal?.mentions, new Set(SEMANTIC_MENTION_TYPES)),
    referenceTypes: controlledTypes(proposal?.references, new Set(SEMANTIC_REFERENCE_TYPES)),
    resolvedEntityTypes,
    candidateCounts: {
      product: candidateCount(resolution, 'product'),
      family: candidateCount(resolution, 'family'),
    },
    decision,
    decisionReason,
    missingFields: controlledList(resolution?.missingFields, new Set(ENTITY_TYPES)),
    ambiguities: controlledList(resolution?.ambiguities, new Set(ENTITY_TYPES)),
  };
}

export function createAgentSemanticAuditService({ store, clock = Date.now } = {}) {
  if (typeof store?.recordAgentSemanticAudit !== 'function') {
    throw new TypeError('store.recordAgentSemanticAudit is required');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  return {
    async record({
      internalUserId,
      messageRef,
      runtime,
      proposal = null,
      resolution = null,
      phase = 'semantic_resolution',
      errorCode = '',
    } = {}) {
      const nowValue = clock();
      const createdAt = nowValue instanceof Date ? nowValue.getTime() : nowValue;
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new TypeError('clock must return a safe timestamp');
      }
      const payload = projectPayload({ runtime, proposal, resolution, phase, errorCode });
      return store.recordAgentSemanticAudit({
        userId: internalUserId,
        messageRef,
        runtime: payload.runtime,
        intent: payload.intent,
        operation: payload.operation,
        decision: payload.decision,
        decisionReason: payload.decisionReason,
        createdAt,
        payload,
      });
    },
  };
}
