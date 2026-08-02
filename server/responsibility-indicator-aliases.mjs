function text(value) {
  return String(value || '').trim();
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function liabilityName(indicator = {}) {
  return text(
    indicator.liability
    || indicator.responsibilityName
    || indicator.benefitName
    || indicator.title
    || indicator.name
    || indicator.coverageType,
  );
}

function sourceExcerpt(indicator = {}) {
  return text(
    indicator.sourceExcerpt
    || indicator.excerpt
    || indicator.sourceText
    || indicator.pageText,
  );
}

function combinedDeathDisabilityTitle(value = '', { exact = false } = {}) {
  const target = compact(value);
  const pattern = exact
    ? /^(?:疾病身故(?:或|和)(?:疾病)?(?:身体)?全残保险金|身故(?:或|和)(?:身体)?全残保险金|身故(?:或|和)全残保险金)$/u
    : /(?:疾病身故(?:或|和)(?:疾病)?(?:身体)?全残保险金|身故(?:或|和)(?:身体)?全残保险金|身故(?:或|和)全残保险金)/u;
  return target.match(pattern)?.[0] || '';
}

export function combinedDeathDisabilityTitleForLegacyAlias(indicator = {}) {
  if (!/^疾病全残(?:保险金)?$/u.test(compact(liabilityName(indicator)))) return '';
  return combinedDeathDisabilityTitle(sourceExcerpt(indicator));
}

function indicatorSourceKey(indicator = {}) {
  return compact(
    indicator.sourceDigest
    || indicator.responsibilitySourceDigest
    || indicator.sourceUrl
    || indicator.url
    || indicator.source_url,
  );
}

function indicatorProductKey(indicator = {}) {
  const canonicalProductId = compact(indicator.canonicalProductId);
  if (canonicalProductId) return `canonical:${canonicalProductId}`;
  const company = compact(indicator.company);
  const productName = compact(indicator.productName || indicator.product_name);
  return company && productName ? `${company}\u001f${productName}` : '';
}

function aliasScopeKey(indicator = {}, title = '') {
  const productKey = indicatorProductKey(indicator);
  const sourceKey = indicatorSourceKey(indicator);
  const normalizedTitle = compact(title);
  return productKey && sourceKey && normalizedTitle
    ? `${productKey}\u001f${sourceKey}\u001f${normalizedTitle}`
    : '';
}

export function removeSupersededDiseaseDisabilityAliases(indicators = []) {
  const rows = Array.isArray(indicators) ? indicators : [];
  const canonicalKeys = new Set(rows.map((indicator) => {
    const title = combinedDeathDisabilityTitle(liabilityName(indicator), { exact: true });
    return title ? aliasScopeKey(indicator, title) : '';
  }).filter(Boolean));

  if (!canonicalKeys.size) return rows;
  return rows.filter((indicator) => {
    const title = combinedDeathDisabilityTitleForLegacyAlias(indicator);
    const key = title ? aliasScopeKey(indicator, title) : '';
    return !key || !canonicalKeys.has(key);
  });
}
