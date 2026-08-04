import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  indicatorCalculationPayloadFields,
  requiredCalculationInputsForMeta,
} from '../src/indicator-calculation.mjs';
import {
  buildResponsibilityCardsForPolicy,
  indicatorCheckForResponsibilityCard,
} from '../server/responsibility-card-standardizer.mjs';
import {
  assertNotLegacyPolicyOcrDatabasePath,
  resolvePolicyOcrWriteDatabasePath,
} from '../server/policy-ocr-database-target.mjs';
import {
  assertImportExecutionGate,
  collectImportExecution,
} from './import-execution-guard.mjs';
import { loadStrictAlignmentProduct } from './responsibility-strict-alignment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const VERSION = '2026-06-23-reviewed-responsibility-artifact-import';

function productKeyFor(company, productName) {
  return `company_product:${text(company)}:${text(productName)}`;
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function preserveText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizedSelectionStatus(value) {
  const status = text(value);
  if (status === 'included') return 'selected';
  if (status === 'not_included') return 'not_selected';
  return status;
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonl(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  try {
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Fall back to newline-delimited reviewed product records.
  }
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error.message}`);
      }
    });
}

function readArtifactProducts(filePath) {
  const resolvedPath = path.resolve(filePath);
  return readJsonl(resolvedPath).map((record) => {
    if (
      !Object.hasOwn(record, 'responsibilities')
      && !Object.hasOwn(record, 'acceptedResponsibilities')
      && text(record.artifactPath)
    ) {
      const nestedPath = path.resolve(path.dirname(resolvedPath), text(record.artifactPath));
      const nestedProduct = JSON.parse(fs.readFileSync(nestedPath, 'utf8'));
      return {
        product: {
          ...nestedProduct,
          ...(text(record.company) ? { company: text(record.company) } : {}),
          ...(text(record.productName) ? { productName: text(record.productName) } : {}),
        },
        expectedResponsibilityCount: Number.isInteger(record.responsibilityCount)
          ? record.responsibilityCount
          : null,
      };
    }
    return {
      product: record,
      expectedResponsibilityCount: Number.isInteger(record.responsibilityCount)
        ? record.responsibilityCount
        : null,
    };
  });
}

function sha1(value) {
  return createHash('sha1').update(value).digest('hex');
}

function liabilityKey(value = '') {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function responsibilityLiability(responsibility = {}) {
  return text(
    responsibility.liability
    || responsibility.responsibilityName
    || responsibility.title
    || responsibility.name,
  );
}

function sourceExcerptFor(responsibility = {}) {
  const direct = preserveText(responsibility.sourceExcerpt);
  if (direct.trim()) return direct;
  return rows(responsibility.evidenceSegments)
    .map((segment) => preserveText(segment?.sourceExcerpt || segment?.exactText || segment?.text || segment?.excerpt))
    .filter((value) => value.trim())
    .join('\n');
}

function normalizeUnifiedProduct(product = {}) {
  if (!Object.hasOwn(product, 'responsibilities')) return product;
  const sourceUrl = text(product.sourceUrl || product.productIdentity?.sourceUrl);
  const sourceDigest = text(product.sourceDigest || product.productIdentity?.sourceDigest);
  const acceptedResponsibilities = rows(product.responsibilities).map((responsibility) => ({
    ...responsibility,
    liability: text(responsibility.card?.title) || responsibilityLiability(responsibility),
    customerSummary: text(responsibility.customerSummary || responsibility.card?.customerSummary),
    sourceUrl: text(responsibility.sourceUrl || sourceUrl),
    sourceExcerpt: sourceExcerptFor(responsibility),
    responsibilitySourceDigest: text(responsibility.responsibilitySourceDigest || sourceDigest),
  }));
  const internalIndicatorChecks = acceptedResponsibilities.flatMap((responsibility, responsibilityIndex) => {
    const sourceIndicators = rows(product.responsibilities[responsibilityIndex]?.indicators);
    if (!sourceIndicators.length) {
      return [{
        liability: responsibilityLiability(responsibility),
        indicatorCheckStatus: 'accepted_unified_pipeline',
      }];
    }
    return sourceIndicators.map((indicator) => ({
      ...indicator,
      liability: responsibilityLiability(responsibility),
      indicatorCheckStatus: text(indicator.indicatorCheckStatus || 'accepted_unified_pipeline'),
      responsibilityId: text(indicator.responsibilityId || responsibility.responsibilityId),
      responsibilitySourceDigest: text(indicator.responsibilitySourceDigest || sourceDigest),
    }));
  });
  return {
    ...product,
    acceptedResponsibilities,
    internalIndicatorChecks,
  };
}

function findSourceRecord(product = {}, responsibility = {}) {
  const sourceRecordId = text(responsibility.sourceRecordId);
  const sourceUrl = text(responsibility.sourceUrl);
  return rows(product.sourceRecords).find((record) => (
    (sourceRecordId && text(record.sourceRecordId) === sourceRecordId)
    || (sourceUrl && text(record.sourceUrl) === sourceUrl)
  )) || {};
}

function findInternalCheck(product = {}, responsibility = {}) {
  const key = liabilityKey(responsibilityLiability(responsibility));
  return rows(product.internalIndicatorChecks).find((item) => (
    liabilityKey(item.liability || item.responsibilityName || item.title || item.name) === key
  )) || {};
}

function explicitCoverageType(responsibility = {}, check = {}) {
  const explicit = text(responsibility.coverageType || check.coverageType);
  return /^(?:现金流|医疗保障|疾病保障|人寿保障|意外保障|豁免|规则参数|其他)$/u.test(explicit) ? explicit : '';
}

function inferCoverageType(responsibility = {}, check = {}) {
  const explicit = explicitCoverageType(responsibility, check);
  if (explicit) return explicit;
  const combined = [
    responsibility.coverageType,
    check.coverageType,
    responsibilityLiability(responsibility),
    responsibility.triggerCondition,
    responsibility.insurerObligation,
    responsibility.sourceExcerpt,
  ].map(text).join(' ');
  if (/豁免/u.test(combined)) return '豁免';
  if (/医疗|住院|门诊|药品|费用|报销|补偿|医保/u.test(combined)) return '医疗保障';
  if (/重大疾病|重疾|中症|轻症|疾病|恶性肿瘤|癌|护理|失能/u.test(combined)) return '疾病保障';
  if (/意外|伤残|交通|车上人员|第三者|车辆|机动车|损失|责任/u.test(combined)) return '意外保障';
  if (/身故|全残|寿险/u.test(combined)) return '人寿保障';
  if (/年金|生存|满期|祝寿|教育金|领取/u.test(combined)) return '现金流';
  return '其他';
}

function basisFor(responsibility = {}, check = {}) {
  const explicit = text(check.basis || responsibility.basis);
  if (explicit) return explicit;
  const basisKey = text(check.basisKey);
  if (basisKey === 'medical_expense') return '实际费用、免赔额、赔付比例和责任限额';
  if (basisKey === 'fixed_amount') return '条款约定固定给付金额';
  if (basisKey === 'basic_amount') return '基本保险金额';
  if (basisKey === 'total_paid_premium') return '已交保险费';
  if (basisKey === 'cash_value') return '现金价值';
  if (basisKey === 'account_value') return '账户价值';
  return text(responsibility.insurerObligation || check.calculationReason || responsibility.sourceExcerpt).slice(0, 500);
}

function formulaFor(responsibility = {}, check = {}) {
  const explicit = text(check.formulaText || responsibility.formulaText);
  if (explicit) return explicit;
  const liability = responsibilityLiability(responsibility);
  const obligation = text(responsibility.insurerObligation);
  if (obligation) return `${liability}：${obligation}`;
  return text(responsibility.sourceExcerpt).slice(0, 500);
}

function structuredFormulaFields(responsibility = {}, check = {}) {
  const normalizedFormula = text(check.normalizedFormula || responsibility.normalizedFormula);
  const basisDefinition = check.basisDefinition && typeof check.basisDefinition === 'object' && !Array.isArray(check.basisDefinition)
    ? check.basisDefinition
    : (responsibility.basisDefinition && typeof responsibility.basisDefinition === 'object' && !Array.isArray(responsibility.basisDefinition)
      ? responsibility.basisDefinition
      : null);
  const requiredInputDetails = Array.isArray(check.requiredInputDetails)
    ? check.requiredInputDetails
    : (Array.isArray(responsibility.requiredInputDetails) ? responsibility.requiredInputDetails : null);
  const operands = Array.isArray(check.operands)
    ? check.operands
    : (Array.isArray(responsibility.operands) ? responsibility.operands : null);
  const branches = Array.isArray(check.branches)
    ? check.branches
    : (Array.isArray(responsibility.branches) ? responsibility.branches : null);
  const branchSemanticContract = text(
    check.branchSemanticContract || responsibility.branchSemanticContract,
  );
  return {
    ...(normalizedFormula ? { normalizedFormula } : {}),
    ...(basisDefinition ? { basisDefinition: { ...basisDefinition } } : {}),
    ...(requiredInputDetails ? { requiredInputDetails: requiredInputDetails.map((detail) => ({ ...detail })) } : {}),
    ...(operands ? { operands } : {}),
    ...(branches ? { branches } : {}),
    ...(branchSemanticContract ? { branchSemanticContract } : {}),
  };
}

function structuredIndicatorFields(product = {}, responsibility = {}, check = {}) {
  const evidenceTokens = Array.isArray(check.evidenceTokens)
    ? check.evidenceTokens
    : (Array.isArray(responsibility.evidenceTokens) ? responsibility.evidenceTokens : null);
  const ruleRefs = Array.isArray(check.ruleRefs)
    ? check.ruleRefs
    : (Array.isArray(responsibility.ruleRefs) ? responsibility.ruleRefs : null);
  const evidenceSegments = Array.isArray(check.evidenceSegments)
    ? check.evidenceSegments
    : (Array.isArray(responsibility.evidenceSegments) ? responsibility.evidenceSegments : null);
  return {
    ...(text(check.indicatorName) ? { indicatorName: text(check.indicatorName) } : {}),
    ...(text(responsibility.responsibilityId || check.responsibilityId) ? { responsibilityId: text(responsibility.responsibilityId || check.responsibilityId) } : {}),
    ...(text(check.parentResponsibilityId || responsibility.parentResponsibilityId) ? { parentResponsibilityId: text(check.parentResponsibilityId || responsibility.parentResponsibilityId) } : {}),
    ...(text(check.branchId || responsibility.branchId) ? { branchId: text(check.branchId || responsibility.branchId) } : {}),
    ...(text(check.payout || responsibility.payout) ? { payout: text(check.payout || responsibility.payout) } : {}),
    ...(text(check.mutuallyExclusiveGroup || responsibility.mutuallyExclusiveGroup) ? { mutuallyExclusiveGroup: text(check.mutuallyExclusiveGroup || responsibility.mutuallyExclusiveGroup) } : {}),
    ...(text(check.responsibilityKind || responsibility.responsibilityKind) ? { responsibilityKind: text(check.responsibilityKind || responsibility.responsibilityKind) } : {}),
    ...(text(check.coverageAggregation || responsibility.coverageAggregation) ? { coverageAggregation: text(check.coverageAggregation || responsibility.coverageAggregation) } : {}),
    ...(evidenceTokens ? { evidenceTokens: evidenceTokens.map(text).filter(Boolean) } : {}),
    ...(ruleRefs ? { ruleRefs: ruleRefs.map(text).filter(Boolean) } : {}),
    ...(evidenceSegments ? { evidenceSegments: evidenceSegments.map((segment) => ({ ...segment })) } : {}),
    ...(text(responsibility.customerSummary || check.customerSummary) ? { customerSummary: text(responsibility.customerSummary || check.customerSummary) } : {}),
    ...(text(responsibility.plainSummary || check.plainSummary || responsibility.card?.customerSummary) ? { plainSummary: text(responsibility.plainSummary || check.plainSummary || responsibility.card?.customerSummary) } : {}),
    ...(rows(responsibility.importantLimits).length ? { importantLimits: rows(responsibility.importantLimits).map(text).filter(Boolean) } : {}),
    ...(check.provenance && typeof check.provenance === 'object' && !Array.isArray(check.provenance) ? { provenance: { ...check.provenance } } : {}),
    ...(text(check.sourceDigest || responsibility.sourceDigest || product.sourceDigest || product.productIdentity?.sourceDigest) ? { sourceDigest: text(check.sourceDigest || responsibility.sourceDigest || product.sourceDigest || product.productIdentity?.sourceDigest) } : {}),
    ...(text(check.responsibilitySourceDigest || responsibility.responsibilitySourceDigest || product.productIdentity?.sourceDigest || product.sourceDigest) ? { responsibilitySourceDigest: text(check.responsibilitySourceDigest || responsibility.responsibilitySourceDigest || product.productIdentity?.sourceDigest || product.sourceDigest) } : {}),
  };
}

function indicatorFrom(product = {}, responsibility = {}, now = new Date().toISOString(), {
  checkOverride = null,
  responsibilityIndex = 0,
  indicatorIndex = 0,
} = {}) {
  const company = text(product.company);
  const productName = text(product.productName);
  const liability = responsibilityLiability(responsibility);
  const sourceRecord = findSourceRecord(product, responsibility);
  // Unified approved indicators are already position-specific. Falling back to
  // the first internal check by liability would leak sparse fields from a
  // sibling indicator (for example ruleRefs/rule_proton_limit).
  const check = checkOverride
    ? { ...checkOverride }
    : findInternalCheck(product, responsibility);
  const sourceUrl = text(check.sourceUrl || responsibility.sourceUrl || sourceRecord.sourceUrl || product.productIdentity?.sourceUrl);
  const indicatorExcerpt = rows(check.evidenceSegments).length
    ? sourceExcerptFor({ evidenceSegments: check.evidenceSegments })
    : sourceExcerptFor(check);
  const sourceExcerpt = indicatorExcerpt.trim()
    ? indicatorExcerpt
    : preserveText(responsibility.sourceExcerpt);
  const sourceRecordId = text(responsibility.sourceRecordId || sourceRecord.sourceRecordId);
  const sourceTitle = text(responsibility.sourceTitle || sourceRecord.sourceTitle || sourceRecord.title);
  const responsibilityKey = [
    text(responsibility.responsibilityId) || liability,
    text(check.indicatorName) || text(check.branchId) || text(check.id) || String(indicatorIndex),
  ].join('\u001f');
  const base = {
    id: `ind_manual_review_${sha1([company, productName, responsibilityKey, sourceRecordId, sourceUrl, VERSION].join('\u001f')).slice(0, 20)}`,
    company,
    productName,
    coverageType: inferCoverageType(responsibility, check),
    liability,
    triggerCondition: text(responsibility.triggerCondition || check.triggerCondition),
    condition: text(responsibility.triggerCondition || check.triggerCondition),
    basis: basisFor(responsibility, check),
    formulaText: formulaFor(responsibility, check),
    ...structuredFormulaFields(responsibility, check),
    ...structuredIndicatorFields(product, responsibility, check),
    payoutSummary: text(responsibility.insurerObligation || check.payoutSummary || responsibility.sourceExcerpt).slice(0, 500),
    value: Number.isFinite(Number(check.value)) ? Number(check.value) : null,
    valueText: text(check.valueText),
    unit: text(check.unit || (text(check.basisKey) === 'fixed_amount' ? '元' : '公式')),
    cashflowTreatment: text(check.cashflowTreatment || 'claim_contingent'),
    calculationStatus: text(check.calculationStatus),
    calculationMetadataVersion: text(check.calculationMetadataVersion || VERSION),
    indicatorCheckStatus: text(check.indicatorCheckStatus || 'accepted_manual_review'),
    indicatorCheckSummary: text(check.indicatorCheckSummary),
    responsibilityScope: text(responsibility.responsibilityScope || check.responsibilityScope || 'basic_or_unspecified'),
    selectionStatus: normalizedSelectionStatus(responsibility.selectionStatus || 'accepted'),
    selectionEvidence: text(responsibility.selectionEvidence || 'manual_skill_review'),
    reviewedResponsibilityIndex: responsibilityIndex,
    reviewedIndicatorIndex: indicatorIndex,
    quantificationStatus: 'quantified',
    extractionMethod: 'manual_skill_review',
    sourceRecordId,
    sourceUrl,
    sourceTitle,
    sourceExcerpt,
    sourceEvidenceLevel: sourceUrl ? 'official_excerpt' : 'missing_source_url',
    responsibilityArtifactId: text(product.artifactId),
    semanticProjectionSource: 'approved_artifact',
    responsibilityRepairVersion: text(product.repairAudit?.version || product.publication?.repairVersion),
    reviewVersion: VERSION,
    updatedAt: now,
  };
  const calculatedFields = indicatorCalculationPayloadFields(base);
  const basisKey = text(check.basisKey) || calculatedFields.basisKey;
  const calculationKey = text(check.calculationKey) || calculatedFields.calculationKey;
  const hasExplicitRequiredInputs = Array.isArray(check.requiredInputs)
    || Array.isArray(responsibility.requiredInputs);
  const explicitRequiredInputs = rows(
    Array.isArray(check.requiredInputs) ? check.requiredInputs : responsibility.requiredInputs,
  ).map(text).filter(Boolean);
  return {
    ...base,
    ...calculatedFields,
    basisKey,
    calculationKey,
    requiredInputs: hasExplicitRequiredInputs
      ? explicitRequiredInputs
      : requiredCalculationInputsForMeta({ basisKey, calculationKey }),
    calculationEligible: typeof check.calculationEligible === 'boolean' ? check.calculationEligible : calculatedFields.calculationEligible,
    calculationReason: text(check.calculationReason) || calculatedFields.calculationReason,
    calculationMetadataVersion: base.calculationMetadataVersion,
  };
}

function validateProduct(product = {}, {
  unifiedResponsibilities = null,
  expectedResponsibilityCount = null,
} = {}) {
  const issues = [];
  if (!text(product.company)) issues.push('missing_company');
  if (!text(product.productName)) issues.push('missing_productName');
  if (
    unifiedResponsibilities
    && expectedResponsibilityCount !== null
    && expectedResponsibilityCount !== unifiedResponsibilities.length
  ) {
    issues.push(`responsibility_count_mismatch:expected=${expectedResponsibilityCount}:actual=${unifiedResponsibilities.length}`);
  }
  for (const responsibility of rows(product.acceptedResponsibilities)) {
    const liability = responsibilityLiability(responsibility);
    if (!liability) issues.push('accepted_missing_liability');
    if (!text(responsibility.sourceUrl)) issues.push(`accepted_missing_sourceUrl:${liability}`);
    if (!text(responsibility.sourceExcerpt)) issues.push(`accepted_missing_sourceExcerpt:${liability}`);
  }
  return issues;
}

function upsertIndicators(db, indicators = [], now = new Date().toISOString()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_company ON insurance_indicator_records(company);
    CREATE INDEX IF NOT EXISTS idx_insurance_indicator_records_product_name ON insurance_indicator_records(product_name);
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insert = db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      coverage_type = excluded.coverage_type,
      liability = excluded.liability,
      payload = excluded.payload
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const indicator of indicators) {
      insert.run(
        indicator.id,
        indicator.company,
        indicator.productName,
        indicator.coverageType,
        indicator.liability,
        JSON.stringify(indicator),
      );
    }
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('reviewed_responsibility_artifact_imported_at', now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function compact(value = '') {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function acceptedTitleSet(product = {}) {
  return new Set(rows(product.acceptedResponsibilities).map((item) => compact(responsibilityLiability(item))).filter(Boolean));
}

function pruneCardsToAcceptedResponsibilities(dbPath, product = {}) {
  const acceptedTitles = acceptedTitleSet(product);
  if (!acceptedTitles.size) return { deletedCards: 0, keptCards: 0 };
  const db = new DatabaseSync(path.resolve(dbPath));
  try {
    const cards = db.prepare(`
      SELECT id, title
        FROM product_responsibility_cards
       WHERE company = ? AND product_name = ?
    `).all(text(product.company), text(product.productName));
    const deleteCard = db.prepare('DELETE FROM product_responsibility_cards WHERE id = ?');
    let deletedCards = 0;
    let keptCards = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const card of cards) {
        if (acceptedTitles.has(compact(card.title))) {
          keptCards += 1;
          continue;
        }
        deleteCard.run(card.id);
        deletedCards += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { deletedCards, keptCards };
  } finally {
    db.close();
  }
}

function pruneIndicatorsToAcceptedResponsibilities(dbPath, product = {}, expectedIndicatorIds = null) {
  const acceptedTitles = acceptedTitleSet(product);
  if (!acceptedTitles.size) return { deletedIndicators: 0, keptIndicators: 0 };
  const db = new DatabaseSync(path.resolve(dbPath));
  try {
    const indicators = db.prepare(`
      SELECT id, liability
        FROM insurance_indicator_records
       WHERE company = ? AND product_name = ?
    `).all(text(product.company), text(product.productName));
    const deleteIndicator = db.prepare('DELETE FROM insurance_indicator_records WHERE id = ?');
    let deletedIndicators = 0;
    let keptIndicators = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const indicator of indicators) {
        const shouldKeep = expectedIndicatorIds instanceof Set
          ? expectedIndicatorIds.has(text(indicator.id))
          : acceptedTitles.has(compact(indicator.liability));
        if (shouldKeep) {
          keptIndicators += 1;
          continue;
        }
        deleteIndicator.run(indicator.id);
        deletedIndicators += 1;
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { deletedIndicators, keptIndicators };
  } finally {
    db.close();
  }
}

function ensureSingleProductWriteTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_responsibility_cards (
      id TEXT PRIMARY KEY,
      product_key TEXT NOT NULL,
      company TEXT,
      product_name TEXT,
      title TEXT,
      category TEXT,
      cashflow_treatment TEXT,
      calculation_status TEXT,
      calculation_reason TEXT,
      responsibility_scope TEXT,
      selection_status TEXT,
      source_url TEXT,
      generated_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_responsibility_artifacts (
      id TEXT PRIMARY KEY,
      company TEXT NOT NULL,
      product_name TEXT NOT NULL,
      source_digest TEXT NOT NULL,
      source_url TEXT,
      published_at TEXT NOT NULL,
      publisher_version TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
}

function targetKnowledgeRows(db, product = {}) {
  return db.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE company = ? AND product_name = ?
     ORDER BY id ASC
  `).all(text(product.company), text(product.productName)).map((row) => {
    const payload = JSON.parse(row.payload || '{}');
    return {
      ...payload,
      id: payload.id ?? row.id,
      company: text(payload.company || row.company),
      productName: text(payload.productName || payload.product_name || payload.name || row.product_name),
      url: text(payload.url || row.url),
    };
  });
}

