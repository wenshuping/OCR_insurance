import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { indicatorCalculationPayloadFields } from '../src/indicator-calculation.mjs';
import { deriveIndicatorProductKeys } from '../server/policy-derived-results.service.mjs';
import {
  markAffectedDerivedRowsStale,
  recordIndicatorRefreshBatch,
} from './backfill-knowledge-responsibility-indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = process.env.POLICY_OCR_APP_DB_PATH || path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-29-basic-indicator-from-responsibility-card';
const REVIEWED_IMPORT_VERSION = '2026-06-23-reviewed-responsibility-artifact-import';

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

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
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

function sha1(value, length = 24) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function productKey(company, productName) {
  return `${text(company)}\u001f${text(productName)}`;
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')));
}

function bump(map, key) {
  const resolved = text(key) || 'unknown';
  map.set(resolved, (map.get(resolved) || 0) + 1);
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(text).filter(Boolean)) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function normalizeCardRow(row = {}) {
  const payload = parseJson(row.payload);
  return {
    ...payload,
    rowId: text(row.id),
    id: text(payload.id || row.id),
    company: text(payload.company || row.company),
    productName: text(payload.productName || payload.product_name || row.product_name),
    title: text(payload.title || row.title),
    category: text(payload.category || row.category),
    cashflowTreatment: text(payload.cashflowTreatment || row.cashflow_treatment),
    calculationStatus: text(payload.calculationStatus || row.calculation_status),
    calculationReason: text(payload.calculationReason || row.calculation_reason),
    responsibilityScope: text(payload.responsibilityScope || row.responsibility_scope),
    selectionStatus: text(payload.selectionStatus || row.selection_status),
    selectionEvidence: text(payload.selectionEvidence),
    sourceUrl: text(payload.sourceUrl || row.source_url),
    sourceTitle: text(payload.sourceTitle),
    sourceExcerpt: text(payload.sourceExcerpt),
    triggerCondition: text(payload.triggerCondition),
    payoutSummary: text(payload.payoutSummary),
    plainSummary: text(payload.plainSummary),
  };
}

function normalizeBenefitTitle(title = '') {
  let raw = text(title).normalize('NFKC').replace(/\s+/gu, ' ').trim();
  raw = raw.replace(/^\d+\s+(?=[A-Z]\s*类)/iu, '');
  raw = raw.replace(/^[（(]?\d+[)）.、]\s*/u, '');
  raw = raw.replace(/^(?:基本责任|可选责任[一二三四五六七八九十\d]*|必选责任|附加责任)\s*[【\[:：、-]?\s*/u, '');
  raw = raw.replace(/^(?:投保范围)?保险责任\s*[：:]?\s*/u, '');
  const bracket = raw.match(/^【([^】]+)】?/u);
  if (bracket) raw = bracket[1].trim();
  return raw.replace(/[】\]]+$/u, '').trim();
}

