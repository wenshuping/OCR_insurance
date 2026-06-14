#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'policy-ocr.sqlite');
const DEFAULT_OUT_DIR = path.join(projectRoot, '.runtime', 'production-data-bundles');
const DEFAULT_TARGET_DB_PATH = process.env.POLICY_OCR_APP_DB_PATH || '/data/policy-ocr.sqlite';
const BUNDLE_FORMAT = 'policy-ocr-production-sqlite-bundle-v1';
const KNOWLEDGE_TABLES = [
  'knowledge_records',
  'insurance_indicator_records',
  'optional_responsibility_records',
  'official_domain_profiles',
  'indicator_definitions',
];
const KNOWLEDGE_STATE_DOCUMENT_KEYS = ['insuranceIndicatorSnapshot'];
const PROTECTED_TABLE_KEYS = {
  users: ['id'],
  sessions: ['token'],
  admin_sessions: ['token'],
  sms_codes: ['id'],
  policies: ['id'],
  pending_scans: ['guest_id'],
  source_records: ['id'],
  policy_cashflows: ['id'],
  policy_cash_values: ['id'],
  family_profiles: ['id'],
  family_members: ['id'],
  family_report_shares: ['id'],
  membership_config: ['id'],
  membership_orders: ['id'],
  memberships: ['user_id'],
  user_wechat_identities: ['user_id', 'app_id'],
  wechat_oauth_states: ['state'],
};
const CORE_TABLES = [
  'users',
  'policies',
  'family_profiles',
  'family_members',
  'family_report_shares',
  'knowledge_records',
  'insurance_indicator_records',
  'optional_responsibility_records',
  'official_domain_profiles',
  'source_records',
  'policy_cashflows',
  'policy_cash_values',
  'indicator_definitions',
  'pending_scans',
  'state_documents',
];
const NON_EMPTY_GUARD_TABLES = CORE_TABLES.filter((table) => table !== 'state_documents');

function timestampSlug(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
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

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => String(row.name || ''))
    .filter(Boolean);
}

function countTable(db, table) {
  try {
    return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0);
  } catch {
    return null;
  }
}

function hasTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(db, table) {
  if (!hasTable(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name || ''));
}

