import { createHash } from 'node:crypto';

function trim(value) {
  return String(value || '').trim();
}

export function normalizeCanonicalProductPart(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/\s+/gu, '');
}

export function buildCanonicalProductId({ company = '', productName = '' } = {}) {
  const normalizedCompany = normalizeCanonicalProductPart(company);
  const normalizedProductName = normalizeCanonicalProductPart(productName);
  if (!normalizedCompany || !normalizedProductName) return '';
  const digest = createHash('sha1')
    .update(`${normalizedCompany}\u001f${normalizedProductName}`)
    .digest('hex')
    .slice(0, 16);
  return `product_${digest}`;
}

export function canonicalProductIdFromOfficialProduct({ company = '', productName = '' } = {}) {
  return buildCanonicalProductId({ company, productName });
}

export function resolveRecordProductName(record = {}) {
  return trim(record.productName || record.product_name || record.matchedProductName);
}

export function resolveRecordCompany(record = {}, fallbackCompany = '') {
  return trim(record.company || record.companyName || fallbackCompany);
}

export function withCanonicalProductId(record = {}, fallbackCompany = '') {
  const existing = trim(record.canonicalProductId);
  if (existing) return { ...record, canonicalProductId: existing };
  const company = resolveRecordCompany(record, fallbackCompany);
  const productName = resolveRecordProductName(record);
  const canonicalProductId = canonicalProductIdFromOfficialProduct({ company, productName });
  return canonicalProductId ? { ...record, canonicalProductId } : { ...record };
}

export function canonicalProductIdForRecord(record = {}, fallbackCompany = '') {
  return trim(record.canonicalProductId)
    || withCanonicalProductId(record, fallbackCompany).canonicalProductId
    || '';
}
