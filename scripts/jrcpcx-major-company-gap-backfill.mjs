import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JRCPCX_OFFICIAL_DOMAIN,
  JRCPCX_TERMS_EVIDENCE_LABEL,
  JRCPCX_TERMS_EVIDENCE_LEVEL,
  buildRowsWithAllocatedIds,
  clauseUrlOf,
  detailUrlOf,
  isHumanInsuranceProductType,
  issuerFullNameOf,
  materialIdentityKey,
  mergeDetailRowsPreferEvidence,
  normalizeClauseUrl,
  productNameOf,
  termsTextCodeOf,
  trim,
} from './ping-an-jrcpcx-backfill.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const DEFAULT_DB_PATH = path.join(runtimeDir, 'policy-ocr.sqlite');
const DEFAULT_COVERAGE_INPUT_PATH = path.join(runtimeDir, 'jrcpcx-major-company-coverage-gap.json');

export { normalizeClauseUrl };

export const TARGET_COMPANIES = Object.freeze([
  Object.freeze({
    issuerFullName: '阳光人寿保险股份有限公司',
    localCompany: '阳光人寿',
    feishuConfigPath: '.runtime/feishu-knowledge-sunshine-life.json',
    tableName: '阳光人寿',
  }),
  Object.freeze({
    issuerFullName: '中国人民人寿保险股份有限公司',
    localCompany: '人保寿险',
    feishuConfigPath: '.runtime/feishu-knowledge-picc-life.json',
    tableName: '人保寿险',
  }),
]);

function normalizeIssuerName(value = '') {
  return trim(value).replace(/\s+/gu, '');
}

export function companyConfigForIssuer(value = '') {
  const issuer = normalizeIssuerName(value);
  if (!issuer) return null;
  return TARGET_COMPANIES.find((config) => {
    return issuer === normalizeIssuerName(config.issuerFullName) || issuer === normalizeIssuerName(config.localCompany);
  }) || null;
}

function targetCompanySummaries() {
  return TARGET_COMPANIES.map((config) => ({ ...config }));
}

function timestampStamp(value = new Date().toISOString()) {
  return trim(value).replace(/[:.]/gu, '-');
}

export function buildDefaultArtifactPath(kind, generatedAt = new Date().toISOString()) {
  const suffixByKind = {
    'query-file': 'queries',
    coverage: 'coverage-gap',
    'insert-plan': 'insert-plan',
    'insert-report': 'insert-report',
  };
  const suffix = suffixByKind[kind];
  if (!suffix) throw new Error(`Unsupported artifact kind: ${kind || '(missing)'}`);
  return path.join(runtimeDir, `jrcpcx-major-company-gap-${timestampStamp(generatedAt)}-${suffix}.json`);
}

function productTypeOf(row = {}) {
  return trim(
    row.productType
      || row.queryProductType
      || row.productTypeLabel
      || row.detailFields?.产品类型
      || row.detailFields?.产品类别,
  );
}

function productStateOf(row = {}) {
  return trim(
    row.productStateLabel
      || row.productState
      || row.queryProductState
      || row.salesStatus
      || row.catalogStatus
      || row.status,
  );
}

function pdfLocalPathOf(row = {}) {
  return trim(row.pdfLocalPath || row.pdfFilePath);
}

function pdfSha256Of(row = {}) {
  return trim(row.pdfSha256 || row.pdfFileHash);
}

function issuerConfigOf(row = {}) {
  return companyConfigForIssuer(issuerFullNameOf(row));
}

export function buildJrcpcxQueriesFromGap(gap = {}) {
  const candidates = Array.isArray(gap?.missingCandidates) ? gap.missingCandidates : [];
  const seen = new Set();
  const queries = [];
  for (const candidate of candidates) {
    const config = issuerConfigOf(candidate);
    const productName = productNameOf(candidate);
    const productType = productTypeOf(candidate);
    if (!config || !productName || !isHumanInsuranceProductType(productType)) continue;

    const productStateLabel = productStateOf(candidate);
    const key = [config.issuerFullName, productName, productStateLabel].join('\u001f');
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({
      deptName: config.issuerFullName,
      productName,
      productTypeLabel: '人身保险类',
      productTermLabel: '全部',
      productStateLabel,
    });
  }
  return queries;
}