function materializedRowsForProduct(db, product = {}, indicators = [], now) {
  const company = text(product.company);
  const productName = text(product.productName);
  const productKey = productKeyFor(company, productName);
  const cards = buildResponsibilityCardsForPolicy({
    policy: { company, productName, name: productName },
    responsibilities: rows(product.acceptedResponsibilities),
    coverageIndicators: indicators,
    knowledgeRecords: targetKnowledgeRows(db, product),
    optionalResponsibilityRecords: [],
    knowledgeResponsibilityMode: 'authoritative_only',
  });
  return cards.map((card, index) => {
    const indicatorCheck = indicatorCheckForResponsibilityCard(card);
    const id = `product_responsibility_card:${productKey}:${String(index).padStart(4, '0')}:${text(card.title).normalize('NFKC').replace(/\s+/gu, '') || '保险责任'}`;
    return {
      id,
      productKey,
      company: text(card.company || company),
      productName: text(card.productName || productName),
      title: text(card.title),
      category: text(card.category),
      cashflowTreatment: text(card.cashflowTreatment),
      calculationStatus: text(card.calculationStatus),
      calculationReason: text(card.calculationReason),
      responsibilityScope: text(card.responsibilityScope),
      selectionStatus: text(card.selectionStatus),
      sourceUrl: text(card.sourceUrl),
      generatedAt: now,
      updatedAt: now,
      payload: {
        ...card,
        productKey,
        generatedAt: now,
        sourceCardId: text(card.id),
        sourceGate: card.sourceUrl ? 'source_url_present' : 'missing_source_url',
        liabilityGate: card.title && card.cashflowTreatment !== 'not_cashflow' ? 'accepted' : 'needs_review',
        indicatorCheckStatus: indicatorCheck.status,
        indicatorCheckIssues: indicatorCheck.issues,
        indicatorCheckSummary: indicatorCheck.summary,
        indicatorCheckVersion: '2026-06-23-responsibility-card-indicator-check',
      },
    };
  });
}