function countTables(db) {
  const tables = tableNames(db);
  const counts = {};
  for (const table of tables) counts[table] = countTable(db, table);
  for (const table of CORE_TABLES) {
    if (!Object.prototype.hasOwnProperty.call(counts, table)) counts[table] = null;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function coreCounts(counts) {
  const result = {};
  for (const table of CORE_TABLES) result[table] = counts[table] ?? 0;
  return result;
}

function nonEmptyGuardTotal(counts) {
  return NON_EMPTY_GUARD_TABLES.reduce((sum, table) => sum + Number(counts[table] || 0), 0);
}

async function fileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

async function gzipFile(sourcePath, targetPath) {
  await pipeline(createReadStream(sourcePath), createGzip({ level: 9 }), createWriteStream(targetPath));
}

async function gunzipFile(sourcePath, targetPath) {
  await pipeline(createReadStream(sourcePath), createGunzip(), createWriteStream(targetPath));
}

async function readJsonIfExists(filePath) {
  if (!filePath || !existsSync(filePath)) return null;
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

function defaultManifestPath(bundlePath) {
  if (bundlePath.endsWith('.sqlite.gz')) return bundlePath.replace(/\.sqlite\.gz$/u, '.manifest.json');
  return `${bundlePath}.manifest.json`;
}

async function validateBundleFile({ resolvedBundlePath, resolvedManifestPath }) {
  if (!existsSync(resolvedBundlePath)) throw new Error(`Bundle not found: ${resolvedBundlePath}`);

  const manifest = await readJsonIfExists(resolvedManifestPath);
  if (manifest?.format && manifest.format !== BUNDLE_FORMAT) {
    throw new Error(`Unsupported bundle manifest format: ${manifest.format}`);
  }
  if (manifest?.bundleSha256) {
    const actualSha = await fileSha256(resolvedBundlePath);
    if (actualSha !== manifest.bundleSha256) {
      throw new Error(`Bundle SHA mismatch: expected ${manifest.bundleSha256}, got ${actualSha}`);
    }
  }
  return manifest;
}

function protectedKeyExpression(keyColumns) {
  if (keyColumns.length === 1) return keyColumns[0];
  return keyColumns.map((column) => `COALESCE(CAST(${column} AS TEXT), '')`).join(" || '\u0001' || ");
}

function readProtectedKeys(db, table, keyColumns) {
  if (!hasTable(db, table)) return new Set();
  const columns = new Set(tableColumns(db, table));
  if (!keyColumns.every((column) => columns.has(column))) return new Set();
  const expression = protectedKeyExpression(keyColumns);
  return new Set(
    db.prepare(`SELECT ${expression} AS key_value FROM ${table}`).all()
      .map((row) => String(row.key_value || ''))
      .filter(Boolean),
  );
}

function buildUserDataLossReport({ currentDbPath, incomingDbPath }) {
  if (!existsSync(currentDbPath) || !existsSync(incomingDbPath)) return { wouldRemoveRows: [] };
  const currentDb = new DatabaseSync(currentDbPath, { readOnly: true });
  const incomingDb = new DatabaseSync(incomingDbPath, { readOnly: true });
  try {
    const wouldRemoveRows = [];
    for (const [table, keyColumns] of Object.entries(PROTECTED_TABLE_KEYS)) {
      const currentKeys = readProtectedKeys(currentDb, table, keyColumns);
      if (!currentKeys.size) continue;
      const incomingKeys = readProtectedKeys(incomingDb, table, keyColumns);
      const removed = [...currentKeys].filter((key) => !incomingKeys.has(key)).sort();
      if (removed.length) {
        wouldRemoveRows.push({
          table,
          keyColumns,
          count: removed.length,
          sampleKeys: removed.slice(0, 20),
        });
      }
    }
    return { wouldRemoveRows };
  } finally {
    currentDb.close();
    incomingDb.close();
  }
}

function insertRowsFromSource({ sourceDb, targetDb, table }) {
  if (!hasTable(sourceDb, table) || !hasTable(targetDb, table)) {
    return { table, copied: 0, skipped: true };
  }
  const sourceColumns = tableColumns(sourceDb, table);
  const targetColumnSet = new Set(tableColumns(targetDb, table));
  const columns = sourceColumns.filter((column) => targetColumnSet.has(column));
  if (!columns.length) return { table, copied: 0, skipped: true };

  targetDb.prepare(`DELETE FROM ${table}`).run();
  const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const insert = targetDb.prepare(`INSERT INTO ${table} (${quotedColumns}) VALUES (${placeholders})`);
  const rows = sourceDb.prepare(`SELECT ${quotedColumns} FROM ${table}`).all();
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
  return { table, copied: rows.length, skipped: false };
}

function replaceSelectedStateDocuments({ sourceDb, targetDb, keys }) {
  if (!hasTable(sourceDb, 'state_documents') || !hasTable(targetDb, 'state_documents')) {
    return { table: 'state_documents', copied: 0, keys: [], skipped: true };
  }
  const select = sourceDb.prepare('SELECT key, payload FROM state_documents WHERE key = ?');
  const remove = targetDb.prepare('DELETE FROM state_documents WHERE key = ?');
  const insert = targetDb.prepare('INSERT INTO state_documents (key, payload) VALUES (?, ?)');
  let copied = 0;
  const copiedKeys = [];
  for (const key of keys) {
    remove.run(key);
    const row = select.get(key);
    if (!row) continue;
    insert.run(row.key, row.payload);
    copied += 1;
    copiedKeys.push(key);
  }
  return { table: 'state_documents', copied, keys: copiedKeys, skipped: false };
}

export function summarizeSqliteDatabase(dbPath) {
  const resolvedDbPath = path.resolve(dbPath);
  if (!existsSync(resolvedDbPath)) {
    return {
      dbPath: resolvedDbPath,
      exists: false,
      bytes: 0,
      integrity: '',
      counts: {},
      coreCounts: {},
      nonEmptyGuardTotal: 0,
    };
  }
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    const counts = countTables(db);
    const integrity = String(db.prepare('PRAGMA integrity_check').get()?.integrity_check || '');
    return {
      dbPath: resolvedDbPath,
      exists: true,
      bytes: statSync(resolvedDbPath).size,
      integrity,
      counts,
      coreCounts: coreCounts(counts),
      nonEmptyGuardTotal: nonEmptyGuardTotal(counts),
    };
  } finally {
    db.close();
  }
}

export async function createProductionDataBundle({
  dbPath = DEFAULT_DB_PATH,
  outDir = DEFAULT_OUT_DIR,
  name = `policy-ocr-production-data-${timestampSlug()}`,
} = {}) {
  const resolvedDbPath = path.resolve(dbPath);
  const resolvedOutDir = path.resolve(outDir);
  if (!existsSync(resolvedDbPath)) throw new Error(`Database not found: ${resolvedDbPath}`);
  await fs.mkdir(resolvedOutDir, { recursive: true });

  const snapshotPath = path.join(resolvedOutDir, `${name}.sqlite`);
  const bundlePath = `${snapshotPath}.gz`;
  const manifestPath = path.join(resolvedOutDir, `${name}.manifest.json`);
  await fs.rm(snapshotPath, { force: true });
  await fs.rm(bundlePath, { force: true });
  await fs.rm(manifestPath, { force: true });

  const sourceSummary = summarizeSqliteDatabase(resolvedDbPath);
  const sourceDb = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    sourceDb.exec(`VACUUM INTO ${sqlString(snapshotPath)}`);
  } finally {
    sourceDb.close();
  }

  const snapshotSummary = summarizeSqliteDatabase(snapshotPath);
  const uncompressedSha256 = await fileSha256(snapshotPath);
  await gzipFile(snapshotPath, bundlePath);
  const bundleSha256 = await fileSha256(bundlePath);
  const manifest = {
    format: BUNDLE_FORMAT,
    createdAt: new Date().toISOString(),
    sourceDbPath: resolvedDbPath,
    bundlePath,
    sqliteBytes: statSync(snapshotPath).size,
    bundleBytes: statSync(bundlePath).size,
    sqliteSha256: uncompressedSha256,
    bundleSha256,
    source: sourceSummary,
    snapshot: snapshotSummary,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await fs.rm(snapshotPath, { force: true });
  return { ...manifest, manifestPath };
}

async function backupSqliteFiles(targetDbPath, backupDir) {
  const stamp = timestampSlug();
  const backupRunDir = path.join(path.resolve(backupDir), `policy-ocr-before-data-install-${stamp}`);
  await fs.mkdir(backupRunDir, { recursive: true });
  const copied = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${targetDbPath}${suffix}`;
    if (!existsSync(source)) continue;
    const target = path.join(backupRunDir, `${path.basename(targetDbPath)}${suffix}`);
    await fs.copyFile(source, target);
    copied.push(target);
  }
  return { backupDir: backupRunDir, copied };
}

async function removeSqliteFiles(targetDbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${targetDbPath}${suffix}`, { force: true });
  }
}

