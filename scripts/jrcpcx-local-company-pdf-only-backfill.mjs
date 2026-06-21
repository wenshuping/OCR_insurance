import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPdfOnlyReport,
  normalizeClauseUrl,
  validatePdfOnlyReport,
} from './jrcpcx-major-company-gap-backfill.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const DEFAULT_DB_PATH = path.join(runtimeDir, 'policy-ocr.sqlite');
const DEFAULT_STATUS_SHARDS = Object.freeze(['在售', '停售', '停用']);
const INVENTORY_CSV_HEADERS = Object.freeze([
  'company',
  'localCompanyName',
  'submittedDeptName',
  'localKnowledgeRecordCount',
  'localHumanInsuranceEvidenceCount',
  'localJrcpcxClauseUrlCount',
  'localPdfPathCount',
  'included',
  'excludeReason',
]);
const QUERY_CSV_HEADERS = Object.freeze([
  'deptName',
  'localCompanyName',
  'productTypeLabel',
  'productTermLabel',
  'productStateLabel',
]);
const PDF_ONLY_HEADERS = Object.freeze([
  'status',
  'reason',
  'localCompanyName',
  'submittedDeptName',
  'issuerFullName',
  'productName',
  'productType',
  'productState',
  'industryCode',
  'detailUrl',
  'clauseUrl',
  'normalizedClauseUrl',
  'clauseFileName',
  'pdfOriginalUrl',
  'pdfLocalPath',
  'pdfFileName',
  'pdfSha256',
  'pdfBytes',
  'pdfContentType',
  'pdfArchivedAt',
  'suggestedReadableName',
  'futureExtractionStatus',
  'responsibilityDeferred',
  'sourceAttemptFile',
  'skipEvidence',
  'existingUrl',
  'existingHash',
  'duplicateOf',
  'existingPdfPathExists',
  'actualPdfSha256',
  'actualPdfBytes',
  'pdfSha256MatchesFile',
  'sourceKnowledgeRecordId',
  'sourceKnowledgeCompany',
  'sourceKnowledgeProductName',
  'sourceKnowledgeUrl',
]);
const CATALOG_HEADERS = Object.freeze([
  'localCompanyName',
  'submittedDeptName',
  'issuerFullName',
  'productName',
  'productType',
  'productState',
  'industryCode',
  'detailUrl',
  'clauseUrl',
  'normalizedClauseUrl',
  'clauseFileName',
]);

