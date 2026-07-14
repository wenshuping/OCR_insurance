import {
  SEMANTIC_INTENTS,
  SEMANTIC_MENTION_TYPES,
  SEMANTIC_QUERY_ASPECTS,
  SEMANTIC_REFERENCE_TYPES,
} from './agent-semantic-contract.mjs';

export const AGENT_SEMANTIC_AUDIT_FALLBACK_REASONS = Object.freeze([
  'none',
  'hermes_unavailable',
  'hermes_invalid_output',
  'direct_unavailable',
  'direct_invalid_output',
  'rule_preparse',
  'candidate_selection',
]);

const RUNTIMES = new Set(['hermes', 'direct', 'rule', 'unknown']);
const INTENTS = new Set([...SEMANTIC_INTENTS, 'unknown']);
const OPERATIONS = new Set(['read', 'write', 'unknown']);
const DECISIONS = new Set(['execute', 'clarify', 'reject', 'retry_later']);
const PHASES = new Set(['semantic_resolution', 'semantic_error', 'persistence_error']);
const FALLBACK_REASONS = new Set(AGENT_SEMANTIC_AUDIT_FALLBACK_REASONS);
const QUERY_ASPECTS = new Set(SEMANTIC_QUERY_ASPECTS);
const MENTION_TYPES = new Set(SEMANTIC_MENTION_TYPES);
const REFERENCE_TYPES = new Set(SEMANTIC_REFERENCE_TYPES);
const ENTITY_TYPES = Object.freeze(['product', 'family']);
const ENTITY_TYPE_SET = new Set(ENTITY_TYPES);
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
const ERROR_CODES = new Set([
  '', 'UNKNOWN', 'SQLITE_BUSY', 'SQLITE_IOERR',
  'AGENT_SEMANTIC_CONVERSATION_CONFLICT', 'AGENT_SEMANTIC_CONVERSATION_CORRUPT',
  'SEMANTIC_INPUT_INVALID', 'SEMANTIC_PROPOSAL_INVALID',
  'SEMANTIC_CONVERSATION_LOAD_FAILED', 'SEMANTIC_RESULT_INVALID',
  'SEMANTIC_RESOLUTION_FAILED', 'SEMANTIC_CONVERSATION_SAVE_FAILED',
]);
const ROOT_FIELDS = new Set([
  'semanticContractVersion', 'runtime', 'fallbackReason', 'phase', 'errorCode',
  'intent', 'operation', 'queryAspects', 'confidence', 'mentionTypes', 'referenceTypes',
  'resolvedEntityTypes', 'candidateCounts', 'decision', 'decisionReason',
  'missingFields', 'ambiguities',
]);
const CONFIDENCE_FIELDS = new Set(['intent', 'mentions', 'references']);
const ENTITY_FIELDS = new Set(['status', 'matchType', 'confidence', 'hasCanonicalId']);
const CANDIDATE_COUNT_FIELDS = new Set(ENTITY_TYPES);

function invalid() {
  const error = new Error('AGENT_SEMANTIC_AUDIT_INVALID');
  error.code = 'AGENT_SEMANTIC_AUDIT_INVALID';
  throw error;
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value;
}

function exactFields(value, fields) {
  const object = plainObject(value);
  const keys = Reflect.ownKeys(object);
  if (keys.length !== fields.size
    || keys.some((key) => typeof key !== 'string' || !fields.has(key))) invalid();
  return object;
}

function enumValue(value, allowed) {
  if (typeof value !== 'string' || !allowed.has(value)) invalid();
  return value;
}

function score(value, { nullable = true } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid();
  return value;
}

function boundedArray(value, limit) {
  if (!Array.isArray(value) || value.length > limit) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) invalid();
  }
  return value;
}

function enumArray(value, allowed, limit) {
  const array = boundedArray(value, limit);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < array.length; index += 1) {
    const item = enumValue(array[index], allowed);
    if (seen.has(item)) invalid();
    seen.add(item);
    result.push(item);
  }
  return result;
}

