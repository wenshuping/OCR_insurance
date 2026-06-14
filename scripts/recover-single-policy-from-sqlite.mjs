#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';

function usage() {
  console.error(`Usage:
  node scripts/recover-single-policy-from-sqlite.mjs --source <source.sqlite[.gz]> --target <target.sqlite> --policy-id <id> [--apply]

Options:
  --source <path>     Source SQLite database or .sqlite.gz bundle.
  --target <path>     Target SQLite database to patch.
  --policy-id <id>    Policy id to recover from the source database.
  --apply             Write changes. Without this flag the script only reports what it would do.
`);
}

function die(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    source: '',
    target: '',
    policyId: 0,
    apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--source') {
      args.source = argv[++index] || '';
    } else if (arg === '--target') {
      args.target = argv[++index] || '';
    } else if (arg === '--policy-id') {
      args.policyId = Number(argv[++index] || 0);
    } else if (arg === '--apply') {
      args.apply = true;
    } else if (arg === '-h' || arg === '--help') {
      usage();
      process.exit(0);
    } else {
      die(`Unknown option: ${arg}`);
    }
  }
  if (!args.source) die('--source is required');
  if (!args.target) die('--target is required');
  if (!Number.isInteger(args.policyId) || args.policyId <= 0) die('--policy-id must be a positive integer');
  return args;
}

function parseJson(value) {
  try {
    return JSON.parse(String(value || '{}'));
  } catch {
    return {};
  }
}

function prepareSourcePath(sourcePath) {
  if (!fs.existsSync(sourcePath)) die(`source file does not exist: ${sourcePath}`);
  if (!sourcePath.endsWith('.gz')) return { sourceDbPath: sourcePath, cleanup: () => {} };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-recover-'));
  const sourceDbPath = path.join(tempDir, path.basename(sourcePath, '.gz'));
  const compressed = fs.readFileSync(sourcePath);
  fs.writeFileSync(sourceDbPath, zlib.gunzipSync(compressed));
  return {
    sourceDbPath,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name || ''));
}

function rowsBy(db, table, whereSql, params = []) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`SELECT * FROM ${table} WHERE ${whereSql}`).all(...params);
}

function oneBy(db, table, whereSql, params = []) {
  return rowsBy(db, table, whereSql, params)[0] || null;
}

function quoteSqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function rowLabel(row) {
  const payload = parseJson(row?.payload);
  return {
    id: row?.id ?? payload.id ?? '',
    userId: row?.user_id ?? row?.userId ?? payload.userId ?? '',
    mobile: row?.mobile ?? payload.mobile ?? '',
    company: row?.company ?? payload.company ?? '',
    name: row?.name ?? payload.name ?? '',
    insured: row?.insured ?? payload.insured ?? '',
    createdAt: row?.created_at ?? payload.createdAt ?? '',
  };
}

function sameJsonPayload(left, right) {
  return JSON.stringify(parseJson(left?.payload)) === JSON.stringify(parseJson(right?.payload));
}

function assertNoConflict(targetDb, table, sourceRow, primaryColumn) {
  if (!sourceRow) return;
  const existing = oneBy(targetDb, table, `${primaryColumn} = ?`, [sourceRow[primaryColumn]]);
  if (!existing) return;
  if (sameJsonPayload(existing, sourceRow)) return;
  throw new Error(`${table}.${primaryColumn}=${sourceRow[primaryColumn]} already exists with different payload`);
}

function insertRow(db, table, row) {
  const columns = tableColumns(db, table).filter((column) => Object.hasOwn(row, column));
  if (!columns.length) throw new Error(`No insertable columns found for ${table}`);
  const placeholders = columns.map(() => '?').join(', ');
  const quotedColumns = columns.map((column) => `"${column}"`).join(', ');
  const values = columns.map((column) => row[column]);
  db.prepare(`INSERT OR IGNORE INTO ${table} (${quotedColumns}) VALUES (${placeholders})`).run(...values);
}

function copyRows(db, table, rows, primaryColumn) {
  if (!tableExists(db, table) || !rows.length) return { table, inserted: 0, skipped: rows.length };
  let inserted = 0;
  let skipped = 0;
  for (const row of rows) {
    const before = primaryColumn
      ? oneBy(db, table, `${primaryColumn} = ?`, [row[primaryColumn]])
      : null;
    insertRow(db, table, row);
    const after = primaryColumn
      ? oneBy(db, table, `${primaryColumn} = ?`, [row[primaryColumn]])
      : null;
    if (!before && after) inserted += 1;
    else skipped += 1;
  }
  return { table, inserted, skipped };
}

function maxId(db, table) {
  if (!tableExists(db, table)) return 0;
  if (!tableColumns(db, table).includes('id')) return 0;
  return Number(db.prepare(`SELECT max(id) AS value FROM ${table}`).get()?.value || 0);
}

