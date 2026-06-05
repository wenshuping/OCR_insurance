import { clusterBoxesIntoRows } from './policy-layout-boxes.mjs';
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

const GENERAL_LABEL_BOUNDARIES = [
  '性别',
  '出生日期',
  '出生年月',
  '保险期间',
  '交费期间',
  '缴费期间',
  '交费方式',
  '缴费方式',
  '基本保险金额',
  '保险金额',
  '保险费',
  '首期保险费',
  '证件类型',
  '职业',
  '电话',
  '手机',
  '地址',
  '关系',
];

function normalizePerson(value) {
  const matched = compactText(value).match(/^[一-龥·]{2,8}/u)?.[0] || '';
  return isKnownLabelText(matched) ? '' : matched;
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
  { field: 'policyNumber', labels: ['保险合同号', '保单号', '合同号'], labelPattern: /^(?:保险合同号|保单号|合同号)[:：]?/u, normalize: normalizePolicyNumber },
  { field: 'applicant', labels: ['投保人'], labelPattern: /^投保人(?!豁免|的)[:：]?/u, normalize: normalizePerson },
  { field: 'insured', labels: ['被保险人', '被保人', '受保人'], labelPattern: /^(?:被保险人(?!的)|被保人|受保人)[:：]?/u, normalize: normalizePerson },
  { field: 'insuredIdNumber', labels: ['证件号码', '证件号', '身份证号码', '身份证号'], labelPattern: /^(?:证件号码|证件号|身份证号码|身份证号)[:：]?/u, normalize: normalizeIdNumber },
  { field: 'date', labels: ['合同生效日期', '生效日期', '保险起期'], labelPattern: /^(?:合同生效日期|生效日期|保险起期)[:：]?/u, normalize: normalizeDateOnly },
  { field: 'beneficiary', labels: ['身故保险金受益人', '身故受益人', '受益人'], labelPattern: /^(?:身故保险金受益人|身故受益人|受益人)[:：]?/u, normalize: normalizeBeneficiary },
  { field: 'name', labels: ['产品名称', '险种名称', '保险名称', '合同名称', '主险名称'], labelPattern: /^(?:产品名称|险种名称|保险名称|合同名称|主险名称)[:：]?/u, normalize: compactText },
];

const ALL_LABEL_BOUNDARIES = [
  ...FIELD_LABELS.flatMap((labelDef) => labelDef.labels),
  ...GENERAL_LABEL_BOUNDARIES,
].sort((left, right) => right.length - left.length);

function isKnownLabelText(value) {
  const text = compactText(value).replace(/[:：]$/u, '');
  return ALL_LABEL_BOUNDARIES.includes(text);
}

function confidenceFor(label, value) {
  if (!label || !value) return 'missing';
  return 'high';
}

function isLabelItem(item) {
  const text = compactText(item?.text);
  return FIELD_LABELS.some((labelDef) => labelDef.labelPattern.test(text))
    || GENERAL_LABEL_BOUNDARIES.some((label) => text.startsWith(label));
}

function labelOccurrenceInText(labelDef, value) {
  const text = compactText(value);
  const matches = labelDef.labels
    .map((label) => {
      const index = text.indexOf(label);
      if (index < 0 || !isAllowedLabelOccurrence(labelDef, text, index, label)) return null;
      const colonLength = /[:：]/u.test(text[index + label.length] || '') ? 1 : 0;
      return { index, length: label.length + colonLength };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index || right.length - left.length);
  return matches[0] || null;
}

function isAllowedLabelOccurrence(labelDef, text, index, label) {
  const afterLabel = text.slice(index + label.length);
  if (labelDef.field === 'applicant' && /^(?:豁免|的)/u.test(afterLabel)) return false;
  if (labelDef.field === 'insured' && label === '被保险人' && afterLabel.startsWith('的')) return false;
  return true;
}

function findLabelInRow(row, labelDef) {
  const matches = row.items
    .map((item) => {
      const occurrence = labelOccurrenceInText(labelDef, item.text);
      return occurrence ? { item, ...occurrence } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.item.xMin - right.item.xMin || left.index - right.index);
  return matches[0] || null;
}

function nextLabelRightOf(label, row) {
  return row.items
    .filter((item) => item.xMin > label.item.xMax && item !== label.item && isLabelItem(item))
    .sort((left, right) => left.xMin - right.xMin)[0] || null;
}

function candidateRightOf(label, row) {
  const nextLabel = nextLabelRightOf(label, row);
  const candidates = row.items
    .filter((item) => (
      item.xMin > label.item.xMax
      && item !== label.item
      && !isLabelItem(item)
      && (!nextLabel || item.xMin < nextLabel.xMin)
    ))
    .sort((left, right) => left.xMin - right.xMin);
  return candidates[0] || null;
}

function inlineValueAfter(labelDef, label, row) {
  const rowItems = [...row.items].sort((left, right) => left.xMin - right.xMin);
  const labelIndex = rowItems.indexOf(label.item);
  if (labelIndex < 0) return '';

  const parts = [];
  for (let index = labelIndex; index < rowItems.length; index += 1) {
    const item = rowItems[index];
    if (index > labelIndex && isLabelItem(item)) break;
    parts.push(item.text || '');
  }
  return textAfterLabelBeforeNextLabel(labelDef, parts.join(''), label.index, label.length);
}

function textAfterLabelBeforeNextLabel(labelDef, value, labelIndex = 0, labelLength = null) {
  const text = compactText(value);
  const matched = labelLength === null ? text.match(labelDef.labelPattern) : null;
  const start = labelLength === null ? matched?.[0]?.length : labelIndex + labelLength;
  if (start === undefined) return '';

  const remainder = text.slice(start);
  const nextLabelIndex = nextKnownLabelIndex(remainder);
  return nextLabelIndex === null ? remainder : remainder.slice(0, nextLabelIndex);
}

function nextKnownLabelIndex(value) {
  const text = compactText(value);
  const indexes = [];

  for (const labelDef of FIELD_LABELS) {
    for (const label of labelDef.labels) {
      let index = text.indexOf(label);
      while (index >= 0) {
        if (isAllowedLabelOccurrence(labelDef, text, index, label)) {
          indexes.push(index);
          break;
        }
        index = text.indexOf(label, index + 1);
      }
    }
  }

  for (const label of GENERAL_LABEL_BOUNDARIES) {
    const index = text.indexOf(label);
    if (index >= 0) indexes.push(index);
  }

  return indexes.length ? Math.min(...indexes) : null;
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
    const company = normalizeCompany(item.text);
    if (!company || fields.company) continue;
    fields.company = company;
    fieldConfidence.company = 'high';
    evidence.company = {
      value: company,
      source: 'basic-info-layout',
      confidence: Number(item.confidence || 0) || 0,
      labelBox: item.box,
      valueBox: item.box,
      region: 'header',
    };
  }

  for (const row of rows) {
    for (const labelDef of FIELD_LABELS) {
      const label = findLabelInRow(row, labelDef);
      if (!label || fields[labelDef.field]) continue;
      const right = candidateRightOf(label, row);
      const inline = inlineValueAfter(labelDef, label, row);
      const rawValue = right?.text || inline;
      const value = labelDef.normalize(rawValue);
      if (!value) continue;
      fields[labelDef.field] = value;
      fieldConfidence[labelDef.field] = confidenceFor(label, right || label);
      evidence[labelDef.field] = {
        value,
        source: 'basic-info-layout',
        confidence: Number(right?.confidence || label.item.confidence || 0) || 0,
        labelBox: label.item.box,
        valueBox: right?.box || label.item.box,
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
