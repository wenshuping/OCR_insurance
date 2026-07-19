import { createSalesChampionCustomerLabelApplicability } from './sales-champion-customer-labels.mjs';

const mapLabels = (definition) => createSalesChampionCustomerLabelApplicability(definition);
const STOP_MARKETING = Object.freeze({ contact_permission: ['B3', 'B4'] });
const STOP_NONESSENTIAL = Object.freeze({ contact_permission: ['B4'] });

export const SALES_CHAMPION_CAPABILITY_LABEL_MAPPINGS = Object.freeze({
  sales_process_navigator: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'resistance', 'decision_maturity', 'customer_journey', 'policy_relationship', 'service_status', 'service_priority', 'contact_permission', 'communication_preference', 'current_concern', 'next_action'],
    preferredLabels: {},
    probeLabels: { contact_permission: ['B0'], current_concern: ['顾虑尚未明确'] },
  }),
  appointment_scope: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'customer_journey', 'contact_permission', 'communication_preference', 'next_action'],
    preferredLabels: { customer_status: ['C1', 'C2', 'C3'], relationship_maturity: ['G0', 'G1', 'G2'], customer_journey: ['J2', 'J3'], contact_permission: ['B2', 'B5'], next_action: ['初次沟通', '需求访谈', '方案沟通'] },
    probeLabels: { contact_permission: ['B0'] },
    excludedLabels: { ...STOP_MARKETING, customer_status: ['C9'] },
  }),
  tradeoff_disclosure: mapLabels({
    readsLabels: ['demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'economic_capacity'],
    requiredLabels: { current_concern: ['收益顾虑', '流动性顾虑', '缴费持续性顾虑', '需要比较其他方案'] },
    preferredLabels: { demand_maturity: ['N2', 'N3', 'N4'], purchase_intent: ['I2', 'I3', 'I4'], decision_maturity: ['D2', 'D3', 'D4'] },
    probeLabels: { current_concern: ['顾虑尚未明确'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { economic_capacity: ['E1', 'E2', 'E3', 'E4', 'E5'] },
  }),
  five_question_diagnosis: mapLabels({
    readsLabels: ['demand_maturity', 'purchase_intent', 'resistance', 'decision_maturity', 'current_concern', 'contact_permission'],
    preferredLabels: { demand_maturity: ['N1', 'N2', 'N3'], purchase_intent: ['I0', 'I1', 'I2', 'I3'], resistance: ['K3', 'K4', 'K5'], decision_maturity: ['D1', 'D2', 'D3', 'D4'] },
    probeLabels: { current_concern: ['顾虑尚未明确'] },
    excludedLabels: STOP_MARKETING,
  }),
  reputation_objection: mapLabels({
    readsLabels: ['relationship_maturity', 'resistance', 'service_status', 'current_concern', 'contact_permission'],
    preferredLabels: { relationship_maturity: ['G0', 'G1', 'G2'], resistance: ['K4', 'K5'], service_status: ['无法继续处理'], current_concern: ['不信任保险', '不信任销售人员', '过去存在不良经历'] },
    probeLabels: { resistance: ['K0'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { contact_permission: ['B0'] },
  }),
  risk_pooling_explanation: mapLabels({
    readsLabels: ['demand_maturity', 'resistance', 'current_concern', 'contact_permission'],
    preferredLabels: { demand_maturity: ['N2', 'N3', 'N4'], resistance: ['K2', 'K3', 'K4'], current_concern: ['合同理解困难', '顾虑尚未明确'] },
    excludedLabels: STOP_MARKETING,
  }),
  needs_discovery: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'resistance', 'customer_journey', 'contact_permission', 'current_concern', 'next_action'],
    preferredLabels: { customer_status: ['C1', 'C2'], relationship_maturity: ['G0', 'G1', 'G2'], demand_maturity: ['N0', 'N1', 'N2', 'N3'], purchase_intent: ['I0', 'I1', 'I2'], customer_journey: ['J2', 'J4'], contact_permission: ['B2', 'B5'], next_action: ['需求访谈'] },
    probeLabels: { contact_permission: ['B0'], current_concern: ['顾虑尚未明确'] },
    excludedLabels: { ...STOP_MARKETING, customer_status: ['C9'] },
  }),
  family_joint_decision: mapLabels({
    readsLabels: ['family_stage', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['家庭意见不一致', '需要共同决策人参与'] },
    preferredLabels: { decision_maturity: ['D4'], next_action: ['邀请共同决策人'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { family_stage: ['已婚', '育儿家庭', '多代家庭', '单亲家庭'] },
  }),
  rebate_request_handling: mapLabels({
    readsLabels: ['purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    preferredLabels: { purchase_intent: ['I3', 'I4', 'I5'], decision_maturity: ['D3', 'D4', 'D5'], next_action: ['处理核心顾虑', '确认客户决定'] },
    excludedLabels: STOP_MARKETING,
  }),
  cooling_off_support: mapLabels({
    readsLabels: ['policy_relationship', 'service_status', 'service_priority', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    preferredLabels: { policy_relationship: ['P3', 'P4', 'P5'], service_priority: ['S1', 'S2', 'S3'], decision_maturity: ['D5'], next_action: ['确认客户决定', '交付服务'] },
    excludedLabels: STOP_NONESSENTIAL,
  }),
  follow_up_consent: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'purchase_intent', 'customer_journey', 'contact_permission', 'communication_preference', 'next_action'],
    preferredLabels: { customer_status: ['C1', 'C2', 'C3'], relationship_maturity: ['G1', 'G2', 'G3'], purchase_intent: ['I1', 'I2', 'I3', 'I4'], customer_journey: ['J2', 'J3'], contact_permission: ['B2', 'B5'], next_action: ['初次沟通', '定期复盘', '确认客户决定'] },
    probeLabels: { contact_permission: ['B0'] },
    excludedLabels: { ...STOP_MARKETING, customer_status: ['C9'] },
  }),
  referral_request: mapLabels({
    readsLabels: ['source', 'customer_status', 'relationship_maturity', 'customer_journey', 'contact_permission', 'next_action'],
    preferredLabels: { source: ['SRC2'], customer_status: ['C5', 'C6', 'C7'], relationship_maturity: ['G3', 'G4'], customer_journey: ['J4', 'J5'], contact_permission: ['B2', 'B5'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { source: ['SRC2'], customer_status: ['C5', 'C6', 'C7'] },
  }),
  plain_language_explanation: mapLabels({
    readsLabels: ['policy_relationship', 'service_priority', 'current_concern', 'contact_permission', 'next_action'],
    preferredLabels: { policy_relationship: ['P1', 'P2', 'P6', 'P7', 'P8', 'P9'], current_concern: ['理赔顾虑', '合同理解困难', '收益顾虑', '流动性顾虑', '缴费持续性顾虑'], next_action: ['保单整理', '核验合同事实', '续期／保全／理赔协助'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { policy_relationship: ['P1', 'P2', 'P6', 'P7', 'P8', 'P9'] },
  }),
  fact_sensitive_routing: mapLabels({
    readsLabels: ['policy_relationship', 'service_status', 'service_priority', 'current_concern', 'contact_permission', 'next_action'],
    preferredLabels: { policy_relationship: ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9'], service_priority: ['S1', 'S2', 'S3'], next_action: ['保单整理', '核验合同事实', '续期／保全／理赔协助'] },
    notTriggeredBy: { policy_relationship: ['P1', 'P2', 'P5', 'P8'] },
  }),
  general_sales_clarification: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'resistance', 'service_priority', 'contact_permission', 'current_concern', 'next_action'],
    preferredLabels: { customer_status: ['C0', 'C1', 'C2'], relationship_maturity: ['G0', 'G1'], demand_maturity: ['N0', 'N1'], purchase_intent: ['I0', 'I1'], resistance: ['K0', 'K3'], current_concern: ['顾虑尚未明确'] },
    probeLabels: { contact_permission: ['B0'], current_concern: ['顾虑尚未明确'] },
    excludedLabels: STOP_NONESSENTIAL,
  }),
});

export const SALES_CHAMPION_TRAINING_LABEL_MAPPINGS = Object.freeze({
  facilitate_family_decision: mapLabels({
    readsLabels: ['family_stage', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['家庭意见不一致', '需要共同决策人参与'] },
    preferredLabels: { demand_maturity: ['N2', 'N3', 'N4'], purchase_intent: ['I2', 'I3', 'I4'], decision_maturity: ['D4'], next_action: ['邀请共同决策人'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { family_stage: ['已婚', '育儿家庭', '多代家庭', '单亲家庭'] },
  }),
  advance_relationship_by_stage: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'resistance', 'customer_journey', 'contact_permission', 'next_action'],
    preferredLabels: { customer_status: ['C1', 'C2', 'C3'], relationship_maturity: ['G0', 'G1', 'G2'], demand_maturity: ['N0', 'N1', 'N2', 'N3'], purchase_intent: ['I0', 'I1', 'I2', 'I3'], customer_journey: ['J2', 'J3'], next_action: ['初次沟通', '需求访谈', '方案沟通'] },
    probeLabels: { contact_permission: ['B0'] },
    excludedLabels: { ...STOP_MARKETING, customer_status: ['C9'] },
  }),
  open_conversation_without_sales_pressure: mapLabels({
    readsLabels: ['source', 'customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'resistance', 'customer_journey', 'contact_permission', 'next_action'],
    preferredLabels: { customer_status: ['C0', 'C1', 'C2'], relationship_maturity: ['G0', 'G1'], demand_maturity: ['N0', 'N1'], purchase_intent: ['I0', 'I1'], resistance: ['K3', 'K4', 'K5'], customer_journey: ['J1', 'J2'], contact_permission: ['B1', 'B2', 'B5'], next_action: ['取得联系许可', '初次沟通'] },
    probeLabels: { contact_permission: ['B0'] },
    excludedLabels: { ...STOP_MARKETING, customer_status: ['C9'] },
  }),
  serve_orphan_policy_before_selling: mapLabels({
    readsLabels: ['source', 'customer_status', 'relationship_maturity', 'policy_relationship', 'service_status', 'service_priority', 'contact_permission', 'next_action'],
    preferredLabels: { source: ['SRC7', 'SRC8'], customer_status: ['C6'], relationship_maturity: ['G0', 'G1'], policy_relationship: ['P1', 'P2', 'P6', 'P8', 'P9'], service_priority: ['S1', 'S2', 'S3'], contact_permission: ['B1', 'B2', 'B5'], next_action: ['保单整理', '续期／保全／理赔协助'] },
    probeLabels: { source: ['SRC0'], policy_relationship: ['P9'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { source: ['SRC7', 'SRC8'], policy_relationship: ['P1', 'P2', 'P6', 'P8', 'P9'] },
  }),
  diagnose_problem_before_product: mapLabels({
    readsLabels: ['demand_maturity', 'purchase_intent', 'resistance', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    preferredLabels: { demand_maturity: ['N0', 'N1', 'N2', 'N3'], purchase_intent: ['I0', 'I1', 'I2', 'I3'], resistance: ['K2', 'K3', 'K4'], decision_maturity: ['D0', 'D1', 'D2', 'D3'], next_action: ['需求访谈'] },
    probeLabels: { current_concern: ['顾虑尚未明确'] },
    excludedLabels: STOP_MARKETING,
  }),
  uncover_real_objection_with_reverse_question: mapLabels({
    readsLabels: ['demand_maturity', 'purchase_intent', 'resistance', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['不信任保险', '不信任销售人员', '理赔顾虑', '合同理解困难', '收益顾虑', '流动性顾虑', '缴费持续性顾虑', '家庭意见不一致', '需要比较其他方案', '需要共同决策人参与', '暂无紧迫性', '过去存在不良经历'] },
    preferredLabels: { purchase_intent: ['I1', 'I2', 'I3', 'I4'], resistance: ['K3', 'K4', 'K5'], decision_maturity: ['D2', 'D3', 'D4'] },
    probeLabels: { current_concern: ['顾虑尚未明确'] },
    excludedLabels: STOP_MARKETING,
  }),
  follow_up_by_customer_intent: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'purchase_intent', 'decision_maturity', 'customer_journey', 'contact_permission', 'communication_preference', 'next_action'],
    preferredLabels: { customer_status: ['C1', 'C2', 'C3'], relationship_maturity: ['G1', 'G2', 'G3'], purchase_intent: ['I1', 'I2', 'I3', 'I4'], decision_maturity: ['D1', 'D2', 'D3', 'D4'], customer_journey: ['J2', 'J3'], contact_permission: ['B2', 'B5'], next_action: ['初次沟通', '确认客户决定', '定期复盘'] },
    probeLabels: { contact_permission: ['B0'] },
    excludedLabels: { ...STOP_MARKETING, customer_status: ['C9'] },
  }),
  revisit_original_goal_before_add_on: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'customer_journey', 'policy_relationship', 'contact_permission', 'current_concern', 'next_action'],
    preferredLabels: { customer_status: ['C5', 'C6'], relationship_maturity: ['G3', 'G4'], demand_maturity: ['N1', 'N2', 'N3', 'N4'], purchase_intent: ['I1', 'I2', 'I3', 'I4'], customer_journey: ['J4'], policy_relationship: ['P2', 'P5', 'P8'], contact_permission: ['B2', 'B5'], next_action: ['需求访谈', '保单整理', '准备分析摘要'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { policy_relationship: ['P1', 'P2', 'P5', 'P8'] },
  }),
  plan_regional_pipeline_activity: mapLabels({
    readsLabels: ['source', 'customer_status', 'relationship_maturity', 'purchase_intent', 'customer_journey', 'marketing_grade', 'contact_permission', 'communication_preference', 'next_action'],
    preferredLabels: { customer_status: ['C1', 'C2', 'C3'], relationship_maturity: ['G0', 'G1', 'G2'], purchase_intent: ['I0', 'I1', 'I2', 'I3'], customer_journey: ['J1', 'J2', 'J3'], marketing_grade: ['M1', 'M2', 'M3'], contact_permission: ['B2', 'B5'], next_action: ['初次沟通', '定期复盘'] },
    probeLabels: { contact_permission: ['B0'] },
    excludedLabels: { ...STOP_MARKETING, customer_status: ['C9'], marketing_grade: ['M4'] },
  }),
  interview_high_value_client_journey: mapLabels({
    readsLabels: ['family_stage', 'income_type', 'economic_capacity', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'contact_permission', 'next_action'],
    preferredLabels: { economic_capacity: ['E4', 'E5'], relationship_maturity: ['G1', 'G2', 'G3'], demand_maturity: ['N1', 'N2', 'N3'], purchase_intent: ['I1', 'I2', 'I3'], decision_maturity: ['D1', 'D2', 'D3'], contact_permission: ['B2', 'B5'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { income_type: ['固定工资', '绩效／佣金收入', '自由职业', '个体经营', '企业经营', '投资性收入', '退休收入', '多收入来源', '收入暂不稳定'], economic_capacity: ['E3', 'E4', 'E5'], contact_permission: ['B0'] },
  }),
  frame_retirement_with_future_scene: mapLabels({
    readsLabels: ['family_stage', 'income_type', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    preferredLabels: { family_stage: ['养老准备期', '退休期'], income_type: ['退休收入'], demand_maturity: ['N1', 'N2', 'N3'], purchase_intent: ['I0', 'I1', 'I2', 'I3'], decision_maturity: ['D0', 'D1', 'D2', 'D3'], next_action: ['需求访谈'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { family_stage: ['养老准备期', '退休期'], income_type: ['退休收入'] },
  }),
  compare_growth_and_protection_roles: mapLabels({
    readsLabels: ['demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['收益顾虑', '需要比较其他方案'] },
    preferredLabels: { demand_maturity: ['N2', 'N3', 'N4'], purchase_intent: ['I2', 'I3', 'I4'], decision_maturity: ['D2', 'D3'], next_action: ['方案沟通', '处理核心顾虑'] },
    excludedLabels: STOP_MARKETING,
  }),
  clarify_long_payment_commitment: mapLabels({
    readsLabels: ['economic_capacity', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['缴费持续性顾虑'] },
    preferredLabels: { demand_maturity: ['N2', 'N3', 'N4'], purchase_intent: ['I2', 'I3', 'I4'], decision_maturity: ['D2', 'D3', 'D4'], next_action: ['处理核心顾虑'] },
    probeLabels: { current_concern: ['顾虑尚未明确'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { economic_capacity: ['E1', 'E2', 'E3', 'E4', 'E5'] },
  }),
  discuss_premium_coverage_tradeoff: mapLabels({
    readsLabels: ['economic_capacity', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['缴费持续性顾虑', '需要比较其他方案'] },
    preferredLabels: { demand_maturity: ['N2', 'N3', 'N4'], purchase_intent: ['I2', 'I3', 'I4'], decision_maturity: ['D2', 'D3', 'D4'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { economic_capacity: ['E1', 'E2', 'E3', 'E4', 'E5'] },
  }),
  explain_medical_and_critical_illness_roles: mapLabels({
    readsLabels: ['policy_relationship', 'demand_maturity', 'purchase_intent', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['合同理解困难', '理赔顾虑', '需要比较其他方案'] },
    preferredLabels: { policy_relationship: ['P1', 'P2'], demand_maturity: ['N2', 'N3', 'N4'], next_action: ['核验合同事实', '方案沟通'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { policy_relationship: ['P1', 'P2'] },
  }),
  distinguish_social_and_commercial_cover: mapLabels({
    readsLabels: ['policy_relationship', 'demand_maturity', 'purchase_intent', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['合同理解困难', '理赔顾虑', '需要比较其他方案'] },
    preferredLabels: { policy_relationship: ['P0', 'P1', 'P2'], demand_maturity: ['N2', 'N3', 'N4'], next_action: ['核验合同事实', '方案沟通'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { policy_relationship: ['P0', 'P1', 'P2'] },
  }),
  explain_dividend_uncertainty_with_evidence: mapLabels({
    readsLabels: ['policy_relationship', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['收益顾虑', '合同理解困难'] },
    preferredLabels: { policy_relationship: ['P1', 'P2'], purchase_intent: ['I2', 'I3', 'I4'], decision_maturity: ['D2', 'D3'], next_action: ['核验合同事实'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { policy_relationship: ['P1', 'P2'] },
  }),
  route_solvency_objection_to_official_evidence: mapLabels({
    readsLabels: ['resistance', 'policy_relationship', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['不信任保险', '合同理解困难'] },
    preferredLabels: { resistance: ['K3', 'K4', 'K5'], next_action: ['核验合同事实'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { policy_relationship: ['P1', 'P2'] },
  }),
  pre_disclose_return_limit_before_plan: mapLabels({
    readsLabels: ['demand_maturity', 'purchase_intent', 'decision_maturity', 'current_concern', 'contact_permission', 'next_action'],
    requiredLabels: { current_concern: ['收益顾虑'] },
    preferredLabels: { demand_maturity: ['N2', 'N3', 'N4'], purchase_intent: ['I2', 'I3', 'I4'], decision_maturity: ['D2', 'D3', 'D4'], next_action: ['方案沟通', '处理核心顾虑'] },
    excludedLabels: STOP_MARKETING,
  }),
  identify_buying_signal_and_ask_next_step: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'demand_maturity', 'purchase_intent', 'decision_maturity', 'customer_journey', 'contact_permission', 'next_action'],
    requiredLabels: { purchase_intent: ['I3', 'I4', 'I5'] },
    preferredLabels: { customer_status: ['C2', 'C3'], relationship_maturity: ['G2', 'G3', 'G4'], demand_maturity: ['N4'], decision_maturity: ['D4', 'D5'], customer_journey: ['J3'], contact_permission: ['B2', 'B5'], next_action: ['确认客户决定', '投保协助'] },
    excludedLabels: STOP_MARKETING,
  }),
  discuss_health_risk_without_probability_scare: mapLabels({
    readsLabels: ['family_stage', 'demand_maturity', 'purchase_intent', 'resistance', 'current_concern', 'contact_permission', 'next_action'],
    preferredLabels: { demand_maturity: ['N1', 'N2', 'N3'], purchase_intent: ['I0', 'I1', 'I2', 'I3'], resistance: ['K2', 'K3', 'K4'], next_action: ['需求访谈'] },
    excludedLabels: STOP_MARKETING,
    notTriggeredBy: { family_stage: ['单身', '已婚', '育儿家庭', '子女教育期', '子女成年', '养老准备期', '退休期', '多代家庭', '单亲家庭', '企业主家庭'] },
  }),
  notify_verified_product_change_without_pressure: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'purchase_intent', 'decision_maturity', 'policy_relationship', 'contact_permission', 'communication_preference', 'current_concern', 'next_action'],
    preferredLabels: { policy_relationship: ['P1', 'P2', 'P5', 'P8', 'P9'], contact_permission: ['B1', 'B2', 'B5'], next_action: ['核验合同事实'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { policy_relationship: ['P1', 'P2', 'P5', 'P8', 'P9'] },
  }),
  rebuild_service_trust_before_recommendation: mapLabels({
    readsLabels: ['customer_status', 'relationship_maturity', 'resistance', 'policy_relationship', 'service_status', 'service_priority', 'contact_permission', 'current_concern', 'next_action'],
    preferredLabels: { relationship_maturity: ['G0', 'G1', 'G2'], resistance: ['K4', 'K5'], service_status: ['客户资料待补充', '顾问处理中', '保险公司处理中', '等待客户确认', '已完成待回访', '无法继续处理'], service_priority: ['S1', 'S2', 'S3'], contact_permission: ['B1', 'B2', 'B5'], current_concern: ['不信任销售人员', '过去存在不良经历'], next_action: ['续期／保全／理赔协助'] },
    excludedLabels: STOP_NONESSENTIAL,
    notTriggeredBy: { customer_status: ['C6'], policy_relationship: ['P1', 'P2', 'P5', 'P8'] },
  }),
});

const CONCERN_LABELS = Object.freeze({
  trust: Object.freeze(['不信任保险', '不信任销售人员', '过去存在不良经历']),
  claims: Object.freeze(['理赔顾虑']),
  underwriting: Object.freeze(['合同理解困难']),
  benefits: Object.freeze(['收益顾虑', '需要比较其他方案']),
  liquidity: Object.freeze(['流动性顾虑']),
  duration: Object.freeze(['缴费持续性顾虑']),
  affordability: Object.freeze(['缴费持续性顾虑']),
  family_decision: Object.freeze(['家庭意见不一致', '需要共同决策人参与']),
  product_fit: Object.freeze(['需要比较其他方案']),
});

function mergeConditionMaps(target, source) {
  for (const [dimension, labels] of Object.entries(source)) {
    target[dimension] = [...new Set([...(target[dimension] || []), ...labels])];
  }
}

export function createExternalSalesChampionTrainingLabelMapping(pack) {
  const readsLabels = new Set();
  const preferredLabels = {};
  const probeLabels = {};
  const notTriggeredBy = {};
  const specificCapabilities = (pack.capabilities || [])
    .filter((capability) => capability !== 'general_sales_clarification');
  const capabilities = specificCapabilities.length ? specificCapabilities : (pack.capabilities || []);
  for (const capability of capabilities) {
    const mapping = SALES_CHAMPION_CAPABILITY_LABEL_MAPPINGS[capability];
    if (!mapping) continue;
    mapping.readsLabels.forEach((dimension) => readsLabels.add(dimension));
    mergeConditionMaps(preferredLabels, mapping.preferredLabels);
    mergeConditionMaps(probeLabels, mapping.probeLabels);
    mergeConditionMaps(notTriggeredBy, mapping.notTriggeredBy);
  }

  const concernLabels = [...new Set((pack.concerns || []).flatMap((concern) => CONCERN_LABELS[concern] || []))];
  if (concernLabels.length) {
    readsLabels.add('current_concern');
    preferredLabels.current_concern = concernLabels;
  }
  if ((pack.concerns || []).includes('unknown')) {
    readsLabels.add('current_concern');
    probeLabels.current_concern = ['顾虑尚未明确'];
  }
  readsLabels.add('contact_permission');
  const isServiceOnly = ['service_first', 'rebuild_trust', 'route_verified_evidence', 'explain_verified_facts']
    .includes(pack.actionSignature);

  return mapLabels({
    readsLabels: [...readsLabels],
    preferredLabels,
    probeLabels,
    excludedLabels: isServiceOnly ? STOP_NONESSENTIAL : STOP_MARKETING,
    notTriggeredBy,
  });
}
