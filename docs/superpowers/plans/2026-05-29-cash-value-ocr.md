# Cash Value Table OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to photograph and upload insurance policy cash value tables, OCR-parse them (Paddle OCR with coordinate-based table detection, vision LLM fallback), store structured data, and display in the cashflow detail page.

**Architecture:** Paddle OCR script enhanced to return bounding boxes. A new `cash-value-parser.mjs` module clusters boxes into rows (like human eyes scanning a table), detects headers, and extracts 2-column or 3-column table data. On failure, a vision LLM fallback extracts structured JSON. Two new API endpoints handle scan (OCR only) and confirm (write to DB). Frontend shows a dialog after policy save to guide the user through the upload flow.

**Tech Stack:** Node.js 22, Python (Paddle OCR), SQLite (`node:sqlite`), Express, React 19, Node.js test runner (`node:test` + `assert/strict`)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `server/cashflow-store.mjs` | Modify | Add `policy_cash_values` table DDL + CRUD (`createCashValueStore`) |
| `ocr-service/scripts/policy_ocr_paddle.py` | Modify | Add `collect_lines_with_boxes()` returning text + coordinates |
| `ocr-service/cash-value-parser.mjs` | **Create** | Table parsing core: row clustering, header detection, value extraction, confidence scoring |
| `ocr-service/insurance-ocr.service.mjs` | Modify | Add `scanCashValueTable()` function that calls Paddle OCR + parser |
| `ocr-service/router.mjs` | Modify | Add `/internal/ocr/policies/cash-value/scan` route |
| `server/vision-llm.mjs` | **Create** | Vision LLM client (OpenAI-compatible API) |
| `server/app.mjs` | Modify | Add 2 API endpoints + include `cashValues` in GET policy response |
| `src/api.ts` | Modify | Add `CashValueRow` type, `scanCashValue()`, `confirmCashValue()` |
| `src/App.tsx` | Modify | Cash value dialog, preview table, editable grid, cashflow merge |
| `tests/cash-value-store.test.mjs` | **Create** | Tests for cash value DB CRUD |
| `tests/cash-value-parser.test.mjs` | **Create** | Tests for table parsing algorithm |

---

### Task 1: Database — Add policy_cash_values table and CRUD

**Files:**
- Modify: `server/cashflow-store.mjs` (append after line 106)
- Test: `tests/cash-value-store.test.mjs` (create)

- [ ] **Step 1: Write failing tests for cash value store**

Create `tests/cash-value-store.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createCashValueStore, ensureCashValueTable } from '../server/cashflow-store.mjs';

const TEST_DB_DIR = path.resolve('.runtime');
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-cash-value-store.sqlite');

let db;

function seedPoliciesTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      guest_id TEXT,
      company TEXT,
      name TEXT,
      insured TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
  `);
  db.prepare(`
    INSERT OR IGNORE INTO policies (id, user_id, guest_id, company, name, insured, created_at, updated_at, payload)
    VALUES (1, 1, '', 'TestCo', 'Product A', 'Insured A', '', '', '{}');
  `).run();
}

async function openTestDb() {
  await fs.mkdir(TEST_DB_DIR, { recursive: true });
  db = new DatabaseSync(TEST_DB_PATH);
  seedPoliciesTable();
}

async function closeAndRemoveTestDb() {
  if (db) {
    db.close();
    db = null;
  }
  try { await fs.unlink(TEST_DB_PATH); } catch { /* ignore */ }
  try { await fs.unlink(`${TEST_DB_PATH}-wal`); } catch { /* ignore */ }
  try { await fs.unlink(`${TEST_DB_PATH}-shm`); } catch { /* ignore */ }
}

