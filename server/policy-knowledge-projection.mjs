import {
  productIdentityMatches,
  responsibilityCompanyIdentity,
} from './product-responsibility-identity.mjs';

function text(value) {
  return String(value || '').trim();
}

function parsePayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasProjectionSource(record = {}) {
  return Boolean(text(record.url || record.sourceUrl || record.source_url)
    || text(record.pageText || record.originalPageText || record.sourceExcerpt || record.snippet));
}

function sourceIdentity(record = {}) {
  const digest = text(record.sourceDigest || record.source_digest);
  if (digest) return `digest:${digest}`;
  const url = text(record.url || record.sourceUrl || record.source_url);
  if (url) return `url:${url}`;
  const id = text(record.id);
  return id ? `id:${id}` : '';
}

function normalizeKnowledgeRow(row = {}) {
  const payload = parsePayload(row.payload);
  return {
    ...payload,
    id: payload.id || row.id,
    company: text(payload.company) || text(row.company),
    productName: text(payload.productName || payload.product_name) || text(row.product_name),
    url: text(payload.url || payload.sourceUrl) || text(row.url),
    sourceDigest: text(payload.sourceDigest || payload.source_digest),
  };
}

function officialMonthlyPayoutFactorExists(knowledgeRecords = []) {
  return (Array.isArray(knowledgeRecords) ? knowledgeRecords : []).some((record) => (
    (record.official === true || text(record.evidenceLevel) === 'insurer_official')
    && /月领折算系数(?:的数值)?为\s*(?:0(?:\.\d+)?|1(?:\.0+)?)/u.test(
      text(record.pageText || record.originalPageText || record.sourceExcerpt),
    )
  ));
}

function derivedIndicators(derivedResult = {}) {
  const cardIndicators = (Array.isArray(derivedResult.responsibilityCards) ? derivedResult.responsibilityCards : [])
    .flatMap((card) => Array.isArray(card?.indicators) ? card.indicators : []);
  return [
    ...(Array.isArray(derivedResult.coverageIndicators) ? derivedResult.coverageIndicators : []),
    ...cardIndicators,
  ];
}

export function derivedProjectionNeedsOfficialPayoutFactorRefresh({
  derivedResult = {},
  knowledgeRecords = [],
} = {}) {
  if (!officialMonthlyPayoutFactorExists(knowledgeRecords)) return false;
  return derivedIndicators(derivedResult).some((indicator) => (
    (Array.isArray(indicator?.branches) ? indicator.branches : []).some((branch) => (
      text(branch?.branchId) === 'monthly'
      && /(?:monthly_conversion_factor|月领折算系数)/u.test(
        `${text(branch?.normalizedFormula)} ${text(branch?.formulaText)}`,
      )
    ))
  ));
}

export function mergeProjectionKnowledgeRecordsForPolicy({ policy = {}, recordGroups = [] } = {}) {
  const seenSources = new Set();
  const merged = [];
  for (const records of recordGroups) {
    for (const record of Array.isArray(records) ? records : []) {
      if (!productIdentityMatches(record, policy) || !hasProjectionSource(record)) continue;
      const identity = sourceIdentity(record);
      if (identity && seenSources.has(identity)) continue;
      if (identity) seenSources.add(identity);
      merged.push(record);
    }
  }
  return merged;
}

export function loadProjectionKnowledgeRecordsForPolicy({
  db,
  policy = {},
  filteredRecords = [],
  stateRecords = [],
} = {}) {
  const inMemoryRecords = mergeProjectionKnowledgeRecordsForPolicy({
    policy,
    recordGroups: [filteredRecords, stateRecords],
  });
  const company = responsibilityCompanyIdentity(policy.company);
  const productName = text(policy.name || policy.productName);
  if (!company || !productName || !db?.prepare) return inMemoryRecords;
  try {
    const databaseRecords = db.prepare(`
      SELECT id, company, product_name, url, payload
      FROM knowledge_records
      WHERE product_name = ?
      ORDER BY id ASC
    `).all(productName).map(normalizeKnowledgeRow);
    return mergeProjectionKnowledgeRecordsForPolicy({
      policy,
      recordGroups: [inMemoryRecords, databaseRecords],
    });
  } catch {
    return inMemoryRecords;
  }
}
