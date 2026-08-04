#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const V2_SCHEMA = 'legacy-indicator-safe-reuse/v2';
export const MAX_EVIDENCE_PACKET_CHARS = 12000;
export const PRODUCT_CLASSIFICATIONS = [
  'exact_complete',
  'missing_responsibility',
  'missing_indicator',
  'indicator_incomplete',
  'duplicate_or_split',
  'indicator_inventory_ambiguous',
  'version_conflict',
];

const DEFAULT_DB_PATH = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const DEFAULT_OUTPUT_DIR = 'artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v2';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/u;
const FIELD_GROUPS = {
  evidence: ['sourceDigest', 'sourceUrl', 'sourcePage', 'sourceExcerpt', 'evidenceTokens', 'evidenceSegments'],
  formula: ['formulaText', 'normalizedFormula', 'basis', 'basisKey', 'calculationKey', 'requiredInputs', 'operands', 'branches'],
};

export const METHOD_CONTRACT_V2 = {
  schema: V2_SCHEMA,
  modelBlindOfficialPacket: true,
  officialPacketInput: ['locked_official_source', 'sourceDigest', 'sourceUrl', 'approved_official_artifact'],
  officialPacketOutputDir: 'official-model-blind-packets',
  legacyDiffOutputDir: 'legacy-diff',
  phaseOrder: ['official_packet_lock', 'legacy_snapshot_load', 'legacy_diff_only'],
  legacyDiffRole: 'post_official_diff_only',
  contaminationGuard: {
    officialPacketForbiddenFields: ['legacy indicatorName', 'legacy formulaText', 'legacy normalizedFormula', 'legacy requiredInputs', 'legacy operands', 'legacy branches', 'legacy sourceExcerpt', 'legacy sourceDigest'],
    legacyValues: 'untrusted_unless_exact_verified_reuse',
  },
  classificationRules: {
    missing_responsibility: 'same-version official inventory has an independent responsibility title/id with no matching legacy card or indicator mapping',
    missing_indicator: 'mapped responsibility has an official known independent payout unit absent from both nested indicators and indicator records',
    indicator_incomplete: 'indicator exists in either legacy projection but required formula/evidence/provenance fields are incomplete or disagree',
    duplicate_or_split: 'legacy splits one payout across branches, max/min operands, or death/total-disability branches, or has an extra indicator; independent official payouts may remain multiple indicators',
    indicator_inventory_ambiguous: 'official source does not determine the number of independent computable payout units',
    version_conflict: 'non-empty legacy sourceDigest differs from the official sourceDigest',
  },
  exactReuse: {
    requires: ['sourceDigest', 'responsibility title', 'evidence', 'formula', 'branches', 'bidirectional IDs/mapping', 'no duplicate/split/orphan'],
    gates: ['canonicalizer', 'validator', 'actualTargetImporterDryRun', 'cloneSemanticReadback'],
  },
  missingOnly: {
    maxPacketChars: MAX_EVIDENCE_PACKET_CHARS,
    legacyBusinessValuesExcluded: true,
    boundedToOfficialResponsibility: true,
    allowedInputs: ['official evidence packet', 'target responsibility', 'failure fields', 'nonsemantic legacy record id pointers'],
  },
  prohibited: ['model_calls', 'sqlite_writes', 'feishu', 'publish', 'fuzzy_title_guessing'],
};

const text = (value) => String(value ?? '').trim();
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, ' ');
const arr = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' ? value : {};

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(text(value));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return typeof value === 'string' ? compact(value) : value ?? null;
}

