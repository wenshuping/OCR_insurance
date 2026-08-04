function readinessReply(readiness) {
  if (readiness?.decision === 'stop_contact') {
    return '客户已明确拒绝或要求停止联系。本轮不要继续促成、追问或安排跟进；记录客户的联系偏好，后续仅在客户主动提出需求时回应。';
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
  return null;
}
