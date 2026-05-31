import crypto from 'node:crypto';
import {
  buildOptionalResponsibilityId as buildGovernanceOptionalResponsibilityId,
  buildOptionalResponsibilityRecords as buildGovernanceOptionalResponsibilityRecords,
  isSelectedQuantifiedIndicator,
  normalizeOptionalResponsibilityRecord as normalizeGovernanceOptionalResponsibilityRecord,
  normalizeQuantificationStatus,
  normalizeSelectionStatus,
} from './optional-responsibility-governance.mjs';

export function createInitialState() {
  return {
    users: [],
    sessions: [],
    adminSessions: [],
    smsCodes: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    nextId: 1,
  };
}

export function allocateId(state) {
  const id = Number(state.nextId || 1);
  state.nextId = id + 1;
  return id;
}

export function normalizeMobile(value) {
  return String(value || '').trim();
}

export function normalizeSmsCode(value) {
  return String(value || '')
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/[^\d]/g, '')
    .slice(0, 6);
}

export function assertValidMobile(mobile) {
  if (!/^1[3-9]\d{9}$/.test(normalizeMobile(mobile))) {
    const error = new Error('INVALID_MOBILE');
    error.status = 400;
    throw error;
  }
}

export function normalizeGuestId(value) {
  return String(value || '').trim().slice(0, 120);
}

export function normalizePolicyRelation(value) {
  const text = String(value || '').trim();
  if (['父亲', '母亲', '爸爸', '妈妈'].includes(text)) return '父母';
  if (['儿子', '女儿', '孩子'].includes(text)) return '子女';
  if (['配偶', '丈夫', '妻子', '先生', '太太'].includes(text)) return '夫妻';
  return ['本人', '子女', '父母', '夫妻'].includes(text) ? text : '';
}

export function normalizeIdNumber(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[^\dXx]/g, '')
    .toUpperCase();
  const matched18 = text.match(/\d{17}[\dX]/);
  if (matched18) return matched18[0];
  const matched15 = text.match(/\d{15}/);
  return matched15?.[0] || '';
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

