import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deriveIndicatorProductKeys } from '../server/policy-derived-results.service.mjs';
import {
  buildIndicatorsForProduct,
  markAffectedDerivedRowsStale,
  normalizeLookupText,
  normalizeSpaces,
  recordIndicatorRefreshBatch,
  sourceText,
  splitBenefitSections,
  upsertIndicators,
} from './backfill-knowledge-responsibility-indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-20-indicator-quality-governance';

const LANES = [
  'cashflow_annuity',
  'medical_formula',
  'critical_illness',
  'accident',
  'death_life',
  'waiver',
];

function trim(value) {
  return String(value ?? '').trim();
}

function parsePayload(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseIdList(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = trim(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function compactText(value) {
  return normalizeSpaces(value).replace(/\s+/gu, '');
}

function isAnnuityLiability(liability) {
  return /年金|养老保险金|生存保险金|生存金|特别生存保险金|满期保险金|满期生存保险金|期满保险金|满期金|满期返还|祝寿金|祝寿保险金|贺寿金|贺岁金|长寿金|关爱年金|教育金|少儿教育金|高中教育金|大学教育金|深造金|婚嫁金|立业金|创业金|返还保险费|返还已交保险费|生存返还|保证领取保险金|保证领取年金|保证给付年金/u.test(normalizeSpaces(liability));
}

function hasAnnuityTrigger(text) {
  const compact = compactText(text);
  return /被保险人[^。；]{0,100}生存|犹豫期结束[^。；]{0,60}生存|保单(?:周年日|生效对应日)[^。；]{0,100}生存|年满[^。；]{0,80}周岁[^。；]{0,100}生存|保险期间届满[^。；]{0,100}生存|满期日[^。；]{0,100}生存|领取期[^。；]{0,100}生存|保证领取期/u.test(compact);
}

function hasDisallowedCashflowContext(text) {
  const compact = compactText(text);
  return /恶性肿瘤|重大疾病|重疾|中症|轻症|特定疾病|疾病关爱金|医疗费用|住院|门诊|报销|豁免/u.test(compact);
}

function hasMultipleDistinctPayoutRates(text) {
  const normalized = normalizeSpaces(text);
  const values = new Set();
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*[％%]/gu)) values.add(`percent:${Number(match[1])}`);
  for (const match of normalized.matchAll(/(\d+(?:\.\d+)?)\s*倍/gu)) values.add(`multiple:${Number(match[1])}`);
  return values.size > 1;
}

function laneForIndicator(indicator = {}) {
  const liability = normalizeSpaces(indicator.liability);
  const text = normalizeSpaces(`${indicator.liability || ''} ${indicator.coverageType || ''} ${indicator.formulaText || ''} ${indicator.sourceExcerpt || ''}`);
  if (/豁免/u.test(text)) return 'waiver';
  if (/医疗|门诊|住院|药品|药械|费用|报销|补偿|免赔额|质子重离子/u.test(text)) return 'medical_formula';
  if (/恶性肿瘤|癌|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病关爱金/u.test(text)) return 'critical_illness';
  if (/意外|伤残|残疾|交通|航空|列车|轮船|驾乘|猝死/u.test(text)) return 'accident';
  if (isAnnuityLiability(liability) && hasAnnuityTrigger(text)) return 'cashflow_annuity';
  if (/身故|全残|高残|现金价值|已交保费|已交保险费|max\(|较大者|较高者/u.test(text)) return 'death_life';
  if (isAnnuityLiability(liability)) return 'cashflow_annuity';
  return 'death_life';
}

function isHighConfidenceAnnuityCandidate(indicator = {}) {
  const liability = normalizeSpaces(indicator.liability);
  const excerpt = normalizeSpaces(indicator.sourceExcerpt);
  const liabilityCompact = compactText(liability);
  const formulaCompact = compactText(`${indicator.formulaText || ''} ${indicator.basis || ''}`);
  if (!isAnnuityLiability(liability)) return false;
  if (liability.length > 18) return false;
  if (/责任|描述|类型|申请|剩余期间|未给付|给付的|已给付|对应日|保单年度|年交|趸交|期交|财富嘉\d*号|个人账户|公共账户/u.test(liabilityCompact)) return false;
  if (/保险金.+保险金/u.test(liabilityCompact)) return false;
  if (/现金价值|账户价值|个人账户|公共账户|领取金额|约定领取比例|领取计划|领取频率/u.test(formulaCompact)) return false;
  if (!hasAnnuityTrigger(excerpt)) return false;
  if (hasDisallowedCashflowContext(`${liability} ${excerpt}`)) return false;
  if (hasMultipleDistinctPayoutRates(excerpt)) return false;
  if (normalizeSpaces(indicator.responsibilityScope) === 'optional' && !trim(indicator.optionalResponsibilityId)) return false;
  if (!trim(indicator.formulaText)) return false;
  if (!trim(indicator.basis)) return false;
  if (!trim(indicator.unit)) return false;
  return true;
}

function loadKnowledgeProducts(db, {
  minKnowledgeId = 0,
  knowledgeIds = [],
  companies = [],
  includeExistingProducts = false,
} = {}) {
  const targetIds = uniqueStrings(knowledgeIds.map(String))
    .map(Number)
    .filter((item) => Number.isInteger(item) && item > 0);
  const idFilter = targetIds.length ? `AND id IN (${targetIds.map(() => '?').join(', ')})` : '';
  const rows = db.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE product_name IS NOT NULL AND product_name <> '' AND id >= ? ${idFilter}
     ORDER BY company, product_name, id DESC
  `).all(minKnowledgeId, ...targetIds);
  const indicatorKeys = includeExistingProducts
    ? new Set()
    : new Set(db.prepare(`
      SELECT DISTINCT COALESCE(company, '') AS company, COALESCE(product_name, '') AS product_name
        FROM insurance_indicator_records
       WHERE product_name IS NOT NULL AND product_name <> ''
    `).all().map((row) => `${row.company}\u001f${row.product_name}`));
  const products = new Map();
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const company = trim(row.company || payload.company);
    const productName = trim(row.product_name || payload.productName);
    if (companies.length && !companies.includes(company)) continue;
    const key = `${company}\u001f${productName}`;
    if (indicatorKeys.has(key)) continue;
    const knowledgeText = sourceText(payload);
    if (!/保险责任|保险金|给付|赔付|报销|津贴|年金/u.test(knowledgeText)) continue;
    if (!products.has(key)) {
      products.set(key, {
        company,
        productName,
        productType: trim(payload.productType),
        salesStatus: trim(payload.salesStatus),
        sourceRecordIds: [],
        sourceUrls: [],
        sourceTitles: [],
        textParts: [],
      });
    }
    const product = products.get(key);
    product.productType ||= trim(payload.productType);
    product.salesStatus ||= trim(payload.salesStatus);
    product.sourceRecordIds.push(String(payload.id || row.id));
    if (trim(payload.url || row.url)) product.sourceUrls.push(trim(payload.url || row.url));
    if (trim(payload.title)) product.sourceTitles.push(trim(payload.title));
    product.textParts.push(knowledgeText);
  }
  return [...products.values()].map((product) => ({
    ...product,
    sourceRecordId: product.sourceRecordIds[0] || '',
    sourceUrl: product.sourceUrls[0] || '',
    sourceTitle: product.sourceTitles[0] || product.productName,
    sourceText: product.textParts.join('\n').slice(0, 24000),
  }));
}

function existingIndicatorsForProducts(db, products) {
  const productKeys = new Set(products.map((product) => `${product.company}\u001f${product.productName}`));
  const rows = db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records').all();
  return rows
    .map((row) => ({ ...row, payload: parsePayload(row.payload) }))
    .filter((row) => productKeys.has(`${row.company}\u001f${row.product_name}`));
}

function comparableFormulaText(indicator = {}) {
  const liability = normalizeSpaces(indicator.liability);
  const rawFormula = normalizeSpaces(indicator.formulaText || indicator.payload?.formulaText);
  const formula = liability
    ? rawFormula.replace(new RegExp(`^${liability.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*=\\s*`, 'u'), '')
    : rawFormula;
  return normalizeLookupText(formula)
    .replace(/本合同实际交纳的?保险费|实际交纳的?保险费|已交纳的?保险费|已交保险费|已交保费/gu, '已交保险费')
    .replace(/基本保额|基本保险金/gu, '基本保险金额');
}

function indicatorComparableKey(indicator = {}) {
  return [
    normalizeLookupText(indicator.company),
    normalizeLookupText(indicator.productName || indicator.product_name),
    normalizeLookupText(indicator.coverageType || indicator.coverage_type),
    normalizeLookupText(indicator.liability),
    comparableFormulaText(indicator),
  ].join('\u001f');
}

function buildIssue({ lane, issueType, severity = 'warning', product, indicator, reason }) {
  return {
    lane,
    issueType,
    severity,
    company: product.company,
    productName: product.productName,
    sourceRecordId: indicator?.sourceRecordId || product.sourceRecordId,
    currentIndicators: [],
    sourceExcerpt: indicator?.sourceExcerpt || '',
    reason,
  };
}

function buildCandidate({ lane, product, proposedIndicator, issueType, reason }) {
  const writeAllowed = lane === 'cashflow_annuity' && isHighConfidenceAnnuityCandidate(proposedIndicator);
  return {
    id: `indicator_quality_candidate_${sha1([product.company, product.productName, lane, proposedIndicator.liability, proposedIndicator.formulaText].join('\u001f'), 24)}`,
    lane,
    operation: writeAllowed ? 'insert' : 'report_only',
    confidence: writeAllowed ? 'high' : 'medium',
    writeAllowed,
    blockedReason: writeAllowed ? '' : lane === 'cashflow_annuity' ? 'cashflow_candidate_not_high_confidence' : 'phase_one_report_only_lane',
    issueType,
    company: product.company,
    productName: product.productName,
    sourceRecordId: proposedIndicator.sourceRecordId || product.sourceRecordId,
    currentIndicator: null,
    proposedIndicator: {
      ...proposedIndicator,
      version: VERSION,
    },
    sourceExcerpt: proposedIndicator.sourceExcerpt || '',
    reason,
  };
}

function proposedIndicatorsForProduct(product, now) {
  return buildIndicatorsForProduct(product, now).map((indicator) => ({
    ...indicator,
    sourceRecordId: indicator.sourceRecordId || product.sourceRecordId,
    sourceUrl: indicator.sourceUrl || product.sourceUrl,
    sourceTitle: indicator.sourceTitle || product.sourceTitle,
    sourceEvidenceLevel: indicator.sourceEvidenceLevel || (product.sourceUrl ? 'official_excerpt' : 'local_excerpt'),
  }));
}

function auditProduct({ product, existingKeys, now }) {
  const issues = [];
  const candidates = [];
  const proposed = proposedIndicatorsForProduct(product, now);
  for (const indicator of proposed) {
    const lane = laneForIndicator(indicator);
    const key = indicatorComparableKey(indicator);
    if (existingKeys.has(key)) continue;
    const issueType = lane === 'cashflow_annuity' ? 'missing_or_generic_cashflow_indicator' : 'report_only_candidate';
    const reason = lane === 'cashflow_annuity'
      ? '官方条款可抽取确定返钱责任，当前指标缺少同等真实责任名和公式。'
      : '第一期仅审计该险种 lane，不写库。';
    issues.push(buildIssue({ lane, issueType, product, indicator, reason }));
    candidates.push(buildCandidate({ lane, product, proposedIndicator: indicator, issueType, reason }));
  }
  for (const section of splitBenefitSections(product.sourceText)) {
    const sectionLane = laneForIndicator({
      liability: section.liability,
      sourceExcerpt: section.text,
    });
    if (sectionLane === 'medical_formula' && /免赔额|医疗费用|给付比例|赔付比例/u.test(section.text)) {
      issues.push(buildIssue({
        lane: 'medical_formula',
        issueType: 'medical_formula_review',
        product,
        indicator: {
          sourceRecordId: product.sourceRecordId,
          sourceExcerpt: normalizeSpaces(section.text).slice(0, 1200),
        },
        reason: '医疗责任需要审查是否误把免赔额、限额或单一金额当作保险金公式。',
      }));
    }
  }
  return { issues, candidates };
}

function emptyLaneSummary() {
  return {
    issues: 0,
    candidates: 0,
    writeAllowedCandidates: 0,
    highConfidenceCandidates: 0,
  };
}

function summarize({ issues, candidates, writtenIndicators }) {
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, emptyLaneSummary()]));
  for (const issue of issues) {
    byLane[issue.lane] ||= emptyLaneSummary();
    byLane[issue.lane].issues += 1;
  }
  for (const candidate of candidates) {
    byLane[candidate.lane] ||= emptyLaneSummary();
    byLane[candidate.lane].candidates += 1;
    if (candidate.writeAllowed) byLane[candidate.lane].writeAllowedCandidates += 1;
    if (candidate.confidence === 'high') byLane[candidate.lane].highConfidenceCandidates += 1;
  }
  return {
    issues: issues.length,
    candidates: candidates.length,
    writeAllowedCandidates: candidates.filter((candidate) => candidate.writeAllowed).length,
    indicatorUpserts: writtenIndicators.length,
    byLane,
  };
}

export function auditInsuranceIndicatorQuality({
  dbPath = DEFAULT_DB_PATH,
  writeAnnuityCashflow = false,
  sampleLimit = 20,
  minKnowledgeId = 0,
  companies = [],
  includeExistingProducts = false,
  knowledgeIds = [],
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    const products = loadKnowledgeProducts(db, { minKnowledgeId, companies, includeExistingProducts, knowledgeIds });
    const existing = existingIndicatorsForProducts(db, products);
    const existingKeys = new Set(existing.map((row) => indicatorComparableKey({
      ...row.payload,
      company: row.company,
      productName: row.product_name,
      coverageType: row.coverage_type,
      liability: row.liability,
    })));
    const issues = [];
    const candidates = [];
    for (const product of products) {
      const audited = auditProduct({ product, existingKeys, now });
      issues.push(...audited.issues);
      candidates.push(...audited.candidates);
    }
    const writeCandidates = writeAnnuityCashflow
      ? candidates.filter((candidate) => candidate.writeAllowed)
      : [];
    const writtenIndicators = writeCandidates.map((candidate) => candidate.proposedIndicator);
    let indicatorUpdateBatchId = '';
    let affectedPolicyCount = 0;
    if (writeAnnuityCashflow && writtenIndicators.length) {
      upsertIndicators(db, writtenIndicators);
      const changedProductKeys = uniqueStrings(writtenIndicators.flatMap((indicator) => deriveIndicatorProductKeys(indicator)));
      db.exec('BEGIN IMMEDIATE');
      try {
        const affectedPolicyIds = markAffectedDerivedRowsStale(db, changedProductKeys, now);
        affectedPolicyCount = affectedPolicyIds.length;
        indicatorUpdateBatchId = recordIndicatorRefreshBatch(db, {
          productKeys: changedProductKeys,
          affectedPolicyCount,
          now,
        });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return {
      dbPath,
      dryRun: !writeAnnuityCashflow,
      candidateProducts: products.length,
      issues,
      candidates,
      samples: candidates.slice(0, sampleLimit),
      indicatorUpserts: writtenIndicators.length,
      affectedPolicyCount,
      indicatorUpdateBatchId,
      summary: summarize({ issues, candidates, writtenIndicators }),
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const companies = readArg('companies', '')
    .split(',')
    .map((item) => trim(item))
    .filter(Boolean);
  const result = auditInsuranceIndicatorQuality({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    writeAnnuityCashflow: hasFlag('write-annuity-cashflow'),
    sampleLimit: Number(readArg('sample-limit', 20)) || 20,
    minKnowledgeId: Number(readArg('min-knowledge-id', 0)) || 0,
    companies,
    includeExistingProducts: hasFlag('include-existing-products'),
    knowledgeIds: parseIdList(readArg('knowledge-ids', '')),
  });
  console.log(JSON.stringify(result, null, 2));
}
