import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const HANDOFF_FORMAT = 'policy-ocr-static-responsibility-handoff-v1';
const SCOPE_FORMAT = 'policy-ocr-static-responsibility-scope-v1';
const CARD_COLUMNS = [
  'id',
  'product_key',
  'company',
  'product_name',
  'title',
  'category',
  'cashflow_treatment',
  'calculation_status',
  'calculation_reason',
  'responsibility_scope',
  'selection_status',
  'source_url',
  'generated_at',
  'updated_at',
  'payload',
];
const INDICATOR_COLUMNS = ['id', 'company', 'product_name', 'coverage_type', 'liability', 'payload'];

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

function sorted(values = []) {
  return [...new Set(values.map(text).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'));
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

function quoteSqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function missingColumns(db, table, expectedColumns) {
  const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => text(column.name)));
  return expectedColumns.filter((column) => !columns.has(column));
}

function sourceDigest(payload = {}) {
  return text(payload.sourceDigest || payload.responsibilitySourceDigest || payload.responsibility_source_digest);
}

function sourceUrl(payload = {}, row = {}) {
  return text(payload.sourceUrl || payload.source_url || row.source_url);
}

function rowIdentityValues(cardRows, indicatorRows) {
  const values = [];
  for (const row of cardRows) {
    const payload = parseJson(row.payload);
    values.push({ sourceUrl: sourceUrl(payload, row), sourceDigest: sourceDigest(payload) });
    for (const indicator of rows(payload.indicators)) {
      values.push({ sourceUrl: sourceUrl(indicator), sourceDigest: sourceDigest(indicator) });
    }
  }
  for (const row of indicatorRows) {
    const payload = parseJson(row.payload);
    values.push({ sourceUrl: sourceUrl(payload, row), sourceDigest: sourceDigest(payload) });
  }
  return {
    sourceUrls: sorted(values.map((value) => value.sourceUrl)),
    sourceDigests: sorted(values.map((value) => value.sourceDigest)),
  };
}

function rowProjectionIssues(cardRows, indicatorRows) {
  const issues = [];
  const indicatorIds = new Set(indicatorRows.map((row) => text(row.id)).filter(Boolean));
  for (const card of cardRows) {
    const payload = parseJson(card.payload);
    const nested = rows(payload.indicators);
    if (!nested.length) {
      issues.push(`card_indicator_projection_missing:${text(card.title) || text(card.id)}`);
      continue;
    }
    for (const indicator of nested) {
      const id = text(indicator?.id);
      if (id && indicatorIds.has(id)) continue;
      const liability = text(indicator?.liability) || text(card.title);
      const sameLiability = indicatorRows.filter((row) => text(row.liability) === liability);
      if (sameLiability.length !== 1) {
        issues.push(`card_indicator_record_missing:${text(card.title) || text(card.id)}:${id || liability || '?'}`);
      }
    }
  }
  return issues;
}

function readStaticRows(db, product) {
  const cards = db.prepare(`
    SELECT ${CARD_COLUMNS.join(', ')}
      FROM product_responsibility_cards
     WHERE company = ? AND product_name = ?
     ORDER BY title ASC, id ASC
  `).all(product.company, product.productName);
  const indicators = db.prepare(`
    SELECT ${INDICATOR_COLUMNS.join(', ')}
      FROM insurance_indicator_records
     WHERE company = ? AND product_name = ?
     ORDER BY liability ASC, id ASC
  `).all(product.company, product.productName);
  return { cards, indicators };
}

function validateScope(scope) {
  const issues = [];
  if (text(scope?.format) !== SCOPE_FORMAT) issues.push(`scope_format:${text(scope?.format)}`);
  if (rows(scope?.products).length !== 9) issues.push(`scope_product_count:${rows(scope?.products).length}:9`);
  const seen = new Set();
  for (const product of rows(scope?.products)) {
    const label = `scope_product:${product?.order ?? '?'}`;
    if (!Number.isInteger(Number(product?.order)) || Number(product.order) < 1) issues.push(`${label}:invalid_order`);
    if (!text(product?.company) || !text(product?.productName)) issues.push(`${label}:identity_missing`);
    if (!text(product?.sourceDigest) || !text(product?.sourceUrl)) issues.push(`${label}:source_identity_missing`);
    if (!Number.isInteger(Number(product?.expectedCards)) || Number(product.expectedCards) < 1) issues.push(`${label}:expected_cards_invalid`);
    if (!Number.isInteger(Number(product?.expectedIndicators)) || Number(product.expectedIndicators) < 1) issues.push(`${label}:expected_indicators_invalid`);
    const key = `${text(product?.company)}\u001f${text(product?.productName)}`;
    if (seen.has(key)) issues.push(`${label}:duplicate_product_identity`);
    seen.add(key);
  }
  return issues;
}

function validateProductRows(product, staticRows) {
  const { cards, indicators } = staticRows;
  const issues = [];
  const label = `${product.order}:${product.productName}`;
  if (cards.length !== Number(product.expectedCards)) issues.push(`${label}:card_count:${cards.length}:${product.expectedCards}`);
  if (indicators.length !== Number(product.expectedIndicators)) issues.push(`${label}:indicator_count:${indicators.length}:${product.expectedIndicators}`);
  if (new Set(cards.map((row) => text(row.id))).size !== cards.length) issues.push(`${label}:duplicate_card_id`);
  if (new Set(indicators.map((row) => text(row.id))).size !== indicators.length) issues.push(`${label}:duplicate_indicator_id`);
  for (const card of cards) {
    if (!text(card.id) || !text(card.product_key) || !text(card.title) || !text(card.source_url) || !text(card.payload)) {
      issues.push(`${label}:card_required_field_missing:${text(card.id) || text(card.title) || '?'}`);
    }
  }
  for (const indicator of indicators) {
    if (!text(indicator.id) || !text(indicator.liability) || !text(indicator.payload)) {
      issues.push(`${label}:indicator_required_field_missing:${text(indicator.id) || text(indicator.liability) || '?'}`);
    }
  }
  const identities = rowIdentityValues(cards, indicators);
  if (identities.sourceDigests.length !== 1 || identities.sourceDigests[0] !== text(product.sourceDigest)) {
    issues.push(`${label}:source_digest_version_conflict:${identities.sourceDigests.join('|') || '(empty)'}`);
  }
  if (identities.sourceUrls.length !== 1 || identities.sourceUrls[0] !== text(product.sourceUrl)) {
    issues.push(`${label}:source_url_version_conflict:${identities.sourceUrls.join('|') || '(empty)'}`);
  }
  issues.push(...rowProjectionIssues(cards, indicators).map((issue) => `${label}:${issue}`));
  return { issues, identities };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function createStaticResponsibilityHandoff({ sourceDbPath = '', scopePath = '', outputPath = '' } = {}) {
  if (!sourceDbPath || !scopePath || !outputPath) throw new Error('sourceDbPath, scopePath, and outputPath are required');
  const resolvedScopePath = path.resolve(scopePath);
  const scope = readJson(resolvedScopePath);
  const issues = validateScope(scope);
  if (issues.length) return { ok: false, validationIssueCount: issues.length, validationIssues: issues };

  const db = new DatabaseSync(path.resolve(sourceDbPath), { readOnly: true });
  try {
    const missingTables = ['product_responsibility_cards', 'insurance_indicator_records'].filter((table) => !tableExists(db, table));
    const missingCardColumns = missingTables.includes('product_responsibility_cards') ? [] : missingColumns(db, 'product_responsibility_cards', CARD_COLUMNS);
    const missingIndicatorColumns = missingTables.includes('insurance_indicator_records') ? [] : missingColumns(db, 'insurance_indicator_records', INDICATOR_COLUMNS);
    if (missingTables.length || missingCardColumns.length || missingIndicatorColumns.length) {
      const validationIssues = [
        ...missingTables.map((table) => `missing_table:${table}`),
        ...missingCardColumns.map((column) => `missing_card_column:${column}`),
        ...missingIndicatorColumns.map((column) => `missing_indicator_column:${column}`),
      ];
      return { ok: false, validationIssueCount: validationIssues.length, validationIssues };
    }
    const products = rows(scope.products).map((scopeProduct) => {
      const staticRows = readStaticRows(db, scopeProduct);
      const validation = validateProductRows(scopeProduct, staticRows);
      issues.push(...validation.issues);
      return {
        order: Number(scopeProduct.order),
        numericId: scopeProduct.numericId ?? null,
        company: text(scopeProduct.company),
        productName: text(scopeProduct.productName),
        sourceDigest: text(scopeProduct.sourceDigest),
        sourceUrl: text(scopeProduct.sourceUrl),
        expectedCards: Number(scopeProduct.expectedCards),
        expectedIndicators: Number(scopeProduct.expectedIndicators),
        cards: staticRows.cards,
        indicators: staticRows.indicators,
      };
    });
    if (issues.length) return { ok: false, validationIssueCount: issues.length, validationIssues: issues };
    const handoff = {
      format: HANDOFF_FORMAT,
      createdAt: new Date().toISOString(),
      source: {
        database: 'verified_ssd_development_database',
        scopeSha256: valueSha256(scope),
        productCount: products.length,
        cardCount: products.reduce((total, product) => total + product.cards.length, 0),
        indicatorCount: products.reduce((total, product) => total + product.indicators.length, 0),
      },
      products,
    };
    const resolvedOutputPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
    fs.writeFileSync(resolvedOutputPath, `${JSON.stringify(handoff, null, 2)}\n`, { mode: 0o600 });
    return {
      ok: true,
      outputPath: resolvedOutputPath,
      outputSha256: valueSha256(handoff),
      productCount: products.length,
      cardCount: handoff.source.cardCount,
      indicatorCount: handoff.source.indicatorCount,
      products: products.map((product) => ({
        order: product.order,
        numericId: product.numericId,
        company: product.company,
        productName: product.productName,
        sourceDigest: product.sourceDigest,
        sourceUrl: product.sourceUrl,
        cards: product.cards.length,
        indicators: product.indicators.length,
      })),
    };
  } finally {
    db.close();
  }
}

function validateHandoff(handoff) {
  const issues = [];
  if (text(handoff?.format) !== HANDOFF_FORMAT) issues.push(`handoff_format:${text(handoff?.format)}`);
  if (rows(handoff?.products).length !== 9) issues.push(`handoff_product_count:${rows(handoff?.products).length}:9`);
  const seen = new Set();
  for (const product of rows(handoff?.products)) {
    const key = `${text(product?.company)}\u001f${text(product?.productName)}`;
    if (seen.has(key)) issues.push(`handoff_duplicate_product:${product?.order ?? '?'}`);
    seen.add(key);
    const validation = validateProductRows(product, {
      cards: rows(product?.cards),
      indicators: rows(product?.indicators),
    });
    issues.push(...validation.issues);
  }
  return issues;
}

function targetProductPreflight(db, product) {
  const staticRows = readStaticRows(db, product);
  const identities = rowIdentityValues(staticRows.cards, staticRows.indicators);
  const issues = [];
  const expectedDigest = text(product.sourceDigest);
  const expectedUrl = text(product.sourceUrl);
  const unexpectedDigests = identities.sourceDigests.filter((digest) => digest !== expectedDigest);
  if (unexpectedDigests.length) issues.push(`version_conflict:source_digest:${unexpectedDigests.join('|')}`);
  if (!identities.sourceDigests.length) {
    const unexpectedUrls = identities.sourceUrls.filter((url) => url !== expectedUrl);
    if (unexpectedUrls.length) issues.push(`version_conflict:source_url:${unexpectedUrls.join('|')}`);
  }
  return {
    order: product.order,
    numericId: product.numericId ?? null,
    company: product.company,
    productName: product.productName,
    sourceDigest: expectedDigest,
    sourceUrl: expectedUrl,
    existingCards: staticRows.cards.length,
    existingIndicators: staticRows.indicators.length,
    observedSourceDigests: identities.sourceDigests,
    observedSourceUrls: identities.sourceUrls,
    cardsToReplace: product.cards.length,
    indicatorsToReplace: product.indicators.length,
    validationIssues: issues,
  };
}

function preflightTargetDatabase(db, handoff) {
  const missingTables = ['product_responsibility_cards', 'insurance_indicator_records'].filter((table) => !tableExists(db, table));
  const missingCardColumns = missingTables.includes('product_responsibility_cards') ? [] : missingColumns(db, 'product_responsibility_cards', CARD_COLUMNS);
  const missingIndicatorColumns = missingTables.includes('insurance_indicator_records') ? [] : missingColumns(db, 'insurance_indicator_records', INDICATOR_COLUMNS);
  const products = rows(handoff.products).map((product) => targetProductPreflight(db, product));
  const quickCheck = text(db.prepare('PRAGMA quick_check').get()?.quick_check);
  const validationIssues = [
    ...missingTables.map((table) => `missing_table:${table}`),
    ...missingCardColumns.map((column) => `missing_card_column:${column}`),
    ...missingIndicatorColumns.map((column) => `missing_indicator_column:${column}`),
    ...(quickCheck === 'ok' ? [] : [`target_quick_check:${quickCheck}`]),
    ...products.flatMap((product) => product.validationIssues.map((issue) => `${product.order}:${issue}`)),
  ];
  return {
    quickCheck,
    products,
    validationIssueCount: validationIssues.length,
    validationIssues,
    ok: validationIssues.length === 0,
  };
}

function backupTarget(db, backupDir) {
  const resolvedBackupDir = path.resolve(backupDir);
  if (!fs.existsSync(resolvedBackupDir) || !fs.statSync(resolvedBackupDir).isDirectory()) {
    throw new Error(`backup_dir_must_exist:${resolvedBackupDir}`);
  }
  const backupPath = path.join(
    resolvedBackupDir,
    `policy-ocr-before-static-responsibility-overwrite-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`,
  );
  db.exec('PRAGMA wal_checkpoint(FULL)');
  db.exec(`VACUUM INTO ${quoteSqlLiteral(backupPath)}`);
  if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) throw new Error(`backup_missing_or_empty:${backupPath}`);
  return backupPath;
}

function insertStatement(db, table, columns) {
  return db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
}

function writeProduct(db, product, statements) {
  const deleteCards = db.prepare('DELETE FROM product_responsibility_cards WHERE company = ? AND product_name = ?');
  const deleteIndicators = db.prepare('DELETE FROM insurance_indicator_records WHERE company = ? AND product_name = ?');
  const before = readStaticRows(db, product);
  const removedIndicators = deleteIndicators.run(product.company, product.productName);
  const removedCards = deleteCards.run(product.company, product.productName);
  for (const row of product.cards) statements.insertCard.run(...CARD_COLUMNS.map((column) => row[column]));
  for (const row of product.indicators) statements.insertIndicator.run(...INDICATOR_COLUMNS.map((column) => row[column]));
  return {
    order: product.order,
    productName: product.productName,
    before: { cards: before.cards.length, indicators: before.indicators.length },
    deleted: { cards: Number(removedCards.changes), indicators: Number(removedIndicators.changes) },
    inserted: { cards: product.cards.length, indicators: product.indicators.length },
  };
}

function semanticReadback(dbPath, handoff) {
  const db = new DatabaseSync(path.resolve(dbPath), { readOnly: true });
  try {
    const products = rows(handoff.products).map((product) => {
      const actual = readStaticRows(db, product);
      const issues = [];
      if (actual.cards.length !== product.cards.length) issues.push(`card_count:${actual.cards.length}:${product.cards.length}`);
      if (actual.indicators.length !== product.indicators.length) issues.push(`indicator_count:${actual.indicators.length}:${product.indicators.length}`);
      const expectedCards = new Map(product.cards.map((row) => [text(row.id), valueSha256(row)]));
      const expectedIndicators = new Map(product.indicators.map((row) => [text(row.id), valueSha256(row)]));
      for (const row of actual.cards) {
        if (expectedCards.get(text(row.id)) !== valueSha256(row)) issues.push(`card_row_mismatch:${text(row.id)}`);
      }
      for (const row of actual.indicators) {
        if (expectedIndicators.get(text(row.id)) !== valueSha256(row)) issues.push(`indicator_row_mismatch:${text(row.id)}`);
      }
      const identities = rowIdentityValues(actual.cards, actual.indicators);
      if (identities.sourceDigests.length !== 1 || identities.sourceDigests[0] !== text(product.sourceDigest)) {
        issues.push(`source_digest_mismatch:${identities.sourceDigests.join('|') || '(empty)'}`);
      }
      if (identities.sourceUrls.length !== 1 || identities.sourceUrls[0] !== text(product.sourceUrl)) {
        issues.push(`source_url_mismatch:${identities.sourceUrls.join('|') || '(empty)'}`);
      }
      issues.push(...rowProjectionIssues(actual.cards, actual.indicators));
      return {
        order: product.order,
        numericId: product.numericId ?? null,
        company: product.company,
        productName: product.productName,
        sourceDigest: product.sourceDigest,
        sourceUrl: product.sourceUrl,
        cards: actual.cards.length,
        indicators: actual.indicators.length,
        validationIssues: issues,
      };
    });
    const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
    const quickCheck = text(db.prepare('PRAGMA quick_check').get()?.quick_check);
    const validationIssueCount = products.reduce((count, product) => count + product.validationIssues.length, 0)
      + foreignKeyIssues.length
      + (quickCheck === 'ok' ? 0 : 1);
    return {
      products,
      foreignKeyIssueCount: foreignKeyIssues.length,
      quickCheck,
      validationIssueCount,
      ok: validationIssueCount === 0,
    };
  } finally {
    db.close();
  }
}

export async function importStaticResponsibilityHandoff({ handoffPath = '', dbPath = '', backupDir = '', write = false } = {}) {
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

  const readOnlyDb = new DatabaseSync(resolvedDbPath, { readOnly: true });
  let preflight;
  try {
    preflight = preflightTargetDatabase(readOnlyDb, handoff);
  } finally {
    readOnlyDb.close();
  }
  const handoffSha256 = await sha256File(resolvedHandoffPath);
  if (!preflight.ok || !write) {
    return {
      ok: preflight.ok,
      dryRun: !write,
      handoffPath: resolvedHandoffPath,
      handoffSha256,
      dbPath: resolvedDbPath,
      validationIssueCount: preflight.validationIssueCount,
      validationIssues: preflight.validationIssues,
      preflight,
      backup: null,
      modifiedTables: [],
      writeResults: [],
      readback: null,
    };
  }
  if (!backupDir) throw new Error('backupDir is required with --write');

  const db = new DatabaseSync(resolvedDbPath);
  let backupPath = '';
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const writePreflight = preflightTargetDatabase(db, handoff);
    if (!writePreflight.ok) {
      return {
        ok: false,
        dryRun: false,
        handoffPath: resolvedHandoffPath,
        handoffSha256,
        dbPath: resolvedDbPath,
        validationIssueCount: writePreflight.validationIssueCount,
        validationIssues: writePreflight.validationIssues,
        preflight: writePreflight,
        backup: null,
        modifiedTables: [],
        writeResults: [],
        readback: null,
      };
    }
    backupPath = backupTarget(db, backupDir);
    const statements = {
      insertCard: insertStatement(db, 'product_responsibility_cards', CARD_COLUMNS),
      insertIndicator: insertStatement(db, 'insurance_indicator_records', INDICATOR_COLUMNS),
    };
    db.exec('BEGIN IMMEDIATE');
    let writeResults;
    try {
      writeResults = rows(handoff.products).map((product) => writeProduct(db, product, statements));
      const foreignKeyIssues = db.prepare('PRAGMA foreign_key_check').all();
      const quickCheck = text(db.prepare('PRAGMA quick_check').get()?.quick_check);
      if (foreignKeyIssues.length || quickCheck !== 'ok') {
        throw new Error(`post_write_integrity_failure:${foreignKeyIssues.length}:${quickCheck}`);
      }
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    const readback = semanticReadback(resolvedDbPath, handoff);
    return {
      ok: readback.ok,
      dryRun: false,
      handoffPath: resolvedHandoffPath,
      handoffSha256,
      dbPath: resolvedDbPath,
      validationIssueCount: readback.validationIssueCount,
      validationIssues: readback.products.flatMap((product) => product.validationIssues.map((issue) => `${product.order}:${issue}`)),
      preflight: writePreflight,
      backup: { path: backupPath, sha256: await sha256File(backupPath) },
      modifiedTables: ['product_responsibility_cards', 'insurance_indicator_records'],
      writeResults,
      readback,
    };
  } finally {
    db.close();
  }
}

if (process.argv[1] && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(process.argv[1])) {
  try {
    const mode = readArg('mode', 'import');
    const result = mode === 'export'
      ? createStaticResponsibilityHandoff({
        sourceDbPath: readArg('source-db'),
        scopePath: readArg('scope'),
        outputPath: readArg('handoff'),
      })
      : await importStaticResponsibilityHandoff({
        handoffPath: readArg('handoff'),
        dbPath: readArg('db-path'),
        backupDir: readArg('backup-dir'),
        write: hasFlag('write'),
      });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
