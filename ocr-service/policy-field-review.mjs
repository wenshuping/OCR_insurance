function trim(value) {
  return String(value || '').trim();
}

function compactText(value) {
  return trim(value).replace(/\s+/gu, '');
}

const LABEL_LIKE_TEXT = [
  '姓名',
  '合同成立日期',
  '合同生效日期',
  '保单生效日',
  '保单生效日期',
  '生效日期',
  '生效日',
  '投保人',
  '被保险人',
  '被保人',
  '受保人',
  '保单号',
  '保险合同号',
  '合同号',
  '险种名称',
  '产品名称',
  '保险金额',
  '标准保费',
  '交费期间',
  '缴费期间',
  '保险期间',
];

function isDateLike(value) {
  return /(19\d{2}|20\d{2})[年./-]?\d{1,2}[月./-]?\d{1,2}/u.test(compactText(value));
}

function isIdNumberLike(value) {
  const text = compactText(value).replace(/[^\dXx]/gu, '');
  if (!/^\d{17}[\dXx]$|^\d{15}$/u.test(text)) return false;
  return hasValidIdNumberBirthday(text);
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

function hasValidIdNumberBirthday(value) {
  const idNumber = compactText(value).replace(/[^\dXx]/gu, '');
  if (idNumber.length === 18) {
    return isValidDateParts(idNumber.slice(6, 10), idNumber.slice(10, 12), idNumber.slice(12, 14));
  }
  if (idNumber.length === 15) {
    const shortYear = Number(idNumber.slice(6, 8));
    const year = String(shortYear >= 30 ? 1900 + shortYear : 2000 + shortYear);
    return isValidDateParts(year, idNumber.slice(8, 10), idNumber.slice(10, 12));
  }
  return false;
}

function isPersonNameLike(value) {
  const text = compactText(value);
  if (!/^[一-龥·]{2,8}$/u.test(text)) return false;
  if (LABEL_LIKE_TEXT.includes(text)) return false;
  if (LABEL_LIKE_TEXT.some((label) => text.includes(label))) return false;
  return true;
}

function isPolicyNumberLike(value) {
  const text = compactText(value).replace(/[^\dA-Za-z]/gu, '');
  if (text.length < 8) return false;
  if (/^\d{8}$/u.test(text) && isDateLike(text)) return false;
  if (isIdNumberLike(text)) return false;
  return true;
}

function rejectField(field, value) {
  const text = compactText(value);
  if (!text) return false;
  if (field === 'applicant' || field === 'insured') return !isPersonNameLike(text);
  if (field === 'policyNumber') return !isPolicyNumberLike(text);
  if (field === 'insuredIdNumber') return !isIdNumberLike(text);
  return false;
}

function fieldLabel(field) {
  if (field === 'applicant') return '投保人';
  if (field === 'insured') return '被保险人';
  if (field === 'policyNumber') return '保单号';
  if (field === 'insuredIdNumber') return '被保险人证件号';
  if (field === 'beneficiary') return '身故受益人';
  if (field === 'amount') return '保额';
  if (field === 'firstPremium') return '首期保费';
  return field;
}

function evidenceText(evidence) {
  if (!evidence) return '';
  if (typeof evidence === 'string') return compactText(evidence);
  if (typeof evidence !== 'object') return '';
  return compactText([
    evidence.value,
    evidence.rawValue,
    evidence.labelText,
    evidence.rowText,
    evidence.relation,
    evidence.source,
    evidence.region,
  ].filter(Boolean).join(' '));
}

function hasExplicitPremiumEvidence(evidence) {
  const text = evidenceText(evidence);
  return /首期|首年|首次|保费|保险费合计|保险费|总保费|总保险费|每年/u.test(text);
}

function hasNonDeathBeneficiaryEvidence(evidence) {
  const text = evidenceText(evidence);
  return /(残疾|医疗|生存|满期|年金).{0,12}受益人/u.test(text) && !/身故/u.test(text);
}

function hasResponsibilityDetailEvidence(evidence) {
  const text = evidenceText(evidence);
  return /保险责任名称|金额\/?份数|给付标准|免赔额|赔付比例|社保赔付|保险金/u.test(text)
    && !/基本保险金额|保险金额\/保险金额/u.test(text);
}

function markReview(field, confidence, warnings, warning) {
  confidence[field] = 'review';
  warnings.push(warning);
}

export function reviewPolicyFieldValues({ data = {}, fieldConfidence = {}, fieldEvidence = {}, warnings = [] } = {}) {
  const nextData = { ...data };
  const nextConfidence = { ...fieldConfidence };
  const nextEvidence = { ...fieldEvidence };
  const nextWarnings = [...warnings];

  for (const field of ['applicant', 'insured', 'policyNumber', 'insuredIdNumber']) {
    const value = trim(nextData[field]);
    if (!rejectField(field, value)) continue;
    delete nextData[field];
    delete nextEvidence[field];
    nextConfidence[field] = 'review';
    nextWarnings.push(`${fieldLabel(field)}识别结果“${value}”不符合字段类型，请确认`);
  }

  if (trim(nextData.firstPremium) && nextEvidence.firstPremium && !hasExplicitPremiumEvidence(nextEvidence.firstPremium)) {
    markReview('firstPremium', nextConfidence, nextWarnings, '首期保费缺少明确保费标签证据，请确认');
  }

  if (trim(nextData.beneficiary) && nextEvidence.beneficiary && hasNonDeathBeneficiaryEvidence(nextEvidence.beneficiary)) {
    markReview('beneficiary', nextConfidence, nextWarnings, '受益人证据不是身故受益人区域，请确认');
  }

  if (trim(nextData.amount) && nextEvidence.amount && hasResponsibilityDetailEvidence(nextEvidence.amount)) {
    markReview('amount', nextConfidence, nextWarnings, '保额证据可能来自保险责任明细表，请确认');
  }

  return {
    data: nextData,
    fieldConfidence: nextConfidence,
    fieldEvidence: nextEvidence,
    warnings: [...new Set(nextWarnings.map(trim).filter(Boolean))],
  };
}