describe('cash-value-store', () => {
  after(async () => {
    await closeAndRemoveTestDb();
  });

  describe('ensureCashValueTable', () => {
    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
    });

    it('creates the policy_cash_values table and index', () => {
      ensureCashValueTable(db);
      const tableInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'policy_cash_values'"
      ).get();
      assert.ok(tableInfo, 'policy_cash_values table should exist');

      const indexInfo = db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_cash_values_policy'"
      ).get();
      assert.ok(indexInfo, 'idx_cash_values_policy index should exist');
    });
  });

  describe('createCashValueStore', () => {
    let store;

    beforeEach(async () => {
      await closeAndRemoveTestDb();
      await openTestDb();
      store = createCashValueStore(db);
    });

    it('replaceValues inserts rows and getValues reads them back', () => {
      const rows = [
        { policyYear: 1, age: 30, cashValue: 8500 },
        { policyYear: 2, age: 31, cashValue: 19200 },
        { policyYear: 3, age: null, cashValue: 31800 },
      ];
      store.replaceValues(1, rows);

      const result = store.getValues(1);
      assert.equal(result.length, 3);
      assert.equal(result[0].policyYear, 1);
      assert.equal(result[0].age, 30);
      assert.equal(result[0].cashValue, 8500);
      assert.equal(result[0].source, 'ocr');
      assert.equal(result[2].age, null);
    });

    it('replaceValues overwrites previous data for same policy', () => {
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 8500 },
      ]);
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 9000 },
        { policyYear: 2, age: 31, cashValue: 20000 },
      ]);

      const result = store.getValues(1);
      assert.equal(result.length, 2);
      assert.equal(result[0].cashValue, 9000);
    });

    it('getValues returns empty array for policy with no cash values', () => {
      const result = store.getValues(999);
      assert.deepEqual(result, []);
    });

    it('replaceValues accepts source parameter', () => {
      store.replaceValues(1, [
        { policyYear: 1, age: 30, cashValue: 8500, source: 'vision_llm' },
      ]);
      const result = store.getValues(1);
      assert.equal(result[0].source, 'vision_llm');
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test ./tests/cash-value-store.test.mjs`
Expected: FAIL — `ensureCashValueTable` and `createCashValueStore` are not defined

- [ ] **Step 3: Implement cash value store in cashflow-store.mjs**

Append to `server/cashflow-store.mjs` after line 106 (end of file):

```javascript
const CREATE_CASH_VALUES_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS policy_cash_values (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id   INTEGER NOT NULL REFERENCES policies(id),
    policy_year INTEGER NOT NULL,
    age         INTEGER,
    cash_value  REAL    NOT NULL,
    source      TEXT    DEFAULT 'ocr',
    created_at  TEXT    DEFAULT (datetime('now')),
    UNIQUE(policy_id, policy_year)
  );
  CREATE INDEX IF NOT EXISTS idx_cash_values_policy
    ON policy_cash_values(policy_id);
`;

export function ensureCashValueTable(db) {
  db.exec(CREATE_CASH_VALUES_TABLE_SQL);
}

export function createCashValueStore(db) {
  ensureCashValueTable(db);

  const selectValues = db.prepare(`
    SELECT policy_year, age, cash_value, source
      FROM policy_cash_values
     WHERE policy_id = ?
     ORDER BY policy_year ASC
  `);

  const deleteByPolicyId = db.prepare(`
    DELETE FROM policy_cash_values WHERE policy_id = ?
  `);

  const insertValue = db.prepare(`
    INSERT INTO policy_cash_values (policy_id, policy_year, age, cash_value, source)
    VALUES (?, ?, ?, ?, ?)
  `);

  function getValues(policyId) {
    return selectValues.all(policyId).map((row) => ({
      policyYear: row.policy_year,
      age: row.age,
      cashValue: row.cash_value,
      source: row.source,
    }));
  }

  function replaceValues(policyId, rows) {
    if (!Array.isArray(rows)) {
      throw new TypeError('replaceValues: rows must be an array');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      deleteByPolicyId.run(policyId);
      for (const row of rows) {
        insertValue.run(
          policyId,
          row.policyYear,
          row.age ?? null,
          row.cashValue,
          row.source || 'ocr',
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  return { getValues, replaceValues };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ./tests/cash-value-store.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/cashflow-store.mjs tests/cash-value-store.test.mjs
git commit -m "feat: add policy_cash_values table and CRUD store"
```

---

### Task 2: Paddle OCR Script — Add bounding box output

**Files:**
- Modify: `ocr-service/scripts/policy_ocr_paddle.py` (add function after line 44, modify main at line 160)

- [ ] **Step 1: Add `collect_lines_with_boxes()` function**

Insert after the existing `collect_lines` function (after line 44 in `policy_ocr_paddle.py`):

```python
def collect_lines_with_boxes(result) -> dict:
    """Extract text with bounding box coordinates for table parsing."""
    lines = []
    boxes = []
    for item in result or []:
        payload = getattr(item, "res", item)
        if not isinstance(payload, dict):
            continue
        texts = payload.get("rec_texts") or []
        rec_boxes = payload.get("rec_boxes") or []
        scores = payload.get("rec_scores") or []
        for i, text in enumerate(texts):
            text = str(text).strip()
            if not text:
                continue
            lines.append(text)
            box_entry = {"text": text}
            if i < len(rec_boxes):
                box_entry["box"] = rec_boxes[i]
            if i < len(scores):
                box_entry["confidence"] = scores[i]
            boxes.append(box_entry)
    return {"lines": lines, "boxes": boxes}
```

- [ ] **Step 2: Modify `main()` to include boxes in output**

In the `main()` function, replace lines 158-173 (the OCR prediction and output section) with:

```python
    try:
        result = ocr.predict(image_path)
        if pipeline_kind == "vl":
            lines = collect_vl_lines(result)
            boxes_data = {"lines": lines, "boxes": []}
        else:
            boxes_data = collect_lines_with_boxes(result)
            lines = boxes_data["lines"]
    except Exception:
        fail("POLICY_OCR_FAILED")

    if not lines:
        fail("POLICY_OCR_EMPTY")

    output = {
        "ok": True,
        "pipeline": pipeline_kind,
        "lines": lines,
        "ocrText": "\n".join(lines),
        "boxes": boxes_data.get("boxes", []),
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
```

- [ ] **Step 3: Verify script syntax**

Run: `python3 -c "import ast; ast.parse(open('/Users/wenshuping/Documents/OCR_insurance/ocr-service/scripts/policy_ocr_paddle.py').read()); print('OK')"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add ocr-service/scripts/policy_ocr_paddle.py
git commit -m "feat: add bounding box output to Paddle OCR script"
```

---

### Task 3: Cash Value Parser — Table parsing core

**Files:**
- Create: `ocr-service/cash-value-parser.mjs`
- Test: `tests/cash-value-parser.test.mjs` (create)

- [ ] **Step 1: Write failing tests for the parser**

Create `tests/cash-value-parser.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clusterIntoRows,
  detectTableHeader,
  extractCashValueRows,
  parseCashValueTable,
} from '../ocr-service/cash-value-parser.mjs';

describe('cash-value-parser', () => {

  describe('clusterIntoRows', () => {
    it('groups items by Y coordinate with tolerance', () => {
      const boxes = [
        { text: '保单年度', box: [[100, 50], [200, 50], [200, 70], [100, 70]] },
        { text: '现金价值', box: [[350, 52], [450, 52], [450, 72], [350, 72]] },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]] },
        { text: '8,500', box: [[360, 92], [430, 92], [430, 112], [360, 112]] },
      ];
      const rows = clusterIntoRows(boxes, { yThreshold: 15 });
      assert.equal(rows.length, 2);
      assert.equal(rows[0].length, 2);
      assert.equal(rows[0][0].text, '保单年度');
      assert.equal(rows[0][1].text, '现金价值');
      assert.equal(rows[1][0].text, '1');
      assert.equal(rows[1][1].text, '8,500');
    });

    it('sorts items within a row by X coordinate', () => {
      const boxes = [
        { text: '8,500', box: [[360, 90], [430, 90], [430, 110], [360, 110]] },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]] },
      ];
      const rows = clusterIntoRows(boxes, { yThreshold: 15 });
      assert.equal(rows[0][0].text, '1');
      assert.equal(rows[0][1].text, '8,500');
    });

    it('handles boxes without coordinates by returning single-item rows', () => {
      const boxes = [
        { text: 'hello' },
        { text: 'world' },
      ];
      const rows = clusterIntoRows(boxes, { yThreshold: 15 });
      assert.equal(rows.length, 2);
    });
  });

  describe('detectTableHeader', () => {
    it('detects 2-column header with 保单年度 and 现金价值', () => {
      const rows = [
        [{ text: '保单年度', box: [[100, 50]] }, { text: '现金价值', box: [[350, 50]] }],
        [{ text: '1', box: [[120, 90]] }, { text: '8,500', box: [[360, 90]] }],
      ];
      const header = detectTableHeader(rows);
      assert.ok(header);
      assert.equal(header.headerRowIndex, 0);
      assert.equal(header.tableType, 2);
      assert.deepEqual(header.columns, ['policyYear', 'cashValue']);
    });

    it('detects 3-column header with age column', () => {
      const rows = [
        [
          { text: '保险年限' },
          { text: '被保险年龄' },
          { text: '现金价值' },
        ],
      ];
      const header = detectTableHeader(rows);
      assert.ok(header);
      assert.equal(header.tableType, 3);
      assert.deepEqual(header.columns, ['policyYear', 'age', 'cashValue']);
    });

    it('returns null when no header keywords found', () => {
      const rows = [
        [{ text: '姓名' }, { text: '张三' }],
      ];
      const header = detectTableHeader(rows);
      assert.equal(header, null);
    });
  });

  describe('extractCashValueRows', () => {
    it('parses 2-column data rows', () => {
      const dataRows = [
        [{ text: '1' }, { text: '8,500' }],
        [{ text: '2' }, { text: '19,200' }],
        [{ text: '3' }, { text: '31,800.50' }],
      ];
      const columns = ['policyYear', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result.length, 3);
      assert.deepEqual(result[0], { policyYear: 1, age: null, cashValue: 8500 });
      assert.deepEqual(result[1], { policyYear: 2, age: null, cashValue: 19200 });
      assert.deepEqual(result[2], { policyYear: 3, age: null, cashValue: 31800.50 });
    });

    it('parses 3-column data rows with age', () => {
      const dataRows = [
        [{ text: '1' }, { text: '30' }, { text: '8,500' }],
        [{ text: '2' }, { text: '31' }, { text: '19,200' }],
      ];
      const columns = ['policyYear', 'age', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result.length, 2);
      assert.deepEqual(result[0], { policyYear: 1, age: 30, cashValue: 8500 });
    });

    it('skips rows with non-numeric data', () => {
      const dataRows = [
        [{ text: '1' }, { text: '8,500' }],
        [{ text: '合计' }, { text: '—' }],
        [{ text: '2' }, { text: '19,200' }],
      ];
      const columns = ['policyYear', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result.length, 2);
    });

    it('handles amounts with 元 suffix', () => {
      const dataRows = [
        [{ text: '1' }, { text: '8500元' }],
      ];
      const columns = ['policyYear', 'cashValue'];
      const result = extractCashValueRows(dataRows, columns);
      assert.equal(result[0].cashValue, 8500);
    });
  });

  describe('parseCashValueTable', () => {
    it('returns parsed result with confidence for valid 2-column table', () => {
      const boxes = [
        { text: '保单年度', box: [[100, 50], [200, 50], [200, 70], [100, 70]], confidence: 0.98 },
        { text: '现金价值', box: [[350, 50], [450, 50], [450, 70], [350, 70]], confidence: 0.97 },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]], confidence: 0.99 },
        { text: '8,500', box: [[360, 90], [430, 90], [430, 110], [360, 110]], confidence: 0.96 },
        { text: '2', box: [[120, 130], [140, 130], [140, 150], [120, 150]], confidence: 0.99 },
        { text: '19,200', box: [[360, 130], [440, 130], [440, 150], [360, 150]], confidence: 0.95 },
        { text: '3', box: [[120, 170], [140, 170], [140, 190], [120, 190]], confidence: 0.98 },
        { text: '31,800', box: [[360, 170], [440, 170], [440, 190], [360, 190]], confidence: 0.94 },
      ];
      const result = parseCashValueTable(boxes);
      assert.ok(result.ok);
      assert.equal(result.tableType, 2);
      assert.equal(result.rows.length, 3);
      assert.equal(result.rows[0].policyYear, 1);
      assert.equal(result.rows[0].cashValue, 8500);
      assert.ok(result.confidence > 0);
    });

    it('returns failure when boxes are empty', () => {
      const result = parseCashValueTable([]);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'CASH_VALUE_TABLE_NOT_DETECTED');
    });

    it('returns failure when no header detected', () => {
      const boxes = [
        { text: '姓名', box: [[100, 50], [200, 50], [200, 70], [100, 70]] },
        { text: '张三', box: [[350, 50], [450, 50], [450, 70], [350, 70]] },
      ];
      const result = parseCashValueTable(boxes);
      assert.equal(result.ok, false);
    });

    it('returns failure when fewer than 3 data rows', () => {
      const boxes = [
        { text: '保单年度', box: [[100, 50], [200, 50], [200, 70], [100, 70]] },
        { text: '现金价值', box: [[350, 50], [450, 50], [450, 70], [350, 70]] },
        { text: '1', box: [[120, 90], [140, 90], [140, 110], [120, 110]] },
        { text: '8,500', box: [[360, 90], [430, 90], [430, 110], [360, 110]] },
      ];
      const result = parseCashValueTable(boxes);
      assert.equal(result.ok, false);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test ./tests/cash-value-parser.test.mjs`
Expected: FAIL — module `cash-value-parser.mjs` does not exist

- [ ] **Step 3: Implement cash value parser**

Create `ocr-service/cash-value-parser.mjs`:

```javascript
/**
 * Cash value table parser — extracts structured data from OCR bounding boxes.
 *
 * Algorithm mimics human eye reading:
 *   1. Cluster text items into rows by Y coordinate
 *   2. Detect table header by keyword matching
 *   3. Read data rows left-to-right based on column semantics
 *   4. Validate and compute confidence score
 */

const YEAR_KEYWORDS = ['保单年度', '保险年限', '保险年度', '年度', '保单年'];
const AGE_KEYWORDS = ['年龄', '被保险年龄', '被保险人年龄'];
const CASH_VALUE_KEYWORDS = ['现金价值', '退保金', '账户价值'];

const DEFAULT_Y_THRESHOLD = 15;
const MIN_DATA_ROWS = 3;
const CONFIDENCE_THRESHOLD = 0.7;

/**
 * Compute the Y midpoint from a bounding box.
 * Box format: [[x1,y1],[x2,y2],[x3,y3],[x4,y4]] (top-left, top-right, bottom-right, bottom-left)
 */
function boxYMid(box) {
  if (!box || !Array.isArray(box) || box.length < 4) return null;
  const ys = box.map((point) => (Array.isArray(point) ? point[1] : 0));
  return (Math.min(...ys) + Math.max(...ys)) / 2;
}

function boxXMin(box) {
  if (!box || !Array.isArray(box) || box.length < 4) return 0;
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

    // Determine columns
    const hasAgeKeyword = AGE_KEYWORDS.some((kw) => joinedText.includes(kw));

    let columns;
    if (row.length >= 3 || hasAgeKeyword) {
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
 * Step 3: Extract structured rows from data rows based on column mapping.
 */
export function extractCashValueRows(dataRows, columns) {
  const results = [];

  for (const row of dataRows) {
    if (row.length < columns.length) continue;

    const values = row.slice(0, columns.length).map((item) => item.text);
    const parsed = {};
    let valid = true;

    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      const text = values[i];

      if (col === 'policyYear') {
        const num = parseNumericValue(text);
        if (num === null || num < 1 || !Number.isInteger(num)) { valid = false; break; }
        parsed.policyYear = num;
      } else if (col === 'age') {
        const num = parseNumericValue(text);
        parsed.age = num;
      } else if (col === 'cashValue') {
        const num = parseNumericValue(text);
        if (num === null || num < 0) { valid = false; break; }
        parsed.cashValue = num;
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

  return results;
}

/**
 * Step 4: Validate parsed rows and compute confidence.
 */
function validateAndScore(rows, boxes) {
  if (rows.length < MIN_DATA_ROWS) {
    return { valid: false, confidence: 0 };
  }

  // Check year ordering
  let yearOrdered = true;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].policyYear <= rows[i - 1].policyYear) {
      yearOrdered = false;
      break;
    }
  }

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test ./tests/cash-value-parser.test.mjs`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add ocr-service/cash-value-parser.mjs tests/cash-value-parser.test.mjs
git commit -m "feat: add cash value table parser with row clustering and header detection"
```

---

### Task 4: OCR Service Integration — Wire cash value scanning

**Files:**
- Modify: `ocr-service/insurance-ocr.service.mjs` (add function)
- Modify: `ocr-service/router.mjs` (add route)

- [ ] **Step 1: Add `scanCashValueTable()` to insurance-ocr.service.mjs**

Add import at top of `ocr-service/insurance-ocr.service.mjs` (after existing imports, around line 10):

```javascript
import { parseCashValueTable } from './cash-value-parser.mjs';
```

Add the `scanCashValueTable` function. Find a good insertion point (before the last export block) and add:

```javascript
/**
 * Scan a cash value table image using Paddle OCR with bounding boxes.
 * Returns parsed rows or failure info.
 */
export async function scanCashValueTable({ uploadItem }) {
  if (!uploadItem?.dataUrl) {
    return { ok: false, error: 'CASH_VALUE_TABLE_NOT_DETECTED', message: '缺少图片数据' };
  }

  // Run Paddle OCR via the same child process mechanism as scanInsurancePolicyLocal
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'cash-value-ocr-'));
  const imagePath = path.join(tmpDir, 'input.png');

  try {
    // Decode base64 data URL to file
    const base64Data = uploadItem.dataUrl.replace(/^data:image\/\w+;base64,/, '');
    await writeFile(imagePath, Buffer.from(base64Data, 'base64'));

    // Run Paddle OCR script
    const { paddleScriptPath } = resolveLocalOcrScriptPaths();
    assertOcrScriptExists(paddleScriptPath);

    const { stdout } = await execFileAsync('python3', [paddleScriptPath, imagePath], {
      maxBuffer: 50 * 1024 * 1024,
      timeout: 120000,
    });

    const ocrOutput = JSON.parse(stdout);
    if (!ocrOutput.ok) {
      return { ok: false, error: 'PARSE_FAILED', message: 'OCR 识别失败' };
    }

    const boxes = ocrOutput.boxes || [];
    const result = parseCashValueTable(boxes);

    return result;
  } catch (error) {
    const code = String(error?.message || error?.code || 'PARSE_FAILED');
    return { ok: false, error: code, message: '现金价值表解析失败' };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
```

- [ ] **Step 2: Add cash value scan route to router.mjs**

In `ocr-service/router.mjs`, add after the existing `/internal/ocr/policies/scan` route (after line 35):

```javascript
  router.post('/internal/ocr/policies/cash-value/scan', requireOcrServiceToken, async (req, res) => {
    try {
      const { uploadItem } = req.body || {};
      if (!uploadItem) {
        return res.status(400).json({ ok: false, error: 'MISSING_UPLOAD', message: '缺少上传图片' });
      }
      const result = await scanCashValueTable({ uploadItem });
      return res.json(result);
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: 'CASH_VALUE_SCAN_FAILED',
        message: err instanceof Error ? err.message : '现金价值表扫描失败',
      });
    }
  });
