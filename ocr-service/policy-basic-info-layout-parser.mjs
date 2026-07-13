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
  '姓名',
  '职业',
  '电话',
  '手机',
  '地址',
  '关系',
  '受益顺序',
  '受益份额',
];

function normalizePerson(value) {
  const matched = compactText(value).match(/^[一-龥·]{2,8}/u)?.[0] || '';
  if (/^(?:申请|姓名|性别|出生日期|本人|受益顺序|受益份额)$/u.test(matched)) return '';
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

function normalizeAmount(value) {
  const text = compactText(value)
    .replace(/[,，]/gu, '')
    .replace(/[¥￥元圆份]/gu, '');
  const matched = text.match(/(\d+(?:\.\d+)?)(万|亿)?/u);
  if (!matched) return '';
  const base = Number(matched[1]);
  if (!Number.isFinite(base) || base <= 0) return '';
  const unit = matched[2] || '';
  const multiplier = unit === '亿' ? 100000000 : unit === '万' ? 10000 : 1;
  return String(Math.round(base * multiplier));
}

function normalizeCoveragePeriod(value) {
  const text = compactText(value);
  const dateMatched = text.match(/至(20\d{2})年(\d{1,2})月(\d{1,2})日/u);
  if (dateMatched) {
    const [, year, rawMonth, rawDay] = dateMatched;
    const month = rawMonth.padStart(2, '0');
    const day = rawDay.padStart(2, '0');
    return isValidDateParts(year, month, day) ? `至${year}年${month}月${day}日` : '';
  }
  if (/终身/u.test(text)) return '终身';
  const ageMatched = text.match(/(?:保至|保障至|至)?(\d{2,3})周?岁/u);
  if (ageMatched?.[1]) return `至${ageMatched[1]}岁`;
  if (/^\d{1,3}年$/u.test(text)) return text;
  return '';
}

function normalizePaymentPeriod(value) {
  const text = compactText(value);
  if (/一次交清|一次性交清|一次性交费|一次性缴清|趸交/u.test(text)) return '趸交';
  const matched = text.match(/(\d{1,3})年(?:交|缴)?/u);
  if (matched?.[1]) return `${matched[1]}年交`;
  return '';
}

function normalizePaymentMode(value) {
  const text = compactText(value);
  if (/一次交清|一次性交清|一次性交费|一次性缴清|趸交/u.test(text)) return '趸交';
  if (/年交|年缴/u.test(text)) return '年交';
  if (/月交|月缴/u.test(text)) return '月交';
  if (/季交|季缴/u.test(text)) return '季交';
  return '';
}

function inferPlanRole(name, index) {
  const text = compactText(name);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  return index === 0 ? 'main' : 'rider';
}

function inferPlanProductType(name) {
  const text = compactText(name);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return '万能账户';
  if (/医疗/u.test(text)) return '医疗险';
  if (/意外/u.test(text)) return '意外险';
  if (/疾病|重疾/u.test(text)) return '重疾险';
  if (/寿险/u.test(text)) return '寿险';
  return '';
}

const FIELD_LABELS = [
  { field: 'policyNumber', labels: ['保险合同号', '保险单号码', '保险单号', '保单号码', '保单号', '合同号'], labelPattern: /^(?:保险合同号|保险单号码|保险单号|保单号码|保单号|合同号)[:：]?/u, normalize: normalizePolicyNumber },
  { field: 'applicant', labels: ['投保人姓名', '投保人', '设保人姓名', '设保人'], labelPattern: /^(?:投保人(?:姓名)?|设保人(?:姓名)?)(?!豁免|的)[:：]?/u, normalize: normalizePerson },
  { field: 'insured', labels: ['被保险人姓名', '被保险入姓名', '披保险人姓名', '被保人姓名', '受保人姓名', '被保险人', '被保险入', '披保险人', '被保人', '受保人'], labelPattern: /^(?:被保险[人入](?:姓名)?(?!的)|披保险人(?:姓名)?|被保人(?:姓名)?|受保人(?:姓名)?)[:：]?/u, normalize: normalizePerson },
  { field: 'insuredIdNumber', labels: ['证件号码', '证件号', '身份证号码', '身份证号'], labelPattern: /^(?:证件号码|证件号|身份证号码|身份证号)[:：]?/u, normalize: normalizeIdNumber },
  { field: 'date', labels: ['保险责任开始时间', '合同成立日期', '合同生效日期', '保单生效日期', '保单生效日', '投保日期', '生效日期', '生效日', '保险起期'], labelPattern: /^(?:保险责任开始时间|合同成立日期|合同生效日期|保单生效日期|保单生效日|投保日期|生效日期|生效日|保险起期)[:：]?/u, normalize: normalizeDateOnly },
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
  const beforeLabel = text.slice(0, index);
  if (labelDef.field === 'applicant' && (/^(?:豁免|的|申请|关系)/u.test(afterLabel) || beforeLabel.endsWith('与'))) return false;
  if (labelDef.field === 'insured' && (/^(?:关系|的)/u.test(afterLabel) || beforeLabel.endsWith('与'))) return false;
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

function findLabelsInRow(row, labelDef) {
  return row.items
    .flatMap((item) => {
      const text = compactText(item.text);
      const matches = [];
      for (const label of labelDef.labels) {
        let index = text.indexOf(label);
        while (index >= 0) {
          if (isAllowedLabelOccurrence(labelDef, text, index, label)) {
            const colonLength = /[:：]/u.test(text[index + label.length] || '') ? 1 : 0;
            matches.push({ item, index, length: label.length + colonLength, label });
          }
          index = text.indexOf(label, index + 1);
        }
      }
      return matches;
    })
    .sort((left, right) => left.item.xMin - right.item.xMin || left.index - right.index || right.length - left.length);
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
      (item.xMin > label.item.xMax || (item.xMid > label.item.xMid && item.xMax > label.item.xMax))
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

function inlineValueInLabelItem(labelDef, label) {
  return textAfterLabelBeforeNextLabel(labelDef, label.item?.text || '', label.index, label.length);
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

function rowText(row) {
  return [...(row?.items || [])]
    .sort((left, right) => left.xMin - right.xMin)
    .map((item) => String(item.text || '').trim())
    .filter(Boolean)
    .join(' ');
}

function evidenceFromLayout({ value, rawValue, label, row, relation, source = 'basic-info-layout', confidence = null, valueItem = null }) {
  return {
    value,
    rawValue: rawValue || '',
    labelText: label?.item?.text || '',
    rowText: rowText(row),
    relation,
    source,
    confidence: Number(confidence ?? valueItem?.confidence ?? label?.item?.confidence ?? 0) || 0,
    labelBox: label?.item?.box,
    valueBox: valueItem?.box || label?.item?.box,
    region: source === 'basic-info-layout' ? 'basic-info' : 'benefit-table',
  };
}

function collectFieldCandidates(rows, labelDef) {
  const candidates = [];
  for (const row of rows) {
    for (const label of findLabelsInRow(row, labelDef)) {
      const right = candidateRightOf(label, row);
      const sameItemInline = inlineValueInLabelItem(labelDef, label);
      const rowInline = inlineValueAfter(labelDef, label, row);
      const sameItemInlineValue = labelDef.normalize(sameItemInline);
      const rightValue = labelDef.normalize(right?.text);
      let rawValue = rowInline;
      let relation = 'row';
      let valueItem = right || label.item;
      if (sameItemInlineValue) {
        rawValue = sameItemInline;
        relation = 'inline';
        valueItem = label.item;
      } else if (rightValue) {
        rawValue = right.text;
        relation = 'right';
        valueItem = right;
      }
      const value = labelDef.normalize(rawValue);
      if (!value) continue;
      candidates.push({
        value,
        rawValue,
        label,
        row,
        relation,
        valueItem,
      });
    }
  }
  return candidates;
}

function dateCandidateScore(candidate) {
  const labelText = compactText(candidate?.label?.item?.text || '');
  if (/合同生效日期|合同生效日|生效日期|生效日|保险起期/u.test(labelText)) return 100;
  if (/合同成立日期|合同成立日/u.test(labelText)) return 80;
  if (/保单生效日期|保单生效日/u.test(labelText)) return 70;
  return 50;
}

function applyPreferredDateCandidate(fields, fieldConfidence, evidence, rows) {
  const dateDef = FIELD_LABELS.find((item) => item.field === 'date');
  const candidates = collectFieldCandidates(rows, dateDef);
  const sameRowEffectiveCandidate = candidates.find((candidate) => {
    const text = compactText(rowText(candidate.row));
    return /合同成立日期|合同成立日/u.test(text) && /合同生效日期|合同生效日/u.test(text) && /合同生效日期|合同生效日/u.test(compactText(candidate.label.item.text));
  });
  const candidate = sameRowEffectiveCandidate || (!fields.date
    ? candidates.sort((left, right) => dateCandidateScore(right) - dateCandidateScore(left) || left.row.yMid - right.row.yMid)[0]
    : null);
  if (!candidate) return;
  fields.date = candidate.value;
  fieldConfidence.date = 'high';
  evidence.date = evidenceFromLayout({
    value: candidate.value,
    rawValue: candidate.rawValue,
    label: candidate.label,
    row: candidate.row,
    relation: candidate.relation,
    valueItem: candidate.valueItem,
  });
}

function nearestLabelRow(rows, field) {
  const labelDef = FIELD_LABELS.find((item) => item.field === field);
  if (!labelDef) return null;
  return rows.find((row) => findLabelInRow(row, labelDef)) || null;
}

function rowHasFieldLabel(row, field) {
  const labelDef = FIELD_LABELS.find((item) => item.field === field);
  return Boolean(labelDef && findLabelInRow(row, labelDef));
}

function distanceScore(candidateRow, anchorRow) {
  if (!candidateRow || !anchorRow) return 0;
  const distance = Math.abs(Number(candidateRow.yMid || 0) - Number(anchorRow.yMid || 0));
  return Math.max(0, 80 - distance);
}

function applyInsuredIdentityCandidate(fields, fieldConfidence, evidence, rows) {
  const idDef = FIELD_LABELS.find((item) => item.field === 'insuredIdNumber');
  const candidates = collectFieldCandidates(rows, idDef);
  if (!candidates.length) return;

  const applicantRow = nearestLabelRow(rows, 'applicant');
  const insuredRow = nearestLabelRow(rows, 'insured');
  const insuredRowIndex = rows.indexOf(insuredRow);
  const beneficiaryRowOffset = insuredRowIndex >= 0
    ? rows.slice(insuredRowIndex + 1).findIndex((row) => /(?:生存保险金受益人|身故保险金受益人|身故受益人|受益人)/u.test(compactText(rowText(row))))
    : -1;
  const insuredSectionEnd = beneficiaryRowOffset < 0 ? rows.length : insuredRowIndex + 1 + beneficiaryRowOffset;
  const explicitInsuredBirthday = insuredRowIndex < 0
    ? ''
    : rows.slice(insuredRowIndex, insuredSectionEnd)
      .filter((row) => /(?:出生日期|出生年月|生日)/u.test(compactText(rowText(row))))
      .map((row) => normalizeDateOnly(rowText(row)))
      .find(Boolean) || '';
  const scored = candidates
    .map((candidate) => {
      let score = 0;
      if (rowHasFieldLabel(candidate.row, 'insured')) score += 120;
      if (rowHasFieldLabel(candidate.row, 'applicant')) score -= 120;
      score += distanceScore(candidate.row, insuredRow);
      score -= distanceScore(candidate.row, applicantRow);
      if (fields.insured && compactText(rowText(candidate.row)).includes(compactText(fields.insured))) score += 40;
      const idBirthday = birthdayFromIdNumber(candidate.value);
      if (explicitInsuredBirthday && idBirthday === explicitInsuredBirthday) score += 200;
      else if (explicitInsuredBirthday && idBirthday) score -= 100;
      return { candidate, score };
    })
    .sort((left, right) => right.score - left.score || right.candidate.row.yMid - left.candidate.row.yMid);
  const best = scored[0]?.candidate;
  if (!best) return;

  fields.insuredIdNumber = best.value;
  fields.insuredBirthday = birthdayFromIdNumber(best.value);
  fieldConfidence.insuredIdNumber = 'high';
  if (fields.insuredBirthday) fieldConfidence.insuredBirthday = 'high';
  evidence.insuredIdNumber = evidenceFromLayout({
    value: best.value,
    rawValue: best.rawValue,
    label: best.label,
    row: best.row,
    relation: best.relation,
    valueItem: best.valueItem,
  });
}

function isBeneficiaryTableHeader(text) {
  const value = compactText(text);
  return !value || /^(?:证件号码|证件号|受益顺序|受益份额|[-—－一]+)$/u.test(value);
}

function applyDeathBeneficiaryCandidate(fields, fieldConfidence, evidence, rows) {
  const labelRowIndex = rows.findIndex((row) => /身故保险金受益人|身故受益人/u.test(compactText(rowText(row))));
  if (labelRowIndex < 0) return;
  const beneficiaryDef = FIELD_LABELS.find((item) => item.field === 'beneficiary');
  const label = findLabelInRow(rows[labelRowIndex], beneficiaryDef) || {
    item: rows[labelRowIndex].items.find((item) => /身故保险金受益人|身故受益人/u.test(compactText(item.text))) || rows[labelRowIndex].items[0],
    index: 0,
    length: 0,
  };

  for (let index = labelRowIndex + 1; index < Math.min(rows.length, labelRowIndex + 6); index += 1) {
    const row = rows[index];
    const text = rowText(row);
    if (/保险利益表|合同生效日期|合同成立日期|投保人/u.test(compactText(text))) break;
    if (isBeneficiaryTableHeader(text)) continue;
    const value = normalizeBeneficiary(text);
    if (!value) continue;
    fields.beneficiary = value;
    fieldConfidence.beneficiary = 'high';
    evidence.beneficiary = evidenceFromLayout({
      value,
      rawValue: text,
      label,
      row,
      relation: 'below',
      valueItem: row.items[0],
    });
    return;
  }
}

function labelForItem(item) {
  return {
    item,
    index: 0,
    length: compactText(item?.text || '').length,
  };
}

function findRowItem(row, pattern) {
  return row?.items?.find((item) => pattern.test(compactText(item.text))) || null;
}

function nearestGeneralLabelRight(row, item) {
  return row?.items
    ?.filter((candidate) => candidate !== item && candidate.xMin > item.xMax && isLabelItem(candidate))
    .sort((left, right) => left.xMin - right.xMin)[0] || null;
}

function valueBelowLabel(rows, labelRowIndex, labelItem, normalize, { maxRows = 4, maxYDistance = 260 } = {}) {
  if (!labelItem) return null;
  const rightBoundary = nearestGeneralLabelRight(rows[labelRowIndex], labelItem)?.xMin || Number.POSITIVE_INFINITY;
  const leftBoundary = labelItem.xMin - 80;
  const labelMidY = Number(labelItem.yMid || 0);
  for (let offset = 1; offset <= maxRows && labelRowIndex + offset < rows.length; offset += 1) {
    const row = rows[labelRowIndex + offset];
    if (labelMidY && Math.abs(Number(row.yMid || 0) - labelMidY) > maxYDistance) break;
    const candidates = [...(row.items || [])]
      .filter((item) => item.xMid >= leftBoundary && item.xMid < rightBoundary && !isLabelItem(item))
      .sort((left, right) => left.xMin - right.xMin);
    for (const item of candidates) {
      const value = normalize(item.text);
      if (value) return { value, rawValue: item.text, row, valueItem: item };
    }
  }
  return null;
}

function firstValueInRows(rows, startIndex, normalize, {
  maxRows = 4,
  maxYDistance = 260,
  leftBoundary = Number.NEGATIVE_INFINITY,
  rightBoundary = Number.POSITIVE_INFINITY,
} = {}) {
  const anchorY = Number(rows[startIndex]?.yMid || 0);
  for (let offset = 1; offset <= maxRows && startIndex + offset < rows.length; offset += 1) {
    const row = rows[startIndex + offset];
    if (anchorY && Math.abs(Number(row.yMid || 0) - anchorY) > maxYDistance) break;
    for (const item of [...(row.items || [])].sort((left, right) => left.xMin - right.xMin)) {
      if (item.xMid < leftBoundary || item.xMid > rightBoundary || isLabelItem(item)) continue;
      const value = normalize(item.text);
      if (value) return { value, rawValue: item.text, row, valueItem: item };
    }
  }
  return null;
}

function dateItemInRow(row) {
  for (const item of row?.items || []) {
    const value = normalizeDateOnly(item.text);
    if (value) return { value, rawValue: item.text, valueItem: item };
  }
  return null;
}

function applyLegacyTableField(fields, fieldConfidence, evidence, rows, {
  field,
  labelPattern,
  normalize,
  overwrite = false,
}) {
  if (!overwrite && fields[field]) return;
  const labelRowIndex = rows.findIndex((row) => findRowItem(row, labelPattern));
  if (labelRowIndex < 0) return;
  const labelItem = findRowItem(rows[labelRowIndex], labelPattern);
  const candidate = valueBelowLabel(rows, labelRowIndex, labelItem, normalize);
  if (!candidate) return;
  fields[field] = candidate.value;
  fieldConfidence[field] = 'high';
  evidence[field] = evidenceFromLayout({
    value: candidate.value,
    rawValue: candidate.rawValue,
    label: labelForItem(labelItem),
    row: candidate.row,
    relation: 'below',
    valueItem: candidate.valueItem,
  });
}

function applyLegacyInsuredName(fields, fieldConfidence, evidence, rows) {
  if (fields.insured) return;
  const applicantHeaderIndex = rows.findIndex((row) => /投保人姓名/u.test(compactText(rowText(row))));
  const insuredHeaderIndex = rows.findIndex((row, index) => (
    index > applicantHeaderIndex
    && /姓名/u.test(compactText(rowText(row)))
    && /出生日期/u.test(compactText(rowText(row)))
    && !/投保人|受益人/u.test(compactText(rowText(row)))
  ));
  if (insuredHeaderIndex < 0) return;

  const nameHeader = findRowItem(rows[insuredHeaderIndex], /^姓名$/u) || rows[insuredHeaderIndex].items[0];
  const nextHeader = nearestGeneralLabelRight(rows[insuredHeaderIndex], nameHeader);
  const candidate = firstValueInRows(rows, insuredHeaderIndex, normalizePerson, {
    rightBoundary: nextHeader?.xMin || nameHeader.xMax + 700,
  });
  if (!candidate) return;
  fields.insured = candidate.value;
  fieldConfidence.insured = 'high';
  evidence.insured = evidenceFromLayout({
    value: candidate.value,
    rawValue: candidate.rawValue,
    label: labelForItem(nameHeader),
    row: candidate.row,
    relation: 'below',
    valueItem: candidate.valueItem,
  });

  if (!fields.insuredBirthday) {
    const birthday = dateItemInRow(rows[insuredHeaderIndex]);
    if (birthday) {
      fields.insuredBirthday = birthday.value;
      fieldConfidence.insuredBirthday = 'high';
      evidence.insuredBirthday = evidenceFromLayout({
        value: birthday.value,
        rawValue: birthday.rawValue,
        label: labelForItem(findRowItem(rows[insuredHeaderIndex], /出生日期/u) || nameHeader),
        row: rows[insuredHeaderIndex],
        relation: 'row',
        valueItem: birthday.valueItem,
      });
    }
  }
}

function applyLegacyResponsibilityStartDate(fields, fieldConfidence, evidence, rows) {
  const labelRowIndex = rows.findIndex((row) => /保险责任开始时间/u.test(compactText(rowText(row))));
  if (labelRowIndex < 0) return;
  const labelItem = findRowItem(rows[labelRowIndex], /保险责任开始时间/u);
  const nearbyRows = [rows[labelRowIndex], rows[labelRowIndex - 1], rows[labelRowIndex + 1]].filter(Boolean);
  for (const row of nearbyRows) {
    const candidate = dateItemInRow(row);
    if (!candidate) continue;
    fields.date = candidate.value;
    fieldConfidence.date = 'high';
    evidence.date = evidenceFromLayout({
      value: candidate.value,
      rawValue: candidate.rawValue,
      label: labelForItem(labelItem),
      row,
      relation: row === rows[labelRowIndex] ? 'row' : 'nearby',
      valueItem: candidate.valueItem,
    });
    return;
  }
}

function applyLegacyAmountAndPremium(fields, fieldConfidence, evidence, rows) {
  const amountRow = rows.find((row) => /保险金额/u.test(compactText(rowText(row))) && normalizeAmount(rowText(row)));
  if (amountRow && !fields.amount) {
    const labelItem = findRowItem(amountRow, /保险金额/u) || amountRow.items[0];
    const valueItem = [...amountRow.items].reverse().find((item) => normalizeAmount(item.text)) || labelItem;
    fields.amount = normalizeAmount(rowText(amountRow));
    fieldConfidence.amount = 'visual-table';
    evidence.amount = evidenceFromLayout({
      value: fields.amount,
      rawValue: rowText(amountRow),
      label: labelForItem(labelItem),
      row: amountRow,
      relation: 'row',
      valueItem,
      source: 'legacy-policy-layout',
    });
  }

  const premiumRow = rows.find((row) => /(?:缴费标准|交费标准|标准保险费|保险费标准)/u.test(compactText(rowText(row))) && normalizeAmount(rowText(row)));
  if (premiumRow && !fields.firstPremium) {
    const labelItem = findRowItem(premiumRow, /(?:缴费标准|交费标准|标准保险费|保险费标准)/u) || premiumRow.items[0];
    const valueItem = [...premiumRow.items].reverse().find((item) => normalizeAmount(item.text)) || labelItem;
    fields.firstPremium = normalizeAmount(rowText(premiumRow));
    fieldConfidence.firstPremium = 'visual-table';
    evidence.firstPremium = evidenceFromLayout({
      value: fields.firstPremium,
      rawValue: rowText(premiumRow),
      label: labelForItem(labelItem),
      row: premiumRow,
      relation: 'row',
      valueItem,
      source: 'legacy-policy-layout',
    });
  }
}

function applyLegacyPolicyTableCandidates(fields, fieldConfidence, evidence, rows) {
  applyLegacyTableField(fields, fieldConfidence, evidence, rows, {
    field: 'policyNumber',
    labelPattern: /^(?:保险单号码|保险单号)$/u,
    normalize: normalizePolicyNumber,
  });
  applyLegacyTableField(fields, fieldConfidence, evidence, rows, {
    field: 'applicant',
    labelPattern: /^投保人姓名$/u,
    normalize: normalizePerson,
  });
  applyLegacyInsuredName(fields, fieldConfidence, evidence, rows);
  applyLegacyTableField(fields, fieldConfidence, evidence, rows, {
    field: 'beneficiary',
    labelPattern: /^受益人姓名$/u,
    normalize: normalizeBeneficiary,
  });
  applyLegacyResponsibilityStartDate(fields, fieldConfidence, evidence, rows);
  applyLegacyAmountAndPremium(fields, fieldConfidence, evidence, rows);
}

function isResponsibilityTableHeader(text) {
  const value = compactText(text);
  return /保险责任名称|金额\/份数|给付标准|免赔额|赔付比例/u.test(value);
}

function cleanResponsibilityTail(value) {
  let text = compactText(value);
  text = text.replace(/(?:意外伤害身故和残疾|疾病身故或全残|意外身故或全残|疾病住院医疗|疾病特定门诊|意外伤害医疗费用|狂犬病疫苗接种医疗费用|微创美容缝合医疗费用|创伤性牙齿修复医疗费用|特定牙齿缺损定额给付|住院津贴)(?:保险)?金$/u, '');
  const splitBeforeResponsibility = text.match(/^(.+?保险)(?=[一-龥]{2,30}(?:保险金|费用保险金|定额给付保险金|津贴保险金)$)/u);
  if (splitBeforeResponsibility?.[1]) text = splitBeforeResponsibility[1];
  return text;
}

function normalizeVisualPlanName(value, continuation = '') {
  const raw = compactText(value);
  const responsibilityMatch = raw.match(/^(.+?保)(?=(?:意外伤害|疾病|身故|全残|住院|门诊|狂犬病|微创|创伤性|特定)[一-龥]{0,24}(?:保险金|费用保险金|定额给付保险金|津贴保险金)$)/u);
  let text = responsibilityMatch?.[1]
    ? `${responsibilityMatch[1]}${continuation === '险' || responsibilityMatch[1].endsWith('保') ? '险' : ''}`
    : cleanResponsibilityTail(`${value || ''}${continuation || ''}`);
  text = text.replace(/^(?:投保主险|主险)[:：]?/u, '');
  if (/^(?:险种名称|保险责任名称|金额\/份数|给付标准|免赔额|赔付比例)$/u.test(text)) return '';
  if (
    !/(保险|寿险)(?:（[^）]+）|\([^)]*\))?$/u.test(text)
    && !/^[一-龥A-Za-z0-9]+(?:（[^）]+）|\([^)]*\))$/u.test(text)
  ) {
    return '';
  }
  if (text.length <= 4) return '';
  return text;
}

function findHeaderItem(row, pattern) {
  return row.items.find((item) => pattern.test(compactText(item.text))) || null;
}

function columnCutBetween(left, right, fallback) {
  if (left && right) return (left.xMid + right.xMid) / 2;
  return fallback;
}

function amountFromRow(row, amountHeader) {
  const candidates = row.items
    .filter((item) => !amountHeader || item.xMid >= amountHeader.xMid - 80)
    .map((item) => ({ item, amount: normalizeAmount(item.text) }))
    .filter((candidate) => candidate.amount);
  return candidates.sort((left, right) => Math.abs(left.item.xMid - amountHeader.xMid) - Math.abs(right.item.xMid - amountHeader.xMid))[0] || null;
}

function sharedPlanPremiumText(premium, header) {
  if (!premium) return '';
  const hasPlanPremiumColumn = header.items.some((item) => /保费|保险费/u.test(compactText(item.text)));
  return hasPlanPremiumColumn ? '' : `整单合计保费：${premium}；保单未列逐险种保费`;
}

function appendNextProductContinuation(rows, index, productCut) {
  const next = rows[index + 1];
  if (!next) return '';
  const text = compactText(rowText(next));
  if (text !== '险') return '';
  const item = next.items[0];
  return item && item.xMin <= productCut ? text : '';
}

function itemsText(items = []) {
  return items.map((item) => item?.text || '').join('');
}

function columnItems(row, leftCut, rightCut) {
  return row.items.filter((item) => item.xMid >= leftCut && item.xMid < rightCut);
}

function columnBoundsByHeader(header, headerItem) {
  const sortedHeaders = [...(header?.items || [])].sort((left, right) => left.xMid - right.xMid);
  const index = sortedHeaders.indexOf(headerItem);
  if (index < 0) return { left: Number.NEGATIVE_INFINITY, right: Number.POSITIVE_INFINITY };
  const previous = sortedHeaders[index - 1];
  const next = sortedHeaders[index + 1];
  return {
    left: previous ? (previous.xMid + headerItem.xMid) / 2 : Number.NEGATIVE_INFINITY,
    right: next ? (headerItem.xMid + next.xMid) / 2 : Number.POSITIVE_INFINITY,
  };
}

function columnTextForHeader(row, header, headerItem) {
  const bounds = columnBoundsByHeader(header, headerItem);
  return itemsText(columnItems(row, bounds.left, bounds.right));
}

function mergePlanFieldValue(current, next) {
  return current || next || '';
}

function parseVisualPlanSummaryTableFromRows(rows, company = '') {
  const headerIndex = rows.findIndex((row) => {
    const text = compactText(rowText(row));
    return /险种名称|保险项目/u.test(text)
      && /基本保险金额|保险金额|保障计划|份数/u.test(text)
      && /保险期间/u.test(text)
      && /交费方式|缴费方式|交费期间|缴费期间|交费年限|缴费年限/u.test(text)
      && /保险费/u.test(text)
      && !/保险责任名称/u.test(text);
  });
  if (headerIndex < 0) return null;

  const header = rows[headerIndex];
  const productHeader = findHeaderItem(header, /险种名称|保险项目/u);
  const amountHeader = findHeaderItem(header, /基本保险金额|保险金额|保障计划|份数/u);
  const periodHeader = findHeaderItem(header, /保险期间/u);
  const paymentHeader = findHeaderItem(header, /交费方式|缴费方式|交费期间|缴费期间|交费年限|缴费年限/u);
  const premiumHeader = findHeaderItem(header, /保险费/u);
  if (!productHeader || !amountHeader || !periodHeader || !paymentHeader || !premiumHeader) return null;

  const plans = [];
  let current = null;

  function pushCurrent() {
    if (!current) return;
    const name = normalizeVisualPlanName(current.rawName);
    if (!name) {
      current = null;
      return;
    }
    plans.push({
      company,
      role: '',
      name,
      productType: inferPlanProductType(name),
      amount: current.amount || '',
      coveragePeriod: current.coveragePeriod || '',
      paymentMode: current.paymentMode || '',
      paymentPeriod: current.paymentPeriod || '',
      premium: current.premium || '',
      premiumText: '',
    });
    current = null;
  }

  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const text = compactText(rowText(row));
    if (!text) continue;
    if (/^首期保险费合计|^保险费合计|^特别约定|^备注|^保险单说明|^保单制作日期|^（?接第\d+页/u.test(text)) break;
    if (/险种名称|基本保险金额|保险金额|保障计划|份数|保险期间|交费方式|缴费方式|交费期间|缴费期间|保险费/u.test(text)) continue;

    const rawProductText = compactText(columnTextForHeader(row, header, productHeader));
    const amount = normalizeAmount(columnTextForHeader(row, header, amountHeader));
    const coveragePeriod = normalizeCoveragePeriod(columnTextForHeader(row, header, periodHeader));
    const paymentText = columnTextForHeader(row, header, paymentHeader);
    const paymentMode = normalizePaymentMode(paymentText);
    const paymentPeriod = normalizePaymentPeriod(paymentText) || (paymentMode === '趸交' ? '趸交' : '');
    const premium = normalizeAmount(columnTextForHeader(row, header, premiumHeader));
    const hasPlanFields = Boolean(amount || coveragePeriod || paymentMode || paymentPeriod || premium);
    const isParentheticalContinuation = /^（[^）]+）$|^\([^)]*\)$/u.test(rawProductText);

    if (rawProductText) {
      if (current && (isParentheticalContinuation || !normalizeVisualPlanName(current.rawName))) {
        current.rawName = `${current.rawName}${rawProductText}`;
        current.amount = mergePlanFieldValue(current.amount, amount);
        current.coveragePeriod = mergePlanFieldValue(current.coveragePeriod, coveragePeriod);
        current.paymentMode = mergePlanFieldValue(current.paymentMode, paymentMode);
        current.paymentPeriod = mergePlanFieldValue(current.paymentPeriod, paymentPeriod);
        current.premium = mergePlanFieldValue(current.premium, premium);
        continue;
      }
      pushCurrent();
      current = {
        rawName: rawProductText,
        amount,
        coveragePeriod,
        paymentMode,
        paymentPeriod,
        premium,
      };
      continue;
    }

    if (current && hasPlanFields) {
      current.amount = mergePlanFieldValue(current.amount, amount);
      current.coveragePeriod = mergePlanFieldValue(current.coveragePeriod, coveragePeriod);
      current.paymentMode = mergePlanFieldValue(current.paymentMode, paymentMode);
      current.paymentPeriod = mergePlanFieldValue(current.paymentPeriod, paymentPeriod);
      current.premium = mergePlanFieldValue(current.premium, premium);
    }
  }
  pushCurrent();

  if (!plans.length) return null;
  const premiumRow = rows.find((row) => /^首期保险费合计|^保险费合计/u.test(compactText(rowText(row))));
  const totalPremium = normalizeAmount(rowText(premiumRow));
  const normalizedPlans = plans.map((plan, index) => ({
    ...plan,
    role: inferPlanRole(plan.name, index),
  }));
  const firstPremium = totalPremium || (normalizedPlans.length === 1 ? normalizedPlans[0]?.premium || '' : '');

  return {
    fields: {
      name: normalizedPlans[0]?.name || '',
      amount: normalizedPlans[0]?.amount || '',
      coveragePeriod: normalizedPlans[0]?.coveragePeriod || '',
      paymentPeriod: normalizedPlans[0]?.paymentPeriod || '',
      firstPremium,
      plans: normalizedPlans,
    },
    evidence: {
      name: {
        value: normalizedPlans[0]?.name || '',
        rawValue: rowText(rows[headerIndex + 1]),
        labelText: productHeader.text,
        rowText: rowText(rows[headerIndex + 1]),
        relation: 'table-column',
        source: 'benefit-summary-table-layout',
        confidence: Number(productHeader.confidence || 0) || 0,
        labelBox: productHeader.box,
        valueBox: rows[headerIndex + 1]?.items?.[0]?.box,
        region: 'benefit-table',
      },
    },
  };
}

