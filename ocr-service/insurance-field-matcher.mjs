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

function findFieldLabelIndex(lines, field) {
  return lines.findIndex((line) => lineHasFieldLabel(line, field));
}

function isProductSearchBoundary(line) {
  const text = compactText(line);
  return /^(特别约定[:：]?|本栏空白|合计(?:（大写）)?.*|服务人员(?:编号|姓名)[:：]?.*|区部组[:：]?.*|以下内容空白|保险业务|收据专用章|收据说明[:：]?|保险单说明[:：]?|保单制作日期[:：]?.*|保险公司签章|业务员[:：].*|第\d+页共\d+页|\*此码仅.*)$/.test(
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
  return /^(首期保险费合计[:：]?|首期保费合计[:：]?|保险费合计[:：]?|合计(?:（大写）)?.*|服务人员(?:编号|姓名)[:：]?.*|区部组[:：]?.*|以下内容空白|保险业务|收据专用章|收据说明[:：]?|特别约定[:：]?|保险单说明[:：]?|保单制作日期[:：]?.*|保险公司签章|第\d+页共\d+页)/u.test(
    text,
  );
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

function findInlineLabeledPlanName(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!lineHasFieldLabel(lines[index], 'name')) continue;
    const name = normalizeProductNameText(lines[index]);
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
  const parts = [source[startIndex]];
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
  if (scorePlanCompleteness(repaired) > repaired.length * 2) return repaired;

  const targetFirstName = compactText(repaired[0]?.name || '');
  const firstNameIndex = source.findIndex((_line, index) => compactText(readPlanName(source, index, '').name) === targetFirstName);
  if (firstNameIndex < 0) return repaired;

  const amountLines = source
    .slice(0, firstNameIndex)
    .map((line) => compactText(line))
    .filter(isBasicAmountColumnValue)
    .slice(-repaired.length);
  amountLines.forEach((line, index) => {
    if (!repaired[index]?.amount) repaired[index].amount = normalizeAmountText(line);
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
  const mainPlan = repaired[0] || null;

  if (mainPlan) {
    const descriptorIndex = source.findIndex((line) => isStandaloneParentheticalDescriptor(line));
    if (descriptorIndex >= 0 && !compactText(mainPlan.name).includes(compactText(source[descriptorIndex]))) {
      const combined = normalizePlanName([mainPlan.name, source[descriptorIndex]]);
      if (combined) mainPlan.name = combined;
    }
  }

  const mainNameIndex = mainPlan ? source.findIndex((line) => compactText(line) === compactText(mainPlan.name.replace(/（[^）]+）|\([^)]*\)/gu, ''))) : -1;
  const linkedPlan = repaired.find((plan) => inferPlanRole(plan, 1) === 'linked_account') || null;
  const linkedNameIndex = linkedPlan ? source.findIndex((line) => compactText(line).startsWith(compactText(linkedPlan.name).slice(0, 8))) : -1;
  const linkedDescriptorIndex = linkedNameIndex >= 0
    ? source.findIndex((line, index) => index > linkedNameIndex && /^保险(?:（[^）]+）|\([^)]*\))$/u.test(compactText(line)))
    : -1;

  if (linkedPlan && linkedDescriptorIndex > linkedNameIndex && !/保险/u.test(compactText(linkedPlan.name))) {
    const combined = normalizePlanName([linkedPlan.name, source[linkedDescriptorIndex]]);
    if (combined) linkedPlan.name = combined;
  }

  if (mainPlan && linkedNameIndex > 0) {
    const mainValueEndIndex = linkedDescriptorIndex > linkedNameIndex ? linkedDescriptorIndex : linkedNameIndex;
    if (!mainPlan.paymentMode && source.some((line, index) => index < mainValueEndIndex && normalizePaymentModeText(line) === '年交')) {
      mainPlan.paymentMode = '年交';
    }
    if (!mainPlan.paymentPeriod) {
      const paymentPeriodLine = source.find((line, index) => {
        const compact = compactText(line).replace(/^\/+/, '');
        return index < mainValueEndIndex && /^\d{1,3}年$/u.test(compact);
      });
      if (paymentPeriodLine) mainPlan.paymentPeriod = normalizePlanPaymentPeriod(paymentPeriodLine, mainPlan.paymentMode || '年交');
    }
    if (!mainPlan.premium) {
      const premium = pickLastAmountBefore(source, mainValueEndIndex - 1, (line) => /^每年/u.test(line));
      if (premium) {
        mainPlan.premium = premium.amount;
        mainPlan.premiumText = premium.line;
      }
    }
  }

  if (linkedPlan) {
    linkedPlan.amount = '';
    if (!linkedPlan.coveragePeriod) linkedPlan.coveragePeriod = '终身';
    if (source.some((line, index) => index > linkedNameIndex && index < Math.max(linkedDescriptorIndex, linkedNameIndex + 12) && normalizePaymentModeText(line) === '趸交')) {
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
  for (; cursor < source.length; cursor += 1) {
    const line = compactText(source[cursor]);
    if (!line) continue;
    if (isBenefitTablePlanBoundary(line)) break;
    if (isPotentialPlanNameLine(line, company)) break;
    if (isBenefitTableHeaderLine(line) || isDateLikePlanValue(line) || isPlaceholderPlanValue(line)) continue;

    if (isProductDescriptorLine(line)) {
      const combined = normalizePlanName([plan.name, line]);
      if (combined) plan.name = combined;
      continue;
    }

    const paymentMode = normalizePaymentModeText(line);
    if (paymentMode) {
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
      if (/^(每年|首期|首年|合计|¥|￥)/u.test(line)) {
        if (!plan.premium) {
          plan.premium = amount;
          plan.premiumText = line;
        }
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

export function extractPolicyPlansFromLines(inputLines, options = {}) {
  const lines = (Array.isArray(inputLines) ? inputLines : [])
    .map((line) => cleanupFieldText(line))
    .filter(Boolean);
  const company = cleanupFieldText(options.company || '');
  const receiptPlans = extractReceiptPolicyPlans(lines, company);
  if (receiptPlans.length) {
    return receiptPlans.map((plan, index) => ({
      ...plan,
      role: inferPlanRole(plan, index),
    }));
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

  const source = lines.slice(labelIndex + 1, labelIndex + 120).map((line) => compactText(line)).filter(Boolean);
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

  return bestPlans.map((plan, index) => ({
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
  for (const field of POLICY_FIELD_KEYS) {
    const best = chooseBestCandidate(candidates[field]);
    if (best) fields[field] = best.value;
  }

  return {
    fields,
    candidates,
  };
}
