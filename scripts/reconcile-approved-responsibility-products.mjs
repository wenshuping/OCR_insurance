import fs from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

import { replaceApprovedArtifactRowsInDevelopmentDb } from '../.agents/skills/ocr-insurance-product-responsibility-pipeline/scripts/publish_development_artifact.mjs';
import { responsibilityProductIdentity } from '../server/product-responsibility-identity.mjs';

const projectRoot = path.resolve(import.meta.dirname, '..');
const defaultDbPath = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');

function text(value) {
  return String(value || '').trim();
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(text(value) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assertDevelopmentDbPath(value) {
  const resolved = path.resolve(value);
  const allowedRoot = `${path.join(projectRoot, '.runtime', 'local')}${path.sep}`;
  if (!resolved.startsWith(allowedRoot)) throw new Error(`refusing non-development database path: ${resolved}`);
  if (!fs.existsSync(resolved)) throw new Error(`development database does not exist: ${resolved}`);
  return resolved;
}

function latestApprovedArtifacts(db) {
  const latest = new Map();
  const rows = db.prepare(`
    SELECT company, product_name, published_at, payload
    FROM product_responsibility_artifacts
    WHERE json_extract(payload, '$.audit.status') = 'approved'
    ORDER BY published_at DESC, id DESC
  `).all();
  for (const row of rows) {
    const artifact = parseJson(row.payload);
    const identity = responsibilityProductIdentity({
      company: artifact.company || row.company,
      productName: artifact.productName || row.product_name,
    });
    if (!identity || latest.has(identity.productKey)) continue;
    latest.set(identity.productKey, artifact);
  }
  return [...latest.values()];
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function preloadReplacementLookup(db) {
  const canonicalProductRows = tableExists(db, 'insurance_products')
    ? db.prepare(`SELECT canonical_product_id, company, official_name
        FROM insurance_products
        WHERE trim(COALESCE(canonical_product_id, '')) != ''`).all()
    : [];
  const canonicalProductLookup = new Map();
  for (const row of canonicalProductRows) {
    const identity = responsibilityProductIdentity({ company: row.company, productName: row.official_name });
    if (!identity) continue;
    if (!canonicalProductLookup.has(identity.productKey)) canonicalProductLookup.set(identity.productKey, new Set());
    canonicalProductLookup.get(identity.productKey).add(text(row.canonical_product_id));
  }
  const equivalentProductLookup = new Map();
  for (const table of [
    'insurance_indicator_records',
    'product_responsibility_cards',
    'optional_responsibility_records',
    'product_responsibility_artifacts',
    'product_customer_responsibility_summaries',
  ]) {
    if (!tableExists(db, table)) continue;
    const rows = db.prepare(`SELECT DISTINCT company, product_name FROM ${table}`).all();
    for (const row of rows) {
      const company = text(row.company);
      const productName = text(row.product_name);
      const identity = responsibilityProductIdentity({ company, productName });
      if (!identity) continue;
      if (!equivalentProductLookup.has(identity.productKey)) equivalentProductLookup.set(identity.productKey, []);
      equivalentProductLookup.get(identity.productKey).push({ table, company, productName });
    }
  }
  return { canonicalProductLookup, equivalentProductLookup };
}

const dbPath = assertDevelopmentDbPath(readArg('db-path', defaultDbPath));
const write = process.argv.includes('--write');
const db = new DatabaseSync(dbPath);
const artifacts = latestApprovedArtifacts(db);

if (!write) {
  console.log(JSON.stringify({ dryRun: true, dbPath, approvedProducts: artifacts.length }, null, 2));
  db.close();
  process.exit(0);
}

const now = new Date().toISOString();
const backupDir = path.join(projectRoot, 'artifacts', 'development-db-backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupPath = path.join(backupDir, `policy-ocr-before-approved-responsibility-reconcile-${now.replace(/[:.]/gu, '-')}.sqlite`);
await backup(db, backupPath);
const lookup = preloadReplacementLookup(db);

const replacedRows = { indicators: 0, cards: 0, optional: 0, artifacts: 0, customerSummaries: 0 };
const insertedRows = { indicators: 0, cards: 0, optional: 0, artifacts: 0 };
let completed = 0;
try {
  for (const artifact of artifacts) {
    const result = replaceApprovedArtifactRowsInDevelopmentDb({ db, artifact, now, lookup });
    for (const key of Object.keys(replacedRows)) replacedRows[key] += Number(result.previous[key] || 0);
    insertedRows.indicators += result.built.indicatorRows.length;
    insertedRows.cards += result.built.cardRows.length;
    insertedRows.optional += result.built.optionalRows.length;
    insertedRows.artifacts += 1;
    completed += 1;
    if (completed % 25 === 0) console.error(`reconciled ${completed}/${artifacts.length}`);
  }
} catch (error) {
  error.message = `${error.message}; database backup: ${backupPath}`;
  throw error;
} finally {
  db.close();
}

console.log(JSON.stringify({
  dryRun: false,
  dbPath,
  backupPath,
  approvedProducts: artifacts.length,
  completed,
  replacedRows,
  insertedRows,
}, null, 2));
