import { agentPolicyImportMatchesOwner } from './agent-policy-import.service.mjs';
import {
  analyzeInsurancePolicyResponsibilities,
  mergeOfficialDomainProfiles,
  sanitizeStoredPolicyAnalysis,
} from './c-policy-analysis.service.mjs';
import { buildDomainAgentEnvelope, isAllowedDomainAgentEvidenceUrl } from './domain-agent-tool-contract.service.mjs';
import { listFamilyProfilesForOwner } from './family-profile.domain.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_QUESTION_LENGTH = 4_000;
const MAX_REQUEST_ID_LENGTH = 160;
const READY_TASK_STATUSES = new Set(['field_completion', 'candidate_selection', 'member_binding', 'final_confirmation', 'completed']);
const RESOLVED_PRODUCTS = new Set(['trusted_match', 'selected', 'manual_confirmed']);
const INSURANCE_RELEVANCE_TERMS = ['住院', '门诊', '医疗', '牙科', '身故', '全残', '重疾', '重大疾病', '轻症', '中症', '疾病', '意外', '交通', '护理', '豁免', '年金', '生存金', '满期', '教育金', '养老金', '现金价值'];
const GENERIC_QUESTION_TERMS = new Set(['保障', '什么', '保障什么', '问题', '怎么', '如何', '能否', '可以', '理赔', '理賠', '赔付', '賠付', '保险', '保險', '责任', '責任']);
const HIGH_RISK_PATTERNS = [
  { pattern: /换保|換保|替换|替換|转保|轉保|replace(?:ment)?|switch(?:ing)?(?:\s+polic(?:y|ies))?/iu, caution: '换保可能导致保障中断、等待期重置或既往症限制，须在新合同生效且核保结论明确后再决定。' },
  { pattern: /退保|解約|退保金|解除合同|撤单|撤單|surrender|cancel(?:lation)?\s+(?:the\s+)?policy/iu, caution: '退保可能产生现金价值损失并终止保障，须以保险公司当期退保试算和正式合同为准。' },
  { pattern: /核保|承保|健康告知|underwrit(?:e|ing|ten)/iu, caution: '核保结论由保险公司基于完整、如实告知的申请资料决定，本回答不能代替核保。' },
  { pattern: /理赔|理賠|赔付|賠付|拒赔|拒賠|claim|payout/iu, caution: '理赔须结合事故事实、完整材料、除外责任及保险公司正式审核，本回答不构成理赔承诺。' },
];

export class InsuranceExpertToolError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'InsuranceExpertToolError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new InsuranceExpertToolError(code, status);
}

function ownerMatchesPolicy(policy, owner) {
  return Number(owner?.userId) > 0
    && Number(policy?.userId || policy?.ownerUserId || 0) === Number(owner.userId);
}

function exactProductMatch(record, policy) {
  const policyCanonical = String(policy?.canonicalProductId || '').trim();
  const recordCanonical = String(record?.canonicalProductId || '').trim();
  if (policyCanonical) return Boolean(recordCanonical && policyCanonical === recordCanonical);
  return String(record?.company || '').trim() === String(policy?.company || '').trim()
    && String(record?.productName || record?.name || '').trim() === String(policy?.name || '').trim();
}

function applicableAt(record, instant) {
  if (record?.current === false || record?.isCurrent === false) return false;
  const validFrom = Date.parse(String(record?.validFrom || ''));
  const validTo = Date.parse(String(record?.validTo || ''));
  if (Number.isFinite(validFrom) && validFrom > instant) return false;
  if (Number.isFinite(validTo) && validTo <= instant) return false;
  return true;
}

function productVersion(value = {}) {
  return normalizedProductPart(value.versionNo || value.version);
}

function policyInstant(policy = {}) {
  const value = Date.parse(String(policy.effectiveDate || policy.issueDate || policy.date || ''));
  return Number.isFinite(value) ? value : NaN;
}

function officialEvidenceHostPolicies(policy, profiles, override) {
  if (override !== undefined) return override;
  const company = normalizedProductPart(policy.company);
  const applicable = (profiles || []).filter((profile) => {
    const names = [profile?.company, profile?.companyName, profile?.name, ...(profile?.aliases || []), ...(profile?.companyAliases || [])].map(normalizedProductPart);
    return !company || names.includes(company);
  });
  return applicable.flatMap((profile) => profile?.officialDomains || profile?.domains || profile?.siteDomains || []);
}

