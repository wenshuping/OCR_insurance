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
import { sanitizeDeepSeekRequestBody } from './deepseek-privacy-gateway.mjs';
import { resolvePolicyValidityStatus } from '../src/policy-validity.mjs';

const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_FAMILY_REVIEW_MODEL = 'deepseek-v4-pro';
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_TOKENS = 6_000;
const DEFAULT_DEEPSEEK_REASONING_EFFORT = 'high';
const DEEPSEEK_V4_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);
const DISPLAY_REPLACEMENTS = Symbol('familySalesReviewDisplayReplacements');
const ID_NUMBER_TOKEN_PATTERN = /\{\{id_number_\d+\}\}/gu;
const CHINA_ID_NUMBER_PATTERN = /\b(?:[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]|[1-9]\d{5}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3})\b/gu;
const SENSITIVE_ID_KEY_PATTERN = /(?:idNumber|idCard|identityNumber|certificateNumber|certificateNo|certNumber|certNo|cardNumber|cardNo|证件号码|身份证号码)/iu;

export function resolveFamilySalesReviewFreshness(review = null, { sourceUpdatedAt = '' } = {}) {
  if (!review || String(review.status || 'active') !== 'active') return { status: 'missing', review: null, generatedAt: '' };
  const generatedAt = String(review.generatedAt || '').trim();
  if (!generatedAt) return { status: 'stale', review, generatedAt: '' };
  const latestSourceAt = String(sourceUpdatedAt || review.sourceUpdatedAt || '').trim();
  const generatedTime = Date.parse(generatedAt);
  if (!Number.isFinite(generatedTime)) return { status: 'stale', review, generatedAt };
  const sourceTime = Date.parse(latestSourceAt);
  return {
    status: Number.isFinite(sourceTime) && (!Number.isFinite(generatedTime) || sourceTime > generatedTime) ? 'stale' : 'fresh',
    review,
    generatedAt,
  };
}

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

export function familySalesReviewDirectIdentifiers(input = {}) {
  return {
    names: displayReplacementsForInput(input).map((item) => item.value),
  };
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

function calculationResultAmount(calculationText = '') {
  const match = trim(calculationText).match(/=\s*([0-9][0-9,]*(?:\.\d+)?)\s*(万)?\s*(?:元|圆)?\s*$/u);
  if (!match) return null;
  const amount = Number(String(match[1]).replace(/,/gu, '')) * (match[2] ? 10_000 : 1);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function cashflowEntryCheck(row = {}) {
  const amount = asNumber(row?.amount);
  const calculatedAmount = calculationResultAmount(row?.calcText || row?.calculationText);
  if (amount <= 0) return { verified: false, amount, warning: '' };
  if (calculatedAmount !== null && Math.abs(calculatedAmount - amount) >= 0.001) {
    return {
      verified: false,
      amount,
      warning: `第${trim(row?.year) || '未知'}年${trim(row?.liability) || '现金流'}金额与计算公式不一致，已从自动分析中排除`,
    };
  }
  return { verified: true, amount, warning: '' };
}

function policySummary(policy = {}, memberContext = {}, generatedAt = new Date().toISOString()) {
  const cashflowEntries = Array.isArray(policy.cashflowEntries) ? policy.cashflowEntries : [];
  const scenarioEntries = Array.isArray(policy.scenarioEntries) ? policy.scenarioEntries : [];
  const cashValues = Array.isArray(policy.cashValues) ? policy.cashValues : [];
  const checkedCashflowEntries = cashflowEntries.map((row) => ({ row, check: cashflowEntryCheck(row) }));
  const verifiedCashflowEntries = checkedCashflowEntries.filter(({ check }) => check.verified);
  const positiveCashflowTotal = verifiedCashflowEntries.reduce((sum, { check }) => sum + check.amount, 0);
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
      verifiedRowCount: verifiedCashflowEntries.length,
      positiveTotal: positiveCashflowTotal,
      samples: take(verifiedCashflowEntries, 12).map(({ row }) => ({
        year: row?.year ?? '',
        age: row?.age ?? '',
        amount: asNumber(row?.amount),
        liability: trim(row?.liability),
        calcText: trim(row?.calcText),
      })),
    },
    verifiedCashflow: verifiedCashflowEntries
      .filter(({ row }) => Number.isFinite(Number(row?.year)))
      .map(({ row }) => ({
        year: Number(row.year),
        amount: asNumber(row.amount),
        liability: trim(row.liability),
        calcText: trim(row.calcText),
      }))
      .sort((left, right) => left.year - right.year || left.amount - right.amount),
    financialDataWarnings: checkedCashflowEntries.map(({ check }) => check.warning).filter(Boolean),
    scenarioEntries: take(scenarioEntries, 12).map((row) => ({
      type: trim(row?.type || row?.coverageType),
      label: trim(row?.label || row?.liability),
      amount: asNumber(row?.amount),
      calcText: trim(row?.calcText),
    })),
  };
}

