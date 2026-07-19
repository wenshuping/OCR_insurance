import {
  SALES_CHAMPION_CAPABILITY_KEYS,
  SALES_CHAMPION_SITUATION_KEYS,
} from './sales-champion-turn.contract.mjs';
import {
  SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS,
  SALES_CHAMPION_EXTERNAL_SOURCES,
} from './sales-champion-external-skill-mappings.mjs';
import {
  SALES_CHAMPION_TRAINING_LABEL_MAPPINGS,
  createExternalSalesChampionTrainingLabelMapping,
} from './sales-champion-customer-label-mappings.mjs';

const YANLI_SOURCE = 'yanli-whole-life-sales-2026-07';
const YULEILEI_SOURCE = 'yuleilei-high-client-sales-2026-07';
const CHENG_JIYE_SOURCE = 'cheng-jiye-practical-sales-2026-07';
const YIRONG_66_TIPS_SOURCE = 'yirong-66-tips-2026-07';
const MAX_PACKS = 7;
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
  Object.freeze({ id: CHENG_JIYE_SOURCE, version: 3, status: 'active' }),
  Object.freeze({ id: YIRONG_66_TIPS_SOURCE, version: 1, status: 'active' }),
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
      'douyin:cheng-jiye:7621480464351497487',
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
    stages: ['contact', 'appointment', 'discovery'],
    concerns: ['trust', 'unknown', 'follow_up'],
    situations: ['first_insurance_conversation'],
    allowedUse: 'pressure_free_opening',
    officialFactsRequired: false,
    priority: 96,
    evidenceRefs: [
      'douyin:cheng-jiye:7599940316023491855',
      'douyin:cheng-jiye:7617439313277553955',
      'douyin:cheng-jiye:7581061218979384618',
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
    stages: ['contact', 'appointment', 'post_sale'],
    concerns: ['trust', 'follow_up', 'unknown'],
    situations: ['orphan_policy'],
    allowedUse: 'orphan_policy_first_meeting',
    officialFactsRequired: false,
    priority: 98,
    evidenceRefs: ['douyin:cheng-jiye:7618134389175651619'],
    promptRules: [
      '孤儿保单、孤儿单、接手保单，或原业务员离职、失联造成无人持续服务时，第一次接触以把服务接稳和建立信任为目标，不假借保单检视挖缺口，也不急着成交。',
      '先问当初为什么买、客户对这份安排是否满意；不满意先安抚和处理服务感受，满意先肯定当年的决定。',
      '本次只推进下一次愿意沟通的机会；涉及原合同责任、现金价值或新旧产品差异时必须先核验官方证据。',
    ],
  },
  compare_online_and_advisor_service_fairly: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['reputation_objection', 'fact_sensitive_routing'],
    stages: ['objection'],
    concerns: ['trust', 'claims', 'product_fit'],
    situations: ['online_purchase_comparison'],
    allowedUse: 'online_advisor_service_comparison',
    officialFactsRequired: true,
    priority: 99,
    evidenceRefs: ['douyin:cheng-jiye:7587068676449307923'],
    promptRules: [
      '客户说想在网上买时，先问他更看重价格、条款、投保便利还是后续服务，不贬低线上渠道，也不把顾问服务说成理赔结果保证。',
      '只比较能核验的产品责任、价格、投保流程、服务范围和理赔协助边界；线上或线下哪一边更合适，由客户按自己的需求决定。',
      '必须给一段不吓客户的话，例如“您想网上买没问题，我先帮您把价格、责任和后续谁来协助这三项对齐，您再选”。',
    ],
  },
  turn_phone_question_into_low_pressure_meeting: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['appointment_scope', 'follow_up_consent'],
    stages: ['contact', 'appointment', 'discovery'],
    concerns: ['follow_up', 'trust'],
    situations: ['phone_only_appointment'],
    allowedUse: 'phone_to_meeting_scope',
    officialFactsRequired: false,
    priority: 98,
    evidenceRefs: ['douyin:cheng-jiye:7587069327438875940'],
    promptRules: [
      '客户说“电话里讲就行”时，不故弄玄虚也不强约；先用一句话说明这次沟通要解决的具体问题，以及为什么需要一起看资料或当面核对。',
      '给客户电话简聊、视频或见面三个选项，先争取十几分钟；客户不愿见面时就按他选择的方式继续，不把见面当成交前提。',
      '话术要说清见面的价值，不能只说产品复杂、电话讲不清，也不能用二选一时间逼客户答应。',
    ],
  },
  reengage_after_proposal_silence: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['follow_up_consent'],
    stages: ['appointment', 'proposal', 'objection', 'decision'],
    concerns: ['follow_up', 'trust', 'unknown'],
    situations: ['silent_after_proposal'],
    allowedUse: 'silent_prospect_reengagement',
    officialFactsRequired: false,
    priority: 100,
    evidenceRefs: ['douyin:cheng-jiye:7581061674732506410'],
    promptRules: [
      '计划书发出后客户不回复，先描述事实，不指责、不连环追问；给出“已经安排、还在考虑、暂时不看”三个都容易回复的出口。',
      '可以说“如果您已经安排好了，我就不再打扰；还在考虑也没关系，回我一句就行”，但不得宣称大多数客户一定会回复或一定能签单。',
      '客户仍不回复时停止高频联系，按已约定的联系偏好等待；明确拒绝后立即结束促成。',
    ],
  },
  handle_anti_insurance_content_with_evidence: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['reputation_objection', 'fact_sensitive_routing'],
    stages: ['objection'],
    concerns: ['trust', 'insurer_safety', 'claims'],
    situations: ['anti_insurance_content'],
    allowedUse: 'anti_insurance_content_review',
    officialFactsRequired: true,
    priority: 99,
    evidenceRefs: ['douyin:cheng-jiye:7584840588860689670'],
    promptRules: [
      '客户刷到质疑保险的视频时，先请他指出最担心的具体说法，不攻击博主、不说客户被流量带偏，也不靠奉承客户来结束讨论。',
      '把视频里的主张拆成可核验问题：合同怎么写、适用条件是什么、官方数据是否支持；有证据就逐项说明，没有证据就明确暂不能判断。',
      '如果视频指出的风险真实存在，要承认限制并讨论是否仍匹配客户目标，不能把所有负面内容都归为抹黑。',
    ],
  },
  request_referral_after_earned_trust: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['referral_request', 'follow_up_consent'],
    stages: ['post_sale'],
    concerns: ['follow_up'],
    situations: ['consented_referral'],
    allowedUse: 'consented_referral_request',
    officialFactsRequired: false,
    priority: 97,
    evidenceRefs: ['douyin:cheng-jiye:7630846169295424783'],
    promptRules: [
      '只有客户明确认可本次服务后才提出转介绍；请客户先征得朋友同意，再把联系方式交给顾问，不让客户当场打开通讯录或替顾问背书。',
      '一次只提一个轻量请求，例如“如果身边有人也在为这件事发愁，您可以先问问他愿不愿意认识我”。',
      '客户犹豫或拒绝就立即收住，不反复索要、不用人情关系施压，也不承诺对方一定没有购买压力。',
    ],
  },
  diagnose_maturing_deposit_before_transfer: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'tradeoff_disclosure', 'fact_sensitive_routing'],
    stages: ['appointment', 'discovery', 'proposal', 'objection'],
    concerns: ['benefits', 'liquidity', 'duration', 'product_fit', 'unknown'],
    situations: ['maturing_deposit'],
    allowedUse: 'maturing_deposit_discovery',
    officialFactsRequired: true,
    priority: 96,
    evidenceRefs: ['douyin:cheng-jiye:7631493095808437519'],
    promptRules: [
      '客户存款到期时，先问这笔钱何时会用、能否承受波动、必须保留多少流动性，不因为利率低就直接引导转入保险。',
      '只有客户目标和期限匹配后，才比较存款与保险的期限、保证程度、退出影响和服务；利率走势、产品调整时间必须有最新官方证据。',
      '不得声称银行利率一定继续下降、保险收益一定高于银行，或用宏观政策推导客户现在必须购买。',
    ],
  },
  explain_insurer_safety_without_guarantees: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['reputation_objection', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'],
    concerns: ['insurer_safety', 'trust'],
    situations: ['insurer_failure_concern'],
    allowedUse: 'insurer_safety_evidence_review',
    officialFactsRequired: true,
    priority: 99,
    evidenceRefs: [
      'douyin:cheng-jiye:7584840232726433067',
      'douyin:cheng-jiye:7602566004958301480',
    ],
    promptRules: [
      '客户担心保险公司出问题时，先区分合同保证利益、非保证利益、公司经营指标和监管处置机制，逐项引用最新官方材料。',
      '历史接管或风险处置只能说明曾经如何处理，不能推导未来所有公司、所有利益都不会受影响。',
      '不得使用“国家一定兜底、保险绝对安全、合同利益一分钱不会少”等保证性表述；不确定处明确说不确定。',
    ],
  },
  support_cooling_off_surrender_choice: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['cooling_off_support'],
    stages: ['decision', 'post_sale'],
    concerns: ['surrender', 'family_decision', 'product_fit'],
    situations: ['cooling_off_surrender'],
    allowedUse: 'cooling_off_surrender_support',
    officialFactsRequired: true,
    priority: 100,
    evidenceRefs: ['douyin:cheng-jiye:7606251354046106895'],
    promptRules: [
      '客户在犹豫期提出退保时，先说明会协助他了解并行使退保选择，不把“挽回保单”放在客户权利之前。',
      '征得同意后只问一个核心原因：信息没听清、方案不匹配、预算变化还是家人有疑问；解决不了或仍不愿继续就协助结束。',
      '犹豫期、退款范围、办理材料和时效必须按合同及公司正式流程核验，不用佣金、人情或所谓损失施压。',
    ],
  },
  explain_insurance_value_in_customer_language: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['plain_language_explanation', 'needs_discovery'],
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['benefits', 'product_fit', 'trust', 'unknown'],
    situations: ['insurance_value_explanation'],
    allowedUse: 'insurance_value_plain_language',
    officialFactsRequired: false,
    priority: 95,
    evidenceRefs: [
      'douyin:cheng-jiye:7592064775505431858',
      'douyin:cheng-jiye:7599940046459866368',
      'douyin:cheng-jiye:7599939696206040355',
    ],
    promptRules: [
      '客户问保险有什么用时，先问他最不想让哪件事打乱生活，再用“这项工具能解决什么、解决不了什么”解释，不先背产品术语。',
      '话术优先使用客户自己的目标和生活场景；涉及收益、税务、传承、法律隔离、理赔或服务权益时转交官方证据核验。',
      '不要讲成宏观行业课，也不要用“客户没认知”评价客户；给一段两三句话就能说清的现场表达。',
    ],
  },
  handle_low_rate_objection_without_prediction: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['tradeoff_disclosure', 'plain_language_explanation', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'],
    concerns: ['benefits', 'product_fit'],
    situations: ['low_rate_objection'],
    allowedUse: 'low_rate_objection',
    officialFactsRequired: true,
    priority: 100,
    evidenceRefs: [
      'douyin:cheng-jiye:7592063437232950555',
      'douyin:cheng-jiye:7616349797116693795',
    ],
    promptRules: [
      '客户说利率或收益低时，先承认“单看收益确实不高”，不要围绕某个固定利率数字背话术；再问他这笔钱更看重增值、稳定、使用时间还是随时能动。',
      '客户担心未来利率继续下调时，把未来走势明确说成未知；只比较当前可核验的合同保证利益、非保证利益、期限、现金价值和退出影响。',
      '必须先给一句现场能说的话，例如“您说得对，单看这个数不高。咱们先别赌以后升还是降，先看这笔钱要解决什么、现在写进合同的是什么”。不得声称利率一定继续下降、当前产品一定更划算或必须马上锁定。',
    ],
  },
  explain_critical_illness_price_change_with_evidence: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['plain_language_explanation', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'],
    concerns: ['affordability', 'benefits', 'claims'],
    situations: ['critical_illness_price_increase'],
    allowedUse: 'critical_illness_price_change',
    officialFactsRequired: true,
    priority: 98,
    evidenceRefs: ['douyin:cheng-jiye:7597280192440093987'],
    promptRules: [
      '客户问重疾险为什么比以前贵时，先核验比较的是同年龄、同保额、同保障期间和相近责任，不能直接归因于疾病更多或服务升级。',
      '把价格差拆成投保年龄、保险期间、责任范围、缴费期和健康情况等可核验因素；哪些因素尚未核实就明确说不知道。',
      '不要用患病概率、年轻化趋势或身边病例吓客户，也不得宣称现在产品责任一定更多、保险公司赚得更少。',
    ],
  },
  compare_gold_and_insurance_by_job: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['tradeoff_disclosure', 'plain_language_explanation'],
    stages: ['proposal', 'objection'],
    concerns: ['benefits', 'liquidity', 'product_fit'],
    situations: ['gold_comparison'],
    allowedUse: 'gold_insurance_role_comparison',
    officialFactsRequired: false,
    priority: 98,
    evidenceRefs: ['douyin:cheng-jiye:7621479224624434447'],
    promptRules: [
      '客户拿黄金和保险比时，不争谁收益高；先问这笔钱要承担增长、应急流动还是长期约定中的哪一项工作。',
      '把波动、流动性、持有期限和合同约定分开比较；需要具体收益、价格或产品利益时转交官方证据核验。',
      '不得贬低黄金、预测金价或保证保险不亏；客户目标不匹配时可以明确建议不做保险安排。',
    ],
  },
  discuss_forced_saving_fit_without_judgment: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'tradeoff_disclosure'],
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['liquidity', 'duration', 'product_fit'],
    situations: ['forced_saving_fit'],
    allowedUse: 'forced_saving_fit',
    officialFactsRequired: true,
    priority: 97,
    evidenceRefs: ['douyin:cheng-jiye:7626001030420974863'],
    promptRules: [
      '客户把保险称为强制储蓄时，不评价他自控力差；先确认他是否真的需要一笔不轻易动用的长期资金，以及应急钱是否已经留够。',
      '同时讲清约束的两面：有助于按计划留下资金，也会牺牲流动性并可能产生提前退出损失；不把约束包装成只有好处。',
      '缴费、现金价值、领取和退出规则必须核验合同；客户需要随时使用这笔钱时，不硬推长期保险。',
    ],
  },
  bring_family_objection_into_same_conversation: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['family_joint_decision', 'follow_up_consent'],
    stages: ['proposal', 'objection', 'decision'],
    concerns: ['family_decision', 'trust'],
    situations: ['family_member_opposition'],
    allowedUse: 'family_opposition_conversation',
    officialFactsRequired: false,
    priority: 99,
    evidenceRefs: ['douyin:cheng-jiye:7621480464351497487'],
    promptRules: [
      '客户说爱人、子女或其他家人反对时，先问家人具体担心什么，并邀请当事人一起听清；不要让客户和顾问结盟去说服家人。',
      '本轮目标是让每个人把预算、期限、用途和疑问说出来，不是绕过或攻破“拦路虎”；家人不愿参与就尊重。',
      '不得借孝顺、养老、传承或家庭责任施压，也不得把家人反对认定为客户的假拒绝。',
    ],
  },
  open_with_acquaintance_without_relationship_debt: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['appointment_scope', 'needs_discovery'],
    stages: ['contact', 'appointment'],
    concerns: ['trust', 'follow_up', 'unknown'],
    situations: ['acquaintance_opening'],
    allowedUse: 'acquaintance_opening',
    officialFactsRequired: false,
    priority: 97,
    evidenceRefs: [
      'douyin:cheng-jiye:7592064135412583730',
      'douyin:cheng-jiye:7581061218979384618',
    ],
    promptRules: [
      '熟人第一次聊保险时，把关系放回正常位置：先说明只是分享自己现在做的事，买不买不影响关系，再问对方愿不愿意聊几分钟。',
      '按陌生客户一样尊重流程和边界，不因为关系熟就跳过需求、默认支持或直接发方案。',
      '必须给一句自然开场，不能写成职业宣言、行业教育或“你不支持我”的人情话。',
    ],
  },
  revisit_existing_policy_goal_before_add_on: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['product_fit', 'benefits', 'unknown'],
    situations: ['already_bought_too_much'],
    allowedUse: 'already_bought_too_much_review',
    officialFactsRequired: true,
    priority: 99,
    evidenceRefs: ['douyin:cheng-jiye:7621478600243432739'],
    promptRules: [
      '客户说保险买太多了时，先停止加保推荐，回到每张现有保单当初要解决什么、现在是否仍需要；不能用“资产不嫌多”反驳。',
      '只有核实现有合同和客户新目标后，才判断是保持、整理、补充还是完全不加；没有缺口证据就不说客户还需要买。',
      '先给客户减压的话术，例如“那咱们先不加，先把已经有的分别是干什么的理清楚，确实够了就不买”。',
    ],
  },
  discover_wealth_preservation_goal_without_promises: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['needs_discovery', 'five_question_diagnosis', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal'],
    concerns: ['product_fit', 'benefits', 'unknown'],
    situations: ['wealth_preservation_goal'],
    allowedUse: 'wealth_preservation_discovery',
    officialFactsRequired: true,
    priority: 96,
    evidenceRefs: [
      'douyin:cheng-jiye:7584842425756093737',
      'douyin:cheng-jiye:7587069033749433636',
    ],
    promptRules: [
      '客户想守住已有财富时，先问最不能接受的是本金波动、家庭使用失控、未来现金流中断还是传承安排不清，不直接把保险等同于财富保全。',
      '把增长资金、备用资金和长期安排分开讨论，允许客户同时使用多种工具；先确认用途和风险边界，再讨论保险是否承担其中一部分工作。',
      '税务、婚姻财产、债务隔离、传承和“钱永远留在家里”等结论必须由专业证据核验，不得承诺保险绝对保本、免税或隔离风险。',
    ],
  },
  address_advisor_continuity_before_long_commitment: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['reputation_objection', 'follow_up_consent'],
    stages: ['proposal', 'objection'],
    concerns: ['trust', 'duration'],
    situations: ['advisor_continuity_concern'],
    allowedUse: 'advisor_continuity_concern',
    officialFactsRequired: false,
    priority: 99,
    evidenceRefs: ['douyin:cheng-jiye:7602564999688588584'],
    promptRules: [
      '客户担心长期缴费期间顾问离职或服务中断时，先承认这是合理顾虑，不用个人承诺“我一定干一辈子”。',
      '说清顾问本人能做到的联系与服务，再核验公司的保全、客服、理赔协助和服务交接渠道；把合同权利与个人服务分开。',
      '客户仍不信任时先不推进长期方案，可以先完成一次具体服务，让客户用兑现结果判断。',
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
    stages: ['contact', 'appointment', 'objection', 'decision', 'post_sale'],
    concerns: ['follow_up', 'trust', 'unknown'],
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
    stages: ['discovery', 'proposal', 'objection', 'decision', 'post_sale'],
    concerns: ['benefits', 'product_fit', 'unknown', 'trust'],
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
    stages: ['appointment', 'discovery', 'proposal'],
    concerns: ['trust', 'product_fit', 'unknown', 'follow_up'],
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
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['benefits', 'product_fit', 'unknown', 'duration', 'liquidity'],
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
    stages: ['discovery', 'proposal', 'objection', 'decision'],
    concerns: ['duration', 'affordability', 'liquidity', 'trust', 'family_decision', 'product_fit'],
    situations: ['long_payment_commitment'],
    allowedUse: 'long_payment_commitment',
    officialFactsRequired: true,
    priority: 97,
    evidenceRefs: ['douyin:cheng-jiye:7602564999688588584'],
    promptRules: [
      '客户觉得缴费期太长时，不要先猜他是怕压力、钱不灵活、顾问服务还是家人反对，也不要用四选一的话术诱导，更不要拿收入证明“每年这点钱不多”；先用中性开放问法让客户自己说具体卡点。话术引用客户本轮实际说出的期限；客户没说具体年数，就只说“您觉得这个缴费期偏长”。',
      '客户没有确认具体卡点前，本轮不要提前列出多个“如果他说……”分支；先停在一个中性问题，等客户回答后下一轮再进入对应处理。',
      '围绕客户确认的那个卡点继续：机会成本就确认未来用钱时间，收入顾虑就做保守压力测试，信任顾虑就先说清长期服务，家庭决策就邀请家人一起听。',
      '缴费期限、中途调整、退保、现金价值和替代方案必须先核验；当前期限不合适，就比较经核验的更短缴费期、调整金额或退出，不为保住方案硬说服。',
    ],
  },
  discuss_premium_coverage_tradeoff: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['tradeoff_disclosure', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal', 'objection', 'decision'],
    concerns: ['affordability', 'benefits', 'claims', 'product_fit'],
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
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['claims', 'product_fit', 'benefits'],
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
    stages: ['proposal', 'objection', 'decision'],
    concerns: ['benefits', 'insurer_safety', 'trust'],
    situations: ['dividend_uncertainty'],
    allowedUse: 'dividend_uncertainty_explanation',
    officialFactsRequired: true,
    priority: 99,
    evidenceRefs: [
      'douyin:cheng-jiye:7606251980457069876',
      'douyin:cheng-jiye:7650139155640421641',
      'douyin:cheng-jiye:7584840842377055531',
      'douyin:cheng-jiye:7618133495436643619',
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
    stages: ['discovery', 'proposal', 'objection', 'decision'],
    concerns: ['benefits', 'product_fit', 'liquidity'],
    situations: ['return_expectation'],
    allowedUse: 'return_limit_disclosure',
    officialFactsRequired: true,
    priority: 95,
    evidenceRefs: [
      'douyin:cheng-jiye:7616349797116693795',
      'douyin:cheng-jiye:7597279968640519459',
    ],
    promptRules: [
      '客户关注收益时，顾问应主动说明保险通常不是追求最高短期收益的工具，再回到客户为何考虑这项安排。',
      '展示计划前先核验保证与非保证利益、期限、现金价值和退出影响，避免客户看到数字后才发现限制。',
      '不得用“确定性对抗不确定性”替代风险披露，也不得把演示利益当成实际回报。',
    ],
  },
  identify_buying_signal_and_ask_next_step: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['appointment_scope', 'follow_up_consent'],
    stages: ['proposal', 'objection', 'decision'],
    concerns: ['product_fit', 'benefits', 'unknown', 'follow_up'],
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
    stages: ['discovery', 'proposal', 'objection'],
    concerns: ['claims', 'risk_pooling', 'trust', 'unknown'],
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
    stages: ['contact', 'appointment', 'proposal', 'decision', 'post_sale'],
    concerns: ['follow_up', 'benefits', 'trust'],
    situations: ['verified_product_change'],
    allowedUse: 'verified_product_change_notice',
    officialFactsRequired: true,
    priority: 94,
    evidenceRefs: [
      'douyin:cheng-jiye:7621475738419612962',
      'douyin:cheng-jiye:7618135060176293172',
    ],
    promptRules: [
      '只有拿到正式停售、调整或生效日期证据后才能通知客户；通知只说事实、可能影响和核验来源。',
      '明确告诉客户“不考虑也没关系”，给出是否需要了解的选择，不用失眠、纠结、最后机会等悬念诱导见面。',
      '不得用宏观经济、国家政策或长期损失测算制造虚假紧迫感。',
    ],
  },
  rebuild_service_trust_before_recommendation: {
    source: CHENG_JIYE_SOURCE,
    capabilities: ['reputation_objection', 'needs_discovery'],
    stages: ['contact', 'appointment', 'discovery', 'post_sale'],
    concerns: ['trust', 'follow_up', 'unknown'],
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
  handle_age_based_delay_without_scare: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['needs_discovery', 'fact_sensitive_routing'],
    stages: ['discovery', 'objection'], concerns: ['product_fit', 'underwriting'],
    situations: ['age_based_purchase_delay'], allowedUse: 'age_delay_discovery',
    officialFactsRequired: true, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:3', 'local:yirong-66-tips:4', 'local:yirong-66-tips:52'],
    promptRules: [
      '客户说孩子还小或自己还年轻时，先问想晚点办是预算、当前已有保障，还是觉得现在没有必要；不要用患病概率和医院故事吓人。',
      '可以比较现在办与以后办的条件，但年龄费率、健康告知和可保性必须交给保险专家按具体产品核验。',
      '给客户保留“现在不办”的选择，并约定什么条件变化时再回来看。',
    ],
  },
  compare_term_and_whole_life_by_goal: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['tradeoff_disclosure', 'needs_discovery', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal', 'objection'], concerns: ['duration', 'affordability', 'product_fit'],
    situations: ['term_whole_life_choice'], allowedUse: 'term_whole_life_goal_comparison',
    officialFactsRequired: true, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:5', 'local:yirong-66-tips:22', 'local:yirong-66-tips:28'],
    promptRules: [
      '定期和终身不预设谁更好，先确认客户最需要覆盖哪段时间、目标保额和可持续预算。',
      '可讨论单独配置或组合配置，但期限、责任、续保或现金价值只按已核验条款说明。',
      '不得用“租房买房”贬低定期保障，也不得把返还、转换或未来可买说成保证。',
    ],
  },
  review_third_party_cover_before_gap_claim: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['needs_discovery', 'fact_sensitive_routing'],
    stages: ['discovery', 'objection'], concerns: ['product_fit', 'claims'],
    situations: ['third_party_cover_overlap'], allowedUse: 'third_party_cover_review',
    officialFactsRequired: true, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:8', 'local:yirong-66-tips:11'],
    promptRules: [
      '客户已有单位团险或学校保险时先肯定已有安排，再请他提供保障责任、额度、期限和离职或转学后的延续规则。',
      '没有材料前不能断言额度低、只保社保内或一定不能续，也不能直接得出必须补个人保险。',
      '核验后只指出重复、空白和变化风险，让客户决定是否需要补充。',
    ],
  },
  compare_cancer_only_and_critical_illness_roles: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['plain_language_explanation', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal', 'objection'], concerns: ['product_fit', 'claims'],
    situations: ['cancer_only_cover_overlap'], allowedUse: 'cancer_critical_illness_role_comparison',
    officialFactsRequired: true, priority: 98,
    evidenceRefs: ['local:yirong-66-tips:12'],
    promptRules: [
      '先用一句话区分防癌险和重疾险各自解决什么，再核验客户现有合同具体保什么、不保什么。',
      '不因客户已有防癌险就默认保障不足，也不背诵高发疾病来制造恐惧。',
      '是否补充取决于客户目标、现有责任和预算，结论必须基于官方条款。',
    ],
  },
  separate_crowdfunding_from_contractual_cover: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['risk_pooling_explanation', 'plain_language_explanation'],
    stages: ['discovery', 'objection'], concerns: ['risk_pooling', 'benefits'],
    situations: ['crowdfunding_substitute'], allowedUse: 'crowdfunding_contract_distinction',
    officialFactsRequired: false, priority: 98,
    evidenceRefs: ['local:yirong-66-tips:17'],
    promptRules: [
      '不攻击筹款平台，只说明社会互助取决于自愿捐助，保险给付取决于合同约定，二者确定性和使用条件不同。',
      '先问客户真正担心的是保费负担，还是认为出事后有其他资金来源，再讨论要不要提前安排。',
      '不得宣称某平台已经解散、一定筹不到钱或保险一定赔。',
    ],
  },
  handle_underwriting_restriction_without_pressure: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['needs_discovery', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal', 'objection'], concerns: ['underwriting', 'product_fit'],
    situations: ['underwriting_restriction'], allowedUse: 'underwriting_restriction_support',
    officialFactsRequired: true, priority: 100,
    evidenceRefs: ['local:yirong-66-tips:18', 'local:yirong-66-tips:24', 'local:yirong-66-tips:37'],
    promptRules: [
      '面对既往症、除外、加费或无法承保，先解释当前只是核保结果或待评估事实，不恭喜、不羞辱，也不拿别人更差的情况施压。',
      '帮助客户整理就诊资料和健康告知，由保险专家核验可选路径；不得承诺标准承保、隐瞒病史或建议用其他产品替代医疗保障。',
      '如果客户最在意的风险被除外，承认限制并一起判断剩余责任是否仍有价值，不以“能买到就赶紧买”促成。',
    ],
  },
  compare_disease_counts_by_relevant_terms: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['tradeoff_disclosure', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'], concerns: ['product_fit', 'claims'],
    situations: ['disease_count_comparison'], allowedUse: 'disease_count_evidence_comparison',
    officialFactsRequired: true, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:20'],
    promptRules: [
      '客户比较病种数量时先认可他认真，再把比较维度从总数扩展到定义、分组、给付条件、比例和除外。',
      '请客户提供两份正式条款，由保险专家完成同口径比较；不能凭病名数量判断哪款更好。',
      '不得嘲笑低概率病种，也不得用未经核验的“高发清单”替代条款比较。',
    ],
  },
  explain_claims_process_without_guarantee: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['reputation_objection', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'], concerns: ['claims', 'trust'],
    situations: ['claims_process_concern'], allowedUse: 'claims_process_boundary',
    officialFactsRequired: true, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:25'],
    promptRules: [
      '客户问理赔快不快、麻不麻烦时，分别说明申请材料、服务协助和保险公司审核三件事，不能把协助服务说成赔付保证。',
      '时效、材料和线上流程只引用当前官方规则或报告，并说明复杂案件可能补充调查。',
      '可以讲顾问能帮客户整理什么，但不得承诺百分之百能赔或暗示能影响理赔结论。',
    ],
  },
  compare_similar_plan_prices_with_evidence: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['tradeoff_disclosure', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'], concerns: ['affordability', 'product_fit', 'benefits'],
    situations: ['similar_plan_price_difference'], allowedUse: 'similar_plan_price_comparison',
    officialFactsRequired: true, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:30'],
    promptRules: [
      '客户说同类方案更便宜时，先问具体和哪份方案、同一预算还是同一保额比较，再对齐责任、期限、除外、服务和退出条件。',
      '承认价格差异，不用豪车比喻暗示贵就一定好，也不宣称便宜产品更难理赔。',
      '正式比较交给保险专家基于两份官方材料完成，销售建议只解释差异是否与客户目标有关。',
    ],
  },
  explain_risk_pooling_when_premium_feels_wasted: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['risk_pooling_explanation', 'plain_language_explanation', 'fact_sensitive_routing'],
    stages: ['proposal', 'objection'], concerns: ['risk_pooling', 'benefits'],
    situations: ['premium_wasted_objection'], allowedUse: 'risk_pooling_value_explanation',
    officialFactsRequired: true, priority: 100,
    evidenceRefs: ['local:yirong-66-tips:31', 'local:yirong-66-tips:32', 'local:yirong-66-tips:44'],
    promptRules: [
      '客户觉得不出险保费白交，先承认他在意资金使用效率，再说明保障买的是约定期间的风险转移，不拿生病当“划算”。',
      '现金价值、年金转换、豁免或多次给付不是所有产品都有，必须按具体合同核验后才能提。',
      '不要把保险收益和银行利息直接混算，也不要反问客户能否保证一辈子不生病。',
    ],
  },
  protect_budget_when_debt_competes_with_cover: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['five_question_diagnosis', 'tradeoff_disclosure'],
    stages: ['discovery', 'objection'], concerns: ['affordability', 'product_fit'],
    situations: ['debt_budget_constraint'], allowedUse: 'debt_budget_protection',
    officialFactsRequired: false, priority: 100,
    evidenceRefs: ['local:yirong-66-tips:34'],
    promptRules: [
      '客户说有房贷车贷、没有余钱时，把它当真实预算约束，先保住日常开支、应急资金和还款能力，不要求客户硬挤保费。',
      '可以一起盘点最不能中断的家庭责任，再决定暂缓、降低目标或只处理最优先的一项。',
      '不得用卖房、失业、生病故事恐吓，也不得把有房有车推断成有购买能力。',
    ],
  },
  decline_rebate_and_explain_service_scope: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['rebate_request_handling', 'reputation_objection'],
    stages: ['proposal', 'objection', 'decision'], concerns: ['rebate', 'trust'],
    situations: ['rebate_request'], allowedUse: 'rebate_boundary_and_service_scope',
    officialFactsRequired: false, priority: 100,
    evidenceRefs: ['local:yirong-66-tips:36'],
    promptRules: [
      '客户提出返佣时不讽刺，直接说明不能通过返佣成交，再讲清顾问实际提供的投保前、保全和理赔协助边界。',
      '服务价值要说具体可兑现动作，不能暗示顾问能改变核保或理赔结果。',
      '客户只接受返佣条件时礼貌结束，不用人情、沉没成本或专业优越感施压。',
    ],
  },
  turn_vague_postponement_into_customer_choice: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['follow_up_consent', 'five_question_diagnosis'],
    stages: ['objection', 'decision'], concerns: ['follow_up', 'unknown'],
    situations: ['postpone_without_date'], allowedUse: 'postponement_clarification',
    officialFactsRequired: false, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:40'],
    promptRules: [
      '客户说以后、明年、改天再看时，不先判定是假拒绝；问一句是现在没空、还没想清楚，还是暂时不考虑。',
      '按客户答案约一个具体但可取消的回访点；如果是暂时不考虑，就停止促成。',
      '不得用体检、基因检测、疾病概率或“晚一年损失多少”制造紧迫感。',
    ],
  },
  verify_existing_coverage_amount_before_gap_claim: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['needs_discovery', 'fact_sensitive_routing'],
    stages: ['discovery', 'objection'], concerns: ['product_fit', 'affordability'],
    situations: ['existing_coverage_amount'], allowedUse: 'existing_coverage_amount_review',
    officialFactsRequired: true, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:45'],
    promptRules: [
      '客户说现有保额够了，先问他希望这笔钱覆盖哪些支出、多久和现有保单具体责任，不直接说“不够”。',
      '收入倍数只能作为讨论线索，不能机械套用；保障缺口必须基于已授权保单和客户确认的家庭责任核验。',
      '如果客户确认现有安排已满足目标，就尊重结论，不为了加保重新制造需求。',
    ],
  },
  surface_advisor_fit_concern_directly: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['reputation_objection', 'follow_up_consent'],
    stages: ['proposal', 'objection', 'decision'], concerns: ['trust', 'follow_up'],
    situations: ['advisor_fit_concern'], allowedUse: 'advisor_fit_clarification',
    officialFactsRequired: false, priority: 99,
    evidenceRefs: ['local:yirong-66-tips:46'],
    promptRules: [
      '客户问了很多却没有推进时，可以坦诚问“是方案还没想清楚，还是您更想找别的顾问服务”，不要把未成交叫飞单。',
      '用两三项具体服务说明自己能做什么，也允许客户选择其他顾问，不贬低同行、不靠返佣话题试探。',
      '客户不愿说明原因时停止追问，保留正常服务关系。',
    ],
  },
  balance_long_term_savings_and_liquidity: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['needs_discovery', 'tradeoff_disclosure', 'fact_sensitive_routing'],
    stages: ['discovery', 'proposal', 'objection'], concerns: ['liquidity', 'duration', 'product_fit'],
    situations: ['long_term_savings_liquidity'], allowedUse: 'savings_liquidity_partition',
    officialFactsRequired: true, priority: 100,
    evidenceRefs: ['local:yirong-66-tips:50'],
    promptRules: [
      '客户想长期存钱又怕急用，先把近期必用、应急和长期不用三类资金分开，不因年龄直接推荐某类保险。',
      '优先确认突发事件需要多少钱、多久能拿到，再核验具体产品现金价值、领取、贷款、退保和费用。',
      '不得宣称万能账户一定跑赢存款、几年后一定回本或保单贷款等同随时取款。',
    ],
  },
  respond_to_insurance_superstition_respectfully: {
    source: YIRONG_66_TIPS_SOURCE,
    capabilities: ['plain_language_explanation', 'reputation_objection'],
    stages: ['discovery', 'objection'], concerns: ['trust', 'risk_pooling'],
    situations: ['insurance_superstition'], allowedUse: 'insurance_superstition_response',
    officialFactsRequired: false, priority: 98,
    evidenceRefs: ['local:yirong-66-tips:49'],
    promptRules: [
      '客户说买了保险反而生病时，不嘲笑、不讲一大段医学知识；先确认他是在开玩笑，还是身边确有经历让他不安。',
      '简单说明买保险不会导致疾病，再把话题放回他是否需要提前安排风险资金。',
      '客户不想继续谈就收住，不用“毫无逻辑”“算命”等语言对抗。',
    ],
  },
});