function officialEvidenceRecords(state, policy, officialDomainProfiles = state.officialDomainProfiles || [], allowedEvidenceHosts) {
  const version = productVersion(policy);
  const instant = policyInstant(policy);
  if (!version) return { records: [], reason: '缺少保单对应的产品版本标识，无法安全匹配当前官方条款。' };
  if (!Number.isFinite(instant)) return { records: [], reason: '缺少保单签发或生效日期，无法判断官方条款版本是否适用。' };
  const hostPolicies = officialEvidenceHostPolicies(policy, officialDomainProfiles, allowedEvidenceHosts);
  const records = (state.knowledgeRecords || []).filter((record) => (
    exactProductMatch(record, policy)
    && productVersion(record) === version
    && record?.official === true
    && String(record?.evidenceLevel || 'insurer_official') === 'insurer_official'
    && isAllowedDomainAgentEvidenceUrl(record?.url, { allowedEvidenceHosts: hostPolicies })
    && applicableAt(record, instant)
  ));
  return { records, reason: records.length ? '' : '缺少与该保单产品版本及生效日期匹配的保险公司官方条款或说明书。' };
}

function normalizedProductPart(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s（）()【】\[\]《》<>「」『』·.,，。；;:：、_-]+/gu, '');
}

function productIdentityMatches(policy, task) {
  const taskProduct = task?.draft || task?.scan || {};
  const policyCanonical = String(policy?.canonicalProductId || policy?.productId || '').trim();
  const taskCanonical = String(taskProduct?.canonicalProductId || taskProduct?.productId || '').trim();
  const policyVersion = productVersion(policy);
  const taskVersion = productVersion(taskProduct);
  if ((policyVersion || taskVersion) && policyVersion !== taskVersion) return false;
  if (policyCanonical && taskCanonical && policyCanonical !== taskCanonical) return false;
  if (policyCanonical && taskCanonical) return true;
  const policyParts = [policy?.company, policy?.name].map(normalizedProductPart);
  const taskParts = [taskProduct?.company, taskProduct?.name].map(normalizedProductPart);
  return Boolean(policyParts[0] && policyParts[1] && policyParts.every((part, index) => part === taskParts[index]));
}

function completedTaskPolicyId(task) {
  return Number(task?.formalPolicyId || task?.savedPolicyId || task?.result?.formalPolicyId || task?.result?.policyId || 0);
}

function safePolicyProjection(value = {}) {
  const projection = {};
  for (const key of ['company', 'name', 'canonicalProductId', 'versionNo', 'version', 'effectiveDate', 'issueDate', 'date']) {
    const text = String(value?.[key] || '').trim();
    if (text) projection[key] = text;
  }
  return projection;
}

function sourceEvidence(sources, records) {
  const byUrl = new Map(records.map((record) => [String(record.url), record]));
  return (Array.isArray(sources) ? sources : []).flatMap((source) => {
    if (source?.official !== true || String(source?.evidenceLevel || '') !== 'insurer_official') return [];
    const record = byUrl.get(String(source?.url || ''));
    if (!record) return [];
    return [{
      label: String(source.evidenceLabel || record.evidenceLabel || '保险公司官方资料'),
      sourceRef: `knowledge:${record.id}`,
      version: String(record.versionNo || record.version),
      url: String(record.url),
    }];
  });
}

function questionRelevance(analysis, question) {
  const rows = Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [];
  const bounded = String(question || '').slice(0, MAX_QUESTION_LENGTH).toLowerCase();
  if (/^(?:请)?(?:概括|介绍)?(?:一下)?(?:保险)?(?:保障|责任)?(?:是什么|什么|有哪些|情况)?[？?。\s]*$/u.test(bounded)
    || /^(?:what\s+(?:is|are)\s+(?:covered|the\s+coverages?)|(?:give|show)\s+(?:me\s+)?(?:a\s+)?coverage\s+summary)[?\s]*$/u.test(bounded)) {
    return { rows, relevantRows: rows, terms: [], narrow: false };
  }
  const terms = new Set(INSURANCE_RELEVANCE_TERMS.filter((term) => bounded.includes(term)));
  for (const segment of bounded.match(/[\p{Script=Han}]+/gu) || []) {
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index + size <= segment.length && terms.size < 80; index += 1) {
        const term = segment.slice(index, index + size);
        if (!GENERIC_QUESTION_TERMS.has(term)) terms.add(term);
      }
    }
  }
  for (const term of bounded.match(/[a-z]{4,}/gu) || []) {
    if (!/^(?:claim|payout|policy|insurance)$/u.test(term) && terms.size < 80) terms.add(term);
  }
  const relevantRows = terms.size ? rows.filter((row) => {
    const text = [row?.coverageType, row?.scenario, row?.payout, row?.note].join(' ').toLowerCase().slice(0, 4_000);
    return [...terms].some((term) => text.includes(term));
  }) : rows;
  return { rows, relevantRows, terms: [...terms], narrow: terms.size > 0 };
}

