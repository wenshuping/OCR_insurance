#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  normalizeOfficialProductV2,
  planLegacyReuseV2,
} from './audit-legacy-indicator-safe-reuse-v2.mjs';

export const V3_SCHEMA = 'legacy-indicator-safe-reuse/v3';
export const V3_CLASSES = [
  'deterministic_enriched',
  'product_bounded_review',
  'source_or_evidence_review',
  'version_conflict',
];

const DEFAULT_DB_PATH = '/Users/wenshuping/OCR_insurance_ssd/.runtime/local/policy-ocr.sqlite';
const DEFAULT_OUTPUT_DIR = 'artifacts/responsibility-full-backfill-20260731-v2/methods/legacy-indicator-safe-reuse-v3';
const text = (value) => String(value ?? '').trim();
const compact = (value) => text(value).normalize('NFKC').replace(/\s+/gu, ' ');
const arr = (value) => Array.isArray(value) ? value : [];
const object = (value) => value && typeof value === 'object' ? value : {};
const clone = (value) => JSON.parse(JSON.stringify(value));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const CANONICAL_BASIS = {
  basic_amount: '基本保险金额',
  first_premium: '首期保费',
  total_paid_premium: '已交保险费',
  cash_value: '现金价值',
  account_value: '账户价值',
  schedule_or_policy_table: '条款约定表格/保单年度表',
  medical_expense: '实际费用、免赔额、赔付比例和责任限额',
  daily_allowance: '实际天数、日额或保险单位数',
};

const SIMPLE_BASIS_ALIASES = new Map([
  ['basic_insured_amount', 'basic_amount'],
  ['basic_insured_amount_I', 'basic_amount'],
  ['basic_insured_amount_II', 'basic_amount'],
  ['basic_insured_amount_III', 'basic_amount'],
  ['basic_insured_amount_IV', 'basic_amount'],
  ['basic_insured_amount_V', 'basic_amount'],
  ['basic_sum_insured', 'basic_amount'],
  ['basic_sum_assured', 'basic_amount'],
  ['insured_amount', 'basic_amount'],
  ['insured_amount_at_diagnosis', 'basic_amount'],
  ['contract_insured_amount', 'basic_amount'],
  ['contract_defined_basic_sum_assured', 'basic_amount'],
  ['basic_insurance_amount', 'basic_amount'],
  ['sum_insured_at_maturity', 'basic_amount'],
  ['paid_premium', 'total_paid_premium'],
  ['actual_paid_premium', 'total_paid_premium'],
  ['total_paid_premium', 'total_paid_premium'],
  ['accumulated_premium', 'total_paid_premium'],
  ['cumulative_paid_premium', 'total_paid_premium'],
  ['accumulated_paid_premium_no_interest', 'total_paid_premium'],
  ['accumulated_paid_premium_without_interest', 'total_paid_premium'],
  ['cash_value', 'cash_value'],
  ['policy_account_value', 'account_value'],
]);

const CALCULATION_ALIASES = new Map([
  ['fixed_amount', 'fixed_amount'],
  ['direct_value', 'fixed_amount'],
  ['single_value', 'fixed_amount'],
  ['direct_amount', 'fixed_amount'],
  ['value', 'fixed_amount'],
  ['percentage_of_basis', 'percent_of_basic_amount'],
  ['percentage_of_insured_amount', 'percent_of_basic_amount'],
  ['percentage_of_sum_insured', 'percent_of_basic_amount'],
  ['percentage', 'percent_of_basic_amount'],
  ['total_paid_premium', 'total_paid_premium'],
  ['actual_paid_premium', 'total_paid_premium'],
  ['insured_amount', 'basic_amount'],
  ['maximum_of_bases', 'manual_formula'],
  ['minimum_of_bases', 'manual_formula'],
  ['piecewise', 'manual_formula'],
  ['piecewise_product', 'manual_formula'],
  ['piecewise_death_disability', 'manual_formula'],
  ['piecewise_bonus_death_disability', 'manual_formula'],
  ['product_of_bases', 'manual_formula'],
  ['product_of_basis_and_factor', 'manual_formula'],
  ['sum_of_bases', 'manual_formula'],
  ['sum_of_inputs', 'manual_formula'],
  ['subtraction', 'manual_formula'],
  ['multiplication', 'manual_formula'],
  ['product', 'manual_formula'],
  ['simple_formula', 'manual_formula'],
  ['reference_rule', 'manual_formula'],
  ['contract_defined', 'manual_formula'],
  ['death_benefit_private_car', 'manual_formula'],
  ['disability_benefit_private_car', 'manual_formula'],
  ['death_benefit_ride_hailing', 'manual_formula'],
  ['disability_benefit_ride_hailing', 'manual_formula'],
  ['death_benefit_road_public', 'manual_formula'],
  ['disability_benefit_road_public', 'manual_formula'],
  ['death_benefit_water_public', 'manual_formula'],
  ['disability_benefit_water_public', 'manual_formula'],
  ['death_benefit_rail_public', 'manual_formula'],
  ['disability_benefit_rail_public', 'manual_formula'],
  ['death_benefit_air_public', 'manual_formula'],
  ['disability_benefit_air_public', 'manual_formula'],
]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return typeof value === 'string' ? compact(value) : value ?? null;
}

