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
const DEFAULT_REASONING_EFFORT = 'high';
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

function entityRef(prefix, entity = {}) {
  return trim(entity[`${prefix}Ref`]) || (entity.id === undefined || entity.id === null ? '' : `${prefix}:${entity.id}`);
}

function policyCategory(policy = {}) {
  const text = `${trim(policy.category)} ${trim(policy.type)} ${trim(policy.name ?? policy.productName)}`;
  for (const [pattern, category] of [[/增额|终身寿/u, '增额终身寿险'], [/意外/u, '意外险'], [/医疗|住院/u, '医疗险'], [/重疾|重大疾病/u, '重疾险'], [/寿险|身故/u, '寿险'], [/年金/u, '年金险']]) {
    if (pattern.test(text)) return category;
  }
  return trim(policy.category) || null;
}

function categoryFromQuestion(question = '') {
  return policyCategory({ name: question });
}

function targetRef(target = {}, key) {
  return trim(target?.[key]) || trim(target?.[key === 'memberRef' ? 'memberId' : 'policyId']);
}

export function resolveSalesTopicPack(question, {
  members = [], policies = [], activeOpportunity = null, lastExplicitTarget = null,
} = {}) {
  const text = trim(question);
  if (!text || (/话术|怎么说|如何说|异议/u.test(text) && !/谁|孩子|父亲|母亲|爸爸|妈妈|保单|险|责任|续保|现金|预算|保费/u.test(text))) return { topicPack: null, ambiguous: false, category: null };
  const category = categoryFromQuestion(text);
  const normalizedMembers = (Array.isArray(members) ? members : []).map((member) => ({ ...member, ref: entityRef('member', member) }));
  const normalizedPolicies = (Array.isArray(policies) ? policies : []).map((policy) => ({ ...policy, ref: entityRef('policy', policy), category: policyCategory(policy) }));
  const explicitMembers = normalizedMembers.filter((member) => [member.name, member.relationLabel, member.role]
    .map(trim).filter((value) => value && value.length >= 2).some((value) => text.includes(value)) ||
    (/孩子|小孩|子女/u.test(text) && /儿|女|孩子/u.test(`${member.relationLabel || ''}${member.role || ''}`)));
  const explicitPolicies = normalizedPolicies.filter((policy) => [policy.name, policy.productName, policy.policyRef]
    .map(trim).filter((value) => value && value.length >= 3).some((value) => text.includes(value)));
  if (explicitMembers.length > 1) return { topicPack: null, ambiguous: true, category, reason: 'multiple_explicit_members', candidateMemberRefs: explicitMembers.slice(0, 4).map((member) => member.ref) };
  const fallback = lastExplicitTarget || activeOpportunity || {};
  const fallbackMemberRef = targetRef(fallback, 'memberRef');
  const fallbackPolicyRef = targetRef(fallback, 'policyRef');
  let selectedPolicies = explicitPolicies;
  let selectedMembers = explicitMembers;
  if (selectedPolicies.length && selectedMembers.length) {
    selectedPolicies = selectedPolicies.filter((policy) => selectedMembers.some((member) => Number(policy.insuredMemberId) === Number(member.id)) && (!category || policy.category === category));
    if (!selectedPolicies.length) return { topicPack: null, ambiguous: true, category, reason: 'conflicting_explicit_targets' };
  }
  if (!selectedPolicies.length && fallbackPolicyRef) {
    selectedPolicies = normalizedPolicies.filter((policy) => (
      (policy.ref === fallbackPolicyRef || String(policy.id) === fallbackPolicyRef) &&
      (!selectedMembers.length || selectedMembers.some((member) => Number(policy.insuredMemberId) === Number(member.id))) &&
      (!category || policy.category === category)
    ));
  }
  if (!selectedMembers.length && fallbackMemberRef) selectedMembers = normalizedMembers.filter((member) => member.ref === fallbackMemberRef || String(member.id) === fallbackMemberRef);
  if (!selectedPolicies.length && (selectedMembers.length || category)) {
    const categoryMatches = normalizedPolicies.filter((policy) => (!category || policy.category === category) && (!selectedMembers.length || selectedMembers.some((member) => Number(policy.insuredMemberId) === Number(member.id))));
    if (categoryMatches.length === 1 || selectedMembers.length) selectedPolicies = categoryMatches;
    else if (categoryMatches.length > 1) return { topicPack: null, ambiguous: true, category, candidatePolicyRefs: categoryMatches.slice(0, 4).map((policy) => policy.ref) };
  }
  if (!selectedMembers.length && selectedPolicies.length) {
    selectedMembers = normalizedMembers.filter((member) => selectedPolicies.some((policy) => Number(policy.insuredMemberId) === Number(member.id)));
  }
  const resolvedCategory = category || selectedPolicies[0]?.category || trim(fallback.category) || null;
  const type = /续保|核保|等待期|保证续保|停售|健康告知/u.test(text)
    ? 'policy_indicators'
    : /责任|赔什么|免责|条款|证据/u.test(text)
      ? 'responsibility_evidence'
      : /现金流|预算|收支|负债|保费/u.test(text)
        ? 'family_finance'
        : /财富|养老|年金|传承|现金价值/u.test(text)
          ? 'wealth_cashflow'
          : (selectedMembers.length || selectedPolicies.length) ? 'member_coverage' : null;
  if (!type) return { topicPack: null, ambiguous: false, category: resolvedCategory };
  return { topicPack: {
    type,
    memberRefs: selectedMembers.slice(0, 2).map((member) => member.ref),
    policyRefs: selectedPolicies.slice(0, 3).map((policy) => policy.ref),
    category: resolvedCategory,
  }, ambiguous: false, category: resolvedCategory };
}