function titleRejectReason(title = '') {
  const raw = text(title);
  const normalized = normalizeBenefitTitle(raw);
  const target = compact(normalized);
  const rawTarget = compact(raw);
  if (!target) return 'missing_title';
  if (/^(?:保险金|基本保险金|保险金额保险金|确定保险金|共享保险金|均分保险金|责任准备金|可选责任[一二三四五六七八九十\d]*)$/u.test(target)) {
    return 'generic_or_rule_title';
  }
  if (/诉讼时效|保险金申请|申请保险金|申领保险金|索赔申请|理赔申请|申请与给付保险金|代理申请|受益人|未还款项|欠款|身体检查|保险事故.{0,8}通知|情形复杂|补偿原则|权益转让|住所|通讯地址|合同的转让|保险金额[:：]?|本主险合同的保险金|本附加合同的保险金|本合同的保险金|给付比例指|如何豁免保险费|缴纳保险费的义务|给付保险金条件|为给付保险金|所负给付|合同项下|投资单位价值|实际保险金|保险责任年免赔额|给付条件|赔付比例|补偿或给付部分后给付保险金|变更(?:基本)?保险金|增加基本保险金|医疗账户|账户价值|给付金申请/u.test(`${target} ${rawTarget}`)) {
    return 'administrative_or_rule_title';
  }
  if (/^\d+(?:\.\d+)?%/u.test(target)) return 'sentence_fragment_title';
  if (/^(?:的|按|以|对于|对(?:于|.*(?:给付|赔偿|补偿))|保险人所负|本险种|本合同|本主险|本附加合同)/u.test(target)) return 'sentence_fragment_title';
  if (/^未成年人身故保险金$/u.test(target)) return 'minor_death_limit_title';
  if (/^.{36,}$/u.test(target) && !/^(?:[A-G]\s*类)?(?:住院|门诊|医疗|齿科|药品|手术).{0,24}保险金$/u.test(normalized)) {
    return 'sentence_fragment_title';
  }
  if (!/(?:保险金|年金|生存金|满期金|教育金|津贴|补偿金|豁免|豁免保险费|保险费的豁免)$/u.test(target)) {
    return 'not_benefit_title';
  }
  return '';
}

function sourceLooksLikeResponsibility(card = {}) {
  const target = compact([
    card.title,
    card.triggerCondition,
    card.payoutSummary,
    card.sourceExcerpt,
  ].join(' '));
  if (!target) return false;
  return /(?:本公司|我们|保险人|公司).{0,140}(?:给付|赔偿|赔付|报销|补偿|承担|豁免|免交)|(?:给付|赔偿|赔付|报销|补偿|豁免|免交).{0,80}(?:保险金|保险费|年金|津贴|费用)/u.test(target);
}

export function cardRejectReason(card = {}) {
  if (!text(card.sourceUrl)) return 'missing_source_url';
  if (!text(card.sourceExcerpt)) return 'missing_source_excerpt';
  const titleReason = titleRejectReason(card.title);
  if (titleReason) return titleReason;
  if (text(card.cashflowTreatment) === 'not_cashflow') return 'not_cashflow_card';
  if (!sourceLooksLikeResponsibility(card)) return 'source_not_responsibility';
  return '';
}

function inferCoverageType(card = {}) {
  const explicit = text(card.category);
  if (explicit && !['其他', '规则参数'].includes(explicit)) return explicit;
  const target = compact([card.title, card.triggerCondition, card.payoutSummary, card.sourceExcerpt].join(' '));
  if (/豁免/u.test(target)) return '豁免';
  if (/医疗|住院|门诊|急诊|药品|药械|费用|报销|补偿|免赔|齿科/u.test(target)) return '医疗保障';
  if (/重大疾病|重疾|中症|轻症|疾病|恶性肿瘤|癌|护理|失能/u.test(target)) return '疾病保障';
  if (/意外|伤残|残疾|交通|航空|驾乘/u.test(target)) return '意外保障';
  if (/身故|死亡|全残|高残|寿险/u.test(target)) return '人寿保障';
  if (/年金|生存|满期|教育金|祝寿|长寿|领取/u.test(target)) return '现金流';
  return explicit || '其他';
}

function inferCashflowTreatment(card = {}, coverageType = '') {
  const explicit = text(card.cashflowTreatment);
  if (['scheduled_cashflow', 'claim_contingent', 'waiver_only', 'not_cashflow'].includes(explicit)) return explicit;
  const target = compact([coverageType, card.title, card.triggerCondition, card.sourceExcerpt].join(' '));
  if (/豁免/u.test(target)) return 'waiver_only';
  if (/年金|生存|满期|教育金|祝寿|长寿|领取/u.test(target)) return 'scheduled_cashflow';
  if (/身故|全残|伤残|残疾|疾病|医疗|意外|费用|报销|补偿/u.test(target)) return 'claim_contingent';
  return 'not_cashflow';
}

