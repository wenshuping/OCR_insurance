# Ping An Coverage Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only Ping An coverage audit that outputs existing-record repair candidates and authoritative-source missing-new candidates with PDF and responsibility evidence where available.

**Architecture:** Add one focused Node ESM audit script with pure exported helpers plus a CLI wrapper. Reuse existing SQLite access through `scripts/runtime-knowledge-state.mjs` and existing JRCPCX/Ping An crawler outputs as source artifacts; do not write knowledge records during this audit. Keep all source matching, issue classification, and report writing in the audit script so tests can cover the behavior without browser or network access.

**Tech Stack:** Node ESM, `node:test`, project SQLite state store, JSON reports under `.runtime/`, existing Scrapling-backed source artifacts.

---

## File Structure

- Create `scripts/audit-ping-an-coverage.mjs`
  - Pure helper exports for name normalization, issuer detection, issue classification, external-source normalization, local indexing, matching, report building, and CLI execution.
  - CLI writes `.runtime/ping-an-existing-repair-audit.json`, `.runtime/ping-an-missing-source-candidates.json`, and `.runtime/ping-an-coverage-audit-summary.json`.
  - CLI reads local SQLite but never calls `saveState`, `upsertRows`, or `writeStateDocument`.
- Create `tests/ping-an-coverage-audit.test.mjs`
  - Unit tests for normalization, local repair issue classification, external source parsing, conservative matching, and summary generation.
- Modify `docs/harness-test-map.json`
  - Add a focused test mapping so changes to `scripts/audit-ping-an-coverage.mjs` run `tests/ping-an-coverage-audit.test.mjs`.

## Task 1: Pure Normalization Helpers

**Files:**
- Create: `scripts/audit-ping-an-coverage.mjs`
- Create: `tests/ping-an-coverage-audit.test.mjs`

- [ ] **Step 1: Write failing normalization tests**

Create `tests/ping-an-coverage-audit.test.mjs` with:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPingAnIssuer,
  normalizeProductName,
  planCodeFromUrl,
} from '../scripts/audit-ping-an-coverage.mjs';

test('normalizeProductName handles spaces and bracket variants conservatively', () => {
  assert.equal(
    normalizeProductName(' 平安智富人生B （ 万能型，2004 ） '),
    '平安智富人生B(万能型,2004)',
  );
  assert.equal(
    normalizeProductName('平安附加少儿大学教育年金保险（分红型，外币版）'),
    '平安附加少儿大学教育年金保险(分红型,外币版)',
  );
});

test('isPingAnIssuer accepts Ping An life issuer names only', () => {
  assert.equal(isPingAnIssuer('中国平安人寿保险股份有限公司'), true);
  assert.equal(isPingAnIssuer('中国平安'), true);
  assert.equal(isPingAnIssuer('平安健康保险股份有限公司'), true);
  assert.equal(isPingAnIssuer('安盛天平财产保险有限公司'), false);
});

test('planCodeFromUrl extracts Ping An plan code query parameter', () => {
  assert.equal(
    planCodeFromUrl('https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=893&versionNo=893-2&attachmentType=1'),
    '893',
  );
  assert.equal(planCodeFromUrl('https://example.test/no-plan-code'), '');
});
```

- [ ] **Step 2: Run the test to verify the module is missing**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: FAIL with `Cannot find module` for `scripts/audit-ping-an-coverage.mjs`.

- [ ] **Step 3: Add minimal helper implementation**

Create `scripts/audit-ping-an-coverage.mjs` with:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createKnowledgeStateStore } from './runtime-knowledge-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');

export function trim(value) {
  return String(value || '').trim();
}

export function normalizeProductName(value = '') {
  return trim(value)
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/[，]/gu, ',')
    .replace(/[：]/gu, ':')
    .replace(/\s+/gu, '')
    .replace(/,+/gu, ',');
}

export function isPingAnIssuer(value = '') {
  const normalized = trim(value).replace(/\s+/gu, '');
  if (!normalized) return false;
  if (normalized === '中国平安') return true;
  if (normalized.includes('中国平安人寿')) return true;
  if (normalized.includes('平安人寿')) return true;
  if (normalized.includes('平安健康保险')) return true;
  return false;
}

export function planCodeFromUrl(url = '') {
  try {
    return trim(new URL(url).searchParams.get('planCode'));
  } catch {
    return '';
  }
}
```

- [ ] **Step 4: Run the normalization tests**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: PASS for the three normalization tests.

- [ ] **Step 5: Commit normalization helpers**