export function selectSalesTopicPack(question, options = {}) {
  return resolveSalesTopicPack(question, options).topicPack;
}

export function deriveSalesConversationTargets({ salesReview = null, memories = null, history = [], members = [], policies = [] } = {}) {
  const targetFromText = (text) => {
    const pack = selectSalesTopicPack(text, { members, policies });
    if (!pack) return null;
    if (pack.policyRefs.length === 1) return { policyRef: pack.policyRefs[0], memberRef: pack.memberRefs[0] || '', category: pack.category || '' };
    if (pack.memberRefs.length === 1) return { memberRef: pack.memberRefs[0], category: pack.category || '' };
    return null;
  };
  const recentMessages = normalizeHistory(history).slice().reverse();
  const memoryList = Array.isArray(memories) ? memories : (memories?.memories || []);
  const confirmedMemories = memoryList.filter((item) => ['confirmed', 'active'].includes(trim(item?.status)) && item?.isCurrent !== false).slice(0, 8);
  const lastExplicitTarget = [...recentMessages.map((item) => item.content), ...confirmedMemories.map((item) => item.content)]
    .map(targetFromText).find(Boolean) || null;
  const refs = salesReview?.structuredSummary?.refs || {};
  const policyRefs = (Array.isArray(refs.policies) ? refs.policies : []).map(trim).filter(Boolean);
  let activeOpportunity = policyRefs.length === 1 ? { policyRef: policyRefs[0] } : null;
  if (!activeOpportunity) {
    activeOpportunity = (salesReview?.structuredSummary?.salesOpportunities || []).map(targetFromText).find(Boolean) || null;
  }
  return { lastExplicitTarget, activeOpportunity };
}

function boundedItems(items, limit = 6) {
  return (Array.isArray(items) ? items : []).slice(0, limit);
}

const SAFE_EXPERT_ITEM_FIELDS = new Set([
  'id', 'ref', 'item', 'label', 'category', 'status', 'amount', 'value', 'unit', 'count', 'method',
  'policyRef', 'policyRefs', 'memberRef', 'memberRefs', 'verificationStatus', 'sourceKind', 'indicator', 'responsibility', 'name', 'title', 'finding', 'recommendation', 'evidenceStatus', 'evidenceRef',
]);

function safeExpertString(value, limit = 120) {
  const text = trim(value);
  if (/\b1[3-9]\d{9}\b|\b[1-9]\d{5}(?:18|19|20)\d{2}\d{8}[\dXx]\b/u.test(text)) return '';
  return text.slice(0, limit);
}