export function eligibleForAutoInsert(row = {}) {
  const reasons = [];
  const config = issuerConfigOf(row);
  const productName = productNameOf(row);
  const productType = productTypeOf(row);
  const qualityStatus = trim(row.qualityStatus || row.responsibilityQualityStatus);
  const pdfLocalPath = pdfLocalPathOf(row);

  if (!config) reasons.push('issuer_not_target');
  if (!productName) reasons.push('missing_product_name');
  if (!isHumanInsuranceProductType(productType)) reasons.push(productType ? 'not_human_insurance' : 'missing_product_type');
  if (!detailUrlOf(row)) reasons.push('missing_detail_url');
  if (!clauseUrlOf(row)) reasons.push('missing_clause_url');
  if (!pdfLocalPath) reasons.push('missing_pdf_local_path');
  if (pdfLocalPath && !fs.existsSync(pdfLocalPath)) reasons.push('pdf_file_not_found');
  if (!pdfSha256Of(row)) reasons.push('missing_pdf_sha256');
  if (!trim(row.pageText)) reasons.push('missing_page_text');
  if (!['valid_complete', 'valid_partial'].includes(qualityStatus)) reasons.push(`quality_${qualityStatus || 'blank'}`);

  return { eligible: reasons.length === 0, reasons };
}

export function buildKnowledgeRecordFromJrcpcx(row = {}) {
  const config = issuerConfigOf(row);
  const productName = productNameOf(row);
  const productType = productTypeOf(row);
  const qualityStatus = trim(row.qualityStatus || row.responsibilityQualityStatus);
  const pdfLocalPath = pdfLocalPathOf(row);
  const pdfSha256 = pdfSha256Of(row);
  const clauseUrl = clauseUrlOf(row);
  const detailUrl = detailUrlOf(row);
  return {
    company: config?.issuerFullName || issuerFullNameOf(row),
    productName,
    productType,
    salesStatus: productStateOf(row),
    title: trim(row.title) || `${productName}条款`,
    url: clauseUrl,
    snippet: trim(row.snippet) || `${JRCPCX_TERMS_EVIDENCE_LABEL}，已截取保险责任正文段。`,
    pageText: trim(row.pageText),
    sourceType: 'pdf',
    materialType: 'terms',
    official: true,
    evidenceLabel: JRCPCX_TERMS_EVIDENCE_LABEL,
    evidenceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
    officialDomain: JRCPCX_OFFICIAL_DOMAIN,
    parser: trim(row.parser) || 'jrcpcx_life_ins_detail',
    versionNo: termsTextCodeOf(row),
    catalogStatus: productStateOf(row),
    seedSource: 'jrcpcx_major_company_material_backfill',
    seedSourceUrl: detailUrl,
    qualityStatus,
    qualityReason: trim(row.qualityReason),
    responsibilityQualityStatus: qualityStatus,
    pages: Number(row.pages || 0) || 0,
    bytes: Number(row.bytes || row.pdfBytes || 0) || 0,
    contentType: trim(row.contentType),
    pdfLocalPath,
    pdfFilePath: pdfLocalPath,
    pdfSha256,
    pdfFileHash: pdfSha256,
    evidence: row.evidence,
    pdfBytes: Number(row.pdfBytes || row.bytes || 0) || 0,
    pdfOriginalUrl: trim(row.pdfOriginalUrl || row.clauseUrl),
    pdfArchivedAt: trim(row.pdfArchivedAt),
  };
}

function normalizedUrlSet(urls = []) {
  const values = urls instanceof Set ? [...urls] : (Array.isArray(urls) ? urls : []);
  return new Set(
    values
      .map((value) => {
        if (typeof value === 'string') return normalizeClauseUrl(value);
        return normalizeClauseUrl(value?.url || value?.clauseUrl || value?.pdfOriginalUrl);
      })
      .filter(Boolean),
  );
}

function skippedInsertRow(row = {}, reason, reasons = [reason]) {
  return {
    reason,
    reasons,
    issuerFullName: issuerFullNameOf(row),
    productName: productNameOf(row),
    clauseUrl: clauseUrlOf(row),
    detailUrl: detailUrlOf(row),
    materialIdentityKey: materialIdentityKey(row),
  };
}

function skippedCoverageRow(item = {}, reasons = []) {
  return {
    ...item,
    reason: reasons[0] || 'out_of_scope',
    reasons,
  };
}

function isOutOfScopeEligibility(reasons = []) {
  return reasons.includes('issuer_not_target') || reasons.includes('not_human_insurance');
}

