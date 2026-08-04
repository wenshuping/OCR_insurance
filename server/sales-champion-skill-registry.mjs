import {
  createSalesChampionSkillBoundary,
  validateSalesChampionActionSignature,
} from './sales-champion-skill-boundary.mjs';
import { SALES_CHAMPION_CAPABILITY_LABEL_MAPPINGS } from './sales-champion-customer-label-mappings.mjs';

function defineSkill(key, { version = 1, stages, concerns, actionSignature, boundary }) {
  validateSalesChampionActionSignature(actionSignature);
  const labelApplicability = SALES_CHAMPION_CAPABILITY_LABEL_MAPPINGS[key];
  if (!labelApplicability) throw new TypeError(`missing customer label mapping: ${key}`);
  return Object.freeze({
    version,
    stages: Object.freeze([...stages]),
    concerns: Object.freeze([...concerns]),
    actionSignature,
    boundary: createSalesChampionSkillBoundary(boundary),
    labelApplicability,
  });
}

export const SALES_CHAMPION_SKILL_DEFINITIONS = Object.freeze({
  sales_process_navigator: defineSkill('sales_process_navigator', {
    stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'],
    concerns: [],
    actionSignature: 'advance_next_step',
    boundary: {
      groups: ['sales_stage', 'customer_relationship', 'meeting_intent', 'conversation_progress', 'decision_and_consent'],
      probeSlots: ['explicit_customer_request', 'conversation_end_state'],
      helpfulSlots: ['customer_relationship_origin', 'customer_goal', 'objection_reason', 'service_issue', 'contact_preference'],
    },
  }),
  appointment_scope: defineSkill('appointment_scope', {
    stages: ['contact', 'appointment', 'objection', 'decision', 'post_sale'],
    concerns: ['follow_up', 'unknown', 'product_fit'],
    actionSignature: 'scope_conversation',
    boundary: {
      groups: ['meeting_intent', 'conversation_progress'],
      probeSlots: ['explicit_customer_request', 'conversation_end_state'],
      helpfulSlots: ['meeting_trigger', 'contact_preference'],
    },
  }),
  tradeoff_disclosure: defineSkill('tradeoff_disclosure', {
    stages: ['proposal', 'objection', 'decision'],
    concerns: ['liquidity', 'duration', 'benefits', 'surrender'],
    actionSignature: 'explain_tradeoff',
    boundary: {
      groups: ['objection', 'insurance_evidence'],
      probeSlots: ['objection_reason', 'product_identity'],
      requiredSlots: ['objection_reason'],
      helpfulSlots: ['future_fund_use', 'fund_use_timeline'],
      unknownFallback: 'acknowledge_and_discover',
    },
  }),
  five_question_diagnosis: defineSkill('five_question_diagnosis', {
    stages: ['discovery', 'proposal', 'objection', 'decision'],
    concerns: [
      'unknown', 'product_fit', 'trust', 'affordability', 'benefits',
      'family_decision', 'claims', 'risk_pooling',
    ],
    actionSignature: 'diagnose_objection',
    boundary: {
      groups: ['customer_goal', 'objection'],
      probeSlots: ['customer_goal', 'objection_reason'],
      helpfulSlots: ['customer_problem', 'future_fund_use'],
      unknownFallback: 'acknowledge_and_discover',
    },
  }),
  reputation_objection: defineSkill('reputation_objection', {
    stages: ['contact', 'appointment', 'objection', 'post_sale'],
    concerns: ['trust'],
    actionSignature: 'rebuild_trust',
    boundary: {
      groups: ['customer_relationship', 'objection'],
      probeSlots: ['objection_reason', 'service_issue'],
      requiredSlots: ['objection_reason'],
      helpfulSlots: ['service_issue'],
      unknownFallback: 'generic_service_first',
    },
  }),
  risk_pooling_explanation: defineSkill('risk_pooling_explanation', {
    stages: ['objection'],
    concerns: ['risk_pooling'],
    actionSignature: 'explain_tradeoff',
    boundary: {
      groups: ['objection', 'insurance_evidence'],
      probeSlots: ['objection_reason'],
      requiredSlots: ['objection_reason'],
      helpfulSlots: ['customer_goal'],
      unknownFallback: 'acknowledge_and_discover',
    },
  }),
  needs_discovery: defineSkill('needs_discovery', {
    stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'post_sale'],
    concerns: ['unknown', 'product_fit', 'trust', 'follow_up'],
    actionSignature: 'discover_need',
    boundary: {
      groups: ['meeting_intent', 'customer_goal'],
      probeSlots: ['explicit_customer_request', 'customer_goal'],
      helpfulSlots: ['meeting_trigger', 'customer_problem'],
      unknownFallback: 'acknowledge_and_discover',
    },
  }),
  family_joint_decision: defineSkill('family_joint_decision', {
    stages: ['discovery', 'proposal', 'objection', 'decision'],
    concerns: ['family_decision'],
    actionSignature: 'facilitate_decision',
    boundary: {
      groups: ['decision_and_consent'],
      probeSlots: ['decision_participants'],
      requiredSlots: ['decision_participants'],
      helpfulSlots: ['objection_reason', 'customer_decision'],
      unknownFallback: 'acknowledge_and_discover',
    },
  }),
  rebate_request_handling: defineSkill('rebate_request_handling', {
    stages: ['objection', 'decision'],
    concerns: ['rebate'],
    actionSignature: 'protect_compliance_boundary',
    boundary: {
      groups: ['objection', 'decision_and_consent'],
      probeSlots: ['objection_reason'],
      requiredSlots: ['objection_reason'],
      helpfulSlots: ['customer_decision'],
      unknownFallback: 'generic_safe_follow_up',
    },
  }),
  cooling_off_support: defineSkill('cooling_off_support', {
    stages: ['decision', 'post_sale'],
    concerns: ['surrender'],
    actionSignature: 'protect_customer_choice',
    boundary: {
      groups: ['decision_and_consent', 'insurance_evidence'],
      probeSlots: ['customer_decision', 'objection_reason'],
      requiredSlots: ['customer_decision'],
      helpfulSlots: ['product_identity'],
      unknownFallback: 'generic_safe_follow_up',
    },
  }),
  follow_up_consent: defineSkill('follow_up_consent', {
    stages: ['contact', 'appointment', 'objection', 'decision', 'post_sale'],
    concerns: ['follow_up', 'trust'],
    actionSignature: 'obtain_consent',
    boundary: {
      groups: ['conversation_progress', 'decision_and_consent'],
      probeSlots: ['contact_preference', 'conversation_end_state'],
      helpfulSlots: ['explicit_customer_request'],
    },
  }),
  referral_request: defineSkill('referral_request', {
    stages: ['post_sale'],
    concerns: ['follow_up'],
    actionSignature: 'obtain_consent',
    boundary: {
      groups: ['customer_relationship', 'decision_and_consent'],
      probeSlots: ['referral_consent'],
      requiredSlots: ['referral_consent'],
      helpfulSlots: ['contact_preference'],
    },
  }),
  plain_language_explanation: defineSkill('plain_language_explanation', {
    version: 1,
    stages: ['discovery', 'proposal', 'objection', 'post_sale'],
    concerns: [
      'unknown', 'trust', 'product_fit', 'benefits', 'claims', 'underwriting', 'risk_pooling',
    ],
    actionSignature: 'explain_verified_facts',
    boundary: {
      groups: ['insurance_evidence'],
      probeSlots: ['product_identity', 'existing_policy_evidence'],
      helpfulSlots: ['customer_goal'],
      unknownFallback: 'defer_fact_until_verified',
    },
  }),
  fact_sensitive_routing: defineSkill('fact_sensitive_routing', {
    stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'],
    concerns: [],
    actionSignature: 'route_verified_evidence',
    boundary: {
      groups: ['insurance_evidence'],
      probeSlots: ['product_identity', 'existing_policy_evidence'],
      helpfulSlots: ['insurer_identity'],
      unknownFallback: 'defer_fact_until_verified',
    },
  }),
  general_sales_clarification: defineSkill('general_sales_clarification', {
    stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'],
    concerns: [],
    actionSignature: 'safe_fallback',
    boundary: {
      groups: ['sales_stage', 'meeting_intent', 'conversation_progress'],
      probeSlots: ['explicit_customer_request', 'conversation_end_state'],
      helpfulSlots: ['customer_goal', 'contact_preference'],
    },
  }),
});

