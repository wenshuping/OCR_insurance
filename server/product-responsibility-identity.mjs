import { createHash } from 'node:crypto';

import { getDefaultOfficialDomainProfiles } from './c-policy-analysis.service.mjs';
import { catalogProductIdentity } from './product-catalog-search.mjs';

function text(value) {
  return String(value || '').trim();
}

function comparable(value) {
  return text(value)
    .normalize('NFKC')
    .replace(/[\s《》（）()【】\[\]·,，。:：;；、-]/gu, '')
    .toLowerCase();
}

function bareCompanyIdentity(value) {
  const normalized = comparable(value)
    .replace(/(?:股份有限公司|有限责任公司|有限公司|股份公司|公司)$/gu, '');
  return normalized.endsWith('再保险') ? normalized : normalized.replace(/保险$/gu, '');
}

function profileAliases(profile = {}) {
  return [
    profile.company,
    ...(Array.isArray(profile.aliases) ? profile.aliases : []),
    ...(Array.isArray(profile.companyAliases) ? profile.companyAliases : []),
  ].map(text).filter(Boolean);
}

const DEFAULT_COMPANY_PROFILES = getDefaultOfficialDomainProfiles();

export function responsibilityCompanyIdentity(value, profiles = DEFAULT_COMPANY_PROFILES) {
  const normalized = comparable(value);
  const bare = bareCompanyIdentity(value);
  if (!normalized || !bare) return '';
  const matches = (Array.isArray(profiles) ? profiles : []).filter((profile) => (
    profileAliases(profile).some((alias) => (
      comparable(alias) === normalized || bareCompanyIdentity(alias) === bare
    ))
  ));
  return matches.length === 1 ? `profile:${text(matches[0].id)}` : `company:${bare}`;
}

export function responsibilityProductNameIdentity(value) {
  return catalogProductIdentity(value);
}

export function responsibilityProductIdentity({ company = '', productName = '' } = {}) {
  const companyIdentity = responsibilityCompanyIdentity(company);
  const productNameIdentity = responsibilityProductNameIdentity(productName);
  if (!companyIdentity || !productNameIdentity) return null;
  const digest = createHash('sha1')
    .update(`${companyIdentity}\u001f${productNameIdentity}`)
    .digest('hex')
    .slice(0, 16);
  return {
    companyIdentity,
    productNameIdentity,
    productKey: `responsibility_product:${digest}`,
  };
}

export function productIdentityKey(row = {}) {
  return text(
    row.canonicalProductId
      || row.canonical_product_id
      || row.productKey
      || row.product_key,
  );
}

function legacyResponsibilityProductMatch(left = {}, right = {}) {
  const leftIdentity = responsibilityProductIdentity({
    company: left.company,
    productName: left.productName || left.product_name || left.name,
  });
  const rightIdentity = responsibilityProductIdentity({
    company: right.company,
    productName: right.productName || right.product_name || right.name,
  });
  return Boolean(leftIdentity && rightIdentity
    && leftIdentity.companyIdentity === rightIdentity.companyIdentity
    && leftIdentity.productNameIdentity === rightIdentity.productNameIdentity);
}

export function productIdentityMatches(left = {}, right = {}) {
  const leftKey = productIdentityKey(left);
  const rightKey = productIdentityKey(right);
  // A populated key is authoritative. A legacy row without a key may still
  // be resolved by its exact normalized company/product identity, but it can
  // never override a conflicting populated key.
  if (leftKey && rightKey) return leftKey === rightKey;
  if (!leftKey && !rightKey) {
    const leftCompany = text(left.company);
    const leftName = text(left.productName || left.product_name || left.name);
    const rightCompany = text(right.company);
    const rightName = text(right.productName || right.product_name || right.name);
    // Partial legacy responsibility rows are completed by their enclosing
    // policy/card context; do not reject them solely because one side has no
    // identity columns at all.
    if (!(leftCompany && leftName && rightCompany && rightName)) return true;
  }
  return legacyResponsibilityProductMatch(left, right);
}

export function sameResponsibilityProduct(left = {}, right = {}) {
  return productIdentityMatches(left, right);
}

export function listEquivalentResponsibilityProductRows(db, target = {}, { includeCustomerSummaries = true } = {}) {
  if (!db || typeof db.prepare !== 'function') return [];
  const tables = [
    { table: 'insurance_indicator_records' },
    { table: 'product_responsibility_cards', productKey: true },
    { table: 'optional_responsibility_records' },
    { table: 'product_responsibility_artifacts' },
    ...(includeCustomerSummaries ? [{ table: 'product_customer_responsibility_summaries', productKey: true }] : []),
  ];
  const matches = [];
  for (const source of tables) {
    const selectedProductKey = source.productKey ? ', product_key' : '';
    let rows;
    try {
      rows = db.prepare(`SELECT DISTINCT company, product_name${selectedProductKey} FROM ${source.table}`).all();
    } catch {
      continue;
    }
    for (const row of rows) {
      if (!sameResponsibilityProduct(
        { company: row.company, productName: row.product_name },
        target,
      )) continue;
      matches.push({
        table: source.table,
        company: text(row.company),
        productName: text(row.product_name),
        productKey: text(row.product_key),
      });
    }
  }
  return matches;
}