function trim(value = '') {
  return String(value || '').trim();
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

export function timestampStamp(value = new Date().toISOString()) {
  return trim(value).replace(/[:.]/gu, '-');
}

export function parseCliArgs(argv = []) {
  const args = {};
  const booleanArgs = new Set(['pretty']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (booleanArgs.has(key) && inlineValue === undefined) {
      args[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && !booleanArgs.has(key)) index += 1;
    args[key] = value;
  }
  return args;
}

export function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

export function writeJsonFile(filePath, value, pretty = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function inventoryFromArtifact(filePath) {
  const input = readJsonFile(filePath);
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.inventory)) return input.inventory;
  throw new Error(`Inventory file must contain an inventory array: ${filePath}`);
}

export function writeCsvFile(filePath, rows = [], headers = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [`\ufeff${headers.join(',')}`];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

function productNameOf(row = {}) {
  return trim(row.productName || row.product_name || row.name || row.payload?.productName);
}

function productTypeOf(row = {}) {
  return trim(row.productType || row.product_type || row.payload?.productType || row.detailFields?.产品类别 || row.detailFields?.产品类型);
}

function productStateOf(row = {}) {
  return trim(row.productState || row.product_state || row.salesStatus || row.payload?.productState || row.payload?.salesStatus || row.detailFields?.销售状态 || row.detailFields?.产品状态);
}

function industryCodeOf(row = {}) {
  return trim(row.industryCode || row.industry_code || row.versionNo || row.payload?.industryCode || row.payload?.versionNo || row.detailFields?.产品条款文字编码 || row.detailFields?.条款文字编码);
}

function pageTextOf(row = {}) {
  return trim(row.pageText || row.payload?.pageText || row.snippet || row.payload?.snippet);
}

function pdfLocalPathOf(row = {}) {
  return trim(row.pdfLocalPath || row.pdfFilePath || row.payload?.pdfLocalPath || row.payload?.pdfFilePath);
}

function companyOf(row = {}) {
  return trim(row.company || row.issuerFullName || row.payload?.company || row.payload?.issuerFullName);
}

function localCompanyNameOf(row = {}) {
  return trim(row.localCompanyName || row.local_company_name || row.payload?.localCompanyName || row.payload?.local_company_name);
}

function submittedDeptNameOf(row = {}) {
  return trim(row.submittedDeptName || row.submitted_dept_name || row.payload?.submittedDeptName || row.payload?.submitted_dept_name);
}

const STRONG_HUMAN_INSURANCE_RE = /人身保险|人寿|寿险|健康保险|疾病保险|医疗保险|意外|年金|养老|两全|终身寿|定期寿|护理|重疾|少儿|教育金/iu;
const PROPERTY_INSURANCE_RE = /财产保险|财险|车险|机动车|责任保险|保证保险|信用保险|农业保险|货运|船舶|工程保险|企业财产/iu;

function evidenceTextOf(row = {}) {
  return [companyOf(row), productNameOf(row), productTypeOf(row), pageTextOf(row)].filter(Boolean).join(' ');
}

function materialSignalTextOf(row = {}) {
  return [productNameOf(row), productTypeOf(row), pageTextOf(row)].filter(Boolean).join(' ');
}

function hasPropertyInsuranceEvidence(row = {}) {
  return PROPERTY_INSURANCE_RE.test(materialSignalTextOf(row));
}

export function isHumanInsuranceEvidence(row = {}) {
  const text = evidenceTextOf(row);
  if (!text) return false;
  const materialText = materialSignalTextOf(row);
  const hasStrongHumanEvidence = STRONG_HUMAN_INSURANCE_RE.test(materialText);
  if (hasPropertyInsuranceEvidence(row) && !hasStrongHumanEvidence) return false;
  return hasStrongHumanEvidence;
}

function jrcpcxClauseUrlsOf(row = {}) {
  const urls = new Set();
  for (const value of [
    row.clauseUrl,
    row.payload?.clauseUrl,
    row.clause_url,
    row.payload?.clause_url,
    row.normalizedClauseUrl,
    row.payload?.normalizedClauseUrl,
    row.normalized_clause_url,
    row.payload?.normalized_clause_url,
    row.pdfOriginalUrl,
    row.payload?.pdfOriginalUrl,
    row.pdf_original_url,
    row.payload?.pdf_original_url,
    row.url,
    row.payload?.url,
    row.sourceKnowledgeUrl,
    row.payload?.sourceKnowledgeUrl,
    row.source_knowledge_url,
    row.payload?.source_knowledge_url,
  ]) {
    const normalized = normalizeClauseUrl(value);
    if (normalized) urls.add(normalized);
  }
  return [...urls];
}

function companySummaryFromRows(company, rows = []) {
  const localJrcpcxClauseUrlCount = new Set(rows.flatMap((row) => jrcpcxClauseUrlsOf(row))).size;
  const localPdfPathCount = rows.filter((row) => pdfLocalPathOf(row)).length;
  const localHumanInsuranceEvidenceCount = rows.filter((row) => isHumanInsuranceEvidence(row)).length;
  const hasPropertyOnlyEvidence = rows.length > 0 && localHumanInsuranceEvidenceCount === 0 && rows.every((row) => hasPropertyInsuranceEvidence(row));
  const included = localHumanInsuranceEvidenceCount > 0;
  const localCompanyName = rows.map((row) => localCompanyNameOf(row)).find(Boolean) || company;
  const submittedDeptName = rows.map((row) => submittedDeptNameOf(row)).find(Boolean) || company;
  return {
    company,
    localCompanyName,
    submittedDeptName,
    localKnowledgeRecordCount: rows.length,
    localHumanInsuranceEvidenceCount,
    localJrcpcxClauseUrlCount,
    localPdfPathCount,
    included,
    excludeReason: included ? '' : (hasPropertyOnlyEvidence ? 'property_insurance_only' : 'no_human_insurance_evidence'),
  };
}

export function buildLocalCompanyInventory(records = []) {
  const byCompany = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    const payload = raw.payload && typeof raw.payload === 'string' ? parseJson(raw.payload, {}) : (raw.payload || {});
    const row = { ...payload, ...raw, payload };
    const company = companyOf(row);
    if (!company) continue;
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push(row);
  }
  return [...byCompany.entries()]
    .map(([company, rows]) => companySummaryFromRows(company, rows))
    .sort((a, b) => {
      if (a.included !== b.included) return a.included ? -1 : 1;
      return b.localKnowledgeRecordCount - a.localKnowledgeRecordCount || a.company.localeCompare(b.company, 'zh-Hans-CN');
    });
}

export function buildLocalCompanyQueries(inventory = [], statusLabels = DEFAULT_STATUS_SHARDS) {
  const queries = [];
  for (const company of Array.isArray(inventory) ? inventory : []) {
    if (!company.included) continue;
    for (const productStateLabel of statusLabels) {
      queries.push({
        deptName: trim(company.submittedDeptName || company.company),
        localCompanyName: trim(company.localCompanyName || company.company),
        productTypeLabel: '人身保险类',
        productTermLabel: '全部',
        productStateLabel,
      });
    }
  }
  return queries;
}

function companyKey(value = '') {
  return trim(value).replace(/\s+/gu, '');
}

function companySlug(value = '') {
  return trim(value)
    .replace(/[\\/:*?"<>|]+/gu, '_')
    .replace(/\s+/gu, '')
    .slice(0, 80) || 'unknown-company';
}

function inventoryMaps(inventory = []) {
  const bySubmitted = new Map();
  const byLocal = new Map();
  for (const row of Array.isArray(inventory) ? inventory : []) {
    if (row.submittedDeptName) bySubmitted.set(companyKey(row.submittedDeptName), row);
    if (row.company) byLocal.set(companyKey(row.company), row);
    if (row.localCompanyName) byLocal.set(companyKey(row.localCompanyName), row);
  }
  return { bySubmitted, byLocal };
}

function attachLocalCompanyMetadata(rows = [], inventory = []) {
  const { bySubmitted, byLocal } = inventoryMaps(inventory);
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const issuerFullName = trim(row.issuerFullName || row.company);
    const inventoryRow = bySubmitted.get(companyKey(issuerFullName)) || byLocal.get(companyKey(issuerFullName)) || {};
    return {
      ...row,
      issuerFullName,
      localCompanyName: trim(inventoryRow.localCompanyName || inventoryRow.company || issuerFullName),
      submittedDeptName: trim(inventoryRow.submittedDeptName || issuerFullName),
    };
  });
}

function countByLocalCompany(rows = []) {
  const counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const company = trim(row.localCompanyName || row.issuerFullName || row.company) || '未知机构';
    counts[company] = (counts[company] || 0) + 1;
  }
  return counts;
}

