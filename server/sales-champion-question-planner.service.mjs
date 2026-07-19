const MAX_QUESTION_COST = 3;

const BASE_CUSTOMER_KYC_SLOTS = Object.freeze([
  'explicit_customer_request',
  'customer_relationship_origin',
  'contact_preference',
]);

const STAGE_KYC_SLOTS = Object.freeze({
  contact: Object.freeze([]),
  appointment: Object.freeze([]),
  discovery: Object.freeze(['customer_goal']),
  proposal: Object.freeze(['customer_decision']),
  objection: Object.freeze(['objection_reason']),
  decision: Object.freeze(['customer_decision', 'decision_participants']),
  post_sale: Object.freeze(['current_service_task', 'contact_preference']),
});

const SLOT_DEFINITIONS = Object.freeze({
  customer_relationship_origin: Object.freeze({
    question: '这个客户是你自己开发、别人转介绍的，还是公司转交的老保单客户？',
    cost: 1,
    priority: 115,
    foundational: true,
    targetLabels: ['source', 'relationship_maturity'],
  }),
  current_service_task: Object.freeze({
    question: '客户这次具体希望你帮他办什么事情？',
    cost: 1,
    priority: 90,
    targetLabels: ['service_status', 'service_priority', 'next_action'],
  }),
  explicit_customer_request: Object.freeze({
    question: '客户有没有主动提过保险，或者明确让你帮他处理、分析什么事情？',
    cost: 1,
    priority: 110,
    targetLabels: ['demand_maturity', 'contact_permission', 'next_action'],
  }),
  meeting_trigger: Object.freeze({
    question: '这次是客户主动找你，还是你主动约他的？',
    cost: 1,
    priority: 70,
    targetLabels: ['purchase_intent', 'customer_journey'],
  }),
  conversation_end_state: Object.freeze({
    question: '你们最后怎么结束的，有没有约下一次或留下要办的事情？',
    cost: 1,
    priority: 80,
    targetLabels: ['purchase_intent', 'decision_maturity', 'next_action'],
  }),
  customer_goal: Object.freeze({
    question: '客户自己最想解决的是什么，理想结果是什么？',
    cost: 2,
    priority: 80,
    targetLabels: ['demand_maturity', 'purchase_intent'],
  }),
  customer_problem: Object.freeze({
    question: '客户现在最困扰他的具体问题是什么？',
    cost: 2,
    priority: 75,
    targetLabels: ['demand_maturity', 'current_concern'],
  }),
  objection_reason: Object.freeze({
    question: '客户当时原话怎么说，他最担心的是哪一点？',
    cost: 1,
    priority: 90,
    targetLabels: ['resistance', 'purchase_intent', 'current_concern'],
  }),
  service_issue: Object.freeze({
    question: '客户之前具体遇到过什么服务问题或不愉快？',
    cost: 2,
    priority: 85,
    targetLabels: ['relationship_maturity', 'resistance', 'service_status', 'current_concern'],
  }),
  customer_decision: Object.freeze({
    question: '客户现在是准备继续了解、暂缓，还是已经作了决定？',
    cost: 1,
    priority: 85,
    targetLabels: ['purchase_intent', 'decision_maturity'],
  }),
  decision_participants: Object.freeze({
    question: '这件事客户自己决定，还是还需要其他家人一起参与？',
    cost: 1,
    priority: 75,
    targetLabels: ['decision_maturity', 'current_concern'],
  }),
  contact_preference: Object.freeze({
    question: '客户希望你用什么方式、什么时间联系？',
    cost: 1,
    priority: 95,
    targetLabels: ['contact_permission', 'communication_preference'],
  }),
  future_fund_use: Object.freeze({
    question: '这笔钱未来主要准备在什么时候、用来做什么？',
    cost: 2,
    priority: 65,
    targetLabels: ['demand_maturity', 'current_concern'],
  }),
  fund_use_timeline: Object.freeze({
    question: '客户大概几年内可能会用到这笔钱？',
    cost: 1,
    priority: 70,
    targetLabels: ['current_concern'],
  }),
  sustainable_budget: Object.freeze({
    question: '客户自己认为每年多少投入可以长期持续、又不影响生活？',
    cost: 3,
    priority: 60,
    targetLabels: ['economic_capacity', 'current_concern'],
  }),
  existing_policy_evidence: Object.freeze({
    question: '需要分析现有保障的话，能否拿到保单或正式保单摘要？',
    cost: 3,
    priority: 55,
    targetLabels: ['policy_relationship'],
    insuranceOnly: true,
  }),
  product_identity: Object.freeze({
    question: '需要核验的是哪款产品，能否确认准确名称和版本？',
    cost: 2,
    priority: 55,
    targetLabels: ['policy_relationship'],
    insuranceOnly: true,
  }),
  existing_coverage: Object.freeze({
    question: '如果要分析保障情况，目前能确认客户已经有哪些保单或保障？',
    cost: 3,
    priority: 50,
    targetLabels: ['policy_relationship'],
    insuranceOnly: true,
  }),
  health_information: Object.freeze({
    question: '只有准备判断投保可行性时，再确认必要的健康情况。',
    cost: 3,
    priority: 40,
    targetLabels: [],
    insuranceOnly: true,
  }),
});

