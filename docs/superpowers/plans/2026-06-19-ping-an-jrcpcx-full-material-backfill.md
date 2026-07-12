# Ping An JRCPCX Full Material Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Ping An Life-only JRCPCX backfill workflow that discovers non-truncated material shards, extracts terms PDF responsibility text, reconciles by material version, writes eligible records to local SQLite, and syncs inserted rows to the Ping An Feishu table.

**Architecture:** Keep browser/PDF extraction in the existing JRCPCX crawler, and add a focused Ping An backfill coordinator for pure planning, merging, reconciliation, and SQLite writes. All data writes are explicit modes with reports and DB backup paths. Feishu sync continues to use the existing `sync:feishu-knowledge` script and records the command outputs in a final report.

**Tech Stack:** Node.js ESM scripts, `node:test`, SQLite via existing `createKnowledgeStateStore`, existing `sync:feishu-knowledge`, `.runtime` JSON artifacts.

---

## Scope Check

The approved spec is one coherent subsystem: Ping An Life JRCPCX material-version backfill. It includes discovery, extraction, reconciliation, SQLite writes, and Feishu sync, but all parts are in one existing ingestion path and can be implemented in one plan with clear checkpoints.

This plan does not include Ping An Health, Ping An Pension, production publish, or OCR fallback for scanned PDFs.

## File Structure

- Modify: `scripts/crawl-jrcpcx-insurance-catalog.mjs`
  - Add reusable Ping An Life shard query planning and shard summary helpers.
  - Keep the existing crawler orchestration unchanged.
- Create: `scripts/ping-an-jrcpcx-backfill.mjs`
  - Owns Ping An-specific pure functions and CLI modes:
    - `plan-shards`
    - `merge-catalog`
    - `reconcile`
    - `insert`
    - `write-feishu-report`
- Modify: `tests/jrcpcx-insurance-catalog.test.mjs`
  - Cover shard query planning and truncation summary helpers.
- Create: `tests/ping-an-jrcpcx-backfill.test.mjs`
  - Cover material identity, catalog/detail merge priority, eligibility checks, coverage report grouping, and write payload mapping.
- Modify: `docs/harness-test-map.json`
  - Map the new backfill script to its focused tests.
- Runtime artifacts generated during execution:
  - `.runtime/jrcpcx-ping-an-life-shard-plan.json`
  - `.runtime/jrcpcx-ping-an-life-catalog-full.json`
  - `.runtime/jrcpcx-ping-an-life-responsibilities-full.json`
  - `.runtime/jrcpcx-ping-an-life-coverage-gap-full.json`
  - `.runtime/jrcpcx-ping-an-life-insert-report.json`
  - `.runtime/jrcpcx-ping-an-life-feishu-sync-report.json`

## Task 1: Add Ping An Life Shard Planning Helpers

**Files:**
- Modify: `scripts/crawl-jrcpcx-insurance-catalog.mjs`
- Modify: `tests/jrcpcx-insurance-catalog.test.mjs`

- [ ] **Step 1: Add failing tests for Ping An shard planning**

Add this import to `tests/jrcpcx-insurance-catalog.test.mjs`:

```js
import {
  buildPingAnLifeShardQueries,
  summarizeJrcpcxShardResults,
} from '../scripts/crawl-jrcpcx-insurance-catalog.mjs';
```

Add these tests:

```js
test('buildPingAnLifeShardQueries creates Ping An Life product keyword shards', () => {
  const queries = buildPingAnLifeShardQueries({
    keywords: ['年金', '终身'],
    statuses: ['在售', '停售'],
  });

  assert.equal(queries.length, 4);
  assert.deepEqual(queries[0], {
    deptName: '中国平安人寿保险股份有限公司',
    productName: '年金',
    productTypeLabel: '人身保险类',
    productTermLabel: '全部',
    productStateLabel: '在售',
  });
  assert.deepEqual(queries.at(-1), {
    deptName: '中国平安人寿保险股份有限公司',
    productName: '终身',
    productTypeLabel: '人身保险类',
    productTermLabel: '全部',
    productStateLabel: '停售',
  });
});

test('summarizeJrcpcxShardResults preserves unresolved truncated shards', () => {
  const summary = summarizeJrcpcxShardResults({
    queries: [
      {
        deptName: '中国平安人寿保险股份有限公司',
        productName: '年金',
        productStateLabel: '在售',
        rowCount: 50,
        truncated: true,
      },
      {
        deptName: '中国平安人寿保险股份有限公司',
        productName: '护理',
        productStateLabel: '停售',
        rowCount: 12,
        truncated: false,
      },
    ],
  });

  assert.equal(summary.queryCount, 2);
  assert.equal(summary.truncatedCount, 1);
  assert.deepEqual(summary.unresolvedShards, [
    {
      deptName: '中国平安人寿保险股份有限公司',
      productName: '年金',
      status: '在售',
      rowCount: 50,
      nextAction: 'split_keyword',
    },
  ]);
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
node --test tests/jrcpcx-insurance-catalog.test.mjs
```

Expected: FAIL because `buildPingAnLifeShardQueries` and `summarizeJrcpcxShardResults` are not exported.

- [ ] **Step 3: Implement shard planning helpers**

