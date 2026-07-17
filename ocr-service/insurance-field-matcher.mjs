import { createEmptyCandidateMap, createEmptyPolicyFields, POLICY_FIELD_KEYS } from './insurance-field-schema.mjs';
import {
  cleanupFieldText,
  compactText,
  isBenefitTableHeaderLine,
  isPremiumAmountLine,
  isProductDescriptorLine,
  isProductNameNoiseLine,
  lineHasFieldLabel,
  looksLikeCompanyLogoLine,
  normalizeAmountText,
  normalizeCoveragePeriodText,
  normalizePaymentModeText,
  normalizePaymentPeriodText,
  normalizeProductNameText,
} from './insurance-field-rules.mjs';

function createCandidate({ field, value, score, lineIndex = -1, source = '', reason = '', rejected = false }) {
  return {
    field,
    value: String(value || '').trim(),
    score: Number(score || 0),
    lineIndex,
    source,
    reason,
    rejected: Boolean(rejected),
  };
}

function addCandidate(candidates, candidate) {
  if (!candidate.value) return;
  const bucket = candidates[candidate.field] || [];
  const existing = bucket.find((item) => item.value === candidate.value && item.source === candidate.source);
  if (existing) {
    existing.score = Math.max(existing.score, candidate.score);
    existing.rejected = existing.rejected && candidate.rejected;
    return;
  }
  bucket.push(candidate);
  candidates[candidate.field] = bucket;
}

function chooseBestCandidate(candidates = []) {
  return candidates
    .filter((candidate) => candidate.value && !candidate.rejected)
    .sort((left, right) => right.score - left.score || left.lineIndex - right.lineIndex)[0] || null;
}

function candidateEvidenceRegion(field) {
  if (['name', 'amount', 'firstPremium', 'coveragePeriod', 'paymentMode', 'paymentPeriod'].includes(field)) {
    return 'policy-table';
  }
  return 'text';
}

function candidateRowText(lines, lineIndex) {
  if (lineIndex < 0) return '';
  return lines
    .slice(Math.max(0, lineIndex - 1), Math.min(lines.length, lineIndex + 2))
    .map((line) => cleanupFieldText(line))
    .filter(Boolean)
    .join(' ');
}

function buildCandidateEvidence(lines, candidate) {
  if (!candidate?.value) return null;
  const rawValue = candidate.lineIndex >= 0 ? cleanupFieldText(lines[candidate.lineIndex] || '') : '';
  return {
    value: candidate.value,
    rawValue,
    labelText: '',
    rowText: candidateRowText(lines, candidate.lineIndex),
    relation: candidate.source || 'candidate',
    source: 'match-policy-ocr-fields',
    region: candidateEvidenceRegion(candidate.field),
    score: candidate.score,
    reason: candidate.reason || '',
  };
}

function confidenceFromCandidate(candidate) {
  if (!candidate) return '';
  if (candidate.score >= 90) return 'matcher-high';
  if (candidate.score >= 70) return 'matcher';
  return 'review';
}

function findFieldLabelIndex(lines, field) {
  return lines.findIndex((line) => lineHasFieldLabel(line, field));
}

function isProductSearchBoundary(line) {
  const text = compactText(line);
  return /^(备注[:：]?.*|特别约定[:：]?|本栏空白|合计(?:（大写）)?.*|服务人员(?:编号|姓名)[:：]?.*|区部组[:：]?.*|以下内容空白|保险业务|收据专用章|收据说明[:：]?|保险单说明[:：]?|保单制作日期[:：]?.*|保险公司签章|业务员[:：].*|第\d+页共\d+页|\*此码仅.*)$/.test(
    text,
  );
}

function scoreProductName(value, { source = '' } = {}) {
  const text = compactText(value);
  let score = 20;
  if (/险|保险|寿险|年金|医疗|重疾|疾病|护理|意外/.test(text)) score += 35;
  if (isProductDescriptorLine(text)) score += 15;
  if (/（[^）]+）|\([^)]*\)/.test(text)) score += 12;
  if (/benefit-table-combined/.test(source)) score += 60;
  if (/benefit-table-stem/.test(source)) score += 30;
  if (text.length >= 8) score += 8;
  return score;
}

function findBenefitTableProductStem(lines, company = '') {
  const labelIndex = findFieldLabelIndex(lines, 'name');
  if (labelIndex < 0) return null;
  const source = lines.slice(labelIndex + 1, labelIndex + 80);
  for (let offset = 0; offset < source.length; offset += 1) {
    const line = compactText(source[offset]);
    if (isBenefitTableHeaderLine(line)) continue;
    if (isProductSearchBoundary(line)) break;
    if (isProductDescriptorLine(line)) continue;
    if (isProductNameNoiseLine(line, company)) continue;
    const normalized = normalizeProductNameText(line);
    if (normalized) {
      return {
        value: normalized,
        lineIndex: labelIndex + 1 + offset,
      };
    }
  }
  return null;
}

function findProductDescriptorAfter(lines, startIndex) {
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 18); index += 1) {
    const line = compactText(lines[index]);
    if (isProductSearchBoundary(line)) break;
    if (isProductDescriptorLine(line)) return { value: line, lineIndex: index };
  }
  return null;
}

function addProductNameCandidates({ candidates, lines, company }) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = compactText(lines[index]);
    if (looksLikeCompanyLogoLine(line, company)) {
      addCandidate(candidates, createCandidate({
        field: 'name',
        value: line,
        score: -100,
        lineIndex: index,
        source: 'logo-noise',
        reason: 'company logo/header OCR noise',
        rejected: true,
      }));
    }
  }

  for (let index = 0; index < lines.length; index += 1) {
    const matched = cleanupFieldText(lines[index]).match(/投保主险[:：]?\s*(.+?[（(]\d{3,5}[）)])/u);
    const value = normalizeProductNameText(matched?.[1] || '');
    if (!value) continue;
    addCandidate(candidates, createCandidate({
      field: 'name',
      value,
      score: 160,
      lineIndex: index,
      source: 'labeled-main-plan-row',
      reason: 'explicit 投保主险 row',
    }));
  }

  const stem = findBenefitTableProductStem(lines, company);
  if (!stem) return;

  addCandidate(candidates, createCandidate({
    field: 'name',
    value: stem.value,
    score: scoreProductName(stem.value, { source: 'benefit-table-stem' }),
    lineIndex: stem.lineIndex,
    source: 'benefit-table-stem',
    reason: 'product stem below policy benefit table name header',
  }));

  const descriptor = findProductDescriptorAfter(lines, stem.lineIndex);
  if (descriptor) {
    const combined = normalizeProductNameText(`${stem.value}${descriptor.value}`);
    addCandidate(candidates, createCandidate({
      field: 'name',
      value: combined,
      score: scoreProductName(combined, { source: 'benefit-table-combined' }),
      lineIndex: stem.lineIndex,
      source: 'benefit-table-combined',
      reason: 'product stem combined with insurance product type descriptor',
    }));
  }
}

function addDurationCandidates({ candidates, lines }) {
  for (let index = 0; index < lines.length; index += 1) {
    const line = compactText(lines[index]);
    const coverage = normalizeCoveragePeriodText(line);
    if (coverage && !isProductDescriptorLine(line)) {
      addCandidate(candidates, createCandidate({
        field: 'coveragePeriod',
        value: coverage,
        score: line === '终身' ? 80 : 60,
        lineIndex: index,
        source: 'duration-line',
      }));
    }

    const paymentMode = normalizePaymentModeText(line);
    if (paymentMode) {
      addCandidate(candidates, createCandidate({
        field: 'paymentMode',
        value: paymentMode,
        score: 80,
        lineIndex: index,
        source: 'payment-mode-line',
      }));
    }

    const paymentPeriod = normalizePaymentPeriodText(line);
    if (paymentPeriod) {
      addCandidate(candidates, createCandidate({
        field: 'paymentPeriod',
        value: paymentPeriod,
        score: /^\d+年$/.test(paymentPeriod) ? 85 : 50,
        lineIndex: index,
        source: 'payment-period-line',
      }));
    }
  }
}