function projectExpertItem(item = {}) {
  return Object.fromEntries(Object.entries(item).filter(([key]) => SAFE_EXPERT_ITEM_FIELDS.has(key)).map(([key, value]) => {
    if (Array.isArray(value)) return [key, value.slice(0, 6).map((entry) => safeExpertString(entry)).filter(Boolean)];
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return [key, value];
    return [key, safeExpertString(value)];
  }).filter(([, value]) => value !== ''));
}

function projectSalesSummary(salesReview = {}) {
  const source = salesReview?.structuredSummary || salesReview?.inputSummary || salesReview?.summary;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const result = {};
  for (const key of ['conclusion', 'meetingObjective']) {
    const value = safeExpertString(source[key], 600);
    if (value) result[key] = value;
  }
  for (const key of ['verificationItems', 'coverageConcerns', 'salesOpportunities', 'nextActions']) {
    const values = boundedItems(source[key], 6).map((value) => safeExpertString(value, 180)).filter(Boolean);
    if (values.length) result[key] = values;
  }
  if (source.refs && typeof source.refs === 'object') {
    result.refs = Object.fromEntries(['facts', 'indicators', 'policies'].map((key) => [key, boundedItems(source.refs[key], 8).map((value) => safeExpertString(value, 80)).filter(Boolean)]));
  }
  return result;
}

const TOPIC_PACK_TYPES = new Set(['member_coverage', 'policy_indicators', 'responsibility_evidence', 'family_finance', 'wealth_cashflow', 'expert_findings']);

function projectTopicPack(topicPack = null) {
  if (!topicPack || !TOPIC_PACK_TYPES.has(trim(topicPack.type))) return null;
  return {
    type: trim(topicPack.type),
    memberRefs: boundedItems(topicPack.memberRefs, 2).map((value) => safeExpertString(value, 80)).filter(Boolean),
    policyRefs: boundedItems(topicPack.policyRefs, 3).map((value) => safeExpertString(value, 80)).filter(Boolean),
    category: safeExpertString(topicPack.category, 40) || null,
  };
}

function projectConversationTargets(targets = null) {
  const projectTarget = (target) => {
    if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
    const projected = Object.fromEntries(['policyRef', 'memberRef', 'category', 'label'].map((key) => [key, safeExpertString(target[key], key === 'label' ? 80 : 60)]).filter(([, value]) => value));
    return Object.keys(projected).length ? projected : null;
  };
  return { lastExplicitTarget: projectTarget(targets?.lastExplicitTarget), activeOpportunity: projectTarget(targets?.activeOpportunity) };
}

function projectFinanceSummary(source = null) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(['annualIncome', 'annualExpense', 'debt', 'premiumBudget', 'availableAssets', 'cashflowConclusion'].map((key) => {
    const value = source[key];
    if (Array.isArray(value)) return [key, value.slice(0, 6).map((item) => typeof item === 'number' ? item : safeExpertString(item, 80)).filter((item) => item !== '')];
    if (typeof value === 'number' && Number.isFinite(value)) return [key, value];
    if (typeof value === 'boolean') return [key, value];
    return [key, safeExpertString(value, key === 'cashflowConclusion' ? 240 : 80)];
  }).filter(([, value]) => value !== '' && (!Array.isArray(value) || value.length)));
}

function relevantFindings(expertReport = {}, topicPack = null) {
  if (!topicPack) return null;
  const findings = expertReport.structuredResult || expertReport.expertFindings || {};
  const refs = new Set([...(topicPack.memberRefs || []), ...(topicPack.policyRefs || [])]);
  const matches = (item = {}) => {
    const itemRefs = [item.memberRef, ...(item.memberRefs || []), item.policyRef, ...(item.policyRefs || [])].map(trim).filter(Boolean);
    return itemRefs.some((ref) => refs.has(ref)) || (topicPack.category && trim(item.category) === topicPack.category);
  };
  return {
    summary: safeExpertString(findings.summary, 600) || null,
    priorityFindings: boundedItems(findings.priorityFindings?.filter(matches), 4).map(projectExpertItem),
    memberFindings: boundedItems(findings.memberFindings?.filter(matches), 4).map(projectExpertItem),
    confirmedFacts: boundedItems(findings.confirmedFacts?.filter(matches), 6).map(projectExpertItem),
    verificationItems: boundedItems(findings.verificationItems?.filter(matches), 4).map(projectExpertItem),
  };
}

