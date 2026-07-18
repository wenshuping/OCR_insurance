import {
  enforceVerifiedCashflowAmounts,
  familySalesReviewDirectIdentifiers,
  privacySafeFamilySalesReviewInputJson,
  restoreFamilySalesReviewDisplayText,
} from './family-sales-review.service.mjs';
import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { salesChampionPromptRules } from './sales-champion-skill-registry.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_REASONING_EFFORT = 'high';
const OPEN_CONSULTATION_MAX_TOKENS = 2_500;
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
    /`?(?:familyInput|consultationScope|sourceUpdated|latestSalesReview|latestFamilyReport|salesMemoryContext|policyImportContext|productMentions|officialFactNeeds|insuranceExpertEvidence|salesTurn)`?/gu,
    '现有资料',
  );
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
  const contextJson = privacySafeChatContextJson(context || {});
  const normalizedHistory = normalizeHistory(history);
  const openConsultation = context?.consultationScope === 'open';
  const hasStructuredSalesTurn = Boolean(context?.salesTurn?.proposal);
  const selectedSkillRules = salesChampionPromptRules(context?.salesTurn?.selection);
  return [
    {
      role: 'system',
      content: [
        openConsultation
          ? '你是一名保险营销专家，面向保险顾问提供开放式客户需求分析、产品方向建议和销售辅导。'
          : '你是一名保险营销专家，面向保险顾问提供家庭销售建议续聊支持。',
        hasStructuredSalesTurn
          ? '本轮销售阶段、客户关注点、缺失信息和受控 Skills 已由 Sales Champion 的结构化 turn contract 校验；必须按该结构化结果执行，不得重新按关键词判断意图或 Skill。'
          : '本轮没有结构化销售 turn，只能使用通用销售澄清能力，不得根据关键词自行选择更具体的 Skill。',
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
        '16. salesTurn.insuranceNeedResults 只表示 Insurance Expert 调用状态；只有对应 insuranceExpertEvidence 为 verified 时才能陈述保险事实或保障缺口。needs_family_or_policy_evidence、needs_resolved_product 或 unavailable 都必须转成待补资料/待核实，而不是自行补全。',
        '17. Sales Champion 始终拥有最终销售回答：Insurance Expert 证据用于理解保险内容和保障缺口，但最终仍要结合销售阶段与客户关注点给出沟通策略。',
        '18. 输出遵守结构化 Skill 的 executionContract：客户已表达事实、销售阶段或异议解读、可执行沟通建议或话术、需要核验的保险事实、以及不确定边界。',
        '19. 不得虚构客户姓名、性别、称谓、健康、社保、负债、预算、缴费能力、退休金额、心理状态、财产安排或家庭决策方式。婚姻、居住、房产、子女和产品名称只是背景，除非结构化 concern 或 verified evidence 明确支持，否则不能据此推出结论。',
        '20. 只追问 salesTurn.proposal.missingInformation 中列出的缺失信息；不得自行扩展成保单体检、产品核验、法律咨询或保障缺口分析。',
        '21. 开放式咨询控制在1200个中文字符以内，不使用复杂表格；优先给客户理解、当前销售目标、一段话术和下一步问题。',
        ...(selectedSkillRules.length ? [
          '',
          '本轮受控 Skill 执行规则：',
          ...selectedSkillRules.map((rule, index) => `${index + 1}. ${rule}`),
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
    return {
      content: sanitizeFamilySalesChatInternalFields(
        sanitizeFamilySalesChatPublicIdentity(
          restoreFamilySalesReviewDisplayText(
            enforceVerifiedCashflowAmounts(upstreamContent, context?.familyInput || {}),
            context?.familyInput || {},
          ),
        ),
      ),
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
