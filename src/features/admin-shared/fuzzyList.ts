export function normalizeAdminSearchText(value: unknown) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[，。、“”‘’（）()【】[\]{}:：;；,./\\|_·-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function scoreAdminFuzzyMatch(query: string, fields: unknown[]) {
  const normalizedQuery = normalizeAdminSearchText(query);
  if (!normalizedQuery) return 1;
  const merged = fields.map(normalizeAdminSearchText).filter(Boolean).join(' ');
  const compactMerged = merged.replace(/\s+/g, '');
  const compactQuery = normalizedQuery.replace(/\s+/g, '');
  if (!merged || !compactQuery) return 0;
  if (compactMerged.includes(compactQuery)) return 120 - compactMerged.indexOf(compactQuery) / 10000;
  if (isOrderedSubsequence(compactQuery, compactMerged)) return 75;

  const terms = normalizedQuery.split(' ').filter(Boolean);
  const termHits = terms.filter((term) => merged.includes(term) || compactMerged.includes(term.replace(/\s+/g, ''))).length;
  const uniqueChars = Array.from(new Set(compactQuery.split(''))).filter((char) => char.trim());
  const charHits = uniqueChars.filter((char) => compactMerged.includes(char)).length;
  const termScore = terms.length ? termHits / terms.length : 0;
  const charScore = uniqueChars.length ? charHits / uniqueChars.length : 0;
  const score = termScore * 70 + charScore * 30;
  return score >= 45 ? score : 0;
}

function isOrderedSubsequence(query: string, target: string) {
  let queryIndex = 0;
  for (const char of target) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex >= query.length) return true;
  }
  return false;
}

export function filterAdminList<T>(items: T[], query: string, fieldsForItem: (item: T) => unknown[]) {
  if (!normalizeAdminSearchText(query)) return items;
  return items
    .map((item, index) => ({ item, index, score: scoreAdminFuzzyMatch(query, fieldsForItem(item)) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((row) => row.item);
}

export function getAdminPageWindow(totalItems: number, requestedPage: number, pageSize: number) {
  const pageCount = Math.max(1, Math.ceil(totalItems / pageSize));
  const page = Math.min(Math.max(1, requestedPage), pageCount);
  const startIndex = totalItems ? (page - 1) * pageSize : 0;
  const endIndex = totalItems ? Math.min(startIndex + pageSize, totalItems) : 0;
  return { page, pageCount, startIndex, endIndex };
}