function answerFromAnalysis(analysis, question, relevance = questionRelevance(analysis, question)) {
  const rows = relevance.rows;
  if (!rows.length) return '现有官方证据不足以确认具体保险责任。';
  const selectedRows = relevance.narrow ? relevance.relevantRows : rows;
  if (!selectedRows.length) return '现有官方责任表没有足够信息直接回答该问题，需结合具体事故、核保或保全资料进一步核验。';
  const summary = selectedRows.map((row) => {
    const title = String(row?.coverageType || '').trim();
    const details = [row?.scenario, row?.payout, row?.note].map((value) => String(value || '').trim()).filter(Boolean);
    return `${title}：${details.join('；')}`;
  }).filter((line) => !line.startsWith('：')).join('\n');
  const prefix = relevance.narrow
    ? '根据当前匹配的官方责任条目，以下仅为条款摘要，不代表必然赔付：'
    : '当前产品版本的官方责任条目摘要：';
  return `${prefix}\n${summary}`;
}

function taskMissingInformation(task) {
  if (!task) return [];
  const fields = [
    ['company', '保险公司'], ['name', '产品名称'], ['insured', '被保险人'],
  ];
  return fields.filter(([key]) => !String(task?.draft?.[key] || '').trim()).map(([, label]) => `保单录入任务仍缺少${label}。`);
}

function taskIsEligible(task) {
  if (!task || !READY_TASK_STATUSES.has(String(task.status || ''))) return false;
  if (task.status === 'completed') return true;
  return RESOLVED_PRODUCTS.has(String(task.productResolution || ''));
}

function invokeWithTimeout(invoke, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new InsuranceExpertToolError('AGENT_TIMEOUT', 504));
    }, timeoutMs);
  });
  let operation;
  try {
    operation = Promise.resolve(invoke(controller.signal));
  } catch (error) {
    operation = Promise.reject(error);
  }
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function missingEvidenceEnvelope({ policy, task, requestId, question, evidenceHosts, detail }) {
  const limitations = ['当前没有可确认该产品当前版本责任的保险公司官方证据，不能据此形成保障、核保、退保或理赔结论。'];
  for (const item of HIGH_RISK_PATTERNS) if (item.pattern.test(question)) limitations.push(item.caution);
  return buildDomainAgentEnvelope({
    agent: 'insurance_expert',
    taskId: String(task?.id || requestId || `policy:${policy.id}`),
    answer: '当前版本的保险公司官方证据不足，暂时无法确认具体保险责任。',
    evidence: [],
    limitations,
    missingInformation: [
      detail || '缺少与当前产品版本匹配的保险公司官方条款或说明书。',
      ...taskMissingInformation(task),
    ],
  }, { allowedEvidenceHosts: evidenceHosts });
}

