export const AGENT_QUESTION_POLICY_DECISIONS = Object.freeze(['execute', 'propose', 'reject']);
export const AGENT_QUESTION_POLICY_HANDLERS = Object.freeze([
  'system',
  'insurance_expert',
  'sales_champion',
]);
export const AGENT_QUESTION_POLICY_OPERATIONS = Object.freeze(['read', 'write']);
export const AGENT_QUESTION_POLICY_CONFIRMATIONS = Object.freeze(['not_required', 'required']);
export const AGENT_QUESTION_POLICY_OUTPUT_MODES = Object.freeze(['direct', 'structured', 'preview']);
export const AGENT_QUESTION_POLICY_TOOLS = Object.freeze([
  'family_summary',
  'coverage_report',
  'sales_report',
  'product_knowledge_search',
  'create_upload_link',
  'propose_memory',
  'preview_transfer',
]);

const definePolicy = (policy) => Object.freeze(policy);

export const AGENT_QUESTION_POLICIES = Object.freeze([
  definePolicy({ key: 'family_summary', intent: 'family_summary', decision: 'execute', handler: 'insurance_expert', operation: 'read', confirmation: 'not_required', outputMode: 'structured', tool: 'family_summary' }),
  definePolicy({ key: 'coverage_report', intent: 'coverage_report', decision: 'execute', handler: 'insurance_expert', operation: 'read', confirmation: 'not_required', outputMode: 'structured', tool: 'coverage_report' }),
  definePolicy({ key: 'sales_report', intent: 'sales_report', decision: 'execute', handler: 'sales_champion', operation: 'read', confirmation: 'not_required', outputMode: 'structured', tool: 'sales_report' }),
  definePolicy({ key: 'insurance_product_knowledge', intent: 'insurance_product_knowledge', decision: 'execute', handler: 'insurance_expert', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: 'product_knowledge_search' }),
  definePolicy({ key: 'sales_coaching', intent: 'sales_coaching', decision: 'execute', handler: 'sales_champion', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: null }),
  definePolicy({ key: 'upload_link', intent: 'upload_link', decision: 'execute', handler: 'system', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: 'create_upload_link' }),
  definePolicy({ key: 'memory_proposal', intent: 'memory_proposal', decision: 'propose', handler: 'sales_champion', operation: 'write', confirmation: 'required', outputMode: 'preview', tool: 'propose_memory' }),
  definePolicy({ key: 'transfer_preview', intent: 'transfer_preview', decision: 'propose', handler: 'system', operation: 'write', confirmation: 'required', outputMode: 'preview', tool: 'preview_transfer' }),
  definePolicy({ key: 'system_help', intent: 'system_help', decision: 'execute', handler: 'system', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: null }),
  definePolicy({ key: 'chat', intent: 'chat', decision: 'execute', handler: 'sales_champion', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: null }),
  definePolicy({ key: 'unknown_read', intent: 'unknown_read', decision: 'execute', handler: 'system', operation: 'read', confirmation: 'not_required', outputMode: 'direct', tool: null }),
  definePolicy({ key: 'unknown_write', intent: 'unknown_write', decision: 'reject', handler: 'system', operation: 'write', confirmation: 'required', outputMode: 'direct', tool: null }),
]);

const normalizeIntent = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .replace(/[\s-]+/g, '_');

const includes = (allowed, value) => allowed.includes(value);

export function validateAgentQuestionPolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new TypeError('policy must be an object');
  if (!policy.key || !policy.intent) throw new TypeError('policy key and intent are required');
  if (!includes(AGENT_QUESTION_POLICY_DECISIONS, policy.decision)) throw new TypeError('invalid policy decision');
  if (!includes(AGENT_QUESTION_POLICY_HANDLERS, policy.handler)) throw new TypeError('invalid policy handler');
  if (!includes(AGENT_QUESTION_POLICY_OPERATIONS, policy.operation)) throw new TypeError('invalid policy operation');
  if (!includes(AGENT_QUESTION_POLICY_CONFIRMATIONS, policy.confirmation)) throw new TypeError('invalid policy confirmation');
  if (!includes(AGENT_QUESTION_POLICY_OUTPUT_MODES, policy.outputMode)) throw new TypeError('invalid policy output mode');
  if (policy.tool !== null && !includes(AGENT_QUESTION_POLICY_TOOLS, policy.tool)) throw new TypeError('tool is not allowed');
  if (policy.operation === 'write' && policy.confirmation !== 'required') {
    throw new TypeError('write operations require confirmation');
  }
  return true;
}

export function chooseAgentQuestionPolicy(candidate = {}, policies = AGENT_QUESTION_POLICIES) {
  const intent = normalizeIntent(candidate.intent);
  const matched = policies.find((policy) => normalizeIntent(policy.intent) === intent);
  const fallbackKey = normalizeIntent(candidate.requestedOperation) === 'write'
    ? 'unknown_write'
    : 'unknown_read';
  const selected = matched ?? policies.find((policy) => policy.key === fallbackKey);
  if (!selected) throw new TypeError(`missing ${fallbackKey} policy`);
  validateAgentQuestionPolicy(selected);
  return { ...selected };
}
