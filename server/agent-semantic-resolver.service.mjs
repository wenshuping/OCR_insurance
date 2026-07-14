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
const MAX_CONTEXT_TTL_MS = 86_400_000;
const PRODUCT_RESOLVED_MATCH_TYPES = new Set([
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

function projectCandidates(value, type) {
  if (!Array.isArray(value)) return [];
  const project = type === 'product' ? projectProduct : projectFamily;
  return value.slice(0, MAX_CANDIDATES).map((item) => project(item)).filter(Boolean);
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

function hasReference(proposal, type) {
  return proposal.references.some((reference) => reference.type === type);
}

function requiredEntityType(intent) {
  if (intent === PRODUCT_INTENT) return 'product';
  if (FAMILY_INTENTS.has(intent)) return 'family';
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
    now,
    contextTtlMs,
    activeIntent: clean(state.activeIntent, 80),
    activeEntities: {
      product: projectActive(activeEntities.product, 'product', now, contextTtlMs),
      family: projectActive(activeEntities.family, 'family', now, contextTtlMs),
    },
    candidateSets: {
      product: projectCandidates(candidateSets.product, 'product'),
      family: projectCandidates(candidateSets.family, 'family'),
    },
    pendingClarification: projectPendingClarification(state.pendingClarification, now, contextTtlMs),
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
    pendingClarification: projectPendingClarification(
      state.pendingClarification,
      state.now,
      state.contextTtlMs,
    ),
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

function comparisonState(state, proposal) {
  const pendingType = clean(state.pendingClarification?.entityType, 20);
  if (pendingType === 'product' || pendingType === 'family') state.candidateSets[pendingType] = [];
  state.candidateSets.product = [];
  state.pendingClarification = null;
  state.activeEntities.product = null;
  state.activeIntent = proposal.intent;
  state.lastCompletedAction = { intent: proposal.intent, entityType: 'product' };
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
    nextTaskState: comparisonState(state, proposal),
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

function unsupportedComparisonResult({ state, proposal }) {
  const pendingType = clean(state.pendingClarification?.entityType, 20);
  if (pendingType === 'product' || pendingType === 'family') state.candidateSets[pendingType] = [];
  state.pendingClarification = null;
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
  if (!candidate || !proposal || requiredEntityType(proposal.intent) !== entityType) {
    return { valid: false, entityType };
  }
  return { valid: true, entityType, candidate, proposal, originalQuestion };
}

function stateAfterResolution({ state, proposal, proposalQuestion, resolutions, readiness, now, contextTtlMs }) {
  const priorPendingType = clean(state.pendingClarification?.entityType, 20);
  const requiredType = requiredEntityType(proposal.intent);
  const resolution = requiredType ? resolutions[requiredType] : null;

  if (resolution?.status === 'resolved') {
    state.activeEntities[requiredType] = {
      ...resolution.entity,
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
        const explicitProduct = hasMention(effectiveProposal, 'product');
        const currentProductReference = hasReference(effectiveProposal, 'current_product');
        const explicitInsurers = effectiveProposal.mentions
          .filter((mention) => mention.type === 'insurer');
        let scan = { entities: [], overflow: false, invalidInsurer: false };
        if (!selection && typeof productResolver.resolveAllFromText === 'function') {
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
          normalizedQuestion,
        );
        const comparisonRequested = forcedComparison
          || effectiveProposal.mentions.filter((mention) => mention.type === 'product').length > 1
          || scan.entities.length > 1;
        if (comparisonRequested) {
          const productMentions = effectiveProposal.mentions
            .filter((mention) => mention.type === 'product')
            .filter((mention, index, values) => values
              .findIndex((value) => value.rawText === mention.rawText) === index);
          if (selection || productMentions.length > 2) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }
          const evidence = [];
          try {
            if (scan.entities.length === 2) {
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
          const distinctProductCount = new Set(products
            .map((item) => clean(item.canonicalProductId))).size;
          if (products.length === 2 && distinctProductCount === 1
            && !forcedComparison && scan.entities.length <= 1) {
            // A formal name plus its parenthetical alias is one product, not a comparison.
          } else if (products.length !== 2 || distinctProductCount !== 2) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          } else {
            return resolvedComparisonResult({
              state,
              proposal: effectiveProposal,
              products,
              question: normalizedQuestion,
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
            { type: 'insurer', rawText: selectedProduct.company },
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
          const productMentions = effectiveProposal.mentions
            .filter((mention) => mention.type === 'product')
            .filter((mention, index, values) => values
              .findIndex((value) => value.rawText === mention.rawText) === index);
          if (productMentions.length > 7) {
            return unsupportedComparisonResult({ state, proposal: effectiveProposal });
          }
          const explicitInsurerMentions = effectiveProposal.mentions
            .filter((mention) => mention.type === 'insurer');
          const evidence = [];
          try {
            for (const productMention of productMentions) {
              evidence.push(projectResolution(await productResolver.resolve({
                mentions: [...explicitInsurerMentions, productMention],
                activeProduct: null,
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
      } else if (effectiveProposal && FAMILY_INTENTS.has(effectiveProposal.intent)) {
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
