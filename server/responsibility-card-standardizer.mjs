import { normalizeIndicatorCalculation } from '../src/indicator-calculation.mjs';

const MISSING_OFFICIAL_EXCERPT_REASON = '缺少官方来源片段，不能进入计算';

const BLOCKED_CALCULATION_KEYS = new Set([
  'cash_value',
  'account_value',
  'schedule_or_policy_table',
  'medical_formula',
  'daily_allowance',
  'manual_formula',
  'unknown',
  'not_calculable',
]);

const BLOCKED_BASIS_KEYS = new Set([
  'cash_value',
  'account_value',
  'schedule_or_policy_table',
  'medical_expense',
  'daily_allowance',
  'rule_parameter',
  'unknown',
]);

const SCHEDULED_RESPONSIBILITY_TITLES = [
  '生存保险金',
  '满期保险金',
  '养老年金',
  '关爱年金',
  '祝寿金',
  '长寿金',
  '教育金',
  '高等教育保险金',
  '深造金',
  '立业金',
  '婚嫁金',
  '关爱金',
  '生存金',
  '满期金',
];

export const RESPONSIBILITY_CARD_INDICATOR_CHECK_VERSION = '2026-06-23-responsibility-card-indicator-check';

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function collapseChineseSpaces(value = '') {
  return text(value).replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1');
}

