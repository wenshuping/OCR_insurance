import fs from 'node:fs';

export const PING_AN_LIFE_FULL_NAME = '中国平安人寿保险股份有限公司';
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

export function issuerFullNameOf(row = {}) {
  return trim(row.issuerFullName || row.company || row.companyName || row.deptName || row.queryDeptName || row.detailFields?.公司名称);
}

export function productNameOf(row = {}) {
  return trim(row.productName || row.product || row.detailFields?.产品名称);
}

export function detailUrlOf(row = {}) {
  return trim(row.detailUrl || row.sourceUrl || row.source);
}

export function clauseUrlOf(row = {}) {
  return trim(row.clauseUrl || row.pdfOriginalUrl || row.url);
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
  if (productType && productType !== '人身保险类' && !/保险/u.test(productType)) reasons.push('not_human_insurance');
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
  const localUrls = new Set((Array.isArray(localRecords) ? localRecords : []).map((row) => trim(row.url)).filter(Boolean));
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