function basisTextFor(card = {}) {
  const explicit = text(card.basis);
  if (explicit) return explicit;
  const target = compact([card.payoutSummary, card.sourceExcerpt, card.title].join(' '));
  if (/现金价值/u.test(target)) return '现金价值';
  if (/账户价值|账户余额/u.test(target)) return '账户价值';
  if (/实际合理医疗费用|合理且必要.*费用|医疗费用|实际费用|报销|补偿/u.test(target)) return '实际费用、免赔额、赔付比例和责任限额';
  if (/住院日数|住院天数|给付日数|实际日数|日额|津贴/u.test(target)) return '实际天数、日额或保险单位数';
  if (/基本保险金额|基本保额|有效保险金额|保险金额/u.test(target)) return '基本保险金额或保险单载明金额';
  if (/已交|已支付|所交|实际交纳|保险费/u.test(target)) return '已交保险费';
  if (/豁免/u.test(target)) return '后续应交保险费';
  return '官方责任卡条款';
}

function formulaTextFor(card = {}, coverageType = '') {
  const explicit = text(card.formulaText);
  if (explicit) return explicit;
  const payout = text(card.payoutSummary);
  if (payout && compact(payout) !== compact(card.title)) return `${card.title} = ${payout}`.slice(0, 600);

  const target = compact([card.title, card.sourceExcerpt].join(' '));
  if (/豁免/u.test(target)) return `${card.title} = 豁免后续应交保险费`;
  if (/医疗费用|合理且必要.*费用|实际费用|报销|补偿/u.test(target)) {
    return `${card.title} = 按实际合理费用、已获补偿、免赔额、赔付比例和责任限额计算`;
  }
  if (/住院日数|住院天数|给付日数|实际日数|日额|津贴/u.test(target)) {
    return `${card.title} = 按实际天数、日额或保险单位数计算`;
  }
  if (/较大者|较高者|最大者|取大|现金价值/u.test(target)) return `${card.title} = 按条款约定多基准比较给付`;
  if (/基本保险金额|基本保额|有效保险金额|保险金额/u.test(target)) return `${card.title} = 按基本保险金额或保险单载明金额给付`;
  if (/已交|已支付|所交|实际交纳|保险费/u.test(target)) return `${card.title} = 按已交保险费或条款约定金额给付`;
  if (coverageType === '现金流') return `${card.title} = 按保单领取计划和官方条款给付`;
  return `${card.title} = 按官方责任卡条款给付`;
}

function calculationStatusFor({ card = {}, treatment = '', calculationEligible = false, basisKey = '', calculationKey = '' } = {}) {
  const explicit = text(card.calculationStatus);
  if (explicit && explicit !== 'needs_review') return explicit;
  if (treatment === 'waiver_only') return 'waiver_only';
  if (['cash_value', 'account_value', 'schedule_or_policy_table', 'medical_formula', 'daily_allowance', 'manual_formula'].includes(calculationKey)) return 'needs_table';
  if (['cash_value', 'account_value', 'schedule_or_policy_table', 'medical_expense', 'daily_allowance'].includes(basisKey)) return 'needs_table';
  if (calculationEligible && treatment === 'scheduled_cashflow') return 'calculable';
  if (treatment === 'claim_contingent') return 'claim_contingent';
  if (treatment === 'not_cashflow') return 'not_cashflow';
  return 'needs_review';
}

