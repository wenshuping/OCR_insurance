import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_OLD_DB_PATH = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');
const DEFAULT_DEV_DB_PATH = process.env.POLICY_OCR_APP_DB_PATH || path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-29-old-runtime-extra-products-migration';

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

function sha1(value, length = 24) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function productKey(company, productName) {
  return `${text(company)}\u001f${text(productName)}`;
}

function tableExists(db, tableName) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName));
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_records (
      id INTEGER PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_company ON knowledge_records(company);
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_product_name ON knowledge_records(product_name);
    CREATE INDEX IF NOT EXISTS idx_knowledge_records_url ON knowledge_records(url);

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
  `);
}

function loadDevProductNames(db) {
  return new Set(db.prepare(`
    SELECT DISTINCT TRIM(product_name) AS product_name
      FROM knowledge_records
     WHERE COALESCE(TRIM(product_name), '') <> ''
  `).all().map((row) => text(row.product_name)));
}

function loadOldProducts(oldDb, devProductNames, includedProductNames = new Set()) {
  const rows = oldDb.prepare(`
    SELECT TRIM(company) AS company,
           TRIM(product_name) AS product_name,
           COUNT(*) AS knowledge_rows,
           SUM(CASE WHEN COALESCE(TRIM(json_extract(payload, '$.pageText')), '') <> '' THEN 1 ELSE 0 END) AS rows_with_page_text
      FROM knowledge_records
     WHERE COALESCE(TRIM(company), '') <> ''
       AND COALESCE(TRIM(product_name), '') <> ''
     GROUP BY TRIM(company), TRIM(product_name)
     ORDER BY TRIM(company), TRIM(product_name)
  `).all();
  return rows
    .map((row) => ({
      company: text(row.company),
      productName: text(row.product_name),
      knowledgeRows: Number(row.knowledge_rows || 0),
      rowsWithPageText: Number(row.rows_with_page_text || 0),
    }))
    .filter((row) => !devProductNames.has(row.productName))
    .filter((row) => !includedProductNames.size || includedProductNames.has(row.productName));
}

function loadKnowledgeRows(oldDb, targetKeys) {
  return oldDb.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE COALESCE(TRIM(company), '') <> ''
       AND COALESCE(TRIM(product_name), '') <> ''
     ORDER BY id
  `).all().filter((row) => targetKeys.has(productKey(row.company, row.product_name)));
}

function loadIndicatorRows(oldDb, targetKeys) {
  if (!tableExists(oldDb, 'insurance_indicator_records')) return [];
  return oldDb.prepare(`
    SELECT id, company, product_name, coverage_type, liability, payload
      FROM insurance_indicator_records
     WHERE COALESCE(TRIM(company), '') <> ''
       AND COALESCE(TRIM(product_name), '') <> ''
     ORDER BY product_name, coverage_type, liability, id
  `).all().filter((row) => targetKeys.has(productKey(row.company, row.product_name)));
}

function migratedKnowledgePayload(row, newId, now, oldDbPath) {
  const payload = parseJson(row.payload, {});
  return JSON.stringify({
    ...payload,
    id: newId,
    company: text(payload.company || row.company),
    productName: text(payload.productName || payload.product_name || row.product_name),
    url: text(payload.url || row.url),
    originalKnowledgeRecordId: row.id,
    migratedFromDb: path.resolve(oldDbPath),
    migrationVersion: VERSION,
    migratedAt: now,
  });
}

function migratedIndicator(row, now, oldDbPath) {
  const payload = parseJson(row.payload, {});
  const id = `ind_old_extra_${sha1([
    row.id,
    row.company,
    row.product_name,
    row.coverage_type,
    row.liability,
    VERSION,
  ].join('\u001f'))}`;
  const company = text(payload.company || row.company);
  const productName = text(payload.productName || payload.product_name || row.product_name);
  const coverageType = text(payload.coverageType || payload.coverage_type || row.coverage_type);
  const liability = text(payload.liability || row.liability);
  return {
    id,
    company,
    productName,
    coverageType,
    liability,
    payload: JSON.stringify({
      ...payload,
      id,
      company,
      productName,
      coverageType,
      liability,
      originalIndicatorRecordId: text(row.id),
      migratedFromDb: path.resolve(oldDbPath),
      migrationVersion: VERSION,
      migratedAt: now,
    }),
  };
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')));
}

function countByCompany(products) {
  const counts = new Map();
  for (const product of products) counts.set(product.company, (counts.get(product.company) || 0) + 1);
  return sortedObject(counts);
}