function localCandidateMaterialKey(row = {}) {
  return [
    trim(row.detailUrl),
    normalizeClauseUrl(row.normalizedClauseUrl || row.clauseUrl || row.pdfOriginalUrl),
    trim(row.productName),
    trim(row.industryCode),
  ].filter(Boolean).join('\u001f');
}

function countUniqueCandidateMaterialsByLocalCompany(rows = []) {
  const keysByCompany = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const company = trim(row.localCompanyName || row.issuerFullName || row.company) || '未知机构';
    const key = localCandidateMaterialKey(row);
    if (!key) continue;
    if (!keysByCompany[company]) keysByCompany[company] = new Set();
    keysByCompany[company].add(key);
  }
  const counts = {};
  for (const [company, keys] of Object.entries(keysByCompany)) counts[company] = keys.size;
  return counts;
}

function isUrlRepresentedRow(row = {}) {
  return ['existing_url', 'represented_url', 'represented_local_url'].includes(trim(row.reason));
}

function isHashRepresentedRow(row = {}) {
  return /hash/iu.test(trim(row.reason));
}

function buildLocalByCompanySummary({
  catalog = [],
  downloaded = [],
  skippedExisting = [],
  existingPdfManifest = [],
  blocked = [],
  unresolvedTruncatedShards = [],
} = {}) {
  const candidateRows = [...catalog, ...downloaded, ...skippedExisting, ...blocked];
  const representedUrl = skippedExisting.filter(isUrlRepresentedRow);
  const representedHash = skippedExisting.filter(isHashRepresentedRow);
  const missingPdfPath = [
    ...downloaded.filter((row) => !trim(row.pdfLocalPath)),
    ...blocked.filter((row) => trim(row.reason) === 'missing_pdf_local_path'),
  ];
  const missingExistingPdfPath = skippedExisting.filter((row) => !trim(row.pdfLocalPath));
  const missingExistingPdfFile = skippedExisting.filter((row) => trim(row.pdfLocalPath) && row.existingPdfPathExists === false);
  const existingPdfSha256Mismatch = skippedExisting.filter((row) => trim(row.pdfSha256) && trim(row.actualPdfSha256) && trim(row.pdfSha256) !== trim(row.actualPdfSha256));
  return {
    catalog: countByLocalCompany(catalog),
    uniqueCandidateMaterials: countUniqueCandidateMaterialsByLocalCompany(candidateRows),
    downloaded: countByLocalCompany(downloaded),
    skippedExisting: countByLocalCompany(skippedExisting),
    blocked: countByLocalCompany(blocked),
    failed: countByLocalCompany(blocked),
    representedUrl: countByLocalCompany(representedUrl),
    representedHash: countByLocalCompany(representedHash),
    missingPdfPath: countByLocalCompany(missingPdfPath),
    existingPdfManifest: countByLocalCompany(existingPdfManifest),
    missingExistingPdfPath: countByLocalCompany(missingExistingPdfPath),
    missingExistingPdfFile: countByLocalCompany(missingExistingPdfFile),
    existingPdfSha256Mismatch: countByLocalCompany(existingPdfSha256Mismatch),
    unresolvedTruncatedShards: countByLocalCompany(unresolvedTruncatedShards),
  };
}

