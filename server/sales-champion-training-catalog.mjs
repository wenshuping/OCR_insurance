import {
  SALES_CHAMPION_CAPABILITY_KEYS,
  SALES_CHAMPION_SITUATION_KEYS,
} from './sales-champion-turn.contract.mjs';
import {
  createSalesChampionSkillBoundary,
  validateSalesChampionActionSignature,
  validateSalesChampionSkillBoundary,
} from './sales-champion-skill-boundary.mjs';
import {
  SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS,
  SALES_CHAMPION_EXTERNAL_SOURCES,
} from './sales-champion-external-skill-mappings.mjs';
import { validateSalesChampionCustomerLabelApplicability } from './sales-champion-customer-labels.mjs';
import {
  SALES_CHAMPION_TRAINING_LABEL_MAPPINGS,
  createExternalSalesChampionTrainingLabelMapping,
} from './sales-champion-customer-label-mappings.mjs';

const YANLI_SOURCE = 'yanli-whole-life-sales-2026-07';
const YULEILEI_SOURCE = 'yuleilei-high-client-sales-2026-07';
const CHENG_JIYE_SOURCE = 'cheng-jiye-practical-sales-2026-07';
const MAX_PACKS = 7;
const MAX_BOUNDARY_CANDIDATES = 4;
const BASE_REQUIRED_INPUTS = Object.freeze(['customer_statements', 'stage', 'concerns']);
const DEFAULT_ANTI_TRIGGERS = Object.freeze(['explicit_refusal', 'stop_contact']);
const VALID_STAGES = new Set(['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale']);
const VALID_CONCERNS = new Set([
  'liquidity', 'duration', 'family_decision', 'trust', 'affordability', 'product_fit',
  'insurer_safety', 'benefits', 'claims', 'underwriting', 'surrender', 'rebate',
  'risk_pooling', 'follow_up', 'unknown',
]);
const VALID_CAPABILITIES = new Set(SALES_CHAMPION_CAPABILITY_KEYS);
const VALID_SITUATIONS = new Set(SALES_CHAMPION_SITUATION_KEYS);

export const SALES_CHAMPION_TRAINING_SOURCES = Object.freeze([
  Object.freeze({ id: YANLI_SOURCE, version: 1, status: 'disabled' }),
  Object.freeze({ id: YULEILEI_SOURCE, version: 1, status: 'disabled' }),
  Object.freeze({ id: CHENG_JIYE_SOURCE, version: 1, status: 'active' }),
  ...SALES_CHAMPION_EXTERNAL_SOURCES,
]);

