function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function memberName(policy) {
  const name = String(policy?.insured || '').trim();
  return name || '未识别被保人';
}

const INACTIVE_STATUS_PATTERN = /(失效|停效|中止|终止|退保|已退保|过期|作废|无效|inactive|expired|lapsed|terminated|surrendered|cancelled|canceled|void)/iu;

function statusText(record) {
  return [
    record?.policyStatus,
    record?.policyState,
    record?.contractStatus,
    record?.contractState,
    record?.validStatus,
    record?.validityStatus,
    record?.coverageStatus,
    record?.state,
    record?.status,
    record?.['保单状态'],
    record?.['合同状态'],
    record?.['效力状态'],
    record?.['状态'],
  ]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '')
    .map((value) => String(value).normalize('NFKC').trim())
    .join(' ');
}

function policyStatusText(policy) {
  return statusText(policy);
}

function inactiveStatusText(text) {
  return INACTIVE_STATUS_PATTERN.test(String(text || '').normalize('NFKC'));
}

function policyIsInactive(policy) {
  if (policy?.expired === true) return true;
  const text = policyStatusText(policy);
  return inactiveStatusText(text);
}

function validEndOfDayDate(year, month, day) {
  const parsedYear = Number(year);
  const parsedMonth = Number(month);
  const parsedDay = Number(day);
  if (!Number.isInteger(parsedYear) || !Number.isInteger(parsedMonth) || !Number.isInteger(parsedDay)) return null;
  if (parsedYear < 1900 || parsedYear > 2200 || parsedMonth < 1 || parsedMonth > 12 || parsedDay < 1 || parsedDay > 31) return null;
  const date = new Date(parsedYear, parsedMonth - 1, parsedDay, 23, 59, 59, 999);
  if (date.getFullYear() !== parsedYear || date.getMonth() !== parsedMonth - 1 || date.getDate() !== parsedDay) return null;
  return date;
}

function parseCoverageEndDate(value) {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text || /终身|永久|lifelong|whole\s*life/iu.test(text)) return null;

  const chineseDateMatches = [...text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?/gu)];
  if (chineseDateMatches.length) {
    const match = chineseDateMatches[chineseDateMatches.length - 1];
    return validEndOfDayDate(match[1], match[2], match[3]);
  }

  const numericDateMatches = [...text.matchAll(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/gu)];
  if (numericDateMatches.length) {
    const match = numericDateMatches[numericDateMatches.length - 1];
    return validEndOfDayDate(match[1], match[2], match[3]);
  }

  return null;
}

function coveragePeriodExpired(value, today = new Date()) {
  const endDate = parseCoverageEndDate(value);
  if (!endDate) return false;
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return endDate < startOfToday;
}

function planStatusText(plan) {
  if (!plan || typeof plan === 'string') return '';
  return statusText(plan);
}

function planIsInactive(policy, plan) {
  if (policyIsInactive(policy)) return true;
  if (!plan || typeof plan === 'string') return false;
  if (plan?.expired === true) return true;
  if (inactiveStatusText(planStatusText(plan))) return true;
  return coveragePeriodExpired(plan?.coveragePeriod);
}

function activePlans(policy) {
  return (Array.isArray(policy?.plans) ? policy.plans : []).filter((plan) => !planIsInactive(policy, plan));
}

function activePolicies(policies = []) {
  return policies.filter((policy) => !policyIsInactive(policy));
}

function inactivePolicies(policies = []) {
  return policies.filter(policyIsInactive);
}

function latestCashValue(policy) {
  const cashValues = Array.isArray(policy?.cashValues) ? policy.cashValues : [];
  return cashValues.reduce((latest, row) => {
    const policyYear = finiteNumber(row?.policyYear);
    const cashValue = finiteNumber(row?.cashValue);
    if (policyYear === null || cashValue === null) return latest;
    if (!latest || policyYear > latest.policyYear) {
      return {
        row,
        policyYear,
        cashValue,
      };
    }
    return latest;
  }, null);
}

function futurePayoutTotal(policy) {
  const entries = Array.isArray(policy?.cashflowEntries) ? policy.cashflowEntries : [];
  return entries.reduce((total, entry) => total + asNumber(entry?.amount), 0);
}

function cumulativePayout(policy) {
  const entries = Array.isArray(policy?.cashflowEntries) ? policy.cashflowEntries : [];
  return entries.reduce((max, entry) => Math.max(max, asNumber(entry?.cumulative)), 0);
}

function formatNumberText(value) {
  return asNumber(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function parsePaymentYears(value) {
  const text = String(value || '').normalize('NFKC');
  if (/趸交|一次交清/u.test(text)) return 1;

  const yearMatch = text.match(/(\d+(?:\.\d+)?)\s*年/u);
  if (yearMatch) return Math.max(1, Math.floor(asNumber(yearMatch[1])));

  const periodMatch = text.match(/(\d+(?:\.\d+)?)\s*期/u);
  if (periodMatch) return Math.max(1, Math.floor(asNumber(periodMatch[1])));

  return null;
}

function totalPremiumText(policy) {
  const premium = asNumber(policy?.firstPremium);
  const years = parsePaymentYears(policy?.paymentPeriod);
  if (premium <= 0) return '待识别';
  if (years === null) return '待识别';
  return formatNumberText(premium * years);
}

function uniqueJoinedText(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const parts = String(value || '').split(/[、,，;；/／]+/u);
    for (const part of parts) {
      const text = part.trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
  }
  return result.join('、');
}

function policyTypeLabel(policy) {
  const indicatorType = uniqueJoinedText((Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : []).map((indicator) => indicator?.productType));
  if (indicatorType) return indicatorType;

  const policyType = uniqueJoinedText([policy?.productType, policy?.type]);
  if (policyType) return policyType;

  return uniqueJoinedText((Array.isArray(policy?.plans) ? policy.plans : []).map((plan) => plan?.productType));
}

function coverageText(policy) {
  const amount = asNumber(policy?.amount);
  if (amount > 0) return `${formatNumberText(amount / 10000)}万`;

  const payout = cumulativePayout(policy);
  if (payout > 0) return `累计领取${formatNumberText(payout)}`;

  return '按条款';
}

function dataStatus(policy) {
  if (policyIsInactive(policy)) return '失效';
  if (policy?.reportStatus === 'generating') return '责任生成中';
  if (policy?.reportStatus === 'failed') return '报告失败';
  if (latestCashValue(policy)) return '现金价值已识别';
  if (futurePayoutTotal(policy) > 0) return '责任已量化';
  return '待补充责任';
}

function buildInventoryRow(policy) {
  const latestCash = latestCashValue(policy);
  return {
    policyId: policy?.id,
    member: memberName(policy),
    company: String(policy?.company || ''),
    policyNumber: String(policy?.policyNumber || policy?.policyNo || policy?.contractNumber || policy?.contractNo || policy?.number || '').trim(),
    productName: String(policy?.name || ''),
    typeLabel: policyTypeLabel(policy),
    isInactive: policyIsInactive(policy),
    policyStatusText: policyStatusText(policy),
    annualPremium: asNumber(policy?.firstPremium),
    annualPremiumText: formatNumberText(policy?.firstPremium),
    totalPremiumText: totalPremiumText(policy),
    coverage: asNumber(policy?.amount),
    coverageText: coverageText(policy),
    paymentPeriod: String(policy?.paymentPeriod || ''),
    coveragePeriod: String(policy?.coveragePeriod || ''),
    effectiveDate: String(policy?.date || ''),
    beneficiary: String(policy?.beneficiary || ''),
    cashValue: latestCash?.cashValue || 0,
    cashValueText: latestCash ? formatNumberText(latestCash.cashValue) : '',
    futurePayout: futurePayoutTotal(policy),
    futurePayoutText: formatNumberText(futurePayoutTotal(policy)),
    dataStatus: dataStatus(policy),
  };
}

const CRITICAL_ROWS = [
  {
    key: 'critical_multiple',
    label: '重疾多次给付',
    patterns: [
      /(?:多次|第二次|第2次|再次).*(?:重疾|重大疾病|重度疾病)/u,
      /(?:重疾|重大疾病|重度疾病).*(?:多次|第二次|第2次|再次)/u,
    ],
  },
  {
    key: 'critical_first',
    label: '重疾首次给付',
    patterns: [
      /重疾(?!.*(?:多次|第二次|第2次|再次))/u,
      /重大疾病(?!.*(?:多次|第二次|第2次|再次))/u,
      /重度疾病(?!.*(?:多次|第二次|第2次|再次))/u,
    ],
  },
  {
    key: 'moderate',
    label: '中症给付',
    patterns: [/中症/u, /中度疾病/u],
  },
  {
    key: 'mild',
    label: '轻症给付',
    patterns: [/轻症/u, /轻度疾病/u],
  },
  {
    key: 'specific_disease',
    label: '特定疾病/少儿特疾/癌症',
    patterns: [/特定疾病/u, /少儿特疾/u, /女性特疾/u, /男性特疾/u, /恶性肿瘤/u, /癌/u],
  },
  {
    key: 'terminal',
    label: '疾病终末期',
    patterns: [/终末期/u],
  },
  {
    key: 'death_disability',
    label: '身故/全残',
    patterns: [/身故/u, /全残/u],
  },
  {
    key: 'waiver',
    label: '保费豁免',
    patterns: [/豁免/u],
  },
];

function indicatorText(indicator) {
  return [
    indicator?.coverageType,
    indicator?.liability,
    indicator?.scenario,
    indicator?.payout,
    indicator?.formulaText,
    indicator?.condition,
    indicator?.basis,
    indicator?.sourceExcerpt,
  ].filter(Boolean).join(' ');
}

function normalizeProductName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s（）()《》〈〉「」『』【】\[\]·・,，.。:：;；\-_/\\]/gu, '');
}