export function buildLocalCompanyPdfOnlyReport({
  crawlResult = {},
  inventory = [],
  localPdfRecords = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseReport = buildPdfOnlyReport({
    crawlResult,
    generatedAt,
    localPdfRecords,
  });
  const catalog = attachLocalCompanyMetadata(baseReport.catalog || [], inventory);
  const downloaded = attachLocalCompanyMetadata(baseReport.downloaded || [], inventory);
  const skippedExisting = attachLocalCompanyMetadata(baseReport.skippedExisting || [], inventory);
  const existingPdfManifest = attachLocalCompanyMetadata(baseReport.existingPdfManifest || [], inventory);
  const blocked = attachLocalCompanyMetadata(baseReport.blocked || [], inventory);
  const unresolvedTruncatedShards = attachLocalCompanyMetadata(baseReport.unresolvedTruncatedShards || [], inventory);
  const includedCompanyCount = inventory.filter((row) => row.included).length;
  const excludedCompanyCount = inventory.filter((row) => !row.included).length;
  return {
    ...baseReport,
    schemaVersion: 'jrcpcx-local-company-pdf-only/v1',
    companyInventory: inventory,
    summary: {
      ...baseReport.summary,
      localCompanyCount: inventory.length,
      includedCompanyCount,
      excludedCompanyCount,
      byCompany: buildLocalByCompanySummary({ catalog, downloaded, skippedExisting, existingPdfManifest, blocked, unresolvedTruncatedShards }),
    },
    catalog,
    downloaded,
    skippedExisting,
    existingPdfManifest,
    blocked,
    unresolvedTruncatedShards,
  };
}

function catalogCsvRow(row = {}) {
  const clauseUrl = normalizeClauseUrl(row.clauseUrl || row.normalizedClauseUrl || row.pdfOriginalUrl);
  return {
    ...row,
    localCompanyName: trim(row.localCompanyName),
    submittedDeptName: trim(row.submittedDeptName),
    issuerFullName: trim(row.issuerFullName || row.company),
    productName: productNameOf(row),
    productType: productTypeOf(row),
    productState: productStateOf(row),
    industryCode: industryCodeOf(row),
    detailUrl: trim(row.detailUrl),
    clauseUrl: clauseUrl || trim(row.clauseUrl),
    normalizedClauseUrl: clauseUrl || trim(row.normalizedClauseUrl),
    clauseFileName: trim(row.clauseFileName || row.fileName),
  };
}

function rowsForLocalCompany(rows = [], company = '') {
  const wanted = companyKey(company);
  return (Array.isArray(rows) ? rows : []).filter((row) => companyKey(row.localCompanyName || row.issuerFullName || row.company) === wanted);
}

export function writeLocalCompanyPdfOnlyArtifacts({
  report,
  outputDir = runtimeDir,
  batchName = `jrcpcx-local-company-pdf-only-${timestampStamp(report?.generatedAt || new Date().toISOString())}`,
  pretty = false,
} = {}) {
  const aggregate = {
    summaryJson: path.join(outputDir, `${batchName}-summary.json`),
    catalogJson: path.join(outputDir, `${batchName}-catalog.json`),
    catalogCsv: path.join(outputDir, `${batchName}-catalog.csv`),
    downloadedJson: path.join(outputDir, `${batchName}-downloaded.json`),
    downloadedCsv: path.join(outputDir, `${batchName}-downloaded.csv`),
    existingPdfManifestJson: path.join(outputDir, `${batchName}-existing-pdf-manifest.json`),
    existingPdfManifestCsv: path.join(outputDir, `${batchName}-existing-pdf-manifest.csv`),
    skippedExistingJson: path.join(outputDir, `${batchName}-skipped-existing.json`),
    skippedExistingCsv: path.join(outputDir, `${batchName}-skipped-existing.csv`),
    blockedJson: path.join(outputDir, `${batchName}-blocked.json`),
    blockedCsv: path.join(outputDir, `${batchName}-blocked.csv`),
  };

  writeJsonFile(aggregate.summaryJson, { ...report, catalog: undefined, downloaded: undefined, existingPdfManifest: undefined, skippedExisting: undefined, blocked: undefined }, pretty);
  writeJsonFile(aggregate.catalogJson, report.catalog || [], pretty);
  writeCsvFile(aggregate.catalogCsv, (report.catalog || []).map(catalogCsvRow), CATALOG_HEADERS);
  writeJsonFile(aggregate.downloadedJson, report.downloaded || [], pretty);
  writeCsvFile(aggregate.downloadedCsv, report.downloaded || [], PDF_ONLY_HEADERS);
  writeJsonFile(aggregate.existingPdfManifestJson, report.existingPdfManifest || [], pretty);
  writeCsvFile(aggregate.existingPdfManifestCsv, report.existingPdfManifest || [], PDF_ONLY_HEADERS);
  writeJsonFile(aggregate.skippedExistingJson, report.skippedExisting || [], pretty);
  writeCsvFile(aggregate.skippedExistingCsv, report.skippedExisting || [], PDF_ONLY_HEADERS);
  writeJsonFile(aggregate.blockedJson, report.blocked || [], pretty);
  writeCsvFile(aggregate.blockedCsv, report.blocked || [], PDF_ONLY_HEADERS);

  const byCompany = {};
  for (const company of report.companyInventory || []) {
    const name = trim(company.localCompanyName || company.company);
    if (!name) continue;
    const prefix = path.join(outputDir, `${batchName}-${companySlug(name)}`);
    const companyFiles = {
      summaryJson: `${prefix}-summary.json`,
      catalogJson: `${prefix}-catalog.json`,
      catalogCsv: `${prefix}-catalog.csv`,
      downloadedJson: `${prefix}-downloaded.json`,
      downloadedCsv: `${prefix}-downloaded.csv`,
      existingPdfManifestJson: `${prefix}-existing-pdf-manifest.json`,
      existingPdfManifestCsv: `${prefix}-existing-pdf-manifest.csv`,
      skippedExistingJson: `${prefix}-skipped-existing.json`,
      skippedExistingCsv: `${prefix}-skipped-existing.csv`,
      blockedJson: `${prefix}-blocked.json`,
      blockedCsv: `${prefix}-blocked.csv`,
    };
    const catalog = rowsForLocalCompany(report.catalog || [], name);
    const downloaded = rowsForLocalCompany(report.downloaded || [], name);
    const existingPdfManifest = rowsForLocalCompany(report.existingPdfManifest || [], name);
    const skippedExisting = rowsForLocalCompany(report.skippedExisting || [], name);
    const blocked = rowsForLocalCompany(report.blocked || [], name);
    writeJsonFile(companyFiles.summaryJson, {
      company: name,
      included: Boolean(company.included),
      excludeReason: trim(company.excludeReason),
      catalogRowCount: catalog.length,
      downloadedCount: downloaded.length,
      existingPdfManifestCount: existingPdfManifest.length,
      skippedExistingCount: skippedExisting.length,
      blockedCount: blocked.length,
    }, pretty);
    writeJsonFile(companyFiles.catalogJson, catalog, pretty);
    writeCsvFile(companyFiles.catalogCsv, catalog.map(catalogCsvRow), CATALOG_HEADERS);
    writeJsonFile(companyFiles.downloadedJson, downloaded, pretty);
    writeCsvFile(companyFiles.downloadedCsv, downloaded, PDF_ONLY_HEADERS);
    writeJsonFile(companyFiles.existingPdfManifestJson, existingPdfManifest, pretty);
    writeCsvFile(companyFiles.existingPdfManifestCsv, existingPdfManifest, PDF_ONLY_HEADERS);
    writeJsonFile(companyFiles.skippedExistingJson, skippedExisting, pretty);
    writeCsvFile(companyFiles.skippedExistingCsv, skippedExisting, PDF_ONLY_HEADERS);
    writeJsonFile(companyFiles.blockedJson, blocked, pretty);
    writeCsvFile(companyFiles.blockedCsv, blocked, PDF_ONLY_HEADERS);
    byCompany[name] = companyFiles;
  }
  return { aggregate, byCompany };
}

export async function readKnowledgeRecordsReadOnly(dbPath) {
  const resolvedDbPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedDbPath)) throw new Error(`SQLite DB not found: ${resolvedDbPath}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records ORDER BY id ASC')
      .all()
      .map((row) => {
        const payload = parseJson(row.payload, {});
        return {
          ...payload,
          id: row.id,
          company: row.company || payload.company,
          productName: row.product_name || payload.productName,
          url: row.url || payload.url,
          payload,
        };
      });
  } finally {
    db.close();
  }
}

async function readKnownJrcpcxPdfRecords(dbPath) {
  const records = await readKnowledgeRecordsReadOnly(dbPath);
  return records.filter((row) => jrcpcxClauseUrlsOf(row).length > 0);
}

export function writeLocalCompanyQueryArtifacts({
  inventory = [],
  queries = [],
  outputDir = runtimeDir,
  batchName = `jrcpcx-local-company-pdf-only-${timestampStamp()}`,
  generatedAt = new Date().toISOString(),
  dbPath = '',
  pretty = false,
} = {}) {
  const files = {
    inventoryJson: path.join(outputDir, `${batchName}-company-inventory.json`),
    inventoryCsv: path.join(outputDir, `${batchName}-company-inventory.csv`),
    queriesJson: path.join(outputDir, `${batchName}-queries.json`),
    queriesCsv: path.join(outputDir, `${batchName}-queries.csv`),
  };
  const inventorySummary = {
    localCompanyCount: inventory.length,
    includedCompanyCount: inventory.filter((row) => row.included).length,
    excludedCompanyCount: inventory.filter((row) => !row.included).length,
  };
  writeJsonFile(files.inventoryJson, {
    schemaVersion: 'jrcpcx-local-company-inventory/v1',
    generatedAt,
    dbPath,
    inventory,
  }, pretty);
  writeCsvFile(files.inventoryCsv, inventory, INVENTORY_CSV_HEADERS);
  writeJsonFile(files.queriesJson, {
    schemaVersion: 'jrcpcx-local-company-query-file/v1',
    generatedAt,
    dbPath,
    inventorySummary,
    queries,
  }, pretty);
  writeCsvFile(files.queriesCsv, queries, QUERY_CSV_HEADERS);
  return files;
}

async function runQueryFileCli(args) {
  const generatedAt = new Date().toISOString();
  const dbPath = path.resolve(args['db-path'] || process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH);
  const outputDir = path.resolve(args['output-dir'] || runtimeDir);
  const batchName = trim(args['batch-name']) || `jrcpcx-local-company-pdf-only-${timestampStamp(generatedAt)}`;
  const records = await readKnowledgeRecordsReadOnly(dbPath);
  const inventory = buildLocalCompanyInventory(records);
  const queries = buildLocalCompanyQueries(inventory);
  const files = writeLocalCompanyQueryArtifacts({
    inventory,
    queries,
    outputDir,
    batchName,
    generatedAt,
    dbPath,
    pretty: Boolean(args.pretty),
  });
  const summary = {
    localCompanyCount: inventory.length,
    includedCompanyCount: inventory.filter((row) => row.included).length,
    excludedCompanyCount: inventory.filter((row) => !row.included).length,
    queryCount: queries.length,
  };
  process.stdout.write(`${JSON.stringify({ summary, files }, null, args.pretty ? 2 : 0)}\n`);
  return { summary, files, inventory, queries };
}

async function runPdfOnlyCli(args) {
  const generatedAt = new Date().toISOString();
  if (!args.input) throw new Error('Missing --input <json>');
  if (!args.inventory) throw new Error('Missing --inventory <json>');
  const dbPath = path.resolve(args['db-path'] || process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH);
  const inputPath = path.resolve(args.input);
  const inventoryPath = path.resolve(args.inventory);
  const outputDir = path.resolve(args['output-dir'] || runtimeDir);
  const input = readJsonFile(inputPath);
  const inventory = inventoryFromArtifact(inventoryPath);
  const localPdfRecords = await readKnownJrcpcxPdfRecords(dbPath);
  const report = buildLocalCompanyPdfOnlyReport({
    crawlResult: { ...input, sourceCrawlPath: inputPath },
    inventory,
    localPdfRecords,
    generatedAt: input.generatedAt || generatedAt,
  });
  const validation = validatePdfOnlyReport(report);
  const batchName = trim(args['batch-name']) || `jrcpcx-local-company-pdf-only-${timestampStamp(report.generatedAt)}`;
  const files = writeLocalCompanyPdfOnlyArtifacts({
    report: { ...report, validation },
    outputDir,
    batchName,
    pretty: Boolean(args.pretty),
  });
  process.stdout.write(`${JSON.stringify({ summary: report.summary, validation, files }, null, args.pretty ? 2 : 0)}\n`);
  return { report, validation, files };
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.mode === 'query-file') return runQueryFileCli(args);
  if (args.mode === 'pdf-only') return runPdfOnlyCli(args);
  throw new Error(`Unsupported --mode ${args.mode || '(missing)'}. Use query-file or pdf-only.`);
}

if (process.argv[1] && __filename === fs.realpathSync(process.argv[1])) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