function addMoneyCandidatesFromBenefitTable({ candidates, lines, company }) {
  const hasBenefitAmountHeader = lines.some((line) => /基本保险金额|保险金额\/?保险金额|保障计划\/份数/u.test(compactText(line)));
  if (!hasBenefitAmountHeader) return;
  const stem = findBenefitTableProductStem(lines, company);
  if (!stem) return;

  for (let index = stem.lineIndex + 1; index < Math.min(lines.length, stem.lineIndex + 16); index += 1) {
    const line = compactText(lines[index]);
    if (isProductSearchBoundary(line)) break;
    const amount = normalizeAmountText(line);
    if (!amount) continue;
    if (/^每年/.test(line)) {
      addCandidate(candidates, createCandidate({
        field: 'firstPremium',
        value: amount,
        score: 90,
        lineIndex: index,
        source: 'benefit-table-annual-premium',
      }));
      continue;
    }
    addCandidate(candidates, createCandidate({
      field: 'amount',
      value: amount,
      score: 85,
      lineIndex: index,
      source: 'benefit-table-basic-amount',
    }));
  }

  const premiumLabelIndex = lines.findIndex((line) => /首期保险费合计/u.test(cleanupFieldText(line)));
  if (premiumLabelIndex >= 0) {
    for (let index = premiumLabelIndex + 1; index < Math.min(lines.length, premiumLabelIndex + 4); index += 1) {
      const premium = normalizeAmountText(lines[index]);
      if (!premium) continue;
      addCandidate(candidates, createCandidate({
        field: 'firstPremium',
        value: premium,
        score: 70,
        lineIndex: index,
        source: 'first-premium-total',
      }));
      break;
    }
  }
}

function isPlaceholderPlanValue(line) {
  const text = compactText(line);
  return !text || /^[-—－一]+$/.test(text);
}

function isBenefitTablePlanBoundary(line) {
  const text = compactText(line);
  return /^(保险责任名称(?:（接第\d+页）|\(接第\d+页\))?|金额\/?份数|给付标准|免赔额(?:赔付比例)?|赔付比例|首期保险费合计[:：]?|首期保费合计[:：]?|保险费合计[:：]?|(?:（大写）|大写).*|合计(?:（大写）)?.*|备注[:：]?.*|服务人员(?:编号|姓名)[:：]?.*|区部组[:：]?.*|以下内容空白|保险业务|收据专用章|收据说明[:：]?|特别约定[:：]?|保险单说明[:：]?|保单制作日期[:：]?.*|保险公司签章|第\d+页共\d+页)/u.test(
    text,
  );
}

function isPlanDetailSkippableLine(line) {
  const text = compactText(line);
  return /^(?:首期保险费合计|首期保费合计|保险费合计|合计(?:（大写）)?|(?:（大写）|大写)|可选责任的约定|可选责任)/u.test(text);
}

function isDateLikePlanValue(line) {
  return /^(?:\/)?(?:每年)?\d{1,2}月\d{1,2}日$|^(?:\/)?20\d{2}年\d{1,2}月\d{1,2}日$|^每年\d{1,2}月\d{1,2}日$/u.test(
    compactText(line),
  );
}

function isPlanNameContinuation(line, currentName = '') {
  const text = compactText(line);
  if (!text || isPlaceholderPlanValue(text) || isBenefitTableHeaderLine(text) || isBenefitTablePlanBoundary(text)) return false;
  if (/^（[^）]+）$/u.test(text) || /^\([^)]*\)$/u.test(text)) return true;
  if (/^(保险|寿险|年金保险|两全保险|医疗保险|意外伤害保险|疾病保险|重大疾病保险|重疾保险|护理保险)(?:（[^）]+）|\([^)]*\))?$/u.test(text)) {
    return true;
  }
  if (isProductDescriptorLine(text)) return true;
  if (!/(保险|寿险|年金保险|两全保险|医疗保险|意外伤害保险|疾病保险|重大疾病保险|重疾保险|护理保险)/u.test(currentName)) {
    return /(?:保险|寿险|年金|两全|医疗|意外|疾病|护理)(?:（[^）]+）|\([^)]*\))?$/u.test(text);
  }
  return false;
}

function isPlanFieldValue(line) {
  const text = compactText(line);
  if (!text || isPlaceholderPlanValue(text)) return true;
  if (normalizeAmountText(text)) return true;
  if (normalizePaymentModeText(text)) return true;
  if (normalizePaymentPeriodText(text)) return true;
  if (normalizeCoveragePeriodText(text)) return true;
  if (isDateLikePlanValue(text)) return true;
  return false;
}

function isPotentialPlanNameLine(line, company = '') {
  const text = compactText(line);
  if (!text) return false;
  if (isBenefitTableHeaderLine(text) || isBenefitTablePlanBoundary(text)) return false;
  if (inlineLabeledPlanName(text)) return true;
  if (isProductNameNoiseLine(text, company)) return false;
  if (isProductDescriptorLine(text)) return false;
  if (isPlanFieldValue(text)) return false;
  return /[一-龥A-Za-z]/u.test(text);
}

function normalizePlanPaymentPeriod(paymentPeriod, paymentMode) {
  const period = compactText(paymentPeriod).replace(/^\/+/, '');
  const mode = normalizePaymentModeText(paymentMode) || compactText(paymentMode);
  if (mode === '趸交') return '趸交';
  if (/^\d{1,3}年$/u.test(period) && mode === '年交') return `${period}交`;
  if (/^\d{1,3}年$/u.test(period) && mode && mode !== '年交') return `${period}${mode}`;
  if (/^\d{1,3}年交$/u.test(period)) return period;
  return period || mode || '';
}

function isStandaloneParentheticalDescriptor(line) {
  return /^（[^）]+）$|^\([^)]*\)$/u.test(compactText(line));
}

function isPlanTailDescriptor(line) {
  const text = compactText(line);
  return isStandaloneParentheticalDescriptor(text) || /^保险(?:（[^）]+）|\([^)]*\))$/u.test(text);
}

function normalizePlanNameWithTailDescriptor(name, descriptor) {
  const descriptorText = compactText(descriptor);
  if (!descriptorText) return normalizePlanName([name]);
  if (/^保险(?:（[^）]+）|\([^)]*\))$/u.test(descriptorText) && /险|保险|寿险/u.test(compactText(name))) {
    return normalizePlanName([name, descriptorText.replace(/^保险/u, '')]);
  }
  return normalizePlanName([name, descriptorText]);
}

function isOcrRemarkLine(line) {
  const text = compactText(line);
  if (/^[年月日。，、.]+$/u.test(text)) return true;
  return /^(备注|[一二三四五六七八九十\d]+[.、．]|特别约定|保险单说明)/u.test(text);
}

function inferPlanRole(plan, index) {
  const text = compactText(`${plan.name} ${plan.productType}`);
  if (/万能型|万能账户|最低保证利率|账户价值/u.test(text)) return 'linked_account';
  if (/附加/u.test(text)) return 'rider';
  return index === 0 ? 'main' : 'rider';
}

function inferPlanProductType(name) {
  const text = compactText(name);
  if (/万能型|万能账户|万能险|最低保证利率|账户价值/u.test(text)) return '万能账户';
  if (/投资连结|投连/u.test(text)) return '投连险';
  if (/重大疾病|重疾/u.test(text)) return '重疾险';
  if (/医疗/u.test(text)) return '医疗险';
  if (/意外/u.test(text)) return '意外险';
  if (/护理/u.test(text)) return '护理险';
  if (/两全/u.test(text)) return '两全保险';
  if (/年金|养老金|养老/u.test(text)) return '年金险';
  if (/终身寿|寿险/u.test(text)) return '增额终身寿险';
  return '';
}

function normalizePlanName(parts = []) {
  const text = parts.map((part) => compactText(part)).filter(Boolean).join('');
  return normalizeProductNameText(text);
}

function normalizeLabeledAmountBeforeNextLabel(line, labelPattern, stopLabels) {
  const text = compactText(line);
  const matched = text.match(new RegExp(`(?:${labelPattern})[:：]?(.+?)(?=(?:${stopLabels})[:：]?|$)`, 'u'));
  return normalizeAmountText(matched?.[1] || '');
}

function normalizePlanAmountLine(line) {
  return normalizeLabeledAmountBeforeNextLabel(
    line,
    '基本保险金额|保险金额|保额',
    '保险期间|保障期间|保险期限|保障期限|交费方式|缴费方式|交费期间|缴费期间|保险费|保费|首期|合计',
  );
}

function normalizePlanPremiumLine(line) {
  return normalizeLabeledAmountBeforeNextLabel(
    line,
    '保险费|保费|总保费|首期|首年',
    '交费方式|缴费方式|交费期间|缴费期间|保险期间|保障期间|保险期限|保障期限|保险金额|基本保险金额|保额|合计',
  );
}