function topicDataForPack({ topicPack, policies = [], expertReport = {}, financeSummary = null } = {}) {
  if (!topicPack) return null;
  const policyRefs = new Set(topicPack.policyRefs || []);
  const findings = expertReport?.structuredResult || expertReport?.expertFindings || {};
  const selectedPolicies = (Array.isArray(policies) ? policies : []).filter((policy) => policyRefs.has(entityRef('policy', policy))).slice(0, 3);
  const matchesPolicy = (item = {}) => policyRefs.has(trim(item.policyRef)) || (item.policyRefs || []).some((ref) => policyRefs.has(trim(ref)));
  if (topicPack.type === 'policy_indicators') {
    const expertIndicators = boundedItems(findings.policyIndicators?.filter(matchesPolicy), 6).map(projectExpertItem);
    const policyIndicators = selectedPolicies.map((policy) => ({
      policyRef: safeExpertString(entityRef('policy', policy), 80), validityStatus: safeExpertString(policy.validityStatus ?? policy.status, 80), renewalType: safeExpertString(policy.renewalType ?? policy.renewal, 120), waitingPeriod: safeExpertString(policy.waitingPeriod, 80),
    }));
    const hasActualIndicator = expertIndicators.some((item) => Object.keys(item).some((key) => key !== 'policyRef')) || policyIndicators.some((item) => item.validityStatus || item.renewalType || item.waitingPeriod);
    return {
      policyIndicators: [
        ...policyIndicators,
        ...expertIndicators,
      ].slice(0, 8),
      absenceMessage: hasActualIndicator ? null : selectedPolicies.length ? '暂按未配置关注，需核对合同' : '当前已录入保单中未发现',
    };
  }
  if (topicPack.type === 'responsibility_evidence') {
    const responsibilityEvidence = boundedItems((findings.responsibilityFindings || findings.responsibilityEvidence)?.filter(matchesPolicy), 6).map((item) => ({
      policyRef: safeExpertString(item.policyRef), responsibility: safeExpertString(item.responsibility ?? item.name), evidenceStatus: safeExpertString(item.evidenceStatus ?? item.status) || 'not_identified', evidenceRef: safeExpertString(item.evidenceRef),
    }));
    return {
      responsibilityEvidence,
      absenceMessage: !selectedPolicies.length ? '当前已录入保单中未发现' : responsibilityEvidence.length ? null : '暂按未配置关注，需核对合同',
    };
  }
  if (topicPack.type === 'family_finance' || topicPack.type === 'wealth_cashflow') {
    return { finance: projectFinanceSummary(financeSummary) };
  }
  return null;
}

