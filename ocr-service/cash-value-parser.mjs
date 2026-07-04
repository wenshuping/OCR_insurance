/**
 * Cash value table parser — extracts structured data from OCR bounding boxes.
 *
 * Algorithm mimics human eye reading:
 *   1. Cluster text items into rows by Y coordinate
 *   2. Detect table header by keyword matching
 *   3. Read data rows left-to-right based on column semantics
 *   4. Validate and compute confidence score
 */

const YEAR_KEYWORDS = ['保单年度', '保险年限', '保险年度', '年度', '保单年', '年份', '保单年度末'];
const AGE_KEYWORDS = ['年龄', '被保险年龄', '被保险人年龄'];
const CASH_VALUE_KEYWORDS = ['现金价值', '退保金', '账户价值', '领取'];
const SKIP_KEYWORDS = ['累计']; // columns to skip in repeating groups

const DEFAULT_Y_THRESHOLD = 15;
const MIN_DATA_ROWS = 3;
const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Compute the Y midpoint from a bounding box.
 * Supports both flat [x_min, y_min, x_max, y_max] and nested [[x1,y1],...] formats.
 */
function boxYMid(box) {
  if (!box || !Array.isArray(box) || box.length < 4) return null;
  if (typeof box[0] === 'number') {
    return (box[1] + box[3]) / 2;
  }
  const ys = box.map((point) => (Array.isArray(point) ? point[1] : 0));
  return (Math.min(...ys) + Math.max(...ys)) / 2;
}

function boxXMin(box) {
  if (!box || !Array.isArray(box) || box.length < 4) return 0;
  if (typeof box[0] === 'number') {
    return Math.min(box[0], box[2]);
  }
  const xs = box.map((point) => (Array.isArray(point) ? point[0] : 0));
  return Math.min(...xs);
}

function boxXMax(box) {
  if (!box || !Array.isArray(box) || box.length < 4) return 0;
  if (typeof box[0] === 'number') {
    return Math.max(box[0], box[2]);
  }
  const xs = box.map((point) => (Array.isArray(point) ? point[0] : 0));
  return Math.max(...xs);
}

function boxXMid(box) {
  if (!box || !Array.isArray(box) || box.length < 4) return 0;
  if (typeof box[0] === 'number') {
    return (Math.min(box[0], box[2]) + Math.max(box[0], box[2])) / 2;
  }
  const xs = box.map((point) => (Array.isArray(point) ? point[0] : 0));
  return (Math.min(...xs) + Math.max(...xs)) / 2;
}

/**
 * Step 1: Cluster text items into rows by Y coordinate proximity.
 */
export function clusterIntoRows(boxes, options = {}) {
  const yThreshold = options.yThreshold || DEFAULT_Y_THRESHOLD;

  const itemsWithY = boxes.map((b) => ({
    ...b,
    _yMid: boxYMid(b.box),
    _xMin: boxXMin(b.box),
  }));

  // Items without coordinates get their own row
  const withCoords = itemsWithY.filter((b) => b._yMid !== null);
  const withoutCoords = itemsWithY.filter((b) => b._yMid === null);

  // Sort by Y midpoint
  withCoords.sort((a, b) => a._yMid - b._yMid);

  const rows = [];
  let currentRow = [];
  let currentY = null;

  for (const item of withCoords) {
    if (currentY === null || Math.abs(item._yMid - currentY) <= yThreshold) {
      currentRow.push(item);
      if (currentY === null) currentY = item._yMid;
      currentY = (currentY + item._yMid) / 2;
    } else {
      if (currentRow.length) {
        currentRow.sort((a, b) => a._xMin - b._xMin);
        rows.push(currentRow);
      }
      currentRow = [item];
      currentY = item._yMid;
    }
  }
  if (currentRow.length) {
    currentRow.sort((a, b) => a._xMin - b._xMin);
    rows.push(currentRow);
  }

  // Append items without coordinates as individual rows
  for (const item of withoutCoords) {
    rows.push([item]);
  }

  return rows;
}