function inlineLabeledPlanName(line) {
  const text = compactText(line);
  if (!text || !lineHasFieldLabel(text, 'name')) return '';
  const name = normalizeProductNameText(text);
  if (!name || name === text) return '';
  if (isBenefitTableHeaderLine(name) || isProductNameNoiseLine(name)) return '';
  return name;
}

function findInlineLabeledPlanName(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!lineHasFieldLabel(lines[index], 'name')) continue;
    const name = inlineLabeledPlanName(lines[index]);
    if (!name) continue;
    return {
      name,
      lineIndex: index,
    };
  }
  return null;
}

function hasInlineSinglePlanSummaryHeaders(lines, startIndex) {
  const window = lines
    .slice(startIndex + 1, startIndex + 24)
    .map((line) => compactText(line))
    .filter(Boolean);
  const joined = window.join('');
  return (/子险种名称/u.test(joined) || window.some((line) => /^子险种名称$/u.test(line)))
    && (/标准保费/u.test(joined) || window.some((line) => /^标准保费/u.test(line)))
    && (/保险金额/u.test(joined) || window.some((line) => /^保险金额/u.test(line)));
}

function extractInlineSinglePlanSummary(lines, company = '') {
  const inlinePlan = findInlineLabeledPlanName(lines);
  if (!inlinePlan?.name) return null;
  if (!hasInlineSinglePlanSummaryHeaders(lines, inlinePlan.lineIndex)) return null;

  const summaryNameIndex = lines.findIndex((line, index) => (
    index > inlinePlan.lineIndex
    && compactText(line) === compactText(inlinePlan.name)
  ));
  if (summaryNameIndex < 0) return null;

  let coveragePeriod = '';
  let coverageLineIndex = -1;
  let paymentMode = '';
  let paymentModeLineIndex = -1;
  let rawPaymentPeriod = '';
  let paymentPeriodLineIndex = -1;

  for (let index = inlinePlan.lineIndex + 1; index < summaryNameIndex; index += 1) {
    const line = compactText(lines[index]);
    if (!line) continue;
    if (!coveragePeriod) {
      const matchedCoverage = normalizeCoveragePeriodText(line);
      if (matchedCoverage) {
        coveragePeriod = matchedCoverage;
        coverageLineIndex = index;
      }
    }
    if (!paymentMode) {
      const matchedMode = normalizePaymentModeText(line);
      if (matchedMode) {
        paymentMode = matchedMode;
        paymentModeLineIndex = index;
      }
    }
    if (!rawPaymentPeriod) {
      const matchedPeriod = normalizePaymentPeriodText(line);
      if (matchedPeriod) {
        rawPaymentPeriod = matchedPeriod;
        paymentPeriodLineIndex = index;
      }
    }
  }

  const numericRows = [];
  for (let index = summaryNameIndex + 1; index < Math.min(lines.length, summaryNameIndex + 8); index += 1) {
    const line = compactText(lines[index]);
    if (!line) continue;
    if (isBenefitTablePlanBoundary(line)) break;
    const amount = normalizeAmountText(line);
    if (!amount) {
      if (numericRows.length) break;
      continue;
    }
    numericRows.push({
      amount,
      line,
      lineIndex: index,
    });
  }
  if (!numericRows.length) return null;

  const premiumRow = numericRows[1] || null;
  return {
    company,
    role: '',
    name: inlinePlan.name,
    productType: inferPlanProductType(inlinePlan.name),
    amount: numericRows[0]?.amount || '',
    amountLineIndex: numericRows[0]?.lineIndex ?? -1,
    coveragePeriod,
    coverageLineIndex,
    paymentMode,
    paymentModeLineIndex,
    rawPaymentPeriod,
    paymentPeriod: normalizePlanPaymentPeriod(rawPaymentPeriod, paymentMode),
    paymentPeriodLineIndex,
    premium: premiumRow?.amount || '',
    premiumText: premiumRow?.line || '',
    premiumLineIndex: premiumRow?.lineIndex ?? -1,
  };
}

function extractReceiptProductName(line) {
  const text = compactText(line);
  const matched = text.match(/^产品名称[:：]?(.+)$/u);
  if (!matched?.[1]) return '';
  return normalizePlanName([matched[1]]);
}

function isReceiptProductPremiumLine(line) {
  return /^金额[¥￥]?\d/u.test(compactText(line));
}

function extractReceiptPolicyPlans(lines, company = '') {
  const productRows = [];
  for (let index = 0; index < lines.length; index += 1) {
    let name = extractReceiptProductName(lines[index]);
    if (!name) continue;
    const nextLine = compactText(lines[index + 1] || '');
    if (isProductDescriptorLine(nextLine) && !compactText(name).includes(nextLine)) {
      name = normalizePlanName([name, nextLine]);
    }
    productRows.push({ name, index });
  }
  if (!productRows.length) return [];

  const premiumLines = [];
  for (let index = productRows[0].index + 1; index < lines.length; index += 1) {
    const line = compactText(lines[index]);
    if (!line) continue;
    if (isBenefitTablePlanBoundary(line)) break;
    if (!isReceiptProductPremiumLine(line)) continue;
    premiumLines.push({ line, index });
  }

  return productRows.map((row, index) => {
    const premiumLine = premiumLines[index]?.line || '';
    return {
      company,
      role: '',
      name: row.name,
      productType: inferPlanProductType(row.name),
      amount: '',
      coveragePeriod: '',
      paymentMode: '',
      paymentPeriod: '',
      premium: normalizeAmountText(premiumLine),
      premiumText: premiumLine,
    };
  });
}

function isAppPlanSummaryHeader(line) {
  const text = compactText(line);
  return /险种名称/u.test(text)
    && /(?:标准保费|保费)/u.test(text)
    && /(?:基本保额|基本保险金额|保险金额)/u.test(text)
    && /(?:交费期间|缴费期间)/u.test(text)
    && /(?:保险期间|保障期间)/u.test(text);
}

function findAppPlanSummaryHeaderRange(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (isAppPlanSummaryHeader(lines[index])) return { startIndex: index, endIndex: index };
    let windowText = '';
    for (let endIndex = index; endIndex < Math.min(lines.length, index + 8); endIndex += 1) {
      windowText += compactText(lines[endIndex]);
      if (isAppPlanSummaryHeader(windowText)) return { startIndex: index, endIndex };
    }
  }
  return null;
}

function normalizeAppPlanName(rawName) {
  const text = compactText(rawName)
    .replace(/^\d{2,4}/u, '')
    .trim()
    .replace(/^V\d+(?:\.\d+)?/iu, '')
    .trim();
  return normalizePlanName([text]) || (/(?:保险|寿险|年金|医疗|意外|疾病|护理)/u.test(text) ? text : '');
}

function parseAppPlanPeriods(value) {
  const text = compactText(value);
  const paymentModeToken = text.match(/一次性交清|一次交清|一次性交费|一次性缴清|趸交|年交|年缴|月交|月缴|季交|季缴|半年交|半年缴/u)?.[0] || '';
  const paymentMode = normalizePaymentModeText(paymentModeToken);
  const remainder = paymentModeToken ? text.replace(paymentModeToken, '') : text;
  const rawPaymentPeriod = paymentMode === '趸交'
    ? ''
    : normalizePaymentPeriodText(text.match(/\d{1,3}年(?=\s*(?:交|缴|终身|$))/u)?.[0] || '');
  const effectivePaymentMode = paymentMode || (rawPaymentPeriod ? '年交' : '');
  const coveragePeriod = text.includes('终身')
    ? '终身'
    : /^\d{1,3}年$/u.test(remainder)
      ? remainder
    : normalizeCoveragePeriodText(remainder) || normalizeCoveragePeriodText(text);
  return {
    coveragePeriod,
    paymentMode: effectivePaymentMode,
    paymentPeriod: normalizePlanPaymentPeriod(rawPaymentPeriod, effectivePaymentMode),
  };
}

function normalizeAppPlanSummaryRowText(line) {
  let text = cleanupFieldText(line)
    .replace(/\s+/gu, ' ')
    .trim();
  for (let iteration = 0; iteration < 3; iteration += 1) {
    text = text
      .replace(/(\d[\d,，]*)\s+(\d{1,3}\.\d{2}\s*(?:元|圆))/gu, '$1$2')
      .replace(/(\d+\.)\s+(\d{1,2}\s*(?:元|圆))/gu, '$1$2')
      .replace(/(\d+\.\d)\s+(\d\s*(?:元|圆))/gu, '$1$2');
  }
  return text;
}

