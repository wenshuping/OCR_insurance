import { resolvePolicyValidityStatus } from './policy-validity.mjs';
import { resolveIndicatorAmountForCurrentContext, resolveIndicatorAmountFromCalculation } from './indicator-calculation.mjs';

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
  const match = text.match(/(\d{4})[年/-](\d{1,2})[月/-](\d{1,2})/u);
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

function ageAtDateParts(birthday, parts) {
  const birth = parseDateParts(birthday);
  if (!birth || !parts) return null;
  let age = parts.year - birth.year;
  if (parts.month < birth.month || (parts.month === birth.month && parts.day < birth.day)) {
    age -= 1;
  }
  return age >= 0 ? age : null;
}

function coverageEndDateParts(policy) {
  return parseDateParts(policy?.coveragePeriod);
}

function memberId(policy) {
  return finiteNumber(policy?.insuredMemberId);
}

function memberName(policy) {
  const name = String(policy?.insuredMemberName || policy?.insured || '').trim();
  return name || '未识别被保人';
}

function memberRelationLabel(policy) {
  return String(policy?.insuredRelationLabel || '').trim();
}

function memberKey(policy) {
  const id = memberId(policy);
  return id !== null ? `member:${id}` : `name:${memberName(policy)}`;
}

function trustedReportCorrections(corrections = []) {
  return (Array.isArray(corrections) ? corrections : [])
    .filter((correction) => ['auto_applied', 'accepted'].includes(String(correction?.status || '')));
}

function correctionMatchesPolicy(correction, policy) {
  const correctionPolicyId = finiteNumber(correction?.policyId);
  if (correctionPolicyId !== null && finiteNumber(policy?.id) !== null) {
    return correctionPolicyId === finiteNumber(policy.id);
  }
  const correctionProductName = String(correction?.productName || '').trim();
  return Boolean(correctionProductName && correctionProductName === String(policy?.name || '').trim());
}

function correctionMatchesMember(correction, policy) {
  const correctionMemberId = finiteNumber(correction?.memberId);
  if (correctionMemberId === null) return true;
  const insuredMemberId = finiteNumber(policy?.insuredMemberId);
  return insuredMemberId === null || insuredMemberId === correctionMemberId;
}

function correctionAppliesToDimension(correction, policy, dimension) {
  const action = String(correction?.action || '').trim();
  return (
    String(correction?.dimension || '').trim() === dimension &&
    ['exclude_amount', 'mark_unquantifiable', 'replace_amount'].includes(action) &&
    correctionMatchesPolicy(correction, policy) &&
    correctionMatchesMember(correction, policy)
  );
}

function correctionExcludesDimensionAmount(policy, dimension, corrections = []) {
  return trustedReportCorrections(corrections).some((correction) => (
    ['exclude_amount', 'mark_unquantifiable'].includes(String(correction?.action || '').trim()) &&
    correctionAppliesToDimension(correction, policy, dimension)
  ));
}

function correctionSortValue(correction = {}) {
  const updatedAt = Date.parse(String(correction.updatedAt || correction.createdAt || ''));
  if (Number.isFinite(updatedAt)) return updatedAt;
  return finiteNumber(correction.id) ?? 0;
}

function latestCorrection(corrections = []) {
  return corrections
    .filter(Boolean)
    .sort((left, right) => correctionSortValue(left) - correctionSortValue(right))
    .at(-1) || null;
}

function correctionNumericValue(value) {
  if (typeof value === 'string') {
    return finiteNumber(value.replace(/,/gu, ''));
  }
  return finiteNumber(value);
}

function correctionReplacementAmount(correction = {}) {
  const corrected = correctionNumericValue(correction.correctedValue);
  return corrected === null ? null : Math.max(0, corrected);
}

function radarDimensionLabel(key) {
  return {
    critical: '重疾',
    accident: '意外',
    medical: '医疗',
    life: '寿险',
    wealth: '财富',
  }[key] || '保障';
}

function partMatchesPolicy(part = {}, policy = {}) {
  const partPolicyId = finiteNumber(part.policyId);
  const policyId = finiteNumber(policy.id);
  if (partPolicyId !== null && policyId !== null) return partPolicyId === policyId;
  return String(part.sourceKey || '') === policySourceKey(policy);
}

function correctionPartForPolicy(policy = {}, dimension, correction = {}) {
  const amount = correctionReplacementAmount(correction);
  if (amount === null) return null;
  const label = `${radarDimensionLabel(dimension)}保额`;
  return {
    sourceKey: policySourceKey(policy),
    policyId: policy?.id,
    label,
    company: String(policy?.company || ''),
    productName: String(policy?.name || correction.productName || ''),
    liability: label,
    amount,
    calculationText: `${label}${formatRadarMoney(amount)}`,
  };
}

function applyRadarCorrectionsToParts(policies = [], dimension, parts = [], corrections = []) {
  const trusted = trustedReportCorrections(corrections);
  if (!trusted.length) return { parts, hasExcludedCorrection: false };

  let nextParts = [...parts];
  let hasExcludedCorrection = false;
  for (const policy of Array.isArray(policies) ? policies : []) {
    const matched = trusted.filter((correction) => correctionAppliesToDimension(correction, policy, dimension));
    if (!matched.length) continue;
    const selected = latestCorrection(matched);
    const action = String(selected?.action || '').trim();
    if (!selected || !['exclude_amount', 'mark_unquantifiable', 'replace_amount'].includes(action)) continue;

    nextParts = nextParts.filter((part) => !partMatchesPolicy(part, policy));
    if (action === 'replace_amount') {
      const replacement = correctionPartForPolicy(policy, dimension, selected);
      if (replacement && replacement.amount > 0) {
        nextParts.push(replacement);
      } else {
        hasExcludedCorrection = true;
      }
    } else {
      hasExcludedCorrection = true;
    }
  }

  return { parts: nextParts, hasExcludedCorrection };
}

function memberGroupMeta(policy) {
  return {
    memberKey: memberKey(policy),
    memberId: memberId(policy),
    member: memberName(policy),
    relationLabel: memberRelationLabel(policy),
  };
}

function policyholderName(policy) {
  const name = String(policy?.applicantMemberName || policy?.applicant || '').trim();
  return name || '未识别投保人';
}

function policyholderMemberId(policy) {
  return finiteNumber(policy?.applicantMemberId);
}

function policyholderRelationLabel(policy) {
  return String(policy?.applicantRelationLabel || '').trim();
}

