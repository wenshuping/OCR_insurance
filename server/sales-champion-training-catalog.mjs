const YANLI_SOURCE = 'yanli-whole-life-sales-2026-07';
const YULEILEI_SOURCE = 'yuleilei-high-client-sales-2026-07';
const MAX_PACKS = 3;

const PACKS = Object.freeze({
  discover_goal_with_golden_circle: { capabilities: ['needs_discovery'], stages: ['discovery'], concerns: ['unknown', 'product_fit'], allowedUse: 'goal_questions', officialFactsRequired: false },
  surface_need_with_three_step: { capabilities: ['five_question_diagnosis'], stages: ['discovery', 'objection'], concerns: ['unknown', 'product_fit'], allowedUse: 'question_sequence', officialFactsRequired: false },
  frame_risk_without_fear: { capabilities: ['five_question_diagnosis'], stages: ['discovery', 'objection'], concerns: ['trust', 'product_fit'], allowedUse: 'risk_discussion', officialFactsRequired: false },
  awaken_scenario_need: { capabilities: ['needs_discovery'], stages: ['contact', 'discovery'], concerns: ['unknown', 'product_fit'], allowedUse: 'scenario_questions', officialFactsRequired: false },
  diagnose_retirement_goal: { capabilities: ['needs_discovery'], stages: ['discovery'], concerns: ['product_fit'], allowedUse: 'retirement_questions', officialFactsRequired: false },
  diagnose_education_goal: { capabilities: ['needs_discovery'], stages: ['discovery'], concerns: ['product_fit'], allowedUse: 'education_questions', officialFactsRequired: false },
  facilitate_family_decision: { capabilities: ['family_joint_decision'], stages: ['discovery', 'proposal', 'objection', 'decision'], concerns: ['family_decision'], allowedUse: 'joint_decision', officialFactsRequired: false },
  identify_legacy_goal: { capabilities: ['needs_discovery'], stages: ['discovery'], concerns: ['product_fit'], allowedUse: 'legacy_questions', officialFactsRequired: true },
  refer_legal_tax_question: { capabilities: ['fact_sensitive_routing'], stages: [], concerns: ['product_fit', 'benefits'], allowedUse: 'professional_referral', officialFactsRequired: true },
  segment_client_by_confirmed_need: { capabilities: ['appointment_scope'], stages: ['appointment'], concerns: ['follow_up'], allowedUse: 'service_segmentation', officialFactsRequired: false },
  plan_hybrid_client_follow_up: { capabilities: ['follow_up_consent'], stages: ['contact', 'appointment'], concerns: ['follow_up'], allowedUse: 'follow_up_planning', officialFactsRequired: false },
  select_five_dimension_dialogue: { capabilities: ['plain_language_explanation'], stages: ['proposal', 'objection'], concerns: ['trust', 'product_fit', 'benefits'], allowedUse: 'dialogue_dimension', officialFactsRequired: true },
  translate_feature_to_value: { capabilities: ['plain_language_explanation'], stages: ['proposal', 'objection'], concerns: ['product_fit', 'benefits'], allowedUse: 'explanation_structure', officialFactsRequired: true },
  clarify_duration_objection: { capabilities: ['tradeoff_disclosure'], stages: ['objection'], concerns: ['duration'], allowedUse: 'duration_clarification', officialFactsRequired: true },
  clarify_payback_objection: { capabilities: ['tradeoff_disclosure'], stages: ['objection'], concerns: ['surrender', 'benefits'], allowedUse: 'payback_clarification', officialFactsRequired: true },
  clarify_liquidity_objection: { capabilities: ['tradeoff_disclosure'], stages: ['objection'], concerns: ['liquidity'], allowedUse: 'liquidity_clarification', officialFactsRequired: true },
  clarify_return_comparison: { capabilities: ['tradeoff_disclosure'], stages: ['proposal', 'objection'], concerns: ['benefits'], allowedUse: 'comparison_normalization', officialFactsRequired: true },
  exit_mismatched_proposal: { capabilities: ['tradeoff_disclosure', 'five_question_diagnosis'], stages: ['proposal', 'objection', 'decision'], concerns: ['affordability', 'duration', 'liquidity', 'product_fit'], allowedUse: 'proposal_exit', officialFactsRequired: false },
  position_trusted_advisor: { source: YULEILEI_SOURCE, capabilities: ['reputation_objection'], stages: ['proposal', 'objection'], concerns: ['trust'], allowedUse: 'advisor_positioning', officialFactsRequired: false },
  qualify_circle_fit: { source: YULEILEI_SOURCE, capabilities: ['appointment_scope'], stages: ['appointment'], concerns: ['follow_up'], allowedUse: 'circle_qualification', officialFactsRequired: false },
  map_circle_entry: { source: YULEILEI_SOURCE, capabilities: ['appointment_scope'], stages: ['appointment'], concerns: ['follow_up'], allowedUse: 'circle_entry', officialFactsRequired: false },
  offer_value_before_access: { source: YULEILEI_SOURCE, capabilities: ['appointment_scope', 'follow_up_consent'], stages: ['contact', 'appointment'], concerns: ['follow_up'], allowedUse: 'value_first_outreach', officialFactsRequired: false },
  request_consented_referral: { source: YULEILEI_SOURCE, capabilities: ['referral_request'], stages: ['post_sale'], concerns: ['follow_up'], allowedUse: 'consented_referral', officialFactsRequired: false },
  prepare_high_value_meeting: { source: YULEILEI_SOURCE, capabilities: ['appointment_scope'], stages: ['appointment'], concerns: ['follow_up'], allowedUse: 'meeting_preparation', officialFactsRequired: false },
  interview_wealth_dilemma: { source: YULEILEI_SOURCE, capabilities: ['needs_discovery', 'five_question_diagnosis'], stages: ['discovery'], concerns: ['unknown', 'product_fit'], allowedUse: 'wealth_discovery', officialFactsRequired: false },
  screen_family_business_risk: { source: YULEILEI_SOURCE, capabilities: ['needs_discovery', 'fact_sensitive_routing'], stages: ['discovery', 'proposal'], concerns: ['product_fit', 'family_decision'], allowedUse: 'family_business_screening', officialFactsRequired: true },
  normalize_asset_allocation: { source: YULEILEI_SOURCE, capabilities: ['tradeoff_disclosure', 'plain_language_explanation'], stages: ['proposal', 'objection'], concerns: ['benefits', 'product_fit', 'liquidity'], allowedUse: 'asset_comparison', officialFactsRequired: true },
  build_evidence_based_trust: { source: YULEILEI_SOURCE, capabilities: ['reputation_objection'], stages: ['objection'], concerns: ['trust'], allowedUse: 'trust_evidence', officialFactsRequired: false },
  plan_long_cycle_high_client_followup: { source: YULEILEI_SOURCE, capabilities: ['follow_up_consent'], stages: ['contact', 'appointment'], concerns: ['follow_up'], allowedUse: 'long_cycle_follow_up', officialFactsRequired: false },
  debrief_high_value_case: { source: YULEILEI_SOURCE, capabilities: ['plain_language_explanation'], stages: ['proposal', 'objection'], concerns: ['product_fit', 'trust'], allowedUse: 'case_method', officialFactsRequired: true },
  plan_consent_based_client_event: { source: YULEILEI_SOURCE, capabilities: ['appointment_scope'], stages: ['appointment'], concerns: ['follow_up'], allowedUse: 'client_event', officialFactsRequired: false },
  protect_network_client_privacy: { source: YULEILEI_SOURCE, capabilities: ['referral_request', 'follow_up_consent'], stages: ['appointment', 'post_sale'], concerns: ['follow_up'], allowedUse: 'network_privacy', officialFactsRequired: false },
});

function matches(pack, requested, stage, concerns) {
  if (!pack.capabilities.some((capability) => requested.has(capability))) return false;
  if (pack.stages.length && !pack.stages.includes(stage)) return false;
  return !pack.concerns.length || pack.concerns.some((concern) => concerns.has(concern));
}

export function getSalesChampionTrainingPacks(capabilityKeys = [], { stage = '', concerns = [] } = {}) {
  const requested = new Set(Array.isArray(capabilityKeys) ? capabilityKeys : []);
  const concernSet = new Set(Array.isArray(concerns) ? concerns : []);
  return Object.entries(PACKS)
    .filter(([, pack]) => matches(pack, requested, stage, concernSet))
    .slice(0, MAX_PACKS)
    .map(([key, pack]) => ({
      key,
      version: 1,
      source: pack.source ?? YANLI_SOURCE,
      allowedUse: pack.allowedUse,
      officialFactsRequired: pack.officialFactsRequired,
    }));
}