/**
 * Step 2: Detect table header row by keyword matching.
 */
export function detectTableHeader(rows) {
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const texts = row.map((item) => item.text);
    const joinedText = texts.join(' ');

    const hasYearKeyword = YEAR_KEYWORDS.some((kw) => joinedText.includes(kw));
    const hasCashValueKeyword = CASH_VALUE_KEYWORDS.some((kw) => joinedText.includes(kw));

    if (!hasYearKeyword && !hasCashValueKeyword) continue;

    const hasAgeKeyword = AGE_KEYWORDS.some((kw) => joinedText.includes(kw));
    // Check for combined year/age header like "年份/年龄"
    const hasYearAgeCombined = /年份\s*[\/／]\s*年龄|年龄\s*[\/／]\s*年份/.test(joinedText);

    // Require both year+cashValue keywords or combined year/age pattern
    // (avoids false matches on section titles like "年度现金流汇总")
    if (!hasYearAgeCombined && !(hasYearKeyword && hasCashValueKeyword)) continue;

    // Detect repeating groups: count how many times year keywords appear
    let yearKwCount = 0;
    for (const t of texts) {
      if (YEAR_KEYWORDS.some((kw) => t.includes(kw)) || /\d{4}\s*[\/／]\s*\d{1,3}/.test(t)) {
        yearKwCount++;
      }
    }

    const yearHeaderCount = texts.filter((text) => YEAR_KEYWORDS.some((kw) => text.includes(kw))).length;
    const cashValueHeaderCount = texts.filter((text) => CASH_VALUE_KEYWORDS.some((kw) => text.includes(kw))).length;

    let columns;
    if (hasYearAgeCombined) {
      // Combined "年份/年龄" header → 3-column group: [yearAge, cashValue, skip(累计)]
      columns = ['policyYear', 'cashValue', 'skip'];
    } else if (hasAgeKeyword) {
      columns = ['policyYear', 'age', 'cashValue'];
    } else if (yearHeaderCount >= 2 && cashValueHeaderCount >= 2) {
      // Same page can contain multiple side-by-side 2-column groups:
      // 保单年度末 | 现金价值 | 保单年度末 | 现金价值 | ...
      columns = ['policyYear', 'cashValue'];
    } else {
      columns = ['policyYear', 'cashValue'];
    }

    return {
      headerRowIndex: i,
      tableType: columns.length === 3 ? 3 : 2,
      columns,
    };
  }

  return null;
}

/**
 * Parse a numeric value from OCR text.
 * Handles: "8,500", "8500元", "31,800.50", "19 200"
 */
