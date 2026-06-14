import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_STATE_PATH = path.join(projectRoot, '.runtime', 'state.json');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');

function trim(value) {
  return String(value ?? '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
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

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function knowledgeKey(row = {}) {
  return [
    trim(row.company),
    trim(row.productName || row.product_name || row.productNameNormalized || row.product_name_normalized || row.title),
    trim(row.url),
  ].join('\u001f');
}

function loadExistingKnowledge(db) {
  const rows = db.prepare('SELECT id, company, product_name, url FROM knowledge_records').all();
  return {
    rows,
    byId: new Map(rows.map((row) => [trim(row.id), row])),
    keys: new Set(rows.map((row) => knowledgeKey(row))),
    maxId: rows.reduce((max, row) => Math.max(max, Number(row.id || 0) || 0), 0),
  };
}

function existingSet(db, table, column) {
  return new Set(db.prepare(`SELECT ${column} AS id FROM ${table}`).all().map((row) => trim(row.id)));
}

function filterCompanies(rows, companies) {
  if (!companies.length) return rows;
  const wanted = new Set(companies);
  return rows.filter((row) => wanted.has(trim(row?.company)));
}

function upsertMissingRows(db, { state, companies = [], write = false }) {
  ensureTables(db);
  const knowledgeRows = filterCompanies(normalizeArray(state.knowledgeRecords), companies)
    .filter((row) => Number(row?.id || 0) > 0);
  const indicatorRows = filterCompanies(normalizeArray(state.insuranceIndicatorRecords), companies)
    .filter((row) => trim(row?.id));
  const existingKnowledge = loadExistingKnowledge(db);
  const existingIndicatorIds = existingSet(db, 'insurance_indicator_records', 'id');
  let nextKnowledgeId = Math.max(existingKnowledge.maxId + 1, Number(state.nextId || 0) || 0, 1);
  let idCollisionRows = 0;
  let duplicateKnowledgeRows = 0;
  const missingKnowledgeRows = [];
  const pendingKeys = new Set();
  for (const row of knowledgeRows) {
    const sourceId = trim(row.id);
    const key = knowledgeKey(row);
    if (existingKnowledge.keys.has(key) || pendingKeys.has(key)) {
      duplicateKnowledgeRows += 1;
      continue;
    }
    const existingById = existingKnowledge.byId.get(sourceId);
    if (!existingById) {
      missingKnowledgeRows.push(row);
      pendingKeys.add(key);
      continue;
    }
    if (knowledgeKey(existingById) === key) {
      duplicateKnowledgeRows += 1;
      continue;
    }
    idCollisionRows += 1;
    missingKnowledgeRows.push({
      ...row,
      id: nextKnowledgeId,
      originalStateId: row.id,
    });
    pendingKeys.add(key);
    nextKnowledgeId += 1;
  }
  const missingIndicatorRows = indicatorRows.filter((row) => !existingIndicatorIds.has(trim(row.id)));

  if (write && (missingKnowledgeRows.length || missingIndicatorRows.length)) {
    const insertKnowledge = db.prepare(`
      INSERT INTO knowledge_records (id, company, product_name, url, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertIndicator = db.prepare(`
      INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    db.exec('BEGIN IMMEDIATE');
    try {
    for (const row of missingKnowledgeRows) {
        insertKnowledge.run(
          Number(row.id),
          trim(row.company),
          trim(row.productName || row.product_name || row.title),
          trim(row.url),
          JSON.stringify(row || {}),
        );
      }
      for (const row of missingIndicatorRows) {
        insertIndicator.run(
          trim(row.id),
          trim(row.company),
          trim(row.productName || row.product_name),
          trim(row.coverageType || row.coverage_type),
          trim(row.liability),
          JSON.stringify(row || {}),
        );
      }
      db.prepare(`
        INSERT INTO app_meta (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run('state_json_knowledge_indicators_synced_at', new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return {
    stateKnowledgeRows: knowledgeRows.length,
    missingKnowledgeRows: missingKnowledgeRows.length,
    existingKnowledgeRows: knowledgeRows.length - missingKnowledgeRows.length,
    duplicateKnowledgeRows,
    idCollisionRows,
    stateIndicatorRows: indicatorRows.length,
    missingIndicatorRows: missingIndicatorRows.length,
    existingIndicatorRows: indicatorRows.length - missingIndicatorRows.length,
    samples: missingKnowledgeRows.slice(0, 12).map((row) => ({
      id: row.id,
      company: row.company,
      productName: row.productName || row.product_name || row.title,
    })),
  };
}

export function syncStateKnowledgeIndicatorsToSqlite({
  statePath = DEFAULT_STATE_PATH,
  dbPath = DEFAULT_DB_PATH,
  write = false,
  companies = [],
} = {}) {
  const state = readState(statePath);
  const db = new DatabaseSync(dbPath);
  try {
    const result = upsertMissingRows(db, { state, companies, write });
    return {
      statePath,
      dbPath,
      dryRun: !write,
      companies,
      ...result,
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
  const result = syncStateKnowledgeIndicatorsToSqlite({
    statePath: path.resolve(readArg('state-path', DEFAULT_STATE_PATH)),
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    write: hasFlag('write'),
    companies,
  });
  console.log(JSON.stringify(result, null, 2));
}