const DEFINITIONS = SALES_CHAMPION_SKILL_DEFINITIONS;

const PROMPT_RULES = Object.freeze({
  sales_process_navigator: Object.freeze([
    '先用本轮已确认事实和客户标签判断当前业务线与销售阶段，再执行主 Skill 和辅助 Skills；流程导航不替代具体 Skill，也不生成产品或保障结论。',
    '只确认会改变主 Skill、联系许可、安全边界或本轮下一步的信息；已经从对话、标签或系统事件确认的内容不得重复追问。',
    '多个候选 Skill 缺少同一边界时合并成一个自然问题；低成本事实可以合并询问，高成本资料一次只问一项。业务员不知道时，使用当前阶段的通用方法继续回答，不反复追问。',
    '除联系许可、停止营销或其他安全边界必须先确认外，先给不依赖未知事实的可执行方法和话术，再补问一至两项最有区分度的信息。',
    '总销冠最终汇总流程判断、主 Skill、辅助 Skills和保险专家证据；只有没有可执行的精确或阶段能力时，才使用 general_sales_clarification 兜底。',
  ]),
  needs_discovery: Object.freeze([
    '只复述 customerStatements 中明确表达的客户事实；顾问估计必须标为估计，不能升级为客户事实。',
    '先基于已有信息给出一个自然的跟进目标和一段可复制话术，再从 missingInformation 中选择最关键的信息追问；不要新增结构化 turn 未列出的异议、保障缺口、产品问题或法律问题。',
    '只使用流程导航 questionPlan 中的问题；多个低成本短事实可以合并，高成本资料一次只问一项。不得只给问题清单，不做大而全的方案。',
  ]),
  family_joint_decision: Object.freeze([
    '只在 customerConcerns 明确包含 family_decision 时讨论共同决策；婚姻、分居或家庭成员背景本身不等于共同决策异议。',
    '使用中性问题确认谁参与决定，不推断财产归属、控制权或法律结果。',
  ]),
  five_question_diagnosis: Object.freeze([
    '只围绕结构化 turn 已确认的 concern 提出最多五个诊断问题，不得把背景信息升级成客户异议。',
    '没有 Insurance Expert 证据时不判断产品责任、保障缺口或适配结论。',
  ]),
  plain_language_explanation: Object.freeze([
    '只把 verified Insurance Expert 证据转成客户能理解的表达，不补充证据之外的保险事实。',
    '保留适用条件和不确定边界，再给顾问沟通话术。',
  ]),
  tradeoff_disclosure: Object.freeze([
    '只讨论 customerConcerns 中已确认的流动性、期限、利益或退保权衡。',
    '涉及现金价值、领取、退保损失或产品责任时必须引用 verified Insurance Expert 证据。',
  ]),
  general_sales_clarification: Object.freeze([
    '无法匹配具体销售能力时，先给出一个不依赖未知事实的低压力跟进方法或话术，再澄清客户目标、当前进展或顾问希望达成的下一步。',
    '只使用流程导航 questionPlan 中会改变路线的问题；多个低成本短事实可以合并，高成本资料一次只问一项。不得要求补齐客户信息后才提供跟进建议。',
    '最终回答要像一线业务员在复盘客户：先直说下一步做什么，再给能直接发给客户的话；不要写“客户理解、当前阶段、优先确认、建议进一步”等课件式小标题。',
    '不得自行生成产品推荐、保障缺口或异议处理结论。',
  ]),
  follow_up_consent: Object.freeze([
    '优先尊重客户联系偏好；明确拒绝或停止联系时不得提供促成话术。',
  ]),
  fact_sensitive_routing: Object.freeze([
    '保险事实和保障缺口只使用 verified Insurance Expert evidence；其他调用状态一律表述为待核实。',
  ]),
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
    'boundaryCandidates',
    'navigation',
  ]),
  outputContract: '所有 sales_champion Skills 必须基于完整客户语义包输出：客户已表达事实 + 销售阶段/异议解读 + 可执行沟通建议/话术 + 需要保险专家核验的事实点 + 不确定边界。客户信息不完整时也必须先给可执行的跟进方法，再按 navigation.questionPlan 追问少量会改变 Skill 或话术的信息；多个低成本短事实可合并，高成本资料一次只问一项。不得把客户自然语言降级为关键词话术，不得编造保险责任、现金价值、理赔、核保或产品比较事实。',
});