export function migrateOldRuntimeExtraProductsToDev({
  oldDbPath = DEFAULT_OLD_DB_PATH,
  devDbPath = DEFAULT_DEV_DB_PATH,
  write = false,
  backupPath = '',
  productNames = [],
  now = new Date().toISOString(),
} = {}) {
  const resolvedOldDbPath = path.resolve(oldDbPath);
  const resolvedDevDbPath = path.resolve(devDbPath);
  const oldDb = new DatabaseSync(resolvedOldDbPath, { readOnly: true });
  const devDb = new DatabaseSync(resolvedDevDbPath);
  try {
    ensureTables(devDb);
    const devProductNames = loadDevProductNames(devDb);
    const includedProductNames = new Set((Array.isArray(productNames) ? productNames : [productNames]).map(text).filter(Boolean));
    const targetProducts = loadOldProducts(oldDb, devProductNames, includedProductNames);
    const targetKeys = new Set(targetProducts.map((row) => productKey(row.company, row.productName)));
    const knowledgeRows = loadKnowledgeRows(oldDb, targetKeys);
    const indicatorRows = loadIndicatorRows(oldDb, targetKeys);
    const maxDevId = Number(devDb.prepare('SELECT COALESCE(MAX(id), 0) AS max_id FROM knowledge_records').get().max_id || 0);
    const productsWithOldIndicators = new Set(indicatorRows.map((row) => productKey(row.company, row.product_name)));
    const knowledgeRowsWithPageText = knowledgeRows.filter((row) => text(parseJson(row.payload).pageText)).length;

    let insertedKnowledgeRows = 0;
    let insertedIndicatorRows = 0;
    let backupCreated = '';

    if (write && targetProducts.length) {
      if (backupPath) {
        const resolvedBackupPath = path.resolve(backupPath);
        fs.mkdirSync(path.dirname(resolvedBackupPath), { recursive: true });
        if (fs.existsSync(resolvedBackupPath)) fs.rmSync(resolvedBackupPath);
        devDb.exec(`VACUUM INTO '${resolvedBackupPath.replaceAll("'", "''")}'`);
        backupCreated = resolvedBackupPath;
      }

      const insertKnowledge = devDb.prepare(`
        INSERT INTO knowledge_records (id, company, product_name, url, payload)
        VALUES (?, ?, ?, ?, ?)
      `);
      const insertIndicator = devDb.prepare(`
        INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      devDb.exec('BEGIN IMMEDIATE');
      try {
        let nextId = maxDevId + 1;
        for (const row of knowledgeRows) {
          const newId = nextId;
          nextId += 1;
          insertKnowledge.run(
            newId,
            text(row.company),
            text(row.product_name),
            text(row.url),
            migratedKnowledgePayload(row, newId, now, resolvedOldDbPath),
          );
          insertedKnowledgeRows += 1;
        }
        for (const row of indicatorRows) {
          const migrated = migratedIndicator(row, now, resolvedOldDbPath);
          insertIndicator.run(
            migrated.id,
            migrated.company,
            migrated.productName,
            migrated.coverageType,
            migrated.liability,
            migrated.payload,
          );
          insertedIndicatorRows += 1;
        }
        devDb.exec('COMMIT');
      } catch (error) {
        devDb.exec('ROLLBACK');
        throw error;
      }
    }

    return {
      oldDbPath: resolvedOldDbPath,
      devDbPath: resolvedDevDbPath,
      dryRun: !write,
      migrationVersion: VERSION,
      selectedProducts: targetProducts.length,
      selectedProductsWithOldIndicators: productsWithOldIndicators.size,
      selectedProductsMissingOldIndicators: targetProducts.length - productsWithOldIndicators.size,
      selectedKnowledgeRows: knowledgeRows.length,
      selectedKnowledgeRowsWithPageText: knowledgeRowsWithPageText,
      selectedIndicatorRows: indicatorRows.length,
      maxDevKnowledgeIdBefore: maxDevId,
      nextKnowledgeIdStart: targetProducts.length ? maxDevId + 1 : 0,
      nextKnowledgeIdEnd: targetProducts.length ? maxDevId + knowledgeRows.length : 0,
      insertedKnowledgeRows,
      insertedIndicatorRows,
      backupPath: backupCreated,
      byCompany: countByCompany(targetProducts),
      samples: targetProducts.slice(0, 12),
    };
  } finally {
    oldDb.close();
    devDb.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = migrateOldRuntimeExtraProductsToDev({
    oldDbPath: readArg('old-db-path', DEFAULT_OLD_DB_PATH),
    devDbPath: readArg('dev-db-path', DEFAULT_DEV_DB_PATH),
    write: hasFlag('write'),
    backupPath: readArg('backup-path', ''),
    productNames: [readArg('product-name', '')].filter(Boolean),
  });
  console.log(JSON.stringify(result, null, 2));
}
