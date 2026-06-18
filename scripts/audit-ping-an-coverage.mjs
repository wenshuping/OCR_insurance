import fs from 'node:fs';

export function trim(value) {
  return String(value || '').trim();
}

export function normalizeProductName(value = '') {
  return trim(value)
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/[，]/gu, ',')
    .replace(/[：]/gu, ':')
    .replace(/\s+/gu, '')
    .replace(/,+/gu, ',');
}

export function isPingAnIssuer(value = '') {
  const normalized = trim(value).replace(/\s+/gu, '');
  if (!normalized) return false;
  if (normalized === '中国平安') return true;
  if (normalized.includes('中国平安人寿')) return true;
  if (normalized.includes('平安人寿')) return true;
  if (normalized.includes('平安健康保险')) return true;
  return false;
}

export function planCodeFromUrl(url = '') {
  try {
    return trim(new URL(url).searchParams.get('planCode'));
  } catch {
    return '';
  }
}

function countBy(rows = [], keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function hasArchivedPdf(record = {}, existsFn = fs.existsSync) {
  const pdfPath = trim(record.pdfLocalPath);
  return Boolean(pdfPath && existsFn(pdfPath));
}

export function classifyLocalRepairCandidate(record = {}, { existsFn = fs.existsSync } = {}) {
  const pageText = trim(record.pageText);
  const qualityStatus = trim(record.qualityStatus);
  const issues = [];
  if (!pageText) issues.push('empty_text');
  if (pageText && pageText.length < 100) issues.push('very_short_text_lt_100');
  else if (pageText && pageText.length < 300) issues.push('short_text_lt_300');
  if (!qualityStatus) issues.push('blank_quality_status');
  if (qualityStatus === 'valid_partial') issues.push('flagged_valid_partial');
  if (qualityStatus === 'invalid_empty' || qualityStatus === 'invalid_responsibility') issues.push('flagged_invalid');
  if (/责任免除/u.test(pageText)) issues.push('boundary_overrun_exclusion_section');
  if (/保单红利|现金价值|保险金申请|如何领取保险金/u.test(pageText)) issues.push('boundary_overrun_policy_benefit_section');
  if (!hasArchivedPdf(record, existsFn)) issues.push('missing_archived_pdf');

  let recommendedAction = '';
  if (issues.includes('empty_text') || issues.includes('flagged_invalid')) recommendedAction = 'ocr_official_pdf';
  else if (issues.some((issue) => issue.startsWith('boundary_overrun'))) recommendedAction = 'boundary_cleanup';
  else if (issues.includes('missing_archived_pdf') || issues.includes('short_text_lt_300') || issues.includes('very_short_text_lt_100') || issues.includes('blank_quality_status') || issues.includes('flagged_valid_partial')) {
    recommendedAction = 'reextract_official_pdf';
  }

  return { issues, recommendedAction };
}

export function normalizeExternalSourceRecord(record = {}, { sourceName = '' } = {}) {
  const issuerFullName = trim(record.issuerFullName || record.company || record.companyName || record.deptName || record['发行机构全称']);
  const productName = trim(record.productName || record.product || record['产品名称']);
  const detailUrl = trim(record.detailUrl || record.sourceUrl || record.source || record.url);
  const clauseUrl = trim(record.clauseUrl || record.pdfOriginalUrl || record.url);
  const pageText = trim(record.pageText);
  return {
    sourceName: trim(sourceName || record.sourceName || record.sourceLevel || record.parser || 'external_source'),
    sourceLevel: trim(record.sourceLevel),
    issuerFullName,
    productName,
    normalizedProductName: normalizeProductName(productName),
    productType: trim(record.productType || record['产品类别']),
    salesStatus: trim(record.salesStatus || record.productState || record['产品销售状态']),
    detailUrl,
    clauseUrl,
    url: clauseUrl || detailUrl,
    planCode: trim(record.planCode) || planCodeFromUrl(clauseUrl || detailUrl),
    materialType: trim(record.materialType || 'terms'),
    responsibilityPreview: pageText.slice(0, 800),
    responsibilityQualityStatus: trim(record.qualityStatus || (pageText ? 'suspect_needs_source_check' : 'invalid_empty')),
    pdfLocalPath: trim(record.pdfLocalPath),
    pdfSha256: trim(record.pdfSha256),
    pdfBytes: Number(record.pdfBytes || record.bytes || 0) || 0,
    rawId: trim(record.id || record.catalogId || record.localId),
  };
}

export function normalizeExternalSourceRecords(records = [], options = {}) {
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeExternalSourceRecord(record, options))
    .filter((record) => record.productName && isPingAnIssuer(record.issuerFullName));
}

export function buildExistingRepairAudit(records = [], { existsFn = fs.existsSync, generatedAt = new Date().toISOString() } = {}) {
  const repairRecords = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (!isPingAnIssuer(record.company)) continue;
    const classification = classifyLocalRepairCandidate(record, { existsFn });
    if (!classification.recommendedAction) continue;
    repairRecords.push({
      id: record.id,
      company: trim(record.company),
      productName: trim(record.productName),
      title: trim(record.title),
      materialType: trim(record.materialType),
      url: trim(record.url),
      currentQualityStatus: trim(record.qualityStatus),
      pageTextChars: trim(record.pageText).length,
      hasArchivedPdf: hasArchivedPdf(record, existsFn),
      pdfLocalPath: trim(record.pdfLocalPath),
      issues: classification.issues,
      recommendedAction: classification.recommendedAction,
    });
  }
  return {
    generatedAt,
    records: repairRecords,
    summary: {
      recordCount: repairRecords.length,
      productCount: new Set(repairRecords.map((row) => normalizeProductName(row.productName)).filter(Boolean)).size,
      byRecommendedAction: countBy(repairRecords, (row) => row.recommendedAction),
      byIssue: repairRecords.reduce((acc, row) => {
        for (const issue of row.issues) acc[issue] = (acc[issue] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}