function parseNumericValue(text) {
  if (!text || typeof text !== 'string') return null;
  let cleaned = text
    .replace(/(?<=\d)[:：](?=\d{2}$)/g, '.')
    .replace(/[,，\s]/g, '')
    .replace(/[元¥￥]/g, '')
    .trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parsePolicyYear(text) {
  if (!text || typeof text !== 'string') return null;
  const normalized = text
    .replace(/[｜|]/g, '')
    .replace(/\s+/g, '')
    .trim();
  const yearEndMatch = normalized.match(/^(?:第)?(\d{1,3})(?:个)?年(?:度)?(?:末|未|木|底)?$/);
  if (yearEndMatch) {
    const year = Number(yearEndMatch[1]);
    return year >= 1 && year <= 150 ? year : null;
  }
  if (/[.．]/.test(normalized)) return null;
  const plain = parseNumericValue(normalized);
  if (plain === null || plain < 1 || plain > 150 || !Number.isInteger(plain)) return null;
  return plain;
}

/**
 * Parse a "year/age" combined value like "2030/42".
 * Returns { year, age } or null if not a combined format.
 */
function parseYearAge(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/^(\d{4})\s*[\/／]\s*(\d{1,3})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const age = Number(match[2]);
  if (!Number.isFinite(year) || !Number.isFinite(age)) return null;
  return { year, age };
}

/**
 * Step 3: Extract structured rows from data rows based on column mapping.
 * Handles repeating column groups and "year/age" combined format.
 */
export function extractCashValueRows(dataRows, columns) {
  const results = [];
  const groupSize = columns.length;

  for (const row of dataRows) {
    const itemCount = row.length;
    const groupCount = Math.max(1, Math.floor(itemCount / groupSize));

    for (let g = 0; g < groupCount; g++) {
      const groupItems = row.slice(g * groupSize, (g + 1) * groupSize);
      if (groupItems.length < groupSize) break;

      const values = groupItems.map((item) => item.text);
      const parsed = {};
      let valid = true;

      const yearAge = parseYearAge(values[0]);

      if (yearAge) {
        // "2030/42" combined format: extract year + age from first value
        parsed.policyYear = yearAge.year;
        parsed.age = yearAge.age;
        // Find cashValue column index
        const cvIdx = columns.indexOf('cashValue');
        if (cvIdx >= 0 && cvIdx < values.length) {
          const cashNum = parseNumericValue(values[cvIdx]);
          if (cashNum === null || cashNum < 0) { valid = false; }
          else parsed.cashValue = cashNum;
        } else {
          valid = false;
        }
      } else {
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          const text = values[i];
          if (col === 'policyYear') {
            const num = parsePolicyYear(text);
            if (num === null) { valid = false; break; }
            parsed.policyYear = num;
          } else if (col === 'age') {
            parsed.age = parseNumericValue(text);
          } else if (col === 'cashValue') {
            const num = parseNumericValue(text);
            if (num === null || num < 0) { valid = false; break; }
            parsed.cashValue = num;
          }
        }
      }

      if (valid && parsed.policyYear != null && parsed.cashValue != null) {
        results.push({
          policyYear: parsed.policyYear,
          age: parsed.age ?? null,
          cashValue: parsed.cashValue,
        });
      }
    }
  }

  return results;
}

function uniqueRowsByPolicyYear(rows) {
  const byYear = new Map();
  for (const row of rows) {
    const existing = byYear.get(row.policyYear);
    if (!existing || row.cashValue > existing.cashValue) byYear.set(row.policyYear, row);
  }
  return [...byYear.values()].sort((a, b) => a.policyYear - b.policyYear || (a.age ?? 0) - (b.age ?? 0));
}

