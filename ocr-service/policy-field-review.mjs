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
  return /^\d{17}[\dXx]$|^\d{15}$/u.test(text);
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
  return field;
}

export function reviewPolicyFieldValues({ data = {}, fieldConfidence = {}, warnings = [] } = {}) {
  const nextData = { ...data };
  const nextConfidence = { ...fieldConfidence };
  const nextWarnings = [...warnings];

  for (const field of ['applicant', 'insured', 'policyNumber', 'insuredIdNumber']) {
    const value = trim(nextData[field]);
    if (!rejectField(field, value)) continue;
    delete nextData[field];
    nextConfidence[field] = 'review';
    nextWarnings.push(`${fieldLabel(field)}识别结果“${value}”不符合字段类型，请确认`);
  }

  return {
    data: nextData,
    fieldConfidence: nextConfidence,
    warnings: [...new Set(nextWarnings.map(trim).filter(Boolean))],
  };
}