export function buildIndicatorFromResponsibilityCard(card = {}, now = new Date().toISOString()) {
  const rejectReason = cardRejectReason(card);
  if (rejectReason) return { indicator: null, rejectReason };

  const liability = normalizeBenefitTitle(card.title);
  const normalizedCard = { ...card, title: liability };
  const coverageType = inferCoverageType(normalizedCard);
  const cashflowTreatment = inferCashflowTreatment(normalizedCard, coverageType);
  const base = {
    id: `ind_card_basic_${sha1([card.company, card.productName, card.title, card.rowId || card.id, VERSION].join('\u001f'))}`,
    company: card.company,
    productName: card.productName,
    coverageType,
    liability,
    originalResponsibilityCardTitle: liability === text(card.title) ? '' : text(card.title),
    triggerCondition: text(normalizedCard.triggerCondition),
    condition: text(normalizedCard.triggerCondition),
    basis: basisTextFor(normalizedCard),
    formulaText: formulaTextFor(normalizedCard, coverageType),
    payoutSummary: text(card.payoutSummary || card.plainSummary || card.sourceExcerpt).slice(0, 600),
    value: card.value ?? null,
    valueText: text(card.valueText),
    unit: firstNonEmpty(card.unit, '公式'),
    cashflowTreatment,
    responsibilityScope: text(card.responsibilityScope || 'basic_or_unspecified'),
    selectionStatus: text(card.selectionStatus),
    selectionEvidence: text(card.selectionEvidence || 'responsibility_card'),
    quantificationStatus: 'basic_indicator',
    extractionMethod: 'responsibility_card_basic_backfill',
    sourceRecordId: text(card.sourceRecordId),
    sourceUrl: text(card.sourceUrl),
    sourceTitle: text(card.sourceTitle),
    sourceExcerpt: text(card.sourceExcerpt).slice(0, 1400),
    sourceEvidenceLevel: 'official_excerpt',
    indicatorCheckStatus: 'basic_from_responsibility_card',
    indicatorCheckSummary: '由已存在责任卡生成的基础指标，供保单责任拆解和大模型动态计算使用。',
    calculationMetadataVersion: VERSION,
    version: VERSION,
    updatedAt: now,
  };
  const calculationFields = indicatorCalculationPayloadFields(base);
  const calculationStatus = calculationStatusFor({
    card,
    treatment: cashflowTreatment,
    calculationEligible: calculationFields.calculationEligible,
    basisKey: calculationFields.basisKey,
    calculationKey: calculationFields.calculationKey,
  });
  return {
    indicator: {
      ...base,
      ...calculationFields,
      calculationStatus,
      calculationReason: text(card.calculationReason) || calculationFields.calculationReason,
    },
    rejectReason: '',
  };
}

function buildFallbackIndicator(product = {}, cards = [], now = new Date().toISOString()) {
  const card = cards.find((item) => item.sourceUrl && item.sourceExcerpt) || cards[0];
  if (!card) return null;
  const coverageType = inferCoverageType(card);
  const base = {
    id: `ind_card_basic_${sha1([product.company, product.productName, 'fallback', VERSION].join('\u001f'))}`,
    company: product.company,
    productName: product.productName,
    coverageType,
    liability: '保险责任基础指标',
    triggerCondition: '',
    condition: '',
    basis: '责任卡官方条款',
    formulaText: `保险责任基础指标 = 需结合责任卡和官方条款由大模型解析；原责任名：${text(card.title) || '未命名责任'}`,
    payoutSummary: text(card.plainSummary || card.payoutSummary || card.sourceExcerpt).slice(0, 600),
    value: null,
    valueText: '',
    unit: '公式',
    cashflowTreatment: 'not_cashflow',
    excludeFromCalculation: true,
    calculationStatus: 'needs_review',
    calculationReason: '现有责任卡标题或责任边界不够干净，已生成基础占位指标供大模型解析，未进入金额计算。',
    responsibilityScope: text(card.responsibilityScope || 'basic_or_unspecified'),
    selectionStatus: text(card.selectionStatus),
    selectionEvidence: text(card.selectionEvidence || 'responsibility_card_fallback'),
    quantificationStatus: 'basic_indicator_needs_llm_parse',
    extractionMethod: 'responsibility_card_basic_backfill',
    sourceRecordId: text(card.sourceRecordId),
    sourceUrl: text(card.sourceUrl),
    sourceTitle: text(card.sourceTitle),
    sourceExcerpt: text(card.sourceExcerpt).slice(0, 1400),
    sourceEvidenceLevel: card.sourceUrl && card.sourceExcerpt ? 'official_excerpt' : 'responsibility_card_excerpt',
    indicatorCheckStatus: 'needs_llm_responsibility_parse',
    indicatorCheckSummary: '现有责任卡不足以稳定拆出具体保险金，保留官方摘录给大模型动态解析。',
    calculationMetadataVersion: VERSION,
    version: VERSION,
    updatedAt: now,
  };
  return {
    ...base,
    ...indicatorCalculationPayloadFields(base),
  };
}

