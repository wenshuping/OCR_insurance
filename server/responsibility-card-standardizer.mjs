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

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function firstNonEmpty(...values) {
  return values.map(text).find(Boolean) || '';
}

function rows(value) {
  return Array.isArray(value) ? value : [];
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

function isWeakLiabilityName(value = '') {
  return /^(?:该项保险金|相应保险金|保险责任|责任|给付责任|保障责任)$/u.test(compact(value));
}

function isRuleParameterText(value = '') {
  return /等待期|赔付方式|给付方式|疾病种数|疾病数量|规则参数|领取起始年龄|开始领取年龄|领取年龄|缴费年期/u.test(value);
}

function isWaiverText(value = '') {
  return /豁免/u.test(value);
}

function isClaimContingentText(value = '') {
  return /身故|死亡|全残|高残|伤残|残疾|残障|重大疾病|重疾|中症|轻症|疾病|恶性肿瘤|癌症|癌|意外|医疗|住院|门诊|急诊|药品|医药|护理|失能|费用|报销|补偿/u.test(value);
}

function isScheduledCashflowText(value = '') {
  return /年金|养老金|生存金|生存保险金|生存|满期|满期保险金|满期生存|教育金|祝寿|长寿|关爱金|关爱年金|领取/u.test(value);
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

function categoryFromText(value = '') {
  const target = compact(value);
  if (isWaiverText(target)) return '豁免';
  if (isRuleParameterText(target)) return '规则参数';
  if (/医疗|住院|门诊|急诊|药品|医药|报销|补偿|费用/u.test(target)) return '医疗保障';
  if (/重大疾病|重疾|中症|轻症|疾病|恶性肿瘤|癌症|癌|护理|失能/u.test(target)) return '疾病保障';
  if (/意外|伤残|残疾|残障|交通|航空|驾乘/u.test(target)) return '意外保障';
  if (/年金|现金流|养老金|生存金|生存保险金|满期|祝寿|教育金|长寿|关爱金|领取/u.test(target)) return '现金流';
  if (/身故|死亡|全残|高残|寿险/u.test(target)) return '人寿保障';
  return '其他';
}

function cashflowTreatmentFor(indicator = {}, meta = {}) {
  const target = joinedText(
    indicator.coverageType,
    indicator.category,
    indicator.liability,
    indicator.responsibilityName,
    indicator.title,
    indicator.condition,
    indicator.triggerCondition,
    indicator.formulaText,
    indicator.basis,
    indicator.sourceExcerpt,
  );

  if (isWaiverText(target)) return 'waiver_only';
  if (isRuleParameterText(target)) return 'not_cashflow';
  if (isClaimContingentText(target)) return 'claim_contingent';
  if (isScheduledCashflowText(target)) {
    if (meta.calculationEligible && !hasBlockedCalculationDependency(meta)) return 'scheduled_cashflow';
    return 'not_cashflow';
  }
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

export function standardizeResponsibilityIndicator(indicator = {}, { policy = {} } = {}) {
  const meta = semanticCalculationMeta(indicator, normalizeIndicatorCalculation(indicator));
  const calculationReason = calculationReasonFor(indicator, meta);
  const calculationEligible = Boolean(meta.calculationEligible) && !calculationReason;
  const sourceUrl = sourceUrlFrom(indicator);
  const sourceExcerpt = sourceExcerptFrom(indicator);
  const treatment = hasOfficialEvidence(indicator)
    ? cashflowTreatmentFor(indicator, { ...meta, calculationEligible })
    : 'not_cashflow';
  const liability = liabilityName(indicator);
  const normalized = {
    id: text(indicator.id),
    company: firstNonEmpty(indicator.company, policy.company),
    productName: firstNonEmpty(indicator.productName, policy.productName, policy.name),
    coverageType: text(indicator.coverageType),
    liability,
    category: categoryFromText([
      indicator.coverageType,
      indicator.liability,
      indicator.condition,
      indicator.formulaText,
      sourceExcerpt,
    ].join(' ')),
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
    calculationReason: calculationEligible ? '' : calculationReason,
    cashflowTreatment: treatment,
    sourceUrl,
    sourceTitle: text(indicator.sourceTitle),
    sourceExcerpt,
    confidence: sourceUrl && sourceExcerpt ? 'high' : 'low',
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
    title: responsibilityTitle(row),
    coverageType: text(row.coverageType),
    scenario: text(row.scenario || row.description || row.desc || row.content),
    payout: text(row.payout || row.limit || row.amount || row.formulaText),
    note: text(row.note || row.remark),
    sourceUrl: sourceUrlFrom(row),
    sourceTitle: firstNonEmpty(row.sourceTitle, row.title),
    sourceExcerpt: sourceExcerptFrom(row) || text(row.scenario || row.description || row.desc || row.content),
  };
}

function responsibilityMatchesIndicator(responsibility = {}, indicator = {}) {
  const indicatorTitle = compact(indicator.liability);
  if (!indicatorTitle || isWeakLiabilityName(indicatorTitle)) return false;
  const target = joinedText(
    responsibility.title,
    responsibility.coverageType,
    responsibility.scenario,
    responsibility.payout,
    responsibility.note,
  );
  return target.includes(indicatorTitle);
}

function bestKnowledgeRecord(records = []) {
  return rows(records).find((record) => sourceUrlFrom(record) || sourceExcerptFrom(record)) || {};
}

function cardIdFor({ policy = {}, title = '', index = 0 }) {
  const company = compact(policy.company);
  const productName = compact(policy.productName || policy.name);
  const cardTitle = compact(title || '保险责任');
  return `responsibility_card_${company || 'policy'}_${productName || 'product'}_${cardTitle || index}`.slice(0, 180);
}

function cardKeyFor({ policy = {}, indicator = {}, responsibility = {}, title = '' }) {
  const productName = firstNonEmpty(indicator.productName, policy.productName, policy.name);
  return `${compact(productName)}:${compact(title || indicator.liability || responsibility.title || '保险责任')}`;
}

function plainSummaryFor({ title, triggerCondition, payoutSummary }) {
  return [title, triggerCondition, payoutSummary].map(text).filter(Boolean).join('：').slice(0, 280);
}

function cardSource({ indicator = {}, responsibility = {}, knowledge = {} }) {
  return {
    sourceUrl: firstNonEmpty(indicator.sourceUrl, responsibility.sourceUrl, sourceUrlFrom(knowledge)),
    sourceTitle: firstNonEmpty(responsibility.sourceTitle, indicator.sourceTitle, knowledge.title),
    sourceExcerpt: firstNonEmpty(indicator.sourceExcerpt, responsibility.sourceExcerpt, sourceExcerptFrom(knowledge)),
  };
}

function cardStatus(indicators = []) {
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
  const target = compact(fallbackText);
  if (isWaiverText(target)) return 'waiver_only';
  if (isClaimContingentText(target)) return 'claim_contingent';
  return 'not_cashflow';
}

function createIndicatorCard({ indicator, responsibility, knowledge, policy, index }) {
  const title = firstNonEmpty(indicator.liability, responsibility?.title, '保险责任');
  const triggerCondition = firstNonEmpty(indicator.triggerCondition, responsibility?.scenario);
  const payoutSummary = firstNonEmpty(indicator.payoutSummary, responsibility?.payout, indicator.basis);
  const source = cardSource({ indicator, responsibility, knowledge });
  const indicators = [indicator];

  return {
    id: cardIdFor({ policy, title, index }),
    company: firstNonEmpty(policy.company, indicator.company),
    productName: firstNonEmpty(policy.productName, policy.name, indicator.productName),
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
  card.plainSummary = plainSummaryFor({
    title: card.title,
    triggerCondition: card.triggerCondition,
    payoutSummary: card.payoutSummary,
  });
}

function createResponsibilityCard({ responsibility, knowledge, policy, index }) {
  const title = responsibility.title || '保险责任';
  const triggerCondition = responsibility.scenario;
  const payoutSummary = responsibility.payout;
  const source = cardSource({ responsibility, knowledge });
  const treatment = cardTreatment([], [
    title,
    responsibility.coverageType,
    responsibility.scenario,
    responsibility.payout,
  ].join(' '));

  return {
    id: cardIdFor({ policy, title, index }),
    company: text(policy.company),
    productName: firstNonEmpty(policy.productName, policy.name),
    title,
    category: categoryFromText([responsibility.coverageType, title, triggerCondition, payoutSummary].join(' ')),
    plainSummary: plainSummaryFor({ title, triggerCondition, payoutSummary }),
    triggerCondition,
    payoutSummary,
    ...source,
    confidence: source.sourceUrl && source.sourceExcerpt ? 'medium' : 'low',
    calculationStatus: treatment === 'claim_contingent' ? 'claim_contingent' : 'needs_review',
    calculationReason: '未匹配到通过核对的结构化指标',
    cashflowTreatment: treatment,
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
  const normalizedResponsibilities = [
    ...rows(responsibilities),
    ...rows(optionalResponsibilityRecords),
  ].map(normalizeResponsibility);
  const normalizedIndicators = rows(coverageIndicators)
    .map((indicator) => standardizeResponsibilityIndicator(indicator, { policy }));
  const knowledge = bestKnowledgeRecord(knowledgeRecords);
  const matchedResponsibilities = new Set();
  const cardsByKey = new Map();
  const cards = [];

  normalizedIndicators.forEach((indicator) => {
    const responsibility = normalizedResponsibilities.find((candidate) => responsibilityMatchesIndicator(candidate, indicator));
    if (responsibility) matchedResponsibilities.add(responsibility);
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

  return cards;
}
