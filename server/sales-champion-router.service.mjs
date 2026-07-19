import { evaluateSalesTurnReadiness } from './sales-champion-readiness.service.mjs';
import { selectSalesChampionSkills } from './sales-champion-skill-registry.mjs';
import { getSalesChampionTrainingPacks } from './sales-champion-training-catalog.mjs';
import { validateSalesTurnProposal } from './sales-champion-turn.contract.mjs';
import { buildSalesChampionProcessNavigation } from './sales-champion-process-navigator.service.mjs';

const CONTRACT_VERSION = 1;
const MAX_ADVISOR_QUESTIONS = 2;

const INFORMATION_QUESTIONS = Object.freeze({
  objection_reason: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '客户说出这个异议后，有没有讲具体卡在哪儿？',
    askCustomerIfUnknown: '您刚才提到这个顾虑，具体最卡您的是哪一点？您按真实想法说就行。',
    impact: '先听客户自己说原因，避免把解决方向带偏。',
  }),
  customer_goal: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '这个客户这次最想解决什么？',
    askCustomerIfUnknown: '您这次最想先解决哪件事？我先按您最关心的来准备。',
    impact: '决定下一次先做需求沟通，还是先处理眼前的异议。',
  }),
  explicit_customer_request: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '客户有没有主动提过保险，或者明确让你帮他处理、分析什么事情？',
    askCustomerIfUnknown: '您现在有没有哪件事情希望我帮您处理？没有也没关系，我就先不打扰您。',
    impact: '确认客户是否允许进入保险或服务沟通，不能把关系友好当成营销许可。',
  }),
  customer_relationship_origin: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '这个客户是你自己开发、别人转介绍的，还是公司转交的老保单客户？',
    askCustomerIfUnknown: '',
    impact: '客户来源会决定是普通经营、转介绍维护，还是先按孤儿保单服务边界处理。',
  }),
  future_fund_use: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '客户未来几年有没有明确要用这笔钱的地方？',
    askCustomerIfUnknown: '这笔钱未来几年有没有明确用途，或者哪几年可能会用到？',
    impact: '决定要不要优先讨论期限和资金灵活性。',
  }),
  budget: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '客户觉得完全没压力、能长期坚持的预算大概是多少？',
    askCustomerIfUnknown: '按最保守的情况，您觉得每年拿出多少完全不影响生活？',
    impact: '决定是调整金额、缴费安排，还是先不谈方案。',
  }),
  existing_coverage: Object.freeze({
    owner: 'insurance_expert',
    askAdvisor: '客户现有保单资料齐不齐，能不能提供给保险专家核验？',
    askCustomerIfUnknown: '您方便把现有保单发我看一下吗？我先帮您把已经有的安排理清楚。',
    impact: '没有保单证据时不能判断保障缺口或重复。',
  }),
  product_contract: Object.freeze({
    owner: 'insurance_expert',
    askAdvisor: '这款产品的官方条款或计划书现在能不能拿到？',
    askCustomerIfUnknown: '您方便把计划书或合同发我一份吗？我先把关键规则核准，再跟您说。',
    impact: '具体责任、期限和产品规则必须交给保险专家按官方资料核验。',
  }),
  cash_value_schedule: Object.freeze({
    owner: 'insurance_expert',
    askAdvisor: '有没有对应的现金价值表或领取演示可以核验？',
    askCustomerIfUnknown: '您把现金价值表或领取演示发我一下，我先核准不同年份的情况。',
    impact: '退保、领取和资金灵活性不能凭印象判断。',
  }),
  family_decision_process: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '这件事客户自己能决定，还是要和家人一起商量？',
    askCustomerIfUnknown: '这件事您平时是自己做决定，还是希望家里人一起听听？',
    impact: '决定下一次是一对一聊，还是邀请共同决策人一起沟通。',
  }),
  health_information: Object.freeze({
    owner: 'insurance_expert',
    askAdvisor: '如果后面涉及投保，客户有没有愿意按正式问卷核验的健康资料？',
    askCustomerIfUnknown: '如果后面需要评估能不能投保，我们再按正式健康问卷逐项核实，可以吗？',
    impact: '投保可行性必须基于正式健康告知，销售不能自行判断。',
  }),
  contact_preference: Object.freeze({
    owner: 'sales_champion',
    askAdvisor: '客户更愿意什么时候、用什么方式沟通？',
    askCustomerIfUnknown: '以后您希望我微信联系，还是电话联系？一般什么时间方便？',
    impact: '决定下一次触达方式，避免让客户觉得被催促。',
  }),
});

const CONCERN_INFORMATION_PRIORITY = Object.freeze({
  liquidity: ['objection_reason', 'future_fund_use', 'customer_goal', 'cash_value_schedule', 'budget'],
  duration: ['objection_reason', 'customer_goal', 'future_fund_use', 'budget', 'cash_value_schedule'],
  affordability: ['objection_reason', 'budget', 'customer_goal', 'future_fund_use'],
  family_decision: ['family_decision_process', 'customer_goal'],
  product_fit: ['customer_goal', 'future_fund_use', 'existing_coverage'],
  benefits: ['objection_reason', 'customer_goal', 'product_contract', 'cash_value_schedule'],
  surrender: ['objection_reason', 'cash_value_schedule', 'product_contract', 'customer_goal'],
  claims: ['existing_coverage', 'product_contract'],
  underwriting: ['health_information', 'product_contract'],
  trust: ['customer_goal', 'contact_preference'],
  follow_up: ['customer_goal', 'contact_preference'],
  unknown: ['customer_goal', 'contact_preference'],
});

