import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import {
  RESPONSIBILITY_CARD_INDICATOR_CHECK_VERSION,
  buildResponsibilityCardsForPolicy,
  indicatorCheckForResponsibilityCard,
} from '../server/responsibility-card-standardizer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = process.env.POLICY_OCR_APP_DB_PATH || path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');

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

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function ensureProductResponsibilityCardTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
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
    CREATE INDEX IF NOT EXISTS idx_product_responsibility_cards_product_key ON product_responsibility_cards(product_key);
    CREATE INDEX IF NOT EXISTS idx_product_responsibility_cards_company_product ON product_responsibility_cards(company, product_name);
    CREATE INDEX IF NOT EXISTS idx_product_responsibility_cards_status ON product_responsibility_cards(calculation_status);
  `);
}

function normalizeKnowledgeRow(row = {}) {
  const payload = parseJson(row.payload);
  return {
    ...payload,
    id: payload.id ?? row.id,
    company: text(payload.company || row.company),
    productName: text(payload.productName || payload.product_name || payload.name || row.product_name),
    url: text(payload.url || row.url),
  };
}

function normalizeIndicatorRow(row = {}) {
  const payload = parseJson(row.payload);
  return {
    ...payload,
    id: text(payload.id || row.id),
    company: text(payload.company || row.company),
    productName: text(payload.productName || payload.product_name || row.product_name),
    coverageType: text(payload.coverageType || payload.coverage_type || row.coverage_type),
    liability: text(payload.liability || row.liability),
  };
}

function normalizeOptionalResponsibilityRow(row = {}) {
  const payload = parseJson(row.payload);
  return {
    ...payload,
    id: text(payload.id || row.id),
    company: text(payload.company || row.company),
    productName: text(payload.productName || payload.product_name || row.product_name),
    liability: text(payload.liability || row.liability),
  };
}

function productKeyFor(company, productName) {
  const resolvedCompany = text(company);
  const resolvedProductName = text(productName);
  if (!resolvedCompany || !resolvedProductName) return '';
  return `company_product:${resolvedCompany}:${resolvedProductName}`;
}

function productMapKey(company, productName) {
  return `${text(company)}\u001f${text(productName)}`;
}

function addProduct(products, company, productName) {
  const resolvedCompany = text(company);
  const resolvedProductName = text(productName);
  if (!resolvedCompany || !resolvedProductName) return;
  products.set(productMapKey(resolvedCompany, resolvedProductName), {
    company: resolvedCompany,
    productName: resolvedProductName,
  });
}

function groupByProduct(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const key = productMapKey(row.company, row.productName);
    if (!text(row.company) || !text(row.productName)) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  return grouped;
}

function loadProductCounts(db, tableName) {
  if (!tableExists(db, tableName)) return new Map();
  return new Map(db.prepare(`
    SELECT company, product_name, COUNT(*) AS count
      FROM ${tableName}
     WHERE COALESCE(TRIM(company), '') <> ''
       AND COALESCE(TRIM(product_name), '') <> ''
     GROUP BY company, product_name
  `).all().map((row) => [productMapKey(row.company, row.product_name), Number(row.count || 0)]));
}

function loadProductListFilter(productListPath = '') {
  const resolvedPath = text(productListPath);
  if (!resolvedPath) return null;
  const rows = JSON.parse(fs.readFileSync(path.resolve(resolvedPath), 'utf8'));
  if (!Array.isArray(rows)) throw new Error('--product-list must be a JSON array');
  return new Set(rows.map((row) => productMapKey(
    row.company,
    row.productName || row.product_name,
  )).filter((key) => key !== '\u001f'));
}

function loadSourceRows(db) {
  const knowledgeRows = tableExists(db, 'knowledge_records')
    ? db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records ORDER BY id ASC').all().map(normalizeKnowledgeRow)
    : [];
  const indicatorRows = tableExists(db, 'insurance_indicator_records')
    ? db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records ORDER BY product_name ASC, coverage_type ASC, liability ASC, id ASC').all().map(normalizeIndicatorRow)
    : [];
  const optionalRows = tableExists(db, 'optional_responsibility_records')
    ? db.prepare('SELECT id, company, product_name, liability, payload FROM optional_responsibility_records ORDER BY product_name ASC, liability ASC, id ASC').all().map(normalizeOptionalResponsibilityRow)
    : [];
  return { knowledgeRows, indicatorRows, optionalRows };
}

function selectProducts({ knowledgeRows, indicatorRows, optionalRows }, { company = '', productName = '', limit = 0 } = {}) {
  const products = new Map();
  for (const row of [...knowledgeRows, ...indicatorRows, ...optionalRows]) addProduct(products, row.company, row.productName);
  const companyFilter = text(company);
  const productFilter = text(productName);
  const selected = [...products.values()]
    .filter((product) => !companyFilter || product.company === companyFilter)
    .filter((product) => !productFilter || product.productName === productFilter)
    .sort((left, right) => `${left.company}\u001f${left.productName}`.localeCompare(`${right.company}\u001f${right.productName}`, 'zh-Hans-CN'));
  return limit > 0 ? selected.slice(0, limit) : selected;
}

function bump(map, key) {
  const resolvedKey = text(key) || 'unknown';
  map.set(resolvedKey, (map.get(resolvedKey) || 0) + 1);
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')));
}

function materializedCardRow({ card, product, productKey, index, now }) {
  const titleKey = compact(card.title) || '保险责任';
  const id = `product_responsibility_card:${productKey}:${String(index).padStart(4, '0')}:${titleKey}`;
  const indicatorCheck = indicatorCheckForResponsibilityCard(card);
  return {
    id,
    productKey,
    company: text(card.company || product.company),
    productName: text(card.productName || product.productName),
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
      indicatorCheckVersion: RESPONSIBILITY_CARD_INDICATOR_CHECK_VERSION,
    },
  };
}

function insertRowsForProduct(db, { productKey, rows }) {
  const existingCount = tableExists(db, 'product_responsibility_cards')
    ? Number(db.prepare('SELECT COUNT(*) AS count FROM product_responsibility_cards WHERE product_key = ?').get(productKey)?.count || 0)
    : 0;
  db.prepare('DELETE FROM product_responsibility_cards WHERE product_key = ?').run(productKey);
  const insert = db.prepare(`
    INSERT INTO product_responsibility_cards (
      id,
      product_key,
      company,
      product_name,
      title,
      category,
      cashflow_treatment,
      calculation_status,
      calculation_reason,
      responsibility_scope,
      selection_status,
      source_url,
      generated_at,
      updated_at,
      payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    insert.run(
      row.id,
      row.productKey,
      row.company,
      row.productName,
      row.title,
      row.category,
      row.cashflowTreatment,
      row.calculationStatus,
      row.calculationReason,
      row.responsibilityScope,
      row.selectionStatus,
      row.sourceUrl,
      row.generatedAt,
      row.updatedAt,
      JSON.stringify(row.payload),
    );
  }
  return {
    deletedRows: existingCount,
    insertedRows: rows.length,
  };
}