function confidenceProjection(value) {
  const object = exactFields(value, CONFIDENCE_FIELDS);
  return {
    intent: score(object.intent),
    mentions: score(object.mentions),
    references: score(object.references),
  };
}

function entityProjection(value) {
  const object = exactFields(value, ENTITY_FIELDS);
  if (typeof object.hasCanonicalId !== 'boolean') invalid();
  return {
    status: enumValue(object.status, ENTITY_STATUSES),
    matchType: enumValue(object.matchType, MATCH_TYPES),
    confidence: score(object.confidence),
    hasCanonicalId: object.hasCanonicalId,
  };
}

function resolvedEntityProjection(value) {
  const object = plainObject(value);
  const keys = Reflect.ownKeys(object);
  if (keys.length > ENTITY_TYPES.length
    || keys.some((key) => typeof key !== 'string' || !ENTITY_TYPE_SET.has(key))) invalid();
  const result = {};
  for (const entityType of ENTITY_TYPES) {
    if (Object.prototype.hasOwnProperty.call(object, entityType)) {
      result[entityType] = entityProjection(object[entityType]);
    }
  }
  return result;
}

function candidateCountProjection(value) {
  const object = exactFields(value, CANDIDATE_COUNT_FIELDS);
  const result = {};
  for (const entityType of ENTITY_TYPES) {
    const count = object[entityType];
    if (!Number.isSafeInteger(count) || count < 0 || count > 10) invalid();
    result[entityType] = count;
  }
  return result;
}

export function normalizeAgentSemanticAuditPayload(value) {
  const object = exactFields(value, ROOT_FIELDS);
  if (object.semanticContractVersion !== null && object.semanticContractVersion !== 1) invalid();
  return {
    semanticContractVersion: object.semanticContractVersion,
    runtime: enumValue(object.runtime, RUNTIMES),
    fallbackReason: enumValue(object.fallbackReason, FALLBACK_REASONS),
    phase: enumValue(object.phase, PHASES),
    errorCode: enumValue(object.errorCode, ERROR_CODES),
    intent: enumValue(object.intent, INTENTS),
    operation: enumValue(object.operation, OPERATIONS),
    queryAspects: enumArray(object.queryAspects, QUERY_ASPECTS, 8),
    confidence: confidenceProjection(object.confidence),
    mentionTypes: enumArray(object.mentionTypes, MENTION_TYPES, 8),
    referenceTypes: enumArray(object.referenceTypes, REFERENCE_TYPES, 8),
    resolvedEntityTypes: resolvedEntityProjection(object.resolvedEntityTypes),
    candidateCounts: candidateCountProjection(object.candidateCounts),
    decision: enumValue(object.decision, DECISIONS),
    decisionReason: enumValue(object.decisionReason, REASONS),
    missingFields: enumArray(object.missingFields, ENTITY_TYPE_SET, 2),
    ambiguities: enumArray(object.ambiguities, ENTITY_TYPE_SET, 2),
  };
}

function sourceArray(value, limit) {
  if (value === undefined) return [];
  return boundedArray(value, limit);
}

function sourceTypes(value, allowed, limit) {
  const array = sourceArray(value, 20);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < array.length; index += 1) {
    const type = array[index]?.type;
    if (typeof type !== 'string' || !allowed.has(type)) invalid();
    if (!seen.has(type)) {
      seen.add(type);
      result.push(type);
      if (result.length > limit) invalid();
    }
  }
  return result;
}

