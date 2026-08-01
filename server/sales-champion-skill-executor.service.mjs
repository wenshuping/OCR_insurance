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

function plannedQuestions(salesTurn) {
  return (Array.isArray(salesTurn?.navigation?.questionPlan)
    ? salesTurn.navigation.questionPlan : [])
    .map((item) => text(item?.question))
    .filter(Boolean);
}

function needsDiscoveryReply(proposal, questionPlan = []) {
  const statements = (Array.isArray(proposal?.customerStatements) ? proposal.customerStatements : [])
    .map((statement) => text(statement?.text))
    .filter(Boolean)
    .slice(0, 8);
  const missing = [...new Set((Array.isArray(proposal?.missingInformation)
    ? proposal.missingInformation : [])
    .map((key) => MISSING_INFORMATION_LABELS[key])
    .filter(Boolean))].slice(0, 2);
  const missingLines = (questionPlan.length
    ? questionPlan
    : (missing.length ? missing : [MISSING_INFORMATION_LABELS.customer_goal]))
    .map((item, index) => `${index + 1}. ${item}${/[？?!！。；;]$/u.test(item) ? '' : '。'}`);
  const knownFacts = statements.length ? statements.join('；') : '还没有能确认的客户原话';
  return [
    `这单先别急着推。客户现在明确说到的是：${knownFacts}。没说的先别替他脑补。`,
    '',
    '下一步只做一件事：约十来分钟，把客户最想解决什么、以前做过什么安排听明白。聊清楚以后，再决定要不要谈方案。',
    '',
    '可以直接这样发：',
    '“我先不急着给您推荐东西。您现在最想解决的到底是哪件事？我先把您的想法和已经做过的安排听明白，再看有没有必要往下聊，免得一上来就给您讲一堆不合适的。您哪天方便，咱们聊十来分钟？”',
    '',
    '等客户愿意聊了，再顺手问两句：',
    ...missingLines,
  ].join('\n');
}

function readinessReply(readiness, questionPlan = []) {
  if (readiness?.decision === 'stop_contact') {
    return '客户已明确拒绝或要求停止联系。本轮不要继续促成、追问或安排跟进；记录客户的联系偏好，后续仅在客户主动提出需求时回应。';
  }
  if (readiness?.decision === 'clarify') {
    const questions = questionPlan.length
      ? questionPlan.map((question, index) => `${index + 1}. ${question}`).join('\n')
      : '1. 客户这次最想解决什么？\n2. 目前聊到了哪一步？';
    return [
      '现在还判断不准客户到底卡在哪儿，但不用等资料全了才跟进。先别推产品，也别急着判断保障够不够。',
      '',
      '先轻轻碰一下，只争取让客户说出眼下最在意的问题。',
      '',
      '可以直接这样发：',
      '“我先不急着给您讲方案，想先确认一下：您现在最想解决的是哪个问题？我按您最关心的部分来准备，不占用您太多时间。”',
      '',
      '你再补我两点左右你知道的，下一步就能说得更准；这轮实际问几个按下面问题来，不知道的不用查：',
      questions,
    ].join('\n');
  }
  if (readiness?.decision === 'retry_later') {
    return '销售语义解释服务暂时不可用，本轮无法可靠判断销售阶段和客户关注点，请稍后重试。';
  }
  return '';
}

export function executeSalesChampionAtomicSkill({ context = {}, salesTurn = {} } = {}) {
  const questions = plannedQuestions(salesTurn);
  const gatedAnswer = readinessReply(salesTurn?.readiness, questions);
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
  const answer = needsDiscoveryReply(salesTurn.proposal, questions);
  const trainingPacks = Array.isArray(salesTurn?.trainingPacks) ? salesTurn.trainingPacks : [];
  return {
    facts: { answer },
    provenance: {
      source: 'sales_champion_atomic_skill',
      skill: 'needs_discovery',
      version: 1,
      trainingPacks: trainingPacks.map((pack) => pack.key).filter(Boolean),
      evidenceRefs: trainingPacks.flatMap((pack) => Array.isArray(pack?.evidenceRefs) ? pack.evidenceRefs : []),
    },
    presentation: { message: answer },
    interaction: { type: 'answer', text: answer },
  };
}