function parseVisualBenefitTable(layout, company = '') {
  const tableBoxes = [...layout.regions.benefitTable, ...layout.regions.riderTable];
  const rows = clusterBoxesIntoRows(tableBoxes, { yThreshold: 14 });
  const headerIndex = rows.findIndex((row) => {
    const text = compactText(rowText(row));
    return /险种名称/u.test(text) && /保险责任名称/u.test(text) && /金额\/份数/u.test(text);
  });
  if (headerIndex < 0) {
    return parseVisualPlanSummaryTableFromRows(rows, company)
      || parseVisualPlanSummaryTableFromRows(clusterBoxesIntoRows(tableBoxes, { yThreshold: 40 }), company);
  }

  const header = rows[headerIndex];
  const productHeader = findHeaderItem(header, /险种名称/u);
  const responsibilityHeader = findHeaderItem(header, /保险责任名称/u);
  const amountHeader = findHeaderItem(header, /金额\/份数/u);
  if (!productHeader || !responsibilityHeader || !amountHeader) return null;

  const productCut = columnCutBetween(productHeader, responsibilityHeader, productHeader.xMax + 120);
  const plans = [];
  for (let index = headerIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    const text = compactText(rowText(row));
    if (!text) continue;
    if (/^保险期间[:：]?|^保险费合计|^特别约定|^保单制作日期|^（?接第\d+页/u.test(text)) break;
    if (isResponsibilityTableHeader(text)) continue;
    const productItems = row.items.filter((item) => item.xMin <= productCut);
    if (!productItems.length) continue;
    const rawProductText = productItems.map((item) => item.text).join('');
    const continuation = appendNextProductContinuation(rows, index, productCut);
    const name = normalizeVisualPlanName(rawProductText, continuation);
    if (!name) continue;
    const amount = amountFromRow(row, amountHeader);
    const plan = {
      company,
      role: '',
      name,
      productType: inferPlanProductType(name),
      amount: amount?.amount || '',
      coveragePeriod: '',
      paymentMode: '',
      paymentPeriod: '',
      premium: '',
      premiumText: '',
    };
    plans.push(plan);
  }

  if (!plans.length) return null;
  const periodRow = rows.find((row) => /^保险期间[:：]?/u.test(compactText(rowText(row))));
  const premiumRowIndex = rows.findIndex((row) => /^保险费合计/u.test(compactText(rowText(row))));
  const premiumRow = premiumRowIndex >= 0 ? rows[premiumRowIndex] : null;
  const premiumNextRow = premiumRowIndex >= 0 ? rows[premiumRowIndex + 1] : null;
  const periodText = rowText(periodRow);
  const coveragePeriod = normalizeCoveragePeriod(periodText);
  const paymentPeriod = normalizePaymentPeriod(periodText);
  const premium = normalizeAmount(rowText(premiumRow)) || normalizeAmount(rowText(premiumNextRow));
  const planPremiumText = sharedPlanPremiumText(premium, header);
  const normalizedPlans = plans.map((plan, index) => ({
    ...plan,
    role: inferPlanRole(plan.name, index),
    coveragePeriod,
    paymentPeriod,
    paymentMode: paymentPeriod === '趸交' ? '趸交' : '',
    premiumText: plan.premiumText || planPremiumText,
  }));

  return {
    fields: {
      name: normalizedPlans[0]?.name || '',
      amount: normalizedPlans[0]?.amount || '',
      coveragePeriod,
      paymentPeriod,
      firstPremium: premium,
      plans: normalizedPlans,
    },
    evidence: {
      name: {
        value: normalizedPlans[0]?.name || '',
        rawValue: rowText(rows[headerIndex + 1]),
        labelText: productHeader.text,
        rowText: rowText(rows[headerIndex + 1]),
        relation: 'table-column',
        source: 'benefit-table-layout',
        confidence: Number(productHeader.confidence || 0) || 0,
        labelBox: productHeader.box,
        valueBox: rows[headerIndex + 1]?.items?.[0]?.box,
        region: 'benefit-table',
      },
    },
  };
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
    paymentPeriod: '',
    coveragePeriod: '',
    amount: '',
    firstPremium: '',
    plans: [],
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
      rawValue: item.text || '',
      labelText: item.text || '',
      rowText: item.text || '',
      relation: 'header',
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
      const sameItemInline = inlineValueInLabelItem(labelDef, label);
      const rowInline = inlineValueAfter(labelDef, label, row);
      const sameItemInlineValue = labelDef.normalize(sameItemInline);
      const rightValue = labelDef.normalize(right?.text);
      let rawValue = rowInline;
      let relation = 'row';
      let valueItem = right || label.item;
      if (sameItemInlineValue) {
        rawValue = sameItemInline;
        relation = 'inline';
        valueItem = label.item;
      } else if (rightValue) {
        rawValue = right.text;
        relation = 'right';
        valueItem = right;
      }
      const value = labelDef.normalize(rawValue);
      if (!value) continue;
      fields[labelDef.field] = value;
      fieldConfidence[labelDef.field] = confidenceFor(label, valueItem || label);
      evidence[labelDef.field] = {
        value,
        rawValue: rawValue || '',
        labelText: label.item.text || '',
        rowText: rowText(row),
        relation,
        source: 'basic-info-layout',
        confidence: Number(valueItem?.confidence || label.item.confidence || 0) || 0,
        labelBox: label.item.box,
        valueBox: valueItem?.box || label.item.box,
        region: 'basic-info',
      };
    }
  }

  applyPreferredDateCandidate(fields, fieldConfidence, evidence, rows);
  applyInsuredIdentityCandidate(fields, fieldConfidence, evidence, rows);
  applyDeathBeneficiaryCandidate(fields, fieldConfidence, evidence, rows);
  applyLegacyPolicyTableCandidates(fields, fieldConfidence, evidence, rows);

  if (fields.insuredIdNumber && !fields.insuredBirthday) {
    fields.insuredBirthday = birthdayFromIdNumber(fields.insuredIdNumber);
    if (fields.insuredBirthday) fieldConfidence.insuredBirthday = 'high';
  }

  const visualBenefitTable = parseVisualBenefitTable(layout, fields.company);
  if (visualBenefitTable?.fields) {
    for (const field of ['name', 'amount', 'coveragePeriod', 'paymentPeriod', 'firstPremium']) {
      if (!visualBenefitTable.fields[field]) continue;
      fields[field] = visualBenefitTable.fields[field];
      fieldConfidence[field] = 'visual-table';
    }
    fields.plans = visualBenefitTable.fields.plans || [];
    if (fields.plans.length) fieldConfidence.plans = 'visual-table';
    Object.assign(evidence, visualBenefitTable.evidence || {});
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
