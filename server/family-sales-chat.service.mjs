import {
  enforceVerifiedCashflowAmounts,
  familySalesReviewDirectIdentifiers,
  privacySafeFamilySalesReviewInputJson,
  restoreFamilySalesReviewDisplayText,
} from './family-sales-review.service.mjs';
import { buildDeepSeekChatCompletionsUrl, sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { salesChampionPromptRules } from './sales-champion-skill-registry.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_REASONING_EFFORT = 'high';
const OPEN_CONSULTATION_MAX_TOKENS = 2_500;
const HISTORY_LIMIT = 20;
const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const FAMILY_SALES_CHAT_PUBLIC_IDENTITY = '保险营销专家';
const FAMILY_SALES_CHAT_IDENTITY_REPLY = `我是${FAMILY_SALES_CHAT_PUBLIC_IDENTITY}，可以帮你做保险需求分析、客户沟通话术和销售建议。`;
const FAMILY_SALES_CHAT_IDENTITY_MODEL = 'identity_guard';

function trim(value) {
  return String(value || '').trim();
}

function withCode(error, code, status) {
  error.code = code;
  if (status) error.status = status;
  return error;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isFamilySalesChatIdentityQuestion(question = '') {
  const text = trim(question);
  if (!text) return false;
  const identityPattern = /(你是谁|你是.*谁|你是什么|你叫.*什么|介绍.*自己|自我介绍|什么.*模型|哪.*模型|大模型|语言模型|\bai\b|人工智能|机器人|谁开发|哪家公司|供应商|底层|\bapi\b|deep\s*seek|deepseek|深度求索|who are you|what model|which model|\bllm\b)/iu;
  if (!identityPattern.test(text)) return false;

  const explicitIdentityPattern = /(你是谁|你是.*谁|你是什么|什么.*模型|哪.*模型|大模型|语言模型|deep\s*seek|deepseek|深度求索|who are you|what model|which model|\bllm\b)/iu;
  const businessPattern = /(话术|方案|保障|保单|客户|预算|异议|责任|条款|缺口|面谈|销售建议|分析|产品|保险|资料|核实|复盘|重算|报告)/u;
  return explicitIdentityPattern.test(text) || !businessPattern.test(text);
}

function sanitizeFamilySalesChatPublicIdentity(content = '') {
  return trim(content)
    .replace(/\bdeep\s*seek(?:[-_\s]*[a-z0-9]+)*/giu, FAMILY_SALES_CHAT_PUBLIC_IDENTITY)
    .replace(/深度求索/gu, FAMILY_SALES_CHAT_PUBLIC_IDENTITY)
    .replace(/保险营销专家\s*(?:大模型|模型|AI|人工智能|agent|Agent)/gu, FAMILY_SALES_CHAT_PUBLIC_IDENTITY);
}

function sanitizeFamilySalesChatInternalFields(content = '') {
  return trim(content).replace(
    /`?(?:familyInput|consultationScope|sourceUpdated|latestSalesReview|latestFamilyReport|salesMemoryContext|policyImportContext|productMentions|officialFactNeeds|insuranceExpertEvidence|salesTurn)`?/gu,
    '现有资料',
  );
}

function isAdvisorCorrectionOrContextUpdate(question = '') {
  const value = trim(question).replace(/\s+/gu, '');
  return /(?:人家|客户).{0,24}(?:没|没有|并没|并没有)(?:明确)?(?:说|表示|提到|提过|想|想要|要求)/u.test(value)
    || /(?:是我|也是我|只是我).{0,20}(?:沟通|问|引导|推|判断|觉得|猜).{0,8}(?:出来|的)/u.test(value)
    || /(?:你理解错|不是这个意思|我补充(?:一下)?|纠正(?:一下)?|实际(?:上|情况)|前面说得不对)/u.test(value)
    || /(?:你|你这|你刚才|你前面).{0,50}(?:理解错|搞错|弄错|说错|答错|不对|啥逻辑|什么逻辑|什么关系)/u.test(value)
    || /^(?:人家|客户|他|她|这|那|前面|之前).{0,80}(?:不是|难道).{1,80}(?:吗|嘛|呢)[？?]?$/u.test(value);
}

function needsUnsupportedInferenceReview(content = '') {
  const value = trim(content);
  return /(?:说明|代表|意味着).{0,40}(?:客户|他|她|不想|担心|害怕|怕|信任|体谅|会躲)/u.test(value)
    || /(?:体谅你|不想让你破费|怕欠人情|会躲|欠了人情|不好拒绝)/u.test(value);
}

function hasInventedCustomerManagementDetail(content = '') {
  const value = trim(content);
  return /(?:隔|等|连续).{0,8}(?:天|周|次)|(?:咖啡|行业新闻|行业资讯|行业文章|刚好.{0,8}附近|带杯|好书、好文章)/u.test(value);
}

function customerManagementKycFallback(context = {}) {
  const questions = (Array.isArray(context?.salesTurn?.navigation?.questionPlan)
    ? context.salesTurn.navigation.questionPlan : []).map((item) => item?.question).filter(Boolean);
  if (!questions.length) return '';
  return [
    '先别急着替这个客户定经营动作。现在能确认的是业务员提供的客观情况；拒绝礼物、工作忙或关系不错本身，不能说明客户为什么这样做，也不能直接判断该进入保险沟通还是继续关系维护。',
    '',
    '我先确认几个会改变客户标签和 Skill 的信息，知道多少说多少：',
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    '如果这些都不知道也没关系，先把对应标签保持为待确认。系统仍会根据已有事实给出建议；有了新事实再更新标签和候选 Skill 排序。',
  ].join('\n');
}

function buildUnsupportedInferenceReviewMessages({ context = {}, question = '', draft = '' } = {}) {
  const proposal = context?.salesTurn?.proposal || {};
  const groundedFacts = (Array.isArray(proposal.kycFacts) ? proposal.kycFacts : [])
    .filter((fact) => !['advisor_estimate', 'advisor_inference'].includes(fact?.source));
  const requiredQuestions = (Array.isArray(context?.salesTurn?.navigation?.questionPlan)
    ? context.salesTurn.navigation.questionPlan : []).map((item) => item?.question).filter(Boolean);
  return [{
    role: 'system',
    content: [
      '你是销冠回答的证据复核员。只输出修订后的完整中文回答，不解释复核过程。',
      '删除所有没有客户原话或明确顾问事实支持的心理动机、因果、信任、意向和行为预测；不要用“可能”换一种方式继续猜。',
      '删除草稿中顾问没有提供的称呼、精确联系频率、等待天数、行业资讯、政策话题、礼物饮品、路过理由、活动细节和见面时长；不能把这些包装成客户经营建议。只保留有证据的客户背景和不依赖未知事实的原则性动作。',
      '校准客户话术的关系距离：普通业务关系就说普通业务话，不得写成亲友、知己、陪伴者或心理咨询式表达。不要用顾问的自我感动、示弱或表忠心换客户回应，不要宣称“惦记、想起、一直记着、尊敬、按您舒服的节奏、买不买都由您”等没有真实关系依据的话。',
      '校准身份和辈分：不得用上级管理下级、老师教育学生、咨询师安抚来访者的口吻替客户安排节奏、授予选择权或评价其生活。面对长辈、老师或资深客户要礼貌克制、就事论事，不居高临下，也不刻意奉承。',
      '客户话术必须有真实、简短、说得出口的联系理由；没有合适理由时可以只做正常问候，不得虚构整理资料、路过、活动、礼物或其他由头。',
      'requiredQuestions 只是结构化层提出的候选 KYC 问题。结合 advisorQuestion、groundedFacts 和 customerEvidence 删除已经被回答的问题；未被回答且确实会改变本轮建议的问题才原样保留，不得换题或新增其他问题。',
      '待确认标签只参与候选 Skill 评分，不得被改写成禁止或许可结论；只有客户明确停止营销或停止联系才是硬边界。',
    ].join('\n'),
  }, {
    role: 'user',
    content: JSON.stringify({
      advisorQuestion: trim(question),
      groundedFacts,
      customerEvidence: proposal.customerStatements || [],
      requiredQuestions,
      draft: trim(draft),
    }),
  }];
}

function resolveFamilySalesChatConfig(env = process.env) {
  return {
    apiKey: trim(env.DEEPSEEK_API_KEY || env.FAMILY_SALES_CHAT_API_KEY),
    baseUrl: trim(env.DEEPSEEK_BASE_URL || env.FAMILY_SALES_CHAT_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
    model: trim(env.FAMILY_SALES_CHAT_MODEL || env.DEEPSEEK_FAMILY_REVIEW_MODEL || env.DEEPSEEK_MODEL) || DEFAULT_MODEL,
    timeoutMs: numberOrDefault(env.FAMILY_SALES_CHAT_TIMEOUT_MS || env.DEEPSEEK_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxTokens: numberOrDefault(env.FAMILY_SALES_CHAT_MAX_TOKENS, DEFAULT_MAX_TOKENS),
  };
}

function compactMarkdown(value = '', limit = 12_000) {
  const text = trim(value).replace(/\n{3,}/gu, '\n\n');
  return text.length > limit ? `${text.slice(0, limit)}\n\n[内容已截断，仅保留前文重点]` : text;
}

function latestActive(records = [], familyId) {
  return (Array.isArray(records) ? records : [])
    .filter((record) => (
      Number(record?.familyId || 0) === Number(familyId || 0) &&
      String(record?.status || 'active') === 'active'
    ))
    .sort((left, right) => (
      String(right.generatedAt || right.updatedAt || right.createdAt || '').localeCompare(String(left.generatedAt || left.updatedAt || left.createdAt || '')) ||
      Number(right.id || 0) - Number(left.id || 0)
    ))[0] || null;
}

function reportSummary(reportRecord = null) {
  if (!reportRecord) return null;
  return {
    id: reportRecord.id,
    generatedAt: reportRecord.generatedAt || reportRecord.createdAt || '',
    updatedAt: reportRecord.updatedAt || '',
    summary: reportRecord.summary || reportRecord.report?.summary || {},
    radar: reportRecord.report?.radar || {},
    policyInventory: reportRecord.report?.policyInventory || {},
    criticalIllness: reportRecord.report?.criticalIllness || {},
    accident: reportRecord.report?.accident || {},
    wealth: reportRecord.report?.wealth || {},
    familyPolicyAnalysisReport: reportRecord.report?.familyPolicyAnalysisReport
      ? {
        status: reportRecord.report.familyPolicyAnalysisReport.status || '',
        generatedAt: reportRecord.report.familyPolicyAnalysisReport.generatedAt || '',
        content: compactMarkdown(reportRecord.report.familyPolicyAnalysisReport.content || '', 8_000),
      }
      : null,
  };
}

function changedAfter(value = '', baseline = '') {
  const left = trim(value);
  const right = trim(baseline);
  return Boolean(left && right && left > right);
}

export function buildFamilySalesChatContext({
  input,
  family,
  members = [],
  policies = [],
  familyReports = [],
  familySalesReviews = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const latestReview = latestActive(familySalesReviews, family?.id);
  const latestReport = latestActive(familyReports, family?.id);
  const baseline = latestReview?.generatedAt || latestReview?.updatedAt || latestReview?.createdAt || '';
  const sourceUpdated = Boolean(
    changedAfter(family?.updatedAt, baseline) ||
    (Array.isArray(members) ? members : []).some((member) => changedAfter(member?.updatedAt, baseline)) ||
    (Array.isArray(policies) ? policies : []).some((policy) => changedAfter(policy?.updatedAt, baseline)),
  );
  return {
    generatedAt,
    sourceUpdated,
    familyInput: input || {},
    latestSalesReview: latestReview
      ? {
        id: latestReview.id,
        generatedAt: latestReview.generatedAt || latestReview.createdAt || '',
        inputSummary: latestReview.inputSummary || {},
        content: compactMarkdown(latestReview.content || ''),
      }
      : null,
    latestFamilyReport: reportSummary(latestReport),
  };
}

function normalizeHistory(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => ['user', 'assistant'].includes(String(message?.role || '')))
    .sort((left, right) => (
      String(left.createdAt || '').localeCompare(String(right.createdAt || '')) ||
      Number(left.id || 0) - Number(right.id || 0)
    ))
    .slice(-HISTORY_LIMIT)
    .map((message) => ({
      role: String(message.role),
      content: trim(message.content),
    }))
    .filter((message) => message.content);
}

function privacySafeChatContextJson(context = {}) {
  const source = context && typeof context === 'object' && !Array.isArray(context) ? context : {};
  const familyInput = source.familyInput && typeof source.familyInput === 'object' && !Array.isArray(source.familyInput)
    ? JSON.parse(privacySafeFamilySalesReviewInputJson(source.familyInput))
    : source.familyInput || {};
  return JSON.stringify({ ...source, familyInput }, null, 2);
}

export function buildFamilySalesChatMessages({
  context,
  history = [],
  question = '',
} = {}) {
  const normalizedHistory = normalizeHistory(history);
  const advisorCorrection = context?.salesTurn?.proposal?.turnRelation?.value === 'correction'
    || isAdvisorCorrectionOrContextUpdate(question);
  const openConsultation = context?.consultationScope === 'open';
  const promptHistory = normalizedHistory;
  if (advisorCorrection) {
    return [
      {
        role: 'system',
        content: [
          '你是与保险顾问复盘客户的销冠。本轮顾问正在纠正你对前文的理解。',
          '所有 user 消息的说话人都是保险顾问，不是客户。没有“客户说、客户原话是”等明确引述时，顾问当前补充只能记作顾问提供的事实，不能改写成客户原话、异议、态度、购买信号或拒绝信号。',
          '先自然承认刚才哪里理解错了，再用一两句话说清修正后的事实，以及旧判断为什么不再成立。不要输出内部标签、路由、Skill 或审计说明。',
          '如果顾问本轮没有明确提出新的问题或任务，到事实纠正为止：不要继续分析客户心理，不要生成跟进方案、客户话术、追问或产品建议，也不要补充顾问没说过的金额含义、称呼、活动细节和保险事实。',
          '只有顾问在纠正之外同时明确提出了新问题，才基于修正后的事实回答那个问题；仍不得恢复已被纠正的旧假设。',
        ].join('\n'),
      },
      ...promptHistory,
      { role: 'user', content: trim(question) },
    ];
  }
  const promptContext = context;
  const contextJson = privacySafeChatContextJson(promptContext || {});
  const hasStructuredSalesTurn = Boolean(context?.salesTurn?.proposal);
  const selectedSkillRules = salesChampionPromptRules(context?.salesTurn?.selection);
  const selectedTrainingRules = (Array.isArray(context?.salesTurn?.trainingPacks)
    ? context.salesTurn.trainingPacks : [])
    .flatMap((pack) => Array.isArray(pack?.promptRules) ? pack.promptRules : [])
    .filter((rule) => typeof rule === 'string' && rule.trim());
  return [
    {
      role: 'system',
      content: [
        openConsultation
          ? '你是一名保险营销专家，面向保险顾问提供开放式客户需求分析、产品方向建议和销售辅导。'
          : '你是一名保险营销专家，面向保险顾问提供家庭销售建议续聊支持。',
        hasStructuredSalesTurn
          ? '结构化层只提供候选理解和参考 Skills，不决定最终答案。你必须先结合完整对话确认业务员本轮真正要解决什么，不得重新按关键词判断意图或 Skill；候选阶段、顾虑或 Skill 与对话冲突时可以纠正或忽略。'
          : '本轮没有结构化销售 turn，仍由你根据完整对话直接理解并回答，不得为了套模板而虚构销售阶段或客户意图。',
        openConsultation
          ? '当前没有绑定家庭档案。你要基于本轮客户描述进行专业分析；信息不足时仍先给出不依赖未知事实的跟进方法，再自然追问，不能假定存在未提供的家庭、保单或产品资料。'
          : '你要基于当前家庭、保单、家庭保障报告、最近销售建议、官网责任证据和本轮对话继续回答顾问追问。',
        '必须遵守：',
        '1. 只使用输入上下文和对话历史中的事实；收入、负债、预算、责任条款、现金价值、分红、领取利益缺少证据时写“待核实”。',
        '2. 不承诺收益、分红、利率、理赔、核保、法律或税务结果。',
        '3. 如果 sourceUpdated=true，开头用一句话提醒“资料已更新，建议重新核实关键数据”。',
        '4. 输出给顾问使用，可以生成微信话术、面谈提纲、异议处理、补资料清单和下一步动作，但不能自动发送。',
        '5. 每个关键判断尽量说明依据来自“保单字段/家庭报告/销售建议/家庭责任信息/官网证据”。',
        '6. 不要输出身份证号、手机号、证件号变量或内部字段名；看到脱敏变量只写“已脱敏”。',
        '7. 客户话术要温和、专业、可复制，避免恐吓式销售。',
        `8. 对身份、模型、厂商、API、底层大模型等问题，只能回答“${FAMILY_SALES_CHAT_IDENTITY_REPLY}”，不得自称任何底层模型或模型品牌。`,
        '9. 如果上下文包含 salesMemoryContext，只能把它当作当前家庭的跟进记忆，用于沟通风格、已确认异议、策略偏好和待办；保单事实、责任条款、金额、收益仍以当前家庭数据和官网证据为准。',
        '10. 如果上下文包含 policyImportContext，它是 OCR Insurance 输出的脱敏保单草稿；只能引用其中已提供字段，并明确提示 missingFields。不得推测被掩码身份、保单号、证件号或原始图片内容。',
        '11. 开放式产品推荐不得从历史对话中擅自绑定某一款产品；缺少已核验候选产品及客户目标时，先给产品方向和需要确认的问题，再由受控产品知识流程核验具体产品。',
        '12. 不得向用户展示上下文 JSON 的字段名、内部变量名、数据结构或系统实现；只能用自然语言说明“现有资料”“已提供信息”或“待补充信息”。',
        '13. 用户提到的保险公司或产品名称只是客户背景线索，不得因此把客户跟进、需求分析、异议处理或沟通话术改成产品检索；本轮最终回答始终围绕顾问的销售问题。',
        '14. 产品名称线索本身不能证明保险责任。只有保险专家证据中标记为 verified 的内容可以作为官方产品事实；没有已核验证据时，把相关责任、续保、领取、现金价值或收益写成“待核实”，但仍要给出不依赖这些事实的跟进策略。',
        '15. 开放式客户跟进要使用 salesTurn.navigation 中已识别的KYC事实和客户标签；严格区分客户事实、顾问估计和待核实项。只讨论与当前流程和 Skill 有关的画像，不得为了完整而逐项盘问年龄、收入、家庭、房产、健康和全部保单。',
        '16. salesTurn.insuranceNeedResults 只表示 Insurance Expert 调用状态；只有对应 insuranceExpertEvidence 为 verified 时才能陈述保险事实或保障缺口。needs_family_or_policy_evidence、needs_resolved_product 或 unavailable 都必须转成待补资料/待核实，而不是自行补全。',
        '17. Sales Champion 始终拥有最终销售回答：Insurance Expert 证据用于理解保险内容和保障缺口，但最终仍要结合销售阶段与客户关注点给出沟通策略。',
        '18. 结构化阶段、顾虑、标签和 Skill 召回结果都是候选参考，不是事实本身。最终判断以完整对话、明确KYC事实和已核验保险证据为准；可以采用、合并或忽略任何候选 Skill。',
        '19. 不得虚构客户姓名、性别、称谓、健康、社保、负债、预算、缴费能力、退休金额、心理状态、财产安排或家庭决策方式。婚姻、居住、房产、子女和产品名称只是背景，除非结构化 concern 或 verified evidence 明确支持，否则不能据此推出结论。',
        '20. 如果存在 salesTurn.navigation.questionPlan，只能追问其中的自然问题；否则才可从 salesTurn.proposal.missingInformation 中选择。不得自行扩展成保单体检、产品核验、法律咨询或保障缺口分析。',
        '21. 开放式咨询控制在1200个中文字符以内，不使用复杂表格；像一线业务员复盘客户一样，先直说这次怎么推进，再给一段能直接复制的话和下一步问题。',
        '22. 即使客户信息不完整，也必须先根据已有信息直说下一步怎么跟，再给至少一个可立即执行的动作或话术；不得把补充信息作为开始分析的前置条件。',
        '23. 补充信息只能放在已有建议之后并遵守 navigation.questionPlan 的回答负担；多个低成本短事实可以合并，高成本资料一次只问一项。不得只输出问题清单、资料清单或让用户补充完整信息后再回答。',
        '24. 最终回答使用业务员日常说法和短句，少讲概念、少复述资料。不得使用“客户理解、当前阶段、优先确认、建议进一步、综合来看、需求发现阶段”等课件式小标题或套话。除非顾问明确要分析报告，否则至少给一段可直接发给客户的原话。',
        ...(selectedSkillRules.length ? [
          '',
          '候选能力的边界参考（仅在符合完整对话时采用）：',
          ...selectedSkillRules.map((rule, index) => `${index + 1}. ${rule}`),
        ] : []),
        ...(selectedTrainingRules.length ? [
          '',
          '本轮已审核培训方法：',
          ...selectedTrainingRules.map((rule, index) => `${index + 1}. ${rule}`),
        ] : []),
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '以下是本次续聊可用上下文 JSON：',
        contextJson,
        '',
        '请围绕顾问的问题继续输出。若需要话术，请给可直接复制的中文内容；若需要分析，请先给结论再给依据和待核实项。',
      ].join('\n'),
    },
    ...promptHistory,
    {
      role: 'user',
      content: trim(question),
    },
  ];
}

export async function generateFamilySalesChatReply({
  context,
  history = [],
  question = '',
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const userQuestion = trim(question);
  if (!userQuestion) {
    throw withCode(new Error('请输入要追问的内容'), 'FAMILY_SALES_CHAT_EMPTY_MESSAGE', 400);
  }
  if (isFamilySalesChatIdentityQuestion(userQuestion)) {
    return {
      content: FAMILY_SALES_CHAT_IDENTITY_REPLY,
      model: FAMILY_SALES_CHAT_IDENTITY_MODEL,
      generatedAt: new Date().toISOString(),
    };
  }
  const config = resolveFamilySalesChatConfig(env);
  if (!config.apiKey) {
    throw withCode(new Error('家庭销售续聊服务未配置专家分析服务 API Key'), 'FAMILY_SALES_CHAT_PROVIDER_NOT_READY', 503);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const directIdentifiers = familySalesReviewDirectIdentifiers(context?.familyInput || {});
    const openConsultation = context?.consultationScope === 'open';
    const body = {
      model: config.model,
      max_tokens: openConsultation
        ? Math.min(config.maxTokens, OPEN_CONSULTATION_MAX_TOKENS)
        : config.maxTokens,
      messages: buildFamilySalesChatMessages({ context, history, question: userQuestion }),
    };
    if (DEEPSEEK_V4_MODELS.has(config.model)) {
      if (openConsultation) {
        body.thinking = { type: 'disabled' };
        body.temperature = 0.1;
      } else {
        body.thinking = { type: 'enabled' };
        body.reasoning_effort = DEFAULT_REASONING_EFFORT;
      }
    } else {
      body.temperature = 0.2;
    }

    const response = await fetchImpl(buildDeepSeekChatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(sanitizeDeepSeekRequestBody(
        body,
        directIdentifiers,
      )),
    });
    if (!response.ok) {
      const bodyText = trim(await response.text());
      throw withCode(
        new Error(`FAMILY_SALES_CHAT_UPSTREAM_${response.status}:${bodyText || 'upstream_error'}`),
        'FAMILY_SALES_CHAT_UPSTREAM_FAILED',
        502,
      );
    }
    const payload = await response.json();
    const upstreamContent = trim(payload?.choices?.[0]?.message?.content);
    if (!upstreamContent) {
      throw withCode(new Error('FAMILY_SALES_CHAT_EMPTY_RESPONSE'), 'FAMILY_SALES_CHAT_EMPTY_RESPONSE', 502);
    }
    let sanitizedContent = sanitizeFamilySalesChatInternalFields(
        sanitizeFamilySalesChatPublicIdentity(
          restoreFamilySalesReviewDisplayText(
            enforceVerifiedCashflowAmounts(upstreamContent, context?.familyInput || {}),
            context?.familyInput || {},
          ),
        ),
      );
    const customerManagementReview = ['contact', 'appointment'].includes(
      context?.salesTurn?.proposal?.stage?.value,
    ) && Array.isArray(context?.salesTurn?.navigation?.questionPlan)
      && context.salesTurn.navigation.questionPlan.length > 0;
    if (openConsultation && (customerManagementReview
      || needsUnsupportedInferenceReview(sanitizedContent))) {
      const reviewBody = {
        model: config.model,
        max_tokens: Math.min(config.maxTokens, OPEN_CONSULTATION_MAX_TOKENS),
        messages: buildUnsupportedInferenceReviewMessages({
          context,
          question: userQuestion,
          draft: sanitizedContent,
        }),
        temperature: 0,
      };
      if (DEEPSEEK_V4_MODELS.has(config.model)) reviewBody.thinking = { type: 'disabled' };
      const reviewResponse = await fetchImpl(new URL('/chat/completions', config.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(sanitizeDeepSeekRequestBody(reviewBody, directIdentifiers)),
      });
      if (reviewResponse.ok) {
        const reviewPayload = await reviewResponse.json();
        const reviewedContent = trim(reviewPayload?.choices?.[0]?.message?.content);
        if (reviewedContent) sanitizedContent = sanitizeFamilySalesChatInternalFields(
          sanitizeFamilySalesChatPublicIdentity(reviewedContent),
        );
      }
    }
    if (customerManagementReview && (needsUnsupportedInferenceReview(sanitizedContent)
      || hasInventedCustomerManagementDetail(sanitizedContent))) {
      sanitizedContent = customerManagementKycFallback(context) || sanitizedContent;
    }
    return {
      content: sanitizedContent,
      model: trim(payload?.model || config.model) || config.model,
      generatedAt: new Date().toISOString(),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw withCode(new Error('家庭销售续聊生成超时'), 'FAMILY_SALES_CHAT_TIMEOUT', 504);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
