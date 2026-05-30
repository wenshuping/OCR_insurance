/**
 * Cash value table parser — extracts structured data from OCR bounding boxes.
 *
 * Algorithm mimics human eye reading:
 *   1. Cluster text items into rows by Y coordinate
 *   2. Detect table header by keyword matching
 *   3. Read data rows left-to-right based on column semantics
 *   4. Validate and compute confidence score
 */

const YEAR_KEYWORDS = ['保单年度', '保险年限', '保险年度', '年度', '保单年', '年份'];
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

    // Detect repeating groups: count how many times year keywords appear
    let yearKwCount = 0;
    for (const t of texts) {
      if (YEAR_KEYWORDS.some((kw) => t.includes(kw)) || /\d{4}\s*[\/／]\s*\d{1,3}/.test(t)) {
        yearKwCount++;
      }
    }

    let columns;
    if (hasYearAgeCombined || hasAgeKeyword || row.length >= 3) {
      // 3-column group: [year(+age combined), age, cashValue] or [year, age, cashValue]
      // With repeating groups, the "累计" columns are extra and handled in extraction
      columns = ['policyYear', 'age', 'cashValue'];
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
    .replace(/[,，\s]/g, '')
    .replace(/[元¥￥]/g, '')
    .trim();
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
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

      if (yearAge && groupSize === 2) {
        parsed.policyYear = yearAge.year;
        parsed.age = yearAge.age;
        const cashNum = parseNumericValue(values[1]);
        if (cashNum === null || cashNum < 0) { valid = false; }
        else parsed.cashValue = cashNum;
      } else if (yearAge && groupSize >= 3 && columns[1] === 'age') {
        parsed.policyYear = yearAge.year;
        parsed.age = yearAge.age;
        const cashNum = parseNumericValue(values[2]);
        if (cashNum === null || cashNum < 0) { valid = false; }
        else parsed.cashValue = cashNum;
      } else {
        for (let i = 0; i < columns.length; i++) {
          const col = columns[i];
          const text = values[i];
          if (col === 'policyYear') {
            const num = parseNumericValue(text);
            if (num === null || num < 1 || !Number.isInteger(num)) { valid = false; break; }
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
    .filter((b) => typeof b.confidence === 'number')
    .map((b) => b.confidence);
  const avgConfidence = confidences.length > 0
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0.8;

  // Score components
  const ocrScore = avgConfidence;                              // weight 0.4
  const alignmentScore = yearOrdered ? 1.0 : 0.3;             // weight 0.3
  const reasonabilityScore = (yearOrdered ? 0.5 : 0) + (ageOrdered ? 0.3 : 0) + (rows.length >= 5 ? 0.2 : 0.1); // weight 0.3

  const confidence = ocrScore * 0.4 + alignmentScore * 0.3 + reasonabilityScore * 0.3;

  return {
    valid: yearOrdered && confidence >= CONFIDENCE_THRESHOLD,
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
  const parsedRows = extractCashValueRows(dataRows, header.columns);
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