function firstNonEmpty(...values) {
  return values.map(text).find(Boolean) || '';
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function objectRows(value) {
  return rows(value).filter((row) => row && typeof row === 'object' && !Array.isArray(row));
}

function joinedText(...values) {
  return compact(values.flat().filter(Boolean).join(' '));
}

function sourceUrlFrom(row = {}) {
  return firstNonEmpty(row.sourceUrl, row.url, row.source_url);
}

function sourceExcerptFrom(row = {}) {
  return firstNonEmpty(row.sourceExcerpt, row.excerpt, row.sourceText, row.pageText);
}

function hasOfficialEvidence(indicator = {}) {
  return Boolean(sourceUrlFrom(indicator) && sourceExcerptFrom(indicator));
}

function liabilityName(indicator = {}) {
  return firstNonEmpty(
    indicator.liability,
    indicator.responsibilityName,
    indicator.benefitName,
    indicator.title,
    indicator.name,
    indicator.coverageType,
  );
}

function displayLiabilityName(indicator = {}, sourceExcerpt = '') {
  const liability = liabilityName(indicator);
  const name = compact(liability);
  const excerpt = compact(sourceExcerpt);
  const withoutForPrefix = text(liability).replace(/^对于/u, '').trim();
  if (withoutForPrefix && withoutForPrefix !== liability && /保险金/u.test(withoutForPrefix)) return withoutForPrefix;
  const cleanedLiability = cleanClauseTitle(liability);
  if (cleanedLiability && cleanedLiability !== liability) return cleanedLiability;
  if (name === '疾病全残' && excerpt.includes('身故或身体全残保险金')) return '身故或身体全残保险金';
  if (name === '满期返还' && excerpt.includes('满期保险金')) return '满期保险金';
  const concreteLiability = concreteScheduledLiabilityFromExcerptForAggregate(indicator, sourceExcerpt);
  if (concreteLiability) return concreteLiability;
  return liability;
}

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isWeakLiabilityName(value = '') {
  return /^(?:该项保险金|该项责任的基本保险金(?:额)?|相应保险金|对应的保险金|保险金|医疗保险金|补偿金|保险责任|责任|给付责任|保障责任|基本责任|可选责任)$/u.test(compact(value));
}

function isSentenceFragmentTitle(value = '') {
  const target = compact(value);
  if (!target) return false;
  if (/^(?:若|如|在本合同|本合同对|上述|中的|对于|身故当时|保险期间届满时|所交保险费|诉讼时效|补偿原则|受益人|申请人|被保险人对本公司请求给付|投保人指定|您在指定|代理申请|人寿保险的被保险人或者受益人|当被保险人|本公司对被保险人所负|本公司应承担|本公司收到申请人|本公司自收到申请人|我们已按本合同的约定给付|保单预期利益)/u.test(target)) return true;
  if (/^(?:范围和约定的基本保险金|[（(]?见表一[）)]?向被保险人支付保险金|向被保险人支付保险金)/u.test(target)) return true;
  if (/^的(?:保险金|豁免保险费)$/u.test(target)) return true;
  if (/^(?:能够实现即时结算约定保险责任|间是账户资金|权责分明的保险责任|元保单预期利益保险责任给付限额)/u.test(target)) return true;
  if (/^(?:主合同保险费已由本公司其他合同豁免|在给付本附加合同各项保险金|本公司给付的保险金|累计给付的|本保险累计给付的|本附加合同的.+豁免保险费和.+豁免保险费)/u.test(target)) return true;
  if (/^(?:本附加合同|本合同|上述)?(?:上述)?[一二三四五六七八九十\d]+项(?:保险金|补偿金)/u.test(target)) return true;
  if (/^(?:本附加合同|本合同|本主险合同)的.+(?:保险金|豁免保险费)$/u.test(target)) return true;
  if (/国寿附加.*豁免保险费/u.test(target)) return true;
  if (/疾病定义|严重慢性缩窄性心包炎/u.test(target) && target.length > 18) return true;
  if (/人民币.*保险单年度.*保险费/u.test(target)) return true;
  if (/^(?:[0-9]+(?:\.[0-9]+)?%|百分之[一二三四五六七八九十百零点\d]+).*(?:给付|额外给付|乘以)/u.test(target)) return true;
  if (/[，,。；;]/u.test(value)) return true;
  return target.length > 18 && /(?:本公司按|我们按|我们按照|给付基本|申领保险金|请求给付保险金|向.*给付.*保险金|指定.*保险金|变更.*保险金|收到.*保险金|现金价值|保险金为以下|本合同终止)/u.test(target);
}

function isRuleParameterText(value = '') {
  const target = compact(value);
  if (/规则参数/u.test(target)) return true;
  if (/^(?:等待期)$/u.test(target)) return true;
  return /^(?:现金流|医疗保障|疾病保障|人寿保障|意外保障|豁免|其他)?(?:赔付方式|给付方式|疾病种数|疾病数量|领取起始年龄|开始领取年龄|领取年龄|缴费年期)$/u.test(target);
}

function isDisplayOnlyMetricTitle(value = '') {
  const target = compact(value);
  if (/险$/u.test(target)) return false;
  if (/(?:保险金|年金|津贴|豁免|赔偿|补偿|伤残|身故|全残|责任|调整)$/u.test(target)) return false;
  return /给付倍数|增额|利率|限额/u.test(target);
}

function isWaiverText(value = '') {
  return /豁免/u.test(value);
}

function isClaimContingentText(value = '') {
  return /身故|死亡|全残|高残|伤残|残疾|残障|残废|重大疾病|重疾|中症|轻症|疾病|恶性肿瘤|癌症|癌|意外|医疗|住院|门诊|急诊|药品|医药|护理|失能|费用|报销|补偿/u.test(value);
}

function isScheduledCashflowText(value = '') {
  return /年金|养老金|生存金|生存保险金|生存|满期|满期保险金|满期生存|教育金|深造金|立业金|婚嫁金|祝寿|长寿|关爱金|关爱年金|领取/u.test(value);
}

function sourceExcerptSupportsResponsibilityTitle(title = '', sourceExcerpt = '') {
  const responsibilityTitle = compact(title);
  const excerpt = compact(sourceExcerpt);
  if (!responsibilityTitle || !excerpt.includes(responsibilityTitle)) return false;
  const titlePattern = escapeRegex(responsibilityTitle);
  const payoutWords = '(?:本公司|我们|按|给付|领取|保险金额|基本保险金额|保险费|保费|%|％)';
  return new RegExp(`${titlePattern}.{0,180}${payoutWords}|${payoutWords}.{0,180}${titlePattern}`, 'u').test(excerpt);
}

function concreteScheduledLiabilityFromExcerptForAggregate(indicator = {}, sourceExcerpt = '') {
  const liability = liabilityName(indicator);
  if (!isAggregateLiabilityName(liability)) return '';
  if (categoryFromIndicator(indicator, sourceExcerpt) !== '现金流') return '';
  const matches = SCHEDULED_RESPONSIBILITY_TITLES.filter((title) => sourceExcerptSupportsResponsibilityTitle(title, sourceExcerpt));
  return matches.length === 1 ? matches[0] : '';
}

function hasBlockedCalculationDependency(meta = {}) {
  return BLOCKED_CALCULATION_KEYS.has(meta.calculationKey) || BLOCKED_BASIS_KEYS.has(meta.basisKey);
}

function needsTableForCalculation(value = {}) {
  return (
    ['cash_value', 'account_value', 'schedule_or_policy_table', 'medical_formula', 'daily_allowance', 'manual_formula'].includes(value.calculationKey)
    || ['cash_value', 'account_value', 'schedule_or_policy_table', 'medical_expense', 'daily_allowance'].includes(value.basisKey)
  );
}

function semanticCalculationMeta(indicator = {}, meta = {}) {
  const target = joinedText(
    indicator.coverageType,
    indicator.liability,
    indicator.condition,
    indicator.formulaText,
    indicator.basis,
    indicator.sourceExcerpt,
  );

  if (/医疗费用|实际合理医疗费用|实际医疗费用|免赔额|报销|补偿/u.test(target)) {
    return {
      ...meta,
      basisKey: 'medical_expense',
      calculationKey: 'medical_formula',
      calculationEligible: false,
      calculationReason: '医疗费用型责任依赖实际费用、免赔额和补偿数据',
    };
  }

  return meta;
}

function hasReviewedIndicatorMetadata(indicator = {}) {
  return Boolean(
    text(indicator.calculationMetadataVersion)
    || text(indicator.extractionMethod) === 'manual_skill_review'
    || text(indicator.reviewVersion) === '2026-06-23-reviewed-responsibility-artifact-import',
  );
}

function reviewedCalculationMeta(indicator = {}, meta = {}) {
  const hasReviewedMetadata = hasReviewedIndicatorMetadata(indicator);
  const basisKey = text(indicator.basisKey);
  const calculationKey = text(indicator.calculationKey);
  if (!hasReviewedMetadata || (!basisKey && !calculationKey)) return meta;

  return {
    ...meta,
    basisKey: basisKey || meta.basisKey,
    calculationKey: calculationKey || meta.calculationKey,
    calculationEligible: typeof indicator.calculationEligible === 'boolean'
      ? indicator.calculationEligible
      : meta.calculationEligible,
    calculationReason: text(indicator.calculationReason) || meta.calculationReason,
  };
}

function reviewedCashflowTreatment(indicator = {}, treatment = '') {
  const explicitTreatment = text(indicator.cashflowTreatment);
  if (
    hasReviewedIndicatorMetadata(indicator)
    && ['scheduled_cashflow', 'claim_contingent', 'waiver_only', 'not_cashflow'].includes(explicitTreatment)
  ) {
    return explicitTreatment;
  }
  return treatment;
}

function reviewedIndicatorStatus(indicator = {}) {
  return hasReviewedIndicatorMetadata(indicator) ? text(indicator.indicatorCheckStatus) : '';
}

function reviewedIndicatorCalculationStatus(indicator = {}) {
  return hasReviewedIndicatorMetadata(indicator) ? text(indicator.calculationStatus) : '';
}

function categoryFromText(value = '') {
  const target = compact(value);
  if (/^现金流/u.test(target)) return '现金流';
  if (isRuleParameterText(target)) return '规则参数';
  if (/^(?:保险责任)?豁免保险费/u.test(target) || /豁免保险费$/u.test(target)) return '豁免';
  if (/(?:^|保险责任)(?:身故|身故或身体全残|身故或全残|全残|高残)(?:保险金|津贴)/u.test(target)) return '人寿保障';
  if (/失能收入损失保险金/u.test(target)) return '疾病保障';
  if (/(?:医疗事故|意外(?:伤害)?医疗|意外医药|医疗费用|医药补偿|门急诊|门诊|住院|生育医疗|公共保额医疗|旅行医疗|津贴|日额|每日|补贴)(?:保险金|补偿金|津贴)?/u.test(target)) return '医疗保障';
  if (/(?:^|保险责任)(?:身故|身故或身体全残|身故或全残)保险金/u.test(target)) return '人寿保障';
  if (/重大疾病|重疾|中症|轻症|疾病|恶性肿瘤|癌症|癌|护理|失能收入损失|失能/u.test(target)) return '疾病保障';
  if (/身故|死亡|全残|高残|人寿保障|寿险/u.test(target)) return '人寿保障';
  if (/医疗|住院|门诊|急诊|药品|医药|报销|补偿|费用|津贴|日额|每日|补贴/u.test(target)) return '医疗保障';
  if (/意外|伤残|残疾|残障|残废|交通|航空|驾乘/u.test(target)) return '意外保障';
  if (/年金|现金流|养老金|生存金|生存保险金|满期|祝寿|教育金|长寿|关爱金|领取/u.test(target)) return '现金流';
  if (isWaiverText(target)) return '豁免';
  return '其他';
}

function categoryFromIndicator(indicator = {}, sourceExcerpt = '') {
  const coreCategory = categoryFromText([
    indicator.coverageType,
    indicator.category,
    indicator.liability,
    indicator.responsibilityName,
    indicator.title,
    indicator.condition,
    indicator.triggerCondition,
  ].join(' '));
  if (coreCategory !== '其他') return coreCategory;
  return categoryFromText([
    indicator.formulaText,
    indicator.basis,
    sourceExcerpt,
  ].join(' '));
}

function cashflowTreatmentFor(indicator = {}, meta = {}) {
  const waiverTarget = joinedText(
    indicator.coverageType,
    indicator.category,
    indicator.liability,
    indicator.responsibilityName,
    indicator.title,
  );
  const coreTarget = joinedText(
    indicator.coverageType,
    indicator.category,
    indicator.liability,
    indicator.responsibilityName,
    indicator.title,
    indicator.condition,
    indicator.triggerCondition,
    indicator.formulaText,
    indicator.basis,
  );
  const target = joinedText(
    coreTarget,
    indicator.sourceExcerpt,
  );
  const coreIsClaimContingent = isClaimContingentText(coreTarget);
  const coreIsScheduledCashflow = isScheduledCashflowText(coreTarget);
  const targetIsScheduledCashflow = isScheduledCashflowText(target);
  const explicitCashflowCategory = categoryFromText(joinedText(indicator.coverageType, indicator.category)) === '现金流';

  if (isWaiverText(waiverTarget)) return 'waiver_only';
  if (isRuleParameterText(coreTarget)) return 'not_cashflow';
  if (explicitCashflowCategory) {
    if (meta.calculationKey === 'schedule_or_policy_table' || meta.basisKey === 'schedule_or_policy_table') return 'scheduled_cashflow';
    if (meta.calculationEligible && !hasBlockedCalculationDependency(meta)) return 'scheduled_cashflow';
    if (hasBlockedCalculationDependency(meta)) return 'scheduled_cashflow';
  }
  if (coreIsScheduledCashflow && !coreIsClaimContingent) {
    if (meta.calculationKey === 'schedule_or_policy_table' || meta.basisKey === 'schedule_or_policy_table') return 'scheduled_cashflow';
    if (meta.calculationEligible && !hasBlockedCalculationDependency(meta)) return 'scheduled_cashflow';
    return 'not_cashflow';
  }
  if (coreIsClaimContingent) return 'claim_contingent';
  if (targetIsScheduledCashflow) {
    if (meta.calculationKey === 'schedule_or_policy_table' || meta.basisKey === 'schedule_or_policy_table') return 'scheduled_cashflow';
    if (meta.calculationEligible && !hasBlockedCalculationDependency(meta)) return 'scheduled_cashflow';
    return 'not_cashflow';
  }
  if (isClaimContingentText(target)) return 'claim_contingent';
  return 'not_cashflow';
}

function calculationStatusFor({ calculationEligible, cashflowTreatment, calculationReason, calculationKey, basisKey }) {
  if (cashflowTreatment === 'waiver_only') return 'waiver_only';
  if (needsTableForCalculation({ calculationKey, basisKey })) return 'needs_table';
  if (calculationEligible && cashflowTreatment === 'scheduled_cashflow') return 'calculable';
  if (calculationEligible && cashflowTreatment === 'claim_contingent') return 'claim_contingent';
  if (cashflowTreatment === 'not_cashflow') {
    return calculationReason ? 'needs_review' : 'not_cashflow';
  }
  if (cashflowTreatment === 'claim_contingent') return 'claim_contingent';
  return 'needs_review';
}

function calculationReasonFor(indicator = {}, meta = {}) {
  const name = liabilityName(indicator);
  if (!hasOfficialEvidence(indicator)) return MISSING_OFFICIAL_EXCERPT_REASON;
  if (!name || isWeakLiabilityName(name)) return '责任名称不独立，不能进入计算';
  if (!meta.calculationEligible) return text(meta.calculationReason) || '未识别到可计算基准';
  return '';
}

function officialExcerptMarksLiabilityOptional(indicator = {}) {
  const excerpt = compact(sourceExcerptFrom(indicator));
  const liabilityNames = [...new Set([
    compact(liabilityName(indicator)),
    compact(displayLiabilityName(indicator, sourceExcerptFrom(indicator))),
  ].filter(Boolean))];
  if (!liabilityNames.length || !excerpt) return false;
  if (isRuleParameterText(joinedText(indicator.coverageType, liabilityNames[0]))) return false;
  if (liabilityNames.some((liability) => {
    const liabilityPattern = escapeRegex(liability);
    return new RegExp(`(?:若您未选择|若您选择|您未选择|您可以选择|您可选择|投保人可以选择|投保人可选择)(?:该|该项|本项|此项)?${liabilityPattern}|${liabilityPattern}.{0,40}(?:若您未选择|未选择该|未选择本项|未选择)`, 'u').test(excerpt);
  })) return true;
  if (!excerpt.includes('可选责任')) return false;
  const optionalIndex = excerpt.indexOf('可选责任');
  const isMixedResponsibilityOverview = /基本责任.{0,8}可选责任/u.test(excerpt) && /(?:1[.．、])?基本责任/u.test(excerpt);
  if (!isMixedResponsibilityOverview && optionalIndex >= 0 && optionalIndex <= 80 && excerpt.length <= 700) return true;
  if (isMixedResponsibilityOverview) {
    return liabilityNames.some((liability) => {
      const liabilityPattern = escapeRegex(liability);
      return new RegExp(`(?:\\d{1,2}[.．、])可选责任(?![^。；;]{0,40}基本责任).{0,120}${liabilityPattern}|${liabilityPattern}.{0,120}(?:若您未选择|若您选择|您未选择|您可以选择|您可选择|投保人可以选择|投保人可选择|选择该)`, 'u').test(excerpt);
    });
  }
  return liabilityNames.some((liability) => {
    const liabilityPattern = escapeRegex(liability);
    return new RegExp(`可选责任.{0,120}${liabilityPattern}|${liabilityPattern}.{0,120}可选责任`, 'u').test(excerpt);
  });
}

function indicatorSelectionFields(indicator = {}) {
  const responsibilityScope = text(indicator.responsibilityScope);
  const selectionStatus = text(indicator.selectionStatus);
  const selectionEvidence = text(indicator.selectionEvidence);
  if (responsibilityScope === 'optional') {
    return {
      responsibilityScope,
      selectionStatus: selectionStatus || 'unknown',
      selectionEvidence: selectionEvidence || 'indicator_scope',
    };
  }
  if (officialExcerptMarksLiabilityOptional(indicator)) {
    return {
      responsibilityScope: 'optional',
      selectionStatus: selectionStatus || 'unknown',
      selectionEvidence: selectionEvidence || 'official_terms',
    };
  }
  return {
    responsibilityScope,
    selectionStatus,
    selectionEvidence,
  };
}

export function standardizeResponsibilityIndicator(indicator = {}, { policy = {} } = {}) {
  const meta = reviewedCalculationMeta(indicator, semanticCalculationMeta(indicator, normalizeIndicatorCalculation(indicator)));
  const calculationReason = calculationReasonFor(indicator, meta);
  const calculationEligible = Boolean(meta.calculationEligible) && !calculationReason;
  const sourceUrl = sourceUrlFrom(indicator);
  const sourceExcerpt = sourceExcerptFrom(indicator);
  const treatment = hasOfficialEvidence(indicator)
    ? reviewedCashflowTreatment(indicator, cashflowTreatmentFor(indicator, { ...meta, calculationEligible }))
    : 'not_cashflow';
  const liability = displayLiabilityName(indicator, sourceExcerpt);
  const selectionFields = indicatorSelectionFields(indicator);
  const reviewedReason = hasReviewedIndicatorMetadata(indicator) ? text(indicator.calculationReason) : '';
  const normalized = {
    id: text(indicator.id),
    company: firstNonEmpty(indicator.company, policy.company),
    productName: firstNonEmpty(indicator.productName, policy.productName, policy.name),
    coverageType: text(indicator.coverageType),
    liability,
    category: categoryFromIndicator(indicator, sourceExcerpt),
    triggerCondition: firstNonEmpty(indicator.triggerCondition, indicator.condition),
    payoutSummary: firstNonEmpty(indicator.payoutSummary, indicator.formulaText, indicator.basis),
    basis: text(indicator.basis),
    formulaText: text(indicator.formulaText),
    value: meta.value ?? indicator.value ?? null,
    valueText: text(indicator.valueText),
    unit: firstNonEmpty(meta.unit, indicator.unit),
    basisKey: meta.basisKey,
    calculationKey: meta.calculationKey,
    calculationEligible,
    calculationReason: reviewedReason || (calculationEligible ? '' : calculationReason),
    calculationMetadataVersion: text(indicator.calculationMetadataVersion),
    indicatorCheckStatus: reviewedIndicatorStatus(indicator),
    reviewedCalculationStatus: reviewedIndicatorCalculationStatus(indicator),
    reviewedIndicatorCheckStatus: reviewedIndicatorStatus(indicator),
    cashflowTreatment: treatment,
    sourceUrl,
    sourceTitle: text(indicator.sourceTitle),
    sourceExcerpt,
    confidence: sourceUrl && sourceExcerpt ? 'high' : 'low',
    ...selectionFields,
  };

  return {
    ...normalized,
    calculationStatus: calculationStatusFor(normalized),
  };
}

function responsibilityTitle(row = {}) {
  const explicit = firstNonEmpty(row.liability, row.responsibilityName, row.benefitName, row.title, row.name);
  if (explicit) return explicit;
  const coverageType = text(row.coverageType);
  if (coverageType && !isWeakLiabilityName(coverageType)) return coverageType;
  const scenario = text(row.scenario || row.description || row.desc || row.content);
  const match = scenario.match(/^([\p{Script=Han}A-Za-z0-9（）()·\-]{2,24}?(?:保险金|年金|生存金|教育金|养老金|满期金|关爱金|津贴|豁免))/u);
  if (match) return match[1];
  return firstNonEmpty(coverageType, '保险责任');
}

function normalizeResponsibility(row = {}) {
  return {
    company: firstNonEmpty(row.company, row.companyName, row.insurer),
    productName: firstNonEmpty(row.productName, row.product_name, row.matchedProductName, row.policyName),
    canonicalProductId: firstNonEmpty(row.canonicalProductId, row.canonical_product_id),
    title: responsibilityTitle(row),
    coverageType: text(row.coverageType),
    scenario: text(row.scenario || row.description || row.desc || row.content),
    payout: text(row.payout || row.limit || row.amount || row.formulaText),
    note: text(row.note || row.remark),
    sourceUrl: sourceUrlFrom(row),
    sourceTitle: firstNonEmpty(row.sourceTitle, row.title),
    sourceExcerpt: sourceExcerptFrom(row) || text(row.scenario || row.description || row.desc || row.content),
    responsibilityScope: text(row.responsibilityScope),
    selectionStatus: text(row.selectionStatus),
    selectionEvidence: text(row.selectionEvidence),
  };
}

function isInvalidResponsibilityTitle(value = '') {
  const target = compact(value);
  if (/^(?:本公司|我们)?不(?:再)?承担|不再承担给付|责任免除/u.test(target)) return true;
  if (/^等待期/u.test(target)) {
    return !/(?:退还|返还|给付)(?:所交|已交)?(?:风险保险费|保险费|保费)|(?:所交|已交)?(?:风险保险费|保险费|保费).{0,8}(?:退还|返还|给付)/u.test(target);
  }
  return false;
}

function knowledgeMatchesPolicy(record = {}, policy = {}) {
  const recordCompany = compact(record.company);
  const policyCompany = compact(policy.company);
  if (recordCompany && policyCompany && recordCompany !== policyCompany) return false;
  const recordProductName = compact(record.productName || record.product_name || record.name);
  const policyProductName = compact(policy.productName || policy.name);
  if (recordProductName && policyProductName && recordProductName !== policyProductName) return false;
  return true;
}

function responsibilityClauseTitle(value = '') {
  const cleaned = collapseChineseSpaces(value);
  const boundary = cleaned.match(/^(.{2,60}?)(?=\s*(?:被保险人|受益人|本公司|我们|除另有约定|若|如|自|在|本合同|本附加合同|本主险合同))/u);
  if (boundary && isResponsibilityTitle(boundary[1])) {
    return cleanClauseTitle(boundary[1]);
  }
  const match = cleaned.match(/^(.{2,52}?(?:豁免保险费|保险金|保险责任|年金|生存金|教育金|养老金|满期金|祝寿金|长寿金|关爱金|津贴|豁免))/u);
  return match ? cleanClauseTitle(match[1]) : '';
}

function cleanClauseTitle(value = '') {
  const title = collapseChineseSpaces(value)
    .replace(/^第[一二三四五六七八九十百千万\d]+条\s*/u, '')
    .replace(/^(?:\d+\s*[.．、]\s*)+\d*\s*/u, '')
    .replace(/^\d+(?:\.\d+)*\s*/u, '')
    .replace(/^\d+\s+(?=[\p{Script=Han}])/u, '')
    .replace(/^[.．、\s]+/u, '')
    .replace(/^[（(]\s*[一二三四五六七八九十\d]+\s*[）)]\s*/u, '')
    .replace(/^[“"‘'「『【]+/u, '')
    .replace(/[”"’'」』】]+$/u, '')
    .replace(/身敀/u, '身故')
    .replace(/^被保险人(?=(?:身故|生存|满期|疾病|意外|重大疾病|轻症|中症))/u, '')
    .replace(/^本公司(?:按月)?给付(?=.+(?:保险金|豁免保险费)$)/u, '')
    .replace(/^保险费(?=.+豁免保险费$)/u, '')
    .replace(/[（(](?:基本|可选|必选)?保险责任[）)]$/u, '')
    .replace(/[：:，,。；;、\s]+$/u, '');
  if (/\d+[.．]\d/u.test(title)) return '';
  return title;
}

function isResponsibilityTitle(value = '') {
  const title = cleanClauseTitle(value);
  if (!title || isWeakLiabilityName(title) || isInvalidResponsibilityTitle(title)) return false;
  return /(?:保险责任|豁免保险费|保险金|年金|生存金|教育金|养老金|满期金|祝寿金|长寿金|关爱金|津贴|豁免|金)$/u.test(title);
}

function isBadInferredResponsibilityTitle(value = '') {
  return /^(?:比例|赔付比例|给付比例|限额|给付限额|金额|数额|并按|等值于|责任中的|本公司应承担)/u.test(compact(value));
}

function inferredResponsibilityTitleFromClause(clause = '', context = {}) {
  const target = collapseChineseSpaces(clause);
  const compactTarget = compact(target);
  const contextTarget = compact(joinedText(context.productName, context.sourceTitle));
  if (/失能收入损失/u.test(contextTarget) && /(?:全残|丧失工作能力|失能)/u.test(compactTarget) && /给付|赔付|补偿|支付/u.test(compactTarget)) return '失能收入损失保险金';
  const quoted = target.match(/(?:给付|支付|赔付|赔偿|补偿|报销)\s*[“"「『【]([^”"」』】]{2,40}?(?:保险金|补偿金|年金|津贴|豁免保险费))[”"」』】]/u);
  if (quoted) {
    const title = cleanClauseTitle(quoted[1]);
    if (
      title
      && !isWeakLiabilityName(title)
      && !isSentenceFragmentTitle(title)
      && !isBadInferredResponsibilityTitle(title)
    ) return title;
  }
  const explicit = target.match(/(?:给付|支付|赔付|赔偿|补偿|报销)(?:[^，。,；;]{0,24}?)([\p{Script=Han}A-Za-z0-9（）()·\-「」『』“”【】]{2,32}?(?:保险金|补偿金|年金|津贴|豁免保险费))/u);
  if (explicit) {
    const title = cleanClauseTitle(explicit[1]).replace(/^责任中的/u, '');
    if (
      title
      && !isWeakLiabilityName(title)
      && !isSentenceFragmentTitle(title)
      && !isBadInferredResponsibilityTitle(title)
    ) return title;
  }
  if (/意外医药补偿|意外医疗/u.test(compactTarget) && /给付|赔付|补偿|报销/u.test(compactTarget)) return '意外医疗保险金';
  if (/医疗事故/u.test(compactTarget) && /给付|赔付|补偿|报销/u.test(compactTarget)) return '医疗事故保险金';
  if (/骨折/u.test(compactTarget) && /给付|赔付|补偿|支付/u.test(compactTarget)) return '骨折保险金';
  if (/失能收入损失|丧失工作能力/u.test(compactTarget) && /给付|赔付|补偿|报销|支付/u.test(compactTarget)) return '失能收入损失保险金';
  if (/住院|门诊|医疗|医药|费用/u.test(compactTarget) && /给付|赔付|补偿|报销/u.test(compactTarget)) return '医疗费用保险金';
  if (/豁免/u.test(compactTarget) && /保险费/u.test(compactTarget)) return '豁免保险费';
  if (/全残/u.test(compactTarget) && /津贴/u.test(compactTarget)) return '全残津贴';
  if (/全残|高残/u.test(compactTarget) && /给付|赔付|补偿|支付/u.test(compactTarget)) return '全残保险金';
  if (/身故|死亡/u.test(compactTarget)) {
    if (/全残|身体全残|永久完全残疾|残疾/u.test(compactTarget)) return '身故或全残保险金';
    return '身故保险金';
  }
  if (/重大疾病|重疾/u.test(compactTarget)) return '重大疾病保险金';
  if (/轻症/u.test(compactTarget)) return '轻症疾病保险金';
  if (/疾病/u.test(compactTarget)) return '疾病保险金';
  if (/养老年金|养老金/u.test(compactTarget)) return '养老年金';
  if (/年金/u.test(compactTarget)) return '年金';
  if (/生存/u.test(compactTarget)) return '生存保险金';
  if (/满期/u.test(compactTarget)) return '满期保险金';
  if (/住院|医疗|门诊|急诊|费用|报销|补偿/u.test(compactTarget)) return '医疗费用保险金';
  return '';
}

function isResponsibilitySectionIntro(clause = '') {
  const target = compact(clause);
  return /(?:下述|以下|下列|如下|一种|几项|各项|所选择).{0,80}(?:保险责任|责任项目|年金类型|给付年金|承担如下)/u.test(target);
}

function isNonResponsibilityAdministrativeClause(value = '') {
  const target = compact(value);
  if (!target) return false;
  const head = target.replace(/^[.．、\s]+/u, '').slice(0, 220);
  if (/^(?:索赔申请|保险金申请|理赔申请|申请保险金|保险金的申请|身故保险金的申请|残废保险金的申请|残疾保险金的申请|给付表|释义|定义|权益转让|受益人|保险金受益人|身故保险金受益人|住所或通讯地址|合同的转让|投保人地址|诉讼时效|补偿原则)/u.test(head)) return true;
  if (/申请(?:书|人)|索赔申请|户籍证明|身份证件|死亡证明|验尸证明|宣告死亡|证明和资料|请求权|受益人(?:的)?指定|受益人变更|法定继承人|给付表/u.test(head)) return true;
  if (/身故保险金受益人|权益转让|变更受益人/u.test(head) && !/(?:若|如|在).{0,80}(?:身故|全残|残疾|烧伤).{0,80}(?:给付|赔付)/u.test(head)) return true;
  return false;
}

function isResponsibilityClause(value = '') {
  const target = compact(value);
  if (isNonResponsibilityAdministrativeClause(value)) return false;
  return /(?:本公司|我们).{0,100}(?:给付|赔偿|赔付|报销|补偿|承担|免交|豁免|视同)|(?:给付|赔偿|赔付|报销|补偿|免交|豁免).{0,30}(?:保险金|保险费|年金|津贴|费用)/u.test(target);
}

function knowledgeClauseSelection(clause = '') {
  const target = compact(clause);
  if (!/可选责任|您可以选择|可以选择|选择该/u.test(target)) return {};
  return {
    responsibilityScope: 'optional',
    selectionStatus: 'unknown',
    selectionEvidence: 'official_terms',
  };
}

function numberedResponsibilitiesFromKnowledge(record = {}, policy = {}) {
  if (!record || typeof record !== 'object') return [];
  if (record.official === false || record.qualityStatus === 'invalid_responsibility') return [];
  if (!knowledgeMatchesPolicy(record, policy)) return [];
  const sourceUrl = sourceUrlFrom(record);
  const sourceText = firstNonEmpty(record.pageText, record.sourceExcerpt, record.excerpt, record.sourceText);
  if (!sourceUrl || !sourceText) return [];

  const normalized = text(sourceText).normalize('NFKC').replace(/\r/gu, '').replace(/\s+/gu, ' ');
  const markerPattern = /(^|[\s。；;])(?:\d{1,2}(?:[.．]\d{1,2})+\s*|(\d{1,2})\s*[.．、]\s*|[一二三四五六七八九十]+\s*[.．、]\s*|[（(][一二三四五六七八九十]+[）)]\s*)/gu;
  const markers = [...normalized.matchAll(markerPattern)]
    .map((match) => ({
      markerStart: match.index + match[1].length,
      bodyStart: match.index + match[0].length,
    }));
  const responsibilities = [];

  markers.forEach((marker, index) => {
    const next = markers[index + 1];
    const clause = text(normalized.slice(marker.bodyStart, next ? next.markerStart : normalized.length));
    const clauseTitle = responsibilityClauseTitle(clause);
    const title = !clauseTitle || isWeakLiabilityName(clauseTitle)
      ? inferredResponsibilityTitleFromClause(clause, {
        productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
        sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
      })
      : clauseTitle;
    if (!title || isWeakLiabilityName(title) || !isResponsibilityClause(clause)) return;
    responsibilities.push({
      company: firstNonEmpty(record.company, policy.company),
      productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
      coverageType: '保险责任',
      liability: title,
      scenario: clause,
      sourceUrl,
      sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
      sourceExcerpt: clause,
      ...knowledgeClauseSelection(clause),
    });
  });

  return responsibilities;
}

function sectionResponsibilitiesFromKnowledge(record = {}, policy = {}) {
  if (!record || typeof record !== 'object') return [];
  if (record.official === false || record.qualityStatus === 'invalid_responsibility') return [];
  if (!knowledgeMatchesPolicy(record, policy)) return [];
  const sourceUrl = sourceUrlFrom(record);
  const sourceText = firstNonEmpty(record.pageText, record.sourceExcerpt, record.excerpt, record.sourceText);
  if (!sourceUrl || !sourceText) return [];

  const normalized = text(sourceText).normalize('NFKC').replace(/\r/gu, '').replace(/\s+/gu, ' ');
  const markerPattern = /(^|[\s。；;])保险责任\s*(?=[：:在若如被本我])/gu;
  const markers = [...normalized.matchAll(markerPattern)]
    .map((match) => ({
      markerStart: match.index + match[1].length,
    }));
  const responsibilities = [];

  markers.forEach((marker, index) => {
    const next = markers[index + 1];
    const clause = text(normalized.slice(marker.markerStart, next ? next.markerStart : normalized.length));
    if (!clause || isResponsibilitySectionIntro(clause) || !isResponsibilityClause(clause)) return;
    const title = inferredResponsibilityTitleFromClause(clause, {
      productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
      sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
    });
    if (!title || isWeakLiabilityName(title) || isInvalidResponsibilityTitle(title) || isSentenceFragmentTitle(title)) return;
    responsibilities.push({
      company: firstNonEmpty(record.company, policy.company),
      productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
      coverageType: '保险责任',
      liability: title,
      scenario: clause,
      sourceUrl,
      sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
      sourceExcerpt: clause,
      ...knowledgeClauseSelection(clause),
    });
  });

  return responsibilities;
}

function articleResponsibilitiesFromKnowledge(record = {}, policy = {}) {
  if (!record || typeof record !== 'object') return [];
  if (record.official === false || record.qualityStatus === 'invalid_responsibility') return [];
  if (!knowledgeMatchesPolicy(record, policy)) return [];
  const sourceUrl = sourceUrlFrom(record);
  const sourceText = firstNonEmpty(record.pageText, record.sourceExcerpt, record.excerpt, record.sourceText);
  if (!sourceUrl || !sourceText) return [];

  const normalized = text(sourceText).normalize('NFKC').replace(/\r/gu, '').replace(/\s+/gu, ' ');
  const markerPattern = /(^|[\s。；;])第[一二三四五六七八九十百千万\d]+条\s*保险责任\s*/gu;
  const markers = [...normalized.matchAll(markerPattern)]
    .map((match) => ({
      markerStart: match.index + match[1].length,
      bodyStart: match.index + match[0].length,
    }));
  const responsibilities = [];

  markers.forEach((marker, index) => {
    const next = markers[index + 1];
    const clause = text(normalized.slice(marker.markerStart, next ? next.markerStart : normalized.length));
    if (!clause || isResponsibilitySectionIntro(clause) || !isResponsibilityClause(clause)) return;
    const title = inferredResponsibilityTitleFromClause(clause, {
      productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
      sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
    });
    if (!title || isWeakLiabilityName(title) || isInvalidResponsibilityTitle(title) || isSentenceFragmentTitle(title)) return;
    responsibilities.push({
      company: firstNonEmpty(record.company, policy.company),
      productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
      coverageType: '保险责任',
      liability: title,
      scenario: clause,
      sourceUrl,
      sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
      sourceExcerpt: clause,
      ...knowledgeClauseSelection(clause),
    });
  });

  return responsibilities;
}

function titledResponsibilitiesFromKnowledge(record = {}, policy = {}) {
  if (!record || typeof record !== 'object') return [];
  if (record.official === false || record.qualityStatus === 'invalid_responsibility') return [];
  if (!knowledgeMatchesPolicy(record, policy)) return [];
  const sourceUrl = sourceUrlFrom(record);
  const sourceText = firstNonEmpty(record.pageText, record.sourceExcerpt, record.excerpt, record.sourceText);
  if (!sourceUrl || !sourceText) return [];

  const normalized = text(sourceText).normalize('NFKC').replace(/\r/gu, '').replace(/\s+/gu, ' ');
  const titlePattern = /(^|[\s。；;：:])([\p{Script=Han}A-Za-z0-9（）()·\-]{2,36}?)(?=\s*[：:，,]?\s*(?:被保险人|受益人|投保人|本公司|我们|若|如|除另有约定|在|自|本主险合同))/gu;
  const markers = [...normalized.matchAll(titlePattern)]
    .map((match) => ({
      title: cleanClauseTitle(match[2]),
      titleStart: match.index + match[1].length,
    }))
    .filter((marker) => {
      return (
        marker.title
        && /(?:豁免保险费|保险金|保险责任|年金|生存金|教育金|养老金|满期金|祝寿金|长寿金|关爱金|津贴|豁免|金)$/u.test(marker.title)
        && !isWeakLiabilityName(marker.title)
        && !isInvalidResponsibilityTitle(marker.title)
        && !(compact(marker.title) === '生存金' && /包括以下(?:两项|三项)/u.test(compact(normalized.slice(Math.max(0, marker.titleStart - 40), marker.titleStart))))
      );
    });
  const responsibilities = [];

  markers.forEach((marker, index) => {
    const next = markers[index + 1];
    const clause = text(normalized.slice(marker.titleStart, next ? next.titleStart : normalized.length));
    if (!isResponsibilityClause(clause)) return;
    const title = isResponsibilityTitle(marker.title) ? marker.title : inferredResponsibilityTitleFromClause(clause, {
      productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
      sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
    });
    if (!title || isWeakLiabilityName(title)) return;
    responsibilities.push({
      company: firstNonEmpty(record.company, policy.company),
      productName: firstNonEmpty(record.productName, record.product_name, record.name, policy.productName, policy.name),
      coverageType: '保险责任',
      liability: title,
      scenario: clause,
      sourceUrl,
      sourceTitle: firstNonEmpty(record.title, record.sourceTitle),
      sourceExcerpt: clause,
      ...knowledgeClauseSelection(clause),
    });
  });

  return responsibilities;
}

function knowledgeResponsibilities(records = [], policy = {}) {
  const seen = new Set();
  const responsibilities = [];
  objectRows(records).forEach((record) => {
    const recordResponsibilities = [
      ...articleResponsibilitiesFromKnowledge(record, policy),
      ...numberedResponsibilitiesFromKnowledge(record, policy),
      ...titledResponsibilitiesFromKnowledge(record, policy),
    ];
    if (!recordResponsibilities.length) {
      recordResponsibilities.push(...sectionResponsibilitiesFromKnowledge(record, policy));
    }
    recordResponsibilities.forEach((responsibility) => {
      const key = cardKeyFor({ policy, responsibility, title: responsibility.liability });
      if (seen.has(key)) return;
      seen.add(key);
      responsibilities.push(responsibility);
    });
  });
  return responsibilities;
}

function shouldUseKnowledgeResponsibilities({
  responsibilities = [],
  coverageIndicators = [],
  optionalResponsibilityRecords = [],
} = {}) {
  if (objectRows(responsibilities).length >= 3) return false;
  if (objectRows(optionalResponsibilityRecords).length >= 3) return false;
  return objectRows(coverageIndicators).length <= 5;
}

function responsibilityMatchesIndicator(responsibility = {}, indicator = {}) {
  const responsibilityCompany = compact(responsibility.company);
  const indicatorCompany = compact(indicator.company);
  if (responsibilityCompany && indicatorCompany && responsibilityCompany !== indicatorCompany) return false;
  const responsibilityCanonicalId = compact(responsibility.canonicalProductId);
  const indicatorCanonicalId = compact(indicator.canonicalProductId);
  if (responsibilityCanonicalId && indicatorCanonicalId && responsibilityCanonicalId !== indicatorCanonicalId) return false;
  const responsibilityProductName = compact(responsibility.productName);
  const indicatorProductName = compact(indicator.productName);
  if (responsibilityProductName && indicatorProductName && responsibilityProductName !== indicatorProductName) return false;
  const indicatorTitle = compact(indicator.liability);
  if (!indicatorTitle || isWeakLiabilityName(indicatorTitle)) return false;
  const target = joinedText(
    responsibility.title,
    responsibility.coverageType,
    responsibility.scenario,
    responsibility.payout,
    responsibility.note,
  );
  if (target.includes(indicatorTitle)) return true;
  const responsibilityTitle = compact(responsibility.title);
  if (!responsibilityTitle) return false;
  const concreteLiability = concreteScheduledLiabilityFromExcerptForAggregate(indicator, indicator.sourceExcerpt);
  return compact(concreteLiability) === responsibilityTitle;
}

function bestKnowledgeRecord(records = []) {
  return objectRows(records).find((record) => sourceUrlFrom(record) || sourceExcerptFrom(record)) || {};
}

function isAggregateLiabilityName(value = '') {
  const target = compact(value);
  return /[\/／、]|等|综合|汇总/u.test(target);
}

function shouldCreateIndicatorCard(indicator = {}, { responsibility = null, hasKnowledgeResponsibilities = false } = {}) {
  if (isInvalidResponsibilityTitle(indicator.liability)) return false;
  if (isWeakLiabilityName(indicator.liability)) return false;
  if (isSentenceFragmentTitle(indicator.liability)) return false;
  if (isRuleParameterText(joinedText(indicator.coverageType, indicator.liability))) return false;
  if (isDisplayOnlyMetricTitle(indicator.liability)) return false;
  if (responsibility) return true;
  if (!hasKnowledgeResponsibilities) return true;
  if (isAggregateLiabilityName(indicator.liability) && categoryFromIndicator(indicator, indicator.sourceExcerpt) === '现金流') return false;
  return true;
}

function cardIdFor({ policy = {}, company = '', productName = '', title = '', index = 0 }) {
  const resolvedCompany = compact(company || policy.company);
  const resolvedProductName = compact(productName || policy.productName || policy.name);
  const cardTitle = compact(title || '保险责任');
  return `responsibility_card_${resolvedCompany || 'policy'}_${resolvedProductName || 'product'}_${cardTitle || index}`.slice(0, 180);
}

function cardKeyFor({ policy = {}, indicator = {}, responsibility = {}, title = '' }) {
  const canonicalProductId = firstNonEmpty(indicator.canonicalProductId, responsibility.canonicalProductId, policy.canonicalProductId);
  const company = firstNonEmpty(indicator.company, responsibility.company, policy.company);
  const productName = firstNonEmpty(indicator.productName, responsibility.productName, policy.productName, policy.name);
  const productKey = canonicalProductId
    ? `canonical:${compact(canonicalProductId)}`
    : `${compact(company)}:${compact(productName)}`;
  return `${productKey}:${compact(title || indicator.liability || responsibility.title || '保险责任')}`;
}

function plainSummaryFor({ title, triggerCondition, payoutSummary }) {
  return [title, triggerCondition, payoutSummary].map(text).filter(Boolean).join('：').slice(0, 280);
}

function cardSource({ indicator = {}, responsibility = {}, knowledge = {} }) {
  const indicatorExcerpt = sourceExcerptFrom(indicator);
  const responsibilityExcerpt = sourceExcerptFrom(responsibility);
  const knowledgeExcerpt = sourceExcerptFrom(knowledge);
  const preferredExcerpt = responsibilityExcerpt.length > indicatorExcerpt.length + 80
    ? responsibilityExcerpt
    : indicatorExcerpt;
  return {
    sourceUrl: firstNonEmpty(indicator.sourceUrl, responsibility.sourceUrl, sourceUrlFrom(knowledge)),
    sourceTitle: firstNonEmpty(responsibility.sourceTitle, indicator.sourceTitle, knowledge.title),
    sourceExcerpt: firstNonEmpty(preferredExcerpt, responsibilityExcerpt, knowledgeExcerpt),
  };
}

function cardStatus(indicators = []) {
  const reviewedStatuses = indicators.map((indicator) => text(indicator.reviewedCalculationStatus)).filter(Boolean);
  if (reviewedStatuses.length === 1) return reviewedStatuses[0];
  if (indicators.some(needsTableForCalculation)) return 'needs_table';
  if (indicators.some((indicator) => indicator.calculationEligible && indicator.cashflowTreatment === 'scheduled_cashflow')) {
    return 'calculable';
  }
  if (indicators.some((indicator) => indicator.calculationEligible && indicator.cashflowTreatment === 'claim_contingent')) {
    return 'claim_contingent';
  }
  if (indicators.some((indicator) => indicator.cashflowTreatment === 'claim_contingent')) return 'claim_contingent';
  if (indicators.some((indicator) => indicator.cashflowTreatment === 'waiver_only')) return 'waiver_only';
  if (indicators.some((indicator) => indicator.cashflowTreatment === 'not_cashflow' && !indicator.calculationReason)) return 'not_cashflow';
  return 'needs_review';
}

function cardTreatment(indicators = [], fallbackText = '') {
  if (indicators.some((indicator) => indicator.cashflowTreatment === 'scheduled_cashflow')) return 'scheduled_cashflow';
  if (indicators.some((indicator) => indicator.cashflowTreatment === 'claim_contingent')) return 'claim_contingent';
  if (indicators.some((indicator) => indicator.cashflowTreatment === 'waiver_only')) return 'waiver_only';
  const rawFallback = text(fallbackText);
  const target = compact(rawFallback);
  const head = compact(rawFallback.split(/[\s：:，,。；;]/u)[0]);
  if (isWaiverText(head)) return 'waiver_only';
  if (isClaimContingentText(head)) return 'claim_contingent';
  if (isScheduledCashflowText(head)) return 'scheduled_cashflow';
  if (isWaiverText(target)) return 'waiver_only';
  if (isScheduledCashflowText(target)) return 'scheduled_cashflow';
  if (isClaimContingentText(target)) return 'claim_contingent';
  return 'not_cashflow';
}

function normalizeResponsibilityText(value = '') {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function optionalResponsibilityTitle(item = {}) {
  return firstNonEmpty(item.liability, item.title, item.coverageType);
}

function responsibilityCardTitle(card = {}) {
  return firstNonEmpty(card.title, card.category, '保险责任');
}

function optionalResponsibilityMatchesCard(item = {}, card = {}) {
  const cardProduct = normalizeResponsibilityText(card.productName);
  const itemProduct = normalizeResponsibilityText(item.productName);
  if (cardProduct && itemProduct && cardProduct !== itemProduct) return false;
  const cardTitle = normalizeResponsibilityText(responsibilityCardTitle(card));
  const itemTitle = normalizeResponsibilityText(optionalResponsibilityTitle(item));
  return Boolean(cardTitle && itemTitle && (cardTitle === itemTitle || cardTitle.includes(itemTitle) || itemTitle.includes(cardTitle)));
}

function responsibilityCardSelectionStatus(card = {}, optionalResponsibilities = []) {
  const indicatorStatuses = objectRows(card.indicators)
    .map((indicator) => text(indicator.selectionStatus))
    .filter(Boolean);
  if (indicatorStatuses.includes('selected')) return 'selected';
  if (indicatorStatuses.includes('not_selected')) return 'not_selected';
  if (indicatorStatuses.includes('unknown')) return 'unknown';

  const matched = objectRows(optionalResponsibilities).find((item) => optionalResponsibilityMatchesCard(item, card));
  if (matched?.selectionStatus) return text(matched.selectionStatus);
  return text(card.selectionStatus);
}

function isVisibleResponsibilityCard(card = {}, optionalResponsibilities = []) {
  const status = responsibilityCardSelectionStatus(card, optionalResponsibilities);
  return !status || status === 'selected';
}

function responsibilityCardNote(card = {}) {
  const status = text(card.calculationStatus);
  if (status === 'calculable') return '按合同约定给付。';
  if (status === 'needs_table') return '具体金额以条款表格、保单载明信息、实际费用或实际天数为准。';
  if (status === 'claim_contingent') return '发生条款约定情形后给付。';
  if (status === 'waiver_only') return '符合条款条件时豁免后续保险费。';
  if (status === 'not_cashflow') return '属于合同规则或辅助说明。';
  return '以正式保险合同条款为准。';
}

export function indicatorCheckForResponsibilityCard(card = {}) {
  const indicators = Array.isArray(card.indicators) ? card.indicators : [];
  const reviewedStatuses = indicators.map((indicator) => text(indicator.reviewedIndicatorCheckStatus)).filter(Boolean);
  const calculationStatus = text(card.calculationStatus);
  const cashflowTreatment = text(card.cashflowTreatment);
  const issues = [];

  if (!text(card.sourceUrl)) issues.push('missing_source_url');
  if (!text(card.title)) issues.push('missing_liability_title');
  if (!indicators.length && !['not_cashflow', 'waiver_only'].includes(cashflowTreatment)) {
    issues.push('missing_structured_indicator');
  }
  if (calculationStatus === 'needs_review') issues.push('needs_manual_review');
  if (calculationStatus === 'needs_table') issues.push('requires_table_or_policy_data');
  if (calculationStatus === 'not_cashflow' && cashflowTreatment !== 'not_cashflow') issues.push('status_treatment_mismatch');

  const indicatorsNeedingMetadata = indicators.filter((indicator) => (
    !text(indicator.basisKey) || !text(indicator.calculationKey)
  ));
  if (indicatorsNeedingMetadata.length) issues.push('indicator_missing_calculation_metadata');

  const status = (() => {
    if (reviewedStatuses.length === 1 && !issues.includes('missing_source_url') && !issues.includes('missing_liability_title')) {
      return reviewedStatuses[0];
    }
    if (issues.includes('missing_source_url') || issues.includes('missing_liability_title')) return 'blocked';
    if (issues.includes('missing_structured_indicator')) return 'needs_indicator_review';
    if (issues.includes('indicator_missing_calculation_metadata')) return 'needs_metadata_update';
    if (issues.includes('needs_manual_review')) return 'needs_review';
    if (issues.includes('requires_table_or_policy_data')) return 'requires_table_or_policy_data';
    if (calculationStatus === 'calculable') return 'verified_calculable';
    if (calculationStatus === 'claim_contingent') return 'verified_claim_contingent';
    if (calculationStatus === 'waiver_only') return 'verified_waiver';
    if (calculationStatus === 'not_cashflow') return 'verified_not_cashflow';
    return 'needs_review';
  })();

  return {
    status,
    issues,
    summary: {
      indicatorCount: indicators.length,
      calculationStatus,
      cashflowTreatment,
      calculationEligibleCount: indicators.filter((indicator) => indicator.calculationEligible === true).length,
      tableDependentCount: indicators.filter((indicator) => (
        ['needs_table', 'medical_formula', 'daily_allowance', 'cash_value', 'account_value', 'schedule_or_policy_table'].includes(text(indicator.calculationStatus))
        || ['cash_value', 'account_value', 'schedule_or_policy_table', 'medical_formula', 'daily_allowance', 'manual_formula'].includes(text(indicator.calculationKey))
        || ['cash_value', 'account_value', 'schedule_or_policy_table', 'medical_expense', 'daily_allowance'].includes(text(indicator.basisKey))
      )).length,
    },
  };
}

function withIndicatorCheck(card = {}) {
  const indicatorCheck = indicatorCheckForResponsibilityCard(card);
  return {
    ...card,
    indicatorCheckStatus: indicatorCheck.status,
    indicatorCheckIssues: indicatorCheck.issues,
    indicatorCheckSummary: indicatorCheck.summary,
    indicatorCheckVersion: RESPONSIBILITY_CARD_INDICATOR_CHECK_VERSION,
  };
}

export function isGeneratedResponsibilityCountReport(value = '') {
  return /^(?:已按官网责任和指标核对生成|已整理)\s*\d+\s*项保险责任。?$/u.test(text(value));
}

function displaySnippet(value = '', limit = 54) {
  const cleaned = collapseChineseSpaces(value)
    .replace(/\s+/gu, ' ')
    .replace(/[。；;]+$/u, '')
    .trim();
  if (!cleaned) return '';
  return cleaned.length > limit ? `${cleaned.slice(0, limit)}...` : cleaned;
}

function uniqueText(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(text).filter(Boolean)) {
    const key = compact(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function summaryCategoryLabel(category = '') {
  const value = text(category);
  if (value === '现金流') return '满期/生存等确定领取';
  if (value === '人寿保障') return '身故或全残保障';
  if (value === '疾病保障') return '疾病/护理保障';
  if (value === '意外保障') return '意外保障';
  if (value === '医疗保障') return '医疗费用或津贴保障';
  if (value === '豁免') return '保费豁免';
  return value && value !== '其他' ? value : '';
}

function summaryCardTreatment(card = {}) {
  return text(card.cashflowTreatment) || cardTreatment(objectRows(card.indicators), [
    card.title,
    card.category,
    card.plainSummary,
    card.triggerCondition,
    card.payoutSummary,
    card.sourceExcerpt,
  ].join(' '));
}

function visibleCardsForSummary(cards = [], optionalResponsibilities = []) {
  return objectRows(cards).filter((card) => {
    const title = responsibilityCardTitle(card);
    if (!title || isWeakLiabilityName(title) || isRuleParameterText(title) || isDisplayOnlyMetricTitle(title)) return false;
    if (isDisplayOnlyAggregateCashflowCard(card, title)) return false;
    if (!isVisibleResponsibilityCard(card, optionalResponsibilities)) return false;
    const treatment = summaryCardTreatment(card);
    if (treatment === 'not_cashflow' && text(card.category) === '规则参数') return false;
    return treatment !== 'not_cashflow' || isClaimContingentText(title) || isScheduledCashflowText(title);
  });
}

function responsibilityListText(cards = [], limit = 6) {
  const items = uniqueText(cards.map((card) => {
    const title = responsibilityCardTitle(card);
    const payout = displaySnippet(firstNonEmpty(card.payoutSummary, card.triggerCondition), 44);
    if (!payout || compact(payout) === compact(title) || isFallbackSummaryValue(payout)) return title;
    return `${title}（${payout}）`;
  }));
  if (!items.length) return '';
  const shown = items.slice(0, limit);
  const suffix = items.length > shown.length ? `等 ${items.length} 项` : '';
  return [...shown, suffix].filter(Boolean).join('、');
}

function hasMutuallyExclusiveOrOneTimeLimit(cards = []) {
  const target = joinedText(cards.map((card) => card.sourceExcerpt));
  return /(?:最多给付其中一项|仅给付一项|只给付一项|以一次为限|一次为限|不能同时给付)/u.test(target);
}

function productSummaryFromCards({ productName = '', cards = [] } = {}) {
  const resolvedProductName = text(productName) || text(cards[0]?.productName) || '本产品';
  const categories = uniqueText(cards.map((card) => summaryCategoryLabel(card.category))).slice(0, 4);
  const scheduled = cards.filter((card) => summaryCardTreatment(card) === 'scheduled_cashflow');
  const claims = cards.filter((card) => summaryCardTreatment(card) === 'claim_contingent');
  const waivers = cards.filter((card) => summaryCardTreatment(card) === 'waiver_only');
  const needsTable = cards.filter((card) => text(card.calculationStatus) === 'needs_table');
  const sentences = [];

  sentences.push(`${resolvedProductName}主要提供${categories.length ? categories.join('、') : '合同约定保险责任'}。`);
  const scheduledText = responsibilityListText(scheduled);
  if (scheduledText) sentences.push(`确定领取类责任包括：${scheduledText}。`);
  const claimsText = responsibilityListText(claims);
  if (claimsText) sentences.push(`保障类责任包括：${claimsText}，发生事故或达到条款条件后按约定给付。`);
  const waiverText = responsibilityListText(waivers, 4);
  if (waiverText) sentences.push(`另有保费豁免类责任：${waiverText}。`);
  if (needsTable.length) {
    const tableText = responsibilityListText(needsTable, 4);
    sentences.push(`${tableText || '部分责任'}的具体金额以条款表格、账户价值、医疗费用或保单载明数据为准。`);
  }
  if (hasMutuallyExclusiveOrOneTimeLimit(cards)) {
    sentences.push('条款提示多项保险金存在择一或一次给付限制，量化时不能简单累加。');
  }

  return sentences.join('\n');
}

export function buildResponsibilitySummaryReportFromCards(cards = [], {
  optionalResponsibilities = [],
  productName = '',
  maxProducts = 4,
} = {}) {
  const visibleCards = visibleCardsForSummary(cards, optionalResponsibilities);
  if (!visibleCards.length) return '';

  const grouped = new Map();
  for (const card of visibleCards) {
    const key = text(card.productName) || text(productName) || '本产品';
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(card);
  }

  const productReports = [...grouped.entries()]
    .slice(0, maxProducts)
    .map(([name, productCards]) => productSummaryFromCards({ productName: name, cards: productCards }))
    .filter(Boolean);
  if (!productReports.length) return '';

  const hiddenProductCount = grouped.size - productReports.length;
  const footer = [
    hiddenProductCount > 0 ? `另有 ${hiddenProductCount} 个产品的责任已拆分为指标卡，详情见下方责任列表。` : '',
  ].filter(Boolean).join('\n');

  return [...productReports, footer].filter(Boolean).join('\n');
}

function summaryRowKey(row = {}) {
  return normalizeResponsibilityText(firstNonEmpty(row.coverageType, row.title, row.name, row.scenario));
}

function summaryRowProductKey(row = {}) {
  return normalizeResponsibilityText(row.productName);
}

function summaryRowsMatch(row = {}, candidate = {}) {
  const rowKey = summaryRowKey(row);
  const candidateKey = summaryRowKey(candidate);
  if (!rowKey || rowKey !== candidateKey) return false;
  const rowProductKey = summaryRowProductKey(row);
  const candidateProductKey = summaryRowProductKey(candidate);
  return !rowProductKey || !candidateProductKey || rowProductKey === candidateProductKey;
}

function normalizeSummaryRow(row = {}) {
  return {
    productName: text(row.productName),
    coverageType: text(row.coverageType || row.title || row.name),
    scenario: text(row.scenario),
    payout: text(row.payout),
    note: text(row.note),
    sourceUrl: text(row.sourceUrl),
    sourceTitle: text(row.sourceTitle || row.source),
  };
}

function hasSummaryRowContent(row = {}) {
  return Boolean(row.coverageType || row.scenario || row.payout || row.note);
}

function isGenericSummaryRow(row = {}) {
  return /^(?:保险责任|责任|保障责任)$/u.test(compact(row.coverageType));
}

function isFallbackSummaryValue(value = '') {
  return /^(?:以(?:正式)?条款(?:约定)?为准|按合同约定给付|需以正式条款核对)$/u.test(compact(value));
}

function isFallbackSummaryNote(value = '') {
  return /未匹配到通过核对的结构化|需继续核对条款和指标|当前只有责任名称|需以正式条款核对/u.test(text(value));
}

function preferCheckedSummaryValue(current = '', checked = '', { fallback = isFallbackSummaryValue } = {}) {
  const checkedValue = text(checked);
  if (!checkedValue) return text(current);
  const currentValue = text(current);
  if (!currentValue || fallback(currentValue)) return checkedValue;
  return currentValue;
}

function preferCheckedScenario(current = '', checked = '') {
  const checkedValue = text(checked);
  if (!checkedValue) return text(current);
  const currentValue = text(current);
  if (!currentValue || isFallbackSummaryValue(currentValue)) return checkedValue;
  const currentCompact = compact(currentValue);
  const checkedCompact = compact(checkedValue);
  if (checkedCompact && currentCompact.startsWith(checkedCompact) && currentCompact.length > checkedCompact.length + 5) {
    return checkedValue;
  }
  return currentValue;
}

function isDisplayOnlyAggregateCashflowCard(card = {}, title = '') {
  if (text(card.category) !== '现金流') return false;
  if (!isAggregateLiabilityName(title)) return false;
  const target = compact(title);
  return !SCHEDULED_RESPONSIBILITY_TITLES.some((item) => compact(item) === target);
}

function cardProductDisplayKey(card = {}) {
  return normalizeResponsibilityText(firstNonEmpty(card.company, '')) + '\u001f' + normalizeResponsibilityText(card.productName);
}

function isConcreteScheduledCashflowCard(card = {}) {
  const title = responsibilityCardTitle(card);
  return text(card.category) === '现金流'
    && text(card.cashflowTreatment) === 'scheduled_cashflow'
    && !isDisplayOnlyMetricTitle(title)
    && !isDisplayOnlyAggregateCashflowCard(card, title);
}

function shouldHideDisplayOnlyCard(card = {}, productKeysWithConcreteCashflow = new Set()) {
  const title = responsibilityCardTitle(card);
  if (!productKeysWithConcreteCashflow.has(cardProductDisplayKey(card))) return false;
  return isDisplayOnlyMetricTitle(title) || isDisplayOnlyAggregateCashflowCard(card, title);
}

function suppressDisplayOnlyCards(cards = []) {
  const productKeysWithConcreteCashflow = new Set(
    objectRows(cards)
      .filter(isConcreteScheduledCashflowCard)
      .map(cardProductDisplayKey)
      .filter(Boolean),
  );
  if (!productKeysWithConcreteCashflow.size) return cards;
  return cards.filter((card) => !shouldHideDisplayOnlyCard(card, productKeysWithConcreteCashflow));
}

export function responsibilityRowsFromCards(cards = [], { optionalResponsibilities = [] } = {}) {
  const rows = [];
  const seen = new Set();
  for (const card of objectRows(cards)) {
    const title = responsibilityCardTitle(card);
    const normalizedTitle = normalizeResponsibilityText(title);
    if (!normalizedTitle || isWeakLiabilityName(title) || isRuleParameterText(title) || isDisplayOnlyMetricTitle(title)) continue;
    if (isDisplayOnlyAggregateCashflowCard(card, title)) continue;
    if (text(card.cashflowTreatment) === 'not_cashflow' || text(card.category) === '规则参数') continue;
    if (!isVisibleResponsibilityCard(card, optionalResponsibilities)) continue;
    const key = `${normalizeResponsibilityText(card.productName)}\u001f${normalizedTitle}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      productName: text(card.productName),
      coverageType: title,
      scenario: firstNonEmpty(card.triggerCondition, card.plainSummary, card.sourceExcerpt, '以条款约定为准'),
      payout: firstNonEmpty(card.payoutSummary, '以正式条款为准'),
      note: responsibilityCardNote(card),
      sourceUrl: text(card.sourceUrl),
      sourceTitle: text(card.sourceTitle),
    });
  }
  return rows;
}

export function mergeCoverageTableWithCheckedRows(coverageTable = [], checkedRows = []) {
  const rawProvidedRows = objectRows(coverageTable)
    .map(normalizeSummaryRow)
    .filter(hasSummaryRowContent);
  const checkedSummaryRows = objectRows(checkedRows)
    .map(normalizeSummaryRow)
    .filter(hasSummaryRowContent);
  const providedRows = checkedSummaryRows.length
    ? rawProvidedRows.filter((row) => !isGenericSummaryRow(row))
    : rawProvidedRows;
  if (!providedRows.length) return checkedSummaryRows;
  if (!checkedSummaryRows.length) return providedRows;

  const usedCheckedIndexes = new Set();
  const mergedRows = providedRows.map((row) => {
    const key = summaryRowKey(row);
    const matchIndex = checkedSummaryRows.findIndex((candidate, index) => (
      !usedCheckedIndexes.has(index) && key && summaryRowsMatch(row, candidate)
    ));
    if (matchIndex < 0) return row;
    usedCheckedIndexes.add(matchIndex);
    const checked = checkedSummaryRows[matchIndex];
    return {
      productName: row.productName || checked.productName,
      coverageType: row.coverageType || checked.coverageType,
      scenario: preferCheckedScenario(row.scenario, checked.scenario),
      payout: preferCheckedSummaryValue(row.payout, checked.payout),
      note: preferCheckedSummaryValue(row.note, checked.note, { fallback: isFallbackSummaryNote }),
      sourceUrl: row.sourceUrl || checked.sourceUrl,
      sourceTitle: row.sourceTitle || checked.sourceTitle,
    };
  });

  for (const [index, row] of checkedSummaryRows.entries()) {
    if (!usedCheckedIndexes.has(index)) mergedRows.push(row);
  }
  return mergedRows;
}

function simpleScheduledPayoutSummary({ title = '', clause = '' } = {}) {
  const cardTitle = compact(title);
  if (!cardTitle || !isScheduledCashflowText(cardTitle)) return '';
  const normalizedClause = collapseChineseSpaces(clause).normalize('NFKC').replace(/\s+/gu, '');
  const match = normalizedClause.match(new RegExp(`(?:本公司|我们)?按(.{2,80}?)(?:一次性)?给付${escapeRegex(cardTitle)}`, 'u'));
  if (!match) return '';
  const basis = text(match[1]).replace(/[，,。；;]+$/u, '');
  const compactBasis = compact(basis);
  if (!compactBasis) return '';
  if (/(?:以下|二者|较大|较小|现金价值|本合同约定|约定给付)/u.test(compactBasis)) return '';
  if (!/(?:保险金额|有效保险金额|保险费|保费|已交|交纳|实际交纳|%|％)/u.test(compactBasis)) return '';
  return `${text(title)} = ${basis}`;
}

function createIndicatorCard({ indicator, responsibility, knowledge, policy, index }) {
  const title = firstNonEmpty(indicator.liability, responsibility?.title, '保险责任');
  const triggerCondition = firstNonEmpty(indicator.triggerCondition, responsibility?.scenario);
  const payoutSummary = firstNonEmpty(indicator.payoutSummary, responsibility?.payout, indicator.basis);
  const source = cardSource({ indicator, responsibility, knowledge });
  const company = firstNonEmpty(indicator.company, responsibility?.company, policy.company);
  const productName = firstNonEmpty(indicator.productName, responsibility?.productName, policy.productName, policy.name);
  const indicators = [indicator];

  return {
    id: cardIdFor({ policy, company, productName, title, index }),
    company,
    productName,
    title,
    category: categoryFromText(firstNonEmpty(indicator.coverageType, indicator.category, responsibility?.coverageType, title)),
    plainSummary: plainSummaryFor({ title, triggerCondition, payoutSummary }),
    triggerCondition,
    payoutSummary,
    ...source,
    confidence: source.sourceUrl && source.sourceExcerpt ? 'high' : 'medium',
    calculationStatus: cardStatus(indicators),
    calculationReason: indicator.calculationReason,
    cashflowTreatment: indicator.cashflowTreatment,
    responsibilityScope: firstNonEmpty(indicator.responsibilityScope, responsibility?.responsibilityScope),
    selectionStatus: firstNonEmpty(indicator.selectionStatus, responsibility?.selectionStatus),
    selectionEvidence: firstNonEmpty(indicator.selectionEvidence, responsibility?.selectionEvidence),
    indicators,
  };
}

function mergeIndicatorCard(card, indicator, responsibility, knowledge) {
  card.indicators.push(indicator);
  card.calculationStatus = cardStatus(card.indicators);
  card.cashflowTreatment = cardTreatment(card.indicators);
  if (!card.calculationReason && indicator.calculationReason) card.calculationReason = indicator.calculationReason;
  if (!card.triggerCondition) card.triggerCondition = firstNonEmpty(indicator.triggerCondition, responsibility?.scenario);
  if (!card.payoutSummary) card.payoutSummary = firstNonEmpty(indicator.payoutSummary, responsibility?.payout, indicator.basis);
  const source = cardSource({ indicator, responsibility, knowledge });
  if (!card.sourceUrl) card.sourceUrl = source.sourceUrl;
  if (!card.sourceTitle) card.sourceTitle = source.sourceTitle;
  if (!card.sourceExcerpt) card.sourceExcerpt = source.sourceExcerpt;
  if (!card.responsibilityScope) card.responsibilityScope = firstNonEmpty(indicator.responsibilityScope, responsibility?.responsibilityScope);
  if (!card.selectionStatus) card.selectionStatus = firstNonEmpty(indicator.selectionStatus, responsibility?.selectionStatus);
  if (!card.selectionEvidence) card.selectionEvidence = firstNonEmpty(indicator.selectionEvidence, responsibility?.selectionEvidence);
  card.plainSummary = plainSummaryFor({
    title: card.title,
    triggerCondition: card.triggerCondition,
    payoutSummary: card.payoutSummary,
  });
}

function createResponsibilityCard({ responsibility, knowledge, policy, index }) {
  const title = responsibility.title || '保险责任';
  const triggerCondition = responsibility.scenario;
  const payoutSummary = firstNonEmpty(
    responsibility.payout,
    simpleScheduledPayoutSummary({ title, clause: responsibility.scenario }),
  );
  const source = cardSource({ responsibility, knowledge });
  const company = firstNonEmpty(responsibility.company, policy.company);
  const productName = firstNonEmpty(responsibility.productName, policy.productName, policy.name);
  const treatment = cardTreatment([], [
    title,
    responsibility.coverageType,
    responsibility.scenario,
    responsibility.payout,
  ].join(' '));

  return {
    id: cardIdFor({ policy, company, productName, title, index }),
    company,
    productName,
    title,
    category: treatment === 'scheduled_cashflow' ? '现金流' : categoryFromText([responsibility.coverageType, title, triggerCondition, payoutSummary].join(' ')),
    plainSummary: plainSummaryFor({ title, triggerCondition, payoutSummary }),
    triggerCondition,
    payoutSummary,
    ...source,
    confidence: source.sourceUrl && source.sourceExcerpt ? 'medium' : 'low',
    calculationStatus: treatment === 'claim_contingent' ? 'claim_contingent' : (treatment === 'scheduled_cashflow' && payoutSummary ? 'calculable' : 'needs_review'),
    calculationReason: treatment === 'scheduled_cashflow' && payoutSummary ? '' : '以正式保险合同条款为准',
    cashflowTreatment: treatment,
    responsibilityScope: text(responsibility.responsibilityScope),
    selectionStatus: text(responsibility.selectionStatus),
    selectionEvidence: text(responsibility.selectionEvidence),
    indicators: [],
  };
}

export function buildResponsibilityCardsForPolicy({
  policy = {},
  responsibilities = policy.responsibilities,
  coverageIndicators = policy.coverageIndicators,
  knowledgeRecords = [],
  optionalResponsibilityRecords = [],
} = {}) {
  const derivedKnowledgeResponsibilities = shouldUseKnowledgeResponsibilities({
    responsibilities,
    coverageIndicators,
    optionalResponsibilityRecords,
  })
    ? knowledgeResponsibilities(knowledgeRecords, policy)
    : [];
  const normalizedResponsibilities = [
    ...derivedKnowledgeResponsibilities,
    ...objectRows(responsibilities),
    ...objectRows(optionalResponsibilityRecords),
  ]
    .map(normalizeResponsibility)
    .filter((responsibility) => !isInvalidResponsibilityTitle(responsibility.title) && !isWeakLiabilityName(responsibility.title) && !isSentenceFragmentTitle(responsibility.title));
  const normalizedIndicators = objectRows(coverageIndicators)
    .map((indicator) => standardizeResponsibilityIndicator(indicator, { policy }));
  const knowledge = bestKnowledgeRecord(knowledgeRecords);
  const matchedResponsibilities = new Set();
  const cardsByKey = new Map();
  const cards = [];

  normalizedIndicators.forEach((indicator) => {
    const responsibility = normalizedResponsibilities.find((candidate) => responsibilityMatchesIndicator(candidate, indicator));
    if (responsibility) matchedResponsibilities.add(responsibility);
    if (!shouldCreateIndicatorCard(indicator, {
      responsibility,
      hasKnowledgeResponsibilities: derivedKnowledgeResponsibilities.length > 0,
    })) return;
    const title = firstNonEmpty(indicator.liability, responsibility?.title, '保险责任');
    const key = cardKeyFor({ policy, indicator, responsibility, title });
    const existing = cardsByKey.get(key);
    if (existing) {
      mergeIndicatorCard(existing, indicator, responsibility, knowledge);
      return;
    }
    const card = createIndicatorCard({
      indicator,
      responsibility,
      knowledge,
      policy,
      index: cards.length,
    });
    cardsByKey.set(key, card);
    cards.push(card);
  });

  normalizedResponsibilities.forEach((responsibility) => {
    if (matchedResponsibilities.has(responsibility)) return;
    const key = cardKeyFor({ policy, responsibility, title: responsibility.title });
    if (cardsByKey.has(key)) return;
    const card = createResponsibilityCard({
      responsibility,
      knowledge,
      policy,
      index: cards.length,
    });
    cardsByKey.set(key, card);
    cards.push(card);
  });

  return suppressDisplayOnlyCards(cards).map(withIndicatorCheck);
}
