import { SALES_CHAMPION_CAPABILITY_LABEL_MAPPINGS } from './sales-champion-customer-label-mappings.mjs';

const DEFINITIONS = Object.freeze({
  appointment_scope: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'decision'], concerns: ['follow_up', 'trust', 'unknown'] }),
  tradeoff_disclosure: Object.freeze({ version: 1, stages: ['discovery', 'proposal', 'objection', 'decision'], concerns: ['liquidity', 'duration', 'benefits', 'surrender', 'affordability', 'product_fit', 'risk_pooling'] }),
  five_question_diagnosis: Object.freeze({ version: 1, stages: ['discovery', 'proposal', 'objection', 'decision'], concerns: ['unknown', 'product_fit', 'trust', 'affordability'] }),
  reputation_objection: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'proposal', 'objection', 'decision', 'post_sale'], concerns: ['trust', 'insurer_safety', 'claims', 'follow_up'] }),
  risk_pooling_explanation: Object.freeze({ version: 1, stages: ['discovery', 'proposal', 'objection'], concerns: ['risk_pooling', 'benefits', 'claims'] }),
  needs_discovery: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'post_sale'], concerns: ['unknown', 'product_fit', 'affordability', 'liquidity', 'duration', 'benefits', 'claims', 'underwriting'] }),
  family_joint_decision: Object.freeze({ version: 1, stages: ['discovery', 'proposal', 'objection', 'decision'], concerns: ['family_decision'] }),
  rebate_request_handling: Object.freeze({ version: 1, stages: ['objection', 'decision'], concerns: ['rebate'] }),
  cooling_off_support: Object.freeze({ version: 1, stages: ['decision', 'post_sale'], concerns: ['surrender'] }),
  follow_up_consent: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'], concerns: ['follow_up', 'trust', 'unknown', 'family_decision'] }),
  referral_request: Object.freeze({ version: 1, stages: ['appointment', 'post_sale'], concerns: ['follow_up', 'trust'] }),
  plain_language_explanation: Object.freeze({
    version: 1,
    stages: ['discovery', 'proposal', 'objection', 'decision', 'post_sale'],
    concerns: ['unknown', 'trust', 'product_fit', 'benefits', 'claims', 'underwriting', 'risk_pooling', 'insurer_safety'],
  }),
  fact_sensitive_routing: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'], concerns: [] }),
  general_sales_clarification: Object.freeze({ version: 1, stages: ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'], concerns: [] }),
});

const PROMPT_RULES = Object.freeze({
  sales_process_navigator: Object.freeze([
    '先使用 navigation 中已确认的 KYC 事实和客户标签判断当前流程，不得把顾问估计升级为客户事实。',
    '先给出不依赖未知信息的跟进方法，再按 questionPlan 追问会改变 Skill 边界的信息。',
  ]),
  needs_discovery: Object.freeze([
    '只复述 customerStatements 中明确表达的客户事实；顾问估计必须标为估计，不能升级为客户事实。',
    '先基于已有信息给出一个自然的跟进目标和一段可复制话术，再从 missingInformation 中选择最关键的信息追问；不要新增结构化 turn 未列出的异议、保障缺口、产品问题或法律问题。',
    '按 navigation.questionPlan 控制回答负担；多个低成本短事实可合并，高成本资料一次只问一项。',
  ]),
  family_joint_decision: Object.freeze([
    '只在 customerConcerns 明确包含 family_decision 时讨论共同决策；婚姻、分居或家庭成员背景本身不等于共同决策异议。',
    '使用中性问题确认谁参与决定，不推断财产归属、控制权或法律结果。',
  ]),
  five_question_diagnosis: Object.freeze([
    '围绕已确认的 product_fit、trust 或 affordability concern 提出最多五个诊断问题。',
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
    '只追问 navigation.questionPlan 中会改变路线的问题，不得要求补齐客户信息后才提供跟进建议。',
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
    'navigation',
  ]),
  outputContract: '所有 sales_champion Skills 必须基于完整客户语义包输出：客户已表达事实 + 销售阶段/异议解读 + 可执行沟通建议/话术 + 需要保险专家核验的事实点 + 不确定边界。客户信息不完整时也必须先给可执行的跟进方法，再按 navigation.questionPlan 低负担追问。不得把客户自然语言降级为关键词话术，不得编造保险责任、现金价值、理赔、核保或产品比较事实。',
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