```

Also update the import at line 3 to include `scanCashValueTable`:

```javascript
import { scanCashValueTable, scanInsurancePolicyLocal } from './insurance-ocr.service.mjs';
```

- [ ] **Step 3: Verify the OCR service starts without errors**

Run: `node -e "import('./ocr-service/router.mjs').then(() => console.log('OK')).catch(e => console.error(e.message))"`
Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add ocr-service/insurance-ocr.service.mjs ocr-service/router.mjs
git commit -m "feat: wire cash value table scanning into OCR service"
```

---

### Task 5: Vision LLM Fallback

**Files:**
- Create: `server/vision-llm.mjs`

- [ ] **Step 1: Implement vision LLM client**

Create `server/vision-llm.mjs`:

```javascript
/**
 * Vision LLM client — OpenAI-compatible API for cash value table extraction.
 *
 * Falls back gracefully when env vars are not configured.
 */

const CASH_VALUE_PROMPT = `请识别这张图片中的现金价值表格。
返回 JSON 数组，每项包含:
- policyYear: 保单年度(整数)
- age: 被保险年龄(整数，如无此列则为 null)
- cashValue: 现金价值金额(数字)
只返回 JSON 数组，不要其他内容。`;

export function isVisionLlmConfigured(env = process.env) {
  return Boolean(
    (env.VISION_LLM_API_KEY || '').trim() &&
    (env.VISION_LLM_ENDPOINT || '').trim()
  );
}

function resolveConfig(env = process.env) {
  const apiKey = (env.VISION_LLM_API_KEY || '').trim();
  const endpoint = (env.VISION_LLM_ENDPOINT || '').trim().replace(/\/+$/, '');
  const model = (env.VISION_LLM_MODEL || 'gpt-4o').trim();
  if (!apiKey || !endpoint) return null;
  return { apiKey, endpoint, model };
}

/**
 * Extract cash value table from an image using a vision LLM.
 *
 * @param {string} imageDataUrl - Base64 data URL of the image
 * @returns {Promise<{ok: boolean, rows?: Array, error?: string}>}
 */
export async function extractCashValueWithVisionLlm(imageDataUrl, env = process.env) {
  const config = resolveConfig(env);
  if (!config) {
    return { ok: false, error: 'VISION_LLM_NOT_CONFIGURED', message: '视觉大模型未配置' };
  }

  try {
    const response = await fetch(`${config.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: CASH_VALUE_PROMPT },
              { type: 'image_url', image_url: { url: imageDataUrl } },
            ],
          },
        ],
        max_tokens: 4096,
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      return { ok: false, error: 'VISION_LLM_FAILED', message: `HTTP ${response.status}: ${errorText.slice(0, 200)}` };
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || '';

    // Extract JSON array from response (handle markdown code blocks)
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return { ok: false, error: 'VISION_LLM_FAILED', message: '返回内容中未找到 JSON 数组' };
    }

    const rows = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, error: 'VISION_LLM_FAILED', message: '解析结果为空' };
    }

    // Validate and normalize
    const normalized = [];
    for (const row of rows) {
      const policyYear = Number(row.policyYear);
      const cashValue = Number(row.cashValue);
      if (!Number.isFinite(policyYear) || !Number.isFinite(cashValue)) continue;
      normalized.push({
        policyYear,
        age: row.age != null ? Number(row.age) : null,
        cashValue,
      });
    }

    if (normalized.length < 3) {
      return { ok: false, error: 'VISION_LLM_FAILED', message: `有效行数不足: ${normalized.length}` };
    }

    return { ok: true, source: 'vision_llm', rows: normalized, rowCount: normalized.length };
  } catch (error) {
    return { ok: false, error: 'VISION_LLM_FAILED', message: error instanceof Error ? error.message : '视觉大模型调用失败' };
  }
}
```

- [ ] **Step 2: Verify module loads**

Run: `node -e "import('./server/vision-llm.mjs').then(m => { console.log('configured:', m.isVisionLlmConfigured()); console.log('OK'); })"`
Expected: `configured: false` and `OK`

- [ ] **Step 3: Commit**

```bash
git add server/vision-llm.mjs
git commit -m "feat: add vision LLM fallback client for cash value extraction"
```

---

### Task 6: API Endpoints — Scan and Confirm

**Files:**
- Modify: `server/app.mjs` (add 2 endpoints + modify GET /api/policies/:id)

- [ ] **Step 1: Add imports to app.mjs**

At the top of `server/app.mjs`, add imports alongside existing imports:

```javascript
import { createCashValueStore } from './cashflow-store.mjs';
import { extractCashValueWithVisionLlm, isVisionLlmConfigured } from './vision-llm.mjs';
```

Find where `createCashflowStore` is used (search for `cashflowStore`) and add `createCashValueStore` initialization nearby. The cash value store should be created from the same `db` instance:

```javascript
const cashValueStore = createCashValueStore(state.db || db);
```

(Place this right after where `cashflowStore` is initialized.)

- [ ] **Step 2: Add POST /api/policies/:id/cash-value/scan endpoint**

Add before the `return app;` line at the end of `createApp()` (around line 1923):

```javascript
  app.post('/api/policies/:id/cash-value/scan', async (req, res) => {
    try {
      const user = resolveAuthUser(req, state);
      const guestId = normalizeGuestId(req.query?.guestId);
      if (!user && !guestId) {
        return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
      }

      const policyId = Number(req.params.id);
      const policy = state.policies.find((row) => {
        if (Number(row.id) !== policyId) return false;
        if (user) return Number(row.userId) === Number(user.id);
        return String(row.guestId || '') === guestId && !row.userId;
      });
      if (!policy) {
        return res.status(404).json({ ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' });
      }

      const { uploadItem } = req.body || {};
      if (!uploadItem?.dataUrl) {
        return res.status(400).json({ ok: false, error: 'MISSING_UPLOAD', message: '缺少上传图片' });
      }

      // Try OCR service first
      let result = { ok: false, error: 'PARSE_FAILED' };
      try {
        const ocrBaseUrl = resolveOcrServiceUrl();
        if (ocrBaseUrl) {
          const ocrResponse = await fetch(`${ocrBaseUrl}/internal/ocr/policies/cash-value/scan`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-service': 'policy-ocr-app',
              ...(process.env.POLICY_OCR_SERVICE_TOKEN ? { 'x-ocr-service-token': process.env.POLICY_OCR_SERVICE_TOKEN } : {}),
            },
            body: JSON.stringify({ uploadItem }),
            signal: AbortSignal.timeout(120000),
          });
          if (ocrResponse.ok) {
            result = await ocrResponse.json();
          }
        }
      } catch {
        // OCR service unavailable, fall through to vision LLM
      }

      // Vision LLM fallback if OCR failed
      if (!result.ok && isVisionLlmConfigured()) {
        result = await extractCashValueWithVisionLlm(uploadItem.dataUrl);
      }

      if (!result.ok) {
        return res.json(result);
      }

      return res.json({
        ok: true,
        source: result.source || 'ocr',
        tableType: result.tableType || 2,
        rows: result.rows,
        rowCount: result.rowCount || result.rows.length,
        confidence: result.confidence || 0.5,
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: 'CASH_VALUE_SCAN_FAILED',
        message: error instanceof Error ? error.message : '现金价值表扫描失败',
      });
    }
  });