function parseAppPlanSummaryRow(line, company = '') {
  const raw = normalizeAppPlanSummaryRowText(line);
  const amountMatches = [...raw.matchAll(/[¥￥]?\d[\d,，]*(?:\.\d+)?\s*(?:元|圆)/gu)];
  if (amountMatches.length < 2) return null;

  const name = normalizeAppPlanName(raw.slice(0, amountMatches[0].index));
  if (!name) return null;

  const periods = parseAppPlanPeriods(raw.slice(amountMatches[1].index + amountMatches[1][0].length));
  return {
    company,
    role: '',
    name,
    productType: inferPlanProductType(name),
    amount: normalizeAmountText(amountMatches[1][0]),
    coveragePeriod: periods.coveragePeriod,
    paymentMode: periods.paymentMode,
    paymentPeriod: periods.paymentPeriod,
    premium: normalizeAmountText(amountMatches[0][0]),
    premiumText: compactText(amountMatches[0][0]),
  };
}

function isAppPlanSummaryBoundary(line) {
  return /^(?:投保人|被保险人|受益人|特别约定|保单详情|手机号码|手机号码|客户信息|家庭信息|保障信息)/u.test(compactText(line));
}

function isAppPlanSummaryRowStart(line) {
  const text = compactText(line);
  if (/^\d{1,3}年(?:交|缴)?$/u.test(text)) return false;
  return /^\d{2,4}(?:\s|[A-Za-z]|[\u4e00-\u9fff])/u.test(text)
    && !/^\d{4}[-/年]\d{1,2}/u.test(text)
    && !/^\d+(?:\.\d+)?(?:元|圆)$/u.test(text);
}

function extractAppPlanSummaryPlans(lines, company = '') {
  const headerRange = findAppPlanSummaryHeaderRange(lines);
  if (!headerRange) return [];

  const plans = [];
  let rowBuffer = [];
  const flushRowBuffer = () => {
    if (!rowBuffer.length) return;
    const plan = parseAppPlanSummaryRow(rowBuffer.join(' '), company);
    if (plan) plans.push(plan);
    rowBuffer = [];
  };

  for (let index = headerRange.endIndex + 1; index < Math.min(lines.length, headerRange.endIndex + 80); index += 1) {
    const line = compactText(lines[index]);
    if (!line) continue;
    if (isAppPlanSummaryBoundary(line)) break;
    if (isAppPlanSummaryHeader(line) || /可左滑列表查看更多信息/u.test(line)) continue;
    if (isAppPlanSummaryRowStart(line)) {
      flushRowBuffer();
      rowBuffer = [lines[index]];
      continue;
    }
    if (rowBuffer.length) rowBuffer.push(lines[index]);
  }
  flushRowBuffer();
  return plans;
}

function labeledPlanValue(line, labelPattern) {
  const text = compactText(line);
  const matched = text.match(new RegExp(`^(?:${labelPattern})[:：]?(.+)$`, 'u'));
  return compactText(matched?.[1] || '');
}

function normalizeChinaLifeCoveragePeriod(line) {
  const value = labeledPlanValue(line, '保险期[间问]|保障期[间问]');
  return normalizeCoveragePeriodText(value || line);
}

function normalizeChinaLifePaymentMode(line) {
  const value = labeledPlanValue(line, '[交文缴]费方式');
  const normalized = normalizePaymentModeText(value || line);
  if (normalized) return normalized;
  if (/不定期/u.test(value)) return '不定期交';
  return '';
}

function normalizeChinaLifePaymentPeriod(line, paymentMode = '') {
  const value = labeledPlanValue(line, '[交文缴]费期间');
  const period = normalizePaymentPeriodText(value || line);
  if (period) return normalizePlanPaymentPeriod(period, paymentMode || '年交');
  if (/不定期/u.test(value || line)) return '不定期交';
  return '';
}

function findChinaLifeSectionTableValues(sectionLines) {
  let searchStart = 0;
  for (let index = 0; index < sectionLines.length; index += 1) {
    const line = compactText(sectionLines[index]);
    if (/^子险种名称$/u.test(line)) {
      searchStart = index + 1;
      break;
    }
    if (line === '子' && compactText(sectionLines[index + 1]) === '险种名称') {
      searchStart = index + 2;
      break;
    }
  }
  const valueLines = sectionLines.slice(searchStart).map((line) => compactText(line)).filter(Boolean);
  const productIndex = valueLines.findIndex((line) => (
    normalizeProductNameText(line)
    && /险|保险|年金|两全|寿|账户/u.test(line)
    && !isBenefitTableHeaderLine(line)
    && !/^(?:保险金额|标准保费|加费)/u.test(line)
  ));
  if (productIndex < 0) return { amount: '', premium: '' };
  const amounts = [];
  for (const line of valueLines.slice(productIndex + 1)) {
    const amount = normalizeAmountText(line);
    if (amount) {
      amounts.push(amount);
      continue;
    }
    if (isBenefitTablePlanBoundary(line) || isProductNameNoiseLine(line)) break;
    if (amounts.length) break;
  }
  return {
    amount: amounts[0] || '',
    premium: amounts[1] || '',
  };
}

function extractChinaLifeDetailPlans(lines, company = '') {
  const hasMainDetailSection = lines.some((line) => /主险明细/u.test(compactText(line)));
  if (!hasMainDetailSection) return [];

  const sectionStarts = [];
  for (let index = 0; index < lines.length; index += 1) {
    const name = labeledPlanValue(lines[index], '险种名称');
    if (normalizeProductNameText(name)) sectionStarts.push(index);
  }
  if (!sectionStarts.length) return [];

  return sectionStarts
    .map((startIndex, sectionIndex) => {
      const nextStart = sectionStarts.find((index) => index > startIndex) ?? lines.length;
      const sectionLines = lines.slice(startIndex, nextStart);
      const name = normalizeProductNameText(labeledPlanValue(sectionLines[0], '险种名称'));
      if (!name) return null;

      let coveragePeriod = '';
      let paymentMode = '';
      let paymentPeriod = '';
      for (const line of sectionLines) {
        if (!coveragePeriod) coveragePeriod = normalizeChinaLifeCoveragePeriod(line);
        if (!paymentMode) paymentMode = normalizeChinaLifePaymentMode(line);
        if (!paymentPeriod) paymentPeriod = normalizeChinaLifePaymentPeriod(line, paymentMode);
      }
      const values = findChinaLifeSectionTableValues(sectionLines);
      return {
        company,
        role: inferPlanRole({ name }, sectionIndex),
        name,
        productType: inferPlanProductType(name),
        amount: values.amount,
        coveragePeriod,
        paymentMode,
        paymentPeriod,
        premium: values.premium,
        premiumText: values.premium,
      };
    })
    .filter(Boolean);
}

function addCandidatesFromInlineSinglePlanSummary({ candidates, lines, company }) {
  const plan = extractInlineSinglePlanSummary(lines, company);
  if (!plan) return;

  addCandidate(candidates, createCandidate({
    field: 'name',
    value: plan.name,
    score: scoreProductName(plan.name, { source: 'inline-single-plan-summary' }) + 30,
    lineIndex: plan.amountLineIndex >= 0 ? plan.amountLineIndex : 0,
    source: 'inline-single-plan-summary',
    reason: 'inline plan name with a single-plan summary table',
  }));

  if (plan.coveragePeriod) {
    addCandidate(candidates, createCandidate({
      field: 'coveragePeriod',
      value: plan.coveragePeriod,
      score: 85,
      lineIndex: plan.coverageLineIndex,
      source: 'inline-single-plan-summary',
    }));
  }

  if (plan.paymentMode) {
    addCandidate(candidates, createCandidate({
      field: 'paymentMode',
      value: plan.paymentMode,
      score: 85,
      lineIndex: plan.paymentModeLineIndex,
      source: 'inline-single-plan-summary',
    }));
  }

  if (plan.rawPaymentPeriod) {
    addCandidate(candidates, createCandidate({
      field: 'paymentPeriod',
      value: plan.rawPaymentPeriod,
      score: 90,
      lineIndex: plan.paymentPeriodLineIndex,
      source: 'inline-single-plan-summary',
    }));
  }

  if (plan.amount) {
    addCandidate(candidates, createCandidate({
      field: 'amount',
      value: plan.amount,
      score: 90,
      lineIndex: plan.amountLineIndex,
      source: 'inline-single-plan-summary',
    }));
  }

  if (plan.premium) {
    addCandidate(candidates, createCandidate({
      field: 'firstPremium',
      value: plan.premium,
      score: 90,
      lineIndex: plan.premiumLineIndex,
      source: 'inline-single-plan-summary',
    }));
  }
}