export function importReviewedResponsibilityArtifacts({
  artifacts = [],
  dbPath = resolvePolicyOcrWriteDatabasePath({ projectRoot }),
  write = false,
  sampleLimit = 10,
  now = new Date().toISOString(),
  execution = null,
} = {}) {
  const productEntries = artifacts.flatMap((artifact) => readArtifactProducts(artifact));
  const samples = [];
  const blockers = [];
  const validationFailures = [];
  const indicators = [];
  const productsForMaterialize = new Map();
  const productsByKey = new Map();
  const indicatorIdsByProduct = new Map();

  for (const entry of productEntries) {
    const unifiedResponsibilities = Object.hasOwn(entry.product, 'responsibilities')
      ? rows(entry.product.responsibilities)
      : null;
    const product = normalizeUnifiedProduct(entry.product);
    const productBlockers = rows(product.blockers);
    if (productBlockers.length) {
      blockers.push({ company: product.company, productName: product.productName, blockers: productBlockers });
    }
    const issues = validateProduct(product, {
      unifiedResponsibilities,
      expectedResponsibilityCount: entry.expectedResponsibilityCount,
    });
    if (issues.length) {
      validationFailures.push({ company: product.company, productName: product.productName, issues });
      continue;
    }
    const accepted = rows(product.acceptedResponsibilities);
    const productKey = `${text(product.company)}\u001f${text(product.productName)}`;
    for (const [responsibilityIndex, responsibility] of accepted.entries()) {
      const sourceIndicators = unifiedResponsibilities
        ? rows(unifiedResponsibilities[responsibilityIndex]?.indicators)
        : rows(responsibility.indicators);
      const checks = sourceIndicators.length ? sourceIndicators : [null];
      if (!indicatorIdsByProduct.has(productKey)) indicatorIdsByProduct.set(productKey, new Set());
      for (const [indicatorIndex, check] of checks.entries()) {
        const indicator = indicatorFrom(product, responsibility, now, {
          checkOverride: check,
          responsibilityIndex,
          indicatorIndex,
        });
        indicators.push(indicator);
        indicatorIdsByProduct.get(productKey).add(indicator.id);
      }
    }
    if (accepted.length) productsForMaterialize.set(productKey, {
      company: text(product.company),
      productName: text(product.productName),
      acceptedCount: accepted.length,
      responsibilityMode: unifiedResponsibilities ? 'authoritative_only' : 'auto',
      authoritativeResponsibilities: accepted,
    });
    if (accepted.length) productsByKey.set(productKey, product);
    if (samples.length < sampleLimit) {
      samples.push({
        company: product.company,
        productName: product.productName,
        acceptedCount: accepted.length,
        blockerCount: productBlockers.length,
        liabilities: accepted.slice(0, 6).map(responsibilityLiability),
      });
    }
  }

  let materializeResult = null;
  const indicatorPruneResults = [];
  const artifactWriteResults = [];
  const strictAlignmentResults = [];
  if (write && indicators.length) {
    const writeDbPath = assertNotLegacyPolicyOcrDatabasePath({ projectRoot, dbPath });
    const db = new DatabaseSync(writeDbPath);
    try {
      ensureSingleProductWriteTables(db);
      const insertIndicator = db.prepare(`
        INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertCard = db.prepare(`
        INSERT INTO product_responsibility_cards (
          id, product_key, company, product_name, title, category, cashflow_treatment,
          calculation_status, calculation_reason, responsibility_scope, selection_status,
          source_url, generated_at, updated_at, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertArtifact = db.prepare(`
        INSERT INTO product_responsibility_artifacts (
          id, company, product_name, source_digest, source_url, published_at, publisher_version, payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const deleteIndicators = db.prepare('DELETE FROM insurance_indicator_records WHERE company = ? AND product_name = ?');
      const deleteCards = db.prepare('DELETE FROM product_responsibility_cards WHERE product_key = ? OR (company = ? AND product_name = ?)');
      const deleteArtifacts = db.prepare('DELETE FROM product_responsibility_artifacts WHERE company = ? AND product_name = ?');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const product of productsForMaterialize.values()) {
          const productKey = `${product.company}\u001f${product.productName}`;
          const productIndicators = indicators.filter((indicator) => (
            text(indicator.company) === product.company && text(indicator.productName) === product.productName
          ));
          const expectedIndicatorIds = indicatorIdsByProduct.get(productKey) || new Set();
          const existingIndicatorIds = db.prepare(`
            SELECT id
              FROM insurance_indicator_records
             WHERE company = ? AND product_name = ?
          `).all(product.company, product.productName).map((row) => text(row.id));
          const staleIndicatorIds = existingIndicatorIds.filter((id) => !expectedIndicatorIds.has(id));
          indicatorPruneResults.push({
            company: product.company,
            productName: product.productName,
            deletedIndicators: staleIndicatorIds.length,
            keptIndicators: existingIndicatorIds.length - staleIndicatorIds.length,
          });
          const before = {
            cards: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE product_key = ? OR (company = ? AND product_name = ?)').get(productKeyFor(product.company, product.productName), product.company, product.productName)?.count || 0),
            indicators: Number(db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records WHERE company = ? AND product_name = ?').get(product.company, product.productName)?.count || 0),
            artifacts: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_artifacts WHERE company = ? AND product_name = ?').get(product.company, product.productName)?.count || 0),
          };
          const cards = materializedRowsForProduct(db, {
            ...productsByKey.get(productKey),
            ...product,
          }, productIndicators, now);
          deleteIndicators.run(product.company, product.productName);
          deleteCards.run(productKeyFor(product.company, product.productName), product.company, product.productName);
          deleteArtifacts.run(product.company, product.productName);
          for (const indicator of productIndicators) {
            insertIndicator.run(
              indicator.id,
              indicator.company,
              indicator.productName,
              indicator.coverageType,
              indicator.liability,
              JSON.stringify(indicator),
            );
          }
          for (const card of cards) {
            insertCard.run(
              card.id,
              card.productKey,
              card.company,
              card.productName,
              card.title,
              card.category,
              card.cashflowTreatment,
              card.calculationStatus,
              card.calculationReason,
              card.responsibilityScope,
              card.selectionStatus,
              card.sourceUrl,
              card.generatedAt,
              card.updatedAt,
              JSON.stringify(card.payload),
            );
          }
          const reviewedProduct = productsByKey.get(productKey) || product;
          const reviewedSourceDigest = text(
            reviewedProduct.sourceDigest || reviewedProduct.productIdentity?.sourceDigest,
          );
          const reviewedSourceUrl = text(
            reviewedProduct.sourceUrl || reviewedProduct.productIdentity?.sourceUrl,
          );
          const artifactId = text(reviewedProduct.artifactId)
            || `responsibility_artifact_${sha1([reviewedProduct.company, reviewedProduct.productName, reviewedSourceDigest, VERSION].join('\u001f')).slice(0, 20)}`;
          insertArtifact.run(
            artifactId,
            reviewedProduct.company,
            reviewedProduct.productName,
            reviewedSourceDigest,
            reviewedSourceUrl,
            now,
            text(reviewedProduct.publisherVersion || VERSION),
            JSON.stringify(reviewedProduct),
          );
          const after = {
            cards: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE product_key = ? OR (company = ? AND product_name = ?)').get(productKeyFor(product.company, product.productName), product.company, product.productName)?.count || 0),
            indicators: Number(db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records WHERE company = ? AND product_name = ?').get(product.company, product.productName)?.count || 0),
            artifacts: Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_artifacts WHERE company = ? AND product_name = ?').get(product.company, product.productName)?.count || 0),
          };
          artifactWriteResults.push({ company: product.company, productName: product.productName, before, after });
        }
        db.prepare(`
          INSERT INTO app_meta (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run('reviewed_responsibility_artifact_imported_at', now);
        db.prepare(`
          INSERT INTO app_meta (key, value)
          VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run('product_responsibility_cards_materialized_at', now);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      for (const product of productsForMaterialize.values()) {
        strictAlignmentResults.push(loadStrictAlignmentProduct(db, product));
      }
    } finally {
      db.close();
    }
    materializeResult = {
      productsWithCards: artifactWriteResults.filter((result) => result.after.cards > 0).length,
      insertedRows: artifactWriteResults.reduce((sum, result) => sum + result.after.cards, 0),
      deletedRows: artifactWriteResults.reduce((sum, result) => sum + result.before.cards, 0),
    };
  }

  return {
    dbPath: path.resolve(dbPath),
    dryRun: !write,
    ok: validationFailures.length === 0,
    validationIssueCount: validationFailures.reduce((sum, failure) => sum + failure.issues.length, 0),
    artifacts: artifacts.map((artifact) => path.resolve(artifact)),
    productsReviewed: productEntries.length,
    productsWithAcceptedResponsibilities: productsForMaterialize.size,
    acceptedResponsibilities: indicators.length,
    validationFailures,
    blockerProducts: blockers,
    materializedProducts: Number(materializeResult?.productsWithCards || 0),
    materializedCards: Number(materializeResult?.insertedRows || 0),
    prunedCards: Number(materializeResult?.deletedRows || 0),
    prunedIndicators: indicatorPruneResults.reduce((sum, result) => sum + Number(result.deletedIndicators || 0), 0),
    indicatorPruneResults: indicatorPruneResults.slice(0, sampleLimit),
    artifactWriteResults,
    strictAlignment: {
      evaluatedProducts: strictAlignmentResults.length,
      strictAlignedProducts: strictAlignmentResults.filter((result) => result.strictAligned).length,
      products: strictAlignmentResults,
    },
    pruneResults: [],
    samples,
    ...(execution ? { execution } : {}),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const artifactArg = readArg('artifacts', '');
  const artifacts = artifactArg
    ? artifactArg.split(',').map((item) => item.trim()).filter(Boolean)
    : process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const write = hasFlag('write');
  const isolatedClone = hasFlag('isolated-clone');
  const requestedDbPath = readArg('db-path', '');
  const executionGatePath = readArg('execution-gate', '');
  if (isolatedClone && !requestedDbPath) {
    throw new Error('--isolated-clone requires --db-path');
  }
  const dbPath = isolatedClone
    ? path.resolve(requestedDbPath)
    : resolvePolicyOcrWriteDatabasePath({ projectRoot, requestedPath: requestedDbPath });
  const execution = collectImportExecution({
    repoRoot: projectRoot,
    scriptPath: process.argv[1],
    dbPath,
    artifacts,
    sampleLimit: Number(readArg('sample-limit', 10)) || 10,
    write,
    isolatedClone,
    gatePath: executionGatePath,
    cwd: process.cwd(),
  });
  if (write) assertImportExecutionGate({ gatePath: executionGatePath, execution });
  const result = importReviewedResponsibilityArtifacts({
    artifacts,
    dbPath,
    write,
    sampleLimit: Number(readArg('sample-limit', 10)) || 10,
    execution,
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