```

- [ ] **Step 3: Add POST /api/policies/:id/cash-value/confirm endpoint**

Add right after the scan endpoint:

```javascript
  app.post('/api/policies/:id/cash-value/confirm', async (req, res) => {
    try {
      const user = resolveAuthUser(req, state);
      const guestId = normalizeGuestId(req.query?.guestId);
      if (!user && !guestId) {
        return res.status(401).json({ ok: false, code: 'UNAUTHORIZED', message: '缺少游客标识' });
      }

      const policyId = Number(req.params.id);
      const policy = state.policies.find((row) => {
        if (Number(row.id) !== policyId) return false;
        if (user) return Number(row.userId) === Number(user.id);
        return String(row.guestId || '') === guestId && !row.userId;
      });
      if (!policy) {
        return res.status(404).json({ ok: false, code: 'POLICY_NOT_FOUND', message: '保单不存在' });
      }

      const { rows } = req.body || {};
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ ok: false, code: 'INVALID_ROWS', message: '缺少现金价值数据' });
      }

      cashValueStore.replaceValues(policyId, rows);

      return res.json({ ok: true, savedCount: rows.length });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: 'CASH_VALUE_SAVE_FAILED',
        message: error instanceof Error ? error.message : '现金价值数据保存失败',
      });
    }
  });
