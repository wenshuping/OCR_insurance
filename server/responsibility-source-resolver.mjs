const OFFICIAL_DOMAINS = [
  'newchinalife.com',
  'pingan.com',
  'chinalife.com',
  'cpic.com',
  'picc.com',
];

const RESPONSIBILITY_TEXT_FIELDS = [
  'responsibilityText',
  'responsibility_text',
  'pageText',
  'text',
  'content',
  'sourceText',
  'source_text',
  'sourceExcerpt',
  'source_excerpt',
  'excerpt',
  'snippet',
  'summary',
  'sourceSummary',
  'source_summary',
  'responsibilitySummary',
  'responsibility_summary',
];

const URL_FIELDS = [
  'url',
  'officialUrl',
  'official_url',
  'sourceUrl',
  'source_url',
  'fileUrl',
  'file_url',
];

const MIN_CONTAINS_MATCH_LENGTH = 4;
const GENERIC_PRODUCT_MAX_LENGTH = 6;
const GENERIC_PRODUCT_SUFFIXES = [
  '保险',
  '寿险',
  '意外险',
];

function text(value) {
  return String(value ?? '').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function comparable(value) {
  return text(value).replace(/[\s《》（）()【】\[\]·,，。:：;；、\-—_/“”"'‘’]/gu, '');
}

function productNameMatches(candidate, query) {
  const left = comparable(candidate);
  const right = comparable(query);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length < MIN_CONTAINS_MATCH_LENGTH || right.length < MIN_CONTAINS_MATCH_LENGTH) return false;
  if (isGenericProductQuery(left) || isGenericProductQuery(right)) return false;
  return left.includes(right) || right.includes(left);
}

function isGenericProductQuery(value) {
  return value.length <= GENERIC_PRODUCT_MAX_LENGTH
    && GENERIC_PRODUCT_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

function productKeyFor(company, productName) {
  return `company_product:${text(company)}:${text(productName)}`;
}

function materialRank(record = {}) {
  const materialType = text(record.materialType || record.material_type).toLowerCase();
  const title = text(record.title);
  const url = firstUrl(record);
  if (materialType === 'terms' || /条款/u.test(title)) return 0;
  if (materialType === 'product_manual' || /说明书/u.test(title)) return 1;
  if (/\.pdf(?:$|\?)/iu.test(url)) return 2;
  return 3;
}

function firstUrl(record = {}) {
  return URL_FIELDS.map((field) => text(record[field])).find(Boolean) || '';
}

function allUrlValues(record = {}) {
  return URL_FIELDS.map((field) => record[field]);
}

function responsibilityText(record = {}) {
  return RESPONSIBILITY_TEXT_FIELDS.map((field) => text(record[field])).filter(Boolean).join('\n');
}

function hasResponsibilityText(record = {}) {
  return /保险责任|给付|保险金|年金|豁免/u.test(responsibilityText(record));
}

function hasOfficialDomain(urlValue) {
  const url = text(urlValue);
  if (!url) return false;

  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return OFFICIAL_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isOfficial(record = {}) {
  return record.official === true
    || text(record.evidenceLevel || record.evidence_level) === 'insurer_official'
    || allUrlValues(record).some(hasOfficialDomain);
}

function preferredProductName({ inputProductName, records }) {
  const counts = new Map();

  for (const record of records) {
    const name = text(record.productName || record.product_name || record.title);
    if (!name || !productNameMatches(name, inputProductName)) continue;
    counts.set(name, (counts.get(name) || 0) + (materialRank(record) === 0 ? 4 : 2));
  }

  return [...counts.entries()].sort((left, right) => right[1] - left[1] || right[0].length - left[0].length)[0]?.[0] || text(inputProductName);
}

export function resolveOfficialResponsibilitySources({
  company = '',
  productName = '',
  records = [],
} = {}) {
  const resolvedCompany = text(company);
  const inputProductName = text(productName);
  const matched = normalizeArray(records)
    .filter((record) => text(record.company || record.companyName) === resolvedCompany)
    .filter((record) => productNameMatches(record.productName || record.product_name || record.title, inputProductName))
    .filter((record) => isOfficial(record))
    .filter((record) => firstUrl(record) || hasResponsibilityText(record))
    .sort((left, right) => Number(hasResponsibilityText(right)) - Number(hasResponsibilityText(left))
      || materialRank(left) - materialRank(right)
      || responsibilityText(right).length - responsibilityText(left).length);

  const resolvedProductName = preferredProductName({ inputProductName, records: matched });

  return {
    productKey: productKeyFor(resolvedCompany, resolvedProductName),
    company: resolvedCompany,
    productName: resolvedProductName,
    records: matched,
    status: matched.length ? 'ready' : 'needs_source_review',
  };
}