export function birthdayFromIdNumber(value) {
  const idNumber = normalizeIdNumber(value);
  if (idNumber.length === 18) {
    const year = idNumber.slice(6, 10);
    const month = idNumber.slice(10, 12);
    const day = idNumber.slice(12, 14);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  if (idNumber.length === 15) {
    const shortYear = Number(idNumber.slice(6, 8));
    const year = String(shortYear >= 30 ? 1900 + shortYear : 2000 + shortYear);
    const month = idNumber.slice(8, 10);
    const day = idNumber.slice(10, 12);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  return '';
}

export function normalizeDateOnly(value) {
  const matched = String(value || '').match(/(19\d{2}|20\d{2})[年./-]?(\d{1,2})[月./-]?(\d{1,2})/u);
  if (!matched) return '';
  const year = matched[1];
  const month = matched[2].padStart(2, '0');
  const day = matched[3].padStart(2, '0');
  return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
}

export function normalizeBeneficiary(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const text = raw
    .replace(/\s+/gu, '')
    .replace(/^(身故保险金受益人|身故受益人|受益人)[:：]?/u, '');
  if (/^(?:被保险人)?的?法定(?:继承人|继本人|维承人|受益人)?$/u.test(text)) return '法定';
  if (/法定(?:继承人|继本人|维承人|受益人)/u.test(text)) return '法定';
  return raw;
}

export function normalizePolicyScanData(data = {}) {
  const insuredIdNumber = normalizeIdNumber(data.insuredIdNumber || data.insuredIdentityNumber || data.insuredIdCard);
  return {
    company: String(data.company || '').trim() || '待补充保险公司',
    name: String(data.name || '').trim() || '未命名保单',
    applicant: String(data.applicant || '').trim(),
    beneficiary: normalizeBeneficiary(data.beneficiary),
    applicantRelation: normalizePolicyRelation(data.applicantRelation),
    insured: String(data.insured || '').trim(),
    insuredRelation: normalizePolicyRelation(data.insuredRelation),
    insuredIdNumber,
    insuredBirthday: normalizeDateOnly(data.insuredBirthday || data.insuredBirthDate) || birthdayFromIdNumber(insuredIdNumber),
    date: String(data.date || '').trim(),
    paymentPeriod: String(data.paymentPeriod || '').trim(),
    coveragePeriod: String(data.coveragePeriod || '').trim(),
    amount: Number(data.amount || 0) || 0,
    firstPremium: Number(data.firstPremium || 0) || 0,
  };
}

function normalizePolicyPlanRole(value, index, name) {
  const role = String(value || '').trim();
  const text = `${role}${name || ''}`;
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  if (['main', 'rider', 'linked_account', 'unknown'].includes(role)) return role;
  return index === 0 ? 'main' : 'rider';
}

export function normalizePolicyPlans(plans = [], company = '') {
  return (Array.isArray(plans) ? plans : [])
    .map((plan, index) => {
      const name = String(plan?.name || plan?.productName || plan?.matchedProductName || '').trim();
      const matchedProductName = String(plan?.matchedProductName || '').trim();
      const effectiveName = matchedProductName || name;
      if (!effectiveName) return null;
      return {
        company: String(plan?.company || company || '').trim(),
        role: normalizePolicyPlanRole(plan?.role, index, name || effectiveName),
        name: name || effectiveName,
        matchedProductName,
        productType: String(plan?.productType || '').trim(),
        amount: Number(plan?.amount || 0) || 0,
        coveragePeriod: String(plan?.coveragePeriod || '').trim(),
        paymentMode: String(plan?.paymentMode || '').trim(),
        paymentPeriod: String(plan?.paymentPeriod || '').trim(),
        premium: Number(plan?.premium || plan?.firstPremium || 0) || 0,
        premiumText: String(plan?.premiumText || '').trim(),
        matchScore: Number(plan?.matchScore || 0) || 0,
        matchReason: String(plan?.matchReason || '').trim(),
      };
    })
    .filter(Boolean);
}

function normalizeLookupText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .trim();
}

const RESPONSIBILITY_SELECTION_STATUSES = new Set(['selected', 'not_selected', 'unknown']);
const OPTIONAL_RESPONSIBILITY_PATTERN =
  /可选(?:保险)?责任|可选部分|可选保障|可选择的保险责任项目|必选部分和可选部分|基本部分和可选部分|基本(?:保险)?责任和可选(?:保险)?责任|可由.{0,30}决定是否投保|可选择投保/u;
const OPTIONAL_RESPONSIBILITY_NEGATIVE_PATTERN =
  /不含可选(?:保险)?责任|未选择投保可选(?:保险)?责任|未投保可选(?:保险)?责任|不投保可选(?:保险)?责任|不包含.{0,30}可选(?:保险)?责任/u;
const OPTIONAL_RESPONSIBILITY_SELECTED_PATTERN =
  /含可选(?:保险)?责任|包含.{0,30}可选(?:保险)?责任|选择投保可选(?:保险)?责任|已投保可选(?:保险)?责任|投保可选(?:保险)?责任/u;
const OPTIONAL_RESPONSIBILITY_SECTION_PATTERN = /可选(?:保险)?责任\s*([一二三四五六七八九十\d]*)/gu;

function normalizeResponsibilitySelectionStatus(value, fallback = 'unknown') {
  return normalizeSelectionStatus(value, fallback);
}

function normalizeOptionalResponsibilityId(value) {
  return String(value || '').trim().slice(0, 120);
}

function optionalResponsibilityKey({ productName = '', coverageType = '', liability = '' } = {}) {
  return [productName, coverageType, liability].map(normalizeLookupText).join('\u001f');
}

function buildOptionalResponsibilityId(value = {}) {
  return buildGovernanceOptionalResponsibilityId({
    company: value.company,
    productName: value.productName,
    liability: value.liability || value.coverageType,
  });
}

function optionalResponsibilityText(value = {}) {
  return [
    value?.coverageType,
    value?.liability,
    value?.condition,
    value?.formulaText,
    value?.basis,
    value?.sourceExcerpt,
  ].map((item) => String(item || '')).join(' ');
}

function indicatorLooksOptional(indicator = {}) {
  const directText = [
    indicator?.liability,
    indicator?.coverageType,
    indicator?.condition,
  ].map((item) => String(item || '')).join(' ');
  if (OPTIONAL_RESPONSIBILITY_PATTERN.test(directText)) return true;
  const text = optionalResponsibilityText(indicator);
  if (!OPTIONAL_RESPONSIBILITY_PATTERN.test(text)) return false;
  const liability = normalizeLookupText(indicator?.liability);
  if (!liability || liability.length < 2) return true;
  const normalizedText = normalizeLookupText(text);
  const liabilityIndex = normalizedText.indexOf(liability);
  if (liabilityIndex < 0) return true;
  const markerIndexes = [
    normalizedText.lastIndexOf('可选责任', liabilityIndex),
    normalizedText.lastIndexOf('可选保险责任', liabilityIndex),
    normalizedText.lastIndexOf('可选部分', liabilityIndex),
  ].filter((index) => index >= 0);
  if (!markerIndexes.length) return false;
  const markerIndex = Math.max(...markerIndexes);
  const priorBasicIndex = Math.max(
    normalizedText.lastIndexOf('基本责任', liabilityIndex),
    normalizedText.lastIndexOf('基本保险责任', liabilityIndex),
    normalizedText.lastIndexOf('必选责任', liabilityIndex),
    normalizedText.lastIndexOf('必选部分', liabilityIndex),
  );
  return markerIndex >= priorBasicIndex;
}

function buildOptionalResponsibilitySelectionMap(items = []) {
  const byId = new Map();
  const byKey = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const status = normalizeResponsibilitySelectionStatus(item?.selectionStatus, '');
    if (!status) continue;
    const normalized = {
      id: normalizeOptionalResponsibilityId(item?.id),
      productName: String(item?.productName || '').trim(),
      coverageType: String(item?.coverageType || '').trim(),
      liability: String(item?.liability || '').trim(),
      selectionStatus: status,
      selectionEvidence: String(item?.selectionEvidence || 'manual').trim() || 'manual',
      responsibilityScope: 'optional',
    };
    if (normalized.id) byId.set(normalized.id, normalized);
    byKey.set(optionalResponsibilityKey(normalized), normalized);
  }
  return { byId, byKey };
}

