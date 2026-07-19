import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';
import { SALES_CHAMPION_BOUNDARY_SLOT_KEYS } from './sales-champion-skill-boundary.mjs';
import { SALES_CHAMPION_EXTERNAL_SITUATION_KEYS } from './sales-champion-external-skill-mappings.mjs';
import { SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY } from './sales-champion-customer-labels.mjs';

const CONTRACT_VERSION = 1;

const STAGES = new Set([
  'contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale',
]);
const CONCERN_TYPES = new Set([
  'liquidity', 'duration', 'family_decision', 'trust', 'affordability', 'product_fit',
  'insurer_safety', 'benefits', 'claims', 'underwriting', 'surrender', 'rebate',
  'risk_pooling', 'follow_up', 'unknown',
]);
const PRIORITIES = new Set(['primary', 'secondary']);
const TURN_RELATIONS = new Set(['new_request', 'follow_up_answer', 'context_update', 'correction']);
const CUSTOMER_CASE_RELATIONS = new Set(['same_customer', 'new_customer', 'uncertain']);
const STATEMENT_SOURCES = new Set(['current_message', 'confirmed_history']);
export const SALES_CHAMPION_KYC_FACT_KEYS = Object.freeze([
  'age_life_stage', 'occupation', 'employment_status', 'income', 'income_type',
  'income_stability', 'marital_status', 'children', 'dependents', 'residence',
  'housing', 'assets', 'liabilities', 'existing_insurance', 'customer_goal',
  'insurance_attitude', 'purchase_behavior', 'decision_process', 'contact_preference',
  'service_request', 'relationship_origin', 'conversation_outcome',
]);
const KYC_FACT_KEYS = new Set(SALES_CHAMPION_KYC_FACT_KEYS);
export const SALES_CHAMPION_KYC_EVIDENCE_SOURCES = Object.freeze([
  'customer_statement', 'advisor_fact', 'advisor_estimate', 'advisor_inference',
]);
const KYC_EVIDENCE_SOURCES = new Set(SALES_CHAMPION_KYC_EVIDENCE_SOURCES);
const CUSTOMER_LABEL_STATUSES = new Set(['confirmed', 'candidate']);
export const SALES_CHAMPION_MISSING_INFORMATION_KEYS = Object.freeze([...new Set([
  'customer_goal', 'future_fund_use', 'budget', 'existing_coverage', 'product_contract',
  'cash_value_schedule', 'family_decision_process', 'health_information', 'contact_preference',
  ...SALES_CHAMPION_BOUNDARY_SLOT_KEYS,
])]);
const MISSING_INFORMATION = new Set(SALES_CHAMPION_MISSING_INFORMATION_KEYS);
const INSURANCE_NEED_TYPES = new Set(['product_facts', 'coverage_gap']);
const QUERY_ASPECTS = new Set(SEMANTIC_QUERY_ASPECTS);
export const SALES_CHAMPION_SITUATION_KEYS = Object.freeze([
  'first_insurance_conversation', 'orphan_policy', 'high_value_client',
  'retirement_planning', 'investment_comparison', 'long_payment_commitment',
  'premium_coverage_tradeoff', 'medical_critical_illness_overlap',
  'social_commercial_overlap', 'dividend_uncertainty', 'solvency_concern',
  'return_expectation', 'buying_signal', 'health_risk_conversation',
  'verified_product_change', 'service_trust_recovery', 'existing_customer_add_on',
  'event_follow_up', 'regional_pipeline',
  'online_purchase_comparison', 'phone_only_appointment', 'silent_after_proposal',
  'anti_insurance_content', 'consented_referral', 'maturing_deposit',
  'insurer_failure_concern', 'cooling_off_surrender', 'insurance_value_explanation',
  'low_rate_objection', 'critical_illness_price_increase', 'gold_comparison',
  'forced_saving_fit', 'family_member_opposition', 'acquaintance_opening',
  'already_bought_too_much', 'wealth_preservation_goal', 'advisor_continuity_concern',
  'age_based_purchase_delay', 'term_whole_life_choice', 'third_party_cover_overlap',
  'cancer_only_cover_overlap', 'crowdfunding_substitute', 'underwriting_restriction',
  'disease_count_comparison', 'claims_process_concern', 'similar_plan_price_difference',
  'premium_wasted_objection', 'debt_budget_constraint', 'rebate_request',
  'postpone_without_date', 'existing_coverage_amount', 'advisor_fit_concern',
  'long_term_savings_liquidity', 'insurance_superstition',
  ...SALES_CHAMPION_EXTERNAL_SITUATION_KEYS,
]);
const SITUATION_KEYS = new Set(SALES_CHAMPION_SITUATION_KEYS);
export const SALES_CHAMPION_CAPABILITY_KEYS = Object.freeze([
  'appointment_scope',
  'tradeoff_disclosure',
  'five_question_diagnosis',
  'reputation_objection',
  'risk_pooling_explanation',
  'needs_discovery',
  'family_joint_decision',
  'rebate_request_handling',
  'cooling_off_support',
  'follow_up_consent',
  'referral_request',
  'plain_language_explanation',
  'fact_sensitive_routing',
  'general_sales_clarification',
]);
const CAPABILITY_KEYS = new Set(SALES_CHAMPION_CAPABILITY_KEYS);

function assertObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
}
function assertExactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new TypeError(`${path} unknown field: ${key}`);
  }
  for (const key of allowed) {
    if (!(key in value)) throw new TypeError(`${path}.${key} is required`);
  }
}

function assertConfidence(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${path} must be between 0 and 1`);
  }
}

function normalizeGroundingText(value) {
  return String(value || '').replace(/\s+/gu, '');
}

export function hasExplicitCustomerAttribution(evidence, sourceTexts = []) {
  const normalizedEvidence = normalizeGroundingText(evidence);
  if (!normalizedEvidence) return false;
  const customerExpression = /(?:客户|顾客|投保人|被保险人|他|她|对方|人家).{0,20}(?:说|表示|提到|回复|告诉|明确|要求|拒绝|同意|答应|认为|觉得|担心|希望|想要|想|不愿|愿意)/u;
  return sourceTexts.some((sourceText) => {
    const source = normalizeGroundingText(sourceText);
    const index = source.indexOf(normalizedEvidence);
    if (index < 0) return false;
    const start = Math.max(0, index - 60);
    const end = Math.min(source.length, index + normalizedEvidence.length + 20);
    return customerExpression.test(source.slice(start, end));
  });
}

export function validateSalesTurnProposal(proposal, { sourceTexts = [] } = {}) {
  assertObject(proposal, 'proposal');
  proposal = {
    ...proposal,
    situations: Object.hasOwn(proposal, 'situations') ? proposal.situations : [],
    kycFacts: Object.hasOwn(proposal, 'kycFacts') ? proposal.kycFacts : [],
    customerLabels: Object.hasOwn(proposal, 'customerLabels') ? proposal.customerLabels : [],
    unknownInformation: Object.hasOwn(proposal, 'unknownInformation')
      ? proposal.unknownInformation : [],
    answeredInformation: Object.hasOwn(proposal, 'answeredInformation')
      ? proposal.answeredInformation : [],
    turnRelation: Object.hasOwn(proposal, 'turnRelation')
      ? proposal.turnRelation : { value: 'new_request', confidence: 1 },
    customerCase: Object.hasOwn(proposal, 'customerCase')
      ? proposal.customerCase : { relation: 'uncertain', confidence: 0 },
  };
  assertExactKeys(proposal, [
    'contractVersion', 'customerStatements', 'stage', 'concerns', 'signals',
    'missingInformation', 'proposedCapabilities', 'insuranceNeeds', 'situations',
    'kycFacts', 'customerLabels', 'unknownInformation', 'answeredInformation', 'turnRelation',
    'customerCase',
  ], 'proposal');
  if (proposal.contractVersion !== CONTRACT_VERSION) {
    throw new TypeError(`contractVersion must be ${CONTRACT_VERSION}`);
  }

  assertObject(proposal.turnRelation, 'turnRelation');
  assertExactKeys(proposal.turnRelation, ['value', 'confidence'], 'turnRelation');
  if (!TURN_RELATIONS.has(proposal.turnRelation.value)) throw new TypeError('turnRelation.value is invalid');
  assertConfidence(proposal.turnRelation.confidence, 'turnRelation.confidence');

  assertObject(proposal.customerCase, 'customerCase');
  assertExactKeys(proposal.customerCase, ['relation', 'confidence'], 'customerCase');
  if (!CUSTOMER_CASE_RELATIONS.has(proposal.customerCase.relation)) {
    throw new TypeError('customerCase.relation is invalid');
  }
  assertConfidence(proposal.customerCase.confidence, 'customerCase.confidence');

  if (!Array.isArray(proposal.customerStatements) || proposal.customerStatements.length > 20) {
    throw new TypeError('customerStatements must be an array with at most 20 items');
  }
  let customerStatementCharacters = 0;
  const groundingSources = sourceTexts.map(normalizeGroundingText).filter(Boolean);
  const currentGroundingSource = normalizeGroundingText(sourceTexts[0]);
  const historicalGroundingSources = sourceTexts.slice(1).map(normalizeGroundingText).filter(Boolean);
  proposal.customerStatements.forEach((statement, index) => {
    assertObject(statement, `customerStatements[${index}]`);
    assertExactKeys(statement, ['text', 'source'], `customerStatements[${index}]`);
    const statementText = String(statement.text || '').trim();
    if (!statementText || statementText.length > 500) {
      throw new TypeError(`customerStatements[${index}].text is invalid`);
    }
    customerStatementCharacters += statementText.length;
    if (!STATEMENT_SOURCES.has(statement.source)) {
      throw new TypeError(`customerStatements[${index}].source is invalid`);
    }
    const normalizedStatement = normalizeGroundingText(statementText);
    const expectedSources = statement.source === 'current_message'
      ? [currentGroundingSource].filter(Boolean)
      : historicalGroundingSources;
    const grounded = expectedSources.some((source) => source.includes(normalizedStatement));
    if (!grounded && groundingSources.some((source) => source.includes(normalizedStatement))) {
      throw new TypeError(`customerStatements[${index}].source does not match evidence`);
    }
    if (!grounded) throw new TypeError(`customerStatements[${index}].text must be grounded`);
  });
  if (customerStatementCharacters > 4_000) {
    throw new TypeError('customerStatements exceed the character budget');
  }

  if (!Array.isArray(proposal.kycFacts) || proposal.kycFacts.length > 16) {
    throw new TypeError('kycFacts must be an array with at most 16 items');
  }
  proposal.kycFacts.forEach((fact, index) => {
    assertObject(fact, `kycFacts[${index}]`);
    assertExactKeys(fact, ['key', 'value', 'source', 'evidence'], `kycFacts[${index}]`);
    if (!KYC_FACT_KEYS.has(fact.key)) throw new TypeError(`kycFacts[${index}].key is invalid`);
    if (typeof fact.value !== 'string' || !fact.value.trim() || fact.value.length > 200) {
      throw new TypeError(`kycFacts[${index}].value is invalid`);
    }
    if (!KYC_EVIDENCE_SOURCES.has(fact.source)) {
      throw new TypeError(`kycFacts[${index}].source is invalid`);
    }
    if (typeof fact.evidence !== 'string' || !fact.evidence.trim() || fact.evidence.length > 500
      || !groundingSources.some((source) => source.includes(normalizeGroundingText(fact.evidence)))) {
      throw new TypeError(`kycFacts[${index}].evidence must be grounded`);
    }
    if (fact.source === 'customer_statement'
      && !hasExplicitCustomerAttribution(fact.evidence, sourceTexts)) {
      throw new TypeError(`kycFacts[${index}].source requires explicit customer attribution`);
    }
  });

  if (!Array.isArray(proposal.customerLabels) || proposal.customerLabels.length > 20) {
    throw new TypeError('customerLabels must be an array with at most 20 items');
  }
  const customerLabelKeys = new Set();
  proposal.customerLabels.forEach((label, index) => {
    assertObject(label, `customerLabels[${index}]`);
    assertExactKeys(
      label,
      ['dimension', 'value', 'status', 'source', 'evidence', 'confidence'],
      `customerLabels[${index}]`,
    );
    const allowedValues = SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY[label.dimension];
    if (!allowedValues) throw new TypeError(`customerLabels[${index}].dimension is invalid`);
    if (!allowedValues.includes(label.value)) throw new TypeError(`customerLabels[${index}].value is invalid`);
    if (!CUSTOMER_LABEL_STATUSES.has(label.status)) {
      throw new TypeError(`customerLabels[${index}].status is invalid`);
    }
    if (!KYC_EVIDENCE_SOURCES.has(label.source)) {
      throw new TypeError(`customerLabels[${index}].source is invalid`);
    }
    if (['advisor_estimate', 'advisor_inference'].includes(label.source)
      && label.status !== 'candidate') {
      throw new TypeError(`customerLabels[${index}] inferred labels must remain candidate`);
    }
    if (typeof label.evidence !== 'string' || !label.evidence.trim() || label.evidence.length > 500
      || !groundingSources.some((source) => source.includes(normalizeGroundingText(label.evidence)))) {
      throw new TypeError(`customerLabels[${index}].evidence must be grounded`);
    }
    if (label.source === 'customer_statement'
      && !hasExplicitCustomerAttribution(label.evidence, sourceTexts)) {
      throw new TypeError(`customerLabels[${index}].source requires explicit customer attribution`);
    }
    assertConfidence(label.confidence, `customerLabels[${index}].confidence`);
    const identity = `${label.dimension}\u0000${label.value}\u0000${label.status}`;
    if (customerLabelKeys.has(identity)) throw new TypeError(`customerLabels[${index}] is duplicated`);
    customerLabelKeys.add(identity);
  });

  assertObject(proposal.stage, 'stage');
  assertExactKeys(proposal.stage, ['value', 'confidence'], 'stage');
  if (!STAGES.has(proposal.stage.value)) throw new TypeError('stage.value is invalid');
  assertConfidence(proposal.stage.confidence, 'stage.confidence');

  if (!Array.isArray(proposal.concerns) || proposal.concerns.length > 5) {
    throw new TypeError('concerns must be an array with at most 5 items');
  }
  const concernTypes = new Set();
  proposal.concerns.forEach((concern, index) => {
    assertObject(concern, `concerns[${index}]`);
    assertExactKeys(concern, ['type', 'priority', 'confidence'], `concerns[${index}]`);
    if (!CONCERN_TYPES.has(concern.type)) throw new TypeError(`concerns[${index}].type is invalid`);
    if (concernTypes.has(concern.type)) throw new TypeError(`concerns[${index}].type is duplicated`);
    concernTypes.add(concern.type);
    if (!PRIORITIES.has(concern.priority)) throw new TypeError(`concerns[${index}].priority is invalid`);
    assertConfidence(concern.confidence, `concerns[${index}].confidence`);
  });

  assertObject(proposal.signals, 'signals');
  assertExactKeys(proposal.signals, ['explicitRefusal', 'stopContact', 'factSensitive'], 'signals');
  for (const [key, value] of Object.entries(proposal.signals)) {
    if (typeof value !== 'boolean') throw new TypeError(`signals.${key} must be boolean`);
  }

  if (!Array.isArray(proposal.missingInformation)) throw new TypeError('missingInformation must be an array');
  const missingInformation = new Set();
  for (const value of proposal.missingInformation) {
    if (!MISSING_INFORMATION.has(value)) throw new TypeError(`missingInformation contains invalid value: ${value}`);
    if (missingInformation.has(value)) throw new TypeError(`missingInformation contains duplicated value: ${value}`);
    missingInformation.add(value);
  }
  if (!Array.isArray(proposal.unknownInformation)) throw new TypeError('unknownInformation must be an array');
  const unknownInformation = new Set();
  for (const value of proposal.unknownInformation) {
    if (!MISSING_INFORMATION.has(value)) throw new TypeError(`unknownInformation contains invalid value: ${value}`);
    if (unknownInformation.has(value)) throw new TypeError(`unknownInformation contains duplicated value: ${value}`);
    if (missingInformation.has(value)) {
      throw new TypeError(`unknownInformation duplicates missingInformation: ${value}`);
    }
    unknownInformation.add(value);
  }
  if (!Array.isArray(proposal.answeredInformation)) throw new TypeError('answeredInformation must be an array');
  const answeredInformation = new Set();
  for (const value of proposal.answeredInformation) {
    if (!MISSING_INFORMATION.has(value)) throw new TypeError(`answeredInformation contains invalid value: ${value}`);
    if (answeredInformation.has(value)) throw new TypeError(`answeredInformation contains duplicated value: ${value}`);
    if (missingInformation.has(value) || unknownInformation.has(value)) {
      throw new TypeError(`answeredInformation conflicts with unresolved information: ${value}`);
    }
    answeredInformation.add(value);
  }
  if (!Array.isArray(proposal.proposedCapabilities) || proposal.proposedCapabilities.length > 7) {
    throw new TypeError('proposedCapabilities must be an array with at most 7 items');
  }
  for (const value of proposal.proposedCapabilities) {
    if (!CAPABILITY_KEYS.has(value)) throw new TypeError(`proposedCapabilities contains invalid value: ${value}`);
  }
  if (!Array.isArray(proposal.situations) || proposal.situations.length > 4) {
    throw new TypeError('situations must be an array with at most 4 items');
  }
  const situations = new Set();
  for (const value of proposal.situations) {
    if (!SITUATION_KEYS.has(value)) throw new TypeError(`situations contains invalid value: ${value}`);
    if (situations.has(value)) throw new TypeError(`situations contains duplicated value: ${value}`);
    situations.add(value);
  }

  if (!Array.isArray(proposal.insuranceNeeds) || proposal.insuranceNeeds.length > 2) {
    throw new TypeError('insuranceNeeds must be an array with at most 2 items');
  }
  const insuranceNeedTypes = new Set();
  proposal.insuranceNeeds.forEach((need, index) => {
    assertObject(need, `insuranceNeeds[${index}]`);
    assertExactKeys(need, ['type', 'queryAspects'], `insuranceNeeds[${index}]`);
    if (!INSURANCE_NEED_TYPES.has(need.type)) {
      throw new TypeError(`insuranceNeeds[${index}].type is invalid`);
    }
    if (insuranceNeedTypes.has(need.type)) {
      throw new TypeError(`insuranceNeeds[${index}].type is duplicated`);
    }
    insuranceNeedTypes.add(need.type);
    if (!Array.isArray(need.queryAspects) || need.queryAspects.length > 8) {
      throw new TypeError(`insuranceNeeds[${index}].queryAspects is invalid`);
    }
    for (const aspect of need.queryAspects) {
      if (!QUERY_ASPECTS.has(aspect)) {
        throw new TypeError(`insuranceNeeds[${index}].queryAspects contains invalid value: ${aspect}`);
      }
    }
  });
  return structuredClone(proposal);
}
