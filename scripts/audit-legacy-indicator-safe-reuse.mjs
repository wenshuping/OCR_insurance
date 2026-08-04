#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SAFE_REUSE_SCHEMA = 'legacy-indicator-safe-reuse/v1';
export const MAX_EVIDENCE_PACKET_CHARS = 12000;

const DEFAULT_DB_PATH = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const DEFAULT_OUTPUT_DIR = 'artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v1';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const IDENTITY_FIELDS = ['responsibilityId', 'indicatorId', 'indicatorName', 'liability'];
const EVIDENCE_FIELDS = ['sourceUrl', 'sourcePage', 'sourceExcerpt', 'evidenceTokens', 'evidenceSegments'];
const FORMULA_FIELDS = [
  'formulaText',
  'normalizedFormula',
  'basis',
  'basisKey',
  'calculationKey',
  'requiredInputs',
  'operands',
  'branches',
  'branchSemanticContract',
];
const MODEL_BLOCKING_CLASSIFICATIONS = new Set([
  'version_mismatch',
  'duplicate_or_orphan',
  'formula_evidence_missing',
]);

export const METHOD_CONTRACT = {
  schema: SAFE_REUSE_SCHEMA,
  officialInput: {
    required: ['company', 'productName', 'sourceDigest', 'sourceUrl', 'responsibilities'],
    sourceOfTruth: 'official_source_and_locked_responsibility_inventory',
    legacyExcluded: true,
    modelBlind: true,
  },
  legacyInput: {
    tables: ['product_responsibility_cards', 'insurance_indicator_records'],
    role: 'post_official_diff_only',
    businessValuesMayEnterOfficialFacts: false,
  },
  exactReuse: {
    identity: 'sourceDigest exact match when the official packet has a digest; sourceUrl fallback is allowed only when both sides have no digest',
    required: [
      'official inventory is sufficient',
      'responsibility titles and counts match',
      'card/nested-indicator/indicator-record mapping is bidirectional',
      'evidence fields match',
      'formula, operands, requiredInputs, and branches match',
      'no duplicate, orphan, version mismatch, or missing field',
    ],
  },
  missingOnly: {
    packetMaxChars: MAX_EVIDENCE_PACKET_CHARS,
    contains: ['sourceDigest', 'sourceUrl', 'responsibility title', 'failure fields', 'official evidence packet'],
    excludes: ['legacy business values', 'legacy formula', 'legacy evidence', 'legacy indicator payload'],
  },
  deterministicReconstructionGates: [
    'canonicalizer',
    'validator',
    'actualTargetImporterDryRun',
    'cloneSemanticReadback',
  ],
};

function text(value) {
  return String(value ?? '').trim();
}

function compactText(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, ' ');
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(text(value));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalizedUrl(value) {
  return text(value);
}

function sortForComparison(value) {
  if (Array.isArray(value)) {
    return value.map(sortForComparison);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForComparison(value[key])]));
  }
  return typeof value === 'string' ? compactText(value) : value ?? null;
}