Run:

```bash
git add scripts/audit-ping-an-coverage.mjs tests/ping-an-coverage-audit.test.mjs
git commit -m "feat: add ping an coverage audit helpers"
```

## Task 2: Existing Local Repair Audit

**Files:**
- Modify: `scripts/audit-ping-an-coverage.mjs`
- Modify: `tests/ping-an-coverage-audit.test.mjs`

- [ ] **Step 1: Add failing tests for local issue classification**

Append to `tests/ping-an-coverage-audit.test.mjs`:

```js
import {
  buildExistingRepairAudit,
  classifyLocalRepairCandidate,
} from '../scripts/audit-ping-an-coverage.mjs';

test('classifyLocalRepairCandidate recommends concrete repair actions', () => {
  assert.deepEqual(
    classifyLocalRepairCandidate(
      {
        id: 1,
        company: '中国平安',
        productName: '平安示例寿险',
        title: '平安示例寿险产品条款',
        materialType: 'terms',
        url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=1&versionNo=1-1&attachmentType=1',
        pageText: '保险责任 被保险人身故，我们按基本保险金额给付身故保险金。',
        qualityStatus: '',
        pdfLocalPath: '/tmp/missing.pdf',
      },
      { existsFn: () => false },
    ),
    {
      issues: ['short_text_lt_300', 'blank_quality_status', 'missing_archived_pdf'],
      recommendedAction: 'reextract_official_pdf',
    },
  );

  assert.deepEqual(
    classifyLocalRepairCandidate(
      {
        id: 2,
        company: '中国平安',
        productName: '平安示例医疗保险',
        pageText: '保险责任 被保险人发生事故，我们按约定给付。责任免除 因下列情形之一导致的保险事故，我们不承担责任。',
        qualityStatus: 'valid_complete',
      },
      { existsFn: () => true },
    ),
    {
      issues: ['boundary_overrun_exclusion_section', 'missing_archived_pdf'],
      recommendedAction: 'boundary_cleanup',
    },
  );
});

test('buildExistingRepairAudit returns only Ping An records with detected issues', () => {
  const audit = buildExistingRepairAudit(
    [
      { id: 1, company: '中国平安', productName: '平安短文本', pageText: '保险责任 身故给付。', qualityStatus: '' },
      { id: 2, company: '新华保险', productName: '新华短文本', pageText: '', qualityStatus: '' },
      { id: 3, company: '中国平安', productName: '平安完整文本', pageText: '保险责任 ' + '我们按约定给付。'.repeat(80), qualityStatus: 'valid_complete', pdfLocalPath: '/tmp/a.pdf' },
    ],
    { existsFn: (filePath) => filePath === '/tmp/a.pdf' },
  );

  assert.equal(audit.records.length, 1);
  assert.equal(audit.records[0].id, 1);
  assert.equal(audit.summary.recordCount, 1);
  assert.equal(audit.summary.byRecommendedAction.reextract_official_pdf, 1);
});
```

- [ ] **Step 2: Run tests and verify missing exports**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: FAIL with missing export errors for `buildExistingRepairAudit` and `classifyLocalRepairCandidate`.

- [ ] **Step 3: Implement local repair classification**

Add to `scripts/audit-ping-an-coverage.mjs`:

