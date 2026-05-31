function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function finiteNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDateParts(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/u);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { year, month, day };
    }
  }
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addYearsToDateParts(parts, years) {
  if (!parts || !Number.isFinite(years)) return null;
  const year = parts.year + years;
  const day = Math.min(parts.day, daysInMonth(year, parts.month));
  return { year, month: parts.month, day };
}

function formatDateParts(parts) {
  if (!parts) return '';
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

function datePartsToTime(parts) {
  return parts ? Date.UTC(parts.year, parts.month - 1, parts.day) : null;
}

function memberName(policy) {
  const name = String(policy?.insured || '').trim();
  return name || '未识别被保人';
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

function isSelectedCoverageIndicator(indicator = {}) {
  const scope = String(indicator?.responsibilityScope || 'basic');
  const status = String(indicator?.selectionStatus || (scope === 'optional' ? 'unknown' : 'selected'));
  const quantificationStatus = String(indicator?.quantificationStatus || 'pending_review');
  return scope !== 'optional' || (status === 'selected' && quantificationStatus === 'quantified');
}

function selectedCoverageIndicators(indicators = []) {
  return (Array.isArray(indicators) ? indicators : []).filter(isSelectedCoverageIndicator);
}

function policyTypeLabel(policy) {
  const indicatorType = uniqueJoinedText(selectedCoverageIndicators(policy?.coverageIndicators).map((indicator) => indicator?.productType));
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

  if (baseAmountPattern.test(text)) return baseAmount;

  return 0;
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
  const amount = resolveIndicatorAmount(indicator, policy);
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
    policyId: policy?.id,
    productName: String(indicator?.productName || policy?.name || ''),
    liability: String(indicator?.liability || ''),
    formulaText,
  });
}

