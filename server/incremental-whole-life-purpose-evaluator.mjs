const EVIDENCE_KEYS = new Set([
  'formulaText',
  'formula_text',
  'normalizedFormula',
  'normalized_formula',
  'calculationText',
  'calculation_text',
  'sourceExcerpt',
  'source_excerpt',
]);

function text(value) {
  return String(value ?? '').trim();
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeFormulaText(value) {
  return text(value)
    .replaceAll('％', '%')
    .replaceAll('＋', '+')
    .replaceAll('（', '(')
    .replaceAll('）', ')')
    .replaceAll('×', '*')
    .replaceAll('－', '-')
    .replace(/[●•·]/gu, '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function collectEvidenceStrings(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidenceStrings(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, nested] of Object.entries(value)) {
    if (EVIDENCE_KEYS.has(key) && typeof nested === 'string' && nested.trim()) result.push(nested);
    collectEvidenceStrings(nested, result);
  }
  return result;
}

function collectSourceDigests(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceDigests(item, result);
    return result;
  }
  if (!value || typeof value !== 'object') return result;
  for (const [key, nested] of Object.entries(value)) {
    if ((key === 'sourceDigest' || key === 'source_digest') && typeof nested === 'string' && nested.trim()) result.push(nested.trim());
    collectSourceDigests(nested, result);
  }
  return result;
}

function normalizedDigest(value) {
  const raw = text(value);
  if (!raw) return '';
  return raw.replace(/^sha256:/iu, '');
}

function entryPayload(entry) {
  if (!entry) return {};
  return asObject(entry.payload || entry);
}

function entryDigests(entry) {
  return unique([
    ...collectSourceDigests(entry),
    ...collectSourceDigests(entryPayload(entry)),
  ].map(normalizedDigest));
}

function entrySourceUrl(entry) {
  const payload = entryPayload(entry);
  return text(entry.sourceUrl || entry.source_url || payload.sourceUrl || payload.source_url);
}

function isApprovedArtifact(entry) {
  const payload = entryPayload(entry);
  return text(payload.audit?.status || payload.approvalStatus || payload.status || entry.approvalStatus || entry.status).toLowerCase() === 'approved';
}

function normalizedEntry(entry) {
  return {
    raw: entry,
    payload: entryPayload(entry),
    digests: entryDigests(entry),
    sourceUrl: entrySourceUrl(entry),
    evidence: unique(collectEvidenceStrings(entryPayload(entry))),
  };
}

function containsFirstYearEvidence(value) {
  const source = normalizeFormulaText(value).replace(/\s+/gu, '');
  const effective = '(?:有效保险金额|有效保额|effective_insured_amount)';
  const basic = '(?:基本保险金额|基本保额|basic_insured_amount)';
  const year = '(?:第一个|首个|第一).*?(?:保单年度|policy_year)';
  return new RegExp(`${year}.*?${effective}.*?(?:等于|=).*?${basic}`, 'iu').test(source)
    || new RegExp(`${effective}.*?${year}.*?(?:等于|=).*?${basic}`, 'iu').test(source);
}