export function buildInsertPlan({ insertable = [], existingUrls = [] } = {}) {
  const existingUrlSet = normalizedUrlSet(existingUrls);
  const recordsToInsert = [];
  const skipped = [];
  for (const row of Array.isArray(insertable) ? insertable : []) {
    const eligibility = eligibleForAutoInsert(row);
    if (!eligibility.eligible) {
      skipped.push(skippedInsertRow(row, eligibility.reasons[0] || 'ineligible', eligibility.reasons));
      continue;
    }
    const clauseUrl = clauseUrlOf(row);
    if (clauseUrl && existingUrlSet.has(clauseUrl)) {
      skipped.push(skippedInsertRow(row, 'existing_url'));
      continue;
    }
    recordsToInsert.push(buildKnowledgeRecordFromJrcpcx(row));
  }
  return { recordsToInsert, skipped };
}

export function buildCoverageGapReport({
  localRecords = [],
  detailRows = [],
  unresolvedShards = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const localUrls = normalizedUrlSet(localRecords);
  const represented = [];
  const insertable = [];
  const manualReview = [];
  const invalid = [];
  const skipped = [];

  for (const row of mergeDetailRowsPreferEvidence(detailRows)) {
    const clauseUrl = clauseUrlOf(row);
    const eligibility = eligibleForAutoInsert(row);
    const item = {
      ...row,
      issuerFullName: issuerFullNameOf(row),
      productName: productNameOf(row),
      productType: productTypeOf(row),
      clauseUrl,
      detailUrl: detailUrlOf(row),
      versionNo: termsTextCodeOf(row),
      materialIdentityKey: materialIdentityKey(row),
      eligibilityReasons: eligibility.reasons,
    };
    if (isOutOfScopeEligibility(eligibility.reasons)) skipped.push(skippedCoverageRow(item, eligibility.reasons));
    else if (clauseUrl && localUrls.has(clauseUrl)) represented.push(item);
    else if (eligibility.eligible) insertable.push(item);
    else if (['invalid_empty', 'invalid_non_responsibility', 'suspect_needs_source_check'].includes(trim(row.qualityStatus))) invalid.push(item);
    else manualReview.push(item);
  }

  return {
    schemaVersion: 'jrcpcx-major-company-coverage-gap/v1',
    generatedAt,
    targetCompanies: targetCompanySummaries(),
    summary: {
      localRecordCount: Array.isArray(localRecords) ? localRecords.length : 0,
      detailRowCount: Array.isArray(detailRows) ? detailRows.length : 0,
      representedCount: represented.length,
      insertableCount: insertable.length,
      manualReviewCount: manualReview.length,
      invalidCount: invalid.length,
      skippedCount: skipped.length,
      unresolvedShardCount: Array.isArray(unresolvedShards) ? unresolvedShards.length : 0,
    },
    represented,
    insertable,
    manualReview,
    invalid,
    skipped,
    unresolvedShards,
  };
}

function recordCompanyOf(row = {}) {
  return trim(row.company || row.issuerFullName) || 'unknown';
}

function emptyCompanyInsertSummary() {
  return {
    plannedCount: 0,
    insertedCount: 0,
    insertedMinId: null,
    insertedMaxId: null,
  };
}

function buildByCompanyInsertSummary({ plannedRows = [], savedRows = [] } = {}) {
  const byCompany = {};
  for (const config of TARGET_COMPANIES) byCompany[config.issuerFullName] = emptyCompanyInsertSummary();
  for (const row of Array.isArray(plannedRows) ? plannedRows : []) {
    const company = recordCompanyOf(row);
    if (!byCompany[company]) byCompany[company] = emptyCompanyInsertSummary();
    byCompany[company].plannedCount += 1;
  }
  for (const row of Array.isArray(savedRows) ? savedRows : []) {
    const company = recordCompanyOf(row);
    if (!byCompany[company]) byCompany[company] = emptyCompanyInsertSummary();
    byCompany[company].insertedCount += 1;
    const id = Number(row?.id || 0);
    if (Number.isFinite(id) && id > 0) {
      byCompany[company].insertedMinId = byCompany[company].insertedMinId === null
        ? id
        : Math.min(byCompany[company].insertedMinId, id);
      byCompany[company].insertedMaxId = byCompany[company].insertedMaxId === null
        ? id
        : Math.max(byCompany[company].insertedMaxId, id);
    }
  }
  return byCompany;
}

export function buildInsertReport({
  generatedAt = new Date().toISOString(),
  dryRun = false,
  dbPath = '',
  dbBackupPath = '',
  before = null,
  after = null,
  recordsToInsert = [],
  saved = [],
  skipped = [],
} = {}) {
  const savedRows = Array.isArray(saved) ? saved : [];
  const skippedRows = Array.isArray(skipped) ? skipped : [];
  const plannedRows = Array.isArray(recordsToInsert) ? recordsToInsert : savedRows;
  const insertedIds = savedRows
    .map((row) => Number(row?.id || 0))
    .filter((id) => Number.isFinite(id) && id > 0);
  const byCompany = buildByCompanyInsertSummary({
    plannedRows,
    savedRows,
  });
  return {
    schemaVersion: 'jrcpcx-major-company-insert-report/v1',
    generatedAt,
    dryRun: Boolean(dryRun),
    dbPath: trim(dbPath),
    dbBackupPath: trim(dbBackupPath),
    targetCompanies: targetCompanySummaries(),
    before,
    after,
    plannedInsertCount: plannedRows.length,
    insertedCount: savedRows.length,
    insertedMinId: insertedIds.length ? Math.min(...insertedIds) : null,
    insertedMaxId: insertedIds.length ? Math.max(...insertedIds) : null,
    byCompany,
    skippedCount: skippedRows.length,
    skipped: skippedRows,
    saved: savedRows,
    recordsToInsert: plannedRows,
  };
}

function rowsOf(value = {}) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.records)) return value.records;
  if (Array.isArray(value.detailRows)) return value.detailRows;
  if (Array.isArray(value.rows)) return value.rows;
  if (Array.isArray(value.products)) return value.products;
  if (Array.isArray(value.candidates)) return value.candidates;
  return [];
}

