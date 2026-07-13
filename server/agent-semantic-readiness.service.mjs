import { SEMANTIC_INTENTS } from './agent-semantic-contract.mjs';

export const MIN_AGENT_INTENT_CONFIDENCE = 0.70;

const RUNTIMES = new Set(['hermes', 'direct', 'rule']);
const REQUIRED_ENTITY = new Map([
  ['insurance_product_knowledge', 'product'],
  ['family_summary', 'family'],
  ['coverage_report', 'family'],
  ['sales_report', 'family'],
  ['sales_coaching', 'family'],
]);

function result(decision, decisionReason, missingFields = [], ambiguities = []) {
  return { decision, decisionReason, missingFields, ambiguities };
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

  const requiredEntity = REQUIRED_ENTITY.get(proposal.intent);
  if (!requiredEntity) return result('execute', 'semantic_ready');
  const resolution = resolutions && typeof resolutions === 'object'
    ? resolutions[requiredEntity]
    : null;
  if (resolution?.status === 'ambiguous') {
    return result('clarify', 'entity_ambiguous', [], [requiredEntity]);
  }
  if (resolution?.status !== 'resolved') {
    return result('clarify', `${requiredEntity}_required`, [requiredEntity]);
  }
  return result('execute', 'unique_authorized_entity');
}
