import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const HANDOFF_FORMAT = 'policy-ocr-targeted-policy-input-handoff-v1';
const SCOPE_FORMAT = 'policy-ocr-targeted-policy-input-scope-v1';
const ALLOWED_INPUT_KEYS = [
  'amount',
  'firstPremium',
  'premium',
  'paymentPeriod',
  'coveragePeriod',
  'date',
  'effectiveDate',
  'insuredBirthday',
  'policyYear',
  'plans',
  'responsibilities',
  'optionalResponsibilities',
  'formulaVariables',
];

function text(value) {
  return String(value ?? '').trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function valueSha256(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function requiredTables(db, tables) {
  return tables.filter((table) => !tableExists(db, table));
}

function quoteSqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function inputPatchFromPayload(payload) {
  return Object.fromEntries(
    ALLOWED_INPUT_KEYS
      .filter((key) => Object.hasOwn(payload, key) && payload[key] !== undefined)
      .map((key) => [key, payload[key]]),
  );
}

function inputPresence(payload) {
  return {
    amount: finitePositive(payload.amount),
    premium: finitePositive(payload.firstPremium) || finitePositive(payload.premium),
    paymentPeriod: Boolean(text(payload.paymentPeriod)),
    effectiveDate: Boolean(text(payload.date || payload.effectiveDate)),
    insuredBirthday: Boolean(text(payload.insuredBirthday)),
    plans: rows(payload.plans).length > 0,
    responsibilities: rows(payload.responsibilities).length > 0,
    optionalResponsibilities: rows(payload.optionalResponsibilities).length > 0,
    formulaVariables: payload.formulaVariables && typeof payload.formulaVariables === 'object',
  };
}

function scopeProductBySourceName(scope) {
  const byName = new Map();
  const issues = [];
  for (const product of rows(scope.products)) {
    for (const productName of rows(product.policySourceProductNames)) {
      const key = text(productName);
      if (!key) {
        issues.push(`scope_missing_policy_source_product_name:${product.order ?? '?'}`);
      } else if (byName.has(key)) {
        issues.push(`scope_duplicate_policy_source_product_name:${key}`);
      } else {
        byName.set(key, product);
      }
    }
  }
  return { byName, issues };
}

function validateScope(scope) {
  const issues = [];
  if (text(scope.format) !== SCOPE_FORMAT) issues.push(`scope_format:${text(scope.format)}`);
  if (!rows(scope.products).length) issues.push('scope_has_no_products');
  const { issues: sourceNameIssues } = scopeProductBySourceName(scope);
  issues.push(...sourceNameIssues);
  for (const product of rows(scope.products)) {
    const label = `scope_product:${product.order ?? '?'}`;
    if (!text(product.cardCompany) || !text(product.cardProductName) || !text(product.cardSourceUrl)) {
      issues.push(`${label}:card_identity_missing`);
    }
    if (!rows(product.policySourceProductNames).length || !rows(product.policySourceUrls).length) {
      issues.push(`${label}:policy_source_identity_missing`);
    }
    if (!Number.isInteger(Number(product.expectedPolicyCount)) || Number(product.expectedPolicyCount) < 1) {
      issues.push(`${label}:expected_policy_count_invalid`);
    }
  }
  return issues;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sourceRowsForScope(db, scope) {
  const names = rows(scope.products).flatMap((product) => rows(product.policySourceProductNames).map(text)).filter(Boolean);
  if (!names.length) return [];
  const placeholders = names.map(() => '?').join(', ');
  return db.prepare(`
    SELECT p.id AS policy_id, p.user_id AS user_id, p.company AS policy_company, p.name AS policy_name,
           p.payload AS policy_payload, s.product_name AS source_product_name, s.url AS source_url
      FROM policies p
      JOIN source_records s ON s.policy_id = p.id
     WHERE s.product_name IN (${placeholders})
     ORDER BY s.product_name, p.id, s.id
  `).all(...names);
}

export function createTargetedPolicyInputHandoff({ sourceDbPath = '', scopePath = '', outputPath = '' } = {}) {
  if (!sourceDbPath || !scopePath || !outputPath) throw new Error('sourceDbPath, scopePath, and outputPath are required');
  const resolvedScopePath = path.resolve(scopePath);
  const scope = readJson(resolvedScopePath);
  const issues = validateScope(scope);
  if (issues.length) return { ok: false, validationIssueCount: issues.length, validationIssues: issues };

  const db = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    const missingTables = requiredTables(db, ['policies', 'source_records']);
    if (missingTables.length) {
      return { ok: false, validationIssueCount: missingTables.length, validationIssues: missingTables.map((table) => `missing_table:${table}`) };
    }
    const { byName } = scopeProductBySourceName(scope);
    const products = rows(scope.products).map((product) => ({ ...product, entries: [] }));
    const productByOrder = new Map(products.map((product) => [Number(product.order), product]));
    const seenPolicyIds = new Set();
    for (const row of sourceRowsForScope(db, scope)) {
      const product = byName.get(text(row.source_product_name));
      if (!product) {
        issues.push(`source_product_not_in_scope:${text(row.source_product_name)}`);
        continue;
      }
      const destination = productByOrder.get(Number(product.order));
      if (seenPolicyIds.has(Number(row.policy_id))) {
        issues.push(`source_policy_multiple_source_records:${row.policy_id}`);
        continue;
      }
      seenPolicyIds.add(Number(row.policy_id));
      if (!rows(product.policySourceUrls).includes(text(row.source_url))) {
        issues.push(`${product.order}:source_url_conflict:${text(row.source_url)}`);
        continue;
      }
      const payload = parseJson(row.policy_payload);
      const inputPatch = inputPatchFromPayload(payload);
      if (!finitePositive(inputPatch.amount)) {
        issues.push(`${product.order}:source_policy_missing_positive_amount:${row.policy_id}`);
        continue;
      }
      destination.entries.push({
        sourcePolicyId: Number(row.policy_id),
        sourceUserId: Number(row.user_id),
        policyCompany: text(row.policy_company),
        policyName: text(row.policy_name),
        policySourceProductName: text(row.source_product_name),
        policySourceUrl: text(row.source_url),
        inputPatch,
        inputPatchSha256: valueSha256(inputPatch),
      });
    }

    for (const product of products) {
      if (product.entries.length !== Number(product.expectedPolicyCount)) {
        issues.push(`${product.order}:source_policy_count:${product.entries.length}:${product.expectedPolicyCount}`);
      }
      for (const entry of product.entries) {
        if (!entry.sourcePolicyId || !entry.sourceUserId || !entry.policyCompany || !entry.policyName) {
          issues.push(`${product.order}:source_policy_identity_missing:${entry.sourcePolicyId || '?'}`);
        }
      }
    }
    if (issues.length) return { ok: false, validationIssueCount: issues.length, validationIssues: issues };

    const entries = products.flatMap((product) => product.entries.map((entry) => ({
      order: Number(product.order),
      numericId: product.numericId ?? null,
      cardCompany: text(product.cardCompany),
      cardProductName: text(product.cardProductName),
      cardSourceUrl: text(product.cardSourceUrl),
      ...entry,
    })));
    const handoff = {
      format: HANDOFF_FORMAT,
      createdAt: new Date().toISOString(),
      source: {
        scopeSha256: valueSha256(scope),
        productCount: products.length,
        policyCount: entries.length,
        allowedInputKeys: ALLOWED_INPUT_KEYS,
      },
      entries,
    };
    const resolvedOutputPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
    return {
      ok: true,
      outputPath: resolvedOutputPath,
      outputSha256: valueSha256(handoff),
      productCount: products.length,
      policyCount: entries.length,
      products: products.map((product) => ({
        order: product.order,
        cardCompany: product.cardCompany,
        cardProductName: product.cardProductName,
        numericId: product.numericId ?? null,
        policyCount: product.entries.length,
        sourceUrls: [...new Set(product.entries.map((entry) => entry.policySourceUrl))],
        inputKeys: [...new Set(product.entries.flatMap((entry) => Object.keys(entry.inputPatch)))].sort(),
        inputPresence: product.entries.map((entry) => inputPresence(entry.inputPatch)),
      })),
    };
  } finally {
    db.close();
  }
}

function validateHandoff(handoff) {
  const issues = [];
  if (text(handoff.format) !== HANDOFF_FORMAT) issues.push(`handoff_format:${text(handoff.format)}`);
  const declaredKeys = rows(handoff?.source?.allowedInputKeys);
  if (stableJson(declaredKeys) !== stableJson(ALLOWED_INPUT_KEYS)) issues.push('handoff_allowed_input_keys_mismatch');
  const entries = rows(handoff.entries);
  if (!entries.length) issues.push('handoff_has_no_entries');
  const seen = new Set();
  for (const entry of entries) {
    const label = `${entry.order ?? '?'}:${entry.sourcePolicyId ?? '?'}`;
    if (!Number.isInteger(Number(entry.sourcePolicyId)) || Number(entry.sourcePolicyId) < 1) issues.push(`handoff_invalid_policy_id:${label}`);
    if (!Number.isInteger(Number(entry.sourceUserId)) || Number(entry.sourceUserId) < 1) issues.push(`handoff_invalid_user_id:${label}`);
    if (!text(entry.policyCompany) || !text(entry.policyName) || !text(entry.policySourceProductName) || !text(entry.policySourceUrl)) {
      issues.push(`handoff_identity_missing:${label}`);
    }
    if (!text(entry.cardCompany) || !text(entry.cardProductName) || !text(entry.cardSourceUrl)) issues.push(`handoff_card_identity_missing:${label}`);
    const key = `${entry.sourcePolicyId}\u001f${entry.sourceUserId}`;
    if (seen.has(key)) issues.push(`handoff_duplicate_policy:${label}`);
    seen.add(key);
    const inputPatch = entry.inputPatch && typeof entry.inputPatch === 'object' && !Array.isArray(entry.inputPatch) ? entry.inputPatch : null;
    if (!inputPatch) {
      issues.push(`handoff_input_patch_invalid:${label}`);
      continue;
    }
    const unexpected = Object.keys(inputPatch).filter((key) => !ALLOWED_INPUT_KEYS.includes(key));
    if (unexpected.length) issues.push(`handoff_unapproved_input_keys:${label}:${unexpected.join(',')}`);
    if (!finitePositive(inputPatch.amount)) issues.push(`handoff_missing_positive_amount:${label}`);
    if (text(entry.inputPatchSha256) !== valueSha256(inputPatch)) issues.push(`handoff_input_patch_sha256_mismatch:${label}`);
  }
  return issues;
}

function staticProductReadback(db, entry) {
  const cards = db.prepare(`
    SELECT title, source_url, payload
      FROM product_responsibility_cards
     WHERE company = ? AND product_name = ?
     ORDER BY title
  `).all(entry.cardCompany, entry.cardProductName);
  const indicators = db.prepare(`
    SELECT liability, payload
      FROM insurance_indicator_records
     WHERE company = ? AND product_name = ?
     ORDER BY liability
  `).all(entry.cardCompany, entry.cardProductName);
  const cardSourceMatch = cards.some((card) => {
    const payload = parseJson(card.payload);
    return text(card.source_url) === entry.cardSourceUrl || text(payload.sourceUrl) === entry.cardSourceUrl;
  });
  const indicatorSourceMatch = indicators.some((indicator) => text(parseJson(indicator.payload).sourceUrl) === entry.cardSourceUrl);
  return {
    cards: cards.length,
    indicators: indicators.length,
    cardSourceMatch,
    indicatorSourceMatch,
  };
}

function targetEntryPreflight(db, entry) {
  const issues = [];
  const target = db.prepare(`
    SELECT id, user_id, company, name, payload
      FROM policies
     WHERE id = ?
  `).get(entry.sourcePolicyId);
  if (!target) {
    issues.push('target_policy_missing');
    return { sourcePolicyId: entry.sourcePolicyId, issues };
  }
  if (Number(target.user_id) !== Number(entry.sourceUserId)) issues.push('target_user_id_mismatch');
  if (text(target.company) !== text(entry.policyCompany)) issues.push('target_policy_company_mismatch');
  if (text(target.name) !== text(entry.policyName)) issues.push('target_policy_name_mismatch');
  const sources = db.prepare(`
    SELECT product_name, url
      FROM source_records
     WHERE policy_id = ?
     ORDER BY id
  `).all(entry.sourcePolicyId);
  const sourceMatch = sources.some((source) => text(source.product_name) === entry.policySourceProductName && text(source.url) === entry.policySourceUrl);
  if (!sourceMatch) issues.push('target_source_record_identity_mismatch');
  const product = staticProductReadback(db, entry);
  if (!product.cards) issues.push('target_responsibility_cards_missing');
  if (!product.indicators) issues.push('target_indicator_records_missing');
  if (!product.cardSourceMatch) issues.push('target_card_source_url_mismatch');
  if (!product.indicatorSourceMatch) issues.push('target_indicator_source_url_mismatch');
  const payload = parseJson(target.payload);
  const changes = ALLOWED_INPUT_KEYS.filter((key) => Object.hasOwn(entry.inputPatch, key)
    && stableJson(payload[key]) !== stableJson(entry.inputPatch[key]));
  return {
    sourcePolicyId: entry.sourcePolicyId,
    order: entry.order,
    cardProductName: entry.cardProductName,
    changes,
    targetInputPresence: inputPresence(payload),
    product,
    issues,
  };
}

function preflightTargetDatabase(db, handoff) {
  const missingTables = requiredTables(db, [
    'policies',
    'source_records',
    'product_responsibility_cards',
    'insurance_indicator_records',
  ]);
  const quickCheck = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
  const entries = rows(handoff.entries).map((entry) => targetEntryPreflight(db, entry));
  const validationIssues = [
    ...missingTables.map((table) => `missing_table:${table}`),
    ...(quickCheck === 'ok' ? [] : [`target_quick_check:${quickCheck}`]),
    ...entries.flatMap((entry) => entry.issues.map((issue) => `${entry.order}:${entry.sourcePolicyId}:${issue}`)),
  ];
  return {
    quickCheck,
    entries,
    validationIssueCount: validationIssues.length,
    validationIssues,
    ok: validationIssues.length === 0,
  };
}

function backupTarget(db, backupDir) {
  const resolvedBackupDir = path.resolve(backupDir);
  if (!fs.existsSync(resolvedBackupDir) || !fs.statSync(resolvedBackupDir).isDirectory()) {
    throw new Error(`backupDir must be an existing directory: ${resolvedBackupDir}`);
  }
  const backupPath = path.join(resolvedBackupDir, `policy-ocr-before-targeted-policy-input-import-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  db.exec('PRAGMA wal_checkpoint(FULL)');
  db.exec(`VACUUM INTO ${quoteSqlLiteral(backupPath)}`);
  return backupPath;
}

function patchEntry(db, entry) {
  const target = db.prepare('SELECT id, user_id, payload FROM policies WHERE id = ?').get(entry.sourcePolicyId);
  if (!target || Number(target.user_id) !== Number(entry.sourceUserId)) {
    throw new Error(`target_identity_changed:${entry.sourcePolicyId}`);
  }
  const payload = parseJson(target.payload);
  const nextPayload = { ...payload, ...entry.inputPatch };
  const result = db.prepare(`
    UPDATE policies
       SET updated_at = ?, payload = ?
     WHERE id = ? AND user_id = ?
  `).run(new Date().toISOString(), JSON.stringify(nextPayload), entry.sourcePolicyId, entry.sourceUserId);
  if (Number(result.changes) !== 1) throw new Error(`target_policy_update_failed:${entry.sourcePolicyId}`);
}

function semanticReadback(dbPath, handoff) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const entries = rows(handoff.entries).map((entry) => {
      const target = db.prepare('SELECT payload FROM policies WHERE id = ? AND user_id = ?').get(entry.sourcePolicyId, entry.sourceUserId);
      const payload = parseJson(target?.payload);
      const issues = [];
      if (!target) issues.push('readback_policy_missing');
      for (const key of Object.keys(entry.inputPatch)) {
        if (stableJson(payload[key]) !== stableJson(entry.inputPatch[key])) issues.push(`input_patch_mismatch:${key}`);
      }
      const product = target ? staticProductReadback(db, entry) : { cards: 0, indicators: 0, cardSourceMatch: false, indicatorSourceMatch: false };
      if (!product.cards || !product.indicators || !product.cardSourceMatch || !product.indicatorSourceMatch) issues.push('artifact_card_indicator_projection_missing');
      return {
        sourcePolicyId: entry.sourcePolicyId,
        order: entry.order,
        cardProductName: entry.cardProductName,
        inputPresence: inputPresence(payload),
        cards: product.cards,
        indicators: product.indicators,
        validationIssues: issues,
      };
    });
    const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
    const quickCheck = String(db.prepare('PRAGMA quick_check').get()?.quick_check || '');
    const validationIssueCount = entries.reduce((count, entry) => count + entry.validationIssues.length, 0)
      + foreignKeyIssues.length
      + (quickCheck === 'ok' ? 0 : 1);
    return {
      entries,
      foreignKeyIssueCount: foreignKeyIssues.length,
      quickCheck,
      validationIssueCount,
      ok: validationIssueCount === 0,
    };
  } finally {
    db.close();
  }
}

export async function importTargetedPolicyInputHandoff({ handoffPath = '', dbPath = '', backupDir = '', write = false } = {}) {
  if (!handoffPath || !dbPath) throw new Error('handoffPath and dbPath are required');
  const resolvedHandoffPath = path.resolve(handoffPath);
  const resolvedDbPath = path.resolve(dbPath);
  const handoff = readJson(resolvedHandoffPath);
  const handoffIssues = validateHandoff(handoff);
  if (handoffIssues.length) {
    return {
      ok: false,
      dryRun: !write,
      handoffPath: resolvedHandoffPath,
      dbPath: resolvedDbPath,
      validationIssueCount: handoffIssues.length,
      validationIssues: handoffIssues,
    };
  }
  const preflightDb = new DatabaseSync(resolvedDbPath, { readOnly: true });
  let preflight;
  try {
    preflight = preflightTargetDatabase(preflightDb, handoff);
  } finally {
    preflightDb.close();
  }
  if (!preflight.ok || !write) {
    return {
      ok: preflight.ok,
      dryRun: !write,
      handoffPath: resolvedHandoffPath,
      handoffSha256: await sha256File(resolvedHandoffPath),
      dbPath: resolvedDbPath,
      validationIssueCount: preflight.validationIssueCount,
      validationIssues: preflight.validationIssues,
      preflight,
      backup: null,
      modifiedTables: [],
      readback: null,
    };
  }
  if (!backupDir) throw new Error('backupDir is required with --write');
  const db = new DatabaseSync(resolvedDbPath);
  let backupPath = '';
  try {
    const writePreflight = preflightTargetDatabase(db, handoff);
    if (!writePreflight.ok) {
      return {
        ok: false,
        dryRun: false,
        handoffPath: resolvedHandoffPath,
        handoffSha256: await sha256File(resolvedHandoffPath),
        dbPath: resolvedDbPath,
        validationIssueCount: writePreflight.validationIssueCount,
        validationIssues: writePreflight.validationIssues,
        preflight: writePreflight,
        backup: null,
        modifiedTables: [],
        readback: null,
      };
    }
    backupPath = backupTarget(db, backupDir);
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const entry of rows(handoff.entries)) patchEntry(db, entry);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  const backup = { path: backupPath, sha256: await sha256File(backupPath) };
  const readback = semanticReadback(resolvedDbPath, handoff);
  return {
    ok: readback.ok,
    dryRun: false,
    handoffPath: resolvedHandoffPath,
    handoffSha256: await sha256File(resolvedHandoffPath),
    dbPath: resolvedDbPath,
    validationIssueCount: readback.validationIssueCount,
    validationIssues: readback.entries.flatMap((entry) => entry.validationIssues.map((issue) => `${entry.order}:${entry.sourcePolicyId}:${issue}`)),
    preflight,
    backup,
    modifiedTables: ['policies'],
    readback,
  };
}

function readArg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] || '' : '';
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const mode = readArg('mode');
  if (mode === 'export') {
    const result = createTargetedPolicyInputHandoff({
      sourceDbPath: readArg('source-db'),
      scopePath: readArg('scope'),
      outputPath: readArg('output'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  if (mode === 'import') {
    const result = await importTargetedPolicyInputHandoff({
      handoffPath: readArg('handoff'),
      dbPath: readArg('db-path'),
      backupDir: readArg('backup-dir'),
      write: hasFlag('write'),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
    return;
  }
  throw new Error('Usage: --mode export --source-db <sqlite> --scope <scope.json> --output <handoff.json> | --mode import --handoff <handoff.json> --db-path <sqlite> [--backup-dir <dir> --write]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
