import {
  normalizeSemanticProposal,
  semanticFrameToRouterCandidate,
  SEMANTIC_CONTRACT_VERSION,
} from './agent-semantic-contract.mjs';
import { preparseAgentMessage } from './agent-semantic-preparser.mjs';
import { decideSemanticReadiness } from './agent-semantic-readiness.service.mjs';

const PRODUCT_INTENT = 'insurance_product_knowledge';
const FAMILY_INTENTS = new Set([
  'family_summary',
  'coverage_report',
  'sales_report',
  'sales_coaching',
]);
const MAX_CANDIDATES = 10;
const MAX_TEXT_LENGTH = 200;

function clean(value, limit = MAX_TEXT_LENGTH) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= limit ? normalized : '';
}

function positiveSafeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : 0;
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function finiteTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function projectProduct(value, { active = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const officialName = clean(value.officialName);
  const company = clean(value.company);
  if (!officialName || !company) return null;
  const entity = {
    canonicalProductId: clean(value.canonicalProductId),
    company,
    officialName,
  };
  const matchType = clean(value.matchType, 80);
  if (matchType) entity.matchType = matchType;
  if (typeof value.confidence === 'number' && Number.isFinite(value.confidence)) {
    entity.confidence = Math.max(0, Math.min(1, value.confidence));
  }
  if (active) {
    const updatedAt = finiteTimestamp(value.updatedAt);
    const expiresAt = finiteTimestamp(value.expiresAt);
    if (updatedAt !== null) entity.updatedAt = updatedAt;
    if (expiresAt !== null) entity.expiresAt = expiresAt;
  }
  return entity;
}

function projectFamily(value, { active = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const familyId = positiveSafeInteger(value.familyId);
  const displayName = clean(value.displayName);
  if (!familyId || !displayName) return null;
  const entity = {
    familyId,
    displayName,
  };
  const matchType = clean(value.matchType, 80);
  if (matchType) entity.matchType = matchType;
  if (typeof value.confidence === 'number' && Number.isFinite(value.confidence)) {
    entity.confidence = Math.max(0, Math.min(1, value.confidence));
  }
  if (active) {
    const updatedAt = finiteTimestamp(value.updatedAt);
    const expiresAt = finiteTimestamp(value.expiresAt);
    if (updatedAt !== null) entity.updatedAt = updatedAt;
    if (expiresAt !== null) entity.expiresAt = expiresAt;
  }
  return entity;
}

function isLive(entity, now, contextTtlMs) {
  if (!entity) return false;
  const expiresAt = finiteTimestamp(entity.expiresAt);
  if (expiresAt !== null) return expiresAt > now;
  const updatedAt = finiteTimestamp(entity.updatedAt);
  return updatedAt !== null && updatedAt + contextTtlMs > now;
}

function projectActive(value, type, now, contextTtlMs) {
  const projected = type === 'product'
    ? projectProduct(value, { active: true })
    : projectFamily(value, { active: true });
  return isLive(projected, now, contextTtlMs) ? projected : null;
}

function projectCandidates(value, type) {
  if (!Array.isArray(value)) return [];
  const project = type === 'product' ? projectProduct : projectFamily;
  return value.slice(0, MAX_CANDIDATES).map((item) => project(item)).filter(Boolean);
}

function projectResolution(value, type) {
  const status = clean(value?.status, 40);
  if (status === 'resolved') {
    const entity = type === 'product' ? projectProduct(value.entity) : projectFamily(value.entity);
    return entity
      ? { status: 'resolved', entity, candidates: [] }
      : { status: 'missing', entity: null, candidates: [] };
  }
  if (status === 'ambiguous') {
    const candidates = projectCandidates(value?.candidates, type);
    return candidates.length
      ? { status: 'ambiguous', entity: null, candidates }
      : { status: 'missing', entity: null, candidates: [] };
  }
  return {
    status: status === 'not_found' ? 'not_found' : 'missing',
    entity: null,
    candidates: [],
  };
}

function uploadProposal() {
  return {
    semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
    intent: 'upload_link',
    operation: 'read',
    queryAspects: ['upload'],
    mentions: [],
    references: [],
    requestedSteps: ['upload'],
    confidence: { intent: 1, mentions: 1, references: 1 },
  };
}

function normalizedProposal(value, originalQuestion) {
  if (!value) return null;
  try {
    return normalizeSemanticProposal(value, originalQuestion);
  } catch {
    return null;
  }
}

function hasMention(proposal, type) {
  return proposal.mentions.some((mention) => mention.type === type);
}

function hasReference(proposal, type) {
  return proposal.references.some((reference) => reference.type === type);
}

function projectPendingClarification(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entityType = clean(value.entityType, 20);
  const originalQuestion = clean(value.originalQuestion, 1_000);
  const expiresAt = finiteTimestamp(value.expiresAt);
  if (!['product', 'family'].includes(entityType) || !originalQuestion || expiresAt === null) return null;
  const proposal = normalizedProposal(value.proposal, originalQuestion);
  return proposal ? { entityType, proposal, originalQuestion, expiresAt } : null;
}

function sanitizedState(context, now, contextTtlMs) {
  const state = context && typeof context === 'object' && !Array.isArray(context)
    && context.taskState && typeof context.taskState === 'object' && !Array.isArray(context.taskState)
    ? context.taskState
    : {};
  const activeEntities = state.activeEntities && typeof state.activeEntities === 'object'
    && !Array.isArray(state.activeEntities) ? state.activeEntities : {};
  const candidateSets = state.candidateSets && typeof state.candidateSets === 'object'
    && !Array.isArray(state.candidateSets) ? state.candidateSets : {};
  return {
    activeIntent: clean(state.activeIntent, 80),
    activeEntities: {
      product: projectActive(activeEntities.product, 'product', now, contextTtlMs),
      family: projectActive(activeEntities.family, 'family', now, contextTtlMs),
    },
    candidateSets: {
      product: projectCandidates(candidateSets.product, 'product'),
      family: projectCandidates(candidateSets.family, 'family'),
    },
    pendingClarification: projectPendingClarification(state.pendingClarification),
    lastCompletedAction: state.lastCompletedAction && typeof state.lastCompletedAction === 'object'
      && !Array.isArray(state.lastCompletedAction) ? state.lastCompletedAction : null,
  };
}

function publicState(state) {
  const lastIntent = clean(state.lastCompletedAction?.intent, 80);
  const lastEntityType = clean(state.lastCompletedAction?.entityType, 20);
  return {
    activeIntent: clean(state.activeIntent, 80),
    activeEntities: {
      product: state.activeEntities.product ? { ...state.activeEntities.product } : null,
      family: state.activeEntities.family ? { ...state.activeEntities.family } : null,
    },
    candidateSets: {
      product: projectCandidates(state.candidateSets.product, 'product'),
      family: projectCandidates(state.candidateSets.family, 'family'),
    },
    pendingClarification: projectPendingClarification(state.pendingClarification),
    lastCompletedAction: lastIntent && ['product', 'family'].includes(lastEntityType)
      ? { intent: lastIntent, entityType: lastEntityType }
      : null,
  };
}

function expiredSelectionResult({ state, entityType = '', proposal = null }) {
  if (entityType === 'product' || entityType === 'family') state.candidateSets[entityType] = [];
  state.pendingClarification = null;
  return {
    decision: 'clarify',
    decisionReason: 'candidate_selection_expired',
    missingFields: [],
    ambiguities: [],
    proposal,
    resolvedEntities: {},
    candidate: null,
    nextTaskState: publicState(state),
  };
}

function pendingSelection(state, selection, now) {
  const pending = state.pendingClarification;
  const entityType = clean(pending?.entityType, 20);
  const originalQuestion = clean(pending?.originalQuestion, 1_000);
  const expiresAt = finiteTimestamp(pending?.expiresAt);
  if (!['product', 'family'].includes(entityType)
    || !originalQuestion
    || expiresAt === null
    || expiresAt <= now) {
    return { valid: false, entityType };
  }
  const candidate = state.candidateSets[entityType]?.[selection.index] || null;
  const proposal = normalizedProposal(pending.proposal, originalQuestion);
  if (!candidate || !proposal) return { valid: false, entityType };
  return { valid: true, entityType, candidate, proposal, originalQuestion };
}

function stateAfterResolution({ state, proposal, proposalQuestion, resolutions, readiness, now, contextTtlMs }) {
  const priorPendingType = clean(state.pendingClarification?.entityType, 20);
  const requiredType = proposal.intent === PRODUCT_INTENT
    ? 'product'
    : FAMILY_INTENTS.has(proposal.intent) ? 'family' : '';
  const resolution = requiredType ? resolutions[requiredType] : null;

  if (resolution?.status === 'resolved') {
    state.activeEntities[requiredType] = {
      ...resolution.entity,
      updatedAt: now,
      expiresAt: now + contextTtlMs,
    };
  }
  if (resolution?.status === 'ambiguous') {
    state.candidateSets[requiredType] = resolution.candidates.slice(0, MAX_CANDIDATES);
    state.pendingClarification = {
      entityType: requiredType,
      proposal,
      originalQuestion: proposalQuestion,
      expiresAt: now + contextTtlMs,
    };
  } else if (requiredType) {
    state.candidateSets[requiredType] = [];
    state.pendingClarification = null;
  }

  if (readiness.decision === 'execute') {
    state.activeIntent = proposal.intent;
    if (['product', 'family'].includes(priorPendingType)) {
      state.candidateSets[priorPendingType] = [];
    }
    state.pendingClarification = null;
    if (requiredType) {
      state.candidateSets[requiredType] = [];
      state.lastCompletedAction = { intent: proposal.intent, entityType: requiredType };
    }
  }
  return publicState(state);
}

export function createAgentSemanticResolver({
  productResolver,
  familyResolver,
  clock = Date.now,
  contextTtlMs = 300_000,
} = {}) {
  if (typeof productResolver?.resolve !== 'function') {
    throw new TypeError('productResolver.resolve is required');
  }
  if (typeof familyResolver?.resolve !== 'function') {
    throw new TypeError('familyResolver.resolve is required');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  if (!Number.isFinite(contextTtlMs) || contextTtlMs <= 0) {
    throw new TypeError('contextTtlMs must be positive');
  }

  return {
    async resolve({ internalUserId, question, runtime = 'rule', proposal = null, context = {} } = {}) {
      const normalizedQuestion = typeof question === 'string' ? question.trim() : '';
      if (!normalizedQuestion || normalizedQuestion.length > 1_000) {
        throw new TypeError('question must be a bounded non-empty string');
      }
      const nowValue = clock();
      const now = nowValue instanceof Date ? nowValue.getTime() : nowValue;
      if (!Number.isFinite(now)) throw new TypeError('clock must return a finite timestamp');

      const preparsed = preparseAgentMessage(normalizedQuestion);
      const state = sanitizedState(context, now, contextTtlMs);
      let selection = null;
      let effectiveProposal = normalizedProposal(proposal, normalizedQuestion);
      let proposalQuestion = normalizedQuestion;

      if (preparsed.candidateSelection) {
        selection = pendingSelection(state, preparsed.candidateSelection, now);
        if (!selection.valid) {
          return expiredSelectionResult({
            state,
            entityType: selection.entityType,
            proposal: effectiveProposal,
          });
        }
        effectiveProposal = selection.proposal;
        proposalQuestion = selection.originalQuestion;
      }

      if (!effectiveProposal && preparsed.operationHint === 'upload_link') {
        effectiveProposal = uploadProposal();
      }

      const resolutions = {};
      if (effectiveProposal?.intent === PRODUCT_INTENT) {
        const explicitProduct = hasMention(effectiveProposal, 'product');
        const activeProduct = selection?.entityType === 'product'
          ? selection.candidate
          : !explicitProduct && hasReference(effectiveProposal, 'current_product')
            ? state.activeEntities.product
            : null;
        const mentions = selection?.entityType === 'product'
          ? effectiveProposal.mentions.filter((mention) => !['product', 'insurer'].includes(mention.type))
          : effectiveProposal.mentions;
        resolutions.product = projectResolution(await productResolver.resolve({
          mentions,
          activeProduct: activeProduct ? projectProduct(activeProduct) : null,
        }), 'product');
      } else if (effectiveProposal && FAMILY_INTENTS.has(effectiveProposal.intent)) {
        const explicitFamily = hasMention(effectiveProposal, 'family');
        const activeFamily = selection?.entityType === 'family'
          ? selection.candidate
          : !explicitFamily && hasReference(effectiveProposal, 'current_family')
            ? state.activeEntities.family
            : null;
        const mentions = selection?.entityType === 'family'
          ? effectiveProposal.mentions.filter((mention) => mention.type !== 'family')
          : effectiveProposal.mentions;
        resolutions.family = projectResolution(await familyResolver.resolve({
          internalUserId,
          mentions,
          activeFamily: activeFamily ? projectFamily(activeFamily) : null,
        }), 'family');
      }

      const readiness = decideSemanticReadiness({ proposal: effectiveProposal, resolutions, runtime });
      const resolvedEntities = {};
      if (resolutions.product?.status === 'resolved') resolvedEntities.product = resolutions.product.entity;
      if (resolutions.family?.status === 'resolved') resolvedEntities.family = resolutions.family.entity;
      const candidate = readiness.decision === 'execute'
        ? semanticFrameToRouterCandidate({ ...effectiveProposal, resolvedEntities }, normalizedQuestion)
        : null;

      return {
        ...readiness,
        proposal: effectiveProposal,
        resolvedEntities,
        candidate,
        nextTaskState: effectiveProposal
          ? stateAfterResolution({
            state,
            proposal: effectiveProposal,
            proposalQuestion,
            resolutions,
            readiness,
            now,
            contextTtlMs,
          })
          : publicState(state),
      };
    },
  };
}
