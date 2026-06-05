# Policy Basic Info Layout OCR Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a coordinate-aware OCR pass for policy basic information so core fields do not get misread from benefit tables or rider rows.

**Architecture:** Keep the existing text OCR flow as the stable fallback. Add focused OCR-service modules that normalize PaddleOCR boxes, split them into layout regions, parse basic-info fields from allowed regions, then merge high-confidence layout fields into the existing scan result with warnings for review. Surface warnings through the existing policy scan payload with minimal frontend changes.

**Tech Stack:** Node ESM `.mjs`, PaddleOCR boxes from existing Python script, `node:test`, React/Vite TypeScript contracts.

---

## File Structure

- Create: `ocr-service/policy-layout-boxes.mjs`
  - Shared geometry helpers for OCR boxes: normalize box shape, compute x/y bounds, cluster rows, sort reading order.
- Create: `ocr-service/policy-layout-regions.mjs`
  - Assign OCR boxes to `header`, `basic-info`, `benefit-table`, `rider-table`, and `footer`.
- Create: `ocr-service/policy-basic-info-layout-parser.mjs`
  - Extract company, name, applicant, insured, policy number, effective date, beneficiary, insured ID, and insured birthday from safe layout regions.
- Create: `ocr-service/policy-layout-merge.mjs`
  - Merge layout parser output into the existing text parser output without letting benefit/rider regions override core fields.
- Modify: `ocr-service/insurance-ocr.service.mjs`
  - Preserve PaddleOCR `boxes`, run layout parsing when boxes exist, merge results, and return warnings/field confidence.
- Modify: `src/api/contracts/policy.ts`
  - Add optional `ocrWarnings` and `fieldConfidence` to `PolicyScanResult`.
- Modify: `src/apps/customer/CustomerApp.tsx`
  - Show a short confirmation message when OCR warnings exist.
- Modify: `src/features/policy-entry/UploadPolicyPage.tsx`
  - Render the warning list near the current OCR status message.
- Test: `tests/policy-layout-boxes.test.mjs`
- Test: `tests/policy-layout-regions.test.mjs`
- Test: `tests/policy-basic-info-layout-parser.test.mjs`
- Test: `tests/policy-layout-merge.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

## Data Contract

Use this shape internally and preserve it through the scan payload:

```js
{
  data: {
    company: '新华保险',
    name: '测试终身寿险',
    applicant: '张三',
    insured: '李四',
    policyNumber: '990123456789',
    date: '2025-12-23',
    beneficiary: '法定',
    insuredIdNumber: '330106198712072413',
    insuredBirthday: '1987-12-07'
  },
  fieldConfidence: {
    company: 'high',
    name: 'review',
    applicant: 'high',
    insured: 'high',
    policyNumber: 'high',
    date: 'high',
    beneficiary: 'review',
    insuredIdNumber: 'high',
    insuredBirthday: 'high'
  },
  ocrWarnings: [
    '产品名称识别到多个候选，请确认是否为主险名称'
  ]
}
```

## Task 1: Geometry Helpers For OCR Boxes

**Files:**
- Create: `ocr-service/policy-layout-boxes.mjs`
- Test: `tests/policy-layout-boxes.test.mjs`

- [ ] **Step 1: Write failing tests for box normalization and row clustering**

Create `tests/policy-layout-boxes.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  boxBounds,
  boxCenter,
  clusterBoxesIntoRows,
  normalizeOcrBoxes,
  sortBoxesReadingOrder,
} from '../ocr-service/policy-layout-boxes.mjs';

test('normalizeOcrBoxes keeps text, confidence, bounds, and original index', () => {
  const boxes = normalizeOcrBoxes([
    { text: '投保人', box: [100, 120, 160, 142], confidence: 0.98 },
    { text: '张三', box: [[220, 121], [260, 121], [260, 143], [220, 143]], confidence: 0.97 },
    { text: '', box: [0, 0, 1, 1] },
  ]);

  assert.equal(boxes.length, 2);
  assert.deepEqual(boxBounds(boxes[0].box), { xMin: 100, yMin: 120, xMax: 160, yMax: 142 });
  assert.deepEqual(boxCenter(boxes[1].box), { x: 240, y: 132 });
  assert.equal(boxes[0].index, 0);
  assert.equal(boxes[1].text, '张三');
});

test('clusterBoxesIntoRows groups nearby y centers and sorts left to right', () => {
  const boxes = normalizeOcrBoxes([
    { text: '张三', box: [220, 121, 260, 143] },
    { text: '投保人', box: [100, 120, 160, 142] },
    { text: '被保险人', box: [100, 170, 180, 192] },
    { text: '李四', box: [220, 171, 260, 193] },
  ]);

  const rows = clusterBoxesIntoRows(boxes, { yThreshold: 12 });
  assert.deepEqual(rows.map((row) => row.items.map((item) => item.text)), [
    ['投保人', '张三'],
    ['被保险人', '李四'],
  ]);
});

