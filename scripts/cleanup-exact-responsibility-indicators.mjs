import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || fallback : fallback;
}

function readArgs(name) {
  const prefix = `--${name}=`;
  return process.argv.flatMap((arg, index) => {
    if (arg.startsWith(prefix)) return [arg.slice(prefix.length)];
    return arg === `--${name}` && process.argv[index + 1] ? [process.argv[index + 1]] : [];
  });
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function text(value) {
  return String(value ?? '').trim();
}

function sqlString(value) {
  return `'${text(value).replaceAll("'", "''")}'`;
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readPayload(value) {
  try {
    return JSON.parse(value || '{}');
  } catch {
    return {};
  }
}

function readIndicators(db, { company, productName }) {
  return db.prepare(`
    SELECT id, liability, payload
      FROM insurance_indicator_records
     WHERE company = ? AND product_name = ?
     ORDER BY id
  `).all(company, productName).map((row) => {
    const payload = readPayload(row.payload);
    return {
      id: text(row.id),
      liability: text(row.liability),
      sourceUrl: text(payload.sourceUrl),
      sourceDigest: text(payload.sourceDigest),
    };
  });
}

function buildPlan({ company, productName, expectedSourceUrl, expectedLiabilities, removeIds }) {
  const issues = [];
  if (!company) issues.push('company_required');
  if (!productName) issues.push('product_name_required');
  if (!expectedSourceUrl) issues.push('expected_source_url_required');
  if (!expectedLiabilities.length) issues.push('expected_remaining_liability_required');
  if (!removeIds.length) issues.push('remove_indicator_id_required');
  if (new Set(removeIds).size !== removeIds.length) issues.push('duplicate_remove_indicator_id');
  return { issues, company, productName, expectedSourceUrl, expectedLiabilities, removeIds };
}

function validateSnapshot({ indicators, plan }) {
  const issues = [];
  const byId = new Map(indicators.map((indicator) => [indicator.id, indicator]));
  const candidates = plan.removeIds.map((id) => byId.get(id)).filter(Boolean);
  for (const id of plan.removeIds) {
    const indicator = byId.get(id);
    if (!indicator) {
      issues.push(`remove_indicator_missing:${id}`);
      continue;
    }
    if (!indicator.sourceUrl || indicator.sourceUrl === plan.expectedSourceUrl) {
      issues.push(`remove_indicator_source_not_conflicting:${id}`);
    }
    if (indicator.sourceDigest) issues.push(`remove_indicator_has_source_digest:${id}`);
  }
  const candidateIds = new Set(plan.removeIds);
  const retained = indicators.filter((indicator) => !candidateIds.has(indicator.id));
  const retainedLiabilities = retained.map((indicator) => indicator.liability).sort();
  const expectedLiabilities = [...plan.expectedLiabilities].sort();
  if (JSON.stringify(retainedLiabilities) !== JSON.stringify(expectedLiabilities)) {
    issues.push(`remaining_liabilities_mismatch:${retainedLiabilities.join('|')}:${expectedLiabilities.join('|')}`);
  }
  for (const indicator of retained) {
    if (indicator.sourceUrl !== plan.expectedSourceUrl) {
      issues.push(`remaining_indicator_source_url_mismatch:${indicator.id}`);
    }
  }
  if (indicators.length !== plan.removeIds.length + plan.expectedLiabilities.length) {
    issues.push(`indicator_count_mismatch:${indicators.length}:${plan.removeIds.length + plan.expectedLiabilities.length}`);
  }
  return { issues, candidates, retained };
}

function inspectDatabase(dbPath, plan, readOnly = true) {
  const db = new DatabaseSync(path.resolve(dbPath), { readOnly });
  try {
    const indicators = readIndicators(db, plan);
    const snapshot = validateSnapshot({ indicators, plan });
    const quickCheck = text(db.prepare('PRAGMA quick_check').get()?.quick_check);
    if (quickCheck !== 'ok') snapshot.issues.push(`quick_check:${quickCheck}`);
    return { ...snapshot, quickCheck };
  } finally {
    db.close();
  }
}

function createBackup(dbPath, backupPath) {
  const resolvedBackupPath = path.resolve(backupPath);
  if (fs.existsSync(resolvedBackupPath)) throw new Error(`backup_already_exists:${resolvedBackupPath}`);
  fs.mkdirSync(path.dirname(resolvedBackupPath), { recursive: true });
  const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  try {
    db.exec(`VACUUM INTO ${sqlString(resolvedBackupPath)}`);
  } finally {
    db.close();
  }
  if (!fs.existsSync(resolvedBackupPath) || fs.statSync(resolvedBackupPath).size === 0) {
    throw new Error(`backup_missing_or_empty:${resolvedBackupPath}`);
  }
  return { path: resolvedBackupPath, sha256: sha256(resolvedBackupPath) };
}

function writeCleanup({ dbPath, plan, backupPath }) {
  const backup = createBackup(dbPath, backupPath);
  const db = new DatabaseSync(path.resolve(dbPath));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    const before = validateSnapshot({ indicators: readIndicators(db, plan), plan });
    if (before.issues.length) throw new Error(before.issues.join(','));
    const remove = db.prepare(`
      DELETE FROM insurance_indicator_records
       WHERE id = ? AND company = ? AND product_name = ?
    `);
    for (const id of plan.removeIds) {
      const result = remove.run(id, plan.company, plan.productName);
      if (result.changes !== 1) throw new Error(`delete_count_mismatch:${id}:${result.changes}`);
    }
    const after = readIndicators(db, plan);
    const remainingLiabilities = after.map((indicator) => indicator.liability).sort();
    const expectedLiabilities = [...plan.expectedLiabilities].sort();
    if (JSON.stringify(remainingLiabilities) !== JSON.stringify(expectedLiabilities)) {
      throw new Error(`post_delete_liabilities_mismatch:${remainingLiabilities.join('|')}:${expectedLiabilities.join('|')}`);
    }
    if (after.some((indicator) => indicator.sourceUrl !== plan.expectedSourceUrl)) {
      throw new Error('post_delete_source_url_mismatch');
    }
    const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
    const quickCheck = text(db.prepare('PRAGMA quick_check').get()?.quick_check);
    if (foreignKeyIssues.length || quickCheck !== 'ok') {
      throw new Error(`post_delete_integrity_failure:${foreignKeyIssues.length}:${quickCheck}`);
    }
    db.exec('COMMIT');
    return {
      backup,
      deletedIndicatorIds: plan.removeIds,
      remainingLiabilities,
      foreignKeyIssueCount: foreignKeyIssues.length,
      quickCheck,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  } finally {
    db.close();
  }
}

export function cleanupExactResponsibilityIndicators({
  dbPath = '',
  company = '',
  productName = '',
  expectedSourceUrl = '',
  expectedLiabilities = [],
  removeIds = [],
  backupPath = '',
  write = false,
} = {}) {
  const plan = buildPlan({
    company: text(company),
    productName: text(productName),
    expectedSourceUrl: text(expectedSourceUrl),
    expectedLiabilities: expectedLiabilities.map(text).filter(Boolean),
    removeIds: removeIds.map(text).filter(Boolean),
  });
  if (!dbPath) plan.issues.push('db_path_required');
  const preflight = plan.issues.length ? { issues: plan.issues, candidates: [], retained: [], quickCheck: '' }
    : inspectDatabase(dbPath, plan);
  if (preflight.issues.length || !write) {
    return {
      ok: preflight.issues.length === 0,
      dryRun: !write,
      dbPath: path.resolve(dbPath || '.'),
      plan: {
        company: plan.company,
        productName: plan.productName,
        expectedSourceUrl: plan.expectedSourceUrl,
        expectedLiabilities: plan.expectedLiabilities,
        removeIds: plan.removeIds,
      },
      validationIssueCount: preflight.issues.length,
      validationIssues: preflight.issues,
      candidates: preflight.candidates,
      retained: preflight.retained,
      quickCheck: preflight.quickCheck,
      backup: null,
      deletedIndicatorIds: [],
    };
  }
  if (!backupPath) throw new Error('backup_path_required_for_write');
  const written = writeCleanup({ dbPath, plan, backupPath });
  return {
    ok: true,
    dryRun: false,
    dbPath: path.resolve(dbPath),
    plan: {
      company: plan.company,
      productName: plan.productName,
      expectedSourceUrl: plan.expectedSourceUrl,
      expectedLiabilities: plan.expectedLiabilities,
      removeIds: plan.removeIds,
    },
    validationIssueCount: 0,
    validationIssues: [],
    candidates: preflight.candidates,
    retained: preflight.retained,
    quickCheck: written.quickCheck,
    backup: written.backup,
    deletedIndicatorIds: written.deletedIndicatorIds,
    remainingLiabilities: written.remainingLiabilities,
    foreignKeyIssueCount: written.foreignKeyIssueCount,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    console.log(JSON.stringify(cleanupExactResponsibilityIndicators({
      dbPath: readArg('db-path'),
      company: readArg('company'),
      productName: readArg('product-name'),
      expectedSourceUrl: readArg('expected-source-url'),
      expectedLiabilities: readArgs('expected-liability'),
      removeIds: readArgs('remove-indicator-id'),
      backupPath: readArg('backup-path'),
      write: hasFlag('write'),
    }), null, 2));
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