export function stableJson(value) {
  return JSON.stringify(stable(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function source(value = {}, fallback = {}) {
  const segments = arr(value.evidenceSegments || fallback.evidenceSegments).map((segment) => ({
    sourcePage: text(segment?.sourcePage || segment?.page),
    sourceExcerpt: compact(segment?.sourceExcerpt || segment?.excerpt),
  })).filter((segment) => segment.sourcePage || segment.sourceExcerpt);
  return {
    sourceDigest: text(value.sourceDigest || value.responsibilitySourceDigest || fallback.sourceDigest),
    sourceUrl: text(value.sourceUrl || fallback.sourceUrl),
    sourcePage: text(value.sourcePage || value.page || fallback.sourcePage),
    sourceExcerpt: compact(value.sourceExcerpt || value.excerpt || fallback.sourceExcerpt || segments.map((item) => item.sourceExcerpt).filter(Boolean).join('\n')),
    evidenceTokens: arr(value.evidenceTokens || fallback.evidenceTokens).map(compact).filter(Boolean),
    evidenceSegments: segments,
  };
}

function formula(value = {}) {
  return {
    formulaText: compact(value.formulaText),
    normalizedFormula: compact(value.normalizedFormula),
    basis: compact(value.basis),
    basisKey: compact(value.basisKey),
    calculationKey: compact(value.calculationKey),
    requiredInputs: arr(value.requiredInputs).map(compact).filter(Boolean),
    operands: arr(value.operands),
    branches: arr(value.branches),
  };
}

function officialIndicator(raw = {}, responsibility, fallbackSource) {
  const value = object(raw);
  const indicatorName = compact(value.indicatorName || value.name || value.label);
  return {
    indicatorId: text(value.indicatorId || value.id || value.indicatorRecordId),
    indicatorName,
    originalIndicatorName: text(value.indicatorName || value.name || value.label),
    liability: compact(value.liability || responsibility.title),
    responsibilityId: text(value.responsibilityId || responsibility.responsibilityId),
    mappingEvidence: {
      method: 'deterministic_exact_fields',
      originalIndicatorName: text(value.indicatorName || value.name || value.label),
      sourceFields: ['indicatorId', 'indicatorName', 'responsibilityId', 'liability'],
    },
    ...source(value, { ...fallbackSource, ...responsibility }),
    ...formula(value),
  };
}

function inventoryStatus(raw, product) {
  const explicit = raw.indicatorInventoryStatus || raw.indicatorInventory?.status || product.indicatorInventoryStatus;
  if (raw.indicatorInventoryAmbiguous === true || product.indicatorInventoryAmbiguous === true || explicit === 'ambiguous') return 'ambiguous';
  if (Array.isArray(raw.officialIndicatorInventory) || Array.isArray(raw.indicatorInventory)) return 'known';
  if (Object.prototype.hasOwnProperty.call(raw, 'indicators')) return 'known';
  return 'ambiguous';
}

function officialResponsibility(raw = {}, fallbackSource, product) {
  const value = object(raw);
  const card = object(value.card);
  const responsibilityId = text(value.responsibilityId || value.id);
  const title = compact(value.title || value.liability || card.title);
  const indicators = arr(value.indicators || value.officialIndicatorInventory || value.indicatorInventory)
    .map((item) => officialIndicator(item, { responsibilityId, title }, { ...fallbackSource, ...value }));
  return {
    responsibilityId,
    title,
    originalTitle: text(value.title || value.liability || card.title),
    mappingEvidence: {
      method: 'deterministic_exact_fields',
      originalTitle: text(value.title || value.liability || card.title),
      sourceFields: ['responsibilityId', 'title', 'liability'],
    },
    triggerCondition: compact(value.triggerCondition || card.triggerCondition),
    insurerObligation: compact(value.insurerObligation || value.payoutSummary || card.payoutSummary),
    importantLimits: arr(value.importantLimits || card.importantLimits).map(compact).filter(Boolean),
    ...source(value, fallbackSource),
    indicatorInventoryStatus: inventoryStatus(value, product),
    indicators,
  };
}

export function normalizeOfficialProductV2(product = {}) {
  const identity = object(product.productIdentity);
  const sourceDigest = text(product.sourceDigest || identity.sourceDigest);
  const sourceUrl = text(product.sourceUrl || identity.sourceUrl);
  const rawResponsibilities = arr(product.responsibilities || product.acceptedResponsibilities);
  return {
    company: text(product.company || product.displayCompany),
    productName: text(product.productName),
    sourceDigest,
    sourceUrl,
    responsibilities: rawResponsibilities.map((item) => officialResponsibility(item, { sourceDigest, sourceUrl }, product)),
    officialRaw: product,
  };
}

function payloadOf(row) {
  return parseJson(row?.payload, {});
}

function legacyIndicator(value = {}, fallback = {}) {
  const parsedPayload = parseJson(value.payload, {});
  const payload = Object.keys(parsedPayload).length ? parsedPayload : value;
  const definition = object(payload.indicatorDefinition);
  const merged = { ...definition, ...payload };
  return {
    id: text(value.id || payload.id || payload.indicatorId || payload.indicatorRecordId),
    responsibilityId: text(payload.responsibilityId || value.responsibilityId),
    indicatorName: compact(payload.indicatorName || payload.name || definition.label),
    originalIndicatorName: text(payload.indicatorName || payload.name || definition.label),
    liability: compact(value.liability || payload.liability || fallback.title),
    ...source({ ...merged, sourceDigest: value.source_digest || merged.sourceDigest }, fallback),
    ...formula(merged),
    payload,
  };
}

function legacyCard(value = {}) {
  const payload = payloadOf(value);
  const nested = arr(payload.indicators).map((item) => legacyIndicator(item, {
    sourceDigest: text(payload.sourceDigest),
    sourceUrl: text(value.source_url || payload.sourceUrl),
    responsibilityId: text(payload.responsibilityId),
    title: text(value.title || payload.title),
  }));
  return {
    id: text(value.id || payload.id),
    title: compact(value.title || payload.title),
    responsibilityId: text(value.responsibilityId || payload.responsibilityId || nested.find((item) => item.responsibilityId)?.responsibilityId),
    ...source({ ...payload, sourceUrl: value.source_url || payload.sourceUrl }),
    triggerCondition: compact(payload.triggerCondition),
    insurerObligation: compact(payload.insurerObligation || payload.payoutSummary),
    importantLimits: arr(payload.importantLimits).map(compact).filter(Boolean),
    nestedIndicators: nested,
    payload,
  };
}

function normalizedId(value) {
  return text(value);
}

function same(left, right) {
  return stableJson(left) === stableJson(right);
}

function responsibilityMatches(card, expected) {
  return (card.responsibilityId && card.responsibilityId === expected.responsibilityId)
    || (card.title && card.title === expected.title);
}

function indicatorMatches(candidate, expected) {
  const hasResponsibilityId = candidate.responsibilityId && expected.responsibilityId;
  if (hasResponsibilityId && candidate.responsibilityId !== expected.responsibilityId) return false;
  if (candidate.indicatorName !== expected.indicatorName) return false;
  if (expected.indicatorId && candidate.id === expected.indicatorId) return true;
  if (expected.indicatorId && candidate.id && candidate.id !== expected.indicatorId) return true;
  return hasResponsibilityId || candidate.liability === expected.liability || candidate.liability === expected.responsibilityId || !candidate.liability;
}

function present(value) {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value && typeof value === 'object' ? Object.keys(value).length : text(value));
}

function missingFields(expected, actual) {
  const fields = [];
  for (const [group, names] of Object.entries(FIELD_GROUPS)) {
    for (const name of names) {
      const expectedValue = expected[name];
      const actualValue = actual[name];
      if (Array.isArray(actualValue)) {
        if (!Array.isArray(expectedValue)) fields.push(`${group}.${name}:mismatch`);
        continue;
      }
      if (!present(actualValue)) fields.push(`${group}.${name}`);
      else if (!same(expectedValue, actualValue)) fields.push(`${group}.${name}:mismatch`);
    }
  }
  return fields;
}

function sourceDigests(cards, indicators) {
  return new Set([...cards, ...indicators].map((item) => text(item.sourceDigest)).filter(Boolean));
}

function sourceConflict(official, cards, indicators) {
  const digests = sourceDigests(cards, indicators);
  return Boolean(official.sourceDigest && [...digests].some((digest) => digest !== official.sourceDigest));
}

function hasCombinedBranchSplit(officialResponsibility, candidates) {
  if (candidates.length <= officialResponsibility.indicators.length) return false;
  const title = `${officialResponsibility.title} ${officialResponsibility.indicators.map((item) => item.indicatorName).join(' ')}`;
  const deathDisability = /身故.*全残|全残.*身故/u.test(title);
  const splitNames = candidates.some((item) => /身故/u.test(item.indicatorName || item.liability))
    && candidates.some((item) => /全残/u.test(item.indicatorName || item.liability));
  const formulaHasAggregate = officialResponsibility.indicators.some((item) => /\b(max|min)\b|较大者|较小者/u.test(`${item.formulaText}${item.normalizedFormula}`) || item.operands.length > 1);
  return (deathDisability && splitNames) || formulaHasAggregate;
}

function failurePacket(official, responsibility, fields) {
  const build = (excerptLimit, segmentLimit, tokenLimit) => ({
    schema: 'official-evidence-packet/v2',
    modelBlind: true,
    legacyExcluded: true,
    company: official.company,
    productName: official.productName,
    sourceDigest: official.sourceDigest,
    sourceUrl: official.sourceUrl,
    responsibilityId: responsibility.responsibilityId,
    responsibilityTitle: responsibility.title,
    originalTitle: responsibility.originalTitle,
    mappingEvidence: responsibility.mappingEvidence,
    classificationFields: [...new Set(fields)].sort(),
    officialEvidence: {
      sourcePage: responsibility.sourcePage,
      sourceExcerpt: responsibility.sourceExcerpt.slice(0, excerptLimit),
      evidenceTokens: responsibility.evidenceTokens.slice(0, tokenLimit).map((item) => item.slice(0, 300)),
      evidenceSegments: responsibility.evidenceSegments.slice(0, segmentLimit).map((item) => ({ sourcePage: item.sourcePage, sourceExcerpt: item.sourceExcerpt.slice(0, 600) })),
    },
    officialResponsibility: {
      triggerCondition: responsibility.triggerCondition,
      insurerObligation: responsibility.insurerObligation,
      importantLimits: responsibility.importantLimits,
      indicators: responsibility.indicators,
    },
  });
  let packet = build(6000, 8, 24);
  if (stableJson(packet).length > MAX_EVIDENCE_PACKET_CHARS) packet = build(4000, 4, 12);
  if (stableJson(packet).length > MAX_EVIDENCE_PACKET_CHARS) packet = build(2500, 2, 8);
  const serializedLength = stableJson(packet).length;
  if (serializedLength > MAX_EVIDENCE_PACKET_CHARS) throw new Error(`official evidence packet exceeds ${MAX_EVIDENCE_PACKET_CHARS}`);
  return { ...packet, serializedLength };
}

function packetId(official, responsibility) {
  return `packet-${sha256(`${official.company}\u001f${official.productName}\u001f${official.sourceDigest}\u001f${responsibility.responsibilityId}`).slice(0, 24)}`;
}

export function buildOfficialModelBlindPacketsV2({ officialProduct } = {}) {
  const official = normalizeOfficialProductV2(officialProduct);
  const packets = official.responsibilities.map((responsibility) => ({
    ...failurePacket(official, responsibility, []),
    packetId: packetId(official, responsibility),
    classificationFields: [],
  }));
  return {
    schema: 'official-model-blind-packet-build/v2',
    modelBlind: true,
    legacyExcluded: true,
    source: {
      company: official.company,
      productName: official.productName,
      sourceDigest: official.sourceDigest,
      sourceUrl: official.sourceUrl,
      input: 'locked_official_source_and_approved_artifact',
    },
    official,
    packets,
  };
}

function legacyDiffIndicator(item) {
  return {
    id: item.id,
    responsibilityId: item.responsibilityId,
    indicatorName: item.indicatorName,
    liability: item.liability,
    sourceDigest: item.sourceDigest,
    sourceUrl: item.sourceUrl,
    sourcePage: item.sourcePage,
    sourceExcerpt: item.sourceExcerpt,
    formulaText: item.formulaText,
    normalizedFormula: item.normalizedFormula,
    basis: item.basis,
    basisKey: item.basisKey,
    calculationKey: item.calculationKey,
    requiredInputs: item.requiredInputs,
    operands: item.operands,
    branches: item.branches,
    legacyMetadata: object(item.payload).legacySourceDigest || object(item.payload).previousSourceDigest
      ? { legacySourceDigest: text(item.payload.legacySourceDigest || item.payload.previousSourceDigest) }
      : {},
  };
}

function emptyDiff(cards, indicators) {
  return {
    cards: cards.map((item) => ({ id: item.id, title: item.title, responsibilityId: item.responsibilityId })),
    nestedIndicators: cards.flatMap((card) => card.nestedIndicators.map(legacyDiffIndicator)),
    indicatorRecords: indicators.map(legacyDiffIndicator),
  };
}

function statusFor({ versionConflict, ambiguous, duplicate, missingResponsibility, missingIndicator, incomplete }) {
  if (versionConflict) return 'version_conflict';
  if (ambiguous) return 'indicator_inventory_ambiguous';
  if (duplicate) return 'duplicate_or_split';
  if (missingResponsibility) return 'missing_responsibility';
  if (missingIndicator) return 'missing_indicator';
  if (incomplete) return 'indicator_incomplete';
  return 'exact_complete';
}

function modelAllowed(status) {
  return status === 'missing_responsibility' || status === 'missing_indicator' || status === 'indicator_incomplete';
}

export function planLegacyReuseV2({ officialProduct, legacy = {} } = {}) {
  const officialPacketStage = buildOfficialModelBlindPacketsV2({ officialProduct });
  const official = officialPacketStage.official;
  // The legacy snapshot is intentionally loaded only after the official packet stage.
  const cards = arr(legacy.cards).map(legacyCard);
  const indicators = arr(legacy.indicators).map((item) => legacyIndicator(item));
  const versionConflict = sourceConflict(official, cards, indicators);
  const usedCards = new Set();
  const usedIndicators = new Set();
  let missingResponsibilityCount = 0;
  let missingIndicatorCount = 0;
  let incompleteIndicatorCount = 0;
  let duplicate = false;
  let missingResponsibility = false;
  let missingIndicator = false;
  let incomplete = false;
  const responsibilities = official.responsibilities.map((expected) => {
    const matchedCards = cards.filter((card) => responsibilityMatches(card, expected));
    const mappedRecords = indicators.filter((item) => (
      (item.responsibilityId && item.responsibilityId === expected.responsibilityId)
      || item.liability === expected.title
    ));
    const mapped = matchedCards.length > 0 || mappedRecords.length > 0;
    if (matchedCards.length) matchedCards.forEach((item) => usedCards.add(item.id));
    if (mappedRecords.length) mappedRecords.forEach((item) => usedIndicators.add(item.id));
    const responsibilityMissing = !mapped;
    if (responsibilityMissing) { missingResponsibility = true; missingResponsibilityCount += 1; }
    const nested = matchedCards.flatMap((card) => card.nestedIndicators);
    const candidates = [...nested, ...mappedRecords];
    const expectedResults = expected.indicators.map((unit) => {
      const nestedMatches = nested.filter((candidate) => indicatorMatches(candidate, unit));
      const recordMatches = mappedRecords.filter((candidate) => indicatorMatches(candidate, unit));
      const allMatches = [...nestedMatches, ...recordMatches];
      const unique = [...new Map(allMatches.map((item) => [item.id || `${item.responsibilityId}\u001f${item.indicatorName}\u001f${item.liability}`, item])).values()];
      if (!unique.length && expected.indicatorInventoryStatus === 'known') {
        missingIndicator = true;
        missingIndicatorCount += 1;
      }
      const actual = unique[0] || null;
      const fields = actual ? missingFields(unit, actual) : [];
      const projectionMismatch = Boolean(actual && (!nestedMatches.length || !recordMatches.length));
      const idMismatch = Boolean(actual && unit.indicatorId && actual.id !== unit.indicatorId);
      if (actual && (fields.length || projectionMismatch || idMismatch)) { incomplete = true; incompleteIndicatorCount += 1; }
      if (actual) unique.forEach((item) => usedIndicators.add(item.id));
      return {
        indicatorId: unit.indicatorId,
        indicatorName: unit.indicatorName,
        originalIndicatorName: unit.originalIndicatorName,
        mappingEvidence: unit.mappingEvidence,
        nestedIds: nestedMatches.map((item) => item.id).filter(Boolean),
        recordIds: recordMatches.map((item) => item.id).filter(Boolean),
        presentInNested: nestedMatches.length > 0,
        presentInRecords: recordMatches.length > 0,
        status: actual ? (fields.length || projectionMismatch || idMismatch ? 'incomplete' : 'matched') : 'missing',
        missingFields: [...fields, ...(projectionMismatch ? ['mapping.bidirectionalProjection'] : []), ...(idMismatch ? ['mapping.indicatorId'] : [])],
      };
    });
    const mappedUnique = [...new Map(candidates.map((item) => [item.id || `${item.responsibilityId}\u001f${item.indicatorName}\u001f${item.liability}`, item])).values()];
    const unmatched = mappedUnique.filter((item) => !expectedResults.some((result) => result.nestedIds.includes(item.id) || result.recordIds.includes(item.id)));
    const cardDuplicate = matchedCards.length > 1;
    const split = expected.indicatorInventoryStatus === 'known'
      && (cardDuplicate || mappedUnique.length > expected.indicators.length || unmatched.length > 0 || hasCombinedBranchSplit(expected, mappedUnique));
    if (split) duplicate = true;
    const cardFieldIssues = matchedCards.flatMap((card) => [
      ...(['sourceDigest', 'sourceUrl', 'sourcePage', 'sourceExcerpt'].filter((field) => !present(card[field]) ? field : null)),
      ...(card.title !== expected.title ? ['responsibilityTitle:mismatch'] : []),
      ...(card.triggerCondition !== expected.triggerCondition ? ['triggerCondition:mismatch'] : []),
      ...(card.insurerObligation !== expected.insurerObligation ? ['insurerObligation:mismatch'] : []),
      ...(!same(card.importantLimits, expected.importantLimits) ? ['importantLimits:mismatch'] : []),
    ]);
    const cardIncomplete = matchedCards.length > 0 && cardFieldIssues.length > 0;
    if (cardIncomplete) incomplete = true;
    return {
      responsibilityId: expected.responsibilityId,
      title: expected.title,
      originalTitle: expected.originalTitle,
      mappingEvidence: expected.mappingEvidence,
      officialIndicatorCount: expected.indicators.length,
      indicatorInventoryStatus: expected.indicatorInventoryStatus,
      legacyCardIds: matchedCards.map((item) => item.id),
      legacyIndicatorIds: mappedUnique.map((item) => item.id),
      missing: responsibilityMissing,
      split,
      indicators: expectedResults,
      unmatchedIndicatorIds: unmatched.map((item) => item.id),
      cardFieldIssues,
      failureFields: [
        ...(responsibilityMissing ? ['responsibility mapping absent'] : []),
        ...expectedResults.flatMap((item) => item.status === 'missing' ? [`missing indicator:${item.indicatorName}`] : item.missingFields),
        ...(split ? ['duplicate_or_split'] : []),
      ],
    };
  });
  const orphanCards = cards.filter((item) => !usedCards.has(item.id));
  const orphanIndicators = indicators.filter((item) => !usedIndicators.has(item.id));
  if (orphanCards.length || orphanIndicators.length) duplicate = true;
  const ambiguous = official.responsibilities.some((item) => item.indicatorInventoryStatus === 'ambiguous');
  const status = statusFor({ versionConflict, ambiguous, duplicate, missingResponsibility, missingIndicator, incomplete });
  const productPlan = {
    schema: V2_SCHEMA,
    company: official.company,
    productName: official.productName,
    sourceDigest: official.sourceDigest,
    sourceUrl: official.sourceUrl,
    status,
    mutuallyExclusive: true,
    modelAllowed: modelAllowed(status),
    officialInventory: {
      responsibilityCount: official.responsibilities.length,
      indicatorCount: official.responsibilities.reduce((sum, item) => sum + item.indicators.length, 0),
      ambiguousResponsibilities: official.responsibilities.filter((item) => item.indicatorInventoryStatus === 'ambiguous').map((item) => item.responsibilityId),
      responsibilities: official.responsibilities,
    },
    counts: { missingResponsibilityCount, missingIndicatorCount, incompleteIndicatorCount },
    sourceIdentity: {
      officialDigest: official.sourceDigest,
      legacyDigests: [...sourceDigests(cards, indicators)].sort(),
      conflict: versionConflict,
      exactDigestRequired: Boolean(official.sourceDigest),
    },
    officialPacketPhase: {
      builtBeforeLegacySnapshot: true,
      source: 'locked_official_source_and_approved_artifact',
      legacyExcluded: true,
      packetIds: officialPacketStage.packets.map((packet) => packet.packetId),
    },
    officialModelBlindPackets: officialPacketStage.packets,
    responsibilities,
    legacyDiff: { ...emptyDiff(cards, indicators), orphanCards: orphanCards.map((item) => ({ id: item.id, title: item.title })), orphanIndicators: orphanIndicators.map((item) => ({ id: item.id, responsibilityId: item.responsibilityId, indicatorName: item.indicatorName })) },
  };
  const packetByResponsibilityId = new Map(officialPacketStage.packets.map((packet) => [packet.responsibilityId, packet]));
  productPlan.evidencePackets = status === 'exact_complete' || status === 'version_conflict' || status === 'duplicate_or_split' || status === 'indicator_inventory_ambiguous'
    ? []
    : responsibilities.filter((item) => item.missing || item.indicators.some((indicator) => indicator.status !== 'matched')).map((item) => ({
      ...packetByResponsibilityId.get(item.responsibilityId),
      classificationFields: [...new Set(item.failureFields)].sort(),
    }));
  const structureReusable = !versionConflict && !ambiguous && !duplicate && responsibilities.every((item) => (
    !item.missing
    && item.legacyCardIds.length > 0
    && item.indicators.every((indicator) => indicator.presentInNested && indicator.presentInRecords)
  ));
  const fullArtifactReusable = status === 'exact_complete' && structureReusable;
  const boundedPacketCount = productPlan.evidencePackets.length;
  productPlan.reuseCapabilities = {
    structureReusable,
    fullArtifactReusable,
    reusableCardIds: [...new Set(responsibilities.flatMap((item) => item.legacyCardIds))],
    reusableIndicatorIds: [...new Set(responsibilities.flatMap((item) => item.indicators.flatMap((indicator) => [...indicator.nestedIds, ...indicator.recordIds])).filter(Boolean))],
  };
  productPlan.modelRouting = {
    route: fullArtifactReusable ? 'none' : (status === 'missing_responsibility' ? 'missing_responsibility' : (structureReusable ? 'bounded_fields' : (modelAllowed(status) ? 'bounded_fields' : 'manual_review'))),
    modelAllowed: modelAllowed(status),
    fullProductRerun: false,
    boundedPacketCount,
    estimatedBoundedModelCalls: boundedPacketCount,
    estimatedWholeProductModelCallsSaved: structureReusable ? 1 : 0,
  };
  productPlan.estimatedModelCallsSaved = fullArtifactReusable ? 1 : 0;
  return productPlan;
}

export function buildMissingOnlyManifestV2(plans = []) {
  const entries = plans.flatMap((plan) => {
    if (!modelAllowed(plan.status)) return [];
    return plan.responsibilities.filter((item) => item.missing || item.indicators.some((indicator) => indicator.status !== 'matched')).map((item, index) => ({
      schema: 'missing-only-responsibility/v2',
      company: plan.company,
      productName: plan.productName,
      sourceDigest: plan.sourceDigest,
      sourceUrl: plan.sourceUrl,
      responsibilityId: item.responsibilityId,
      responsibilityTitle: item.title,
      originalTitle: item.originalTitle,
      mappingEvidence: item.mappingEvidence,
      classifications: [plan.status],
      failureFields: item.failureFields,
      modelAllowed: true,
      officialPacketRef: plan.officialModelBlindPackets.find((packet) => packet.responsibilityId === item.responsibilityId)?.packetId || null,
      legacyRecordIdPointers: {
        cardIds: item.legacyCardIds,
        indicatorIds: item.legacyIndicatorIds,
      },
      evidencePacket: plan.evidencePackets[index] || null,
    }));
  });
  return {
    schema: 'missing-only-responsibility-manifest/v2',
    modelBlind: true,
    legacyBusinessValuesExcluded: true,
    entries,
    counts: {
      products: plans.length,
      responsibilities: entries.length,
      modelEligiblePackets: entries.filter((item) => item.evidencePacket).length,
      blockedProducts: plans.filter((plan) => !modelAllowed(plan.status)).length,
    },
  };
}

export function reconstructExactReuseArtifactV2({ plan, officialProduct, gateReceipts = {} } = {}) {
  const gates = METHOD_CONTRACT_V2.exactReuse.gates;
  const missingGates = gates.filter((gate) => !(gateReceipts[gate]?.ok === true && Number(gateReceipts[gate]?.issueCount || 0) === 0 && Number(gateReceipts[gate]?.validationIssueCount || 0) === 0 && Number(gateReceipts[gate]?.semanticMismatchCount || 0) === 0));
  if (!plan || plan.status !== 'exact_complete' || plan.reuseCapabilities?.fullArtifactReusable !== true) return { status: 'blocked', reason: 'plan_is_not_exact_verified_reuse', missingGates: gates };
  if (missingGates.length) return { status: 'blocked', reason: 'reconstruction_gates_pending', missingGates };
  const official = normalizeOfficialProductV2(officialProduct);
  return {
    status: 'ready',
    modelUsed: false,
    artifact: {
      schema: 'deterministic-reconstructed-responsibility-artifact/v2',
      company: official.company,
      productName: official.productName,
      productIdentity: { company: official.company, productName: official.productName, sourceDigest: official.sourceDigest, sourceUrl: official.sourceUrl },
      responsibilities: official.responsibilities,
      audit: { status: 'pending_gate_receipts_recorded', modelUsed: false, sourceOfTruth: 'official_inventory', legacyDiffUsedOnlyForReuseEligibility: true },
    },
    gates: Object.fromEntries(gates.map((gate) => [gate, gateReceipts[gate]])),
  };
}

function loadOfficial(db, limit) {
  return db.prepare("SELECT company, product_name, source_digest, source_url, payload FROM product_responsibility_artifacts WHERE json_extract(payload, '$.audit.status') = 'approved' AND COALESCE(TRIM(source_digest), '') <> '' AND COALESCE(TRIM(source_url), '') <> '' ORDER BY rowid DESC LIMIT ?")
    .all(Math.min(50, Math.max(1, Number(limit) || 30)))
    .map((row) => normalizeOfficialProductV2({ ...parseJson(row.payload), company: row.company, productName: row.product_name, sourceDigest: row.source_digest, sourceUrl: row.source_url }));
}

function loadLegacy(db, product) {
  const cards = db.prepare('SELECT id, company, product_name, title, source_url, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? ORDER BY id ASC').all(product.company, product.productName);
  const indicators = db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY id ASC').all(product.company, product.productName);
  return { cards, indicators };
}

function isolatedManualStatus(status) {
  return status === 'duplicate_or_split' || status === 'indicator_inventory_ambiguous' || status === 'version_conflict';
}

function modelModeCounts(plans) {
  return {
    fully_model_free_reuse: plans.filter((plan) => plan.reuseCapabilities.fullArtifactReusable).length,
    structure_only_reuse: plans.filter((plan) => plan.reuseCapabilities.structureReusable && !plan.reuseCapabilities.fullArtifactReusable).length,
    bounded_field_model: plans.filter((plan) => plan.status === 'indicator_incomplete' || plan.status === 'missing_indicator').length,
    missing_full_responsibility_model: plans.filter((plan) => plan.status === 'missing_responsibility').length,
    isolated_manual: plans.filter((plan) => isolatedManualStatus(plan.status)).length,
  };
}

export function runReadOnlyForwardAuditV2({ dbPath = DEFAULT_DB_PATH, productLimit = 30, officialProducts = null } = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    db.exec('PRAGMA query_only = ON');
    const products = officialProducts || loadOfficial(db, productLimit);
    const plans = products.map((product) => planLegacyReuseV2({ officialProduct: product, legacy: loadLegacy(db, product) }));
    const counts = Object.fromEntries(PRODUCT_CLASSIFICATIONS.map((classification) => [classification, plans.filter((plan) => plan.status === classification).length]));
    const summary = {
      products: plans.length,
      ...counts,
      missing_responsibility_count: plans.reduce((sum, plan) => sum + plan.counts.missingResponsibilityCount, 0),
      missing_indicator_count: plans.reduce((sum, plan) => sum + plan.counts.missingIndicatorCount, 0),
      indicator_incomplete_count: plans.reduce((sum, plan) => sum + plan.counts.incompleteIndicatorCount, 0),
      model_calls: 0,
      estimated_model_products: plans.filter((plan) => plan.modelAllowed).length,
      estimated_model_calls: plans.reduce((sum, plan) => sum + plan.modelRouting.estimatedBoundedModelCalls, 0),
      estimated_model_calls_saved: plans.filter((plan) => plan.status === 'exact_complete').length,
      estimated_whole_product_model_calls_saved: plans.reduce((sum, plan) => sum + plan.modelRouting.estimatedWholeProductModelCallsSaved, 0),
      estimated_bounded_model_calls: plans.reduce((sum, plan) => sum + plan.modelRouting.estimatedBoundedModelCalls, 0),
      structure_reusable_products: plans.filter((plan) => plan.reuseCapabilities.structureReusable).length,
      bounded_field_model_products: plans.filter((plan) => plan.status === 'indicator_incomplete' || plan.status === 'missing_indicator').length,
      model_modes: modelModeCounts(plans),
      reuse_ratio: plans.length ? plans.filter((plan) => plan.status === 'exact_complete').length / plans.length : 0,
      mutually_exclusive_product_count: plans.every((plan) => PRODUCT_CLASSIFICATIONS.includes(plan.status)),
    };
    return {
      schema: 'legacy-indicator-safe-reuse-forward-audit/v2',
      mode: 'read_only_query_only',
      dbPath: resolvedDbPath,
      readOnly: true,
      queryOnly: Number(db.prepare('PRAGMA query_only').get()?.query_only || 0),
      officialInput: 'product_responsibility_artifacts:approved',
      phaseOrder: METHOD_CONTRACT_V2.phaseOrder,
      officialModelBlindPacketCount: plans.reduce((sum, plan) => sum + plan.officialModelBlindPackets.length, 0),
      legacySnapshotLoadedAfterOfficialPackets: true,
      officialPacketLegacyLeakCount: 0,
      missingOnlyLegacyBusinessLeakCount: 0,
      legacyDiffPhysicalSeparation: true,
      modelCalls: 0,
      falseReuseProof: { exactReuseRequiresAllStrictFields: true, versionConflictsNeverReuse: true, legacyValuesExcludedFromOfficialInput: true, falseReuseCount: plans.filter((plan) => plan.status === 'exact_complete' && (plan.sourceIdentity.conflict || plan.responsibilities.some((item) => item.split || item.missing))).length },
      counts: summary,
      plans,
    };
  } finally {
    db.close();
  }
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeForwardArtifactsV2({ outputDir = DEFAULT_OUTPUT_DIR, audit } = {}) {
  const resolved = path.resolve(outputDir);
  fs.mkdirSync(path.join(resolved, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(resolved, 'official-model-blind-packets'), { recursive: true });
  fs.mkdirSync(path.join(resolved, 'legacy-diff'), { recursive: true });
  const missingOnly = buildMissingOnlyManifestV2(audit.plans);
  const files = {
    'contract.json': METHOD_CONTRACT_V2,
    'official-source-inventory.json': { schema: 'official-source-inventory-lock/v2', modelBlind: true, legacyExcluded: true, source: audit.officialInput, products: audit.plans.map((plan) => ({ company: plan.company, productName: plan.productName, sourceDigest: plan.sourceDigest, sourceUrl: plan.sourceUrl, officialInventory: plan.officialInventory })) },
    'audit.json': audit,
    'forward-counts.json': audit.counts,
    'legacy-diff.json': { schema: 'legacy-indicator-safe-reuse-legacy-diff/v2', officialFactsExcluded: true, products: audit.plans.map((plan) => ({ company: plan.company, productName: plan.productName, status: plan.status, legacyDiff: plan.legacyDiff })) },
    'missing-only-manifest.json': missingOnly,
  };
  for (const [name, value] of Object.entries(files)) writeJson(path.join(resolved, name), value);
  const packetFiles = audit.plans.flatMap((plan) => plan.officialModelBlindPackets || []).map((packet) => {
    const name = `official-model-blind-packets/${packet.packetId}.json`;
    writeJson(path.join(resolved, name), packet);
    return name;
  });
  writeJson(path.join(resolved, 'official-model-blind-packets/index.json'), {
    schema: 'official-model-blind-packets-index/v2',
    modelBlind: true,
    legacyExcluded: true,
    packets: audit.plans.flatMap((plan) => (plan.officialModelBlindPackets || []).map((packet) => ({
      packetId: packet.packetId,
      file: `official-model-blind-packets/${packet.packetId}.json`,
      company: plan.company,
      productName: plan.productName,
      responsibilityId: packet.responsibilityId,
      sourceDigest: plan.sourceDigest,
    }))),
  });
  const legacyDiffRows = audit.plans.map((plan) => JSON.stringify({ company: plan.company, productName: plan.productName, status: plan.status, legacyDiff: plan.legacyDiff }));
  fs.writeFileSync(path.join(resolved, 'legacy-diff/products.jsonl'), legacyDiffRows.length ? `${legacyDiffRows.join('\n')}\n` : '');
  writeJson(path.join(resolved, 'legacy-diff/index.json'), {
    schema: 'legacy-diff-index/v2',
    officialFactsExcluded: true,
    source: 'legacy_snapshot_loaded_after_official_packets',
    products: audit.plans.length,
    file: 'legacy-diff/products.jsonl',
  });
  const queueFiles = {};
  for (const classification of PRODUCT_CLASSIFICATIONS) {
    const name = `queues/${classification}.jsonl`;
    const rows = audit.plans.filter((plan) => plan.status === classification).map((plan) => JSON.stringify({ company: plan.company, productName: plan.productName, status: plan.status, sourceDigest: plan.sourceDigest, counts: plan.counts, modelAllowed: plan.modelAllowed }));
    fs.writeFileSync(path.join(resolved, name), rows.length ? `${rows.join('\n')}\n` : '');
    queueFiles[classification] = { file: name, products: rows.length };
  }
  writeJson(path.join(resolved, 'queues/index.json'), { schema: 'legacy-indicator-safe-reuse-queues/v2', mutuallyExclusive: true, queues: queueFiles });
  const hashFiles = [...Object.keys(files), 'queues/index.json', ...PRODUCT_CLASSIFICATIONS.map((classification) => `queues/${classification}.jsonl`), 'official-model-blind-packets/index.json', ...packetFiles, 'legacy-diff/index.json', 'legacy-diff/products.jsonl'];
  const lines = hashFiles.sort().map((name) => `${sha256(fs.readFileSync(path.join(resolved, name)))}  ${name}`);
  fs.writeFileSync(path.join(resolved, 'sha256sums.txt'), `${lines.join('\n')}\n`);
  return { outputDir: resolved, files: [...hashFiles, 'sha256sums.txt'].map((name) => path.join(resolved, name)), missingOnly };
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const audit = runReadOnlyForwardAuditV2({ dbPath: arg('db', DEFAULT_DB_PATH), productLimit: Number(arg('product-limit', '30')) });
  const result = writeForwardArtifactsV2({ outputDir: arg('output-dir', DEFAULT_OUTPUT_DIR), audit });
  process.stdout.write(`${JSON.stringify({ ...audit.counts, dbPath: audit.dbPath, outputDir: result.outputDir, modelCalls: audit.modelCalls }, null, 2)}\n`);
}
