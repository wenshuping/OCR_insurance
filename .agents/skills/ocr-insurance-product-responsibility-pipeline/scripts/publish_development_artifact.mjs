import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

import {
  listEquivalentResponsibilityProductRows,
  responsibilityProductIdentity,
  sameResponsibilityProduct,
} from '../../../../server/product-responsibility-identity.mjs';
import { resolvePolicyOcrWriteDatabasePath } from '../../../../server/policy-ocr-database-target.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(__dirname, '..');
const projectRoot = path.resolve(__dirname, '../../../..');
const publisherVersion = '2026-07-23-unified-responsibility-artifact-v3';

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
  return value === null || value === undefined ? '' : String(value).trim();
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function evidenceSegments(item = {}) {
  const segments = rows(item.evidenceSegments).filter((segment) => segment && typeof segment === 'object');
  if (segments.length) return segments;
  return text(item.sourceExcerpt) ? [{ sourcePage: item.sourcePage, sourceExcerpt: item.sourceExcerpt }] : [];
}

function evidenceExcerpt(item = {}) {
  return evidenceSegments(item).map((segment) => text(segment.sourceExcerpt)).filter(Boolean).join('\n');
}

function evidencePage(item = {}) {
  return evidenceSegments(item).map((segment) => text(segment.sourcePage)).filter(Boolean).join('、');
}

function stableId(prefix, ...parts) {
  const digest = createHash('sha256').update(parts.map(text).join('\u001f')).digest('hex').slice(0, 24);
  return `${prefix}_${digest}`;
}