Add these constants and functions after `buildJrcpcxUiQueries` in `scripts/crawl-jrcpcx-insurance-catalog.mjs`:

```js
export const PING_AN_LIFE_DEPT_NAME = '中国平安人寿保险股份有限公司';
export const PING_AN_LIFE_PRODUCT_TYPE_LABEL = '人身保险类';
export const PING_AN_LIFE_STATUSES = ['在售', '停售', '停用'];
export const PING_AN_LIFE_KEYWORDS = [
  '附加',
  '终身',
  '年金',
  '两全',
  '医疗',
  '重疾',
  '疾病',
  '意外',
  '万能',
  '分红',
  '养老',
  '少儿',
  '护理',
  '教育',
  '金',
  '福',
  '安',
  '智',
  '鑫',
  '御',
  '盛世',
];

export function buildPingAnLifeShardQueries({
  keywords = PING_AN_LIFE_KEYWORDS,
  statuses = PING_AN_LIFE_STATUSES,
} = {}) {
  const normalizedKeywords = (Array.isArray(keywords) ? keywords : [])
    .map((item) => trim(item))
    .filter(Boolean);
  const normalizedStatuses = (Array.isArray(statuses) ? statuses : [])
    .map((item) => trim(item))
    .filter(Boolean);
  const queries = [];
  for (const productName of normalizedKeywords) {
    for (const productStateLabel of normalizedStatuses) {
      queries.push({
        deptName: PING_AN_LIFE_DEPT_NAME,
        productName,
        productTypeLabel: PING_AN_LIFE_PRODUCT_TYPE_LABEL,
        productTermLabel: '全部',
        productStateLabel,
      });
    }
  }
  return queries;
}

export function summarizeJrcpcxShardResults(result = {}) {
  const queries = Array.isArray(result.queries) ? result.queries : [];
  const rows = queries.map((query) => ({
    deptName: trim(query.deptName || query.queryDeptName),
    productName: trim(query.productName),
    status: trim(query.productStateLabel || query.queryProductState),
    rowCount: Number(query.rowCount || 0) || 0,
    truncated: Boolean(query.truncated),
    nextAction: query.truncated ? 'split_keyword' : 'complete',
  }));
  return {
    queryCount: rows.length,
    truncatedCount: rows.filter((row) => row.truncated).length,
    completeCount: rows.filter((row) => !row.truncated).length,
    shards: rows,
    unresolvedShards: rows
      .filter((row) => row.truncated)
      .map((row) => ({
        deptName: row.deptName,
        productName: row.productName,
        status: row.status,
        rowCount: row.rowCount,
        nextAction: row.nextAction,
      })),
  };
}
```

- [ ] **Step 4: Run the focused test and verify pass**

Run:

```bash
node --test tests/jrcpcx-insurance-catalog.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add scripts/crawl-jrcpcx-insurance-catalog.mjs tests/jrcpcx-insurance-catalog.test.mjs
git commit -m "feat: plan ping an jrcpcx shards"
```

## Task 2: Add Pure Backfill Merge And Reconcile Utilities

**Files:**
- Create: `scripts/ping-an-jrcpcx-backfill.mjs`
- Create: `tests/ping-an-jrcpcx-backfill.test.mjs`

- [ ] **Step 1: Write failing tests for material identity and eligibility**

Create `tests/ping-an-jrcpcx-backfill.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoverageGapReport,
  buildKnowledgeRecordFromJrcpcx,
  dedupeCatalogRows,
  eligibleForAutoInsert,
  materialIdentityKey,
  mergeDetailRowsPreferEvidence,
} from '../scripts/ping-an-jrcpcx-backfill.mjs';

test('materialIdentityKey prefers terms PDF URL and terms text code', () => {
  const key = materialIdentityKey({
    productName: '平安示例年金保险',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    detailFields: { 产品条款文字编码: '平安人寿〔2026〕年金保险001号' },
  });

  assert.equal(
    key,
    '平安示例年金保险\u001f平安人寿〔2026〕年金保险001号\u001fhttps://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
  );
});

test('dedupeCatalogRows keeps one row per issuer product industry code and detail URL', () => {
  const rows = dedupeCatalogRows([
    {
      deptName: '中国平安人寿保险股份有限公司',
      productName: '平安示例年金保险',
      industryCode: '平安人寿〔2026〕年金保险001号',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    },
    {
      deptName: '中国平安人寿保险股份有限公司',
      productName: '平安示例年金保险',
      industryCode: '平安人寿〔2026〕年金保险001号',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    },
  ]);

  assert.equal(rows.length, 1);
});

test('mergeDetailRowsPreferEvidence keeps the row with PDF and page text', () => {
  const rows = mergeDetailRowsPreferEvidence([
    {
      productName: '平安示例年金保险',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    },
    {
      productName: '平安示例年金保险',
      detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
      clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
      pdfLocalPath: '/tmp/example.pdf',
      pageText: '保险责任 年金给付',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].clauseUrl, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
});

test('eligibleForAutoInsert allows valid complete and valid partial with PDF evidence', () => {
  const base = {
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '人身保险类',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: '/tmp/example.pdf',
    pdfSha256: 'abc123',
    pageText: '保险责任 年金给付',
  };

  assert.equal(eligibleForAutoInsert({ ...base, qualityStatus: 'valid_complete' }).eligible, true);
  assert.equal(eligibleForAutoInsert({ ...base, qualityStatus: 'valid_partial' }).eligible, true);
  assert.equal(eligibleForAutoInsert({ ...base, qualityStatus: 'suspect_needs_source_check' }).eligible, false);
});

test('buildCoverageGapReport separates represented and insertable material gaps', () => {
  const report = buildCoverageGapReport({
    localRecords: [
      {
        id: 1,
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old',
      },
    ],
    detailRows: [
      {
        company: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=new',
        pdfLocalPath: '/tmp/example.pdf',
        pdfSha256: 'abc123',
        qualityStatus: 'valid_partial',
        pageText: '保险责任 年金给付',
      },
    ],
  });

  assert.equal(report.summary.insertableCount, 1);
  assert.equal(report.insertable[0].productName, '平安示例年金保险');
});

test('buildKnowledgeRecordFromJrcpcx maps detail rows to knowledge record fields', () => {
  const record = buildKnowledgeRecordFromJrcpcx({
    company: '中国平安人寿保险股份有限公司',
    productName: '平安示例年金保险',
    productType: '年金保险',
    salesStatus: '停售',
    title: '平安示例年金保险条款',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: '/tmp/example.pdf',
    pdfSha256: 'abc123',
    pdfBytes: 100,
    pageText: '保险责任 年金给付',
    qualityStatus: 'valid_partial',
    detailFields: { 产品条款文字编码: '平安人寿〔2026〕年金保险001号' },
  });

  assert.equal(record.url, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
  assert.equal(record.seedSourceUrl, 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1');
  assert.equal(record.evidenceLevel, 'regulatory_industry_terms');
  assert.equal(record.versionNo, '平安人寿〔2026〕年金保险001号');
});
```

