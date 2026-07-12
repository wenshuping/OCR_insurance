import { agentPolicyImportMatchesOwner } from './agent-policy-import.service.mjs';
import {
  analyzeInsurancePolicyResponsibilities,
  sanitizeStoredPolicyAnalysis,
} from './c-policy-analysis.service.mjs';
import { buildDomainAgentEnvelope } from './domain-agent-tool-contract.service.mjs';
import { listFamilyProfilesForOwner } from './family-profile.domain.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_QUESTION_LENGTH = 4_000;
const MAX_REQUEST_ID_LENGTH = 160;
const HIGH_RISK_PATTERNS = [
  { pattern: /换保|替换|转保/u, caution: '换保可能导致保障中断、等待期重置或既往症限制，须在新合同生效且核保结论明确后再决定。' },
  { pattern: /退保| surrender/iu, caution: '退保可能产生现金价值损失并终止保障，须以保险公司当期退保试算和正式合同为准。' },
  { pattern: /核保|承保/u, caution: '核保结论由保险公司基于完整、如实告知的申请资料决定，本回答不能代替核保。' },
  { pattern: /理赔|赔付/u, caution: '理赔须结合事故事实、完整材料、除外责任及保险公司正式审核，本回答不构成理赔承诺。' },
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

function currentAt(record, now) {
  if (record?.current === false || record?.isCurrent === false) return false;
  const validFrom = Date.parse(String(record?.validFrom || ''));
  const validTo = Date.parse(String(record?.validTo || ''));
  if (Number.isFinite(validFrom) && validFrom > now) return false;
  if (Number.isFinite(validTo) && validTo <= now) return false;
  return true;
}

function officialEvidenceRecords(state, policy) {
  const matched = (state.knowledgeRecords || []).filter((record) => (
    exactProductMatch(record, policy)
    && record?.official === true
    && String(record?.evidenceLevel || 'insurer_official') === 'insurer_official'
    && String(record?.url || '').startsWith('https://')
    && String(record?.versionNo || record?.version || '').trim()
    && currentAt(record, Date.now())
  ));
  const explicitlyCurrent = matched.filter((record) => record?.isCurrent === true || record?.current === true);
  const candidates = explicitlyCurrent.length ? explicitlyCurrent : matched;
  const versions = candidates.map((record) => String(record.versionNo || record.version));
  const currentVersion = versions.sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))[0];
  return candidates.filter((record) => String(record.versionNo || record.version) === currentVersion);
}

function normalizedProductPart(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s（）()【】\[\]《》<>「」『』·.,，。；;:：、_-]+/gu, '');
}

function productIdentityMatches(policy, task) {
  const taskProduct = task?.draft || task?.scan || {};
  const policyCanonical = String(policy?.canonicalProductId || policy?.productId || '').trim();
  const taskCanonical = String(taskProduct?.canonicalProductId || taskProduct?.productId || '').trim();
  if (policyCanonical && taskCanonical) return policyCanonical === taskCanonical;
  const policyParts = [policy?.company, policy?.name, policy?.versionNo || policy?.version].map(normalizedProductPart);
  const taskParts = [taskProduct?.company, taskProduct?.name, taskProduct?.versionNo || taskProduct?.version].map(normalizedProductPart);
  return Boolean(policyParts[0] && policyParts[1] && policyParts.every((part, index) => part === taskParts[index]));
}

function completedTaskPolicyId(task) {
  return Number(task?.formalPolicyId || task?.savedPolicyId || task?.result?.formalPolicyId || task?.result?.policyId || 0);
}

function safePolicyProjection(value = {}) {
  const projection = {};
  for (const key of ['company', 'name', 'canonicalProductId']) {
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

function answerFromAnalysis(analysis) {
  const rows = Array.isArray(analysis?.coverageTable) ? analysis.coverageTable : [];
  if (!rows.length) return '现有官方证据不足以确认具体保险责任。';
  return rows.map((row) => {
    const title = String(row?.coverageType || '').trim();
    const details = [row?.scenario, row?.payout, row?.note].map((value) => String(value || '').trim()).filter(Boolean);
    return `${title}：${details.join('；')}`;
  }).filter((line) => !line.startsWith('：')).join('\n');
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
    missingInformation: [detail || '缺少与当前产品版本匹配的保险公司官方条款或说明书。'],
  }, { allowedEvidenceHosts: evidenceHosts });
}

export function createInsuranceExpertTool({
  state = {},
  analyze = analyzeInsurancePolicyResponsibilities,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowedEvidenceHosts,
} = {}) {
  const evidenceHosts = allowedEvidenceHosts || (state.officialDomainProfiles || [])
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
    if (policy && task) {
      const formalPolicyId = completedTaskPolicyId(task);
      const correlated = String(task.status || '') === 'completed'
        ? formalPolicyId === Number(policy.id)
        : productIdentityMatches(policy, task);
      if (!correlated) fail('POLICY_TASK_MISMATCH', 409);
    }

    const policyProjection = safePolicyProjection(policy || task?.draft);
    if (!policyProjection.company || !policyProjection.name) fail('POLICY_PRODUCT_NOT_RESOLVED', 409);
    const evidenceRecords = officialEvidenceRecords(state, policyProjection);
    if (!evidenceRecords.length) return missingEvidenceEnvelope({ policy, task, requestId, question, evidenceHosts });

    let rawResult;
    try {
      rawResult = await invokeWithTimeout((signal) => analyze({
        policy: policyProjection,
        ocrText: '',
        knowledgeRecords: evidenceRecords,
        officialDomainProfiles: state.officialDomainProfiles || [],
        allowExternalReferences: false,
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
    const missingInformation = sanitized.coverageTable.length ? [] : ['官方证据未提供可确认的保险责任。'];
    const limitations = ['仅依据当前产品版本的保险公司官方证据回答；个案以正式保险合同及保险公司审核为准。'];
    for (const item of HIGH_RISK_PATTERNS) if (item.pattern.test(question)) limitations.push(item.caution);
    return buildDomainAgentEnvelope({
      agent: 'insurance_expert',
      taskId: String(task?.id || requestId || `policy:${policy.id}`),
      answer: answerFromAnalysis(sanitized),
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