export async function installProductionDataBundle({
  bundlePath,
  manifestPath = '',
  targetDbPath = DEFAULT_TARGET_DB_PATH,
  backupDir = '',
  replaceNonEmpty = false,
  allowUserDataLoss = false,
} = {}) {
  if (!bundlePath) throw new Error('bundlePath is required');
  const resolvedBundlePath = path.resolve(bundlePath);
  const resolvedTargetDbPath = path.resolve(targetDbPath);
  const resolvedManifestPath = path.resolve(manifestPath || defaultManifestPath(resolvedBundlePath));
  const resolvedBackupDir = path.resolve(backupDir || path.join(path.dirname(resolvedTargetDbPath), 'backups'));
  const manifest = await validateBundleFile({ resolvedBundlePath, resolvedManifestPath });

  const before = summarizeSqliteDatabase(resolvedTargetDbPath);
  if (before.nonEmptyGuardTotal > 0 && !replaceNonEmpty) {
    throw new Error(
      `Refusing to replace non-empty production database (${before.nonEmptyGuardTotal} rows). `
      + 'Pass --replace-non-empty only after taking a backup and confirming this is intentional.',
    );
  }

  await fs.mkdir(path.dirname(resolvedTargetDbPath), { recursive: true });
  const backup = await backupSqliteFiles(resolvedTargetDbPath, resolvedBackupDir);
  const tmpDbPath = `${resolvedTargetDbPath}.installing-${Date.now()}`;
  await fs.rm(tmpDbPath, { force: true });
  try {
    await gunzipFile(resolvedBundlePath, tmpDbPath);
    const installedSummary = summarizeSqliteDatabase(tmpDbPath);
    if (installedSummary.integrity !== 'ok') {
      throw new Error(`Installed database integrity check failed: ${installedSummary.integrity}`);
    }
    if (manifest?.snapshot?.coreCounts) {
      for (const [table, expected] of Object.entries(manifest.snapshot.coreCounts)) {
        const actual = installedSummary.coreCounts[table] ?? 0;
        if (Number(expected || 0) !== Number(actual || 0)) {
          throw new Error(`Installed table count mismatch for ${table}: expected ${expected}, got ${actual}`);
        }
      }
    }
    const userDataLossReport = buildUserDataLossReport({
      currentDbPath: resolvedTargetDbPath,
      incomingDbPath: tmpDbPath,
    });
    if (userDataLossReport.wouldRemoveRows.length && !allowUserDataLoss) {
      throw new Error(
        'Refusing full database install because it would remove protected production rows: '
        + JSON.stringify(userDataLossReport.wouldRemoveRows),
      );
    }
    await removeSqliteFiles(resolvedTargetDbPath);
    await fs.rename(tmpDbPath, resolvedTargetDbPath);
    return {
      ok: true,
      bundlePath: resolvedBundlePath,
      manifestPath: existsSync(resolvedManifestPath) ? resolvedManifestPath : '',
      targetDbPath: resolvedTargetDbPath,
      backup,
      userDataLossReport,
      before,
      after: summarizeSqliteDatabase(resolvedTargetDbPath),
    };
  } catch (error) {
    await fs.rm(tmpDbPath, { force: true });
    throw error;
  }
}

