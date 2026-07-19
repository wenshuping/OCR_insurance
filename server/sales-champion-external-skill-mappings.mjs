const SOURCES = Object.freeze({
  chengjiye: 'cheng-jiye-atomic-skills-2026-07',
  wenxian: 'wenxian-meeting-close-skills-2026-07',
  yeyunyan: 'ye-yunyan-customer-operation-skills-2026-07',
  yirong: 'yi-rong-health-sales-skills-2026-07',
  daxiang: 'daxiang-huibao-sales-skills-2026-07',
});

export const SALES_CHAMPION_EXTERNAL_SOURCES = Object.freeze(
  Object.values(SOURCES).map((id) => Object.freeze({ id, version: 1, status: 'active' })),
);

function mapping(source, sourceSkill, capabilities, stages, concerns, {
  officialFactsRequired = false,
  actionSignature = 'discover_need',
  groups = ['customer_goal'],
  probeSlots = ['customer_goal'],
  requiredSlots = [],
  helpfulSlots = ['explicit_customer_request'],
  unknownFallback = officialFactsRequired ? 'defer_fact_until_verified' : 'acknowledge_and_discover',
  priority = 80,
} = {}) {
  const key = sourceSkill.replaceAll('-', '_');
  return Object.freeze({
    key,
    source,
    sourceSkill,
    capabilities: Object.freeze([...new Set([...capabilities, 'general_sales_clarification'])]),
    stages: Object.freeze(stages),
    concerns: Object.freeze(concerns),
    situations: Object.freeze([key]),
    allowedUse: key,
    officialFactsRequired,
    priority,
    promptRules: Object.freeze([
      `执行 ${sourceSkill} 的已审查原子方法；只使用客户已确认事实，并先给一个立即动作和一段可直接说的话。`,
      officialFactsRequired
        ? '保险、医疗、法律、税务或产品事实只登记核验需求，未经保险专家或权威证据确认不得下结论。'
        : '信息不足时先给不依赖未知事实的安全方法，再按统一 questionPlan 追问会改变本轮边界的信息。',
    ]),
    actionSignature,
    boundary: Object.freeze({
      groups: Object.freeze(groups),
      confirmedSituations: Object.freeze([key]),
      probeSlots: Object.freeze(probeSlots),
      requiredSlots: Object.freeze(requiredSlots),
      helpfulSlots: Object.freeze(helpfulSlots),
      excludedSignals: Object.freeze(['explicit_refusal', 'stop_contact']),
      unknownFallback,
    }),
  });
}

const C = SOURCES.chengjiye;
const W = SOURCES.wenxian;
const Y = SOURCES.yeyunyan;
const I = SOURCES.yirong;
const D = SOURCES.daxiang;