function readPlanName(source, startIndex, company) {
  const parts = [inlineLabeledPlanName(source[startIndex]) || source[startIndex]];
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < Math.min(source.length, startIndex + 5); index += 1) {
    const line = source[index];
    if (isPlanNameContinuation(line, parts.join(''))) {
      parts.push(line);
      endIndex = index;
      continue;
    }
    break;
  }
  return {
    name: normalizePlanName(parts),
    endIndex,
  };
}

function pickLastAmountBefore(source, endIndex, predicate) {
  for (let index = endIndex; index >= 0; index -= 1) {
    const line = compactText(source[index]);
    if (predicate && !predicate(line, index)) continue;
    const amount = normalizeAmountText(line);
    if (amount) return { amount, line, index };
  }
  return null;
}

function pickFirstAmountBetween(source, startIndex, endIndex, predicate) {
  for (let index = Math.max(0, startIndex); index < Math.min(source.length, endIndex); index += 1) {
    const line = compactText(source[index]);
    if (predicate && !predicate(line, index)) continue;
    const amount = normalizeAmountText(line);
    if (amount) return { amount, line, index };
  }
  return null;
}

function collectLeadingBenefitTablePlanNames(source, company) {
  const names = [];
  let index = 0;
  for (; index < source.length; index += 1) {
    const line = compactText(source[index]);
    if (!line || isBenefitTableHeaderLine(line)) continue;
    if (isBenefitTablePlanBoundary(line)) break;
    if (isPlanFieldValue(line)) break;
    if (!isPotentialPlanNameLine(line, company)) continue;

    const nameInfo = readPlanName(source, index, company);
    if (nameInfo.name) {
      names.push({
        name: nameInfo.name,
        startIndex: index,
        endIndex: nameInfo.endIndex,
      });
      index = nameInfo.endIndex;
    }
  }
  return {
    names,
    valueStartIndex: names.length ? names[names.length - 1].endIndex + 1 : index,
  };
}

function takePlanColumnGroup(values, startIndex, count, predicate) {
  const group = [];
  let index = startIndex;
  for (; index < values.length && group.length < count; index += 1) {
    const line = compactText(values[index]);
    if (predicate(line) || isPlaceholderPlanValue(line)) {
      group.push(line);
      continue;
    }
    if (group.length) break;
  }
  while (group.length < count) group.push('');
  return { group, nextIndex: index };
}

function isBasicAmountColumnValue(line) {
  const text = compactText(line);
  if (!normalizeAmountText(text)) return false;
  return !/^(每年|首期|首年|合计|¥|￥)/u.test(text);
}

function columnGroupValue(group, index) {
  return compactText(Array.isArray(group) ? group[index] || '' : '');
}

function normalizePlanCoveragePeriod(line) {
  return normalizeCoveragePeriodText(compactText(line).replace(/(?:一次交清|趸交|年交|月交|季交|半年交)$/u, ''));
}

function scorePlanCompleteness(plans = []) {
  return (Array.isArray(plans) ? plans : []).reduce((score, plan) => {
    if (plan?.name) score += 2;
    for (const key of ['amount', 'coveragePeriod', 'paymentMode', 'paymentPeriod', 'premium']) {
      if (plan?.[key]) score += 1;
    }
    return score;
  }, 0);
}

function reconstructColumnOrderedBenefitTablePlans(source, company) {
  const { names, valueStartIndex } = collectLeadingBenefitTablePlanNames(source, company);
  if (names.length < 2) return [];

  const boundaryIndex = source.findIndex((line, index) => index >= valueStartIndex && isBenefitTablePlanBoundary(line));
  const values = source
    .slice(valueStartIndex, boundaryIndex >= 0 ? boundaryIndex : source.length)
    .map((line) => compactText(line))
    .filter(Boolean);
  if (!values.length) return [];

  const count = names.length;
  const amountResult = takePlanColumnGroup(values, 0, count, isBasicAmountColumnValue);
  const coverageResult = takePlanColumnGroup(
    values,
    amountResult.nextIndex,
    count,
    (line) => Boolean(normalizeCoveragePeriodText(line)),
  );
  const paymentModeResult = takePlanColumnGroup(
    values,
    coverageResult.nextIndex,
    count,
    (line) => Boolean(normalizePaymentModeText(line)),
  );
  const paymentPeriodResult = takePlanColumnGroup(
    values,
    paymentModeResult.nextIndex,
    count,
    (line) => Boolean(normalizePaymentPeriodText(line)),
  );
  const premiumLines = values
    .slice(paymentPeriodResult.nextIndex)
    .filter((line) => normalizeAmountText(line))
    .slice(-count);

  const plans = names.map((item, index) => {
    const paymentMode = normalizePaymentModeText(columnGroupValue(paymentModeResult.group, index));
    const rawPaymentPeriod = normalizePaymentPeriodText(columnGroupValue(paymentPeriodResult.group, index));
    return {
      company,
      role: '',
      name: item.name,
      productType: inferPlanProductType(item.name),
      amount: normalizeAmountText(columnGroupValue(amountResult.group, index)),
      coveragePeriod: normalizeCoveragePeriodText(columnGroupValue(coverageResult.group, index)),
      paymentMode,
      paymentPeriod: normalizePlanPaymentPeriod(rawPaymentPeriod, paymentMode),
      premium: normalizeAmountText(columnGroupValue(premiumLines, index)),
      premiumText: columnGroupValue(premiumLines, index),
    };
  });

  return scorePlanCompleteness(plans) > names.length * 2 ? plans : [];
}

function fillValueFirstBenefitTablePlans(plans, source) {
  const repaired = (Array.isArray(plans) ? plans : []).map((plan) => ({ ...plan }));
  if (repaired.length < 2) return repaired;
  if (repaired.every((plan) => plan.name && plan.amount && plan.coveragePeriod && plan.paymentMode && plan.paymentPeriod && plan.premium)) {
    return repaired;
  }

  const targetFirstName = compactText(repaired[0]?.name || '');
  const firstNameIndex = source.findIndex((_line, index) => compactText(readPlanName(source, index, '').name) === targetFirstName);
  if (firstNameIndex < 0) return repaired;

  const amountLines = source
    .slice(0, firstNameIndex)
    .map((line) => compactText(line))
    .filter(isBasicAmountColumnValue)
    .slice(-repaired.length);
  amountLines.forEach((line, index) => {
    if (repaired[index]) repaired[index].amount = normalizeAmountText(line) || repaired[index].amount;
  });

  const boundaryIndex = source.findIndex((line, index) => index > firstNameIndex && isBenefitTablePlanBoundary(line));
  const valueLines = source
    .slice(boundaryIndex >= 0 ? boundaryIndex + 1 : firstNameIndex + 1)
    .map((line) => compactText(line))
    .filter(Boolean);
  const totalPremiumIndex = valueLines.findIndex((line, index) => (
    /^首期(?:保险费|保费)?合计/u.test(line)
    || (/^首期$/u.test(line) && /^保险费合计/u.test(valueLines[index + 1] || ''))
  ));
  const detailLines = totalPremiumIndex >= 0 ? valueLines.slice(0, totalPremiumIndex) : valueLines;
  const premiumCandidateLines = [];
  let sawPremiumHeader = totalPremiumIndex < 0;
  const premiumScanStart = totalPremiumIndex >= 0
    && /^首期$/u.test(valueLines[totalPremiumIndex] || '')
    && /^保险费合计/u.test(valueLines[totalPremiumIndex + 1] || '')
    ? totalPremiumIndex + 2
    : totalPremiumIndex + 1;
  for (const line of totalPremiumIndex >= 0 ? valueLines.slice(premiumScanStart) : valueLines) {
    if (isBenefitTablePlanBoundary(line)) break;
    if (isBenefitTableHeaderLine(line)) {
      if (/保险费/u.test(line)) sawPremiumHeader = true;
      continue;
    }
    if (!sawPremiumHeader) continue;
    if (isPremiumAmountLine(line)) premiumCandidateLines.push(line);
  }
  const premiumLines = premiumCandidateLines
    .slice(0, repaired.length);

  const coverageLines = detailLines.filter((line) => normalizePlanCoveragePeriod(line) && !/^\/?\d{1,3}年$/u.test(line));
  if (coverageLines[0] && !repaired[0].coveragePeriod) repaired[0].coveragePeriod = normalizePlanCoveragePeriod(coverageLines[0]);
  const riderCoverage = coverageLines.find((line, index) => index > 0 || normalizePaymentModeText(line) === '趸交');
  if (riderCoverage && !repaired[1].coveragePeriod) repaired[1].coveragePeriod = normalizePlanCoveragePeriod(riderCoverage);

  if (!repaired[0].paymentMode && detailLines.some((line) => normalizePaymentModeText(line) === '年交')) {
    repaired[0].paymentMode = '年交';
  }
  if (!repaired[0].paymentPeriod) {
    const mainPeriod = detailLines.find((line) => /^\/?\d{1,3}年$/u.test(line));
    if (mainPeriod) repaired[0].paymentPeriod = normalizePlanPaymentPeriod(mainPeriod, repaired[0].paymentMode || '年交');
  }

  const riderPayLine = detailLines.find((line) => normalizePaymentModeText(line) === '趸交' || /一次交清|趸交/u.test(line));
  if (riderPayLine) {
    if (!repaired[1].paymentMode) repaired[1].paymentMode = '趸交';
    if (!repaired[1].paymentPeriod) repaired[1].paymentPeriod = '趸交';
  }

  premiumLines.forEach((line, index) => {
    if (!repaired[index]?.premium) {
      repaired[index].premium = normalizeAmountText(line);
      repaired[index].premiumText = line;
    }
  });

  return repaired;
}