function materializePack(key, pack, order) {
  const officialFactsRequired = pack.officialFactsRequired === true;
  return Object.freeze({
    key,
    version: 1,
    source: pack.source ?? YANLI_SOURCE,
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
    actionSignature: pack.actionSignature || '',
    order,
  });
}

export const SALES_CHAMPION_TRAINING_PACKS = Object.freeze(
  [
    ...Object.entries(RAW_PACKS),
    ...SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS.map((mappingEntry) => [
      mappingEntry.key,
      mappingEntry,
    ]),
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
  for (const source of sources) {
    if (!source?.id || sourceIds.has(source.id)) throw new TypeError(`duplicate or missing source: ${source?.id || ''}`);
    if (!Number.isInteger(source.version) || source.version < 1) throw new TypeError(`invalid source version: ${source.id}`);
    if (!['active', 'disabled'].includes(source.status)) throw new TypeError(`invalid source status: ${source.id}`);
    sourceIds.add(source.id);
  }

  const packKeys = new Set();
  for (const pack of packs) {
    if (!pack?.key || !/^[a-z][a-z0-9_]*$/u.test(pack.key) || packKeys.has(pack.key)) {
      throw new TypeError(`duplicate or invalid training pack key: ${pack?.key || ''}`);
    }
    packKeys.add(pack.key);
    if (!sourceIds.has(pack.source)) throw new TypeError(`unknown source for training pack: ${pack.key}`);
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
  }
  return true;
}

validateSalesChampionTrainingCatalog();

function matches(pack, requested, stage, concerns, situations) {
  if (!pack.capabilities.some((capability) => requested.has(capability))) return false;
  if (pack.stages.length && !pack.stages.includes(stage)) return false;
  if (pack.situations.length && !pack.situations.some((situation) => situations.has(situation))) return false;
  return !pack.concerns.length || pack.concerns.some((concern) => concerns.has(concern));
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
      allowedUse: pack.allowedUse,
      officialFactsRequired: pack.officialFactsRequired,
      requiredInputs: [...pack.requiredInputs],
      antiTriggers: [...pack.antiTriggers],
      outputContract: pack.outputContract,
      evidenceRefs: [...pack.evidenceRefs],
      promptRules: [...pack.promptRules],
      selectionScore: score,
      labelScore,
      selectionReason: pack.situations.some((situation) => situationSet.has(situation))
        ? 'explicit_situation+capability+stage+concern+priority'
        : 'capability+stage+concern+priority',
    }));
}