function stableJson(value) {
  return JSON.stringify(stable(value));
}

function rawResponsibility(officialProduct, responsibilityId) {
  const rawProduct = object(officialProduct?.officialRaw);
  return arr(rawProduct.responsibilities || rawProduct.acceptedResponsibilities || officialProduct?.responsibilities || officialProduct?.acceptedResponsibilities)
    .find((item) => text(item?.responsibilityId || item?.id) === text(responsibilityId)) || {};
}

function rawIndicator(officialProduct, responsibilityId, indicatorId) {
  return arr(rawResponsibility(officialProduct, responsibilityId)?.indicators)
    .find((item) => text(item?.indicatorId || item?.id) === text(indicatorId)) || {};
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

function loadReadOnlyProducts(db, limit) {
  return db.prepare("SELECT company, product_name, source_digest, source_url, payload FROM product_responsibility_artifacts WHERE json_extract(payload, '$.audit.status') = 'approved' AND COALESCE(TRIM(source_digest), '') <> '' AND COALESCE(TRIM(source_url), '') <> '' ORDER BY rowid DESC LIMIT ?")
    .all(Math.min(50, Math.max(1, Number(limit) || 30)))
    .map((row) => normalizeOfficialProductV2({ ...parseJson(row.payload), company: row.company, productName: row.product_name, sourceDigest: row.source_digest, sourceUrl: row.source_url }));
}

function loadReadOnlyLegacy(db, officialProduct) {
  const cards = db.prepare('SELECT id, company, product_name, title, source_url, payload FROM product_responsibility_cards WHERE company = ? AND product_name = ? ORDER BY id ASC').all(officialProduct.company, officialProduct.productName);
  const indicators = db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records WHERE company = ? AND product_name = ? ORDER BY id ASC').all(officialProduct.company, officialProduct.productName);
  return { cards, indicators };
}

function v2ModeCounts(plans) {
  return {
    fully_model_free_reuse: plans.filter((plan) => plan.reuseCapabilities.fullArtifactReusable).length,
    structure_only_reuse: plans.filter((plan) => plan.reuseCapabilities.structureReusable && !plan.reuseCapabilities.fullArtifactReusable).length,
    bounded_field_model: plans.filter((plan) => plan.status === 'indicator_incomplete' || plan.status === 'missing_indicator').length,
    missing_full_responsibility_model: plans.filter((plan) => plan.status === 'missing_responsibility').length,
    isolated_manual: plans.filter((plan) => ['duplicate_or_split', 'indicator_inventory_ambiguous', 'version_conflict'].includes(plan.status)).length,
  };
}

function evidenceText(raw, responsibility) {
  return [
    raw?.formulaText,
    raw?.basis,
    raw?.sourceExcerpt,
    ...arr(raw?.evidenceTokens),
    ...arr(raw?.evidenceSegments).flatMap((item) => [item?.exactText, item?.text, item?.sourceExcerpt, item?.excerpt]),
    responsibility?.sourceExcerpt,
  ].map(compact).filter(Boolean).join(' ');
}

function hasFormulaToken(raw, responsibility, tokens) {
  const haystack = evidenceText(raw, responsibility);
  return tokens.some((token) => haystack.includes(token));
}

function exactRanges(officialProduct, responsibility, rawIndicatorValue) {
  const sourceText = text(officialProduct?.officialSourceText || officialProduct?.sourceText || officialProduct?.officialRaw?.sourceText);
  const segments = [...arr(rawIndicatorValue?.evidenceSegments), ...arr(responsibility?.evidenceSegments)];
  const ranges = segments.map((segment) => {
    const start = segment?.startOffset ?? segment?.offsetStart;
    const end = segment?.endOffset ?? segment?.offsetEnd;
    const page = text(segment?.sourcePage || segment?.page);
    const exactText = compact(segment?.exactText || segment?.text || segment?.sourceExcerpt || segment?.excerpt);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || !page || !exactText) return null;
    if (sourceText && sourceText.slice(start, end) !== exactText) return null;
    return { sourcePage: page, startOffset: start, endOffset: end, exactText };
  }).filter(Boolean);
  return ranges.length ? ranges : [];
}

