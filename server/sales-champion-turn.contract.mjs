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
const STATEMENT_SOURCES = new Set(['current_message', 'confirmed_history']);
const MISSING_INFORMATION = new Set([
  'customer_goal', 'future_fund_use', 'budget', 'existing_coverage', 'product_contract',
  'cash_value_schedule', 'family_decision_process', 'health_information', 'contact_preference',
]);
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

export function validateSalesTurnProposal(proposal, { sourceTexts = [] } = {}) {
  assertObject(proposal, 'proposal');
  assertExactKeys(proposal, [
    'contractVersion', 'customerStatements', 'stage', 'concerns', 'signals',
    'missingInformation', 'proposedCapabilities',
  ], 'proposal');
  if (proposal.contractVersion !== CONTRACT_VERSION) {
    throw new TypeError(`contractVersion must be ${CONTRACT_VERSION}`);
  }

  if (!Array.isArray(proposal.customerStatements) || proposal.customerStatements.length > 8) {
    throw new TypeError('customerStatements must be an array with at most 8 items');
  }
  const groundingSources = sourceTexts.map(normalizeGroundingText).filter(Boolean);
  proposal.customerStatements.forEach((statement, index) => {
    assertObject(statement, `customerStatements[${index}]`);
    assertExactKeys(statement, ['text', 'source'], `customerStatements[${index}]`);
    const statementText = String(statement.text || '').trim();
    if (!statementText || statementText.length > 500) {
      throw new TypeError(`customerStatements[${index}].text is invalid`);
    }
    if (!STATEMENT_SOURCES.has(statement.source)) {
      throw new TypeError(`customerStatements[${index}].source is invalid`);
    }
    const grounded = groundingSources.some((source) => source.includes(normalizeGroundingText(statementText)));
    if (!grounded) throw new TypeError(`customerStatements[${index}].text must be grounded`);
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
  for (const value of proposal.missingInformation) {
    if (!MISSING_INFORMATION.has(value)) throw new TypeError(`missingInformation contains invalid value: ${value}`);
  }
  if (!Array.isArray(proposal.proposedCapabilities) || proposal.proposedCapabilities.length > 5) {
    throw new TypeError('proposedCapabilities must be an array with at most 5 items');
  }
  for (const value of proposal.proposedCapabilities) {
    if (!CAPABILITY_KEYS.has(value)) throw new TypeError(`proposedCapabilities contains invalid value: ${value}`);
  }
  return structuredClone(proposal);
}