export function buildLightweightSalesChatContext({
  salesReview = null, expertReport = null, memories = null, history = [], question = '', topicPack = null,
  members = [], policies = [], sourceUpdated = false, generatedAt = new Date().toISOString(), displayReplacements = null,
  financeSummary = null,
  conversationTargets = null,
  topicResolution = null,
} = {}) {
  const safeTopicPack = projectTopicPack(topicPack);
  const safeConversationTargets = projectConversationTargets(conversationTargets);
  const ambiguous = Boolean(topicResolution?.ambiguous) || (!safeTopicPack && /这份|这个|这张|怎么样|如何/u.test(trim(question)));
  const memberRefs = new Set(safeTopicPack?.memberRefs || []);
  const policyRefs = new Set(safeTopicPack?.policyRefs || []);
  const memberIndex = boundedItems((Array.isArray(members) ? members : []).filter((member) => memberRefs.has(entityRef('member', member))).map((member) => ({
    memberRef: safeExpertString(entityRef('member', member), 80), relationLabel: safeExpertString(member.relationLabel, 40), role: safeExpertString(member.role, 40), age: Number.isFinite(Number(member.age)) ? Number(member.age) : null,
  })), 2);
  const policyIndex = boundedItems((Array.isArray(policies) ? policies : []).filter((policy) => policyRefs.has(entityRef('policy', policy))).map((policy) => ({
    policyRef: safeExpertString(entityRef('policy', policy), 80), insuredMemberRef: safeExpertString(entityRef('member', { id: policy.insuredMemberId }), 80), productName: safeExpertString(policy.name ?? policy.productName, 100), category: safeExpertString(policyCategory(policy), 40), validityStatus: safeExpertString(policy.validityStatus ?? policy.status, 40),
  })), 3);
  const memoryList = Array.isArray(memories) ? memories : (memories?.memories || memories?.items || []);
  const asOf = Date.parse(generatedAt);
  const currentMemories = memoryList.filter((item) => {
    if (!['confirmed', 'active'].includes(trim(item?.status)) || item?.isCurrent === false) return false;
    if (item?.invalidatedAt) return false;
    const validFrom = Date.parse(item?.validFrom || '');
    const validTo = Date.parse(item?.validTo || '');
    if (!Number.isFinite(asOf)) return true;
    if (Number.isFinite(validFrom) && validFrom > asOf) return false;
    return !Number.isFinite(validTo) || validTo > asOf;
  }).slice(0, 8).map((item) => ({
    status: trim(item.status),
    isCurrent: true,
    kind: safeExpertString(item.kind, 40),
    memoryKey: safeExpertString(item.memoryKey, 120),
    content: safeExpertString(item.content, 300),
    confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : undefined,
    validFrom: safeExpertString(item.validFrom, 40),
    validTo: safeExpertString(item.validTo, 40),
    updatedAt: safeExpertString(item.updatedAt, 40),
  }));
  const recentMessages = normalizeHistory(history).map((item) => ({ role: item.role, content: safeExpertString(item.content, 800) })).filter((item) => item.content);
  const context = {
    generatedAt,
    sourceUpdated: Boolean(sourceUpdated),
    salesSummary: projectSalesSummary(salesReview),
    expertFindings: relevantFindings(expertReport || {}, safeTopicPack),
    salesMemoryContext: currentMemories,
    recentMessages,
    question: trim(question).slice(0, 2_000),
    clarificationNeeded: ambiguous,
    minimalIndexes: { members: memberIndex, policies: policyIndex },
    topicPack: safeTopicPack,
    topicData: topicDataForPack({ topicPack: safeTopicPack, policies, expertReport, financeSummary }),
    conversationTargets: safeConversationTargets,
    ...(displayReplacements ? { displayReplacements: boundedItems(displayReplacements, 20).map((item) => ({ token: safeExpertString(item.token, 40), value: safeExpertString(item.value, 40) })).filter((item) => item.token && item.value) } : {}),
  };
  const truncatedSections = new Set();
  if (trim(question).length > 2_000) truncatedSections.add('question');
  if ((topicPack?.memberRefs?.length || 0) > 2 || (topicPack?.policyRefs?.length || 0) > 3 || (Array.isArray(members) && members.length > 2) || (Array.isArray(policies) && policies.length > 3)) truncatedSections.add('projectionLimits');
  const publicLengthOf = () => JSON.stringify(context).length;
  while (publicLengthOf() > 10_500 && context.recentMessages.length) {
    context.recentMessages.shift();
    truncatedSections.add('history');
  }
  for (const key of ['priorityFindings', 'memberFindings', 'confirmedFacts', 'verificationItems']) {
    while (publicLengthOf() > 10_500 && context.expertFindings?.[key]?.length) {
      context.expertFindings[key].pop();
      truncatedSections.add('expertFindings');
    }
  }
  while (publicLengthOf() > 10_500 && context.salesMemoryContext.length) {
    context.salesMemoryContext.pop();
    truncatedSections.add('salesMemoryContext');
  }
  if (publicLengthOf() > 10_500 && context.topicData) {
    context.topicData = null;
    truncatedSections.add('topicData');
  }
  while (publicLengthOf() > 10_500 && context.minimalIndexes.policies.length) {
    context.minimalIndexes.policies.pop();
    truncatedSections.add('minimalIndexes');
  }
  while (publicLengthOf() > 10_500 && context.minimalIndexes.members.length) {
    context.minimalIndexes.members.pop();
    truncatedSections.add('minimalIndexes');
  }
  if (publicLengthOf() > 10_500 && (context.conversationTargets.lastExplicitTarget || context.conversationTargets.activeOpportunity)) {
    context.conversationTargets = { lastExplicitTarget: null, activeOpportunity: null };
    truncatedSections.add('conversationTargets');
  }
  const publicLength = publicLengthOf();
  context.telemetry = {
    stage: 'family_sales_chat_context',
    expertReused: Boolean(expertReport),
    selectedMemberCount: memberIndex.length,
    selectedPolicyCount: policyIndex.length,
    topicPackType: topicPack?.type || null,
    indicatorCount: topicPack?.type === 'policy_indicators' ? policyIndex.length : 0,
    estimatedInputCharacters: publicLength,
    estimatedInputTokens: Math.ceil(publicLength / 2),
    truncatedSections: [...truncatedSections],
    truncations: {
      history: Math.max(0, (Array.isArray(history) ? history.length : 0) - HISTORY_LIMIT),
      memories: Math.max(0, memoryList.length - 8),
    },
  };
  if (JSON.stringify(context).length > 12_000) {
    truncatedSections.add('minimalFallback');
    const minimalContext = {
      generatedAt: context.generatedAt,
      sourceUpdated: context.sourceUpdated,
      salesSummary: context.salesSummary?.conclusion ? { conclusion: context.salesSummary.conclusion } : null,
      question: context.question,
      clarificationNeeded: context.clarificationNeeded,
      topicPack: null,
      ...(context.displayReplacements ? { displayReplacements: context.displayReplacements.slice(0, 12) } : {}),
      telemetry: { ...context.telemetry, selectedMemberCount: 0, selectedPolicyCount: 0, topicPackType: null, indicatorCount: 0, truncatedSections: [...truncatedSections] },
    };
    minimalContext.telemetry.estimatedInputCharacters = JSON.stringify(minimalContext).length;
    minimalContext.telemetry.estimatedInputTokens = Math.ceil(minimalContext.telemetry.estimatedInputCharacters / 2);
    if (JSON.stringify(minimalContext).length > 12_000) {
      delete minimalContext.displayReplacements;
      minimalContext.telemetry.truncatedSections.push('displayReplacements');
    }
    return minimalContext;
  }
  return context;
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
  const { displayReplacements: _displayReplacements, ...publicSource } = source;
  return JSON.stringify({ ...publicSource, ...(source.familyInput ? { familyInput } : {}) }, null, 2);
}