function formatVerifiedCashflowAmount(amount) {
  const numeric = asNumber(amount);
  if (numeric > 0 && Number.isInteger(numeric) && numeric % 10_000 === 0) return `${numeric / 10_000}万元`;
  return `${Number.isInteger(numeric) ? numeric : numeric.toFixed(2)}元`;
}

function buildFinancialFacts(policies = []) {
  return (Array.isArray(policies) ? policies : [])
    .map((policy) => ({
      policyId: policy.id,
      productName: policy.name,
      entries: (Array.isArray(policy.verifiedCashflow) ? policy.verifiedCashflow : []).map((entry) => ({
        year: entry.year,
        liability: entry.liability,
        amount: entry.amount,
        amountText: formatVerifiedCashflowAmount(entry.amount),
        calculationText: entry.calcText,
      })),
    }))
    .filter((policy) => policy.entries.length);
}

function uniqueVerifiedCashflowAmountsByYear(input = {}) {
  const amountsByYear = new Map();
  for (const policy of Array.isArray(input?.policies) ? input.policies : []) {
    for (const entry of Array.isArray(policy?.verifiedCashflow) ? policy.verifiedCashflow : []) {
      const year = Number(entry?.year);
      const amount = asNumber(entry?.amount);
      if (!Number.isInteger(year) || amount <= 0) continue;
      const amounts = amountsByYear.get(year) || new Set();
      amounts.add(amount);
      amountsByYear.set(year, amounts);
    }
  }
  return amountsByYear;
}

const YEARLY_CASHFLOW_CLAIM_PATTERN = /((?:19|20)\d{2}\s*年(?:(?![。\n]).){0,40}?(?:确定(?:性)?\s*)?(?:给付|领取)\s*(?:约\s*)?)([0-9]+(?:\.[0-9]+)?)\s*(万元|万|元)/gu;

function escapeRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function reconcileProductLiabilityAmounts(content = '', input = {}) {
  let result = String(content || '');
  let changed = false;
  for (const policy of Array.isArray(input?.financialFacts) ? input.financialFacts : []) {
    const productName = trim(policy?.productName);
    if (!productName || !normalizeLookupText(result).includes(normalizeLookupText(productName))) continue;
    for (const entry of Array.isArray(policy?.entries) ? policy.entries : []) {
      const liability = trim(entry?.liability);
      const expectedAmount = asNumber(entry?.amount);
      if (!liability || expectedAmount <= 0) continue;
      const pattern = new RegExp(
        `(${escapeRegExp(productName)}(?:(?![。；;\\n]).){0,80}?${escapeRegExp(liability)}(?:(?![。；;\\n]).){0,30}?)([0-9]+(?:\\.[0-9]+)?)\\s*(万元|万|元)`,
        'gu',
      );
      result = result.replace(pattern, (match, prefix, amountText, unit) => {
        const claimedAmount = Number(amountText) * (String(unit).startsWith('万') ? 10_000 : 1);
        if (Math.abs(claimedAmount - expectedAmount) < 0.001) return match;
        changed = true;
        return `${prefix}${formatVerifiedCashflowAmount(expectedAmount)}`;
      });
    }
  }
  return { content: result, changed };
}

