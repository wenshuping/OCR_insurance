import { SEMANTIC_QUERY_ASPECTS } from './agent-semantic-contract.mjs';
import {
  SALES_CHAMPION_CAPABILITY_KEYS,
  SALES_CHAMPION_KYC_EVIDENCE_SOURCES,
  SALES_CHAMPION_KYC_FACT_KEYS,
  SALES_CHAMPION_MISSING_INFORMATION_KEYS,
  SALES_CHAMPION_SITUATION_KEYS,
  hasExplicitCustomerAttribution,
  validateSalesTurnProposal,
} from './sales-champion-turn.contract.mjs';
import { SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY } from './sales-champion-customer-labels.mjs';
import { SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS } from './sales-champion-external-skill-mappings.mjs';
import {
  redactDeepSeekDirectIdentifiers,
  sanitizeDeepSeekRequestBody,
} from './deepseek-privacy-gateway.mjs';

const STAGES = ['contact', 'appointment', 'discovery', 'proposal', 'objection', 'decision', 'post_sale'];
const CONCERNS = [
  'liquidity', 'duration', 'family_decision', 'trust', 'affordability', 'product_fit',
  'insurer_safety', 'benefits', 'claims', 'underwriting', 'surrender', 'rebate',
  'risk_pooling', 'follow_up', 'unknown',
];
const INTERPRETER_MAX_TOKENS = 4_000;
const CUSTOMER_STATEMENT_MAX_ITEMS = 20;
const CUSTOMER_STATEMENT_CHARACTER_BUDGET = 4_000;
const CUSTOMER_STATEMENT_KYC_PRIORITY = Object.freeze({
  customer_goal: 50,
  service_request: 45,
  insurance_attitude: 40,
  purchase_behavior: 35,
  conversation_outcome: 30,
});
const EXTERNAL_SKILL_SEMANTIC_INDEX = Object.freeze(
  SALES_CHAMPION_EXTERNAL_SKILL_MAPPINGS.map((mappingEntry) => Object.freeze({
    key: mappingEntry.key,
    sourceSkill: mappingEntry.sourceSkill,
    capabilities: mappingEntry.capabilities,
    stages: mappingEntry.stages,
    concerns: mappingEntry.concerns,
    boundaryGroups: mappingEntry.boundary.groups,
    probeSlots: mappingEntry.boundary.probeSlots,
  })),
);
function text(value) {
  return String(value || '').trim();
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseJson(content = '') {
  return JSON.parse(text(content)
    .replace(/^```json\s*/iu, '')
    .replace(/^```\s*/u, '')
    .replace(/```$/u, '')
    .trim());
}

function dropUngroundedCustomerStatements(proposal, sourceTexts = []) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)
    || !Array.isArray(proposal.customerStatements) || !proposal.customerStatements.length) return proposal;
  const sources = sourceTexts.map((item) => text(item).replace(/\s+/gu, ''));
  const currentSource = sources[0] || '';
  const historicalSources = sources.slice(1).filter(Boolean);
  const grounded = proposal.customerStatements.flatMap((statement, index) => {
    if (!statement || typeof statement !== 'object' || Array.isArray(statement)
      || Object.keys(statement).length !== 2
      || !Object.hasOwn(statement, 'text') || !Object.hasOwn(statement, 'source')
      || !['current_message', 'confirmed_history'].includes(statement.source)) return [statement];
    const statementText = text(statement.text);
    if (!statementText || statementText.length > 500) return [statement];
    const normalized = statementText.replace(/\s+/gu, '');
    if (currentSource.includes(normalized)) {
      return [{ ...statement, source: 'current_message', normalized, index }];
    }
    if (historicalSources.some((source) => source.includes(normalized))) {
      return [{ ...statement, source: 'confirmed_history', normalized, index }];
    }
    return [];
  });
  if (!grounded.length) return proposal;
  if (grounded.some((statement) => !statement?.normalized)) {
    return { ...proposal, customerStatements: grounded.slice(0, CUSTOMER_STATEMENT_MAX_ITEMS) };
  }
  const facts = Array.isArray(proposal.kycFacts) ? proposal.kycFacts : [];
  const labels = Array.isArray(proposal.customerLabels) ? proposal.customerLabels : [];
  const unique = [...new Map(grounded.map((statement) => [statement.normalized, statement])).values()];
  const ranked = unique.map((statement) => {
    const kycPriority = facts.reduce((highest, fact) => {
      const evidence = text(fact?.evidence).replace(/\s+/gu, '');
      const matches = evidence && (evidence.includes(statement.normalized)
        || statement.normalized.includes(evidence));
      return matches ? Math.max(highest, CUSTOMER_STATEMENT_KYC_PRIORITY[fact?.key] || 10) : highest;
    }, 0);
    const labelPriority = labels.some((label) => {
      const evidence = text(label?.evidence).replace(/\s+/gu, '');
      return evidence && (evidence.includes(statement.normalized)
        || statement.normalized.includes(evidence));
    }) ? 8 : 0;
    return {
      ...statement,
      score: (statement.source === 'current_message' ? 20 : 0) + kycPriority + labelPriority,
    };
  }).sort((left, right) => right.score - left.score || left.index - right.index);
  let usedCharacters = 0;
  const selected = [];
  for (const statement of ranked) {
    if (selected.length >= CUSTOMER_STATEMENT_MAX_ITEMS) break;
    if (usedCharacters + statement.text.length > CUSTOMER_STATEMENT_CHARACTER_BUDGET) continue;
    selected.push({ text: statement.text, source: statement.source });
    usedCharacters += statement.text.length;
  }
  return { ...proposal, customerStatements: selected };
}

function normalizeAdvisorEvidenceAttribution(proposal, sourceTexts = []) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  return {
    ...proposal,
    ...(Array.isArray(proposal.kycFacts) ? {
      kycFacts: proposal.kycFacts.map((fact) => (
        fact?.source === 'customer_statement'
          && !hasExplicitCustomerAttribution(fact.evidence, sourceTexts)
          ? { ...fact, source: 'advisor_fact' }
          : fact
      )),
    } : {}),
    ...(Array.isArray(proposal.customerLabels) ? {
      customerLabels: proposal.customerLabels.filter((label) => (
        label?.source !== 'customer_statement'
          || hasExplicitCustomerAttribution(label.evidence, sourceTexts)
      )),
    } : {}),
  };
}

function dropUngroundedKycEvidence(proposal, sourceTexts = []) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  const sources = sourceTexts.map((item) => text(item).replace(/\s+/gu, '')).filter(Boolean);
  const keepGrounded = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || typeof item.evidence !== 'string' || !item.evidence.trim()) return true;
    const evidence = item.evidence.replace(/\s+/gu, '');
    return sources.some((source) => source.includes(evidence));
  };
  return {
    ...proposal,
    ...(Array.isArray(proposal.kycFacts)
      ? { kycFacts: proposal.kycFacts.filter(keepGrounded).slice(0, 16) }
      : {}),
    ...(Array.isArray(proposal.customerLabels)
      ? { customerLabels: proposal.customerLabels.filter(keepGrounded).slice(0, 20) }
      : {}),
  };
}

function normalizeGroundedProposal(proposal, sourceTexts = []) {
  return normalizeAdvisorEvidenceAttribution(
    dropUngroundedKycEvidence(
      dropUngroundedCustomerStatements(proposal, sourceTexts),
      sourceTexts,
    ),
    sourceTexts,
  );
}

function applyTurnRelation(proposal, question = '') {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return proposal;
  const value = text(question).replace(/\s+/gu, '');
  const correction = /(?:人家|客户).{0,24}(?:没|没有|并没|并没有)(?:明确)?(?:说|表示|提到|提过|想|想要|要求)/u.test(value)
    || /(?:是我|也是我|只是我).{0,20}(?:沟通|问|引导|推|判断|觉得|猜).{0,8}(?:出来|的)/u.test(value)
    || /^(?:人家|客户|他|她|这|那|前面|之前).{0,80}(?:不是|难道).{1,80}(?:吗|嘛|呢)[？?]?$/u.test(value);
  return correction
    ? {
      ...proposal,
      turnRelation: { value: 'correction', confidence: 1 },
      concerns: [{ type: 'unknown', priority: 'primary', confidence: 1 }],
      missingInformation: [],
      unknownInformation: [],
      proposedCapabilities: ['general_sales_clarification'],
      insuranceNeeds: [],
      situations: [],
    }
    : proposal;
}

function boundedHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-20).flatMap((message) => {
    const role = text(message?.role);
    const content = redactDeepSeekDirectIdentifiers(text(message?.content)).slice(0, 2_000);
    return ['user', 'assistant'].includes(role) && content ? [{ role, content }] : [];
  });
}

function interpreterMessages({ question, history, activeCustomerKyc = null }) {
  const safeQuestion = redactDeepSeekDirectIdentifiers(question).slice(0, 2_000);
  const safeHistory = boundedHistory(history);
  return {
    messages: [
      {
        role: 'system',
        content: [
          '你是 Sales Champion 内部的销售 turn interpreter，只做结构化理解和受控能力选择，不生成给客户的答案。',
          '只能返回一个 JSON 对象，不要输出 Markdown、解释或额外字段。',
          `stage.value 只能是：${STAGES.join(', ')}`,
          `concerns.type 只能是：${CONCERNS.join(', ')}`,
          `missingInformation 只能是：${SALES_CHAMPION_MISSING_INFORMATION_KEYS.join(', ')}`,
          `proposedCapabilities 只能是：${SALES_CHAMPION_CAPABILITY_KEYS.join(', ')}`,
          `situations 只能是：${SALES_CHAMPION_SITUATION_KEYS.join(', ')}`,
          `可语义召回的销售 Skills 目录：${JSON.stringify(EXTERNAL_SKILL_SEMANTIC_INDEX)}`,
          `kycFacts.key 只能是：${SALES_CHAMPION_KYC_FACT_KEYS.join(', ')}`,
          `kycFacts.source 和 customerLabels.source 只能是：${SALES_CHAMPION_KYC_EVIDENCE_SOURCES.join(', ')}`,
          `customerLabels 必须使用以下受控标签：${JSON.stringify(SALES_CHAMPION_CUSTOMER_LABEL_TAXONOMY)}`,
          `insuranceNeeds.queryAspects 只能是：${SEMANTIC_QUERY_ASPECTS.join(', ')}`,
          'customerStatements 最多提交 24 条候选逐字证据片段，不得改写；系统会去重并在总字符预算内优先保留与客户目标、明确态度、服务诉求、购买行为和本轮结果有关的证据。它只标记证据位置，不代表客户本人说过。片段在当前问题中才用 current_message，只在历史中出现必须用 confirmed_history。',
          'customerStatements 不要收录顾问的任务请求，例如“我怎么跟进”“给我建议”“怎么回复”；也不要把整段 currentQuestion 原样放进一条 statement。',
          'kycFacts 从顾问描述中提取年龄人生阶段、工作职业、收入、家庭婚姻子女、居住房产、资产负债、现有保单、客户目标、保险态度、购买行为、决策方式、联系偏好、服务事项和本轮结果；evidence 必须逐字摘录。',
          '所有 user 消息默认都是保险顾问在描述客户，不是客户本人直接输入。只有顾问明确写出客户说、表示、回复、要求、拒绝、认为、担心或希望的内容，才能用 customer_statement；顾问明确陈述的客观情况用 advisor_fact；“估计、可能、应该、忘记了”用 advisor_estimate；顾问主观判断用 advisor_inference。',
          'customerLabels 只登记有证据的受控标签。customer_statement 或明确 advisor_fact 可以 confirmed；advisor_estimate 和 advisor_inference 只能 candidate。',
          '不得仅凭年龄、职业、收入、婚姻、房产或产品名称推断 economic_capacity、purchase_intent、resistance、decision_maturity、family_decision 或保障缺口。',
          'missingInformation 只能填写当前问题和已确认历史中仍然没有的信息。历史里已经回答过的目标、用途、预算、保单、家庭决策或联系偏好不得重复列入；当前问题是“养老”“一年一万”“微信联系”等简短回答时，要结合最近一轮销冠追问理解为补充答案，再只保留仍缺的信息。',
          '基础 KYC 是跨轮累计状态：历史或本轮一旦明确客户来源、本轮诉求或联系偏好，后续每轮都要保留对应 kycFacts/customerLabels，不得因为当前话题变化而丢失。客户来源用 relationship_origin，同时映射 source 标签；来源不明才使用 SRC0。',
          '客户只表达“太长、太贵、收益低、不需要、以后再说”等表面异议，但没有说明具体原因时，把 objection_reason 放入 missingInformation；不得用模型猜测的原因替客户补全。客户已经明确说明原因时不要再列 objection_reason。',
          'turnRelation.value 只能是 new_request、follow_up_answer、context_update、correction；用于说明本轮与历史的关系。顾问在回答上一轮问题时用 follow_up_answer，新增背景用 context_update，明确否定或修正前文判断时用 correction。',
          'customerCase.relation 用于判断本轮描述属于哪个客户案例，只能是 same_customer、new_customer、uncertain。必须比较 activeCustomerKyc 与本轮完整语义，不能依赖“另一个客户”等固定关键词：身份、职业、年龄阶段、家庭、来源、现有保单或服务事项明显不兼容时用 new_customer；补充同一客户的事实、回答上轮问题或身份事实相容时用 same_customer；证据不足且混用会影响建议时用 uncertain。',
          'activeCustomerKyc 为空时，出现客户经营问题即使用 new_customer。不得把新客户的 KYC 与 activeCustomerKyc 合并。',
          'turnRelation=correction 时，当前消息优先于历史：撤销与本轮纠正冲突的 customer_goal、concern、situation、标签和追问，不得把顾问的纠正当成客户新异议。',
          'turnRelation=correction 时，先结合顾问历史描述消解当前口语中的指代和省略，再把修正后的客户事实写入合适的 kycFacts.value，source 使用 advisor_fact，evidence 仍逐字引用当前消息。业务员叙述中的“客户、他、她、人家”指被讨论客户，不表示客户亲口说过；持有、经历或背景事实不得改写成客户主动提及、咨询或比较。',
          '客户对非保险商品、服务或活动的价格反馈，不等于保险产品的 affordability 异议；只有顾问明确在讨论保险方案及其预算时，才可以添加 budget、sustainable_budget 或保险价格处理能力。',
          '证据主语不明确时，不得把行为、意愿或态度归到客户名下。顾问手里出现一个联系、服务或邀约机会，不等于客户主动联系、愿意参加、允许营销、信任顾问或出现购买信号。',
          '关系友好、礼貌回应、拒绝礼物、工作繁忙或愿意接收普通问候，都不等于允许谈保险。客户没有主动提出保险、保单或服务事项，也没有明确给出沟通时间时，把 explicit_customer_request 放入 missingInformation，优先使用 appointment_scope 或 follow_up_consent 确认边界，不得直接进入 needs_discovery、方案或成交话术。',
          '客户反复表示忙、没有时间或始终约不出来时，先尊重可联系时间和沟通许可；不得把“关系不错”解释成应当趁机销售，也不得推断拒绝礼物背后的心理动机。',
          'answeredInformation 表示历史或本轮已经被顾问实质回答的受控信息槽位。必须把销冠最近提出的问题与顾问后续回答做语义对应：只登记真正回答到的槽位；编号相同但答非所问不能算已回答。已回答槽位不得再次进入 missingInformation。',
          '如果顾问已明确说某项“不知道、不了解、没问到、拿不到”，把它放进 unknownInformation，不要放进 answeredInformation 或 missingInformation，后续仍给安全跟进方法。',
          '只有回答确实依赖产品责任、条款、续保、理赔、核保、现金价值或产品比较事实时，才添加 type=product_facts 的 insuranceNeeds。',
          '只有需要基于已授权家庭保单或保障报告判断现有保障覆盖、重复或缺口时，才添加 type=coverage_gap 的 insuranceNeeds。',
          '产品名称只是客户背景、且销售建议不依赖产品事实时，insuranceNeeds 必须为空。',
          '年龄、收入估计、婚姻状态、居住、房产、子女和已有产品属于客户背景，不会自动成为 affordability、family_decision、benefits 或 product_fit concern。只有客户明确表达预算异议、共同决策问题、产品疑问或购买诉求时才能选择对应 concern。',
          '顾问只问“怎么跟进”，但客户目标和当前销售进展尚不清楚时，使用 discovery + unknown + needs_discovery，不得从背景信息猜一个异议。',
          'situations 只标记当前问题明确出现的具体业务场景；没有明确场景时返回空数组，不得根据年龄、收入或产品名称猜测。',
          '对销售 Skill 使用语义匹配，不要求顾问说出 Skill 名或固定关键词。根据完整描述与目录中的 sourceSkill、能力、阶段、顾虑、边界分组和待确认槽位选择最相近的 situations；最多保留四个真正相关的候选，不能因为名称沾边就忽略联系许可、客户来源和明确服务任务。',
          '同一句客户表达可以同时包含多个已明确顾虑：例如“缴费期太长”可能同时明确指向 duration，并在客户同时提到用钱、收入、服务或家人时追加 liquidity、affordability、trust 或 family_decision。不得把未说出口的可能原因当成 concern。',
          'stage 按真实沟通进度选择，不要为了套某条规则强改阶段；具体 situation 已明确时，即使处于相邻阶段，也应保留该 situation 和对应能力。',
          '客户话术中的年数、金额、年龄、利率和称呼都只按本轮原话理解；场景能力不得依赖固定示例数字，也不得自行补入视频案例里的数字。',
          '只有顾问明确说明已经与客户进行第一次保险交流，且客户实际参与了保险话题、尚未进入方案讨论时，才使用 contact/appointment/discovery + trust/unknown/follow_up + appointment_scope + needs_discovery + first_insurance_conversation。仅仅关系友好、准备联系、送礼、客户很忙或尚未聊过保险，不能标记 first_insurance_conversation。',
          '当前问题明确是孤儿保单、孤儿单、接手保单，或原业务员离职、失联导致客户无人持续服务，且客户当前只要求服务时，使用 contact/appointment/post_sale + follow_up/trust + follow_up_consent + needs_discovery + orphan_policy；不得降级成普通 needs_discovery，也不得把服务转成购买需求。',
          '客户明确说想在网上买、比较线上与顾问渠道时，使用 objection + trust/product_fit + reputation_objection + fact_sensitive_routing + online_purchase_comparison。',
          '客户要求只在电话里讲、不愿见面时，使用 appointment + follow_up + appointment_scope + phone_only_appointment；不得把不见面识别为拒绝购买。',
          '计划书或方案发出后客户不接电话、不回消息时，使用 objection + follow_up + follow_up_consent + silent_after_proposal。',
          '客户因短视频、自媒体或他人言论质疑保险时，使用 objection + trust + reputation_objection + fact_sensitive_routing + anti_insurance_content。',
          '顾问询问如何向满意的老客户要转介绍时，使用 post_sale + follow_up + referral_request + follow_up_consent + consented_referral。',
          '客户明确有存款到期并询问如何安排时，使用 discovery + product_fit + needs_discovery + maturing_deposit；只有涉及具体产品比较时才追加 fact_sensitive_routing。',
          '客户担心保险公司倒闭、接管或多家公司整体出问题时，使用 objection + insurer_safety + reputation_objection + fact_sensitive_routing + insurer_failure_concern；明确问偿付能力指标时仍使用 solvency_concern。',
          '客户在犹豫期明确想退保时，使用 post_sale + surrender + cooling_off_support + cooling_off_surrender；必须尊重退保选择。',
          '客户问保险有什么用、如何用大白话讲保险价值时，使用 discovery/proposal + benefits/product_fit + plain_language_explanation + insurance_value_explanation。',
          '客户明确说当前利率、保证利益或整体收益太低，或担心未来利率继续下调时，使用 objection + benefits + tradeoff_disclosure + plain_language_explanation + fact_sensitive_routing + low_rate_objection；不要把场景写死为某个利率数字。',
          '客户问重疾险为什么比过去贵或价格上涨时，使用 objection + affordability/benefits + plain_language_explanation + fact_sensitive_routing + critical_illness_price_increase。',
          '客户明确拿黄金与保险比较时，使用 objection + benefits/product_fit + tradeoff_disclosure + plain_language_explanation + gold_comparison；普通股票或基金比较仍使用 investment_comparison。',
          '客户讨论保险是否适合作为强制储蓄时，使用 discovery/objection + liquidity/duration/product_fit + needs_discovery + tradeoff_disclosure + forced_saving_fit。',
          '客户明确说爱人、子女或其他家人反对方案时，使用 objection + family_decision + family_joint_decision + follow_up_consent + family_member_opposition。',
          '顾问问熟人、朋友或亲戚第一次如何开口聊保险时，使用 contact + unknown + needs_discovery + acquaintance_opening；关系熟悉本身不等于客户已有信任异议或约访异议。',
          '客户明确说保险已经买太多、不想再加时，使用 objection + product_fit + needs_discovery + fact_sensitive_routing + already_bought_too_much；不得直接推断保障缺口。',
          '客户明确想守住已有财富、区分赚钱和守钱时，使用 discovery + product_fit + needs_discovery + five_question_diagnosis + fact_sensitive_routing + wealth_preservation_goal。',
          '客户担心长期缴费期间顾问离职、失联或没人持续服务时，使用 objection + trust/duration + reputation_objection + follow_up_consent + advisor_continuity_concern。',
          '顾问明确要访谈高净值或高价值客户的经历、目标和决策过程时，使用 appointment/discovery/proposal + trust/product_fit/unknown + needs_discovery + five_question_diagnosis + high_value_client；不得仅凭收入或职业自动标记。',
          '客户讨论退休生活、养老现金流或何时能有选择地退休时，使用 discovery/proposal/objection + benefits/product_fit/duration/liquidity + needs_discovery + five_question_diagnosis + retirement_planning。',
          '客户觉得任何缴费期限太长、担心交不完或承诺周期过久时，使用 discovery/proposal/objection/decision + duration，并按原话追加 liquidity/affordability/trust/family_decision + tradeoff_disclosure + five_question_diagnosis + long_payment_commitment；不得限定为十年。',
          '客户在保费与保额、预算与保障力度之间犹豫时，使用 discovery/proposal/objection/decision + affordability/benefits/product_fit，涉及责任事实时追加 claims + tradeoff_disclosure + fact_sensitive_routing + premium_coverage_tradeoff。',
          '客户询问医疗险与重疾险如何分工、是否重复时，使用 discovery/proposal/objection + product_fit/claims + plain_language_explanation + fact_sensitive_routing + medical_critical_illness_overlap。',
          '客户询问社保、单位保障与商业保险如何配合、是否重复时，使用 discovery/proposal/objection + product_fit/claims/benefits + plain_language_explanation + fact_sensitive_routing + social_commercial_overlap。',
          '客户询问分红是否确定、演示利益能否实现或分红险怎么看时，使用 proposal/objection/decision + benefits/insurer_safety + plain_language_explanation + tradeoff_disclosure + fact_sensitive_routing + dividend_uncertainty。',
          '客户先设定收益预期、回本预期或拿预期数字要求产品满足时，使用 discovery/proposal/objection/decision + benefits/product_fit/liquidity + tradeoff_disclosure + plain_language_explanation + fact_sensitive_routing + return_expectation。',
          '客户主动追问怎么办理、需要什么资料、何时能开始或明确愿意推进时，使用 proposal/decision + product_fit/follow_up + appointment_scope + follow_up_consent + buying_signal；不能把普通询问误判为购买信号。',
          '客户愿意讨论健康风险但尚未形成具体产品问题时，使用 discovery/proposal/objection + claims/risk_pooling/unknown + needs_discovery + five_question_diagnosis + health_risk_conversation；不得用疾病概率恐吓。',
          '有已核验的产品调整、停售或规则变化，需要通知客户但不强迫成交时，使用 contact/appointment/proposal/decision/post_sale + follow_up/benefits + follow_up_consent + fact_sensitive_routing + verified_product_change。',
          '客户因过去被强推、无人服务或体验不好而不信任顾问时，使用 contact/appointment/discovery/post_sale + trust/follow_up + reputation_objection + needs_discovery + service_trust_recovery。',
          '老客户已经买过保险，顾问考虑加保或追加安排时，使用 discovery/proposal/objection/post_sale + product_fit/benefits/unknown + needs_discovery + plain_language_explanation + existing_customer_add_on；先回到原目标，不默认存在缺口。',
          '活动、讲座或客户经营场景后的跟进，按客户当时意愿使用 contact/appointment/objection/decision/post_sale + follow_up/trust + follow_up_consent + appointment_scope + event_follow_up。',
          '顾问规划某一区域的日常获客、拜访和转介绍节奏时，使用 contact/appointment + follow_up/unknown + appointment_scope + follow_up_consent + regional_pipeline；不得把区域标签推导成客户购买能力。',
          '客户以孩子还小、自己年轻为由想以后再买时，使用 discovery/objection + product_fit/underwriting + needs_discovery + fact_sensitive_routing + age_based_purchase_delay。',
          '客户比较定期与终身保障、或明确只想保一段时间时，使用 discovery/proposal/objection + duration/product_fit + tradeoff_disclosure + needs_discovery + fact_sensitive_routing + term_whole_life_choice。',
          '客户认为单位团险或学校保险已经足够时，使用 objection + product_fit/claims + needs_discovery + fact_sensitive_routing + third_party_cover_overlap。',
          '客户已有防癌险并询问是否还需要重疾险时，使用 objection + product_fit/claims + plain_language_explanation + fact_sensitive_routing + cancer_only_cover_overlap。',
          '客户说生病后可以靠众筹、不需要保险时，使用 objection + risk_pooling/benefits + risk_pooling_explanation + plain_language_explanation + crowdfunding_substitute。',
          '客户有既往症、被除外、加费、拒保或担心还能不能买时，使用 discovery/proposal/objection + underwriting + needs_discovery + fact_sensitive_routing + underwriting_restriction。',
          '客户拿重疾病种数量比较产品时，使用 objection + product_fit/claims + tradeoff_disclosure + fact_sensitive_routing + disease_count_comparison。',
          '客户问理赔快不快、手续麻不麻烦或顾问能帮什么时，使用 objection + claims/trust + reputation_objection + fact_sensitive_routing + claims_process_concern。',
          '客户说相似方案别家更便宜、询问贵在哪里时，使用 objection + affordability/product_fit + tradeoff_disclosure + fact_sensitive_routing + similar_plan_price_difference。',
          '客户觉得不出险保费白交、总保费接近保额或重疾险不如存银行时，使用 objection + risk_pooling/benefits + risk_pooling_explanation + plain_language_explanation + fact_sensitive_routing + premium_wasted_objection。',
          '客户明确说房贷车贷占用预算、没有余钱时，使用 discovery/objection + affordability + five_question_diagnosis + tradeoff_disclosure + debt_budget_constraint。',
          '客户明确要求返佣时，使用 proposal/objection/decision + rebate/trust + rebate_request_handling + reputation_objection + rebate_request。',
          '客户只说以后、明年、改天再看且没有具体时间时，使用 objection/decision + follow_up/unknown + follow_up_consent + five_question_diagnosis + postpone_without_date。',
          '客户明确说现有保额已经够时，使用 discovery/objection + product_fit + needs_discovery + fact_sensitive_routing + existing_coverage_amount；不得直接判断存在缺口。',
          '客户了解很多但不愿从当前顾问处办理、或顾问想确认是否是服务人选问题时，使用 proposal/objection/decision + trust/follow_up + reputation_objection + follow_up_consent + advisor_fit_concern。',
          '客户想长期存钱但担心急用取不出来时，使用 discovery/proposal/objection + liquidity/duration + needs_discovery + tradeoff_disclosure + fact_sensitive_routing + long_term_savings_liquidity。',
          '客户说买保险反而会生病或类似忌讳时，使用 discovery/objection + trust/risk_pooling + plain_language_explanation + reputation_objection + insurance_superstition。',
          '保险事实和保障缺口交给 Insurance Expert；销售阶段、客户关注点、跟进策略归 Sales Champion。',
          '明确拒绝或要求停止联系时设置对应 signals，不得选择促成类能力。',
          'JSON 字段必须完整：contractVersion, turnRelation, customerCase, customerStatements, kycFacts, customerLabels, stage, concerns, signals, missingInformation, unknownInformation, answeredInformation, proposedCapabilities, insuranceNeeds, situations。',
          'contractVersion 必须是 JSON 数字 1，不能是字符串。confidence 必须是 0 到 1 的 JSON 数字。',
          'insuranceNeeds 每项格式为 {"type":"product_facts|coverage_gap","queryAspects":[]}。',
          'kycFacts 每项格式为 {"key":"受控字段","value":"简短结构化值","source":"证据来源","evidence":"逐字证据"}。',
          'customerLabels 每项格式为 {"dimension":"标签维度","value":"受控标签值","status":"confirmed|candidate","source":"证据来源","evidence":"逐字证据","confidence":0.9}。',
          '完整 JSON 形状必须是：',
          '{"contractVersion":1,"turnRelation":{"value":"new_request","confidence":0.9},"customerCase":{"relation":"new_customer","confidence":0.9},"customerStatements":[{"text":"逐字摘录的原句","source":"current_message"}],"kycFacts":[],"customerLabels":[],"stage":{"value":"discovery","confidence":0.9},"concerns":[{"type":"unknown","priority":"primary","confidence":0.9}],"signals":{"explicitRefusal":false,"stopContact":false,"factSensitive":false},"missingInformation":["customer_goal"],"unknownInformation":[],"answeredInformation":[],"proposedCapabilities":["needs_discovery"],"insuranceNeeds":[],"situations":[]}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          activeCustomerKyc,
          history: safeHistory,
          currentQuestion: safeQuestion,
        }),
      },
    ],
    sourceTexts: [safeQuestion, ...safeHistory.map((message) => message.content)],
  };
}

export async function interpretSalesChampionTurn({
  question = '',
  history = [],
  activeCustomerKyc = null,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const apiKey = text(env.DEEPSEEK_API_KEY || env.FAMILY_SALES_CHAT_API_KEY);
  if (!apiKey) {
    throw Object.assign(new Error('SALES_CHAMPION_INTERPRETER_NOT_READY'), {
      code: 'SALES_CHAMPION_INTERPRETER_NOT_READY', status: 503,
    });
  }
  const baseUrl = text(env.DEEPSEEK_BASE_URL || env.FAMILY_SALES_CHAT_BASE_URL) || 'https://api.deepseek.com';
  const model = text(env.SALES_CHAMPION_INTERPRETER_MODEL || env.FAMILY_AGENT_SKILL_ROUTER_MODEL) || 'deepseek-v4-flash';
  const timeoutMs = numberOrDefault(env.SALES_CHAMPION_INTERPRETER_TIMEOUT_MS, 30_000);
  const { messages, sourceTexts } = interpreterMessages({ question, history, activeCustomerKyc });
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const complete = async (requestMessages) => {
      const response = await fetchImpl(new URL('/chat/completions', baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(sanitizeDeepSeekRequestBody({
          model,
          max_tokens: INTERPRETER_MAX_TOKENS,
          temperature: 0,
          response_format: { type: 'json_object' },
          thinking: { type: 'disabled' },
          messages: requestMessages,
        })),
      });
      if (!response.ok) {
        throw Object.assign(new Error(`SALES_CHAMPION_INTERPRETER_UPSTREAM_${response.status}`), {
          code: 'SALES_CHAMPION_INTERPRETER_UPSTREAM_FAILED', status: 502,
        });
      }
      const payload = await response.json();
      return text(payload?.choices?.[0]?.message?.content);
    };

    const firstContent = await complete(messages);
    try {
      return validateSalesTurnProposal(
        applyTurnRelation(
          normalizeGroundedProposal(parseJson(firstContent), sourceTexts),
          question,
        ),
        { sourceTexts },
      );
    } catch (validationError) {
      const repairedContent = await complete([
        ...messages,
        { role: 'assistant', content: firstContent },
        {
          role: 'user',
          content: `上一份 JSON 未通过 contract 校验：${text(validationError?.message).slice(0, 300)}。只修正 JSON 结构和枚举值；不得改变原问题含义，不得添加无必要的 insuranceNeeds。仅返回修正后的完整 JSON。`,
        },
      ]);
      return validateSalesTurnProposal(
        applyTurnRelation(
          normalizeGroundedProposal(parseJson(repairedContent), sourceTexts),
          question,
        ),
        { sourceTexts },
      );
    }
  } catch (error) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error('SALES_CHAMPION_INTERPRETER_TIMEOUT'), {
        code: 'SALES_CHAMPION_INTERPRETER_TIMEOUT', status: 504,
      });
    }
    if (error?.code) throw error;
    throw Object.assign(new Error('SALES_CHAMPION_INTERPRETER_INVALID_RESPONSE', { cause: error }), {
      code: 'SALES_CHAMPION_INTERPRETER_INVALID_RESPONSE', status: 502,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}