```js
function countBy(rows = [], keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row) || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function hasArchivedPdf(record = {}, existsFn = fs.existsSync) {
  const pdfPath = trim(record.pdfLocalPath);
  return Boolean(pdfPath && existsFn(pdfPath));
}

export function classifyLocalRepairCandidate(record = {}, { existsFn = fs.existsSync } = {}) {
  const pageText = trim(record.pageText);
  const qualityStatus = trim(record.qualityStatus);
  const issues = [];
  if (!pageText) issues.push('empty_text');
  if (pageText && pageText.length < 100) issues.push('very_short_text_lt_100');
  else if (pageText && pageText.length < 300) issues.push('short_text_lt_300');
  if (!qualityStatus) issues.push('blank_quality_status');
  if (qualityStatus === 'valid_partial') issues.push('flagged_valid_partial');
  if (qualityStatus === 'invalid_empty' || qualityStatus === 'invalid_responsibility') issues.push('flagged_invalid');
  if (/责任免除/u.test(pageText)) issues.push('boundary_overrun_exclusion_section');
  if (/保单红利|现金价值|保险金申请|如何领取保险金/u.test(pageText)) issues.push('boundary_overrun_policy_benefit_section');
  if (!hasArchivedPdf(record, existsFn)) issues.push('missing_archived_pdf');

  let recommendedAction = '';
  if (issues.includes('empty_text') || issues.includes('flagged_invalid')) recommendedAction = 'ocr_official_pdf';
  else if (issues.some((issue) => issue.startsWith('boundary_overrun'))) recommendedAction = 'boundary_cleanup';
  else if (issues.includes('missing_archived_pdf') || issues.includes('short_text_lt_300') || issues.includes('very_short_text_lt_100') || issues.includes('blank_quality_status') || issues.includes('flagged_valid_partial')) {
    recommendedAction = 'reextract_official_pdf';
  }

  return { issues, recommendedAction };
}

export function buildExistingRepairAudit(records = [], { existsFn = fs.existsSync, generatedAt = new Date().toISOString() } = {}) {
  const repairRecords = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (trim(record.company) !== '中国平安') continue;
    const classification = classifyLocalRepairCandidate(record, { existsFn });
    if (!classification.recommendedAction) continue;
    repairRecords.push({
      id: record.id,
      company: trim(record.company),
      productName: trim(record.productName),
      title: trim(record.title),
      materialType: trim(record.materialType),
      url: trim(record.url),
      currentQualityStatus: trim(record.qualityStatus),
      pageTextChars: trim(record.pageText).length,
      hasArchivedPdf: hasArchivedPdf(record, existsFn),
      pdfLocalPath: trim(record.pdfLocalPath),
      issues: classification.issues,
      recommendedAction: classification.recommendedAction,
    });
  }
  return {
    generatedAt,
    records: repairRecords,
    summary: {
      recordCount: repairRecords.length,
      productCount: new Set(repairRecords.map((row) => normalizeProductName(row.productName)).filter(Boolean)).size,
      byRecommendedAction: countBy(repairRecords, (row) => row.recommendedAction),
      byIssue: repairRecords.reduce((acc, row) => {
        for (const issue of row.issues) acc[issue] = (acc[issue] || 0) + 1;
        return acc;
      }, {}),
    },
  };
}
```

- [ ] **Step 4: Run local repair tests**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit local repair audit**

Run:

```bash
git add scripts/audit-ping-an-coverage.mjs tests/ping-an-coverage-audit.test.mjs
git commit -m "feat: classify ping an local repair candidates"
```

## Task 3: External Source Loading and Normalization

**Files:**
- Modify: `scripts/audit-ping-an-coverage.mjs`
- Modify: `tests/ping-an-coverage-audit.test.mjs`

- [ ] **Step 1: Add failing tests for external source records**

Append to `tests/ping-an-coverage-audit.test.mjs`:

```js
import {
  normalizeExternalSourceRecord,
  normalizeExternalSourceRecords,
} from '../scripts/audit-ping-an-coverage.mjs';

test('normalizeExternalSourceRecord preserves JRCPCX Ping An evidence fields', () => {
  const normalized = normalizeExternalSourceRecord({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安金宝贝少儿教育年金保险（分红型）',
    productType: '年金保险-非养老年金保险',
    salesStatus: '停用',
    sourceLevel: 'regulatory_industry_terms',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=abc',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pageText: '保险责任 大学教育金 被保险人生存至18周岁，我们给付大学教育金。',
    qualityStatus: 'valid_complete',
    pdfLocalPath: '/tmp/terms.pdf',
    pdfSha256: 'abc123',
    pdfBytes: 123,
  }, { sourceName: 'jrcpcx' });

  assert.equal(normalized.issuerFullName, '中国平安人寿保险股份有限公司');
  assert.equal(normalized.normalizedProductName, '平安金宝贝少儿教育年金保险(分红型)');
  assert.equal(normalized.sourceName, 'jrcpcx');
  assert.equal(normalized.responsibilityPreview.includes('大学教育金'), true);
});

test('normalizeExternalSourceRecords filters non Ping An issuers', () => {
  const records = normalizeExternalSourceRecords([
    { company: '中国平安人寿保险股份有限公司', productName: '平安产品', pageText: '保险责任 身故给付。' },
    { company: '新华保险股份有限公司', productName: '新华产品', pageText: '保险责任 身故给付。' },
  ], { sourceName: 'sample' });

  assert.equal(records.length, 1);
  assert.equal(records[0].productName, '平安产品');
});
```

- [ ] **Step 2: Run tests and verify missing exports**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: FAIL with missing exports for `normalizeExternalSourceRecord` and `normalizeExternalSourceRecords`.