export function stableJson(value) {
  return JSON.stringify(sortForComparison(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function pickSource(value = {}, fallback = {}) {
  const evidenceSegments = array(value.evidenceSegments || fallback.evidenceSegments).map((segment) => ({
    sourcePage: text(segment?.sourcePage),
    sourceExcerpt: compactText(segment?.sourceExcerpt),
  })).filter((segment) => segment.sourcePage || segment.sourceExcerpt);
  return {
    sourceDigest: text(value.sourceDigest || value.responsibilitySourceDigest || fallback.sourceDigest),
    sourceUrl: normalizedUrl(value.sourceUrl || fallback.sourceUrl),
    sourcePage: text(value.sourcePage || fallback.sourcePage),
    sourceExcerpt: compactText(value.sourceExcerpt || fallback.sourceExcerpt || evidenceSegments.map((segment) => segment.sourceExcerpt).filter(Boolean).join('\n')),
    evidenceTokens: array(value.evidenceTokens || fallback.evidenceTokens).map(compactText).filter(Boolean),
    evidenceSegments,
  };
}

function pickFormula(value = {}) {
  return {
    formulaText: compactText(value.formulaText),
    normalizedFormula: compactText(value.normalizedFormula),
    basis: compactText(value.basis),
    basisKey: compactText(value.basisKey),
    calculationKey: compactText(value.calculationKey),
    requiredInputs: array(value.requiredInputs).map(compactText).filter(Boolean),
    operands: array(value.operands),
    branches: array(value.branches),
    branchSemanticContract: value.branchSemanticContract ?? null,
  };
}

function compareField(left, right) {
  return stableJson(left) === stableJson(right);
}

function normalizeOfficialIndicator(indicator = {}, responsibility = {}) {
  const source = pickSource(indicator, responsibility);
  const formula = pickFormula(indicator);
  return {
    indicatorId: text(indicator.indicatorId || indicator.id || indicator.indicatorRecordId),
    indicatorName: text(indicator.indicatorName || indicator.name),
    liability: text(indicator.liability || responsibility.liability || responsibility.title),
    responsibilityId: text(indicator.responsibilityId || responsibility.responsibilityId),
    ...source,
    ...formula,
  };
}

function normalizeOfficialResponsibility(responsibility = {}, fallbackSource = {}) {
  const source = pickSource(responsibility, fallbackSource);
  const card = responsibility.card && typeof responsibility.card === 'object' ? responsibility.card : {};
  const indicators = array(responsibility.indicators || card.indicators)
    .map((indicator) => normalizeOfficialIndicator(indicator, { ...fallbackSource, ...responsibility, ...source }));
  return {
    responsibilityId: text(responsibility.responsibilityId || responsibility.id),
    title: text(responsibility.title || responsibility.liability || card.title),
    triggerCondition: compactText(responsibility.triggerCondition || card.triggerCondition),
    insurerObligation: compactText(responsibility.insurerObligation || responsibility.payoutSummary || card.payoutSummary),
    importantLimits: array(responsibility.importantLimits || card.importantLimits).map(compactText).filter(Boolean),
    ...source,
    indicators,
  };
}

export function normalizeOfficialProduct(product = {}) {
  const productIdentity = product.productIdentity || {};
  const sourceDigest = text(product.sourceDigest || productIdentity.sourceDigest);
  const sourceUrl = normalizedUrl(product.sourceUrl || productIdentity.sourceUrl);
  const responsibilities = array(product.responsibilities || product.acceptedResponsibilities)
    .map((responsibility) => normalizeOfficialResponsibility(responsibility, { sourceDigest, sourceUrl }));
  return {
    company: text(product.company || product.displayCompany),
    productName: text(product.productName),
    sourceDigest,
    sourceUrl,
    responsibilities,
  };
}

function legacyPayload(row) {
  return parseJson(row?.payload, {});
}

function normalizeLegacyCard(row = {}) {
  const payload = legacyPayload(row);
  return {
    id: text(row.id || payload.id),
    company: text(row.company || payload.company),
    productName: text(row.productName || row.product_name || payload.productName),
    title: text(row.title || payload.title),
    sourceUrl: normalizedUrl(row.source_url || payload.sourceUrl),
    sourceDigest: text(row.source_digest || payload.sourceDigest || payload.responsibilitySourceDigest),
    payload,
    nestedIndicators: array(payload.indicators).map((indicator) => normalizeLegacyIndicator(indicator, payload)),
  };
}

function normalizeLegacyIndicator(row = {}, fallback = {}) {
  const payload = row.payload && typeof row.payload === 'object'
    ? row.payload
    : (row.payload ? legacyPayload(row) : row);
  const source = pickSource({
    ...payload,
    sourceUrl: row.source_url || payload.sourceUrl,
    sourceDigest: row.source_digest || payload.sourceDigest,
  });
  return {
    id: text(row.id || payload.id),
    company: text(row.company || payload.company || fallback.company),
    productName: text(row.productName || row.product_name || payload.productName || fallback.productName),
    coverageType: text(row.coverage_type || payload.coverageType),
    liability: text(row.liability || payload.liability),
    indicatorName: text(payload.indicatorName),
    responsibilityId: text(payload.responsibilityId),
    ...source,
    ...pickFormula(payload),
    payload,
  };
}

function sourceIdentity(official, legacyDigests, legacyUrls) {
  const officialDigest = text(official.sourceDigest);
  const officialUrl = normalizedUrl(official.sourceUrl);
  const conflictingDigests = [...legacyDigests].filter((digest) => officialDigest && digest && digest !== officialDigest);
  if (conflictingDigests.length) {
    return { ok: false, method: 'conflict', conflictingDigests };
  }
  if (officialDigest) {
    if (legacyDigests.size === 1 && legacyDigests.has(officialDigest)) {
      return { ok: true, method: 'sourceDigest', conflictingDigests: [] };
    }
    return { ok: false, method: 'unproven', conflictingDigests: [] };
  }
  if (officialUrl && legacyDigests.size === 0 && legacyUrls.size === 1 && legacyUrls.has(officialUrl)) {
    return { ok: true, method: 'sourceUrl', conflictingDigests: [] };
  }
  return { ok: false, method: 'unproven', conflictingDigests: [] };
}

function sourceValues(cards, indicators) {
  const digests = new Set();
  const urls = new Set();
  for (const row of [...cards, ...indicators]) {
    if (row.sourceDigest) digests.add(row.sourceDigest);
    if (row.sourceUrl) urls.add(row.sourceUrl);
  }
  return { digests, urls };
}

function uniqueNonEmpty(values) {
  return new Set(values.filter(Boolean)).size === values.filter(Boolean).length;
}

function officialInventoryIssues(official) {
  const issues = [];
  if (!official.company || !official.productName) issues.push('product_identity_missing');
  if (!DIGEST_RE.test(official.sourceDigest)) issues.push('source_digest_missing_or_invalid');
  if (!official.sourceUrl) issues.push('official_source_url_missing');
  if (!official.responsibilities.length) issues.push('responsibility_inventory_empty');
  if (!uniqueNonEmpty(official.responsibilities.map((item) => item.responsibilityId))) issues.push('responsibility_id_missing_or_duplicate');
  if (!uniqueNonEmpty(official.responsibilities.map((item) => item.title))) issues.push('responsibility_title_missing_or_duplicate');
  for (const responsibility of official.responsibilities) {
    if (!responsibility.sourceExcerpt) issues.push(`${responsibility.responsibilityId || responsibility.title}:evidence_missing`);
    if (!responsibility.indicators.length) issues.push(`${responsibility.responsibilityId || responsibility.title}:indicator_inventory_missing`);
    if (!uniqueNonEmpty(responsibility.indicators.map((item) => item.indicatorName || item.indicatorId || item.liability))) {
      issues.push(`${responsibility.responsibilityId || responsibility.title}:indicator_identity_missing_or_duplicate`);
    }
    for (const indicator of responsibility.indicators) {
      if (!indicator.sourceExcerpt) issues.push(`${responsibility.responsibilityId || responsibility.title}:${indicator.indicatorName || indicator.liability}:evidence_missing`);
    }
  }
  return [...new Set(issues)];
}

function indicatorIdentity(indicator) {
  return [indicator.responsibilityId, indicator.indicatorName, indicator.liability].map(compactText).join('\u001f');
}

function matchLegacyIndicator(official, candidates) {
  const explicitId = official.indicatorId;
  const byId = explicitId ? candidates.filter((candidate) => candidate.id === explicitId) : [];
  if (byId.length === 1) return byId[0];
  const bySemantic = candidates.filter((candidate) => (
    candidate.responsibilityId === official.responsibilityId
      && candidate.indicatorName === official.indicatorName
      && candidate.liability === official.liability
  ));
  if (bySemantic.length === 1) return bySemantic[0];
  const byLiability = candidates.filter((candidate) => (
    candidate.responsibilityId === official.responsibilityId && candidate.liability === official.liability
  ));
  return byLiability.length === 1 ? byLiability[0] : null;
}

function compareCard(official, card) {
  const failures = [];
  const cardPayload = card?.payload || {};
  const checks = [
    ['responsibility title', official.title, card.title],
    ['responsibilityId mapping', official.responsibilityId, card.nestedIndicators.map((item) => item.responsibilityId).filter(Boolean)],
    ['responsibility sourceUrl', official.sourceUrl, card.sourceUrl],
    ['responsibility sourceDigest', official.sourceDigest, card.sourceDigest],
    ['responsibility sourceExcerpt', official.sourceExcerpt, pickSource(cardPayload).sourceExcerpt],
    ['triggerCondition', official.triggerCondition, compactText(cardPayload.triggerCondition)],
    ['insurerObligation', official.insurerObligation, compactText(cardPayload.insurerObligation || cardPayload.payoutSummary)],
    ['importantLimits', official.importantLimits, cardPayload.importantLimits || []],
  ];
  for (const [field, expected, actual] of checks) {
    if (field === 'responsibilityId mapping') {
      if (!actual.length || actual.some((value) => value !== expected)) failures.push(field);
    } else if (!compareField(expected, actual)) {
      failures.push(field);
    }
  }
  return failures;
}

function compareIndicator(official, legacy) {
  const identityFailures = [];
  const evidenceFailures = [];
  const formulaFailures = [];
  if (official.indicatorId && official.indicatorId !== legacy.id) identityFailures.push('indicatorId mapping');
  if (official.responsibilityId !== legacy.responsibilityId) identityFailures.push('responsibilityId mapping');
  if (official.indicatorName !== legacy.indicatorName) identityFailures.push('indicatorName mapping');
  if (official.liability !== legacy.liability) identityFailures.push('liability mapping');
  for (const field of EVIDENCE_FIELDS) {
    if (!compareField(official[field], legacy[field])) evidenceFailures.push(field);
  }
  for (const field of FORMULA_FIELDS) {
    if (!compareField(official[field], legacy[field])) formulaFailures.push(field);
  }
  return { identityFailures, evidenceFailures, formulaFailures };
}

function classifyFailures(failures) {
  const result = new Set(failures);
  if (failures.some((field) => {
    const value = field.toLowerCase();
    return value.includes('evidence') || value.includes('source') || value.includes('formula')
      || value.includes('requiredinputs') || value.includes('operands') || value.includes('branches');
  })) {
    result.add('formula_evidence_missing');
  }
  if (failures.some((field) => {
    const value = field.toLowerCase();
    return value.includes('duplicate') || value.includes('orphan') || value.includes('nested indicator mapping');
  })) result.add('duplicate_or_orphan');
  return [...result];
}

function modelAllowedFor(classifications = []) {
  return classifications.length > 0 && classifications.every((classification) => (
    classification === 'card_only'
    || classification === 'indicator_only'
    || classification.startsWith('missing responsibility')
    || classification.startsWith('missing indicator:')
  ));
}

function evidencePacket(official, failureFields) {
  const build = (excerptLimit, tokenLimit, segmentLimit) => ({
    schema: 'official-evidence-packet/v1',
    modelBlind: true,
    legacyExcluded: true,
    company: official.company,
    productName: official.productName,
    sourceDigest: official.sourceDigest,
    sourceUrl: official.sourceUrl,
    responsibilityId: official.responsibilityId,
    responsibilityTitle: official.title,
    failureFields: [...new Set(failureFields)].sort(),
    officialEvidence: {
      sourcePage: official.sourcePage,
      sourceExcerpt: official.sourceExcerpt.slice(0, excerptLimit),
      evidenceTokens: official.evidenceTokens.slice(0, tokenLimit).map((token) => token.slice(0, 300)),
      evidenceSegments: official.evidenceSegments.slice(0, segmentLimit).map((segment) => ({
        sourcePage: segment.sourcePage,
        sourceExcerpt: segment.sourceExcerpt.slice(0, 600),
      })),
    },
    officialResponsibility: {
      triggerCondition: official.triggerCondition,
      insurerObligation: official.insurerObligation,
      importantLimits: official.importantLimits,
      indicators: official.indicators,
    },
  });
  let packet = build(6000, 24, 8);
  if (stableJson(packet).length > MAX_EVIDENCE_PACKET_CHARS) packet = build(4000, 12, 4);
  if (stableJson(packet).length > MAX_EVIDENCE_PACKET_CHARS) packet = build(2500, 8, 2);
  const serializedLength = stableJson(packet).length;
  if (serializedLength > MAX_EVIDENCE_PACKET_CHARS) throw new Error(`official evidence packet exceeds ${MAX_EVIDENCE_PACKET_CHARS} characters`);
  return { ...packet, serializedLength };
}

function emptyLegacyDiff(cards, indicators) {
  return {
    cards: {
      total: cards.length,
      ids: cards.map((card) => card.id).filter(Boolean),
      titles: cards.map((card) => card.title).filter(Boolean),
    },
    nestedIndicators: {
      total: cards.reduce((sum, card) => sum + card.nestedIndicators.length, 0),
      ids: cards.flatMap((card) => card.nestedIndicators.map((item) => item.id).filter(Boolean)),
    },
    indicatorRecords: {
      total: indicators.length,
      ids: indicators.map((indicator) => indicator.id).filter(Boolean),
    },
  };
}

export function planLegacyReuse({ officialProduct, legacy = {} } = {}) {
  const official = normalizeOfficialProduct(officialProduct);
  const cards = array(legacy.cards).map(normalizeLegacyCard);
  const indicators = array(legacy.indicators).map((row) => normalizeLegacyIndicator(row, official));
  const inventoryIssues = officialInventoryIssues(official);
  const source = sourceValues(cards, indicators);
  const identity = sourceIdentity(official, source.digests, source.urls);
  const globalFailures = [];
  if (inventoryIssues.length) globalFailures.push('insufficient_official_inventory');
  if (!identity.ok) globalFailures.push(identity.method === 'conflict' ? 'version_mismatch' : 'source_identity_unproven');

  const cardsByTitle = new Map();
  for (const card of cards) {
    const list = cardsByTitle.get(card.title) || [];
    list.push(card);
    cardsByTitle.set(card.title, list);
  }
  const indicatorsByResponsibility = new Map();
  for (const indicator of indicators) {
    const key = indicator.responsibilityId || indicator.liability;
    const list = indicatorsByResponsibility.get(key) || [];
    list.push(indicator);
    indicatorsByResponsibility.set(key, list);
  }
  const expectedTitles = new Set(official.responsibilities.map((item) => item.title));
  const expectedResponsibilityIds = new Set(official.responsibilities.map((item) => item.responsibilityId));
  const resultResponsibilities = [];
  const usedCardIds = new Set();
  const usedIndicatorIds = new Set();

  for (const responsibility of official.responsibilities) {
    const failures = [];
    const matchedCards = cardsByTitle.get(responsibility.title) || [];
    if (matchedCards.length === 0) failures.push('missing responsibility');
    if (matchedCards.length > 1) failures.push('duplicate card title');
    const card = matchedCards[0] || null;
    if (card) usedCardIds.add(card.id);
    if (card) failures.push(...compareCard(responsibility, card));
    const candidates = indicatorsByResponsibility.get(responsibility.responsibilityId)
      || indicatorsByResponsibility.get(responsibility.title)
      || indicators.filter((indicator) => indicator.liability === responsibility.title);
    const expectedIndicators = responsibility.indicators;
    const matchedIndicators = [];
    for (const expected of expectedIndicators) {
      const matched = matchLegacyIndicator(
        expected,
        (candidates || []).filter((candidate) => !matchedIndicators.some((used) => used.id === candidate.id)),
      );
      if (!matched) {
        failures.push(`missing indicator:${expected.indicatorName || expected.liability}`);
      } else {
        matchedIndicators.push(matched);
        usedIndicatorIds.add(matched.id);
        const compared = compareIndicator(expected, matched);
        failures.push(...compared.identityFailures, ...compared.evidenceFailures, ...compared.formulaFailures);
      }
    }
    if ((candidates || []).length > expectedIndicators.length) failures.push('duplicate or orphan indicator');
    if (card) {
      const nestedIds = card.nestedIndicators.map((indicator) => indicator.id).filter(Boolean);
      const matchedIds = new Set(matchedIndicators.map((indicator) => indicator.id));
      if (nestedIds.length !== expectedIndicators.length) failures.push('nested indicator count mismatch');
      if (nestedIds.some((id) => !matchedIds.has(id))) failures.push('nested indicator mapping mismatch');
    }
    const categories = classifyFailures(failures);
    resultResponsibilities.push({
      responsibilityId: responsibility.responsibilityId,
      title: responsibility.title,
      status: categories.length ? 'needs_follow_up' : 'reuse',
      classifications: categories,
      failureFields: [...new Set(failures)].sort(),
      officialIndicatorCount: expectedIndicators.length,
      legacyMatchedIndicatorCount: matchedIndicators.length,
      legacyDiff: {
        card: card ? {
          found: true,
          ids: [card.id].filter(Boolean),
          nestedIndicatorIds: card.nestedIndicators.map((indicator) => indicator.id).filter(Boolean),
        } : { found: false, ids: [], nestedIndicatorIds: [] },
        indicatorRecords: matchedIndicators.map((indicator) => ({
          id: indicator.id,
          responsibilityId: indicator.responsibilityId,
          indicatorName: indicator.indicatorName,
        })),
      },
    });
  }

  const extraCards = cards.filter((card) => !usedCardIds.has(card.id) && !expectedTitles.has(card.title));
  const extraIndicators = indicators.filter((indicator) => !usedIndicatorIds.has(indicator.id));
  if (extraCards.length || extraIndicators.length) globalFailures.push('duplicate_or_orphan');
  if (cards.length && !indicators.length) globalFailures.push('card_only');
  if (!cards.length && indicators.length) globalFailures.push('indicator_only');

  const classifications = [...new Set([...globalFailures, ...resultResponsibilities.flatMap((item) => item.classifications)])];
  const allResponsibilitiesReuse = official.responsibilities.length > 0
    && resultResponsibilities.every((item) => item.status === 'reuse')
    && classifications.length === 0
    && cards.length === official.responsibilities.length
    && indicators.length === official.responsibilities.reduce((sum, item) => sum + item.indicators.length, 0);
  const responsibilityPlans = resultResponsibilities.map((item, index) => ({
    ...item,
    evidencePacket: item.status === 'reuse' ? null : evidencePacket({
      ...official,
      ...official.responsibilities[index],
      company: official.company,
      productName: official.productName,
      indicators: official.responsibilities[index].indicators,
    }, item.failureFields.length ? item.failureFields : classifications),
  }));
  if (inventoryIssues.length) {
    for (const item of responsibilityPlans) item.evidencePacket = null;
  }
  return {
    schema: SAFE_REUSE_SCHEMA,
    company: official.company,
    productName: official.productName,
    sourceDigest: official.sourceDigest,
    sourceUrl: official.sourceUrl,
    status: allResponsibilitiesReuse ? 'reuse' : 'needs_follow_up',
    classifications,
    officialInventory: {
      responsibilityCount: official.responsibilities.length,
      indicatorCount: official.responsibilities.reduce((sum, item) => sum + item.indicators.length, 0),
      issues: inventoryIssues,
    },
    sourceIdentity: {
      method: identity.method,
      proven: identity.ok,
      conflictingDigests: identity.conflictingDigests,
    },
    legacyDiff: {
      ...emptyLegacyDiff(cards, indicators),
      extraCards: extraCards.map((card) => ({ id: card.id, title: card.title })),
      extraIndicatorRecords: extraIndicators.map((indicator) => ({
        id: indicator.id,
        responsibilityId: indicator.responsibilityId,
        indicatorName: indicator.indicatorName,
        liability: indicator.liability,
      })),
    },
    responsibilities: responsibilityPlans,
    estimatedModelCalls: responsibilityPlans.filter((item) => item.status !== 'reuse' && item.evidencePacket).length,
    estimatedModelCallsSaved: responsibilityPlans.filter((item) => item.status === 'reuse').length,
  };
}

export function buildMissingOnlyManifest(plans = []) {
  const entries = [];
  for (const plan of plans) {
    if (plan.classifications.includes('insufficient_official_inventory')) {
      entries.push({
        schema: 'missing-only-product/v1',
        company: plan.company,
        productName: plan.productName,
        sourceDigest: plan.sourceDigest,
        sourceUrl: plan.sourceUrl,
        responsibilityId: null,
        responsibilityTitle: null,
        classifications: ['insufficient_official_inventory'],
        failureFields: plan.officialInventory?.issues || ['responsibility_inventory_unavailable'],
        evidencePacket: null,
      });
      continue;
    }
    for (const responsibility of plan.responsibilities || []) {
      if (responsibility.status === 'reuse') continue;
      entries.push({
        schema: 'missing-only-responsibility/v1',
        company: plan.company,
        productName: plan.productName,
        sourceDigest: plan.sourceDigest,
        sourceUrl: plan.sourceUrl,
        responsibilityId: responsibility.responsibilityId,
        responsibilityTitle: responsibility.title,
        classifications: responsibility.classifications,
        failureFields: responsibility.failureFields,
        modelAllowed: modelAllowedFor(responsibility.classifications),
        evidencePacket: responsibility.evidencePacket,
      });
    }
    if (!plan.responsibilities?.length) {
      entries.push({
        schema: 'missing-only-product/v1',
        company: plan.company,
        productName: plan.productName,
        sourceDigest: plan.sourceDigest,
        sourceUrl: plan.sourceUrl,
        responsibilityId: null,
        responsibilityTitle: null,
        classifications: ['insufficient_official_inventory'],
        failureFields: plan.officialInventory?.issues || ['responsibility_inventory_unavailable'],
        evidencePacket: null,
      });
    }
  }
  return {
    schema: 'missing-only-responsibility-manifest/v1',
    modelBlind: true,
    legacyBusinessValuesExcluded: true,
    entries,
    counts: {
      products: new Set(plans.map((plan) => `${plan.company}\u001f${plan.productName}`)).size,
      responsibilities: entries.filter((entry) => entry.responsibilityId).length,
      modelPackets: entries.filter((entry) => entry.evidencePacket).length,
      modelEligiblePackets: entries.filter((entry) => entry.evidencePacket && entry.modelAllowed).length,
      modelBlockedPackets: entries.filter((entry) => entry.evidencePacket && !entry.modelAllowed).length,
      blockedWithoutOfficialPacket: entries.filter((entry) => !entry.evidencePacket).length,
    },
  };
}

function passedReceipt(receipt) {
  return Boolean(
    receipt?.ok === true
    && Number(receipt.issueCount || 0) === 0
    && Number(receipt.validationIssueCount || 0) === 0
    && Number(receipt.semanticMismatchCount || 0) === 0,
  );
}

export function reconstructExactReuseArtifact({ plan, officialProduct, gateReceipts = {} } = {}) {
  const required = METHOD_CONTRACT.deterministicReconstructionGates;
  const missingGates = required.filter((gate) => !passedReceipt(gateReceipts[gate]));
  if (!plan || plan.status !== 'reuse') {
    return { status: 'blocked', reason: 'plan_is_not_exact_reuse', missingGates: required };
  }
  if (missingGates.length) return { status: 'blocked', reason: 'reconstruction_gates_pending', missingGates };
  const official = normalizeOfficialProduct(officialProduct);
  return {
    status: 'ready',
    modelUsed: false,
    sourceDigest: official.sourceDigest,
    sourceUrl: official.sourceUrl,
    artifact: {
      schema: 'deterministic-reconstructed-responsibility-artifact/v1',
      company: official.company,
      productName: official.productName,
      productIdentity: {
        company: official.company,
        productName: official.productName,
        sourceDigest: official.sourceDigest,
        sourceUrl: official.sourceUrl,
      },
      responsibilities: official.responsibilities,
      audit: {
        status: 'pending_gate_receipts_recorded',
        modelUsed: false,
        sourceOfTruth: 'official_inventory',
        legacyDiffUsedOnlyForReuseEligibility: true,
      },
    },
    gates: Object.fromEntries(required.map((gate) => [gate, gateReceipts[gate]])),
  };
}

function rowPayload(row) {
  return parseJson(row.payload, {});
}

function loadApprovedOfficialProducts(db, { company = '', productName = '', limit = 20 } = {}) {
  const clauses = ["json_extract(payload, '$.audit.status') = 'approved'", "COALESCE(TRIM(source_digest), '') <> ''", "COALESCE(TRIM(source_url), '') <> ''"];
  const params = [];
  if (company) { clauses.push('company = ?'); params.push(company); }
  if (productName) { clauses.push('product_name = ?'); params.push(productName); }
  params.push(Math.min(50, Math.max(1, Number(limit) || 20)));
  return db.prepare(`
    SELECT company, product_name, source_digest, source_url, payload
      FROM product_responsibility_artifacts
     WHERE ${clauses.join(' AND ')}
     ORDER BY rowid DESC
     LIMIT ?
  `).all(...params).map((row) => normalizeOfficialProduct({
    ...rowPayload(row),
    company: row.company,
    productName: row.product_name,
    sourceDigest: row.source_digest,
    sourceUrl: row.source_url,
  }));
}

function loadLegacyForProduct(db, product) {
  const cardRows = db.prepare(`
    SELECT id, company, product_name, title, source_url, payload
      FROM product_responsibility_cards
     WHERE company = ? AND product_name = ?
     ORDER BY id ASC
  `).all(product.company, product.productName);
  const indicatorRows = db.prepare(`
    SELECT id, company, product_name, coverage_type, liability, payload
      FROM insurance_indicator_records
     WHERE company = ? AND product_name = ?
     ORDER BY id ASC
  `).all(product.company, product.productName);
  return { cards: cardRows, indicators: indicatorRows };
}

function readOfficialManifest(filePath) {
  const payload = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8'));
  return array(payload.products || payload).map(normalizeOfficialProduct);
}

export function runReadOnlyForwardAudit({
  dbPath = DEFAULT_DB_PATH,
  officialManifestPath = '',
  fromApprovedArtifacts = false,
  company = '',
  productName = '',
  productLimit = 20,
} = {}) {
  if (!officialManifestPath && !fromApprovedArtifacts) throw new Error('provide --official-manifest or --from-approved-artifacts');
  const resolvedDbPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const queryOnly = Number(db.prepare('PRAGMA query_only').get()?.query_only || 0);
    const officialProducts = officialManifestPath
      ? readOfficialManifest(officialManifestPath).slice(0, Math.min(50, Math.max(1, Number(productLimit) || 20)))
      : loadApprovedOfficialProducts(db, { company, productName, limit: productLimit });
    const plans = officialProducts.map((official) => planLegacyReuse({
      officialProduct: official,
      legacy: loadLegacyForProduct(db, official),
    }));
    const counts = {
      products: plans.length,
      exactReuse: plans.filter((plan) => plan.status === 'reuse').length,
      needsFollowUp: plans.filter((plan) => plan.status !== 'reuse').length,
      missingResponsibilities: plans.reduce((sum, plan) => sum + plan.responsibilities.filter((item) => item.classifications.includes('missing responsibility')).length, 0),
      missingIndicators: plans.reduce((sum, plan) => sum + plan.responsibilities.filter((item) => item.classifications.some((value) => value.startsWith('missing indicator:'))).length, 0),
      formulaEvidenceMissing: plans.reduce((sum, plan) => sum + plan.responsibilities.filter((item) => item.classifications.includes('formula_evidence_missing')).length, 0),
      duplicateOrOrphan: plans.filter((plan) => plan.classifications.includes('duplicate_or_orphan')).length,
      versionMismatch: plans.filter((plan) => plan.classifications.includes('version_mismatch')).length,
      insufficientOfficialInventory: plans.filter((plan) => plan.classifications.includes('insufficient_official_inventory')).length,
      cardOnly: plans.filter((plan) => plan.classifications.includes('card_only')).length,
      indicatorOnly: plans.filter((plan) => plan.classifications.includes('indicator_only')).length,
      estimatedModelCallsSaved: plans.reduce((sum, plan) => sum + plan.estimatedModelCallsSaved, 0),
      estimatedModelCalls: plans.reduce((sum, plan) => sum + plan.responsibilities.filter((item) => item.status !== 'reuse' && item.evidencePacket && modelAllowedFor(item.classifications)).length, 0),
      modelBlockedPackets: plans.reduce((sum, plan) => sum + plan.responsibilities.filter((item) => item.status !== 'reuse' && item.evidencePacket && !modelAllowedFor(item.classifications)).length, 0),
    };
    return {
      schema: 'legacy-indicator-safe-reuse-forward-audit/v1',
      mode: 'read_only_query_only',
      dbPath: resolvedDbPath,
      readOnly: true,
      queryOnly,
      officialInput: officialManifestPath ? path.resolve(officialManifestPath) : 'product_responsibility_artifacts:approved',
      legacyTables: ['product_responsibility_cards', 'insurance_indicator_records'],
      officialProducts,
      modelCalls: 0,
      falseReuseProof: {
        exactReuseRequiresAllStrictFields: true,
        versionConflictsNeverReuse: true,
        legacyValuesExcludedFromOfficialInput: true,
        falseReuseCount: plans.filter((plan) => plan.status === 'reuse' && plan.classifications.length > 0).length,
      },
      counts,
      plans,
    };
  } finally {
    db.close();
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeForwardArtifacts({ outputDir = DEFAULT_OUTPUT_DIR, audit } = {}) {
  const resolvedOutputDir = path.resolve(outputDir);
  fs.mkdirSync(resolvedOutputDir, { recursive: true });
  const missingOnly = buildMissingOnlyManifest(audit.plans);
  const files = {
    'contract.json': METHOD_CONTRACT,
    'official-source-inventory.json': {
      schema: 'official-source-inventory-lock/v1',
      modelBlind: true,
      legacyExcluded: true,
      source: audit.officialInput,
      products: audit.officialProducts,
    },
    'audit.json': audit,
    'legacy-diff.json': {
      schema: 'legacy-indicator-safe-reuse-legacy-diff/v1',
      officialFactsExcluded: true,
      products: audit.plans.map((plan) => ({
        company: plan.company,
        productName: plan.productName,
        legacyDiff: plan.legacyDiff,
        classifications: plan.classifications,
      })),
    },
    'missing-only-manifest.json': missingOnly,
  };
  for (const [name, value] of Object.entries(files)) writeJson(path.join(resolvedOutputDir, name), value);
  const lines = Object.keys(files).sort().map((name) => `${sha256(fs.readFileSync(path.join(resolvedOutputDir, name)))}  ${name}`);
  lines.push(`${sha256(JSON.stringify(audit.counts))}  forward-counts.json-inline`);
  fs.writeFileSync(path.join(resolvedOutputDir, 'sha256sums.txt'), `${lines.join('\n')}\n`);
  return { outputDir: resolvedOutputDir, files: Object.keys(files).map((name) => path.join(resolvedOutputDir, name)).concat(path.join(resolvedOutputDir, 'sha256sums.txt')), missingOnly };
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const audit = runReadOnlyForwardAudit({
    dbPath: arg('db', DEFAULT_DB_PATH),
    officialManifestPath: arg('official-manifest'),
    fromApprovedArtifacts: process.argv.includes('--from-approved-artifacts'),
    company: arg('company'),
    productName: arg('product-name'),
    productLimit: Number(arg('product-limit', '20')),
  });
  const result = writeForwardArtifacts({ outputDir: arg('output-dir', DEFAULT_OUTPUT_DIR), audit });
  process.stdout.write(`${JSON.stringify({ ...audit.counts, dbPath: audit.dbPath, outputDir: result.outputDir, modelCalls: audit.modelCalls, falseReuseCount: audit.falseReuseProof.falseReuseCount }, null, 2)}\n`);
}
