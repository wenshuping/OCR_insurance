function normalizeResponsibilityTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/gu, '')
    .replace(/\((?:可选责任|基本责任)[^)]*\)$/u, '')
    .replace(/轻症(?:疾病)?/gu, '轻度疾病')
    .replace(/中症(?:疾病)?/gu, '中度疾病')
    .replace(/重大疾病/gu, '重度疾病')
    .replace(/重疾/gu, '重度疾病');
}

function hasNumberedBenefitPrefix(value) {
  return /(?:第[一二三四五六七八九十\d]+次|第[一二三四五六七八九十\d]+至第?[一二三四五六七八九十\d]+次)/u.test(value);
}

export function responsibilityTitlesMatch(left, right) {
  const normalizedLeft = normalizeResponsibilityTitle(left);
  const normalizedRight = normalizeResponsibilityTitle(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  return !hasNumberedBenefitPrefix(normalizedLeft) && normalizedRight.endsWith(normalizedLeft);
}

export function mergeCalculatedResponsibilityTitles(baseTitles, cashflowEntries, scenarioEntries) {
  const titles = (Array.isArray(baseTitles) ? baseTitles : []).map(String).filter(Boolean);
  const calculatedTitles = [
    ...(Array.isArray(cashflowEntries) ? cashflowEntries : [])
      .filter((entry) => Number(entry?.amount) > 0)
      .map((entry) => String(entry?.liability || '').trim()),
    ...(Array.isArray(scenarioEntries) ? scenarioEntries : [])
      .filter((entry) => Number(entry?.amount) > 0)
      .map((entry) => String(entry?.scenario || '').trim()),
  ].filter(Boolean);

  for (const title of calculatedTitles) {
    if (!titles.some((existing) => responsibilityTitlesMatch(existing, title))) titles.push(title);
  }
  return titles;
}
