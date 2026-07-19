function text(value) {
  return String(value ?? '').trim();
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(text(value));
}

function unresolved(input, reasons, candidates = []) {
  return {
    canonicalProductId: text(input.canonicalProductId),
    productVersionId: '',
    resolution: 'unresolved',
    confidence: 0,
    reasons,
    effectiveFrom: '',
    effectiveTo: '',
    candidates: candidates.map((version) => text(version?.id)).filter(Boolean),
  };
}

export function resolveProductVersion(input = {}) {
  const canonicalProductId = text(input.canonicalProductId);
  if (!canonicalProductId) return unresolved(input, ['missing_canonical_product_id']);

  const dateFields = ['effectiveFrom', 'effectiveTo', 'asOfDate'];
  const invalidDateField = dateFields.find((field) => text(input[field]) && !isIsoDate(input[field]));
  if (invalidDateField) return unresolved(input, [`invalid_${invalidDateField}`]);

  const versionLabel = text(input.versionLabel);
  const filingCode = text(input.filingCode);
  const effectiveFrom = text(input.effectiveFrom);
  const effectiveTo = text(input.effectiveTo);
  const asOfDate = text(input.asOfDate);
  const versions = (Array.isArray(input.versions) ? input.versions : [])
    .filter((version) => text(version?.canonicalProductId) === canonicalProductId);

  const matches = versions.filter((version) => {
    if (versionLabel && text(version?.versionLabel) !== versionLabel) return false;
    if (filingCode && text(version?.filingCode) !== filingCode) return false;
    if (effectiveFrom && text(version?.effectiveFrom) !== effectiveFrom) return false;
    if (effectiveTo && text(version?.effectiveTo) !== effectiveTo) return false;
    if (asOfDate && text(version?.effectiveFrom) && text(version.effectiveFrom) > asOfDate) return false;
    if (asOfDate && text(version?.effectiveTo) && text(version.effectiveTo) < asOfDate) return false;
    return true;
  });

  if (matches.length !== 1) {
    return unresolved(input, [matches.length ? 'ambiguous_version_match' : 'no_version_match'], matches);
  }

  const version = matches[0];
  const reasons = [];
  if (versionLabel) reasons.push('version_label_exact');
  if (filingCode) reasons.push('filing_code_exact');
  if (effectiveFrom) reasons.push('effective_from_exact');
  if (effectiveTo) reasons.push('effective_to_exact');
  if (asOfDate) reasons.push('effective_at_date');
  if (!reasons.length) reasons.push('single_product_version');
  return {
    canonicalProductId,
    productVersionId: text(version.id),
    resolution: 'exact',
    confidence: 1,
    reasons,
    effectiveFrom: text(version.effectiveFrom),
    effectiveTo: text(version.effectiveTo),
    candidates: [text(version.id)],
  };
}

export function createProductVersionResolutionService({ store } = {}) {
  if (!store?.listProductVersions) {
    throw new TypeError('Product version resolution service requires listProductVersions');
  }
  return {
    resolve(input = {}) {
      const tenantId = text(input.tenantId);
      const canonicalProductId = text(input.canonicalProductId);
      if (!tenantId) return unresolved(input, ['missing_tenant_id']);
      const versions = store.listProductVersions({ tenantId, canonicalProductId });
      return resolveProductVersion({ ...input, canonicalProductId, versions });
    },
  };
}
