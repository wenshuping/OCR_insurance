const MISSING_INFORMATION_LABELS = Object.freeze({
  customer_goal: '客户希望解决的核心问题，以及理想结果是什么',
  future_fund_use: '未来几年是否有明确的大额资金用途',
  budget: '不影响当前生活的可持续预算范围',
  existing_coverage: '现有保障和保单资料是否完整',
  product_contract: '相关产品合同或计划书是否可供核验',
  cash_value_schedule: '现金价值表或领取演示是否可供核验',
  family_decision_process: '这项安排需要哪些家人共同参与决定',
  health_information: '与后续投保可行性有关的健康信息',
  contact_preference: '客户希望的联系时间和沟通方式',
});

function text(value) {
  return String(value || '').trim();
}

function needsDiscoveryReply(proposal) {
  const statements = (Array.isArray(proposal?.customerStatements) ? proposal.customerStatements : [])
    .map((statement) => text(statement?.text))
    .filter(Boolean)
    .slice(0, 8);
  const missing = [...new Set((Array.isArray(proposal?.missingInformation)
    ? proposal.missingInformation : [])
    .map((key) => MISSING_INFORMATION_LABELS[key])
    .filter(Boolean))].slice(0, 5);
  const missingLines = (missing.length ? missing : [MISSING_INFORMATION_LABELS.customer_goal])
    .map((item, index) => `${index + 1}. ${item}。`);
  return [
    '客户理解',
    ...(statements.length
      ? statements.map((statement) => `- 顾问本轮提供：${statement}`)
      : ['- 当前还缺少可确认的客户原话。']),
    '- 以上内容只按原话记录；其中的估计、可能性和未确认产品类型仍保持未确认，不据此推导保障缺口、购买能力、家庭决策或财产结论。',
    '',
    '当前阶段',
    '现在属于需求发现阶段。本轮先弄清客户真正想解决的问题和下一步沟通目标，不急着推荐、比较或替换产品；没有已核验证据时，也不判断现有保障是否充足。',
    '',
    '下次沟通话术',
    '“您好，上次聊到您已经做过一些安排。我想先不急着谈新产品，先听听您现在最希望解决的是什么、理想结果是什么样。把目标和现实约束弄清楚后，我们再结合您已经做过的准备逐项核实，这样给您的建议才不会偏。您看什么时候方便聊十几分钟？”',
    '',
    '优先确认',
    ...missingLines,
  ].join('\n');
}

function readinessReply(readiness) {
  if (readiness?.decision === 'stop_contact') {
    return '客户已明确拒绝或要求停止联系。本轮不要继续促成、追问或安排跟进；记录客户的联系偏好，后续仅在客户主动提出需求时回应。';
  }
  if (readiness?.decision === 'clarify') {
    return '当前信息不足以稳定判断销售阶段或客户主要关注点。请先确认客户这次最想解决的问题、目前沟通到哪一步，以及希望下一次沟通达成什么结果；在确认前不要推荐产品或判断保障缺口。';
  }
  if (readiness?.decision === 'retry_later') {
    return '销售语义解释服务暂时不可用，本轮无法可靠判断销售阶段和客户关注点，请稍后重试。';
  }
  return '';
}

export function executeSalesChampionAtomicSkill({ context = {}, salesTurn = {} } = {}) {
  const gatedAnswer = readinessReply(salesTurn?.readiness);
  if (gatedAnswer) {
    return {
      facts: { answer: gatedAnswer },
      provenance: { source: 'sales_champion_readiness_gate', decision: salesTurn.readiness.decision, version: 1 },
      presentation: { message: gatedAnswer },
      interaction: { type: 'answer', text: gatedAnswer },
    };
  }
  if (context.familyId) return null;
  if (salesTurn?.selection?.primary?.key !== 'needs_discovery') return null;
  const answer = needsDiscoveryReply(salesTurn.proposal);
  return {
    facts: { answer },
    provenance: { source: 'sales_champion_atomic_skill', skill: 'needs_discovery', version: 1 },
    presentation: { message: answer },
    interaction: { type: 'answer', text: answer },
  };
}