function itemsWithCoordinates(boxes) {
  return boxes
    .map((item, index) => ({
      ...item,
      _index: index,
      _xMin: boxXMin(item.box),
      _xMax: boxXMax(item.box),
      _xMid: boxXMid(item.box),
      _yMid: boxYMid(item.box),
    }))
    .filter((item) => typeof item.text === 'string' && item.text.trim() && item._yMid !== null);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function detectRepeatedHeaderGroups(items) {
  const yearHeaders = items.filter((item) => isYearHeader(item.text));
  const cashHeaders = items.filter((item) => isCashValueHeader(item.text));
  const groups = [];
  const usedCashIndexes = new Set();

  for (const yearHeader of yearHeaders) {
    let best = null;
    let bestScore = Infinity;
    for (const cashHeader of cashHeaders) {
      if (usedCashIndexes.has(cashHeader._index)) continue;
      if (cashHeader._xMid <= yearHeader._xMid) continue;
      const xDistance = cashHeader._xMid - yearHeader._xMid;
      const yDistance = Math.abs(cashHeader._yMid - yearHeader._yMid);
      if (xDistance < 60 || xDistance > 900 || yDistance > 90) continue;
      const score = yDistance * 5 + xDistance;
      if (score < bestScore) {
        best = cashHeader;
        bestScore = score;
      }
    }
    if (!best) continue;
    usedCashIndexes.add(best._index);
    groups.push({
      yearHeader,
      cashHeader: best,
      centerX: (yearHeader._xMid + best._xMid) / 2,
      headerY: Math.min(yearHeader._yMid, best._yMid),
    });
  }

  return groups.sort((a, b) => a.centerX - b.centerX);
}

function extractCashValueRowsByHeaderGroups(boxes) {
  const items = itemsWithCoordinates(boxes);
  const headerGroups = detectRepeatedHeaderGroups(items);
  if (headerGroups.length < 2) return [];

  const rows = [];
  for (let i = 0; i < headerGroups.length; i++) {
    const group = headerGroups[i];
    const previous = headerGroups[i - 1];
    const next = headerGroups[i + 1];
    const leftBoundary = previous ? (previous.centerX + group.centerX) / 2 : -Infinity;
    const rightBoundary = next ? (group.centerX + next.centerX) / 2 : Infinity;
    const groupItems = items.filter((item) => (
      item._xMid >= leftBoundary
      && item._xMid < rightBoundary
      && item._yMid > group.headerY + 18
      && !isYearHeader(item.text)
      && !isCashValueHeader(item.text)
    ));

    const yearItems = groupItems
      .map((item) => ({ ...item, _policyYear: parsePolicyYear(item.text) }))
      .filter((item) => item._policyYear !== null);
    const valueItems = groupItems
      .map((item) => ({ ...item, _cashValue: parseNumericValue(item.text) }))
      .filter((item) => (
        item._cashValue !== null
        && item._cashValue >= 0
        && parsePolicyYear(item.text) === null
      ));

    const sortedYearItems = [...yearItems].sort((a, b) => a._yMid - b._yMid);
    const yearYDistances = [];
    for (let y = 1; y < sortedYearItems.length; y++) {
      yearYDistances.push(Math.abs(sortedYearItems[y]._yMid - sortedYearItems[y - 1]._yMid));
    }
    const rowGap = median(yearYDistances);
    const yThreshold = Math.max(28, Math.min(80, (rowGap || 55) * 0.7));
    const usedValueIndexes = new Set();

    for (const yearItem of yearItems) {
      let best = null;
      let bestScore = Infinity;
      for (const valueItem of valueItems) {
        if (usedValueIndexes.has(valueItem._index)) continue;
        if (valueItem._xMid <= yearItem._xMid) continue;
        const yDistance = Math.abs(valueItem._yMid - yearItem._yMid);
        if (yDistance > yThreshold) continue;
        const score = yDistance * 6 + Math.abs(valueItem._xMid - group.cashHeader._xMid);
        if (score < bestScore) {
          best = valueItem;
          bestScore = score;
        }
      }
      if (!best) continue;
      usedValueIndexes.add(best._index);
      rows.push({
        policyYear: yearItem._policyYear,
        age: null,
        cashValue: best._cashValue,
      });
    }
  }

  return uniqueRowsByPolicyYear(rows);
}

function sortBoxesReadingOrder(boxes, options = {}) {
  return clusterIntoRows(boxes, options)
    .flatMap((row) => row)
    .filter((item) => typeof item.text === 'string' && item.text.trim());
}

function extractSequentialYearValuePairs(items) {
  const rows = [];
  for (let i = 0; i < items.length; i++) {
    const policyYear = parsePolicyYear(items[i]?.text);
    if (policyYear === null) continue;

    for (let j = i + 1; j < Math.min(items.length, i + 5); j++) {
      if (parsePolicyYear(items[j]?.text) !== null) break;
      const cashValue = parseNumericValue(items[j]?.text);
      if (cashValue === null || cashValue < 0) continue;
      rows.push({ policyYear, age: null, cashValue });
      break;
    }
  }
  return uniqueRowsByPolicyYear(rows);
}

function extractColumnarYearValuePairs(boxes) {
  const items = boxes
    .map((item, index) => ({
      ...item,
      _index: index,
      _xMid: boxXMid(item.box),
      _yMid: boxYMid(item.box),
    }))
    .filter((item) => typeof item.text === 'string' && item.text.trim() && item._yMid !== null);

  const yearItems = items
    .map((item) => ({ ...item, _policyYear: parsePolicyYear(item.text) }))
    .filter((item) => item._policyYear !== null);
  const valueItems = items
    .map((item) => ({ ...item, _cashValue: parseNumericValue(item.text) }))
    .filter((item) => item._cashValue !== null && item._cashValue >= 0 && parsePolicyYear(item.text) === null);

  const rows = [];
  for (const yearItem of yearItems) {
    let best = null;
    let bestScore = Infinity;
    for (const valueItem of valueItems) {
      const yDistance = Math.abs(valueItem._yMid - yearItem._yMid);
      const rightSidePenalty = valueItem._xMid >= yearItem._xMid ? 0 : 40;
      const xDistance = Math.abs(valueItem._xMid - yearItem._xMid);
      const score = yDistance * 4 + xDistance + rightSidePenalty;
      if (score < bestScore) {
        best = valueItem;
        bestScore = score;
      }
    }
    if (best && bestScore < 260) {
      rows.push({ policyYear: yearItem._policyYear, age: null, cashValue: best._cashValue });
    }
  }
  return uniqueRowsByPolicyYear(rows);
}

function parseCashValueRowsFromRecognizedOrder(boxes, options = {}) {
  const candidates = [
    extractSequentialYearValuePairs(boxes),
    extractSequentialYearValuePairs(sortBoxesReadingOrder(boxes, options)),
    extractColumnarYearValuePairs(boxes),
  ];
  return candidates.sort((a, b) => b.length - a.length)[0] || [];
}

function normalizeOcrTextLines(input) {
  const lines = Array.isArray(input) ? input : String(input || '').split(/\r?\n/u);
  const normalized = lines.map((line) => String(line || '').trim()).filter(Boolean);
  const merged = [];
  for (let i = 0; i < normalized.length; i++) {
    const line = normalized[i];
    const nextLine = normalized[i + 1];
    if (/^\d+[.．]$/.test(line) && /^\d{1,2}$/.test(nextLine || '')) {
      merged.push(`${line.replace('．', '.')}${nextLine}`);
      i++;
      continue;
    }
    merged.push(line);
  }
  return merged;
}

function isYearHeader(text) {
  return YEAR_KEYWORDS.some((kw) => String(text || '').includes(kw));
}

function isCashValueHeader(text) {
  return CASH_VALUE_KEYWORDS.some((kw) => String(text || '').includes(kw));
}

function isTableStopLine(text) {
  return /^第\d+页/u.test(text)
    || /^(?:\d+[.．、]\s*)?本表/u.test(text)
    || /^上表/u.test(text)
    || /^注[:：]/u.test(text);
}

function parseAlternatingYearValueTokens(tokens) {
  if (tokens.length < MIN_DATA_ROWS * 2 || tokens.length % 2 !== 0) return [];
  const rows = [];
  for (let i = 0; i < tokens.length; i += 2) {
    const policyYear = parsePolicyYear(tokens[i]);
    const cashValue = parseNumericValue(tokens[i + 1]);
    if (policyYear === null || cashValue === null || cashValue < 0) return [];
    rows.push({ policyYear, age: null, cashValue });
  }
  return rows;
}

function parseSplitYearValueTokens(yearTokens, valueTokens) {
  if (yearTokens.length < MIN_DATA_ROWS || yearTokens.length !== valueTokens.length) return [];
  const rows = [];
  for (let i = 0; i < yearTokens.length; i++) {
    const policyYear = parsePolicyYear(yearTokens[i]);
    const cashValue = parseNumericValue(valueTokens[i]);
    if (policyYear === null || cashValue === null || cashValue < 0) return [];
    rows.push({ policyYear, age: null, cashValue });
  }
  return rows;
}

function parseSequentialYearValueTextRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const policyYear = parsePolicyYear(lines[i]);
    if (policyYear === null) continue;
    const nextLine = lines[i + 1];
    if (isYearHeader(nextLine) || isCashValueHeader(nextLine) || parsePolicyYear(nextLine) !== null) continue;
    if (parseInlineYearValueTextRows([nextLine]).length) continue;
    const cashValue = parseNumericValue(nextLine);
    if (cashValue === null || cashValue < 0) continue;
    rows.push({ policyYear, age: null, cashValue });
  }
  return rows;
}

