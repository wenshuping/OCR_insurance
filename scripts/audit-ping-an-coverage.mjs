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
    normalizedProductName: trim(record.normalizedProductName) || normalizeProductName(productName),
    productType: trim(record.productType || record['产品类别']),
    salesStatus: trim(record.salesStatus || record.productState || record['产品销售状态']),
    detailUrl,
    clauseUrl,
    url: clauseUrl || detailUrl,
    planCode: trim(record.planCode) || planCodeFromUrl(clauseUrl || detailUrl),
    materialType: trim(record.materialType || 'terms'),
    responsibilityPreview: trim(record.responsibilityPreview) || pageText.slice(0, 800),
    responsibilityQualityStatus: trim(record.responsibilityQualityStatus) || trim(record.qualityStatus || (pageText ? 'suspect_needs_source_check' : 'invalid_empty')),
    pdfLocalPath: trim(record.pdfLocalPath),
    pdfSha256: trim(record.pdfSha256),
    pdfBytes: Number(record.pdfBytes || record.bytes || 0) || 0,
    rawId: trim(record.rawId) || trim(record.id || record.catalogId || record.localId),
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

function pushMap(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

export function buildLocalPingAnIndexes(localRecords = []) {
  const byProductName = new Map();
  const byUrl = new Map();
  const byPlanCode = new Map();
  const records = (Array.isArray(localRecords) ? localRecords : [])
    .filter((record) => isPingAnIssuer(record.company))
    .map((record) => ({
      id: record.id,
      company: trim(record.company),
      productName: trim(record.productName),
      normalizedProductName: normalizeProductName(record.productName),
      title: trim(record.title),
      url: trim(record.url),
      planCode: trim(record.planCode) || planCodeFromUrl(record.url),
      materialType: trim(record.materialType),
    }));

  for (const record of records) {
    pushMap(byProductName, record.normalizedProductName, record);
    pushMap(byUrl, record.url, record);
    pushMap(byPlanCode, record.planCode, record);
  }

  return { records, byProductName, byUrl, byPlanCode };
}

export function matchExternalToLocal(externalRecord = {}, indexes = buildLocalPingAnIndexes([])) {
  const urlMatches = indexes.byUrl.get(trim(externalRecord.url)) || indexes.byUrl.get(trim(externalRecord.clauseUrl)) || [];
  if (urlMatches.length) {
    return { status: 'represented_by_url', missingReason: '', localMatches: urlMatches };
  }

  const planCode = trim(externalRecord.planCode) || planCodeFromUrl(externalRecord.url) || planCodeFromUrl(externalRecord.clauseUrl);
  const planMatches = planCode ? indexes.byPlanCode.get(planCode) || [] : [];
  if (planMatches.length) {
    return { status: 'represented_by_plan_code', missingReason: '', localMatches: planMatches };
  }

  const normalizedProductName = trim(externalRecord.normalizedProductName) || normalizeProductName(externalRecord.productName);
  const nameMatches = indexes.byProductName.get(normalizedProductName) || [];
  if (nameMatches.length === 1) {
    return { status: 'represented_by_product_name', missingReason: '', localMatches: nameMatches };
  }
  if (nameMatches.length > 1) {
    return { status: 'ambiguous_local_match', missingReason: 'ambiguous_local_match', localMatches: nameMatches };
  }

  return { status: 'missing', missingReason: 'no_local_product_match', localMatches: [] };
}

export function buildMissingSourceCandidates(externalRecords = [], localRecords = []) {
  const indexes = buildLocalPingAnIndexes(localRecords);
  const candidates = [];
  for (const record of Array.isArray(externalRecords) ? externalRecords : []) {
    const match = matchExternalToLocal(record, indexes);
    if (!match.missingReason) continue;
    candidates.push({
      productName: record.productName,
      normalizedProductName: record.normalizedProductName,
      issuerFullName: record.issuerFullName,
      productType: record.productType,
      salesStatus: record.salesStatus,
      sourceName: record.sourceName,
      sourceLevel: record.sourceLevel,
      detailUrl: record.detailUrl,
      clauseUrl: record.clauseUrl,
      url: record.url,
      planCode: record.planCode,
      materialType: record.materialType,
      pdfLocalPath: record.pdfLocalPath,
      pdfSha256: record.pdfSha256,
      pdfBytes: record.pdfBytes,
      responsibilityPreview: record.responsibilityPreview,
      responsibilityQualityStatus: record.responsibilityQualityStatus,
      localMatchCandidates: match.localMatches.slice(0, 10),
      matchStatus: match.status,
      missingReason: match.missingReason,
      recommendedAction: match.missingReason === 'ambiguous_local_match' ? 'manual_review' : 'review_then_insert',
    });
  }
  return candidates;
}
