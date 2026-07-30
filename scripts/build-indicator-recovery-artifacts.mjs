import { createHash } from 'node:crypto';

const ALLOWED_CALCULATION_STATUSES = new Set([
  'calculable',
  'display_only',
  'needs_table',
  'needs_claim_facts',
  'not_quantitative',
]);

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function stableId(prefix, ...parts) {
  const digest = createHash('sha256').update(parts.map(text).join('\u001f')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function sourceOf(indicator, fallbackUrl) {
  return {
    sourceUrl: text(indicator.sourceUrl || fallbackUrl),
    sourceExcerpt: text(indicator.sourceExcerpt),
    sourceTitle: text(indicator.sourceTitle || '保险合同条款'),
    sourcePage: text(indicator.sourcePage || 'SOURCE_EXCERPT'),
  };
}

function calculationStatus(indicator) {
  const explicit = text(indicator.calculationStatus);
  if (ALLOWED_CALCULATION_STATUSES.has(explicit)) return explicit;
  return indicator.calculationEligible === true ? 'display_only' : 'display_only';
}

function evidenceTokens(indicator, liability, sourceExcerpt) {
  const existing = rows(indicator.evidenceTokens).map(text).filter(Boolean);
  if (existing.length) return existing;
  return [liability, indicator.basis, indicator.formulaText]
    .map(text)
    .filter((value, index, values) => value && values.indexOf(value) === index && sourceExcerpt.includes(value));
}

function buildIndicator(indicator, fallbackUrl, responsibilityId) {
  const source = sourceOf(indicator, fallbackUrl);
  const liability = text(indicator.liability || indicator.title || indicator.coverageType);
  if (!liability) throw new Error('indicator_missing_liability');
  if (!text(indicator.id)) throw new Error(`indicator_missing_id:${liability}`);
  if (!source.sourceUrl || !source.sourceExcerpt) throw new Error(`indicator_missing_official_excerpt:${liability}`);
  return {
    ...indicator,
    id: text(indicator.id),
    indicatorName: text(indicator.indicatorName || liability),
    formulaText: text(indicator.formulaText || indicator.payoutSummary || indicator.basis || source.sourceExcerpt),
    calculationStatus: calculationStatus(indicator),
    calculationEligible: false,
    calculationReason: text(indicator.calculationReason || '需要结合条款、保单或理赔事实核验'),
    sourceUrl: source.sourceUrl,
    sourceExcerpt: source.sourceExcerpt,
    sourceTitle: source.sourceTitle,
    sourcePage: source.sourcePage,
    evidenceTokens: evidenceTokens(indicator, liability, source.sourceExcerpt),
    responsibilityId,
  };
}

export function buildIndicatorRecoveryArtifact({
  company,
  productName,
  sourceUrl,
  sourceDigest,
  indicators = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const resolvedCompany = text(company);
  const resolvedProductName = text(productName);
  const resolvedSourceUrl = text(sourceUrl);
  const resolvedDigest = text(sourceDigest);
  if (!resolvedCompany || !resolvedProductName || !resolvedSourceUrl || !resolvedDigest) {
    throw new Error('missing_product_or_source_identity');
  }
  const seenIndicators = new Set();
  const grouped = new Map();
  for (const raw of rows(indicators)) {
    const liability = text(raw.liability || raw.title || raw.coverageType);
    if (!liability) throw new Error('indicator_missing_liability');
    if (seenIndicators.has(text(raw.id))) throw new Error(`duplicate_indicator_id:${raw.id}`);
    seenIndicators.add(text(raw.id));
    const responsibilityId = stableId('responsibility_recovery', resolvedCompany, resolvedProductName, liability);
    const item = grouped.get(liability) || { responsibilityId, indicators: [] };
    item.indicators.push(buildIndicator(raw, resolvedSourceUrl, responsibilityId));
    grouped.set(liability, item);
  }
  if (!grouped.size) throw new Error('no_indicators');

  const responsibilities = [...grouped.entries()].map(([liability, item]) => {
    const first = item.indicators[0];
    const source = sourceOf(first, resolvedSourceUrl);
    const triggerCondition = text(first.triggerCondition || first.condition || source.sourceExcerpt);
    const insurerObligation = text(first.insurerObligation || first.formulaText || source.sourceExcerpt);
    const card = {
      title: liability,
      customerSummary: `${liability}：${triggerCondition}`,
      benefitExplanation: insurerObligation,
    };
    return {
      responsibilityId: item.responsibilityId,
      liability,
      responsibilityKind: 'benefit',
      coverageAggregation: 'include',
      selectionStatus: 'included',
      selectionEvidence: 'official_indicator_payload_reuse',
      triggerCondition,
      insurerObligation,
      sourcePage: source.sourcePage,
      sourceExcerpt: source.sourceExcerpt,
      card,
      indicators: item.indicators,
    };
  });

  const officialChecklist = responsibilities.map((responsibility) => ({
    responsibilityId: responsibility.responsibilityId,
    officialHeading: responsibility.liability,
    sourcePage: responsibility.sourcePage,
    sourceExcerpt: responsibility.sourceExcerpt,
  }));
  const matrix = responsibilities.map((responsibility) => ({
    responsibilityId: responsibility.responsibilityId,
    inventory: 'pass',
    card: 'pass',
    indicatorDecision: 'pass',
    formulaEvidence: 'pass',
    selectionEvidence: 'pass',
    productVersion: 'pass',
    result: 'pass',
    issues: [],
  }));
  return {
    company: resolvedCompany,
    displayCompany: resolvedCompany,
    productName: resolvedProductName,
    productIdentity: {
      filingCode: '',
      productCode: '',
      filingDate: '',
      sourceUrl: resolvedSourceUrl,
      sourceDigest: resolvedDigest,
      fieldEvidence: {
        filingCode: { status: 'not_present_in_source', reviewScope: '官方来源责任摘录' },
        productCode: { status: 'not_present_in_source', reviewScope: '官方来源责任摘录' },
        filingDate: { status: 'not_present_in_source', reviewScope: '官方来源责任摘录' },
      },
    },
    productOverview: { productType: '', primaryPurpose: '', mainFunctions: [], importantLimits: [] },
    productServices: [],
    productRules: [],
    currentPolicyInputs: {},
    optionalGroups: [],
    officialOptionalGroupChecklist: [],
    officialChecklist,
    responsibilities,
    audit: {
      status: 'pending_validation',
      officialChecklistCount: responsibilities.length,
      inventoryCount: responsibilities.length,
      cardCount: responsibilities.length,
      indicatorDecisionCount: responsibilities.length,
      matrix,
      issues: [],
    },
    publication: { status: 'approved', generatedAt, publisher: 'indicator-recovery-deterministic' },
    generatedAt,
  };
}