function looksLikeCashValueToken(text) {
  return /[,，.．]/u.test(String(text || ''));
}

function parseInlineYearValueTextRows(lines) {
  const rows = [];
  for (const line of lines) {
    if (isTableStopLine(line)) continue;
    const tokens = String(line || '').match(/(?<![\d,，.．])(?:\d{1,3}(?:年末|年未|年木|年度末)?|[\d,，]*\d[\d,，]*(?:[.．]\d{2})?)(?![\d,，.．])/gu) || [];
    for (let i = 0; i < tokens.length - 1; i++) {
      const policyYear = parsePolicyYear(tokens[i]);
      if (policyYear === null) continue;
      const cashToken = tokens[i + 1];
      if (!looksLikeCashValueToken(cashToken)) continue;
      const cashValue = parseNumericValue(cashToken);
      if (cashValue === null || cashValue < 0) continue;
      rows.push({ policyYear, age: null, cashValue });
    }
  }
  return rows;
}

function parseCashValueTextSegment(segment, options = {}) {
  const yearHeaderIndex = segment.findIndex(isYearHeader);
  if (yearHeaderIndex < 0) return [];
  const cashHeaderIndex = segment.findIndex((line, index) => index > yearHeaderIndex && isCashValueHeader(line));
  if (cashHeaderIndex < 0) return [];

  const excludedPolicyYears = options.excludedPolicyYears || new Set();
  const beforeCashHeader = segment.slice(yearHeaderIndex + 1, cashHeaderIndex)
    .filter((line) => parsePolicyYear(line) !== null);
  const afterCashHeader = segment.slice(cashHeaderIndex + 1)
    .filter((line) => (
      !isYearHeader(line)
      && !isCashValueHeader(line)
      && (parsePolicyYear(line) !== null || parseNumericValue(line) !== null)
    ));

  const splitRows = parseSplitYearValueTokens(beforeCashHeader, afterCashHeader);
  if (splitRows.length) return splitRows;
  const remainingYearTokens = beforeCashHeader
    .filter((line) => !excludedPolicyYears.has(parsePolicyYear(line)));
  const remainingSplitRows = parseSplitYearValueTokens(remainingYearTokens, afterCashHeader);
  if (remainingSplitRows.length) return remainingSplitRows;
  return parseAlternatingYearValueTokens(afterCashHeader);
}