function containsRecurrenceEvidence(value) {
  const source = normalizeFormulaText(value).replace(/\s+/gu, '');
  const effective = /有效保险金额|有效保额|effective_insured_amount/iu.test(source);
  const previous = /上一保单年度|上一个保单年度|previous[_ ]?policy[_ ]?year|effective_insured_amount_\{?n-1/iu.test(source);
  const secondYear = /自第二年|自第二个保单年度|第二年起|第二个保单年度起|year[_ ]?n|n[≥>=]2/iu.test(source);
  const multiplier = /\(1\+(\d+(?:\.\d+)?)%\)/u.test(source);
  return effective && previous && secondYear && multiplier;
}

function explicitExpandedRate(value) {
  const source = normalizeFormulaText(value).replace(/\s+/gu, '');
  const match = source.match(/(?:基本保险金额|基本保额|basic_insured_amount).*?\(1\+(\d+(?:\.\d+)?)%\).*?(?:\^|幂|次方).*?n-1/iu);
  return match ? Number(match[1]) : null;
}

function ratesFromRecurrence(value) {
  return [...normalizeFormulaText(value).matchAll(/\(1\+(\d+(?:\.\d+)?)%\)/gu)].map((match) => Number(match[1]));
}

function isBenefitComparison(value) {
  const source = text(value);
  return /(有效保险金额|有效保额|effective_insured_amount)/iu.test(source)
    && /(身故|全残|death|disability)/iu.test(source)
    && /(较大者|最大者|max\(|MAX\(|比较|取.*(?:大|最大))/iu.test(source);
}

function isPaidCashComparison(value) {
  const source = text(value);
  return isBenefitComparison(source)
    && /(已交保险费|已交保费|paid_premium)/iu.test(source)
    && /(现金价值|cash_value)/iu.test(source);
}

function evidenceForChain(chain) {
  return [
    ...chain.artifacts.flatMap((entry) => entry.evidence.map((value) => ({ role: 'approved_artifact', sourceDigest: chain.sourceDigest, evidence: value }))),
    ...chain.cards.flatMap((entry) => entry.evidence.map((value) => ({ role: 'responsibility_card', sourceDigest: chain.sourceDigest, evidence: value }))),
    ...chain.indicators.flatMap((entry) => entry.evidence.map((value) => ({ role: 'indicator_record', sourceDigest: chain.sourceDigest, evidence: value }))),
  ];
}

function sourceChainForDigest({ sourceDigest, artifacts, cards, indicators }) {
  const matches = (entry) => entry.digests.includes(sourceDigest);
  return {
    sourceDigest,
    artifacts: artifacts.filter(matches),
    cards: cards.filter(matches),
    indicators: indicators.filter(matches),
  };
}

function evaluateSourceChain({ company, productName, sourceChain }) {
  const evidence = evidenceForChain(sourceChain);
  const evidenceTexts = unique(evidence.map((item) => item.evidence));
  const firstYearEvidence = evidence.filter((item) => containsFirstYearEvidence(item.evidence));
  const recurrenceEvidence = evidence.filter((item) => containsRecurrenceEvidence(item.evidence));
  const recurrenceRates = unique(recurrenceEvidence.flatMap((item) => ratesFromRecurrence(item.evidence)));
  const explicitEvidence = evidence
    .map((item) => ({ ...item, rate: explicitExpandedRate(item.evidence) }))
    .filter((item) => item.rate !== null);
  const benefitEvidence = evidence.filter((item) => isBenefitComparison(item.evidence));
  const paidCashEvidence = evidence.filter((item) => isPaidCashComparison(item.evidence));
  const productIdentityText = [company, productName, ...sourceChain.artifacts.flatMap((entry) => [entry.payload.productIdentity?.productType, entry.payload.productOverview?.productType])].join(' ');
  const wholeLife = /终身寿险|终身保险/iu.test(productIdentityText);
  const sourceDigestAligned = sourceChain.artifacts.length > 0 && sourceChain.cards.length > 0 && sourceChain.indicators.length > 0;
  const explicitPathEligible = wholeLife && sourceDigestAligned && explicitEvidence.length > 0 && benefitEvidence.length > 0 && paidCashEvidence.length > 0;
  const equivalentPathEligible = wholeLife
    && sourceDigestAligned
    && firstYearEvidence.length > 0
    && recurrenceEvidence.length > 0
    && recurrenceRates.length === 1
    && benefitEvidence.length > 0
    && paidCashEvidence.length > 0;
  const path = explicitPathEligible ? 'explicit_expanded' : (equivalentPathEligible ? 'equivalent_recurrence' : 'none');
  const rate = explicitPathEligible
    ? explicitEvidence[0].rate
    : (equivalentPathEligible ? recurrenceRates[0] : null);
  const productPurpose = path === 'none' || rate === null
    ? ''
    : `这是一款增额终身寿险，提供终身身故、全残保障；缴费期满后，基本保险金额按每年 ${rate}% 的保单年度系数递增，并与已交保险费、现金价值按条款比较给付。`;
  return {
    eligible: path !== 'none',
    path,
    rate,
    productPurpose,
    sourceDigest: sourceChain.sourceDigest,
    gates: {
      wholeLife,
      sourceDigestAligned,
      firstYear: firstYearEvidence.length > 0,
      recurrence: recurrenceEvidence.length > 0,
      singleRate: recurrenceRates.length === 1,
      benefitAssociation: benefitEvidence.length > 0,
      paidCashComparison: paidCashEvidence.length > 0,
      explicitExpanded: explicitEvidence.length > 0,
    },
    evidence: {
      firstYear: firstYearEvidence,
      recurrence: recurrenceEvidence,
      explicitExpanded: explicitEvidence,
      benefitAssociation: benefitEvidence,
      paidCashComparison: paidCashEvidence,
      sourceDigest: sourceChain.sourceDigest,
      sourceRoles: {
        approvedArtifact: sourceChain.artifacts.length,
        responsibilityCard: sourceChain.cards.length,
        indicatorRecord: sourceChain.indicators.length,
      },
      evidenceTextCount: evidenceTexts.length,
    },
  };
}

function versionConflictEvaluation({ company, productName, candidateEvaluations }) {
  const first = candidateEvaluations[0] || evaluateSourceChain({
    company,
    productName,
    sourceChain: { sourceDigest: '', artifacts: [], cards: [], indicators: [] },
  });
  return {
    ...first,
    eligible: false,
    path: 'none',
    productPurpose: '',
    sourceDigest: '',
    status: 'version_conflict',
    holdReason: 'version_conflict',
    versionConflict: true,
    candidateChains: candidateEvaluations.map((candidate) => ({
      sourceDigest: candidate.sourceDigest,
      eligible: candidate.eligible,
      path: candidate.path,
      rate: candidate.path === 'explicit_expanded'
        ? candidate.rate
        : candidate.path === 'equivalent_recurrence' ? candidate.rate : null,
      gates: candidate.gates,
    })),
  };
}

export function evaluateIncrementalWholeLifePurpose({
  company = '',
  productName = '',
  cards = [],
  indicators = [],
  artifacts = [],
} = {}) {
  const normalizedCards = normalizeArray(cards).map(normalizedEntry);
  const normalizedIndicators = normalizeArray(indicators).map(normalizedEntry);
  const normalizedArtifacts = normalizeArray(artifacts).map(normalizedEntry).filter(isApprovedArtifact);
  const artifactDigests = unique(normalizedArtifacts.flatMap((entry) => entry.digests));
  const chains = artifactDigests
    .map((sourceDigest) => sourceChainForDigest({ sourceDigest, artifacts: normalizedArtifacts, cards: normalizedCards, indicators: normalizedIndicators }))
    .filter((chain) => chain.artifacts.length > 0 && chain.cards.length > 0 && chain.indicators.length > 0);
  const candidateEvaluations = chains.map((sourceChain) => evaluateSourceChain({ company, productName, sourceChain }));
  const renderableChains = candidateEvaluations.filter((candidate) => candidate.eligible);
  if (renderableChains.length > 1) return versionConflictEvaluation({ company, productName, candidateEvaluations });
  if (renderableChains.length === 1) return { ...renderableChains[0], status: 'eligible', holdReason: null, versionConflict: false, candidateChains: candidateEvaluations };
  const held = candidateEvaluations[0] || evaluateSourceChain({
    company,
    productName,
    sourceChain: { sourceDigest: '', artifacts: [], cards: [], indicators: [] },
  });
  return { ...held, status: 'hold', holdReason: 'missing_three_gate_evidence', versionConflict: false, candidateChains: candidateEvaluations };
}

function safePlainWholeLifePurpose(summary = {}) {
  const headline = text(summary.headline).replace(/增额终身寿险|增额寿险/gu, '终身寿险');
  if (headline) return headline;
  return '本产品提供终身身故、全残等保险责任，具体以保险条款为准。';
}

export function applyIncrementalWholeLifePurpose(summary = {}, evidence = {}) {
  const evaluation = evaluateIncrementalWholeLifePurpose(evidence);
  if (!evaluation.gates.wholeLife) return summary;
  const blocks = Array.isArray(summary.contentBlocks) ? summary.contentBlocks : [];
  const purposeBlock = {
    blockKey: 'productPurpose',
    title: '产品主要做什么',
    enabled: true,
    editable: true,
    order: 1,
    content: evaluation.eligible ? evaluation.productPurpose : safePlainWholeLifePurpose(summary),
  };
  const remainingBlocks = blocks.filter((block) => text(block?.blockKey) !== 'productPurpose');
  return {
    ...summary,
    headline: evaluation.eligible ? evaluation.productPurpose : safePlainWholeLifePurpose(summary),
    contentBlocks: [purposeBlock, ...remainingBlocks],
    incrementalWholeLifeEvaluation: evaluation,
  };
}
