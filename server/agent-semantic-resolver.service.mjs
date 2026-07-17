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
]);
const MAX_CANDIDATES = 10;
const MAX_PRODUCT_ALIASES = 5;
const MAX_TEXT_LENGTH = 200;
const MAX_CONTEXT_TTL_MS = 86_400_000;
const PRODUCT_RESOLVED_MATCH_TYPES = new Set([
  'confirmed_candidate',
  'exact_official_name',
  'filing_name',
  'approved_alias',
  'company_scoped_normalized',
  'unique_high_confidence',
]);
const FAMILY_RESOLVED_MATCH_TYPES = new Set(['exact', 'contextual']);

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
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
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
    const aliases = Array.isArray(value.aliases)
      ? [...new Set(value.aliases.map((alias) => clean(alias)).filter(Boolean))]
        .slice(0, MAX_PRODUCT_ALIASES)
      : [];
    if (aliases.length) entity.aliases = aliases;
    const updatedAt = finiteTimestamp(value.updatedAt);
    const expiresAt = finiteTimestamp(value.expiresAt);
    if (updatedAt !== null) entity.updatedAt = updatedAt;
    if (expiresAt !== null) entity.expiresAt = expiresAt;
  }
  return entity;
}

function contextualProductMention(mention, activeProduct) {
  const rawText = clean(mention?.rawText);
  if (!rawText || !activeProduct?.aliases?.includes(rawText)) return mention;
  return { type: 'product', rawText: activeProduct.officialName };
}

function confirmedProductAliases(proposal, entity, priorProduct) {
  const priorAliases = priorProduct?.canonicalProductId === entity.canonicalProductId
    ? priorProduct.aliases || []
    : [];
  const mentionedAliases = proposal.mentions
    .filter((mention) => mention.type === 'product')
    .map((mention) => clean(mention.rawText))
    .filter(Boolean);
  return [...new Set([...priorAliases, ...mentionedAliases])].slice(0, MAX_PRODUCT_ALIASES);
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
  const updatedAt = finiteTimestamp(entity.updatedAt);
  const maxExpiry = now + contextTtlMs;
  if (expiresAt !== null) {
    if (expiresAt <= now || expiresAt > maxExpiry) return false;
    if (updatedAt === null) return true;
    return updatedAt <= now
      && Number.isSafeInteger(updatedAt + contextTtlMs)
      && expiresAt <= updatedAt + contextTtlMs;
  }
  return updatedAt !== null
    && updatedAt <= now
    && Number.isSafeInteger(updatedAt + contextTtlMs)
    && updatedAt + contextTtlMs > now;
}

function projectActive(value, type, now, contextTtlMs) {
  if (value?.updatedAt !== undefined && finiteTimestamp(value.updatedAt) === null) return null;
  if (value?.expiresAt !== undefined && finiteTimestamp(value.expiresAt) === null) return null;
  const projected = type === 'product'
    ? projectProduct(value, { active: true })
    : projectFamily(value, { active: true });
  return isLive(projected, now, contextTtlMs) ? projected : null;
}

function projectCandidates(value, type, { timed = false, now = 0, contextTtlMs = 0 } = {}) {
  if (!Array.isArray(value)) return [];
  const project = type === 'product' ? projectProduct : projectFamily;
  return value.slice(0, MAX_CANDIDATES)
    .map((item) => project(item, { active: timed }))
    .filter((item) => item && (!timed || isLive(item, now, contextTtlMs)));
}