function repairUnorderedBenefitTablePlans(plans, source) {
  const repaired = plans
    .map((plan) => ({ ...plan }))
    .filter((plan) => plan.name && !isStandaloneParentheticalDescriptor(plan.name) && !isOcrRemarkLine(plan.name));

  const findPlanSourceIndex = (plan, afterIndex = -1) => {
    const fullName = compactText(plan?.name || '');
    const baseName = fullName.replace(/（[^）]+）|\([^)]*\)/gu, '');
    if (!baseName) return -1;
    return source.findIndex((line, index) => {
      if (index <= afterIndex) return false;
      const text = compactText(line);
      if (!text || isBenefitTableHeaderLine(text) || isBenefitTablePlanBoundary(text) || isPlanTailDescriptor(text)) return false;
      return text === baseName || baseName.startsWith(text);
    });
  };

  const sourceIndexes = [];
  for (const plan of repaired) {
    const previousIndex = sourceIndexes.length ? sourceIndexes[sourceIndexes.length - 1] : -1;
    sourceIndexes.push(findPlanSourceIndex(plan, previousIndex));
  }

  const findDescriptorIndexAfterPlan = (planIndex) => {
    const startIndex = sourceIndexes[planIndex];
    if (startIndex < 0) return -1;
    const nextPlanIndex = sourceIndexes.find((index, cursor) => cursor > planIndex && index > startIndex) ?? source.length;
    for (let index = startIndex + 1; index < Math.min(source.length, nextPlanIndex); index += 1) {
      const line = compactText(source[index]);
      if (!line) continue;
      if (isBenefitTablePlanBoundary(line)) break;
      if (isPlanTailDescriptor(line)) return index;
    }
    return -1;
  };

  repaired.forEach((plan, index) => {
    const descriptorIndex = findDescriptorIndexAfterPlan(index);
    const descriptor = descriptorIndex >= 0 ? source[descriptorIndex] : '';
    if (!descriptor || compactText(plan.name).includes(compactText(descriptor))) return;
    const combined = normalizePlanNameWithTailDescriptor(plan.name, descriptor);
    if (combined) {
      plan.name = combined;
      plan.productType = inferPlanProductType(combined);
    }
  });

  const firstPlanIndex = sourceIndexes[0] ?? -1;
  if (repaired[0] && !repaired[0].premium && firstPlanIndex > 0) {
    const premium = pickLastAmountBefore(source, firstPlanIndex - 1, (line) => /^每年/u.test(line));
    if (premium) {
      repaired[0].premium = premium.amount;
      repaired[0].premiumText = premium.line;
    }
  }
  if (repaired[0] && !repaired[0].amount && firstPlanIndex > 0) {
    const amount = pickLastAmountBefore(source, firstPlanIndex - 1, isBasicAmountColumnValue);
    if (amount) repaired[0].amount = amount.amount;
  }

  for (let planIndex = 1; planIndex < repaired.length; planIndex += 1) {
    const plan = repaired[planIndex];
    const currentSourceIndex = sourceIndexes[planIndex];
    const previousSourceIndex = sourceIndexes[planIndex - 1];
    if (!plan || currentSourceIndex <= 0 || previousSourceIndex < 0 || previousSourceIndex >= currentSourceIndex) continue;

    const paymentModeLineIndex = source.findLastIndex((line, index) => (
      index > previousSourceIndex
      && index < currentSourceIndex
      && Boolean(normalizePaymentModeText(line))
    ));
    if (paymentModeLineIndex < 0) continue;

    const paymentMode = normalizePaymentModeText(source[paymentModeLineIndex]);
    if (paymentMode && !plan.paymentMode) plan.paymentMode = paymentMode;
    if (paymentMode === '趸交' && !plan.paymentPeriod) plan.paymentPeriod = '趸交';

    if (!plan.premium) {
      const premium = pickLastAmountBefore(source, currentSourceIndex - 1, (line, index) => (
        index > paymentModeLineIndex
        && isPremiumAmountLine(line)
        && !/^每年/u.test(line)
      ));
      if (premium) {
        plan.premium = premium.amount;
        plan.premiumText = premium.line;
      }
    }
  }

  const mainPlan = repaired[0] || null;
  const linkedPlanIndex = repaired.findIndex((plan) => inferPlanRole(plan, 1) === 'linked_account');
  const linkedPlan = linkedPlanIndex >= 0 ? repaired[linkedPlanIndex] : null;
  const linkedNameIndex = linkedPlanIndex >= 0 ? sourceIndexes[linkedPlanIndex] : -1;
  const linkedDescriptorIndex = linkedPlanIndex >= 0 ? findDescriptorIndexAfterPlan(linkedPlanIndex) : -1;

  if (mainPlan && linkedNameIndex > 0) {
    const mainValueEndIndex = linkedDescriptorIndex > linkedNameIndex ? linkedDescriptorIndex : linkedNameIndex;
    const mainAmount = pickFirstAmountBetween(source, firstPlanIndex + 1, mainValueEndIndex, isBasicAmountColumnValue);
    if (mainAmount && !mainPlan.amount) mainPlan.amount = mainAmount.amount;
    if (!mainPlan.paymentMode && source.some((line, index) => index < mainValueEndIndex && normalizePaymentModeText(line) === '年交')) {
      mainPlan.paymentMode = '年交';
    }
    const linkedSinglePayIndex = source.findIndex((line, index) => (
      index > linkedNameIndex
      && index < linkedNameIndex + 12
      && normalizePaymentModeText(line) === '趸交'
    ));
    const linkedPaymentStartIndex = linkedSinglePayIndex >= 0 ? linkedSinglePayIndex : Math.max(linkedDescriptorIndex, linkedNameIndex);
    const trailingMainModeIndex = source.findIndex((line, index) => (
      index > linkedNameIndex
      && index < linkedPaymentStartIndex
      && normalizePaymentModeText(line) === '年交'
    ));
    if (trailingMainModeIndex >= 0 && !mainPlan.paymentMode) mainPlan.paymentMode = '年交';
    if (!mainPlan.paymentPeriod) {
      const paymentPeriodLine = source.find((line, index) => {
        const compact = compactText(line).replace(/^\/+/, '');
        return index < mainValueEndIndex && /^\d{1,3}年$/u.test(compact);
      });
      if (paymentPeriodLine) mainPlan.paymentPeriod = normalizePlanPaymentPeriod(paymentPeriodLine, mainPlan.paymentMode || '年交');
    }
    if (!mainPlan.paymentPeriod && trailingMainModeIndex >= 0) {
      const paymentPeriodLine = source.find((line, index) => {
        const compact = compactText(line).replace(/^\/+/, '');
        return index > trailingMainModeIndex && index < linkedPaymentStartIndex && /^\d{1,3}年$/u.test(compact);
      });
      if (paymentPeriodLine) mainPlan.paymentPeriod = normalizePlanPaymentPeriod(paymentPeriodLine, mainPlan.paymentMode || '年交');
    }
    const premium = pickLastAmountBefore(source, mainValueEndIndex - 1, (line) => /^每年/u.test(line));
    if (premium && (!mainPlan.premium || mainPlan.premium === mainPlan.amount || !/^每年/u.test(compactText(mainPlan.premiumText)))) {
      mainPlan.premium = premium.amount;
      mainPlan.premiumText = premium.line;
    }
  }

  if (linkedPlan) {
    linkedPlan.amount = '';
    if (!linkedPlan.coveragePeriod) linkedPlan.coveragePeriod = '终身';
    const linkedPaymentModeIndex = source.findIndex((line, index) => (
      index > linkedNameIndex
      && index < Math.max(linkedDescriptorIndex, linkedNameIndex + 12)
      && normalizePaymentModeText(line) === '趸交'
    ));
    if (linkedPaymentModeIndex >= 0) {
      linkedPlan.paymentMode = '趸交';
    }
    if (linkedPlan.paymentMode === '趸交') linkedPlan.paymentPeriod = '趸交';
    const linkedPremium = linkedDescriptorIndex > linkedNameIndex
      ? pickLastAmountBefore(source, linkedDescriptorIndex - 1, (line, index) => index > linkedNameIndex && !/^每年/u.test(line))
      : null;
    if (linkedPremium) {
      linkedPlan.premium = linkedPremium.amount;
      linkedPlan.premiumText = linkedPremium.line;
    }
    if (!linkedPlan.premium && linkedPaymentModeIndex >= 0) {
      const premium = pickFirstAmountBetween(source, linkedPaymentModeIndex + 1, linkedNameIndex + 12, (line) => (
        !/^每年/u.test(line)
        && Boolean(normalizeAmountText(line))
      ));
      if (premium) {
        linkedPlan.premium = premium.amount;
        linkedPlan.premiumText = premium.line;
      }
    }
  }

  return fillValueFirstBenefitTablePlans(repaired, source);
}