function requireFile(value, label) {
  const resolved = path.resolve(text(value));
  if (!text(value) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} must be an existing file: ${resolved}`);
  }
  return resolved;
}

function calculationStatus(responsibility = {}) {
  const priority = new Map([
    ['needs_table', 5],
    ['needs_claim_facts', 4],
    ['display_only', 3],
    ['calculable', 2],
    ['not_quantitative', 1],
  ]);
  return rows(responsibility.indicators)
    .map((indicator) => text(indicator.calculationStatus) || 'not_quantitative')
    .sort((left, right) => (priority.get(right) || 0) - (priority.get(left) || 0))[0]
    || 'not_quantitative';
}

function coverageType(responsibility = {}) {
  const combined = [responsibility.liability, responsibility.triggerCondition, responsibility.insurerObligation]
    .map(text).join(' ');
  if (text(responsibility.responsibilityKind) === 'waiver' || /豁免/u.test(combined)) return '豁免';
  if (/医疗|住院|门诊|费用|报销|补偿|津贴/u.test(combined)) return '医疗保障';
  if (/重疾|重大疾病|中症|轻症|疾病|癌|恶性肿瘤/u.test(combined)) return '疾病保障';
  if (/意外|伤残|交通|航空|自驾/u.test(combined)) return '意外保障';
  if (/身故|全残/u.test(combined)) return '人寿保障';
  if (/年金|生存|满期|教育金|婚嫁金|养老金|压岁金|深造金|立业金/u.test(combined)) return '现金流';
  return '其他';
}

function cashflowTreatment(responsibility = {}) {
  if (text(responsibility.responsibilityKind) === 'waiver') return 'waiver_only';
  if (text(responsibility.responsibilityKind) === 'waiting_period_refund') return 'not_cashflow';
  return coverageType(responsibility) === '现金流' ? 'scheduled_cashflow' : 'claim_contingent';
}

function buildRows(artifact, now) {
  const company = text(artifact.company);
  const productName = text(artifact.productName);
  const sourceDigest = text(artifact.productIdentity?.sourceDigest);
  const sourceUrl = text(artifact.productIdentity?.sourceUrl);
  const identity = responsibilityProductIdentity({ company, productName });
  const productKey = identity?.productKey || '';
  const indicatorRows = [];
  const cardRows = [];
  const optionalRows = [];
  const productRules = rows(artifact.productRules);

  for (const responsibility of rows(artifact.responsibilities)) {
    const responsibilityId = text(responsibility.responsibilityId);
    const liability = text(responsibility.liability);
    const category = coverageType(responsibility);
    const status = calculationStatus(responsibility);
    const indicators = rows(responsibility.indicators);

    indicators.forEach((indicator, index) => {
      const id = stableId('ind_pipeline', sourceDigest, responsibilityId, indicator.indicatorName, index);
      const payload = {
        ...indicator,
        id,
        company,
        productName,
        responsibilityProductIdentity: identity,
        coverageType: category,
        liability,
        responsibilityId,
        responsibilityKind: text(responsibility.responsibilityKind),
        coverageAggregation: text(responsibility.coverageAggregation),
        responsibilityScope: responsibility.groupId ? 'optional' : 'basic_or_unspecified',
        selectionStatus: text(responsibility.selectionStatus),
        selectionEvidence: 'validated_unified_artifact',
        triggerCondition: text(responsibility.triggerCondition),
        condition: text(responsibility.triggerCondition),
        payoutSummary: text(responsibility.insurerObligation),
        basis: text(indicator.formulaText),
        cashflowTreatment: cashflowTreatment(responsibility),
        indicatorCheckStatus: 'accepted_deterministic_pipeline',
        calculationMetadataVersion: publisherVersion,
        extractionMethod: 'official_clause_deterministic_pipeline',
        sourceUrl,
        sourceDigest,
        ruleRefs: rows(indicator.ruleRefs || responsibility.ruleRefs),
        productRules,
        evidenceSegments: evidenceSegments(indicator).length ? evidenceSegments(indicator) : evidenceSegments(responsibility),
        sourcePage: evidencePage(indicator) || evidencePage(responsibility),
        sourceExcerpt: evidenceExcerpt(indicator) || evidenceExcerpt(responsibility),
        official: true,
        updatedAt: now,
      };
      indicatorRows.push({ id, company, productName, category, liability, payload });
    });

    const cardId = stableId('product_responsibility_card_pipeline', sourceDigest, responsibilityId);
    const cardPayload = {
      id: cardId,
      responsibilityId,
      company,
      productName,
      productKey,
      responsibilityProductIdentity: identity,
      title: text(responsibility.card?.title || liability),
      category,
      customerSummary: text(responsibility.card?.customerSummary),
      benefitExplanation: text(responsibility.card?.benefitExplanation),
      triggerCondition: text(responsibility.triggerCondition),
      payoutSummary: text(responsibility.insurerObligation),
      importantLimits: rows(responsibility.importantLimits),
      ruleRefs: rows(responsibility.ruleRefs),
      productRules,
      indicators,
      cashflowTreatment: cashflowTreatment(responsibility),
      calculationStatus: status,
      calculationReason: indicators.map((indicator) => text(indicator.calculationReason)).filter(Boolean).join('；'),
      responsibilityScope: responsibility.groupId ? 'optional' : 'basic_or_unspecified',
      selectionStatus: text(responsibility.selectionStatus),
      responsibilityKind: text(responsibility.responsibilityKind),
      coverageAggregation: text(responsibility.coverageAggregation),
      groupId: responsibility.groupId || null,
      parentResponsibilityId: responsibility.parentResponsibilityId || null,
      sourceUrl,
      sourceDigest,
      evidenceSegments: evidenceSegments(responsibility),
      sourcePage: evidencePage(responsibility),
      sourceExcerpt: evidenceExcerpt(responsibility),
      sourceGate: 'validated_official_source',
      liabilityGate: 'accepted',
      indicatorCheckStatus: 'accepted_deterministic_pipeline',
      indicatorCheckIssues: [],
      generatedAt: now,
      updatedAt: now,
    };
    cardRows.push({
      id: cardId,
      productKey,
      company,
      productName,
      title: liability,
      category,
      cashflowTreatment: cardPayload.cashflowTreatment,
      calculationStatus: status,
      calculationReason: cardPayload.calculationReason,
      responsibilityScope: cardPayload.responsibilityScope,
      selectionStatus: cardPayload.selectionStatus,
      sourceUrl,
      payload: cardPayload,
    });

    if (responsibility.groupId) {
      const id = stableId('optional_pipeline', sourceDigest, responsibilityId);
      optionalRows.push({
        id,
        company,
        productName,
        liability,
        payload: {
          ...cardPayload,
          id,
          responsibilityId,
          selectionStatus: text(responsibility.selectionStatus) || 'unknown',
        },
      });
    }
  }
  return { company, productName, sourceDigest, productKey, identity, indicatorRows, cardRows, optionalRows };
}

function tableColumns(db, table) {
  try {
    return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => text(row.name)));
  } catch {
    return new Set();
  }
}

function resolveCanonicalProductId(db, artifact, built, canonicalProductLookup = null) {
  const explicit = text(artifact.productIdentity?.canonicalProductId);
  if (explicit) return explicit;
  if (canonicalProductLookup instanceof Map) {
    const matched = canonicalProductLookup.get(built.identity?.productKey);
    if (matched instanceof Set && matched.size > 1) {
      throw new Error(`ambiguous canonical product identity for ${built.company} ${built.productName}`);
    }
    return matched instanceof Set ? [...matched][0] || '' : text(matched);
  }
  const columns = tableColumns(db, 'insurance_products');
  if (!columns.has('canonical_product_id') || !columns.has('company') || !columns.has('official_name')) return '';
  const candidates = db.prepare(`SELECT canonical_product_id, company, official_name
    FROM insurance_products
    WHERE trim(COALESCE(canonical_product_id, '')) != ''`).all();
  const ids = new Set(candidates.filter((row) => sameResponsibilityProduct(
    { company: row.company, productName: row.official_name },
    { company: built.company, productName: built.productName },
  )).map((row) => text(row.canonical_product_id)).filter(Boolean));
  if (ids.size > 1) throw new Error(`ambiguous canonical product identity for ${built.company} ${built.productName}`);
  return [...ids][0] || '';
}

function bindCanonicalProductId(built, canonicalProductId) {
  const resolvedCanonicalProductId = text(canonicalProductId);
  if (!resolvedCanonicalProductId) return built;
  const productKey = `canonical:${resolvedCanonicalProductId}`;
  return {
    ...built,
    canonicalProductId: resolvedCanonicalProductId,
    productKey,
    indicatorRows: built.indicatorRows.map((row) => ({
      ...row,
      payload: { ...row.payload, canonicalProductId: resolvedCanonicalProductId },
    })),
    cardRows: built.cardRows.map((row) => ({
      ...row,
      productKey,
      payload: { ...row.payload, productKey, canonicalProductId: resolvedCanonicalProductId },
    })),
    optionalRows: built.optionalRows.map((row) => ({
      ...row,
      payload: { ...row.payload, productKey, canonicalProductId: resolvedCanonicalProductId },
    })),
  };
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS insurance_indicator_records (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, coverage_type TEXT, liability TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_responsibility_cards (
      id TEXT PRIMARY KEY, product_key TEXT NOT NULL, company TEXT, product_name TEXT, title TEXT,
      category TEXT, cashflow_treatment TEXT, calculation_status TEXT, calculation_reason TEXT,
      responsibility_scope TEXT, selection_status TEXT, source_url TEXT, generated_at TEXT,
      updated_at TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS optional_responsibility_records (
      id TEXT PRIMARY KEY, company TEXT, product_name TEXT, liability TEXT, payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS product_responsibility_artifacts (
      id TEXT PRIMARY KEY, company TEXT NOT NULL, product_name TEXT NOT NULL, source_digest TEXT NOT NULL,
      source_url TEXT, published_at TEXT NOT NULL, publisher_version TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_indicator_records_product
      ON insurance_indicator_records(company, product_name);
    CREATE INDEX IF NOT EXISTS idx_responsibility_cards_product
      ON product_responsibility_cards(company, product_name);
    CREATE INDEX IF NOT EXISTS idx_optional_responsibility_records_product
      ON optional_responsibility_records(company, product_name);
    CREATE INDEX IF NOT EXISTS idx_responsibility_artifacts_product
      ON product_responsibility_artifacts(company, product_name);
  `);
  const hasCustomerSummaryTable = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_customer_responsibility_summaries'",
  ).get());
  if (hasCustomerSummaryTable) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_customer_responsibility_summaries_product
      ON product_customer_responsibility_summaries(company, product_name)`);
  }
}

function writeRows(db, artifact, built, now, equivalentProductLookup = null) {
  const { company, productName, productKey, sourceDigest } = built;
  const hasCustomerSummaryTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'product_customer_responsibility_summaries'").get());
  const equivalentRows = equivalentProductLookup instanceof Map
    ? equivalentProductLookup.get(built.identity?.productKey) || []
    : listEquivalentResponsibilityProductRows(db, {
      company: built.company,
      productName: built.productName,
    }, { includeCustomerSummaries: hasCustomerSummaryTable });
  const equivalentRowsFor = (table) => equivalentRows.filter((row) => row.table === table);
  const previous = {
    indicators: 0,
    cards: 0,
    optional: 0,
    artifacts: 0,
    customerSummaries: 0,
  };
  const insertIndicator = db.prepare(`INSERT INTO insurance_indicator_records
    (id, company, product_name, coverage_type, liability, payload) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertCard = db.prepare(`INSERT INTO product_responsibility_cards
    (id, product_key, company, product_name, title, category, cashflow_treatment, calculation_status,
     calculation_reason, responsibility_scope, selection_status, source_url, generated_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertOptional = db.prepare(`INSERT INTO optional_responsibility_records
    (id, company, product_name, liability, payload) VALUES (?, ?, ?, ?, ?)`);
  const artifactId = stableId('responsibility_artifact', sourceDigest, company, productName);
  const storedArtifact = built.canonicalProductId ? {
    ...artifact,
    productIdentity: { ...artifact.productIdentity, canonicalProductId: built.canonicalProductId },
  } : artifact;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [table, counter] of [
      ['insurance_indicator_records', 'indicators'],
      ['product_responsibility_cards', 'cards'],
      ['optional_responsibility_records', 'optional'],
      ['product_responsibility_artifacts', 'artifacts'],
      ...(hasCustomerSummaryTable ? [['product_customer_responsibility_summaries', 'customerSummaries']] : []),
    ]) {
      const remove = db.prepare(`DELETE FROM ${table} WHERE company = ? AND product_name = ?`);
      for (const row of equivalentRowsFor(table)) {
        previous[counter] += Number(remove.run(row.company, row.productName).changes || 0);
      }
    }
    for (const row of built.indicatorRows) insertIndicator.run(row.id, row.company, row.productName, row.category, row.liability, JSON.stringify(row.payload));
    for (const row of built.cardRows) insertCard.run(
      row.id, row.productKey, row.company, row.productName, row.title, row.category, row.cashflowTreatment,
      row.calculationStatus, row.calculationReason, row.responsibilityScope, row.selectionStatus,
      row.sourceUrl, now, now, JSON.stringify(row.payload),
    );
    for (const row of built.optionalRows) insertOptional.run(row.id, row.company, row.productName, row.liability, JSON.stringify(row.payload));
    db.prepare(`INSERT INTO product_responsibility_artifacts
      (id, company, product_name, source_digest, source_url, published_at, publisher_version, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      artifactId, company, productName, sourceDigest, text(artifact.productIdentity?.sourceUrl), now,
      publisherVersion, JSON.stringify(storedArtifact),
    );
    const counts = readback(db, built);
    db.exec('COMMIT');
    return { previous, counts, replacedIdentities: equivalentRows };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readback(db, built) {
  const { company, productName, sourceDigest } = built;
  const artifactRow = db.prepare(`SELECT source_digest, payload FROM product_responsibility_artifacts
    WHERE company = ? AND product_name = ?`).get(company, productName);
  const stored = JSON.parse(artifactRow?.payload || '{}');
  const counts = {
    responsibilities: rows(stored.responsibilities).length,
    indicators: Number(db.prepare('SELECT COUNT(*) AS n FROM insurance_indicator_records WHERE company = ? AND product_name = ?').get(company, productName).n),
    cards: Number(db.prepare('SELECT COUNT(*) AS n FROM product_responsibility_cards WHERE company = ? AND product_name = ?').get(company, productName).n),
    optional: Number(db.prepare('SELECT COUNT(*) AS n FROM optional_responsibility_records WHERE company = ? AND product_name = ?').get(company, productName).n),
  };
  const exact = artifactRow?.source_digest === sourceDigest
    && counts.responsibilities === built.cardRows.length
    && counts.indicators === built.indicatorRows.length
    && counts.cards === built.cardRows.length
    && counts.optional === built.optionalRows.length;
  if (!exact) throw new Error(`development database readback mismatch: ${JSON.stringify(counts)}`);
  return counts;
}

export function replaceApprovedArtifactRowsInDevelopmentDb({
  db,
  artifact,
  now = new Date().toISOString(),
  lookup = null,
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('db is required');
  if (text(artifact?.audit?.status) !== 'approved') throw new Error('only approved artifacts may replace responsibility rows');
  ensureTables(db);
  let built = buildRows(artifact, now);
  if (!built.company || !built.productName || !built.sourceDigest || !built.cardRows.length || !built.productKey) {
    throw new Error('approved artifact is missing publication identity or responsibilities');
  }
  built = bindCanonicalProductId(
    built,
    resolveCanonicalProductId(db, artifact, built, lookup?.canonicalProductLookup),
  );
  const result = writeRows(db, artifact, built, now, lookup?.equivalentProductLookup);
  return { built, ...result };
}

export async function publishDevelopmentArtifact({
  artifactPath,
  sourceDocumentPath,
  sourceTextPath,
  officialDomain,
  dbPath = '',
  existingBackupPath = '',
  write = false,
  now = new Date().toISOString(),
} = {}) {
  const artifactFile = requireFile(artifactPath, 'artifact');
  const sourceDocument = requireFile(sourceDocumentPath, 'source-document');
  const sourceText = requireFile(sourceTextPath, 'source-text');
  const resolvedDbPath = resolvePolicyOcrWriteDatabasePath({
    projectRoot,
    requestedPath: dbPath,
  });
  const validatorPath = path.join(skillDir, 'scripts', 'validate_artifact.py');
  const validatorArgs = [validatorPath, `--artifact=${artifactFile}`, `--source-document=${sourceDocument}`, `--source-text=${sourceText}`, `--official-domain=${text(officialDomain)}`];
  const validatorStdout = execFileSync('python3', validatorArgs, { encoding: 'utf8' }).trim();
  const validation = JSON.parse(validatorStdout);
  const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  if (validation.ok !== true || text(validation.status) !== 'approved' || text(artifact.audit?.status) !== 'approved') {
    throw new Error('only approved artifacts may be published');
  }
  let built = buildRows(artifact, now);
  if (!built.company || !built.productName || !built.sourceDigest || !built.cardRows.length) {
    throw new Error('approved artifact is missing publication identity or responsibilities');
  }
  if (!write) {
    if (fs.existsSync(resolvedDbPath)) {
      const readDb = new DatabaseSync(resolvedDbPath, { readOnly: true });
      try {
        built = bindCanonicalProductId(built, resolveCanonicalProductId(readDb, artifact, built));
      } finally {
        readDb.close();
      }
    }
    return {
      dryRun: true,
      validatorStdout,
      dbPath: resolvedDbPath,
      canonicalProductId: built.canonicalProductId || '',
      productKey: built.productKey,
      counts: {
        responsibilities: built.cardRows.length, indicators: built.indicatorRows.length, optional: built.optionalRows.length,
      },
    };
  }
  if (!fs.existsSync(resolvedDbPath)) throw new Error(`development database does not exist: ${resolvedDbPath}`);

  let backupPath = text(existingBackupPath) ? requireFile(existingBackupPath, 'backup-path') : '';
  if (!backupPath) {
    const backupDir = path.join(projectRoot, 'artifacts', 'development-db-backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = now.replace(/[:.]/gu, '-');
    backupPath = path.join(backupDir, `policy-ocr-before-responsibility-publish-${stamp}.sqlite`);
    const backupSource = new DatabaseSync(resolvedDbPath, { readOnly: true });
    try {
      await backup(backupSource, backupPath);
    } finally {
      backupSource.close();
    }
  }

  const db = new DatabaseSync(resolvedDbPath);
  try {
    const replacement = replaceApprovedArtifactRowsInDevelopmentDb({ db, artifact, now });
    built = replacement.built;
    const { previous: replacedRows, counts, replacedIdentities } = replacement;
    return {
      dryRun: false,
      validatorPath,
      validatorExitCode: 0,
      validatorStdout,
      databasePath: resolvedDbPath,
      developmentDbPath: resolvedDbPath,
      backupPath,
      company: built.company,
      productName: built.productName,
      canonicalProductId: built.canonicalProductId || '',
      productKey: built.productKey,
      sourceDigest: built.sourceDigest,
      responsibilityProductIdentity: built.identity,
      replacedRows,
      replacedIdentities,
      insertedRows: { indicators: built.indicatorRows.length, cards: built.cardRows.length, optional: built.optionalRows.length, artifacts: 1 },
      readbackStatus: 'passed',
      readbackCounts: counts,
    };
  } catch (error) {
    throw error;
  } finally {
    try { db.close(); } catch { /* already closed during restoration */ }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await publishDevelopmentArtifact({
    artifactPath: readArg('artifact'),
    sourceDocumentPath: readArg('source-document'),
    sourceTextPath: readArg('source-text'),
    officialDomain: readArg('official-domain'),
    dbPath: readArg('db-path', ''),
    existingBackupPath: readArg('backup-path', ''),
    write: hasFlag('write'),
  });
  console.log(JSON.stringify(result, null, 2));
}
