const MIN_CONFIDENCE = 0.65;

export function evaluateSalesTurnReadiness(proposal, { runtimeAvailable = true } = {}) {
  const insuranceExpertRequired = Array.isArray(proposal?.insuranceNeeds)
    && proposal.insuranceNeeds.length > 0;
  if (!runtimeAvailable) {
    return { decision: 'retry_later', reason: 'interpreter_unavailable', officialFactsRequired: false, insuranceExpertRequired };
  }
  if (proposal.signals.stopContact) {
    return { decision: 'stop_contact', reason: 'stop_contact_requested', officialFactsRequired: false, insuranceExpertRequired: false };
  }
  if (proposal.signals.explicitRefusal) {
    return { decision: 'stop_contact', reason: 'explicit_refusal', officialFactsRequired: false, insuranceExpertRequired: false };
  }
  if (proposal.stage.confidence < MIN_CONFIDENCE) {
    return { decision: 'clarify', reason: 'low_stage_confidence', officialFactsRequired: proposal.signals.factSensitive, insuranceExpertRequired };
  }
  if (!proposal.concerns.length) {
    return { decision: 'clarify', reason: 'missing_concern', officialFactsRequired: proposal.signals.factSensitive, insuranceExpertRequired };
  }
  const primaryConcern = proposal.concerns.find((concern) => concern.priority === 'primary') || proposal.concerns[0];
  if (primaryConcern.confidence < MIN_CONFIDENCE) {
    return { decision: 'clarify', reason: 'low_concern_confidence', officialFactsRequired: proposal.signals.factSensitive, insuranceExpertRequired };
  }
  return { decision: 'execute', reason: 'ready', officialFactsRequired: proposal.signals.factSensitive, insuranceExpertRequired };
}
