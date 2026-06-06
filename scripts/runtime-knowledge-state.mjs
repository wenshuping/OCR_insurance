import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const defaultRuntimeDir = path.join(projectRoot, '.runtime');

function trim(value) {
  return String(value || '').trim();
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getMeta(db, key) {
  return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value || '';
}

function setMeta(db, key, value) {
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value ?? ''));
}

function loadKnowledgeRecords(db) {
  return db.prepare('SELECT payload FROM knowledge_records ORDER BY id ASC').all().map((row) => parseJson(row.payload, {}));
}

function loadStateDocument(db, key, fallback = null) {
  const row = db.prepare('SELECT payload FROM state_documents WHERE key = ?').get(trim(key));
  return row ? parseJson(row.payload, fallback) : fallback;
}

function maxKnowledgeId(rows = []) {
  return (Array.isArray(rows) ? rows : []).reduce((max, row) => {
    const id = Number(row?.id || 0);
    return Number.isFinite(id) ? Math.max(max, id) : max;
  }, 0);
}

function resolveNextId(db, rows = loadKnowledgeRecords(db)) {
  const nextId = Number(getMeta(db, 'next_id') || 0);
  return Math.max(nextId || 1, maxKnowledgeId(rows) + 1, 1);
}

function upsertKnowledgeRows(db, rows = [], { nextId } = {}) {
  const upsert = db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      product_name = excluded.product_name,
      url = excluded.url,
      payload = excluded.payload
  `);

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number(row?.id || 0);
      if (!Number.isFinite(id) || id <= 0) continue;
      upsert.run(
        id,
        trim(row.company),
        trim(row.productName),
        trim(row.url),
        JSON.stringify(row || {}),
      );
    }
    if (Number.isFinite(Number(nextId)) && Number(nextId) > 0) {
      setMeta(db, 'next_id', String(nextId));
    }
    setMeta(db, 'updated_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function writeStateDocument(db, key, value) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO state_documents (key, payload)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET payload = excluded.payload
    `).run(trim(key), JSON.stringify(value ?? null));
    setMeta(db, 'updated_at', new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function createKnowledgeStateStore({
  dbPath = process.env.POLICY_OCR_APP_DB_PATH || path.join(defaultRuntimeDir, 'policy-ocr.sqlite'),
  seedStatePath = process.env.POLICY_OCR_APP_STATE_PATH || path.join(defaultRuntimeDir, 'state.json'),
} = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedSeedStatePath = path.resolve(seedStatePath);
  const runtimeStore = await createSqliteStateStore({
    dbPath: resolvedDbPath,
    seedStatePath: resolvedSeedStatePath,
  });
  await runtimeStore.load();
  const db = runtimeStore.db;

  function loadState() {
    const knowledgeRecords = loadKnowledgeRecords(db);
    return {
      knowledgeRecords,
      nextId: resolveNextId(db, knowledgeRecords),
    };
  }

  function saveState(state = {}) {
    const currentRows = loadKnowledgeRecords(db);
    const currentById = new Map(currentRows.map((row) => [String(row.id), JSON.stringify(row)]));
    const nextRows = Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : [];
    const nextIds = new Set(nextRows.map((row) => String(row?.id || '')));
    const deletedIds = currentRows
      .map((row) => String(row?.id || ''))
      .filter((id) => id && !nextIds.has(id));
    if (deletedIds.length) {
      throw new Error(`Knowledge state save does not support deletions (${deletedIds.length} rows)`);
    }

    const changedRows = nextRows.filter((row) => {
      const id = String(row?.id || '');
      if (!id) return false;
      return currentById.get(id) !== JSON.stringify(row);
    });
    const nextId = Math.max(Number(state.nextId || 0), resolveNextId(db, currentRows));
    if (!changedRows.length && nextId === resolveNextId(db, currentRows)) return { changed: 0, nextId };

    upsertKnowledgeRows(db, changedRows, { nextId });
    return {
      changed: changedRows.length,
      nextId,
    };
  }

  function countKnowledgeRecords() {
    return Number(db.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get()?.count || 0);
  }

  function upsertRows(rows = [], { nextId } = {}) {
    const nextRows = Array.isArray(rows) ? rows : [];
    const validRows = nextRows.filter((row) => Number(row?.id || 0) > 0);
    const resolvedNextId = Number.isFinite(Number(nextId)) && Number(nextId) > 0
      ? Math.max(Number(nextId), resolveNextId(db))
      : resolveNextId(db);
    if (!validRows.length) {
      return {
        changed: 0,
        nextId: resolvedNextId,
      };
    }
    upsertKnowledgeRows(db, validRows, { nextId: resolvedNextId });
    return {
      changed: validRows.length,
      nextId: resolvedNextId,
    };
  }

  function allKnownUrls() {
    return db
      .prepare("SELECT url FROM knowledge_records WHERE TRIM(COALESCE(url, '')) <> '' ORDER BY id ASC")
      .all()
      .map((row) => trim(row.url))
      .filter(Boolean);
  }

  function knownCompanyUrls(company = '') {
    return db
      .prepare("SELECT url FROM knowledge_records WHERE company = ? AND TRIM(COALESCE(url, '')) <> '' ORDER BY id ASC")
      .all(trim(company))
      .map((row) => trim(row.url))
      .filter(Boolean);
  }

  function knownCompanyProductNames(company = '') {
    return db
      .prepare("SELECT DISTINCT product_name FROM knowledge_records WHERE company = ? AND TRIM(COALESCE(product_name, '')) <> '' ORDER BY product_name ASC")
      .all(trim(company))
      .map((row) => trim(row.product_name))
      .filter(Boolean);
  }

  function close() {
    runtimeStore.close();
  }

  return {
    db,
    dbPath: resolvedDbPath,
    seedStatePath: resolvedSeedStatePath,
    loadState,
    saveState,
    countKnowledgeRecords,
    upsertRows,
    allKnownUrls,
    knownCompanyUrls,
    knownCompanyProductNames,
    readStateDocument(key, fallback = null) {
      return loadStateDocument(db, key, fallback);
    },
    writeStateDocument(key, value) {
      return writeStateDocument(db, key, value);
    },
    close,
  };
}