export function reconcileVerifiedCashflowAmounts(content = '', input = {}) {
  const amountsByYear = uniqueVerifiedCashflowAmountsByYear(input);
  let changed = false;
  const reconciledContent = String(content || '').replace(YEARLY_CASHFLOW_CLAIM_PATTERN, (match, prefix, amountText, unit) => {
    const year = Number(prefix.match(/(?:19|20)\d{2}/u)?.[0]);
    const amounts = amountsByYear.get(year);
    if (!amounts || amounts.size !== 1) {
      changed = true;
      return `${prefix}金额待核实`;
    }
    const expectedAmount = Array.from(amounts)[0];
    const claimedAmount = Number(amountText) * (String(unit).startsWith('万') ? 10_000 : 1);
    if (Math.abs(claimedAmount - expectedAmount) < 0.001) return match;
    changed = true;
    return `${prefix}${formatVerifiedCashflowAmount(expectedAmount)}`;
  });
  const productReconciliation = reconcileProductLiabilityAmounts(reconciledContent, input);
  return { content: productReconciliation.content, changed: changed || productReconciliation.changed };
}

export function enforceVerifiedCashflowAmounts(content = '', input = {}) {
  return reconcileVerifiedCashflowAmounts(content, input).content;
}

function financialReanalysisRequest() {
  return [
    '刚才的报告至少有一笔年度给付金额与已核实金额事实表不一致。',
    '不能只替换数字，因为财富价值、销售机会、保单重整和方案排序可能已经被错误金额带偏。',
    '请从头重写整份报告，重新评估所有涉及财富、现金流、产品价值和销售策略的结论；只能使用 financialFacts 中的金额。',
    '不要提及校验、重试或上一版错误。',
  ].join('\n');
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
      '## 三、最重要的保障问题',
      '- 家庭成员资料未提供，需先补齐成员清单、生日、社保状态和已有保单，再判断个人保障缺口。',
    ].join('\n');
  }

  const priorityMembers = [...members]
    .sort((left, right) => Number(Boolean(right.isCore)) - Number(Boolean(left.isCore))
      || Number(Boolean(left.hasPolicy)) - Number(Boolean(right.hasPolicy)))
    .slice(0, 3);
  const lines = ['## 三、最重要的保障问题'];
  for (const member of priorityMembers) {
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
      '## 四、优先销售机会',
      '- 当前家庭暂无已录入保单，销售动作先放在补录电子保单、确认家庭成员和核实社保/既往症上。',
    ].join('\n');
  }
  return [
    '## 四、优先销售机会',
    ...policies.slice(0, 3).map((policy, index) => {
      const insuredRef = trim(policy.insuredMemberRef) && trim(policy.insuredMemberRef) !== '未匹配成员'
        ? trim(policy.insuredMemberRef)
        : '被保人待匹配';
      return `- P${index + 1}｜成熟度：待核实｜${policyDisplayName(policy)}：被保人 ${insuredRef}；保额 ${formatMoney(policy.amount)}；首期/年交保费 ${formatMoney(policy.firstPremium)}；${productSuggestionEvidence(policy)}。下一步先核实责任证据和客户关注点，不直接推荐新产品。`;
    }),
  ].join('\n');
}

