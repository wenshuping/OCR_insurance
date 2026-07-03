import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { indicatorCalculationPayloadFields } from '../src/indicator-calculation.mjs';
import { materializeProductResponsibilityCards } from './materialize-product-responsibility-cards.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = process.env.POLICY_OCR_APP_DB_PATH || path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-23-reviewed-responsibility-artifact-import';

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

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
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
  const explicit = text(responsibility.basis || check.basis);
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
  const explicit = text(responsibility.formulaText || check.formulaText);
  if (explicit) return explicit;
  const liability = responsibilityLiability(responsibility);
  const obligation = text(responsibility.insurerObligation);
  if (obligation) return `${liability}：${obligation}`;
  return text(responsibility.sourceExcerpt).slice(0, 500);
}

function indicatorFrom(product = {}, responsibility = {}, now = new Date().toISOString()) {
  const company = text(product.company);
  const productName = text(product.productName);
  const liability = responsibilityLiability(responsibility);
  const sourceRecord = findSourceRecord(product, responsibility);
  const check = findInternalCheck(product, responsibility);
  const sourceUrl = text(responsibility.sourceUrl || sourceRecord.sourceUrl);
  const sourceExcerpt = text(responsibility.sourceExcerpt);
  const sourceRecordId = text(responsibility.sourceRecordId || sourceRecord.sourceRecordId);
  const sourceTitle = text(responsibility.sourceTitle || sourceRecord.sourceTitle || sourceRecord.title);
  const base = {
    id: `ind_manual_review_${sha1([company, productName, liability, sourceRecordId, sourceUrl, VERSION].join('\u001f')).slice(0, 20)}`,
    company,
    productName,
    coverageType: inferCoverageType(responsibility, check),
    liability,
    triggerCondition: text(responsibility.triggerCondition || check.triggerCondition),
    condition: text(responsibility.triggerCondition || check.triggerCondition),
    basis: basisFor(responsibility, check),
    formulaText: formulaFor(responsibility, check),
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
    selectionStatus: text(responsibility.selectionStatus || 'accepted'),
    selectionEvidence: text(responsibility.selectionEvidence || 'manual_skill_review'),
    quantificationStatus: 'quantified',
    extractionMethod: 'manual_skill_review',
    sourceRecordId,
    sourceUrl,
    sourceTitle,
    sourceExcerpt,
    sourceEvidenceLevel: sourceUrl ? 'official_excerpt' : 'missing_source_url',
    reviewVersion: VERSION,
    updatedAt: now,
  };
  const calculatedFields = indicatorCalculationPayloadFields(base);
  return {
    ...base,
    ...calculatedFields,
    basisKey: text(check.basisKey) || calculatedFields.basisKey,
    calculationKey: text(check.calculationKey) || calculatedFields.calculationKey,
    calculationEligible: typeof check.calculationEligible === 'boolean' ? check.calculationEligible : calculatedFields.calculationEligible,
    calculationReason: text(check.calculationReason) || calculatedFields.calculationReason,
    calculationMetadataVersion: base.calculationMetadataVersion,
  };
}

function validateProduct(product = {}) {
  const issues = [];
  if (!text(product.company)) issues.push('missing_company');
  if (!text(product.productName)) issues.push('missing_productName');
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

function pruneIndicatorsToAcceptedResponsibilities(dbPath, product = {}) {
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
        if (acceptedTitles.has(compact(indicator.liability))) {
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

export function importReviewedResponsibilityArtifacts({
  artifacts = [],
  dbPath = DEFAULT_DB_PATH,
  write = false,
  sampleLimit = 10,
  now = new Date().toISOString(),
} = {}) {
  const products = artifacts.flatMap((artifact) => readJsonl(path.resolve(artifact)));
  const samples = [];
  const blockers = [];
  const validationFailures = [];
  const indicators = [];
  const productsForMaterialize = new Map();
  const productsByKey = new Map();

  for (const product of products) {
    const productBlockers = rows(product.blockers);
    if (productBlockers.length) {
      blockers.push({ company: product.company, productName: product.productName, blockers: productBlockers });
    }
    const issues = validateProduct(product);
    if (issues.length) {
      validationFailures.push({ company: product.company, productName: product.productName, issues });
      continue;
    }
    const accepted = rows(product.acceptedResponsibilities);
    for (const responsibility of accepted) indicators.push(indicatorFrom(product, responsibility, now));
    if (accepted.length) productsForMaterialize.set(`${text(product.company)}\u001f${text(product.productName)}`, {
      company: text(product.company),
      productName: text(product.productName),
      acceptedCount: accepted.length,
    });
    if (accepted.length) productsByKey.set(`${text(product.company)}\u001f${text(product.productName)}`, product);
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

  const materializeResults = [];
  const pruneResults = [];
  const indicatorPruneResults = [];
  if (write && indicators.length) {
    const db = new DatabaseSync(path.resolve(dbPath));
    try {
      upsertIndicators(db, indicators, now);
    } finally {
      db.close();
    }
    for (const product of productsForMaterialize.values()) {
      const reviewedProduct = productsByKey.get(`${product.company}\u001f${product.productName}`) || product;
      indicatorPruneResults.push({
        company: product.company,
        productName: product.productName,
        ...pruneIndicatorsToAcceptedResponsibilities(dbPath, reviewedProduct),
      });
      materializeResults.push(materializeProductResponsibilityCards({
        dbPath,
        write: true,
        company: product.company,
        productName: product.productName,
        sampleLimit: 1,
        now,
      }));
      pruneResults.push({
        company: product.company,
        productName: product.productName,
        ...pruneCardsToAcceptedResponsibilities(dbPath, reviewedProduct),
      });
    }
  }

  return {
    dbPath: path.resolve(dbPath),
    dryRun: !write,
    artifacts: artifacts.map((artifact) => path.resolve(artifact)),
    productsReviewed: products.length,
    productsWithAcceptedResponsibilities: productsForMaterialize.size,
    acceptedResponsibilities: indicators.length,
    validationFailures,
    blockerProducts: blockers,
    materializedProducts: materializeResults.length,
    materializedCards: materializeResults.reduce((sum, result) => sum + Number(result.insertedRows || 0), 0),
    prunedCards: pruneResults.reduce((sum, result) => sum + Number(result.deletedCards || 0), 0),
    prunedIndicators: indicatorPruneResults.reduce((sum, result) => sum + Number(result.deletedIndicators || 0), 0),
    indicatorPruneResults: indicatorPruneResults.slice(0, sampleLimit),
    pruneResults: pruneResults.slice(0, sampleLimit),
    samples,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const artifactArg = readArg('artifacts', '');
  const artifacts = artifactArg
    ? artifactArg.split(',').map((item) => item.trim()).filter(Boolean)
    : process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const result = importReviewedResponsibilityArtifacts({
    artifacts,
    dbPath: readArg('db-path', DEFAULT_DB_PATH),
    write: hasFlag('write'),
    sampleLimit: Number(readArg('sample-limit', 10)) || 10,
  });
  console.log(JSON.stringify(result, null, 2));
}
