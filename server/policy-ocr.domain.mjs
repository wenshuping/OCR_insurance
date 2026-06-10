import crypto from 'node:crypto';
import { shouldKeepPolicyPlan } from '../src/policy-plan-filter.mjs';
import {
  canonicalProductIdForRecord,
  canonicalProductIdFromOfficialProduct,
  resolveRecordCompany,
  resolveRecordProductName,
} from './canonical-product-id.mjs';
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
    officialDomainProfiles: [],
    familyProfiles: [],
    familyMembers: [],
    familyReportShares: [],
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
  if (['丈夫', '妻子', '先生', '太太', '夫妻'].includes(text)) return '配偶';
  if (['爸爸'].includes(text)) return '父亲';
  if (['妈妈'].includes(text)) return '母亲';
  if (['孩子', '小孩'].includes(text)) return '子女';
  return ['本人', '配偶', '儿子', '女儿', '子女', '父亲', '母亲', '父母', '其他', '待确认'].includes(text) ? text : '';
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
  const normalized = {
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
  const canonicalProductId = String(data.canonicalProductId || '').trim();
  if (canonicalProductId) normalized.canonicalProductId = canonicalProductId;
  return normalized;
}

function normalizePolicyPlanRole(value, index, name) {
  const role = String(value || '').trim();
  const text = `${role}${name || ''}`;
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  if (['main', 'rider', 'linked_account', 'unknown'].includes(role)) return role;
  return index === 0 ? 'main' : 'rider';
}

function normalizePolicyPlanBenefitRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      responsibilityName: String(row?.responsibilityName || '').trim(),
      amountText: String(row?.amountText || '').trim(),
      amount: Number(row?.amount || 0) || 0,
      premium: Number(row?.premium || 0) || 0,
      coveragePeriod: String(row?.coveragePeriod || '').trim(),
      paymentMode: String(row?.paymentMode || '').trim(),
      paymentPeriod: String(row?.paymentPeriod || '').trim(),
      paymentBasis: String(row?.paymentBasis || '').trim(),
      benefitStandard: String(row?.benefitStandard || '').trim(),
      deductible: String(row?.deductible || '').trim(),
      ratio: String(row?.ratio || '').trim(),
      evidence: String(row?.evidence || '').trim(),
    }))
    .filter((row) => Object.values(row).some(Boolean));
}

