const OFFICIAL_DOMAINS = [
  'newchinalife.com',
  'pingan.com',
  'chinalife.com',
  'cpic.com',
  'picc.com',
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
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function productKeyFor(company, productName) {
  return `company_product:${text(company)}:${text(productName)}`;
}

function materialRank(record = {}) {
  const materialType = text(record.materialType || record.material_type).toLowerCase();
  const title = text(record.title);
  const url = text(record.url);
  if (materialType === 'terms' || /条款/u.test(title)) return 0;
  if (materialType === 'product_manual' || /说明书/u.test(title)) return 1;
  if (/\.pdf(?:$|\?)/iu.test(url)) return 2;
  return 3;
}

function hasResponsibilityText(record = {}) {
  return /保险责任|给付|保险金|年金|豁免/u.test(text(record.pageText || record.responsibilityText || record.content));
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
  return record.official === true || hasOfficialDomain(record.url);
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
    .filter((record) => text(record.url) || hasResponsibilityText(record))
    .sort((left, right) => materialRank(left) - materialRank(right) || text(right.pageText).length - text(left.pageText).length);

  const recordsWithResponsibility = matched.filter(hasResponsibilityText);
  const resolvedProductName = preferredProductName({ inputProductName, records: matched });

  return {
    productKey: productKeyFor(resolvedCompany, resolvedProductName),
    company: resolvedCompany,
    productName: resolvedProductName,
    records: recordsWithResponsibility,
    status: recordsWithResponsibility.length ? 'ready' : 'needs_source_review',
  };
}
