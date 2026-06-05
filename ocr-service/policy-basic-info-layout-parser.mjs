import { clusterBoxesIntoRows, rowText } from './policy-layout-boxes.mjs';
import { classifyPolicyLayoutRegions } from './policy-layout-regions.mjs';

function compactText(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function normalizeIdNumber(value) {
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

function normalizeDateOnly(value) {
  const matched = String(value || '').match(/(19\d{2}|20\d{2})[年./-]?(\d{1,2})[月./-]?(\d{1,2})/u);
  if (!matched) return '';
  const year = matched[1];
  const month = matched[2].padStart(2, '0');
  const day = matched[3].padStart(2, '0');
  return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
}

function birthdayFromIdNumber(value) {
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

function normalizeCompany(value) {
  const text = compactText(value);
  if (/新华/u.test(text)) return '新华保险';
  return '';
}

function normalizePerson(value) {
  const matched = compactText(value).match(/^[一-龥·]{2,8}/u);
  return matched?.[0] || '';
}

function normalizePolicyNumber(value) {
  const text = compactText(value).replace(/[^\dA-Za-z]/gu, '');
  if (!text || normalizeIdNumber(text) === text) return '';
  return text.length >= 6 ? text : '';
}

function normalizeBeneficiary(value) {
  const text = compactText(value);
  if (/法定/u.test(text)) return '法定';
  return normalizePerson(text);
}

const FIELD_LABELS = [
  { field: 'policyNumber', labelPattern: /^(?:保险合同号|保单号|合同号)[:：]?/u, normalize: normalizePolicyNumber },
  { field: 'applicant', labelPattern: /^投保人(?!豁免|的)[:：]?/u, normalize: normalizePerson },
  { field: 'insured', labelPattern: /^(?:被保险人(?!的)|被保人|受保人)[:：]?/u, normalize: normalizePerson },
  { field: 'insuredIdNumber', labelPattern: /^(?:证件号码|证件号|身份证号码|身份证号)[:：]?/u, normalize: normalizeIdNumber },
  { field: 'date', labelPattern: /^(?:合同生效日期|生效日期|保险起期)[:：]?/u, normalize: normalizeDateOnly },
  { field: 'beneficiary', labelPattern: /^(?:身故保险金受益人|身故受益人|受益人)[:：]?/u, normalize: normalizeBeneficiary },
  { field: 'name', labelPattern: /^(?:产品名称|险种名称|保险名称|合同名称|主险名称)[:：]?/u, normalize: compactText },
];

function confidenceFor(label, value) {
  if (!label || !value) return 'missing';
  return 'high';
}

function candidateRightOf(label, row) {
  const candidates = row.items
    .filter((item) => item.xMin > label.xMax && item.text !== label.text)
    .sort((left, right) => left.xMin - right.xMin);
  return candidates[0] || null;
}

function parseRowsFromAllowedRegions(regions) {
  const allowed = [...regions.header, ...regions.basicInfo];
  return clusterBoxesIntoRows(allowed, { yThreshold: 14 });
}

export function parsePolicyBasicInfoFromLayoutBoxes(rawBoxes = []) {
  const layout = classifyPolicyLayoutRegions(rawBoxes);
  const rows = parseRowsFromAllowedRegions(layout.regions);
  const fields = {
    company: '',
    name: '',
    applicant: '',
    insured: '',
    policyNumber: '',
    date: '',
    beneficiary: '',
    insuredIdNumber: '',
    insuredBirthday: '',
  };
  const fieldConfidence = {};
  const evidence = {};
  const ocrWarnings = [...layout.regionWarnings];

  for (const item of layout.regions.header) {
    fields.company ||= normalizeCompany(item.text);
  }

  for (const row of rows) {
    const text = rowText(row);
    for (const labelDef of FIELD_LABELS) {
      const label = row.items.find((item) => labelDef.labelPattern.test(compactText(item.text)));
      if (!label || fields[labelDef.field]) continue;
      const inline = compactText(text).replace(labelDef.labelPattern, '');
      const right = candidateRightOf(label, row);
      const rawValue = right?.text || inline;
      const value = labelDef.normalize(rawValue);
      if (!value) continue;
      fields[labelDef.field] = value;
      fieldConfidence[labelDef.field] = confidenceFor(label, right || label);
      evidence[labelDef.field] = {
        value,
        source: 'basic-info-layout',
        confidence: Number(right?.confidence || label.confidence || 0) || 0,
        labelBox: label.box,
        valueBox: right?.box || label.box,
        region: 'basic-info',
      };
    }
  }

  if (fields.insuredIdNumber && !fields.insuredBirthday) {
    fields.insuredBirthday = birthdayFromIdNumber(fields.insuredIdNumber);
    if (fields.insuredBirthday) fieldConfidence.insuredBirthday = 'high';
  }

  if (layout.regions.riderTable.length) {
    ocrWarnings.push('检测到附加险区域，基础字段已限制为从基本信息区读取');
  }

  return {
    fields,
    evidence,
    fieldConfidence,
    ocrWarnings,
  };
}
