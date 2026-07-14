import {
  normalizeSemanticProposal,
  SEMANTIC_INTENTS,
} from './agent-semantic-contract.mjs';

const MAX_TEXT_LENGTH = 200;
const MAX_QUESTION_LENGTH = 1_000;
const MAX_CANDIDATES = 10;
const PRODUCT_ACTIVE_MATCH_TYPES = new Set([
  'exact_official_name',
  'approved_alias',
  'company_scoped_alias',
  'company_scoped_normalized',
  'filing_name',
  'unique_high_confidence',
]);
const PRODUCT_CANDIDATE_MATCH_TYPES = new Set([
  ...PRODUCT_ACTIVE_MATCH_TYPES,
]);
const FAMILY_ACTIVE_MATCH_TYPES = new Set(['exact', 'contextual']);
const FAMILY_CANDIDATE_MATCH_TYPES = new Set([...FAMILY_ACTIVE_MATCH_TYPES, 'prefix']);
const FAMILY_ENTITY_INTENTS = new Set([
  'family_summary',
  'coverage_report',
  'sales_report',
  'sales_coaching',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value, { required = false } = {}) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > MAX_TEXT_LENGTH) return null;
  return normalized;
}

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function boundedConfidence(value, minimum = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= minimum && value <= 1
    ? value
    : null;
}

function projectProduct(value, { active = false } = {}) {
  if (!isRecord(value)) return null;
  const canonicalProductId = boundedString(value.canonicalProductId);
  const company = boundedString(value.company);
  const officialName = boundedString(value.officialName, { required: true });
  const matchTypes = active ? PRODUCT_ACTIVE_MATCH_TYPES : PRODUCT_CANDIDATE_MATCH_TYPES;
  const matchType = typeof value.matchType === 'string' && matchTypes.has(value.matchType)
    ? value.matchType
    : null;
  const confidence = boundedConfidence(value.confidence, active ? 0.9 : 0);
  if (canonicalProductId === null || company === null || !officialName || !matchType || confidence === null) {
    return null;
  }
  const projected = { canonicalProductId, company, officialName, matchType, confidence };
  if (!active) return projected;
  const updatedAt = nonnegativeSafeInteger(value.updatedAt);
  const expiresAt = nonnegativeSafeInteger(value.expiresAt);
  if (updatedAt === null || expiresAt === null) return null;
  return { ...projected, updatedAt, expiresAt };
}

function projectFamily(value, { active = false } = {}) {
  if (!isRecord(value)) return null;
  const familyId = positiveSafeInteger(value.familyId);
  const displayName = boundedString(value.displayName, { required: true });
  const matchTypes = active ? FAMILY_ACTIVE_MATCH_TYPES : FAMILY_CANDIDATE_MATCH_TYPES;
  const matchType = typeof value.matchType === 'string' && matchTypes.has(value.matchType)
    ? value.matchType
    : null;
  const confidence = boundedConfidence(value.confidence, active ? 1 : 0);
  if (!familyId || displayName === null || !matchType || confidence === null) return null;
  const projected = { familyId, displayName, matchType, confidence };
  if (!active) return projected;
  const updatedAt = nonnegativeSafeInteger(value.updatedAt);
  const expiresAt = nonnegativeSafeInteger(value.expiresAt);
  if (updatedAt === null || expiresAt === null) return null;
  return { ...projected, updatedAt, expiresAt };
}

function projectCandidateList(value, projector, label) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_CANDIDATES) {
    throw new RangeError(`${label} exceeds ${MAX_CANDIDATES} candidates`);
  }
  return value.map((candidate) => projector(candidate)).filter(Boolean);
}

function assertCandidateSetBounds(value) {
  if (!isRecord(value)) return;
  for (const [key, label] of [['product', 'Product'], ['family', 'Family']]) {
    if (Array.isArray(value[key]) && value[key].length > MAX_CANDIDATES) {
      throw new RangeError(`${label} candidate set exceeds ${MAX_CANDIDATES} candidates`);
    }
  }
}

