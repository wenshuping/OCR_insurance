import {
  getDefaultOfficialDomainProfiles,
  isPolicyOfficialSourceUrl,
} from './c-policy-analysis.service.mjs';
import { companiesMatch } from './policy-knowledge.service.mjs';

const LEGACY_OFFICIAL_DOMAINS = [
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

const GENERIC_PRODUCT_SUFFIXES = [
  '意外险',
  '寿险',
  '保险',
];
const GENERIC_PRODUCT_BASES = new Set([
  '',
  '商业',
  '养老',
  '商业养老',
  '健康',
  '护理',
  '定期',
  '终身',
  '年金',
  '重大疾病',
  '医疗',
  '两全',
]);

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
  if (isGenericProductQuery(left) || isGenericProductQuery(right)) return false;
  return left.includes(right) || right.includes(left);
}

function isGenericProductQuery(value) {
  for (const suffix of GENERIC_PRODUCT_SUFFIXES) {
    if (!value.endsWith(suffix)) continue;
    const base = value.slice(0, -suffix.length);
    if (GENERIC_PRODUCT_BASES.has(base)) return true;
  }
  return false;
}

function productKeyFor(company, productName) {
  return `company_product:${text(company)}:${text(productName)}`;
}

function materialRank(record = {}) {
  const materialType = text(record.materialType || record.material_type).toLowerCase();
  const title = text(record.title);
  const url = firstUrl(record);
  if (materialType === 'terms' || /条款/u.test(title)) return 0;
  if (materialType === 'product_manual' || /说明书/u.test(title)) return 2;
  if (/\.pdf(?:$|\?)/iu.test(url)) return 1;
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

function hasOfficialDomain(urlValue, { company, productName, officialDomainProfiles }) {
  const url = text(urlValue);
  if (!url) return false;
  if (isPolicyOfficialSourceUrl(
    url,
    { company, name: productName },
    officialDomainProfiles,
  )) return true;
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return LEGACY_OFFICIAL_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function isOfficial(record = {}, sourceIdentity) {
  return record.official === true
    || text(record.evidenceLevel || record.evidence_level) === 'insurer_official'
    || allUrlValues(record).some((url) => hasOfficialDomain(url, sourceIdentity));
}

function isCustomerPolicyUpload(record = {}) {
  return ['customer_policy_photo', 'customer_policy_terms']
    .includes(text(record.sourceKind || record.source_kind));
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
  allowCustomerUploadSources = false,
  officialDomainProfiles = getDefaultOfficialDomainProfiles(),
} = {}) {
  const resolvedCompany = text(company);
  const inputProductName = text(productName);
  const sourceIdentity = {
    company: resolvedCompany,
    productName: inputProductName,
    officialDomainProfiles,
  };
  const matched = normalizeArray(records)
    .filter((record) => companiesMatch(
      record.company || record.companyName,
      resolvedCompany,
      officialDomainProfiles,
    ))
    .filter((record) => productNameMatches(record.productName || record.product_name || record.title, inputProductName))
    .filter((record) => isOfficial(record, sourceIdentity) || (allowCustomerUploadSources && isCustomerPolicyUpload(record)))
    .filter((record) => firstUrl(record) || hasResponsibilityText(record))
    .sort((left, right) => materialRank(left) - materialRank(right)
      || Number(hasResponsibilityText(right)) - Number(hasResponsibilityText(left))
      || Number(Boolean(firstUrl(right))) - Number(Boolean(firstUrl(left)))
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