- [ ] **Step 3: Implement external source normalization**

Add to `scripts/audit-ping-an-coverage.mjs`:

```js
export function normalizeExternalSourceRecord(record = {}, { sourceName = '' } = {}) {
  const issuerFullName = trim(record.issuerFullName || record.company || record.companyName || record.deptName || record['发行机构全称']);
  const productName = trim(record.productName || record.product || record['产品名称']);
  const detailUrl = trim(record.detailUrl || record.sourceUrl || record.source || record.url);
  const clauseUrl = trim(record.clauseUrl || record.pdfOriginalUrl || record.url);
  const pageText = trim(record.pageText);
  return {
    sourceName: trim(sourceName || record.sourceName || record.sourceLevel || record.parser || 'external_source'),
    sourceLevel: trim(record.sourceLevel),
    issuerFullName,
    productName,
    normalizedProductName: normalizeProductName(productName),
    productType: trim(record.productType || record['产品类别']),
    salesStatus: trim(record.salesStatus || record.productState || record['产品销售状态']),
    detailUrl,
    clauseUrl,
    url: clauseUrl || detailUrl,
    planCode: trim(record.planCode) || planCodeFromUrl(clauseUrl || detailUrl),
    materialType: trim(record.materialType || 'terms'),
    responsibilityPreview: pageText.slice(0, 800),
    responsibilityQualityStatus: trim(record.qualityStatus || (pageText ? 'suspect_needs_source_check' : 'invalid_empty')),
    pdfLocalPath: trim(record.pdfLocalPath),
    pdfSha256: trim(record.pdfSha256),
    pdfBytes: Number(record.pdfBytes || record.bytes || 0) || 0,
    rawId: trim(record.id || record.catalogId || record.localId),
  };
}

export function normalizeExternalSourceRecords(records = [], options = {}) {
  return (Array.isArray(records) ? records : [])
    .map((record) => normalizeExternalSourceRecord(record, options))
    .filter((record) => record.productName && isPingAnIssuer(record.issuerFullName));
}
```

- [ ] **Step 4: Run external source tests**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit external source normalization**

Run:

```bash
git add scripts/audit-ping-an-coverage.mjs tests/ping-an-coverage-audit.test.mjs
git commit -m "feat: normalize ping an external source records"
```

## Task 4: Conservative Matching and Missing Candidate Builder

**Files:**
- Modify: `scripts/audit-ping-an-coverage.mjs`
- Modify: `tests/ping-an-coverage-audit.test.mjs`

- [ ] **Step 1: Add failing tests for matching**

Append to `tests/ping-an-coverage-audit.test.mjs`:

```js
import {
  buildLocalPingAnIndexes,
  buildMissingSourceCandidates,
  matchExternalToLocal,
} from '../scripts/audit-ping-an-coverage.mjs';

test('matchExternalToLocal treats exact local product as represented', () => {
  const indexes = buildLocalPingAnIndexes([
    {
      id: 10,
      company: '中国平安',
      productName: '平安金宝贝少儿教育年金保险（分红型）',
      url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=901&versionNo=901-1&attachmentType=1',
    },
  ]);
  const match = matchExternalToLocal(
    normalizeExternalSourceRecord({
      company: '中国平安人寿保险股份有限公司',
      productName: '平安金宝贝少儿教育年金保险(分红型)',
      clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
      pageText: '保险责任 大学教育金。',
    }),
    indexes,
  );

  assert.equal(match.status, 'represented_by_product_name');
  assert.equal(match.localMatches[0].id, 10);
});

test('buildMissingSourceCandidates keeps missing and ambiguous records reviewable', () => {
  const localRecords = [
    { id: 10, company: '中国平安', productName: '平安智盈人生终身寿险（万能型）', url: 'https://life.pingan.com/ilife-home/product/getPlanClausePdf?planCode=810&versionNo=810-2&attachmentType=1' },
  ];
  const externalRecords = normalizeExternalSourceRecords([
    { company: '中国平安人寿保险股份有限公司', productName: '平安智盈人生终身寿险（万能型）', clauseUrl: 'https://external.test/810.pdf', pageText: '保险责任 身故保险金。', qualityStatus: 'valid_complete' },
    { company: '中国平安人寿保险股份有限公司', productName: '平安康泰终身保险（甲）（9906）', clauseUrl: 'https://external.test/738.pdf', pageText: '保险责任 身故保险金。', qualityStatus: 'valid_complete' },
  ], { sourceName: 'sample' });

  const candidates = buildMissingSourceCandidates(externalRecords, localRecords);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].productName, '平安康泰终身保险（甲）（9906）');
  assert.equal(candidates[0].missingReason, 'no_local_product_match');
  assert.equal(candidates[0].recommendedAction, 'review_then_insert');
});
```

