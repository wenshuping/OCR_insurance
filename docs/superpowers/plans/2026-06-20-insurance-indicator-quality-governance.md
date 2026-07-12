# Insurance Indicator Quality Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full-insurance indicator quality governance runner that audits all lanes and only writes high-confidence annuity/two-pay/retirement cashflow candidates in phase one.

**Architecture:** Add a focused governance CLI that reuses the existing official-knowledge indicator extraction helpers, classifies proposed indicators into lanes, compares them with existing DB indicators, and applies a strict write gate. The first implementation writes only `cashflow_annuity` candidates and keeps medical, critical illness, accident, death/life, and waiver lanes report-only.

**Tech Stack:** Node.js ESM, `node:sqlite` `DatabaseSync`, Node test runner, existing SQLite schema in `.runtime/local/policy-ocr.sqlite`.

---

## File Structure

- Modify: `scripts/backfill-knowledge-responsibility-indicators.mjs`
  - Export existing helper functions so the governance runner can reuse the current extraction logic instead of duplicating large regex blocks.
  - No behavior change to the existing CLI or `backfillKnowledgeResponsibilityIndicators(...)`.

- Create: `scripts/insurance-indicator-quality-governance.mjs`
  - New CLI and reusable function `auditInsuranceIndicatorQuality(...)`.
  - Responsibilities: read knowledge/products, generate proposed indicators, classify lanes, compare existing indicators, enforce write gate, optionally upsert only allowed annuity cashflow candidates.

- Create: `tests/insurance-indicator-quality-governance.test.mjs`
  - Focused tests for lane classification, annuity write gate, report-only lanes, and write behavior.

- Leave unchanged in phase one:
  - `server/cashflow-compute.mjs`
  - `server/policy-ocr.domain.mjs`
  - frontend files
  - production runtime data

## Success Criteria

- Dry-run reports issues and candidates for all lanes.
- `--write-annuity-cashflow` writes only high-confidence `cashflow_annuity` candidates.
- `尊享人生年金保险（分红型）` produces:
  - `关爱年金 = 首次交纳的基本责任的保险费 × 1%`
  - `生存保险金 = 基本责任保险金额 × 9%`
- Disease care benefits, medical formula issues, accident/death/waiver candidates remain report-only in phase one.
- Focused tests pass.
- `npm run check` passes.

---

### Task 1: Export Existing Extraction Helpers

**Files:**
- Modify: `scripts/backfill-knowledge-responsibility-indicators.mjs`
- Test: `tests/backfill-knowledge-responsibility-indicators.test.mjs`

- [ ] **Step 1: Add named exports to existing helper functions**

In `scripts/backfill-knowledge-responsibility-indicators.mjs`, add `export` to the existing declarations below. Do not move functions and do not change their bodies.

Apply these exact declaration edits:

```diff
-function normalizeSpaces(value) {
+export function normalizeSpaces(value) {
```

```diff
-function normalizeLookupText(value) {
+export function normalizeLookupText(value) {
```

```diff
-function sourceText(payload = {}) {
+export function sourceText(payload = {}) {
```

```diff
-function splitBenefitSections(text) {
+export function splitBenefitSections(text) {
```

```diff
-function coverageTypeFor(liability, text) {
+export function coverageTypeFor(liability, text) {
```

```diff
-function formulaFor(liability, sectionText) {
+export function formulaFor(liability, sectionText) {
```

```diff
-function conditionFromText(text) {
+export function conditionFromText(text) {
```

```diff
-function buildIndicatorsForProduct(product, now) {
+export function buildIndicatorsForProduct(product, now) {
```

```diff
-function upsertIndicators(db, indicators) {
+export function upsertIndicators(db, indicators) {
```

```diff
-function affectedDerivedRows(db, productKeys) {
+export function affectedDerivedRows(db, productKeys) {
```

```diff
-function markAffectedDerivedRowsStale(db, productKeys, now) {
+export function markAffectedDerivedRowsStale(db, productKeys, now) {
```

```diff
-function recordIndicatorRefreshBatch(db, { productKeys, affectedPolicyCount, now }) {
+export function recordIndicatorRefreshBatch(db, { productKeys, affectedPolicyCount, now }) {
```

- [ ] **Step 2: Run existing focused test**

Run:

```bash
node --test tests/backfill-knowledge-responsibility-indicators.test.mjs
```