export function createInsuranceExpertTool({
  state = {},
  analyze = analyzeInsurancePolicyResponsibilities,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowedEvidenceHosts,
} = {}) {
  const officialDomainProfiles = mergeOfficialDomainProfiles(state.officialDomainProfiles || []);
  const evidenceHosts = allowedEvidenceHosts || officialDomainProfiles
    .flatMap((profile) => profile?.officialDomains || profile?.domains || []);
  return async function askInsuranceExpert(toolInput = {}) {
    const allowedKeys = new Set(['owner', 'question', 'policyRef', 'policyImportTaskId', 'requestId']);
    if (!toolInput || Array.isArray(toolInput) || typeof toolInput !== 'object'
      || Object.keys(toolInput).some((key) => !allowedKeys.has(key))) fail('INVALID_TOOL_INPUT', 400);
    const { owner, question, policyRef, policyImportTaskId, requestId } = toolInput;
    if (!owner || typeof question !== 'string' || !question.trim() || question.length > MAX_QUESTION_LENGTH
      || (requestId !== undefined && (typeof requestId !== 'string' || !requestId.trim() || requestId.length > MAX_REQUEST_ID_LENGTH))) fail('INVALID_TOOL_INPUT', 400);
    if (policyRef !== undefined && (!Number.isSafeInteger(policyRef) || policyRef <= 0)) fail('INVALID_TOOL_INPUT', 400);
    if (policyImportTaskId !== undefined && (!Number.isSafeInteger(policyImportTaskId) || policyImportTaskId <= 0)) fail('INVALID_TOOL_INPUT', 400);

    const policy = policyRef === undefined ? null : (state.policies || []).find((candidate) => (
      Number(candidate?.id) === policyRef && ownerMatchesPolicy(candidate, owner)
    ));
    if (policyRef !== undefined && !policy) fail('POLICY_NOT_FOUND', 404);

    const accessibleFamilies = new Set(listFamilyProfilesForOwner(state, owner).map((family) => Number(family.id)));
    const task = policyImportTaskId === undefined ? null : (state.agentPolicyImportTasks || []).find((candidate) => (
      Number(candidate?.id) === policyImportTaskId
      && agentPolicyImportMatchesOwner(candidate, owner)
      && accessibleFamilies.has(Number(candidate?.familyId))
      && String(candidate?.targetAgent || '') === 'insurance_expert'
      && (!policy || Number(candidate?.familyId) === Number(policy?.familyId))
    ));
    if (policyImportTaskId !== undefined && !task) fail('POLICY_IMPORT_NOT_FOUND', 404);
    if (task && !taskIsEligible(task)) fail('POLICY_IMPORT_NOT_READY', 409);
    if (policy && task) {
      const formalPolicyId = completedTaskPolicyId(task);
      const correlated = String(task.status || '') === 'completed'
        ? formalPolicyId === Number(policy.id)
        : productIdentityMatches(policy, task);
      if (!correlated) fail('POLICY_TASK_MISMATCH', 409);
    }

    const policyProjection = safePolicyProjection(policy || task?.draft);
    if (!policyProjection.company || !policyProjection.name) fail('POLICY_PRODUCT_NOT_RESOLVED', 409);
    const evidenceResolution = officialEvidenceRecords(state, policyProjection, officialDomainProfiles, allowedEvidenceHosts);
    const evidenceRecords = evidenceResolution.records;
    if (!evidenceRecords.length) return missingEvidenceEnvelope({ policy, task, requestId, question, evidenceHosts, detail: evidenceResolution.reason });

    let rawResult;
    try {
      rawResult = await invokeWithTimeout((signal) => analyze({
        policy: policyProjection,
        ocrText: '',
        knowledgeRecords: evidenceRecords,
        officialDomainProfiles,
        allowExternalReferences: false,
        question: question.trim(),
        signal,
      }), timeoutMs);
    } catch (error) {
      if (error?.code === 'AGENT_TIMEOUT' || error?.code === 'POLICY_ANALYSIS_TIMEOUT' || error?.name === 'AbortError') fail('AGENT_TIMEOUT', 504);
      throw error;
    }

    const sanitized = sanitizeStoredPolicyAnalysis(rawResult?.analysis || rawResult);
    if (!sanitized) fail('POLICY_ANALYSIS_INVALID', 502);
    const evidence = sourceEvidence(rawResult?.sources, evidenceRecords);
    if (!evidence.length) return missingEvidenceEnvelope({
      policy, task, requestId, question, evidenceHosts,
      detail: '分析结果缺少与当前产品版本匹配的保险公司官方来源。',
    });
    const missingInformation = [
      ...(sanitized.coverageTable.length ? [] : ['官方证据未提供可确认的保险责任。']),
      ...taskMissingInformation(task),
    ];
    const limitations = ['仅依据当前产品版本的保险公司官方证据回答；个案以正式保险合同及保险公司审核为准。'];
    for (const item of HIGH_RISK_PATTERNS) if (item.pattern.test(question)) limitations.push(item.caution);
    const relevance = questionRelevance(sanitized, question);
    return buildDomainAgentEnvelope({
      agent: 'insurance_expert',
      taskId: String(task?.id || requestId || `policy:${policy.id}`),
      answer: answerFromAnalysis(sanitized, question, relevance),
      evidence,
      limitations,
      missingInformation,
    }, { allowedEvidenceHosts: evidenceHosts });
  };
}

export async function askInsuranceExpertTool(options = {}) {
  const { state, analyze, timeoutMs, allowedEvidenceHosts, ...input } = options;
  return createInsuranceExpertTool({ state, analyze, timeoutMs, allowedEvidenceHosts })(input);
}
