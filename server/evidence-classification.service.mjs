export const INSURER_OFFICIAL_SOURCE_KIND = 'insurer_official';
export const INSURER_OFFICIAL_EVIDENCE_LEVEL = 'insurer_official';
export const CUSTOMER_POLICY_TERMS_SOURCE_KIND = 'customer_policy_terms';
export const CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL = 'customer_policy_terms';
export const CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL = '客户上传保单责任页/合同页';
export const CUSTOMER_POLICY_PHOTO_SOURCE_KIND = 'customer_policy_photo';
export const CUSTOMER_POLICY_PHOTO_PENDING_EVIDENCE_LEVEL = 'customer_policy_photo_pending';
export const CUSTOMER_POLICY_PHOTO_REVIEWED_EVIDENCE_LEVEL = 'customer_policy_photo_reviewed';
export const REGULATORY_INDUSTRY_TERMS_EVIDENCE_LEVEL = 'regulatory_industry_terms';
export const REGULATORY_INDUSTRY_TERMS_EVIDENCE_LABEL = '金融产品查询平台/中国保险行业协会条款 PDF';
export const EXTERNAL_REFERENCE_EVIDENCE_LEVEL = 'external_legacy_reference';
export const EXTERNAL_REFERENCE_EVIDENCE_LABEL = '非官方资料，待保险公司确认';

const EXTERNAL_REFERENCE_SOURCE_KINDS = new Set(['legacy_external_reference', 'open_web_reference']);

function text(value) {
  return String(value ?? '').trim();
}

function sourceKindOf(source = {}) {
  return text(source.sourceKind);
}

function evidenceLevelOf(source = {}) {
  return text(source.evidenceLevel || source.sourceLevel);
}

export function isExternalReferenceEvidence(source = {}) {
  const sourceKind = sourceKindOf(source);
  const evidenceLevel = evidenceLevelOf(source);
  return (
    EXTERNAL_REFERENCE_SOURCE_KINDS.has(sourceKind) ||
    evidenceLevel === EXTERNAL_REFERENCE_EVIDENCE_LEVEL ||
    text(source.materialType) === 'external_reference'
  );
}

export function isCustomerPolicyTermsEvidence(source = {}) {
  const sourceKind = sourceKindOf(source);
  const evidenceLevel = evidenceLevelOf(source);
  return (
    sourceKind === CUSTOMER_POLICY_TERMS_SOURCE_KIND ||
    evidenceLevel === CUSTOMER_POLICY_TERMS_EVIDENCE_LEVEL ||
    (sourceKind === CUSTOMER_POLICY_PHOTO_SOURCE_KIND && evidenceLevel === CUSTOMER_POLICY_PHOTO_REVIEWED_EVIDENCE_LEVEL)
  );
}

export function isRegulatoryIndustryTermsEvidence(source = {}) {
  const sourceKind = sourceKindOf(source);
  const evidenceLevel = evidenceLevelOf(source);
  return sourceKind === 'jrcpcx' || evidenceLevel === REGULATORY_INDUSTRY_TERMS_EVIDENCE_LEVEL;
}

export function isInsurerOfficialEvidence(source = {}) {
  const sourceKind = sourceKindOf(source);
  const evidenceLevel = evidenceLevelOf(source);
  if (isExternalReferenceEvidence(source) || isRegulatoryIndustryTermsEvidence(source)) return false;
  return sourceKind === INSURER_OFFICIAL_SOURCE_KIND || evidenceLevel === INSURER_OFFICIAL_EVIDENCE_LEVEL || source.official === true;
}

export function evidenceVerificationFields(source = {}) {
  const explicitStatus = text(source.verificationStatus);
  if (isExternalReferenceEvidence(source) || source.referenceOnly === true || source.responsibilityDeferred === true) {
    return {
      verificationStatus: explicitStatus || 'pending_review',
      verificationLabel: text(source.verificationLabel || source.evidenceLabel) || EXTERNAL_REFERENCE_EVIDENCE_LABEL,
      referenceOnly: true,
    };
  }
  if (isCustomerPolicyTermsEvidence(source)) {
    return {
      verificationStatus: explicitStatus || 'verified',
      verificationLabel: text(source.verificationLabel || source.evidenceLabel) || CUSTOMER_POLICY_TERMS_EVIDENCE_LABEL,
      referenceOnly: false,
    };
  }
  if (isRegulatoryIndustryTermsEvidence(source)) {
    return {
      verificationStatus: explicitStatus || 'industry_terms',
      verificationLabel: text(source.verificationLabel || source.evidenceLabel) || REGULATORY_INDUSTRY_TERMS_EVIDENCE_LABEL,
      referenceOnly: false,
    };
  }
  return {
    verificationStatus: explicitStatus || 'verified',
    verificationLabel: text(source.verificationLabel || source.evidenceLabel) || '保险公司官方资料',
    referenceOnly: false,
  };
}

export function withEvidenceVerificationFields(source = {}) {
  return {
    ...source,
    ...evidenceVerificationFields(source),
  };
}

export function isReferenceOnlyEvidence(source = {}) {
  return evidenceVerificationFields(source).referenceOnly === true;
}

export function isFormalResponsibilityEvidence(source = {}) {
  if (isReferenceOnlyEvidence(source)) return false;
  if (isCustomerPolicyTermsEvidence(source) || isInsurerOfficialEvidence(source)) return true;
  const hasEvidenceMarker = Boolean(sourceKindOf(source) || evidenceLevelOf(source));
  return !hasEvidenceMarker && source.official !== false;
}