function sourceControlledList(value, allowed, limit) {
  const array = sourceArray(value, limit);
  const result = [];
  const seen = new Set();
  for (let index = 0; index < array.length; index += 1) {
    const item = array[index];
    if (typeof item !== 'string' || !allowed.has(item)) invalid();
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function sourceCandidateCount(resolution, entityType) {
  if (resolution?.nextTaskState !== undefined) plainObject(resolution.nextTaskState);
  if (resolution?.nextTaskState?.candidateSets !== undefined) {
    plainObject(resolution.nextTaskState.candidateSets);
  }
  const candidates = resolution?.nextTaskState?.candidateSets?.[entityType];
  if (candidates === undefined) return 0;
  return sourceArray(candidates, 10).length;
}

function sourceEntityProjection(resolution, entityType) {
  if (resolution?.resolvedEntities !== undefined) plainObject(resolution.resolvedEntities);
  const entity = resolution?.resolvedEntities?.[entityType];
  if (entity !== undefined && entity !== null) plainObject(entity);
  const candidates = sourceCandidateCount(resolution, entityType);
  const ambiguities = sourceArray(resolution?.ambiguities, 2);
  const missingFields = sourceArray(resolution?.missingFields, 2);
  const ambiguous = ambiguities.includes(entityType);
  const missing = missingFields.includes(entityType);
  if (!entity && !candidates && !ambiguous && !missing) return null;
  return {
    status: entity ? 'resolved' : ambiguous || candidates ? 'ambiguous' : missing ? 'missing' : 'unknown',
    matchType: entity?.matchType === undefined ? 'unknown' : entity.matchType,
    confidence: entity?.confidence === undefined ? null : entity.confidence,
    hasCanonicalId: entityType === 'product'
      && typeof entity?.canonicalProductId === 'string'
      && entity.canonicalProductId.trim().length > 0,
  };
}

export function projectAgentSemanticAuditPayload({
  runtime,
  fallbackReason = 'none',
  proposal,
  resolution,
  phase = 'semantic_resolution',
  errorCode = '',
} = {}) {
  if (proposal !== undefined && proposal !== null) plainObject(proposal);
  if (resolution !== undefined && resolution !== null) plainObject(resolution);
  if (proposal?.confidence !== undefined) plainObject(proposal.confidence);
  const resolvedEntityTypes = {};
  for (const entityType of ENTITY_TYPES) {
    const projected = sourceEntityProjection(resolution, entityType);
    if (projected) resolvedEntityTypes[entityType] = projected;
  }
  return normalizeAgentSemanticAuditPayload({
    semanticContractVersion: proposal?.semanticContractVersion === 1 ? 1 : null,
    runtime: runtime === undefined ? 'unknown' : runtime,
    fallbackReason,
    phase,
    errorCode,
    intent: proposal?.intent === undefined ? 'unknown' : proposal.intent,
    operation: proposal?.operation === undefined ? 'unknown' : proposal.operation,
    queryAspects: sourceControlledList(proposal?.queryAspects, QUERY_ASPECTS, 8),
    confidence: {
      intent: proposal?.confidence?.intent ?? null,
      mentions: proposal?.confidence?.mentions ?? null,
      references: proposal?.confidence?.references ?? null,
    },
    mentionTypes: sourceTypes(proposal?.mentions, MENTION_TYPES, 8),
    referenceTypes: sourceTypes(proposal?.references, REFERENCE_TYPES, 8),
    resolvedEntityTypes,
    candidateCounts: {
      product: sourceCandidateCount(resolution, 'product'),
      family: sourceCandidateCount(resolution, 'family'),
    },
    decision: resolution?.decision === undefined ? 'retry_later' : resolution.decision,
    decisionReason: resolution?.decisionReason === undefined ? 'unknown' : resolution.decisionReason,
    missingFields: sourceControlledList(resolution?.missingFields, ENTITY_TYPE_SET, 2),
    ambiguities: sourceControlledList(resolution?.ambiguities, ENTITY_TYPE_SET, 2),
  });
}

export function normalizeAgentSemanticPersistenceErrorCode(value) {
  return ERROR_CODES.has(value) ? value : 'UNKNOWN';
}