function policyOptionalSelectionEvidenceText(policy = {}) {
  return [
    policy?.ocrText,
    policy?.report,
    ...(Array.isArray(policy?.responsibilities)
      ? policy.responsibilities.map((row) => [row?.coverageType, row?.scenario, row?.payout, row?.note].join(' '))
      : []),
  ].join(' ');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function optionalResponsibilitySuffix(value) {
  const match = normalizeLookupText(value).match(/可选(?:保险)?责任([一二三四五六七八九十\d]+)/u);
  return match?.[1] || '';
}

function explicitSelectedOptionalResponsibilitySuffixes(evidenceText) {
  const text = normalizeLookupText(evidenceText);
  if (!/(?:保险责任)?包含|含基本(?:保险)?责任/u.test(text)) return null;
  const suffixes = [...text.matchAll(/可选(?:保险)?责任([一二三四五六七八九十\d]+)/gu)]
    .map((match) => match[1])
    .filter(Boolean);
  return suffixes.length ? new Set(suffixes) : null;
}

function hasSpecificOptionalResponsibilityEvidence(evidenceText, suffix, patternPrefix) {
  if (!suffix) return false;
  const text = normalizeLookupText(evidenceText);
  const liabilityPattern = `可选(?:保险)?责任${escapeRegExp(suffix)}`;
  return new RegExp(`(?:${patternPrefix}).{0,16}${liabilityPattern}|${liabilityPattern}.{0,16}(?:${patternPrefix})`, 'u').test(text);
}

function inferOptionalResponsibilitySelection(policy = {}, indicator = {}, id = '') {
  const existing = buildOptionalResponsibilitySelectionMap(policy?.optionalResponsibilities);
  const key = optionalResponsibilityKey({
    productName: indicator?.productName,
    coverageType: indicator?.coverageType,
    liability: indicator?.liability,
  });
  const override = existing.byId.get(id) || existing.byKey.get(key);
  if (override?.selectionStatus) {
    return {
      selectionStatus: override.selectionStatus,
      selectionEvidence: override.selectionEvidence || 'manual',
    };
  }

  const evidenceText = policyOptionalSelectionEvidenceText(policy);
  const suffix = optionalResponsibilitySuffix(indicator?.liability);
  const explicitSelectedSuffixes = explicitSelectedOptionalResponsibilitySuffixes(evidenceText);
  if (explicitSelectedSuffixes && suffix) {
    return {
      selectionStatus: explicitSelectedSuffixes.has(suffix) ? 'selected' : 'not_selected',
      selectionEvidence: 'policy_ocr',
    };
  }
  if (hasSpecificOptionalResponsibilityEvidence(evidenceText, suffix, '不含|不包含|未选择投保|未投保|不投保')) {
    return { selectionStatus: 'not_selected', selectionEvidence: 'policy_ocr' };
  }
  if (hasSpecificOptionalResponsibilityEvidence(evidenceText, suffix, '含|包含|选择投保|已投保|投保')) {
    return { selectionStatus: 'selected', selectionEvidence: 'policy_ocr' };
  }
  if (OPTIONAL_RESPONSIBILITY_NEGATIVE_PATTERN.test(evidenceText)) {
    return { selectionStatus: 'not_selected', selectionEvidence: 'policy_ocr' };
  }
  if (OPTIONAL_RESPONSIBILITY_SELECTED_PATTERN.test(evidenceText)) {
    return { selectionStatus: 'selected', selectionEvidence: 'policy_ocr' };
  }
  return { selectionStatus: 'unknown', selectionEvidence: 'official_terms' };
}

function indicatorHasQuantifiableShape(indicator = {}) {
  if (indicator.value !== undefined && indicator.value !== null && String(indicator.unit || indicator.formulaText || '').trim()) return true;
  if (String(indicator.formulaText || '').trim() && !/按条款|以条款/u.test(String(indicator.formulaText || ''))) return true;
  return false;
}

function indicatorQuantificationStatus(indicator = {}) {
  return normalizeQuantificationStatus(
    indicator?.quantificationStatus,
    indicatorHasQuantifiableShape(indicator) ? 'quantified' : 'pending_review',
  );
}

function annotateCoverageIndicatorSelection(policy = {}, indicator = {}) {
  const optional = indicatorLooksOptional(indicator);
  if (!optional) {
    return {
      ...indicator,
      responsibilityScope: 'basic',
      selectionStatus: 'selected',
      selectionEvidence: 'official_terms',
    };
  }
  const id = buildOptionalResponsibilityId(indicator);
  const selection = inferOptionalResponsibilitySelection(policy, indicator, id);
  return {
    ...indicator,
    optionalResponsibilityId: id,
    responsibilityScope: 'optional',
    quantificationStatus: indicatorQuantificationStatus(indicator),
    quantificationReason: String(indicator?.quantificationReason || '').trim(),
    ...selection,
  };
}

export function isSelectedCoverageIndicator(indicator = {}) {
  return isSelectedQuantifiedIndicator(indicator);
}

export function selectedCoverageIndicators(indicators = []) {
  return (Array.isArray(indicators) ? indicators : []).filter(isSelectedCoverageIndicator);
}

export function normalizeOptionalResponsibilities(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const company = String(item?.company || '').trim();
      const productName = String(item?.productName || '').trim();
      const coverageType = String(item?.coverageType || '').trim();
      const liability = String(item?.liability || item?.name || item?.title || '').trim();
      const id = normalizeOptionalResponsibilityId(item?.id) || buildOptionalResponsibilityId({ company, productName, coverageType, liability });
      if (!id || (!productName && !coverageType && !liability)) return null;
      return normalizeGovernanceOptionalResponsibilityRecord({
        ...item,
        id,
        company,
        productName,
        coverageType,
        liability,
        selectionStatus: normalizeResponsibilitySelectionStatus(item?.selectionStatus),
        selectionEvidence: String(item?.selectionEvidence || 'manual').trim() || 'manual',
        quantificationStatus: normalizeQuantificationStatus(item?.quantificationStatus),
        quantificationReason: String(item?.quantificationReason || '').trim(),
        indicatorIds: Array.isArray(item?.indicatorIds) ? item.indicatorIds : [],
        sourceExcerpt: String(item?.sourceExcerpt || '').trim().slice(0, 500),
      });
    })
    .filter(Boolean);
}

