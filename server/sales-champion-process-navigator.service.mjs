import { buildSalesChampionKycLabelSnapshot } from './sales-champion-kyc-label-engine.mjs';
import { planSalesChampionQuestions } from './sales-champion-question-planner.service.mjs';

const PROCESS_LANES_BY_STAGE = Object.freeze({
  contact: 'relationship',
  appointment: 'relationship',
  discovery: 'discovery',
  proposal: 'solution',
  objection: 'decision',
  decision: 'decision',
  post_sale: 'retention',
});

const SERVICE_SITUATIONS = new Set(['orphan_policy', 'service_trust_recovery']);
const KYC_FACT_TO_SLOTS = Object.freeze({
  relationship_origin: ['customer_relationship_origin'],
  service_request: ['current_service_task', 'explicit_customer_request'],
  customer_goal: ['customer_goal'],
  contact_preference: ['contact_preference'],
  conversation_outcome: ['conversation_end_state'],
});

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value))];
}

function processLane(proposal) {
  if ((proposal?.situations || []).some((situation) => SERVICE_SITUATIONS.has(situation))) {
    return 'service';
  }
  return PROCESS_LANES_BY_STAGE[proposal?.stage?.value] || 'unknown';
}

function knownSlotsFromKyc(facts = []) {
  return uniqueStrings((Array.isArray(facts) ? facts : [])
    .filter((fact) => !['advisor_estimate', 'advisor_inference'].includes(fact?.source))
    .flatMap((fact) => KYC_FACT_TO_SLOTS[fact?.key] || []));
}

export function buildSalesChampionProcessNavigation({
  proposal = {},
  selection = {},
  boundaryCandidates = [],
  historicalLabels = [],
  knownSlots = [],
  unknownSlots = [],
} = {}) {
  const labels = buildSalesChampionKycLabelSnapshot({
    customerStatements: proposal.customerStatements || [],
    businessFacts: proposal.kycFacts || [],
    recognizedLabels: proposal.customerLabels || [],
    historicalLabels,
  });
  const questionPlan = planSalesChampionQuestions({
    proposal,
    boundaryCandidates,
    knownSlots: uniqueStrings([...knownSlots, ...knownSlotsFromKyc(proposal.kycFacts)]),
    unknownSlots: uniqueStrings([...unknownSlots, ...(proposal.unknownInformation || [])]),
  });
  const selectedSkills = uniqueStrings([
    selection?.primary?.key,
    ...(Array.isArray(selection?.supporting)
      ? selection.supporting.map((skill) => skill?.key) : []),
  ]);
  const candidateSkills = uniqueStrings([
    ...selectedSkills,
    ...(Array.isArray(boundaryCandidates)
      ? boundaryCandidates.map((candidate) => candidate?.key) : []),
  ]);
  const missingBoundaries = uniqueStrings((Array.isArray(boundaryCandidates)
    ? boundaryCandidates : []).flatMap((candidate) => candidate?.confirmationSlots || []));

  return Object.freeze({
    skill: Object.freeze({ key: 'sales_process_navigator', version: 1 }),
    processLane: processLane(proposal),
    stage: proposal?.stage?.value || 'unknown',
    confirmedFacts: Object.freeze(labels.confirmedFacts),
    estimatedFacts: Object.freeze(labels.estimatedFacts),
    confirmedLabels: Object.freeze(labels.confirmedLabels),
    candidateLabels: Object.freeze(labels.candidateLabels),
    labelConflicts: Object.freeze(labels.conflicts),
    candidateSkills: Object.freeze(candidateSkills),
    selectedSkills: Object.freeze(selectedSkills),
    missingBoundaries: Object.freeze(missingBoundaries),
    questionPlan,
    unknownFallback: boundaryCandidates[0]?.unknownFallback || 'generic_safe_follow_up',
  });
}