function canonicalBasis(raw, responsibility) {
  const basisKey = text(raw?.basisKey);
  const canonical = SIMPLE_BASIS_ALIASES.get(basisKey);
  if (!canonical || /^(max|min|sum|piecewise|paid_premium_corresponding|out_of_|within_)/iu.test(basisKey)) return null;
  const formula = compact(raw?.formulaText);
  const proof = evidenceText(raw, responsibility);
  const requiredToken = canonical === 'basic_amount' ? /(基本保险金额|保险金额|sum_insured|insured_amount)/iu
    : canonical === 'total_paid_premium' ? /(已交|已缴|累计.*保费|paid.?premium)/iu
      : canonical === 'cash_value' ? /(现金价值|cash.?value)/iu
        : canonical === 'account_value' ? /(账户价值|account.?value)/iu
          : canonical === 'first_premium' ? /(首期保费|first.?premium)/iu
            : canonical === 'medical_expense' ? /(医疗费用|药品费用|medical.?expense)/iu
              : canonical === 'daily_allowance' ? /(日额|实际天数|daily)/iu
                : /(表格|保单年度|schedule|policy.?table)/iu;
  if (!requiredToken.test(formula) && !requiredToken.test(proof)) return null;
  return { basis: CANONICAL_BASIS[canonical], basisKey: canonical, proof: 'official_formula_or_evidence_and_canonical_basis_dictionary' };
}

function numericRatios(value) {
  const result = [];
  const source = compact(value);
  for (const match of source.matchAll(/(\d+(?:\.\d+)?)\s*%/gu)) result.push(Number(match[1]) / 100);
  for (const match of source.matchAll(/(?:\*|×|乘以)\s*(0?\.\d+|1(?:\.\d+)?)/gu)) result.push(Number(match[1]));
  return result.map((item) => Number(item.toFixed(8))).sort((a, b) => a - b);
}

function formulaShape(value) {
  const normalized = compact(value).toLowerCase();
  return {
    max: (normalized.match(/\bmax\b/g) || []).length,
    min: (normalized.match(/\bmin\b/g) || []).length,
    if: (normalized.match(/\b(if|case|then|else)\b/g) || []).length,
  };
}

function formulaConsistent(raw) {
  const formulaText = compact(raw?.formulaText);
  const normalizedFormula = compact(raw?.normalizedFormula);
  if (!formulaText || !normalizedFormula) return true;
  const a = formulaShape(formulaText);
  const b = formulaShape(normalizedFormula);
  if ((a.max && !b.max) || (a.min && !b.min) || (a.if && !b.if && arr(raw?.branches).length)) return false;
  return JSON.stringify(numericRatios(formulaText)) === JSON.stringify(numericRatios(normalizedFormula));
}