function detailRowsFromInput(input = {}) {
  if (Array.isArray(input?.records)) return input.records;
  if (Array.isArray(input?.detailRows)) return input.detailRows;
  return rowsOf(input);
}

function insertableRowsFromCoverage(coverage = {}) {
  if (Array.isArray(coverage?.insertable)) return coverage.insertable;
  if (Array.isArray(coverage?.coverageGap?.insertable)) return coverage.coverageGap.insertable;
  if (Array.isArray(coverage?.records)) return coverage.records;
  if (Array.isArray(coverage?.detailRows)) return coverage.detailRows;
  return [];
}

function parseCliArgs(argv = []) {
  const args = {};
  const booleanArgs = new Set(['pretty', 'write']);
  const booleanValue = (value) => !['false', '0', 'no'].includes(trim(value).toLowerCase());
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (booleanArgs.has(key) && inlineValue === undefined) {
      args[key] = true;
      continue;
    }
    if (booleanArgs.has(key)) {
      args[key] = booleanValue(inlineValue);
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    args[key] = value;
  }
  return args;
}

function writeJsonFile(filePath, value, pretty = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function buildSqliteBackupPath(dbPath, generatedAt = new Date().toISOString()) {
  return `${dbPath}.backup-before-jrcpcx-major-company-gap-${timestampStamp(generatedAt)}`;
}

export function backupSqliteFile(dbPath, generatedAt = new Date().toISOString()) {
  const backupPath = buildSqliteBackupPath(dbPath, generatedAt);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${backupPath}${suffix}`);
  }
  return backupPath;
}

async function openKnowledgeStore(dbPath) {
  const { createKnowledgeStateStore } = await import('./runtime-knowledge-state.mjs');
  return createKnowledgeStateStore({ dbPath });
}

async function buildCoverageFromStore({ input, dbPath, generatedAt }) {
  const knowledgeStore = await openKnowledgeStore(dbPath);
  try {
    const state = knowledgeStore.loadState();
    return {
      ...buildCoverageGapReport({
        generatedAt,
        localRecords: state.knowledgeRecords,
        detailRows: detailRowsFromInput(input),
        unresolvedShards: input.unresolvedShards || input.summary?.unresolvedShards || [],
      }),
      dbPath: knowledgeStore.dbPath,
    };
  } finally {
    knowledgeStore.close();
  }
}

async function buildInsertReportFromStore({ coverage, dbPath, dbBackupPath = '', generatedAt, write = false }) {
  const [{ allocateId }, knowledgeStore] = await Promise.all([
    import('../server/policy-ocr.domain.mjs'),
    openKnowledgeStore(dbPath),
  ]);
  try {
    const before = knowledgeStore.countKnowledgeRecords();
    const plan = buildInsertPlan({
      insertable: insertableRowsFromCoverage(coverage),
      existingUrls: knowledgeStore.allKnownUrls(),
    });
    if (!write) {
      return buildInsertReport({
        generatedAt,
        dryRun: true,
        dbPath: knowledgeStore.dbPath,
        dbBackupPath,
        before,
        after: before,
        recordsToInsert: plan.recordsToInsert,
        saved: [],
        skipped: plan.skipped,
      });
    }

    const state = knowledgeStore.loadState();
    const { saved, nextId } = buildRowsWithAllocatedIds({
      state,
      recordsToInsert: plan.recordsToInsert,
      allocateId,
    });
    knowledgeStore.upsertRows(saved, { nextId });
    const after = knowledgeStore.countKnowledgeRecords();
    return buildInsertReport({
      generatedAt,
      dryRun: false,
      dbPath: knowledgeStore.dbPath,
      dbBackupPath,
      before,
      after,
      recordsToInsert: plan.recordsToInsert,
      saved,
      skipped: plan.skipped,
    });
  } finally {
    knowledgeStore.close();
  }
}

async function runQueryFileCli(args) {
  const generatedAt = new Date().toISOString();
  const gapArg = args['gap-path'] || args.input;
  if (!gapArg) throw new Error('Missing --gap-path <json>');
  const gapPath = path.resolve(gapArg);
  const artifact = {
    schemaVersion: 'jrcpcx-major-company-query-file/v1',
    generatedAt,
    sourceGapPath: gapPath,
    targetCompanies: targetCompanySummaries(),
    queries: buildJrcpcxQueriesFromGap(readJsonFile(gapPath)),
  };
  const outputPath = path.resolve(args.output || buildDefaultArtifactPath('query-file', generatedAt));
  writeJsonFile(outputPath, artifact, Boolean(args.pretty));
  process.stdout.write(`${JSON.stringify({ queryCount: artifact.queries.length }, null, 2)}\n`);
  return artifact;
}

async function runCoverageCli(args) {
  const generatedAt = new Date().toISOString();
  if (!args.input) throw new Error('Missing --input <json>');
  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output || buildDefaultArtifactPath('coverage', generatedAt));
  const dbPath = path.resolve(args['db-path'] || process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH);
  const input = readJsonFile(inputPath);
  const artifact = {
    ...(await buildCoverageFromStore({ input, dbPath, generatedAt: input.generatedAt || generatedAt })),
    sourceInputPath: inputPath,
  };
  writeJsonFile(outputPath, artifact, Boolean(args.pretty));
  process.stdout.write(`${JSON.stringify(artifact.summary || {}, null, 2)}\n`);
  return artifact;
}

async function runInsertCli(args) {
  const generatedAt = new Date().toISOString();
  const coveragePath = path.resolve(args['coverage-path'] || args.input || DEFAULT_COVERAGE_INPUT_PATH);
  const outputPath = path.resolve(args.output || buildDefaultArtifactPath(args.write ? 'insert-report' : 'insert-plan', generatedAt));
  const dbPath = path.resolve(args['db-path'] || process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH);
  const coverage = readJsonFile(coveragePath);
  if (args.write && !fs.existsSync(dbPath)) throw new Error(`SQLite DB not found: ${dbPath}`);
  const dbBackupPath = args.write ? backupSqliteFile(dbPath, generatedAt) : '';
  const artifact = await buildInsertReportFromStore({
    coverage,
    dbPath,
    dbBackupPath,
    generatedAt: coverage.generatedAt || generatedAt,
    write: Boolean(args.write),
  });
  writeJsonFile(outputPath, artifact, Boolean(args.pretty));
  process.stdout.write(`${JSON.stringify(artifact, null, 2)}\n`);
  return artifact;
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.mode === 'query-file') return runQueryFileCli(args);
  if (args.mode === 'coverage') return runCoverageCli(args);
  if (args.mode === 'insert') return runInsertCli(args);
  throw new Error(`Unsupported --mode ${args.mode || '(missing)'}. Use query-file, coverage, or insert.`);
}

if (process.argv[1] && __filename === fs.realpathSync(process.argv[1])) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