const text = (value) => String(value || '').trim();

function candidateSlots(boundaryCandidates = []) {
  const affectedSkills = new Map();
  for (const candidate of Array.isArray(boundaryCandidates) ? boundaryCandidates : []) {
    for (const slot of Array.isArray(candidate?.confirmationSlots) ? candidate.confirmationSlots : []) {
      if (!affectedSkills.has(slot)) affectedSkills.set(slot, []);
      affectedSkills.get(slot).push(text(candidate?.key));
    }
  }
  return affectedSkills;
}

export function planSalesChampionQuestions({
  proposal = {},
  boundaryCandidates = [],
  knownSlots = [],
  unknownSlots = [],
} = {}) {
  if (proposal?.turnRelation?.value === 'correction') return Object.freeze([]);
  const affectedSkills = candidateSlots(boundaryCandidates);
  const known = new Set(Array.isArray(knownSlots) ? knownSlots : []);
  const unknown = new Set(Array.isArray(unknownSlots) ? unknownSlots : []);
  const needsInsurance = Array.isArray(proposal?.insuranceNeeds) && proposal.insuranceNeeds.length > 0;
  const stageSlots = STAGE_KYC_SLOTS[proposal?.stage?.value] || [];
  const missingSlots = Array.isArray(proposal?.missingInformation) ? proposal.missingInformation : [];
  const currentTurnSlots = new Set([...stageSlots, ...missingSlots]);
  const slots = [...new Set([
    ...affectedSkills.keys(),
    ...BASE_CUSTOMER_KYC_SLOTS,
    ...stageSlots,
    ...missingSlots,
  ])];

  const ranked = slots.flatMap((slot) => {
    const definition = SLOT_DEFINITIONS[slot];
    if (!definition || known.has(slot) || unknown.has(slot)) return [];
    if (definition.insuranceOnly && !needsInsurance) return [];
    return [{
      slot,
      definition,
      affectedSkills: [...new Set(affectedSkills.get(slot) || [])],
      currentTurn: currentTurnSlots.has(slot),
    }];
  }).sort((left, right) => (
    Number(right.affectedSkills.length > 0) - Number(left.affectedSkills.length > 0)
    || Number(right.currentTurn) - Number(left.currentTurn)
    || right.definition.priority - left.definition.priority
    || left.definition.cost - right.definition.cost
    || left.slot.localeCompare(right.slot)
  ));

  const selected = [];
  let cost = 0;
  if (!needsInsurance) {
    const foundational = ranked.find((item) => item.definition.foundational === true);
    if (foundational) {
      selected.push(Object.freeze({
        slot: foundational.slot,
        question: foundational.definition.question,
        answerCost: foundational.definition.cost,
        targetLabels: Object.freeze([...foundational.definition.targetLabels]),
        affectedSkills: Object.freeze(foundational.affectedSkills),
        askBeforeAdvice: false,
      }));
      cost += foundational.definition.cost;
    }
  }
  for (const item of ranked) {
    if (selected.some((question) => question.slot === item.slot)) continue;
    if (cost + item.definition.cost > MAX_QUESTION_COST) continue;
    selected.push(Object.freeze({
      slot: item.slot,
      question: item.definition.question,
      answerCost: item.definition.cost,
      targetLabels: Object.freeze([...item.definition.targetLabels]),
      affectedSkills: Object.freeze(item.affectedSkills),
      askBeforeAdvice: false,
    }));
    cost += item.definition.cost;
  }
  return Object.freeze(selected);
}