const STAGE_INFORMATION_PRIORITY = Object.freeze({
  contact: ['explicit_customer_request', 'customer_relationship_origin', 'contact_preference', 'customer_goal'],
  appointment: ['explicit_customer_request', 'customer_relationship_origin', 'contact_preference', 'customer_goal'],
  discovery: ['customer_goal', 'future_fund_use', 'budget', 'existing_coverage'],
  proposal: ['customer_goal', 'budget', 'family_decision_process', 'product_contract'],
  objection: ['customer_goal', 'future_fund_use', 'budget', 'product_contract'],
  decision: ['family_decision_process', 'budget', 'product_contract'],
  post_sale: ['contact_preference', 'existing_coverage'],
});

function orderedMissingInformation(proposal = {}) {
  const missing = new Set(Array.isArray(proposal.missingInformation) ? proposal.missingInformation : []);
  const priorities = [];
  const concerns = Array.isArray(proposal.concerns) ? proposal.concerns : [];
  const primaryConcern = concerns
    .find((concern) => concern?.priority === 'primary')?.type;
  const situations = new Set(Array.isArray(proposal.situations) ? proposal.situations : []);
  if (situations.has('long_payment_commitment')
    && primaryConcern === 'duration'
    && !concerns.some((concern) => concern?.priority === 'secondary')) {
    missing.add('objection_reason');
  }
  priorities.push(...(CONCERN_INFORMATION_PRIORITY[primaryConcern] || []));
  priorities.push(...(STAGE_INFORMATION_PRIORITY[proposal?.stage?.value] || []));
  for (const concern of concerns) {
    priorities.push(...(CONCERN_INFORMATION_PRIORITY[concern?.type] || []));
  }
  priorities.push(...missing);
  return [...new Set(priorities)].filter((key) => missing.has(key));
}

export function buildSalesChampionInformationFollowUp(proposal = {}) {
  if (proposal?.signals?.explicitRefusal || proposal?.signals?.stopContact
    || proposal?.turnRelation?.value === 'correction') {
    return { maxQuestions: MAX_ADVISOR_QUESTIONS, questions: [] };
  }
  const questions = orderedMissingInformation(proposal)
    .slice(0, MAX_ADVISOR_QUESTIONS)
    .flatMap((key) => INFORMATION_QUESTIONS[key] ? [{ key, ...INFORMATION_QUESTIONS[key] }] : []);
  return { maxQuestions: MAX_ADVISOR_QUESTIONS, questions };
}

export function buildSalesChampionExecutionPlan(trainingPacks = []) {
  const packs = Array.isArray(trainingPacks) ? trainingPacks : [];
  return {
    primary: packs[0] ? { key: packs[0].key } : null,
    supporting: packs.slice(1, 7).map((pack) => ({ key: pack.key })),
    fallbackUsed: packs.length === 0,
  };
}

export function evaluateSalesChampionRoute({
  proposal,
  sourceTexts = [],
  runtimeAvailable = true,
  knownSlots = [],
  unknownSlots = [],
  historicalFacts = [],
  historicalLabels = [],
  hasActiveCustomerContext = false,
} = {}) {
  let validated;
  try {
    validated = validateSalesTurnProposal(proposal, { sourceTexts });
  } catch (error) {
    return {
      contractVersion: CONTRACT_VERSION,
      status: 'invalid_proposal',
      readiness: null,
      selection: null,
      error: String(error?.message || error),
    };
  }

  const readiness = evaluateSalesTurnReadiness(validated, { runtimeAvailable });
  const informationFollowUp = buildSalesChampionInformationFollowUp(validated);
  if (readiness.decision !== 'execute') {
    return {
      contractVersion: CONTRACT_VERSION,
      status: 'gated',
      readiness,
      informationFollowUp,
      selection: null,
      navigation: null,
      boundaryCandidates: [],
      error: '',
    };
  }

  const selection = selectSalesChampionSkills(validated);
  const capabilityKeys = [selection.primary, ...selection.supporting].map((skill) => skill.key);
  const hasContactPermissionLabel = validated.customerLabels.some(
    (label) => label.dimension === 'contact_permission',
  );
  const customerLabels = hasContactPermissionLabel || !['contact', 'appointment'].includes(validated.stage.value)
    ? validated.customerLabels
    : [...validated.customerLabels, {
      dimension: 'contact_permission',
      value: 'B0',
      status: 'candidate',
      source: 'advisor_inference',
      evidence: '联系许可待确认',
      confidence: 0.5,
    }];
  const trainingPacks = getSalesChampionTrainingPacks(capabilityKeys, {
    stage: validated.stage.value,
    concerns: validated.concerns.map((concern) => concern.type),
    primaryConcern: validated.concerns.find((concern) => concern.priority === 'primary')?.type || '',
    situations: validated.situations,
    signals: validated.signals,
    customerLabels,
  });
  const navigation = buildSalesChampionProcessNavigation({
    proposal: validated,
    selection,
    boundaryCandidates: [],
    knownSlots,
    unknownSlots,
    historicalFacts,
    historicalLabels,
    hasActiveCustomerContext,
  });
  return {
    contractVersion: CONTRACT_VERSION,
    status: 'routed',
    readiness,
    selection,
    trainingPacks,
    executionPlan: buildSalesChampionExecutionPlan(trainingPacks),
    informationFollowUp,
    navigation,
    boundaryCandidates: [],
    error: '',
  };
}