function mergeOptionalResponsibilityCandidate(candidates, candidate) {
  const productName = String(candidate?.productName || '').trim();
  const coverageType = String(candidate?.coverageType || '').trim();
  const liability = String(candidate?.liability || '').trim();
  const id = normalizeOptionalResponsibilityId(candidate?.id) || buildOptionalResponsibilityId({ productName, coverageType, liability });
  if (!id || (!productName && !coverageType && !liability)) return;
  const normalized = {
    id,
    company: String(candidate?.company || '').trim(),
    productName,
    coverageType,
    liability,
    title: String(candidate?.title || liability || coverageType || '可选责任').trim(),
    responsibilityScope: 'optional',
    selectionStatus: normalizeResponsibilitySelectionStatus(candidate?.selectionStatus),
    selectionEvidence: String(candidate?.selectionEvidence || 'official_terms').trim() || 'official_terms',
    quantificationStatus: normalizeQuantificationStatus(
      candidate?.quantificationStatus,
      Array.isArray(candidate?.indicatorIds) && candidate.indicatorIds.length ? 'quantified' : 'pending_review',
    ),
    quantificationReason: String(candidate?.quantificationReason || '').trim(),
    indicatorIds: (Array.isArray(candidate?.indicatorIds) ? candidate.indicatorIds : []).map((item) => String(item || '').trim()).filter(Boolean),
    sourceExcerpt: String(candidate?.sourceExcerpt || '').trim().slice(0, 500),
  };
  const existing = candidates.get(id);
  if (!existing) {
    candidates.set(id, normalized);
    return;
  }
  const candidateStatus = normalizeResponsibilitySelectionStatus(normalized.selectionStatus);
  const useCandidateSelection = existing.selectionEvidence !== 'manual' && candidateStatus !== 'unknown';
  const existingQuantificationStatus = normalizeQuantificationStatus(existing.quantificationStatus);
  const candidateQuantificationStatus = normalizeQuantificationStatus(normalized.quantificationStatus);
  const nextQuantificationStatus = existingQuantificationStatus === 'not_quantifiable'
    ? existingQuantificationStatus
    : candidateQuantificationStatus === 'quantified' || candidateQuantificationStatus === 'not_quantifiable'
      ? candidateQuantificationStatus
      : existingQuantificationStatus === 'quantified'
        ? existingQuantificationStatus
        : candidateQuantificationStatus;
  candidates.set(id, {
    ...existing,
    ...normalized,
    sourceExcerpt: existing.sourceExcerpt || normalized.sourceExcerpt,
    selectionStatus: useCandidateSelection ? candidateStatus : existing.selectionStatus,
    selectionEvidence: useCandidateSelection ? normalized.selectionEvidence : existing.selectionEvidence,
    quantificationStatus: nextQuantificationStatus,
    quantificationReason: normalized.quantificationReason || existing.quantificationReason,
    indicatorIds: normalized.indicatorIds.length ? normalized.indicatorIds : existing.indicatorIds,
  });
}