export const SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS = Object.freeze([
  mapping(C, 'chengjiye-attention-reset', ['appointment_scope', 'follow_up_consent'], ['contact', 'appointment', 'discovery', 'proposal', 'objection'], ['trust', 'follow_up', 'unknown'], { actionSignature: 'obtain_consent', groups: ['conversation_progress', 'decision_and_consent'], probeSlots: ['conversation_end_state', 'contact_preference'] }),
  mapping(C, 'chengjiye-business-owner-continuity', ['needs_discovery', 'five_question_diagnosis', 'fact_sensitive_routing'], ['discovery', 'proposal'], ['product_fit', 'liquidity', 'affordability', 'unknown'], { officialFactsRequired: true, probeSlots: ['customer_goal', 'customer_problem', 'sustainable_budget'], helpfulSlots: ['decision_participants'] }),
  mapping(C, 'chengjiye-education-funding-discovery', ['needs_discovery', 'five_question_diagnosis'], ['discovery', 'proposal'], ['product_fit', 'liquidity', 'affordability', 'unknown'], { probeSlots: ['customer_goal', 'fund_use_timeline'], helpfulSlots: ['future_fund_use', 'sustainable_budget'] }),
  mapping(C, 'chengjiye-health-needs-discovery', ['needs_discovery', 'five_question_diagnosis', 'fact_sensitive_routing'], ['discovery', 'proposal'], ['product_fit', 'claims', 'underwriting', 'affordability', 'unknown'], { officialFactsRequired: true, probeSlots: ['customer_goal', 'customer_problem', 'existing_policy_evidence'], helpfulSlots: ['sustainable_budget'] }),
  mapping(C, 'chengjiye-high-net-worth-authentic-positioning', ['reputation_objection', 'fact_sensitive_routing'], ['contact', 'appointment', 'discovery'], ['trust', 'unknown'], { officialFactsRequired: true, actionSignature: 'protect_compliance_boundary', groups: ['customer_relationship', 'insurance_evidence'], probeSlots: ['explicit_customer_request'], helpfulSlots: ['customer_goal'] }),
  mapping(C, 'chengjiye-high-net-worth-investment-objection', ['tradeoff_disclosure', 'five_question_diagnosis'], ['proposal', 'objection'], ['benefits', 'liquidity', 'product_fit'], { actionSignature: 'explain_tradeoff', groups: ['customer_goal', 'objection'], probeSlots: ['objection_reason', 'future_fund_use'], requiredSlots: ['objection_reason'], helpfulSlots: ['fund_use_timeline'] }),
  mapping(C, 'chengjiye-next-meeting-commitment', ['appointment_scope', 'follow_up_consent'], ['discovery', 'proposal'], ['follow_up', 'product_fit', 'unknown'], { actionSignature: 'advance_next_step', groups: ['conversation_progress', 'decision_and_consent'], probeSlots: ['conversation_end_state', 'contact_preference'], helpfulSlots: ['customer_goal'] }),
  mapping(C, 'chengjiye-referral-needs-reset', ['appointment_scope', 'needs_discovery'], ['contact', 'appointment', 'discovery'], ['trust', 'product_fit', 'unknown'], { actionSignature: 'scope_conversation', groups: ['customer_relationship', 'meeting_intent'], probeSlots: ['customer_relationship_origin', 'meeting_trigger'], requiredSlots: ['customer_relationship_origin'], helpfulSlots: ['customer_goal'] }),
  mapping(C, 'chengjiye-relatives-insurance-boundary', ['reputation_objection', 'follow_up_consent'], ['contact', 'appointment', 'objection'], ['trust', 'follow_up'], { actionSignature: 'protect_customer_choice', groups: ['customer_relationship', 'decision_and_consent'], probeSlots: ['customer_decision', 'contact_preference'], helpfulSlots: ['objection_reason'], unknownFallback: 'generic_safe_follow_up' }),
  mapping(C, 'chengjiye-social-insurance-gap-review', ['five_question_diagnosis', 'plain_language_explanation', 'fact_sensitive_routing'], ['discovery', 'proposal', 'objection'], ['product_fit', 'claims', 'benefits'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['existing_policy_evidence', 'customer_goal'], requiredSlots: ['existing_policy_evidence'] }),
  mapping(C, 'chengjiye-transparent-opening', ['appointment_scope', 'needs_discovery'], ['contact', 'appointment'], ['trust', 'follow_up', 'unknown'], { actionSignature: 'scope_conversation', groups: ['customer_relationship', 'meeting_intent'], probeSlots: ['explicit_customer_request', 'meeting_trigger'], helpfulSlots: ['customer_relationship_origin'] }),
  mapping(C, 'chengjiye-wealth-goal-discovery', ['needs_discovery', 'five_question_diagnosis', 'tradeoff_disclosure'], ['discovery', 'proposal', 'objection'], ['benefits', 'liquidity', 'product_fit', 'unknown'], { probeSlots: ['customer_goal', 'future_fund_use', 'fund_use_timeline'], helpfulSlots: ['sustainable_budget'] }),

  mapping(W, 'wenxian-channel-service-comparison', ['plain_language_explanation', 'five_question_diagnosis'], ['proposal', 'objection', 'decision'], ['trust', 'product_fit', 'benefits'], { officialFactsRequired: true, actionSignature: 'explain_verified_facts', groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['customer_goal', 'product_identity'] }),
  mapping(W, 'wenxian-competitor-comparison', ['tradeoff_disclosure', 'plain_language_explanation', 'fact_sensitive_routing'], ['proposal', 'objection', 'decision'], ['benefits', 'product_fit', 'trust', 'liquidity'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['customer_goal', 'objection', 'insurance_evidence'], probeSlots: ['customer_goal', 'product_identity', 'objection_reason'], requiredSlots: ['product_identity'] }),
  mapping(W, 'wenxian-cross-institution-asset-inventory', ['needs_discovery', 'five_question_diagnosis'], ['discovery', 'proposal'], ['liquidity', 'product_fit', 'unknown'], { actionSignature: 'obtain_consent', groups: ['customer_goal', 'decision_and_consent'], probeSlots: ['customer_goal', 'explicit_customer_request'], helpfulSlots: ['future_fund_use'] }),
  mapping(W, 'wenxian-dormant-funds-appointment', ['appointment_scope', 'follow_up_consent'], ['contact', 'appointment'], ['follow_up', 'liquidity', 'unknown'], { actionSignature: 'scope_conversation', groups: ['customer_relationship', 'meeting_intent'], probeSlots: ['meeting_trigger', 'contact_preference'], requiredSlots: ['meeting_trigger'] }),
  mapping(W, 'wenxian-family-decision-meeting', ['family_joint_decision', 'five_question_diagnosis'], ['proposal', 'objection', 'decision'], ['family_decision'], { actionSignature: 'facilitate_decision', groups: ['objection', 'decision_and_consent'], probeSlots: ['decision_participants', 'objection_reason'], requiredSlots: ['decision_participants'], helpfulSlots: ['customer_decision'] }),
  mapping(W, 'wenxian-hidden-objection-clarification', ['five_question_diagnosis', 'follow_up_consent'], ['objection', 'decision'], ['unknown', 'family_decision', 'trust', 'product_fit'], { actionSignature: 'diagnose_objection', groups: ['objection', 'conversation_progress'], probeSlots: ['objection_reason', 'conversation_end_state'], requiredSlots: ['objection_reason'] }),
  mapping(W, 'wenxian-liquidity-contingency-objection', ['tradeoff_disclosure', 'five_question_diagnosis', 'fact_sensitive_routing'], ['proposal', 'objection', 'decision'], ['liquidity', 'affordability', 'surrender'], { officialFactsRequired: true, actionSignature: 'explain_tradeoff', groups: ['objection', 'insurance_evidence'], probeSlots: ['objection_reason', 'fund_use_timeline', 'sustainable_budget'], requiredSlots: ['objection_reason'] }),
  mapping(W, 'wenxian-long-commitment-objection', ['tradeoff_disclosure', 'five_question_diagnosis', 'fact_sensitive_routing'], ['proposal', 'objection'], ['duration', 'affordability', 'liquidity'], { officialFactsRequired: true, actionSignature: 'explain_tradeoff', groups: ['objection', 'insurance_evidence'], probeSlots: ['objection_reason', 'fund_use_timeline', 'sustainable_budget'], requiredSlots: ['objection_reason'] }),
  mapping(W, 'wenxian-low-return-objection', ['tradeoff_disclosure', 'five_question_diagnosis', 'fact_sensitive_routing'], ['proposal', 'objection'], ['benefits', 'liquidity', 'product_fit'], { officialFactsRequired: true, actionSignature: 'explain_tradeoff', groups: ['customer_goal', 'objection', 'insurance_evidence'], probeSlots: ['objection_reason', 'future_fund_use', 'product_identity'], requiredSlots: ['objection_reason'] }),
  mapping(W, 'wenxian-meeting-agenda-permission', ['appointment_scope', 'follow_up_consent'], ['appointment', 'discovery'], ['follow_up', 'trust', 'unknown'], { actionSignature: 'scope_conversation', groups: ['meeting_intent', 'decision_and_consent'], probeSlots: ['explicit_customer_request', 'contact_preference'], helpfulSlots: ['customer_goal'] }),
  mapping(W, 'wenxian-objection-emotion-clarification', ['five_question_diagnosis', 'reputation_objection'], ['objection', 'decision'], ['trust', 'unknown', 'product_fit'], { actionSignature: 'diagnose_objection', groups: ['objection'], probeSlots: ['objection_reason'], requiredSlots: ['objection_reason'], helpfulSlots: ['customer_goal'] }),
  mapping(W, 'wenxian-prior-insurance-experience-repair', ['reputation_objection', 'fact_sensitive_routing'], ['contact', 'appointment', 'objection', 'post_sale'], ['trust', 'claims', 'surrender'], { officialFactsRequired: true, actionSignature: 'rebuild_trust', groups: ['customer_relationship', 'insurance_evidence'], probeSlots: ['service_issue', 'existing_policy_evidence'], requiredSlots: ['service_issue'], helpfulSlots: ['customer_goal'], unknownFallback: 'generic_service_first' }),
  mapping(W, 'wenxian-priority-tradeoff-discovery', ['needs_discovery', 'tradeoff_disclosure'], ['discovery', 'proposal'], ['liquidity', 'benefits', 'product_fit', 'unknown'], { actionSignature: 'discover_need', groups: ['customer_goal'], probeSlots: ['customer_goal', 'future_fund_use', 'fund_use_timeline'] }),
  mapping(W, 'wenxian-product-fact-comparison', ['plain_language_explanation', 'fact_sensitive_routing'], ['proposal', 'objection', 'decision'], ['benefits', 'product_fit'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['insurance_evidence'], probeSlots: ['product_identity'], requiredSlots: ['product_identity'], helpfulSlots: ['customer_goal'] }),
  mapping(W, 'wenxian-reciprocal-disclosure-kyc', ['appointment_scope', 'needs_discovery'], ['appointment', 'discovery'], ['trust', 'unknown'], { actionSignature: 'obtain_consent', groups: ['meeting_intent', 'decision_and_consent'], probeSlots: ['explicit_customer_request'], helpfulSlots: ['customer_goal'] }),
  mapping(W, 'wenxian-request-behind-request-discovery', ['needs_discovery', 'five_question_diagnosis'], ['discovery', 'proposal'], ['product_fit', 'unknown'], { probeSlots: ['explicit_customer_request', 'customer_goal'], helpfulSlots: ['customer_problem'] }),
  mapping(W, 'wenxian-stalled-commitment-clarification', ['five_question_diagnosis', 'follow_up_consent'], ['objection', 'decision'], ['follow_up', 'unknown', 'product_fit'], { actionSignature: 'diagnose_objection', groups: ['objection', 'conversation_progress'], probeSlots: ['objection_reason', 'conversation_end_state'], helpfulSlots: ['customer_decision'] }),
  mapping(W, 'wenxian-time-bucket-allocation', ['needs_discovery', 'tradeoff_disclosure'], ['discovery', 'proposal'], ['liquidity', 'duration', 'product_fit'], { actionSignature: 'explain_tradeoff', groups: ['customer_goal'], probeSlots: ['future_fund_use', 'fund_use_timeline'], helpfulSlots: ['sustainable_budget'] }),

  mapping(Y, 'yeyunyan-client-contact-planning', ['appointment_scope', 'follow_up_consent'], ['contact', 'appointment', 'post_sale'], ['follow_up', 'unknown'], { actionSignature: 'advance_next_step', groups: ['customer_relationship', 'conversation_progress'], probeSlots: ['contact_preference', 'conversation_end_state'] }),
  mapping(Y, 'yeyunyan-client-event-design', ['appointment_scope', 'follow_up_consent'], ['contact', 'appointment'], ['follow_up', 'unknown'], { actionSignature: 'scope_conversation', groups: ['meeting_intent', 'decision_and_consent'], probeSlots: ['meeting_trigger', 'explicit_customer_request'], helpfulSlots: ['contact_preference'] }),
  mapping(Y, 'yeyunyan-client-event-follow-up', ['follow_up_consent', 'appointment_scope'], ['appointment', 'post_sale'], ['follow_up', 'trust'], { actionSignature: 'obtain_consent', groups: ['conversation_progress', 'decision_and_consent'], probeSlots: ['contact_preference', 'conversation_end_state'], helpfulSlots: ['explicit_customer_request'] }),
  mapping(Y, 'yeyunyan-client-resource-platform', ['referral_request', 'follow_up_consent'], ['appointment', 'post_sale'], ['follow_up', 'trust'], { actionSignature: 'obtain_consent', groups: ['customer_relationship', 'decision_and_consent'], probeSlots: ['referral_consent', 'explicit_customer_request'], requiredSlots: ['referral_consent'], helpfulSlots: ['contact_preference'] }),
  mapping(Y, 'yeyunyan-continuous-service-cadence', ['follow_up_consent'], ['post_sale'], ['follow_up', 'trust'], { actionSignature: 'service_first', groups: ['customer_relationship', 'conversation_progress'], probeSlots: ['contact_preference', 'conversation_end_state'], helpfulSlots: ['service_issue'], unknownFallback: 'generic_service_first' }),
  mapping(Y, 'yeyunyan-customer-problem-response', ['reputation_objection', 'follow_up_consent'], ['contact', 'appointment', 'post_sale'], ['trust', 'follow_up', 'claims'], { actionSignature: 'service_first', groups: ['customer_relationship', 'conversation_progress'], probeSlots: ['service_issue', 'explicit_customer_request'], requiredSlots: ['service_issue'], helpfulSlots: ['contact_preference'], unknownFallback: 'generic_service_first' }),
  mapping(Y, 'yeyunyan-personalized-service-preference', ['follow_up_consent'], ['appointment', 'post_sale'], ['follow_up', 'trust'], { actionSignature: 'obtain_consent', groups: ['customer_relationship', 'decision_and_consent'], probeSlots: ['contact_preference'], requiredSlots: ['contact_preference'], helpfulSlots: ['explicit_customer_request'] }),
  mapping(Y, 'yeyunyan-professional-presentation', ['reputation_objection', 'appointment_scope'], ['contact', 'appointment'], ['trust', 'unknown'], { actionSignature: 'rebuild_trust', groups: ['customer_relationship', 'meeting_intent'], probeSlots: ['explicit_customer_request'], helpfulSlots: ['customer_goal'] }),
  mapping(Y, 'yeyunyan-sales-operation-maturity', ['general_sales_clarification'], ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'], ['follow_up', 'unknown'], { actionSignature: 'safe_fallback', groups: ['sales_stage', 'conversation_progress'], probeSlots: ['conversation_end_state'], helpfulSlots: ['customer_goal'] }),
  mapping(Y, 'yeyunyan-service-level-planning', ['follow_up_consent'], ['appointment', 'post_sale'], ['follow_up', 'trust'], { actionSignature: 'service_first', groups: ['customer_relationship', 'conversation_progress'], probeSlots: ['contact_preference', 'explicit_customer_request'], helpfulSlots: ['service_issue'], unknownFallback: 'generic_service_first' }),
  mapping(Y, 'yeyunyan-trust-profile-branding', ['reputation_objection'], ['contact', 'appointment'], ['trust', 'follow_up'], { actionSignature: 'rebuild_trust', groups: ['customer_relationship'], probeSlots: ['explicit_customer_request'], helpfulSlots: ['customer_relationship_origin'] }),

  mapping(I, 'yirong-care-setting-medical-tier', ['needs_discovery', 'plain_language_explanation', 'fact_sensitive_routing'], ['discovery', 'proposal'], ['product_fit', 'benefits', 'affordability', 'underwriting'], { officialFactsRequired: true, groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['customer_goal', 'sustainable_budget', 'product_identity'] }),
  mapping(I, 'yirong-critical-illness-total-loss', ['needs_discovery', 'five_question_diagnosis', 'fact_sensitive_routing'], ['discovery', 'proposal', 'objection'], ['claims', 'risk_pooling', 'product_fit'], { officialFactsRequired: true, groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['customer_problem', 'existing_policy_evidence'], helpfulSlots: ['sustainable_budget'] }),
  mapping(I, 'yirong-immunotherapy-coverage', ['plain_language_explanation', 'fact_sensitive_routing'], ['proposal', 'objection', 'post_sale'], ['claims', 'underwriting'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['insurance_evidence'], probeSlots: ['product_identity', 'existing_policy_evidence'], requiredSlots: ['product_identity'] }),
  mapping(I, 'yirong-medical-inflation-review', ['tradeoff_disclosure', 'fact_sensitive_routing'], ['discovery', 'proposal', 'objection', 'post_sale'], ['benefits', 'affordability', 'product_fit'], { officialFactsRequired: true, actionSignature: 'explain_tradeoff', groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['existing_policy_evidence', 'sustainable_budget'], helpfulSlots: ['customer_goal'] }),
  mapping(I, 'yirong-million-medical-needs', ['needs_discovery', 'plain_language_explanation', 'fact_sensitive_routing'], ['discovery', 'proposal', 'objection'], ['product_fit', 'claims', 'underwriting', 'affordability'], { officialFactsRequired: true, groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['customer_goal', 'product_identity', 'sustainable_budget'] }),
  mapping(I, 'yirong-million-medical-vs-critical-illness', ['plain_language_explanation', 'five_question_diagnosis', 'fact_sensitive_routing'], ['discovery', 'proposal', 'objection'], ['product_fit', 'claims', 'risk_pooling'], { officialFactsRequired: true, actionSignature: 'explain_verified_facts', groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['existing_policy_evidence', 'customer_goal'] }),
  mapping(I, 'yirong-proton-heavy-ion-coverage', ['plain_language_explanation', 'fact_sensitive_routing'], ['proposal', 'objection', 'post_sale'], ['claims', 'underwriting'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['insurance_evidence'], probeSlots: ['product_identity', 'existing_policy_evidence'], requiredSlots: ['product_identity'] }),
  mapping(I, 'yirong-robotic-surgery-coverage', ['plain_language_explanation', 'fact_sensitive_routing'], ['proposal', 'objection', 'post_sale'], ['claims', 'underwriting'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['insurance_evidence'], probeSlots: ['product_identity', 'existing_policy_evidence'], requiredSlots: ['product_identity'] }),
  mapping(I, 'yirong-social-medical-insurance-gap', ['five_question_diagnosis', 'plain_language_explanation', 'fact_sensitive_routing'], ['discovery', 'proposal', 'objection'], ['product_fit', 'claims', 'benefits'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['existing_policy_evidence', 'customer_goal'], requiredSlots: ['existing_policy_evidence'] }),
  mapping(I, 'yirong-targeted-drug-coverage', ['plain_language_explanation', 'fact_sensitive_routing'], ['proposal', 'objection', 'post_sale'], ['claims', 'underwriting'], { officialFactsRequired: true, actionSignature: 'route_verified_evidence', groups: ['insurance_evidence'], probeSlots: ['product_identity', 'existing_policy_evidence'], requiredSlots: ['product_identity'] }),

  mapping(D, 'maturing-funds-needs-discovery', ['needs_discovery', 'five_question_diagnosis'], ['discovery'], ['liquidity', 'product_fit', 'unknown'], { probeSlots: ['future_fund_use', 'fund_use_timeline'], helpfulSlots: ['existing_policy_evidence'] }),
  mapping(D, 'three-dimension-asset-discovery', ['needs_discovery', 'tradeoff_disclosure'], ['discovery'], ['liquidity', 'benefits', 'product_fit', 'unknown'], { probeSlots: ['customer_goal', 'future_fund_use'], helpfulSlots: ['fund_use_timeline'] }),
  mapping(D, 'early-cash-value-objection', ['tradeoff_disclosure', 'fact_sensitive_routing'], ['proposal', 'objection'], ['liquidity', 'benefits', 'surrender'], { officialFactsRequired: true, actionSignature: 'explain_tradeoff', groups: ['objection', 'insurance_evidence'], probeSlots: ['objection_reason', 'product_identity', 'fund_use_timeline'], requiredSlots: ['objection_reason'] }),
  mapping(D, 'permission-based-appointment-call', ['appointment_scope', 'follow_up_consent'], ['contact', 'appointment'], ['trust', 'follow_up'], { actionSignature: 'scope_conversation', groups: ['customer_relationship', 'meeting_intent'], probeSlots: ['customer_relationship_origin', 'meeting_trigger', 'contact_preference'], requiredSlots: ['customer_relationship_origin'] }),
  mapping(D, 'existing-policy-gap-review', ['needs_discovery', 'fact_sensitive_routing'], ['proposal', 'post_sale'], ['product_fit', 'affordability', 'unknown'], { officialFactsRequired: true, groups: ['customer_goal', 'insurance_evidence'], probeSlots: ['existing_arrangement_goal', 'existing_policy_evidence', 'sustainable_budget'], requiredSlots: ['existing_policy_evidence'] }),
  mapping(D, 'insurance-category-resistance', ['reputation_objection', 'five_question_diagnosis', 'fact_sensitive_routing'], ['proposal', 'objection'], ['trust', 'product_fit'], { officialFactsRequired: true, actionSignature: 'diagnose_objection', groups: ['objection', 'insurance_evidence'], probeSlots: ['objection_reason', 'product_identity'], requiredSlots: ['objection_reason'] }),
]);

export const SALES_CHAMPION_EXTERNAL_SITUATION_KEYS = Object.freeze(
  SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS.map((mappingEntry) => mappingEntry.key),
);
