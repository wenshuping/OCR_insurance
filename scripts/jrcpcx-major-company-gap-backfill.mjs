import crypto from 'node:crypto';
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
    issuerFullName: '中国人寿保险股份有限公司',
    localCompany: '中国人寿',
    feishuConfigPath: '.runtime/feishu-knowledge-china-life.json',
    tableName: '中国人寿',
  }),
  Object.freeze({
    issuerFullName: '泰康人寿保险有限责任公司',
    localCompany: '泰康人寿',
    feishuConfigPath: '.runtime/feishu-knowledge-taikang.json',
    tableName: '泰康',
  }),
  Object.freeze({
    issuerFullName: '新华人寿保险股份有限公司',
    localCompany: '新华保险',
    feishuConfigPath: '.runtime/feishu-knowledge.json',
    tableName: '新华保险',
  }),
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
  Object.freeze({
    issuerFullName: '友邦人寿保险有限公司',
    localCompany: '友邦人寿',
    feishuConfigPath: '.runtime/feishu-knowledge-aia.json',
    tableName: '友邦',
  }),
  Object.freeze({
    issuerFullName: '中国太平洋人寿保险股份有限公司',
    localCompany: '太保寿险',
    feishuConfigPath: '.runtime/feishu-knowledge-cpic-life.json',
    tableName: '太保寿险',
  }),
  Object.freeze({
    issuerFullName: '太平人寿保险有限公司',
    localCompany: '中国太平',
    feishuConfigPath: '.runtime/feishu-knowledge-china-taiping.json',
    tableName: '中国太平',
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

function compactFileNamePart(value = '') {
  return trim(value)
    .replace(/[\\/:*?"<>|]+/gu, '_')
    .replace(/\s+/gu, '')
    .slice(0, 80);
}

export function buildSuggestedReadableName(row = {}) {
  const issuer = compactFileNamePart(issuerFullNameOf(row)) || '未知机构';
  const product = compactFileNamePart(productNameOf(row)) || '未知产品';
  const code = compactFileNamePart(termsTextCodeOf(row));
  return [issuer, product, code || '条款'].filter(Boolean).join('__') + '.pdf';
}

function pdfFileNameOf(row = {}) {
  const localPath = pdfLocalPathOf(row);
  return localPath ? path.basename(localPath) : '';
}

function pdfBytesOf(row = {}) {
  return Number(row.pdfBytes || row.bytes || 0) || 0;
}

function pdfContentTypeOf(row = {}) {
  return trim(row.pdfContentType || row.contentType);
}

function skipReasonOf(row = {}) {
  return trim(row.reason || row.skipReason || row.skippedReason || row.skippedExistingReason);
}

function pdfOnlyBaseRow(row = {}, status, reason = '') {
  const clauseUrl = clauseUrlOf(row);
  return {
    status,
    reason,
    issuerFullName: issuerFullNameOf(row),
    productName: productNameOf(row),
    productType: productTypeOf(row),
    productState: productStateOf(row),
    industryCode: termsTextCodeOf(row),
    detailUrl: detailUrlOf(row) || trim(row.detailUrl),
    clauseUrl,
    normalizedClauseUrl: clauseUrl,
    clauseFileName: trim(row.clauseFileName || row.fileName),
    pdfOriginalUrl: trim(row.pdfOriginalUrl || row.clauseUrl),
    pdfLocalPath: pdfLocalPathOf(row),
    pdfFileName: pdfFileNameOf(row),
    pdfSha256: pdfSha256Of(row),
    pdfBytes: pdfBytesOf(row),
    pdfContentType: pdfContentTypeOf(row),
    pdfArchivedAt: trim(row.pdfArchivedAt),
    suggestedReadableName: buildSuggestedReadableName(row),
    futureExtractionStatus: 'pending',
    responsibilityDeferred: true,
    sourceAttemptFile: trim(row.sourceAttemptFile),
    skipEvidence: row.skipEvidence || row.skippedExistingEvidence || null,
    existingUrl: trim(row.existingUrl || row.representedUrl || row.localUrl),
    existingHash: trim(row.existingHash || row.representedHash || row.localHash),
    duplicateOf: trim(row.duplicateOf || row.duplicatePlanUrl || row.duplicateClauseUrl),
    detailFields: row.detailFields || row.fields || {},
  };
}

function isSkippedExistingRecord(row = {}) {
  const reason = skipReasonOf(row);
  return Boolean(row.skippedExisting)
    || trim(row.qualityStatus) === 'represented_local_url'
    || /existing|represented|duplicate/iu.test(reason);
}

function pdfOnlyRowsFromCrawl(crawlResult = {}) {
  const records = rowsOf(crawlResult.records ? { rows: crawlResult.records } : crawlResult);
  const downloaded = [];
  const skippedExisting = [];
  const blocked = [];

  for (const row of records) {
    if (isSkippedExistingRecord(row)) {
      skippedExisting.push(pdfOnlyBaseRow(row, 'skipped_existing', skipReasonOf(row) || 'existing_url'));
    } else if (pdfLocalPathOf(row)) {
      downloaded.push(pdfOnlyBaseRow(row, 'downloaded'));
    } else if (detailUrlOf(row) || trim(row.detailUrl)) {
      blocked.push(pdfOnlyBaseRow(row, 'blocked', 'missing_pdf_local_path'));
    }
  }

  for (const result of Array.isArray(crawlResult.detailResults) ? crawlResult.detailResults : []) {
    if (result && result.ok === false) {
      blocked.push(pdfOnlyBaseRow(result, 'blocked', trim(result.code) || 'detail_failed'));
    }
  }

  return { downloaded, skippedExisting, blocked };
}

function pdfKnowledgeUrlCandidates(row = {}) {
  return [
    row.url,
    row.clauseUrl,
    row.normalizedClauseUrl,
    row.pdfOriginalUrl,
    row.sourceKnowledgeUrl,
  ];
}

function pdfKnowledgeEntry(row = {}) {
  const pdfLocalPath = pdfLocalPathOf(row);
  const pdfSha256 = pdfSha256Of(row);
  return {
    sourceKnowledgeRecordId: row.id || row.sourceKnowledgeRecordId || '',
    sourceKnowledgeCompany: trim(row.company || row.sourceKnowledgeCompany || row.issuerFullName),
    sourceKnowledgeProductName: trim(row.productName || row.product_name || row.sourceKnowledgeProductName),
    sourceKnowledgeUrl: trim(row.url || row.sourceKnowledgeUrl),
    pdfOriginalUrl: trim(row.pdfOriginalUrl || row.url),
    pdfLocalPath,
    pdfFileName: pdfLocalPath ? path.basename(pdfLocalPath) : '',
    pdfSha256,
    pdfBytes: pdfBytesOf(row),
    pdfContentType: pdfContentTypeOf(row),
    pdfArchivedAt: trim(row.pdfArchivedAt),
  };
}

function buildKnownPdfByClauseUrl(localPdfRecords = []) {
  const known = new Map();
  for (const row of Array.isArray(localPdfRecords) ? localPdfRecords : []) {
    const entry = pdfKnowledgeEntry(row);
    for (const value of pdfKnowledgeUrlCandidates(row)) {
      const normalized = normalizeClauseUrl(value);
      if (!normalized) continue;
      const existing = known.get(normalized);
      if (!existing || (!existing.pdfLocalPath && entry.pdfLocalPath)) known.set(normalized, entry);
    }
  }
  return known;
}

function enrichSkippedExistingRows(skippedExisting = [], localPdfRecords = []) {
  const knownByClauseUrl = buildKnownPdfByClauseUrl(localPdfRecords);
  return skippedExisting.map((row) => {
    const normalizedClauseUrl = normalizeClauseUrl(row.normalizedClauseUrl || row.clauseUrl || row.pdfOriginalUrl);
    const known = knownByClauseUrl.get(normalizedClauseUrl) || {};
    const pdfLocalPath = pdfLocalPathOf(known) || pdfLocalPathOf(row);
    const pdfSha256 = pdfSha256Of(known) || pdfSha256Of(row);
    let actualPdfSha256 = '';
    let actualPdfBytes = 0;
    let existingPdfPathExists = false;
    if (pdfLocalPath) {
      try {
        const bytes = fs.readFileSync(pdfLocalPath);
        existingPdfPathExists = true;
        actualPdfBytes = bytes.length;
        actualPdfSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      } catch {
        existingPdfPathExists = false;
      }
    }
    return {
      ...row,
      normalizedClauseUrl: normalizedClauseUrl || row.normalizedClauseUrl,
      pdfOriginalUrl: trim(known.pdfOriginalUrl || row.pdfOriginalUrl),
      pdfLocalPath,
      pdfFileName: trim(known.pdfFileName || row.pdfFileName || (pdfLocalPath ? path.basename(pdfLocalPath) : '')),
      pdfSha256,
      pdfBytes: Number(known.pdfBytes || row.pdfBytes || actualPdfBytes || 0) || 0,
      pdfContentType: trim(known.pdfContentType || row.pdfContentType),
      pdfArchivedAt: trim(known.pdfArchivedAt || row.pdfArchivedAt),
      existingPdfPathExists,
      actualPdfSha256,
      actualPdfBytes,
      pdfSha256MatchesFile: Boolean(pdfSha256 && actualPdfSha256 && pdfSha256 === actualPdfSha256),
      sourceKnowledgeRecordId: known.sourceKnowledgeRecordId || row.sourceKnowledgeRecordId || '',
      sourceKnowledgeCompany: known.sourceKnowledgeCompany || row.sourceKnowledgeCompany || '',
      sourceKnowledgeProductName: known.sourceKnowledgeProductName || row.sourceKnowledgeProductName || '',
      sourceKnowledgeUrl: known.sourceKnowledgeUrl || row.sourceKnowledgeUrl || '',
    };
  });
}

function candidateMaterialKey(row = {}) {
  const identityUrl = detailUrlOf(row) || trim(row.detailUrl) || clauseUrlOf(row) || trim(row.normalizedClauseUrl);
  const key = [
    issuerFullNameOf(row),
    productNameOf(row),
    termsTextCodeOf(row),
    identityUrl,
  ].map(trim).filter(Boolean).join('\u001f');
  return key || materialIdentityKey(row);
}

function countUniqueCandidateMaterials(rows = []) {
  const keys = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = candidateMaterialKey(row);
    if (key) keys.add(key);
  }
  return keys.size;
}

function countByCompany(rows = []) {
  const counts = {};
  for (const row of rows) {
    const company = issuerFullNameOf(row) || trim(row.issuerFullName) || '未知机构';
    counts[company] = (counts[company] || 0) + 1;
  }
  return counts;
}

function countUniqueCandidateMaterialsByCompany(rows = []) {
  const keysByCompany = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const company = issuerFullNameOf(row) || trim(row.issuerFullName) || '未知机构';
    const key = candidateMaterialKey(row);
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

function unresolvedTruncatedShardsFrom(crawlResult = {}) {
  if (Array.isArray(crawlResult.unresolvedTruncatedShards)) return crawlResult.unresolvedTruncatedShards;
  const shards = Array.isArray(crawlResult.unresolvedShards)
    ? crawlResult.unresolvedShards
    : (Array.isArray(crawlResult.summary?.unresolvedShards) ? crawlResult.summary.unresolvedShards : []);
  return shards.filter((row) => /truncated/iu.test([
    row.reason,
    row.status,
    row.code,
    row.message,
    row.qualityStatus,
  ].map(trim).filter(Boolean).join(' ')));
}

export function buildPdfOnlyReport({
  crawlResult = {},
  generatedAt = new Date().toISOString(),
  localPdfRecords = [],
} = {}) {
  const { downloaded, skippedExisting: rawSkippedExisting, blocked } = pdfOnlyRowsFromCrawl(crawlResult);
  const skippedExisting = enrichSkippedExistingRows(rawSkippedExisting, localPdfRecords);
  const existingPdfManifest = skippedExisting.filter((row) => trim(row.pdfLocalPath));
  const catalogRows = Array.isArray(crawlResult.products) ? crawlResult.products : [];
  const candidateRows = [...catalogRows, ...downloaded, ...skippedExisting, ...blocked];
  const urlRepresented = skippedExisting.filter(isUrlRepresentedRow);
  const hashRepresented = skippedExisting.filter(isHashRepresentedRow);
  const missingPdfPathRows = [
    ...downloaded.filter((row) => !trim(row.pdfLocalPath)),
    ...blocked.filter((row) => trim(row.reason) === 'missing_pdf_local_path'),
  ];
  const missingExistingPdfPathRows = skippedExisting.filter((row) => !trim(row.pdfLocalPath));
  const missingExistingPdfFileRows = skippedExisting.filter((row) => trim(row.pdfLocalPath) && row.existingPdfPathExists === false);
  const existingPdfSha256MismatchRows = skippedExisting.filter((row) => trim(row.pdfSha256) && trim(row.actualPdfSha256) && trim(row.pdfSha256) !== trim(row.actualPdfSha256));
  const unresolvedTruncatedShards = unresolvedTruncatedShardsFrom(crawlResult);
  const fallbackUnresolvedTruncatedShardCount = Number(crawlResult.summary?.unresolvedTruncatedShardCount || 0) || 0;
  return {
    schemaVersion: 'jrcpcx-major-company-pdf-only/v1',
    generatedAt,
    sourceCrawlPath: trim(crawlResult.sourceCrawlPath),
    targetCompanies: targetCompanySummaries(),
    summary: {
      catalogRowCount: catalogRows.length,
      uniqueCandidateMaterialCount: countUniqueCandidateMaterials(candidateRows),
      downloadedCount: downloaded.length,
      skippedExistingCount: skippedExisting.length,
      blockedCount: blocked.length,
      failedCount: blocked.length,
      representedUrlCount: urlRepresented.length,
      representedHashCount: hashRepresented.length,
      missingPdfPathCount: missingPdfPathRows.length,
      existingPdfManifestCount: existingPdfManifest.length,
      existingPdfPathExistsCount: existingPdfManifest.filter((row) => row.existingPdfPathExists === true).length,
      missingExistingPdfPathCount: missingExistingPdfPathRows.length,
      missingExistingPdfFileCount: missingExistingPdfFileRows.length,
      existingPdfSha256MismatchCount: existingPdfSha256MismatchRows.length,
      unresolvedTruncatedShardCount: unresolvedTruncatedShards.length || fallbackUnresolvedTruncatedShardCount,
      byCompany: {
        catalog: countByCompany(catalogRows),
        uniqueCandidateMaterials: countUniqueCandidateMaterialsByCompany(candidateRows),
        downloaded: countByCompany(downloaded),
        skippedExisting: countByCompany(skippedExisting),
        blocked: countByCompany(blocked),
        failed: countByCompany(blocked),
        representedUrl: countByCompany(urlRepresented),
        representedHash: countByCompany(hashRepresented),
        missingPdfPath: countByCompany(missingPdfPathRows),
        existingPdfManifest: countByCompany(existingPdfManifest),
        missingExistingPdfPath: countByCompany(missingExistingPdfPathRows),
        missingExistingPdfFile: countByCompany(missingExistingPdfFileRows),
        existingPdfSha256Mismatch: countByCompany(existingPdfSha256MismatchRows),
        unresolvedTruncatedShards: countByCompany(unresolvedTruncatedShards),
      },
    },
    catalog: catalogRows,
    downloaded,
    skippedExisting,
    existingPdfManifest,
    blocked,
    unresolvedTruncatedShards,
  };
}

export function validatePdfOnlyReport(report = {}, existsFn = fs.existsSync) {
  const issues = [];
  const rowsToValidate = [
    ...(Array.isArray(report.downloaded) ? report.downloaded : []),
    ...(Array.isArray(report.existingPdfManifest) ? report.existingPdfManifest : []),
  ];
  for (const row of rowsToValidate) {
    const pdfLocalPath = trim(row.pdfLocalPath);
    const expectedSha256 = trim(row.pdfSha256).toLowerCase();
    let fileBytes = null;
    if (!pdfLocalPath) {
      issues.push({ row, reason: 'missing_pdf_local_path' });
    } else if (!existsFn(pdfLocalPath)) {
      issues.push({ row, reason: 'pdf_file_not_found' });
    } else {
      try {
        fileBytes = fs.readFileSync(pdfLocalPath);
        if (fileBytes.subarray(0, 4).toString('latin1') !== '%PDF') issues.push({ row, reason: 'pdf_file_signature_mismatch' });
      } catch (error) {
        issues.push({ row, reason: 'pdf_file_read_failed', message: error.message });
      }
    }
    if (!expectedSha256) issues.push({ row, reason: 'missing_pdf_sha256' });
    else if (fileBytes) {
      const actualSha256 = crypto.createHash('sha256').update(fileBytes).digest('hex');
      if (actualSha256 !== expectedSha256) issues.push({ row, reason: 'pdf_sha256_mismatch', expected: expectedSha256, actual: actualSha256 });
    }
    if (Number(row.pdfBytes || 0) <= 0) issues.push({ row, reason: 'invalid_pdf_bytes' });
    if (!trim(row.productName)) issues.push({ row, reason: 'missing_product_name' });
    if (!trim(row.productType)) issues.push({ row, reason: 'missing_product_type' });
    if (!trim(row.productState)) issues.push({ row, reason: 'missing_product_state' });
    if (!trim(row.industryCode)) issues.push({ row, reason: 'missing_industry_code' });
    if (!trim(row.issuerFullName)) issues.push({ row, reason: 'missing_issuer_full_name' });
    if (!trim(row.detailUrl)) issues.push({ row, reason: 'missing_detail_url' });
    if (!trim(row.clauseUrl)) issues.push({ row, reason: 'missing_clause_url' });
    if (!trim(row.normalizedClauseUrl)) issues.push({ row, reason: 'missing_normalized_clause_url' });
    if (!trim(row.clauseFileName)) issues.push({ row, reason: 'missing_clause_file_name' });
    if (!trim(row.pdfOriginalUrl)) issues.push({ row, reason: 'missing_pdf_original_url' });
    if (!trim(row.pdfContentType)) issues.push({ row, reason: 'missing_pdf_content_type' });
    if (!trim(row.pdfArchivedAt)) issues.push({ row, reason: 'missing_pdf_archived_at' });
    if (!trim(row.suggestedReadableName)) issues.push({ row, reason: 'missing_suggested_readable_name' });
    if (row.responsibilityDeferred !== true) issues.push({ row, reason: 'responsibility_not_deferred' });
    if (row.futureExtractionStatus !== 'pending') issues.push({ row, reason: 'future_extraction_status_not_pending' });
  }
  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    missingPdfPathCount: issues.filter((issue) => ['missing_pdf_local_path', 'pdf_file_not_found'].includes(issue.reason)).length,
    issues,
  };
}

function isOutOfScopeEligibility(reasons = []) {
  return reasons.includes('issuer_not_target') || reasons.includes('not_human_insurance');
}

export function buildInsertPlan({ insertable = [], existingUrls = [] } = {}) {
  const existingUrlSet = normalizedUrlSet(existingUrls);
  const plannedUrlSet = new Set(existingUrlSet);
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
    if (clauseUrl && plannedUrlSet.has(clauseUrl)) {
      skipped.push(skippedInsertRow(row, 'duplicate_plan_url'));
      continue;
    }
    recordsToInsert.push(buildKnowledgeRecordFromJrcpcx(row));
    if (clauseUrl) plannedUrlSet.add(clauseUrl);
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

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function writeCsvFile(filePath, rows = [], headers = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = ['\ufeff' + headers.join(',')];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

const PDF_ONLY_CSV_HEADERS = Object.freeze([
  'status',
  'reason',
  'skipEvidence',
  'existingUrl',
  'existingHash',
  'duplicateOf',
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
]);

const PDF_ONLY_CATALOG_CSV_HEADERS = Object.freeze([
  'issuerFullName',
  'productName',
  'productType',
  'productState',
  'industryCode',
  'detailUrl',
  'clauseUrl',
  'normalizedClauseUrl',
  'clauseFileName',
  'materialIdentityKey',
]);

const EXISTING_PDF_MANIFEST_CSV_HEADERS = Object.freeze([
  ...PDF_ONLY_CSV_HEADERS,
  'existingPdfPathExists',
  'pdfSha256MatchesFile',
  'actualPdfSha256',
  'actualPdfBytes',
  'sourceKnowledgeRecordId',
  'sourceKnowledgeCompany',
  'sourceKnowledgeProductName',
  'sourceKnowledgeUrl',
]);

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

async function openReadOnlyKnowledgeSnapshot(dbPath) {
  const resolvedDbPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedDbPath)) throw new Error(`SQLite DB not found: ${resolvedDbPath}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  return {
    dbPath: resolvedDbPath,
    countKnowledgeRecords() {
      return Number(db.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get()?.count || 0);
    },
    allKnownUrls() {
      return db
        .prepare("SELECT url FROM knowledge_records WHERE TRIM(COALESCE(url, '')) <> '' ORDER BY id ASC")
        .all()
        .map((row) => trim(row.url))
        .filter(Boolean);
    },
    allKnownJrcpcxPdfRecords() {
      return db
        .prepare(`
          SELECT id, company, product_name, url, payload
          FROM knowledge_records
          WHERE url LIKE 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo%'
             OR payload LIKE '%inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo%'
          ORDER BY id ASC
        `)
        .all()
        .map((row) => {
          let payload = {};
          try {
            payload = row.payload ? JSON.parse(row.payload) : {};
          } catch {
            payload = {};
          }
          return {
            ...payload,
            id: row.id,
            company: row.company || payload.company,
            productName: row.product_name || payload.productName,
            url: row.url || payload.url,
          };
        });
    },
    close() {
      db.close();
    },
  };
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
  if (!write) {
    const knowledgeSnapshot = await openReadOnlyKnowledgeSnapshot(dbPath);
    try {
      const before = knowledgeSnapshot.countKnowledgeRecords();
      const plan = buildInsertPlan({
        insertable: insertableRowsFromCoverage(coverage),
        existingUrls: knowledgeSnapshot.allKnownUrls(),
      });
      return buildInsertReport({
        generatedAt,
        dryRun: true,
        dbPath: knowledgeSnapshot.dbPath,
        dbBackupPath,
        before,
        after: before,
        recordsToInsert: plan.recordsToInsert,
        saved: [],
        skipped: plan.skipped,
      });
    } finally {
      knowledgeSnapshot.close();
    }
  }

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

function companySlug(value = '') {
  const config = companyConfigForIssuer(value);
  if (config?.localCompany) return compactFileNamePart(config.localCompany);
  return compactFileNamePart(value) || 'unknown-company';
}

function rowsForCompany(rows = [], company = '') {
  return rows.filter((row) => normalizeIssuerName(issuerFullNameOf(row)) === normalizeIssuerName(company));
}

function countFromCompanyMap(map = {}, company = '') {
  return Number(map?.[company] || 0) || 0;
}

function catalogCsvRow(row = {}) {
  const clauseUrl = clauseUrlOf(row);
  return {
    issuerFullName: issuerFullNameOf(row),
    productName: productNameOf(row),
    productType: productTypeOf(row),
    productState: productStateOf(row),
    industryCode: termsTextCodeOf(row),
    detailUrl: detailUrlOf(row) || trim(row.detailUrl),
    clauseUrl,
    normalizedClauseUrl: clauseUrl,
    clauseFileName: trim(row.clauseFileName || row.fileName),
    materialIdentityKey: materialIdentityKey(row),
  };
}

export function writePdfOnlyArtifacts({
  report,
  outputDir = runtimeDir,
  batchName = `jrcpcx-major-company-pdf-only-${timestampStamp(report?.generatedAt || new Date().toISOString())}`,
  pretty = true,
} = {}) {
  const aggregate = {
    summaryJson: path.join(outputDir, `${batchName}-summary.json`),
    catalogJson: path.join(outputDir, `${batchName}-catalog.json`),
    catalogCsv: path.join(outputDir, `${batchName}-catalog.csv`),
    downloadedJson: path.join(outputDir, `${batchName}-downloaded.json`),
    downloadedCsv: path.join(outputDir, `${batchName}-downloaded.csv`),
    skippedExistingJson: path.join(outputDir, `${batchName}-skipped-existing.json`),
    skippedExistingCsv: path.join(outputDir, `${batchName}-skipped-existing.csv`),
    existingPdfManifestJson: path.join(outputDir, `${batchName}-existing-pdf-manifest.json`),
    existingPdfManifestCsv: path.join(outputDir, `${batchName}-existing-pdf-manifest.csv`),
    blockedJson: path.join(outputDir, `${batchName}-blocked.json`),
    blockedCsv: path.join(outputDir, `${batchName}-blocked.csv`),
  };

  writeJsonFile(aggregate.summaryJson, { ...report, catalog: undefined, downloaded: undefined, skippedExisting: undefined, existingPdfManifest: undefined, blocked: undefined }, pretty);
  writeJsonFile(aggregate.catalogJson, report.catalog || [], pretty);
  writeCsvFile(aggregate.catalogCsv, (report.catalog || []).map(catalogCsvRow), PDF_ONLY_CATALOG_CSV_HEADERS);
  writeJsonFile(aggregate.downloadedJson, report.downloaded || [], pretty);
  writeCsvFile(aggregate.downloadedCsv, report.downloaded || [], PDF_ONLY_CSV_HEADERS);
  writeJsonFile(aggregate.skippedExistingJson, report.skippedExisting || [], pretty);
  writeCsvFile(aggregate.skippedExistingCsv, report.skippedExisting || [], PDF_ONLY_CSV_HEADERS);
  writeJsonFile(aggregate.existingPdfManifestJson, report.existingPdfManifest || [], pretty);
  writeCsvFile(aggregate.existingPdfManifestCsv, report.existingPdfManifest || [], EXISTING_PDF_MANIFEST_CSV_HEADERS);
  writeJsonFile(aggregate.blockedJson, report.blocked || [], pretty);
  writeCsvFile(aggregate.blockedCsv, report.blocked || [], PDF_ONLY_CSV_HEADERS);

  const byCompany = {};
  for (const config of TARGET_COMPANIES) {
    const slug = companySlug(config.issuerFullName);
    const prefix = path.join(outputDir, `${batchName}-${slug}`);
    const companyFiles = {
      downloadedJson: `${prefix}-downloaded.json`,
      downloadedCsv: `${prefix}-downloaded.csv`,
      catalogJson: `${prefix}-catalog.json`,
      catalogCsv: `${prefix}-catalog.csv`,
      skippedExistingJson: `${prefix}-skipped-existing.json`,
      skippedExistingCsv: `${prefix}-skipped-existing.csv`,
      existingPdfManifestJson: `${prefix}-existing-pdf-manifest.json`,
      existingPdfManifestCsv: `${prefix}-existing-pdf-manifest.csv`,
      blockedJson: `${prefix}-blocked.json`,
      blockedCsv: `${prefix}-blocked.csv`,
      summaryJson: `${prefix}-summary.json`,
    };
    const downloaded = rowsForCompany(report.downloaded || [], config.issuerFullName);
    const skippedExisting = rowsForCompany(report.skippedExisting || [], config.issuerFullName);
    const existingPdfManifest = rowsForCompany(report.existingPdfManifest || [], config.issuerFullName);
    const blocked = rowsForCompany(report.blocked || [], config.issuerFullName);
    const catalog = rowsForCompany(report.catalog || [], config.issuerFullName);
    writeJsonFile(companyFiles.downloadedJson, downloaded, pretty);
    writeCsvFile(companyFiles.downloadedCsv, downloaded, PDF_ONLY_CSV_HEADERS);
    writeJsonFile(companyFiles.catalogJson, catalog, pretty);
    writeCsvFile(companyFiles.catalogCsv, catalog.map(catalogCsvRow), PDF_ONLY_CATALOG_CSV_HEADERS);
    writeJsonFile(companyFiles.skippedExistingJson, skippedExisting, pretty);
    writeCsvFile(companyFiles.skippedExistingCsv, skippedExisting, PDF_ONLY_CSV_HEADERS);
    writeJsonFile(companyFiles.existingPdfManifestJson, existingPdfManifest, pretty);
    writeCsvFile(companyFiles.existingPdfManifestCsv, existingPdfManifest, EXISTING_PDF_MANIFEST_CSV_HEADERS);
    writeJsonFile(companyFiles.blockedJson, blocked, pretty);
    writeCsvFile(companyFiles.blockedCsv, blocked, PDF_ONLY_CSV_HEADERS);
    writeJsonFile(companyFiles.summaryJson, {
      issuerFullName: config.issuerFullName,
      catalogRowCount: catalog.length,
      uniqueCandidateMaterialCount: countFromCompanyMap(report.summary?.byCompany?.uniqueCandidateMaterials, config.issuerFullName),
      downloadedCount: downloaded.length,
      skippedExistingCount: skippedExisting.length,
      blockedCount: blocked.length,
      failedCount: countFromCompanyMap(report.summary?.byCompany?.failed, config.issuerFullName),
      representedUrlCount: countFromCompanyMap(report.summary?.byCompany?.representedUrl, config.issuerFullName),
      representedHashCount: countFromCompanyMap(report.summary?.byCompany?.representedHash, config.issuerFullName),
      missingPdfPathCount: countFromCompanyMap(report.summary?.byCompany?.missingPdfPath, config.issuerFullName),
      existingPdfManifestCount: existingPdfManifest.length,
      missingExistingPdfPathCount: countFromCompanyMap(report.summary?.byCompany?.missingExistingPdfPath, config.issuerFullName),
      missingExistingPdfFileCount: countFromCompanyMap(report.summary?.byCompany?.missingExistingPdfFile, config.issuerFullName),
      existingPdfSha256MismatchCount: countFromCompanyMap(report.summary?.byCompany?.existingPdfSha256Mismatch, config.issuerFullName),
      unresolvedTruncatedShardCount: countFromCompanyMap(report.summary?.byCompany?.unresolvedTruncatedShards, config.issuerFullName),
    }, pretty);
    byCompany[config.issuerFullName] = companyFiles;
  }

  return { aggregate, byCompany };
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
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite DB not found: ${dbPath}`);
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

async function runPdfOnlyCli(args) {
  const generatedAt = new Date().toISOString();
  if (!args.input) throw new Error('Missing --input <json>');
  const inputPath = path.resolve(args.input);
  const input = readJsonFile(inputPath);
  let knowledgeSnapshot = null;
  let localPdfRecords = [];
  try {
    if (args['db-path']) {
      knowledgeSnapshot = await openReadOnlyKnowledgeSnapshot(path.resolve(args['db-path']));
      localPdfRecords = knowledgeSnapshot.allKnownJrcpcxPdfRecords();
    }
    const report = buildPdfOnlyReport({
      crawlResult: { ...input, sourceCrawlPath: inputPath },
      generatedAt: input.generatedAt || generatedAt,
      localPdfRecords,
    });
    const validation = validatePdfOnlyReport(report);
    const outputDir = path.resolve(args['output-dir'] || runtimeDir);
    const batchName = trim(args['batch-name']) || `jrcpcx-major-company-pdf-only-${timestampStamp(report.generatedAt)}`;
    const files = writePdfOnlyArtifacts({
      report: { ...report, validation },
      outputDir,
      batchName,
      pretty: Boolean(args.pretty),
    });
    process.stdout.write(`${JSON.stringify({ summary: report.summary, validation, files }, null, 2)}\n`);
    return { report, validation, files };
  } finally {
    if (knowledgeSnapshot) knowledgeSnapshot.close();
  }
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.mode === 'query-file') return runQueryFileCli(args);
  if (args.mode === 'coverage') return runCoverageCli(args);
  if (args.mode === 'insert') return runInsertCli(args);
  if (args.mode === 'pdf-only') return runPdfOnlyCli(args);
  throw new Error(`Unsupported --mode ${args.mode || '(missing)'}. Use query-file, coverage, insert, or pdf-only.`);
}

if (process.argv[1] && __filename === fs.realpathSync(process.argv[1])) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
