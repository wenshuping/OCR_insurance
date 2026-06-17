const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_FAMILY_REPORT_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 8_000;
const DEFAULT_DEEPSEEK_REASONING_EFFORT = 'high';
const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

const ALLOWED_SEVERITIES = new Set(['error', 'warning', 'info']);
const ALLOWED_CATEGORIES = new Set([
  'responsibility_understanding',
  'coverage_gap',
  'amount_calculation',
  'policy_data_conflict',
  'product_classification',
  'official_evidence_gap',
  'deepseek_quality_failed',
  'report_quality',
]);
const ALLOWED_CORRECTION_ACTIONS = new Set(['exclude_amount', 'mark_unquantifiable', 'replace_amount', 'change_dimension', 'override_cashflow']);
const ALLOWED_RISK_LEVELS = new Set(['low', 'medium', 'high']);

function trim(value) {
  return String(value || '').trim();
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || trim(value) === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteNumberAllowZero(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLookupText(value) {
  return trim(value).normalize('NFKC').replace(/\s+/gu, '').toLowerCase();
}

function take(items, limit) {
  return (Array.isArray(items) ? items : []).slice(0, limit);
}

function excerpt(value, limit = 1200) {
  const text = trim(value).replace(/\s+/gu, ' ');
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function withCode(error, code, status) {
  error.code = code;
  if (status) error.status = status;
  return error;
}

function isDeepSeekV4Model(model) {
  return DEEPSEEK_V4_MODELS.has(trim(model));
}

function usesDeepSeekThinkingMode(model) {
  const value = trim(model);
  return value === 'deepseek-reasoner' || isDeepSeekV4Model(value);
}

function resolveFamilyReportQualityConfig(env = process.env) {
  const timeoutCandidate = Number(env.DEEPSEEK_FAMILY_REPORT_TIMEOUT_MS || env.DEEPSEEK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const maxTokensCandidate = Number(env.DEEPSEEK_FAMILY_REPORT_MAX_TOKENS || DEFAULT_MAX_TOKENS);
  return {
    apiKey: trim(env.DEEPSEEK_API_KEY),
    baseUrl: trim(env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
    model: trim(env.DEEPSEEK_FAMILY_REPORT_MODEL)
      || trim(env.DEEPSEEK_FAMILY_REVIEW_MODEL)
      || trim(env.DEEPSEEK_MODEL)
      || DEFAULT_FAMILY_REPORT_MODEL,
    timeoutMs: Number.isFinite(timeoutCandidate) ? Math.max(10_000, timeoutCandidate) : DEFAULT_TIMEOUT_MS,
    maxTokens: Number.isFinite(maxTokensCandidate) ? Math.max(2_000, maxTokensCandidate) : DEFAULT_MAX_TOKENS,
  };
}

export function isFamilyReportQualityConfigured(env = process.env) {
  return Boolean(resolveFamilyReportQualityConfig(env).apiKey);
}

function extractJson(content) {
  const raw = trim(content);
  if (!raw) throw withCode(new Error('FAMILY_REPORT_QUALITY_EMPTY'), 'FAMILY_REPORT_QUALITY_EMPTY', 502);
  try {
    return JSON.parse(raw);
  } catch {
    // Some model responses wrap JSON with short prose or code fences.
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/iu);
  const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (trim(candidate)) return JSON.parse(candidate);
  throw withCode(new Error('FAMILY_REPORT_QUALITY_INVALID_JSON'), 'FAMILY_REPORT_QUALITY_INVALID_JSON', 502);
}

function buildMemberContext(members = []) {
  const activeMembers = (Array.isArray(members) ? members : []).filter((member) => trim(member?.status || 'active') === 'active');
  const refById = new Map();
  const refByName = new Map();
  const memberByRef = new Map();
  activeMembers.forEach((member, index) => {
    const memberRef = `member_${index + 1}`;
    const memberId = Number(member.id || 0);
    if (memberId) refById.set(memberId, memberRef);
    const nameKey = normalizeLookupText(member.name);
    if (nameKey) refByName.set(nameKey, memberRef);
    memberByRef.set(memberRef, member);
  });
  return { activeMembers, refById, refByName, memberByRef };
}

function memberRefForPolicy(policy = {}, memberContext = {}) {
  const insuredId = Number(policy.insuredMemberId || 0);
  if (insuredId && memberContext.refById?.has(insuredId)) return memberContext.refById.get(insuredId);
  const nameKey = normalizeLookupText(policy.insuredMemberName || policy.insured);
  return memberContext.refByName?.get(nameKey) || '';
}

function buildPolicyContext(policies = [], memberContext = {}) {
  const policyByRef = new Map();
  const policyRefs = new Map();
  const summaries = (Array.isArray(policies) ? policies : []).map((policy, index) => {
    const policyRef = `policy_${index + 1}`;
    policyByRef.set(policyRef, policy);
    if (policy?.id !== undefined && policy?.id !== null) policyRefs.set(String(policy.id), policyRef);
    return {
      policyRef,
      company: trim(policy.company),
      productName: trim(policy.name),
      insuredMemberRef: memberRefForPolicy(policy, memberContext),
      amount: asNumber(policy.amount),
      firstPremium: asNumber(policy.firstPremium),
      paymentPeriod: trim(policy.paymentPeriod),
      coveragePeriod: trim(policy.coveragePeriod),
      effectiveDate: trim(policy.date || policy.effectiveDate),
      policyStatus: trim(policy.policyStatus || policy.policyState || policy.contractStatus || policy.validityStatus || policy.status),
      plans: take(policy.plans, 12).map((plan) => ({
        name: trim(plan?.name || plan?.productName || plan?.matchedProductName),
        amount: asNumber(plan?.amount),
        firstPremium: asNumber(plan?.firstPremium),
        paymentPeriod: trim(plan?.paymentPeriod),
        coveragePeriod: trim(plan?.coveragePeriod),
      })),
      coverageIndicators: take(policy.coverageIndicators, 20).map(indicatorSummary),
      optionalResponsibilities: take(policy.optionalResponsibilities, 12).map(optionalResponsibilitySummary),
      cashflowEntries: take(policy.cashflowEntries, 40).map(cashflowEntrySummary),
      responsibilities: take(policy.responsibilities, 16).map((item) => ({
        coverageType: trim(item?.coverageType),
        scenario: trim(item?.scenario),
        payout: trim(item?.payout),
        note: trim(item?.note),
      })),
    };
  });
  return { policyByRef, policyRefs, summaries };
}

function indicatorSummary(record = {}) {
  return {
    coverageType: trim(record.coverageType || record.coverage_type || record.category),
    liability: trim(record.liability || record.name || record.title),
    formulaText: trim(record.formulaText || record.formula || record.calcText),
    value: record.value ?? '',
    unit: trim(record.unit),
    responsibilityScope: trim(record.responsibilityScope || record.scope),
    quantificationStatus: trim(record.quantificationStatus),
    sourceUrl: trim(record.sourceUrl || record.officialUrl || record.url),
  };
}

function optionalResponsibilitySummary(record = {}) {
  return {
    liability: trim(record.liability || record.name || record.title),
    quantificationStatus: trim(record.quantificationStatus),
    quantificationReason: trim(record.quantificationReason),
    sourceExcerpt: excerpt(record.sourceExcerpt || record.excerpt, 400),
    sourceUrl: trim(record.sourceUrl || record.officialUrl || record.url),
  };
}

function cashflowEntrySummary(record = {}) {
  return {
    year: finiteNumber(record.year),
    age: finiteNumberAllowZero(record.age),
    amount: finiteNumber(record.amount),
    cumulative: finiteNumber(record.cumulative),
    liability: trim(record.liability),
    calculationText: trim(record.calculationText || record.calcText),
  };
}

function recordMatchesPolicy(policy = {}, record = {}) {
  const policyCompany = normalizeLookupText(policy.company);
  const policyProduct = normalizeLookupText(policy.name);
  const recordCompany = normalizeLookupText(record.company);
  const recordProduct = normalizeLookupText(record.productName || record.name || record.title);
  if (policyCompany && recordCompany && policyCompany !== recordCompany) return false;
  if (!policyProduct || !recordProduct) return false;
  return policyProduct === recordProduct || policyProduct.includes(recordProduct) || recordProduct.includes(policyProduct);
}

function officialEvidenceForPolicy(policy, { knowledgeRecords = [], indicatorRecords = [], optionalResponsibilityRecords = [] } = {}) {
  const sources = (Array.isArray(knowledgeRecords) ? knowledgeRecords : [])
    .filter((record) => recordMatchesPolicy(policy, record))
    .slice(0, 3)
    .map((record) => ({
      company: trim(record.company),
      productName: trim(record.productName || record.title),
      productType: trim(record.productType || record.category || record.productCategory),
      url: trim(record.officialUrl || record.url || record.sourceUrl),
      pageText: excerpt(record.pageText || record.text || record.content || record.sourceExcerpt, 1600),
    }));
  const indicators = [
    ...(Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : []),
    ...(Array.isArray(indicatorRecords) ? indicatorRecords.filter((record) => recordMatchesPolicy(policy, record)) : []),
  ].slice(0, 40).map(indicatorSummary);
  const optionalResponsibilities = [
    ...(Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities : []),
    ...(Array.isArray(optionalResponsibilityRecords) ? optionalResponsibilityRecords.filter((record) => recordMatchesPolicy(policy, record)) : []),
  ].slice(0, 24).map(optionalResponsibilitySummary);
  return { sources, indicators, optionalResponsibilities };
}

function reportMemberRef(member = {}, memberContext = {}) {
  const memberId = Number(member.memberId || 0);
  if (memberId && memberContext.refById?.has(memberId)) return memberContext.refById.get(memberId);
  return memberContext.refByName?.get(normalizeLookupText(member.name || member.member)) || '';
}

function reportPolicyRefs(sourcePolicies = [], policyContext = {}) {
  return take(sourcePolicies, 8)
    .map((source) => policyContext.policyRefs?.get(String(source.policyId || source.id || '')) || '')
    .filter(Boolean);
}

function protectionMemberSnapshot(member = {}, memberContext = {}, policyContext = {}) {
  return {
    memberRef: reportMemberRef(member, memberContext),
    rows: take(member.rows, 12).map((row) => ({
      key: trim(row?.key),
      label: trim(row?.label),
      amount: asNumber(row?.amount),
      amountText: trim(row?.amountText),
      status: trim(row?.status),
      conditionText: trim(row?.conditionText),
      sourcePolicyRefs: reportPolicyRefs(row?.sourcePolicies, policyContext),
    })),
    attentionItems: take(member.attentionItems, 8).map(trim).filter(Boolean),
  };
}

function wealthPolicySnapshot(policy = {}, policyContext = {}) {
  return {
    policyRef: policyContext.policyRefs?.get(String(policy?.policyId || '')) || '',
    productName: trim(policy?.productName),
    cashflowRows: take(policy?.cashflowRows, 40).map(cashflowEntrySummary),
    annualCashflowRows: take(policy?.annualCashflowRows, 40).map((row) => ({
      year: finiteNumber(row?.year),
      payoutInflow: finiteNumber(row?.payoutInflow),
      cumulativePayoutInflow: finiteNumber(row?.cumulativePayoutInflow),
      cashValueTotal: finiteNumber(row?.cashValueTotal),
      totalValue: finiteNumber(row?.totalValue),
    })),
    attentionItems: take(policy?.attentionItems, 8).map(trim).filter(Boolean),
  };
}

function reportSnapshot(report = {}, memberContext = {}, policyContext = {}) {
  return {
    summary: report.summary || {},
    optionalResponsibilityGaps: take(report.optionalResponsibilityGaps, 20).map((gap) => ({
      policyRef: policyContext.policyRefs?.get(String(gap?.policyId || '')) || '',
      productName: trim(gap?.productName),
      liability: trim(gap?.liability),
      quantificationReason: trim(gap?.quantificationReason),
    })),
    criticalIllness: take(report.criticalIllness?.members, 12).map((member) => protectionMemberSnapshot(member, memberContext, policyContext)),
    accident: take(report.accident?.members, 12).map((member) => protectionMemberSnapshot(member, memberContext, policyContext)),
    wealth: take(report.wealth?.memberReports, 12).map((member) => ({
      memberRef: reportMemberRef(member, memberContext),
      policies: take(member?.policies, 12).map((policy) => wealthPolicySnapshot(policy, policyContext)),
      attentionItems: take(member?.attentionItems, 8).map(trim).filter(Boolean),
    })),
    radar: {
      mode: trim(report.radar?.mode),
      members: take([...(report.radar?.members || []), ...(report.radar?.hiddenMembers || [])], 12).map((member) => ({
        memberRef: reportMemberRef(member, memberContext),
        scores: take(member.scores, 8).map((score) => ({
          key: trim(score?.key),
          label: trim(score?.label),
          amount: asNumber(score?.amount),
          coveragePresent: score?.coveragePresent === true,
          note: trim(score?.note),
        })),
      })),
    },
  };
}

function buildQualityInput({
  family,
  members = [],
  policies = [],
  report,
  planningProfile = null,
  knowledgeRecords = [],
  indicatorRecords = [],
  optionalResponsibilityRecords = [],
} = {}) {
  const memberContext = buildMemberContext(members);
  const policyContext = buildPolicyContext(policies, memberContext);
  return {
    input: {
      family: {
        familyRef: 'current_family',
        memberCount: memberContext.activeMembers.length,
        policyCount: Array.isArray(policies) ? policies.length : 0,
      },
      members: memberContext.activeMembers.map((member, index) => ({
        memberRef: memberContext.refById.get(Number(member.id || 0)) || `member_${index + 1}`,
        relationLabel: trim(member.relationLabel),
        relationToCore: trim(member.relationToCore),
        role: trim(member.role),
        gender: trim(member.gender),
        birthday: trim(member.birthday),
        hasNotes: Boolean(trim(member.notes)),
      })),
      policies: policyContext.summaries,
      officialEvidence: policyContext.summaries.map((policySummary, index) => ({
        policyRef: policySummary.policyRef,
        ...officialEvidenceForPolicy(policies[index], { knowledgeRecords, indicatorRecords, optionalResponsibilityRecords }),
      })),
      codeReport: reportSnapshot(report, memberContext, policyContext),
      planningProfile: planningProfile || null,
    },
    memberContext,
    policyContext,
  };
}

function buildQualityMessages(input) {
  return [
    {
      role: 'system',
      content: [
        '你是家庭保障分析报告的后台质检助手。',
        '你的任务是基于保单基本信息、官网条款/指标证据和代码生成的报告快照，返回结构化问题清单和可机器校验的修正建议。',
        '不要生成客户报告，不要改写报告正文，不要输出 Markdown。',
        '只指出会影响报告准确性或后台需要复核的问题，包括责任理解、保障缺口、金额计算、产品分类、官网证据不足和数据冲突。',
        '成员只能引用 memberRef，保单只能引用 policyRef；不要编造保额、条款或客户信息。',
        '修正建议只允许表达计算口径，不允许要求直接改写最终报告 JSON。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '请只返回严格 JSON，格式如下：',
        '{"issues":[{"severity":"error|warning|info","category":"responsibility_understanding|coverage_gap|amount_calculation|policy_data_conflict|product_classification|official_evidence_gap|report_quality","title":"短标题","detail":"后台复核说明","suggestion":"处理建议","memberRef":"member_1","policyRef":"policy_1","dimension":"critical|accident|medical|life|wealth|other","confidence":0.8}],"corrections":[{"issueIndex":0,"action":"exclude_amount|mark_unquantifiable|replace_amount|change_dimension|override_cashflow","targetPath":"radar.medical.policyAmount|policy.cashflowEntries","originalValue":60,"correctedValue":null,"cashflowRows":[{"year":2030,"age":42,"amount":1465,"liability":"生存保险金","calculationText":"基本保险金额×10%","evidence":"官网证据摘录"}],"reason":"修正原因","evidence":"官网证据摘录","memberRef":"member_1","policyRef":"policy_1","dimension":"critical|accident|medical|life|wealth|other","riskLevel":"low|medium|high","confidence":0.9}]}',
        '',
        '判断口径：',
        '- 如果官网条款显示产品类型与报告/保单理解不一致，例如分红型终身寿险被写成增额终身寿险，返回 product_classification。',
        '- 如果代码报告金额与官网指标或来源责任明显冲突，返回 amount_calculation。',
        '- 如果家庭成员没有保单或某个保障维度缺失，返回 coverage_gap，但不要重复啰嗦；优先输出最重要的问题。',
        '- 如果官网证据不足以支撑量化，返回 official_evidence_gap 或 responsibility_understanding。',
        '- 如果某个金额应从计算中排除，corrections 使用 exclude_amount。',
        '- 如果某个报销型/津贴型/日额型责任不能展示成固定保额，corrections 使用 mark_unquantifiable。',
        '- replace_amount 和 change_dimension 仅在官网证据非常明确时返回；金额变大、寿险/重疾/财富相关默认 riskLevel 为 high。',
        '- 年金险/养老年金/教育金/两全险现金流：先基于官网条款独立判断确定现金流，再对比 codeReport。若代码现金流为空、年份错、金额错或漏掉确定生存金/年金/满期金，corrections 使用 override_cashflow，并在 cashflowRows 中给出最终年度表。',
        '- override_cashflow 只包含确定给付；红利、万能账户、账户价值、现金价值等不确定收益不得写入 cashflowRows，可在 reason/evidence 中说明排除。',
        '- 每条 correction 必须能定位 policyRef；不能定位时只返回 issue，不返回 correction。',
        '- severity 只允许 error、warning、info；最多返回 20 条。',
        '',
        '输入 JSON：',
        JSON.stringify(input),
      ].join('\n'),
    },
  ];
}

function normalizeSeverity(value) {
  const severity = trim(value).toLowerCase();
  return ALLOWED_SEVERITIES.has(severity) ? severity : 'warning';
}

function normalizeCategory(value) {
  const category = trim(value).toLowerCase();
  return ALLOWED_CATEGORIES.has(category) ? category : 'report_quality';
}

function normalizeDimension(value) {
  const dimension = trim(value).toLowerCase();
  return ['critical', 'accident', 'medical', 'life', 'wealth', 'other'].includes(dimension) ? dimension : '';
}

function normalizeCorrectionAction(value) {
  const action = trim(value).toLowerCase();
  return ALLOWED_CORRECTION_ACTIONS.has(action) ? action : '';
}

function normalizeRiskLevel(value) {
  const risk = trim(value).toLowerCase();
  return ALLOWED_RISK_LEVELS.has(risk) ? risk : 'medium';
}

function compactJsonValue(value) {
  if (value === null || value === undefined) return null;
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return excerpt(JSON.stringify(value), 500);
}

function normalizeCashflowRows(value) {
  return take(value, 120)
    .map((row) => {
      const year = finiteNumber(row?.year);
      const amount = finiteNumber(row?.amount);
      if (!Number.isInteger(year) || year <= 0 || amount === null || amount <= 0) return null;
      const age = finiteNumberAllowZero(row?.age);
      return {
        year,
        age: age === null ? null : age,
        amount,
        liability: excerpt(row?.liability || '现金流', 80),
        calculationText: excerpt(row?.calculationText || row?.calcText || row?.evidence, 300),
        evidence: excerpt(row?.evidence, 500),
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.year - right.year || String(left.liability).localeCompare(String(right.liability)));
}

function normalizeIssueRows(payload = {}, { memberContext, policyContext, model = '' } = {}) {
  return take(payload.issues, 20)
    .map((issue) => {
      const title = excerpt(issue?.title, 80);
      const detail = excerpt(issue?.detail, 800);
      if (!title || !detail) return null;
      const member = memberContext.memberByRef?.get(trim(issue?.memberRef)) || {};
      const policy = policyContext.policyByRef?.get(trim(issue?.policyRef)) || {};
      const confidence = finiteNumber(issue?.confidence);
      return {
        severity: normalizeSeverity(issue?.severity),
        category: normalizeCategory(issue?.category),
        title,
        detail,
        suggestion: excerpt(issue?.suggestion, 500),
        source: 'deepseek',
        memberId: Number(member.id || 0) || null,
        memberName: trim(member.name),
        policyId: Number(policy.id || 0) || null,
        productName: trim(policy.name || issue?.productName),
        dimension: normalizeDimension(issue?.dimension),
        model: trim(model),
        confidence: confidence === null ? null : Math.max(0, Math.min(1, confidence)),
      };
    })
    .filter(Boolean);
}

function normalizeCorrectionRows(payload = {}, { memberContext, policyContext, model = '' } = {}) {
  return take(payload.corrections, 20)
    .map((correction) => {
      const action = normalizeCorrectionAction(correction?.action);
      const dimension = normalizeDimension(correction?.dimension);
      const reason = excerpt(correction?.reason, 500);
      if (!action || !dimension || !reason) return null;
      const member = memberContext.memberByRef?.get(trim(correction?.memberRef)) || {};
      const policy = policyContext.policyByRef?.get(trim(correction?.policyRef)) || {};
      const confidence = finiteNumber(correction?.confidence);
      const issueIndex = finiteNumberAllowZero(correction?.issueIndex);
      return {
        issueIndex: Number.isInteger(issueIndex) && issueIndex >= 0 ? issueIndex : null,
        action,
        targetPath: excerpt(correction?.targetPath, 160),
        originalValue: compactJsonValue(correction?.originalValue),
        correctedValue: compactJsonValue(correction?.correctedValue),
        cashflowRows: normalizeCashflowRows(correction?.cashflowRows),
        reason,
        evidence: excerpt(correction?.evidence, 800),
        source: 'deepseek',
        memberId: Number(member.id || 0) || null,
        memberName: trim(member.name),
        policyId: Number(policy.id || 0) || null,
        productName: trim(policy.name || correction?.productName),
        dimension,
        riskLevel: normalizeRiskLevel(correction?.riskLevel),
        model: trim(model),
        confidence: confidence === null ? null : Math.max(0, Math.min(1, confidence)),
      };
    })
    .filter(Boolean);
}

function normalizeQualityResult(payload = {}, { memberContext, policyContext, model = '' } = {}) {
  return {
    issues: normalizeIssueRows(payload, { memberContext, policyContext, model }),
    corrections: normalizeCorrectionRows(payload, { memberContext, policyContext, model }),
  };
}

export async function generateFamilyReportQualityIssues({
  family,
  members = [],
  policies = [],
  report,
  planningProfile = null,
  knowledgeRecords = [],
  indicatorRecords = [],
  optionalResponsibilityRecords = [],
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const config = resolveFamilyReportQualityConfig(env);
  if (!config.apiKey) return [];

  const { input, memberContext, policyContext } = buildQualityInput({
    family,
    members,
    policies,
    report,
    planningProfile,
    knowledgeRecords,
    indicatorRecords,
    optionalResponsibilityRecords,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const url = new URL('/chat/completions', config.baseUrl);
    const body = {
      model: config.model,
      max_tokens: config.maxTokens,
      response_format: { type: 'json_object' },
      messages: buildQualityMessages(input),
    };
    if (isDeepSeekV4Model(config.model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = DEFAULT_DEEPSEEK_REASONING_EFFORT;
    }
    if (!usesDeepSeekThinkingMode(config.model)) body.temperature = 0.1;

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
      const bodyText = trim(await response.text().catch(() => ''));
      throw withCode(
        new Error(`FAMILY_REPORT_QUALITY_UPSTREAM_${response.status}:${bodyText || 'upstream_error'}`),
        'FAMILY_REPORT_QUALITY_UPSTREAM_FAILED',
        502,
      );
    }

    const payload = await response.json();
    const content = trim(payload?.choices?.[0]?.message?.content);
    const parsed = extractJson(content);
    return normalizeQualityResult(parsed, {
      memberContext,
      policyContext,
      model: trim(payload?.model || config.model),
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw withCode(new Error('FAMILY_REPORT_QUALITY_TIMEOUT'), 'FAMILY_REPORT_QUALITY_TIMEOUT', 504);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

generateFamilyReportQualityIssues.returnsStructuredResult = true;