function parseKnowledgeRecordPayload(record = {}) {
  const payload = record?.payload;
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  if (typeof payload !== 'string') return {};
  try {
    const parsed = JSON.parse(payload);
    return parsed && typeof parsed === 'object' ? parsed : { pageText: payload };
  } catch (_error) {
    return { pageText: payload };
  }
}

function knowledgeRecordProductNames(record = {}) {
  const payload = parseKnowledgeRecordPayload(record);
  return [
    record?.productName,
    record?.name,
    record?.title,
    payload?.productName,
    payload?.name,
    payload?.title,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function knowledgeRecordText(record = {}) {
  const payload = parseKnowledgeRecordPayload(record);
  const pageTexts = Array.isArray(payload?.pages)
    ? payload.pages.map((page) => [page?.pageText, page?.text, page?.content].filter(Boolean).join('\n'))
    : [];
  return [
    record?.pageText,
    record?.text,
    record?.content,
    record?.body,
    record?.snippet,
    payload?.pageText,
    payload?.text,
    payload?.content,
    payload?.body,
    payload?.snippet,
    ...pageTexts,
  ].map((value) => String(value || '').trim()).filter(Boolean).join('\n');
}

function excerptAround(text, index, length = 280) {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!source) return '';
  const start = Math.max(0, Number(index || 0) - 40);
  return source.slice(start, start + length).trim();
}

function optionalResponsibilityMatchLooksLikeSection(text, index) {
  const prefix = String(text || '').slice(Math.max(0, Number(index || 0) - 16), Number(index || 0));
  return !prefix || /(?:[。；;:：]\s*|\d+[.．、]\s*)$/u.test(prefix);
}

function findPolicyKnowledgeRecords(policy = {}, knowledgeRecords = []) {
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return [];
  return (Array.isArray(knowledgeRecords) ? knowledgeRecords : []).filter((record) => {
    const company = normalizeLookupText(record?.company || parseKnowledgeRecordPayload(record)?.company || policy.company);
    return knowledgeRecordProductNames(record).some((productName) => keys.has(`${company}\u001f${normalizeLookupText(productName)}`));
  });
}

function buildOptionalResponsibilitiesFromKnowledge(policy = {}, knowledgeRecords = []) {
  const result = [];
  for (const record of findPolicyKnowledgeRecords(policy, knowledgeRecords)) {
    const text = knowledgeRecordText(record).replace(/\s+/gu, ' ').trim();
    if (!OPTIONAL_RESPONSIBILITY_PATTERN.test(text)) continue;
    const allMatches = [...text.matchAll(OPTIONAL_RESPONSIBILITY_SECTION_PATTERN)];
    const sectionMatches = allMatches.filter((match) => optionalResponsibilityMatchLooksLikeSection(text, match.index));
    const matches = sectionMatches.length ? sectionMatches : allMatches;
    const specificMatches = matches.filter((match) => String(match[1] || '').trim());
    const selectedMatches = specificMatches.length ? specificMatches : matches.slice(0, 1);
    for (const match of selectedMatches) {
      const suffix = String(match[1] || '').trim();
      const liability = `可选责任${suffix}`;
      const productName = String(policy.name || knowledgeRecordProductNames(record)[0] || '').trim();
      const candidate = {
        productName,
        coverageType: '可选责任',
        liability,
        sourceExcerpt: excerptAround(text, match.index),
      };
      const id = buildOptionalResponsibilityId(candidate);
      result.push({
        id,
        ...candidate,
        responsibilityScope: 'optional',
        ...inferOptionalResponsibilitySelection(policy, candidate, id),
      });
    }
  }
  return result;
}

export function buildOptionalResponsibilityReview(policy = {}, indicators = [], knowledgeRecords = [], optionalResponsibilityRecords = []) {
  const annotated = (Array.isArray(indicators) ? indicators : []).map((indicator) =>
    annotateCoverageIndicatorSelection(policy, indicator),
  );
  const candidates = new Map();
  for (const record of buildGovernanceOptionalResponsibilityRecords({
    policy,
    knowledgeRecords,
    indicators: annotated,
    existingRecords: optionalResponsibilityRecords,
  })) {
    mergeOptionalResponsibilityCandidate(candidates, record);
  }
  for (const record of Array.isArray(optionalResponsibilityRecords) ? optionalResponsibilityRecords : []) {
    if (!optionalResponsibilityRecordMatchesPolicy(policy, record)) continue;
    mergeOptionalResponsibilityCandidate(candidates, normalizeGovernanceOptionalResponsibilityRecord(record));
  }

  for (const indicator of annotated) {
    if (indicator.responsibilityScope !== 'optional') continue;
    const id = indicator.optionalResponsibilityId || buildOptionalResponsibilityId(indicator);
    const existing = candidates.get(id);
    const quantificationStatus = indicatorQuantificationStatus(indicator);
    const candidate = {
      id,
      company: String(indicator.company || policy.company || '').trim(),
      productName: String(indicator.productName || policy.name || '').trim(),
      coverageType: String(indicator.coverageType || '').trim(),
      liability: String(indicator.liability || '').trim(),
      responsibilityScope: 'optional',
      selectionStatus: normalizeResponsibilitySelectionStatus(indicator.selectionStatus),
      selectionEvidence: String(indicator.selectionEvidence || 'official_terms').trim() || 'official_terms',
      quantificationStatus,
      quantificationReason: quantificationStatus === 'pending_review' ? '缺少可计算结构化指标' : '',
      indicatorIds: String(indicator.id || '').trim() && quantificationStatus === 'quantified' ? [String(indicator.id).trim()] : [],
      sourceExcerpt: String(indicator.sourceExcerpt || '').trim().slice(0, 500),
    };
    mergeOptionalResponsibilityCandidate(
      candidates,
      existing ? { ...candidate, selectionStatus: existing.selectionStatus, selectionEvidence: existing.selectionEvidence } : candidate,
    );
  }

  for (const candidate of buildOptionalResponsibilitiesFromKnowledge(policy, knowledgeRecords)) {
    mergeOptionalResponsibilityCandidate(candidates, candidate);
  }

  for (const persisted of normalizeOptionalResponsibilities(policy?.optionalResponsibilities)) {
    const existingByKey = [...candidates.values()].find((candidate) => optionalResponsibilityKey(candidate) === optionalResponsibilityKey(persisted));
    const id = existingByKey?.id || persisted.id;
    const existing = candidates.get(id);
    candidates.set(id, existing ? { ...existing, ...persisted, id } : { ...persisted, id });
  }

  return [...candidates.values()].sort(
    (left, right) =>
      left.productName.localeCompare(right.productName, 'zh-CN') ||
      left.coverageType.localeCompare(right.coverageType, 'zh-CN') ||
      left.liability.localeCompare(right.liability, 'zh-CN'),
  );
}

function dedupePolicyIndicatorRows(rows = []) {
  const seen = new Set();
  const result = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = [
      row?.id,
      row?.company,
      row?.productName,
      row?.coverageType,
      row?.liability,
      row?.valueText ?? row?.value,
      row?.unit,
      row?.basis,
      row?.formulaText,
    ].map((value) => String(value ?? '')).join('\u001f');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

function optionalResponsibilityRecordMatchesPolicy(policy = {}, record = {}) {
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return false;
  const company = normalizeLookupText(record?.company || policy.company);
  const productName = normalizeLookupText(record?.productName || record?.name || record?.title);
  return productName && keys.has(`${company}\u001f${productName}`);
}

export function policyProductIndicatorKeys(policy = {}) {
  const keys = [];
  const add = (company, productName) => {
    const normalizedCompany = normalizeLookupText(company || policy.company);
    const normalizedProductName = normalizeLookupText(productName);
    if (!normalizedProductName) return;
    const key = `${normalizedCompany}\u001f${normalizedProductName}`;
    if (!keys.includes(key)) keys.push(key);
  };

  add(policy.company, policy.name);
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    const company = plan?.company || policy.company;
    add(company, plan?.matchedProductName);
    add(company, plan?.productName);
    add(company, plan?.name);
  }
  return keys;
}

export function findPolicyCoverageIndicators(policy = {}, indicatorRecords = []) {
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return [];
  return dedupePolicyIndicatorRows(
    (Array.isArray(indicatorRecords) ? indicatorRecords : []).filter((record) =>
      keys.has(`${normalizeLookupText(record?.company)}\u001f${normalizeLookupText(record?.productName)}`),
    ),
  ).map((record) => annotateCoverageIndicatorSelection(policy, record));
}

export function attachPolicyCoverageIndicators(policy = {}, indicatorRecords = [], knowledgeRecords = [], optionalResponsibilityRecords = []) {
  const coverageIndicators = findPolicyCoverageIndicators(policy, indicatorRecords);
  return {
    ...policy,
    coverageIndicators,
    optionalResponsibilities: buildOptionalResponsibilityReview(policy, coverageIndicators, knowledgeRecords, optionalResponsibilityRecords),
  };
}

export function attachPoliciesCoverageIndicators(policies = [], indicatorRecords = [], knowledgeRecords = [], optionalResponsibilityRecords = []) {
  return (Array.isArray(policies) ? policies : []).map((policy) =>
    attachPolicyCoverageIndicators(policy, indicatorRecords, knowledgeRecords, optionalResponsibilityRecords),
  );
}

export function normalizePolicySources(sources = []) {
  return (Array.isArray(sources) ? sources : [])
    .map((source) => ({
      company: String(source?.company || '').trim(),
      productName: String(source?.productName || source?.name || '').trim(),
      title: String(source?.title || '').trim(),
      url: String(source?.url || '').trim(),
      snippet: String(source?.snippet || '').trim(),
      evidenceLabel: String(source?.evidenceLabel || '').trim(),
      evidenceLevel: String(source?.evidenceLevel || '').trim(),
      official: Boolean(source?.official),
      sourceType: String(source?.sourceType || '').trim(),
    }))
    .filter((source) => source.url)
    .slice(0, 12);
}

export function buildPolicyFromScan({ state, userId = null, guestId = '', scan, analysis }) {
  const data = normalizePolicyScanData(scan?.data || {});
  const plans = normalizePolicyPlans(scan?.data?.plans, data.company);
  const now = new Date().toISOString();
  const hasAnalysis = Boolean(analysis?.report || analysis?.coverageTable?.length);
  const responsibilities = Array.isArray(analysis?.coverageTable)
    ? analysis.coverageTable.map((row) => ({
        coverageType: String(row.coverageType || '').trim() || '保险责任',
        scenario: String(row.scenario || '').trim() || '以条款约定为准',
        payout: String(row.payout || '').trim() || '以正式条款为准',
        note: String(row.note || '').trim(),
        sourceUrl: String(row.sourceUrl || '').trim(),
        sourceTitle: String(row.sourceTitle || '').trim(),
      }))
    : [];
  const optionalResponsibilities = normalizeOptionalResponsibilities(analysis?.optionalResponsibilities);

  return {
    id: allocateId(state),
    userId: userId ? Number(userId) : null,
    guestId: userId ? '' : normalizeGuestId(guestId),
    company: data.company,
    name: data.name,
    applicant: data.applicant,
    beneficiary: data.beneficiary,
    applicantRelation: data.applicantRelation,
    insured: data.insured,
    insuredRelation: data.insuredRelation,
    insuredIdNumber: data.insuredIdNumber,
    insuredBirthday: data.insuredBirthday,
    date: data.date,
    paymentPeriod: data.paymentPeriod,
    coveragePeriod: data.coveragePeriod,
    amount: data.amount,
    firstPremium: data.firstPremium,
    plans,
    ocrText: String(scan?.ocrText || '').trim(),
    responsibilities,
    optionalResponsibilities,
    report: String(analysis?.report || '').trim(),
    sources: normalizePolicySources(analysis?.sources),
    reportStatus: hasAnalysis ? 'ready' : 'generating',
    reportError: '',
    createdAt: now,
    updatedAt: now,
  };
}

export function findSessionUser(state, token) {
  const normalized = String(token || '').trim();
  if (!normalized) return null;
  const session = (state.sessions || []).find((row) => String(row.token || '') === normalized);
  if (!session) return null;
  return (state.users || []).find((row) => Number(row.id) === Number(session.userId)) || null;
}

export function createSession(state, userId) {
  const token = crypto.randomUUID();
  state.sessions.push({
    token,
    userId: Number(userId),
    createdAt: new Date().toISOString(),
  });
  return token;
}

export function deleteSession(state, token) {
  const normalized = String(token || '').trim();
  if (!normalized) return false;
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];
  const before = sessions.length;
  state.sessions = sessions.filter((row) => String(row.token || '') !== normalized);
  return state.sessions.length < before;
}

export function getBearerToken(req) {
  const header = String(req.headers.authorization || '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || '';
}

export function latestValidSmsCode(state, { mobile, code }) {
  const normalizedMobile = normalizeMobile(mobile);
  const normalizedCode = normalizeSmsCode(code);
  return [...(state.smsCodes || [])]
    .reverse()
    .find(
      (row) =>
        String(row.mobile || '') === normalizedMobile &&
        normalizeSmsCode(row.code) === normalizedCode &&
        !row.used &&
        new Date(row.expiresAt).getTime() > Date.now(),
    );
}

export function publicUser(user) {
  return {
    id: Number(user.id),
    mobile: String(user.mobile || ''),
    createdAt: user.createdAt,
  };
}
