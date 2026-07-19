export const SALES_CHAMPION_BOUNDARY_GROUP_KEYS = Object.freeze([
  'customer_relationship',
  'meeting_intent',
  'conversation_progress',
  'customer_goal',
  'objection',
  'decision_and_consent',
  'insurance_evidence',
  'sales_stage',
]);

export const SALES_CHAMPION_BOUNDARY_SLOT_KEYS = Object.freeze([
  'customer_relationship_origin',
  'current_service_task',
  'meeting_trigger',
  'explicit_customer_request',
  'conversation_end_state',
  'customer_goal',
  'goal_source',
  'customer_problem',
  'objection_reason',
  'future_fund_use',
  'fund_use_timeline',
  'sustainable_budget',
  'decision_participants',
  'customer_decision',
  'contact_preference',
  'referral_consent',
  'existing_arrangement_goal',
  'existing_policy_evidence',
  'product_identity',
  'insurer_identity',
  'product_change_evidence',
  'service_issue',
]);

export const SALES_CHAMPION_ACTION_SIGNATURE_KEYS = Object.freeze([
  'scope_conversation',
  'discover_need',
  'diagnose_objection',
  'explain_tradeoff',
  'rebuild_trust',
  'facilitate_decision',
  'protect_customer_choice',
  'protect_compliance_boundary',
  'obtain_consent',
  'service_first',
  'explain_verified_facts',
  'route_verified_evidence',
  'advance_next_step',
  'safe_fallback',
]);

export const SALES_CHAMPION_UNKNOWN_FALLBACK_KEYS = Object.freeze([
  'generic_safe_follow_up',
  'generic_service_first',
  'acknowledge_and_discover',
  'defer_fact_until_verified',
]);

export const SALES_CHAMPION_EXCLUDED_SIGNAL_KEYS = Object.freeze([
  'explicit_refusal',
  'stop_contact',
]);

const VALID_GROUPS = new Set(SALES_CHAMPION_BOUNDARY_GROUP_KEYS);
const VALID_SLOTS = new Set(SALES_CHAMPION_BOUNDARY_SLOT_KEYS);
const VALID_ACTION_SIGNATURES = new Set(SALES_CHAMPION_ACTION_SIGNATURE_KEYS);
const VALID_UNKNOWN_FALLBACKS = new Set(SALES_CHAMPION_UNKNOWN_FALLBACK_KEYS);
const VALID_EXCLUDED_SIGNALS = new Set(SALES_CHAMPION_EXCLUDED_SIGNAL_KEYS);

function assertRegisteredArray(values, path, validValues, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length)) {
    throw new TypeError(`${path} must be ${allowEmpty ? 'an' : 'a non-empty'} array`);
  }
  if (values.some((value) => typeof value !== 'string' || !validValues.has(value))) {
    throw new TypeError(`${path} contains an unregistered value`);
  }
  if (new Set(values).size !== values.length) throw new TypeError(`${path} contains duplicate values`);
}

export function validateSalesChampionSkillBoundary(boundary, path = 'boundary') {
  if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary)) {
    throw new TypeError(`${path} must be an object`);
  }
  const allowedFields = new Set([
    'groups',
    'confirmedSituations',
    'probeSlots',
    'requiredSlots',
    'helpfulSlots',
    'excludedSignals',
    'unknownFallback',
  ]);
  for (const field of Object.keys(boundary)) {
    if (!allowedFields.has(field)) throw new TypeError(`${path} contains unknown field: ${field}`);
  }
  assertRegisteredArray(boundary.groups, `${path}.groups`, VALID_GROUPS, { allowEmpty: false });
  assertRegisteredArray(boundary.probeSlots, `${path}.probeSlots`, VALID_SLOTS);
  assertRegisteredArray(boundary.requiredSlots, `${path}.requiredSlots`, VALID_SLOTS);
  assertRegisteredArray(boundary.helpfulSlots, `${path}.helpfulSlots`, VALID_SLOTS);
  assertRegisteredArray(boundary.excludedSignals, `${path}.excludedSignals`, VALID_EXCLUDED_SIGNALS);
  if (!Array.isArray(boundary.confirmedSituations)
    || boundary.confirmedSituations.some((value) => typeof value !== 'string' || !value)
    || new Set(boundary.confirmedSituations).size !== boundary.confirmedSituations.length) {
    throw new TypeError(`${path}.confirmedSituations must be a unique string array`);
  }
  if (!VALID_UNKNOWN_FALLBACKS.has(boundary.unknownFallback)) {
    throw new TypeError(`${path}.unknownFallback is unregistered`);
  }
  const duplicatedSlots = boundary.requiredSlots.filter((slot) => boundary.helpfulSlots.includes(slot));
  if (duplicatedSlots.length) throw new TypeError(`${path} repeats slots across requiredSlots and helpfulSlots`);
  return true;
}

export function createSalesChampionSkillBoundary({
  groups,
  confirmedSituations = [],
  probeSlots = [],
  requiredSlots = [],
  helpfulSlots = [],
  excludedSignals = SALES_CHAMPION_EXCLUDED_SIGNAL_KEYS,
  unknownFallback = 'generic_safe_follow_up',
}) {
  const boundary = {
    groups: [...groups],
    confirmedSituations: [...confirmedSituations],
    probeSlots: [...probeSlots],
    requiredSlots: [...requiredSlots],
    helpfulSlots: [...helpfulSlots],
    excludedSignals: [...excludedSignals],
    unknownFallback,
  };
  validateSalesChampionSkillBoundary(boundary);
  return Object.freeze(Object.fromEntries(
    Object.entries(boundary).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze(value) : value]),
  ));
}

export function validateSalesChampionActionSignature(actionSignature, path = 'actionSignature') {
  if (!VALID_ACTION_SIGNATURES.has(actionSignature)) {
    throw new TypeError(`${path} is unregistered`);
  }
  return true;
}
