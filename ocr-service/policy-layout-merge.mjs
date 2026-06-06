import { reviewPolicyFieldValues } from './policy-field-review.mjs';

const CORE_LAYOUT_FIELDS = [
  'company',
  'applicant',
  'insured',
  'policyNumber',
  'date',
  'beneficiary',
  'insuredIdNumber',
  'insuredBirthday',
];
const REVIEW_ONLY_FIELDS = ['name'];
const VISUAL_TABLE_FIELDS = ['name', 'amount', 'coveragePeriod', 'paymentPeriod', 'firstPremium'];

function trim(value) {
  return String(value || '').trim();
}

function uniqueWarnings(items = []) {
  return [...new Set(items.map(trim).filter(Boolean))];
}

export function mergePolicyLayoutScanResult({ textData = {}, layoutResult = null } = {}) {
  if (!layoutResult?.fields) {
    return {
      data: { ...textData },
      fieldConfidence: {},
      fieldEvidence: {},
      ocrWarnings: [],
    };
  }

  const data = { ...textData };
  const fieldConfidence = { ...(layoutResult.fieldConfidence || {}) };
  const fieldEvidence = { ...(layoutResult.evidence || {}) };
  const warnings = [...(layoutResult.ocrWarnings || [])];

  for (const field of REVIEW_ONLY_FIELDS) {
    delete fieldConfidence[field];
  }

  for (const field of CORE_LAYOUT_FIELDS) {
    const value = trim(layoutResult.fields[field]);
    if (!value) continue;
    const confidence = String(layoutResult.fieldConfidence?.[field] || '');
    if (confidence === 'high' || !trim(data[field])) {
      data[field] = value;
    } else if (trim(data[field]) !== value) {
      warnings.push(`${field} 坐标识别结果与文本识别结果不一致，请确认`);
    }
  }

  for (const field of REVIEW_ONLY_FIELDS) {
    const value = trim(layoutResult.fields[field]);
    if (!value) continue;
    if (String(layoutResult.fieldConfidence?.[field] || '') === 'visual-table') continue;
    if (!trim(data[field])) {
      data[field] = value;
      fieldConfidence[field] = 'review';
    } else if (trim(data[field]) !== value) {
      fieldConfidence[field] = 'review';
      warnings.push('产品名称存在多个候选，请确认是否为主险名称');
    }
  }

  for (const field of VISUAL_TABLE_FIELDS) {
    const value = trim(layoutResult.fields[field]);
    if (!value) continue;
    if (String(layoutResult.fieldConfidence?.[field] || '') !== 'visual-table') continue;
    data[field] = value;
    fieldConfidence[field] = 'visual-table';
  }

  if (String(layoutResult.fieldConfidence?.plans || '') === 'visual-table' && Array.isArray(layoutResult.fields.plans)) {
    data.plans = layoutResult.fields.plans;
    fieldConfidence.plans = 'visual-table';
  }

  const reviewed = reviewPolicyFieldValues({ data, fieldConfidence, fieldEvidence, warnings });

  return {
    data: reviewed.data,
    fieldConfidence: reviewed.fieldConfidence,
    fieldEvidence: reviewed.fieldEvidence,
    ocrWarnings: uniqueWarnings(reviewed.warnings),
  };
}