function parsePlanDetails(source, startIndex, company) {
  const plan = {
    company,
    role: '',
    name: '',
    productType: '',
    amount: '',
    coveragePeriod: '',
    paymentMode: '',
    paymentPeriod: '',
    premium: '',
    premiumText: '',
  };
  const nameInfo = readPlanName(source, startIndex, company);
  plan.name = nameInfo.name;
  if (!plan.name) return null;

  let cursor = nameInfo.endIndex + 1;
  let sawTotalPremiumLine = false;
  for (; cursor < source.length; cursor += 1) {
    const line = compactText(source[cursor]);
    if (!line) continue;
    if (isPlanDetailSkippableLine(line)) {
      if (/合计|大写/u.test(line)) sawTotalPremiumLine = true;
      continue;
    }
    if (isBenefitTablePlanBoundary(line)) break;
    if (isPotentialPlanNameLine(line, company)) break;

    if (isProductDescriptorLine(line)) {
      const combined = normalizePlanName([plan.name, line]);
      if (combined) plan.name = combined;
      continue;
    }

    const labeledPremium = normalizePlanPremiumLine(line);
    if (labeledPremium && /(?:保险费|保费|总保费|首期|首年|合计)/u.test(line)) {
      if (!plan.premium) {
        plan.premium = labeledPremium;
        plan.premiumText = line;
      }
      continue;
    }
    const labeledAmount = normalizePlanAmountLine(line);
    if (labeledAmount && /(?:保险金额|基本保险金额|保额)/u.test(line)) {
      if (!plan.amount) plan.amount = labeledAmount;
      continue;
    }

    const labeledCoverage = normalizeCoveragePeriodText(line);
    if (labeledCoverage && /(?:保险期间|保障期间|保险期限|保障期限)/u.test(line)) {
      if (!plan.coveragePeriod) plan.coveragePeriod = labeledCoverage;
      continue;
    }

    const inlinePaymentMode = normalizePaymentModeText(line.match(/(?:交费方式|缴费方式)[:：]?(年交|年缴|月交|月缴|季交|季缴|半年交|半年缴|趸交|一次交清|一次性交清|一次性交费|一次性缴清)/u)?.[1] || '');
    if (inlinePaymentMode) {
      plan.paymentMode = inlinePaymentMode;
      const inlinePaymentPeriod = normalizePaymentPeriodText(line.match(/(?:交费期间|缴费期间|交费年期|缴费年期|交费年限|缴费年限)[:：]?\/?(\d{1,3}年)/u)?.[1] || '');
      if (inlinePaymentPeriod) plan.paymentPeriod = normalizePlanPaymentPeriod(inlinePaymentPeriod, inlinePaymentMode);
      continue;
    }

    const labeledPaymentPeriod = normalizePaymentPeriodText(line);
    if (labeledPaymentPeriod && /(?:交费期间|缴费期间|交费年期|缴费年期|交费年限|缴费年限)/u.test(line)) {
      plan.paymentPeriod = normalizePlanPaymentPeriod(labeledPaymentPeriod, plan.paymentMode);
      continue;
    }

    if (isBenefitTableHeaderLine(line) || isDateLikePlanValue(line) || isPlaceholderPlanValue(line)) continue;

    const paymentMode = normalizePaymentModeText(line);
    if (paymentMode) {
      if (plan.paymentMode && plan.paymentMode !== paymentMode && (plan.amount || plan.coveragePeriod || plan.paymentPeriod)) break;
      plan.paymentMode = paymentMode;
      continue;
    }

    const rawPaymentPeriod = normalizePaymentPeriodText(line);
    if (rawPaymentPeriod && (/^\//u.test(line) || plan.paymentMode)) {
      plan.paymentPeriod = normalizePlanPaymentPeriod(rawPaymentPeriod, plan.paymentMode);
      continue;
    }

    const coverage = normalizeCoveragePeriodText(line);
    if (coverage && !plan.coveragePeriod) {
      plan.coveragePeriod = coverage;
      continue;
    }

    const amount = normalizeAmountText(line);
    if (amount) {
      if (sawTotalPremiumLine && /^[¥￥]/u.test(line)) continue;
      if (/(?:保险费|保费|总保费|首期|首年|合计)/u.test(line) || /^(每年|首期|首年|合计|¥|￥)/u.test(line)) {
        if (!plan.premium) {
          plan.premium = amount;
          plan.premiumText = line;
        }
        continue;
      }
      if (/(?:保险金额|基本保险金额|保额)/u.test(line)) {
        if (!plan.amount) plan.amount = amount;
        continue;
      }
      if (!plan.amount && !plan.coveragePeriod && !plan.paymentMode && !plan.paymentPeriod) {
        plan.amount = amount;
        continue;
      }
      if (!plan.premium) {
        plan.premium = amount;
        plan.premiumText = line;
      } else if (!plan.amount) {
        plan.amount = amount;
      }
      continue;
    }
  }

  if (!plan.paymentPeriod) {
    plan.paymentPeriod = normalizePlanPaymentPeriod('', plan.paymentMode);
  }
  plan.productType = inferPlanProductType(plan.name);
  return { plan, nextIndex: cursor };
}

function findPlanDetailStartIndex(source, plan, afterIndex = -1) {
  const fullName = compactText(plan?.name || '');
  const baseName = fullName.replace(/（[^）]+）|\([^)]*\)/gu, '');
  if (!baseName) return -1;
  return source.findIndex((line, index) => {
    if (index <= afterIndex) return false;
    const text = compactText(line);
    if (!text || text.length < 3 || isBenefitTableHeaderLine(text) || isBenefitTablePlanBoundary(text)) return false;
    return text.includes(fullName) || fullName.includes(text) || text.includes(baseName) || baseName.includes(text);
  });
}