export function parseCashValueText(input, options = {}) {
  const lines = normalizeOcrTextLines(input);
  if (!lines.length) {
    return { ok: false, error: 'CASH_VALUE_TABLE_NOT_DETECTED', message: '未检测到文本内容' };
  }

  const hasYearHeader = lines.some(isYearHeader);
  const hasCashValueHeader = lines.some(isCashValueHeader);
  if (!hasYearHeader || !hasCashValueHeader) {
    return { ok: false, error: 'CASH_VALUE_TABLE_NOT_DETECTED', message: '未检测到现金价值表表头' };
  }

  const segments = [];
  let current = [];
  for (const line of lines) {
    if (isTableStopLine(line)) break;
    if (isYearHeader(line) && current.some(isYearHeader)) {
      segments.push(current);
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length) segments.push(current);

  const sequentialRows = parseSequentialYearValueTextRows(lines);
  const inlineRows = parseInlineYearValueTextRows(lines);
  const sequentialYears = new Set(sequentialRows.map((row) => row.policyYear));
  const parsedRows = uniqueRowsByPolicyYear([
    ...sequentialRows,
    ...inlineRows,
    ...segments.flatMap((segment) => parseCashValueTextSegment(segment, { excludedPolicyYears: sequentialYears })),
  ]);
  const { valid, confidence } = validateAndScore(parsedRows, []);
  if (!valid) {
    return {
      ok: false,
      error: 'PARSE_FAILED',
      message: `解析结果不可靠：仅 ${parsedRows.length} 行有效数据`,
      rows: parsedRows,
      confidence,
    };
  }

  return {
    ok: true,
    source: options.source || 'ocr',
    tableType: 2,
    rows: parsedRows,
    rowCount: parsedRows.length,
    confidence,
  };
}

/**
 * Step 4: Validate parsed rows and compute confidence.
 */
function validateAndScore(rows, boxes) {
  if (rows.length < MIN_DATA_ROWS) {
    return { valid: false, confidence: 0 };
  }

  // Check year ordering (allow some disorder from repeating groups)
  let ascendingCount = 0;
  let totalPairs = 0;
  for (let i = 1; i < rows.length; i++) {
    totalPairs++;
    if (rows[i].policyYear >= rows[i - 1].policyYear) ascendingCount++;
  }
  const yearOrdered = totalPairs === 0 || ascendingCount / totalPairs >= 0.5;
  const adjacentYearLikeCashValues = rows.filter((row) => (
    Number.isInteger(row.cashValue)
    && row.cashValue >= 1
    && row.cashValue <= 150
    && Math.abs(row.cashValue - row.policyYear) <= 1
  )).length;
  const mostlyAdjacentYearValues = rows.length >= 5 && adjacentYearLikeCashValues / rows.length >= 0.5;

  // Check cash value non-negative (already enforced in parsing)
  // Check age ordering if present
  let ageOrdered = true;
  const hasAge = rows.some((r) => r.age != null);
  if (hasAge) {
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].age != null && rows[i - 1].age != null && rows[i].age < rows[i - 1].age) {
        ageOrdered = false;
        break;
      }
    }
  }

  // OCR average confidence
  const confidences = boxes
    .map((b) => Number(b.confidence))
    .filter((confidence) => Number.isFinite(confidence) && confidence > 0);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0.8;

  // Score components
  const ocrScore = avgConfidence;                              // weight 0.4
  const alignmentScore = yearOrdered ? 1.0 : 0.3;             // weight 0.3
  const reasonabilityScore = (yearOrdered ? 0.5 : 0) + (ageOrdered ? 0.3 : 0) + (rows.length >= 5 ? 0.2 : 0.1); // weight 0.3

  const confidence = ocrScore * 0.4 + alignmentScore * 0.3 + reasonabilityScore * 0.3;

  return {
    valid: yearOrdered && !mostlyAdjacentYearValues && confidence >= CONFIDENCE_THRESHOLD,
    confidence: Math.round(confidence * 100) / 100,
  };
}

