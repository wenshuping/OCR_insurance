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

function policyTypeLabel(policy) {
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
  ].filter(Boolean).join(' ');

  if (/(年金|终身寿|增额|分红|万能|两全|满期|生存金|财富|养老)/u.test(text)) return '财富/年金';
  if (/(重疾|重大疾病|轻症|中症|恶性肿瘤|癌)/u.test(text)) return '重疾';
  if (/(意外|伤残|身故|航空|交通)/u.test(text)) return '意外';
  if (/(医疗|住院|门诊|医保|百万医疗|手术)/u.test(text)) return '医疗';
  return '其他';
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
    productName: String(policy?.name || ''),
    typeLabel: policyTypeLabel(policy),
    annualPremium: asNumber(policy?.firstPremium),
    annualPremiumText: formatNumberText(policy?.firstPremium),
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

function classifyByDefinitions(text, definitions) {
  const normalized = String(text || '').normalize('NFKC');
  return definitions.find((definition) => definition.patterns.some((pattern) => pattern.test(normalized))) || null;
}

function resolveIndicatorAmount(indicator, policy) {
  const value = finiteNumber(indicator?.value);
  const unit = String(indicator?.unit || '').normalize('NFKC');
  const basis = String(indicator?.basis || '').normalize('NFKC');
  const text = indicatorText(indicator).normalize('NFKC');
  const policyAmount = asNumber(policy?.amount);
  const baseAmountPattern = /基本(?:保险金额|保额)/u;

  if (value !== null && unit === '%' && baseAmountPattern.test(basis)) {
    return policyAmount * value / 100;
  }

  if (value !== null && unit === '倍' && baseAmountPattern.test(basis)) {
    return policyAmount * value;
  }

  const formulaPercentMatch = text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/u);
  if (formulaPercentMatch) return policyAmount * asNumber(formulaPercentMatch[1]) / 100;

  const formulaMultipleMatch = text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*倍/u);
  if (formulaMultipleMatch) return policyAmount * asNumber(formulaMultipleMatch[1]);

  if (value !== null && /^(?:元|圆)$/u.test(unit)) return value;

  const wanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*万/u);
  if (wanMatch) return asNumber(wanMatch[1]) * 10000;

  const yuanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:元|圆)/u);
  if (yuanMatch) return asNumber(yuanMatch[1]);

  if (baseAmountPattern.test(text)) return policyAmount;

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
  row.sourcePolicies.push({
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
  row.sourcePolicies.push({
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
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
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

function classifyAccidentIndicator(indicator) {
  const specificTransportRows = ACCIDENT_ROWS.filter((definition) => (
    ['driving', 'public_transport', 'aviation', 'rail_ship'].includes(definition.key)
  ));

  const liabilityText = String(indicator?.liability || '').normalize('NFKC');
  const liabilityDefinition = classifyByDefinitions(liabilityText, specificTransportRows)
    || classifyByDefinitions(liabilityText, ACCIDENT_ROWS);
  if (liabilityDefinition) return liabilityDefinition;

  const text = indicatorText(indicator);
  return classifyByDefinitions(text, specificTransportRows) || classifyByDefinitions(text, ACCIDENT_ROWS);
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
  row.sourcePolicies.push({
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
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    const indicatorRowKeys = new Set();

    for (const indicator of indicators) {
      if (!indicatorImpliesAccident(indicator)) continue;

      const definition = classifyAccidentIndicator(indicator);
      if (!definition) continue;
      applyAccidentIndicatorToRow(rowMap.get(definition.key), definition, indicator, policy);
      indicatorRowKeys.add(definition.key);
    }

    const responsibilities = Array.isArray(policy?.responsibilities) ? policy.responsibilities : [];
    for (const responsibility of responsibilities) {
      const indicator = responsibilityToAccidentIndicator(responsibility, policy);
      if (!indicatorImpliesAccident(indicator)) continue;

      const definition = classifyAccidentIndicator(indicator);
      if (!definition) continue;
      const row = rowMap.get(definition.key);
      if (indicatorRowKeys.has(definition.key) && row.amount > 0) continue;
      applyAccidentIndicatorToRow(row, definition, indicator, policy);
    }

    if (indicators.length === 0 && responsibilities.length === 0 && textImpliesAccident(accidentPolicyText(policy))) {
      const indicator = fallbackPolicyIndicator(policy);
      const definition = classifyAccidentIndicator(indicator) || ACCIDENT_ROWS.find((item) => item.key === 'general_accident');
      applyAccidentIndicatorToRow(rowMap.get(definition.key), definition, indicator, policy);
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

export function buildFamilyReport(policies = []) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    criticalIllness: buildCriticalIllnessSection(policies),
    accident: buildAccidentSection(policies),
    wealth: { memberReports: [], aggregateRows: [], keyPoints: [] },
    appendix: {
      policies: policies.map((policy) => ({
        policyId: policy.id,
        productName: String(policy.name || ''),
        ocrText: String(policy.ocrText || ''),
      })),
    },
  };
}