function capabilityMatches(definition, proposal) {
  const stageMatches = definition.stages.includes(proposal.stage.value);
  const concernTypes = new Set(proposal.concerns.map((concern) => concern.type));
  const concernMatches = !definition.concerns.length || definition.concerns.some((type) => concernTypes.has(type));
  return stageMatches && concernMatches;
}
function skillRef(key) {
  return {
    key,
    version: DEFINITIONS[key]?.version || 1,
    labelApplicability: SALES_CHAMPION_CAPABILITY_LABEL_MAPPINGS[key],
  };
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
  if (!accepted.length) accepted.push('general_sales_clarification');
  if ((proposal.signals.factSensitive || proposal.insuranceNeeds.length > 0)
    && !accepted.includes('fact_sensitive_routing')) {
    accepted.push('fact_sensitive_routing');
  }

  const primaryKey = accepted.find((key) => key !== 'fact_sensitive_routing') || accepted[0];
  const supportingKeys = accepted.filter((key) => key !== primaryKey).slice(0, 6);
  const primaryConcern = proposal.concerns.find((concern) => concern.priority === 'primary') || proposal.concerns[0];
  return {
    navigator: skillRef('sales_process_navigator'),
    primary: skillRef(primaryKey),
    supporting: supportingKeys.map(skillRef),
    executionContract: SALES_CHAMPION_SKILL_CONTRACT,
    rejected,
    decision: primaryKey === 'general_sales_clarification' ? 'clarify' : 'execute',
    reasonCodes: proposal.insuranceNeeds.map((need) => `insurance_expert_${need.type}`),
    confidence: primaryConcern?.confidence ?? proposal.stage.confidence,
  };
}

export function salesChampionPromptRules(selection = {}) {
  const keys = [selection?.navigator?.key, selection?.primary?.key, ...(Array.isArray(selection?.supporting)
    ? selection.supporting.map((skill) => skill?.key) : [])]
    .filter((key) => typeof key === 'string');
  return [...new Set(keys.flatMap((key) => PROMPT_RULES[key] || []))];
}