test('sortBoxesReadingOrder returns top-to-bottom then left-to-right text order', () => {
  const boxes = normalizeOcrBoxes([
    { text: '李四', box: [220, 171, 260, 193] },
    { text: '投保人', box: [100, 120, 160, 142] },
    { text: '张三', box: [220, 121, 260, 143] },
    { text: '被保险人', box: [100, 170, 180, 192] },
  ]);

  assert.deepEqual(sortBoxesReadingOrder(boxes).map((item) => item.text), ['投保人', '张三', '被保险人', '李四']);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- tests/policy-layout-boxes.test.mjs
```

Expected: FAIL with module not found for `policy-layout-boxes.mjs`.

- [ ] **Step 3: Implement geometry helpers**

Create `ocr-service/policy-layout-boxes.mjs`:

```js
export function boxBounds(box) {
  if (!Array.isArray(box) || box.length < 4) return null;
  if (typeof box[0] === 'number') {
    const xMin = Math.min(Number(box[0]), Number(box[2]));
    const yMin = Math.min(Number(box[1]), Number(box[3]));
    const xMax = Math.max(Number(box[0]), Number(box[2]));
    const yMax = Math.max(Number(box[1]), Number(box[3]));
    if (![xMin, yMin, xMax, yMax].every(Number.isFinite)) return null;
    return { xMin, yMin, xMax, yMax };
  }
  const points = box.filter((point) => Array.isArray(point) && point.length >= 2);
  if (!points.length) return null;
  const xs = points.map((point) => Number(point[0])).filter(Number.isFinite);
  const ys = points.map((point) => Number(point[1])).filter(Number.isFinite);
  if (!xs.length || !ys.length) return null;
  return {
    xMin: Math.min(...xs),
    yMin: Math.min(...ys),
    xMax: Math.max(...xs),
    yMax: Math.max(...ys),
  };
}

export function boxCenter(box) {
  const bounds = boxBounds(box);
  if (!bounds) return null;
  return {
    x: (bounds.xMin + bounds.xMax) / 2,
    y: (bounds.yMin + bounds.yMax) / 2,
  };
}

export function normalizeOcrBoxes(boxes = []) {
  return (Array.isArray(boxes) ? boxes : [])
    .map((item, index) => {
      const text = String(item?.text || '').trim();
      const bounds = boxBounds(item?.box);
      if (!text || !bounds) return null;
      return {
        text,
        box: item.box,
        confidence: Number(item?.confidence || 0) || 0,
        index,
        ...bounds,
        xMid: (bounds.xMin + bounds.xMax) / 2,
        yMid: (bounds.yMin + bounds.yMax) / 2,
        width: bounds.xMax - bounds.xMin,
        height: bounds.yMax - bounds.yMin,
      };
    })
    .filter(Boolean);
}

export function clusterBoxesIntoRows(boxes = [], options = {}) {
  const yThreshold = Number(options.yThreshold || 14) || 14;
  const sorted = [...boxes]
    .filter((item) => Number.isFinite(item?.yMid))
    .sort((left, right) => left.yMid - right.yMid || left.xMin - right.xMin);
  const rows = [];
  for (const item of sorted) {
    const current = rows[rows.length - 1];
    if (!current || Math.abs(item.yMid - current.yMid) > yThreshold) {
      rows.push({ yMid: item.yMid, items: [item] });
      continue;
    }
    current.items.push(item);
    current.yMid = (current.yMid * (current.items.length - 1) + item.yMid) / current.items.length;
  }
  return rows.map((row) => ({
    ...row,
    items: row.items.sort((left, right) => left.xMin - right.xMin || left.index - right.index),
  }));
}

export function sortBoxesReadingOrder(boxes = [], options = {}) {
  return clusterBoxesIntoRows(boxes, options).flatMap((row) => row.items);
}

export function rowText(row) {
  return (row?.items || []).map((item) => item.text).join('');
}
```

- [ ] **Step 4: Run test and verify it passes**

Run:

```bash
npm test -- tests/policy-layout-boxes.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add ocr-service/policy-layout-boxes.mjs tests/policy-layout-boxes.test.mjs
git commit -m "feat: add OCR layout box helpers"
```

## Task 2: Layout Region Classification

**Files:**
- Create: `ocr-service/policy-layout-regions.mjs`
- Test: `tests/policy-layout-regions.test.mjs`

- [ ] **Step 1: Write failing tests for region splitting**

Create `tests/policy-layout-regions.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyPolicyLayoutRegions } from '../ocr-service/policy-layout-regions.mjs';

const box = (text, x1, y1, x2, y2) => ({ text, box: [x1, y1, x2, y2], confidence: 0.98 });

test('classifyPolicyLayoutRegions separates header, basic info, benefit table, rider table, and footer', () => {
  const result = classifyPolicyLayoutRegions([
    box('NCI 新华保险', 60, 30, 220, 55),
    box('保险单', 430, 65, 500, 90),
    box('保险合同号', 70, 120, 170, 145),
    box('990171228067', 240, 120, 390, 145),
    box('投保人', 70, 165, 140, 190),
    box('冯力', 240, 165, 290, 190),
    box('被保险人', 70, 205, 160, 230),
    box('冯力', 240, 205, 290, 230),
    box('合同生效日期', 70, 245, 190, 270),
    box('2024年09月30日', 240, 245, 420, 270),
    box('保险利益表', 70, 330, 180, 355),
    box('险种名称', 70, 370, 160, 395),
    box('基本保险金额', 260, 370, 390, 395),
    box('畅行万里智赢版两全保险', 70, 410, 250, 435),
    box('60000.00元', 260, 410, 380, 435),
    box('附加i他男性特定疾病保险', 70, 450, 260, 475),
    box('50000.00元', 260, 450, 380, 475),
    box('特别约定', 70, 540, 160, 565),
  ]);

  assert.deepEqual(result.regions.header.map((item) => item.text), ['NCI 新华保险', '保险单']);
  assert.ok(result.regions.basicInfo.some((item) => item.text === '投保人'));
  assert.ok(result.regions.benefitTable.some((item) => item.text === '畅行万里智赢版两全保险'));
  assert.ok(result.regions.riderTable.some((item) => item.text === '附加i他男性特定疾病保险'));
  assert.ok(result.regions.footer.some((item) => item.text === '特别约定'));
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- tests/policy-layout-regions.test.mjs
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement region classification**

Create `ocr-service/policy-layout-regions.mjs`:

```js
import { clusterBoxesIntoRows, normalizeOcrBoxes, rowText } from './policy-layout-boxes.mjs';

function compactText(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function isBenefitHeader(text) {
  return /保险利益表|险种名称|产品名称|基本保险金额|保险金额|保险期间|交费方式|缴费方式|交费期间|缴费期间|保险费/u.test(text);
}

function isFooter(text) {
  return /特别约定|保险单说明|保单制作日期|保险公司签章|业务员|第\d+页共\d+页/u.test(text);
}

function isRider(text) {
  return /附加|附加险|附加责任|附加医疗|附加意外/u.test(text);
}

function pushMany(target, row) {
  target.push(...(row?.items || []));
}

export function classifyPolicyLayoutRegions(rawBoxes = [], options = {}) {
  const boxes = normalizeOcrBoxes(rawBoxes);
  const rows = clusterBoxesIntoRows(boxes, { yThreshold: options.yThreshold || 14 });
  const regions = {
    header: [],
    basicInfo: [],
    benefitTable: [],
    riderTable: [],
    footer: [],
  };
  let mode = 'header';
  let seenBasicInfo = false;

  for (const row of rows) {
    const text = compactText(rowText(row));
    if (!text) continue;
    if (isFooter(text)) {
      mode = 'footer';
      pushMany(regions.footer, row);
      continue;
    }
    if (isBenefitHeader(text)) {
      mode = 'benefitTable';
      pushMany(regions.benefitTable, row);
      continue;
    }
    if (mode === 'benefitTable' && isRider(text)) {
      pushMany(regions.riderTable, row);
      continue;
    }
    if (/投保人|被保险人|保险合同号|保单号|合同号|合同生效日期|生效日期|证件号码|身份证|受益人/u.test(text)) {
      seenBasicInfo = true;
      if (mode !== 'benefitTable' && mode !== 'footer') mode = 'basicInfo';
    }
    if (mode === 'header' && seenBasicInfo) mode = 'basicInfo';
    pushMany(regions[mode] || regions.basicInfo, row);
  }

  return {
    boxes,
    rows,
    regions,
    regionWarnings: boxes.length ? [] : ['OCR 未返回可用于版面分析的坐标'],
  };
}
```

- [ ] **Step 4: Run test and verify it passes**

Run:

```bash
npm test -- tests/policy-layout-regions.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add ocr-service/policy-layout-regions.mjs tests/policy-layout-regions.test.mjs
git commit -m "feat: classify policy OCR layout regions"
```

## Task 3: Basic Info Layout Parser

**Files:**
- Create: `ocr-service/policy-basic-info-layout-parser.mjs`
- Test: `tests/policy-basic-info-layout-parser.test.mjs`

- [ ] **Step 1: Write failing tests for basic-info extraction and rider protection**

Create `tests/policy-basic-info-layout-parser.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePolicyBasicInfoFromLayoutBoxes } from '../ocr-service/policy-basic-info-layout-parser.mjs';

const box = (text, x1, y1, x2, y2) => ({ text, box: [x1, y1, x2, y2], confidence: 0.98 });

test('parsePolicyBasicInfoFromLayoutBoxes extracts right-side basic information fields', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('NCI 新华保险', 60, 30, 220, 55),
    box('保险合同号', 70, 120, 170, 145),
    box('990171228067', 240, 120, 390, 145),
    box('投保人', 70, 165, 140, 190),
    box('冯力', 240, 165, 290, 190),
    box('被保险人', 70, 205, 160, 230),
    box('温舒萍', 240, 205, 320, 230),
    box('证件号码', 70, 245, 160, 270),
    box('330106198712072413', 240, 245, 430, 270),
    box('合同生效日期', 70, 285, 190, 310),
    box('2024年09月30日', 240, 285, 420, 310),
    box('身故保险金受益人', 70, 325, 210, 350),
    box('法定继承人', 240, 325, 340, 350),
  ]);

  assert.equal(result.fields.company, '新华保险');
  assert.equal(result.fields.policyNumber, '990171228067');
  assert.equal(result.fields.applicant, '冯力');
  assert.equal(result.fields.insured, '温舒萍');
  assert.equal(result.fields.insuredIdNumber, '330106198712072413');
  assert.equal(result.fields.insuredBirthday, '1987-12-07');
  assert.equal(result.fields.date, '2024-09-30');
  assert.equal(result.fields.beneficiary, '法定');
  assert.equal(result.fieldConfidence.applicant, 'high');
});

test('parsePolicyBasicInfoFromLayoutBoxes refuses to source core fields from rider table', () => {
  const result = parsePolicyBasicInfoFromLayoutBoxes([
    box('投保人', 70, 120, 140, 145),
    box('张三', 240, 120, 290, 145),
    box('被保险人', 70, 160, 160, 185),
    box('李四', 240, 160, 290, 185),
    box('保险利益表', 70, 260, 180, 285),
    box('险种名称', 70, 300, 160, 325),
    box('保险期间', 260, 300, 350, 325),
    box('附加住院医疗保险', 70, 340, 220, 365),
    box('至2026年12月23日', 260, 340, 430, 365),
    box('附加投保人豁免保险', 70, 380, 240, 405),
  ]);

  assert.equal(result.fields.applicant, '张三');
  assert.equal(result.fields.insured, '李四');
  assert.equal(result.fields.date, '');
  assert.ok(result.ocrWarnings.some((warning) => warning.includes('附加险')));
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- tests/policy-basic-info-layout-parser.test.mjs
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement the parser**

Create `ocr-service/policy-basic-info-layout-parser.mjs`:

```js
import { classifyPolicyLayoutRegions } from './policy-layout-regions.mjs';
import { clusterBoxesIntoRows, rowText } from './policy-layout-boxes.mjs';

function compactText(value) {
  return String(value || '').replace(/\s+/gu, '');
}

function normalizeIdNumber(value) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[^\dXx]/g, '')
    .toUpperCase();
  const matched18 = text.match(/\d{17}[\dX]/);
  if (matched18) return matched18[0];
  const matched15 = text.match(/\d{15}/);
  return matched15?.[0] || '';
}

function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    date.getUTCFullYear() === Number(year) &&
    date.getUTCMonth() + 1 === Number(month) &&
    date.getUTCDate() === Number(day)
  );
}