function reportPoliciesForFamily(policies = [], options = {}) {
  const source = Array.isArray(policies) ? policies : [];
  const familyId = options?.familyId;
  if (familyId === null || familyId === undefined || String(familyId).trim() === '') return source;
  const selectedFamilyId = finiteNumber(familyId);
  if (selectedFamilyId === null) return [];
  return source.filter((policy) => finiteNumber(policy?.familyId) === selectedFamilyId);
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

function policyValidityContext(record, fallback = {}) {
  return {
    effectiveDate: record?.date || record?.effectiveDate || fallback.effectiveDate,
    insuredBirthday: record?.insuredBirthday || fallback.insuredBirthday,
  };
}

function policyIsInactive(policy) {
  if (policy?.expired === true) return true;
  const text = policyStatusText(policy);
  if (inactiveStatusText(text)) return true;
  return coveragePeriodExpired(policy?.coveragePeriod, policyValidityContext(policy));
}

function coveragePeriodExpired(value, context = {}) {
  return resolvePolicyValidityStatus(value, context).tone === 'expired';
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
  return coveragePeriodExpired(plan?.coveragePeriod, policyValidityContext(plan, policyValidityContext(policy)));
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

function isSelectedCoverageIndicator(indicator = {}) {
  if (indicatorIsReferenceOnly(indicator)) return false;
  const scope = String(indicator?.responsibilityScope || 'basic');
  const status = String(indicator?.selectionStatus || (scope === 'optional' ? 'unknown' : 'selected'));
  const quantificationStatus = String(indicator?.quantificationStatus || 'pending_review');
  return scope !== 'optional' || (status === 'selected' && quantificationStatus === 'quantified');
}

function indicatorIsReferenceOnly(indicator = {}) {
  const sourceKind = String(indicator?.sourceKind || '').trim();
  const evidenceLevel = String(indicator?.evidenceLevel || indicator?.sourceLevel || '').trim();
  const verificationStatus = String(indicator?.verificationStatus || '').trim();
  return (
    indicator?.referenceOnly === true ||
    indicator?.responsibilityDeferred === true ||
    verificationStatus === 'pending_review' ||
    ['legacy_external_reference', 'open_web_reference'].includes(sourceKind) ||
    evidenceLevel === 'external_legacy_reference'
  );
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

function planDisplayName(plan) {
  if (typeof plan === 'string') return plan.trim();
  return String(plan?.name || plan?.productName || plan?.matchedProductName || '').trim();
}

function planMatchedProductName(plan) {
  if (!plan || typeof plan === 'string') return '';
  return String(plan?.matchedProductName || '').trim();
}

function planRoleLabel(plan, index) {
  if (plan && typeof plan !== 'string') {
    const role = String(plan?.role || '').trim();
    if (role === 'main') return '主险';
    if (role === 'rider') return '附加险';
    if (role === 'linked_account') return '万能账户';
  }
  return index === 0 ? '主险' : '附加险';
}

function planTypeLabel(policy, plan) {
  if (plan && typeof plan !== 'string') {
    const directType = uniqueJoinedText([plan?.productType, plan?.type]);
    if (directType) return directType;
  }

  const names = [planDisplayName(plan), planMatchedProductName(plan)].filter(Boolean);
  const indicatorTypes = selectedCoverageIndicators(policy?.coverageIndicators)
    .filter((indicator) => {
      const matchedPlan = findPlanForIndicator(policy, indicator);
      if (matchedPlan === plan) return true;
      if (matchedPlan) return false;
      return names.some((name) => productNameMatchesIndicator(name, indicator?.productName));
    })
    .map((indicator) => indicator?.productType);

  return uniqueJoinedText(indicatorTypes);
}

function planCoverageText(plan) {
  if (!plan || typeof plan === 'string') return '';
  const amount = finiteNumber(plan?.amount);
  if (amount !== null && amount > 0) return `${formatNumberText(amount / 10000)}万`;
  return '';
}

function planPremiumText(plan) {
  if (!plan || typeof plan === 'string') return '';
  const premium = [plan?.premium, plan?.firstPremium, plan?.annualPremium]
    .map(finiteNumber)
    .find((value) => value !== null && value > 0);
  return premium ? formatNumberText(premium) : '';
}

function buildFallbackPlanItem(policy) {
  return {
    roleLabel: '主险',
    productName: String(policy?.name || '').trim(),
    matchedProductName: '',
    typeLabel: policyTypeLabel(policy),
    coverageText: coverageText(policy),
    premiumText: finiteNumber(policy?.firstPremium) !== null && asNumber(policy?.firstPremium) > 0 ? formatNumberText(policy?.firstPremium) : '',
    paymentPeriod: String(policy?.paymentPeriod || ''),
    coveragePeriod: String(policy?.coveragePeriod || ''),
    statusLabel: policyIsInactive(policy) ? (policyStatusText(policy) || '已失效') : '',
  };
}

function buildInventoryPlanItems(policy) {
  const planItems = (Array.isArray(policy?.plans) ? policy.plans : [])
    .map((plan, index) => ({
      roleLabel: planRoleLabel(plan, index),
      productName: planDisplayName(plan),
      matchedProductName: planMatchedProductName(plan),
      typeLabel: planTypeLabel(policy, plan),
      coverageText: planCoverageText(plan),
      premiumText: planPremiumText(plan),
      paymentPeriod: plan && typeof plan !== 'string' ? String(plan?.paymentPeriod || plan?.paymentMode || '') : '',
      coveragePeriod: plan && typeof plan !== 'string' ? String(plan?.coveragePeriod || '') : '',
      statusLabel: planIsInactive(policy, plan) ? (planStatusText(plan) || '已失效') : '',
    }))
    .filter((item) => [item.productName, item.matchedProductName, item.typeLabel, item.coverageText, item.premiumText, item.coveragePeriod, item.statusLabel].some(Boolean));

  const policyName = String(policy?.name || '').trim();
  const includesPolicyProduct = planItems.some((item) => [item.productName, item.matchedProductName].some((name) => productNameMatchesIndicator(name, policyName)));
  if (!planItems.length || (policyName && !includesPolicyProduct)) {
    return [buildFallbackPlanItem(policy), ...planItems];
  }
  return planItems;
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
  const member = memberGroupMeta(policy);
  return {
    policyId: policy?.id,
    memberKey: member.memberKey,
    memberId: member.memberId,
    member: member.member,
    relationLabel: member.relationLabel,
    applicant: policyholderName(policy),
    applicantMemberId: policyholderMemberId(policy),
    applicantRelationLabel: policyholderRelationLabel(policy),
    participantReviewStatus: String(policy?.participantReviewStatus || ''),
    company: String(policy?.company || ''),
    policyNumber: String(policy?.policyNumber || policy?.policyNo || policy?.contractNumber || policy?.contractNo || policy?.number || '').trim(),
    productName: String(policy?.name || ''),
    planItems: buildInventoryPlanItems(policy),
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

function findPlanForResponsibility(policy, responsibility) {
  if (!responsibility || typeof responsibility === 'string') return null;
  const plans = Array.isArray(policy?.plans) ? policy.plans : [];
  const candidates = [
    responsibility?.productName,
    responsibility?.matchedProductName,
    responsibility?.sourceProductName,
    responsibility?.planName,
    responsibility?.note,
  ].filter(Boolean);
  if (!candidates.length) return null;

  return plans.find((plan) => candidates.some((candidate) => (
    [plan?.matchedProductName, plan?.name].some((value) => productNameMatchesIndicator(value, candidate))
  ))) || null;
}

function indicatorPlanIsInactive(policy, indicator) {
  const plan = findPlanForIndicator(policy, indicator);
  return Boolean(plan && planIsInactive(policy, plan));
}

function responsibilityPlanIsInactive(policy, responsibility) {
  const plan = findPlanForResponsibility(policy, responsibility);
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

function indicatorCalculationInputs(indicator, policy) {
  const plan = findPlanForIndicator(policy, indicator);
  const premium = [
    plan?.premium,
    plan?.firstPremium,
    plan?.annualPremium,
    policy?.firstPremium,
  ].map(finiteNumber).find((value) => value !== null && value > 0) || 0;
  const paymentYears = parsePaymentYears(plan?.paymentPeriod || plan?.paymentMode || policy?.paymentPeriod) || 1;
  return {
    baseAmount: indicatorBaseAmount(indicator, policy),
    firstPremium: premium,
    paymentYears,
    currentAge: ageFromBirthday(policy?.insuredBirthday),
  };
}

function classifyByDefinitions(text, definitions) {
  const normalized = String(text || '').normalize('NFKC');
  return definitions.find((definition) => definition.patterns.some((pattern) => pattern.test(normalized))) || null;
}

function classifyCriticalIndicator(indicator) {
  const primaryText = [
    indicator?.coverageType,
    indicator?.liability,
    indicator?.scenario,
    indicator?.payout,
    indicator?.formulaText,
    indicator?.condition,
    indicator?.basis,
  ].filter(Boolean).join(' ');
  return classifyByDefinitions(primaryText, CRITICAL_ROWS) || classifyByDefinitions(indicatorText(indicator), CRITICAL_ROWS);
}

function formulaNeedsManualAmount(text) {
  return /(较大|较高|最大|取|现金价值|现价|账户价值|已交|所交|实际交纳|保险费|保费|余额|两者|三者|max)/iu
    .test(String(text || '').normalize('NFKC'));
}

function indicatorCannotContributeRadarAmount(indicator = {}) {
  const coverageType = String(indicator?.coverageType || '').normalize('NFKC').trim();
  const liability = String(indicator?.liability || '').normalize('NFKC').trim();
  const statusText = [
    indicator?.quantificationStatus,
    indicator?.qualityStatus,
    indicator?.responsibilityScope,
  ].map((value) => String(value || '').normalize('NFKC')).join(' ');
  const ruleText = [
    coverageType,
    liability,
    indicator?.basis,
    indicator?.unit,
  ].map((value) => String(value || '').normalize('NFKC')).join(' ');

  return indicator?.excludeFromCalculation === true
    || indicator?.calculationEligible === false
    || coverageType === '规则参数'
    || /rule_parameter|not_quantifiable|non_calculable|unquantifiable/iu.test(statusText)
    || /^(等待期|赔付方式|领取起始年龄|开始领取年龄|领取年龄|缴费年期)$/u.test(liability)
    || /保险责任赔付机制/u.test(ruleText);
}

function medicalIndicatorCannotContributeFixedAmount(indicator = {}) {
  if (indicatorCannotContributeRadarAmount(indicator)) return true;
  const text = indicatorText(indicator).normalize('NFKC');
  if (/(医疗费用限额|医疗限额|报销限额|费用限额)/u.test(text) && resolveIndicatorAmount(indicator, {}) > 0) return false;
  return /(等待期|赔付方式|床位费|每日|每天|日额|津贴|给付天数|每次住院最长)/u.test(text);
}

function resolveIndicatorAmount(indicator, policy) {
  const value = finiteNumber(indicator?.value);
  const unit = String(indicator?.unit || '').normalize('NFKC');
  const text = indicatorText(indicator).normalize('NFKC');
  const formulaText = String(indicator?.formulaText || '').normalize('NFKC');
  const explicitYuanLimit = value !== null
    && /^(?:元|圆)$/u.test(unit)
    && /(限额|保额|保险金额|医疗费用|费用|给付金|保险金)/u.test(text);
  const structured = resolveIndicatorAmountForCurrentContext(indicator, indicatorCalculationInputs(indicator, policy));
  if (structured.resolved) return structured.amount;
  if (structured.meta.calculationKey !== 'unknown' && structured.meta.calculationEligible === false && !explicitYuanLimit) return 0;

  const basis = String(indicator?.basis || '').normalize('NFKC');
  const baseAmount = indicatorBaseAmount(indicator, policy);
  const baseAmountPattern = /基本(?:保险金额|保额)/u;
  const usesBaseAmountBasis = baseAmountPattern.test(basis) || /^(?:保险金额|本合同保险金额|合同保险金额|保单保险金额)$/u.test(basis);

  if (value !== null && unit === '%' && usesBaseAmountBasis) {
    return baseAmount * value / 100;
  }

  if (value !== null && unit === '倍' && usesBaseAmountBasis) {
    return baseAmount * value;
  }

  const formulaPercentMatch = formulaText.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/u)
    || text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*%/u);
  if (formulaPercentMatch) return baseAmount * asNumber(formulaPercentMatch[1]) / 100;

  const formulaMultipleMatch = formulaText.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*倍/u)
    || text.match(/基本(?:保险金额|保额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*倍/u);
  if (formulaMultipleMatch) return baseAmount * asNumber(formulaMultipleMatch[1]);

  if (value !== null && /^(?:元|圆)$/u.test(unit)) return value;

  const wanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*万/u);
  if (wanMatch) return asNumber(wanMatch[1]) * 10000;

  const yuanMatch = text.match(/([0-9]+(?:\.[0-9]+)?)\s*(?:元|圆)/u);
  if (yuanMatch) return asNumber(yuanMatch[1]);

  if (baseAmountPattern.test(formulaText) && !formulaNeedsManualAmount(formulaText)) return baseAmount;
  if (baseAmountPattern.test(text) && !formulaNeedsManualAmount(text)) return baseAmount;

  return 0;
}

function indicatorAmountCalculationText(indicator, policy, amount) {
  const structured = resolveIndicatorAmountForCurrentContext(indicator, indicatorCalculationInputs(indicator, policy));
  if (structured.resolved && Math.abs(structured.amount - asNumber(amount)) < 0.01) return structured.calculationText;

  const numericAmount = asNumber(amount);
  const value = finiteNumber(indicator?.value);
  const unit = String(indicator?.unit || '').normalize('NFKC').trim();
  const basis = String(indicator?.basis || '').normalize('NFKC').trim();
  const text = indicatorText(indicator).normalize('NFKC');
  const baseAmount = indicatorBaseAmount(indicator, policy);
  const baseAmountPattern = /基本(?:保险金额|保额)/u;
  const usesBaseAmountBasis = baseAmountPattern.test(basis) || /^(?:保险金额|本合同保险金额|合同保险金额|保单保险金额)$/u.test(basis);
  const baseLabel = usesBaseAmountBasis || baseAmountPattern.test(text) ? '基本保险金额' : (basis || '基准金额');

  if (value !== null && unit === '%' && usesBaseAmountBasis) {
    return `${baseLabel}${formatRadarMoney(baseAmount)} × ${formatNumberText(value)}% = ${formatRadarMoney(numericAmount)}`;
  }

  if (value !== null && unit === '倍' && usesBaseAmountBasis) {
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

function lifeRadarLiabilityLabel(indicator) {
  const liability = String(indicator?.liability || '').trim();
  const text = indicatorText(indicator).normalize('NFKC');
  if (/身故|全残/u.test(text) && /增额|利率/u.test(liability)) return '身故/全残';
  return liability || '寿险保额';
}

function lifeRadarCalculationText(indicator, policy, amount) {
  const baseAmount = indicatorBaseAmount(indicator, policy);
  const text = `${indicatorText(indicator)} ${radarPolicyText(policy)}`.normalize('NFKC');
  if (
    asNumber(amount) >= baseAmount
    && /身故|全残/u.test(text)
    && /累积红利保险金额|累计红利保险金额/u.test(text)
  ) {
    return `基本保险金额${formatRadarMoney(baseAmount)} + 累积红利保险金额，当前按确定部分至少${formatRadarMoney(amount)}统计`;
  }
  return indicatorAmountCalculationText(indicator, policy, amount);
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
  row.amountText = row.amount > 0 ? amountDisplay(row.amount) : amountDisplay(row.amount, formulaText || '待识别');
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
  return criticalPolicyTextWithOptions(policy);
}

function criticalPolicyTextWithOptions(policy, options = {}) {
  const includeInactivePlans = options?.includeInactivePlans === true;
  const plans = includeInactivePlans ? (Array.isArray(policy?.plans) ? policy.plans : []) : activePlans(policy);
  return [
    policy?.name,
    policy?.report,
    policy?.ocrText,
    ...plans.map((plan) => {
      if (typeof plan === 'string') return plan;
      return [plan?.name, plan?.title, plan?.liability, plan?.type].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).map((item) => {
      if (!includeInactivePlans && responsibilityPlanIsInactive(policy, item)) return '';
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

function policyImpliesCriticalIllness(policy, options = {}) {
  return /(重疾|重大疾病|轻症|中症|恶性肿瘤|癌)/u.test(criticalPolicyTextWithOptions(policy, options).normalize('NFKC'));
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
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    let matched = false;
    for (const indicator of indicators) {
      if (indicatorCannotContributeRadarAmount(indicator)) continue;
      if (indicatorIsAccidentCoverage(indicator)) continue;
      const definition = classifyCriticalIndicator(indicator);
      if (!definition) continue;
      matched = true;
      const amount = indicatorAmountForPolicy(indicator, policy);
      markInactiveSourceOnRow(rowMap.get(definition.key), policy, indicator?.liability || definition.label, {
        productName: indicatorSourceProductName(policy, indicator),
        amount,
        countText: indicatorCountText(indicator),
      });
    }
    if (!matched && policyImpliesCriticalIllness(policy, { includeInactivePlans: true })) {
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

function correctionSourceForCriticalRow(policy, correction = {}) {
  const amount = correctionReplacementAmount(correction);
  if (amount === null) return null;
  return {
    sourceKey: policySourceKey(policy),
    policyId: policy?.id,
    company: String(policy?.company || ''),
    productName: String(policy?.name || correction.productName || ''),
    liability: '重疾首次给付',
    formulaText: 'DeepSeek修正',
    amount,
    amountText: formatRadarMoney(amount),
    calculationText: correction.reason
      ? `${correction.reason}：${formatRadarMoney(amount)}`
      : `DeepSeek修正为${formatRadarMoney(amount)}`,
  };
}

function applyCriticalRowCorrections(rowMap, memberPolicies, corrections = []) {
  const trusted = trustedReportCorrections(corrections)
    .filter((correction) => String(correction?.dimension || '').trim() === 'critical')
    .filter((correction) => ['exclude_amount', 'mark_unquantifiable', 'replace_amount'].includes(String(correction?.action || '').trim()));
  if (!trusted.length) return;

  for (const policy of memberPolicies) {
    const matched = trusted.filter((correction) => correctionMatchesPolicy(correction, policy) && correctionMatchesMember(correction, policy));
    if (!matched.length) continue;
    const selected = latestCorrection(matched);
    const action = String(selected?.action || '').trim();
    const criticalFirst = rowMap.get('critical_first');
    if (!selected || !criticalFirst) continue;

    criticalFirst.sourcePolicies = (criticalFirst.sourcePolicies || [])
      .filter((source) => sourcePolicyKey(source) !== policySourceKey(policy));

    if (action === 'replace_amount') {
      const replacement = correctionSourceForCriticalRow(policy, selected);
      if (!replacement) continue;
      criticalFirst.sourcePolicies.push(replacement);
    }
  }

  const criticalFirst = rowMap.get('critical_first');
  if (!criticalFirst) return;
  criticalFirst.amount = (criticalFirst.sourcePolicies || [])
    .reduce((total, source) => total + asNumber(source.amount), 0);
  criticalFirst.amountText = criticalFirst.amount > 0 ? amountDisplay(criticalFirst.amount) : '未识别';
  criticalFirst.countText = criticalFirst.amount > 0 ? 'DeepSeek修正' : '-';
  criticalFirst.status = criticalFirst.amount > 0 ? 'covered' : 'missing';
  const correctionSource = (criticalFirst.sourcePolicies || [])
    .find((source) => String(source.formulaText || '') === 'DeepSeek修正');
  criticalFirst.conditionText = correctionSource?.calculationText || (criticalFirst.amount > 0 ? '按识别责任计算' : '未识别到该责任');
}

function buildMemberCriticalRows(memberPolicies, inactiveMemberPolicies = [], corrections = []) {
  const rowMap = new Map(CRITICAL_ROWS.map((definition) => [definition.key, baseProtectionRow(definition)]));
  const usableCriticalFirstPolicies = new Set();
  const formulaCriticalFirstPolicies = new Set();
  const inactiveCriticalPolicies = new Set();

  for (const policy of memberPolicies) {
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    for (const indicator of indicators) {
      if (indicatorCannotContributeRadarAmount(indicator)) continue;
      if (indicatorIsAccidentCoverage(indicator)) continue;
      const definition = classifyCriticalIndicator(indicator);
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

  applyCriticalRowCorrections(rowMap, memberPolicies, corrections);
  markInactiveCriticalPolicies(rowMap, inactiveMemberPolicies);

  const rows = Array.from(rowMap.values());
  const attentionItems = [];
  if (memberPolicies.length > 0 && rowMap.get('critical_first')?.status === 'missing') {
    attentionItems.push('重疾首次给付缺失');
  }

  return { rows, attentionItems };
}

export function buildCriticalIllnessSection(policies = [], corrections = []) {
  const groupMap = new Map();

  for (const policy of policies) {
    const member = memberGroupMeta(policy);
    if (!groupMap.has(member.memberKey)) {
      groupMap.set(member.memberKey, {
        ...member,
        policies: [],
      });
    }
    groupMap.get(member.memberKey).policies.push(policy);
  }

  return {
    members: Array.from(groupMap.values(), (group) => {
      const memberPolicies = group.policies;
      const activeMemberPolicies = activePolicies(memberPolicies);
      const inactiveMemberPolicies = inactivePolicies(memberPolicies);
      return {
        memberKey: group.memberKey,
        memberId: group.memberId,
        member: group.member,
        relationLabel: group.relationLabel,
        ...buildMemberCriticalRows(activeMemberPolicies, inactiveMemberPolicies, corrections),
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

function indicatorIsExplicitAccidentCoverage(indicator) {
  const coverageType = String(indicator?.coverageType || '').normalize('NFKC');
  const primaryText = [
    indicator?.coverageType,
    indicator?.liability,
    indicator?.scenario,
  ].filter(Boolean).join(' ').normalize('NFKC');
  return coverageType === '意外保障' || textImpliesAccident(primaryText);
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
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    const responsibilities = (Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).filter((item) => !indicatorIsReferenceOnly(item));
    let matched = false;

    for (const indicator of indicators) {
      if (indicatorCannotContributeRadarAmount(indicator)) continue;
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
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    const indicatorRowKeys = new Set();

    for (const indicator of indicators) {
      if (indicatorCannotContributeRadarAmount(indicator)) continue;
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

    const responsibilities = (Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).filter((item) => !indicatorIsReferenceOnly(item));
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
  const attentionItems = memberPolicies.length > 0
    ? rows
      .filter((row) => row.status === 'missing')
      .map((row) => `${row.label}缺失`)
    : [];

  return { rows, attentionItems };
}

export function buildAccidentSection(policies = []) {
  const groupMap = new Map();

  for (const policy of policies) {
    const member = memberGroupMeta(policy);
    if (!groupMap.has(member.memberKey)) {
      groupMap.set(member.memberKey, {
        ...member,
        policies: [],
      });
    }
    groupMap.get(member.memberKey).policies.push(policy);
  }

  return {
    members: Array.from(groupMap.values(), (group) => {
      const memberPolicies = group.policies;
      const activeMemberPolicies = activePolicies(memberPolicies);
      const inactiveMemberPolicies = inactivePolicies(memberPolicies);
      return {
        memberKey: group.memberKey,
        memberId: group.memberId,
        member: group.member,
        relationLabel: group.relationLabel,
        ...buildMemberAccidentRows(activeMemberPolicies, inactiveMemberPolicies),
      };
    }),
  };
}

function effectiveDateParts(policy) {
  return parseDateParts(policy?.date || policy?.effectiveDate);
}

function effectiveYear(policy) {
  return effectiveDateParts(policy)?.year || 0;
}

const MATURITY_PAYOUT_PATTERN = /(满期|期满|保险期间届满|合同期满)/u;
const CONTRACT_TERMINATING_PAYOUT_PATTERN = /(满期|期满|保险期间届满|合同期满|身故|全残|身体全残|退保|解约|解除合同|本合同终止|合同终止|保险责任终止|责任终止|效力终止|终止保险合同)/u;

function cashflowTerminationText(row) {
  return [
    row?.liability,
    row?.calculationText,
    row?.calcText,
  ].filter(Boolean).join(' ').normalize('NFKC');
}

function isMaturityPayoutRow(row) {
  return asNumber(row?.amount) > 0 && MATURITY_PAYOUT_PATTERN.test(cashflowTerminationText(row));
}

function isContractTerminatingPayoutRow(row) {
  return asNumber(row?.amount) > 0 && CONTRACT_TERMINATING_PAYOUT_PATTERN.test(cashflowTerminationText(row));
}

function cashValueReferenceTypeFor({ hasCashValue, hasPayout, isMaturityPayout, isContractTerminatingPayout }) {
  if (!hasCashValue) return '';
  if (isMaturityPayout) return 'pre_maturity';
  if (isContractTerminatingPayout) return 'pre_termination';
  if (hasPayout) return 'surrender';
  return 'reference';
}

function cashValueReferenceNote(type) {
  if (type === 'pre_maturity') return '满期金给付后合同终止，不与现金价值叠加领取';
  if (type === 'pre_termination') return '该给付后合同终止，不与现金价值叠加领取';
  if (type === 'surrender') return '现金价值不与当年领取金额叠加领取';
  if (type === 'reference') return '现金价值不等同于可直接领取金额';
  return '';
}

function cashValueKeyPointLabel(type) {
  if (type === 'pre_maturity') return '期满前现金价值参考';
  if (type === 'pre_termination') return '终止前现金价值参考';
  return '末期现金价值参考';
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
      const rowAge = finiteNumber(row?.age);
      const inferredAge = ageAtDateParts(policy?.insuredBirthday, cashValueEndDate);
      const age = rowAge !== null && rowAge > 0
        ? rowAge
        : (inferredAge !== null && inferredAge >= 0 ? inferredAge : rowAge);

      return {
        policyYear,
        age,
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
        calculationText: String(row?.calculationText || row?.calcText || ''),
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
        isMaturityPayout: false,
        isContractTerminatingPayout: false,
      });
    }
    const grouped = payoutByYear.get(row.year);
    grouped.amount += row.amount;
    grouped.cumulative = Math.max(grouped.cumulative, asNumber(row.cumulative));
    if (grouped.age === null && row.age !== null) grouped.age = row.age;
    if (row.liability && !grouped.liabilities.includes(row.liability)) grouped.liabilities.push(row.liability);
    grouped.isMaturityPayout = grouped.isMaturityPayout || isMaturityPayoutRow(row);
    grouped.isContractTerminatingPayout = grouped.isContractTerminatingPayout || isContractTerminatingPayoutRow(row);
  }

  const knownYears = [
    ...payouts.map((row) => row.year),
    ...values.map((row) => row.calendarYear || row.policyYear),
  ].filter((year) => year > 0);
  if (!knownYears.length) return [];

  const years = Array.from(new Set(knownYears)).sort((a, b) => a - b);
  const coverageEndDate = coverageEndDateParts(policy);
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
    const coverageEndAge = coverageEndDate?.year === year ? ageAtDateParts(policy?.insuredBirthday, coverageEndDate) : null;
    const age = meta?.age ?? coverageEndAge ?? payout?.age ?? (year > 1900 && inferredBirthYear ? year - inferredBirthYear : null);
    const liabilities = payout?.liabilities ?? [];
    const cashValue = cashValueByDisplayYear.get(year) ?? null;
    const hasPayout = (payout?.amount ?? 0) > 0;
    const isMaturityPayout = Boolean(payout?.isMaturityPayout);
    const isContractTerminatingPayout = Boolean(payout?.isContractTerminatingPayout);
    const cashValueReferenceType = cashValueReferenceTypeFor({
      hasCashValue: cashValue !== null,
      hasPayout,
      isMaturityPayout,
      isContractTerminatingPayout,
    });
    const cashValueIsNonAdditiveReference = cashValue !== null && hasPayout;

    return {
      year,
      age,
      amount: payout?.amount ?? 0,
      cumulative: payout ? Math.max(payout.cumulative, runningCumulative) : 0,
      cashValue,
      liabilities,
      isMaturityPayout,
      isContractTerminatingPayout,
      cashValueReferenceType,
      cashValueIsNonAdditiveReference,
      cashValueIsPreMaturityReference: cashValueReferenceType === 'pre_maturity',
      cashValueNote: cashValueReferenceNote(cashValueReferenceType),
    };
  });
}

function cashValuePolicyYearGapRanges(values) {
  const policyYears = Array.from(new Set(values.map((row) => row.policyYear)))
    .filter((year) => Number.isFinite(year) && year > 0)
    .sort((a, b) => a - b);
  const ranges = [];
  for (let index = 1; index < policyYears.length; index += 1) {
    const previous = policyYears[index - 1];
    const current = policyYears[index];
    if (current - previous > 1) {
      ranges.push({ start: previous + 1, end: current - 1 });
    }
  }
  return ranges;
}

function policyYearGapText(range) {
  return range.start === range.end ? `第${range.start}年` : `第${range.start}-${range.end}年`;
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

function wealthInsuranceText(policy) {
  return [
    policy?.company,
    policy?.name,
    policy?.productName,
    policy?.productType,
    policy?.type,
    policy?.category,
    ...activePlans(policy).map((plan) => {
      if (typeof plan === 'string') return plan;
      return [
        plan?.name,
        plan?.title,
        plan?.productName,
        plan?.productType,
        plan?.matchedProductName,
        plan?.liability,
        plan?.type,
      ].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : []).map((indicator) => [
      indicator?.productType,
      indicator?.productName,
      indicator?.name,
      indicator?.title,
      indicator?.coverageType,
      indicator?.liability,
    ].filter(Boolean).join(' ')),
  ].filter(Boolean).join(' ').normalize('NFKC');
}

function wealthPolicyIdentityText(policy) {
  return [
    policy?.company,
    policy?.name,
    policy?.productName,
    policy?.productType,
    policy?.type,
    policy?.category,
  ].filter(Boolean).join(' ').normalize('NFKC');
}

function wealthUncertaintyItems(policy) {
  const text = wealthInsuranceText(policy);
  const items = [];
  if (/分红|红利/u.test(text)) {
    items.push({
      key: 'dividend',
      label: '分红/红利',
      reason: '红利分配不保证，实际金额取决于保险公司分配',
    });
  }
  if (/万能(?:账户|型|保险|险)|账户价值|保单账户|最低保证利率|结算利率/u.test(text)) {
    items.push({
      key: 'universal_account',
      label: '万能账户',
      reason: '结算利率和账户价值会随实际账户变动',
    });
  }
  return items;
}

function wealthUncertaintyAttentionText(items) {
  if (!items.length) return '';
  return `${items.map((item) => item.label).join('、')}存在不确定因素，未进入财富统计`;
}

function wealthUncertaintyNote(items) {
  if (!items.length) return '';
  return `${items.map((item) => item.reason).join('；')}。当前财富统计仅包含已识别的确定领取现金流，现金价值仅在保单明细展示。`;
}

function isWealthInsurancePolicy(policy) {
  const text = wealthInsuranceText(policy);
  return /年金/u.test(text)
    || /万能(?:账户|型|保险|险)/u.test(text)
    || /(?:增额|递增).{0,12}终身寿/u.test(text)
    || /终身寿.{0,12}(?:增额|递增)/u.test(text);
}

function cashflowRowHasUncertainWealthFactor(row) {
  const liabilityText = String(row?.liability || '').normalize('NFKC');
  const productText = String(row?.productName || '').normalize('NFKC');
  if (/分红|红利/u.test(liabilityText)) return true;
  return /万能(?:账户|型|保险|险)|账户价值|保单账户|最低保证利率|结算利率/u.test(`${liabilityText} ${productText}`);
}

function policyCashValuesAreUncertain(policy) {
  return /万能(?:账户|型|保险|险)|账户价值|保单账户|最低保证利率|结算利率/u.test(wealthPolicyIdentityText(policy));
}

function deterministicCashflowRows(policy) {
  return cashflowRows(policy).filter((row) => !cashflowRowHasUncertainWealthFactor(row));
}

function excludedUncertainCashflowRows(policy) {
  return cashflowRows(policy).filter(cashflowRowHasUncertainWealthFactor);
}

function deterministicCashValueRows(policy) {
  return policyCashValuesAreUncertain(policy) ? [] : cashValueRows(policy);
}

function excludedUncertainCashValueRows(policy) {
  return policyCashValuesAreUncertain(policy) ? cashValueRows(policy) : [];
}

function deterministicLatestCashValue(policy) {
  if (policyCashValuesAreUncertain(policy)) return null;
  return latestCashValue(policy);
}

function deterministicFuturePayoutTotal(policy) {
  return deterministicCashflowRows(policy).reduce((total, entry) => total + asNumber(entry?.amount), 0);
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
  const payouts = deterministicCashflowRows(policy);
  const excludedCashflowRows = excludedUncertainCashflowRows(policy);
  const values = deterministicCashValueRows(policy);
  const excludedCashValueRows = excludedUncertainCashValueRows(policy);
  const uncertaintyItems = wealthUncertaintyItems(policy);
  const uncertaintyAttention = wealthUncertaintyAttentionText(uncertaintyItems);
  const excludedStatisticRowsCount = excludedCashflowRows.length + excludedCashValueRows.length;
  const cashValueGapRanges = cashValuePolicyYearGapRanges(values);
  const annualRows = annualCashflowRows(policy, payouts, values);
  const firstPayout = payouts.find((row) => row.amount > 0);
  const highestPayout = payouts.reduce((highest, row) => (!highest || row.amount > highest.amount ? row : highest), null);
  const lastCashValue = values[values.length - 1];
  const lastCashValueYear = lastCashValue?.calendarYear || lastCashValue?.policyYear;
  const lastCashValueAnnualRow = annualRows.find((row) => row.year === lastCashValueYear);
  const lastCashValueReferenceType = lastCashValueAnnualRow?.cashValueReferenceType || (lastCashValue ? 'reference' : '');
  const attentionItems = [
    uncertaintyAttention || null,
    excludedStatisticRowsCount > 0 ? `已排除${excludedStatisticRowsCount}条不确定财富数据` : null,
    values.length > 0 && effectiveYear(policy) <= 0 ? '生效日待补充' : null,
    asNumber(policy?.firstPremium) > 0 && parsePaymentYears(policy?.paymentPeriod) === null ? '缴费期待补充' : null,
    cashValueGapRanges.length ? `现金价值表缺少${cashValueGapRanges.map(policyYearGapText).join('、')}` : null,
  ].filter(Boolean);

  return {
    policyId: policy?.id,
    productName: String(policy?.name || ''),
    company: String(policy?.company || ''),
    annualPremium: asNumber(policy?.firstPremium),
    cashflowRows: payouts,
    cashValueRows: values,
    excludedCashflowRows,
    excludedCashValueRows,
    annualCashflowRows: annualRows,
    uncertaintyItems,
    uncertaintyNote: wealthUncertaintyNote(uncertaintyItems),
    hasUncertainWealthFactors: uncertaintyItems.length > 0,
    attentionItems,
    keyPoints: [
      firstPayout
        ? { label: '开始领取', value: String(firstPayout.year), amount: firstPayout.amount }
        : null,
      highestPayout
        ? { label: '单年最高领取', value: String(highestPayout.year), amount: highestPayout.amount }
        : null,
      lastCashValue
        ? {
          label: cashValueKeyPointLabel(lastCashValueReferenceType),
          value: lastCashValue.cashValueDateLabel || String(lastCashValue.calendarYear || lastCashValue.policyYear),
          amount: lastCashValue.cashValue,
          note: cashValueReferenceNote(lastCashValueReferenceType),
        }
        : null,
    ].filter(Boolean),
  };
}

export function buildWealthSection(policies = []) {
  const wealthPolicies = activePolicies(policies).filter(isWealthPolicy);
  const groupMap = new Map();

  for (const policy of wealthPolicies) {
    const member = memberGroupMeta(policy);
    if (!groupMap.has(member.memberKey)) {
      groupMap.set(member.memberKey, {
        ...member,
        policies: [],
      });
    }
    groupMap.get(member.memberKey).policies.push(policy);
  }

  const memberReports = Array.from(groupMap.values(), (group) => {
    const memberPolicies = group.policies;
    const reports = memberPolicies.map(buildWealthPolicyReport);
    const attentionItems = [
      ...reports
        .filter((policyReport) => policyReport.cashValueRows.length === 0 && policyReport.excludedCashValueRows.length === 0)
        .map((policyReport) => `${policyReport.productName || '未命名保单'}缺少现金价值表`),
      ...new Set(reports.flatMap((policyReport) => policyReport.attentionItems)),
    ];

    return {
      memberKey: group.memberKey,
      memberId: group.memberId,
      member: group.member,
      relationLabel: group.relationLabel,
      policies: reports,
      attentionItems,
    };
  });
  const excludedPolicies = memberReports.flatMap((memberReport) => memberReport.policies
    .filter((policyReport) => policyReport.hasUncertainWealthFactors)
    .map((policyReport) => ({
      policyId: policyReport.policyId,
      member: memberReport.member,
      productName: policyReport.productName,
      reasons: policyReport.uncertaintyItems.map((item) => item.label),
      note: policyReport.uncertaintyNote,
    })));

  const aggregateMap = new Map();
  const ensureRow = (year) => {
    if (!aggregateMap.has(year)) {
      aggregateMap.set(year, {
        year,
        premiumOutflow: 0,
        payoutInflow: 0,
        cashValueIncrease: 0,
        netCashflow: 0,
        cumulativeNetCashflow: 0,
        cumulativePayoutInflow: 0,
        cashValueTotal: 0,
        totalValue: 0,
        details: [],
      });
    }
    return aggregateMap.get(year);
  };

  for (const policy of wealthPolicies) {
    const member = memberName(policy);
    const policyholder = policyholderName(policy);
    const policyId = policy?.id;
    const productName = String(policy?.name || '');

    for (const payout of deterministicCashflowRows(policy)) {
      const row = ensureRow(payout.year);
      row.payoutInflow += payout.amount;
      row.details.push({
        type: 'payout',
        member,
        policyholder,
        policyId,
        productName,
        liability: payout.liability,
        amount: payout.amount,
      });
    }

  }

  let cumulativeNetCashflow = 0;
  let cumulativePayoutInflow = 0;
  const aggregateRows = Array.from(aggregateMap.values())
    .sort((a, b) => a.year - b.year)
    .map((row) => {
      row.netCashflow = row.payoutInflow;
      cumulativeNetCashflow += row.netCashflow;
      row.cumulativeNetCashflow = cumulativeNetCashflow;
      cumulativePayoutInflow += row.payoutInflow;
      row.cumulativePayoutInflow = cumulativePayoutInflow;
      row.totalValue = row.cumulativePayoutInflow;
      return row;
    });

  const peakPayoutRow = aggregateRows.reduce((peak, row) => {
    if (row.payoutInflow <= 0) return peak;
    return !peak || row.payoutInflow > peak.payoutInflow ? row : peak;
  }, null);

  return {
    memberReports,
    excludedPolicies,
    statisticsScopeNote: excludedPolicies.length
      ? '分红、万能账户存在收益或账户价值不确定因素，无法进入现金流统计；当前统计仅包含已识别的确定领取现金流，现金价值仅在保单明细展示。'
      : '',
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
    annualIncome: planningNumber(profile?.annualIncome),
    annualExpense: planningNumber(profile?.annualExpense),
    debt: planningNumber(profile?.debt),
    educationGoal: planningNumber(profile?.educationGoal),
    parentSupportGoal: planningNumber(profile?.parentSupportGoal),
    retirementGoal: planningNumber(profile?.retirementGoal),
    availableAssets: planningNumber(profile?.availableAssets),
    premiumBudget: planningNumber(profile?.premiumBudget),
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
  const parentSupportGoal = normalized.parentSupportGoal;
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
      debt + educationGoal + parentSupportGoal + annualExpense * FAMILY_PLANNING_DEFAULTS.lifeExpenseYears - availableAssets,
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
  if (indicatorCannotContributeRadarAmount(indicator)) return 0;
  if (indicatorIsFormulaOnly(indicator, policy)) return 0;
  return resolveIndicatorAmount(indicator, policy);
}

function parseSimpleMultiplier(value) {
  const text = String(value || '').normalize('NFKC').trim();
  if (!text) return 0;
  const numeric = finiteNumber(text);
  if (numeric !== null) return numeric;
  return {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  }[text] || 0;
}

function formulaLifeBaseReference(policy = {}, indicator = {}) {
  const text = `${indicatorText(indicator)} ${radarPolicyText(policy)}`.normalize('NFKC');
  const baseAmount = indicatorBaseAmount(indicator, policy);
  if (baseAmount <= 0 || !/(身故|全残)/u.test(text)) return null;

  const multipleMatch = text.match(/(?:有效保险金额|基本保险金额|基本保额|保险金额)(?:的)?\s*([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十])\s*倍/u)
    || text.match(/([0-9]+(?:\.[0-9]+)?|[一二两三四五六七八九十])\s*倍(?:的)?(?:有效保险金额|基本保险金额|基本保额|保险金额)/u);
  const multiplier = parseSimpleMultiplier(multipleMatch?.[1]);
  if (multiplier > 0) {
    const amount = baseAmount * multiplier;
    return {
      amount,
      sourceText: `保险金额${formatRadarMoney(baseAmount)} × ${formatNumberText(multiplier)}倍 = ${formatRadarMoney(amount)}`,
    };
  }

  if (/(基本保险金额|基本保额).{0,16}(累积红利保险金额|累计红利保险金额)/u.test(text)) {
    return {
      amount: baseAmount,
      sourceText: `基本保险金额${formatRadarMoney(baseAmount)}，红利部分不确定`,
    };
  }

  return null;
}

function formulaLifeReferenceAmount(policy = {}, indicator = {}) {
  const cashValue = deterministicLatestCashValue(policy)?.cashValue || 0;
  const baseReference = formulaLifeBaseReference(policy, indicator);
  const amount = Math.max(cashValue, asNumber(baseReference?.amount));
  if (amount <= 0) return null;
  const sources = [
    cashValue > 0 ? `现金价值${formatRadarMoney(cashValue)}` : null,
    baseReference?.sourceText || null,
  ].filter(Boolean);
  return {
    amount,
    calculationText: `${sources.join('，')}；公式型寿险固定保额不可量化，当前仅作参考下限`,
  };
}

function formulaLifeReferencePart(policy, indicator) {
  const reference = formulaLifeReferenceAmount(policy, indicator);
  if (!reference) return null;
  return {
    sourceKey: policySourceKey(policy),
    policyId: policy?.id,
    label: '公式型寿险参考下限',
    company: String(policy?.company || ''),
    productName: indicatorSourceProductName(policy, indicator),
    liability: lifeRadarLiabilityLabel(indicator),
    amount: reference.amount,
    calculationText: reference.calculationText,
    referenceOnly: true,
  };
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
  if (amount <= 0 && part?.referenceOnly !== true) return null;
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
    ...(part?.referenceOnly === true ? { referenceOnly: true } : {}),
  };
}

function radarAmountResult(amount, parts, fallbackNote = '') {
  const amountParts = parts.filter((part) => part?.referenceOnly !== true && asNumber(part.amount) > 0);
  const referenceParts = parts.filter((part) => part?.referenceOnly === true && asNumber(part.amount) > 0);
  const amountDetails = [...amountParts, ...referenceParts]
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

function criticalRadarAmount(policies, corrections = []) {
  const { rows } = buildMemberCriticalRows(policies, [], corrections);
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
  const corrected = applyRadarCorrectionsToParts(policies, 'critical', sourceParts, corrections);
  return radarAmountResult(
    amountPartsTotal(corrected.parts),
    corrected.parts,
    corrected.hasExcludedCorrection ? '已识别责任不可量化为固定保额' : (formulaOnly ? '公式型待确认' : '未识别到可落地金额'),
  );
}

const ACCIDENT_RADAR_ROW_KEYS = new Set(['general_accident', 'traffic', 'driving', 'public_transport', 'aviation', 'rail_ship', 'sudden_death']);

function accidentIndicatorRadarAmount(indicator, policy) {
  if (indicatorCannotContributeRadarAmount(indicator)) return null;
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

function accidentRadarAmount(policies, corrections = []) {
  const bestByScenario = new Map();

  for (const policy of policies) {
    const candidates = [];
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    for (const indicator of indicators) {
      const part = accidentIndicatorRadarAmount(indicator, policy);
      if (part) candidates.push(part);
    }

    const responsibilities = (Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).filter((item) => !indicatorIsReferenceOnly(item));
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
  const corrected = applyRadarCorrectionsToParts(policies, 'accident', parts, corrections);
  return radarAmountResult(
    amountPartsTotal(corrected.parts),
    corrected.parts,
    corrected.hasExcludedCorrection ? '已识别责任不可量化为固定保额' : '',
  );
}

function medicalRadarAmount(policies, corrections = []) {
  const parts = [];
  let hasFormula = false;
  let hasExcludedCorrection = false;
  let hasUnquantifiableMedical = false;
  for (const policy of policies) {
    const excludedByCorrection = correctionExcludesDimensionAmount(policy, 'medical', corrections);
    if (excludedByCorrection) hasExcludedCorrection = true;
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    let hasMedicalIndicator = false;
    for (const indicator of indicators) {
      const text = indicatorText(indicator);
      if (!/(医疗|住院|门诊|报销|百万医疗|手术|医疗费用)/u.test(text)) continue;
      hasMedicalIndicator = true;
      if (indicatorPlanIsInactive(policy, indicator)) continue;
      if (excludedByCorrection) continue;
      if (medicalIndicatorCannotContributeFixedAmount(indicator)) {
        hasUnquantifiableMedical = true;
        continue;
      }
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
    if (!excludedByCorrection && !hasMedicalIndicator && !parts.some((part) => part.sourceKey === sourceKey) && /(医疗|住院|门诊|报销|百万医疗|手术|医疗费用)/u.test(radarPolicyText(policy))) {
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
  const corrected = applyRadarCorrectionsToParts(policies, 'medical', parts, corrections);
  return radarAmountResult(
    amountPartsTotal(corrected.parts),
    corrected.parts,
    (hasExcludedCorrection || corrected.hasExcludedCorrection || hasUnquantifiableMedical) ? '报销型/不可量化责任未统计为固定保额' : (hasFormula ? '公式型待确认' : '未识别到可落地金额'),
  );
}

function lifeRadarAmount(policies, corrections = []) {
  const bestPartByPolicy = new Map();
  const referenceParts = [];
  let hasFormula = false;
  let hasUnquantifiableLife = false;
  for (const policy of policies) {
    const indicators = selectedCoverageIndicators(policy?.coverageIndicators);
    let hasLifeIndicator = false;
    for (const indicator of indicators) {
      const text = indicatorText(indicator);
      if (!/(身故|全残|终身寿|人寿保障|护理)/u.test(text)) continue;
      hasLifeIndicator = true;
      if (indicatorIsExplicitAccidentCoverage(indicator)) continue;
      if (/(重疾|重大疾病|中症|轻症|恶性肿瘤|癌)/u.test(text)) continue;
      if (indicatorPlanIsInactive(policy, indicator)) continue;
      if (indicatorCannotContributeRadarAmount(indicator)) {
        hasUnquantifiableLife = true;
        const referencePart = formulaLifeReferencePart(policy, indicator);
        if (referencePart) referenceParts.push(referencePart);
        continue;
      }
      if (indicatorIsFormulaOnly(indicator, policy)) {
        hasFormula = true;
        const referencePart = formulaLifeReferencePart(policy, indicator);
        if (referencePart) referenceParts.push(referencePart);
        continue;
      }
      const amount = indicatorAmountForPolicy(indicator, policy);
      if (amount > 0) {
        const liability = lifeRadarLiabilityLabel(indicator);
        const part = {
          sourceKey: policySourceKey(policy),
          policyId: policy?.id,
          label: liability,
          company: String(policy?.company || ''),
          productName: indicatorSourceProductName(policy, indicator),
          liability,
          amount,
          calculationText: lifeRadarCalculationText(indicator, policy, amount),
        };
        const previous = bestPartByPolicy.get(part.sourceKey);
        if (!previous || amount > previous.amount) bestPartByPolicy.set(part.sourceKey, part);
      }
    }
    const text = radarPolicyText(policy);
    const sourceKey = policySourceKey(policy);
    if (!bestPartByPolicy.has(sourceKey) && !hasLifeIndicator && /(终身寿|人寿|寿险|身故|全残|护理)/u.test(text) && !/(重疾|意外)/u.test(text)) {
      const amount = asNumber(policy?.amount);
      if (amount > 0) {
        bestPartByPolicy.set(sourceKey, {
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
  const parts = Array.from(bestPartByPolicy.values());
  const corrected = applyRadarCorrectionsToParts(policies, 'life', parts, corrections);
  const result = radarAmountResult(
    amountPartsTotal(corrected.parts),
    [...corrected.parts, ...referenceParts],
    (corrected.hasExcludedCorrection || hasUnquantifiableLife) ? '公式型/不可量化责任未统计为固定保额' : (hasFormula ? '公式型待确认' : '未识别到可落地金额'),
  );
  if (result.amount <= 0 && referenceParts.length) {
    const referenceAmount = Math.max(...referenceParts.map((part) => asNumber(part.amount)));
    return {
      ...result,
      amountText: `≥${formatRadarMoney(referenceAmount)}参考`,
      note: '固定保额不可量化，已展示公式型寿险参考下限',
      coveragePresent: true,
    };
  }
  return result;
}

function futurePayoutPresentValue(policy, discountRate = FAMILY_PLANNING_DEFAULTS.wealthDiscountRate) {
  const currentYear = new Date().getFullYear();
  return deterministicCashflowRows(policy).reduce((total, row) => {
    const years = Math.max(0, asNumber(row.year) - currentYear);
    const divisor = (1 + discountRate) ** years;
    return total + (asNumber(row.amount) / divisor);
  }, 0);
}

function payoutRunText(rows) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const liability = String(first?.liability || '未来领取').trim() || '未来领取';
  const amountText = formatRadarMoney(first?.amount);
  const years = rows.map((row) => asNumber(row.year)).filter((year) => year > 0);
  const contiguous = years.length > 1 && years.every((year, index) => index === 0 || year === years[index - 1] + 1);

  if (rows.length === 1) return `${liability}${amountText}(${first.year})`;
  if (contiguous) return `${liability}${amountText} × ${rows.length}年(${first.year}-${last.year})`;
  return `${liability}${amountText} × ${rows.length}次(${years.join('、')})`;
}

function futurePayoutCalculationText(rows) {
  const payouts = (Array.isArray(rows) ? rows : [])
    .filter((row) => asNumber(row?.amount) > 0)
    .sort((a, b) => asNumber(a.year) - asNumber(b.year));
  const total = payouts.reduce((sum, row) => sum + asNumber(row.amount), 0);
  if (!payouts.length) return `未来确定领取合计 = ${formatRadarMoney(0)}`;

  const runs = [];
  for (const row of payouts) {
    const previous = runs[runs.length - 1];
    const previousLast = previous?.[previous.length - 1];
    const sameRun = previousLast
      && String(previousLast.liability || '') === String(row.liability || '')
      && asNumber(previousLast.amount) === asNumber(row.amount)
      && asNumber(row.year) === asNumber(previousLast.year) + 1;
    if (sameRun) {
      previous.push(row);
    } else {
      runs.push([row]);
    }
  }

  return `未来确定领取合计 = ${runs.map(payoutRunText).join(' + ')} = ${formatRadarMoney(total)}`;
}

function wealthRadarAmount(policies, corrections = []) {
  let countedCashValue = 0;
  let referenceOnlyCashValue = 0;
  let futurePayout = 0;
  let futurePayoutPresent = 0;
  const parts = [];
  const hasUncertainWealthFactors = policies.some((policy) => wealthUncertaintyItems(policy).length > 0);
  for (const policy of policies) {
    const sourceKey = policySourceKey(policy);
    const company = String(policy?.company || '');
    const productName = String(policy?.name || '');
    const policyCashValue = deterministicLatestCashValue(policy)?.cashValue || 0;
    const policyPayoutRows = deterministicCashflowRows(policy);
    const policyFuturePayout = policyPayoutRows.reduce((total, row) => total + asNumber(row?.amount), 0);
    const hasFuturePayout = policyFuturePayout > 0;

    if (hasFuturePayout) {
      futurePayout += policyFuturePayout;
      futurePayoutPresent += futurePayoutPresentValue(policy);
      if (policyCashValue > 0) referenceOnlyCashValue += policyCashValue;
      parts.push({
        sourceKey: `${sourceKey}:future-payout`,
        policyId: policy?.id,
        company,
        productName,
        label: productName || '未来领取',
        liability: '未来领取',
        amount: policyFuturePayout,
        calculationText: futurePayoutCalculationText(policyPayoutRows),
      });
    } else if (policyCashValue > 0) {
      countedCashValue += policyCashValue;
      parts.push({
        sourceKey: `${sourceKey}:cash-value`,
        policyId: policy?.id,
        company,
        productName,
        label: productName || '现金价值参考',
        liability: '现金价值参考',
        amount: policyCashValue,
        calculationText: `现金价值参考 = ${formatRadarMoney(policyCashValue)}`,
      });
    }
  }
  const corrected = applyRadarCorrectionsToParts(policies, 'wealth', parts, corrections);
  const amount = amountPartsTotal(corrected.parts);
  const effectiveAmount = corrected.hasExcludedCorrection || amount !== countedCashValue + futurePayout
    ? amount
    : countedCashValue + futurePayoutPresent;
  const noteParts = [
    countedCashValue > 0 ? `现金价值参考${formatNumberText(countedCashValue)}` : null,
    futurePayout > 0 ? `未来领取${formatNumberText(futurePayout)}` : null,
    referenceOnlyCashValue > 0 ? `现金价值参考${formatNumberText(referenceOnlyCashValue)}未计入合计` : null,
  ].filter(Boolean);
  const uncertainNote = hasUncertainWealthFactors ? '；分红、万能账户不确定金额未统计' : '';
  return {
    amount,
    effectiveAmount,
    policyCount: uniquePolicyCount(corrected.parts),
    coveragePresent: policies.some((policy) => isWealthInsurancePolicy(policy) || wealthUncertaintyItems(policy).length > 0),
    note: amount > 0
      ? (corrected.hasExcludedCorrection ? '已识别财富责任不可量化为固定金额' : `${noteParts.join('，')}${uncertainNote}`)
      : (hasUncertainWealthFactors ? '分红、万能账户不确定金额未统计' : '未识别到可落地金额'),
    amountDetails: corrected.parts.map(radarAmountDetailFromPart).filter(Boolean),
  };
}

function radarAmountForDimension(policies, key, corrections = []) {
  if (key === 'critical') return criticalRadarAmount(policies, corrections);
  if (key === 'accident') return accidentRadarAmount(policies, corrections);
  if (key === 'medical') return medicalRadarAmount(policies, corrections);
  if (key === 'life') return lifeRadarAmount(policies, corrections);
  return wealthRadarAmount(policies, corrections);
}

function buildRadarScores(policies, corrections = []) {
  return RADAR_DIMENSIONS.map((dimension) => {
    const result = radarAmountForDimension(policies, dimension.key, corrections);
    const effectiveAmount = asNumber(result.effectiveAmount ?? result.amount);
    const coveragePresent = result.coveragePresent ?? result.amount > 0;
    return {
      key: dimension.key,
      label: dimension.label,
      amount: result.amount,
      effectiveAmount,
      coveragePresent,
      score: 0,
      amountText: result.amountText || formatRadarMoney(result.amount),
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

function radarSeriesKey(series) {
  return series?.memberKey || series?.name || '';
}

function distributeTarget(memberSeries, totalTarget, weightsByRole) {
  const weights = memberSeries.map((series) => Math.max(0, weightsByRole?.[series.role] ?? 1));
  const weightTotal = weights.reduce((total, weight) => total + weight, 0);
  if (totalTarget <= 0) return new Map(memberSeries.map((series) => [radarSeriesKey(series), 0]));
  if (weightTotal <= 0) {
    const equalTarget = totalTarget / Math.max(memberSeries.length, 1);
    return new Map(memberSeries.map((series) => [radarSeriesKey(series), equalTarget]));
  }
  return new Map(memberSeries.map((series, index) => [radarSeriesKey(series), totalTarget * (weights[index] / weightTotal)]));
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
    radarSeriesKey(series),
    {
      critical: criticalTargets.get(radarSeriesKey(series)) || 0,
      medical: FAMILY_PLANNING_DEFAULTS.medicalTarget,
      accident: accidentTargets.get(radarSeriesKey(series)) || 0,
      life: lifeTargets.get(radarSeriesKey(series)) || 0,
      wealth: (educationTargets.get(radarSeriesKey(series)) || 0) + (retirementTargets.get(radarSeriesKey(series)) || 0),
    },
  ]));
}

function normalizeMemberEstimatedScores(memberSeries, planningProfile) {
  const targetsByMember = memberEstimatedTargets(memberSeries, planningProfile);
  return memberSeries.map((series) => ({
    ...series,
    targetSource: 'system_estimate',
    scores: normalizeScoresAgainstTargets(series.scores, targetsByMember.get(radarSeriesKey(series)), 'system_estimate'),
  }));
}

function buildRadarSeries(group, policies, corrections = []) {
  const scores = buildRadarScores(policies, corrections);
  const totalAmount = scores.reduce((total, score) => total + score.amount, 0);
  const missingLabels = scores.filter((score) => score.coveragePresent === false).map((score) => score.label);
  const name = group.member;
  const role = memberRole(name, policies);
  return {
    memberKey: group.memberKey,
    memberId: group.memberId,
    name,
    relationLabel: group.relationLabel,
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
    if (!selected.some((item) => radarSeriesKey(item) === radarSeriesKey(series))) selected.push(series);
  }
  return {
    members: selected,
    hiddenMembers: memberSeries.filter((series) => !selected.some((item) => radarSeriesKey(item) === radarSeriesKey(series))),
  };
}

export function buildFamilyRadarReport(policies = [], planningProfile = null, options = {}) {
  const reportPolicies = activePolicies(policies);
  const corrections = trustedReportCorrections(options.corrections);
  const familyScores = buildRadarScores(reportPolicies, corrections);
  const normalizedPlanningProfile = normalizeFamilyPlanningProfile(planningProfile);
  const planningEnabled = hasFamilyPlanningProfile(normalizedPlanningProfile);
  const family = {
    name: '全家',
    scores: normalizeFamilyScores(familyScores, planningEnabled ? normalizedPlanningProfile : null),
    totalAmount: familyScores.reduce((total, score) => total + score.amount, 0),
    notes: familyScores.some((score) => score.coveragePresent === false)
      ? [`缺口维度: ${familyScores.filter((score) => score.coveragePresent === false).map((score) => score.label).join('、')}`]
      : [],
  };

  const groupMap = new Map();
  for (const policy of reportPolicies) {
    const member = memberGroupMeta(policy);
    if (!groupMap.has(member.memberKey)) {
      groupMap.set(member.memberKey, {
        ...member,
        policies: [],
      });
    }
    groupMap.get(member.memberKey).policies.push(policy);
  }

  const rawMembers = Array.from(groupMap.values(), (group) => buildRadarSeries(group, group.policies, corrections));
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
  const members = new Set(reportPolicies.map(memberKey));
  return {
    memberCount: members.size,
    policyCount: reportPolicies.length,
    annualPremium: reportPolicies.reduce((total, policy) => total + asNumber(policy?.firstPremium), 0),
    totalCoverage: reportPolicies.reduce((total, policy) => total + asNumber(policy?.amount), 0),
    cashValueTotal: reportPolicies.reduce((total, policy) => total + (deterministicLatestCashValue(policy)?.cashValue || 0), 0),
    futurePayoutTotal: reportPolicies.reduce((total, policy) => total + deterministicFuturePayoutTotal(policy), 0),
    attentionItems: [],
  };
}

export function buildPolicyInventory(policies = []) {
  const rows = policies.map(buildInventoryRow);
  const groupMap = new Map();

  for (const row of rows) {
    if (!groupMap.has(row.memberKey)) {
      groupMap.set(row.memberKey, {
        memberKey: row.memberKey,
        memberId: row.memberId,
        member: row.member,
        relationLabel: row.relationLabel,
        policies: [],
        annualPremium: 0,
        totalCoverage: 0,
        cashValueTotal: 0,
        futurePayoutTotal: 0,
      });
    }
    const group = groupMap.get(row.memberKey);
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

function buildOptionalResponsibilityGaps(policies = []) {
  const gaps = [];
  for (const policy of Array.isArray(policies) ? policies : []) {
    for (const item of Array.isArray(policy?.optionalResponsibilities) ? policy.optionalResponsibilities : []) {
      if (String(item?.selectionStatus || '') !== 'selected') continue;
      if (String(item?.quantificationStatus || '') !== 'pending_review') continue;
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

function verificationLabelFor(item = {}) {
  if (item?.verificationLabel) return String(item.verificationLabel);
  if (item?.referenceOnly === true || String(item?.verificationStatus || '') === 'pending_review') return '待核实参考';
  return String(item?.evidenceLabel || '待核实参考');
}

function buildPendingVerificationItems(policies = []) {
  const items = [];
  const pushItem = (policy = {}, item = {}, fallbackTitle = '') => {
    if (!indicatorIsReferenceOnly(item)) return;
    const title = String(item.title || item.sourceTitle || item.liability || item.coverageType || fallbackTitle || '待核实资料').trim();
    const key = [
      policy?.id,
      String(policy?.name || ''),
      title,
      String(item.url || item.sourceUrl || ''),
      String(item.sourceExcerpt || item.snippet || '').slice(0, 80),
    ].join('\u001f');
    if (items.some((existing) => existing.key === key)) return;
    items.push({
      key,
      policyId: policy?.id,
      company: String(policy?.company || ''),
      productName: String(policy?.name || item.productName || ''),
      title,
      sourceKind: String(item.sourceKind || ''),
      verificationStatus: String(item.verificationStatus || 'pending_review'),
      verificationLabel: verificationLabelFor(item),
      url: String(item.url || item.sourceUrl || ''),
      excerpt: String(item.sourceExcerpt || item.snippet || item.note || item.scenario || '').trim().slice(0, 220),
    });
  };

  for (const policy of Array.isArray(policies) ? policies : []) {
    for (const source of Array.isArray(policy?.sources) ? policy.sources : []) pushItem(policy, source, source?.title);
    for (const responsibility of Array.isArray(policy?.responsibilities) ? policy.responsibilities : []) pushItem(policy, responsibility, responsibility?.coverageType);
    for (const indicator of Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : []) pushItem(policy, indicator, indicator?.liability);
    for (const card of Array.isArray(policy?.responsibilityCards) ? policy.responsibilityCards : []) pushItem(policy, card, card?.title);
  }
  return items.slice(0, 20).map(({ key, ...item }) => item);
}

export function buildFamilyReport(policies = [], planningProfile = null, options = {}) {
  const reportPolicies = reportPoliciesForFamily(policies, options);
  const corrections = trustedReportCorrections(options.corrections);
  return {
    summary: buildFamilyReportSummary(reportPolicies),
    policyInventory: buildPolicyInventory(reportPolicies),
    optionalResponsibilityGaps: buildOptionalResponsibilityGaps(reportPolicies),
    pendingVerificationItems: buildPendingVerificationItems(reportPolicies),
    criticalIllness: buildCriticalIllnessSection(reportPolicies, corrections),
    accident: buildAccidentSection(reportPolicies),
    wealth: buildWealthSection(reportPolicies),
    radar: buildFamilyRadarReport(reportPolicies, planningProfile, { corrections }),
    appendix: {
      policies: reportPolicies.map((policy) => ({
        policyId: policy.id,
        productName: String(policy.name || ''),
        ocrText: String(policy.ocrText || ''),
      })),
    },
  };
}