function hydrateMissingSequentialPlanDetails(plans, source) {
  const hydrated = (Array.isArray(plans) ? plans : []).map((plan) => ({ ...plan }));
  const indexes = [];
  for (const plan of hydrated) {
    const previousIndex = indexes.length ? indexes[indexes.length - 1] : -1;
    indexes.push(findPlanDetailStartIndex(source, plan, previousIndex));
  }

  hydrated.forEach((plan, planIndex) => {
    const startIndex = indexes[planIndex];
    if (startIndex < 0) return;
    const nextIndex = indexes.find((index, indexCursor) => indexCursor > planIndex && index > startIndex) ?? source.length;
    let sawTotalPremiumLine = false;
    for (let index = startIndex + 1; index < nextIndex; index += 1) {
      const line = compactText(source[index]);
      if (!line) continue;
      if (isPlanDetailSkippableLine(line)) {
        if (/合计|大写/u.test(line)) sawTotalPremiumLine = true;
        continue;
      }
      if (isBenefitTablePlanBoundary(line)) break;

      const coverage = normalizeCoveragePeriodText(line);
      if (coverage && /(?:保险期间|保障期间|保险期限|保障期限)/u.test(line) && !plan.coveragePeriod) {
        plan.coveragePeriod = coverage;
        continue;
      }

      const paymentMode = normalizePaymentModeText(line.match(/(?:交费方式|缴费方式)[:：]?(年交|年缴|月交|月缴|季交|季缴|半年交|半年缴|趸交|一次交清|一次性交清|一次性交费|一次性缴清)/u)?.[1] || line);
      if (paymentMode && !plan.paymentMode) plan.paymentMode = paymentMode;

      const paymentPeriod = normalizePaymentPeriodText(line.match(/(?:交费期间|缴费期间|交费年期|缴费年期|交费年限|缴费年限)[:：]?\/?(\d{1,3}年)/u)?.[1] || line);
      if (paymentPeriod && !plan.paymentPeriod) {
        plan.paymentPeriod = normalizePlanPaymentPeriod(paymentPeriod, plan.paymentMode);
        continue;
      }

      const amount = normalizePlanAmountLine(line) || normalizeAmountText(line);
      if (!amount) continue;
      if (sawTotalPremiumLine && /^[¥￥]/u.test(line)) continue;
      if (/(?:保险金额|基本保险金额|保额)/u.test(line) && !plan.amount) {
        plan.amount = amount;
        continue;
      }
      const premium = normalizePlanPremiumLine(line) || amount;
      if (/(?:保险费|保费|总保费|首期|首年)/u.test(line) && !plan.premium) {
        plan.premium = premium;
        plan.premiumText = line;
      }
    }
    if (!plan.paymentPeriod) plan.paymentPeriod = normalizePlanPaymentPeriod('', plan.paymentMode);
  });

  return hydrated;
}

function extractPingAnInlineTablePlans(lines, company) {
  const plans = [];
  let insidePlanTable = false;
  let insideOneYearSection = false;

  for (const rawLine of lines) {
    const line = cleanupFieldText(rawLine);
    if (/保险项目.*保险期间.*交费年限.*保险费/u.test(line)) {
      insidePlanTable = true;
      continue;
    }
    if (!insidePlanTable) continue;
    if (/附加一年期短险/u.test(line)) insideOneYearSection = true;
    if (/首期保险费合计/u.test(line)) break;

    const longTerm = line.match(/^(?:(投保主险|附加险|附加长险)[:：]?\s*)?(.+?[（(]\d{3,5}[）)])\s*(终身|\d{1,3}年)\s*(\d{1,3}年)\s*(---|[\d,]+(?:\.\d+)?元)\s*([\d,]+(?:\.\d+)?元)/u);
    if (longTerm) {
      const label = longTerm[1] || '';
      plans.push({
        company,
        role: label === '投保主险' || plans.length === 0 ? 'main' : 'rider',
        name: normalizeProductNameText(longTerm[2]),
        productType: inferPlanProductType(longTerm[2]),
        coveragePeriod: normalizeCoveragePeriodText(longTerm[3]),
        paymentMode: '',
        paymentPeriod: normalizePlanPaymentPeriod(normalizePaymentPeriodText(longTerm[4]), ''),
        amount: longTerm[5] === '---' ? '' : normalizeAmountText(longTerm[5]),
        premium: normalizeAmountText(longTerm[6]),
        premiumText: longTerm[6],
      });
      continue;
    }

    if (!insideOneYearSection) continue;
    const oneYear = line.match(/^(.+?[（(]\d{3,5}[）)])\s*([\d,]+(?:\.\d+)?元|\d+份含可选)\s*([\d,]+(?:\.\d+)?元)(?:投保人|被保险人)?$/u);
    if (!oneYear) continue;
    plans.push({
      company,
      role: 'rider',
      name: normalizeProductNameText(oneYear[1]),
      productType: inferPlanProductType(oneYear[1]),
      coveragePeriod: '1年',
      paymentMode: '',
      paymentPeriod: '1年交',
      amount: normalizeAmountText(oneYear[2]) || oneYear[2],
      premium: normalizeAmountText(oneYear[3]),
      premiumText: oneYear[3],
    });
  }

  return plans.length >= 2 ? plans : [];
}

export function extractPolicyPlansFromLines(inputLines, options = {}) {
  const lines = (Array.isArray(inputLines) ? inputLines : [])
    .map((line) => cleanupFieldText(line))
    .filter(Boolean);
  const company = cleanupFieldText(options.company || '');
  const pingAnPlans = extractPingAnInlineTablePlans(lines, company);
  if (pingAnPlans.length) return pingAnPlans;
  const chinaLifePlans = extractChinaLifeDetailPlans(lines, company);
  if (chinaLifePlans.length) return chinaLifePlans;
  const receiptPlans = extractReceiptPolicyPlans(lines, company);
  if (receiptPlans.length) {
    return receiptPlans.map((plan, index) => ({
      ...plan,
      role: inferPlanRole(plan, index),
    }));
  }
  const appSummaryPlans = extractAppPlanSummaryPlans(lines, company);
  if (appSummaryPlans.length) {
    let hasMainPlan = false;
    return appSummaryPlans.map((plan, index) => {
      const inferredRole = inferPlanRole(plan, index);
      const role = inferredRole === 'rider' && !/附加/u.test(compactText(plan.name)) && !hasMainPlan
        ? 'main'
        : inferredRole;
      if (role === 'main') hasMainPlan = true;
      return { ...plan, role };
    });
  }
  const inlineSinglePlan = extractInlineSinglePlanSummary(lines, company);
  if (inlineSinglePlan) {
    return [{
      company: inlineSinglePlan.company,
      role: inferPlanRole(inlineSinglePlan, 0),
      name: inlineSinglePlan.name,
      productType: inlineSinglePlan.productType,
      amount: inlineSinglePlan.amount,
      coveragePeriod: inlineSinglePlan.coveragePeriod,
      paymentMode: inlineSinglePlan.paymentMode,
      paymentPeriod: inlineSinglePlan.paymentPeriod,
      premium: inlineSinglePlan.premium,
      premiumText: inlineSinglePlan.premiumText,
    }];
  }
  const labelIndex = findFieldLabelIndex(lines, 'name');
  if (labelIndex < 0) return [];

  const source = lines.slice(labelIndex, labelIndex + 120).map((line) => compactText(line)).filter(Boolean);
  const plans = [];
  for (let index = 0; index < source.length; index += 1) {
    const line = source[index];
    if (isBenefitTablePlanBoundary(line)) break;
    if (!isPotentialPlanNameLine(line, company)) continue;
    const parsed = parsePlanDetails(source, index, company);
    if (!parsed?.plan?.name) continue;
    const duplicate = plans.some((plan) => plan.name === parsed.plan.name);
    if (!duplicate) plans.push(parsed.plan);
    index = Math.max(index, parsed.nextIndex - 1);
  }

  const repairedPlans = repairUnorderedBenefitTablePlans(plans, source);
  const columnOrderedPlans = reconstructColumnOrderedBenefitTablePlans(source, company);
  const bestPlans = scorePlanCompleteness(columnOrderedPlans) > scorePlanCompleteness(repairedPlans)
    ? columnOrderedPlans
    : repairedPlans;

  return hydrateMissingSequentialPlanDetails(bestPlans, source).map((plan, index) => ({
    ...plan,
    role: inferPlanRole(plan, index),
  }));
}

export function matchPolicyFieldsFromLines(inputLines, options = {}) {
  const lines = (Array.isArray(inputLines) ? inputLines : [])
    .map((line) => cleanupFieldText(line))
    .filter(Boolean);
  const company = cleanupFieldText(options.company || '');
  const candidates = createEmptyCandidateMap();

  addProductNameCandidates({ candidates, lines, company });
  addDurationCandidates({ candidates, lines });
  addMoneyCandidatesFromBenefitTable({ candidates, lines, company });
  addCandidatesFromInlineSinglePlanSummary({ candidates, lines, company });

  const fields = createEmptyPolicyFields();
  const fieldEvidence = {};
  const fieldConfidence = {};
  for (const field of POLICY_FIELD_KEYS) {
    const best = chooseBestCandidate(candidates[field]);
    if (!best) continue;
    fields[field] = best.value;
    const evidence = buildCandidateEvidence(lines, best);
    if (evidence) fieldEvidence[field] = evidence;
    const confidence = confidenceFromCandidate(best);
    if (confidence) fieldConfidence[field] = confidence;
  }

  return {
    fields,
    candidates,
    fieldEvidence,
    fieldConfidence,
  };
}
