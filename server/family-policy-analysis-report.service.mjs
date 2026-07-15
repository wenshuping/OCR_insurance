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
import { evidenceVerificationFields } from './evidence-classification.service.mjs';
import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import {
  buildExpertPlanningProfile,
  computeExpertInputVersion,
  groupExpertCoverageIndicators,
  parseFamilyPolicyAnalysisEnvelope,
} from './family-policy-analysis-contract.service.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 14_000;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_REASONING_EFFORT = 'high';
const THINKING_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const PRO_MODEL = 'deepseek-v4-pro';

const COMPLETE_REPORT_STATUSES = new Set(['complete', 'completed', 'ready', 'success']);

export function resolveFamilyPolicyAnalysisReportFreshness(record = null, { sourceUpdatedAt = '' } = {}) {
  if (!record || String(record.status || 'active') !== 'active') return { status: 'missing', report: null, generatedAt: '' };
  const report = record?.report?.familyPolicyAnalysisReport || null;
  if (!report) return { status: 'missing', report: null, generatedAt: '' };
  const reportStatus = String(report.status || '').trim().toLowerCase();
  if (!COMPLETE_REPORT_STATUSES.has(reportStatus)) {
    return { status: ['pending', 'queued', 'running', 'processing'].includes(reportStatus) ? 'pending' : 'stale', report, generatedAt: '' };
  }
  const generatedAt = String(report.generatedAt || '').trim();
  if (!generatedAt) return { status: 'stale', report, generatedAt: '' };
  const latestSourceAt = String(sourceUpdatedAt || report.sourceUpdatedAt || record.sourceUpdatedAt || '').trim();
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime)) return { status: 'stale', report, generatedAt };
  const sourceTime = Date.parse(latestSourceAt);
  return {
    status: Number.isFinite(sourceTime) && (!Number.isFinite(generatedTime) || sourceTime > generatedTime) ? 'stale' : 'fresh',
    report,
    generatedAt,
  };
}

function trim(value) {
  return String(value || '').trim();
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numericFact(value) {
  const missing = value === undefined || value === null || (typeof value === 'string' && !value.trim());
  const number = Number(value);
  return missing || !Number.isFinite(number)
    ? { value: null, status: 'unknown' }
    : { value: number, status: 'confirmed' };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
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
  const expected = [
    '一、报告结论摘要', '二、家庭成员与保单全景', '三、现有保障结构评价', '四、重点保障缺口分析',
    '五、风险场景影响', '六、配置优先级与预算建议', '七、需要补充核实的信息', '八、动态复盘建议',
  ];
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gmu)];
  if (headings.length !== expected.length || headings.some((match, index) => match[1] !== expected[index])) return true;
  return headings.some((match, index) => {
    const bodyStart = match.index + match[0].length;
    const bodyEnd = headings[index + 1]?.index ?? text.length;
    return !trim(text.slice(bodyStart, bodyEnd));
  });
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
  const evidence = evidenceVerificationFields(record);
  return {
    company: recordCompany(record),
    productName: recordProductName(record),
    productType: trim(record.productType || record.category || record.productCategory),
    title: trim(record.title || record.sourceTitle || record.name),
    official: record.official === true,
    sourceKind: trim(record.sourceKind),
    evidenceLevel: trim(record.evidenceLevel || record.sourceLevel),
    verificationStatus: evidence.verificationStatus,
    verificationLabel: evidence.verificationLabel,
    referenceOnly: evidence.referenceOnly,
    url: sourceUrl(record),
    excerpt: textExcerpt(record.sourceExcerpt || record.excerpt || record.summary || record.content || record.text || record.ocrText, 420),
  };
}

function indicatorEvidenceSummary(record = {}) {
  const evidence = evidenceVerificationFields(record);
  return {
    coverageType: trim(record.coverageType || record.coverage_type || record.category),
    liability: trim(record.liability || record.name || record.title),
    formulaText: textExcerpt(record.formulaText || record.formula || record.calcText, 260),
    value: record.value ?? '',
    unit: trim(record.unit),
    responsibilityScope: textExcerpt(record.responsibilityScope || record.scope, 260),
    selectionStatus: trim(record.selectionStatus),
    quantificationStatus: trim(record.quantificationStatus),
    sourceKind: trim(record.sourceKind),
    evidenceLevel: trim(record.evidenceLevel || record.sourceLevel),
    verificationStatus: evidence.verificationStatus,
    verificationLabel: evidence.verificationLabel,
    referenceOnly: evidence.referenceOnly,
    sourceUrl: sourceUrl(record),
  };
}

