function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function memberName(policy) {
  const name = String(policy?.insured || '').trim();
  return name || '未识别被保人';
}

function latestCashValue(policy) {
  const cashValues = Array.isArray(policy?.cashValues) ? policy.cashValues : [];
  return cashValues.reduce((latest, row) => {
    const policyYear = asNumber(row?.policyYear);
    if (!latest || policyYear > latest.policyYear) {
      return {
        row,
        policyYear,
        cashValue: asNumber(row?.cashValue),
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
    ...(Array.isArray(policy?.plans) ? policy.plans : []).map((plan) => {
      if (typeof plan === 'string') return plan;
      return [plan?.name, plan?.title, plan?.liability, plan?.type].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).map((item) => {
      if (typeof item === 'string') return item;
      return [item?.name, item?.title, item?.liability, item?.type].filter(Boolean).join(' ');
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
    criticalIllness: { members: [] },
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