- [ ] **Step 2: Run the new test and verify failure**

Run:

```bash
node --test tests/ping-an-jrcpcx-backfill.test.mjs
```

Expected: FAIL because `scripts/ping-an-jrcpcx-backfill.mjs` does not exist.

- [ ] **Step 3: Create pure backfill utility module**

Create `scripts/ping-an-jrcpcx-backfill.mjs` with these concrete helpers. Later tasks can add CLI code below these exports.

```js
import fs from 'node:fs';

export const PING_AN_LIFE_FULL_NAME = '中国平安人寿保险股份有限公司';
export const JRCPCX_TERMS_EVIDENCE_LABEL = '金融产品查询平台/中国保险行业协会条款 PDF';
export const JRCPCX_TERMS_EVIDENCE_LEVEL = 'regulatory_industry_terms';
export const JRCPCX_OFFICIAL_DOMAIN = 'inspdinfo.iachina.cn';
const SEP = '\u001f';

export function trim(value) {
  return String(value || '').trim();
}

export function normalizeProductName(value = '') {
  return trim(value)
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/[，]/gu, ',')
    .replace(/\s+/gu, '');
}

export function isPingAnLifeIssuer(value = '') {
  return trim(value).replace(/\s+/gu, '') === PING_AN_LIFE_FULL_NAME;
}

export function issuerFullNameOf(row = {}) {
  return trim(row.issuerFullName || row.company || row.companyName || row.deptName || row.queryDeptName || row.detailFields?.公司名称);
}

export function productNameOf(row = {}) {
  return trim(row.productName || row.product || row.detailFields?.产品名称);
}

export function detailUrlOf(row = {}) {
  return trim(row.detailUrl || row.sourceUrl || row.source);
}

export function clauseUrlOf(row = {}) {
  return trim(row.clauseUrl || row.pdfOriginalUrl || row.url);
}

export function termsTextCodeOf(row = {}) {
  return trim(row.versionNo || row.industryCode || row.detailFields?.产品条款文字编码);
}

export function materialIdentityKey(row = {}) {
  return [productNameOf(row), termsTextCodeOf(row), clauseUrlOf(row)].map(trim).join(SEP);
}

export function dedupeCatalogRows(rows = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = [
      issuerFullNameOf(row),
      productNameOf(row),
      trim(row.industryCode || row.detailFields?.产品条款文字编码),
      detailUrlOf(row) || trim(row.detailUrl),
    ].join(SEP);
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

function evidenceScore(row = {}) {
  return [
    clauseUrlOf(row) ? 16 : 0,
    trim(row.pdfLocalPath) ? 8 : 0,
    trim(row.pdfSha256) ? 4 : 0,
    trim(row.pageText) ? 2 : 0,
    termsTextCodeOf(row) ? 1 : 0,
  ].reduce((sum, value) => sum + value, 0);
}

export function mergeDetailRowsPreferEvidence(rows = []) {
  const byKey = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = detailUrlOf(row) || materialIdentityKey(row);
    const existing = byKey.get(key);
    if (!existing || evidenceScore(row) >= evidenceScore(existing)) byKey.set(key, row);
  }
  return [...byKey.values()];
}

export function eligibleForAutoInsert(row = {}) {
  const reasons = [];
  const issuer = issuerFullNameOf(row);
  const productName = productNameOf(row);
  const productType = trim(row.productType || row.productTypeLabel || row.queryProductType);
  const qualityStatus = trim(row.qualityStatus);
  const pdfLocalPath = trim(row.pdfLocalPath);
  if (!isPingAnLifeIssuer(issuer)) reasons.push('issuer_not_ping_an_life');
  if (!productName) reasons.push('missing_product_name');
  if (productType && productType !== '人身保险类' && !/保险/u.test(productType)) reasons.push('not_human_insurance');
  if (!detailUrlOf(row)) reasons.push('missing_detail_url');
  if (!clauseUrlOf(row)) reasons.push('missing_clause_url');
  if (!pdfLocalPath) reasons.push('missing_pdf_local_path');
  if (pdfLocalPath && !fs.existsSync(pdfLocalPath)) reasons.push('pdf_file_not_found');
  if (!trim(row.pdfSha256)) reasons.push('missing_pdf_sha256');
  if (!trim(row.pageText)) reasons.push('missing_page_text');
  if (!['valid_complete', 'valid_partial'].includes(qualityStatus)) reasons.push(`quality_${qualityStatus || 'blank'}`);
  return { eligible: reasons.length === 0, reasons };
}

export function buildKnowledgeRecordFromJrcpcx(row = {}) {
  const productName = productNameOf(row);
  return {
    company: PING_AN_LIFE_FULL_NAME,
    productName,
    productType: trim(row.productType),
    salesStatus: trim(row.salesStatus || row.productState || row.detailFields?.产品销售状态),
    title: trim(row.title) || `${productName}条款`,
    url: clauseUrlOf(row),
    snippet: trim(row.snippet) || `${JRCPCX_TERMS_EVIDENCE_LABEL}，已截取保险责任正文段。`,
    pageText: trim(row.pageText),
    sourceType: 'pdf',
    materialType: 'terms',
    official: true,
    evidenceLabel: JRCPCX_TERMS_EVIDENCE_LABEL,
    evidenceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
    officialDomain: JRCPCX_OFFICIAL_DOMAIN,
    parser: trim(row.parser) || 'jrcpcx_life_ins_detail',
    versionNo: termsTextCodeOf(row),
    catalogStatus: trim(row.salesStatus || row.productState || row.detailFields?.产品销售状态),
    seedSource: 'jrcpcx_ping_an_life_material_backfill',
    seedSourceUrl: detailUrlOf(row),
    qualityStatus: trim(row.qualityStatus),
    qualityReason: trim(row.qualityReason),
    pages: Number(row.pages || 0) || 0,
    bytes: Number(row.bytes || 0) || 0,
    contentType: trim(row.contentType),
    pdfLocalPath: trim(row.pdfLocalPath),
    pdfSha256: trim(row.pdfSha256),
    pdfBytes: Number(row.pdfBytes || row.bytes || 0) || 0,
    pdfOriginalUrl: trim(row.pdfOriginalUrl || row.clauseUrl),
    pdfArchivedAt: trim(row.pdfArchivedAt),
  };
}

export function buildCoverageGapReport({ localRecords = [], detailRows = [], unresolvedShards = [], generatedAt = new Date().toISOString() } = {}) {
  const localUrls = new Set((Array.isArray(localRecords) ? localRecords : []).map((row) => trim(row.url)).filter(Boolean));
  const represented = [];
  const insertable = [];
  const manualReview = [];
  const invalid = [];
  for (const row of mergeDetailRowsPreferEvidence(detailRows)) {
    const clauseUrl = clauseUrlOf(row);
    const eligibility = eligibleForAutoInsert(row);
    const item = {
      ...row,
      issuerFullName: issuerFullNameOf(row),
      productName: productNameOf(row),
      clauseUrl,
      detailUrl: detailUrlOf(row),
      versionNo: termsTextCodeOf(row),
      materialIdentityKey: materialIdentityKey(row),
      eligibilityReasons: eligibility.reasons,
    };
    if (clauseUrl && localUrls.has(clauseUrl)) represented.push(item);
    else if (eligibility.eligible) insertable.push(item);
    else if (['invalid_empty', 'invalid_non_responsibility', 'suspect_needs_source_check'].includes(trim(row.qualityStatus))) invalid.push(item);
    else manualReview.push(item);
  }
  return {
    generatedAt,
    summary: {
      representedCount: represented.length,
      insertableCount: insertable.length,
      manualReviewCount: manualReview.length,
      invalidCount: invalid.length,
      unresolvedShardCount: Array.isArray(unresolvedShards) ? unresolvedShards.length : 0,
    },
    represented,
    insertable,
    manualReview,
    invalid,
    unresolvedShards,
  };
}
```

