import {
  enforceVerifiedCashflowAmounts,
  familySalesReviewDirectIdentifiers,
  privacySafeFamilySalesReviewInputJson,
  restoreFamilySalesReviewDisplayText,
} from './family-sales-review.service.mjs';
import {
  selectAgentSkillPrompt,
  selectAgentSkillPromptWithDeepSeek,
} from './agent-skill-router.service.mjs';
import {
  redactDeepSeekDirectIdentifiers,
  sanitizeDeepSeekRequestBody,
} from './deepseek-privacy-gateway.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 8_000;
const OPEN_CONSULTATION_MAX_TOKENS = 2_500;
const DEFAULT_REASONING_EFFORT = 'high';
const OPEN_CONSULTATION_REASONING_EFFORT = 'low';
const HISTORY_LIMIT = 12;
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
    /`?(?:familyInput|consultationScope|sourceUpdated|latestSalesReview|latestFamilyReport|salesMemoryContext|policyImportContext|productMentions|officialFactNeeds|insuranceExpertEvidence)`?/gu,
    '现有资料',
  );
}

function openConsultationReplyCrossesFactBoundary(content = '') {
  const text = trim(content);
  return [
    /(?:从名称看|推断为|初步判断为)[^。\n]{0,30}(?:医疗险|重疾险|年金险|增额终身寿险|储蓄险)/u,
    /客户已(?:拥有|配置|购买)[^。\n]{0,50}(?:医疗险|重疾险|年金险|增额终身寿险|储蓄险)/u,
    /(?:养老焦虑|孤独养老|财产(?:归属|分割|独立)|保单(?:所有权|控制权)|法律风险)/u,
    /共同决策[^。\n]{0,15}(?:较低|不需要|由本人)/u,
    /收入(?:属|属于)(?:中等|较低|较高)水平/u,
    /缴费能力(?:强|弱|有限|不足)/u,
    /房产[^。\n]{0,20}(?:退路|变现|补充养老金)/u,
  ].some((pattern) => pattern.test(text));
}