export async function installKnowledgeDataBundle({
  bundlePath,
  manifestPath = '',
  targetDbPath = DEFAULT_TARGET_DB_PATH,
  backupDir = '',
} = {}) {
  if (!bundlePath) throw new Error('bundlePath is required');
  const resolvedBundlePath = path.resolve(bundlePath);
  const resolvedTargetDbPath = path.resolve(targetDbPath);
  const resolvedManifestPath = path.resolve(manifestPath || defaultManifestPath(resolvedBundlePath));
  const resolvedBackupDir = path.resolve(backupDir || path.join(path.dirname(resolvedTargetDbPath), 'backups'));
  await validateBundleFile({ resolvedBundlePath, resolvedManifestPath });
  if (!existsSync(resolvedTargetDbPath)) throw new Error(`Target database not found: ${resolvedTargetDbPath}`);

  const before = summarizeSqliteDatabase(resolvedTargetDbPath);
  const tmpDbPath = `${resolvedTargetDbPath}.knowledge-installing-${Date.now()}`;
  await fs.rm(tmpDbPath, { force: true });
  try {
    await gunzipFile(resolvedBundlePath, tmpDbPath);
    const sourceSummary = summarizeSqliteDatabase(tmpDbPath);
    if (sourceSummary.integrity !== 'ok') {
      throw new Error(`Source database integrity check failed: ${sourceSummary.integrity}`);
    }

    const backup = await backupSqliteFiles(resolvedTargetDbPath, resolvedBackupDir);
    const sourceDb = new DatabaseSync(tmpDbPath, { readOnly: true });
    const targetDb = new DatabaseSync(resolvedTargetDbPath);
    try {
      const tableResults = [];
      targetDb.exec('BEGIN IMMEDIATE');
      try {
        for (const table of KNOWLEDGE_TABLES) {
          tableResults.push(insertRowsFromSource({ sourceDb, targetDb, table }));
        }
        tableResults.push(replaceSelectedStateDocuments({
          sourceDb,
          targetDb,
          keys: KNOWLEDGE_STATE_DOCUMENT_KEYS,
        }));
        targetDb.exec(`
          INSERT INTO app_meta (key, value)
          VALUES ('updated_at', ${sqlString(new Date().toISOString())})
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `);
        targetDb.exec('COMMIT');
      } catch (error) {
        targetDb.exec('ROLLBACK');
        throw error;
      }
      return {
        ok: true,
        mode: 'knowledge',
        bundlePath: resolvedBundlePath,
        manifestPath: existsSync(resolvedManifestPath) ? resolvedManifestPath : '',
        targetDbPath: resolvedTargetDbPath,
        backup,
        tables: tableResults,
        before,
        after: summarizeSqliteDatabase(resolvedTargetDbPath),
      };
    } finally {
      sourceDb.close();
      targetDb.close();
    }
  } finally {
    await fs.rm(tmpDbPath, { force: true });
  }
}