Use the existing matching ideas from `scripts/audit-ping-an-coverage.mjs`, but keep the new script focused on Ping An JRCPCX backfill decisions.

- [ ] **Step 4: Run the new test and verify pass**

Run:

```bash
node --test tests/ping-an-jrcpcx-backfill.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add scripts/ping-an-jrcpcx-backfill.mjs tests/ping-an-jrcpcx-backfill.test.mjs
git commit -m "feat: reconcile ping an jrcpcx materials"
```

## Task 3: Add Backfill CLI Read-Only Modes

**Files:**
- Modify: `scripts/ping-an-jrcpcx-backfill.mjs`
- Modify: `tests/ping-an-jrcpcx-backfill.test.mjs`

- [ ] **Step 1: Add tests for artifact building helpers**

Add tests for these exported helpers:

```js
import {
  buildShardPlanArtifact,
  buildCatalogArtifact,
  buildResponsibilitiesArtifact,
} from '../scripts/ping-an-jrcpcx-backfill.mjs';
```

Test expectations:

```js
test('buildShardPlanArtifact includes unresolved truncated shards', () => {
  const artifact = buildShardPlanArtifact({
    generatedAt: '2026-06-19T00:00:00.000Z',
    shardSummary: {
      queryCount: 2,
      truncatedCount: 1,
      completeCount: 1,
      unresolvedShards: [{ productName: '年金', status: '在售', rowCount: 50, nextAction: 'split_keyword' }],
    },
  });

  assert.equal(artifact.summary.truncatedCount, 1);
  assert.equal(artifact.unresolvedShards[0].productName, '年金');
});

test('buildCatalogArtifact reports unique products and material candidates', () => {
  const artifact = buildCatalogArtifact({
    generatedAt: '2026-06-19T00:00:00.000Z',
    rows: [
      {
        deptName: '中国平安人寿保险股份有限公司',
        productName: '平安示例年金保险',
        industryCode: '平安人寿〔2026〕年金保险001号',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
      },
    ],
  });

  assert.equal(artifact.summary.rowCount, 1);
  assert.equal(artifact.summary.uniqueProductCount, 1);
  assert.equal(artifact.summary.uniqueMaterialCandidateCount, 1);
});

test('buildResponsibilitiesArtifact reports eligible quality distribution', () => {
  const artifact = buildResponsibilitiesArtifact({
    generatedAt: '2026-06-19T00:00:00.000Z',
    rows: [
      { productName: 'A', qualityStatus: 'valid_complete', clauseUrl: 'url-a' },
      { productName: 'B', qualityStatus: 'invalid_empty', clauseUrl: 'url-b' },
    ],
  });

  assert.equal(artifact.summary.recordCount, 2);
  assert.equal(artifact.summary.byQualityStatus.valid_complete, 1);
  assert.equal(artifact.summary.byQualityStatus.invalid_empty, 1);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test tests/ping-an-jrcpcx-backfill.test.mjs
```