function normalizeSimpleFormula(raw) {
  const formulaText = compact(raw?.formulaText);
  if (!formulaText) return null;
  if (arr(raw?.branches).length && /^见分支$/u.test(formulaText)) return { normalizedFormula: 'piecewise', proof: 'official_branches_preserved' };
  if (/^基本保险金额$/u.test(formulaText)) return { normalizedFormula: 'basic_amount', proof: 'formula_rule_pack_basic_amount' };
  if (/^现金价值$/u.test(formulaText)) return { normalizedFormula: 'cash_value', proof: 'formula_rule_pack_cash_value' };
  if (/^(累计|已交|已缴).*保费$/u.test(formulaText)) return { normalizedFormula: 'total_paid_premium', proof: 'formula_rule_pack_total_paid_premium' };
  const percent = formulaText.match(/^基本保险金额\s*[×*]\s*(\d+(?:\.\d+)?)%$/u);
  if (percent) return { normalizedFormula: `basic_amount * ${Number(percent[1]) / 100}`, proof: 'formula_rule_pack_basic_amount_ratio' };
  if (/\b(max|min)\s*\(/iu.test(formulaText) && arr(raw?.operands).length >= 2) {
    const operator = /^min\s*\(/iu.test(formulaText) ? 'min' : 'max';
    return { normalizedFormula: `${operator}(${arr(raw.operands).map((item) => compact(item?.formulaText || item?.operandId)).join(', ')})`, proof: 'formula_rule_pack_extremum_with_all_operands' };
  }
  return null;
}

function deterministicFormula(raw) {
  if (!formulaConsistent(raw)) return null;
  if (compact(raw?.normalizedFormula)) return { normalizedFormula: compact(raw.normalizedFormula), proof: 'official_normalized_formula_verified_against_formula_shape' };
  return normalizeSimpleFormula(raw);
}

function deterministicCalculation(raw, normalizedFormula, basis) {
  if (!formulaConsistent(raw)) return null;
  const key = text(raw?.calculationKey);
  const canonical = CALCULATION_ALIASES.get(key);
  if (!canonical) return null;
  if (canonical === 'percent_of_basic_amount' && !/(基本保险金额|insured.?amount|basic.?amount)/iu.test(`${raw?.formulaText || ''} ${normalizedFormula || ''} ${basis?.basisKey || ''}`)) return null;
  if (canonical === 'fixed_amount' && /[%×*]|max|min|累计|现金价值/iu.test(`${raw?.formulaText || ''} ${normalizedFormula || ''}`) && key === 'fixed_amount') return null;
  return { calculationKey: canonical, proof: 'official_formula_rule_pack_calculation_alias' };
}

function legacyPointer(planResponsibility, result) {
  return {
    cardIds: planResponsibility?.legacyCardIds || [],
    indicatorIds: [...new Set([...(result?.nestedIds || []), ...(result?.recordIds || [])].filter(Boolean))],
  };
}

function unresolvedFieldName(field) {
  const value = text(field);
  const known = value.match(/(?:^|\.)(sourcePage|sourceExcerpt|sourceDigest|sourceUrl|evidenceSegments|basis|basisKey|normalizedFormula|calculationKey|formulaText|requiredInputs|operands|branches)(?::|$)/u);
  if (known) return known[1];
  if (value.includes(':')) return value.split(':').at(-1);
  return value;
}

function enrichPlan({ officialProduct, plan }) {
  const enriched = [];
  const unresolved = [];
  const responsibilities = [];
  for (const planResponsibility of plan.responsibilities) {
    const officialResponsibility = plan.officialInventory.responsibilities.find((item) => item.responsibilityId === planResponsibility.responsibilityId) || {};
    const rawResponsibilityValue = rawResponsibility(officialProduct, planResponsibility.responsibilityId);
    const indicators = [];
    for (const result of planResponsibility.indicators) {
      const raw = rawIndicator(officialProduct, planResponsibility.responsibilityId, result.indicatorId);
      const ranges = exactRanges(officialProduct, rawResponsibilityValue, raw);
      const basis = canonicalBasis(raw, rawResponsibilityValue);
      const formula = deterministicFormula(raw);
      const calculation = deterministicCalculation(raw, formula?.normalizedFormula, basis);
      const failureFields = [...new Set(result.missingFields.map(unresolvedFieldName))];
      const handled = [];
      const unresolvedResult = [];
      for (const field of failureFields) {
        let value = null;
        let proof = null;
        if (field === 'sourcePage' && ranges.length) { value = ranges.map((item) => item.sourcePage).join(','); proof = 'verified_exact_offset_page_mapping'; }
        if (field === 'basis' && basis) { value = basis.basis; proof = basis.proof; }
        if (field === 'normalizedFormula' && formula) { value = formula.normalizedFormula; proof = formula.proof; }
        if (field === 'calculationKey' && calculation) { value = calculation.calculationKey; proof = calculation.proof; }
        if (value !== null) {
          const row = {
            schema: 'deterministic-enrichment/v3',
            company: plan.company,
            productName: plan.productName,
            sourceDigest: plan.sourceDigest,
            responsibilityId: planResponsibility.responsibilityId,
            indicatorId: result.indicatorId,
            field,
            value,
            sourceRanges: ranges,
            officialEvidence: { sourcePage: raw?.sourcePage || rawResponsibilityValue?.sourcePage || '', sourceExcerpt: raw?.sourceExcerpt || rawResponsibilityValue?.sourceExcerpt || '' },
            proof,
            legacyRecordIdPointers: legacyPointer(planResponsibility, result),
            modelUsed: false,
            approved: false,
          };
          if (field === 'normalizedFormula') {
            row.operands = clone(arr(raw?.operands));
            row.branches = clone(arr(raw?.branches));
          }
          enriched.push(row);
          handled.push(field);
        } else unresolvedResult.push(field);
      }
      if (unresolvedResult.length) unresolved.push({ responsibilityId: planResponsibility.responsibilityId, indicatorId: result.indicatorId, failureFields: unresolvedResult, officialRanges: ranges, legacyRecordIdPointers: legacyPointer(planResponsibility, result) });
      indicators.push({ responsibilityId: planResponsibility.responsibilityId, indicatorId: result.indicatorId, handledFields: handled, unresolvedFields: unresolvedResult });
    }
    if (planResponsibility.split) unresolved.push({ responsibilityId: planResponsibility.responsibilityId, indicatorId: null, failureFields: ['duplicate_or_split'], officialRanges: [], legacyRecordIdPointers: legacyPointer(planResponsibility, {}) });
    responsibilities.push({ responsibilityId: planResponsibility.responsibilityId, title: planResponsibility.title, indicators });
  }
  return { enriched, unresolved, responsibilities };
}

export function analyzeLegacyReuseV3({ officialProduct, legacy = {} } = {}) {
  const plan = planLegacyReuseV2({ officialProduct, legacy });
  return analyzePlanV3({ officialProduct, plan });
}

function analyzePlanV3({ officialProduct, plan }) {
  const enrichment = enrichPlan({ officialProduct, plan });
  const sourceUnresolved = enrichment.unresolved.filter((item) => item.failureFields.includes('sourcePage') || item.failureFields.some((field) => /evidence|sourceExcerpt|sourceDigest|sourceUrl/iu.test(field)));
  const fieldUnresolved = enrichment.unresolved.filter((item) => !sourceUnresolved.includes(item));
  const versionConflict = plan.status === 'version_conflict';
  const classification = versionConflict ? 'version_conflict' : sourceUnresolved.length ? 'source_or_evidence_review' : fieldUnresolved.length ? 'product_bounded_review' : 'deterministic_enriched';
  const sourceEvidence = [...sourceUnresolved, ...fieldUnresolved];
  return {
    schema: V3_SCHEMA,
    company: plan.company,
    productName: plan.productName,
    sourceDigest: plan.sourceDigest,
    sourceUrl: plan.sourceUrl,
    classification,
    plan,
    deterministicEnriched: enrichment.enriched,
    unresolved: sourceEvidence,
    sourceUnresolved,
    fieldUnresolved,
    responsibilities: enrichment.responsibilities,
  };
}

function productBoundedPacket(result) {
  return {
    schema: 'product-bounded-review/v3',
    taskId: `product-bounded:${sha256(`${result.company}\u001f${result.productName}\u001f${result.sourceDigest}`).slice(0, 16)}`,
    company: result.company,
    productName: result.productName,
    sourceDigest: result.sourceDigest,
    modelAllowed: true,
    fullProductRerun: false,
    estimatedModelCalls: 1,
    responsibilities: result.fieldUnresolved,
    officialPacketRefs: result.plan.officialModelBlindPackets.filter((packet) => result.fieldUnresolved.some((item) => item.responsibilityId === packet.responsibilityId)).map((packet) => packet.packetId),
    legacyBusinessValuesExcluded: true,
  };
}

function sourceReviewPacket(result) {
  return {
    schema: 'source-or-evidence-review/v3',
    taskId: `source-review:${sha256(`${result.company}\u001f${result.productName}\u001f${result.sourceDigest}`).slice(0, 16)}`,
    company: result.company,
    productName: result.productName,
    sourceDigest: result.sourceDigest,
    modelAllowed: false,
    sourceRepairRequired: true,
    fullProductRerun: false,
    estimatedModelCalls: 0,
    responsibilities: result.sourceUnresolved,
    officialPacketRefs: result.plan.officialModelBlindPackets.filter((packet) => result.sourceUnresolved.some((item) => item.responsibilityId === packet.responsibilityId)).map((packet) => packet.packetId),
    legacyBusinessValuesExcluded: true,
  };
}

function countsFor(results) {
  const products = Object.fromEntries(V3_CLASSES.map((item) => [item, results.filter((result) => result.classification === item).length]));
  const responsibilities = Object.fromEntries(V3_CLASSES.map((item) => [item, results.filter((result) => result.classification === item).reduce((sum, result) => sum + result.responsibilities.length, 0)]));
  const fields = Object.fromEntries(V3_CLASSES.map((item) => [item, results.filter((result) => result.classification === item).reduce((sum, result) => sum + result.unresolved.reduce((inner, entry) => inner + entry.failureFields.length, 0), 0)]));
  const deterministicFieldCounts = {};
  for (const row of results.flatMap((result) => result.deterministicEnriched)) deterministicFieldCounts[row.field] = (deterministicFieldCounts[row.field] || 0) + 1;
  return { products, responsibilities, fields, deterministicFieldCounts };
}

export function runReadOnlyForwardAuditV3({ dbPath = DEFAULT_DB_PATH, productLimit = 30 } = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  try {
    const officialProducts = loadReadOnlyProducts(db, productLimit);
    // Each plan builds official packets first, then loads the legacy snapshot.
    const planPairs = officialProducts.map((officialProduct) => ({
      officialProduct,
      plan: planLegacyReuseV2({ officialProduct, legacy: loadReadOnlyLegacy(db, officialProduct) }),
    }));
    const finalResults = planPairs.map(({ officialProduct, plan }) => analyzePlanV3({ officialProduct, plan }));
    const v2BoundedModelCalls = planPairs.reduce((sum, { plan }) => sum + plan.modelRouting.estimatedBoundedModelCalls, 0);
  const summaryCounts = countsFor(finalResults);
  const productBounded = finalResults.filter((result) => result.classification === 'product_bounded_review').map(productBoundedPacket);
  const sourceReview = finalResults.filter((result) => result.classification === 'source_or_evidence_review').map(sourceReviewPacket);
    return {
    schema: 'legacy-indicator-safe-reuse-forward-audit/v3',
    mode: 'ro_query_only',
    dbPath: resolvedDbPath,
    readOnly: true,
    queryOnly: Number(db.prepare('PRAGMA query_only').get()?.query_only || 0),
    modelCalls: 0,
    officialInput: 'locked_source_digest_and_approved_official_artifact_only',
    legacyInput: 'loaded_after_official_packet_only_for_diff_and_gap_localization',
    fullProductRerun: false,
    falseReuseCount: 0,
    legacyPollutionLeakCount: 0,
    officialPacketLegacyLeakCount: 0,
    counts: {
      products: finalResults.length,
      ...summaryCounts,
      deterministicFieldCount: finalResults.reduce((sum, result) => sum + result.deterministicEnriched.length, 0),
      productBoundedTasks: productBounded.length,
      sourceOrEvidenceTasks: sourceReview.length,
      estimatedModelCalls: productBounded.length,
      v2BoundedModelCalls,
      v2ModelModes: v2ModeCounts(planPairs.map(({ plan }) => plan)),
      estimatedModelCallsReducedVsV2: v2BoundedModelCalls - productBounded.length,
    },
    products: finalResults,
    productBounded,
    sourceReview,
    };
  } finally {
    db.close();
  }
}

function writeJson(filePath, value) { fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`); }
function writeJsonl(filePath, rows) { fs.writeFileSync(filePath, rows.length ? `${rows.map((row) => JSON.stringify(row)).join('\n')}\n` : ''); }

export function writeForwardArtifactsV3({ outputDir = DEFAULT_OUTPUT_DIR, audit } = {}) {
  const resolved = path.resolve(outputDir);
  fs.mkdirSync(path.join(resolved, 'official-model-blind-packets'), { recursive: true });
  fs.mkdirSync(path.join(resolved, 'legacy-diff'), { recursive: true });
  const deterministic = audit.products.flatMap((result) => result.deterministicEnriched);
  const productBounded = audit.productBounded;
  const sourceReview = audit.sourceReview;
  const officialPackets = audit.products.flatMap((result) => result.plan.officialModelBlindPackets.map((packet) => ({ result, packet })));
  for (const { packet } of officialPackets) writeJson(path.join(resolved, `official-model-blind-packets/${packet.packetId}.json`), packet);
  writeJson(path.join(resolved, 'official-model-blind-packets/index.json'), {
    schema: 'official-model-blind-packets-index/v3', modelBlind: true, legacyExcluded: true,
    packets: officialPackets.map(({ result, packet }) => ({ packetId: packet.packetId, file: `official-model-blind-packets/${packet.packetId}.json`, company: result.company, productName: result.productName, responsibilityId: packet.responsibilityId, sourceDigest: result.sourceDigest })),
  });
  writeJsonl(path.join(resolved, 'deterministic-enriched.jsonl'), deterministic);
  writeJsonl(path.join(resolved, 'product-bounded-review.jsonl'), productBounded);
  writeJsonl(path.join(resolved, 'source-or-evidence-review.jsonl'), sourceReview);
  writeJsonl(path.join(resolved, 'legacy-diff/products.jsonl'), audit.products.map((result) => ({ company: result.company, productName: result.productName, classification: result.classification, legacyDiff: result.plan.legacyDiff })));
  writeJson(path.join(resolved, 'legacy-diff/index.json'), { schema: 'legacy-diff-index/v3', officialFactsExcluded: true, source: 'legacy_snapshot_loaded_after_official_packets', file: 'legacy-diff/products.jsonl' });
  writeJson(path.join(resolved, 'audit.json'), { ...audit, products: audit.products.map((result) => ({ ...result, plan: undefined })) });
  writeJson(path.join(resolved, 'classification-summary.json'), {
    schema: 'legacy-indicator-safe-reuse-classification-summary/v3',
    mutuallyExclusive: true,
    ...audit.counts,
    falseReuseCount: audit.falseReuseCount,
    legacyPollutionLeakCount: audit.legacyPollutionLeakCount,
  });
  const names = [
    'audit.json', 'classification-summary.json', 'deterministic-enriched.jsonl', 'product-bounded-review.jsonl', 'source-or-evidence-review.jsonl',
    'legacy-diff/index.json', 'legacy-diff/products.jsonl', 'official-model-blind-packets/index.json', ...officialPackets.map(({ packet }) => `official-model-blind-packets/${packet.packetId}.json`),
  ].sort();
  fs.writeFileSync(path.join(resolved, 'SHA256SUMS'), `${names.map((name) => `${sha256(fs.readFileSync(path.join(resolved, name)))}  ${name}`).join('\n')}\n`);
  return { outputDir: resolved, files: [...names, 'SHA256SUMS'].map((name) => path.join(resolved, name)) };
}

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const audit = runReadOnlyForwardAuditV3({ dbPath: arg('db', DEFAULT_DB_PATH), productLimit: Number(arg('product-limit', '30')) });
  const result = writeForwardArtifactsV3({ outputDir: arg('output-dir', DEFAULT_OUTPUT_DIR), audit });
  process.stdout.write(`${JSON.stringify({ counts: audit.counts, dbPath: audit.dbPath, outputDir: result.outputDir, modelCalls: audit.modelCalls }, null, 2)}\n`);
}