function productNameMatchesIndicator(planName, indicatorProductName) {
  const planText = normalizeProductName(planName);
  const indicatorTextValue = normalizeProductName(indicatorProductName);
  if (!planText || !indicatorTextValue) return false;
  return planText === indicatorTextValue
    || planText.includes(indicatorTextValue)
    || indicatorTextValue.includes(planText);
}

function findPlanForIndicator(policy, indicator) {
  const productName = indicator?.productName;
  const plans = Array.isArray(policy?.plans) ? policy.plans : [];
  if (!productName) return null;

  return plans.find((plan) => {
    if (!plan || typeof plan === 'string') return productNameMatchesIndicator(plan, productName);
    return [plan?.matchedProductName, plan?.name].some((value) => productNameMatchesIndicator(value, productName));
  }) || null;
}

function indicatorPlanIsInactive(policy, indicator) {
  const plan = findPlanForIndicator(policy, indicator);
  return Boolean(plan && planIsInactive(policy, plan));
}

function indicatorSourceProductName(policy, indicator) {
  const plan = findPlanForIndicator(policy, indicator);
  if (plan && typeof plan !== 'string') {
    const productName = String(plan?.matchedProductName || plan?.name || '').trim();
    if (productName) return productName;
  }
  return String(indicator?.productName || policy?.name || '').trim();
}

function indicatorBaseAmount(indicator, policy) {
  const plan = findPlanForIndicator(policy, indicator);
  const planAmount = finiteNumber(plan?.amount);
  if (planAmount !== null && planAmount > 0) return planAmount;
  return asNumber(policy?.amount);
}

function classifyByDefinitions(text, definitions) {
  const normalized = String(text || '').normalize('NFKC');
  return definitions.find((definition) => definition.patterns.some((pattern) => pattern.test(normalized))) || null;
}

function formulaNeedsManualAmount(text) {
  return /(较大|较高|最大|取|现金价值|现价|账户价值|已交|所交|实际交纳|保险费|保费|余额|两者|三者|max)/iu
    .test(String(text || '').normalize('NFKC'));
}

function resolveIndicatorAmount(indicator, policy) {
  const value = finiteNumber(indicator?.value);
  const unit = String(indicator?.unit || '').normalize('NFKC');
  const basis = String(indicator?.basis || '').normalize('NFKC');
  const text = indicatorText(indicator).normalize('NFKC');
  const baseAmount = indicatorBaseAmount(indicator, policy);
  const baseAmountPattern = /基本(?:保险金额|保额)/u;

  if (value !== null && unit === '%' && baseAmountPattern.test(basis)) {
    return baseAmount * value / 100;
  }

  if (value !== null && unit === '倍' && baseAmountPattern.test(basis)) {
    return baseAmount * value;
  }

  const formulaPercentMatch = text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/u);
  if (formulaPercentMatch) return baseAmount * asNumber(formulaPercentMatch[1]) / 100;

  const formulaMultipleMatch = text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*倍/u);
  if (formulaMultipleMatch) return baseAmount * asNumber(formulaMultipleMatch[1]);

  if (value !== null && /^(?:元|圆)$/u.test(unit)) return value;

  const wanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*万/u);
  if (wanMatch) return asNumber(wanMatch[1]) * 10000;

  const yuanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:元|圆)/u);
  if (yuanMatch) return asNumber(yuanMatch[1]);

  if (baseAmountPattern.test(text) && !formulaNeedsManualAmount(text)) return baseAmount;

  return 0;
}

function indicatorAmountCalculationText(indicator, policy, amount) {
  const numericAmount = asNumber(amount);
  const value = finiteNumber(indicator?.value);
  const unit = String(indicator?.unit || '').normalize('NFKC').trim();
  const basis = String(indicator?.basis || '').normalize('NFKC').trim();
  const text = indicatorText(indicator).normalize('NFKC');
  const baseAmount = indicatorBaseAmount(indicator, policy);
  const baseAmountPattern = /基本(?:保险金额|保额)/u;
  const baseLabel = baseAmountPattern.test(basis) || baseAmountPattern.test(text) ? '基本保险金额' : (basis || '基准金额');

  if (value !== null && unit === '%' && baseAmountPattern.test(basis)) {
    return `${baseLabel}${formatRadarMoney(baseAmount)} × ${formatNumberText(value)}% = ${formatRadarMoney(numericAmount)}`;
  }

  if (value !== null && unit === '倍' && baseAmountPattern.test(basis)) {
    return `${baseLabel}${formatRadarMoney(baseAmount)} × ${formatNumberText(value)}倍 = ${formatRadarMoney(numericAmount)}`;
  }

  const formulaPercentMatch = text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/u);
  if (formulaPercentMatch) {
    return `基本保险金额${formatRadarMoney(baseAmount)} × ${formatNumberText(asNumber(formulaPercentMatch[1]))}% = ${formatRadarMoney(numericAmount)}`;
  }

  const formulaMultipleMatch = text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*倍/u);
  if (formulaMultipleMatch) {
    return `基本保险金额${formatRadarMoney(baseAmount)} × ${formatNumberText(asNumber(formulaMultipleMatch[1]))}倍 = ${formatRadarMoney(numericAmount)}`;
  }

  if (value !== null && /^(?:元|圆)$/u.test(unit)) {
    return `识别金额${formatRadarMoney(numericAmount)}`;
  }

  const wanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*万/u);
  if (wanMatch) {
    return `文本识别${formatNumberText(asNumber(wanMatch[1]))}万 = ${formatRadarMoney(numericAmount)}`;
  }

  const yuanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:元|圆)/u);
  if (yuanMatch) {
    return `文本识别${formatRadarMoney(numericAmount)}`;
  }

  if (baseAmountPattern.test(text)) {
    return `基本保险金额${formatRadarMoney(baseAmount)} = ${formatRadarMoney(numericAmount)}`;
  }

  const formulaText = String(indicator?.formulaText || '').trim();
  if (formulaText) return `${formulaText} = ${formatRadarMoney(numericAmount)}`;
  return `按识别责任金额合计 = ${formatRadarMoney(numericAmount)}`;
}

function amountDisplay(amount, fallback = '') {
  const numericAmount = asNumber(amount);
  if (numericAmount >= 10000) return `${formatNumberText(numericAmount / 10000)}万`;
  if (numericAmount > 0) return numericAmount.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  return fallback || '待识别';
}

function baseProtectionRow(definition) {
  return {
    key: definition.key,
    label: definition.label,
    amount: 0,
    amountText: '未识别',
    countText: '-',
    status: 'missing',
    conditionText: '未识别到该责任',
    sourcePolicies: [],
  };
}

function sourcePolicyKey(source) {
  if (source?.sourceKey) return String(source.sourceKey);
  const policyId = source?.policyId;
  if (policyId !== undefined && policyId !== null && String(policyId).trim() !== '') return `policy:${policyId}`;
  return `product:${normalizeProductName(source?.productName)}:${String(source?.liability || '').trim()}`;
}

function addSourcePolicy(row, source) {
  const key = sourcePolicyKey(source);
  if (row.sourcePolicies.some((item) => sourcePolicyKey(item) === key)) return;
  row.sourcePolicies.push(source);
}

function indicatorIsAccidentCoverage(indicator) {
  const coverageType = String(indicator?.coverageType || '').normalize('NFKC');
  const primaryText = [
    indicator?.coverageType,
    indicator?.liability,
    indicator?.scenario,
  ].filter(Boolean).join(' ').normalize('NFKC');
  return coverageType === '意外保障' || /(意外|交通|公共交通|航空|民航|飞机|轨道|列车|轮船|自驾|驾乘|猝死)/u.test(primaryText);
}

function applyIndicatorToRow(row, indicator, policy) {
  const amount = indicatorAmountForPolicy(indicator, policy);
  const formulaText = String(indicator?.formulaText || '').trim();
  const value = finiteNumber(indicator?.value);
  const unit = String(indicator?.unit || '').trim();
  const conditionText = String(indicator?.condition || formulaText || indicator?.sourceExcerpt || '').trim();

  row.amount += amount;
  row.amountText = amountDisplay(row.amount, formulaText || '待识别');
  row.countText = value !== null && unit ? `${formatNumberText(value)}${unit}` : formulaText || '-';
  row.status = row.amount > 0 ? 'covered' : 'formula';
  row.conditionText = conditionText || '按识别责任计算';
  addSourcePolicy(row, {
    sourceKey: policySourceKey(policy),
    policyId: policy?.id,
    company: String(policy?.company || ''),
    productName: indicatorSourceProductName(policy, indicator),
    liability: String(indicator?.liability || ''),
    formulaText,
    amount,
    amountText: formatRadarMoney(amount),
    calculationText: indicatorAmountCalculationText(indicator, policy, amount),
  });
  return amount;
}