function safeOpenConsultationReply() {
  return [
    '客户画像',
    '本轮提供的客户背景、现有保单线索和关注点都已按原话保留。凡是顾问估计的信息仍按估计处理；产品的准确名称、险种和责任都要以保单为准。',
    '',
    '当前判断',
    '这次先不要急着推荐或比较产品。下一次沟通的目标，是确认客户想要怎样的养老生活、目前已经做了哪些准备、真实收支能否支持长期安排，以及后续决策需要谁参与。婚姻、居住、房产和子女等信息如本轮有提到，也只作为背景，不直接推出财产、保障缺口或购买能力结论。',
    '',
    '下次沟通话术',
    '“您好，上次您提到比较在意养老，我想先不急着谈新产品，先帮您把现在的准备理清楚。您希望以后在哪里生活、每个月大概需要多少生活费？您提到的几份保单也可以一起看一下，确认它们分别是什么、现在交到哪一步。把这些信息弄清楚后，我们再判断有没有需要调整的地方，您看可以吗？”',
    '',
    '优先核实',
    '1. 理想养老地点、时间和生活方式。',
    '2. 现有保单的准确名称、保单状态、缴费和领取信息。',
    '3. 实际收入、固定开支、社保和可持续预算。',
    '4. 房产未来是自住、出租还是暂未决定。',
    '5. 养老安排是否需要与家人共同商量。',
  ].join('\n');
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
  skillPrompt = null,
} = {}) {
  const contextJson = privacySafeChatContextJson(context || {});
  const normalizedHistory = normalizeHistory(history);
  const resolvedSkillPrompt = skillPrompt || selectAgentSkillPrompt({ scene: 'family_sales_chat', question });
  const openConsultation = context?.consultationScope === 'open';
  if (openConsultation) {
    return [
      {
        role: 'system',
        content: [
          '你是一名保险营销专家。本轮唯一任务是理解顾问描述的客户，并设计下一次跟进沟通；不是查询产品、判断保障缺口、出保险方案或分析婚姻法律关系。',
          '严格遵守以下规则：',
          '1. 只使用本轮原话中的事实。画像分清“客户明确事实”“顾问估计”“待核实”，不得把推测写成事实。',
          '2. 产品只按顾问原话记录为“客户提到的产品线索”。没有 verified 保险专家证据时，不得根据名称猜险种，不得描述责任、续保、收益、现金价值、领取或替换建议；“年金险或者增额终身寿险”必须保留尚未确定的状态。',
          '3. 分居只是一条客户事实。不得推断财产归属、保单控制权、配偶是否参与决策、法律风险或客户心理；可以中性询问未来养老安排是否需要与家人共同商量。',
          '4. 不得虚构客户姓名、称谓、性别、健康、社保、负债、预算、退休金额、缴费能力、传承需求或养老恐惧。话术统一使用“您好”或“您”。',
          '5. 资料不足时，不得判定任何保障严重缺失，不得推荐具体险种、产品、保费比例或退换保。当前目标是弄清客户想要的养老生活、现有保单、实际收支和下一步决策方式。',
          '6. 当前完整问题优先于历史里的旧产品确认或候选列表；不得要求顾问继续回复产品序号，除非本轮就是数字选择。',
          '7. 输出不超过1200个中文字符，不使用表格，固定为四段：客户画像、当前判断、下次沟通话术、优先核实（最多5项）。话术只给一段，语气自然，不制造焦虑。',
          `8. 对身份、模型、厂商、API、底层大模型等问题，只能回答“${FAMILY_SALES_CHAT_IDENTITY_REPLY}”。`,
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          '以下是可用的辅助线索；其中产品名称不代表已核实的保险事实：',
          contextJson,
        ].join('\n'),
      },
      ...normalizedHistory,
      {
        role: 'user',
        content: trim(question),
      },
      {
        role: 'system',
        content: [
          '输出前做最后事实检查：',
          '- 若辅助线索中没有已核验产品证据，所有产品名称最多只能在“客户画像”中原样记为产品线索；不得在“当前判断”或话术中把它写成医疗险、年金、储蓄、健康保障或任何其他险种/功能。',
          '- 不得根据分居、租房、有房、无子女推导财产、缴费能力、传承需求或心理结论。',
          '- 删除所有不是客户原话、顾问明确估计或中性待核实问题的陈述。',
        ].join('\n'),
      },
    ];
  }
  return [
    {
      role: 'system',
      content: [
        openConsultation
          ? '你是一名保险营销专家，面向保险顾问提供开放式客户需求分析、产品方向建议和销售辅导。'
          : '你是一名保险营销专家，面向保险顾问提供家庭销售建议续聊支持。',
        resolvedSkillPrompt.promptHint,
        `本轮启用 skills：${resolvedSkillPrompt.skills.map((skill) => skill.label).join('、') || '通用保险续聊'}`,
        openConsultation
          ? '当前没有绑定家庭档案。你要基于本轮客户描述进行专业分析；信息不足时自然追问，不能假定存在未提供的家庭、保单或产品资料。'
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
        '15. 开放式客户跟进要先根据顾问本轮原话形成客户画像，逐项覆盖已明确的年龄或人生阶段、工作与收入、婚姻及共同决策关系、居住和房产、子女或赡养责任、现有保障线索、明确关注目标；严格区分客户事实、顾问估计和待核实项，不得因产品名称模糊而忽略其余客户信息。',
        '',
        '本轮 skill 规则：',
        ...resolvedSkillPrompt.systemRules.map((rule, index) => `${index + 1}. ${rule}`),
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
    ...normalizedHistory,
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
    const skillPrompt = openConsultation
      ? null
      : await selectAgentSkillPromptWithDeepSeek({
        scene: 'family_sales_chat',
        question: redactDeepSeekDirectIdentifiers(userQuestion, directIdentifiers),
        fetchImpl,
        config: {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: trim(env.FAMILY_AGENT_SKILL_ROUTER_MODEL || env.DEEPSEEK_SKILL_ROUTER_MODEL || 'deepseek-v4-flash'),
          timeoutMs: numberOrDefault(env.FAMILY_AGENT_SKILL_ROUTER_TIMEOUT_MS, 30_000),
        },
        privacyOptions: directIdentifiers,
      });
    const body = {
      model: config.model,
      max_tokens: openConsultation
        ? Math.min(config.maxTokens, OPEN_CONSULTATION_MAX_TOKENS)
        : config.maxTokens,
      messages: buildFamilySalesChatMessages({ context, history, question: userQuestion, skillPrompt }),
    };
    if (DEEPSEEK_V4_MODELS.has(config.model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = openConsultation
        ? OPEN_CONSULTATION_REASONING_EFFORT
        : DEFAULT_REASONING_EFFORT;
    } else {
      body.temperature = 0.2;
    }

    const response = await fetchImpl(new URL('/chat/completions', config.baseUrl), {
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
    const content = sanitizeFamilySalesChatInternalFields(
      sanitizeFamilySalesChatPublicIdentity(
        restoreFamilySalesReviewDisplayText(
          enforceVerifiedCashflowAmounts(upstreamContent, context?.familyInput || {}),
          context?.familyInput || {},
        ),
      ),
    );
    return {
      content: openConsultation && openConsultationReplyCrossesFactBoundary(content)
        ? safeOpenConsultationReply()
        : content,
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
