import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PING_AN_LIFE_FULL_NAME = '中国平安人寿保险股份有限公司';
export const PING_AN_LIFE_PRODUCT_TYPE_LABEL = '人身保险类';
export const JRCPCX_TERMS_EVIDENCE_LABEL = '金融产品查询平台/中国保险行业协会条款 PDF';
export const JRCPCX_TERMS_EVIDENCE_LEVEL = 'regulatory_industry_terms';
export const JRCPCX_OFFICIAL_DOMAIN = 'inspdinfo.iachina.cn';

const SEP = '\u001f';

export function trim(value) {
  return String(value || '').trim();
}

export function normalizeProductName(value = '') {
  return trim(value)
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/[，]/gu, ',')
    .replace(/\s+/gu, '');
}

export function isPingAnLifeIssuer(value = '') {
  return trim(value).replace(/\s+/gu, '') === PING_AN_LIFE_FULL_NAME;
}

export function isHumanInsuranceProductType(value = '') {
  const normalized = trim(value).replace(/\s+/gu, '');
  if (!normalized) return false;
  if (/财产保险|财产险|车险|机动车|责任保险|责任险|保证保险|保证险|信用保险|信用险/u.test(normalized)) return false;
  if (normalized === '人身保险类' || normalized === '人身保险') return true;
  return /寿险|人寿保险|健康险|健康保险|意外险|意外保险|意外伤害保险|年金险|年金保险|养老保险|医疗险|医疗保险|疾病险|疾病保险|护理保险|两全保险/u.test(normalized);
}

function parseUrl(value = '') {
  try {
    return new URL(trim(value));
  } catch {
    return null;
  }
}

export function isJrcpcxDetailUrl(value = '') {
  const url = parseUrl(value);
  return Boolean(url && url.hostname === JRCPCX_OFFICIAL_DOMAIN && /\/lifeIns\/detail\b/u.test(url.pathname));
}

export function isJrcpcxClauseUrl(value = '') {
  const url = parseUrl(value);
  return Boolean(url && url.hostname === JRCPCX_OFFICIAL_DOMAIN && /\/lifeIns\/clauseInfo\b/u.test(url.pathname));
}

export function normalizeClauseUrl(value = '') {
  const url = parseUrl(value);
  if (!url || !isJrcpcxClauseUrl(url.href)) return '';
  const params = [...url.searchParams.entries()]
    .filter(([key]) => key !== 't')
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
      return leftKey.localeCompare(rightKey);
    });
  url.search = '';
  for (const [key, paramValue] of params) url.searchParams.append(key, paramValue);
  return url.href;
}

export function issuerFullNameOf(row = {}) {
  return trim(row.issuerFullName || row.company || row.companyName || row.deptName || row.queryDeptName || row.detailFields?.公司名称);
}

export function productNameOf(row = {}) {
  return trim(row.productName || row.product || row.detailFields?.产品名称);
}

export function detailUrlOf(row = {}) {
  for (const value of [row.detailUrl, row.sourceUrl, row.source]) {
    const candidate = trim(value);
    if (isJrcpcxDetailUrl(candidate)) return candidate;
  }
  return '';
}

export function clauseUrlOf(row = {}) {
  return normalizeClauseUrl(row.clauseUrl || row.pdfOriginalUrl) || normalizeClauseUrl(row.url);
}

export function termsTextCodeOf(row = {}) {
  return trim(row.versionNo || row.industryCode || row.detailFields?.产品条款文字编码);
}

export function materialIdentityKey(row = {}) {
  return [productNameOf(row), termsTextCodeOf(row), clauseUrlOf(row)].map(trim).join(SEP);
}