function chatDirectIdentifiers(context = {}) {
  if (context?.familyInput) return familySalesReviewDirectIdentifiers(context.familyInput);
  return { names: (context?.displayReplacements || []).map((item) => trim(item?.value)).filter(Boolean) };
}

function restoreChatDisplayText(text = '', context = {}) {
  if (context?.familyInput) return restoreFamilySalesReviewDisplayText(text, context.familyInput);
  let result = String(text || '');
  for (const replacement of context?.displayReplacements || []) {
    if (trim(replacement?.token) && trim(replacement?.value)) result = result.split(replacement.token).join(replacement.value);
  }
  return result.replace(/\{\{id_number_\d+\}\}/gu, '身份证号已脱敏');
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
  return [
    {
      role: 'system',
      content: [
        '你是一名保险营销专家，面向保险顾问提供家庭销售建议续聊支持。',
        resolvedSkillPrompt.promptHint,
        `本轮启用 skills：${resolvedSkillPrompt.skills.map((skill) => skill.label).join('、') || '通用保险续聊'}`,
        '你要基于已提供的专家结论、结构化销售摘要、相关记忆和至多一个专题包继续回答，不要重新做全家全面分析。',
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
        '11. 如果 clarificationNeeded=true 或专题包无法定位对象，请先请顾问明确具体成员、保单或险种，不得回退猜测全家详情。',
        '12. 两级缺失措辞必须严格区分：无关联保单或指标时写“当前已录入保单中未发现”；已有相关保单但责任未识别时写“暂按未配置关注，需核对合同”。禁止写“客户确认没有”。',
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
    const directIdentifiers = chatDirectIdentifiers(context);
    const skillPrompt = await selectAgentSkillPromptWithDeepSeek({
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
      max_tokens: config.maxTokens,
      messages: buildFamilySalesChatMessages({ context, history, question: userQuestion, skillPrompt }),
    };
    if (DEEPSEEK_V4_MODELS.has(config.model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = DEFAULT_REASONING_EFFORT;
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
      content: sanitizeFamilySalesChatPublicIdentity(
        restoreChatDisplayText(enforceVerifiedCashflowAmounts(upstreamContent, context?.familyInput || {}), context),
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