Expected: PASS. This proves the export-only refactor did not change behavior.

- [ ] **Step 3: Run syntax check for touched script**

Run:

```bash
node --check scripts/backfill-knowledge-responsibility-indicators.mjs
```

Expected: no output and exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-knowledge-responsibility-indicators.mjs tests/backfill-knowledge-responsibility-indicators.test.mjs
git commit -m "refactor: export indicator extraction helpers"
```

If `tests/backfill-knowledge-responsibility-indicators.test.mjs` was not modified, do not include it in `git add`.

---

### Task 2: Write Governance Tests First

**Files:**
- Create: `tests/insurance-indicator-quality-governance.test.mjs`
- Test: `tests/insurance-indicator-quality-governance.test.mjs`

- [ ] **Step 1: Create the failing test file**

Create `tests/insurance-indicator-quality-governance.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { auditInsuranceIndicatorQuality } from '../scripts/insurance-indicator-quality-governance.mjs';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'indicator-governance-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE knowledge_records (
      id INTEGER PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      url TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE insurance_indicator_records (
      id TEXT PRIMARY KEY,
      company TEXT,
      product_name TEXT,
      coverage_type TEXT,
      liability TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE policy_derived_results (
      policy_id INTEGER PRIMARY KEY,
      product_keys TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ready',
      stale_reason TEXT,
      generated_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE product_indicator_versions (
      product_key TEXT PRIMARY KEY,
      version INTEGER NOT NULL DEFAULT 0,
      batch_id TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE TABLE indicator_update_batches (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      product_keys TEXT NOT NULL DEFAULT '[]',
      changed_product_key_count INTEGER NOT NULL DEFAULT 0,
      affected_policy_count INTEGER NOT NULL DEFAULT 0,
      payload TEXT NOT NULL
    );
  `);
  db.close();
  return { dir, dbPath };
}

function insertKnowledge(db, row) {
  db.prepare(`
    INSERT INTO knowledge_records (id, company, product_name, url, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.url || 'https://example.test/terms.pdf', JSON.stringify({
    id: row.id,
    company: row.company,
    productName: row.productName,
    productType: row.productType || '年金险',
    salesStatus: row.salesStatus || '停售',
    title: `${row.productName}条款`,
    url: row.url || 'https://example.test/terms.pdf',
    pageText: row.pageText,
  }));
}

function insertIndicator(db, row) {
  const payload = {
    id: row.id,
    company: row.company,
    productName: row.productName,
    coverageType: row.coverageType,
    liability: row.liability,
    value: row.value ?? null,
    valueText: row.valueText || '',
    unit: row.unit || '',
    basis: row.basis || '',
    formulaText: row.formulaText || '',
    condition: row.condition || '',
    sourceRecordId: String(row.sourceRecordId || ''),
    sourceExcerpt: row.sourceExcerpt || '',
  };
  db.prepare(`
    INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(row.id, row.company, row.productName, row.coverageType, row.liability, JSON.stringify(payload));
}

test('audits annuity cashflow candidates while keeping disease and medical lanes report-only', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 1359,
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      pageText: [
        '保险责任 关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
        '生存保险金被保险人于本合同生效后至60周岁保单生效对应日之前每满两周年的保单生效对应日生存，本公司按该保单生效对应日基本责任的保险金额的9%给付生存保险金。',
        '身故或身体全残保险金被保险人身故或身体全残，本公司给付身故或身体全残保险金。',
        '投保人意外身故或全残豁免保险费。'
      ].join(' '),
    });
    insertIndicator(db, {
      id: 'generic_cashflow',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '教育/养老金/两全等返还',
      value: 1,
      valueText: '1',
      unit: '%',
      basis: '条款载明',
      sourceRecordId: '1359',
      sourceExcerpt: '关爱年金按首次交纳的基本责任的保险费的1%给付',
    });
    insertKnowledge(db, {
      id: 2000,
      company: '测试人寿',
      productName: '测试恶性肿瘤疾病保险',
      productType: '疾病保险',
      pageText: '保险责任 恶性肿瘤-重度二次确诊关爱金被保险人再次确诊恶性肿瘤-重度，我们按基本保险金额的30%给付恶性肿瘤-重度二次确诊关爱金。',
    });
    insertKnowledge(db, {
      id: 2001,
      company: '测试人寿',
      productName: '测试意外医疗保险',
      productType: '医疗保险',
      pageText: '保险责任 意外伤害医疗保险金=（该次治疗的医疗费用－其他途径获得的补偿－100元免赔额）×80%。',
    });

    const result = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [1359, 2000, 2001],
      includeExistingProducts: true,
      sampleLimit: 20,
    });

    const writeAllowed = result.candidates.filter((candidate) => candidate.writeAllowed);
    assert.equal(writeAllowed.length, 2);
    assert.ok(writeAllowed.some((candidate) => candidate.proposedIndicator.liability === '关爱年金'));
    assert.ok(writeAllowed.some((candidate) => candidate.proposedIndicator.formulaText === '生存保险金 = 基本责任保险金额 × 9%'));
    assert.ok(result.candidates.some((candidate) => candidate.lane === 'critical_illness' && candidate.writeAllowed === false));
    assert.ok(result.issues.some((issue) => issue.lane === 'medical_formula'));
    assert.equal(result.summary.writeAllowedCandidates, 2);
    assert.equal(result.summary.byLane.cashflow_annuity.writeAllowedCandidates, 2);
    assert.equal(result.summary.byLane.critical_illness.writeAllowedCandidates, 0);
    assert.equal(result.summary.byLane.medical_formula.writeAllowedCandidates, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write mode upserts only allowed annuity cashflow candidates', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 1359,
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      pageText: [
        '保险责任 关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
        '生存保险金被保险人于本合同生效后至60周岁保单生效对应日之前每满两周年的保单生效对应日生存，本公司按该保单生效对应日基本责任的保险金额的9%给付生存保险金。'
      ].join(' '),
    });
    insertKnowledge(db, {
      id: 2000,
      company: '测试人寿',
      productName: '测试恶性肿瘤疾病保险',
      productType: '疾病保险',
      pageText: '保险责任 恶性肿瘤-重度二次确诊关爱金被保险人再次确诊恶性肿瘤-重度，我们按基本保险金额的30%给付恶性肿瘤-重度二次确诊关爱金。',
    });

    const dryRun = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [1359, 2000],
      includeExistingProducts: true,
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM insurance_indicator_records').get().count, 0);

    const written = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [1359, 2000],
      includeExistingProducts: true,
      writeAnnuityCashflow: true,
    });

    assert.equal(written.dryRun, false);
    assert.equal(written.indicatorUpserts, 2);
    const rows = db.prepare('SELECT coverage_type, liability, payload FROM insurance_indicator_records ORDER BY liability').all();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.liability), ['关爱年金', '生存保险金']);
    assert.ok(rows.every((row) => row.coverage_type === '现金流'));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the new test to verify it fails**

Run:

```bash
node --test tests/insurance-indicator-quality-governance.test.mjs
```

Expected: FAIL with a module-not-found or missing export error for `../scripts/insurance-indicator-quality-governance.mjs`.

---

### Task 3: Implement Governance Runner

**Files:**
- Create: `scripts/insurance-indicator-quality-governance.mjs`
- Test: `tests/insurance-indicator-quality-governance.test.mjs`

- [ ] **Step 1: Create governance module with imports and constants**

Create `scripts/insurance-indicator-quality-governance.mjs`:

```js
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { deriveIndicatorProductKeys } from '../server/policy-derived-results.service.mjs';
import {
  affectedDerivedRows,
  buildIndicatorsForProduct,
  markAffectedDerivedRowsStale,
  normalizeLookupText,
  normalizeSpaces,
  recordIndicatorRefreshBatch,
  sourceText,
  splitBenefitSections,
  upsertIndicators,
} from './backfill-knowledge-responsibility-indicators.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const DEFAULT_DB_PATH = path.join(projectRoot, '.runtime', 'local', 'policy-ocr.sqlite');
const VERSION = '2026-06-20-indicator-quality-governance';

const LANES = [
  'cashflow_annuity',
  'medical_formula',
  'critical_illness',
  'accident',
  'death_life',
  'waiver',
];

function trim(value) {
  return String(value ?? '').trim();
}

function parsePayload(value, fallback = {}) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function parseIdList(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function sha1(value, length = 18) {
  return crypto.createHash('sha1').update(value).digest('hex').slice(0, length);
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = trim(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}
```

- [ ] **Step 2: Add lane classification helpers**

Append:

```js
function compactText(value) {
  return normalizeSpaces(value).replace(/\s+/gu, '');
}

function isAnnuityLiability(liability) {
  return /年金|养老保险金|生存保险金|特别生存保险金|生存金|满期保险金|满期生存保险金|期满保险金|满期金|满期返还|祝寿金|祝寿保险金|贺寿金|贺岁金|长寿金|关爱年金|教育金|少儿教育金|高中教育金|大学教育金|深造金|婚嫁金|立业金|创业金|返还保险费|返还已交保险费|生存返还|保证领取保险金|保证领取年金|保证给付年金/u.test(normalizeSpaces(liability));
}

function hasAnnuityTrigger(text) {
  const compact = compactText(text);
  return /被保险人[^。；]{0,80}生存|犹豫期结束[^。；]{0,40}生存|保单(?:周年日|生效对应日)[^。；]{0,80}生存|年满[^。；]{0,40}周岁[^。；]{0,80}生存|保险期间届满[^。；]{0,80}生存|满期日[^。；]{0,80}生存|领取期[^。；]{0,80}生存|保证领取期/u.test(compact);
}

function hasExcludedCashflowTrigger(text) {
  const compact = compactText(text);
  return /恶性肿瘤|重大疾病|重疾|中症|轻症|特定疾病|疾病关爱金|身故|全残|高残|身体全残|医疗费用|住院|门诊|报销|豁免/u.test(compact);
}

function laneForIndicator(indicator = {}) {
  const liability = normalizeSpaces(indicator.liability);
  const text = normalizeSpaces(`${indicator.liability || ''} ${indicator.coverageType || ''} ${indicator.formulaText || ''} ${indicator.sourceExcerpt || ''}`);
  if (/豁免/u.test(text)) return 'waiver';
  if (/医疗|门诊|住院|药品|药械|费用|报销|补偿|免赔额|质子重离子/u.test(text)) return 'medical_formula';
  if (/恶性肿瘤|癌|重大疾病|重疾|中症|轻症|中度疾病|轻度疾病|特定疾病|疾病关爱金/u.test(text)) return 'critical_illness';
  if (/意外|伤残|残疾|交通|航空|列车|轮船|驾乘|猝死/u.test(text)) return 'accident';
  if (/身故|全残|高残|现金价值|已交保费|已交保险费|max\\(|较大者|较高者/u.test(text)) return 'death_life';
  if (isAnnuityLiability(liability)) return 'cashflow_annuity';
  return 'death_life';
}

function isHighConfidenceAnnuityCandidate(indicator = {}) {
  const liability = normalizeSpaces(indicator.liability);
  const excerpt = normalizeSpaces(indicator.sourceExcerpt);
  if (!isAnnuityLiability(liability)) return false;
  if (!hasAnnuityTrigger(excerpt)) return false;
  if (hasExcludedCashflowTrigger(`${liability} ${excerpt}`) && !/关爱年金/u.test(liability)) return false;
  if (normalizeSpaces(indicator.responsibilityScope) === 'optional' && !trim(indicator.optionalResponsibilityId)) return false;
  if (!trim(indicator.formulaText)) return false;
  if (!trim(indicator.basis)) return false;
  if (!trim(indicator.unit)) return false;
  return true;
}
```

- [ ] **Step 3: Add DB loading helpers**

Append:

```js
function loadKnowledgeProducts(db, { minKnowledgeId = 0, knowledgeIds = [], companies = [], includeExistingProducts = false } = {}) {
  const targetIds = uniqueStrings(knowledgeIds.map(String)).map(Number).filter((item) => Number.isInteger(item) && item > 0);
  const idFilter = targetIds.length ? `AND id IN (${targetIds.map(() => '?').join(', ')})` : '';
  const rows = db.prepare(`
    SELECT id, company, product_name, url, payload
      FROM knowledge_records
     WHERE product_name IS NOT NULL AND product_name <> '' AND id >= ? ${idFilter}
     ORDER BY company, product_name, id DESC
  `).all(minKnowledgeId, ...targetIds);
  const indicatorKeys = includeExistingProducts
    ? new Set()
    : new Set(db.prepare(`
      SELECT DISTINCT COALESCE(company, '') AS company, COALESCE(product_name, '') AS product_name
        FROM insurance_indicator_records
       WHERE product_name IS NOT NULL AND product_name <> ''
    `).all().map((row) => `${row.company}\u001f${row.product_name}`));
  const products = new Map();
  for (const row of rows) {
    const payload = parsePayload(row.payload);
    const company = trim(row.company || payload.company);
    const productName = trim(row.product_name || payload.productName);
    if (companies.length && !companies.includes(company)) continue;
    const key = `${company}\u001f${productName}`;
    if (indicatorKeys.has(key)) continue;
    const text = sourceText(payload);
    if (!/保险责任|保险金|给付|赔付|报销|津贴|年金/u.test(text)) continue;
    if (!products.has(key)) {
      products.set(key, {
        company,
        productName,
        productType: trim(payload.productType),
        salesStatus: trim(payload.salesStatus),
        sourceRecordIds: [],
        sourceUrls: [],
        sourceTitles: [],
        textParts: [],
      });
    }
    const product = products.get(key);
    product.productType ||= trim(payload.productType);
    product.salesStatus ||= trim(payload.salesStatus);
    product.sourceRecordIds.push(String(payload.id || row.id));
    if (trim(payload.url || row.url)) product.sourceUrls.push(trim(payload.url || row.url));
    if (trim(payload.title)) product.sourceTitles.push(trim(payload.title));
    product.textParts.push(text);
  }
  return [...products.values()].map((product) => ({
    ...product,
    sourceRecordId: product.sourceRecordIds[0] || '',
    sourceUrl: product.sourceUrls[0] || '',
    sourceTitle: product.sourceTitles[0] || product.productName,
    sourceText: product.textParts.join('\n').slice(0, 24000),
  }));
}

function existingIndicatorsForProducts(db, products) {
  const productKeys = new Set(products.map((product) => `${product.company}\u001f${product.productName}`));
  const rows = db.prepare('SELECT id, company, product_name, coverage_type, liability, payload FROM insurance_indicator_records').all();
  return rows
    .map((row) => ({ ...row, payload: parsePayload(row.payload) }))
    .filter((row) => productKeys.has(`${row.company}\u001f${row.product_name}`));
}

function indicatorComparableKey(indicator = {}) {
  return [
    normalizeLookupText(indicator.company),
    normalizeLookupText(indicator.productName || indicator.product_name),
    normalizeLookupText(indicator.coverageType || indicator.coverage_type),
    normalizeLookupText(indicator.liability),
    normalizeLookupText(indicator.formulaText || indicator.payload?.formulaText),
  ].join('\u001f');
}
```

- [ ] **Step 4: Add issue and candidate builders**

Append:

```js
function buildIssue({ lane, issueType, severity = 'warning', product, indicator, reason }) {
  return {
    lane,
    issueType,
    severity,
    company: product.company,
    productName: product.productName,
    sourceRecordId: indicator?.sourceRecordId || product.sourceRecordId,
    currentIndicators: [],
    sourceExcerpt: indicator?.sourceExcerpt || '',
    reason,
  };
}

function buildCandidate({ lane, product, proposedIndicator, issueType, reason }) {
  const highAnnuity = lane === 'cashflow_annuity' && isHighConfidenceAnnuityCandidate(proposedIndicator);
  const writeAllowed = highAnnuity;
  return {
    id: `indicator_quality_candidate_${sha1([product.company, product.productName, lane, proposedIndicator.liability, proposedIndicator.formulaText].join('\u001f'), 24)}`,
    lane,
    operation: writeAllowed ? 'insert' : 'report_only',
    confidence: writeAllowed ? 'high' : 'medium',
    writeAllowed,
    blockedReason: writeAllowed ? '' : lane === 'cashflow_annuity' ? 'cashflow_candidate_not_high_confidence' : 'phase_one_report_only_lane',
    issueType,
    company: product.company,
    productName: product.productName,
    sourceRecordId: proposedIndicator.sourceRecordId || product.sourceRecordId,
    currentIndicator: null,
    proposedIndicator: {
      ...proposedIndicator,
      version: VERSION,
    },
    sourceExcerpt: proposedIndicator.sourceExcerpt || '',
    reason,
  };
}

function proposedIndicatorsForProduct(product, now) {
  return buildIndicatorsForProduct(product, now).map((indicator) => ({
    ...indicator,
    sourceRecordId: indicator.sourceRecordId || product.sourceRecordId,
    sourceUrl: indicator.sourceUrl || product.sourceUrl,
    sourceTitle: indicator.sourceTitle || product.sourceTitle,
    sourceEvidenceLevel: indicator.sourceEvidenceLevel || (product.sourceUrl ? 'official_excerpt' : 'local_excerpt'),
  }));
}

function auditProduct({ product, existingKeys, now }) {
  const issues = [];
  const candidates = [];
  const proposed = proposedIndicatorsForProduct(product, now);
  for (const indicator of proposed) {
    const lane = laneForIndicator(indicator);
    const key = indicatorComparableKey(indicator);
    if (existingKeys.has(key)) continue;
    const issueType = lane === 'cashflow_annuity' ? 'missing_or_generic_cashflow_indicator' : 'report_only_candidate';
    const reason = lane === 'cashflow_annuity'
      ? '官方条款可抽取确定返钱责任，当前指标缺少同等真实责任名和公式。'
      : '第一期仅审计该险种 lane，不写库。';
    issues.push(buildIssue({ lane, issueType, product, indicator, reason }));
    candidates.push(buildCandidate({ lane, product, proposedIndicator: indicator, issueType, reason }));
  }
  for (const section of splitBenefitSections(product.sourceText)) {
    const sectionLane = laneForIndicator({
      liability: section.liability,
      sourceExcerpt: section.text,
    });
    if (sectionLane === 'medical_formula' && /免赔额|医疗费用|给付比例|赔付比例/u.test(section.text)) {
      issues.push(buildIssue({
        lane: 'medical_formula',
        issueType: 'medical_formula_review',
        product,
        indicator: { sourceRecordId: product.sourceRecordId, sourceExcerpt: normalizeSpaces(section.text).slice(0, 1200) },
        reason: '医疗责任需要审查是否误把免赔额、限额或单一金额当作保险金公式。',
      }));
    }
  }
  return { issues, candidates };
}
```

- [ ] **Step 5: Add summary and main function**

Append:

```js
function emptyLaneSummary() {
  return {
    issues: 0,
    candidates: 0,
    writeAllowedCandidates: 0,
    highConfidenceCandidates: 0,
  };
}

function summarize({ issues, candidates, writtenIndicators }) {
  const byLane = Object.fromEntries(LANES.map((lane) => [lane, emptyLaneSummary()]));
  for (const issue of issues) {
    byLane[issue.lane] ||= emptyLaneSummary();
    byLane[issue.lane].issues += 1;
  }
  for (const candidate of candidates) {
    byLane[candidate.lane] ||= emptyLaneSummary();
    byLane[candidate.lane].candidates += 1;
    if (candidate.writeAllowed) byLane[candidate.lane].writeAllowedCandidates += 1;
    if (candidate.confidence === 'high') byLane[candidate.lane].highConfidenceCandidates += 1;
  }
  return {
    issues: issues.length,
    candidates: candidates.length,
    writeAllowedCandidates: candidates.filter((candidate) => candidate.writeAllowed).length,
    indicatorUpserts: writtenIndicators.length,
    byLane,
  };
}

export function auditInsuranceIndicatorQuality({
  dbPath = DEFAULT_DB_PATH,
  writeAnnuityCashflow = false,
  sampleLimit = 20,
  minKnowledgeId = 0,
  companies = [],
  includeExistingProducts = false,
  knowledgeIds = [],
} = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    const now = new Date().toISOString();
    const products = loadKnowledgeProducts(db, { minKnowledgeId, companies, includeExistingProducts, knowledgeIds });
    const existing = existingIndicatorsForProducts(db, products);
    const existingKeys = new Set(existing.map((row) => indicatorComparableKey({
      ...row.payload,
      company: row.company,
      productName: row.product_name,
      coverageType: row.coverage_type,
      liability: row.liability,
    })));
    const issues = [];
    const candidates = [];
    for (const product of products) {
      const audited = auditProduct({ product, existingKeys, now });
      issues.push(...audited.issues);
      candidates.push(...audited.candidates);
    }
    const writeCandidates = writeAnnuityCashflow
      ? candidates.filter((candidate) => candidate.writeAllowed)
      : [];
    const writtenIndicators = writeCandidates.map((candidate) => candidate.proposedIndicator);
    let indicatorUpdateBatchId = '';
    let affectedPolicyCount = 0;
    if (writeAnnuityCashflow && writtenIndicators.length) {
      upsertIndicators(db, writtenIndicators);
      const changedProductKeys = uniqueStrings(writtenIndicators.flatMap((indicator) => deriveIndicatorProductKeys(indicator)));
      db.exec('BEGIN IMMEDIATE');
      try {
        const affectedPolicyIds = markAffectedDerivedRowsStale(db, changedProductKeys, now);
        affectedPolicyCount = affectedPolicyIds.length;
        indicatorUpdateBatchId = recordIndicatorRefreshBatch(db, {
          productKeys: changedProductKeys,
          affectedPolicyCount,
          now,
        });
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    }
    return {
      dbPath,
      dryRun: !writeAnnuityCashflow,
      candidateProducts: products.length,
      issues,
      candidates,
      samples: candidates.slice(0, sampleLimit),
      indicatorUpserts: writtenIndicators.length,
      affectedPolicyCount,
      indicatorUpdateBatchId,
      summary: summarize({ issues, candidates, writtenIndicators }),
    };
  } finally {
    db.close();
  }
}
```

- [ ] **Step 6: Add CLI entrypoint**

Append:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const companies = readArg('companies', '')
    .split(',')
    .map((item) => trim(item))
    .filter(Boolean);
  const result = auditInsuranceIndicatorQuality({
    dbPath: path.resolve(readArg('db-path', DEFAULT_DB_PATH)),
    writeAnnuityCashflow: hasFlag('write-annuity-cashflow'),
    sampleLimit: Number(readArg('sample-limit', 20)) || 20,
    minKnowledgeId: Number(readArg('min-knowledge-id', 0)) || 0,
    companies,
    includeExistingProducts: hasFlag('include-existing-products'),
    knowledgeIds: parseIdList(readArg('knowledge-ids', '')),
  });
  console.log(JSON.stringify(result, null, 2));
}
```

- [ ] **Step 7: Run the focused governance tests**

Run:

```bash
node --test tests/insurance-indicator-quality-governance.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add scripts/insurance-indicator-quality-governance.mjs tests/insurance-indicator-quality-governance.test.mjs
git commit -m "feat: add indicator quality governance runner"
```

---

### Task 4: Add Existing-DB Dry-Run Verification

**Files:**
- Modify: `tests/insurance-indicator-quality-governance.test.mjs`
- Manual verification: `.runtime/local/policy-ocr.sqlite`

- [ ] **Step 1: Add a regression test for mixed annuity responsibility names**

Append to `tests/insurance-indicator-quality-governance.test.mjs`:

```js
test('annuity lane recognizes broader return-money liability names', () => {
  const { dir, dbPath } = makeTempDb();
  const db = new DatabaseSync(dbPath);
  try {
    insertKnowledge(db, {
      id: 3000,
      company: '测试人寿',
      productName: '测试返钱年金保险',
      pageText: [
        '保险责任 贺寿金被保险人生存至年满60周岁后的首个保单周年日，我们按基本保险金额的20%给付贺寿金。',
        '大学教育金被保险人在18周岁至21周岁每个保单周年日生存，我们按基本保险金额的10%给付大学教育金。',
        '保证领取保险金若保证领取期内仍应给付年金，我们按保证领取总额扣除已领取年金后的余额给付保证领取保险金。'
      ].join(' '),
    });

    const result = auditInsuranceIndicatorQuality({
      dbPath,
      knowledgeIds: [3000],
      includeExistingProducts: true,
    });

    const annuityLiabilities = result.candidates
      .filter((candidate) => candidate.lane === 'cashflow_annuity')
      .map((candidate) => candidate.proposedIndicator.liability);
    assert.ok(annuityLiabilities.includes('贺寿金'));
    assert.ok(annuityLiabilities.includes('大学教育金'));
    assert.ok(result.summary.byLane.cashflow_annuity.candidates >= 2);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run all focused indicator tests**

Run:

```bash
node --test tests/backfill-knowledge-responsibility-indicators.test.mjs tests/insurance-indicator-quality-governance.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Run dev DB dry-run for the seed product**

Run:

```bash
node scripts/insurance-indicator-quality-governance.mjs \
  --db-path=.runtime/local/policy-ocr.sqlite \
  --knowledge-ids=1359 \
  --include-existing-products \
  --sample-limit=20
```

Expected:

- JSON output has `dryRun: true`.
- `summary.byLane.cashflow_annuity.writeAllowedCandidates` is at least `2`.
- Samples include `关爱年金` and `生存保险金`.
- `indicatorUpserts` is `0`.

- [ ] **Step 4: Run syntax and project checks**

Run:

```bash
node --check scripts/insurance-indicator-quality-governance.mjs
npm run check
```

Expected: both pass.

- [ ] **Step 5: Commit**

```bash
git add tests/insurance-indicator-quality-governance.test.mjs
git commit -m "test: cover annuity cashflow governance names"
```

---

### Task 5: Optional Write Run on Development DB

**Files:**
- No source files changed unless a bug is found.
- Data target: `.runtime/local/policy-ocr.sqlite`

- [ ] **Step 1: Confirm development DB target**

Run:

```bash
npm run local:status
```

Expected: development stack is visible. Do not start, stop, restart, or modify local production.

- [ ] **Step 2: Back up development SQLite**

Run:

```bash
mkdir -p .runtime/local/backups
cp .runtime/local/policy-ocr.sqlite ".runtime/local/backups/policy-ocr-before-indicator-quality-$(date +%Y%m%d-%H%M%S).sqlite"
```

Expected: backup file created under `.runtime/local/backups/`.

- [ ] **Step 3: Write only seed annuity candidates**

Run:

```bash
node scripts/insurance-indicator-quality-governance.mjs \
  --db-path=.runtime/local/policy-ocr.sqlite \
  --knowledge-ids=1359 \
  --include-existing-products \
  --write-annuity-cashflow \
  --sample-limit=20
```

Expected:

- `dryRun: false`.
- `indicatorUpserts` equals the number of write-allowed annuity candidates.
- No medical, critical illness, accident, death/life, or waiver candidate is written.

- [ ] **Step 4: Rerun dry-run and verify convergence**

Run:

```bash
node scripts/insurance-indicator-quality-governance.mjs \
  --db-path=.runtime/local/policy-ocr.sqlite \
  --knowledge-ids=1359 \
  --include-existing-products \
  --sample-limit=20
```

Expected:

- `dryRun: true`.
- The seed product should no longer propose the same written annuity formulas as write-allowed candidates.
- Remaining candidates, if any, have `writeAllowed: false` or a clear `blockedReason`.

- [ ] **Step 5: SQL verify seed rows**

Run:

```bash
sqlite3 .runtime/local/policy-ocr.sqlite <<'SQL'
.headers on
.mode column
SELECT coverage_type, liability, json_extract(payload,'$.formulaText') AS formula_text,
       json_extract(payload,'$.basis') AS basis,
       json_extract(payload,'$.sourceRecordId') AS source_record_id
FROM insurance_indicator_records
WHERE company LIKE '%新华%' AND product_name LIKE '%尊享人生%'
ORDER BY liability;
SQL
```

Expected:

- Rows include `关爱年金` with `关爱年金 = 首次交纳的基本责任的保险费 × 1%`.
- Rows include `生存保险金` with `生存保险金 = 基本责任保险金额 × 9%`.
- `投保人意外身故/全残豁免` is not `coverage_type=现金流`.

- [ ] **Step 6: Commit source changes only**

Do not commit `.runtime/` backups or SQLite files.

```bash
git status --short
git add scripts/backfill-knowledge-responsibility-indicators.mjs scripts/insurance-indicator-quality-governance.mjs tests/insurance-indicator-quality-governance.test.mjs
git commit -m "feat: govern insurance indicator quality"
```

If there are unrelated dirty files, leave them out of the commit.

---

### Task 6: Final Verification

**Files:**
- Verify only

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test tests/backfill-knowledge-responsibility-indicators.test.mjs tests/insurance-indicator-quality-governance.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run project check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 3: Summarize changed files and data writes**

Run:

```bash
git status --short
```

Expected:

- Source changes are either committed or clearly listed.
- `.runtime/` is not committed.
- Existing unrelated dirty files are still not staged unless they are part of this task.

Final response should include:

- Verification commands run.
- Whether dev DB write was performed.
- Whether local production was untouched.
- Any remaining report-only lanes or blocked candidates.