function criticalPolicyText(policy) {
  return [
    policy?.name,
    policy?.report,
    policy?.ocrText,
    ...activePlans(policy).map((plan) => {
      if (typeof plan === 'string') return plan;
      return [plan?.name, plan?.title, plan?.liability, plan?.type].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).map((item) => {
      if (typeof item === 'string') return item;
      return [
        item?.name,
        item?.title,
        item?.liability,
        item?.type,
        item?.coverageType,
        item?.scenario,
        item?.payout,
        item?.note,
      ].filter(Boolean).join(' ');
    }),
  ].filter(Boolean).join(' ');
}

function policyImpliesCriticalIllness(policy) {
  return /(重疾|重大疾病|轻症|中症|恶性肿瘤|癌)/u.test(criticalPolicyText(policy).normalize('NFKC'));
}

function applyFallbackPolicyToRow(row, policy) {
  const amount = asNumber(policy?.amount);
  row.amount += amount;
  row.amountText = amountDisplay(row.amount);
  row.countText = row.amount > 0 ? '基本保额' : '-';
  row.status = row.amount > 0 ? 'covered' : 'unknown';
  row.conditionText = '按保单基础保额估算';
  addSourcePolicy(row, {
    sourceKey: policySourceKey(policy),
    policyId: policy?.id,
    company: String(policy?.company || ''),
    productName: String(policy?.name || ''),
    liability: '重疾首次给付',
    formulaText: '按保单基础保额估算',
    amount,
    amountText: formatRadarMoney(amount),
    calculationText: `保单基础保额${formatRadarMoney(amount)} = ${formatRadarMoney(amount)}`,
  });
}

function indicatorCountText(indicator, fallback = '-') {
  const formulaText = String(indicator?.formulaText || '').trim();
  const value = finiteNumber(indicator?.value);
  const unit = String(indicator?.unit || '').trim();
  return value !== null && unit ? `${formatNumberText(value)}${unit}` : formulaText || fallback;
}

function markInactiveSourceOnRow(row, policy, liability, options = {}) {
  if (!row || row.amount > 0 || row.status === 'covered') return;
  const normalizedLiability = String(liability || row.label || '').trim();
  const productName = String(options.productName || policy?.name || '').trim();
  const reasonText = String(options.reasonText || '历史识别到该责任，但保单已失效，未计入当前保障').trim();
  const inactiveAmount = asNumber(options.amount);
  row.amount = 0;
  if (inactiveAmount > 0) {
    row.inactiveAmount = asNumber(row.inactiveAmount) + inactiveAmount;
    row.amountText = amountDisplay(row.inactiveAmount);
  } else if (options.amountText) {
    row.amountText = String(options.amountText);
  } else if (row.amountText === '未统计') {
    row.amountText = '未识别';
  }
  const countText = String(options.countText || '').trim();
  if (countText) {
    row.countText = row.countText === '-' || row.countText === countText ? countText : `${row.countText}/${countText}`;
  } else if (row.countText === '未统计') {
    row.countText = '-';
  }
  row.status = 'inactive';
  row.conditionText = reasonText;
  addSourcePolicy(row, {
    sourceKey: `${policySourceKey(policy)}:inactive:${row.key}:${normalizeProductName(productName)}:${normalizeProductName(normalizedLiability)}`,
    policyId: policy?.id,
    company: String(policy?.company || ''),
    productName,
    liability: normalizedLiability,
    formulaText: reasonText,
    amount: inactiveAmount,
    amountText: inactiveAmount > 0 ? formatRadarMoney(inactiveAmount) : '未识别',
    calculationText: inactiveAmount > 0 ? `${formatRadarMoney(inactiveAmount)}；${reasonText}` : reasonText,
  });
}

function markInactiveCriticalPolicies(rowMap, memberPolicies) {
  for (const policy of memberPolicies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    let matched = false;
    for (const indicator of indicators) {
      if (indicatorIsAccidentCoverage(indicator)) continue;
      const definition = classifyByDefinitions(indicatorText(indicator), CRITICAL_ROWS);
      if (!definition) continue;
      matched = true;
      const amount = indicatorAmountForPolicy(indicator, policy);
      markInactiveSourceOnRow(rowMap.get(definition.key), policy, indicator?.liability || definition.label, {
        productName: indicatorSourceProductName(policy, indicator),
        amount,
        countText: indicatorCountText(indicator),
      });
    }
    if (!matched && policyImpliesCriticalIllness(policy)) {
      markInactiveSourceOnRow(rowMap.get('critical_first'), policy, '重疾首次给付', {
        amount: asNumber(policy?.amount),
        countText: '基本保额',
      });
    }
  }
}

function indicatorHasFormulaUnit(indicator) {
  return String(indicator?.unit || '').normalize('NFKC').trim() === '公式';
}

function buildMemberCriticalRows(memberPolicies, inactiveMemberPolicies = []) {
  const rowMap = new Map(CRITICAL_ROWS.map((definition) => [definition.key, baseProtectionRow(definition)]));
  const usableCriticalFirstPolicies = new Set();
  const formulaCriticalFirstPolicies = new Set();
  const inactiveCriticalPolicies = new Set();

  for (const policy of memberPolicies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      if (indicatorIsAccidentCoverage(indicator)) continue;
      const definition = classifyByDefinitions(indicatorText(indicator), CRITICAL_ROWS);
      if (!definition) continue;
      if (indicatorPlanIsInactive(policy, indicator)) {
        inactiveCriticalPolicies.add(policy);
        markInactiveSourceOnRow(rowMap.get(definition.key), policy, indicator?.liability || definition.label, {
          productName: indicatorSourceProductName(policy, indicator),
          reasonText: '历史识别到该责任，但对应险种已失效，未计入当前保障',
          amount: indicatorAmountForPolicy(indicator, policy),
          countText: indicatorCountText(indicator),
        });
        continue;
      }
      const amount = applyIndicatorToRow(rowMap.get(definition.key), indicator, policy);
      if (definition.key === 'critical_first') {
        if (amount > 0) {
          usableCriticalFirstPolicies.add(policy);
        } else if (indicatorHasFormulaUnit(indicator)) {
          formulaCriticalFirstPolicies.add(policy);
        }
      }
    }
  }

  const criticalFirst = rowMap.get('critical_first');
  if (criticalFirst.status === 'missing' || criticalFirst.status === 'formula') {
    if (criticalFirst.status === 'formula') {
      criticalFirst.amount = 0;
      criticalFirst.sourcePolicies = [];
      usableCriticalFirstPolicies.clear();
    }
  }

  for (const policy of memberPolicies) {
    if (
      policyImpliesCriticalIllness(policy)
      && !usableCriticalFirstPolicies.has(policy)
      && !formulaCriticalFirstPolicies.has(policy)
      && !inactiveCriticalPolicies.has(policy)
    ) {
      applyFallbackPolicyToRow(criticalFirst, policy);
    }
  }

  markInactiveCriticalPolicies(rowMap, inactiveMemberPolicies);

  const rows = Array.from(rowMap.values());
  const attentionItems = [];
  if (rowMap.get('critical_first')?.status === 'missing') {
    attentionItems.push('重疾首次给付缺失');
  }

  return { rows, attentionItems };
}

export function buildCriticalIllnessSection(policies = []) {
  const groupMap = new Map();

  for (const policy of policies) {
    const member = memberName(policy);
    if (!groupMap.has(member)) groupMap.set(member, []);
    groupMap.get(member).push(policy);
  }

  return {
    members: Array.from(groupMap, ([member, memberPolicies]) => {
      const activeMemberPolicies = activePolicies(memberPolicies);
      const inactiveMemberPolicies = inactivePolicies(memberPolicies);
      return {
        member,
        ...buildMemberCriticalRows(activeMemberPolicies, inactiveMemberPolicies),
      };
    }),
  };
}

const ACCIDENT_ROWS = [
  {
    key: 'general_accident',
    label: '一般意外身故/全残',
    patterns: [/一般意外/u, /意外身故/u, /意外全残/u],
  },
  {
    key: 'accident_disability',
    label: '意外伤残',
    patterns: [/意外伤残/u, /残疾/u, /伤残等级/u],
  },
  {
    key: 'accident_medical',
    label: '意外医疗',
    patterns: [/意外医疗/u, /医疗费用/u, /报销/u],
  },
  {
    key: 'traffic',
    label: '交通意外',
    patterns: [/交通意外/u, /公共交通/u, /网约车/u],
  },
  {
    key: 'driving',
    label: '自驾/驾乘',
    patterns: [/自驾/u, /驾乘/u, /驾驶/u],
  },
  {
    key: 'public_transport',
    label: '公共交通',
    patterns: [/公共交通/u, /客运汽车/u, /客运轮船/u],
  },
  {
    key: 'aviation',
    label: '航空意外',
    patterns: [/航空/u, /民航/u, /飞机/u],
  },
  {
    key: 'rail_ship',
    label: '轨道/轮船',
    patterns: [/轨道/u, /列车/u, /轮船/u],
  },
  {
    key: 'sudden_death',
    label: '猝死',
    patterns: [/猝死/u],
  },
  {
    key: 'hospital_allowance',
    label: '住院津贴',
    patterns: [/住院津贴/u, /津贴/u],
  },
];