function updateNextId(db) {
  if (!tableExists(db, 'app_meta')) return;
  const value = Math.max(
    maxId(db, 'users'),
    maxId(db, 'policies'),
    maxId(db, 'source_records'),
    maxId(db, 'family_profiles'),
    maxId(db, 'family_members'),
    maxId(db, 'family_report_shares'),
    maxId(db, 'membership_orders'),
    0,
  ) + 1;
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES ('next_id', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(String(value));
  db.prepare(`
    INSERT INTO app_meta (key, value)
    VALUES ('updated_at', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(new Date().toISOString());
}

function backupTarget(db, targetPath) {
  const backupPath = `${targetPath}.before-policy-recover-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  db.exec('PRAGMA wal_checkpoint(FULL)');
  db.exec(`VACUUM INTO ${quoteSqlLiteral(backupPath)}`);
  return backupPath;
}

function buildRecoveryPlan(sourceDb, targetDb, policyId) {
  const policy = oneBy(sourceDb, 'policies', 'id = ?', [policyId]);
  if (!policy) die(`policy id ${policyId} was not found in source`);
  const policyPayload = parseJson(policy.payload);
  const userId = Number(policy.user_id || policyPayload.userId || 0);
  const familyId = Number(policyPayload.familyId || 0);
  const applicantMemberId = Number(policyPayload.applicantMemberId || 0);
  const insuredMemberId = Number(policyPayload.insuredMemberId || 0);
  const familyMemberIds = [...new Set([applicantMemberId, insuredMemberId].filter(Boolean))];

  const user = userId ? oneBy(sourceDb, 'users', 'id = ?', [userId]) : null;
  const familyProfiles = familyId
    ? rowsBy(sourceDb, 'family_profiles', 'id = ?', [familyId])
    : rowsBy(sourceDb, 'family_profiles', 'owner_user_id = ?', [userId]);
  const familyIds = [...new Set(familyProfiles.map((row) => Number(row.id || 0)).filter(Boolean))];
  const familyMembers = familyIds.length
    ? rowsBy(sourceDb, 'family_members', `family_id IN (${familyIds.map(() => '?').join(',')})`, familyIds)
    : familyMemberIds.length
      ? rowsBy(sourceDb, 'family_members', `id IN (${familyMemberIds.map(() => '?').join(',')})`, familyMemberIds)
      : [];

  const rows = {
    users: user ? [user] : [],
    family_profiles: familyProfiles,
    family_members: familyMembers,
    policies: [policy],
    source_records: rowsBy(sourceDb, 'source_records', 'policy_id = ?', [policyId]),
    policy_cashflows: rowsBy(sourceDb, 'policy_cashflows', 'policy_id = ?', [policyId]),
    policy_cash_values: rowsBy(sourceDb, 'policy_cash_values', 'policy_id = ?', [policyId]),
  };

  for (const row of rows.users) assertNoConflict(targetDb, 'users', row, 'id');
  for (const row of rows.family_profiles) assertNoConflict(targetDb, 'family_profiles', row, 'id');
  for (const row of rows.family_members) assertNoConflict(targetDb, 'family_members', row, 'id');
  for (const row of rows.policies) assertNoConflict(targetDb, 'policies', row, 'id');
  for (const row of rows.source_records) assertNoConflict(targetDb, 'source_records', row, 'id');
  for (const row of rows.policy_cashflows) assertNoConflict(targetDb, 'policy_cashflows', row, 'id');
  for (const row of rows.policy_cash_values) assertNoConflict(targetDb, 'policy_cash_values', row, 'id');

  return {
    summary: {
      policy: rowLabel(policy),
      user: user ? rowLabel(user) : null,
      rowCounts: Object.fromEntries(Object.entries(rows).map(([table, tableRows]) => [table, tableRows.length])),
    },
    rows,
  };
}

const args = parseArgs(process.argv.slice(2));
const prepared = prepareSourcePath(args.source);

try {
  if (!fs.existsSync(args.target)) die(`target file does not exist: ${args.target}`);
  const sourceDb = new DatabaseSync(prepared.sourceDbPath, { readOnly: true });
  const targetDb = new DatabaseSync(args.target);
  try {
    const plan = buildRecoveryPlan(sourceDb, targetDb, args.policyId);
    if (!args.apply) {
      console.log(JSON.stringify({ dryRun: true, ...plan.summary }, null, 2));
      process.exit(0);
    }

    const backupPath = backupTarget(targetDb, args.target);
    const results = [];
    targetDb.exec('BEGIN IMMEDIATE');
    try {
      results.push(copyRows(targetDb, 'users', plan.rows.users, 'id'));
      results.push(copyRows(targetDb, 'family_profiles', plan.rows.family_profiles, 'id'));
      results.push(copyRows(targetDb, 'family_members', plan.rows.family_members, 'id'));
      results.push(copyRows(targetDb, 'policies', plan.rows.policies, 'id'));
      results.push(copyRows(targetDb, 'source_records', plan.rows.source_records, 'id'));
      results.push(copyRows(targetDb, 'policy_cashflows', plan.rows.policy_cashflows, 'id'));
      results.push(copyRows(targetDb, 'policy_cash_values', plan.rows.policy_cash_values, 'id'));
      updateNextId(targetDb);
      targetDb.exec('COMMIT');
    } catch (error) {
      targetDb.exec('ROLLBACK');
      throw error;
    }

    console.log(JSON.stringify({
      dryRun: false,
      backupPath,
      ...plan.summary,
      results,
    }, null, 2));
  } finally {
    sourceDb.close();
    targetDb.close();
  }
} finally {
  prepared.cleanup();
}
