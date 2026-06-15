import { attachPolicyCoverageIndicators } from './policy-ocr.domain.mjs';

function normalizeKeyPart(value) {
  return String(value || '').trim().replace(/\s+/gu, '');
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function productKeyFromParts({ canonicalProductId = '', company = '', productName = '' } = {}) {
  const canonical = String(canonicalProductId || '').trim();
  if (canonical) return `canonical:${canonical}`;
  const normalizedCompany = normalizeKeyPart(company);
  const normalizedProductName = normalizeKeyPart(productName);
  if (!normalizedCompany || !normalizedProductName) return '';
  return `company_product:${normalizedCompany}:${normalizedProductName}`;
}

export function deriveIndicatorProductKeys(indicator = {}) {
  return unique([
    productKeyFromParts({ canonicalProductId: indicator.canonicalProductId }),
    productKeyFromParts({ company: indicator.company, productName: indicator.productName }),
  ]);
}

export function derivePolicyProductKeys(policy = {}) {
  const keys = [
    productKeyFromParts({ canonicalProductId: policy.canonicalProductId }),
    productKeyFromParts({ company: policy.company, productName: policy.name }),
  ];
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    keys.push(productKeyFromParts({ canonicalProductId: plan?.canonicalProductId }));
    keys.push(productKeyFromParts({
      company: plan?.company || policy.company,
      productName: plan?.matchedProductName || plan?.name,
    }));
  }
  return unique(keys);
}

export function buildPolicyDerivedResult({
  policy,
  indicatorRecords = [],
  knowledgeRecords = [],
  optionalResponsibilityRecords = [],
  productIndicatorVersions = [],
  now = new Date().toISOString(),
} = {}) {
  const productKeys = derivePolicyProductKeys(policy);
  const attached = attachPolicyCoverageIndicators(
    policy,
    indicatorRecords,
    knowledgeRecords,
    optionalResponsibilityRecords,
  );
  const versionByKey = new Map((Array.isArray(productIndicatorVersions) ? productIndicatorVersions : []).map((row) => [
    String(row.productKey || row.product_key || '').trim(),
    Number(row.version || 0) || 0,
  ]));
  const indicatorVersions = {};
  for (const key of productKeys) indicatorVersions[key] = versionByKey.get(key) || 0;
  return {
    policyId: Number(policy?.id || 0),
    productKeys,
    coverageIndicators: Array.isArray(attached.coverageIndicators) ? attached.coverageIndicators : [],
    optionalResponsibilities: Array.isArray(attached.optionalResponsibilities) ? attached.optionalResponsibilities : [],
    indicatorVersions,
    knowledgeVersion: 0,
    status: 'ready',
    staleReason: '',
    generatedAt: now,
    error: '',
  };
}

export function mergePolicyDerivedResult(policy = {}, derived = null) {
  if (!derived) {
    return {
      ...policy,
      coverageIndicators: Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : [],
      optionalResponsibilities: Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities : [],
      derivedStatus: 'stale',
      derivedStaleReason: 'missing',
    };
  }
  return {
    ...policy,
    coverageIndicators: Array.isArray(derived.coverageIndicators) ? derived.coverageIndicators : [],
    optionalResponsibilities: Array.isArray(derived.optionalResponsibilities) ? derived.optionalResponsibilities : [],
    derivedStatus: String(derived.status || 'stale'),
    derivedStaleReason: String(derived.staleReason || ''),
    derivedGeneratedAt: String(derived.generatedAt || ''),
    derivedError: String(derived.error || ''),
  };
}