export function dedupeCatalogRows(rows = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = [
      issuerFullNameOf(row),
      productNameOf(row),
      trim(row.industryCode || row.detailFields?.产品条款文字编码),
      detailUrlOf(row) || trim(row.detailUrl),
    ].join(SEP);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function evidenceScore(row = {}) {
  return [
    clauseUrlOf(row) ? 16 : 0,
    trim(row.pdfLocalPath) ? 8 : 0,
    trim(row.pdfSha256) ? 4 : 0,
    trim(row.pageText) ? 2 : 0,
    termsTextCodeOf(row) ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

export function mergeDetailRowsPreferEvidence(rows = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = detailUrlOf(row) || materialIdentityKey(row);
    const existing = byKey.get(key);
    if (!existing || evidenceScore(row) >= evidenceScore(existing)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export function eligibleForAutoInsert(row = {}) {
  const reasons = [];
  const issuer = issuerFullNameOf(row);
  const productName = productNameOf(row);
  const productType = trim(row.productType || row.productTypeLabel || row.queryProductType);
  const qualityStatus = trim(row.qualityStatus);
  const pdfLocalPath = trim(row.pdfLocalPath);
  if (!isPingAnLifeIssuer(issuer)) reasons.push('issuer_not_ping_an_life');
  if (!productName) reasons.push('missing_product_name');
  if (!isHumanInsuranceProductType(productType)) reasons.push(productType ? 'not_human_insurance' : 'missing_product_type');
  if (!detailUrlOf(row)) reasons.push('missing_detail_url');
  if (!clauseUrlOf(row)) reasons.push('missing_clause_url');
  if (!pdfLocalPath) reasons.push('missing_pdf_local_path');
  if (pdfLocalPath && !fs.existsSync(pdfLocalPath)) reasons.push('pdf_file_not_found');
  if (!trim(row.pdfSha256)) reasons.push('missing_pdf_sha256');
  if (!trim(row.pageText)) reasons.push('missing_page_text');
  if (!['valid_complete', 'valid_partial'].includes(qualityStatus)) reasons.push(`quality_${qualityStatus || 'blank'}`);
  return { eligible: reasons.length === 0, reasons };
}

export function buildKnowledgeRecordFromJrcpcx(row = {}) {
  const productName = productNameOf(row);
  return {
    company: PING_AN_LIFE_FULL_NAME,
    productName,
    productType: trim(row.productType),
    salesStatus: trim(row.salesStatus || row.productState || row.detailFields?.产品销售状态),
    title: trim(row.title) || `${productName}条款`,
    url: clauseUrlOf(row),
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
    catalogStatus: trim(row.salesStatus || row.productState || row.detailFields?.产品销售状态),
    seedSource: 'jrcpcx_ping_an_life_material_backfill',
    seedSourceUrl: detailUrlOf(row),
    qualityStatus: trim(row.qualityStatus),
    qualityReason: trim(row.qualityReason),
    pages: Number(row.pages || 0) || 0,
    bytes: Number(row.bytes || 0) || 0,
    contentType: trim(row.contentType),
    pdfLocalPath: trim(row.pdfLocalPath),
    pdfSha256: trim(row.pdfSha256),
    pdfBytes: Number(row.pdfBytes || row.bytes || 0) || 0,
    pdfOriginalUrl: trim(row.pdfOriginalUrl || row.clauseUrl),
    pdfArchivedAt: trim(row.pdfArchivedAt),
  };
}

export function buildCoverageGapReport({
  localRecords = [],
  detailRows = [],
  unresolvedShards = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const localUrls = new Set((Array.isArray(localRecords) ? localRecords : []).map((row) => normalizeClauseUrl(row.url)).filter(Boolean));
  const represented = [];
  const insertable = [];
  const manualReview = [];
  const invalid = [];
  for (const row of mergeDetailRowsPreferEvidence(detailRows)) {
    const clauseUrl = clauseUrlOf(row);
    const eligibility = eligibleForAutoInsert(row);
    const item = {
      ...row,
      issuerFullName: issuerFullNameOf(row),
      productName: productNameOf(row),
      clauseUrl,
      detailUrl: detailUrlOf(row),
      versionNo: termsTextCodeOf(row),
      materialIdentityKey: materialIdentityKey(row),
      eligibilityReasons: eligibility.reasons,
    };
    if (clauseUrl && localUrls.has(clauseUrl)) represented.push(item);
    else if (eligibility.eligible) insertable.push(item);
    else if (['invalid_empty', 'invalid_non_responsibility', 'suspect_needs_source_check'].includes(trim(row.qualityStatus))) invalid.push(item);
    else manualReview.push(item);
  }
  return {
    generatedAt,
    summary: {
      representedCount: represented.length,
      insertableCount: insertable.length,
      manualReviewCount: manualReview.length,
      invalidCount: invalid.length,
      unresolvedShardCount: Array.isArray(unresolvedShards) ? unresolvedShards.length : 0,
    },
    represented,
    insertable,
    manualReview,
    invalid,
    unresolvedShards,
  };
}

function rowsOf(value = {}) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.rows)) return value.rows;
  if (Array.isArray(value.queries)) return value.queries;
  if (Array.isArray(value.shards)) return value.shards;
  if (Array.isArray(value.records)) return value.records;
  if (Array.isArray(value.products)) return value.products;
  if (Array.isArray(value.candidates)) return value.candidates;
  return [];
}

function countBy(rows = [], field) {
  const counts = {};
  for (const row of rows) {
    const key = trim(row[field]) || 'unknown';
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeShard(row = {}) {
  const rowCount = Number(row.rowCount || row.count || 0) || 0;
  const truncated = Boolean(row.truncated);
  return {
    ...row,
    deptName: trim(row.deptName || row.company || row.queryDeptName) || PING_AN_LIFE_FULL_NAME,
    productName: trim(row.productName || row.keyword),
    status: trim(row.status || row.productStateLabel || row.queryProductState),
    productTypeLabel: trim(row.productTypeLabel || row.queryProductType) || PING_AN_LIFE_PRODUCT_TYPE_LABEL,
    rowCount,
    truncated,
    nextAction: trim(row.nextAction) || (truncated ? 'split_keyword' : 'complete'),
  };
}

function unresolvedShardsOf({ shardSummary = {}, shards = [] } = {}) {
  if (Array.isArray(shardSummary.unresolvedShards)) return shardSummary.unresolvedShards.map(normalizeShard);
  return shards.filter((row) => row.truncated).map(normalizeShard);
}

export function buildShardPlanArtifact({
  generatedAt = new Date().toISOString(),
  shardPlan = {},
  shardSummary = {},
  company = PING_AN_LIFE_FULL_NAME,
  productTypeLabel = PING_AN_LIFE_PRODUCT_TYPE_LABEL,
} = {}) {
  const shards = rowsOf(shardSummary.shards ? { rows: shardSummary.shards } : shardPlan).map(normalizeShard);
  const unresolvedShards = unresolvedShardsOf({ shardSummary, shards });
  const queryCount = Number(shardSummary.queryCount || shardSummary.shardCount || shards.length) || shards.length;
  const truncatedCount = Number(shardSummary.truncatedCount || unresolvedShards.length) || unresolvedShards.length;
  const completeCount = Number(shardSummary.completeCount ?? Math.max(queryCount - truncatedCount, 0));
  return {
    schemaVersion: 'ping-an-jrcpcx-shard-plan-artifact/v1',
    generatedAt,
    company,
    productTypeLabel,
    humanInsuranceFilter: {
      productTypeLabel,
      enabled: true,
    },
    summary: {
      shardCount: queryCount,
      queryCount,
      completeCount,
      truncatedCount,
      unresolvedShardCount: unresolvedShards.length,
    },
    shards,
    unresolvedShards,
  };
}

function catalogMaterialCandidateKey(row = {}) {
  return [
    issuerFullNameOf(row),
    productNameOf(row),
    termsTextCodeOf(row),
    detailUrlOf(row) || trim(row.detailUrl),
  ].map(trim).join(SEP);
}

export function buildCatalogArtifact({
  generatedAt = new Date().toISOString(),
  rows = [],
  catalogRows,
  detailRows = [],
  localRecords = [],
  unresolvedShards = [],
} = {}) {
  const sourceCatalogRows = rowsOf(catalogRows ?? rows);
  const sourceDetailRows = mergeDetailRowsPreferEvidence(rowsOf(detailRows));
  const dedupedCatalogRows = dedupeCatalogRows(sourceCatalogRows);
  const coverageGap = buildCoverageGapReport({
    generatedAt,
    localRecords,
    detailRows: sourceDetailRows,
    unresolvedShards,
  });
  const uniqueProductCount = new Set(dedupedCatalogRows.map((row) => normalizeProductName(productNameOf(row))).filter(Boolean)).size;
  const uniqueMaterialCandidateCount = new Set(dedupedCatalogRows.map(catalogMaterialCandidateKey).filter(Boolean)).size;
  return {
    schemaVersion: 'ping-an-jrcpcx-catalog-artifact/v1',
    generatedAt,
    company: PING_AN_LIFE_FULL_NAME,
    productTypeLabel: PING_AN_LIFE_PRODUCT_TYPE_LABEL,
    summary: {
      rowCount: sourceCatalogRows.length,
      dedupedCatalogRowCount: dedupedCatalogRows.length,
      detailRowCount: rowsOf(detailRows).length,
      mergedDetailRowCount: sourceDetailRows.length,
      localRecordCount: Array.isArray(localRecords) ? localRecords.length : 0,
      uniqueProductCount,
      uniqueMaterialCandidateCount,
      ...coverageGap.summary,
    },
    dedupedCatalogRows,
    mergedDetailRows: sourceDetailRows,
    coverageGapSummary: coverageGap.summary,
    coverageGap,
  };
}

function normalizePageText(value = '') {
  return trim(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n');
}

function extractResponsibilitySection(pageText = '') {
  const sourceText = normalizePageText(pageText);
  if (!sourceText) {
    return { text: '', qualityStatus: 'invalid_empty', qualityReason: 'missing_page_text' };
  }
  const startMatch = /(?:保险责任|保障责任|给付责任)/u.exec(sourceText);
  if (!startMatch) {
    return { text: '', qualityStatus: 'invalid_non_responsibility', qualityReason: 'missing_responsibility_heading' };
  }
  const responsibilityStart = startMatch.index;
  const responsibilitySource = sourceText.slice(responsibilityStart);
  const endPatterns = [
    /\n\s*(?:责任免除|除外责任|免除责任)/u,
    /\n\s*(?:保险金申请|如何申请领取保险金|理赔申请)/u,
    /\n\s*(?:释义|定义|附则)/u,
  ];
  const endIndex = endPatterns
    .map((pattern) => {
      const match = pattern.exec(responsibilitySource);
      return match ? match.index : -1;
    })
    .filter((index) => index > 0)
    .sort((left, right) => left - right)[0];
  const text = trim(endIndex ? responsibilitySource.slice(0, endIndex) : responsibilitySource);
  if (!text) {
    return { text: '', qualityStatus: 'invalid_non_responsibility', qualityReason: 'empty_responsibility_section' };
  }
  return {
    text,
    qualityStatus: text.length >= 120 ? 'valid_complete' : 'valid_partial',
    qualityReason: endIndex ? 'responsibility_section_until_next_heading' : 'responsibility_section_to_end',
  };
}

export function buildResponsibilitiesArtifact({
  generatedAt = new Date().toISOString(),
  rows = [],
  detailRows,
  pageTextRows,
} = {}) {
  const sourceRows = rowsOf(detailRows ?? pageTextRows ?? rows);
  const records = mergeDetailRowsPreferEvidence(sourceRows).map((row) => {
    const extracted = extractResponsibilitySection(row.pageText || row.responsibilityText || row.text);
    const qualityStatus = trim(row.qualityStatus) || extracted.qualityStatus;
    return {
      ...row,
      productName: productNameOf(row),
      clauseUrl: clauseUrlOf(row),
      detailUrl: detailUrlOf(row),
      versionNo: termsTextCodeOf(row),
      materialIdentityKey: materialIdentityKey(row),
      pageText: extracted.text,
      responsibilityText: extracted.text,
      responsibilityQualityStatus: extracted.qualityStatus,
      qualityStatus,
      qualityReason: trim(row.qualityReason) || extracted.qualityReason,
      extractedChars: extracted.text.length,
    };
  });
  const byQualityStatus = countBy(records, 'qualityStatus');
  return {
    schemaVersion: 'ping-an-jrcpcx-responsibilities-artifact/v1',
    generatedAt,
    company: PING_AN_LIFE_FULL_NAME,
    productTypeLabel: PING_AN_LIFE_PRODUCT_TYPE_LABEL,
    summary: {
      sourceRowCount: sourceRows.length,
      recordCount: records.length,
      extractedCount: records.filter((row) => row.pageText).length,
      emptyCount: records.filter((row) => !row.pageText).length,
      byQualityStatus,
    },
    records,
  };
}

function parseCliArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (key === 'pretty') {
      args.pretty = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) index += 1;
    args[key] = value;
  }
  return args;
}

function buildCliArtifact(mode, input) {
  if (mode === 'shard-plan') {
    return buildShardPlanArtifact({
      shardPlan: input.shardPlan || input,
      shardSummary: input.shardSummary || input.summary || input,
      generatedAt: input.generatedAt,
    });
  }
  if (mode === 'catalog') {
    return buildCatalogArtifact({
      generatedAt: input.generatedAt,
      rows: input.rows || input.catalogRows || input.records || input,
      detailRows: input.detailRows || input.details || [],
      localRecords: input.localRecords || input.knowledgeRecords || [],
      unresolvedShards: input.unresolvedShards || input.summary?.unresolvedShards || [],
    });
  }
  if (mode === 'responsibilities') {
    return buildResponsibilitiesArtifact({
      generatedAt: input.generatedAt,
      rows: input.rows || input.detailRows || input.pageTextRows || input.records || input,
    });
  }
  throw new Error(`Unsupported --mode ${mode || '(missing)'}. Use shard-plan, catalog, or responsibilities.`);
}

function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (!args.input) throw new Error('Missing --input <json>');
  if (!args.output) throw new Error('Missing --output <json>');
  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const artifact = buildCliArtifact(args.mode, input);
  fs.writeFileSync(args.output, `${JSON.stringify(artifact, null, args.pretty ? 2 : 0)}\n`);
  process.stdout.write(`${JSON.stringify(artifact.summary || {}, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