function ensureFamilySalesReviewSalesEnablement(content = '', input = {}) {
  const additions = [];
  const source = trim(content);
  if (!sectionHasUsableContent(source, /最重要的保障问题|成员级保障缺口/u)) additions.push(buildMemberGapSection(input));
  if (!sectionHasUsableContent(source, /优先销售机会|已有产品逐项切入建议|产品逐项|逐项切入/u)) additions.push(buildExistingProductSuggestionsSection(input));
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
  const financialFacts = buildFinancialFacts(summarizedPolicies);
  const financialDataWarnings = summarizedPolicies.flatMap((policy) => (
    Array.isArray(policy.financialDataWarnings)
      ? policy.financialDataWarnings.map((warning) => `${policy.name || '保单'}：${warning}`)
      : []
  ));

  const input = {
    generatedAt,
    analysisGoal: '给销售使用的简短行动摘要：核实关键数据、识别最重要保障问题、排序最多三个销售机会并明确本次面谈目标。',
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
    financialFacts,
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
      financialDataWarnings,
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
        '4. 只输出当前家庭最重要的保障问题和销售机会；理财险/财富类机会不属于前三优先级时不要为凑结构强行输出，也不能承诺收益、分红或确定利率。',
        '5. 输出给销售看，语言要直接、可执行，避免给客户看的营销话术泛泛而谈。',
        '6. 成员字段 memberRef 是本地变量，输出中提到家庭成员时必须原样使用 memberRef，例如 {{member_1}}（本人），不要只写关系。',
        '7. 不提供医疗、法律、税务、投资确定收益承诺；涉及核保、既往症、保全、分红实现率、税务传承时提示进一步核实。',
        '8. 不要直接输出输入 JSON 的英文内部字段名或技术标识，例如 duplicatePolicyHints、evidenceWarnings、canonical:product_*、plans；必须改写为“重复保单提示”“条款证据冲突”“险种明细”等中文业务描述。',
        '9. 主报告只解决“这次最值得谈什么、为什么谈、先核实什么、下一步怎么推进”；不要展开三档方案、完整会议流程或通用异议话术。',
        '10. 每个保障问题和销售机会必须写清成员、现有保单事实、家庭影响、缺失信息和下一步动作；没有具体事实支撑的套话不要输出。',
        '11. family.notes 是整个家庭层面的备注，不属于某个具体成员；members[].notes 才是成员个人备注。两类备注都是客户工作、收入、喜好、沟通记录等销售线索；必须结合这些备注优化面谈重点，但备注没有写明的事实不能自行补充。',
        '12. family.topPillarMemberRef 明确表示家庭顶梁柱；涉及收入中断、重疾、定寿、家庭责任和优先面谈对象时必须优先参考该成员。',
        '13. {{id_number_1}} 这类证件号码变量只表示本地已脱敏隐私，不得在报告正文中输出、解释或要求销售复述。',
        '14. family.planningProfile 是客户已填写的家庭责任信息，包含家庭年收入、必要支出、总负债、子女教育、父母赡养、现金储备和保费预算；涉及保障缺口、定寿、重疾、失能和预算建议时必须优先使用这些字段。',
        '15. 本次请求只提供结构化保单摘要、分层证据摘要和家庭责任信息，不提供原始 OCR 全文；不得假装读过未提供的条款原文。',
        '16. 必须融合家庭财务规划视角和保险重整建议，但只保留对当前家庭最重要的结论，不为凑篇幅罗列年金、寿险、养老、教育金等所有方向。',
        '17. 优先销售机会最多 3 个，按 P1/P2/P3 排序；使用“机会成熟度：高/中/低/待核实”，不得编造成功概率。高=客户明确关注且事实完整，中=缺口明确但需求或预算未确认，低=只有系统缺口线索，待核实=保单或家庭资料不足。',
        '18. 只给出一个本次面谈目标和一句可直接使用的核心话术；其他方案与异议处理留到顾问选择机会后按需生成。',
        '19. 年金、寿险、养老/教育金机会只能基于客户责任、预算、现金流、现有现金价值或官网证据提出；不得承诺收益、分红、利率或理赔结果。',
        '20. 家庭财务规划视角必须结合收入、支出、负债、现金储备和保费预算，判断保障型、储蓄型、养老/教育金安排的先后顺序。',
        '21. 如果输入包含 salesChatContext，表示顾问围绕上一版销售建议的追问、补充想法和客户异议；必须把这些对话内容融入新版销售建议，尤其是话术风格、异议处理、方案排序和下一步动作。',
        '22. 如果输入包含 salesMemoryContext，表示当前家庭历史续聊自动提炼的长期跟进记忆；只能用于客户异议、表达偏好、策略排序和下一步动作。若 salesChatContext 与 salesMemoryContext 同时存在，顾问本次勾选的 salesChatContext 优先。',
        '23. evidence 中 verificationStatus=verified 且 sourceKind/evidenceLevel 为 insurer_official 或 customer_policy_terms 的内容，可以作为已核实责任依据。',
        '24. regulatory_industry_terms 只能表述为“行业条款来源/中国保险行业协会条款线索”，不得写成保险公司官网资料。',
        '25. referenceOnly=true 或 verificationStatus=pending_review 的第三方网页、开放网页搜索、老产品非官方资料，只能作为“待核实参考/需保险公司确认”的销售沟通线索，不得计入已确认保障、保障合计、缺口抵扣或确定性销售承诺。',
        '26. financialFacts 是已核实的年度金额事实表，必须作为财富分析、产品对比、销售结论和话术中金额判断的唯一依据。正文只要写到某年某项给付或领取金额，必须逐项照抄其中的年份、责任和金额；不得除以10、四舍五入、合并金额或自行换算单位。dataQuality.financialDataWarnings 中涉及的保单存在金额异常，不能据此判断产品价值、财富规划意义或替换建议，只能写“数据待核实”。没有对应 financialFacts 时，也只能写“金额待核实”，不得写具体金额。',
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
        '## 一、本次销售结论',
        '## 二、必须先核实的数据',
        '## 三、最重要的保障问题',
        '## 四、优先销售机会',
        '## 五、本次面谈目标与一句核心话术',
        '## 六、下一步动作',
        '',
        '要求：',
        '- “必须先核实的数据”最多 3 项，只列会改变销售结论的缺失或冲突数据。',
        '- “最重要的保障问题”最多 3 个；每个问题必须包含成员、现有事实、家庭影响、缺失信息和下一步动作。没有保单的成员只有在确实属于前三优先级时才列入。',
        '- “优先销售机会”最多 3 个，按 P1/P2/P3 排序；每条包含机会成熟度、客户痛点、事实依据、建议方向和下一步动作。不得输出成功概率。',
        '- 机会成熟度只能是高、中、低或待核实；客户没有明确表达需求时，不得标为高。',
        '- “本次面谈目标”只能有一个；核心话术只能有一句，必须围绕该目标和当前家庭事实，不要输出通用话术库。',
        '- 不展开基础/标准/完善三档方案，不输出完整会议流程；需要时由顾问选择某个机会后另行生成。',
        '- 对疑似重复、失效、产品类型冲突、责任缺少官网指标的保单要放到核实清单。',
        '- 每条保障问题和销售机会必须明确说明依据来自“家庭报告/保单字段/官网证据/现金价值或现金流”；无法对应具体依据时删除该结论。',
        '- 预算建议必须引用 family.planningProfile 中的收入、支出、负债、现金储备和保费预算；缺失时写“待核实”，不得自行补数。',
        '- 如果 salesChatContext 中出现顾问补充的客户关注点、异议或想要的表达方式，新版报告必须吸收这些内容，并在相应章节中体现。',
        '- 如果 salesMemoryContext 中出现当前家庭已确认的异议、沟通偏好、策略或待办，也要在相应章节中体现；但它不能覆盖家庭/保单/官网证据中的事实。',
        '- 报告正文要像销售经理可在 2 分钟内读完的行动摘要，少用源码字段、ID 堆叠和原始 JSON 字段名。',
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
        privacyOptions: familySalesReviewDirectIdentifiers(input),
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
      body: JSON.stringify(sanitizeDeepSeekRequestBody(body, familySalesReviewDirectIdentifiers(input))),
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
    const initialContent = ensureFamilySalesReviewSalesEnablement(upstreamContent, input);
    const initialReconciliation = reconcileVerifiedCashflowAmounts(initialContent, input);
    let reviewedContent = initialReconciliation.content;
    let responseModel = trim(payload?.model || config.model) || config.model;
    if (initialReconciliation.changed) {
      const retryResponse = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(sanitizeDeepSeekRequestBody({
          ...body,
          messages: [
            ...body.messages,
            { role: 'assistant', content: upstreamContent },
            { role: 'user', content: financialReanalysisRequest() },
          ],
        }, familySalesReviewDirectIdentifiers(input))),
      });
      if (retryResponse.ok) {
        const retryPayload = await retryResponse.json();
        const retryContent = trim(retryPayload?.choices?.[0]?.message?.content);
        if (retryContent) {
          reviewedContent = reconcileVerifiedCashflowAmounts(
            ensureFamilySalesReviewSalesEnablement(retryContent, input),
            input,
          ).content;
          responseModel = trim(retryPayload?.model || responseModel) || responseModel;
        }
      }
    }
    const content = restoreFamilySalesReviewDisplayText(
      reviewedContent,
      input,
    );
    return {
      content,
      model: responseModel,
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