- [ ] **Step 2: Run tests and verify missing exports**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: FAIL with missing matching exports.

- [ ] **Step 3: Implement indexes and candidate matching**

Add to `scripts/audit-ping-an-coverage.mjs`:

```js
function pushMap(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

export function buildLocalPingAnIndexes(localRecords = []) {
  const byProductName = new Map();
  const byUrl = new Map();
  const byPlanCode = new Map();
  const records = (Array.isArray(localRecords) ? localRecords : [])
    .filter((record) => trim(record.company) === '中国平安')
    .map((record) => ({
      id: record.id,
      productName: trim(record.productName),
      normalizedProductName: normalizeProductName(record.productName),
      title: trim(record.title),
      url: trim(record.url),
      planCode: trim(record.planCode) || planCodeFromUrl(record.url),
      materialType: trim(record.materialType),
    }));
  for (const record of records) {
    pushMap(byProductName, record.normalizedProductName, record);
    pushMap(byUrl, record.url, record);
    pushMap(byPlanCode, record.planCode, record);
  }
  return { records, byProductName, byUrl, byPlanCode };
}

export function matchExternalToLocal(externalRecord = {}, indexes = buildLocalPingAnIndexes([])) {
  const urlMatches = indexes.byUrl.get(trim(externalRecord.url)) || indexes.byUrl.get(trim(externalRecord.clauseUrl)) || [];
  if (urlMatches.length) {
    return { status: 'represented_by_url', missingReason: '', localMatches: urlMatches };
  }
  const planMatches = externalRecord.planCode ? indexes.byPlanCode.get(externalRecord.planCode) || [] : [];
  if (planMatches.length) {
    return { status: 'represented_by_plan_code', missingReason: '', localMatches: planMatches };
  }
  const nameMatches = indexes.byProductName.get(externalRecord.normalizedProductName) || [];
  if (nameMatches.length === 1) {
    return { status: 'represented_by_product_name', missingReason: '', localMatches: nameMatches };
  }
  if (nameMatches.length > 1) {
    return { status: 'ambiguous_local_match', missingReason: 'ambiguous_local_match', localMatches: nameMatches };
  }
  return { status: 'missing', missingReason: 'no_local_product_match', localMatches: [] };
}

export function buildMissingSourceCandidates(externalRecords = [], localRecords = []) {
  const indexes = buildLocalPingAnIndexes(localRecords);
  const candidates = [];
  for (const record of Array.isArray(externalRecords) ? externalRecords : []) {
    const match = matchExternalToLocal(record, indexes);
    if (!match.missingReason) continue;
    candidates.push({
      productName: record.productName,
      normalizedProductName: record.normalizedProductName,
      issuerFullName: record.issuerFullName,
      productType: record.productType,
      salesStatus: record.salesStatus,
      sourceName: record.sourceName,
      sourceLevel: record.sourceLevel,
      detailUrl: record.detailUrl,
      clauseUrl: record.clauseUrl,
      url: record.url,
      planCode: record.planCode,
      materialType: record.materialType,
      pdfLocalPath: record.pdfLocalPath,
      pdfSha256: record.pdfSha256,
      pdfBytes: record.pdfBytes,
      responsibilityPreview: record.responsibilityPreview,
      responsibilityQualityStatus: record.responsibilityQualityStatus,
      localMatchCandidates: match.localMatches.slice(0, 10),
      matchStatus: match.status,
      missingReason: match.missingReason,
      recommendedAction: match.missingReason === 'ambiguous_local_match' ? 'manual_review' : 'review_then_insert',
    });
  }
  return candidates;
}
```

- [ ] **Step 4: Run matching tests**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit matching implementation**

Run:

```bash
git add scripts/audit-ping-an-coverage.mjs tests/ping-an-coverage-audit.test.mjs
git commit -m "feat: match ping an source coverage gaps"
```

## Task 5: CLI Report Writer and Read-Only Guard

**Files:**
- Modify: `scripts/audit-ping-an-coverage.mjs`
- Modify: `tests/ping-an-coverage-audit.test.mjs`

- [ ] **Step 1: Add failing tests for report summary**

Append to `tests/ping-an-coverage-audit.test.mjs`:

