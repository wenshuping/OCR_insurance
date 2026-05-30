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
    key: 'critical_first',
    label: '重疾首次给付',
    patterns: [
      /重疾(?!.*(?:多次|第二次|第2次|再次))/u,
      /重大疾病(?!.*(?:多次|第二次|第2次|再次))/u,
      /重度疾病(?!.*(?:多次|第二次|第2次|再次))/u,
    ],
  },
  {
    key: 'critical_multiple',
    label: '重疾多次给付',
    patterns: [/多次/u, /第二次/u, /第2次/u, /再次/u],
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

  if (value !== null && unit === '%' && /基本(保险金额|保额)/u.test(basis)) {
    return policyAmount * value / 100;
  }

  if (value !== null && unit === '倍' && /基本(保险金额|保额)/u.test(basis)) {
    return policyAmount * value;
  }

  const wanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*万/u);
  if (wanMatch) return asNumber(wanMatch[1]) * 10000;

  const yuanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:元|圆)/u);
  if (yuanMatch) return asNumber(yuanMatch[1]);

  if (/基本(保险金额|保额)/u.test(text)) return policyAmount;

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

  row.amount = amount;
  row.amountText = amountDisplay(amount, formulaText || '待识别');
  row.countText = value !== null && unit ? `${formatNumberText(value)}${unit}` : formulaText || '-';
  row.status = amount > 0 ? 'covered' : 'formula';
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

function buildMemberCriticalRows(memberPolicies) {
  const rowMap = new Map(CRITICAL_ROWS.map((definition) => [definition.key, baseProtectionRow(definition)]));

  for (const policy of memberPolicies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      const definition = classifyByDefinitions(indicatorText(indicator), CRITICAL_ROWS);
      if (!definition) continue;
      applyIndicatorToRow(rowMap.get(definition.key), indicator, policy);
    }
  }

  const criticalFirst = rowMap.get('critical_first');
  if (criticalFirst.status === 'missing') {
    const fallbackPolicy = memberPolicies.find((policy) => {
      const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
      return indicators.length === 0 && policyImpliesCriticalIllness(policy);
    });

    if (fallbackPolicy) {
      const amount = asNumber(fallbackPolicy?.amount);
      criticalFirst.amount = amount;
      criticalFirst.amountText = amountDisplay(amount);
      criticalFirst.countText = amount > 0 ? '基本保额' : '-';
      criticalFirst.status = amount > 0 ? 'covered' : 'unknown';
      criticalFirst.conditionText = '按保单基础保额估算';
      criticalFirst.sourcePolicies.push({
        policyId: fallbackPolicy?.id,
        productName: String(fallbackPolicy?.name || ''),
        liability: '重疾首次给付',
        formulaText: '按保单基础保额估算',
      });
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
    accident: { members: [] },
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