function printUsageAndExit() {
  console.error(`Usage:
  node scripts/production-data-bundle.mjs export [--db-path <path>] [--out-dir <dir>] [--name <name>]
  node scripts/production-data-bundle.mjs inspect --db-path <path>
  node scripts/production-data-bundle.mjs install-knowledge --bundle <path> [--manifest <path>] [--target-db <path>] [--backup-dir <dir>]
  node scripts/production-data-bundle.mjs install --bundle <path> [--manifest <path>] [--target-db <path>] [--backup-dir <dir>] [--replace-non-empty] [--allow-user-data-loss]
`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2] || '';
  try {
    if (command === 'export') {
      const result = await createProductionDataBundle({
        dbPath: readArg('db-path', DEFAULT_DB_PATH),
        outDir: readArg('out-dir', DEFAULT_OUT_DIR),
        name: readArg('name', `policy-ocr-production-data-${timestampSlug()}`),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'inspect') {
      const dbPath = readArg('db-path');
      if (!dbPath) printUsageAndExit();
      console.log(JSON.stringify(summarizeSqliteDatabase(dbPath), null, 2));
    } else if (command === 'install-knowledge') {
      const bundlePath = readArg('bundle');
      if (!bundlePath) printUsageAndExit();
      const result = await installKnowledgeDataBundle({
        bundlePath,
        manifestPath: readArg('manifest', ''),
        targetDbPath: readArg('target-db', DEFAULT_TARGET_DB_PATH),
        backupDir: readArg('backup-dir', ''),
      });
      console.log(JSON.stringify(result, null, 2));
    } else if (command === 'install') {
      const bundlePath = readArg('bundle');
      if (!bundlePath) printUsageAndExit();
      const result = await installProductionDataBundle({
        bundlePath,
        manifestPath: readArg('manifest', ''),
        targetDbPath: readArg('target-db', DEFAULT_TARGET_DB_PATH),
        backupDir: readArg('backup-dir', ''),
        replaceNonEmpty: hasFlag('replace-non-empty'),
        allowUserDataLoss: hasFlag('allow-user-data-loss'),
      });
      console.log(JSON.stringify(result, null, 2));
    } else {
      printUsageAndExit();
    }
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
