import {
  findPolicyCoverageIndicators,
  policyCanonicalProductIds,
  policyProductIndicatorKeys,
} from './policy-ocr.domain.mjs';
import {
  canonicalProductIdForRecord,
  resolveRecordCompany,
  resolveRecordProductName,
} from './canonical-product-id.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 14_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_REASONING_EFFORT = 'high';
const THINKING_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const PRO_MODEL = 'deepseek-v4-pro';

function trim(value) {
  return String(value || '').trim();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function withCode(error, code, status) {
  error.code = code;
  if (status) error.status = status;
  return error;
}

function sanitizeGeneratedContent(value) {
  return trim(value)
    .replace(/\bAI\b/giu, '分析')
    .replace(/人工智能|DeepSeek|大模型|模型/gu, '分析服务');
}

function isInsufficientReport(content = '') {
  const text = trim(content);
  if (text.length < 1200) return true;
  return !/重点保障缺口分析/u.test(text)
    || !/缺口总览|保障类型.*建议额度|建议额度.*已有保障/u.test(text)
    || !/现有保障结构评价|逐张|每张保单|保单/u.test(text);
}

function resolveConfig(env = process.env) {
  return {
    apiKey: trim(env.DEEPSEEK_API_KEY || env.FAMILY_POLICY_ANALYSIS_API_KEY),
    baseUrl: trim(env.DEEPSEEK_BASE_URL || env.FAMILY_POLICY_ANALYSIS_BASE_URL || DEFAULT_DEEPSEEK_BASE_URL),
    model: PRO_MODEL,
    retryAttempts: Math.max(1, numberOrZero(env.FAMILY_POLICY_ANALYSIS_RETRY_ATTEMPTS) || DEFAULT_RETRY_ATTEMPTS),
    timeoutMs: numberOrZero(env.FAMILY_POLICY_ANALYSIS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    maxTokens: numberOrZero(env.FAMILY_POLICY_ANALYSIS_MAX_TOKENS) || DEFAULT_MAX_TOKENS,
  };
}

function normalizeLookupText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .trim();
}

function textExcerpt(value, limit = 360) {
  const text = trim(value).replace(/\s+/gu, ' ');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
}

function sourceUrl(record = {}) {
  return trim(record.officialUrl || record.url || record.sourceUrl || record.source_url || record.fileUrl);
}

function recordProductName(record = {}) {
  return trim(record.productName || record.product_name || resolveRecordProductName(record) || record.name || record.title);
}

function recordCompany(record = {}) {
  return trim(record.company || record.companyName || resolveRecordCompany(record) || record.insurer || record.insurerName);
}

function recordMatchesPolicy(policy = {}, record = {}) {
  const policyCanonicalIds = new Set(policyCanonicalProductIds(policy));
  const recordCanonicalId = canonicalProductIdForRecord(record, policy.company);
  if (policyCanonicalIds.size && recordCanonicalId) {
    return policyCanonicalIds.has(recordCanonicalId);
  }
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return false;
  return keys.has(`${normalizeLookupText(recordCompany(record) || policy.company)}\u001f${normalizeLookupText(recordProductName(record))}`);
}

function knowledgeEvidenceSummary(record = {}) {
  return {
    company: recordCompany(record),
    productName: recordProductName(record),
    productType: trim(record.productType || record.category || record.productCategory),
    title: trim(record.title || record.sourceTitle || record.name),
    official: record.official === true,
    url: sourceUrl(record),
    excerpt: textExcerpt(record.sourceExcerpt || record.excerpt || record.summary || record.content || record.text || record.ocrText, 420),
  };
}

function indicatorEvidenceSummary(record = {}) {
  return {
    coverageType: trim(record.coverageType || record.coverage_type || record.category),
    liability: trim(record.liability || record.name || record.title),
    formulaText: textExcerpt(record.formulaText || record.formula || record.calcText, 260),
    value: record.value ?? '',
    unit: trim(record.unit),
    responsibilityScope: textExcerpt(record.responsibilityScope || record.scope, 260),
    selectionStatus: trim(record.selectionStatus),
    quantificationStatus: trim(record.quantificationStatus),
    sourceUrl: sourceUrl(record),
  };
}

function optionalResponsibilityEvidenceSummary(record = {}) {
  return {
    liability: trim(record.liability || record.name || record.title),
    quantificationStatus: trim(record.quantificationStatus),
    sourceExcerpt: textExcerpt(record.sourceExcerpt || record.excerpt || record.summary, 360),
    sourceUrl: sourceUrl(record),
  };
}

function compactPolicyEvidence(policy = {}, {
  knowledgeRecords = [],
  indicatorRecords = [],
  optionalResponsibilityRecords = [],
} = {}) {
  const knowledgeEvidence = (Array.isArray(knowledgeRecords) ? knowledgeRecords : [])
    .filter((record) => recordMatchesPolicy(policy, record))
    .map(knowledgeEvidenceSummary)
    .filter((record) => record.productName || record.title || record.excerpt)
    .slice(0, 4);
  const indicatorEvidence = findPolicyCoverageIndicators(policy, indicatorRecords)
    .map(indicatorEvidenceSummary)
    .filter((record) => record.coverageType || record.liability || record.formulaText)
    .slice(0, 28);
  const optionalResponsibilityEvidence = (Array.isArray(optionalResponsibilityRecords) ? optionalResponsibilityRecords : [])
    .filter((record) => recordMatchesPolicy(policy, record))
    .map(optionalResponsibilityEvidenceSummary)
    .filter((record) => record.liability || record.sourceExcerpt)
    .slice(0, 16);

  return {
    knowledgeEvidence,
    indicatorEvidence,
    optionalResponsibilityEvidence,
  };
}

function policyBrief(policy = {}, evidenceOptions = {}) {
  const evidence = compactPolicyEvidence(policy, evidenceOptions);
  return {
    id: policy.id ?? null,
    company: trim(policy.company),
    productName: trim(policy.name || policy.productName),
    applicant: trim(policy.applicant || policy.applicantMemberName),
    insured: trim(policy.insured || policy.insuredMemberName),
    annualPremium: numberOrZero(policy.premium || policy.annualPremium),
    coverageAmount: numberOrZero(policy.amount || policy.coverage),
    effectiveDate: trim(policy.effectiveDate),
    paymentPeriod: trim(policy.paymentPeriod || policy.payPeriod),
    coveragePeriod: trim(policy.coveragePeriod || policy.insurancePeriod),
    status: trim(policy.status || policy.policyStatus),
    type: trim(policy.type || policy.category),
    responsibilities: (Array.isArray(policy.responsibilities) ? policy.responsibilities : [])
      .slice(0, 12)
      .map((item) => ({
        name: trim(item.name || item.liability || item.title),
        amount: numberOrZero(item.amount || item.coverageAmount),
        condition: trim(item.condition || item.description),
      }))
      .filter((item) => item.name || item.amount || item.condition),
    evidence,
  };
}

function reportScoreBrief(score = {}) {
  return {
    key: trim(score.key),
    label: trim(score.label || score.name),
    score: numberOrZero(score.score),
    amount: numberOrZero(score.amount),
    amountText: trim(score.amountText),
    target: numberOrZero(score.target),
    targetText: trim(score.targetText),
    gap: numberOrZero(score.gap),
    gapText: trim(score.gapText),
    note: trim(score.note),
  };
}

export function buildFamilyPolicyAnalysisInput({
  family,
  members = [],
  policies = [],
  familyReport,
  planningProfile,
  knowledgeRecords = [],
  indicatorRecords = [],
  optionalResponsibilityRecords = [],
} = {}) {
  const report = familyReport || {};
  const evidenceOptions = { knowledgeRecords, indicatorRecords, optionalResponsibilityRecords };
  return {
    family: {
      id: family?.id ?? null,
      familyName: trim(family?.familyName || family?.name),
      notes: trim(family?.notes),
    },
    planningProfile: {
      annualIncome: numberOrZero(planningProfile?.annualIncome),
      annualExpense: numberOrZero(planningProfile?.annualExpense),
      debt: numberOrZero(planningProfile?.debt),
      educationGoal: numberOrZero(planningProfile?.educationGoal),
      parentSupportGoal: numberOrZero(planningProfile?.parentSupportGoal),
      availableAssets: numberOrZero(planningProfile?.availableAssets),
      premiumBudget: numberOrZero(planningProfile?.premiumBudget),
    },
    members: (Array.isArray(members) ? members : []).map((member) => ({
      id: member.id ?? null,
      name: trim(member.name),
      relationLabel: trim(member.relationLabel),
      role: trim(member.role),
      birthday: trim(member.birthday),
      notes: trim(member.notes),
    })),
    policies: (Array.isArray(policies) ? policies : []).map((policy) => policyBrief(policy, evidenceOptions)),
    report: {
      summary: report.summary || {},
      radar: {
        family: {
          scores: (report.radar?.family?.scores || []).map(reportScoreBrief),
        },
        members: (report.radar?.members || []).map((member) => ({
          member: trim(member.member),
          relationLabel: trim(member.relationLabel),
          scores: (member.scores || []).map(reportScoreBrief),
        })),
      },
      inventoryRows: (report.policyInventory?.rows || []).map((row) => ({
        member: trim(row.member),
        relationLabel: trim(row.relationLabel),
        applicant: trim(row.applicant),
        company: trim(row.company),
        productName: trim(row.productName),
        typeLabel: trim(row.typeLabel),
        coverageText: trim(row.coverageText),
        annualPremiumText: trim(row.annualPremiumText),
        coveragePeriod: trim(row.coveragePeriod),
        paymentPeriod: trim(row.paymentPeriod),
        policyStatusText: trim(row.policyStatusText),
        dataStatus: trim(row.dataStatus),
      })),
      criticalIllness: report.criticalIllness || {},
      accident: report.accident || {},
      wealth: report.wealth || {},
    },
  };
}

export function buildFamilyPolicyAnalysisMessages(input = {}) {
  return [
    {
      role: 'system',
      content: [
        '你是一名面向中国大陆家庭客户的寿险、健康险和家庭保障缺口分析顾问。',
        '任务是同时完成两件事：第一，像保险分析师一样逐张解析家庭现有保单；第二，像保障规划师一样量化识别家庭保障缺口。',
        '你必须基于输入的家庭成员、现有保单、家庭保障报告、每张保单的 RAG/官网证据和责任指标，输出一份客户可直接阅读的《家庭保单分析报告》。',
        '必须遵守：',
        '1. 全文不能出现“AI”“人工智能”“DeepSeek”“模型”“大模型”等技术来源字样。',
        '2. 不承诺理赔结果，不替代保险合同条款、核保结论、法律或税务意见。',
        '3. 只使用输入中能支持的事实；缺少收入、支出、负债、健康告知等信息时写“待补充核实”。',
        '4. 每个判断尽量追溯依据，优先使用保单字段、已识别责任、RAG/官网证据、责任指标、家庭保障雷达和成员角色；没有依据时写“待补充核实”。',
        '5. 既要分析整个家庭保单结构，也要重点展开保障缺口；缺口分析篇幅不少于全文 40%。',
        '6. 表达要专业、清晰、温和，避免恐吓式措辞；不要写成销售内训话术。',
        '7. 输入只包含结构化保单摘要、RAG/官网证据摘要、责任指标和家庭责任信息，不包含原始 OCR 全文；不得假装读过未提供的条款原文。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '请按以下中文 Markdown 结构输出：',
        '## 一、报告结论摘要',
        '## 二、家庭成员与保单全景',
        '## 三、现有保障结构评价',
        '## 四、重点保障缺口分析',
        '## 五、风险场景影响',
        '## 六、配置优先级与预算建议',
        '## 七、需要补充核实的信息',
        '## 八、动态复盘建议',
        '',
        '重点要求：',
        '- “现有保障结构评价”必须逐张保单分析，说明保障对象、主要责任、解决的家庭风险、保额是否匹配、保障期限是否匹配、是否存在重复/缺失/错配/保费压力、需要核实的条款限制。',
        '- “重点保障缺口分析”必须至少覆盖医疗、意外、重疾、寿险/身故责任、收入中断/失能五类；每类说明建议额度口径、已有保障、缺口判断、严重度、家庭影响和建议处理方式。',
        '- 必须给出一张缺口总览表，表头包含：保障类型、建议额度/口径、已有保障、缺口判断、严重度、优先级。',
        '- 缺口测算必须参考以下口径：寿险=负债+子女教育+父母赡养+5-10年家庭必要支出；重疾=治疗费用+康复费用+3-5年收入补偿；医疗=300-600万医疗额度并核实住院、特药、外购药、质子重离子；意外=年收入5-10倍；失能/收入中断=3-5年家庭支出或收入损失。',
        '- 输入 JSON 的 planningProfile 是客户补充的家庭责任信息：annualIncome=家庭年收入，annualExpense=家庭年必要支出，debt=家庭总负债，educationGoal=子女教育责任，parentSupportGoal=父母赡养责任，availableAssets=家庭现金储备，premiumBudget=可接受年保费预算。必须优先使用这些字段进行缺口测算和预算建议。',
        '- 如果家庭收入、支出、负债、子女教育、父母赡养等信息缺失，不得编造精确金额；此时先输出基于现有保单可确定的结构分析和初步缺口判断，再列出需要补充的信息清单。',
        '- 每类保障缺口必须说明为什么需要这个额度、当前已有保障能覆盖什么、缺口会在哪个风险场景暴露、对现金流/负债/教育/赡养的影响、应优先补齐还是逐步完善。',
        '- 配置建议不要直接堆产品名称，先讲配置逻辑和优先级：先保障后储蓄、先大人后小孩、先经济支柱后非经济支柱。',
        '- 配置建议必须分三档：基础版、标准版、完善版；每档说明适合人群、预算口径、解决的主要缺口、暂缓解决的问题。',
        '- 对储蓄、养老、教育金、年金或现金价值类保单，只评价其在家庭资产和长期现金流中的作用，不承诺收益。',
        '- 不要只写“建议增加保障”“保障不足”这类空泛结论；每条建议都要说明依据来自保单字段、责任指标、家庭责任或缺口测算。',
        '- 结尾必须包含提示：本报告仅供家庭保障规划参考，具体投保、责任范围、等待期、除外责任、理赔和核保结果以保险合同条款及保险公司结论为准。',
        '- 输入 JSON 已经做过压缩，只保留分析必要的保单字段、家庭责任信息和 RAG/官网证据摘要；不要要求客户提供原始 OCR 文本，也不要编造未提供的条款细节。',
        '',
        '分析输入 JSON：',
        JSON.stringify(input || {}, null, 2),
      ].join('\n'),
    },
  ];
}

export async function generateFamilyPolicyAnalysisReport({
  input,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const config = resolveConfig(env);
  if (!config.apiKey) {
    throw withCode(new Error('保单分析报告服务暂未配置'), 'FAMILY_POLICY_ANALYSIS_PROVIDER_NOT_READY', 503);
  }

  async function requestReport(model, retryReason = '') {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
    const url = new URL('/chat/completions', config.baseUrl);
    const messages = buildFamilyPolicyAnalysisMessages(input);
    if (retryReason) {
      messages.push({
        role: 'user',
        content: [
          '上一次报告内容不足，请重新生成完整报告。',
          `不足原因：${retryReason}`,
          '必须补齐：逐张保单分析、保障缺口总览表、医疗/意外/重疾/寿险/失能五类缺口、三档配置建议。',
        ].join('\n'),
      });
    }
    const body = {
      model,
      max_tokens: config.maxTokens,
      messages,
    };
    if (THINKING_MODELS.has(model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = DEFAULT_REASONING_EFFORT;
    } else {
      body.temperature = 0.2;
    }

    const response = await fetchImpl(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const bodyText = trim(await response.text());
      throw withCode(
        new Error(`FAMILY_POLICY_ANALYSIS_UPSTREAM_${response.status}:${bodyText || 'upstream_error'}`),
        'FAMILY_POLICY_ANALYSIS_UPSTREAM_FAILED',
        502,
      );
    }

    const payload = await response.json();
    return {
      content: sanitizeGeneratedContent(payload?.choices?.[0]?.message?.content),
      model: trim(payload?.model || model) || model,
      generatedAt: new Date().toISOString(),
    };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  try {
    let result = await requestReport(config.model);
    for (let attempt = 1; attempt < config.retryAttempts && isInsufficientReport(result.content); attempt += 1) {
      result = await requestReport(config.model, '内容为空、过短，或缺少逐张保单分析/缺口总览表/五类缺口分析');
    }
    if (!result.content) {
      throw withCode(new Error('FAMILY_POLICY_ANALYSIS_EMPTY_RESPONSE'), 'FAMILY_POLICY_ANALYSIS_EMPTY_RESPONSE', 502);
    }
    return {
      status: 'complete',
      ...result,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw withCode(new Error('保单分析报告生成超时'), 'FAMILY_POLICY_ANALYSIS_TIMEOUT', 504);
    }
    if (error?.code) throw error;
    throw withCode(error instanceof Error ? error : new Error('保单分析报告生成失败'), 'FAMILY_POLICY_ANALYSIS_FAILED', 500);
  }
}