const RAW_PACKS = Object.freeze({
  discover_goal_with_golden_circle: { capabilities: ['needs_discovery'], stages: ['discovery'], concerns: ['unknown', 'product_fit'], allowedUse: 'goal_questions', officialFactsRequired: false },
  surface_need_with_three_step: { capabilities: ['five_question_diagnosis'], stages: ['discovery', 'objection'], concerns: ['unknown', 'product_fit'], allowedUse: 'question_sequence', officialFactsRequired: false },
  frame_risk_without_fear: { capabilities: ['five_question_diagnosis'], stages: ['discovery', 'objection'], concerns: ['trust', 'product_fit'], allowedUse: 'risk_discussion', officialFactsRequired: false },
  awaken_scenario_need: { capabilities: ['needs_discovery'], stages: ['contact', 'discovery'], concerns: ['unknown', 'product_fit'], allowedUse: 'scenario_questions', officialFactsRequired: false },
  diagnose_retirement_goal: { capabilities: ['needs_discovery'], stages: ['discovery'], concerns: ['product_fit'], allowedUse: 'retirement_questions', officialFactsRequired: false },
  diagnose_education_goal: { capabilities: ['needs_discovery'], stages: ['discovery'], concerns: ['product_fit'], allowedUse: 'education_questions', officialFactsRequired: false },
  facilitate_family_decision: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['family_joint_decision', 'cooling_off_support'],
    stages: ['discovery', 'proposal', 'objection', 'decision'],
    concerns: ['family_decision'],
    allowedUse: 'joint_decision',
    officialFactsRequired: false,
    priority: 94,
    evidenceRefs: [
      'douyin:cheng-jiye:7602564999688588584',
      'douyin:cheng-jiye:7606251354046106895',
    ],
    promptRules: [
      '客户说要和家人商量时，把它当作共同决策需要，不当作假拒绝；先确认家人最担心什么。',
      '建议邀请相关家人一起听清目标、预算、期限和限制，买不买由家庭决定；不要让客户和顾问联手去“说服”家人。',
      '如果家人反对导致犹豫期退保，先保证退保选择畅通，再征得同意安排一次说明。',
    ],
  },
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
  advance_relationship_by_stage: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery'],
    stages: ['contact', 'appointment', 'discovery'],
    concerns: ['unknown', 'product_fit', 'follow_up'],
    allowedUse: 'stage_progression',
    officialFactsRequired: false,
    priority: 90,
    evidenceRefs: [
      'douyin:cheng-jiye:7617439313277553955',
      'douyin:cheng-jiye:7630848003833711872',
    ],
    promptRules: [
      '按四步推进：先让客户愿意聊，再围绕他的目标形成共识，然后才谈匹配方向；只有客户出现明确购买信号时才进入下一步。',
      '信息不完整时也先判断“眼下只推进哪一小步”，给一个今天就能做的动作和一段可直接说的话，再补问最多两项。',
      '说人话，像一线业务员复盘客户；不要使用“顾问本轮提供、客户理解、当前阶段、优先确认、结构化信息”等报告腔。',
      '话术要给客户退路，不用最后通牒、恐吓、亲情施压或虚假紧迫感。',
    ],
  },
  open_conversation_without_sales_pressure: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['appointment_scope', 'needs_discovery'],
    stages: ['contact', 'appointment'],
    concerns: ['trust', 'unknown', 'follow_up'],
    situations: ['first_insurance_conversation'],
    allowedUse: 'pressure_free_opening',
    officialFactsRequired: false,
    priority: 96,
    evidenceRefs: [
      'douyin:cheng-jiye:7599940316023491855',
      'douyin:cheng-jiye:7617439313277553955',
    ],
    promptRules: [
      '先替客户减压，再谈保险：明确买不买、何时买、找谁买都由客户决定，本次只想先听听他的想法。',
      '开场只争取几分钟交流，不索要完整资料；优先问“您以前怎么看保险”或“您眼下最想解决哪件事”。',
      '必须给顾问一段能直接开口的话，语气像熟人聊天，不写成培训讲义或客户分析报告。',
    ],
  },
  serve_orphan_policy_before_selling: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['appointment_scope', 'needs_discovery', 'follow_up_consent'],
    stages: ['post_sale'],
    concerns: ['trust', 'follow_up', 'unknown'],
    situations: ['orphan_policy'],
    allowedUse: 'orphan_policy_first_meeting',
    officialFactsRequired: false,
    priority: 98,
    evidenceRefs: ['douyin:cheng-jiye:7618134389175651619'],
    promptRules: [
      '孤儿单或接手老客户第一次见面以服务和建立信任为目标，不假借保单检视挖缺口，也不急着成交。',
      '先问当初为什么买、客户对这份安排是否满意；不满意先安抚和处理服务感受，满意先肯定当年的决定。',
      '本次只推进下一次愿意沟通的机会；涉及原合同责任、现金价值或新旧产品差异时必须先核验官方证据。',
    ],
  },
  diagnose_problem_before_product: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'five_question_diagnosis'],
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['unknown', 'product_fit', 'benefits', 'affordability'],
    allowedUse: 'problem_first_discovery',
    officialFactsRequired: false,
    priority: 85,
    evidenceRefs: [
      'douyin:cheng-jiye:7621478600243432739',
      'douyin:cheng-jiye:7630847723284991247',
    ],
    promptRules: [
      '先找客户真正想解决的问题，再谈工具；不要从产品卖点倒推客户一定有某个痛点。',
      '客户说“不需要、买多了、收益低”时，可先问“不这样安排的话，这笔钱或这个风险您准备怎么处理”，听完再追问目标和顾虑。',
      '不得替客户制造恐惧或断言未来必然发生风险；客户目标尚未说清时，先给一个提问动作，不硬推方案。',
    ],
  },
  uncover_real_objection_with_reverse_question: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['five_question_diagnosis', 'tradeoff_disclosure', 'cooling_off_support'],
    stages: ['objection', 'decision'],
    concerns: ['trust', 'affordability', 'duration', 'liquidity', 'benefits', 'product_fit', 'family_decision'],
    allowedUse: 'real_objection_diagnosis',
    officialFactsRequired: false,
    priority: 35,
    evidenceRefs: [
      'douyin:cheng-jiye:7630847290445450511',
      'douyin:cheng-jiye:7606251354046106895',
    ],
    promptRules: [
      '先接住拒绝并明确不合作也没关系，再用一个反问了解真实原因，不要立刻解释或反驳。',
      '可问“除了这点，还有没有别的顾虑”来判断是否为主要原因；原因没问清前不进入异议话术。',
      '犹豫期退保必须尊重客户法定选择，不阻挠退保；可以复盘原因，但不得用人情、损失或家人施压。',
    ],
  },
  follow_up_by_customer_intent: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['follow_up_consent', 'appointment_scope'],
    stages: ['appointment', 'objection', 'decision'],
    concerns: ['follow_up', 'trust'],
    situations: ['event_follow_up'],
    allowedUse: 'intent_based_follow_up',
    officialFactsRequired: false,
    priority: 95,
    evidenceRefs: ['douyin:cheng-jiye:7602566236332903720'],
    promptRules: [
      '先区分客户是有意向待考虑，还是现场就明显抗拒；前者可在约定时间提供专业帮助，后者先只做轻量关心。',
      '客户未回复时不要连环追问；隔一段时间发一次收口信息，明确“不考虑也没关系，回复我即可，我就不再打扰”。',
      '客户一旦明确拒绝或要求停止联系，立即停止促成；任何停售或时限信息只有核验为真时才可告知。',
    ],
  },
  revisit_original_goal_before_add_on: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'plain_language_explanation'],
    stages: ['proposal', 'objection', 'post_sale'],
    concerns: ['benefits', 'product_fit', 'unknown'],
    situations: ['existing_customer_add_on'],
    allowedUse: 'existing_customer_value_review',
    officialFactsRequired: false,
    priority: 88,
    evidenceRefs: ['douyin:cheng-jiye:7606250600417725748'],
    promptRules: [
      '老客户说“已经买很多”时，先回到当初购买的目标、现在是否仍有这个目标，以及近几年情况是否变化，不直接要求加保。',
      '只能复述客户确认过的原始目标；原保单能解决什么、新方案是否补充必须以保险专家核验后的合同事实为准。',
      '如果现有安排已经满足客户目标，就明确可以不追加；把复盘结果和下一步说清楚即可。',
    ],
  },
  plan_regional_pipeline_activity: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['appointment_scope', 'follow_up_consent'],
    stages: ['contact', 'appointment'],
    concerns: ['follow_up', 'unknown'],
    situations: ['regional_pipeline'],
    allowedUse: 'regional_pipeline_planning',
    officialFactsRequired: false,
    priority: 86,
    evidenceRefs: [
      'douyin:cheng-jiye:7650139581693562150',
      'douyin:cheng-jiye:7602565452023336227',
    ],
    promptRules: [
      '客户经营不要只盯一两个对象：按联系意愿、销售阶段和区域维护一批可持续跟进的客户。',
      '已有一个约访后，优先查看同区域且允许联系的客户，集中安排，减少通勤和临时群发。',
      '信息不完整时先给今天的动作：整理三个客户标签、挑一个区域、发一条低压力约访；再问最多两项用于细化计划。',
    ],
  },
  interview_high_value_client_journey: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'five_question_diagnosis'],
    stages: ['discovery'],
    concerns: ['trust', 'product_fit', 'unknown'],
    situations: ['high_value_client'],
    allowedUse: 'high_value_client_interview',
    officialFactsRequired: false,
    priority: 92,
    evidenceRefs: ['douyin:cheng-jiye:7621477443878128911'],
    promptRules: [
      '面对企业主或高净值客户，先聊创业、财富起伏和未来最不想失去什么，不要一开口就讲收益、传承或免税。',
      '从客户亲口讲出的经历中确认他想守住的生活、家庭或事业底线，再判断是否需要保险工具。',
      '不得套用名人故事替客户下结论，也不得把资产规模等同于购买能力或购买意愿。',
    ],
  },
  frame_retirement_with_future_scene: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'five_question_diagnosis'],
    stages: ['discovery', 'proposal'],
    concerns: ['benefits', 'product_fit', 'unknown'],
    situations: ['retirement_planning'],
    allowedUse: 'retirement_scene_discovery',
    officialFactsRequired: false,
    priority: 91,
    evidenceRefs: ['douyin:cheng-jiye:7606253227700423988'],
    promptRules: [
      '客户觉得养老还早时，不争论年龄；先问希望何时有选择地退休、退休后哪些开支要持续、这笔钱希望由谁负责准备。',
      '先把“什么时候需要、每年是否持续、需要多久”三个目标说清，再讨论可选工具。',
      '不得断言社保一定不够，也不得在客户目标和现金流未知时直接推荐年金险。',
    ],
  },
  compare_growth_and_protection_roles: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['tradeoff_disclosure', 'plain_language_explanation'],
    stages: ['proposal', 'objection'],
    concerns: ['benefits', 'risk_pooling', 'product_fit'],
    situations: ['investment_comparison'],
    allowedUse: 'growth_protection_comparison',
    officialFactsRequired: false,
    priority: 90,
    evidenceRefs: ['douyin:cheng-jiye:7606252309579926836'],
    promptRules: [
      '客户拿保险和股票、黄金等比较时，先说明它们解决的问题不同：一类追求增长，一类管理约定风险，不做简单收益高低排名。',
      '先问客户这笔钱的用途、可承受波动和不能接受的结果，再讨论是否需要分开安排。',
      '不得保证保险绝对安全或投资必然亏损，不引用未经核验的市场亏损概率。',
    ],
  },
  clarify_long_payment_commitment: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['tradeoff_disclosure', 'five_question_diagnosis', 'family_joint_decision'],
    stages: ['proposal', 'objection'],
    concerns: ['duration', 'affordability', 'family_decision'],
    situations: ['long_payment_commitment'],
    allowedUse: 'long_payment_commitment',
    officialFactsRequired: true,
    priority: 97,
    evidenceRefs: ['douyin:cheng-jiye:7602564999688588584'],
    promptRules: [
      '客户担心十年等长期缴费时，先承认机会成本、收入波动和家庭共同决策都是真问题，不用“坚持就好”压过去。',
      '先核验缴费期限、中途调整、退保和现金价值，再和客户一起压力测试可持续预算；不合适就缩小或退出方案。',
      '客户要和家人商量时主动邀请共同沟通，不能把家庭讨论当成成交障碍。',
    ],
  },
  discuss_premium_coverage_tradeoff: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['tradeoff_disclosure', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'],
    concerns: ['affordability', 'benefits', 'claims'],
    situations: ['premium_coverage_tradeoff'],
    allowedUse: 'premium_coverage_tradeoff',
    officialFactsRequired: true,
    priority: 96,
    evidenceRefs: [
      'douyin:cheng-jiye:7617438206841113891',
      'douyin:cheng-jiye:7602565208074194228',
    ],
    promptRules: [
      '客户说保费贵或保费倒挂时，先核验保额、缴费总额、保险期间、轻中重症责任和豁免条件，再讨论客户承担风险的替代方案。',
      '把问题落到“每年可持续支出”和“发生风险时可承受损失”，不只比较累计保费与名义保额。',
      '不得泛化宣称轻症、中症、多次赔付或保费豁免；具体责任只能引用保险专家已核验证据。',
    ],
  },
  explain_medical_and_critical_illness_roles: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['plain_language_explanation', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['product_fit', 'claims'],
    situations: ['medical_critical_illness_overlap'],
    allowedUse: 'medical_critical_illness_roles',
    officialFactsRequired: true,
    priority: 98,
    evidenceRefs: [
      'douyin:cheng-jiye:7617373581026053376',
      'douyin:cheng-jiye:7650138002068426038',
    ],
    promptRules: [
      '客户已有医疗险时，先核验现有产品的报销范围、免赔额、续保条件和终止条件，再确认客户还担心治疗费之外的哪些收入或生活影响。',
      '用“费用报销”和“达到合同约定条件后的给付”解释功能差异，但不得据此断言客户两类产品都必须买。',
      '续保年限、确诊给付、多次赔付和终身保障都属于具体合同事实，必须由保险专家核验。',
    ],
  },
  distinguish_social_and_commercial_cover: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['plain_language_explanation', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal'],
    concerns: ['claims', 'product_fit'],
    situations: ['social_commercial_overlap'],
    allowedUse: 'social_commercial_cover_roles',
    officialFactsRequired: true,
    priority: 89,
    evidenceRefs: ['douyin:cheng-jiye:7650138333355576630'],
    promptRules: [
      '客户说已有社保时，先肯定基础保障，再核验当地医保政策和客户现有商业保障，不用“社保只管一半”等固定数字制造缺口。',
      '围绕客户实际担心的自付费用、收入中断和长期照护逐项确认，已有保障能解决的部分要明确说清。',
      '报销比例、起付线、封顶线和药品范围具有地区与时间差异，必须使用可核验证据。',
    ],
  },
  explain_dividend_uncertainty_with_evidence: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['plain_language_explanation', 'fact_sensitive_routing', 'tradeoff_disclosure'],
    stages: ['proposal', 'objection'],
    concerns: ['benefits', 'insurer_safety'],
    situations: ['dividend_uncertainty'],
    allowedUse: 'dividend_uncertainty_explanation',
    officialFactsRequired: true,
    priority: 99,
    evidenceRefs: [
      'douyin:cheng-jiye:7606251980457069876',
      'douyin:cheng-jiye:7650139155640421641',
    ],
    promptRules: [
      '解释分红险时严格分开保证利益与非保证利益：先引用合同中的保证部分，再说明分红可能为零或低于演示。',
      '分红机制、可分配盈余比例、实现率和演示数字只能引用保险专家核验过的合同、监管或公司官方材料。',
      '不得把“机制确定”说成“收益确定”，不得承诺未来经济好转就一定多分红。',
    ],
  },
  route_solvency_objection_to_official_evidence: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['reputation_objection', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'],
    concerns: ['insurer_safety'],
    situations: ['solvency_concern'],
    allowedUse: 'solvency_evidence_review',
    officialFactsRequired: true,
    priority: 100,
    evidenceRefs: ['douyin:cheng-jiye:7618133950833118464'],
    promptRules: [
      '客户担心偿付能力时，不替公司辩护；先核验最新综合偿付能力、核心偿付能力、风险评级和监管披露时间。',
      '把当前指标、历史变化和产品合同责任分开说明，指标低不能自动推出产品会出问题，指标高也不能承诺绝对安全。',
      '不得推测公司未来一定改善，也不得用国资接管、监管兜底等未经核验案例保证结果。',
    ],
  },
  pre_disclose_return_limit_before_plan: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['tradeoff_disclosure', 'plain_language_explanation'],
    stages: ['proposal', 'objection'],
    concerns: ['benefits'],
    situations: ['return_expectation'],
    allowedUse: 'return_limit_disclosure',
    officialFactsRequired: true,
    priority: 95,
    evidenceRefs: ['douyin:cheng-jiye:7616349797116693795'],
    promptRules: [
      '客户关注收益时，顾问应主动说明保险通常不是追求最高短期收益的工具，再回到客户为何考虑这项安排。',
      '展示计划前先核验保证与非保证利益、期限、现金价值和退出影响，避免客户看到数字后才发现限制。',
      '不得用“确定性对抗不确定性”替代风险披露，也不得把演示利益当成实际回报。',
    ],
  },
  identify_buying_signal_and_ask_next_step: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['appointment_scope', 'follow_up_consent'],
    stages: ['decision'],
    concerns: ['product_fit', 'unknown', 'follow_up'],
    situations: ['buying_signal'],
    allowedUse: 'buying_signal_next_step',
    officialFactsRequired: false,
    priority: 93,
    evidenceRefs: ['douyin:cheng-jiye:7630848003833711872'],
    promptRules: [
      '客户主动问办理方式、下一步或具体准备材料时，先复述他的目标和仍待确认的限制，再直接询问是否愿意进入下一步。',
      '把微笑、点头等弱信号只当作继续确认的机会，不能单凭肢体反应认定客户同意购买。',
      '下一步可以是补一项资料、核验一项事实或约定第二次沟通，不把“及时促成”理解成催签。',
    ],
  },
  discuss_health_risk_without_probability_scare: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'five_question_diagnosis'],
    stages: ['discovery'],
    concerns: ['claims', 'risk_pooling', 'unknown'],
    situations: ['health_risk_conversation'],
    allowedUse: 'health_risk_discovery',
    officialFactsRequired: false,
    priority: 90,
    evidenceRefs: ['douyin:cheng-jiye:7599939578371411200'],
    promptRules: [
      '聊健康风险时，不背诵患病概率，也不让客户回忆亲友死亡；改问“如果需要停工治疗，您最担心哪部分影响”。',
      '从医疗支出、收入中断、照护责任中让客户自己选最在意的一项，再判断是否需要核验保障缺口。',
      '客户不愿谈健康或家庭经历时立即换题，不用死亡、疾病高发或年龄焦虑施压。',
    ],
  },
  notify_verified_product_change_without_pressure: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['follow_up_consent', 'fact_sensitive_routing'],
    stages: ['appointment', 'decision'],
    concerns: ['follow_up', 'benefits'],
    situations: ['verified_product_change'],
    allowedUse: 'verified_product_change_notice',
    officialFactsRequired: true,
    priority: 94,
    evidenceRefs: ['douyin:cheng-jiye:7621475738419612962'],
    promptRules: [
      '只有拿到正式停售、调整或生效日期证据后才能通知客户；通知只说事实、可能影响和核验来源。',
      '明确告诉客户“不考虑也没关系”，给出是否需要了解的选择，不用失眠、纠结、最后机会等悬念诱导见面。',
      '不得用宏观经济、国家政策或长期损失测算制造虚假紧迫感。',
    ],
  },
  rebuild_service_trust_before_recommendation: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['reputation_objection', 'needs_discovery'],
    stages: ['contact', 'appointment', 'post_sale'],
    concerns: ['trust'],
    situations: ['service_trust_recovery'],
    allowedUse: 'service_trust_recovery',
    officialFactsRequired: false,
    priority: 94,
    evidenceRefs: ['douyin:cheng-jiye:7618134389175651619'],
    promptRules: [
      '客户曾被失联服务、强推或不愉快体验伤害时，先承认体验和解决服务问题，不急着证明行业或公司没错。',
      '先问客户希望这次服务做到什么，并用一次小而具体的兑现建立信任，再争取下一次沟通。',
      '不得把道歉当成成交铺垫；服务问题没有解决前不推荐新产品。',
    ],
  },
});

