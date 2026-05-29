const OCR_CHAR_NORMALIZATION = new Map([
  ['險', '险'],
  ['険', '险'],
  ['費', '费'],
  ['繳', '缴'],
  ['額', '额'],
  ['稱', '称'],
  ['證', '证'],
  ['號', '号'],
  ['單', '单'],
  ['劃', '划'],
  ['畫', '画'],
  ['臺', '台'],
  ['週', '周'],
  ['責', '责'],
  ['終', '终'],
  ['產', '产'],
  ['産', '产'],
  ['護', '护'],
  ['紅', '红'],
  ['類', '类'],
  ['間', '间'],
  ['问', '间'],
  ['閒', '间'],
  ['缴', '交'],
  ['￥', '元'],
  ['¥', '元'],
]);

const GENERIC_SALIENCE_CHARS = new Set(Array.from('保险合同名称公司金额期间方式交费缴费基本首期'));

function normalizeChar(char) {
  return OCR_CHAR_NORMALIZATION.get(char) || char;
}

export function normalizeFuzzyText(value, { compact = true } = {}) {
  const text = String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[：﹕]/g, ':')
    .replace(/[|｜/／\\()\[\]{}（）【】,，.。;；、\-_=+~`'"“”‘’<>《》!?！？]/g, ' ');

  const normalized = Array.from(text, normalizeChar)
    .join('')
    .replace(/[^\p{Script=Han}a-z0-9:\s]/gu, ' ')
    .replace(/\s+/g, compact ? '' : ' ')
    .trim();

  return compact ? normalized.replace(/:/g, '') : normalized;
}

function toChars(value) {
  return Array.from(normalizeFuzzyText(value));
}

function makeNgrams(value, size) {
  const chars = toChars(value);
  if (!chars.length) return [];
  if (chars.length <= size) return [chars.join('')];
  const grams = [];
  for (let index = 0; index <= chars.length - size; index += 1) {
    grams.push(chars.slice(index, index + size).join(''));
  }
  return grams;
}

function setOverlap(leftItems, rightItems) {
  const left = new Set(leftItems);
  const right = new Set(rightItems);
  let overlap = 0;
  for (const item of left) {
    if (right.has(item)) overlap += 1;
  }
  return { left, right, overlap };
}

export function ngramCosineSimilarity(leftValue, rightValue, size = 2) {
  const leftGrams = makeNgrams(leftValue, size);
  const rightGrams = makeNgrams(rightValue, size);
  if (!leftGrams.length || !rightGrams.length) return 0;
  const { left, right, overlap } = setOverlap(leftGrams, rightGrams);
  if (!overlap) return 0;
  return overlap / Math.sqrt(left.size * right.size);
}

function levenshteinDistance(leftValue, rightValue) {
  const left = toChars(leftValue);
  const right = toChars(rightValue);
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + cost,
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function longestCommonPrefixRatio(leftValue, rightValue) {
  const left = toChars(leftValue);
  const right = toChars(rightValue);
  const maxLength = Math.max(left.length, right.length);
  if (!maxLength) return 0;
  let shared = 0;
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) {
    shared += 1;
  }
  return shared / maxLength;
}

export function tokenJaccardSimilarity(leftValue, rightValue) {
  const leftTokens = makeNgrams(leftValue, 2);
  const rightTokens = makeNgrams(rightValue, 2);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const { left, right, overlap } = setOverlap(leftTokens, rightTokens);
  if (!overlap) return 0;
  return overlap / (left.size + right.size - overlap);
}

export function calculateFuzzySimilarity(leftValue, rightValue) {
  const left = normalizeFuzzyText(leftValue);
  const right = normalizeFuzzyText(rightValue);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) {
    const ratio = Math.min(left.length, right.length) / Math.max(left.length, right.length);
    return ratio >= 0.75 ? Math.max(0.88, ratio) : ratio * 0.9;
  }

  const maxLength = Math.max(toChars(left).length, toChars(right).length);
  const editSimilarity = maxLength ? 1 - levenshteinDistance(left, right) / maxLength : 0;
  const bigramSimilarity = ngramCosineSimilarity(left, right, 2);
  const trigramSimilarity = ngramCosineSimilarity(left, right, 3);
  const prefixSimilarity = longestCommonPrefixRatio(left, right);
  const weightedSimilarity = 0.45 * editSimilarity + 0.35 * bigramSimilarity + 0.2 * trigramSimilarity;

  return Math.max(weightedSimilarity, prefixSimilarity * 0.95);
}

export function hasSalientOverlap(leftValue, rightValue, { minShared = 1 } = {}) {
  const leftChars = new Set(toChars(leftValue).filter((char) => !GENERIC_SALIENCE_CHARS.has(char)));
  const rightChars = new Set(toChars(rightValue).filter((char) => !GENERIC_SALIENCE_CHARS.has(char)));
  if (!leftChars.size || !rightChars.size) return true;

  let shared = 0;
  for (const char of leftChars) {
    if (rightChars.has(char)) shared += 1;
    if (shared >= minShared) return true;
  }
  return false;
}

function candidateWindows(value, targetLength) {
  const normalized = normalizeFuzzyText(value);
  const chars = Array.from(normalized);
  if (!chars.length) return [];
  const windows = new Set([normalized]);
  const sizes = new Set([
    Math.max(1, targetLength - 1),
    targetLength,
    targetLength + 1,
    targetLength + 2,
  ]);

  for (const size of sizes) {
    if (size > chars.length) continue;
    windows.add(chars.slice(0, size).join(''));
    for (let index = 0; index <= chars.length - size; index += 1) {
      windows.add(chars.slice(index, index + size).join(''));
    }
  }
  return [...windows];
}

export function findBestFuzzyMatch(value, choices, { minScore = 0.7, requireSalientOverlap = true } = {}) {
  let best = null;
  for (const choice of choices || []) {
    const normalizedChoice = normalizeFuzzyText(choice);
    if (!normalizedChoice) continue;
    if (requireSalientOverlap && !hasSalientOverlap(value, choice)) continue;

    for (const window of candidateWindows(value, Array.from(normalizedChoice).length)) {
      const score = calculateFuzzySimilarity(window, normalizedChoice);
      if (score < minScore) continue;
      if (!best || score > best.score) {
        best = { choice, score, matchedText: window };
      }
    }
  }
  return best;
}

export function matchesFuzzyPhrase(value, phrase, options = {}) {
  return Boolean(findBestFuzzyMatch(value, [phrase], options));
}

export function stripFuzzyPrefix(value, prefixes, { minScore = 0.7 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';

  const colonIndex = text.search(/[:：]/);
  if (colonIndex >= 0) {
    const prefix = text.slice(0, colonIndex);
    const match = findBestFuzzyMatch(prefix, prefixes, { minScore });
    if (match) return text.slice(colonIndex + 1).trim();
  }

  const compactChars = Array.from(text.replace(/\s+/g, ''));
  const orderedPrefixes = [...(prefixes || [])].sort((left, right) => right.length - left.length);
  for (const prefix of orderedPrefixes) {
    const normalizedPrefix = normalizeFuzzyText(prefix);
    const prefixLength = Array.from(normalizedPrefix).length;
    const candidatePrefix = compactChars.slice(0, prefixLength).join('');
    const score = calculateFuzzySimilarity(candidatePrefix, normalizedPrefix);
    if (score >= minScore) {
      return compactChars.slice(prefixLength).join('').trim();
    }
  }
  return text;
}