```

- [ ] **Step 4: Modify GET /api/policies/:id to include cashValues**

Find the existing GET endpoint (line 1909-1922). Modify line 1921 to include cash values:

Change:
```javascript
    res.json({ ok: true, policy: attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords) });
```

To:
```javascript
    const policyWithIndicators = attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords);
    const cashValues = cashValueStore.getValues(policyId);
    res.json({ ok: true, policy: { ...policyWithIndicators, cashValues } });
```

Also add `const policyId = Number(req.params.id);` before the `state.policies.find` call if not already present, and use `policyId` in the find callback instead of `Number(req.params.id)`.

- [ ] **Step 5: Verify server starts**

Run: `node -e "import('./server/app.mjs').then(() => console.log('OK')).catch(e => console.error(e.message))"`
Expected: `OK`

- [ ] **Step 6: Commit**

```bash
git add server/app.mjs
git commit -m "feat: add cash value scan and confirm API endpoints"
```

---

### Task 7: Frontend API Types and Functions

**Files:**
- Modify: `src/api.ts`

- [ ] **Step 1: Add CashValueRow type**

Add after `CashflowEntry` type (after line 299 in `src/api.ts`):

```typescript
export type CashValueRow = {
  policyYear: number;
  age: number | null;
  cashValue: number;
  source?: string;
};