export function materializeProductResponsibilityCards({
  dbPath = DEFAULT_DB_PATH,
  write = false,
  company = '',
  productName = '',
  limit = 0,
  sampleLimit = 12,
  onlyMissingCards = false,
  requireIndicators = false,
  productListPath = '',
  now = new Date().toISOString(),
} = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const db = new DatabaseSync(resolvedDbPath);
  try {
    const sourceRows = loadSourceRows(db);
    const knowledgeByProduct = groupByProduct(sourceRows.knowledgeRows);
    const indicatorsByProduct = groupByProduct(sourceRows.indicatorRows);
    const optionalByProduct = groupByProduct(sourceRows.optionalRows);
    const cardCountsByProduct = onlyMissingCards ? loadProductCounts(db, 'product_responsibility_cards') : new Map();
    const productListFilter = loadProductListFilter(productListPath);
    const products = selectProducts(sourceRows, { company, productName, limit })
      .filter((product) => !productListFilter || productListFilter.has(productMapKey(product.company, product.productName)))
      .filter((product) => !onlyMissingCards || !cardCountsByProduct.get(productMapKey(product.company, product.productName)))
      .filter((product) => !requireIndicators || (indicatorsByProduct.get(productMapKey(product.company, product.productName)) || []).length > 0);
    const byCalculationStatus = new Map();
    const byCashflowTreatment = new Map();
    const byResponsibilityScope = new Map();
    const byIndicatorCheckStatus = new Map();
    const byIndicatorCheckIssue = new Map();
    const samples = [];
    let productsWithCards = 0;
    let cardsGenerated = 0;
    let deletedRows = 0;
    let insertedRows = 0;

    const productResults = products.map((product) => {
      const key = productMapKey(product.company, product.productName);
      const knowledgeRecords = knowledgeByProduct.get(key) || [];
      const coverageIndicators = indicatorsByProduct.get(key) || [];
      const optionalResponsibilityRecords = optionalByProduct.get(key) || [];
      const productKey = productKeyFor(product.company, product.productName);
      const cards = buildResponsibilityCardsForPolicy({
        policy: {
          company: product.company,
          productName: product.productName,
          name: product.productName,
        },
        knowledgeRecords,
        coverageIndicators,
        optionalResponsibilityRecords,
      });
      const rows = cards.map((card, index) => materializedCardRow({ card, product, productKey, index, now }));
      if (rows.length) productsWithCards += 1;
      cardsGenerated += rows.length;
      for (const row of rows) {
        bump(byCalculationStatus, row.calculationStatus);
        bump(byCashflowTreatment, row.cashflowTreatment);
        bump(byResponsibilityScope, row.responsibilityScope || 'basic_or_unspecified');
        bump(byIndicatorCheckStatus, row.payload.indicatorCheckStatus);
        for (const issue of row.payload.indicatorCheckIssues || []) bump(byIndicatorCheckIssue, issue);
      }
      if (samples.length < sampleLimit) {
        samples.push({
          company: product.company,
          productName: product.productName,
          productKey,
          knowledgeRecords: knowledgeRecords.length,
          indicators: coverageIndicators.length,
          optionalResponsibilities: optionalResponsibilityRecords.length,
          cardCount: rows.length,
          cards: rows.slice(0, 8).map((row) => ({
            title: row.title,
            category: row.category,
            cashflowTreatment: row.cashflowTreatment,
            calculationStatus: row.calculationStatus,
            indicatorCheckStatus: row.payload.indicatorCheckStatus,
            indicatorCheckIssues: row.payload.indicatorCheckIssues,
            indicatorCount: Array.isArray(row.payload.indicators) ? row.payload.indicators.length : 0,
          })),
        });
      }
      return { productKey, rows };
    });

    if (write) {
      ensureProductResponsibilityCardTable(db);
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const result of productResults) {
          const writeResult = insertRowsForProduct(db, result);
          deletedRows += writeResult.deletedRows;
          insertedRows += writeResult.insertedRows;
        }
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
    }

    return {
      dbPath: resolvedDbPath,
      dryRun: !write,
      company: text(company) || 'all',
      productName: text(productName) || 'all',
      limit: Number(limit) || 0,
      filters: {
        onlyMissingCards: Boolean(onlyMissingCards),
        requireIndicators: Boolean(requireIndicators),
        productListPath: text(productListPath),
        productListProducts: productListFilter ? productListFilter.size : 0,
      },
      sourceCounts: {
        knowledgeRows: sourceRows.knowledgeRows.length,
        indicatorRows: sourceRows.indicatorRows.length,
        optionalRows: sourceRows.optionalRows.length,
      },
      selectedProducts: products.length,
      productsWithCards,
      productsWithoutCards: products.length - productsWithCards,
      cardsGenerated,
      deletedRows: write ? deletedRows : 0,
      insertedRows: write ? insertedRows : 0,
      byCalculationStatus: sortedObject(byCalculationStatus),
      byCashflowTreatment: sortedObject(byCashflowTreatment),
      byResponsibilityScope: sortedObject(byResponsibilityScope),
      byIndicatorCheckStatus: sortedObject(byIndicatorCheckStatus),
      byIndicatorCheckIssue: sortedObject(byIndicatorCheckIssue),
      samples,
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = materializeProductResponsibilityCards({
    dbPath: readArg('db-path', DEFAULT_DB_PATH),
    write: hasFlag('write'),
    company: readArg('company', ''),
    productName: readArg('product', readArg('product-name', '')),
    limit: Number(readArg('limit', 0)) || 0,
    sampleLimit: Number(readArg('sample-limit', 12)) || 12,
    onlyMissingCards: hasFlag('only-missing-cards'),
    requireIndicators: hasFlag('require-indicators'),
    productListPath: readArg('product-list', ''),
  });
  console.log(JSON.stringify(result, null, 2));
}