```js
import {
  buildCoverageSummary,
  collectExternalSourceRecords,
} from '../scripts/audit-ping-an-coverage.mjs';

test('collectExternalSourceRecords reads records arrays from mixed source payloads', () => {
  const records = collectExternalSourceRecords([
    { sourceName: 'jrcpcx', payload: { records: [{ company: '中国平安人寿保险股份有限公司', productName: '平安A', pageText: '保险责任 A' }] } },
    { sourceName: 'historical', payload: [{ company: '中国平安人寿保险股份有限公司', productName: '平安B', pageText: '保险责任 B' }] },
  ]);

  assert.equal(records.length, 2);
  assert.equal(records[0].sourceName, 'jrcpcx');
  assert.equal(records[1].sourceName, 'historical');
});

test('buildCoverageSummary reports local, repair, missing, and pdf counts', () => {
  const summary = buildCoverageSummary({
    localRecords: [
      { company: '中国平安', productName: '平安A' },
      { company: '中国平安', productName: '平安B' },
      { company: '新华保险', productName: '新华A' },
    ],
    externalRecords: [
      { productName: '平安C', pdfLocalPath: '/tmp/c.pdf', responsibilityQualityStatus: 'valid_complete' },
    ],
    existingRepairRecords: [{ productName: '平安A', recommendedAction: 'reextract_official_pdf' }],
    missingCandidates: [{ productName: '平安C', pdfLocalPath: '/tmp/c.pdf', responsibilityQualityStatus: 'valid_complete', missingReason: 'no_local_product_match' }],
  });

  assert.equal(summary.localPingAnRecordCount, 2);
  assert.equal(summary.localPingAnProductCount, 2);
  assert.equal(summary.externalSourceRecordCount, 1);
  assert.equal(summary.existingRepairCount, 1);
  assert.equal(summary.missingCandidateCount, 1);
  assert.equal(summary.missingCandidatesWithPdfCount, 1);
});
```

- [ ] **Step 2: Run tests and verify missing exports**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
```

Expected: FAIL with missing exports for `collectExternalSourceRecords` and `buildCoverageSummary`.

- [ ] **Step 3: Implement source collection and summary**

Add to `scripts/audit-ping-an-coverage.mjs`:

```js
function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function recordsFromPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.products)) return payload.products;
  if (Array.isArray(payload?.suspects)) return payload.suspects;
  if (Array.isArray(payload?.candidates)) return payload.candidates;
  return [];
}

export function collectExternalSourceRecords(sources = []) {
  return (Array.isArray(sources) ? sources : []).flatMap((source) =>
    normalizeExternalSourceRecords(recordsFromPayload(source.payload), { sourceName: source.sourceName }),
  );
}

