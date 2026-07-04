import crypto from 'node:crypto';

import {
  CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_PHOTO_REVIEWED_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_PHOTO_SOURCE_KIND,
  CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL,
  CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL,
  CUSTOMER_POLICY_TERMS_SOURCE_KIND,
} from './policy-knowledge.service.mjs';
import { evidenceVerificationFields } from './evidence-classification.service.mjs';

const MAX_CUSTOMER_POLICY_PHOTO_UPLOADS = 5;
const MAX_CUSTOMER_POLICY_PHOTO_TEXT_CHARS = 6000;

function text(value) {
  return String(value || '').trim();
}

function normalizeLine(value) {
  return text(value).replace(/\s+/gu, ' ');
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function firstText(...values) {
  return values.map(text).find(Boolean) || '';
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueLines(lines = []) {
  const seen = new Set();
  const result = [];
  for (const rawLine of lines) {
    const line = normalizeLine(rawLine);
    if (!line) continue;
    const key = compact(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }
  return result;
}

function mergeOcrTexts(...values) {
  return uniqueLines(values.flatMap((value) => text(value).split(/\r?\n/u))).join('\n');
}

function sensitiveValuePatterns(values = []) {
  return values
    .map(compact)
    .filter((value) => value.length >= 2)
    .map((value) => new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
}

function looksLikePrivatePolicyLine(line = '', valuePatterns = []) {
  const normalized = compact(line);
  if (!normalized) return true;
  if (valuePatterns.some((pattern) => pattern.test(normalized))) return true;
  if (/\d{17}[\dXx]|\d{15}/u.test(normalized)) return true;
  if (/1[3-9]\d{9}/u.test(normalized)) return true;
  if (/(?:投保人|要保人|被保(?:险)?人|受益人|证件号码|证件号|身份证|保单号|合同号|客户号|手机号|联系电话|出生日期|生日|家庭住址|联系地址|地址)[:：]/u.test(line)) return true;
  if (/(?:保单载明|本保单|您已选择|已选择|已投保|本次投保|保险单载明|投保的保险责任).*(?:可选责任|附加责任)/u.test(line)) return true;
  return false;
}

function looksLikeProductKnowledgeLine(line = '') {
  return /(?:保险公司|承保公司|产品名称|险种名称|主险|附加|保险利益表|保险责任|基本责任|可选责任|责任免除|给付|保险金|豁免|年金|津贴|身故|全残|重大疾病|轻度疾病|中度疾病|医疗|住院|护理|终身寿险|两全保险|年金保险|重大疾病保险|医疗保险|意外伤害保险|护理保险|万能型|分红型)/u.test(line);
}

function looksLikePolicyTermsEvidence(pageText = '') {
  const target = compact(pageText);
  if (!target) return false;
  const hasResponsibilityBody = /(?:保险责任|保险利益表|基本责任|可选责任|责任免除|给付|保险金|身故|全残|重大疾病|医疗保险金|住院|年金|生存金|满期保险金)/u.test(target);
  const hasContractMarker = /(?:本合同|保险合同|保险单|保险条款|条款|险种名称|产品名称|保险期间|基本保险金额|被保险人|受益人)/u.test(target);
  return hasResponsibilityBody && hasContractMarker;
}

export function sanitizeCustomerPolicyPhotoKnowledgeText({ ocrText = '', scan = {}, manualData = {} } = {}) {
  const privateValuePatterns = sensitiveValuePatterns([
    scan?.data?.applicant,
    scan?.data?.insured,
    scan?.data?.beneficiary,
    scan?.data?.insuredIdNumber,
    manualData?.applicant,
    manualData?.insured,
    manualData?.beneficiary,
    manualData?.insuredIdNumber,
  ]);
  const lines = uniqueLines(text(ocrText).split(/\r?\n/u));
  const safeLines = lines
    .filter((line) => !looksLikePrivatePolicyLine(line, privateValuePatterns))
    .filter((line) => looksLikeProductKnowledgeLine(line));
  return safeLines.join('\n').slice(0, MAX_CUSTOMER_POLICY_PHOTO_TEXT_CHARS).trim();
}

function digestForKnowledgeRecord({ company = '', productName = '', pageText = '', createdAt = '' } = {}) {
  return crypto
    .createHash('sha1')
    .update([company, productName, pageText, createdAt].map(text).join('\u001f'))
    .digest('hex')
    .slice(0, 20);
}

export function buildCustomerPolicyPhotoKnowledgeRecord({
  company = '',
  productName = '',
  pageText = '',
  ownerUserId = 0,
  ownerGuestId = '',
  uploadItems = [],
  createdAt = new Date().toISOString(),
} = {}) {
  const resolvedCompany = text(company);
  const resolvedProductName = text(productName);
  const safePageText = text(pageText);
  if (!resolvedCompany || !resolvedProductName || !safePageText) return null;
  const termsEvidence = looksLikePolicyTermsEvidence(safePageText);
  const digest = digestForKnowledgeRecord({
    company: resolvedCompany,
    productName: resolvedProductName,
    pageText: safePageText,
    createdAt,
  });
  const record = {
    company: resolvedCompany,
    productName: resolvedProductName,
    title: termsEvidence ? `客户上传保单责任页/合同页：${resolvedProductName}` : `客户补充保单照片识别：${resolvedProductName}`,
    url: termsEvidence ? `customer-policy-terms://knowledge/${digest}` : `customer-policy-photo://knowledge/${digest}`,
    snippet: safePageText.slice(0, 220),
    pageText: safePageText,
    sourceType: termsEvidence ? 'customer_policy_terms' : 'customer_policy_photo',
    materialType: termsEvidence ? 'policy_terms' : 'policy_photo',
    official: termsEvidence,
    evidenceLabel: termsEvidence ? CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL : '客户上传保单照片（待审核）',
    evidenceLevel: termsEvidence ? CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL : CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
    sourceLevel: termsEvidence ? CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL : CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
    sourceKind: termsEvidence ? CUSTOMER_POLICY_TERMS_SOURCE_KIND : CUSTOMER_POLICY_PHOTO_SOURCE_KIND,
    parser: 'policy_product_knowledge_scan',
    reviewStatus: termsEvidence ? 'approved' : 'pending',
    globalSearchable: termsEvidence,
    responsibilityDeferred: !termsEvidence,
    ownerUserId: Number(ownerUserId || 0) || 0,
    ownerGuestId: text(ownerGuestId),
    uploadNames: normalizeArray(uploadItems).map((item) => text(item?.name)).filter(Boolean),
    discoveredAt: createdAt,
    lastFetchedAt: createdAt,
    updatedAt: createdAt,
  };
  return {
    ...record,
    ...evidenceVerificationFields(record),
  };
}

export function approveCustomerPolicyPhotoKnowledgeRecord(record = {}, { approved = true, reviewedAt = new Date().toISOString() } = {}) {
  if (![CUSTOMER_POLICY_PHOTO_SOURCE_KIND, CUSTOMER_POLICY_TERMS_SOURCE_KIND].includes(text(record.sourceKind))) return null;
  if (!approved) {
    return {
      ...record,
      reviewStatus: 'rejected',
      globalSearchable: false,
      evidenceLabel: '客户上传保单照片（已驳回）',
      evidenceLevel: CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
      sourceLevel: CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
      reviewedAt,
      updatedAt: reviewedAt,
    };
  }
  const termsEvidence = looksLikePolicyTermsEvidence(record.pageText || record.snippet);
  const next = {
    ...record,
    reviewStatus: 'approved',
    globalSearchable: true,
    sourceKind: termsEvidence ? CUSTOMER_POLICY_TERMS_SOURCE_KIND : CUSTOMER_POLICY_PHOTO_SOURCE_KIND,
    sourceType: termsEvidence ? 'customer_policy_terms' : 'customer_policy_photo',
    materialType: termsEvidence ? 'policy_terms' : 'policy_photo',
    official: termsEvidence,
    evidenceLabel: termsEvidence ? CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL : '客户上传保单照片（已审核，非官方）',
    evidenceLevel: termsEvidence ? CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL : CUSTOMER_POLICY_PHOTO_REVIEWED_EVIDENCE_LEVEL,
    sourceLevel: termsEvidence ? CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL : CUSTOMER_POLICY_PHOTO_REVIEWED_EVIDENCE_LEVEL,
    responsibilityDeferred: !termsEvidence,
    reviewedAt,
    updatedAt: reviewedAt,
  };
  return {
    ...next,
    ...evidenceVerificationFields(next),
  };
}

export function normalizeCustomerPolicyPhotoUploadItems(value = []) {
  const uploadItems = normalizeArray(value).filter((item) => item && typeof item === 'object' && text(item.dataUrl));
  if (!uploadItems.length) {
    const error = new Error('请上传补充产品页或保险利益表照片');
    error.code = 'CUSTOMER_POLICY_PHOTO_UPLOAD_REQUIRED';
    error.status = 400;
    throw error;
  }
  if (uploadItems.length > MAX_CUSTOMER_POLICY_PHOTO_UPLOADS) {
    const error = new Error('补充照片最多上传 5 张保险产品页面');
    error.code = 'CUSTOMER_POLICY_PHOTO_UPLOAD_LIMIT';
    error.status = 400;
    throw error;
  }
  return uploadItems;
}

function preferredProductName(scan = {}, manualData = {}, fallbackName = '') {
  const scanName = text(scan?.data?.name);
  if (scanName && scanName !== 'OCR识别保单') return scanName;
  return firstText(manualData?.name, fallbackName, scanName);
}

export function mergeCustomerPolicyPhotoScans({ baseScan = null, supplementScans = [], manualData = {}, fallback = {} } = {}) {
  const scans = normalizeArray(supplementScans);
  const bestSupplement = scans.find((scan) => preferredProductName(scan, {}, '')) || scans[0] || {};
  const baseData = baseScan?.data || {};
  const supplementData = bestSupplement?.data || {};
  const company = firstText(supplementData.company, baseData.company, manualData.company, fallback.company);
  const name = preferredProductName(bestSupplement, manualData, firstText(baseData.name, fallback.name));
  const plans = normalizeArray(supplementData.plans).length ? supplementData.plans : baseData.plans;
  return {
    ...(baseScan || {}),
    ocrText: mergeOcrTexts(baseScan?.ocrText, ...scans.map((scan) => scan?.ocrText)),
    data: {
      ...baseData,
      ...manualData,
      ...supplementData,
      company,
      name,
      ...(plans ? { plans } : {}),
    },
    ocrWarnings: uniqueLines([
      ...normalizeArray(baseScan?.ocrWarnings),
      ...scans.flatMap((scan) => normalizeArray(scan?.ocrWarnings)),
      '补充照片已作为当前保单证据保存；可解析的责任页会作为客户上传合同页参与分析，非责任页需后台审核后才会全局复用',
    ]),
  };
}

export function customerPolicyPhotoPendingMatch(record = {}) {
  const company = text(record.company);
  const productName = text(record.productName);
  if (!company || !productName) return null;
  const evidenceFields = evidenceVerificationFields(record);
  const sourceKind = text(record.sourceKind) || CUSTOMER_POLICY_PHOTO_SOURCE_KIND;
  const sourceType = sourceKind === CUSTOMER_POLICY_TERMS_SOURCE_KIND ? 'customer_policy_terms' : 'customer_policy_photo';
  const materialType = sourceKind === CUSTOMER_POLICY_TERMS_SOURCE_KIND ? 'policy_terms' : 'policy_photo';
  return {
    company,
    productName,
    title: text(record.title) || productName,
    score: 0.92,
    matchReason: evidenceFields.referenceOnly ? '客户补充保单照片识别，待审核' : '客户上传保单责任页/合同页识别',
    evidenceLabel: record.evidenceLabel || evidenceFields.verificationLabel,
    evidenceLevel: record.evidenceLevel || CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
    verificationStatus: evidenceFields.verificationStatus,
    verificationLabel: evidenceFields.verificationLabel,
    referenceOnly: evidenceFields.referenceOnly,
    sourceKind,
    inputName: productName,
    resolvedProductName: productName,
    needsConfirmation: true,
    responsibilityDeferred: evidenceFields.referenceOnly,
    sourceCount: 1,
    bestSource: {
      title: text(record.title) || productName,
      url: text(record.url),
      sourceType,
      materialType,
      sourceKind,
      evidenceLevel: record.evidenceLevel || CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL,
      verificationStatus: evidenceFields.verificationStatus,
      verificationLabel: evidenceFields.verificationLabel,
      referenceOnly: evidenceFields.referenceOnly,
      responsibilityDeferred: evidenceFields.referenceOnly,
    },
  };
}