function definePackBoundary(actionSignature, boundary) {
  validateSalesChampionActionSignature(actionSignature);
  return Object.freeze({
    actionSignature,
    boundary: createSalesChampionSkillBoundary(boundary),
  });
}

const ACTIVE_PACK_BOUNDARIES = Object.freeze({
  facilitate_family_decision: definePackBoundary('facilitate_decision', {
    groups: ['decision_and_consent'],
    probeSlots: ['decision_participants', 'objection_reason'],
    requiredSlots: ['decision_participants'],
    helpfulSlots: ['customer_decision'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  advance_relationship_by_stage: definePackBoundary('advance_next_step', {
    groups: ['sales_stage', 'conversation_progress'],
    probeSlots: ['explicit_customer_request', 'conversation_end_state'],
    helpfulSlots: ['customer_goal', 'contact_preference'],
  }),
  open_conversation_without_sales_pressure: definePackBoundary('scope_conversation', {
    groups: ['customer_relationship', 'meeting_intent'],
    confirmedSituations: ['first_insurance_conversation'],
    probeSlots: ['meeting_trigger', 'explicit_customer_request'],
    helpfulSlots: ['customer_relationship_origin', 'customer_goal'],
  }),
  serve_orphan_policy_before_selling: definePackBoundary('service_first', {
    groups: ['customer_relationship', 'meeting_intent'],
    confirmedSituations: ['orphan_policy'],
    probeSlots: ['customer_relationship_origin', 'current_service_task'],
    requiredSlots: ['customer_relationship_origin'],
    helpfulSlots: ['explicit_customer_request', 'conversation_end_state'],
    unknownFallback: 'generic_service_first',
  }),
  diagnose_problem_before_product: definePackBoundary('discover_need', {
    groups: ['customer_goal'],
    probeSlots: ['customer_goal', 'customer_problem'],
    helpfulSlots: ['explicit_customer_request', 'goal_source'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  uncover_real_objection_with_reverse_question: definePackBoundary('diagnose_objection', {
    groups: ['objection', 'decision_and_consent'],
    probeSlots: ['objection_reason'],
    requiredSlots: ['objection_reason'],
    helpfulSlots: ['customer_goal', 'customer_decision'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  follow_up_by_customer_intent: definePackBoundary('obtain_consent', {
    groups: ['conversation_progress', 'decision_and_consent'],
    confirmedSituations: ['event_follow_up'],
    probeSlots: ['contact_preference', 'conversation_end_state'],
    helpfulSlots: ['explicit_customer_request'],
  }),
  revisit_original_goal_before_add_on: definePackBoundary('discover_need', {
    groups: ['customer_goal', 'insurance_evidence'],
    confirmedSituations: ['existing_customer_add_on'],
    probeSlots: ['existing_arrangement_goal'],
    requiredSlots: ['existing_arrangement_goal'],
    helpfulSlots: ['customer_goal', 'existing_policy_evidence'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  plan_regional_pipeline_activity: definePackBoundary('advance_next_step', {
    groups: ['customer_relationship', 'conversation_progress'],
    confirmedSituations: ['regional_pipeline'],
    probeSlots: ['customer_relationship_origin', 'contact_preference'],
    helpfulSlots: ['conversation_end_state'],
  }),
  interview_high_value_client_journey: definePackBoundary('discover_need', {
    groups: ['customer_goal'],
    confirmedSituations: ['high_value_client'],
    probeSlots: ['customer_goal', 'goal_source'],
    helpfulSlots: ['customer_problem'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  frame_retirement_with_future_scene: definePackBoundary('discover_need', {
    groups: ['customer_goal'],
    confirmedSituations: ['retirement_planning'],
    probeSlots: ['customer_goal', 'goal_source'],
    helpfulSlots: ['future_fund_use', 'fund_use_timeline'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  compare_growth_and_protection_roles: definePackBoundary('explain_tradeoff', {
    groups: ['customer_goal', 'objection'],
    confirmedSituations: ['investment_comparison'],
    probeSlots: ['customer_goal', 'objection_reason'],
    helpfulSlots: ['future_fund_use', 'fund_use_timeline'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  clarify_long_payment_commitment: definePackBoundary('explain_tradeoff', {
    groups: ['objection', 'decision_and_consent', 'insurance_evidence'],
    confirmedSituations: ['long_payment_commitment'],
    probeSlots: ['objection_reason'],
    requiredSlots: ['objection_reason'],
    helpfulSlots: ['fund_use_timeline', 'sustainable_budget', 'decision_participants'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  discuss_premium_coverage_tradeoff: definePackBoundary('explain_tradeoff', {
    groups: ['customer_goal', 'objection', 'insurance_evidence'],
    confirmedSituations: ['premium_coverage_tradeoff'],
    probeSlots: ['customer_goal', 'sustainable_budget'],
    helpfulSlots: ['existing_policy_evidence'],
    unknownFallback: 'defer_fact_until_verified',
  }),
  explain_medical_and_critical_illness_roles: definePackBoundary('explain_verified_facts', {
    groups: ['customer_goal', 'insurance_evidence'],
    confirmedSituations: ['medical_critical_illness_overlap'],
    probeSlots: ['existing_policy_evidence', 'product_identity'],
    requiredSlots: ['existing_policy_evidence'],
    helpfulSlots: ['customer_goal'],
    unknownFallback: 'defer_fact_until_verified',
  }),
  distinguish_social_and_commercial_cover: definePackBoundary('explain_verified_facts', {
    groups: ['customer_goal', 'insurance_evidence'],
    confirmedSituations: ['social_commercial_overlap'],
    probeSlots: ['existing_policy_evidence'],
    requiredSlots: ['existing_policy_evidence'],
    helpfulSlots: ['customer_goal'],
    unknownFallback: 'defer_fact_until_verified',
  }),
  explain_dividend_uncertainty_with_evidence: definePackBoundary('explain_verified_facts', {
    groups: ['objection', 'insurance_evidence'],
    confirmedSituations: ['dividend_uncertainty'],
    probeSlots: ['product_identity', 'objection_reason'],
    requiredSlots: ['product_identity'],
    helpfulSlots: ['objection_reason'],
    unknownFallback: 'defer_fact_until_verified',
  }),
  route_solvency_objection_to_official_evidence: definePackBoundary('route_verified_evidence', {
    groups: ['objection', 'insurance_evidence'],
    confirmedSituations: ['solvency_concern'],
    probeSlots: ['insurer_identity', 'objection_reason'],
    requiredSlots: ['insurer_identity'],
    helpfulSlots: ['objection_reason'],
    unknownFallback: 'defer_fact_until_verified',
  }),
  pre_disclose_return_limit_before_plan: definePackBoundary('explain_tradeoff', {
    groups: ['customer_goal', 'objection', 'insurance_evidence'],
    confirmedSituations: ['return_expectation'],
    probeSlots: ['customer_goal', 'product_identity'],
    helpfulSlots: ['objection_reason', 'future_fund_use'],
    unknownFallback: 'defer_fact_until_verified',
  }),
  identify_buying_signal_and_ask_next_step: definePackBoundary('advance_next_step', {
    groups: ['conversation_progress', 'decision_and_consent'],
    confirmedSituations: ['buying_signal'],
    probeSlots: ['conversation_end_state', 'customer_decision'],
    helpfulSlots: ['contact_preference'],
  }),
  discuss_health_risk_without_probability_scare: definePackBoundary('discover_need', {
    groups: ['customer_goal'],
    confirmedSituations: ['health_risk_conversation'],
    probeSlots: ['customer_goal', 'customer_problem'],
    helpfulSlots: ['goal_source'],
    unknownFallback: 'acknowledge_and_discover',
  }),
  notify_verified_product_change_without_pressure: definePackBoundary('route_verified_evidence', {
    groups: ['conversation_progress', 'insurance_evidence'],
    confirmedSituations: ['verified_product_change'],
    probeSlots: ['product_change_evidence', 'product_identity'],
    requiredSlots: ['product_change_evidence'],
    helpfulSlots: ['contact_preference', 'product_identity'],
    unknownFallback: 'defer_fact_until_verified',
  }),
  rebuild_service_trust_before_recommendation: definePackBoundary('rebuild_trust', {
    groups: ['customer_relationship', 'meeting_intent'],
    confirmedSituations: ['service_trust_recovery'],
    probeSlots: ['service_issue', 'explicit_customer_request'],
    requiredSlots: ['service_issue'],
    helpfulSlots: ['customer_relationship_origin'],
    unknownFallback: 'generic_service_first',
  }),
});

function materializePack(key, pack, order) {
  const officialFactsRequired = pack.officialFactsRequired === true;
  const boundaryDefinition = ACTIVE_PACK_BOUNDARIES[key] || null;
  const labelApplicability = SALES_CHAMPION_TRAINING_LABEL_MAPPINGS[key]
    || (pack.sourceSkill ? createExternalSalesChampionTrainingLabelMapping(pack) : null);
  return Object.freeze({
    key,
    version: 1,
    source: pack.source ?? YANLI_SOURCE,
    sourceSkill: pack.sourceSkill || '',
    capabilities: Object.freeze([...pack.capabilities]),
    stages: Object.freeze([...pack.stages]),
    concerns: Object.freeze([...pack.concerns]),
    situations: Object.freeze([...(pack.situations || [])]),
    requiredInputs: Object.freeze([
      ...BASE_REQUIRED_INPUTS,
      ...(officialFactsRequired ? ['official_evidence'] : []),
    ]),
    antiTriggers: DEFAULT_ANTI_TRIGGERS,
    outputContract: pack.allowedUse,
    allowedUse: pack.allowedUse,
    officialFactsRequired,
    priority: Number.isInteger(pack.priority) ? pack.priority : 50,
    evidenceRefs: Object.freeze([...(pack.evidenceRefs || [])]),
    promptRules: Object.freeze([...(pack.promptRules || [])]),
    actionSignature: boundaryDefinition?.actionSignature || pack.actionSignature || '',
    boundary: boundaryDefinition?.boundary || pack.boundary || null,
    labelApplicability,
    order,
  });
}

export const SALES_CHAMPION_TRAINING_PACKS = Object.freeze(
  [
    ...Object.entries(RAW_PACKS),
    ...SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS.map((pack) => [pack.key, pack]),
  ].map(([key, pack], order) => materializePack(key, pack, order)),
);

function assertStringArray(values, path, { allowEmpty = false } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && !values.length) || values.some((value) => typeof value !== 'string' || !value)) {
    throw new TypeError(`${path} must be ${allowEmpty ? 'an' : 'a non-empty'} string array`);
  }
}

export function validateSalesChampionTrainingCatalog({
  sources = SALES_CHAMPION_TRAINING_SOURCES,
  packs = SALES_CHAMPION_TRAINING_PACKS,
} = {}) {
  if (!Array.isArray(sources) || !Array.isArray(packs)) throw new TypeError('sources and packs must be arrays');
  const sourceIds = new Set();
  const sourceStatuses = new Map();
  for (const source of sources) {
    if (!source?.id || sourceIds.has(source.id)) throw new TypeError(`duplicate or missing source: ${source?.id || ''}`);
    if (!Number.isInteger(source.version) || source.version < 1) throw new TypeError(`invalid source version: ${source.id}`);
    if (!['active', 'disabled'].includes(source.status)) throw new TypeError(`invalid source status: ${source.id}`);
    sourceIds.add(source.id);
    sourceStatuses.set(source.id, source.status);
  }

  const packKeys = new Set();
  for (const pack of packs) {
    if (!pack?.key || !/^[a-z][a-z0-9_]*$/u.test(pack.key) || packKeys.has(pack.key)) {
      throw new TypeError(`duplicate or invalid training pack key: ${pack?.key || ''}`);
    }
    packKeys.add(pack.key);
    if (!sourceIds.has(pack.source)) throw new TypeError(`unknown source for training pack: ${pack.key}`);
    if (pack.sourceSkill && (typeof pack.sourceSkill !== 'string' || !pack.sourceSkill)) {
      throw new TypeError(`invalid source skill: ${pack.key}`);
    }
    if (!Number.isInteger(pack.version) || pack.version < 1) throw new TypeError(`invalid training pack version: ${pack.key}`);
    assertStringArray(pack.capabilities, `${pack.key}.capabilities`);
    assertStringArray(pack.stages, `${pack.key}.stages`, { allowEmpty: true });
    assertStringArray(pack.concerns, `${pack.key}.concerns`, { allowEmpty: true });
    assertStringArray(pack.situations || [], `${pack.key}.situations`, { allowEmpty: true });
    assertStringArray(pack.requiredInputs, `${pack.key}.requiredInputs`);
    assertStringArray(pack.antiTriggers, `${pack.key}.antiTriggers`);
    assertStringArray(pack.evidenceRefs || [], `${pack.key}.evidenceRefs`, { allowEmpty: true });
    assertStringArray(pack.promptRules || [], `${pack.key}.promptRules`, { allowEmpty: true });
    if (pack.capabilities.some((value) => !VALID_CAPABILITIES.has(value))) throw new TypeError(`invalid capability: ${pack.key}`);
    if (pack.stages.some((value) => !VALID_STAGES.has(value))) throw new TypeError(`invalid stage: ${pack.key}`);
    if (pack.concerns.some((value) => !VALID_CONCERNS.has(value))) throw new TypeError(`invalid concern: ${pack.key}`);
    if (pack.situations.some((value) => !VALID_SITUATIONS.has(value))) throw new TypeError(`invalid situation: ${pack.key}`);
    if (!pack.outputContract || !pack.allowedUse) throw new TypeError(`incomplete output contract: ${pack.key}`);
    if (typeof pack.officialFactsRequired !== 'boolean') throw new TypeError(`invalid evidence flag: ${pack.key}`);
    if (!Number.isInteger(pack.priority) || pack.priority < 0 || pack.priority > 100) throw new TypeError(`invalid priority: ${pack.key}`);
    if (sourceStatuses.get(pack.source) === 'active') {
      validateSalesChampionActionSignature(pack.actionSignature, `${pack.key}.actionSignature`);
      validateSalesChampionSkillBoundary(pack.boundary, `${pack.key}.boundary`);
      validateSalesChampionCustomerLabelApplicability(pack.labelApplicability, `${pack.key}.labelApplicability`);
      if (pack.boundary.confirmedSituations.some((value) => !VALID_SITUATIONS.has(value))) {
        throw new TypeError(`invalid confirmed situation: ${pack.key}`);
      }
      if (pack.boundary.confirmedSituations.length !== pack.situations.length
        || pack.boundary.confirmedSituations.some((value) => !pack.situations.includes(value))) {
        throw new TypeError(`boundary situations do not match routing situations: ${pack.key}`);
      }
      if (pack.boundary.excludedSignals.some((value) => !pack.antiTriggers.includes(value))) {
        throw new TypeError(`boundary exclusion is not enforced by antiTriggers: ${pack.key}`);
      }
    }
  }
  return true;
}

validateSalesChampionTrainingCatalog();

function matchesCore(pack, requested, stage, concerns) {
  if (!pack.capabilities.some((capability) => requested.has(capability))) return false;
  if (pack.stages.length && !pack.stages.includes(stage)) return false;
  return !pack.concerns.length || pack.concerns.some((concern) => concerns.has(concern));
}

function matches(pack, requested, stage, concerns, situations) {
  if (!matchesCore(pack, requested, stage, concerns)) return false;
  return !pack.situations.length || pack.situations.some((situation) => situations.has(situation));
}

function isAntiTriggered(pack, signals = {}) {
  return pack.antiTriggers.some((trigger) => (
    (trigger === 'explicit_refusal' && signals.explicitRefusal === true)
    || (trigger === 'stop_contact' && signals.stopContact === true)
  ));
}

function selectionScore(pack, requested, stage, concerns, situations, primaryConcern) {
  const situationMatch = pack.situations.some((situation) => situations.has(situation)) ? 1 : 0;
  const capabilityMatches = pack.capabilities.filter((capability) => requested.has(capability)).length;
  const stageMatch = pack.stages.includes(stage) ? 1 : 0;
  const concernMatch = pack.concerns.some((concern) => concerns.has(concern)) ? 1 : 0;
  const primaryConcernMatch = pack.concerns.includes(primaryConcern) ? 1 : 0;
  return situationMatch * 1_000 + primaryConcernMatch * 300
    + capabilityMatches * 100 + concernMatch * 20 + stageMatch * 10 + pack.priority;
}

function customerLabelIndex(customerLabels = []) {
  const index = new Map();
  for (const label of Array.isArray(customerLabels) ? customerLabels : []) {
    if (!label?.dimension || !label?.value) continue;
    if (!index.has(label.dimension)) index.set(label.dimension, new Map());
    const confidence = Number.isFinite(label.confidence) ? label.confidence : 0.5;
    const statusWeight = label.status === 'confirmed' ? 1 : 0.5;
    index.get(label.dimension).set(label.value, confidence * statusWeight);
  }
  return index;
}

function conditionWeight(index, conditions = {}) {
  let weight = 0;
  for (const [dimension, values] of Object.entries(conditions)) {
    const actual = index.get(dimension);
    if (!actual) continue;
    weight += Math.max(0, ...values.map((value) => actual.get(value) || 0));
  }
  return weight;
}

function trainingLabelScore(pack, customerLabels = []) {
  const index = customerLabelIndex(customerLabels);
  if (!index.size) return 0;
  const applicability = SALES_CHAMPION_TRAINING_LABEL_MAPPINGS[pack.key]
    || createExternalSalesChampionTrainingLabelMapping(pack);
  const stopped = ['B3', 'B4'].some((value) => index.get('contact_permission')?.has(value));
  if (stopped && applicability.excludedLabels?.contact_permission?.some(
    (value) => ['B3', 'B4'].includes(value),
  )) return -10_000;

  let score = conditionWeight(index, applicability.preferredLabels) * 60;
  score += conditionWeight(index, applicability.probeLabels) * 35;
  score -= conditionWeight(index, applicability.notTriggeredBy) * 50;
  return score;
}

export function getSalesChampionTrainingPacks(capabilityKeys = [], {
  stage = '',
  concerns = [],
  primaryConcern = concerns[0] || '',
  situations = [],
  signals = {},
  customerLabels = [],
} = {}) {
  const requested = new Set(Array.isArray(capabilityKeys) ? capabilityKeys : []);
  const concernSet = new Set(Array.isArray(concerns) ? concerns : []);
  const situationSet = new Set(Array.isArray(situations) ? situations : []);
  const activeSourceIds = new Set(SALES_CHAMPION_TRAINING_SOURCES
    .filter((source) => source.status === 'active')
    .map((source) => source.id));
  return SALES_CHAMPION_TRAINING_PACKS
    .filter((pack) => activeSourceIds.has(pack.source)
      && matches(pack, requested, stage, concernSet, situationSet)
      && !isAntiTriggered(pack, signals))
    .map((pack) => {
      const labelScore = trainingLabelScore(pack, customerLabels);
      return {
        pack,
        labelScore,
        score: selectionScore(pack, requested, stage, concernSet, situationSet, primaryConcern)
          + labelScore,
      };
    })
    .filter(({ labelScore }) => labelScore > -10_000)
    .sort((left, right) => right.score - left.score || left.pack.order - right.pack.order)
    .slice(0, MAX_PACKS)
    .map(({ pack, score, labelScore }) => ({
      key: pack.key,
      version: pack.version,
      source: pack.source,
      ...(pack.sourceSkill ? { sourceSkill: pack.sourceSkill } : {}),
      allowedUse: pack.allowedUse,
      officialFactsRequired: pack.officialFactsRequired,
      requiredInputs: [...pack.requiredInputs],
      antiTriggers: [...pack.antiTriggers],
      outputContract: pack.outputContract,
      evidenceRefs: [...pack.evidenceRefs],
      promptRules: [...pack.promptRules],
      actionSignature: pack.actionSignature,
      boundary: pack.boundary,
      labelApplicability: pack.labelApplicability,
      mappingStatus: 'confirmed',
      selectionScore: score,
      labelScore,
      selectionReason: pack.situations.some((situation) => situationSet.has(situation))
        ? 'explicit_situation+capability+stage+concern+priority'
        : 'capability+stage+concern+priority',
    }));
}

export function getSalesChampionTrainingPackBoundaryCandidates(capabilityKeys = [], {
  stage = '',
  concerns = [],
  primaryConcern = concerns[0] || '',
  situations = [],
  missingInformation = [],
  signals = {},
} = {}) {
  const requested = new Set(Array.isArray(capabilityKeys) ? capabilityKeys : []);
  const concernSet = new Set(Array.isArray(concerns) ? concerns : []);
  const situationSet = new Set(Array.isArray(situations) ? situations : []);
  const missingSet = new Set(Array.isArray(missingInformation) ? missingInformation : []);
  const activeSourceIds = new Set(SALES_CHAMPION_TRAINING_SOURCES
    .filter((source) => source.status === 'active')
    .map((source) => source.id));

  return SALES_CHAMPION_TRAINING_PACKS
    .filter((pack) => activeSourceIds.has(pack.source)
      && pack.situations.length > 0
      && matchesCore(pack, requested, stage, concernSet)
      && !pack.situations.some((situation) => situationSet.has(situation))
      && !isAntiTriggered(pack, signals))
    .map((pack) => {
      const confirmationSlots = [...new Set([
        ...pack.boundary.requiredSlots,
        ...pack.boundary.probeSlots,
      ])].filter((slot) => missingSet.has(slot));
      return { pack, confirmationSlots };
    })
    .filter(({ confirmationSlots }) => confirmationSlots.length > 0)
    .sort((left, right) => (
      right.confirmationSlots.length - left.confirmationSlots.length
      || selectionScore(right.pack, requested, stage, concernSet, situationSet, primaryConcern)
        - selectionScore(left.pack, requested, stage, concernSet, situationSet, primaryConcern)
      || left.pack.order - right.pack.order
    ))
    .slice(0, MAX_BOUNDARY_CANDIDATES)
    .map(({ pack, confirmationSlots }) => ({
      key: pack.key,
      version: pack.version,
      source: pack.source,
      ...(pack.sourceSkill ? { sourceSkill: pack.sourceSkill } : {}),
      actionSignature: pack.actionSignature,
      mappingStatus: 'needs_confirmation',
      confirmationSlots,
      unknownFallback: pack.boundary.unknownFallback,
      excludedSignals: [...pack.boundary.excludedSignals],
      selectionReason: 'capability+stage+concern+missing_boundary_slot',
    }));
}