function projectResolution(value, type) {
  const status = clean(value?.status, 40);
  if (status === 'resolved') {
    const entity = type === 'product' ? projectProduct(value.entity) : projectFamily(value.entity);
    const rawConfidence = value?.entity?.confidence;
    const rawMatchType = clean(value?.entity?.matchType, 80);
    const valid = entity
      && typeof rawConfidence === 'number'
      && Number.isFinite(rawConfidence)
      && rawConfidence >= 0
      && rawConfidence <= 1
      && (type === 'product'
        ? PRODUCT_RESOLVED_MATCH_TYPES.has(rawMatchType) && rawConfidence >= 0.9
        : FAMILY_RESOLVED_MATCH_TYPES.has(rawMatchType) && rawConfidence === 1);
    return valid
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

function isGenericProductPlanLabel(value) {
  return /^(?:保障|保险)?(?:计划|方案)(?:[一二三四五六七八九十百\dA-Za-z]+)?$/u.test(clean(value));
}

function semanticProductMentions(proposal) {
  return proposal.mentions.filter((mention) => (
    mention.type === 'product' && !isGenericProductPlanLabel(mention.rawText)
  ));
}

function comparesPlansWithinOneProduct(question) {
  const normalizedQuestion = clean(question, 1_000);
  const labels = normalizedQuestion.match(/(?:计划|方案)[一二三四五六七八九十百\dA-Za-z]+/gu) || [];
  return new Set(labels).size >= 2
    || /(?:计划|方案)[一二三四五六七八九十百\dA-Za-z]+(?:\s*[/／、,，和与及]\s*[一二三四五六七八九十百\dA-Za-z]+)+/u
      .test(normalizedQuestion);
}

function hasReference(proposal, type) {
  return proposal.references.some((reference) => reference.type === type);
}

function requiredEntityType(proposal) {
  if (proposal?.intent === PRODUCT_INTENT) return 'product';
  if (FAMILY_INTENTS.has(proposal?.intent)
    || (proposal?.intent === 'sales_coaching'
      && (hasMention(proposal, 'family') || hasReference(proposal, 'current_family')))) return 'family';
  return '';
}

function projectPendingClarification(value, now, contextTtlMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entityType = clean(value.entityType, 20);
  const originalQuestion = clean(value.originalQuestion, 1_000);
  const expiresAt = finiteTimestamp(value.expiresAt);
  if (!['product', 'family'].includes(entityType)
    || !originalQuestion
    || expiresAt === null
    || expiresAt <= now
    || expiresAt > now + contextTtlMs) return null;
  const proposal = normalizedProposal(value.proposal, originalQuestion);
  if (!proposal) return null;
  const comparison = value.comparison === true
    && entityType === 'product'
    && proposal.intent === PRODUCT_INTENT;
  return {
    entityType,
    proposal,
    originalQuestion,
    expiresAt,
    ...(comparison
      ? {
        comparison: true,
        selectedProducts: projectCandidates(value.selectedProducts, 'product').slice(0, 1),
      }
      : {}),
  };
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
  const comparisonCompleted = state.lastCompletedAction?.comparison === true
    && state.lastCompletedAction?.intent === PRODUCT_INTENT
    && state.lastCompletedAction?.entityType === 'product';
  return {
    now,
    contextTtlMs,
    activeIntent: clean(state.activeIntent, 80),
    activeEntities: {
      product: projectActive(activeEntities.product, 'product', now, contextTtlMs),
      family: projectActive(activeEntities.family, 'family', now, contextTtlMs),
    },
    candidateSets: {
      product: projectCandidates(candidateSets.product, 'product', {
        timed: comparisonCompleted, now, contextTtlMs,
      }),
      family: projectCandidates(candidateSets.family, 'family'),
    },
    pendingClarification: projectPendingClarification(state.pendingClarification, now, contextTtlMs),
    lastCompletedAction: state.lastCompletedAction && typeof state.lastCompletedAction === 'object'
      && !Array.isArray(state.lastCompletedAction) ? {
        ...state.lastCompletedAction,
        ...(comparisonCompleted ? { comparison: true } : {}),
      } : null,
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
      product: projectCandidates(state.candidateSets.product, 'product', {
        timed: state.lastCompletedAction?.comparison === true,
        now: state.now,
        contextTtlMs: state.contextTtlMs,
      }),
      family: projectCandidates(state.candidateSets.family, 'family'),
    },
    pendingClarification: projectPendingClarification(
      state.pendingClarification,
      state.now,
      state.contextTtlMs,
    ),
    lastCompletedAction: lastIntent && ['product', 'family'].includes(lastEntityType)
      ? {
        intent: lastIntent,
        entityType: lastEntityType,
        ...(state.lastCompletedAction?.comparison === true
          && lastIntent === PRODUCT_INTENT && lastEntityType === 'product'
          ? { comparison: true } : {}),
      }
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

function resolverUnavailableResult({ state, proposal }) {
  return {
    decision: 'retry_later',
    decisionReason: 'entity_resolver_unavailable',
    missingFields: [],
    ambiguities: [],
    proposal,
    resolvedEntities: {},
    candidate: null,
    nextTaskState: publicState(state),
  };
}

function preflightResult({ state, proposal, runtime }) {
  const readiness = decideSemanticReadiness({ proposal, resolutions: {}, runtime });
  if (['product_required', 'family_required'].includes(readiness.decisionReason)) return null;
  if (readiness.decision === 'execute') return null;
  return {
    ...readiness,
    proposal,
    resolvedEntities: {},
    candidate: null,
    nextTaskState: publicState(state),
  };
}

function explicitlyRequestsProductComparison(proposal, question) {
  return proposal?.intent === PRODUCT_INTENT && (proposal.queryAspects.includes('comparison')
    || proposal.requestedSteps.includes('compare')
    || /这(?:两|2)款|二者|两者/u.test(question)
    || proposal.references.some((reference) => (
      reference.type === 'comparison_left' || reference.type === 'comparison_right'
    )));
}

function comparisonState(state, proposal, products) {
  const pendingType = clean(state.pendingClarification?.entityType, 20);
  if (pendingType === 'product' || pendingType === 'family') state.candidateSets[pendingType] = [];
  state.candidateSets.product = products.map((product) => ({
    ...product,
    updatedAt: state.now,
    expiresAt: state.now + state.contextTtlMs,
  }));
  state.pendingClarification = null;
  state.activeEntities.product = null;
  state.activeIntent = proposal.intent;
  state.lastCompletedAction = { intent: proposal.intent, entityType: 'product', comparison: true };
  return publicState(state);
}

function resolvedComparisonResult({ state, proposal, products, question }) {
  const resolvedEntities = { products };
  return {
    decision: 'execute',
    decisionReason: 'unique_authorized_entity',
    missingFields: [],
    ambiguities: [],
    proposal,
    resolvedEntities,
    candidate: semanticFrameToRouterCandidate({ ...proposal, resolvedEntities }, question),
    nextTaskState: comparisonState(state, proposal, products),
  };
}

function projectProductScan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.overflow !== 'boolean'
    || !Array.isArray(value.entities)
    || value.entities.length > 8) return null;
  const hasInvalidSignal = value.invalid !== undefined || value.status !== undefined;
  const invalidInsurer = value.invalid === true && value.status === 'invalid_insurer';
  if (hasInvalidSignal && !invalidInsurer) return null;
  const entities = value.entities.map((entity) => projectProduct(entity));
  if (entities.some((entity) => !entity?.canonicalProductId)) return null;
  return { entities, overflow: value.overflow, invalidInsurer };
}

function unsupportedComparisonResult({
  state,
  proposal,
  question = '',
  candidates = [],
  selectedProducts = [],
}) {
  const pendingType = clean(state.pendingClarification?.entityType, 20);
  if (pendingType === 'product' || pendingType === 'family') state.candidateSets[pendingType] = [];
  const distinctCandidates = candidates.filter((candidate, index, values) => candidate
    && values.findIndex((value) => value.canonicalProductId === candidate.canonicalProductId) === index)
    .slice(0, MAX_CANDIDATES);
  const enoughChoices = selectedProducts.length > 0
    ? distinctCandidates.length > 0
    : distinctCandidates.length > 1;
  if (enoughChoices && clean(question, 1_000)) {
    state.candidateSets.product = distinctCandidates;
    state.pendingClarification = {
      entityType: 'product',
      proposal,
      originalQuestion: question,
      expiresAt: state.now + state.contextTtlMs,
      comparison: true,
      selectedProducts: selectedProducts.slice(0, 1),
    };
  } else {
    state.pendingClarification = null;
  }
  return {
    decision: 'clarify',
    decisionReason: 'product_comparison_unsupported',
    missingFields: [],
    ambiguities: ['product'],
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
  if (!candidate || !proposal || requiredEntityType(proposal) !== entityType) {
    return { valid: false, entityType };
  }
  return {
    valid: true,
    entityType,
    candidate,
    proposal,
    originalQuestion,
    comparison: pending.comparison === true && entityType === 'product',
    selectedProducts: projectCandidates(pending.selectedProducts, 'product').slice(0, 1),
  };
}

function completedComparisonSelection(state, selection, now) {
  if (state.pendingClarification
    || state.lastCompletedAction?.comparison !== true
    || state.lastCompletedAction?.intent !== PRODUCT_INTENT
    || state.lastCompletedAction?.entityType !== 'product'
    || !Array.isArray(state.candidateSets.product)
    || state.candidateSets.product.length !== 2
    || selection.index < 0
    || selection.index >= 2) return { valid: false, entityType: 'product' };
  const candidate = state.candidateSets.product[selection.index];
  if (!isLive(candidate, now, state.contextTtlMs)) return { valid: false, entityType: 'product' };
  return { valid: true, entityType: 'product', candidate, comparison: true };
}

function stateAfterResolution({ state, proposal, proposalQuestion, resolutions, readiness, now, contextTtlMs }) {
  const priorPendingType = clean(state.pendingClarification?.entityType, 20);
  const requiredType = requiredEntityType(proposal);
  const resolution = requiredType ? resolutions[requiredType] : null;

  if (resolution?.status === 'resolved') {
    const aliases = requiredType === 'product'
      ? confirmedProductAliases(proposal, resolution.entity, state.activeEntities.product)
      : [];
    state.activeEntities[requiredType] = {
      ...resolution.entity,
      ...(aliases.length ? { aliases } : {}),
      updatedAt: now,
      expiresAt: now + contextTtlMs,
    };
  }
  if (resolution?.status === 'ambiguous') {
    if (['product', 'family'].includes(priorPendingType)) {
      state.candidateSets[priorPendingType] = [];
    }
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
  if (!Number.isSafeInteger(contextTtlMs)
    || contextTtlMs <= 0
    || contextTtlMs > MAX_CONTEXT_TTL_MS) {
    throw new TypeError('contextTtlMs must be a bounded positive integer');
  }

  return {
    async resolve({ internalUserId, question, runtime = 'rule', proposal = null, context = {} } = {}) {
      const normalizedQuestion = typeof question === 'string' ? question.trim() : '';
      if (!normalizedQuestion || normalizedQuestion.length > 1_000) {
        throw new TypeError('question must be a bounded non-empty string');
      }
      const nowValue = clock();
      const now = nowValue instanceof Date ? nowValue.getTime() : nowValue;
      if (!Number.isSafeInteger(now)
        || now < 0
        || !Number.isSafeInteger(now + contextTtlMs)) {
        throw new TypeError('clock must return a safe timestamp');
      }

      const preparsed = preparseAgentMessage(normalizedQuestion);
      const state = sanitizedState(context, now, contextTtlMs);
      const proposalUnavailable = proposal === null || proposal === undefined;
      let selection = null;
      let effectiveProposal = normalizedProposal(proposal, normalizedQuestion);
      let proposalQuestion = normalizedQuestion;

      if (preparsed.candidateSelection) {
        selection = state.pendingClarification
          ? pendingSelection(state, preparsed.candidateSelection, now)
          : completedComparisonSelection(state, preparsed.candidateSelection, now);
        if (!selection.valid) {
          return expiredSelectionResult({
            state,
            entityType: selection.entityType,
            proposal: effectiveProposal,
          });
        }
        if (effectiveProposal) {
          const boundCurrentSelection = requiredEntityType(effectiveProposal) === selection.entityType
            && effectiveProposal.references.some((reference) => (
              reference.type === 'candidate_index'
              && reference.rawText === preparsed.candidateSelection.rawText
            ));
          if (!boundCurrentSelection) {
            return expiredSelectionResult({
              state,
              entityType: selection.entityType,
              proposal: effectiveProposal,
            });
          }
        } else if (proposalUnavailable && selection.proposal) {
          effectiveProposal = selection.proposal;
          proposalQuestion = selection.originalQuestion;
        }
      }

      if (!effectiveProposal
        && proposalUnavailable
        && runtime === 'rule'
        && preparsed.operationHint === 'upload_link') {
        effectiveProposal = uploadProposal();
      }

      const blocked = preflightResult({ state, proposal: effectiveProposal, runtime });
      if (blocked) return blocked;

      const resolutions = {};
      if (effectiveProposal?.intent === PRODUCT_INTENT) {
        const explicitProductMentions = semanticProductMentions(effectiveProposal);
        const explicitProduct = explicitProductMentions.length > 0;
        const currentProductReference = hasReference(effectiveProposal, 'current_product');
        const semanticQuestion = selection?.originalQuestion || normalizedQuestion;
        const explicitInsurers = effectiveProposal.mentions
          .filter((mention) => mention.type === 'insurer');
        const singleMentionCoversWholeQuestion = explicitProductMentions.length === 1
          && explicitProductMentions[0].rawText.trim() === semanticQuestion;
        const internalPlanQuery = comparesPlansWithinOneProduct(semanticQuestion)
          && ((explicitProductMentions.length === 1
            && !singleMentionCoversWholeQuestion
            && !currentProductReference)
            || (explicitProductMentions.length === 0
              && Boolean(state.activeEntities.product)));
        const requiresResidualProductScan = !internalPlanQuery;
        let scan = { entities: [], overflow: false, invalidInsurer: false };
        if (!selection
          && requiresResidualProductScan
          && typeof productResolver.resolveAllFromText === 'function') {
          try {
            scan = projectProductScan(await productResolver.resolveAllFromText({
              question: normalizedQuestion,
              insurerMentions: explicitInsurers,
            }));
          } catch {
            return resolverUnavailableResult({ state, proposal: effectiveProposal });
          }
          if (!scan) return resolverUnavailableResult({ state, proposal: effectiveProposal });
          if (scan.invalidInsurer || scan.overflow || scan.entities.length > 2) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }
        }

        const forcedComparison = explicitlyRequestsProductComparison(
          effectiveProposal,
          semanticQuestion,
        ) && !internalPlanQuery;
        const retainedComparisonProducts = state.lastCompletedAction?.comparison === true
          && state.lastCompletedAction?.intent === PRODUCT_INTENT
          && state.lastCompletedAction?.entityType === 'product'
          && state.candidateSets.product.length === 2
          ? state.candidateSets.product
          : [];
        const proposalProductMentionCount = explicitProductMentions.length;
        const continuesPreviousComparison = retainedComparisonProducts.length === 2
          && proposalProductMentionCount === 0
          && explicitInsurers.length === 0
          && (effectiveProposal.queryAspects.includes('sales_guidance')
            || /它们|这两款|两者|二者|各自|分别|哪个|哪款|推荐|更适合|怎么选|二选一/u.test(semanticQuestion));
        const comparisonRequested = forcedComparison
          || continuesPreviousComparison
          || proposalProductMentionCount > 1
          || scan.entities.length > 1;
        if (comparisonRequested) {
          const productMentions = explicitProductMentions
            .filter((mention, index, values) => values
              .findIndex((value) => value.rawText === mention.rawText) === index)
            .map((mention) => contextualProductMention(mention, state.activeEntities.product));
          const previousComparisonProducts = (forcedComparison || continuesPreviousComparison)
            && productMentions.length === 0
            && explicitInsurers.length === 0
            && retainedComparisonProducts.length === 2
            ? retainedComparisonProducts
            : [];
          if (selection && !selection.comparison) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }
          if (productMentions.length > 2) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }
          const comparesActiveProduct = forcedComparison
            && productMentions.length === 1
            && effectiveProposal.references.some((reference) => [
              'comparison_left', 'comparison_right', 'current_product',
            ].includes(reference.type));
          const activeComparisonProduct = comparesActiveProduct
            ? projectProduct(state.activeEntities.product)
            : null;
          const evidence = [];
          try {
            if (selection?.comparison) {
              for (const product of [...selection.selectedProducts, selection.candidate]) {
                evidence.push(projectResolution(await productResolver.resolve({
                  mentions: [
                    { type: 'insurer', rawText: product.company },
                    { type: 'product', rawText: product.officialName },
                  ],
                  activeProduct: null,
                  ...(product === selection.candidate ? { confirmedCandidate: product } : {}),
                }), 'product'));
              }
            } else if (previousComparisonProducts.length === 2) {
              for (const product of previousComparisonProducts) {
                evidence.push(projectResolution(await productResolver.resolve({
                  mentions: [
                    { type: 'insurer', rawText: product.company },
                    { type: 'product', rawText: product.officialName },
                  ],
                  activeProduct: null,
                }), 'product'));
              }
            } else if (comparesActiveProduct) {
              evidence.push(projectResolution(await productResolver.resolve({
                mentions: [...explicitInsurers, productMentions[0]],
                activeProduct: null,
              }), 'product'));
              if (activeComparisonProduct) {
                evidence.push(projectResolution(await productResolver.resolve({
                  mentions: [
                    { type: 'insurer', rawText: activeComparisonProduct.company },
                    { type: 'product', rawText: activeComparisonProduct.officialName },
                  ],
                  activeProduct: null,
                }), 'product'));
              }
            } else if (scan.entities.length === 2) {
              for (const product of scan.entities) {
                evidence.push(projectResolution(await productResolver.resolve({
                  mentions: [
                    { type: 'insurer', rawText: product.company },
                    { type: 'product', rawText: product.officialName },
                  ],
                  activeProduct: null,
                }), 'product'));
              }
            } else if (productMentions.length === 2) {
              for (const mention of productMentions) {
                evidence.push(projectResolution(await productResolver.resolve({
                  mentions: [...(explicitInsurers.length <= 1 ? explicitInsurers : []), mention],
                  activeProduct: null,
                }), 'product'));
              }
            }
          } catch {
            return resolverUnavailableResult({ state, proposal: effectiveProposal });
          }
          const products = evidence.filter((item) => item.status === 'resolved')
            .map((item) => item.entity);
          if (selection?.comparison && selection.selectedProducts.length === 0) {
            const selectedProduct = products[0] || null;
            if (!selectedProduct) {
              return unsupportedComparisonResult({ state, proposal: effectiveProposal });
            }
            const remainingCandidates = state.candidateSets.product.filter((candidate) => (
              candidate.canonicalProductId !== selectedProduct.canonicalProductId
            ));
            return unsupportedComparisonResult({
              state,
              proposal: effectiveProposal,
              question: selection.originalQuestion,
              candidates: remainingCandidates,
              selectedProducts: [selectedProduct],
            });
          }
          const distinctProductCount = new Set(products
            .map((item) => clean(item.canonicalProductId))).size;
          const scanCanonicalIds = new Set(scan.entities
            .map((item) => clean(item.canonicalProductId)).filter(Boolean));
          const comparisonCanonicalIds = new Set(products
            .map((item) => clean(item.canonicalProductId)).filter(Boolean));
          const scanConflicts = comparesActiveProduct && [...scanCanonicalIds]
            .some((canonicalId) => !comparisonCanonicalIds.has(canonicalId));
          if (products.length === 2 && distinctProductCount === 1
            && !forcedComparison && scan.entities.length <= 1) {
            // A formal name plus its parenthetical alias is one product, not a comparison.
          } else if (products.length !== 2 || distinctProductCount !== 2 || scanConflicts) {
            const comparisonCandidates = evidence.flatMap((item) => (
              item.status === 'ambiguous'
                ? item.candidates
                : (item.status === 'resolved' ? [item.entity] : [])
            ));
            return unsupportedComparisonResult({
              state,
              proposal: effectiveProposal,
              question: semanticQuestion,
              candidates: comparisonCandidates,
            });
          } else {
            return resolvedComparisonResult({
              state,
              proposal: effectiveProposal,
              products,
              question: semanticQuestion,
            });
          }
        }

        const selectedProduct = selection?.entityType === 'product'
          ? projectProduct(selection.candidate)
          : null;
        const referencedProduct = !explicitProduct
          && currentProductReference
          ? projectProduct(state.activeEntities.product)
          : null;
        const omittedActiveProduct = !explicitProduct
          && !currentProductReference
          && !state.pendingClarification
          && state.activeIntent === PRODUCT_INTENT
          ? projectProduct(state.activeEntities.product, { active: true })
          : null;
        const scannedProduct = !explicitProduct && !currentProductReference && scan.entities.length === 1
          ? scan.entities[0]
          : null;
        const mentions = selectedProduct
          ? [
            { type: 'product', rawText: selectedProduct.officialName },
          ]
            : referencedProduct
            ? [
              ...(explicitInsurers.length
                ? explicitInsurers
                : [{ type: 'insurer', rawText: referencedProduct.company }]),
              { type: 'product', rawText: referencedProduct.officialName },
            ]
            : scannedProduct
              ? [
                { type: 'insurer', rawText: scannedProduct.company },
                { type: 'product', rawText: scannedProduct.officialName },
              ]
              : effectiveProposal.mentions;
        if (!selectedProduct && !explicitProduct && currentProductReference && !referencedProduct) {
          resolutions.product = { status: 'missing', entity: null, candidates: [] };
        } else if (!selectedProduct && explicitProduct) {
          const productMentions = explicitProductMentions
            .filter((mention, index, values) => values
              .findIndex((value) => value.rawText === mention.rawText) === index)
            .map((mention) => contextualProductMention(mention, state.activeEntities.product));
          if (productMentions.length > 7) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }
          const explicitInsurerMentions = effectiveProposal.mentions
            .filter((mention) => mention.type === 'insurer');
          const activeConfirmedProduct = projectProduct(state.activeEntities.product);
          const evidence = [];
          try {
            for (const productMention of productMentions) {
              const confirmsActiveProduct = activeConfirmedProduct
                && clean(productMention.rawText) === activeConfirmedProduct.officialName;
              evidence.push(projectResolution(await productResolver.resolve({
                mentions: [...explicitInsurerMentions, productMention],
                activeProduct: null,
                ...(confirmsActiveProduct ? { confirmedCandidate: activeConfirmedProduct } : {}),
              }), 'product'));
            }
          } catch {
            return resolverUnavailableResult({ state, proposal: effectiveProposal });
          }

          const explicitCanonicalIds = evidence.map((result) => (
            result.status === 'resolved' ? clean(result.entity.canonicalProductId) : ''
          )).filter(Boolean);
          if (productMentions.length > 1 && (evidence.some((result) => result.status !== 'resolved')
            || explicitCanonicalIds.length !== productMentions.length
            || new Set(explicitCanonicalIds).size !== 1)) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }

          resolutions.product = evidence[0] || { status: 'missing', entity: null, candidates: [] };
          if (resolutions.product.status === 'ambiguous' && scan.entities.length === 1) {
            const scannedProduct = scan.entities[0];
            const scannedCandidateIsCompatible = resolutions.product.candidates.some((candidate) => (
              candidate.canonicalProductId === scannedProduct.canonicalProductId
            ));
            if (scannedCandidateIsCompatible) {
              try {
                const scannedResolution = projectResolution(await productResolver.resolve({
                  mentions: [
                    { type: 'insurer', rawText: scannedProduct.company },
                    { type: 'product', rawText: scannedProduct.officialName },
                  ],
                  activeProduct: null,
                }), 'product');
                if (scannedResolution.status === 'resolved'
                  && scannedResolution.entity.canonicalProductId === scannedProduct.canonicalProductId) {
                  resolutions.product = scannedResolution;
                }
              } catch {
                return resolverUnavailableResult({ state, proposal: effectiveProposal });
              }
            }
          }
        } else if (omittedActiveProduct && !scannedProduct) {
          try {
            resolutions.product = projectResolution(await productResolver.resolve({
              mentions: explicitInsurers.length
                ? [
                  ...explicitInsurers,
                  { type: 'product', rawText: omittedActiveProduct.officialName },
                ]
                : [],
              activeProduct: explicitInsurers.length ? null : omittedActiveProduct,
            }), 'product');
          } catch {
            return resolverUnavailableResult({ state, proposal: effectiveProposal });
          }
        } else {
          try {
            resolutions.product = projectResolution(await productResolver.resolve({
              mentions,
              activeProduct: null,
              ...(selectedProduct ? { confirmedCandidate: selectedProduct } : {}),
            }), 'product');
          } catch {
            return resolverUnavailableResult({ state, proposal: effectiveProposal });
          }
        }

        if (!selectedProduct && (explicitProduct || referencedProduct)) {
          const primaryCanonicalId = resolutions.product?.status === 'resolved'
            ? clean(resolutions.product.entity.canonicalProductId)
            : '';
          const canonicalIds = new Set(scan.entities.map((entity) => entity.canonicalProductId));
          if (primaryCanonicalId) canonicalIds.add(primaryCanonicalId);
          if (canonicalIds.size > 1) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }
        }
      } else if (effectiveProposal && requiredEntityType(effectiveProposal) === 'family') {
        const explicitFamily = hasMention(effectiveProposal, 'family');
        const currentFamilyReference = hasReference(effectiveProposal, 'current_family');
        const activeFamily = selection?.entityType === 'family'
          ? selection.candidate
          : !explicitFamily && currentFamilyReference
            ? state.activeEntities.family
            : null;
        const mentions = selection?.entityType === 'family'
          ? effectiveProposal.mentions.filter((mention) => mention.type !== 'family')
          : effectiveProposal.mentions;
        if (!selection && !explicitFamily && currentFamilyReference && !activeFamily) {
          resolutions.family = { status: 'missing', entity: null, candidates: [] };
        } else {
          try {
            resolutions.family = projectResolution(await familyResolver.resolve({
              internalUserId,
              mentions,
              activeFamily: activeFamily ? projectFamily(activeFamily) : null,
            }), 'family');
          } catch {
            return resolverUnavailableResult({ state, proposal: effectiveProposal });
          }
        }
      }

      const readiness = decideSemanticReadiness({ proposal: effectiveProposal, resolutions, runtime });
      const resolvedEntities = {};
      if (resolutions.product?.status === 'resolved') resolvedEntities.product = resolutions.product.entity;
      if (resolutions.family?.status === 'resolved') resolvedEntities.family = resolutions.family.entity;
      const candidateQuestion = selection ? proposalQuestion : normalizedQuestion;
      const resolvedProposal = resolvedEntities.product
        && comparesPlansWithinOneProduct(candidateQuestion)
        && effectiveProposal.queryAspects.includes('comparison')
        ? {
          ...effectiveProposal,
          queryAspects: [...new Set([
            ...effectiveProposal.queryAspects.filter((aspect) => aspect !== 'comparison'),
            'main_responsibilities',
          ])],
        }
        : effectiveProposal;
      const candidate = readiness.decision === 'execute'
        ? semanticFrameToRouterCandidate(
          { ...resolvedProposal, resolvedEntities },
          candidateQuestion,
        )
        : null;

      return {
        ...readiness,
        proposal: resolvedProposal,
        resolvedEntities,
        candidate,
        nextTaskState: effectiveProposal
          ? stateAfterResolution({
            state,
            proposal: resolvedProposal,
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