export function buildCoverageSummary({
  localRecords = [],
  externalRecords = [],
  existingRepairRecords = [],
  missingCandidates = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const localPingAnRecords = localRecords.filter((record) => trim(record.company) === '中国平安');
  return {
    generatedAt,
    localPingAnRecordCount: localPingAnRecords.length,
    localPingAnProductCount: new Set(localPingAnRecords.map((row) => normalizeProductName(row.productName)).filter(Boolean)).size,
    externalSourceRecordCount: externalRecords.length,
    externalSourceProductCount: new Set(externalRecords.map((row) => row.normalizedProductName).filter(Boolean)).size,
    existingRepairCount: existingRepairRecords.length,
    existingRepairProductCount: new Set(existingRepairRecords.map((row) => normalizeProductName(row.productName)).filter(Boolean)).size,
    missingCandidateCount: missingCandidates.length,
    missingCandidateProductCount: new Set(missingCandidates.map((row) => row.normalizedProductName).filter(Boolean)).size,
    missingCandidatesWithPdfCount: missingCandidates.filter((row) => trim(row.pdfLocalPath)).length,
    missingCandidatesWithResponsibilityCount: missingCandidates.filter((row) => trim(row.responsibilityPreview)).length,
    missingCandidatesByReason: countBy(missingCandidates, (row) => row.missingReason),
    missingCandidatesByQuality: countBy(missingCandidates, (row) => row.responsibilityQualityStatus),
    repairCandidatesByAction: countBy(existingRepairRecords, (row) => row.recommendedAction),
  };
}
```

- [ ] **Step 4: Add CLI entrypoint**

Append to `scripts/audit-ping-an-coverage.mjs`:

```js
function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function splitList(value = '') {
  return trim(value)
    .split(/[,，\n]/u)
    .map((item) => trim(item))
    .filter(Boolean);
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const dbPath = readArg('db-path', process.env.POLICY_OCR_APP_DB_PATH || path.join(runtimeDir, 'policy-ocr.sqlite'));
  const statePath = readArg('state-path', process.env.POLICY_OCR_APP_STATE_PATH || path.join(runtimeDir, 'state.json'));
  const sourcePaths = splitList(readArg('source-paths', process.env.PING_AN_COVERAGE_SOURCE_PATHS || ''));
  const existingRepairPath = path.resolve(readArg('existing-repair-path', path.join(runtimeDir, 'ping-an-existing-repair-audit.json')));
  const missingPath = path.resolve(readArg('missing-path', path.join(runtimeDir, 'ping-an-missing-source-candidates.json')));
  const summaryPath = path.resolve(readArg('summary-path', path.join(runtimeDir, 'ping-an-coverage-audit-summary.json')));
  const generatedAt = new Date().toISOString();
  const store = await createKnowledgeStateStore({ dbPath, seedStatePath: statePath });
  try {
    const beforeCount = store.countKnowledgeRecords();
    const state = store.loadState();
    const localRecords = state.knowledgeRecords || [];
    const externalRecords = collectExternalSourceRecords(
      sourcePaths.map((sourcePath) => ({
        sourceName: path.basename(sourcePath).replace(/\.json$/u, ''),
        payload: readJson(path.resolve(sourcePath), {}),
      })),
    );
    const existingRepairAudit = buildExistingRepairAudit(localRecords, { generatedAt });
    const missingCandidates = buildMissingSourceCandidates(externalRecords, localRecords);
    const summary = buildCoverageSummary({
      localRecords,
      externalRecords,
      existingRepairRecords: existingRepairAudit.records,
      missingCandidates,
      generatedAt,
    });
    const afterCount = store.countKnowledgeRecords();
    if (beforeCount !== afterCount) {
      throw new Error(`Read-only audit changed knowledge row count: before=${beforeCount} after=${afterCount}`);
    }
    writeJson(existingRepairPath, existingRepairAudit);
    writeJson(missingPath, { generatedAt, records: missingCandidates, summary: { recordCount: missingCandidates.length } });
    writeJson(summaryPath, { ...summary, dbPath: store.dbPath, sourcePaths });
    console.log(JSON.stringify({ ok: true, existingRepairPath, missingPath, summaryPath, summary }, null, 2));
  } finally {
    store.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run report summary tests and syntax check**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
node --check scripts/audit-ping-an-coverage.mjs
```

Expected: both commands PASS.

- [ ] **Step 6: Commit CLI report writer**

Run:

```bash
git add scripts/audit-ping-an-coverage.mjs tests/ping-an-coverage-audit.test.mjs
git commit -m "feat: write ping an coverage audit reports"
```

## Task 6: Harness Mapping and Real Audit Run

**Files:**
- Modify: `docs/harness-test-map.json`
- Runtime output: `.runtime/ping-an-existing-repair-audit.json`
- Runtime output: `.runtime/ping-an-missing-source-candidates.json`
- Runtime output: `.runtime/ping-an-coverage-audit-summary.json`

- [ ] **Step 1: Inspect harness map format**

Run:

```bash
sed -n '1,220p' docs/harness-test-map.json
```

Expected: JSON with file-to-test mappings.

- [ ] **Step 2: Add focused test mapping**

Edit `docs/harness-test-map.json` to include this mapping:

```json
{
  "path": "scripts/audit-ping-an-coverage.mjs",
  "tests": [
    "tests/ping-an-coverage-audit.test.mjs"
  ]
}
```

If the file uses a different object shape, preserve the existing shape and add the same path/test relationship without changing unrelated mappings.

- [ ] **Step 3: Run focused tests and harness audit**

Run:

```bash
node --test tests/ping-an-coverage-audit.test.mjs
npm run harness:audit
```

Expected: both commands PASS. If `npm run harness:audit` fails on unrelated dirty-worktree files, capture the failing check and keep the focused test result as the audit-script verification.

- [ ] **Step 4: Run the read-only Ping An coverage audit with existing source artifacts**

Run:

```bash
node scripts/audit-ping-an-coverage.mjs \
  --source-paths=.runtime/jrcpcx-missing-life-detail-responsibilities-merged.json \
  --existing-repair-path=.runtime/ping-an-existing-repair-audit.json \
  --missing-path=.runtime/ping-an-missing-source-candidates.json \
  --summary-path=.runtime/ping-an-coverage-audit-summary.json
```

Expected: command prints `{ "ok": true, ... }` and reports nonzero local Ping An counts. The row count guard must not throw.

- [ ] **Step 5: Validate generated reports**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const paths = [
  '.runtime/ping-an-existing-repair-audit.json',
  '.runtime/ping-an-missing-source-candidates.json',
  '.runtime/ping-an-coverage-audit-summary.json',
];
for (const filePath of paths) {
  const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  console.log(filePath, Object.keys(payload).join(','));
}
const missing = JSON.parse(fs.readFileSync('.runtime/ping-an-missing-source-candidates.json', 'utf8'));
const pdfRows = (missing.records || []).filter((row) => row.pdfLocalPath);
const missingPdf = pdfRows.filter((row) => !fs.existsSync(row.pdfLocalPath));
console.log(JSON.stringify({
  missingRecordCount: (missing.records || []).length,
  pdfRows: pdfRows.length,
  missingPdfRows: missingPdf.length,
}, null, 2));
if (missingPdf.length) process.exit(1);
NODE
```

Expected: all JSON files parse and `missingPdfRows` is `0`.

- [ ] **Step 6: Commit harness mapping and reports decision**

Run:

```bash
git add docs/harness-test-map.json
git commit -m "test: map ping an coverage audit test"
```

Do not commit `.runtime/` reports unless the user explicitly asks for runtime artifacts in Git.

## Task 7: Review Results and Prepare Next Write Phase

**Files:**
- Read: `.runtime/ping-an-existing-repair-audit.json`
- Read: `.runtime/ping-an-missing-source-candidates.json`
- Read: `.runtime/ping-an-coverage-audit-summary.json`

- [ ] **Step 1: Summarize counts for the user**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const repair = JSON.parse(fs.readFileSync('.runtime/ping-an-existing-repair-audit.json', 'utf8'));
const missing = JSON.parse(fs.readFileSync('.runtime/ping-an-missing-source-candidates.json', 'utf8'));
const summary = JSON.parse(fs.readFileSync('.runtime/ping-an-coverage-audit-summary.json', 'utf8'));
console.log(JSON.stringify({
  localPingAnRecordCount: summary.localPingAnRecordCount,
  localPingAnProductCount: summary.localPingAnProductCount,
  externalSourceRecordCount: summary.externalSourceRecordCount,
  existingRepairCount: repair.summary.recordCount,
  existingRepairByAction: repair.summary.byRecommendedAction,
  missingCandidateCount: (missing.records || []).length,
  missingByReason: summary.missingCandidatesByReason,
  missingByQuality: summary.missingCandidatesByQuality,
}, null, 2));
NODE
```

Expected: output contains the counts needed to decide the next write phase.

- [ ] **Step 2: Inspect samples before proposing writes**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const missing = JSON.parse(fs.readFileSync('.runtime/ping-an-missing-source-candidates.json', 'utf8'));
const repair = JSON.parse(fs.readFileSync('.runtime/ping-an-existing-repair-audit.json', 'utf8'));
console.log(JSON.stringify({
  missingSamples: (missing.records || []).slice(0, 10).map((row) => ({
    productName: row.productName,
    issuerFullName: row.issuerFullName,
    missingReason: row.missingReason,
    quality: row.responsibilityQualityStatus,
    hasPdf: Boolean(row.pdfLocalPath),
    preview: String(row.responsibilityPreview || '').slice(0, 120),
  })),
  repairSamples: (repair.records || []).slice(0, 10).map((row) => ({
    id: row.id,
    productName: row.productName,
    action: row.recommendedAction,
    issues: row.issues,
  })),
}, null, 2));
NODE
```

Expected: samples are concrete Ping An products with traceable reasons.

- [ ] **Step 3: Report audit completion and stop before write phase**

Prepare a concise report:

```text
平安全量覆盖审计已完成。本次只读审计没有新增或修改 knowledge_records。

已入库待修复: <count> 条，按动作: <json>
未入库待新增: <count> 条，按原因: <json>，按责任质量: <json>
报告文件:
- .runtime/ping-an-existing-repair-audit.json
- .runtime/ping-an-missing-source-candidates.json
- .runtime/ping-an-coverage-audit-summary.json

下一步建议: 先从 missing candidates 中 valid_complete 且有 PDF 的记录开始写入；ambiguous_local_match 和 source_unusable 保持人工复核。
```

Expected: stop here and ask the user to approve the write phase. Do not write new records in this implementation plan.