export type CashValueScanResult = {
  ok: boolean;
  source?: 'ocr' | 'vision_llm';
  tableType?: 2 | 3;
  rows: CashValueRow[];
  rowCount?: number;
  confidence?: number;
  error?: string;
  message?: string;
};
```

- [ ] **Step 2: Add cashValues field to Policy type**

In the `Policy` type (line 39-68), add after `totalCashflow` (line 67):

```typescript
  cashValues?: CashValueRow[];
```

- [ ] **Step 3: Add API functions**

Add after the `regeneratePolicyReport` function (after line 565):

```typescript
export function scanCashValue(input: { token?: string; guestId?: string; policyId: number; uploadItem: UploadItem }) {
  const query = input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
  return request<CashValueScanResult>(`/api/policies/${input.policyId}/cash-value/scan${query}`, {
    token: input.token,
    body: { uploadItem: input.uploadItem },
  });
}

export function confirmCashValue(input: { token?: string; guestId?: string; policyId: number; rows: CashValueRow[] }) {
  const query = input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
  return request<{ ok: true; savedCount: number }>(`/api/policies/${input.policyId}/cash-value/confirm${query}`, {
    token: input.token,
    body: { rows: input.rows },
  });
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors related to `api.ts`

- [ ] **Step 5: Commit**

```bash
git add src/api.ts
git commit -m "feat: add cash value API types and client functions"
```

---

### Task 8: Frontend — Cash Value Upload Dialog and Preview

**Files:**
- Modify: `src/App.tsx`

This is the largest task. It adds:
1. State variables for the dialog
2. The dialog component that appears after save
3. The preview/edit table component
4. Integration into the handleSubmit flow

- [ ] **Step 1: Add imports**

At the top of `src/App.tsx`, add to the existing api.ts import (find the line importing from `./api`):

Add `scanCashValue`, `confirmCashValue`, `CashValueRow`, `CashValueScanResult` to the import destructuring.

- [ ] **Step 2: Add state variables**

Find the state declarations section (around lines 2173-2218). Add after the existing state declarations:

```typescript
  // Cash value upload dialog state
  const [cashValueDialogOpen, setCashValueDialogOpen] = useState(false);
  const [cashValuePolicyId, setCashValuePolicyId] = useState<number | null>(null);
  const [cashValueScanResult, setCashValueScanResult] = useState<CashValueScanResult | null>(null);
  const [cashValueEditRows, setCashValueEditRows] = useState<CashValueRow[]>([]);
  const [cashValueLoading, setCashValueLoading] = useState(false);
  const [cashValueMessage, setCashValueMessage] = useState('');
  const cashValueInputRef = useRef<HTMLInputElement | null>(null);
```

- [ ] **Step 3: Add cash value upload handler**

Add after the existing `handleSubmit` function (after line 2999):

```typescript
  async function handleCashValueFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || cashValuePolicyId === null) return;
    e.target.value = '';

    setCashValueLoading(true);
    setCashValueMessage('正在识别现金价值表...');

    try {
      const uploadItem = await fileToUploadItem(file);
      const result = await scanCashValue({
        token,
        guestId,
        policyId: cashValuePolicyId,
        uploadItem,
      });

      if (result.ok && result.rows?.length) {
        setCashValueScanResult(result);
        setCashValueEditRows(result.rows);
        setCashValueMessage('');
      } else {
        setCashValueMessage(result.message || '未能识别现金价值表，请确保照片清晰且包含完整表格');
        setCashValueScanResult(null);
        setCashValueEditRows([]);
      }
    } catch (error) {
      setCashValueMessage(error instanceof Error ? error.message : '识别失败');
      setCashValueScanResult(null);
      setCashValueEditRows([]);
    } finally {
      setCashValueLoading(false);
    }
  }

  async function handleCashValueConfirm() {
    if (cashValuePolicyId === null || cashValueEditRows.length === 0) return;
    setCashValueLoading(true);
    setCashValueMessage('正在保存...');

    try {
      await confirmCashValue({
        token,
        guestId,
        policyId: cashValuePolicyId,
        rows: cashValueEditRows,
      });

      // Refresh the policy data
      const updated = policies.map((p) =>
        p.id === cashValuePolicyId ? { ...p, cashValues: cashValueEditRows } : p
      );
      setPolicies(updated);
      if (selectedPolicy?.id === cashValuePolicyId) {
        setSelectedPolicy({ ...selectedPolicy, cashValues: cashValueEditRows });
      }

      setCashValueDialogOpen(false);
      setCashValueScanResult(null);
      setCashValueEditRows([]);
      setCashValuePolicyId(null);
      setCashValueMessage(`现金价值表已保存（${cashValueEditRows.length} 行）`);
    } catch (error) {
      setCashValueMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setCashValueLoading(false);
    }
  }

  function handleCashValueCellEdit(rowIndex: number, field: 'policyYear' | 'age' | 'cashValue', value: string) {
    setCashValueEditRows((prev) => {
      const updated = [...prev];
      const num = Number(value.replace(/[,，\s元]/g, ''));
      if (field === 'age') {
        updated[rowIndex] = { ...updated[rowIndex], age: Number.isFinite(num) ? num : null };
      } else if (Number.isFinite(num)) {
        updated[rowIndex] = { ...updated[rowIndex], [field]: num };
      }
      return updated;
    });
  }

  function closeCashValueDialog() {
    setCashValueDialogOpen(false);
    setCashValueScanResult(null);
    setCashValueEditRows([]);
    setCashValuePolicyId(null);
    setCashValueMessage('');
    setActiveTab('policies');
  }
```

- [ ] **Step 4: Modify handleSubmit to trigger dialog after save**

In the `handleSubmit` function (around line 2938-2999), find the success block (after `setSelectedPolicy(payload.policy)` around line 2978). Add the dialog trigger right before the final `setMessage` call:

Find:
```typescript
      setSelectedPolicy(payload.policy);
      setActiveTab('policies');
```

At the top of the `handleSubmit` function, before the `scanPolicy()` call, add:

```typescript
      const isNewPolicy = !policies.some((p) => Number(p.id) === Number((formData as any).id));
```

Replace with:
```typescript
      setSelectedPolicy(payload.policy);

      // Trigger cash value dialog for newly saved policies without cash values
      const hasExistingCashValues = (payload.policy.cashValues?.length ?? 0) > 0;
      if (!hasExistingCashValues && isNewPolicy) {
        setCashValuePolicyId(payload.policy.id);
        setCashValueDialogOpen(true);
      } else {
        setActiveTab('policies');
      }
```

- [ ] **Step 5: Add CashValueDialog component**

Add the dialog component. Find a good place near the other component definitions (before the main `App` return statement, around line 3160). Add:

```typescript
  // Cash Value Upload Dialog
  const cashValueDialog = cashValueDialogOpen ? (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
        {!cashValueScanResult ? (
          /* Step 1: Upload prompt */
          <div className="text-center">
            <h3 className="mb-2 text-lg font-bold text-slate-800">
              保单已保存！是否上传现金价值表？
            </h3>
            <p className="mb-5 text-sm text-slate-500">
              拍照上传保单的现金价值页面，系统将自动识别并录入
            </p>
            {cashValueMessage && (
              <p className="mb-3 text-sm text-red-500">{cashValueMessage}</p>
            )}
            {cashValueLoading && (
              <p className="mb-3 text-sm text-blue-500">正在识别中...</p>
            )}
            <div className="flex gap-3 justify-center">
              <button
                className="rounded-lg bg-[#0B72B9] px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                disabled={cashValueLoading}
                onClick={() => cashValueInputRef.current?.click()}
              >
                拍照上传
              </button>
              <button
                className="rounded-lg border border-slate-200 px-5 py-2.5 text-sm font-medium text-slate-600"
                onClick={closeCashValueDialog}
              >
                暂时跳过
              </button>
            </div>
            <input
              ref={cashValueInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => { void handleCashValueFileChange(e); }}
            />
          </div>
        ) : (
          /* Step 2: Preview and edit results */
          <div>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-lg font-bold text-slate-800">现金价值表识别结果</h3>
              <span className="text-xs text-slate-400">
                {cashValueScanResult.source === 'vision_llm' ? 'AI识别' : 'Paddle OCR'}
                {cashValueScanResult.confidence != null && ` · 置信度 ${Math.round(cashValueScanResult.confidence * 100)}%`}
              </span>
            </div>
            {cashValueMessage && (
              <p className="mb-2 text-sm text-red-500">{cashValueMessage}</p>
            )}
            <div className="max-h-[50vh] overflow-y-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-slate-100">
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">保单年度</th>
                    {cashValueScanResult.tableType === 3 && (
                      <th className="px-2 py-1.5 text-left font-bold text-slate-600">年龄</th>
                    )}
                    <th className="px-2 py-1.5 text-left font-bold text-slate-600">现金价值(元)</th>
                  </tr>
                </thead>
                <tbody>
                  {cashValueEditRows.map((row, i) => (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="px-1 py-0.5">
                        <input
                          type="text"
                          className="w-16 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                          defaultValue={row.policyYear}
                          onBlur={(e) => handleCashValueCellEdit(i, 'policyYear', e.target.value)}
                        />
                      </td>
                      {cashValueScanResult.tableType === 3 && (
                        <td className="px-1 py-0.5">
                          <input
                            type="text"
                            className="w-14 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                            defaultValue={row.age ?? ''}
                            onBlur={(e) => handleCashValueCellEdit(i, 'age', e.target.value)}
                          />
                        </td>
                      )}
                      <td className="px-1 py-0.5">
                        <input
                          type="text"
                          className="w-24 rounded border border-slate-200 px-1.5 py-1 text-xs focus:border-blue-400 focus:outline-none"
                          defaultValue={row.cashValue.toLocaleString('zh-CN')}
                          onBlur={(e) => handleCashValueCellEdit(i, 'cashValue', e.target.value)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex gap-2 justify-center">
              <button
                className="rounded-lg bg-[#0B72B9] px-4 py-2 text-sm font-bold text-white disabled:opacity-50"
                disabled={cashValueLoading || cashValueEditRows.length === 0}
                onClick={() => { void handleCashValueConfirm(); }}
              >
                确认保存
              </button>
              <button
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 disabled:opacity-50"
                disabled={cashValueLoading}
                onClick={() => {
                  setCashValueScanResult(null);
                  setCashValueEditRows([]);
                  setCashValueMessage('');
                  cashValueInputRef.current?.click();
                }}
              >
                重新拍照
              </button>
              <button
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-400"
                onClick={closeCashValueDialog}
              >
                跳过
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  ) : null;
```

- [ ] **Step 6: Render the dialog in the JSX**

Find all the return blocks in the main App component (around lines 3164-3225). Add `{cashValueDialog}` to each return block that renders the main UI, similar to how `{authDialog}` and `{accountSheet}` are included. For example, in the `activeTab === 'entry'` block (around line 3183-3224), add `{cashValueDialog}` right before the closing `</>`:

```tsx
        {cashValueDialog}
        {responsibilityAssistant}
        {authDialog}
        {accountSheet}
```

Do the same for the main return block (the policies list view, around line 3237+).

- [ ] **Step 7: Add manual trigger button for cash value upload**

The spec requires that users who skipped the dialog can later manually trigger the cash value upload from the policy detail / cashflow area.

In the `CashflowDetailPage` component (around line 3523), find where policy details are rendered. Add an "上传现金价值表" button near each policy's section that, when clicked, opens the cash value dialog for that specific policy:

```tsx
  <button
    className="mt-2 rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
    onClick={() => {
      setCashValuePolicyId(policy.id);
      setCashValueDialogOpen(true);
    }}
  >
    上传现金价值表
  </button>
```

This button should only appear when the policy has no `cashValues` or the user wants to re-upload (always show it — re-uploading overwrites).

Also add `{cashValueDialog}` to the `CashflowDetailPage` return JSX so the dialog renders when triggered from this page.

- [ ] **Step 8: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add cash value upload dialog with editable preview table"
```

---

### Task 9: Frontend — Merge Cash Values into Cashflow Display

**Files:**
- Modify: `src/App.tsx` (CashflowAnnualTable component and CashflowDetailPage)

- [ ] **Step 1: Pass cashValues to CashflowAnnualTable**

Find where `CashflowAnnualTable` is rendered (around line 3583). It currently receives `entries` (CashflowEntry[]). Add the policy's `cashValues` as a new prop:

Find the call site:
```tsx
<CashflowAnnualTable
  entries={plan.annualEntries}
  effectiveYear={...}
  birthYear={...}
  endYear={...}
  policyId={plan.policyId}
  productName={plan.productName}
/>
```

Add a new prop:
```tsx
<CashflowAnnualTable
  entries={plan.annualEntries}
  effectiveYear={...}
  birthYear={...}
  endYear={...}
  policyId={plan.policyId}
  productName={plan.productName}
  cashValues={memberPolicies.find(p => p.id === plan.policyId)?.cashValues}
/>
```

- [ ] **Step 2: Update CashflowAnnualTable to accept and use cashValues**

Modify the `CashflowAnnualTable` function signature (line 3351) to add the `cashValues` prop:

```typescript
function CashflowAnnualTable({ entries, effectiveYear, birthYear, endYear, policyId, productName, cashValues }: {
  entries: CashflowEntry[];
  effectiveYear: number;
  birthYear: number;
  endYear: number;
  policyId: number;
  productName: string;
  cashValues?: CashValueRow[];
}) {
```

After `fillCashflowYears` call (line 3359), add a map that overlays OCR cash values onto entries:

```typescript
  // Overlay OCR cash values onto entries
  const cashValueMap = new Map<number, number>();
  if (cashValues) {
    for (const cv of cashValues) {
      const calendarYear = effectiveYear + cv.policyYear - 1;
      cashValueMap.set(calendarYear, cv.cashValue);
    }
  }
  const enrichedEntries = allEntries.map((entry) => {
    const ocrCashValue = cashValueMap.get(entry.year);
    if (ocrCashValue != null) {
      return { ...entry, cashValue: ocrCashValue };
    }
    return entry;
  });
```

Then use `enrichedEntries` instead of `allEntries` in the rest of the component (the column splitting and rendering logic).

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat: merge OCR cash values into cashflow annual table display"
```

---

### Task 10: Integration Testing and Final Verification

- [ ] **Step 1: Run all existing tests to ensure no regressions**

Run: `npm test`
Expected: All existing tests pass (15 test files)

- [ ] **Step 2: Run the new tests**

Run: `node --test ./tests/cash-value-store.test.mjs ./tests/cash-value-parser.test.mjs`
Expected: All new tests pass

- [ ] **Step 3: Verify dev server starts**

Run: `npm run local:dev` (in background)
Expected: Server starts on configured ports without errors

- [ ] **Step 4: Manual smoke test checklist**

1. Upload a policy front page → confirm basic info → save → dialog appears
2. Click "暂时跳过" → dialog closes, policy saved to list
3. Upload another policy → save → dialog appears → click "拍照上传"
4. Upload a cash value table image → preview table appears with parsed data
5. Edit a cell in the preview → confirm save → success message
6. Open cashflow detail page → verify cash value column shows OCR data
7. Re-upload cash value for same policy → data overwrites previous

- [ ] **Step 5: Final commit with any fixes**

```bash
git add -A
git commit -m "fix: address integration issues from cash value OCR feature"
```