/**
 * Main entry point: parse a cash value table from OCR bounding boxes.
 */
export function parseCashValueTable(boxes, options = {}) {
  if (!boxes || boxes.length === 0) {
    return { ok: false, error: 'CASH_VALUE_TABLE_NOT_DETECTED', message: '未检测到文本内容' };
  }

  const rows = clusterIntoRows(boxes, options);
  const header = detectTableHeader(rows);

  if (!header) {
    return { ok: false, error: 'CASH_VALUE_TABLE_NOT_DETECTED', message: '未检测到现金价值表表头' };
  }

  const dataRows = rows.slice(header.headerRowIndex + 1);
  let parsedRows = extractCashValueRows(dataRows, header.columns);
  const groupedRows = extractCashValueRowsByHeaderGroups(boxes);
  if (groupedRows.length >= MIN_DATA_ROWS && groupedRows.length >= parsedRows.length) {
    parsedRows = groupedRows;
  } else if (parsedRows.length < MIN_DATA_ROWS) {
    parsedRows = parseCashValueRowsFromRecognizedOrder(boxes, options);
  }
  // Sort by policyYear (repeating groups interleave years from different column groups)
  parsedRows = uniqueRowsByPolicyYear(parsedRows);
  const { valid, confidence } = validateAndScore(parsedRows, boxes);

  if (!valid) {
    return {
      ok: false,
      error: 'PARSE_FAILED',
      message: `解析结果不可靠：仅 ${parsedRows.length} 行有效数据`,
      rows: parsedRows,
      confidence,
    };
  }

  return {
    ok: true,
    source: 'ocr',
    tableType: header.tableType,
    rows: parsedRows,
    rowCount: parsedRows.length,
    confidence,
  };
}

export { CONFIDENCE_THRESHOLD, MIN_DATA_ROWS };
