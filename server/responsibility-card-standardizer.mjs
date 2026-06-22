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

  if (isWaiverText(waiverTarget)) return 'waiver_only';
  if (isRuleParameterText(coreTarget)) return 'not_cashflow';
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
  };
}

function isInvalidResponsibilityTitle(value = '') {
  return /^(?:本公司|我们)?不(?:再)?承担|不再承担给付|责任免除|等待期/u.test(compact(value));
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
  const cleaned = text(value);
  const boundary = cleaned.match(/^(.{2,60}?)(?=\s*(?:被保险人|受益人|本公司|除另有约定|若|如))/u);
  if (boundary && /(?:豁免保险费|保险金|年金|生存金|教育金|养老金|满期金|祝寿金|长寿金|关爱金|津贴|豁免|金)$/u.test(boundary[1])) {
    return cleanClauseTitle(boundary[1]);
  }
  const match = cleaned.match(/^(.{2,52}?(?:豁免保险费|保险金|年金|生存金|教育金|养老金|满期金|祝寿金|长寿金|关爱金|津贴|豁免))/u);
  return match ? cleanClauseTitle(match[1]) : '';
}

function cleanClauseTitle(value = '') {
  const title = text(value)
    .replace(/^(?:\d+[.．])+\d*\s*/u, '')
    .replace(/[：:，,。；;、\s]+$/u, '');
  if (/\d+[.．]\d/u.test(title)) return '';
  return title;
}

function isResponsibilityClause(value = '') {
  const target = compact(value);
  return /(?:本公司|我们).{0,100}(?:给付|赔偿|赔付|报销|补偿|承担|免交|豁免|视同)|(?:给付|赔偿|赔付|报销|补偿|免交|豁免).{0,30}(?:保险金|保险费|年金|津贴|费用)/u.test(target);
}

function numberedResponsibilitiesFromKnowledge(record = {}, policy = {}) {
  if (!record || typeof record !== 'object') return [];
  if (record.official === false || record.qualityStatus === 'invalid_responsibility') return [];
  if (!knowledgeMatchesPolicy(record, policy)) return [];
  const sourceUrl = sourceUrlFrom(record);
  const sourceText = firstNonEmpty(record.pageText, record.sourceExcerpt, record.excerpt, record.sourceText);
  if (!sourceUrl || !sourceText) return [];

  const normalized = text(sourceText).normalize('NFKC').replace(/\r/gu, '').replace(/\s+/gu, ' ');
  const markers = [...normalized.matchAll(/(^|[\s。；;])(\d{1,2})[.．、]\s*/gu)]
    .map((match) => ({
      markerStart: match.index + match[1].length,
      bodyStart: match.index + match[0].length,
    }));
  const responsibilities = [];

  markers.forEach((marker, index) => {
    const next = markers[index + 1];
    const clause = text(normalized.slice(marker.bodyStart, next ? next.markerStart : normalized.length));
    const title = responsibilityClauseTitle(clause);
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
    });
  });

  return responsibilities;
}

function knowledgeResponsibilities(records = [], policy = {}) {
  const seen = new Set();
  const responsibilities = [];
  objectRows(records).forEach((record) => {
    numberedResponsibilitiesFromKnowledge(record, policy).forEach((responsibility) => {
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
  return target.includes(indicatorTitle);
}

function bestKnowledgeRecord(records = []) {
  return objectRows(records).find((record) => sourceUrlFrom(record) || sourceExcerptFrom(record)) || {};
}

function isAggregateLiabilityName(value = '') {
  const target = compact(value);
  return /[\/／、]|等|综合|汇总|返还/u.test(target);
}

function shouldCreateIndicatorCard(indicator = {}, { responsibility = null, hasKnowledgeResponsibilities = false } = {}) {
  if (isInvalidResponsibilityTitle(indicator.liability)) return false;
  if (responsibility) return true;
  if (!hasKnowledgeResponsibilities) return true;
  if (isRuleParameterText(joinedText(indicator.coverageType, indicator.liability))) return false;
  if (isAggregateLiabilityName(indicator.liability)) return false;
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
  if (isScheduledCashflowText(target)) return 'scheduled_cashflow';
  return 'not_cashflow';
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
    .filter((responsibility) => !isInvalidResponsibilityTitle(responsibility.title));
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

  return cards;
}