function loadProductSet(db) {
  return db.prepare(`
    SELECT DISTINCT company, product_name
      FROM knowledge_records
     WHERE COALESCE(TRIM(company), '') <> ''
       AND COALESCE(TRIM(product_name), '') <> ''
     ORDER BY company, product_name
  `).all().map((row) => ({ company: text(row.company), productName: text(row.product_name) }));
}

function loadMissingAnyIndicatorProducts(db) {
  return db.prepare(`
    WITH products AS (
      SELECT DISTINCT company, product_name
        FROM knowledge_records
       WHERE COALESCE(TRIM(company), '') <> ''
         AND COALESCE(TRIM(product_name), '') <> ''
    ),
    indicators AS (
      SELECT DISTINCT company, product_name
        FROM insurance_indicator_records
       WHERE COALESCE(TRIM(company), '') <> ''
         AND COALESCE(TRIM(product_name), '') <> ''
    )
    SELECT p.company, p.product_name
      FROM products p
      LEFT JOIN indicators i
        ON i.company = p.company
       AND i.product_name = p.product_name
     WHERE i.product_name IS NULL
     ORDER BY p.company, p.product_name
  `).all().map((row) => ({ company: text(row.company), productName: text(row.product_name) }));
}

function loadExistingVersionIndicatorProducts(db) {
  if (!tableExists(db, 'insurance_indicator_records')) return [];
  return db.prepare(`
    SELECT DISTINCT company, product_name
      FROM insurance_indicator_records
     WHERE COALESCE(TRIM(company), '') <> ''
       AND COALESCE(TRIM(product_name), '') <> ''
       AND json_extract(payload, '$.version') = ?
     ORDER BY company, product_name
  `).all(VERSION).map((row) => ({ company: text(row.company), productName: text(row.product_name) }));
}

function mergeProducts(...productLists) {
  const seen = new Set();
  const merged = [];
  for (const product of productLists.flat()) {
    const key = productKey(product.company, product.productName);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(product);
  }
  return merged;
}

function loadProductListFilter(productListPath = '') {
  const resolvedPath = text(productListPath);
  if (!resolvedPath) return null;
  const rows = JSON.parse(fs.readFileSync(path.resolve(resolvedPath), 'utf8'));
  if (!Array.isArray(rows)) throw new Error('--product-list must be a JSON array');
  return new Set(rows.map((row) => productKey(
    row.company,
    row.productName || row.product_name,
  )).filter((key) => key !== '\u001f'));
}

