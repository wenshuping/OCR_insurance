const DEFINITIONS = Object.freeze({
  appointment_scope: Object.freeze({ version: 1, stages: ['appointment'], concerns: ['follow_up'] }),
  tradeoff_disclosure: Object.freeze({ version: 1, stages: ['proposal', 'objection'], concerns: ['liquidity', 'duration', 'benefits', 'surrender'] }),
  five_question_diagnosis: Object.freeze({ version: 1, stages: ['discovery', 'proposal', 'objection', 'decision'], concerns: ['unknown', 'product_fit', 'trust', 'affordability'] }),
  reputation_objection: Object.freeze({ version: 1, stages: ['objection'], concerns: ['trust'] }),
  risk_pooling_explanation: Object.freeze({ version: 1, stages: ['objection'], concerns: ['risk_pooling'] }),
  needs_discovery: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'discovery'], concerns: ['unknown', 'product_fit'] }),
  family_joint_decision: Object.freeze({ version: 1, stages: ['discovery', 'proposal', 'objection', 'decision'], concerns: ['family_decision'] }),
  rebate_request_handling: Object.freeze({ version: 1, stages: ['objection', 'decision'], concerns: ['rebate'] }),
  cooling_off_support: Object.freeze({ version: 1, stages: ['decision', 'post_sale'], concerns: ['surrender'] }),
  follow_up_consent: Object.freeze({ version: 1, stages: ['contact', 'appointment'], concerns: ['follow_up'] }),
  referral_request: Object.freeze({ version: 1, stages: ['post_sale'], concerns: ['follow_up'] }),
  plain_language_explanation: Object.freeze({ version: 1, stages: ['discovery', 'proposal', 'objection'], concerns: ['unknown', 'trust', 'product_fit'] }),
  fact_sensitive_routing: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'], concerns: [] }),
  general_sales_clarification: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'], concerns: [] }),
});

export const SALES_CHAMPION_SKILL_CONTRACT = Object.freeze({
  requiredContext: Object.freeze([
    'originalQuestion',
    'recentConversation',
    'customerStatements',
    'stage',
    'concerns',
    'authorizedFamilyContext',
    'insuranceExpertEvidence',
  ]),
  outputContract: '所有 sales_champion Skills 必须基于完整客户语义包输出：客户已表达事实 + 销售阶段/异议解读 + 可执行沟通建议/话术 + 需要保险专家核验的事实点 + 不确定边界。不得把客户自然语言降级为关键词话术，不得编造保险责任、现金价值、理赔、核保或产品比较事实。',
});

function capabilityMatches(definition, proposal) {
  const stageMatches = definition.stages.includes(proposal.stage.value);
  const concernTypes = new Set(proposal.concerns.map((concern) => concern.type));
  const concernMatches = !definition.concerns.length || definition.concerns.some((type) => concernTypes.has(type));
  return stageMatches && concernMatches;
}
function skillRef(key) {
  return { key, version: DEFINITIONS[key].version };
}

export function selectSalesChampionSkills(proposal) {
  const accepted = [];
  const rejected = [];
  for (const key of proposal.proposedCapabilities) {
    const definition = DEFINITIONS[key];
    if (!definition || !capabilityMatches(definition, proposal)) {
      rejected.push({ key, reason: 'stage_or_concern_mismatch' });
      continue;
    }
    if (!accepted.includes(key)) accepted.push(key);
  }
  if (proposal.signals.factSensitive && !accepted.includes('fact_sensitive_routing')) {
    accepted.push('fact_sensitive_routing');
  }
  if (!accepted.length) accepted.push('general_sales_clarification');

  const primaryKey = accepted.find((key) => key !== 'fact_sensitive_routing') || accepted[0];
  const supportingKeys = accepted.filter((key) => key !== primaryKey).slice(0, 2);
  const primaryConcern = proposal.concerns.find((concern) => concern.priority === 'primary') || proposal.concerns[0];
  return {
    primary: skillRef(primaryKey),
    supporting: supportingKeys.map(skillRef),
    executionContract: SALES_CHAMPION_SKILL_CONTRACT,
    rejected,
    decision: primaryKey === 'general_sales_clarification' ? 'clarify' : 'execute',
    reasonCodes: proposal.signals.factSensitive ? ['official_facts_required'] : [],
    confidence: primaryConcern?.confidence ?? proposal.stage.confidence,
  };
}