function optionalResponsibilityEvidenceSummary(record = {}) {
  const evidence = evidenceVerificationFields(record);
  return {
    liability: trim(record.liability || record.name || record.title),
    quantificationStatus: trim(record.quantificationStatus),
    sourceKind: trim(record.sourceKind),
    evidenceLevel: trim(record.evidenceLevel || record.sourceLevel),
    verificationStatus: evidence.verificationStatus,
    verificationLabel: evidence.verificationLabel,
    referenceOnly: evidence.referenceOnly,
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
  const policySourceEvidence = (Array.isArray(policy.sources) ? policy.sources : [])
    .map(knowledgeEvidenceSummary)
    .filter((record) => record.title || record.url || record.excerpt)
    .slice(0, 8);

  return {
    knowledgeEvidence,
    indicatorEvidence,
    optionalResponsibilityEvidence,
    policySourceEvidence,
  };
}

function policyBrief(policy = {}, evidenceOptions = {}) {
  const evidence = compactPolicyEvidence(policy, evidenceOptions);
  const annualPremium = numericFact(firstDefined(policy.premium, policy.annualPremium));
  const coverageAmount = numericFact(firstDefined(policy.amount, policy.coverage));
  const policyStatuses = ['status', 'policyStatus', 'policyState', 'contractStatus', 'validityStatus']
    .map((key) => trim(policy[key])).filter(Boolean);
  return {
    id: policy.id ?? null,
    company: trim(policy.company),
    productName: trim(policy.name || policy.productName),
    applicant: trim(policy.applicant || policy.applicantMemberName),
    insured: trim(policy.insured || policy.insuredMemberName),
    annualPremium: annualPremium.value,
    annualPremiumStatus: annualPremium.status,
    coverageAmount: coverageAmount.value,
    coverageAmountStatus: coverageAmount.status,
    effectiveDate: trim(policy.effectiveDate),
    paymentPeriod: trim(policy.paymentPeriod || policy.payPeriod),
    coveragePeriod: trim(policy.coveragePeriod || policy.insurancePeriod),
    status: trim(policy.status),
    policyStatus: trim(policy.policyStatus),
    policyState: trim(policy.policyState),
    contractStatus: trim(policy.contractStatus),
    validityStatus: trim(policy.validityStatus),
    statusText: [...new Set(policyStatuses)].join(' | '),
    type: trim(policy.type || policy.category),
    responsibilities: (Array.isArray(policy.responsibilities) ? policy.responsibilities : [])
      .slice(0, 12)
      .map((item) => {
        const evidence = evidenceVerificationFields(item);
        const amount = numericFact(firstDefined(item.amount, item.coverageAmount));
        return {
          name: trim(item.name || item.liability || item.title || item.coverageType),
          amount: amount.value,
          amountStatus: amount.status,
          condition: trim(item.condition || item.description || item.scenario),
          payout: trim(item.payout),
          sourceKind: trim(item.sourceKind),
          evidenceLevel: trim(item.evidenceLevel || item.sourceLevel),
          verificationStatus: evidence.verificationStatus,
          verificationLabel: evidence.verificationLabel,
          referenceOnly: evidence.referenceOnly,
        };
      })
      .filter((item) => item.name || item.amount || item.condition),
    evidence,
  };
}

function reportScoreBrief(score = {}) {
  const result = {
    key: trim(score.key),
    label: trim(score.label || score.name),
    amountText: trim(score.amountText),
    effectiveAmountText: trim(score.effectiveAmountText),
    adequacyText: trim(score.adequacyText),
    targetText: trim(score.targetText),
    targetSource: trim(score.targetSource),
    gapText: trim(score.gapText),
    note: trim(score.note),
  };
  for (const key of ['score', 'amount', 'effectiveAmount', 'adequacyRate', 'target', 'gap']) {
    const fact = numericFact(score[key]);
    result[key] = fact.value;
    result[`${key}Status`] = fact.status;
  }
  return result;
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
  const policySummaries = (Array.isArray(policies) ? policies : []).map((policy, index) => ({
    ...policyBrief(policy, evidenceOptions),
    policyRef: `policy:${policy?.id ?? index}`,
  }));
  const coverageIndicators = (Array.isArray(policies) ? policies : []).flatMap((policy) =>
    (Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : []).map((indicator) => ({
      ...indicator,
      memberRef: indicator.memberRef || policy.insuredMemberRef || policy.insured || '',
    })));
  const groupedCoverageIndicators = groupExpertCoverageIndicators(coverageIndicators)
    .map((group, index) => ({ ...group, indicatorRef: `indicator:${index}` }));
  const input = {
    family: {
      id: family?.id ?? null,
      familyName: trim(family?.familyName || family?.name),
      notes: trim(family?.notes),
    },
    planningProfile: buildExpertPlanningProfile(planningProfile),
    members: (Array.isArray(members) ? members : []).map((member) => ({
      id: member.id ?? null,
      name: trim(member.name),
      relationLabel: trim(member.relationLabel),
      role: trim(member.role),
      birthday: trim(member.birthday),
      notes: trim(member.notes),
    })),
    policies: policySummaries,
    groupedCoverageIndicators,
    allowedEvidenceRefs: {
      policies: policySummaries.map((policy) => policy.policyRef),
      indicators: groupedCoverageIndicators.map((group) => group.indicatorRef),
    },
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
  input.expertInputVersion = computeExpertInputVersion(input);
  return input;
}

export function buildFamilyPolicyAnalysisMessages(input = {}) {
  return [
    {
      role: 'system',
      content: [
        '你是一名面向中国大陆家庭客户的寿险、健康险和家庭保障缺口分析顾问。',
        '任务是同时完成两件事：第一，像保险分析师一样逐张解析家庭现有保单；第二，像保障规划师一样定性识别家庭保障缺口。',
        '你必须在同一次响应中输出客户可直接阅读的《家庭保单分析报告》和供销冠使用的结构化专家结论。',
        '必须遵守：',
        '1. 全文不能出现“AI”“人工智能”“DeepSeek”“模型”“大模型”等技术来源字样。',
        '2. 不承诺理赔结果，不替代保险合同条款、核保结论、法律或税务意见。',
        '3. 只使用输入中能支持的事实；缺少收入、支出、负债、健康告知等信息时写“待补充核实”。',
        '4. 每个判断尽量追溯依据，优先使用保单字段、已识别责任、保险公司官方资料、客户上传保单责任页/合同页、责任指标、家庭保障雷达和成员角色；没有依据时写“待补充核实”。',
        '5. 既要分析整个家庭保单结构，也要定性判断保障缺失、责任不完整、保额偏低、配置失衡和保费结构；资料不足时不输出精确缺口金额，不把 unknown 当作 0。',
        '6. 表达要专业、清晰、温和，避免恐吓式措辞；不要写成销售内训话术。',
        '7. 输入只包含结构化保单摘要、分层证据摘要、责任指标和家庭责任信息，不包含原始 OCR 全文；不得假装读过未提供的条款原文。',
        '8. evidence 中 verificationStatus=verified 且 sourceKind/evidenceLevel 为 insurer_official 或 customer_policy_terms 的内容，可以作为已核实责任依据。',
        '9. regulatory_industry_terms 只能表述为“行业条款来源/中国保险行业协会条款线索”，不得写成保险公司官网资料。',
        '10. referenceOnly=true 或 verificationStatus=pending_review 的第三方网页、开放网页搜索、老产品非官方资料，只能放在“待核实参考/需要补充核实”里，不得计入已确认保障、保障合计或缺口抵扣。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '只输出 JSON object：{markdownContent, structuredResult, expertInputVersion}。expertInputVersion 必须原样返回输入中的同名值。',
        'markdownContent 按以下中文 Markdown 结构输出：',
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
        '- “重点保障缺口分析”基于已有证据定性判断保障缺失、责任不完整、保额偏低、配置失衡和保费结构。客户不补齐财务信息也应完成报告。',
        '- 输入 JSON 的 planningProfile 是客户补充的家庭责任信息：annualIncome=家庭年收入，annualExpense=家庭年必要支出，debt=家庭总负债，educationGoal=子女教育责任，parentSupportGoal=父母赡养责任，availableAssets=家庭现金储备，premiumBudget=可接受年保费预算。必须优先使用这些字段进行缺口测算和预算建议。',
        '- 如果家庭收入、支出、负债、子女教育、父母赡养等信息缺失，不得编造精确金额；此时先输出基于现有保单可确定的结构分析和初步缺口判断，再列出需要补充的信息清单。',
        '- 每类保障缺口必须说明为什么需要这个额度、当前已有保障能覆盖什么、缺口会在哪个风险场景暴露、对现金流/负债/教育/赡养的影响、应优先补齐还是逐步完善。',
        '- 配置建议不要直接堆产品名称，先讲配置逻辑和优先级：先保障后储蓄、先大人后小孩、先经济支柱后非经济支柱。',
        '- 不强制输出三档金额方案；资料不足时不得输出精确缺口金额。',
        '- 对储蓄、养老、教育金、年金或现金价值类保单，只评价其在家庭资产和长期现金流中的作用，不承诺收益。',
        '- 不要只写“建议增加保障”“保障不足”这类空泛结论；每条建议都要说明依据来自保单字段、责任指标、家庭责任或缺口测算。',
        '- 结尾必须包含提示：本报告仅供家庭保障规划参考，具体投保、责任范围、等待期、除外责任、理赔和核保结果以保险合同条款及保险公司结论为准。',
        '- 输入 JSON 已经做过压缩，只保留分析必要的保单字段、家庭责任信息和分层证据摘要；不要要求客户提供原始 OCR 文本，也不要编造未提供的条款细节。',
        '- 如果使用非官方网页或老产品第三方资料，必须显式标注“待核实参考”，并提醒以保险公司确认或补发合同条款为准。',
        '- structuredResult 必须包含 summary, priorityFindings, confirmedFacts, verificationItems, memberFindings, evidenceRefs, dataQualityWarnings。',
        '- 每个 priorityFinding 和 memberFinding 都包含 memberRef/category/finding/assessment/confidence/confirmedFactRefs/indicatorRefs/policyRefs/missingInformation/nextVerification。',
        '- confirmedFacts 中每项使用唯一 id；evidenceRefs 必须是 {facts:[id], indicators:[id], policies:[id]}，finding 的三类 *Refs 只能引用这些已列出的 id。',
        '- policyRefs 和 indicatorRefs 只能使用输入 allowedEvidenceRefs 中提供的稳定 ref，不得自行创造；每张保单和每组指标也带有对应 ref。',
        '- assessment 只能是 confirmed_gap、likely_insufficient、needs_verification、currently_reasonable。',
        '- 有合同或已确认事实支撑时使用“当前已录入保单中未发现”；仅因资料未录入而无法确认时使用“暂按未配置关注，需核对合同”，不得把未识别直接断言为没有保障。',
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
          '必须返回有效 JSON envelope、完整八章 Markdown，并让每条关键结论可追溯到事实、指标、保单或明确的待核实信息。',
        ].join('\n'),
      });
    }
    const body = {
      model,
      max_tokens: config.maxTokens,
      messages,
      response_format: { type: 'json_object' },
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
      body: JSON.stringify(sanitizeDeepSeekRequestBody(body)),
    });

    if (!response.ok) {
      const bodyText = trim(await response.text());
      const error = withCode(
        new Error(`FAMILY_POLICY_ANALYSIS_UPSTREAM_${response.status}:${bodyText || 'upstream_error'}`),
        'FAMILY_POLICY_ANALYSIS_UPSTREAM_FAILED',
        502,
      );
      error.retryable = response.status === 429 || response.status >= 500;
      throw error;
    }

    const payload = await response.json();
    return {
      rawContent: payload?.choices?.[0]?.message?.content,
      model: trim(payload?.model || model) || model,
      generatedAt: new Date().toISOString(),
    };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  try {
    let lastError;
    for (let attempt = 0; attempt < config.retryAttempts; attempt += 1) {
      try {
        const result = await requestReport(config.model, attempt ? 'JSON 结构无效、证据引用无效，或缺少八个 Markdown 章节' : '');
        const allowedEvidenceRefs = input?.allowedEvidenceRefs || {
          policies: (input?.policies || []).map((policy, index) => policy.policyRef || `policy:${policy?.id ?? index}`),
          indicators: (input?.groupedCoverageIndicators || []).map((group, index) => group.indicatorRef || `indicator:${index}`),
        };
        const envelope = parseFamilyPolicyAnalysisEnvelope(result.rawContent, input?.expertInputVersion, allowedEvidenceRefs, input);
        const markdownContent = sanitizeGeneratedContent(envelope.markdownContent);
        if (isInsufficientReport(markdownContent)) throw withCode(new Error('Markdown sections are incomplete'), 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT', 502);
        return {
          status: 'complete',
          content: markdownContent,
          markdownContent,
          structuredResult: envelope.structuredResult,
          expertInputVersion: envelope.expertInputVersion,
          model: result.model,
          generatedAt: result.generatedAt,
        };
      } catch (error) {
        lastError = error;
        const retryable = error?.code === 'FAMILY_POLICY_ANALYSIS_INVALID_RESULT'
          || error?.retryable === true
          || error instanceof SyntaxError;
        if (!retryable) throw error;
      }
    }
    if (lastError?.code) throw lastError;
    throw withCode(lastError instanceof Error ? lastError : new Error('Invalid upstream response'), 'FAMILY_POLICY_ANALYSIS_UPSTREAM_FAILED', 502);
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw withCode(new Error('保单分析报告生成超时'), 'FAMILY_POLICY_ANALYSIS_TIMEOUT', 504);
    }
    if (error?.code) throw error;
    throw withCode(error instanceof Error ? error : new Error('保单分析报告生成失败'), 'FAMILY_POLICY_ANALYSIS_FAILED', 500);
  }
}
