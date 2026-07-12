import { buildFamilyReport } from '../src/family-report-engine.mjs';
import { buildAgentPolicyImportContext, agentPolicyImportMatchesOwner } from './agent-policy-import.service.mjs';
import { buildDomainAgentEnvelope } from './domain-agent-tool-contract.service.mjs';
import { listFamilyMembers, listFamilyProfilesForOwner } from './family-profile.domain.mjs';
import { buildFamilySalesChatContext, generateFamilySalesChatReply } from './family-sales-chat.service.mjs';
import { buildFamilySalesMemoryContext, isCurrentFamilySalesMemory } from './family-sales-memory.service.mjs';
import { buildFamilySalesReviewInput } from './family-sales-review.service.mjs';

const DEFAULT_TIMEOUT_MS = 60_000;

export class SalesChampionToolError extends Error {
  constructor(code, status) {
    super(code);
    this.name = 'SalesChampionToolError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status) {
  throw new SalesChampionToolError(code, status);
}

function ownerMatches(record, owner) {
  if (Number(owner?.userId) > 0) {
    const recordOwner = Number(record?.ownerUserId || record?.userId || 0);
    return recordOwner === Number(owner.userId);
  }
  return Boolean(owner?.guestId)
    && !Number(record?.ownerUserId || record?.userId || 0)
    && String(record?.ownerGuestId || record?.guestId || '') === String(owner.guestId);
}

function policiesForFamily(state, family, owner) {
  return (state.policies || []).filter((policy) => (
    Number(policy?.familyId || 0) === Number(family.id) && ownerMatches(policy, owner)
  ));
}

function currentConfirmedMemories(state, family, owner, asOf) {
  return (state.familySalesMemories || []).filter((memory) => (
    Number(memory?.familyId || 0) === Number(family.id)
    && ownerMatches(memory, owner)
    && isCurrentFamilySalesMemory(memory, { asOf })
  ));
}

function evidenceFromContext(context) {
  const officialEvidence = context?.familyInput?.officialEvidence;
  const groups = Array.isArray(officialEvidence) ? officialEvidence : Object.values(officialEvidence || {});
  return groups.flatMap((group) => (
    Array.isArray(group?.evidence) ? group.evidence : (group?.officialSources || [])
  )).map((item) => ({
    label: String(item?.title || item?.label || '官方责任证据'),
    sourceRef: String(item?.sourceRef || item?.sourceId || item?.url || 'current-family-evidence'),
    version: String(item?.version || item?.updatedAt || item?.effectiveDate || 'current'),
    ...(item?.url ? { url: String(item.url) } : {}),
  })).slice(0, 20);
}

function timeoutAfter(promise, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new SalesChampionToolError('AGENT_TIMEOUT', 504)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function createSalesChampionTool({
  state = {},
  generateReply = generateFamilySalesChatReply,
  nowIso = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowedEvidenceHosts,
} = {}) {
  const evidenceHosts = allowedEvidenceHosts || (state.officialDomainProfiles || [])
    .flatMap((profile) => profile?.officialDomains || profile?.domains || []);
  return async function askSalesChampion(toolInput = {}) {
    const allowedKeys = new Set(['owner', 'question', 'familyRef', 'policyImportTaskId', 'requestId']);
    if (!toolInput || Array.isArray(toolInput) || typeof toolInput !== 'object'
      || Object.keys(toolInput).some((key) => !allowedKeys.has(key))) fail('INVALID_TOOL_INPUT', 400);
    const { owner, question, familyRef, policyImportTaskId, requestId } = toolInput;
    if (!owner || typeof question !== 'string' || !question.trim() || !Number.isSafeInteger(familyRef) || familyRef <= 0) {
      fail('INVALID_TOOL_INPUT', 400);
    }
    const family = listFamilyProfilesForOwner(state, owner)
      .find((candidate) => Number(candidate.id) === familyRef);
    if (!family) fail('FAMILY_NOT_FOUND', 404);

    let policyImportTask = null;
    if (policyImportTaskId !== undefined) {
      if (!Number.isSafeInteger(policyImportTaskId) || policyImportTaskId <= 0) fail('INVALID_TOOL_INPUT', 400);
      policyImportTask = (state.agentPolicyImportTasks || []).find((task) => (
        Number(task?.id) === policyImportTaskId
        && Number(task?.familyId) === familyRef
        && agentPolicyImportMatchesOwner(task, owner)
        && String(task?.targetAgent || 'sales_champion') === 'sales_champion'
      ));
      if (!policyImportTask) fail('POLICY_IMPORT_NOT_FOUND', 404);
    }

    const generatedAt = nowIso();
    const members = listFamilyMembers(state, family.id);
    const policies = policiesForFamily(state, family, owner);
    const familyReport = buildFamilyReport(policies, family.planningProfile || null, { familyId: family.id });
    const input = buildFamilySalesReviewInput({
      family, members, policies, familyReport, planningProfile: family.planningProfile || null,
      knowledgeRecords: state.knowledgeRecords || [],
      indicatorRecords: state.insuranceIndicatorRecords || [],
      optionalResponsibilityRecords: state.optionalResponsibilityRecords || [],
      generatedAt,
    });
    const context = buildFamilySalesChatContext({
      input, family, members, policies,
      familyReports: state.familyReports || [],
      familySalesReviews: state.familySalesReviews || [],
      generatedAt,
    });
    const memoryContext = buildFamilySalesMemoryContext(currentConfirmedMemories(state, family, owner, generatedAt), { asOf: generatedAt });
    if (memoryContext) context.salesMemoryContext = memoryContext;
    if (policyImportTask) context.policyImportContext = buildAgentPolicyImportContext(policyImportTask);

    let reply;
    try {
      reply = await timeoutAfter(Promise.resolve(generateReply({
        context,
        history: [],
        question: question.trim(),
        env: {
          ...process.env,
          FAMILY_SALES_CHAT_TIMEOUT_MS: String(timeoutMs),
          FAMILY_AGENT_SKILL_ROUTER_TIMEOUT_MS: String(Math.min(timeoutMs, 30_000)),
        },
      })), timeoutMs);
    } catch (error) {
      if (error?.code === 'AGENT_TIMEOUT' || error?.code === 'FAMILY_SALES_CHAT_TIMEOUT' || error?.name === 'AbortError') {
        fail('AGENT_TIMEOUT', 504);
      }
      throw error;
    }
    return buildDomainAgentEnvelope({
      agent: 'sales_champion',
      taskId: String(policyImportTask?.id || requestId || `family:${family.id}`),
      answer: String(reply?.content || ''),
      evidence: evidenceFromContext(context),
      limitations: ['销售建议仅供顾问沟通参考，不构成承保、理赔、收益或法律承诺。'],
      missingInformation: policyImportTask ? buildAgentPolicyImportContext(policyImportTask).missingFields : [],
    }, { allowedEvidenceHosts: evidenceHosts });
  };
}

export async function askSalesChampionTool(options = {}) {
  const { state, generateReply, nowIso, timeoutMs, allowedEvidenceHosts, ...input } = options;
  return createSalesChampionTool({ state, generateReply, nowIso, timeoutMs, allowedEvidenceHosts })(input);
}
