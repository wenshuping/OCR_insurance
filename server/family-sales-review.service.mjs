import {
  canonicalProductIdForRecord,
  resolveRecordCompany,
  resolveRecordProductName,
} from './canonical-product-id.mjs';
import {
  findPolicyCoverageIndicators,
  policyCanonicalProductIds,
  policyProductIndicatorKeys,
} from './policy-ocr.domain.mjs';
import {
  selectAgentSkillPrompt,
  selectAgentSkillPromptWithDeepSeek,
} from './agent-skill-router.service.mjs';
import { evidenceVerificationFields } from './evidence-classification.service.mjs';
import { resolvePolicyValidityStatus } from '../src/policy-validity.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_FAMILY_REVIEW_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 16_000;
const DEFAULT_DEEPSEEK_REASONING_EFFORT = 'high';
const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const DISPLAY_REPLACEMENTS = Symbol('familySalesReviewDisplayReplacements');
const ID_NUMBER_TOKEN_PATTERN = /\{\{id_number_\d+\}\}/gu;
const CHINA_ID_NUMBER_PATTERN = /\b(?:[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})\b/gu;
const SENSITIVE_ID_KEY_PATTERN = /(?:idNumber|idCard|identityNumber|certificateNumber|certificateNo|certNumber|certNo|cardNumber|cardNo|证件号码|身份证号码)/iu;

function trim(value) {
  return String(value || '').trim();
}

function normalizeLookupText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || trim(value) === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseDate(value) {
  const text = trim(value);
  if (!text) return null;
  const match = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/u);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3])
  ) {
    return null;
  }
  return date;
}

function ageFromBirthday(birthday, now = new Date()) {
  const birth = parseDate(birthday);
  if (!birth || !Number.isFinite(now.getTime())) return null;
  let age = now.getFullYear() - birth.getFullYear();
  const beforeBirthday = now.getMonth() < birth.getMonth()
    || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 ? age : null;
}

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function unique(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = trim(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

function take(items, limit) {
  return (Array.isArray(items) ? items : []).slice(0, limit);
}

function formatMoney(value) {
  const number = finiteNumber(value);
  if (number === null || number <= 0) return '待核实';
  if (number >= 10_000) return `${Math.round(number / 10_000)}万`;
  return `${Math.round(number)}元`;
}

function withCode(error, code, status) {
  error.code = code;
  if (status) error.status = status;
  return error;
}

function applyTextReplacements(text = '', replacements = [], direction = 'tokenToName') {
  let result = String(text || '');
  for (const replacement of Array.isArray(replacements) ? replacements : []) {
    const from = direction === 'nameToToken' ? trim(replacement.value) : trim(replacement.token);
    const to = direction === 'nameToToken' ? trim(replacement.token) : trim(replacement.value);
    if (!from || !to) continue;
    result = result.split(from).join(to);
  }
  return result;
}

function createPrivacyTokenState() {
  return { values: new Map(), nextIdNumberIndex: 1 };
}

function privacyTokenForValue(value, state = createPrivacyTokenState()) {
  const text = trim(value);
  if (!text) return '';
  if (!state.values.has(text)) {
    state.values.set(text, `{{id_number_${state.nextIdNumberIndex}}}`);
    state.nextIdNumberIndex += 1;
  }
  return state.values.get(text);
}

function redactIdentityNumbersInText(value = '', state = createPrivacyTokenState()) {
  return String(value || '').replace(CHINA_ID_NUMBER_PATTERN, (match) => privacyTokenForValue(match, state));
}

function isSensitiveIdentityKey(key = '') {
  return SENSITIVE_ID_KEY_PATTERN.test(String(key || ''));
}

function privacySafeValue(value, key = '', state = createPrivacyTokenState()) {
  if (Array.isArray(value)) {
    return value.map((item) => privacySafeValue(item, '', state));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([itemKey, item]) => [itemKey, privacySafeValue(item, itemKey, state)]),
    );
  }
  if (value === null || value === undefined) return value;
  if (isSensitiveIdentityKey(key) && trim(value)) {
    return privacyTokenForValue(value, state);
  }
  return typeof value === 'string' ? redactIdentityNumbersInText(value, state) : value;
}

function privacySafeInputJson(input = {}) {
  const state = createPrivacyTokenState();
  const safeInput = privacySafeValue(input, '', state);
  return applyTextReplacements(
    JSON.stringify(safeInput, null, 2),
    displayReplacementsForInput(input),
    'nameToToken',
  );
}

function removeSensitiveTokens(text = '') {
  return String(text || '').replace(ID_NUMBER_TOKEN_PATTERN, '身份证号已脱敏');
}

export function privacySafeFamilySalesReviewInputJson(input = {}) {
  return privacySafeInputJson(input);
}

export function restoreFamilySalesReviewDisplayText(text = '', input = {}) {
  return removeSensitiveTokens(
    applyTextReplacements(
      text,
      displayReplacementsForInput(input),
      'tokenToName',
    ),
  );
}

function displayReplacementsForInput(input = {}) {
  return Array.isArray(input?.[DISPLAY_REPLACEMENTS]) ? input[DISPLAY_REPLACEMENTS] : [];
}

function isDeepSeekV4Model(model) {
  return DEEPSEEK_V4_MODELS.has(trim(model));
}

function usesDeepSeekThinkingMode(model) {
  const value = trim(model);
  return value === 'deepseek-reasoner' || isDeepSeekV4Model(value);
}

