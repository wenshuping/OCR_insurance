import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');
const VERSION = '2026-05-30-payout-method';

function trim(value) {
  return String(value ?? '').trim();
}

function normalizeSpaces(value) {
  return trim(value).replace(/\s+/gu, '');
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

export function inferPayoutMethods({ productName = '', productType = '', text = '' } = {}) {
  const haystack = normalizeSpaces([productName, productType, text].join('\n'));
  const methods = [];
  const add = (method) => {
    if (!methods.includes(method)) methods.push(method);
  };

  const hasReimbursement = /(?:医疗费用|实际费用|合理且必要.*费用|符合.*医疗保险.*费用|赔付比例|免赔额|给付比例|补偿|报销|按.*费用.*给付|扣除.{0,30}(?:补偿|赔偿|报销))/u.test(haystack);
  const hasAllowance = /(?:津贴|日额|每日|每天|按日|住院日数|给付日数|给付天数|护理天数|元\/日|元每日)/u.test(haystack);
  const hasFixedPayment = /(?:身故|全残|伤残|重大疾病|重疾|中症|轻症|特定疾病|恶性肿瘤|癌症|护理保险金|年金|生存金|满期|祝寿金|养老金|教育金|保险金额|基本保险金额|有效保险金额|已交保险费|实际交纳的保险费|现金价值|给付系数|给付倍数)/u.test(haystack);

  if (hasFixedPayment) add('定额给付型');
  if (hasReimbursement) add('费用报销型');
  if (hasAllowance) add('津贴给付型');

  return methods;
}

export function buildPayoutMethodIndicator(product, now = new Date().toISOString()) {
  const company = trim(product.company);
  const productName = trim(product.productName);
  const productType = trim(product.productType);
  const sourceText = trim(product.sourceText || product.text);
  const methods = inferPayoutMethods({ productName, productType, text: sourceText });
  if (!methods.length) return null;
  const valueText = methods.join('+');
  const evidence = sourceText.slice(0, 900);
  return {
    id: `ind_payout_method_${sha1(`${company}\u001f${productName}`)}`,
    version: VERSION,
    rowNumber: 0,
    company,
    productName,
    productType,
    salesStatus: trim(product.salesStatus),
    coverageType: '规则参数',
    liability: '赔付方式',
    value: null,
    valueText,
    unit: '方式',
    basis: '保险责任赔付机制',
    formulaText: '',
    condition: methods.length > 1 ? '该产品包含多类赔付机制' : '',
    quantificationStatus: 'not_quantifiable',
    calculationEligible: false,
    excludeFromCalculation: true,
    responsibilityScope: 'rule_parameter',
    qualityStatus: 'non_calculable_rule_parameter',
    qualityReason: '赔付方式是保险责任机制说明，不作为可计算保险金指标',
    extractionMethod: '规则推断',
    sourceRecordId: trim(product.sourceRecordId),
    sourceUrl: trim(product.sourceUrl),
    sourceExcerpt: evidence,
    updatedAt: now,
  };
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function collectProducts(db) {
  const products = new Map();
  const keyOf = (company, productName) => `${trim(company)}\u001f${trim(productName)}`;
  const ensure = (company, productName) => {
    const key = keyOf(company, productName);
    if (!trim(productName)) return null;
    if (!products.has(key)) {
      products.set(key, {
        company: trim(company),
        productName: trim(productName),
        productType: '',
        salesStatus: '',
        sourceRecordId: '',
        sourceUrl: '',
        sourceTextParts: [],
      });
    }
    return products.get(key);
  };

  for (const row of db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records').all()) {
    const payload = parseJson(row.payload);
    const product = ensure(payload.company || row.company, payload.productName || row.product_name);
    if (!product) continue;
    product.productType ||= trim(payload.productType);
    product.salesStatus ||= trim(payload.salesStatus);
    product.sourceRecordId ||= String(payload.id || row.id || '');
    product.sourceUrl ||= trim(payload.url || row.url);
    product.sourceTextParts.push([
      payload.title,
      payload.snippet,
      payload.pageText,
      payload.responsibility,
      payload.analysis?.report,
      ...(Array.isArray(payload.analysis?.coverageTable)
        ? payload.analysis.coverageTable.map((item) => [item.coverageType, item.scenario, item.payout, item.note].join(' '))
        : []),
    ].filter(Boolean).join('\n'));
  }

  for (const row of db.prepare('SELECT company, product_name, payload FROM insurance_indicator_records').all()) {
    const payload = parseJson(row.payload);
    const product = ensure(payload.company || row.company, payload.productName || row.product_name);
    if (!product) continue;
    product.productType ||= trim(payload.productType);
    product.salesStatus ||= trim(payload.salesStatus);
    product.sourceRecordId ||= trim(payload.sourceRecordId);
    product.sourceUrl ||= trim(payload.sourceUrl);
    product.sourceTextParts.push([
      payload.coverageType,
      payload.liability,
      payload.valueText,
      payload.unit,
      payload.basis,
      payload.formulaText,
      payload.condition,
      payload.sourceExcerpt,
    ].filter(Boolean).join(' '));
  }

  return [...products.values()].map((product) => ({
    ...product,
    sourceText: product.sourceTextParts.join('\n').slice(0, 8000),
  }));
}

function upsertRecords(db, records) {
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
    for (const record of records) {
      insert.run(record.id, record.company, record.productName, record.coverageType, record.liability, JSON.stringify(record));
    }
    db.prepare(`
      INSERT INTO app_meta (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run('payout_method_indicators_updated_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function backfillPayoutMethodIndicators({ dbPath = DEFAULT_DB_PATH, dryRun = false } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    const products = collectProducts(db);
    const records = products
      .map((product) => buildPayoutMethodIndicator(product, now))
      .filter(Boolean);
    if (!dryRun) upsertRecords(db, records);
    const byMethod = {};
    for (const record of records) {
      byMethod[record.valueText] = (byMethod[record.valueText] || 0) + 1;
    }
    return { dbPath, dryRun, productCount: products.length, recordCount: records.length, byMethod };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = backfillPayoutMethodIndicators({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    dryRun: hasFlag('dry-run'),
  });
  console.log(`[payout-method] ${result.dryRun ? 'dry-run ' : ''}覆盖产品 ${result.productCount} 个，写入/更新指标 ${result.recordCount} 条`);
  console.log(JSON.stringify(result.byMethod, null, 2));
}