function projectPendingClarification(value) {
  if (!isRecord(value)) return { pending: null, entityType: '' };
  const entityType = value.entityType === 'product' || value.entityType === 'family'
    ? value.entityType
    : '';
  const originalQuestion = typeof value.originalQuestion === 'string'
    ? value.originalQuestion.trim()
    : '';
  const expiresAt = nonnegativeSafeInteger(value.expiresAt);
  if (!entityType || !originalQuestion || originalQuestion.length > MAX_QUESTION_LENGTH || expiresAt === null) {
    return { pending: null, entityType };
  }
  try {
    const proposal = normalizeSemanticProposal(value.proposal, originalQuestion);
    const requiredEntityType = proposal.intent === 'insurance_product_knowledge'
      ? 'product'
      : (FAMILY_ENTITY_INTENTS.has(proposal.intent) ? 'family' : '');
    if (!requiredEntityType || entityType !== requiredEntityType) {
      return { pending: null, entityType };
    }
    return {
      pending: {
        entityType,
        proposal,
        originalQuestion,
        expiresAt,
      },
      entityType,
    };
  } catch {
    return { pending: null, entityType };
  }
}

function projectLastCompletedAction(value) {
  if (!isRecord(value) || !SEMANTIC_INTENTS.includes(value.intent)) return null;
  const entityType = value.entityType === null
    ? null
    : (value.entityType === 'product' || value.entityType === 'family' ? value.entityType : undefined);
  return entityType === undefined ? null : { intent: value.intent, entityType };
}

export function projectAgentSemanticTaskState(value) {
  const source = isRecord(value) ? value : {};
  assertCandidateSetBounds(source.candidateSets);
  const taskState = {
    activeIntent: SEMANTIC_INTENTS.includes(source.activeIntent) ? source.activeIntent : '',
    activeEntities: {
      product: projectProduct(source.activeEntities?.product, { active: true }),
      family: projectFamily(source.activeEntities?.family, { active: true }),
    },
    candidateSets: {
      product: [],
      family: [],
    },
    pendingClarification: null,
    lastCompletedAction: projectLastCompletedAction(source.lastCompletedAction),
  };
  const { pending } = projectPendingClarification(source.pendingClarification);
  if (pending) {
    const candidates = pending.entityType === 'product'
      ? projectCandidateList(source.candidateSets?.product, projectProduct, 'Product candidate set')
      : projectCandidateList(source.candidateSets?.family, projectFamily, 'Family candidate set');
    if (candidates.length > 0) {
      taskState.pendingClarification = pending;
      taskState.candidateSets[pending.entityType] = candidates;
    }
  }
  return taskState;
}

function validateServiceIdentity({ internalUserId, channel }) {
  if (!positiveSafeInteger(internalUserId)) {
    throw new TypeError('internalUserId must be a positive safe integer');
  }
  if (typeof channel !== 'string' || !/^[a-z][a-z0-9_-]{0,19}$/u.test(channel.trim())) {
    throw new TypeError('channel is invalid');
  }
  return { userId: internalUserId, channel: channel.trim() };
}

function normalizeConversationId(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new TypeError('conversationId must be a string');
  return value.trim();
}

export function createAgentSemanticConversationService({ store, clock = Date.now } = {}) {
  if (!store || typeof store.getAgentSemanticConversation !== 'function'
    || typeof store.saveAgentSemanticConversation !== 'function') {
    throw new TypeError('store with semantic conversation methods is required');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  return {
    async load({ internalUserId, channel, conversationId } = {}) {
      const identity = validateServiceIdentity({ internalUserId, channel });
      const normalizedConversationId = normalizeConversationId(conversationId);
      if (!normalizedConversationId) {
        return { version: 0, taskState: projectAgentSemanticTaskState(null) };
      }
      const row = await store.getAgentSemanticConversation({
        ...identity,
        conversationId: normalizedConversationId,
      });
      return row
        ? { version: row.version, taskState: projectAgentSemanticTaskState(row.taskState) }
        : { version: 0, taskState: projectAgentSemanticTaskState(null) };
    },

    async save({ internalUserId, channel, conversationId, expectedVersion, taskState } = {}) {
      const identity = validateServiceIdentity({ internalUserId, channel });
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new TypeError('expectedVersion must be a nonnegative safe integer');
      }
      const projected = projectAgentSemanticTaskState(taskState);
      const normalizedConversationId = normalizeConversationId(conversationId);
      if (!normalizedConversationId) {
        return { persisted: false, version: expectedVersion, taskState: projected };
      }
      const updatedAt = clock();
      if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) {
        throw new TypeError('clock must return a nonnegative safe integer');
      }
      const saved = await store.saveAgentSemanticConversation({
        ...identity,
        conversationId: normalizedConversationId,
        expectedVersion,
        updatedAt,
        taskState: projected,
      });
      return {
        persisted: true,
        version: saved.version,
        taskState: projectAgentSemanticTaskState(saved.taskState),
      };
    },
  };
}