function resolveFamilySalesReviewConfig(env = process.env) {
  const timeoutCandidate = Number(env.DEEPSEEK_FAMILY_REVIEW_TIMEOUT_MS || env.DEEPSEEK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const maxTokensCandidate = Number(env.DEEPSEEK_FAMILY_REVIEW_MAX_TOKENS || DEFAULT_MAX_TOKENS);
  return {
    apiKey: trim(env.DEEPSEEK_API_KEY),
    baseUrl: trim(env.DEEPSEEK_BASE_URL) || DEFAULT_DEEPSEEK_BASE_URL,
    model: trim(env.DEEPSEEK_FAMILY_REVIEW_MODEL) || trim(env.DEEPSEEK_MODEL) || DEFAULT_FAMILY_REVIEW_MODEL,
    timeoutMs: Number.isFinite(timeoutCandidate) ? Math.max(10_000, timeoutCandidate) : DEFAULT_TIMEOUT_MS,
    maxTokens: Number.isFinite(maxTokensCandidate) ? Math.max(2_000, maxTokensCandidate) : DEFAULT_MAX_TOKENS,
  };
}

export function isFamilySalesReviewConfigured(env = process.env) {
  return Boolean(resolveFamilySalesReviewConfig(env).apiKey);
}

function recordMatchesPolicy(policy = {}, record = {}) {
  const policyCanonicalIds = new Set(policyCanonicalProductIds(policy));
  const recordCanonicalId = canonicalProductIdForRecord(record, policy.company);
  if (policyCanonicalIds.size && recordCanonicalId) {
    return policyCanonicalIds.has(recordCanonicalId);
  }
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return false;
  const company = normalizeLookupText(resolveRecordCompany(record, policy.company));
  const productName = normalizeLookupText(resolveRecordProductName(record));
  return keys.has(`${company}\u001f${productName}`);
}

function productEvidenceKey(policy = {}, fallbackRecord = {}) {
  const canonicalId = policyCanonicalProductIds(policy)[0] || canonicalProductIdForRecord(fallbackRecord, policy.company);
  if (canonicalId) return `canonical:${canonicalId}`;
  const company = normalizeLookupText(policy.company || resolveRecordCompany(fallbackRecord));
  const productName = normalizeLookupText(policy.name || resolveRecordProductName(fallbackRecord));
  return `${company}\u001f${productName}`;
}

function sourceUrl(record = {}) {
  return trim(record.officialUrl || record.url || record.sourceUrl || record.source_url || record.fileUrl);
}

function knowledgeSummary(record = {}) {
  const evidence = evidenceVerificationFields(record);
  return {
    id: record.id ?? '',
    company: trim(record.company || resolveRecordCompany(record)),
    productName: trim(record.productName || resolveRecordProductName(record)),
    productType: trim(record.productType || record.category || record.productCategory),
    title: trim(record.title || record.sourceTitle || record.name),
    official: record.official === true,
    sourceKind: trim(record.sourceKind),
    evidenceLevel: trim(record.evidenceLevel || record.sourceLevel),
    verificationStatus: evidence.verificationStatus,
    verificationLabel: evidence.verificationLabel,
    referenceOnly: evidence.referenceOnly,
    url: sourceUrl(record),
  };
}

function indicatorSummary(record = {}) {
  const evidence = evidenceVerificationFields(record);
  return {
    id: record.id ?? '',
    company: trim(record.company || resolveRecordCompany(record)),
    productName: trim(record.productName || resolveRecordProductName(record)),
    coverageType: trim(record.coverageType || record.coverage_type || record.category),
    liability: trim(record.liability || record.name || record.title),
    formulaText: trim(record.formulaText || record.formula || record.calcText),
    value: record.value ?? '',
    unit: trim(record.unit),
    responsibilityScope: trim(record.responsibilityScope || record.scope),
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

function optionalResponsibilitySummary(record = {}) {
  const evidence = evidenceVerificationFields(record);
  return {
    id: record.id ?? '',
    company: trim(record.company || resolveRecordCompany(record)),
    productName: trim(record.productName || resolveRecordProductName(record)),
    liability: trim(record.liability || record.name || record.title),
    quantificationStatus: trim(record.quantificationStatus),
    sourceKind: trim(record.sourceKind),
    evidenceLevel: trim(record.evidenceLevel || record.sourceLevel),
    verificationStatus: evidence.verificationStatus,
    verificationLabel: evidence.verificationLabel,
    referenceOnly: evidence.referenceOnly,
    sourceExcerpt: trim(record.sourceExcerpt || record.excerpt),
    sourceUrl: sourceUrl(record),
  };
}

function buildOfficialEvidence({ policies = [], knowledgeRecords = [], indicatorRecords = [], optionalResponsibilityRecords = [] } = {}) {
  const products = new Map();
  for (const policy of Array.isArray(policies) ? policies : []) {
    const key = productEvidenceKey(policy);
    const knowledge = (Array.isArray(knowledgeRecords) ? knowledgeRecords : []).filter((record) => recordMatchesPolicy(policy, record));
    const indicators = findPolicyCoverageIndicators(policy, indicatorRecords);
    const optionalResponsibilities = (Array.isArray(optionalResponsibilityRecords) ? optionalResponsibilityRecords : [])
      .filter((record) => recordMatchesPolicy(policy, record));

    const existing = products.get(key) || {
      key,
      company: trim(policy.company),
      productName: trim(policy.name),
      canonicalProductIds: [],
      relatedPolicyIds: [],
      allSources: [],
      officialSources: [],
      referenceSources: [],
      officialIndicators: [],
      optionalResponsibilities: [],
      evidenceWarnings: [],
    };

    existing.relatedPolicyIds = unique([...existing.relatedPolicyIds, String(policy.id || '')]);
    existing.canonicalProductIds = unique([...existing.canonicalProductIds, ...policyCanonicalProductIds(policy)]);
    const knowledgeSummaries = knowledge.map(knowledgeSummary);
    existing.allSources = [
      ...existing.allSources,
      ...knowledgeSummaries,
    ];
    existing.officialSources = [
      ...existing.officialSources,
      ...knowledgeSummaries.filter((record) => record.referenceOnly !== true),
    ];
    existing.referenceSources = [
      ...existing.referenceSources,
      ...knowledgeSummaries.filter((record) => record.referenceOnly === true),
    ];
    existing.officialIndicators = [
      ...existing.officialIndicators,
      ...indicators.map(indicatorSummary),
    ];
    existing.optionalResponsibilities = [
      ...existing.optionalResponsibilities,
      ...optionalResponsibilities.map(optionalResponsibilitySummary),
    ];

    const productTypes = unique(existing.officialSources.map((record) => record.productType));
    if (productTypes.length > 1) {
      existing.evidenceWarnings = unique([
        ...existing.evidenceWarnings,
        `官网知识库产品类型存在冲突：${productTypes.join('、')}`,
      ]);
    }

    products.set(key, existing);
  }

  return Array.from(products.values()).map((product) => ({
    ...product,
    allSources: dedupeObjects(product.allSources, (record) => `${record.url}\u001f${record.productType}\u001f${record.productName}\u001f${record.verificationStatus}`).slice(0, 8),
    officialSources: dedupeObjects(product.officialSources, (record) => `${record.url}\u001f${record.productType}\u001f${record.productName}`).slice(0, 5),
    referenceSources: dedupeObjects(product.referenceSources, (record) => `${record.url}\u001f${record.productType}\u001f${record.productName}`).slice(0, 5),
    officialIndicators: dedupeObjects(product.officialIndicators, (record) => `${record.coverageType}\u001f${record.liability}\u001f${record.formulaText}`).slice(0, 40),
    optionalResponsibilities: dedupeObjects(product.optionalResponsibilities, (record) => `${record.liability}\u001f${record.sourceExcerpt}`).slice(0, 30),
  }));
}

function dedupeObjects(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = trim(keyFn(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function policyValidity(policy = {}) {
  const status = resolvePolicyValidityStatus(policy.coveragePeriod, {
    effectiveDate: policy.date || policy.effectiveDate,
    insuredBirthday: policy.insuredBirthday,
  });
  const statusText = trim([
    policy.policyStatus,
    policy.policyState,
    policy.contractStatus,
    policy.validityStatus,
    policy.status,
  ].filter(Boolean).join(' '));
  const inactiveByText = /(失效|停效|中止|终止|退保|过期|inactive|expired|lapsed|terminated|cancelled|canceled)/iu.test(statusText);
  return {
    label: inactiveByText ? '失效或需核实' : status.label,
    tone: inactiveByText ? 'expired' : status.tone,
    expiresAt: status.expiresAt ? status.expiresAt.toISOString() : '',
    statusText,
  };
}

function latestCashValue(cashValues = []) {
  return (Array.isArray(cashValues) ? cashValues : []).reduce((latest, row) => {
    const policyYear = finiteNumber(row?.policyYear);
    const cashValue = finiteNumber(row?.cashValue);
    if (policyYear === null || cashValue === null) return latest;
    if (!latest || policyYear > latest.policyYear) {
      return { policyYear, cashValue, age: row?.age ?? '', source: trim(row?.source) };
    }
    return latest;
  }, null);
}

function relationFallback(member = {}, index = 0) {
  return trim(member.relationLabel)
    || trim(member.relationToCore)
    || trim(member.role)
    || `成员${Number(index) + 1}`;
}

function buildMemberReferenceContext({ members = [] } = {}) {
  const activeMembers = (Array.isArray(members) ? members : [])
    .filter((member) => trim(member?.status || 'active') === 'active');
  const refById = new Map();
  const idByName = new Map();
  const memberById = new Map();
  const displayReplacements = [];
  const relationCounts = new Map();
  activeMembers.forEach((member, index) => {
    const relation = relationFallback(member, index);
    relationCounts.set(relation, (relationCounts.get(relation) || 0) + 1);
  });
  const relationIndexes = new Map();
  activeMembers.forEach((member, index) => {
    const memberId = Number(member.id || 0);
    if (!memberId) return;
    memberById.set(memberId, member);
    const relation = relationFallback(member, index);
    const nextIndex = (relationIndexes.get(relation) || 0) + 1;
    relationIndexes.set(relation, nextIndex);
    const token = `{{member_${index + 1}}}`;
    refById.set(memberId, token);
    const displayName = trim(member.name) || (relationCounts.get(relation) > 1 ? `${relation}${nextIndex}` : relation);
    displayReplacements.push({ token, value: displayName });
    const nameKey = normalizeLookupText(member.name);
    if (nameKey) idByName.set(nameKey, memberId);
  });
  return { activeMembers, refById, idByName, memberById, displayReplacements };
}

function resolvePolicyPerson(policy = {}, role = 'insured', memberContext = {}, generatedAt = new Date().toISOString()) {
  const idField = role === 'applicant' ? 'applicantMemberId' : 'insuredMemberId';
  const nameField = role === 'applicant' ? 'applicantMemberName' : 'insuredMemberName';
  const rawNameField = role === 'applicant' ? 'applicant' : 'insured';
  const birthdayField = role === 'applicant' ? 'applicantBirthday' : 'insuredBirthday';
  const relationField = role === 'applicant' ? 'applicantRelationLabel' : 'insuredRelationLabel';
  const relationSnapshotField = role === 'applicant' ? 'applicantRelationSnapshot' : 'insuredRelationSnapshot';
  const memberId = Number(policy[idField] || 0)
    || memberContext.idByName?.get(normalizeLookupText(policy[nameField] || policy[rawNameField]))
    || 0;
  const member = memberContext.memberById?.get(memberId) || {};
  const birthday = trim(member.birthday || policy[birthdayField]);
  return {
    memberRef: memberContext.refById?.get(memberId) || '未匹配成员',
    relationLabel: trim(policy[relationField] || policy[relationSnapshotField]),
    birthday,
    age: ageFromBirthday(birthday, new Date(generatedAt)),
  };
}

function policySummary(policy = {}, memberContext = {}, generatedAt = new Date().toISOString()) {
  const cashflowEntries = Array.isArray(policy.cashflowEntries) ? policy.cashflowEntries : [];
  const scenarioEntries = Array.isArray(policy.scenarioEntries) ? policy.scenarioEntries : [];
  const cashValues = Array.isArray(policy.cashValues) ? policy.cashValues : [];
  const positiveCashflowTotal = cashflowEntries.reduce((sum, row) => sum + Math.max(0, asNumber(row?.amount)), 0);
  const applicant = resolvePolicyPerson(policy, 'applicant', memberContext, generatedAt);
  const insured = resolvePolicyPerson(policy, 'insured', memberContext, generatedAt);
  return {
    id: policy.id,
    company: trim(policy.company),
    name: trim(policy.name),
    canonicalProductId: trim(policy.canonicalProductId),
    applicantMemberRef: applicant.memberRef,
    applicantRelationLabel: applicant.relationLabel,
    applicantBirthday: applicant.birthday,
    applicantAge: applicant.age,
    insuredMemberRef: insured.memberRef,
    insuredRelationLabel: insured.relationLabel,
    insuredBirthday: insured.birthday,
    insuredAge: insured.age,
    familyBindingSource: trim(policy.familyBindingSource),
    amount: asNumber(policy.amount),
    firstPremium: asNumber(policy.firstPremium),
    paymentPeriod: trim(policy.paymentPeriod),
    coveragePeriod: trim(policy.coveragePeriod),
    effectiveDate: trim(policy.date || policy.effectiveDate),
    validity: policyValidity(policy),
    plans: take(policy.plans, 20).map((plan) => ({
      name: trim(plan?.name || plan?.productName || plan?.matchedProductName),
      matchedProductName: trim(plan?.matchedProductName),
      canonicalProductId: trim(plan?.canonicalProductId),
      amount: asNumber(plan?.amount),
      firstPremium: asNumber(plan?.firstPremium),
      paymentPeriod: trim(plan?.paymentPeriod),
      coveragePeriod: trim(plan?.coveragePeriod),
    })),
    sources: take(policy.sources, 12).map(knowledgeSummary),
    responsibilities: take(policy.responsibilities, 20).map((item) => {
      const evidence = evidenceVerificationFields(item);
      return {
        productName: trim(item?.productName),
        coverageType: trim(item?.coverageType || item?.title || item?.liability),
        scenario: trim(item?.scenario || item?.condition || item?.description),
        payout: trim(item?.payout),
        note: trim(item?.note),
        sourceKind: trim(item?.sourceKind),
        evidenceLevel: trim(item?.evidenceLevel || item?.sourceLevel),
        verificationStatus: evidence.verificationStatus,
        verificationLabel: evidence.verificationLabel,
        referenceOnly: evidence.referenceOnly,
      };
    }),
    coverageIndicators: take(policy.coverageIndicators, 30).map(indicatorSummary),
    optionalResponsibilities: take(policy.optionalResponsibilities, 20).map(optionalResponsibilitySummary),
    cashValue: {
      latest: latestCashValue(cashValues),
      rowCount: cashValues.length,
    },
    cashflow: {
      rowCount: cashflowEntries.length,
      positiveTotal: positiveCashflowTotal,
      samples: take(cashflowEntries, 12).map((row) => ({
        year: row?.year ?? '',
        age: row?.age ?? '',
        amount: asNumber(row?.amount),
        liability: trim(row?.liability),
        calcText: trim(row?.calcText),
      })),
    },
    scenarioEntries: take(scenarioEntries, 12).map((row) => ({
      type: trim(row?.type || row?.coverageType),
      label: trim(row?.label || row?.liability),
      amount: asNumber(row?.amount),
      calcText: trim(row?.calcText),
    })),
  };
}

function memberSummaries({ policies = [], family = {}, memberContext = {}, generatedAt = new Date().toISOString() } = {}) {
  const byMemberId = new Map();
  const activeMembers = memberContext.activeMembers || [];
  const generatedDate = new Date(generatedAt);
  activeMembers.forEach((member) => {
    byMemberId.set(Number(member.id), { insuredPolicyIds: [], applicantPolicyIds: [] });
  });

  for (const policy of Array.isArray(policies) ? policies : []) {
    const insuredId = Number(policy.insuredMemberId || 0)
      || memberContext.idByName?.get(normalizeLookupText(policy.insuredMemberName || policy.insured));
    const applicantId = Number(policy.applicantMemberId || 0)
      || memberContext.idByName?.get(normalizeLookupText(policy.applicantMemberName || policy.applicant));
    if (insuredId && byMemberId.has(insuredId)) byMemberId.get(insuredId).insuredPolicyIds.push(policy.id);
    if (applicantId && byMemberId.has(applicantId)) byMemberId.get(applicantId).applicantPolicyIds.push(policy.id);
  }

  return activeMembers.map((member, index) => {
    const policyRefs = byMemberId.get(Number(member.id)) || { insuredPolicyIds: [], applicantPolicyIds: [] };
    const policyIds = unique([...policyRefs.insuredPolicyIds, ...policyRefs.applicantPolicyIds].map(String));
    return {
      memberRef: memberContext.refById?.get(Number(member.id)) || relationFallback(member, index),
      relationLabel: trim(member.relationLabel),
      relationToCore: trim(member.relationToCore),
      role: trim(member.role),
      gender: trim(member.gender),
      birthday: trim(member.birthday),
      notes: trim(member.notes),
      age: ageFromBirthday(member.birthday, generatedDate),
      isCore: Number(member.id) === Number(family.coreMemberId || 0),
      insuredPolicyCount: policyRefs.insuredPolicyIds.length,
      applicantPolicyCount: policyRefs.applicantPolicyIds.length,
      policyCount: policyIds.length,
      hasPolicy: policyIds.length > 0,
      policyIds,
    };
  });
}

function duplicatePolicyHints(policies = []) {
  const groups = new Map();
  for (const policy of Array.isArray(policies) ? policies : []) {
    const key = [
      normalizeLookupText(policy.insuredMemberRef),
      normalizeLookupText(policy.name),
      asNumber(policy.amount),
      asNumber(policy.firstPremium),
      normalizeLookupText(policy.coveragePeriod),
    ].join('\u001f');
    const rows = groups.get(key) || [];
    rows.push(policy);
    groups.set(key, rows);
  }
  return Array.from(groups.values())
    .filter((rows) => rows.length > 1)
    .map((rows) => ({
      policyIds: rows.map((row) => row.id),
      insuredMemberRef: trim(rows[0]?.insuredMemberRef),
      productName: trim(rows[0]?.name),
      amount: asNumber(rows[0]?.amount),
      firstPremium: asNumber(rows[0]?.firstPremium),
      coveragePeriod: trim(rows[0]?.coveragePeriod),
      note: '同一被保人、产品、保额、首期保费和保险期间相同，建议销售先核实是否重复录入或多张有效合同。',
    }));
}

function memberLabel(member = {}) {
  const relation = trim(member.relationLabel || member.relationToCore || member.role);
  return `${trim(member.memberRef) || '家庭成员'}${relation ? `（${relation}）` : ''}`;
}

function firstMemberByRole(members = [], rolePattern = /core|adult|unknown/u) {
  return (Array.isArray(members) ? members : []).find((member) => rolePattern.test(trim(member.role || member.relationToCore))) || members?.[0] || {};
}

function policyDisplayName(policy = {}) {
  return trim([policy.company, policy.name].filter(Boolean).join(' ')) || '现有保单';
}

function stripMarkdownListMarker(value) {
  return trim(String(value || '').replace(/^[-*]\s*/u, '').replace(/^\d+[.．、]\s*/u, ''));
}

function isPlaceholderMarkdownLine(value) {
  const normalized = stripMarkdownListMarker(value).normalize('NFKC').replace(/\s+/gu, '').trim();
  return !normalized || /^[•·\-_*—–]+$/u.test(normalized) || /^(暂无明确结论|暂无|无|待补充)$/u.test(normalized);
}

function sectionHasUsableContent(content = '', titlePattern = /./u) {
  let matching = false;
  for (const rawLine of String(content || '').replace(/\r/gu, '').split('\n')) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^#{1,2}\s*(.+)$/u);
    if (headingMatch) {
      const title = trim(headingMatch[1]).replace(/^([一二三四五六七八九十]+|[0-9]+)[、.．]\s*/u, '');
      matching = titlePattern.test(title);
      continue;
    }
    if (/^#{3,6}\s+/u.test(line)) continue;
    if (matching && !isPlaceholderMarkdownLine(line)) return true;
  }
  return false;
}

function isWealthPolicy(policy = {}) {
  const text = [
    policy.name,
    policy.coveragePeriod,
    ...(Array.isArray(policy.plans) ? policy.plans.map((plan) => `${plan.name || ''}${plan.matchedProductName || ''}`) : []),
  ].join(' ');
  return /(年金|终身寿|两全|护理|分红|万能|现金价值|现金流|领取|养老|教育金)/u.test(text)
    || finiteNumber(policy.cashValue?.latest?.cashValue) !== null
    || asNumber(policy.cashflow?.positiveTotal) > 0;
}

function policiesForMember(member = {}, policies = []) {
  const policyIds = new Set((Array.isArray(member.policyIds) ? member.policyIds : []).map(String));
  return (Array.isArray(policies) ? policies : []).filter((policy) => {
    if (policyIds.has(String(policy.id))) return true;
    return trim(policy.insuredMemberRef) === trim(member.memberRef)
      || trim(policy.applicantMemberRef) === trim(member.memberRef);
  });
}

function memberCoverageText(policies = []) {
  return unique((Array.isArray(policies) ? policies : []).flatMap((policy) => [
    policy.name,
    policy.coveragePeriod,
    ...(Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators.map((indicator) => `${indicator.coverageType || ''}${indicator.liability || ''}`) : []),
    ...(Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities.map((row) => `${row.coverageType || ''}${row.liability || ''}`) : []),
    ...(Array.isArray(policy.scenarioEntries) ? policy.scenarioEntries.map((row) => `${row.type || ''}${row.label || ''}`) : []),
    ...(Array.isArray(policy.plans) ? policy.plans.map((plan) => `${plan.name || ''}${plan.matchedProductName || ''}`) : []),
  ])).join(' ');
}

function buildMemberGapSection(input = {}) {
  const members = Array.isArray(input.members) ? input.members : [];
  const policies = Array.isArray(input.policies) ? input.policies : [];
  if (!members.length) {
    return [
      '## 三、成员级保障缺口',
      '- 家庭成员资料未提供，需先补齐成员清单、生日、社保状态和已有保单，再判断个人保障缺口。',
    ].join('\n');
  }

  const lines = ['## 三、成员级保障缺口'];
  for (const member of members) {
    const relatedPolicies = policiesForMember(member, policies);
    const coverageText = memberCoverageText(relatedPolicies);
    const ageText = finiteNumber(member.age) === null ? '年龄待核实' : `${Math.round(Number(member.age))}岁`;
    const policyText = relatedPolicies.length
      ? `已关联 ${relatedPolicies.length} 张保单`
      : '系统内暂未关联保单';
    const gaps = [];
    if (!relatedPolicies.length) {
      gaps.push('先核实是否有保单未录入；确认无保障后，优先排查医疗险、意外险、重疾/寿险责任');
    } else {
      if (!/(医疗|住院|门诊|医保外|药品费|手术费)/u.test(coverageText)) {
        gaps.push('医疗报销责任待核实，重点看百万医疗、住院医疗、医保外费用和续保条件');
      }
      if (!/(意外|伤残|残疾)/u.test(coverageText)) {
        gaps.push('意外医疗和意外伤残责任待核实');
      }
      if (!/(重疾|重大疾病|轻症|中症|疾病)/u.test(coverageText)) {
        gaps.push('重疾/疾病给付责任待核实');
      }
      if (member.isCore || /core|self|spouse|adult|本人|配偶/u.test(`${member.role || ''}${member.relationLabel || ''}${member.relationToCore || ''}`)) {
        gaps.push('作为家庭责任成员，需额外测算身故/全残、定寿和收入中断责任');
      }
    }
    if (!gaps.length) {
      gaps.push('已有责任需结合保额、有效状态、官网条款证据和家庭责任重新复核，暂不直接判断为充足');
    }
    lines.push(`- ${memberLabel(member)}，${ageText}：${policyText}；${gaps.join('；')}。`);
  }
  return lines.join('\n');
}

function productSuggestionEvidence(policy = {}) {
  const indicatorLabels = unique([
    ...(Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators.map((indicator) => trim(indicator.coverageType || indicator.liability)) : []),
    ...(Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities.map((row) => trim(row.coverageType || row.liability)) : []),
  ]).slice(0, 3);
  const signals = [];
  const validityLabel = trim(policy.validity?.label || policy.validity?.status);
  if (policy.validity?.tone === 'expired') {
    signals.push('效力状态需优先复核，避免拿失效保单做保障依据');
  } else if (validityLabel) {
    signals.push(`效力状态显示为${validityLabel}，面谈时仍需核对合同原件`);
  }
  if (indicatorLabels.length) {
    signals.push(`可围绕${indicatorLabels.join('、')}做责任解释和缺口对比`);
  } else {
    signals.push('官网责任指标不足，先补齐条款证据，再判断可切入责任');
  }
  if (isWealthPolicy(policy)) {
    signals.push('作为财富类/现金价值线索，重点核实现金价值、领取、减保、保单贷款和传承安排');
  }
  return signals.join('；');
}

function buildExistingProductSuggestionsSection(input = {}) {
  const policies = Array.isArray(input.policies) ? input.policies : [];
  if (!policies.length) {
    return [
      '## 五、已有产品逐项切入建议',
      '- 当前家庭暂无已录入保单，销售动作先放在补录电子保单、确认家庭成员和核实社保/既往症上。',
    ].join('\n');
  }
  return [
    '## 五、已有产品逐项切入建议',
    ...policies.slice(0, 20).map((policy) => {
      const insuredRef = trim(policy.insuredMemberRef) && trim(policy.insuredMemberRef) !== '未匹配成员'
        ? trim(policy.insuredMemberRef)
        : '被保人待匹配';
      return `- ${policyDisplayName(policy)}：被保人 ${insuredRef}；保额 ${formatMoney(policy.amount)}；首期/年交保费 ${formatMoney(policy.firstPremium)}；${productSuggestionEvidence(policy)}。`;
    }),
  ].join('\n');
}

function hasExpandedSalesPlan(content = '') {
  const text = String(content || '');
  return /销售方案展开/u.test(text)
    && /适合对象/u.test(text)
    && /客户痛点/u.test(text)
    && /推荐方向/u.test(text)
    && /预算[\//／]保额口径|预算|保额口径/u.test(text)
    && /需补资料/u.test(text)
    && /下一步动作/u.test(text);
}

function hasSalesScript(content = '') {
  const text = String(content || '');
  return /邀约面谈|销售话术/u.test(text)
    && /见面开场/u.test(text)
    && /风险洞察/u.test(text)
    && /保障缺口/u.test(text)
    && /理财险|养老|教育金/u.test(text)
    && /已经买过很多保险/u.test(text)
    && /暂时不想增加预算/u.test(text)
    && /理财险收益不确定/u.test(text);
}

function buildExpandedSalesPlanSection(input = {}) {
  const members = Array.isArray(input.members) ? input.members : [];
  const policies = Array.isArray(input.policies) ? input.policies : [];
  const coreMember = firstMemberByRole(members, /core|self|adult/u);
  const spouseMember = members.find((member) => /spouse|配偶/u.test(`${member.role || ''}${member.relationLabel || ''}${member.relationToCore || ''}`)) || firstMemberByRole(members, /adult/u);
  const uninsuredMember = Array.isArray(input.dataQuality?.membersWithoutPolicy)
    ? input.dataQuality.membersWithoutPolicy[0]
    : null;
  const wealthPolicy = policies.find(isWealthPolicy) || policies[0] || {};
  const annualPremium = policies.reduce((sum, policy) => sum + asNumber(policy.firstPremium), 0);
  const totalCoverage = policies.reduce((sum, policy) => sum + asNumber(policy.amount), 0);
  const budgetText = annualPremium > 0
    ? `可先以家庭现有首期/年交保费合计约 ${formatMoney(annualPremium)} 作为预算承受度参考，再让客户确认是否愿意新增预算。`
    : '客户预算、年收入、负债和现金流未提供，预算必须面谈核实，不直接假设新增保费。';
  const coverageText = totalCoverage > 0
    ? `现有录入保额合计约 ${formatMoney(totalCoverage)}，补强方案先围绕缺口责任和家庭收入责任重新测算。`
    : '现有保额口径不完整，需先补齐重疾、医疗、寿险、意外的保额与责任。';
  const targetCore = memberLabel(coreMember);
  const targetSpouse = memberLabel(spouseMember);
  const targetUninsured = uninsuredMember
    ? memberLabel(uninsuredMember)
    : (members.length ? '暂未发现无保单成员，仍需核实家庭成员是否完整' : '家庭成员资料待核实');
  const wealthPolicyName = policyDisplayName(wealthPolicy);

  return [
    '## 六、销售方案展开',
    '- 方案一：全家医疗与意外底座补强',
    `- 适合对象：${members.length ? members.map(memberLabel).join('、') : '全家成员，尤其是未完成保障核实的成员'}。`,
    '- 客户痛点：客户已经有部分给付型或财富类保单，但住院医疗、医保外费用、意外医疗和意外伤残责任通常最容易遗漏，容易出现“有保单但不能报销”的落差。',
    '- 推荐方向：先核实每位成员是否已有百万医疗、门急诊/住院医疗、意外医疗和伤残责任；缺口成员优先补齐医疗险和意外险，再谈重疾或寿险。',
    `- 预算/保额口径：${budgetText}医疗险重点看免赔额、报销范围、续保条件；意外险重点看伤残保额、意外医疗和职业类别。`,
    '- 销售话术：“我今天不是直接让您加保费，先帮您把全家的住院报销和意外伤残责任查清楚。很多家庭不是没买保险，而是出事时发现医疗费报销不上、伤残赔付不够。”',
    '- 需补资料：每位成员的社保/医保状态、已有医疗险保单页、职业类别、近期住院或体检异常。',
    '- 下一步动作：面谈时用家庭成员清单逐个打勾，确认谁有医疗、谁有意外、谁没有，再输出一页补强清单。',
    '',
    '- 方案二：顶梁柱收入成员重疾与定寿补强',
    `- 适合对象：${targetCore}${targetSpouse && targetSpouse !== targetCore ? `、${targetSpouse}` : ''}。`,
    '- 客户痛点：家庭收入责任通常集中在成年人身上，一旦重疾、身故或全残，现有财富型保单不一定能覆盖收入中断、贷款、父母赡养和子女教育责任。',
    '- 推荐方向：先测算顶梁柱的重疾保额、身故/全残保额和保障期限；若重疾不足，优先补足重疾险；若家庭负债或子女教育责任较重，再讨论定寿/高额寿险责任。',
    `- 预算/保额口径：${coverageText}如客户不愿新增预算，可先做保单精简、责任重配或分阶段补齐。`,
    '- 销售话术：“您现在不是没有保单，而是要确认这些保单在收入中断时能不能真正替家里扛住三到五年的现金流。我们先把责任缺口算出来，再决定要不要补。”',
    '- 需补资料：家庭年收入、房贷/车贷余额、子女教育预算、双方单位福利、既往症和体检异常。',
    '- 下一步动作：现场先定家庭顶梁柱，再用家庭责任清单测算重疾、寿险、医疗三条线的缺口。',
    '',
    '- 方案三：养老/教育金与财富传承配置',
    `- 适合对象：${targetCore || '顶梁柱'}，以及需要规划养老、教育金或传承安排的家庭；可结合 ${wealthPolicyName} 做现有资产复盘。`,
    '- 客户痛点：已有年金、终身寿、两全、护理险或带现金价值保单时，客户容易只看“交了多少钱”，没有看清未来现金流、保单贷款、减保、领取和传承安排。',
    '- 推荐方向：先把现有财富类保单的现金价值、未来领取、减保规则和分红/万能账户演示利益核实清楚，再判断是继续持有、做教育金/养老金分层，还是补充增额终身寿/年金类配置。',
    '- 预算/保额口径：理财险不能承诺收益或确定利率，只能基于合同现金价值、保单利益演示和客户确认的长期闲置资金来设计；新增预算必须来自客户确认的长期资金，不挤占医疗和重疾保障预算。',
    '- 销售话术：“财富类保单不是只看收益高不高，而是看哪笔钱什么时候确定能用、哪笔钱可以长期放、万一家庭责任变化时怎么调整。我们先把现有保单的现金流图画出来。”',
    '- 需补资料：现金价值表、利益演示表、万能账户结算利率/保底利率说明、家庭教育金和养老目标、可长期锁定资金规模。',
    '- 下一步动作：把现有财富类保单整理成年度现金流表，再给客户看“继续持有、减额交清/减保、补充配置”三种路径。',
    '',
    '- 方案四：无保单或资料缺口成员补录',
    `- 适合对象：${targetUninsured}。`,
    '- 客户痛点：系统里没有保单或资料不完整的成员，可能不是没有保障，而是保单没有录入；如果直接给方案，容易误判缺口。',
    '- 推荐方向：先补齐成员生日、社保状态、已有保单照片和健康告知情况；确认确实无保障后，再按“医疗险/意外险优先、重疾和寿险按家庭责任补充”的顺序推进。',
    '- 预算/保额口径：资料未完整前不直接报价；先确认年龄、健康、职业和已有保障，再给区间方案。',
    '- 销售话术：“这位家庭成员我先不急着建议买什么，第一步是确认是不是有保单没录进来。资料补齐后，我们再判断是真缺口还是系统缺资料。”',
    '- 需补资料：成员生日、身份证后四位可选、社保状态、现有保单照片、最近体检/就医情况。',
    '- 下一步动作：把缺资料成员列成补资料清单，约客户下次带保单原件或电子保单一起核对。',
  ].join('\n');
}

function buildSalesScriptSection() {
  return [
    '## 七、邀约面谈与销售话术',
    '- 1. 见面开场',
    '- 销售话术：“我这次不是来推某一款产品，而是先把您家现有保单做一次体检：哪些责任已经有，哪些责任重复，哪些成员还没覆盖，先让您心里有数。”',
    '- 销售话术：“如果最后发现不用加保，我也会直接告诉您；如果有缺口，我们再按优先级决定先补哪一块。”',
    '',
    '- 2. 风险洞察提问',
    '- 销售话术：“如果家里一个成年人连续一年不能工作，家庭开支、贷款和孩子教育金主要靠哪笔钱支撑？”',
    '- 销售话术：“您更担心大额医疗费报销不上，还是担心收入中断后家里现金流断掉？这两个问题对应的保险责任不一样。”',
    '',
    '- 3. 保障缺口切入',
    '- 销售话术：“从保单结构看，您家不是没有保险，而是要确认医疗、重疾、寿险、意外这四条线是不是都够用。我们先看缺口最大的成员，不平均加保费。”',
    '- 销售话术：“我建议先把医保外医疗和顶梁柱收入成员的大病/身故责任核清楚，这两块最影响家庭现金流。”',
    '',
    '- 4. 理财险/养老教育金切入',
    '- 销售话术：“财富类保单我不会跟您讲确定收益，因为合同里能确定的是现金价值、领取规则和保障责任。我们先把哪一年能用多少钱看清楚。”',
    '- 销售话术：“如果这笔钱是三五年内要用的，就不适合长期锁定；如果是养老或教育金，可以单独做长期账户，不和医疗、重疾预算混在一起。”',
    '',
    '- 5. 促成面谈/二次沟通',
    '- 销售话术：“这次我们先把家庭保障雷达图和现金流表核准，下次我给您带两套方案：一套是不增加预算的责任重配，一套是按优先级逐步补齐。”',
    '- 销售话术：“您不用今天决定买不买，先把保单和资料补齐。资料越完整，我给您的建议越不会偏。”',
    '',
    '- 6. 常见异议处理',
    '- 客户说“已经买过很多保险”：销售话术：“买过很多不等于责任刚好够。我们先看有没有重复、有没有失效、有没有只保身故不报医疗的情况，确认后再决定是否需要调整。”',
    '- 客户说“暂时不想增加预算”：销售话术：“可以，我们先做不增加预算的版本，看看现有保费能不能通过责任重配、优先级调整，把最急的缺口先补上。”',
    '- 客户说“理财险收益不确定”：销售话术：“您这个顾虑是对的，所以我不会按高收益来讲。我们只看合同现金价值、保底规则和领取安排，把能确定和待核实的部分分开。”',
  ].join('\n');
}

function ensureFamilySalesReviewSalesEnablement(content = '', input = {}) {
  const additions = [];
  const source = trim(content);
  if (!sectionHasUsableContent(source, /成员级保障缺口/u)) additions.push(buildMemberGapSection(input));
  if (!sectionHasUsableContent(source, /已有产品逐项切入建议|产品逐项|逐项切入/u)) additions.push(buildExistingProductSuggestionsSection(input));
  if (!hasExpandedSalesPlan(source)) additions.push(buildExpandedSalesPlanSection(input));
  if (!hasSalesScript(source)) additions.push(buildSalesScriptSection(input));
  return [source, ...additions].filter(Boolean).join('\n\n');
}

function sanitizeFamilyReport(report = {}) {
  return {
    summary: report.summary || {},
    policyInventory: {
      insuredGroups: take(report.policyInventory?.insuredGroups, 30).map((group) => ({
        member: group.member,
        memberId: group.memberId,
        relationLabel: group.relationLabel,
        policyCount: Array.isArray(group.policies) ? group.policies.length : 0,
        annualPremium: group.annualPremium,
        totalCoverage: group.totalCoverage,
        cashValueTotal: group.cashValueTotal,
        futurePayoutTotal: group.futurePayoutTotal,
      })),
    },
    optionalResponsibilityGaps: report.optionalResponsibilityGaps || [],
    criticalIllness: report.criticalIllness || {},
    accident: report.accident || {},
    wealth: report.wealth || {},
    radar: report.radar || {},
  };
}

export function buildFamilySalesReviewInput({
  family = {},
  members = [],
  policies = [],
  familyReport = {},
  planningProfile = null,
  knowledgeRecords = [],
  indicatorRecords = [],
  optionalResponsibilityRecords = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const memberContext = buildMemberReferenceContext({ members });
  const summarizedMembers = memberSummaries({ policies, family, memberContext, generatedAt });
  const summarizedPolicies = (Array.isArray(policies) ? policies : [])
    .map((policy) => policySummary(policy, memberContext, generatedAt));
  const expiredPolicies = summarizedPolicies
    .filter((policy) => policy.validity?.tone === 'expired')
    .map((policy) => ({
      policyId: policy.id,
      insuredMemberRef: policy.insuredMemberRef,
      productName: policy.name,
      validity: policy.validity,
    }));
  const uninsuredMembers = summarizedMembers.filter((member) => !member.hasPolicy);
  const topPillarMemberRef = memberContext.refById?.get(Number(family.coreMemberId || 0)) || '';

  const input = {
    generatedAt,
    analysisGoal: '给销售使用的家庭保单复盘、保障缺口、理财险销售机会、邀约面谈话术和销售方案建议。',
    family: {
      familyRef: '当前家庭',
      coreMemberRef: topPillarMemberRef,
      topPillarMemberRef,
      notes: trim(family.notes),
      planningProfile: {
        annualIncome: asNumber(planningProfile?.annualIncome || family.planningProfile?.annualIncome),
        annualExpense: asNumber(planningProfile?.annualExpense || family.planningProfile?.annualExpense),
        debt: asNumber(planningProfile?.debt || family.planningProfile?.debt),
        educationGoal: asNumber(planningProfile?.educationGoal || family.planningProfile?.educationGoal),
        parentSupportGoal: asNumber(planningProfile?.parentSupportGoal || family.planningProfile?.parentSupportGoal),
        availableAssets: asNumber(planningProfile?.availableAssets || family.planningProfile?.availableAssets),
        premiumBudget: asNumber(planningProfile?.premiumBudget || family.planningProfile?.premiumBudget),
      },
      status: trim(family.status || 'active'),
    },
    members: summarizedMembers,
    policies: summarizedPolicies,
    report: sanitizeFamilyReport(familyReport),
    officialEvidence: buildOfficialEvidence({
      policies,
      knowledgeRecords,
      indicatorRecords,
      optionalResponsibilityRecords,
    }),
    dataQuality: {
      memberCount: summarizedMembers.length,
      policyCount: summarizedPolicies.length,
      membersWithoutPolicy: uninsuredMembers.map((member) => ({
        memberRef: member.memberRef,
        relationLabel: member.relationLabel,
        role: member.role,
      })),
      expiredOrInactivePolicies: expiredPolicies,
      duplicatePolicyHints: duplicatePolicyHints(summarizedPolicies),
    },
  };
  Object.defineProperty(input, DISPLAY_REPLACEMENTS, {
    enumerable: false,
    value: memberContext.displayReplacements,
  });
  return input;
}

export function buildFamilySalesReviewMessages(input = {}, { skillPrompt = null } = {}) {
  const inputJson = privacySafeInputJson(input);
  const resolvedSkillPrompt = skillPrompt || (input?.salesChatContext
    ? selectAgentSkillPrompt({ scene: 'family_sales_review', question: '重新生成销售建议报告', salesChatContext: input.salesChatContext })
    : null);
  return [
    {
      role: 'system',
      content: [
        '你是一名资深寿险/健康险销售赋能顾问，任务是基于结构化家庭成员、家庭保单报告、保单明细和分层证据，输出给销售使用的下一步建议。',
        ...(resolvedSkillPrompt ? [
          resolvedSkillPrompt.promptHint,
          `本轮启用 skills：${resolvedSkillPrompt.skills.map((skill) => skill.label).join('、')}`,
        ] : []),
        '必须遵守：',
        '1. 只使用输入中的事实；金额、责任、现金价值、分红、领取利益没有证据时必须写“待核实”，不能编造。',
        '2. 保险公司官方资料、客户上传保单责任页/合同页与保单派生分类冲突时，优先参考已核实来源的产品名称、链接和指标；仍不确定就标为“待核实”。',
        '3. 家庭成员清单是完整录入口径，必须覆盖没有保单的成员，并明确他们对应的销售机会或资料缺口。',
        '4. 保障缺口和理财险/财富类销售机会都必须输出；理财险建议不能承诺收益、分红或确定利率。',
        '5. 输出给销售看，语言要直接、可执行，避免给客户看的营销话术泛泛而谈。',
        '6. 成员字段 memberRef 是本地变量，输出中提到家庭成员时必须原样使用 memberRef，例如 {{member_1}}（本人），不要只写关系。',
        '7. 不提供医疗、法律、税务、投资确定收益承诺；涉及核保、既往症、保全、分红实现率、税务传承时提示进一步核实。',
        '8. 不要直接输出输入 JSON 的英文内部字段名或技术标识，例如 duplicatePolicyHints、evidenceWarnings、canonical:product_*、plans；必须改写为“重复保单提示”“条款证据冲突”“险种明细”等中文业务描述。',
        '9. 必须给出可直接复制给销售使用的邀约面谈话术和销售话术；不要只写“建议沟通”“引导客户重视”这类空泛句。',
        '10. 销售方案必须展开成完整方案包，不能只写一句方案名称；每个方案必须说明适合对象、客户痛点、推荐方向、预算/保额口径、面谈话术、需补资料和下一步动作。',
        '11. family.notes 是整个家庭层面的备注，不属于某个具体成员；members[].notes 才是成员个人备注。两类备注都是客户工作、收入、喜好、沟通记录等销售线索；必须结合这些备注优化面谈重点，但备注没有写明的事实不能自行补充。',
        '12. family.topPillarMemberRef 明确表示家庭顶梁柱；涉及收入中断、重疾、定寿、家庭责任和优先面谈对象时必须优先参考该成员。',
        '13. {{id_number_1}} 这类证件号码变量只表示本地已脱敏隐私，不得在报告正文中输出、解释或要求销售复述。',
        '14. family.planningProfile 是客户已填写的家庭责任信息，包含家庭年收入、必要支出、总负债、子女教育、父母赡养、现金储备和保费预算；涉及保障缺口、定寿、重疾、失能和预算建议时必须优先使用这些字段。',
        '15. 本次请求只提供结构化保单摘要、分层证据摘要和家庭责任信息，不提供原始 OCR 全文；不得假装读过未提供的条款原文。',
        '16. 必须融合以下销售分析框架：交叉销售机会、客户复盘会议策略、年金、寿险、养老/教育金机会、家庭财务规划视角和保险重整建议。',
        '17. 交叉销售机会必须按 P1/P2/P3 标注机会优先级，并说明成功概率、客户痛点、触发依据、切入产品方向和下一步动作。',
        '18. 客户复盘会议策略必须覆盖会前准备、会中展示顺序和会后跟进动作；会中顺序为先核实数据，再讲保障缺口，再讲保单重整，再展开三档方案。',
        '19. 年金、寿险、养老/教育金机会只能基于客户责任、预算、现金流、现有现金价值或官网证据提出；不得承诺收益、分红、利率或理赔结果。',
        '20. 家庭财务规划视角必须结合收入、支出、负债、现金储备和保费预算，判断保障型、储蓄型、养老/教育金安排的先后顺序。',
        '21. 如果输入包含 salesChatContext，表示顾问围绕上一版销售建议的追问、补充想法和客户异议；必须把这些对话内容融入新版销售建议，尤其是话术风格、异议处理、方案排序和下一步动作。',
        '22. evidence 中 verificationStatus=verified 且 sourceKind/evidenceLevel 为 insurer_official 或 customer_policy_terms 的内容，可以作为已核实责任依据。',
        '23. regulatory_industry_terms 只能表述为“行业条款来源/中国保险行业协会条款线索”，不得写成保险公司官网资料。',
        '24. referenceOnly=true 或 verificationStatus=pending_review 的第三方网页、开放网页搜索、老产品非官方资料，只能作为“待核实参考/需保险公司确认”的销售沟通线索，不得计入已确认保障、保障合计、缺口抵扣或确定性销售承诺。',
        ...(resolvedSkillPrompt ? [
          '',
          '本轮 skill 规则：',
          ...resolvedSkillPrompt.systemRules.map((rule, index) => `${index + 1}. ${rule}`),
        ] : []),
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        '请按以下结构输出中文 Markdown：',
        '## 一、销售结论摘要',
        '## 二、必须先核实的数据风险',
        '## 三、成员级保障缺口',
        '## 四、理财险/财富传承销售机会',
        '## 五、交叉销售机会与保单重整建议',
        '## 六、已有产品逐项切入建议',
        '## 七、客户复盘会议策略',
        '## 八、销售方案展开',
        '## 九、邀约面谈与销售话术',
        '## 十、下一步销售动作清单',
        '',
        '要求：',
        '- “成员级保障缺口”按家庭成员逐个写，包含无保单成员；每个成员标题必须包含 memberRef 变量和 relationLabel。',
        '- “理财险/财富传承销售机会”至少写现有财富类/年金/终身寿/两全/护理险现金价值线索、可补充方案、需要补资料。',
        '- “交叉销售机会与保单重整建议”必须输出 P1/P2/P3 机会清单；每条包含机会优先级、成功概率、客户痛点、依据、建议产品方向、面谈切入话术和下一步动作。',
        '- “客户复盘会议策略”必须按会前、会中、会后三段写；会前列资料清单，会中按“数据核实 → 缺口展示 → 保险重整 → 方案选择”展开，会后列跟进任务。',
        '- “销售方案展开”至少输出 3 个方案；每个方案必须按“适合对象、客户痛点、推荐方向、预算/保额口径、销售话术、需补资料、下一步动作”展开。预算和保额只能基于输入数据给区间或“待核实”，不得编造客户收入。',
        '- 三档方案必须分别命名为基础方案、标准方案、完善方案；基础方案优先医疗/意外底座，标准方案增加重疾/定寿，完善方案再考虑养老、教育金、年金或财富传承。',
        '- “邀约面谈与销售话术”必须输出 5 组可直接照读的话术：见面开场、风险洞察提问、保障缺口切入、理财险/养老教育金切入、促成面谈/二次沟通。每组至少 2 句，其中至少 1 句用引号写成销售可直接说出口的话。',
        '- 邀约面谈要写清楚切入顺序：先核实数据，再展示保障缺口，再展开方案，再约客户补资料或二次面谈。',
        '- 需要包含常见异议处理话术，至少覆盖“已经买过很多保险”“暂时不想增加预算”“理财险收益不确定”三类。',
        '- 对疑似重复、失效、产品类型冲突、责任缺少官网指标的保单要放到核实清单。',
        '- 每条建议尽量说明依据来自“家庭报告/保单字段/官网证据/现金价值或现金流”。',
        '- 预算建议必须引用 family.planningProfile 中的收入、支出、负债、现金储备和保费预算；缺失时写“待核实”，不得自行补数。',
        '- 如果 salesChatContext 中出现顾问补充的客户关注点、异议或想要的表达方式，新版报告必须吸收这些内容，并在相应章节中体现。',
        '- 报告正文要像销售经理可直接阅读的策略简报，少用源码字段、ID 堆叠和原始 JSON 字段名。',
        '- 不要把“邀约面谈”和“销售方案”压缩成几个短句；这两节必须展开，优先保证可执行和可复制话术。',
        '- 输入 JSON 已是压缩后的结构化保单摘要、RAG/官网证据摘要和家庭责任信息；不要要求原始 OCR 全文，不要编造未提供的条款细节。',
        '',
        '以下是分析输入 JSON：',
        inputJson,
      ].join('\n'),
    },
  ];
}

export async function generateFamilySalesReview({
  input,
  fetchImpl = fetch,
  env = process.env,
} = {}) {
  const config = resolveFamilySalesReviewConfig(env);
  if (!config.apiKey) {
    throw withCode(new Error('家庭销售建议服务未配置专家分析服务 API Key'), 'FAMILY_SALES_REVIEW_PROVIDER_NOT_READY', 503);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const skillPrompt = input?.salesChatContext
      ? await selectAgentSkillPromptWithDeepSeek({
        scene: 'family_sales_review',
        question: '根据顾问选择的续聊内容重新生成销售建议报告',
        salesChatContext: input.salesChatContext,
        fetchImpl,
        config: {
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
          model: trim(env.FAMILY_AGENT_SKILL_ROUTER_MODEL || env.DEEPSEEK_SKILL_ROUTER_MODEL || 'deepseek-v4-flash'),
          timeoutMs: numberOrDefault(env.FAMILY_AGENT_SKILL_ROUTER_TIMEOUT_MS, 30_000),
        },
      })
      : null;
    const url = new URL('/chat/completions', config.baseUrl);
    const body = {
      model: config.model,
      max_tokens: config.maxTokens,
      messages: buildFamilySalesReviewMessages(input, { skillPrompt }),
    };
    if (isDeepSeekV4Model(config.model)) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = DEFAULT_DEEPSEEK_REASONING_EFFORT;
    }
    if (!usesDeepSeekThinkingMode(config.model)) {
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
        new Error(`FAMILY_SALES_REVIEW_UPSTREAM_${response.status}:${bodyText || 'upstream_error'}`),
        'FAMILY_SALES_REVIEW_UPSTREAM_FAILED',
        502,
      );
    }

    const payload = await response.json();
    const upstreamContent = trim(payload?.choices?.[0]?.message?.content);
    if (!upstreamContent) {
      throw withCode(new Error('FAMILY_SALES_REVIEW_EMPTY_RESPONSE'), 'FAMILY_SALES_REVIEW_EMPTY_RESPONSE', 502);
    }
    const content = restoreFamilySalesReviewDisplayText(
      ensureFamilySalesReviewSalesEnablement(upstreamContent, input),
      input,
    );
    return {
      content,
      model: trim(payload?.model || config.model) || config.model,
      generatedAt: new Date().toISOString(),
      inputSummary: {
        familyId: input?.family?.id ?? null,
        memberCount: Array.isArray(input?.members) ? input.members.length : 0,
        policyCount: Array.isArray(input?.policies) ? input.policies.length : 0,
        membersWithoutPolicyCount: Array.isArray(input?.dataQuality?.membersWithoutPolicy)
          ? input.dataQuality.membersWithoutPolicy.length
          : 0,
        officialProductCount: Array.isArray(input?.officialEvidence) ? input.officialEvidence.length : 0,
      },
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw withCode(new Error('家庭销售建议生成超时'), 'FAMILY_SALES_REVIEW_TIMEOUT', 504);
    }
    if (error?.code) throw error;
    throw withCode(error instanceof Error ? error : new Error('家庭销售建议生成失败'), 'FAMILY_SALES_REVIEW_FAILED', 500);
  } finally {
    clearTimeout(timeoutId);
  }
}