function accidentPolicyText(policy) {
  return [
    policy?.name,
    policy?.report,
    policy?.ocrText,
    ...activePlans(policy).map((plan) => {
      if (typeof plan === 'string') return plan;
      return [plan?.name, plan?.title, plan?.liability, plan?.type].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).map((item) => {
      if (typeof item === 'string') return item;
      return [
        item?.name,
        item?.title,
        item?.liability,
        item?.type,
        item?.coverageType,
        item?.scenario,
        item?.payout,
        item?.note,
      ].filter(Boolean).join(' ');
    }),
  ].filter(Boolean).join(' ');
}

function textImpliesAccident(text) {
  return /(意外|伤残|残疾|交通|公共交通|网约车|自驾|驾乘|航空|民航|飞机|轨道|列车|轮船|猝死)/u
    .test(String(text || '').normalize('NFKC'));
}

function indicatorImpliesAccident(indicator) {
  const coverageType = String(indicator?.coverageType || '').normalize('NFKC');
  return coverageType === '意外保障' || textImpliesAccident(indicatorText(indicator));
}

function accidentSpecificTransportRows() {
  return ['driving', 'rail_ship', 'public_transport', 'aviation']
    .map((key) => ACCIDENT_ROWS.find((definition) => definition.key === key))
    .filter(Boolean);
}

function uniqueDefinitions(definitions) {
  const seen = new Set();
  return definitions.filter((definition) => {
    if (!definition || seen.has(definition.key)) return false;
    seen.add(definition.key);
    return true;
  });
}

function accidentTextSegments(text) {
  const normalized = String(text || '').normalize('NFKC').trim();
  if (!normalized) return [];
  const segments = normalized
    .split(/[\/／、,，;；]+|以及|或者|及|和|或/u)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length > 1 ? segments : [normalized];
}

function classifyAccidentTextDefinitions(text, specificTransportRows) {
  const matches = [];
  for (const segment of accidentTextSegments(text)) {
    const definition = classifyByDefinitions(segment, specificTransportRows)
      || classifyByDefinitions(segment, ACCIDENT_ROWS);
    if (definition) matches.push(definition);
  }
  return uniqueDefinitions(matches);
}

function classifyAccidentIndicatorDefinitions(indicator) {
  const specificTransportRows = accidentSpecificTransportRows();
  const liabilityMatches = classifyAccidentTextDefinitions(indicator?.liability, specificTransportRows);
  if (liabilityMatches.length) return liabilityMatches;
  return classifyAccidentTextDefinitions(indicatorText(indicator), specificTransportRows);
}

function accidentCountText(definition, indicator) {
  const text = indicatorText(indicator);
  if (definition.key === 'accident_medical' || /(医疗费用|报销)/u.test(text)) return '报销型';
  if (definition.key === 'hospital_allowance' || /津贴/u.test(text)) return '津贴';
  return '定额给付';
}

function applyAccidentIndicatorToRow(row, definition, indicator, policy) {
  const amount = resolveIndicatorAmount(indicator, policy);
  const formulaText = String(indicator?.formulaText || '').trim();
  const conditionText = String(indicator?.condition || formulaText || indicator?.sourceExcerpt || '').trim();
  const countText = accidentCountText(definition, indicator);

  row.amount += amount;
  row.amountText = amountDisplay(row.amount, formulaText || '待识别');
  row.countText = row.countText === '-' || row.countText === countText ? countText : `${row.countText}/${countText}`;
  row.status = row.amount > 0 ? 'covered' : 'formula';
  if (conditionText) {
    row.conditionText = row.conditionText === '未识别到该责任' || row.conditionText === conditionText
      ? conditionText
      : `${row.conditionText}；${conditionText}`;
  } else if (row.conditionText === '未识别到该责任') {
    row.conditionText = '按识别责任计算';
  }
  addSourcePolicy(row, {
    sourceKey: policySourceKey(policy),
    policyId: policy?.id,
    company: String(policy?.company || ''),
    productName: indicatorSourceProductName(policy, indicator),
    liability: String(indicator?.liability || indicator?.scenario || ''),
    formulaText,
    amount,
    amountText: formatRadarMoney(amount),
    calculationText: indicatorAmountCalculationText(indicator, policy, amount),
  });
}

function responsibilityToAccidentIndicator(responsibility, policy) {
  if (typeof responsibility === 'string') {
    return {
      coverageType: '',
      liability: responsibility,
      formulaText: '',
      productName: policy?.name,
      sourceExcerpt: responsibility,
    };
  }

  return {
    coverageType: responsibility?.coverageType,
    liability: responsibility?.liability || responsibility?.name || responsibility?.title || responsibility?.type,
    scenario: responsibility?.scenario,
    payout: responsibility?.payout,
    formulaText: responsibility?.formulaText || responsibility?.payout || responsibility?.note || '',
    condition: responsibility?.condition || responsibility?.note || '',
    basis: responsibility?.basis,
    productName: responsibility?.productName || responsibility?.matchedProductName || responsibility?.sourceProductName || responsibility?.planName || policy?.name,
    sourceExcerpt: responsibility?.sourceExcerpt,
  };
}

function fallbackPolicyIndicator(policy) {
  const text = accidentPolicyText(policy);

  return {
    coverageType: '意外保障',
    liability: text || '一般意外身故/全残',
    value: asNumber(policy?.amount),
    unit: '元',
    formulaText: '按保单基础保额估算',
    productName: policy?.name,
    sourceExcerpt: text,
  };
}

function markInactiveAccidentPolicies(rowMap, memberPolicies) {
  for (const policy of memberPolicies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    const responsibilities = Array.isArray(policy?.responsibilities) ? policy.responsibilities : [];
    let matched = false;

    for (const indicator of indicators) {
      if (!indicatorImpliesAccident(indicator)) continue;
      const definitions = classifyAccidentIndicatorDefinitions(indicator);
      if (!definitions.length) continue;
      matched = true;
      for (const definition of definitions) {
        markInactiveSourceOnRow(rowMap.get(definition.key), policy, indicator?.liability || indicator?.scenario || definition.label, {
          productName: indicatorSourceProductName(policy, indicator),
          amount: indicatorAmountForPolicy(indicator, policy),
          countText: accidentCountText(definition, indicator),
        });
      }
    }

    for (const responsibility of responsibilities) {
      const indicator = responsibilityToAccidentIndicator(responsibility, policy);
      if (!indicatorImpliesAccident(indicator)) continue;
      const definitions = classifyAccidentIndicatorDefinitions(indicator);
      if (!definitions.length) continue;
      matched = true;
      for (const definition of definitions) {
        markInactiveSourceOnRow(rowMap.get(definition.key), policy, indicator?.liability || indicator?.scenario || definition.label, {
          productName: indicatorSourceProductName(policy, indicator),
          amount: indicatorAmountForPolicy(indicator, policy),
          countText: accidentCountText(definition, indicator),
        });
      }
    }

    if (!matched && textImpliesAccident(accidentPolicyText(policy))) {
      const indicator = fallbackPolicyIndicator(policy);
      const definitions = classifyAccidentIndicatorDefinitions(indicator);
      const fallbackDefinitions = definitions.length ? definitions : [ACCIDENT_ROWS.find((item) => item.key === 'general_accident')];
      for (const definition of fallbackDefinitions) {
        markInactiveSourceOnRow(rowMap.get(definition?.key), policy, indicator?.liability || definition?.label, {
          productName: indicatorSourceProductName(policy, indicator),
          amount: indicatorAmountForPolicy(indicator, policy),
          countText: definition ? accidentCountText(definition, indicator) : '定额给付',
        });
      }
    }
  }
}

function buildMemberAccidentRows(memberPolicies, inactiveMemberPolicies = []) {
  const rowMap = new Map(ACCIDENT_ROWS.map((definition) => [definition.key, baseProtectionRow(definition)]));

  for (const policy of memberPolicies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    const indicatorRowKeys = new Set();

    for (const indicator of indicators) {
      if (!indicatorImpliesAccident(indicator)) continue;

      const definitions = classifyAccidentIndicatorDefinitions(indicator);
      for (const definition of definitions) {
        if (indicatorPlanIsInactive(policy, indicator)) {
          markInactiveSourceOnRow(rowMap.get(definition.key), policy, indicator?.liability || indicator?.scenario || definition.label, {
            productName: indicatorSourceProductName(policy, indicator),
            reasonText: '历史识别到该责任，但对应险种已失效，未计入当前保障',
            amount: indicatorAmountForPolicy(indicator, policy),
            countText: accidentCountText(definition, indicator),
          });
          continue;
        }
        applyAccidentIndicatorToRow(rowMap.get(definition.key), definition, indicator, policy);
        indicatorRowKeys.add(definition.key);
      }
    }

    const responsibilities = Array.isArray(policy?.responsibilities) ? policy.responsibilities : [];
    for (const responsibility of responsibilities) {
      const indicator = responsibilityToAccidentIndicator(responsibility, policy);
      if (!indicatorImpliesAccident(indicator)) continue;

      const definitions = classifyAccidentIndicatorDefinitions(indicator);
      for (const definition of definitions) {
        const row = rowMap.get(definition.key);
        if (indicatorRowKeys.has(definition.key) && row.amount > 0) continue;
        if (indicatorPlanIsInactive(policy, indicator)) {
          markInactiveSourceOnRow(row, policy, indicator?.liability || indicator?.scenario || definition.label, {
            productName: indicatorSourceProductName(policy, indicator),
            reasonText: '历史识别到该责任，但对应险种已失效，未计入当前保障',
            amount: indicatorAmountForPolicy(indicator, policy),
            countText: accidentCountText(definition, indicator),
          });
          continue;
        }
        applyAccidentIndicatorToRow(row, definition, indicator, policy);
      }
    }

    if (indicators.length === 0 && responsibilities.length === 0 && textImpliesAccident(accidentPolicyText(policy))) {
      const indicator = fallbackPolicyIndicator(policy);
      const definitions = classifyAccidentIndicatorDefinitions(indicator);
      const fallbackDefinitions = definitions.length ? definitions : [ACCIDENT_ROWS.find((item) => item.key === 'general_accident')];
      for (const definition of fallbackDefinitions) {
        applyAccidentIndicatorToRow(rowMap.get(definition.key), definition, indicator, policy);
      }
    }
  }

  markInactiveAccidentPolicies(rowMap, inactiveMemberPolicies);

  const rows = Array.from(rowMap.values());
  const attentionItems = rows
    .filter((row) => row.status === 'missing')
    .map((row) => `${row.label}缺失`);

  return { rows, attentionItems };
}

export function buildAccidentSection(policies = []) {
  const groupMap = new Map();

  for (const policy of policies) {
    const member = memberName(policy);
    if (!groupMap.has(member)) groupMap.set(member, []);
    groupMap.get(member).push(policy);
  }

  return {
    members: Array.from(groupMap, ([member, memberPolicies]) => {
      const activeMemberPolicies = activePolicies(memberPolicies);
      const inactiveMemberPolicies = inactivePolicies(memberPolicies);
      return {
        member,
        ...buildMemberAccidentRows(activeMemberPolicies, inactiveMemberPolicies),
      };
    }),
  };
}

function effectiveYear(policy) {
  const year = new Date(policy?.date).getFullYear();
  return Number.isFinite(year) ? year : 0;
}

function cashValueRows(policy) {
  const startYear = effectiveYear(policy);
  const rows = Array.isArray(policy?.cashValues) ? policy.cashValues : [];

  return rows
    .map((row) => {
      const policyYear = finiteNumber(row?.policyYear);
      const cashValue = finiteNumber(row?.cashValue);
      if (policyYear === null || cashValue === null) return null;

      return {
        policyYear,
        age: finiteNumber(row?.age),
        calendarYear: startYear > 0 ? startYear + policyYear - 1 : 0,
        cashValue,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.policyYear - b.policyYear);
}

function cashflowRows(policy) {
  const rows = Array.isArray(policy?.cashflowEntries) ? policy.cashflowEntries : [];

  return rows
    .map((row) => {
      const year = finiteNumber(row?.year);
      const amount = finiteNumber(row?.amount);
      if (year === null || amount === null) return null;

      return {
        year,
        age: finiteNumber(row?.age),
        amount,
        cumulative: asNumber(row?.cumulative),
        liability: String(row?.liability || ''),
        policyId: row?.policyId ?? policy?.id,
        productName: String(row?.productName || policy?.name || ''),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.year - b.year);
}

function insuredBirthYear(policy) {
  const year = new Date(policy?.insuredBirthday).getFullYear();
  return Number.isFinite(year) ? year : null;
}

function annualCashflowRows(policy, payouts, values) {
  const cashValueByDisplayYear = new Map();
  const cashValueMeta = new Map();

  for (const row of values) {
    const displayYear = row.calendarYear || row.policyYear;
    cashValueByDisplayYear.set(displayYear, row.cashValue);
    cashValueMeta.set(displayYear, row);
  }

  const payoutByYear = new Map();
  for (const row of payouts) {
    if (!payoutByYear.has(row.year)) {
      payoutByYear.set(row.year, {
        year: row.year,
        age: row.age,
        amount: 0,
        cumulative: 0,
        liabilities: [],
      });
    }
    const grouped = payoutByYear.get(row.year);
    grouped.amount += row.amount;
    grouped.cumulative = Math.max(grouped.cumulative, asNumber(row.cumulative));
    if (grouped.age === null && row.age !== null) grouped.age = row.age;
    if (row.liability && !grouped.liabilities.includes(row.liability)) grouped.liabilities.push(row.liability);
  }

  const knownYears = [
    ...payouts.map((row) => row.year),
    ...values.map((row) => row.calendarYear || row.policyYear),
  ].filter((year) => year > 0);
  if (!knownYears.length) return [];

  const minYear = Math.min(...knownYears);
  const maxYear = Math.max(...knownYears);
  const years = maxYear - minYear <= 120
    ? Array.from({ length: maxYear - minYear + 1 }, (_, index) => minYear + index)
    : Array.from(new Set(knownYears)).sort((a, b) => a - b);
  const inferredBirthYear = [
    ...payouts.map((row) => (row.age === null ? null : row.year - row.age)),
    ...values.map((row) => (row.calendarYear > 0 && row.age !== null ? row.calendarYear - row.age : null)),
    insuredBirthYear(policy),
  ].find((year) => typeof year === 'number' && Number.isFinite(year));

  let runningCumulative = 0;
  return years.map((year) => {
    const payout = payoutByYear.get(year);
    if (payout?.amount > 0) runningCumulative += payout.amount;
    const meta = cashValueMeta.get(year);
    const age = payout?.age ?? meta?.age ?? (year > 1900 && inferredBirthYear ? year - inferredBirthYear : null);

    return {
      year,
      age,
      amount: payout?.amount ?? 0,
      cumulative: payout ? Math.max(payout.cumulative, runningCumulative) : 0,
      cashValue: cashValueByDisplayYear.get(year) ?? null,
      liabilities: payout?.liabilities ?? [],
    };
  });
}

function isWealthPolicy(policy) {
  if (cashValueRows(policy).length > 0) return true;
  if (cashflowRows(policy).length > 0) return true;

  const text = [
    policy?.company,
    policy?.name,
    policy?.coveragePeriod,
    ...activePlans(policy).map((plan) => {
      if (typeof plan === 'string') return plan;
      return [plan?.name, plan?.title, plan?.liability, plan?.type].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).map((item) => {
      if (typeof item === 'string') return item;
      return [
        item?.name,
        item?.title,
        item?.liability,
        item?.type,
        item?.coverageType,
        item?.scenario,
        item?.payout,
        item?.note,
      ].filter(Boolean).join(' ');
    }),
  ].filter(Boolean).join(' ').normalize('NFKC');

  return /(年金|教育金|生存金|满期|分红|万能|现金价值|终身寿|增额)/u.test(text);
}

function premiumOutflows(policy) {
  const startYear = effectiveYear(policy);
  const paymentYears = parsePaymentYears(policy?.paymentPeriod);
  const amount = asNumber(policy?.firstPremium);
  if (paymentYears === null || startYear <= 0 || amount <= 0) return [];

  return Array.from({ length: paymentYears }, (_, index) => ({
    year: startYear + index,
    amount,
    policyId: policy?.id,
    productName: String(policy?.name || ''),
  }));
}

function buildWealthPolicyReport(policy) {
  const payouts = cashflowRows(policy);
  const values = cashValueRows(policy);
  const firstPayout = payouts.find((row) => row.amount > 0);
  const highestPayout = payouts.reduce((highest, row) => (!highest || row.amount > highest.amount ? row : highest), null);
  const lastCashValue = values[values.length - 1];
  const attentionItems = [
    values.length > 0 && effectiveYear(policy) <= 0 ? '生效日待补充' : null,
    asNumber(policy?.firstPremium) > 0 && parsePaymentYears(policy?.paymentPeriod) === null ? '缴费期待补充' : null,
  ].filter(Boolean);

  return {
    policyId: policy?.id,
    productName: String(policy?.name || ''),
    company: String(policy?.company || ''),
    annualPremium: asNumber(policy?.firstPremium),
    cashflowRows: payouts,
    cashValueRows: values,
    annualCashflowRows: annualCashflowRows(policy, payouts, values),
    attentionItems,
    keyPoints: [
      firstPayout
        ? { label: '开始领取', value: String(firstPayout.year), amount: firstPayout.amount }
        : null,
      highestPayout
        ? { label: '单年最高领取', value: String(highestPayout.year), amount: highestPayout.amount }
        : null,
      lastCashValue
        ? { label: '末期现金价值', value: String(lastCashValue.calendarYear), amount: lastCashValue.cashValue }
        : null,
    ].filter(Boolean),
  };
}

export function buildWealthSection(policies = []) {
  const wealthPolicies = activePolicies(policies).filter(isWealthPolicy);
  const groupMap = new Map();

  for (const policy of wealthPolicies) {
    const member = memberName(policy);
    if (!groupMap.has(member)) groupMap.set(member, []);
    groupMap.get(member).push(policy);
  }

  const memberReports = Array.from(groupMap, ([member, memberPolicies]) => {
    const reports = memberPolicies.map(buildWealthPolicyReport);
    const attentionItems = [
      ...reports
        .filter((policyReport) => policyReport.cashValueRows.length === 0)
        .map((policyReport) => `${policyReport.productName || '未命名保单'}缺少现金价值表`),
      ...new Set(reports.flatMap((policyReport) => policyReport.attentionItems)),
    ];

    return {
      member,
      policies: reports,
      attentionItems,
    };
  });

  const aggregateMap = new Map();
  const ensureRow = (year) => {
    if (!aggregateMap.has(year)) {
      aggregateMap.set(year, {
        year,
        premiumOutflow: 0,
        payoutInflow: 0,
        netCashflow: 0,
        cumulativeNetCashflow: 0,
        cashValueTotal: 0,
        details: [],
      });
    }
    return aggregateMap.get(year);
  };

  for (const policy of wealthPolicies) {
    const member = memberName(policy);
    const policyId = policy?.id;
    const productName = String(policy?.name || '');

    for (const outflow of premiumOutflows(policy)) {
      const row = ensureRow(outflow.year);
      row.premiumOutflow += outflow.amount;
      row.details.push({
        type: 'premium',
        member,
        policyId,
        productName,
        amount: outflow.amount,
      });
    }

    for (const payout of cashflowRows(policy)) {
      const row = ensureRow(payout.year);
      row.payoutInflow += payout.amount;
      row.details.push({
        type: 'payout',
        member,
        policyId,
        productName,
        liability: payout.liability,
        amount: payout.amount,
      });
    }

    for (const value of cashValueRows(policy)) {
      if (value.calendarYear <= 0) continue;

      const row = ensureRow(value.calendarYear);
      row.cashValueTotal += value.cashValue;
      row.details.push({
        type: 'cashValue',
        member,
        policyId,
        productName,
        policyYear: value.policyYear,
        calendarYear: value.calendarYear,
        age: value.age,
        amount: value.cashValue,
      });
    }
  }

  let cumulativeNetCashflow = 0;
  const aggregateRows = Array.from(aggregateMap.values())
    .sort((a, b) => a.year - b.year)
    .map((row) => {
      row.netCashflow = row.payoutInflow - row.premiumOutflow;
      cumulativeNetCashflow += row.netCashflow;
      row.cumulativeNetCashflow = cumulativeNetCashflow;
      return row;
    });

  const peakPayoutRow = aggregateRows.reduce((peak, row) => {
    if (row.payoutInflow <= 0) return peak;
    return !peak || row.payoutInflow > peak.payoutInflow ? row : peak;
  }, null);

  return {
    memberReports,
    aggregateRows,
    keyPoints: [
      peakPayoutRow
        ? { label: '领取高峰年', value: String(peakPayoutRow.year), amount: peakPayoutRow.payoutInflow }
        : null,
    ].filter(Boolean),
  };
}

const RADAR_DIMENSIONS = [
  { key: 'critical', label: '重疾' },
  { key: 'accident', label: '意外' },
  { key: 'medical', label: '医疗' },
  { key: 'life', label: '寿险' },
  { key: 'wealth', label: '财富' },
];

const FAMILY_PLANNING_DEFAULTS = {
  criticalRecoveryYears: 3,
  criticalRecoveryReserve: 200000,
  medicalTarget: 3000000,
  accidentExpenseYears: 5,
  lifeExpenseYears: 10,
  wealthDiscountRate: 0.03,
};

const ACCIDENT_RADAR_WEIGHTS = {
  general_accident: 1,
  sudden_death: 1,
  driving: 0.5,
  traffic: 0.3,
  public_transport: 0.3,
  rail_ship: 0.3,
  aviation: 0.2,
};

const MEMBER_TARGET_WEIGHTS = {
  critical: { adult: 1, child: 0.55, elder: 0.35 },
  accident: { adult: 1, child: 0.25, elder: 0.35 },
  life: { adult: 1, child: 0, elder: 0.1 },
};

function formatRadarMoney(value) {
  return `${formatNumberText(value)}元`;
}

function formatPercentText(value) {
  return `${Math.round(asNumber(value))}%`;
}

function planningNumber(value) {
  return Math.max(0, asNumber(value));
}

function normalizeFamilyPlanningProfile(profile = {}) {
  return {
    annualExpense: planningNumber(profile?.annualExpense),
    debt: planningNumber(profile?.debt),
    educationGoal: planningNumber(profile?.educationGoal),
    retirementGoal: planningNumber(profile?.retirementGoal),
    availableAssets: planningNumber(profile?.availableAssets),
  };
}

function hasFamilyPlanningProfile(profile = {}) {
  return Object.values(normalizeFamilyPlanningProfile(profile)).some((value) => value > 0);
}

function ageFromBirthday(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const year = new Date(text).getFullYear();
  if (!Number.isFinite(year)) return null;
  const age = new Date().getFullYear() - year;
  return age >= 0 && age < 130 ? age : null;
}

function memberRole(member, policies = []) {
  const nameText = String(member || '').normalize('NFKC');
  const relationText = policies.map((policy) => policy?.insuredRelation).filter(Boolean).join(' ').normalize('NFKC');
  const text = `${nameText} ${relationText}`;
  const ages = policies.map((policy) => ageFromBirthday(policy?.insuredBirthday)).filter((age) => age !== null);
  const age = ages.length ? Math.min(...ages) : null;

  if (/(子|女|儿|孩|宝宝|未成年|孙|外孙)/u.test(text) || (age !== null && age < 18)) return 'child';
  if (/(父母|父亲|母亲|公公|婆婆|岳父|岳母|爷爷|奶奶|外公|外婆|姥|祖)/u.test(relationText)
    || /(老人|爷爷|奶奶|外公|外婆|姥|祖)/u.test(nameText)
    || (age !== null && age >= 60)) return 'elder';
  return 'adult';
}

function memberRoleLabel(role) {
  if (role === 'child') return '子女';
  if (role === 'elder') return '长辈';
  return '成人';
}

function familyPlanningTargets(profile = {}) {
  const normalized = normalizeFamilyPlanningProfile(profile);
  const annualExpense = normalized.annualExpense;
  const debt = normalized.debt;
  const educationGoal = normalized.educationGoal;
  const retirementGoal = normalized.retirementGoal;
  const availableAssets = normalized.availableAssets;

  return {
    critical: annualExpense * FAMILY_PLANNING_DEFAULTS.criticalRecoveryYears + FAMILY_PLANNING_DEFAULTS.criticalRecoveryReserve,
    medical: FAMILY_PLANNING_DEFAULTS.medicalTarget,
    accident: Math.max(
      annualExpense * FAMILY_PLANNING_DEFAULTS.accidentExpenseYears,
      debt + annualExpense * FAMILY_PLANNING_DEFAULTS.accidentExpenseYears - availableAssets,
      0,
    ),
    life: Math.max(
      debt + educationGoal + annualExpense * FAMILY_PLANNING_DEFAULTS.lifeExpenseYears - availableAssets,
      0,
    ),
    wealth: Math.max(educationGoal + retirementGoal, 0),
  };
}

const fallbackPolicySourceKeys = new WeakMap();
let fallbackPolicySourceKeyIndex = 0;

function policySourceKey(policy) {
  const policyId = policy?.id;
  if (policyId !== undefined && policyId !== null && String(policyId).trim() !== '') return `policy:${policyId}`;
  if (policy && typeof policy === 'object') {
    if (!fallbackPolicySourceKeys.has(policy)) {
      fallbackPolicySourceKeyIndex += 1;
      fallbackPolicySourceKeys.set(policy, `policy:fallback:${fallbackPolicySourceKeyIndex}`);
    }
    return fallbackPolicySourceKeys.get(policy);
  }
  return 'policy:fallback:unknown';
}

function radarPolicyText(policy) {
  return [
    policy?.company,
    policy?.name,
    policy?.coveragePeriod,
    policy?.report,
    policy?.ocrText,
    ...activePlans(policy).map((plan) => {
      if (typeof plan === 'string') return plan;
      return [plan?.name, plan?.title, plan?.liability, plan?.type, plan?.matchedProductName].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).map((item) => {
      if (typeof item === 'string') return item;
      return [
        item?.name,
        item?.title,
        item?.liability,
        item?.type,
        item?.coverageType,
        item?.scenario,
        item?.payout,
        item?.note,
      ].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [])
      .filter((indicator) => !indicatorPlanIsInactive(policy, indicator))
      .map(indicatorText),
  ].filter(Boolean).join(' ').normalize('NFKC');
}

function indicatorIsFormulaOnly(indicator, policy = {}) {
  const unit = String(indicator?.unit || '').normalize('NFKC');
  return unit === '公式' && resolveIndicatorAmount(indicator, policy) <= 0;
}

function indicatorAmountForPolicy(indicator, policy) {
  if (indicatorIsFormulaOnly(indicator, policy)) return 0;
  return resolveIndicatorAmount(indicator, policy);
}

function amountPartsTotal(parts) {
  return parts.reduce((total, part) => total + asNumber(part.amount), 0);
}

function uniquePolicyCount(parts) {
  return new Set(parts.map((part) => part.sourceKey || sourcePolicyKey(part)).filter(Boolean)).size;
}

function compactRadarLabel(value, fallback = '已识别责任') {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!normalized) return fallback;

  const firstPhrase = normalized.split(/[。；;\n\r]/u)[0]?.trim() || normalized;
  if (firstPhrase.length > 24) return fallback;
  return firstPhrase;
}

function accidentScenarioWeight(definitions) {
  const weights = definitions
    .map((definition) => ACCIDENT_RADAR_WEIGHTS[definition.key] || 0)
    .filter((weight) => weight > 0);
  return weights.length ? Math.max(...weights) : 1;
}

function radarAmountDetailFromPart(part) {
  const amount = asNumber(part?.amount);
  if (amount <= 0) return null;
  const company = String(part?.company || '').trim();
  const productName = String(part?.productName || '').trim();
  const liability = String(part?.liability || '').trim();
  const label = compactRadarLabel(part?.label || productName || liability, '已识别责任');
  const calculationText = String(part?.calculationText || '').trim();
  return {
    sourceKey: part?.sourceKey,
    policyId: part?.policyId,
    company,
    productName,
    liability,
    label,
    amount,
    amountText: formatRadarMoney(amount),
    calculationText: calculationText || `${label} = ${formatRadarMoney(amount)}`,
  };
}

function radarAmountResult(amount, parts, fallbackNote = '') {
  const amountParts = parts.filter((part) => asNumber(part.amount) > 0);
  const amountDetails = amountParts
    .map(radarAmountDetailFromPart)
    .filter(Boolean);
  const effectiveAmount = amount > 0
    ? (
      amountParts.length
        ? amountParts.reduce((total, part) => total + asNumber(part.effectiveAmount ?? part.amount), 0)
        : amount
    )
    : 0;
  const note = amount > 0
    ? (
      amountParts.length
        ? amountParts.map((part) => `${compactRadarLabel(part.label)}${formatNumberText(part.amount)}`).join('，')
        : `合计${formatNumberText(amount)}，来源${parts.map((part) => compactRadarLabel(part.label)).filter(Boolean).join('、') || '已识别责任'}`
    )
    : fallbackNote || '未识别到可落地金额';
  return {
    amount,
    effectiveAmount,
    policyCount: uniquePolicyCount(parts),
    note,
    amountDetails,
  };
}

function criticalRadarAmount(policies) {
  const { rows } = buildMemberCriticalRows(policies);
  const first = rows.find((row) => row.key === 'critical_first');
  const formulaOnly = rows.some((row) => row.status === 'formula');
  const amount = asNumber(first?.amount);
  const sourceParts = amount > 0
    ? (first?.sourcePolicies || []).map((source) => ({
      sourceKey: sourcePolicyKey(source),
      policyId: source.policyId,
      label: source.productName || source.liability || '重疾保额',
      company: source.company,
      productName: source.productName,
      liability: source.liability,
      amount: source.amount,
      calculationText: source.calculationText || source.formulaText,
    }))
    : [];
  return radarAmountResult(
    amount,
    sourceParts,
    formulaOnly ? '公式型待确认' : '未识别到可落地金额',
  );
}

const ACCIDENT_RADAR_ROW_KEYS = new Set(['general_accident', 'traffic', 'driving', 'public_transport', 'aviation', 'rail_ship', 'sudden_death']);

function accidentIndicatorRadarAmount(indicator, policy) {
  if (!indicatorImpliesAccident(indicator)) return null;
  if (indicatorPlanIsInactive(policy, indicator)) return null;
  const definitions = classifyAccidentIndicatorDefinitions(indicator)
    .filter((definition) => ACCIDENT_RADAR_ROW_KEYS.has(definition.key));
  if (!definitions.length) return null;

  const amount = indicatorAmountForPolicy(indicator, policy);
  if (amount <= 0) return null;
  const weight = accidentScenarioWeight(definitions);

  return {
    sourceKey: policySourceKey(policy),
    scenarioKey: [
      policySourceKey(policy),
      normalizeProductName(indicator?.liability || 'accident'),
      normalizeProductName(indicator?.scenario || ''),
      definitions.map((definition) => definition.key).sort().join('|'),
    ].join(':scenario:'),
    policyId: policy?.id,
    label: compactRadarLabel(indicator?.liability || indicator?.scenario, definitions[0]?.label || '意外保障'),
    company: String(policy?.company || ''),
    productName: indicatorSourceProductName(policy, indicator),
    liability: String(indicator?.liability || indicator?.scenario || ''),
    amount,
    effectiveAmount: amount * weight,
    weight,
    calculationText: indicatorAmountCalculationText(indicator, policy, amount),
  };
}

function accidentRadarAmount(policies) {
  const bestByScenario = new Map();

  for (const policy of policies) {
    const candidates = [];
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      const part = accidentIndicatorRadarAmount(indicator, policy);
      if (part) candidates.push(part);
    }

    const responsibilities = Array.isArray(policy?.responsibilities) ? policy.responsibilities : [];
    for (const responsibility of responsibilities) {
      const part = accidentIndicatorRadarAmount(responsibilityToAccidentIndicator(responsibility, policy), policy);
      if (part) candidates.push(part);
    }

    if (!indicators.length && !responsibilities.length && textImpliesAccident(accidentPolicyText(policy))) {
      const part = accidentIndicatorRadarAmount(fallbackPolicyIndicator(policy), policy);
      if (part) candidates.push(part);
    }

    for (const part of candidates) {
      const previous = bestByScenario.get(part.scenarioKey);
      if (!previous || part.amount > previous.amount) {
        bestByScenario.set(part.scenarioKey, part);
      }
    }
  }

  const parts = Array.from(bestByScenario.values());
  return radarAmountResult(amountPartsTotal(parts), parts);
}

function medicalRadarAmount(policies) {
  const parts = [];
  let hasFormula = false;
  for (const policy of policies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      const text = indicatorText(indicator);
      if (!/(医疗|住院|门诊|报销|百万医疗|手术|医疗费用)/u.test(text)) continue;
      if (indicatorPlanIsInactive(policy, indicator)) continue;
      if (indicatorIsFormulaOnly(indicator, policy)) {
        hasFormula = true;
        continue;
      }
      const amount = indicatorAmountForPolicy(indicator, policy);
      if (amount > 0) {
        parts.push({
          sourceKey: policySourceKey(policy),
          policyId: policy?.id,
          label: String(indicator?.liability || '医疗额度'),
          company: String(policy?.company || ''),
          productName: indicatorSourceProductName(policy, indicator),
          liability: String(indicator?.liability || ''),
          amount,
          calculationText: indicatorAmountCalculationText(indicator, policy, amount),
        });
      }
    }
    const sourceKey = policySourceKey(policy);
    if (!parts.some((part) => part.sourceKey === sourceKey) && /(医疗|住院|门诊|报销|百万医疗|手术|医疗费用)/u.test(radarPolicyText(policy))) {
      const amount = asNumber(policy?.amount);
      if (amount > 0) {
        parts.push({
          sourceKey,
          policyId: policy?.id,
          label: '医疗额度',
          company: String(policy?.company || ''),
          productName: String(policy?.name || ''),
          liability: '医疗额度',
          amount,
          calculationText: `保单基础保额${formatRadarMoney(amount)} = ${formatRadarMoney(amount)}`,
        });
      }
    }
  }
  return radarAmountResult(amountPartsTotal(parts), parts, hasFormula ? '公式型待确认' : '未识别到可落地金额');
}

function lifeRadarAmount(policies) {
  const parts = [];
  let hasFormula = false;
  for (const policy of policies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      const text = indicatorText(indicator);
      if (!/(身故|全残|终身寿|人寿保障|护理)/u.test(text)) continue;
      if (indicatorImpliesAccident(indicator)) continue;
      if (/(重疾|重大疾病|中症|轻症|恶性肿瘤|癌)/u.test(text)) continue;
      if (indicatorPlanIsInactive(policy, indicator)) continue;
      if (indicatorIsFormulaOnly(indicator, policy)) {
        hasFormula = true;
        continue;
      }
      const amount = indicatorAmountForPolicy(indicator, policy);
      if (amount > 0) {
        parts.push({
          sourceKey: policySourceKey(policy),
          policyId: policy?.id,
          label: String(indicator?.liability || '寿险保额'),
          company: String(policy?.company || ''),
          productName: indicatorSourceProductName(policy, indicator),
          liability: String(indicator?.liability || ''),
          amount,
          calculationText: indicatorAmountCalculationText(indicator, policy, amount),
        });
      }
    }
    const text = radarPolicyText(policy);
    const sourceKey = policySourceKey(policy);
    if (!parts.some((part) => part.sourceKey === sourceKey) && /(终身寿|人寿|寿险|身故|全残|护理)/u.test(text) && !/(重疾|意外)/u.test(text)) {
      const amount = asNumber(policy?.amount);
      if (amount > 0) {
        parts.push({
          sourceKey,
          policyId: policy?.id,
          label: '寿险保额',
          company: String(policy?.company || ''),
          productName: String(policy?.name || ''),
          liability: '寿险保额',
          amount,
          calculationText: `保单基础保额${formatRadarMoney(amount)} = ${formatRadarMoney(amount)}`,
        });
      }
    }
  }
  return radarAmountResult(amountPartsTotal(parts), parts, hasFormula ? '公式型待确认' : '未识别到可落地金额');
}

function futurePayoutPresentValue(policy, discountRate = FAMILY_PLANNING_DEFAULTS.wealthDiscountRate) {
  const currentYear = new Date().getFullYear();
  return cashflowRows(policy).reduce((total, row) => {
    const years = Math.max(0, asNumber(row.year) - currentYear);
    const divisor = (1 + discountRate) ** years;
    return total + (asNumber(row.amount) / divisor);
  }, 0);
}

function wealthRadarAmount(policies) {
  const cashValue = policies.reduce((total, policy) => total + (latestCashValue(policy)?.cashValue || 0), 0);
  const futurePayout = policies.reduce((total, policy) => total + futurePayoutTotal(policy), 0);
  const futurePayoutPresent = policies.reduce((total, policy) => total + futurePayoutPresentValue(policy), 0);
  const amount = cashValue + futurePayout;
  const amountDetails = [];
  for (const policy of policies) {
    const sourceKey = policySourceKey(policy);
    const company = String(policy?.company || '');
    const productName = String(policy?.name || '');
    const policyCashValue = latestCashValue(policy)?.cashValue || 0;
    if (policyCashValue > 0) {
      amountDetails.push(radarAmountDetailFromPart({
        sourceKey: `${sourceKey}:cash-value`,
        policyId: policy?.id,
        company,
        productName,
        label: productName || '现金价值',
        liability: '现金价值',
        amount: policyCashValue,
        calculationText: `最新现金价值 = ${formatRadarMoney(policyCashValue)}`,
      }));
    }

    const policyFuturePayout = futurePayoutTotal(policy);
    if (policyFuturePayout > 0) {
      amountDetails.push(radarAmountDetailFromPart({
        sourceKey: `${sourceKey}:future-payout`,
        policyId: policy?.id,
        company,
        productName,
        label: productName || '未来领取',
        liability: '未来领取',
        amount: policyFuturePayout,
        calculationText: `未来确定领取合计 = ${formatRadarMoney(policyFuturePayout)}`,
      }));
    }
  }
  return {
    amount,
    effectiveAmount: cashValue + futurePayoutPresent,
    policyCount: policies.filter((policy) => (latestCashValue(policy)?.cashValue || 0) > 0 || futurePayoutTotal(policy) > 0).length,
    note: amount > 0 ? `现金价值${formatNumberText(cashValue)}，未来领取${formatNumberText(futurePayout)}` : '未识别到可落地金额',
    amountDetails: amountDetails.filter(Boolean),
  };
}

function radarAmountForDimension(policies, key) {
  if (key === 'critical') return criticalRadarAmount(policies);
  if (key === 'accident') return accidentRadarAmount(policies);
  if (key === 'medical') return medicalRadarAmount(policies);
  if (key === 'life') return lifeRadarAmount(policies);
  return wealthRadarAmount(policies);
}

function buildRadarScores(policies) {
  return RADAR_DIMENSIONS.map((dimension) => {
    const result = radarAmountForDimension(policies, dimension.key);
    const effectiveAmount = asNumber(result.effectiveAmount ?? result.amount);
    return {
      key: dimension.key,
      label: dimension.label,
      amount: result.amount,
      effectiveAmount,
      score: 0,
      amountText: formatRadarMoney(result.amount),
      effectiveAmountText: formatRadarMoney(effectiveAmount),
      policyCount: result.policyCount,
      note: result.note,
      amountDetails: result.amountDetails || [],
    };
  });
}

function normalizeFamilyScores(scores, planningProfile = null) {
  if (hasFamilyPlanningProfile(planningProfile)) {
    const targets = familyPlanningTargets(planningProfile);
    return normalizeScoresAgainstTargets(scores, targets, 'family');
  }

  const maxAmount = Math.max(0, ...scores.map(structureScoreBase));
  return scores.map((score) => ({
    ...score,
    score: maxAmount > 0 ? Math.round((structureScoreBase(score) / maxAmount) * 100) : 0,
  }));
}

function structureScoreBase(score) {
  const amount = score.key === 'accident'
    ? asNumber(score.effectiveAmount ?? score.amount)
    : asNumber(score.amount);
  return Math.sqrt(Math.max(0, amount));
}

function normalizeScoresAgainstTargets(scores, targets, targetSource) {
  return scores.map((score) => {
    const target = asNumber(targets?.[score.key]);
    const effectiveAmount = asNumber(score.effectiveAmount ?? score.amount);
    const adequacyRate = target > 0 ? (effectiveAmount / target) * 100 : 0;
    const gap = target > 0 ? Math.max(target - effectiveAmount, 0) : 0;
    const over = target > 0 ? Math.max(effectiveAmount - target, 0) : 0;
    return {
      ...score,
      target,
      targetText: formatRadarMoney(target),
      gap,
      gapText: formatRadarMoney(gap),
      over,
      overText: formatRadarMoney(over),
      adequacyRate,
      adequacyText: formatPercentText(adequacyRate),
      targetSource,
      score: target > 0 ? Math.min(Math.round(adequacyRate), 100) : 0,
    };
  });
}

function normalizeMemberStructureScores(memberSeries) {
  return memberSeries.map((series) => ({
    ...series,
    scores: series.scores.map((score) => {
      const maxAmount = Math.max(0, ...series.scores.map(structureScoreBase));
      return {
        ...score,
        score: maxAmount > 0 ? Math.round((structureScoreBase(score) / maxAmount) * 100) : 0,
      };
    }),
  }));
}

function distributeTarget(memberSeries, totalTarget, weightsByRole) {
  const weights = memberSeries.map((series) => Math.max(0, weightsByRole?.[series.role] ?? 1));
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  if (totalTarget <= 0) return new Map(memberSeries.map((series) => [series.name, 0]));
  if (weightTotal <= 0) {
    const equalTarget = totalTarget / Math.max(memberSeries.length, 1);
    return new Map(memberSeries.map((series) => [series.name, equalTarget]));
  }
  return new Map(memberSeries.map((series, index) => [series.name, totalTarget * (weights[index] / weightTotal)]));
}

function memberEstimatedTargets(memberSeries, planningProfile) {
  const normalized = normalizeFamilyPlanningProfile(planningProfile);
  const familyTargets = familyPlanningTargets(normalized);
  const criticalTargets = distributeTarget(memberSeries, familyTargets.critical, MEMBER_TARGET_WEIGHTS.critical);
  const accidentTargets = distributeTarget(memberSeries, familyTargets.accident, MEMBER_TARGET_WEIGHTS.accident);
  const lifeTargets = distributeTarget(memberSeries, familyTargets.life, MEMBER_TARGET_WEIGHTS.life);
  const children = memberSeries.filter((series) => series.role === 'child');
  const retirementMembers = memberSeries.filter((series) => series.role !== 'child');
  const educationTargets = distributeTarget(children.length ? children : memberSeries, normalized.educationGoal, {});
  const retirementTargets = distributeTarget(retirementMembers.length ? retirementMembers : memberSeries, normalized.retirementGoal, {});

  return new Map(memberSeries.map((series) => [
    series.name,
    {
      critical: criticalTargets.get(series.name) || 0,
      medical: FAMILY_PLANNING_DEFAULTS.medicalTarget,
      accident: accidentTargets.get(series.name) || 0,
      life: lifeTargets.get(series.name) || 0,
      wealth: (educationTargets.get(series.name) || 0) + (retirementTargets.get(series.name) || 0),
    },
  ]));
}

function normalizeMemberEstimatedScores(memberSeries, planningProfile) {
  const targetsByMember = memberEstimatedTargets(memberSeries, planningProfile);
  return memberSeries.map((series) => ({
    ...series,
    targetSource: 'system_estimate',
    scores: normalizeScoresAgainstTargets(series.scores, targetsByMember.get(series.name), 'system_estimate'),
  }));
}

function buildRadarSeries(name, policies) {
  const scores = buildRadarScores(policies);
  const totalAmount = scores.reduce((total, score) => total + score.amount, 0);
  const missingLabels = scores.filter((score) => score.amount <= 0).map((score) => score.label);
  const role = memberRole(name, policies);
  return {
    name,
    role,
    roleLabel: memberRoleLabel(role),
    scores,
    totalAmount,
    notes: missingLabels.length ? [`缺口维度: ${missingLabels.join('、')}`] : [],
  };
}

function selectDisplayedRadarMembers(memberSeries) {
  if (memberSeries.length <= 4) return { members: memberSeries, hiddenMembers: [] };
  const byHigh = [...memberSeries].sort((a, b) => b.totalAmount - a.totalAmount);
  const lowest = [...memberSeries].sort((a, b) => a.totalAmount - b.totalAmount)[0];
  const selected = [];
  for (const series of [...byHigh.slice(0, 3), lowest, ...byHigh]) {
    if (selected.length >= 4) break;
    if (!selected.some((item) => item.name === series.name)) selected.push(series);
  }
  return {
    members: selected,
    hiddenMembers: memberSeries.filter((series) => !selected.some((item) => item.name === series.name)),
  };
}

export function buildFamilyRadarReport(policies = [], planningProfile = null) {
  const reportPolicies = activePolicies(policies);
  const familyScores = buildRadarScores(reportPolicies);
  const normalizedPlanningProfile = normalizeFamilyPlanningProfile(planningProfile);
  const planningEnabled = hasFamilyPlanningProfile(normalizedPlanningProfile);
  const family = {
    name: '全家',
    scores: normalizeFamilyScores(familyScores, planningEnabled ? normalizedPlanningProfile : null),
    totalAmount: familyScores.reduce((total, score) => total + score.amount, 0),
    notes: familyScores.some((score) => score.amount <= 0)
      ? [`缺口维度: ${familyScores.filter((score) => score.amount <= 0).map((score) => score.label).join('、')}`]
      : [],
  };

  const groupMap = new Map();
  for (const policy of reportPolicies) {
    const member = memberName(policy);
    if (!groupMap.has(member)) groupMap.set(member, []);
    groupMap.get(member).push(policy);
  }

  const rawMembers = Array.from(groupMap, ([member, memberPolicies]) => buildRadarSeries(member, memberPolicies));
  const allMembers = planningEnabled
    ? normalizeMemberEstimatedScores(rawMembers, normalizedPlanningProfile)
    : normalizeMemberStructureScores(rawMembers);
  const { members, hiddenMembers } = selectDisplayedRadarMembers(allMembers);

  return {
    dimensions: RADAR_DIMENSIONS,
    mode: planningEnabled ? 'planning' : 'structure',
    planningProfile: planningEnabled ? normalizedPlanningProfile : null,
    planningTargets: planningEnabled ? familyPlanningTargets(normalizedPlanningProfile) : null,
    assumptions: FAMILY_PLANNING_DEFAULTS,
    family,
    members,
    hiddenMembers,
  };
}

export function buildFamilyReportSummary(policies = []) {
  const reportPolicies = activePolicies(policies);
  const members = new Set(policies.map(memberName));
  return {
    memberCount: members.size,
    policyCount: reportPolicies.length,
    annualPremium: reportPolicies.reduce((total, policy) => total + asNumber(policy?.firstPremium), 0),
    totalCoverage: reportPolicies.reduce((total, policy) => total + asNumber(policy?.amount), 0),
    cashValueTotal: reportPolicies.reduce((total, policy) => total + (latestCashValue(policy)?.cashValue || 0), 0),
    futurePayoutTotal: reportPolicies.reduce((total, policy) => total + futurePayoutTotal(policy), 0),
    attentionItems: [],
  };
}

export function buildPolicyInventory(policies = []) {
  const rows = policies.map(buildInventoryRow);
  const groupMap = new Map();

  for (const row of rows) {
    if (!groupMap.has(row.member)) {
      groupMap.set(row.member, {
        member: row.member,
        policies: [],
        annualPremium: 0,
        totalCoverage: 0,
        cashValueTotal: 0,
        futurePayoutTotal: 0,
      });
    }
    const group = groupMap.get(row.member);
    group.policies.push(row);
    if (!row.isInactive) {
      group.annualPremium += row.annualPremium;
      group.totalCoverage += row.coverage;
      group.cashValueTotal += row.cashValue;
      group.futurePayoutTotal += row.futurePayout;
    }
  }

  return {
    rows,
    insuredGroups: Array.from(groupMap.values()),
  };
}

export function buildFamilyReport(policies = [], planningProfile = null) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    criticalIllness: buildCriticalIllnessSection(policies),
    accident: buildAccidentSection(policies),
    wealth: buildWealthSection(policies),
    radar: buildFamilyRadarReport(policies, planningProfile),
    appendix: {
      policies: policies.map((policy) => ({
        policyId: policy.id,
        productName: String(policy.name || ''),
        ocrText: String(policy.ocrText || ''),
      })),
    },
  };
}