export function normalizePolicyPlans(plans = [], company = '') {
  return (Array.isArray(plans) ? plans : [])
    .map((plan, index) => {
      const name = String(plan?.name || plan?.productName || plan?.matchedProductName || '').trim();
      const matchedProductName = String(plan?.matchedProductName || '').trim();
      const effectiveName = matchedProductName || name;
      if (!effectiveName) return null;
      if (!shouldKeepPolicyPlan(plan)) return null;
      const normalized = {
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
      const canonicalProductId = String(plan?.canonicalProductId || '').trim();
      const benefitRows = normalizePolicyPlanBenefitRows(plan?.benefitRows);
      if (canonicalProductId) normalized.canonicalProductId = canonicalProductId;
      if (benefitRows.length) normalized.benefitRows = benefitRows;
      return normalized;
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

function optionalResponsibilitySelectionKey({ company = '', productName = '', coverageType = '', liability = '' } = {}) {
  return [
    normalizeLookupText(company),
    normalizeOptionalResponsibilityProductKey(productName, company),
    normalizeLookupText(coverageType),
    normalizeLookupText(liability),
  ].join('\u001f');
}

function normalizeOptionalResponsibilityProductKey(productName = '', company = '') {
  const normalizedCompany = normalizeLookupText(company);
  let text = normalizeLookupText(productName);
  if (!text) return '';
  if (normalizedCompany) text = text.replaceAll(normalizedCompany, '');
  return text
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险股份有限公司/gu, '')
    .replace(/^[\p{Script=Han}]{2,14}(?:人寿|财产|养老|健康)?保险有限责任公司/gu, '')
    .replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司|产品说明书|产品说明|保险条款|利益条款|条款/gu, '')
    .trim();
}

function optionalResponsibilityMergeKey(value = {}) {
  const {
    company = '',
    productName = '',
    canonicalProductId = '',
    liability = '',
  } = value || {};
  const hasMergeCanonicalProductId = Object.prototype.hasOwnProperty.call(value || {}, 'mergeCanonicalProductId');
  const canonicalKey = normalizeLookupText(hasMergeCanonicalProductId ? value.mergeCanonicalProductId : canonicalProductId);
  return [
    canonicalKey,
    normalizeLookupText(company),
    canonicalKey ? '' : normalizeOptionalResponsibilityProductKey(productName, company),
    normalizeLookupText(liability),
  ].join('\u001f');
}

function buildOptionalResponsibilityId(value = {}) {
  return buildGovernanceOptionalResponsibilityId({
    company: value.company,
    productName: value.productName,
    canonicalProductId: String(value.canonicalProductId || '').trim(),
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
  if (String(indicator?.responsibilityScope || '').trim() === 'optional') return true;
  if (normalizeOptionalResponsibilityId(indicator?.optionalResponsibilityId)) return true;
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
    byKey.set(optionalResponsibilitySelectionKey({ ...normalized, company: item?.company }), normalized);
  }
  return { byId, byKey };
}

function policyOptionalSelectionEvidenceText(policy = {}) {
  return [
    policy?.ocrText,
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

function inferOptionalResponsibilitySelection(policy = {}, indicator = {}, id = '', hasExplicitOptionalResponsibilityId = false) {
  const existing = buildOptionalResponsibilitySelectionMap(policy?.optionalResponsibilities);
  const key = optionalResponsibilityKey({
    company: indicator?.company,
    productName: indicator?.productName,
    coverageType: indicator?.coverageType,
    liability: indicator?.liability,
  });
  const semanticKey = optionalResponsibilitySelectionKey({
    company: indicator?.company || policy?.company,
    productName: indicator?.productName,
    coverageType: indicator?.coverageType,
    liability: indicator?.liability,
  });
  const override = existing.byId.get(id);
  if (override?.selectionStatus) {
    return {
      optionalResponsibilityId: override.id || id,
      selectionStatus: override.selectionStatus,
      selectionEvidence: override.selectionEvidence || 'manual',
      ...(override.id ? { selectedOptionalResponsibilityId: override.id } : {}),
    };
  }
  if (hasExplicitOptionalResponsibilityId) {
    return { selectionStatus: 'unknown', selectionEvidence: 'official_terms' };
  }

  const keyOverride = existing.byKey.get(semanticKey) || existing.byKey.get(key);
  if (keyOverride?.selectionStatus) {
    return {
      ...(keyOverride.id ? { optionalResponsibilityId: keyOverride.id, selectedOptionalResponsibilityId: keyOverride.id } : {}),
      selectionStatus: keyOverride.selectionStatus,
      selectionEvidence: keyOverride.selectionEvidence || 'manual',
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
  const canonicalProductId = canonicalProductIdForRecord(indicator, policy.company);
  if (!optional) {
    return {
      ...indicator,
      ...(canonicalProductId ? { canonicalProductId } : {}),
      responsibilityScope: 'basic',
      selectionStatus: 'selected',
      selectionEvidence: 'official_terms',
    };
  }
  const explicitOptionalResponsibilityId = normalizeOptionalResponsibilityId(indicator?.optionalResponsibilityId);
  const id = explicitOptionalResponsibilityId || buildOptionalResponsibilityId(indicator);
  const selection = inferOptionalResponsibilitySelection(policy, indicator, id, Boolean(explicitOptionalResponsibilityId));
  return {
    ...indicator,
    ...(canonicalProductId ? { canonicalProductId } : {}),
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
      const canonicalProductId = String(item?.canonicalProductId || '').trim();
      const id = normalizeOptionalResponsibilityId(item?.id) || buildOptionalResponsibilityId({ company, productName, canonicalProductId, coverageType, liability });
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
  const company = String(candidate?.company || '').trim();
  const productName = String(candidate?.productName || '').trim();
  const coverageType = String(candidate?.coverageType || '').trim();
  const liability = String(candidate?.liability || '').trim();
  const hasMergeCanonicalProductId = Object.prototype.hasOwnProperty.call(candidate || {}, 'mergeCanonicalProductId');
  const mergeCanonicalProductId = hasMergeCanonicalProductId
    ? String(candidate?.mergeCanonicalProductId || '').trim()
    : explicitCanonicalProductId(candidate);
  const canonicalProductId = explicitCanonicalProductId(candidate) || canonicalProductIdForRecord(candidate);
  const id = normalizeOptionalResponsibilityId(candidate?.id) || buildOptionalResponsibilityId({
    company,
    productName,
    canonicalProductId: String(candidate?.canonicalProductId || '').trim(),
    coverageType,
    liability,
  });
  if (!id || (!productName && !coverageType && !liability)) return;
  const normalized = {
    id,
    company,
    productName,
    ...(canonicalProductId ? { canonicalProductId } : {}),
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
    mergeCanonicalProductId,
  };
  const mergeKey = optionalResponsibilityMergeKey(normalized);
  const existingKey = candidates.has(id)
    ? id
    : [...candidates.entries()].find(([, item]) => optionalResponsibilityMergeKey(item) === mergeKey)?.[0];
  const existing = existingKey ? candidates.get(existingKey) : null;
  if (!existing) {
    candidates.set(id, normalized);
    return;
  }
  const candidateStatus = normalizeResponsibilitySelectionStatus(normalized.selectionStatus);
  const useCandidateSelection = normalized.selectionEvidence === 'manual'
    ? Boolean(candidateStatus)
    : existing.selectionEvidence !== 'manual' && candidateStatus !== 'unknown';
  const existingQuantificationStatus = normalizeQuantificationStatus(existing.quantificationStatus);
  const candidateQuantificationStatus = normalizeQuantificationStatus(normalized.quantificationStatus);
  const nextQuantificationStatus = existingQuantificationStatus === 'not_quantifiable'
    ? existingQuantificationStatus
    : candidateQuantificationStatus === 'quantified' || candidateQuantificationStatus === 'not_quantifiable'
      ? candidateQuantificationStatus
      : existingQuantificationStatus === 'quantified'
        ? existingQuantificationStatus
        : candidateQuantificationStatus;
  const keepExistingOptionalLabel = normalizeLookupText(existing.coverageType) === '可选责任'
    && normalizeLookupText(normalized.coverageType) !== '可选责任';
  const indicatorIds = [
    ...(Array.isArray(existing.indicatorIds) ? existing.indicatorIds : []),
    ...normalized.indicatorIds,
  ].filter((item, index, list) => item && list.indexOf(item) === index);
  candidates.set(existingKey, {
    ...existing,
    ...normalized,
    id: existing.id || normalized.id,
    coverageType: keepExistingOptionalLabel ? existing.coverageType : normalized.coverageType || existing.coverageType,
    liability: keepExistingOptionalLabel ? existing.liability : normalized.liability || existing.liability,
    title: keepExistingOptionalLabel ? existing.title : normalized.title || existing.title,
    sourceExcerpt: existing.sourceExcerpt || normalized.sourceExcerpt,
    selectionStatus: useCandidateSelection ? candidateStatus : existing.selectionStatus,
    selectionEvidence: useCandidateSelection ? normalized.selectionEvidence : existing.selectionEvidence,
    quantificationStatus: nextQuantificationStatus,
    quantificationReason: normalized.quantificationReason || existing.quantificationReason,
    indicatorIds,
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
  const canonicalIds = new Set(policyCanonicalProductIds(policy));
  if (!keys.size && !canonicalIds.size) return [];
  return (Array.isArray(knowledgeRecords) ? knowledgeRecords : []).filter((record) => {
    const recordCanonicalProductId = explicitCanonicalProductId(record);
    if (canonicalIds.size && recordCanonicalProductId) return canonicalIds.has(recordCanonicalProductId);
    const company = normalizeLookupText(record?.company || parseKnowledgeRecordPayload(record)?.company || policy.company);
    return knowledgeRecordProductNames(record).some((productName) => keys.has(`${company}\u001f${normalizeLookupText(productName)}`));
  });
}

function matchedKnowledgeProductIdentity(policy = {}, record = {}) {
  const recordNames = knowledgeRecordProductNames(record);
  const recordCompany = String(record?.company || parseKnowledgeRecordPayload(record)?.company || policy.company || '').trim();
  const explicitRecordCanonicalProductId = explicitCanonicalProductId(record);
  const recordCanonicalProductId = explicitRecordCanonicalProductId
    || canonicalProductIdForRecord(record, recordCompany || policy.company);
  if (recordCanonicalProductId) {
    const matchedPlan = (Array.isArray(policy.plans) ? policy.plans : []).find((plan) => {
      const matchedProductName = String(plan?.matchedProductName || '').trim();
      const planCanonicalProductId = explicitCanonicalProductId(plan)
        || (matchedProductName
          ? canonicalProductIdFromOfficialProduct({
              company: plan?.company || policy.company,
              productName: matchedProductName,
            })
          : '');
      return planCanonicalProductId && planCanonicalProductId === recordCanonicalProductId;
    });
    return {
      productName: String(matchedPlan?.matchedProductName || '').trim() || recordNames[0] || String(policy.name || '').trim(),
      canonicalProductId: explicitRecordCanonicalProductId
        || explicitCanonicalProductId(matchedPlan)
        || explicitCanonicalProductId(policy),
    };
  }

  const matchedPlan = (Array.isArray(policy.plans) ? policy.plans : []).find((plan) => {
    const matchedProductName = String(plan?.matchedProductName || '').trim();
    return matchedProductName && recordNames.some((name) => normalizeLookupText(name) === normalizeLookupText(matchedProductName));
  });
  return {
    productName: String(matchedPlan?.matchedProductName || '').trim() || recordNames[0] || String(policy.name || '').trim(),
    canonicalProductId: explicitCanonicalProductId(policy),
  };
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
      const productIdentity = matchedKnowledgeProductIdentity(policy, record);
      const candidate = {
        company: String(policy.company || record?.company || parseKnowledgeRecordPayload(record)?.company || '').trim(),
        productName: productIdentity.productName,
        ...(productIdentity.canonicalProductId ? { canonicalProductId: productIdentity.canonicalProductId } : {}),
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
    mergeOptionalResponsibilityCandidate(candidates, {
      ...record,
      mergeCanonicalProductId: mergeCanonicalProductIdForPolicyCandidate(policy, record),
    });
  }
  for (const record of Array.isArray(optionalResponsibilityRecords) ? optionalResponsibilityRecords : []) {
    if (!optionalResponsibilityRecordMatchesPolicy(policy, record)) continue;
    const normalized = normalizeGovernanceOptionalResponsibilityRecord(record);
    const hasConcreteCandidateForProduct = normalizeLookupText(normalized.liability) === '可选责任'
      && [...candidates.values()].some((item) =>
        normalizeLookupText(item.productName) === normalizeLookupText(normalized.productName)
          && normalizeLookupText(item.liability) !== '可选责任'
    );
    if (hasConcreteCandidateForProduct) continue;
    mergeOptionalResponsibilityCandidate(candidates, {
      ...normalized,
      mergeCanonicalProductId: mergeCanonicalProductIdForPolicyCandidate(policy, record),
    });
  }

  for (const indicator of annotated) {
    if (indicator.responsibilityScope !== 'optional') continue;
    const indicatorOptionalId = String(indicator.optionalResponsibilityId || '').trim();
    const existingByIndicatorId = indicatorOptionalId ? candidates.get(indicatorOptionalId) : null;
    const existingByConcreteLiability = [...candidates.values()].find((item) =>
      normalizeLookupText(item.productName) === normalizeLookupText(indicator.productName || policy.name)
        && normalizeLookupText(item.liability) === normalizeLookupText(indicator.liability)
    );
    const existing = existingByConcreteLiability
      || (normalizeLookupText(existingByIndicatorId?.liability) === '可选责任' ? null : existingByIndicatorId);
    const id = existing?.id || indicatorOptionalId || buildOptionalResponsibilityId(indicator);
    const quantificationStatus = indicatorQuantificationStatus(indicator);
    const candidate = {
      id,
      company: String(indicator.company || policy.company || '').trim(),
      productName: String(indicator.productName || policy.name || '').trim(),
      ...(indicator.canonicalProductId ? { canonicalProductId: indicator.canonicalProductId } : {}),
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
      {
        ...(existing ? { ...candidate, selectionStatus: existing.selectionStatus, selectionEvidence: existing.selectionEvidence } : candidate),
        mergeCanonicalProductId: mergeCanonicalProductIdForPolicyCandidate(policy, indicator),
      },
    );
  }

  for (const candidate of buildOptionalResponsibilitiesFromKnowledge(policy, knowledgeRecords)) {
    const candidateIsGeneric = normalizeLookupText(candidate?.liability) === '可选责任';
    const hasConcreteCandidateForProduct = [...candidates.values()].some((item) =>
      normalizeLookupText(item.productName) === normalizeLookupText(candidate.productName)
        && normalizeLookupText(item.liability) !== '可选责任'
    );
    if (candidateIsGeneric && hasConcreteCandidateForProduct) continue;
    mergeOptionalResponsibilityCandidate(candidates, candidate);
  }

  for (const persisted of normalizeOptionalResponsibilities(policy?.optionalResponsibilities)) {
    if (!optionalResponsibilityRecordMatchesPolicy(policy, persisted)) continue;
    const existingByKey = [...candidates.values()].find((candidate) => optionalResponsibilityKey(candidate) === optionalResponsibilityKey(persisted));
    const id = existingByKey?.id || persisted.id;
    mergeOptionalResponsibilityCandidate(candidates, {
      ...persisted,
      id,
      mergeCanonicalProductId: mergeCanonicalProductIdForPolicyCandidate(policy, persisted),
    });
  }

  return [...candidates.values()].map(({ mergeCanonicalProductId, ...candidate }) => candidate).sort(
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
  const canonicalIds = new Set(policyCanonicalProductIds(policy));
  const recordCanonicalProductId = explicitCanonicalProductId(record);
  if (canonicalIds.size && recordCanonicalProductId) return canonicalIds.has(recordCanonicalProductId);
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return false;
  const company = normalizeLookupText(record?.company || policy.company);
  const productName = normalizeLookupText(record?.productName || record?.name || record?.title);
  return productName && keys.has(`${company}\u001f${productName}`);
}

function explicitCanonicalProductId(record = {}) {
  return String(record?.canonicalProductId || '').trim();
}

export function policyCanonicalProductIds(policy = {}) {
  const ids = [];
  const add = (canonicalProductId) => {
    const id = String(canonicalProductId || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(policy.canonicalProductId);
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    add(plan?.canonicalProductId);
    const matchedProductName = String(plan?.matchedProductName || '').trim();
    if (matchedProductName) {
      add(canonicalProductIdFromOfficialProduct({
        company: plan?.company || policy.company,
        productName: matchedProductName,
      }));
    }
  }
  return ids;
}

function explicitPolicyCanonicalProductIds(policy = {}) {
  const ids = [];
  const add = (canonicalProductId) => {
    const id = String(canonicalProductId || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(policy.canonicalProductId);
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    add(plan?.canonicalProductId);
  }
  return ids;
}

function mergeCanonicalProductIdForPolicyCandidate(policy = {}, candidate = {}) {
  const candidateCanonicalProductId = explicitCanonicalProductId(candidate);
  if (!candidateCanonicalProductId) return '';
  return explicitPolicyCanonicalProductIds(policy).includes(candidateCanonicalProductId) ? candidateCanonicalProductId : '';
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
  const canonicalIds = new Set(policyCanonicalProductIds(policy));
  if (!keys.size && !canonicalIds.size) return [];
  return dedupePolicyIndicatorRows(
    (Array.isArray(indicatorRecords) ? indicatorRecords : []).filter((record) => {
      const recordCanonicalProductId = explicitCanonicalProductId(record);
      if (canonicalIds.size && recordCanonicalProductId) return canonicalIds.has(recordCanonicalProductId);
      return keys.has(`${normalizeLookupText(resolveRecordCompany(record))}\u001f${normalizeLookupText(resolveRecordProductName(record))}`);
    }),
  ).map((record) => annotateCoverageIndicatorSelection(policy, record));
}

export function attachPolicyCoverageIndicators(policy = {}, indicatorRecords = [], knowledgeRecords = [], optionalResponsibilityRecords = []) {
  const normalizedPolicy = {
    ...policy,
    plans: normalizePolicyPlans(policy?.plans, policy?.company || ''),
  };
  const coverageIndicators = findPolicyCoverageIndicators(normalizedPolicy, indicatorRecords);
  return {
    ...normalizedPolicy,
    coverageIndicators,
    optionalResponsibilities: buildOptionalResponsibilityReview(normalizedPolicy, coverageIndicators, knowledgeRecords, optionalResponsibilityRecords),
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

export function buildPolicyFromScan({ state, userId = null, guestId = '', scan, analysis, familyBinding = null }) {
  const data = normalizePolicyScanData(scan?.data || {});
  let plans = normalizePolicyPlans(scan?.data?.plans, data.company);
  const mainPlan = plans.find((plan) => plan.role === 'main') || plans[0] || null;
  const canonicalProductId = data.canonicalProductId || mainPlan?.canonicalProductId || '';
  if (plans.length && (data.amount || data.firstPremium)) {
    plans = plans.map((plan, index) => {
      const isMain = plan.role === 'main' || index === 0;
      if (!isMain) return plan;
      return {
        ...plan,
        amount: plan.amount || data.amount || 0,
        premium: plan.premium || data.firstPremium || 0,
      };
    });
  }
  const now = new Date().toISOString();
  const hasAnalysis = Boolean(analysis?.report || analysis?.coverageTable?.length || analysis?.optionalResponsibilities?.length);
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
  const useFamilyRelationLabels = String(familyBinding?.familyBindingSource || '').trim() === 'explicit';
  const applicantRelation = String(
    (useFamilyRelationLabels ? familyBinding?.applicantRelationLabel : '') ||
      data.applicantRelation ||
      familyBinding?.applicantRelationLabel ||
      '',
  ).trim();
  const insuredRelation = String(
    (useFamilyRelationLabels ? familyBinding?.insuredRelationLabel : '') ||
      data.insuredRelation ||
      familyBinding?.insuredRelationLabel ||
      '',
  ).trim();

  return {
    id: allocateId(state),
    userId: userId ? Number(userId) : null,
    guestId: userId ? '' : normalizeGuestId(guestId),
    company: data.company,
    name: data.name,
    applicant: data.applicant,
    beneficiary: data.beneficiary,
    applicantRelation,
    insured: data.insured,
    insuredRelation,
    insuredIdNumber: data.insuredIdNumber,
    insuredBirthday: data.insuredBirthday,
    date: data.date,
    paymentPeriod: data.paymentPeriod,
    coveragePeriod: data.coveragePeriod,
    amount: data.amount,
    firstPremium: data.firstPremium,
    canonicalProductId,
    plans,
    ocrText: String(scan?.ocrText || '').trim(),
    responsibilities,
    optionalResponsibilities,
    report: String(analysis?.report || '').trim(),
    sources: normalizePolicySources(analysis?.sources),
    familyBindingSource: String(familyBinding?.familyBindingSource || '').trim(),
    familyId: familyBinding?.familyId || null,
    applicantMemberId: familyBinding?.applicantMemberId || null,
    insuredMemberId: familyBinding?.insuredMemberId || null,
    applicantNameSnapshot: String(familyBinding?.applicantNameSnapshot || '').trim(),
    insuredNameSnapshot: String(familyBinding?.insuredNameSnapshot || '').trim(),
    applicantRelationSnapshot: String(familyBinding?.applicantRelationSnapshot || '').trim(),
    insuredRelationSnapshot: String(familyBinding?.insuredRelationSnapshot || '').trim(),
    participantReviewStatus: String(familyBinding?.participantReviewStatus || '').trim(),
    insuredMemberName: String(familyBinding?.insuredMemberName || '').trim(),
    insuredRelationLabel: String(familyBinding?.insuredRelationLabel || '').trim(),
    applicantMemberName: String(familyBinding?.applicantMemberName || '').trim(),
    applicantRelationLabel: String(familyBinding?.applicantRelationLabel || '').trim(),
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
