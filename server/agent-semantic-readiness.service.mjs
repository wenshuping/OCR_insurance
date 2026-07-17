import { SEMANTIC_INTENTS } from './agent-semantic-contract.mjs';

export const MIN_AGENT_INTENT_CONFIDENCE = 0.70;

const RUNTIMES = new Set(['hermes', 'direct', 'rule']);
const MAX_ENTITY_TEXT_LENGTH = 200;
const REQUIRED_ENTITY = new Map([
  ['insurance_product_knowledge', 'product'],
  ['family_summary', 'family'],
  ['coverage_report', 'family'],
  ['sales_report', 'family'],
]);

function requiredEntity(proposal) {
  if (proposal?.intent === 'sales_coaching'
    && (proposal.mentions?.some((mention) => mention?.type === 'family')
      || proposal.references?.some((reference) => reference?.type === 'current_family'))) {
    return 'family';
  }
  return REQUIRED_ENTITY.get(proposal?.intent);
}

function result(decision, decisionReason, missingFields = [], ambiguities = []) {
  return { decision, decisionReason, missingFields, ambiguities };
}

function positiveSafeInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) return false;
  return Number.isSafeInteger(Number(value));
}

function boundedNonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_ENTITY_TEXT_LENGTH;
}

function boundedOptionalString(value) {
  return value === undefined || value === ''
    || (typeof value === 'string' && value.length <= MAX_ENTITY_TEXT_LENGTH);
}

function validResolvedEntity(key, resolution) {
  if (resolution?.status !== 'resolved' || !resolution.entity
    || typeof resolution.entity !== 'object' || Array.isArray(resolution.entity)) return false;
  if (key === 'family') {
    return positiveSafeInteger(resolution.entity.familyId)
      && boundedNonemptyString(resolution.entity.displayName);
  }
  if (key === 'product') {
    return boundedNonemptyString(resolution.entity.officialName)
      && boundedNonemptyString(resolution.entity.canonicalProductId)
      && boundedOptionalString(resolution.entity.company);
  }
  return false;
}

export function decideSemanticReadiness({ proposal, resolutions = {}, runtime = 'rule' } = {}) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    return result('retry_later', 'semantic_proposal_unavailable');
  }
  if (!SEMANTIC_INTENTS.includes(proposal.intent)) {
    return result('reject', 'unsupported_intent');
  }

  const intentConfidence = proposal?.confidence?.intent;
  if (typeof intentConfidence !== 'number'
    || !Number.isFinite(intentConfidence)
    || intentConfidence < MIN_AGENT_INTENT_CONFIDENCE
    || intentConfidence > 1) {
    return result('clarify', 'low_intent_confidence');
  }
  if (!RUNTIMES.has(runtime)) return result('retry_later', 'unsupported_runtime');
  if (proposal.operation !== 'read' && proposal.operation !== 'write') {
    return result('reject', 'unsupported_operation');
  }
  if (proposal.operation === 'write' && runtime !== 'hermes') {
    return result('clarify', 'unsafe_fallback_operation');
  }

  const requiredEntityKey = requiredEntity(proposal);
  if (!requiredEntityKey) return result('execute', 'semantic_ready');
  const resolution = resolutions && typeof resolutions === 'object'
    ? resolutions[requiredEntityKey]
    : null;
  if (resolution?.status === 'ambiguous') {
    return result('clarify', 'entity_ambiguous', [], [requiredEntityKey]);
  }
  if (!validResolvedEntity(requiredEntityKey, resolution)) {
    return result('clarify', `${requiredEntityKey}_required`, [requiredEntityKey]);
  }
  return result('execute', 'unique_authorized_entity');
}