function criticalPolicyText(policy) {
  return [
    policy?.name,
    policy?.report,
    policy?.ocrText,
    ...(Array.isArray(policy?.plans) ? policy.plans : []).map((plan) => {
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
    policyId: policy?.id,
    productName: String(policy?.name || ''),
    liability: '重疾首次给付',
    formulaText: '按保单基础保额估算',
  });
}

function buildMemberCriticalRows(memberPolicies) {
  const rowMap = new Map(CRITICAL_ROWS.map((definition) => [definition.key, baseProtectionRow(definition)]));
  const usableCriticalFirstPolicies = new Set();

  for (const policy of memberPolicies) {
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    for (const indicator of indicators) {
      if (indicatorIsAccidentCoverage(indicator)) continue;
      const definition = classifyByDefinitions(indicatorText(indicator), CRITICAL_ROWS);
      if (!definition) continue;
      const previousAmount = rowMap.get(definition.key).amount;
      applyIndicatorToRow(rowMap.get(definition.key), indicator, policy);
      if (definition.key === 'critical_first' && rowMap.get(definition.key).amount > previousAmount) {
        usableCriticalFirstPolicies.add(policy);
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
    if (policyImpliesCriticalIllness(policy) && !usableCriticalFirstPolicies.has(policy)) {
      applyFallbackPolicyToRow(criticalFirst, policy);
    }
  }

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
    members: Array.from(groupMap, ([member, memberPolicies]) => ({
      member,
      ...buildMemberCriticalRows(memberPolicies),
    })),
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
    ...(Array.isArray(policy?.plans) ? policy.plans : []).map((plan) => {
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
    policyId: policy?.id,
    productName: String(indicator?.productName || policy?.name || ''),
    liability: String(indicator?.liability || indicator?.scenario || ''),
    formulaText,
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
    productName: policy?.name,
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

function buildMemberAccidentRows(memberPolicies) {
  const rowMap = new Map(ACCIDENT_ROWS.map((definition) => [definition.key, baseProtectionRow(definition)]));

  for (const policy of memberPolicies) {
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    const indicatorRowKeys = new Set();

    for (const indicator of indicators) {
      if (!indicatorImpliesAccident(indicator)) continue;

      const definitions = classifyAccidentIndicatorDefinitions(indicator);
      for (const definition of definitions) {
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
    members: Array.from(groupMap, ([member, memberPolicies]) => ({
      member,
      ...buildMemberAccidentRows(memberPolicies),
    })),
  };
}

function effectiveDateParts(policy) {
  return parseDateParts(policy?.date || policy?.effectiveDate);
}

function effectiveYear(policy) {
  return effectiveDateParts(policy)?.year || 0;
}

function cashValueRows(policy) {
  const startDate = effectiveDateParts(policy);
  const rows = Array.isArray(policy?.cashValues) ? policy.cashValues : [];

  return rows
    .map((row) => {
      const policyYear = finiteNumber(row?.policyYear);
      const cashValue = finiteNumber(row?.cashValue);
      if (policyYear === null || cashValue === null) return null;
      const cashValueEndDate = startDate ? addYearsToDateParts(startDate, policyYear) : null;
      const cashValueDate = formatDateParts(cashValueEndDate);

      return {
        policyYear,
        age: finiteNumber(row?.age),
        calendarYear: cashValueEndDate?.year || 0,
        cashValueDate,
        cashValueDateLabel: cashValueDate || `第${policyYear}年末`,
        cashValueTime: datePartsToTime(cashValueEndDate),
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
    ...(Array.isArray(policy?.plans) ? policy.plans : []).map((plan) => {
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
        ? { label: '末期现金价值', value: lastCashValue.cashValueDateLabel || String(lastCashValue.calendarYear || lastCashValue.policyYear), amount: lastCashValue.cashValue }
        : null,
    ].filter(Boolean),
  };
}

export function buildWealthSection(policies = []) {
  const wealthPolicies = policies.filter(isWealthPolicy);
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

export function buildFamilyReportSummary(policies = []) {
  const members = new Set(policies.map(memberName));
  return {
    memberCount: members.size,
    policyCount: policies.length,
    annualPremium: policies.reduce((total, policy) => total + asNumber(policy?.firstPremium), 0),
    totalCoverage: policies.reduce((total, policy) => total + asNumber(policy?.amount), 0),
    cashValueTotal: policies.reduce((total, policy) => total + (latestCashValue(policy)?.cashValue || 0), 0),
    futurePayoutTotal: policies.reduce((total, policy) => total + futurePayoutTotal(policy), 0),
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
    group.annualPremium += row.annualPremium;
    group.totalCoverage += row.coverage;
    group.cashValueTotal += row.cashValue;
    group.futurePayoutTotal += row.futurePayout;
  }

  return {
    rows,
    insuredGroups: Array.from(groupMap.values()),
  };
}

function buildOptionalResponsibilityGaps(policies = []) {
  const gaps = [];
  for (const policy of Array.isArray(policies) ? policies : []) {
    for (const item of Array.isArray(policy?.optionalResponsibilities) ? policy.optionalResponsibilities : []) {
      if (String(item?.selectionStatus || '') !== 'selected') continue;
      if (String(item?.quantificationStatus || '') === 'quantified') continue;
      gaps.push({
        member: memberName(policy),
        policyId: policy?.id,
        productName: String(policy?.name || item?.productName || ''),
        liability: String(item?.liability || item?.title || '可选责任'),
        quantificationStatus: String(item?.quantificationStatus || 'pending_review'),
        quantificationReason: String(item?.quantificationReason || '缺少可计算结构化指标'),
      });
    }
  }
  return gaps;
}

export function buildFamilyReport(policies = []) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    optionalResponsibilityGaps: buildOptionalResponsibilityGaps(policies),
    criticalIllness: buildCriticalIllnessSection(policies),
    accident: buildAccidentSection(policies),
    wealth: buildWealthSection(policies),
    appendix: {
      policies: policies.map((policy) => ({
        policyId: policy.id,
        productName: String(policy.name || ''),
        ocrText: String(policy.ocrText || ''),
      })),
    },
  };
}