function normalizeDateOnly(value) {
  const matched = String(value || '').match(/(19\d{2}|20\d{2})[年./-]?(\d{1,2})[月./-]?(\d{1,2})/u);
  if (!matched) return '';
  const year = matched[1];
  const month = matched[2].padStart(2, '0');
  const day = matched[3].padStart(2, '0');
  return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
}

function birthdayFromIdNumber(value) {
  const idNumber = normalizeIdNumber(value);
  if (idNumber.length === 18) {
    const year = idNumber.slice(6, 10);
    const month = idNumber.slice(10, 12);
    const day = idNumber.slice(12, 14);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  if (idNumber.length === 15) {
    const shortYear = Number(idNumber.slice(6, 8));
    const year = String(shortYear >= 30 ? 1900 + shortYear : 2000 + shortYear);
    const month = idNumber.slice(8, 10);
    const day = idNumber.slice(10, 12);
    return isValidDateParts(year, month, day) ? `${year}-${month}-${day}` : '';
  }
  return '';
}

function normalizeCompany(value) {
  const text = compactText(value);
  if (/新华/.test(text)) return '新华保险';
  if (/平安|PING\s*AN|PINGAN/iu.test(text)) return '中国平安保险';
  if (/中国人寿|国寿/u.test(text)) return '中国人寿保险';
  return '';
}

function normalizePerson(value) {
  const matched = compactText(value).match(/^[一-龥·]{2,8}/u);
  return matched?.[0] || '';
}

function normalizePolicyNumber(value) {
  const text = compactText(value).replace(/[^\dA-Za-z]/gu, '');
  if (!text || normalizeIdNumber(text) === text) return '';
  return text.length >= 6 ? text : '';
}

function normalizeBeneficiary(value) {
  const text = compactText(value);
  if (/法定/.test(text)) return '法定';
  return normalizePerson(text);
}

const FIELD_LABELS = [
  { field: 'policyNumber', pattern: /保险合同号|保单号|合同号/u, normalize: normalizePolicyNumber },
  { field: 'applicant', pattern: /投保人(?!豁免)/u, normalize: normalizePerson },
  { field: 'insured', pattern: /被保险人|被保人|受保人/u, normalize: normalizePerson },
  { field: 'insuredIdNumber', pattern: /证件号码|证件号|身份证号码|身份证号/u, normalize: normalizeIdNumber },
  { field: 'date', pattern: /合同生效日期|生效日期|保险起期/u, normalize: normalizeDateOnly },
  { field: 'beneficiary', pattern: /身故保险金受益人|身故受益人|受益人/u, normalize: normalizeBeneficiary },
  { field: 'name', pattern: /产品名称|险种名称|保险名称|合同名称|主险名称/u, normalize: compactText },
];

function confidenceFor(label, value) {
  if (!label || !value) return 'missing';
  return 'high';
}

function candidateRightOf(label, row) {
  const candidates = row.items
    .filter((item) => item.xMin > label.xMax && item.text !== label.text)
    .sort((left, right) => left.xMin - right.xMin);
  return candidates[0] || null;
}

function parseRowsFromAllowedRegions(regions) {
  const allowed = [...regions.header, ...regions.basicInfo];
  return clusterBoxesIntoRows(allowed, { yThreshold: 14 });
}

export function parsePolicyBasicInfoFromLayoutBoxes(rawBoxes = []) {
  const layout = classifyPolicyLayoutRegions(rawBoxes);
  const rows = parseRowsFromAllowedRegions(layout.regions);
  const fields = {
    company: '',
    name: '',
    applicant: '',
    insured: '',
    policyNumber: '',
    date: '',
    beneficiary: '',
    insuredIdNumber: '',
    insuredBirthday: '',
  };
  const fieldConfidence = {};
  const evidence = {};
  const ocrWarnings = [...layout.regionWarnings];

  for (const item of layout.regions.header) {
    fields.company ||= normalizeCompany(item.text);
  }

  for (const row of rows) {
    const text = rowText(row);
    for (const labelDef of FIELD_LABELS) {
      const label = row.items.find((item) => labelDef.pattern.test(compactText(item.text)));
      if (!label || fields[labelDef.field]) continue;
      const inline = compactText(text).replace(labelDef.pattern, '');
      const right = candidateRightOf(label, row);
      const rawValue = right?.text || inline;
      const value = labelDef.normalize(rawValue);
      if (!value) continue;
      fields[labelDef.field] = value;
      fieldConfidence[labelDef.field] = confidenceFor(label, right || label);
      evidence[labelDef.field] = {
        value,
        source: 'basic-info-layout',
        confidence: Number(right?.confidence || label.confidence || 0) || 0,
        labelBox: label.box,
        valueBox: right?.box || label.box,
        region: 'basic-info',
      };
    }
  }

  if (fields.insuredIdNumber && !fields.insuredBirthday) {
    fields.insuredBirthday = birthdayFromIdNumber(fields.insuredIdNumber);
    if (fields.insuredBirthday) fieldConfidence.insuredBirthday = 'high';
  }

  if (layout.regions.riderTable.length) {
    ocrWarnings.push('检测到附加险区域，基础字段已限制为从基本信息区读取');
  }

  return {
    fields,
    evidence,
    fieldConfidence,
    ocrWarnings,
  };
}
```

- [ ] **Step 4: Run test and verify it passes**

Run:

```bash
npm test -- tests/policy-basic-info-layout-parser.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add ocr-service/policy-basic-info-layout-parser.mjs tests/policy-basic-info-layout-parser.test.mjs
git commit -m "feat: parse policy basic info from OCR layout"
```

## Task 4: Merge Layout Fields With Existing Text Fields

**Files:**
- Create: `ocr-service/policy-layout-merge.mjs`
- Test: `tests/policy-layout-merge.test.mjs`

- [ ] **Step 1: Write failing tests for merge priority and warnings**

Create `tests/policy-layout-merge.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { mergePolicyLayoutScanResult } from '../ocr-service/policy-layout-merge.mjs';

test('mergePolicyLayoutScanResult lets high-confidence layout core fields override rider-contaminated text fields', () => {
  const merged = mergePolicyLayoutScanResult({
    textData: {
      company: '新华保险',
      name: '附加住院医疗保险',
      applicant: '附加投保人豁免保险',
      insured: '李四',
      date: '2026-12-23',
    },
    layoutResult: {
      fields: {
        company: '新华保险',
        name: '主险终身寿险',
        applicant: '张三',
        insured: '李四',
        policyNumber: '990123456789',
        date: '2025-12-23',
      },
      fieldConfidence: {
        applicant: 'high',
        insured: 'high',
        policyNumber: 'high',
        date: 'high',
        name: 'review',
      },
      ocrWarnings: ['检测到附加险区域，基础字段已限制为从基本信息区读取'],
    },
  });

  assert.equal(merged.data.applicant, '张三');
  assert.equal(merged.data.policyNumber, '990123456789');
  assert.equal(merged.data.date, '2025-12-23');
  assert.equal(merged.data.name, '附加住院医疗保险');
  assert.equal(merged.fieldConfidence.applicant, 'high');
  assert.ok(merged.ocrWarnings.some((warning) => warning.includes('附加险')));
});

test('mergePolicyLayoutScanResult preserves text fields when layout is missing', () => {
  const merged = mergePolicyLayoutScanResult({
    textData: { applicant: '张三', insured: '李四', name: '旧流程产品' },
    layoutResult: null,
  });

  assert.equal(merged.data.applicant, '张三');
  assert.equal(merged.data.name, '旧流程产品');
  assert.deepEqual(merged.ocrWarnings, []);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npm test -- tests/policy-layout-merge.test.mjs
```

Expected: FAIL with module not found.

- [ ] **Step 3: Implement merge helper**

Create `ocr-service/policy-layout-merge.mjs`:

```js
const CORE_LAYOUT_FIELDS = ['company', 'applicant', 'insured', 'policyNumber', 'date', 'beneficiary', 'insuredIdNumber', 'insuredBirthday'];
const REVIEW_ONLY_FIELDS = ['name'];

function trim(value) {
  return String(value || '').trim();
}

function uniqueWarnings(items = []) {
  return [...new Set(items.map(trim).filter(Boolean))];
}

export function mergePolicyLayoutScanResult({ textData = {}, layoutResult = null } = {}) {
  if (!layoutResult?.fields) {
    return {
      data: { ...textData },
      fieldConfidence: {},
      ocrWarnings: [],
    };
  }

  const data = { ...textData };
  const fieldConfidence = { ...(layoutResult.fieldConfidence || {}) };
  const warnings = [...(layoutResult.ocrWarnings || [])];

  for (const field of CORE_LAYOUT_FIELDS) {
    const value = trim(layoutResult.fields[field]);
    if (!value) continue;
    const confidence = String(layoutResult.fieldConfidence?.[field] || '');
    if (confidence === 'high' || !trim(data[field])) {
      data[field] = value;
    } else if (trim(data[field]) !== value) {
      warnings.push(`${field} 坐标识别结果与文本识别结果不一致，请确认`);
    }
  }

  for (const field of REVIEW_ONLY_FIELDS) {
    const value = trim(layoutResult.fields[field]);
    if (!value) continue;
    if (!trim(data[field])) {
      data[field] = value;
    } else if (trim(data[field]) !== value) {
      fieldConfidence[field] = 'review';
      warnings.push('产品名称存在多个候选，请确认是否为主险名称');
    }
  }

  return {
    data,
    fieldConfidence,
    ocrWarnings: uniqueWarnings(warnings),
  };
}
```

- [ ] **Step 4: Run test and verify it passes**

Run:

```bash
npm test -- tests/policy-layout-merge.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 4**

```bash
git add ocr-service/policy-layout-merge.mjs tests/policy-layout-merge.test.mjs
git commit -m "feat: merge policy layout OCR fields"
```

## Task 5: Preserve PaddleOCR Boxes In The Policy Scan Flow

**Files:**
- Modify: `ocr-service/insurance-ocr.service.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add a regression test that injects Paddle OCR output with boxes**

Add this test near the policy OCR scan tests in `tests/policy-ocr-flow.test.mjs`:

```js
test('policy recognize response preserves OCR review warnings from scanner', async () => {
  const calls = [];
  const scanner = async () => ({
    ok: true,
    ocrText: [
      '投保人 张三',
      '被保险人 李四',
      '保险利益表',
      '附加投保人豁免保险 至2026年12月23日',
    ].join('\n'),
    data: {
      company: '新华保险',
      name: '附加投保人豁免保险',
      applicant: '附加投保人豁免保险',
      insured: '李四',
      date: '2026-12-23',
    },
    fieldConfidence: {
      applicant: 'high',
      insured: 'high',
      date: 'high',
    },
    ocrWarnings: ['检测到附加险区域，基础字段已限制为从基本信息区读取'],
  });

  const app = createTestApp({
    scanner: async (input) => {
      calls.push(input);
      return scanner(input);
    },
  });

  const recognized = await requestJson(app, '/api/policies/recognize', {
    method: 'POST',
    body: {
      guestId: 'guest_layout',
      ocrText: '投保人 张三\n被保险人 李四',
      uploadItem: null,
      manualData: {},
    },
  });

  assert.equal(recognized.status, 200);
  assert.equal(recognized.payload.scan.data.applicant, '附加投保人豁免保险');
  assert.ok(recognized.payload.scan.ocrWarnings.some((warning) => warning.includes('附加险')));
  assert.equal(calls.length, 1);
});
```

This test verifies app-level propagation of warning metadata. The OCR-service box parsing itself is covered by Tasks 1-4.

- [ ] **Step 2: Run the app flow test and record current behavior**

Run:

```bash
npm test -- tests/policy-ocr-flow.test.mjs
```

Expected before contract changes: FAIL if `ocrWarnings` is lost during scan mapping; PASS if the current spread behavior already preserves unknown scan metadata. Keep the test either way because it protects the contract.

- [ ] **Step 3: Refactor Paddle recognition to return payload while preserving text-only callers**

In `ocr-service/insurance-ocr.service.mjs`, add:

```js
async function recognizePaddlePolicyUpload(uploadItem) {
  const provider = getConfiguredOcrProvider();
  await warmupPaddleLocalIfNeeded();
  assertOcrScriptExists(OCR_PADDLE_SCRIPT);
  const { mimeType, buffer } = parseDataUrl(uploadItem);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'policy-ocr-paddle-'));
  const absPath = path.join(tmpDir, `scan${inferFileExtension(uploadItem?.name, mimeType)}`);
  try {
    await writeFile(absPath, buffer);
    const env = { ...process.env };
    const projectDir = String(env.POLICY_OCR_PADDLE_PROJECT_DIR || '').trim();
    const pythonCmd = getConfiguredPaddlePython();
    env.POLICY_OCR_PADDLE_PIPELINE = getConfiguredPaddlePipeline(provider);
    const { stdout } = await execFileAsync(pythonCmd, [OCR_PADDLE_SCRIPT, absPath], {
      env,
      cwd: projectDir || undefined,
      timeout: 60000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const payload = JSON.parse(stdout);
    const recognized = extractPaddleOcrText(payload);
    if (!recognized) throw new Error('POLICY_OCR_EMPTY');
    return {
      ocrText: recognized,
      boxes: Array.isArray(payload?.boxes) ? payload.boxes : [],
      rawPayload: payload,
    };
  } catch (err) {
    const message = String(err?.stderr || err?.message || err || '');
    if (message.includes('POLICY_OCR_EMPTY')) throw new Error('POLICY_OCR_EMPTY');
    if (message.includes('POLICY_OCR_PADDLE_IMPORT_FAILED') || message.includes('POLICY_OCR_PROVIDER_NOT_READY')) {
      throw new Error('POLICY_OCR_PROVIDER_NOT_READY');
    }
    throw new Error('POLICY_OCR_FAILED');
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
```

Then change `recognizeTextWithPaddleLocal(uploadItem)` to:

```js
async function recognizeTextWithPaddleLocal(uploadItem) {
  const result = await recognizePaddlePolicyUpload(uploadItem);
  return result.ocrText;
}
```

- [ ] **Step 4: Add layout parsing to Paddle path in `scanInsurancePolicyLocal()`**

At the imports near the top of `ocr-service/insurance-ocr.service.mjs`, add:

```js
import { parsePolicyBasicInfoFromLayoutBoxes } from './policy-basic-info-layout-parser.mjs';
import { mergePolicyLayoutScanResult } from './policy-layout-merge.mjs';
```

In the Paddle branch of `scanInsurancePolicyLocal()`, replace:

```js
const paddleText = await recognizeTextWithPaddleLocal(uploadItem);
candidates.push(paddleText);
```

with:

```js
const paddleResult = await recognizePaddlePolicyUpload(uploadItem);
candidates.push(paddleResult.ocrText);
const best = selectBestPolicyScanCandidate(candidates);
const layoutResult = paddleResult.boxes?.length
  ? parsePolicyBasicInfoFromLayoutBoxes(paddleResult.boxes)
  : null;
const merged = mergePolicyLayoutScanResult({
  textData: best.data,
  layoutResult,
});
data = merged.data;
data.fieldConfidence = merged.fieldConfidence;
data.ocrWarnings = merged.ocrWarnings;
bestOcrText = best.ocrText;
```

Use a local boolean so the shared selection block does not run twice:

```js
let handledPaddleLayout = false;

if (provider === OCR_PROVIDER_PADDLE_LOCAL || provider === OCR_PROVIDER_PADDLEOCR_VL_LOCAL) {
  const paddleResult = await recognizePaddlePolicyUpload(uploadItem);
  candidates.push(paddleResult.ocrText);
  const best = selectBestPolicyScanCandidate(candidates);
  const layoutResult = paddleResult.boxes?.length
    ? parsePolicyBasicInfoFromLayoutBoxes(paddleResult.boxes)
    : null;
  const merged = mergePolicyLayoutScanResult({
    textData: best.data,
    layoutResult,
  });
  data = merged.data;
  data.fieldConfidence = merged.fieldConfidence;
  data.ocrWarnings = merged.ocrWarnings;
  bestOcrText = best.ocrText;
  handledPaddleLayout = true;
} else if (provider === OCR_PROVIDER_PDF_EXTRACT_KIT_LOCAL) {
  const pdfExtractKitText = await recognizeTextWithPdfExtractKit(uploadItem);
  candidates.push(pdfExtractKitText);
} else {
  candidates.push(await recognizeTextWithImageFallback(uploadItem));
}

if (!handledPaddleLayout) {
  const best = selectBestPolicyScanCandidate(candidates);
  data = best.data;
  bestOcrText = best.ocrText;
}
```

Keep non-Paddle branches otherwise unchanged.

- [ ] **Step 5: Ensure final scan payload exposes metadata outside `data`**

Before returning from `scanInsurancePolicyLocal()`, compute:

```js
const fieldConfidence = data.fieldConfidence || {};
const ocrWarnings = data.ocrWarnings || [];
delete data.fieldConfidence;
delete data.ocrWarnings;
```

Then return:

```js
return {
  ok: true,
  data,
  ocrText: bestOcrText,
  ...(Object.keys(fieldConfidence).length ? { fieldConfidence } : {}),
  ...(ocrWarnings.length ? { ocrWarnings } : {}),
};
```

- [ ] **Step 6: Run focused OCR tests**

Run:

```bash
npm test -- tests/policy-basic-info-layout-parser.test.mjs tests/policy-layout-merge.test.mjs tests/policy-ocr-flow.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5**

```bash
git add ocr-service/insurance-ocr.service.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: apply layout OCR to policy scans"
```

## Task 6: API Contract And Frontend Warning Display

**Files:**
- Modify: `src/api/contracts/policy.ts`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Modify: `src/features/policy-entry/UploadPolicyPage.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Update TypeScript contract**

Modify `PolicyScanResult` in `src/api/contracts/policy.ts`:

```ts
export type PolicyScanResult = {
  ocrText: string;
  data: PolicyScanData;
  fieldConfidence?: Record<string, 'high' | 'review' | 'missing' | string>;
  ocrWarnings?: string[];
};
```

- [ ] **Step 2: Pass warning message through customer app state**

In `src/apps/customer/CustomerApp.tsx`, after `setScanResult(payload.scan);` in the recognize success path, add:

```ts
const scanWarnings = Array.isArray(payload.scan.ocrWarnings) ? payload.scan.ocrWarnings : [];
```

Then update the success messages:

```ts
const warningSuffix = scanWarnings.length ? `，${scanWarnings.length} 项字段建议确认` : '';
```

Use it in the existing `setMessage()` calls:

```ts
setMessage(recognizedAnalysis?.optionalResponsibilities?.length
  ? `OCR 已完成，已匹配本地保险责任，请确认可选责任后保存${warningSuffix}`
  : `OCR 已完成，已匹配本地保险责任，请确认后保存${warningSuffix}`);
```

and:

```ts
setMessage(`OCR 已完成，可生成保险责任或直接保存${warningSuffix}`);
```

- [ ] **Step 3: Render warnings in upload page**

In `src/features/policy-entry/UploadPolicyPage.tsx`, add a prop to the component type if it is not already present:

```ts
scanResult?: PolicyScanResult | null;
```

Near the existing message block, add:

```tsx
{scanResult?.ocrWarnings?.length ? (
  <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs font-semibold leading-5 text-amber-800">
    <p>部分 OCR 字段建议确认</p>
    <ul className="mt-1 list-disc space-y-1 pl-4">
      {scanResult.ocrWarnings.slice(0, 3).map((warning) => (
        <li key={warning}>{warning}</li>
      ))}
    </ul>
  </div>
) : null}
```

If `UploadPolicyPage` already receives `scanResult`, only add the rendering block.

- [ ] **Step 4: Add a source-style regression test**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('upload policy page renders OCR warning review text', () => {
  const source = componentSource('UploadPolicyPage');
  assert.match(source, /部分 OCR 字段建议确认/u);
  assert.match(source, /ocrWarnings/u);
});
```

- [ ] **Step 5: Run frontend checks**

Run:

```bash
npm run typecheck
npm test -- tests/customer-ui-style.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

```bash
git add src/api/contracts/policy.ts src/apps/customer/CustomerApp.tsx src/features/policy-entry/UploadPolicyPage.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: show OCR field review warnings"
```

## Task 7: Final Verification

**Files:**
- Verify all changed OCR, API, frontend, and tests.

- [ ] **Step 1: Run OCR and backend checks**

Run:

```bash
npm run check
npm test
```

Expected: PASS.

- [ ] **Step 2: Run frontend type and build checks**

Run:

```bash
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 3: Inspect git diff for scope**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only files from this plan are changed since the first implementation commit, plus any pre-existing unrelated dirty files still untouched.

- [ ] **Step 4: Final commit if verification fixes were needed**

If Task 7 required fixes in files covered by this plan, commit them:

```bash
git add ocr-service/policy-layout-boxes.mjs \
  ocr-service/policy-layout-regions.mjs \
  ocr-service/policy-basic-info-layout-parser.mjs \
  ocr-service/policy-layout-merge.mjs \
  ocr-service/insurance-ocr.service.mjs \
  src/api/contracts/policy.ts \
  src/apps/customer/CustomerApp.tsx \
  src/features/policy-entry/UploadPolicyPage.tsx \
  tests/policy-layout-boxes.test.mjs \
  tests/policy-layout-regions.test.mjs \
  tests/policy-basic-info-layout-parser.test.mjs \
  tests/policy-layout-merge.test.mjs \
  tests/policy-ocr-flow.test.mjs \
  tests/customer-ui-style.test.mjs
git commit -m "fix: stabilize policy layout OCR verification"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

- Spec coverage: The plan covers coordinate parsing, region separation, rider-table protection, fallback behavior, warnings, tests, and frontend display.
- Scope: The plan does not implement 4080 Windows, PaddleOCR-VL as a main chain, complex perspective correction, or full benefit-table plan parsing.
- Type consistency: Scan warnings use `ocrWarnings`; field confidence uses `fieldConfidence`; both live on `PolicyScanResult`, not inside `data`, after OCR-service return cleanup.
- Verification: OCR changes run `npm run check` and `npm test`; frontend contract/display changes also run `npm run typecheck` and `npm run build`.