Expected: FAIL because the artifact helper functions are not exported.

- [ ] **Step 3: Implement read-only CLI modes**

Add CLI support to `scripts/ping-an-jrcpcx-backfill.mjs`:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=plan-shards --write
node scripts/ping-an-jrcpcx-backfill.mjs --mode=merge-catalog --catalog-inputs=.runtime/a.json,.runtime/b.json --write
node scripts/ping-an-jrcpcx-backfill.mjs --mode=merge-responsibilities --detail-inputs=.runtime/details-a.json,.runtime/details-b.json --write
node scripts/ping-an-jrcpcx-backfill.mjs --mode=reconcile --responsibilities-path=.runtime/jrcpcx-ping-an-life-responsibilities-full.json --write
```

Mode outputs:

- `plan-shards` writes `.runtime/jrcpcx-ping-an-life-shard-plan.json`.
- `merge-catalog` writes `.runtime/jrcpcx-ping-an-life-catalog-full.json`.
- `merge-responsibilities` writes `.runtime/jrcpcx-ping-an-life-responsibilities-full.json`.
- `reconcile` writes `.runtime/jrcpcx-ping-an-life-coverage-gap-full.json`.

Read-only modes must not call `upsertKnowledgeRecords` and must not modify SQLite.

- [ ] **Step 4: Run focused tests and syntax check**

Run:

```bash
node --test tests/ping-an-jrcpcx-backfill.test.mjs
node --check scripts/ping-an-jrcpcx-backfill.mjs
```

Expected: PASS and no syntax errors.

- [ ] **Step 5: Commit Task 3**

Run:

```bash
git add scripts/ping-an-jrcpcx-backfill.mjs tests/ping-an-jrcpcx-backfill.test.mjs
git commit -m "feat: add ping an jrcpcx backfill reports"
```

## Task 4: Add SQLite Insert Mode With Backup And Report

**Files:**
- Modify: `scripts/ping-an-jrcpcx-backfill.mjs`
- Modify: `tests/ping-an-jrcpcx-backfill.test.mjs`

- [ ] **Step 1: Add tests for insert planning without touching real SQLite**

Add pure-function tests:

```js
import {
  buildInsertPlan,
  buildInsertReport,
} from '../scripts/ping-an-jrcpcx-backfill.mjs';
```

Use this test:

```js
test('buildInsertPlan includes only eligible insertable records and skips existing URLs', () => {
  const plan = buildInsertPlan({
    insertable: [
      {
        productName: '平安示例年金保险',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=new',
        qualityStatus: 'valid_complete',
        pageText: '保险责任 年金给付',
        pdfLocalPath: '/tmp/example.pdf',
        pdfSha256: 'abc123',
        company: '中国平安人寿保险股份有限公司',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
      },
      {
        productName: '平安示例医疗保险',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old',
        qualityStatus: 'valid_complete',
        pageText: '保险责任 医疗保险金',
        pdfLocalPath: '/tmp/example-old.pdf',
        pdfSha256: 'old123',
        company: '中国平安人寿保险股份有限公司',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2',
      },
    ],
    existingUrls: new Set(['https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old']),
  });

  assert.equal(plan.recordsToInsert.length, 1);
  assert.equal(plan.skipped[0].reason, 'existing_url');
});