function loadCardsByProduct(db) {
  if (!tableExists(db, 'product_responsibility_cards')) return new Map();
  const rows = db.prepare(`
    SELECT id, company, product_name, title, category, cashflow_treatment,
           calculation_status, calculation_reason, responsibility_scope,
           selection_status, source_url, payload
      FROM product_responsibility_cards
     WHERE COALESCE(TRIM(company), '') <> ''
       AND COALESCE(TRIM(product_name), '') <> ''
     ORDER BY company, product_name, title, id
  `).all().map(normalizeCardRow);
  const grouped = new Map();
  for (const row of rows) {
    const key = productKey(row.company, row.productName);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function replaceGeneratedIndicatorsForProducts(db, indicators = [], products = [], now = new Date().toISOString()) {
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
  const deleteGenerated = db.prepare(`
    DELETE FROM insurance_indicator_records
     WHERE company = ?
       AND product_name = ?
       AND json_extract(payload, '$.version') = ?
  `);
  db.exec('BEGIN IMMEDIATE');
  let deletedRows = 0;
  try {
    for (const product of products) {
      const result = deleteGenerated.run(product.company, product.productName, VERSION);
      deletedRows += Number(result?.changes || 0);
    }
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
    `).run('basic_indicators_from_responsibility_cards_updated_at', now);
    db.exec('COMMIT');
    return deletedRows;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function loadIndicatorCoverageSummary(db) {
  const products = loadProductSet(db);
  const totalProducts = products.length;
  const productKeys = new Set(products.map((product) => productKey(product.company, product.productName)));
  const cards = tableExists(db, 'product_responsibility_cards')
    ? new Set(db.prepare(`
      SELECT DISTINCT company, product_name
        FROM product_responsibility_cards
       WHERE COALESCE(TRIM(company), '') <> ''
         AND COALESCE(TRIM(product_name), '') <> ''
    `).all().map((row) => productKey(row.company, row.product_name)).filter((key) => productKeys.has(key)))
    : new Set();
  const anyIndicators = new Set();
  const reviewedIndicators = new Set();
  if (tableExists(db, 'insurance_indicator_records')) {
    const rows = db.prepare('SELECT company, product_name, payload FROM insurance_indicator_records').all();
    for (const row of rows) {
      const key = productKey(row.company, row.product_name);
      if (!productKeys.has(key)) continue;
      anyIndicators.add(key);
      const payload = parseJson(row.payload);
      if (
        text(payload.reviewVersion) === REVIEWED_IMPORT_VERSION
        || text(payload.extractionMethod) === 'manual_skill_review'
        || text(payload.indicatorCheckStatus) === 'accepted_manual_review'
      ) {
        reviewedIndicators.add(key);
      }
    }
  }
  return {
    knowledgeProducts: totalProducts,
    productsWithResponsibilityCards: cards.size,
    productsWithAnyIndicators: anyIndicators.size,
    productsWithReviewedIndicators: reviewedIndicators.size,
    productsMissingAnyIndicators: totalProducts - anyIndicators.size,
    productsLegacyOrBasicOnlyIndicators: [...anyIndicators].filter((key) => !reviewedIndicators.has(key)).length,
    productsHaveCardsButMissingAnyIndicators: [...cards].filter((key) => !anyIndicators.has(key)).length,
    note: '缺指标只统计 productsMissingAnyIndicators；旧规则指标或基础指标单独归为 productsLegacyOrBasicOnlyIndicators。',
  };
}

export function buildBasicIndicatorsFromResponsibilityCards({
  dbPath = DEFAULT_DB_PATH,
  write = false,
  sampleLimit = 20,
  allowFallback = true,
  productListPath = '',
  now = new Date().toISOString(),
} = {}) {
  const db = new DatabaseSync(path.resolve(dbPath));
  try {
    const beforeCoverage = loadIndicatorCoverageSummary(db);
    const productListFilter = loadProductListFilter(productListPath);
    const missingProducts = loadMissingAnyIndicatorProducts(db)
      .filter((product) => !productListFilter || productListFilter.has(productKey(product.company, product.productName)));
    const existingVersionProducts = loadExistingVersionIndicatorProducts(db)
      .filter((product) => !productListFilter || productListFilter.has(productKey(product.company, product.productName)));
    const products = mergeProducts(missingProducts, existingVersionProducts);
    const cardsByProduct = loadCardsByProduct(db);
    const indicators = [];
    const productResults = [];
    const rejectReasons = new Map();
    const byCoverageType = new Map();
    const byIndicatorCheckStatus = new Map();
    let productsWithGeneratedIndicators = 0;
    let fallbackIndicators = 0;
    let missingCardProducts = 0;

    for (const product of products) {
      const cards = cardsByProduct.get(productKey(product.company, product.productName)) || [];
      if (!cards.length) {
        missingCardProducts += 1;
        productResults.push({ ...product, cards: 0, indicators: 0, fallback: false, rejectReasons: ['missing_cards'] });
        continue;
      }
      const productIndicators = [];
      const productRejectReasons = [];
      for (const card of cards) {
        const result = buildIndicatorFromResponsibilityCard(card, now);
        if (result.indicator) {
          productIndicators.push(result.indicator);
          continue;
        }
        productRejectReasons.push(result.rejectReason);
        bump(rejectReasons, result.rejectReason);
      }
      let usedFallback = false;
      if (!productIndicators.length && allowFallback) {
        const fallback = buildFallbackIndicator(product, cards, now);
        if (fallback) {
          productIndicators.push(fallback);
          fallbackIndicators += 1;
          usedFallback = true;
        }
      }
      if (productIndicators.length) productsWithGeneratedIndicators += 1;
      for (const indicator of productIndicators) {
        indicators.push(indicator);
        bump(byCoverageType, indicator.coverageType);
        bump(byIndicatorCheckStatus, indicator.indicatorCheckStatus);
      }
      productResults.push({
        ...product,
        cards: cards.length,
        indicators: productIndicators.length,
        fallback: usedFallback,
        rejectReasons: unique(productRejectReasons),
      });
    }

    const changedProductKeys = unique(indicators.flatMap((indicator) => deriveIndicatorProductKeys(indicator)));
    let indicatorUpdateBatchId = '';
    let affectedPolicyCount = 0;
    let prunedGeneratedIndicators = 0;
    if (write && products.length) {
      prunedGeneratedIndicators = replaceGeneratedIndicatorsForProducts(db, indicators, products, now);
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

    const afterCoverage = write ? loadIndicatorCoverageSummary(db) : beforeCoverage;
    return {
      dbPath: path.resolve(dbPath),
      dryRun: !write,
      targetProductsSelected: products.length,
      targetProductsMissingAnyIndicator: missingProducts.length,
      targetProductsWithExistingVersionIndicators: existingVersionProducts.length,
      filters: {
        productListPath: text(productListPath),
        productListProducts: productListFilter ? productListFilter.size : 0,
      },
      targetProductsWithCards: products.length - missingCardProducts,
      productsWithGeneratedIndicators,
      indicatorUpserts: write ? indicators.length : 0,
      prunedGeneratedIndicators,
      candidateIndicators: indicators.length,
      fallbackIndicators,
      changedProductKeyCount: changedProductKeys.length,
      changedProductKeys,
      affectedPolicyCount,
      indicatorUpdateBatchId,
      byCoverageType: sortedObject(byCoverageType),
      byIndicatorCheckStatus: sortedObject(byIndicatorCheckStatus),
      skippedCardReasons: sortedObject(rejectReasons),
      coverageSummary: {
        before: beforeCoverage,
        after: afterCoverage,
      },
      samples: indicators.slice(0, sampleLimit).map((indicator) => ({
        id: indicator.id,
        company: indicator.company,
        productName: indicator.productName,
        coverageType: indicator.coverageType,
        liability: indicator.liability,
        indicatorCheckStatus: indicator.indicatorCheckStatus,
        calculationStatus: indicator.calculationStatus,
        calculationKey: indicator.calculationKey,
        formulaText: indicator.formulaText,
      })),
      productSamples: productResults.slice(0, sampleLimit),
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildBasicIndicatorsFromResponsibilityCards({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    sampleLimit: Number(readArg('sample-limit', 20)) || 20,
    allowFallback: !hasFlag('no-fallback'),
    productListPath: readArg('product-list', ''),
  });
  console.log(JSON.stringify(result, null, 2));
}