test('buildInsertReport records before after counts and inserted IDs', () => {
  const report = buildInsertReport({
    dbPath: '/tmp/policy-ocr.sqlite',
    dbBackupPath: '/tmp/backup.sqlite',
    before: 10,
    after: 12,
    saved: [{ id: 101 }, { id: 102 }],
    skipped: [],
  });

  assert.equal(report.insertedCount, 2);
  assert.equal(report.insertedMinId, 101);
  assert.equal(report.insertedMaxId, 102);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
node --test tests/ping-an-jrcpcx-backfill.test.mjs
```

Expected: FAIL because insert helper functions are not exported.

- [ ] **Step 3: Implement insert mode**

Add `--mode=insert` to `scripts/ping-an-jrcpcx-backfill.mjs`.

Behavior:

- Read `.runtime/jrcpcx-ping-an-life-coverage-gap-full.json` by default.
- Require `--write` for SQLite changes.
- Copy `.runtime/policy-ocr.sqlite` to `.runtime/backups/policy-ocr-before-ping-an-jrcpcx-backfill-<timestamp>.sqlite`.
- Load existing URLs with `createKnowledgeStateStore`.
- Use `upsertKnowledgeRecords` and `allocateId`.
- Write `.runtime/jrcpcx-ping-an-life-insert-report.json`.
- Print the report JSON.

Insert mode command:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=insert --write
```

- [ ] **Step 4: Run focused tests and syntax check**

Run:

```bash
node --test tests/ping-an-jrcpcx-backfill.test.mjs
node --check scripts/ping-an-jrcpcx-backfill.mjs
```

Expected: PASS and no syntax errors.

- [ ] **Step 5: Commit Task 4**

Run:

```bash
git add scripts/ping-an-jrcpcx-backfill.mjs tests/ping-an-jrcpcx-backfill.test.mjs
git commit -m "feat: write ping an jrcpcx backfill rows"
```

## Task 5: Add Harness Mapping For New Backfill Script

**Files:**
- Modify: `docs/harness-test-map.json`

- [ ] **Step 1: Inspect existing harness mapping style**

Run:

```bash
sed -n '1,120p' docs/harness-test-map.json
```

Expected: JSON map with script-to-test entries.

- [ ] **Step 2: Add mapping for new script**

Add an entry mapping:

- Source: `scripts/ping-an-jrcpcx-backfill.mjs`
- Tests: `tests/ping-an-jrcpcx-backfill.test.mjs`
- Command: `node --test tests/ping-an-jrcpcx-backfill.test.mjs`

Do not remove or reformat unrelated entries.

- [ ] **Step 3: Run JSON parse and focused tests**

Run:

```bash
node --input-type=module -e "const fs=await import('node:fs/promises'); JSON.parse(await fs.readFile('docs/harness-test-map.json','utf8')); console.log('ok')"
node --test tests/jrcpcx-insurance-catalog.test.mjs tests/ping-an-jrcpcx-backfill.test.mjs
```

Expected: JSON parse prints `ok`; tests PASS.

- [ ] **Step 4: Commit Task 5**

Run:

```bash
git add docs/harness-test-map.json
git commit -m "test: map ping an jrcpcx backfill test"
```

## Task 6: Generate Read-Only Shard And Catalog Artifacts

**Files:**
- Runtime output only under `.runtime/`

- [ ] **Step 1: Generate shard plan**

Run:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=plan-shards --write
```

Expected: `.runtime/jrcpcx-ping-an-life-shard-plan.json` exists and prints a JSON summary.

- [ ] **Step 2: Use shard plan as crawler query file**

Run:

```bash
node scripts/crawl-jrcpcx-insurance-catalog.mjs --ui --query-file=.runtime/jrcpcx-ping-an-life-shard-plan.json --fetch-detail-links --wait-ms=180000 --write --catalog-path=.runtime/jrcpcx-ping-an-life-catalog-shards-raw.json
```

Expected: crawler prints JSON with `ok: true`, `queryCount` greater than zero, and a catalog path.

- [ ] **Step 3: Merge catalog rows**

Run:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=merge-catalog --catalog-inputs=.runtime/jrcpcx-ping-an-life-catalog-shards-raw.json --write
```

Expected: `.runtime/jrcpcx-ping-an-life-catalog-full.json` exists and reports row count, unique product count, and unique material candidate count.

- [ ] **Step 4: Inspect unresolved shard count**

Run:

```bash
node --input-type=module -e "const fs=await import('node:fs/promises'); const p=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-shard-plan.json','utf8')); console.log(JSON.stringify(p.summary||p, null, 2));"
```

Expected: Summary includes `truncatedCount`. If `truncatedCount` is greater than zero, add narrower keywords in Task 1 helper constants and repeat Task 6 before extracting details.

- [ ] **Step 5: Commit code only if keyword constants changed**

If Task 6 Step 4 required keyword changes, run:

```bash
git add scripts/crawl-jrcpcx-insurance-catalog.mjs tests/jrcpcx-insurance-catalog.test.mjs
git commit -m "fix: refine ping an jrcpcx shard keywords"
```

Expected: commit only if code or tests changed. Runtime `.runtime` artifacts stay uncommitted.

## Task 7: Extract Terms PDF Responsibilities

**Files:**
- Runtime output only under `.runtime/`

- [ ] **Step 1: Build detail query file from full catalog**

Run:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=detail-query-file --catalog-path=.runtime/jrcpcx-ping-an-life-catalog-full.json --write
```

Expected: `.runtime/jrcpcx-ping-an-life-detail-queries.json` exists and contains deduped detail URL tasks.

- [ ] **Step 2: Extract PDF responsibilities**

Run:

```bash
node scripts/crawl-jrcpcx-insurance-catalog.mjs --ui --query-file=.runtime/jrcpcx-ping-an-life-detail-queries.json --extract-responsibility --wait-ms=180000 --write --catalog-path=.runtime/jrcpcx-ping-an-life-responsibilities-raw.json
```

Expected: crawler prints JSON with `recordCount` and `responsibilityCount`; PDFs are archived under `.runtime/policy-material-pdfs/`.

- [ ] **Step 3: Merge responsibility rows**

Run:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=merge-responsibilities --detail-inputs=.runtime/jrcpcx-ping-an-life-responsibilities-raw.json --write
```

Expected: `.runtime/jrcpcx-ping-an-life-responsibilities-full.json` exists and reports quality distribution.

- [ ] **Step 4: Inspect quality distribution**

Run:

```bash
node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-responsibilities-full.json','utf8')); console.log(JSON.stringify(r.summary, null, 2));"
```

Expected: Summary shows counts for `valid_complete`, `valid_partial`, and invalid statuses.

## Task 8: Reconcile Against SQLite And Review Candidates

**Files:**
- Runtime output only under `.runtime/`

- [ ] **Step 1: Build coverage gap report**

Run:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=reconcile --responsibilities-path=.runtime/jrcpcx-ping-an-life-responsibilities-full.json --write
```

Expected: `.runtime/jrcpcx-ping-an-life-coverage-gap-full.json` exists and reports represented, insertable, manual-review, invalid, and unresolved counts.

- [ ] **Step 2: Inspect insertable samples**

Run:

```bash
node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-coverage-gap-full.json','utf8')); console.log(JSON.stringify({summary:r.summary, sample:(r.insertable||[]).slice(0,10).map(x=>({productName:x.productName, qualityStatus:x.qualityStatus, pageTextChars:String(x.pageText||'').length, clauseUrl:x.clauseUrl, pdfLocalPath:x.pdfLocalPath}))}, null, 2));"
```

Expected: Insertable samples have non-empty `clauseUrl`, `pdfLocalPath`, and responsibility text length.

- [ ] **Step 3: Stop for manual review if invalid or unresolved counts are unexpectedly high**

Run:

```bash
node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-coverage-gap-full.json','utf8')); const s=r.summary||{}; console.log(JSON.stringify({insertable:s.insertableCount||0, manualReview:s.manualReviewCount||0, invalid:s.invalidCount||0, unresolved:s.unresolvedShardCount||0}, null, 2)); process.exit((s.unresolvedShardCount||0)>0 ? 2 : 0);"
```

Expected: exit code 0 when no unresolved shards remain. If exit code 2, report unresolved shards to the user before writes.

## Task 9: Write Eligible Rows To Local SQLite

**Files:**
- Runtime output only under `.runtime/`
- Mutates: `.runtime/policy-ocr.sqlite`

- [ ] **Step 1: Run insert mode with write flag**

Run:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=insert --coverage-path=.runtime/jrcpcx-ping-an-life-coverage-gap-full.json --write
```

Expected: `.runtime/jrcpcx-ping-an-life-insert-report.json` exists. Output reports DB path, backup path, inserted count, min ID, and max ID.

- [ ] **Step 2: Verify inserted ID range is retrievable**

Run:

```bash
node --input-type=module -e "import { createKnowledgeStateStore } from './scripts/runtime-knowledge-state.mjs'; const fs=await import('node:fs/promises'); const report=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); const store=await createKnowledgeStateStore(); const state=store.loadState(); const ids=new Set((report.saved||[]).map(x=>Number(x.id))); const found=state.knowledgeRecords.filter(r=>ids.has(Number(r.id))); console.log(JSON.stringify({expected:ids.size, found:found.length, dbPath:store.dbPath}, null, 2)); store.close(); if(found.length!==ids.size) process.exit(2);"
```

Expected: `expected` equals `found`.

- [ ] **Step 3: Run focused tests after write**

Run:

```bash
node --test tests/jrcpcx-insurance-catalog.test.mjs tests/ping-an-jrcpcx-backfill.test.mjs tests/ping-an-coverage-audit.test.mjs
```

Expected: PASS.

## Task 10: Sync Inserted Rows To Feishu

**Files:**
- Runtime output only under `.runtime/`

- [ ] **Step 1: Print inserted ID range**

Run:

```bash
node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); console.log(JSON.stringify({min:r.insertedMinId, max:r.insertedMaxId, count:r.insertedCount}, null, 2));"
```

Expected: count is greater than zero when there were new rows.

- [ ] **Step 2: Run Feishu dry-run before sync and save output**

Run:

```bash
npm run sync:feishu-knowledge -- --config-path=.runtime/feishu-knowledge-ping-an.json --local-id-min="$(node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); process.stdout.write(String(r.insertedMinId||0));")" --local-id-max="$(node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); process.stdout.write(String(r.insertedMaxId||0));")" --create-only --skip-existing-local-ids --dry-run | tee .runtime/jrcpcx-ping-an-life-feishu-dry-run-before.txt
```

Expected: output shows pending rows equal to the inserted count.

- [ ] **Step 3: Run Feishu create-only sync and save output**

Run:

```bash
npm run sync:feishu-knowledge -- --config-path=.runtime/feishu-knowledge-ping-an.json --local-id-min="$(node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); process.stdout.write(String(r.insertedMinId||0));")" --local-id-max="$(node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); process.stdout.write(String(r.insertedMaxId||0));")" --create-only --skip-existing-local-ids --batch-size=10 | tee .runtime/jrcpcx-ping-an-life-feishu-sync.txt
```

Expected: output reports synced records with created count and zero updates.

- [ ] **Step 4: Run Feishu dry-run after sync and save output**

Run:

```bash
npm run sync:feishu-knowledge -- --config-path=.runtime/feishu-knowledge-ping-an.json --local-id-min="$(node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); process.stdout.write(String(r.insertedMinId||0));")" --local-id-max="$(node --input-type=module -e "const fs=await import('node:fs/promises'); const r=JSON.parse(await fs.readFile('.runtime/jrcpcx-ping-an-life-insert-report.json','utf8')); process.stdout.write(String(r.insertedMaxId||0));")" --create-only --skip-existing-local-ids --dry-run | tee .runtime/jrcpcx-ping-an-life-feishu-dry-run-after.txt
```

Expected: output shows all inserted IDs skipped as already remote, with zero pending rows.

- [ ] **Step 5: Build Feishu sync report**

Run:

```bash
node scripts/ping-an-jrcpcx-backfill.mjs --mode=write-feishu-report --insert-report=.runtime/jrcpcx-ping-an-life-insert-report.json --dry-run-before=.runtime/jrcpcx-ping-an-life-feishu-dry-run-before.txt --sync-output=.runtime/jrcpcx-ping-an-life-feishu-sync.txt --dry-run-after=.runtime/jrcpcx-ping-an-life-feishu-dry-run-after.txt --write
```

Expected: `.runtime/jrcpcx-ping-an-life-feishu-sync-report.json` exists and reports pending-after as zero.

## Task 11: Final Verification And Summary

**Files:**
- Runtime output only under `.runtime/`

- [ ] **Step 1: Run full focused verification**

Run:

```bash
node --test tests/jrcpcx-insurance-catalog.test.mjs tests/ping-an-jrcpcx-backfill.test.mjs tests/ping-an-coverage-audit.test.mjs
node --check scripts/crawl-jrcpcx-insurance-catalog.mjs
node --check scripts/ping-an-jrcpcx-backfill.mjs
```

Expected: tests PASS and syntax checks return no output.

- [ ] **Step 2: Print final artifact summary**

Run:

```bash
node --input-type=module -e "const fs=await import('node:fs/promises'); const files=['.runtime/jrcpcx-ping-an-life-shard-plan.json','.runtime/jrcpcx-ping-an-life-catalog-full.json','.runtime/jrcpcx-ping-an-life-responsibilities-full.json','.runtime/jrcpcx-ping-an-life-coverage-gap-full.json','.runtime/jrcpcx-ping-an-life-insert-report.json','.runtime/jrcpcx-ping-an-life-feishu-sync-report.json']; const out={}; for(const file of files){ const data=JSON.parse(await fs.readFile(file,'utf8')); out[file]=data.summary||{insertedCount:data.insertedCount, insertedMinId:data.insertedMinId, insertedMaxId:data.insertedMaxId, syncedAt:data.syncedAt}; } console.log(JSON.stringify(out,null,2));"
```

Expected: output includes shard, catalog, responsibility, coverage, insert, and Feishu summaries.

- [ ] **Step 3: Commit implementation code**

Run:

```bash
git status --short
git add scripts/crawl-jrcpcx-insurance-catalog.mjs scripts/ping-an-jrcpcx-backfill.mjs tests/jrcpcx-insurance-catalog.test.mjs tests/ping-an-jrcpcx-backfill.test.mjs docs/harness-test-map.json
git commit -m "feat: backfill ping an jrcpcx materials"
```

Expected: commit includes only code, tests, and harness mapping. Runtime `.runtime` artifacts remain uncommitted.

## Self-Review Checklist

- Spec coverage:
  - Ping An Life-only scope: Tasks 1, 2, and 6.
  - Material-version matching: Tasks 2, 3, and 8.
  - `valid_complete` plus `valid_partial` writes: Tasks 2 and 4.
  - SQLite backup and insert report: Task 4 and Task 9.
  - Feishu sync and post-sync dry-run: Task 10.
  - Unresolved truncated shards: Tasks 1, 3, 6, and 8.
- Placeholder scan:
  - No plan step uses empty stand-ins for paths, commands, or files.
- Type consistency:
  - Function names used in tests are introduced in the same task before downstream tasks use them.
  - Runtime artifact names match the approved spec.
