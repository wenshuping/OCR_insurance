# JRCPCX Major Company Gap Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill 阳光人寿 and 人保寿险 JRCPCX terms PDF responsibility records into local SQLite and Feishu with traceable artifacts.

**Architecture:** Add one generic JRCPCX major-company Node helper for query planning, coverage reconciliation, insert planning, SQLite writes, and reports. Add one Python pipe-browser runner that reuses `server/scrapling-policy-crawler.py` JRCPCX functions without relying on Chrome HTTP CDP. Keep existing Ping An scripts untouched.

**Tech Stack:** Node ESM, `node:test`, existing SQLite knowledge store in `scripts/runtime-knowledge-state.mjs`, existing Feishu sync script, Scrapling Python virtualenv, Playwright persistent browser pipe.

---

## Files

- Create: `scripts/jrcpcx-major-company-gap-backfill.mjs`
  - Owns target company config, gap-to-query conversion, generic JRCPCX eligibility, coverage artifacts, insert reports, and SQLite write mode.
- Create: `scripts/jrcpcx-pipe-major-company-crawl.py`
  - Opens a visible Playwright persistent browser and calls `jrcpcx_set_visible_page_size`, `jrcpcx_query_visible_page`, and `jrcpcx_fetch_life_ins_detail` from `server/scrapling-policy-crawler.py`.
- Create: `tests/jrcpcx-major-company-gap-backfill.test.mjs`
  - Verifies target company config, human-insurance eligibility, URL normalization, query planning from gap files, insert plan behavior, and record mapping.
- Runtime artifacts only during execution:
  - `.runtime/jrcpcx-major-company-gap-<stamp>-queries.json`
  - `.runtime/jrcpcx-major-company-gap-<stamp>-catalog.json`
  - `.runtime/jrcpcx-major-company-gap-<stamp>-coverage-gap.json`
  - `.runtime/jrcpcx-major-company-gap-<stamp>-insert-plan.json`
  - `.runtime/jrcpcx-major-company-gap-<stamp>-insert-report.json`
  - `.runtime/jrcpcx-major-company-gap-<stamp>-feishu-sync-report.json`

## Task 1: Add Generic Backfill Tests

**Files:**
- Create: `tests/jrcpcx-major-company-gap-backfill.test.mjs`
- Create later: `scripts/jrcpcx-major-company-gap-backfill.mjs`

- [ ] **Step 1: Write the failing test file**

Create `tests/jrcpcx-major-company-gap-backfill.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TARGET_COMPANIES,
  buildInsertPlan,
  buildJrcpcxQueriesFromGap,
  buildKnowledgeRecordFromJrcpcx,
  companyConfigForIssuer,
  eligibleForAutoInsert,
  normalizeClauseUrl,
} from '../scripts/jrcpcx-major-company-gap-backfill.mjs';

const pdfFixturePath = path.join(os.tmpdir(), 'jrcpcx-major-company-gap-fixture.pdf');

function ensurePdfFixture() {
  fs.writeFileSync(pdfFixturePath, '%PDF-1.4\n% test fixture\n');
  return pdfFixturePath;
}

test('target company config maps 阳光 and 人保 to Feishu configs', () => {
  assert.equal(TARGET_COMPANIES.length, 2);
  assert.equal(companyConfigForIssuer('阳光人寿保险股份有限公司').localCompany, '阳光人寿');
  assert.equal(companyConfigForIssuer('中国人民人寿保险股份有限公司').localCompany, '人保寿险');
  assert.equal(companyConfigForIssuer('中国平安人寿保险股份有限公司'), null);
});

test('buildJrcpcxQueriesFromGap keeps only target human-insurance candidates', () => {
  const queries = buildJrcpcxQueriesFromGap({
    missingCandidates: [
      {
        queryDeptName: '阳光人寿保险股份有限公司',
        productName: '阳光人寿附加意外伤害保险',
        productState: '停用',
        productType: '人身保险类',
      },
      {
        queryDeptName: '中国人民人寿保险股份有限公司',
        productName: '人保寿险康乐年华两全保险',
        productState: '在售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '中国平安人寿保险股份有限公司',
        productName: '平安示例',
        productState: '停售',
        productType: '人身保险类',
      },
      {
        queryDeptName: '阳光人寿保险股份有限公司',
        productName: '阳光财产示例',
        productState: '停售',
        productType: '财产保险类',
      },
    ],
  });

  assert.deepEqual(
    queries.map((row) => [row.deptName, row.productName, row.productStateLabel]),
    [
      ['阳光人寿保险股份有限公司', '阳光人寿附加意外伤害保险', '停用'],
      ['中国人民人寿保险股份有限公司', '人保寿险康乐年华两全保险', '在售'],
    ],
  );
});

test('eligibleForAutoInsert accepts target company human-insurance rows with PDF evidence', () => {
  const result = eligibleForAutoInsert({
    company: '阳光人寿保险股份有限公司',
    productName: '阳光人寿附加意外伤害保险',
    productType: '人身保险类',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 意外身故保险金',
    qualityStatus: 'valid_complete',
  });

  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
});

test('eligibleForAutoInsert rejects non-target issuer and property insurance', () => {
  const base = {
    productName: '示例产品',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 示例责任',
    qualityStatus: 'valid_complete',
  };

  assert.deepEqual(eligibleForAutoInsert({ ...base, company: '中国平安人寿保险股份有限公司', productType: '人身保险类' }).reasons, ['issuer_not_target']);
  assert.deepEqual(eligibleForAutoInsert({ ...base, company: '阳光人寿保险股份有限公司', productType: '财产保险类' }).reasons, ['not_human_insurance']);
});

test('buildInsertPlan skips normalized existing clause URLs', () => {
  const plan = buildInsertPlan({
    insertable: [
      {
        company: '中国人民人寿保险股份有限公司',
        productName: '人保寿险示例年金保险',
        productType: '人身保险类',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=222&info=old',
        pdfLocalPath: ensurePdfFixture(),
        pdfSha256: 'old123',
        pageText: '保险责任 年金给付',
        qualityStatus: 'valid_partial',
      },
    ],
    existingUrls: ['https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old&t=111'],
  });

  assert.equal(plan.recordsToInsert.length, 0);
  assert.equal(plan.skipped[0].reason, 'existing_url');
});

test('buildKnowledgeRecordFromJrcpcx maps official evidence fields', () => {
  const record = buildKnowledgeRecordFromJrcpcx({
    company: '阳光人寿保险股份有限公司',
    productName: '阳光人寿附加意外伤害保险',
    productType: '人身保险类',
    salesStatus: '停用',
    detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
    clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=111&info=abc',
    pdfLocalPath: ensurePdfFixture(),
    pdfSha256: 'abc123',
    pageText: '保险责任 意外身故保险金',
    qualityStatus: 'valid_complete',
    detailFields: { 产品条款文字编码: '阳光人寿〔2020〕意外伤害保险001号' },
  });

  assert.equal(record.company, '阳光人寿保险股份有限公司');
  assert.equal(record.url, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
  assert.equal(record.seedSourceUrl, 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1');
  assert.equal(record.sourceType, 'pdf');
  assert.equal(record.materialType, 'terms');
  assert.equal(record.officialDomain, 'inspdinfo.iachina.cn');
  assert.equal(record.responsibilityQualityStatus, 'valid_complete');
  assert.equal(record.versionNo, '阳光人寿〔2020〕意外伤害保险001号');
});

test('normalizeClauseUrl removes volatile t parameter and sorts params', () => {
  assert.equal(
    normalizeClauseUrl('https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=2&info=abc&data=1'),
    'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?data=1&info=abc',
  );
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs
```

Expected: FAIL with `Cannot find module '../scripts/jrcpcx-major-company-gap-backfill.mjs'`.

## Task 2: Add Generic Major-Company Backfill Helper

**Files:**
- Create: `scripts/jrcpcx-major-company-gap-backfill.mjs`
- Test: `tests/jrcpcx-major-company-gap-backfill.test.mjs`

- [ ] **Step 1: Implement exported helper functions and CLI modes**

Create `scripts/jrcpcx-major-company-gap-backfill.mjs` with:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  clauseUrlOf,
  detailUrlOf,
  isHumanInsuranceProductType,
  materialIdentityKey,
  mergeDetailRowsPreferEvidence,
  normalizeClauseUrl,
  productNameOf,
  termsTextCodeOf,
} from './ping-an-jrcpcx-backfill.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const DEFAULT_DB_PATH = path.join(runtimeDir, 'policy-ocr.sqlite');
const JRCPCX_TERMS_EVIDENCE_LABEL = '金融产品查询平台/中国保险行业协会条款 PDF';
const JRCPCX_TERMS_EVIDENCE_LEVEL = 'regulatory_industry_terms';
const JRCPCX_OFFICIAL_DOMAIN = 'inspdinfo.iachina.cn';

export { normalizeClauseUrl };

export const TARGET_COMPANIES = [
  {
    issuerFullName: '阳光人寿保险股份有限公司',
    localCompany: '阳光人寿',
    feishuConfigPath: '.runtime/feishu-knowledge-sunshine-life.json',
    feishuTableName: '阳光人寿',
  },
  {
    issuerFullName: '中国人民人寿保险股份有限公司',
    localCompany: '人保寿险',
    feishuConfigPath: '.runtime/feishu-knowledge-picc-life.json',
    feishuTableName: '人保寿险',
  },
];

function trim(value) {
  return String(value || '').trim();
}

function normalizeCompany(value = '') {
  return trim(value).replace(/\s+/gu, '');
}

function readJsonFile(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value, pretty = true) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function readArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export function companyConfigForIssuer(value = '') {
  const normalized = normalizeCompany(value);
  return TARGET_COMPANIES.find((company) => normalizeCompany(company.issuerFullName) === normalized || normalizeCompany(company.localCompany) === normalized) || null;
}

function issuerFullNameOf(row = {}) {
  return trim(row.issuerFullName || row.company || row.companyName || row.deptName || row.queryDeptName || row.detailFields?.公司名称);
}

function salesStatusOf(row = {}) {
  return trim(row.salesStatus || row.productState || row.productStateLabel || row.queryProductState || row.detailFields?.产品销售状态) || '全部';
}

export function buildJrcpcxQueriesFromGap(gap = {}) {
  const candidates = Array.isArray(gap.missingCandidates) ? gap.missingCandidates : [];
  const seen = new Set();
  const queries = [];
  for (const candidate of candidates) {
    const issuer = issuerFullNameOf(candidate);
    const config = companyConfigForIssuer(issuer);
    const productName = productNameOf(candidate);
    const productType = trim(candidate.productType || candidate.queryProductType || candidate.productTypeLabel);
    if (!config || !productName || !isHumanInsuranceProductType(productType)) continue;
    const query = {
      deptName: config.issuerFullName,
      productName,
      productTypeLabel: '人身保险类',
      productTermLabel: '全部',
      productStateLabel: salesStatusOf(candidate),
    };
    const key = [query.deptName, query.productName, query.productStateLabel].join('\u001f');
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push(query);
  }
  return queries;
}

export function eligibleForAutoInsert(row = {}) {
  const reasons = [];
  const issuer = issuerFullNameOf(row);
  const productName = productNameOf(row);
  const productType = trim(row.productType || row.productTypeLabel || row.queryProductType);
  const qualityStatus = trim(row.qualityStatus || row.responsibilityQualityStatus);
  const pdfLocalPath = trim(row.pdfLocalPath);
  if (!companyConfigForIssuer(issuer)) reasons.push('issuer_not_target');
  if (!productName) reasons.push('missing_product_name');
  if (!isHumanInsuranceProductType(productType)) reasons.push(productType ? 'not_human_insurance' : 'missing_product_type');
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
  const issuer = issuerFullNameOf(row);
  const config = companyConfigForIssuer(issuer);
  const productName = productNameOf(row);
  return {
    company: config?.issuerFullName || issuer,
    productName,
    productType: trim(row.productType),
    salesStatus: salesStatusOf(row),
    title: trim(row.title) || `${productName}条款`,
    url: clauseUrlOf(row),
    snippet: `${JRCPCX_TERMS_EVIDENCE_LABEL}，已截取保险责任正文段。`,
    pageText: trim(row.pageText),
    sourceType: 'pdf',
    materialType: 'terms',
    official: true,
    evidenceLabel: JRCPCX_TERMS_EVIDENCE_LABEL,
    evidenceLevel: JRCPCX_TERMS_EVIDENCE_LEVEL,
    officialDomain: JRCPCX_OFFICIAL_DOMAIN,
    parser: trim(row.parser) || 'jrcpcx_life_ins_detail',
    versionNo: termsTextCodeOf(row),
    catalogStatus: salesStatusOf(row),
    seedSource: 'jrcpcx_major_company_gap_backfill',
    seedSourceUrl: detailUrlOf(row),
    qualityStatus: trim(row.qualityStatus || row.responsibilityQualityStatus),
    responsibilityQualityStatus: trim(row.responsibilityQualityStatus || row.qualityStatus),
    qualityReason: trim(row.qualityReason),
    pages: Number(row.pages || 0) || 0,
    bytes: Number(row.bytes || 0) || 0,
    contentType: trim(row.contentType),
    pdfLocalPath: trim(row.pdfLocalPath),
    pdfFilePath: trim(row.pdfLocalPath),
    pdfSha256: trim(row.pdfSha256),
    pdfFileHash: trim(row.pdfSha256),
    pdfBytes: Number(row.pdfBytes || row.bytes || 0) || 0,
    pdfOriginalUrl: trim(row.pdfOriginalUrl || row.clauseUrl),
    pdfArchivedAt: trim(row.pdfArchivedAt),
    evidence: row.evidence,
  };
}

export function buildInsertPlan({ insertable = [], existingUrls = [] } = {}) {
  const existingUrlSet = new Set(
    (existingUrls instanceof Set ? [...existingUrls] : existingUrls)
      .map((value) => normalizeClauseUrl(typeof value === 'string' ? value : value?.url))
      .filter(Boolean),
  );
  const recordsToInsert = [];
  const skipped = [];
  for (const row of Array.isArray(insertable) ? insertable : []) {
    const eligibility = eligibleForAutoInsert(row);
    const clauseUrl = clauseUrlOf(row);
    if (!eligibility.eligible) {
      skipped.push({ reason: eligibility.reasons[0] || 'ineligible', reasons: eligibility.reasons, productName: productNameOf(row), clauseUrl, detailUrl: detailUrlOf(row), materialIdentityKey: materialIdentityKey(row) });
      continue;
    }
    if (clauseUrl && existingUrlSet.has(clauseUrl)) {
      skipped.push({ reason: 'existing_url', reasons: ['existing_url'], productName: productNameOf(row), clauseUrl, detailUrl: detailUrlOf(row), materialIdentityKey: materialIdentityKey(row) });
      continue;
    }
    recordsToInsert.push(buildKnowledgeRecordFromJrcpcx(row));
  }
  return { recordsToInsert, skipped };
}

export function buildCoverageGapReport({ localRecords = [], detailRows = [], generatedAt = new Date().toISOString() } = {}) {
  const localUrls = new Set(localRecords.map((row) => normalizeClauseUrl(row.url)).filter(Boolean));
  const represented = [];
  const insertable = [];
  const manualReview = [];
  const invalid = [];
  for (const row of mergeDetailRowsPreferEvidence(detailRows)) {
    const item = {
      ...row,
      issuerFullName: issuerFullNameOf(row),
      productName: productNameOf(row),
      clauseUrl: clauseUrlOf(row),
      detailUrl: detailUrlOf(row),
      versionNo: termsTextCodeOf(row),
      materialIdentityKey: materialIdentityKey(row),
      eligibilityReasons: eligibleForAutoInsert(row).reasons,
    };
    if (item.clauseUrl && localUrls.has(item.clauseUrl)) represented.push(item);
    else if (eligibleForAutoInsert(item).eligible) insertable.push(item);
    else if (['invalid_empty', 'invalid_non_responsibility', 'suspect_needs_source_check'].includes(trim(item.qualityStatus))) invalid.push(item);
    else manualReview.push(item);
  }
  return {
    schemaVersion: 'jrcpcx-major-company-coverage-gap/v1',
    generatedAt,
    targetCompanies: TARGET_COMPANIES,
    summary: {
      representedCount: represented.length,
      insertableCount: insertable.length,
      manualReviewCount: manualReview.length,
      invalidCount: invalid.length,
    },
    represented,
    insertable,
    manualReview,
    invalid,
  };
}

async function loadLocalRecords(dbPath) {
  const { createKnowledgeStateStore } = await import('./runtime-knowledge-state.mjs');
  const store = await createKnowledgeStateStore({ dbPath });
  try {
    return { dbPath: store.dbPath, records: store.loadState().knowledgeRecords, count: store.countKnowledgeRecords(), urls: store.allKnownUrls() };
  } finally {
    store.close();
  }
}

function buildInsertReport({ generatedAt, dryRun, dbPath, dbBackupPath = '', before = null, after = null, recordsToInsert = [], saved = [], skipped = [] }) {
  const ids = saved.map((row) => Number(row.id)).filter(Number.isFinite);
  return {
    schemaVersion: 'jrcpcx-major-company-insert-report/v1',
    generatedAt,
    dryRun,
    dbPath,
    dbBackupPath,
    before,
    after,
    plannedInsertCount: recordsToInsert.length,
    insertedCount: saved.length,
    insertedMinId: ids.length ? Math.min(...ids) : null,
    insertedMaxId: ids.length ? Math.max(...ids) : null,
    byCompany: saved.reduce((acc, row) => ({ ...acc, [row.company]: (acc[row.company] || 0) + 1 }), {}),
    skippedCount: skipped.length,
    skipped,
    saved,
    ...(dryRun ? { recordsToInsert } : {}),
  };
}

function backupSqliteFile(dbPath, generatedAt) {
  const stamp = generatedAt.replace(/[:.]/gu, '-');
  const backupPath = path.join(path.dirname(dbPath), `policy-ocr.sqlite.backup-before-jrcpcx-major-company-gap-${stamp}`);
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`;
    if (fs.existsSync(source)) fs.copyFileSync(source, `${backupPath}${suffix}`);
  }
  return backupPath;
}

async function writeInsert({ coveragePath, dbPath, outputPath, write }) {
  const generatedAt = new Date().toISOString();
  const coverage = readJsonFile(coveragePath, {});
  const local = await loadLocalRecords(dbPath);
  const plan = buildInsertPlan({ insertable: coverage.insertable || [], existingUrls: local.urls });
  if (!write) {
    const report = buildInsertReport({ generatedAt, dryRun: true, dbPath: local.dbPath, recordsToInsert: plan.recordsToInsert, skipped: plan.skipped });
    if (outputPath) writeJsonFile(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const [{ createKnowledgeStateStore }, { allocateId }, { buildRowsWithAllocatedIds }] = await Promise.all([
    import('./runtime-knowledge-state.mjs'),
    import('../server/policy-ocr.domain.mjs'),
    import('./ping-an-jrcpcx-backfill.mjs'),
  ]);
  const store = await createKnowledgeStateStore({ dbPath });
  const dbBackupPath = backupSqliteFile(dbPath, generatedAt);
  try {
    const before = store.countKnowledgeRecords();
    const state = store.loadState();
    const { saved, nextId } = buildRowsWithAllocatedIds({ state, recordsToInsert: plan.recordsToInsert, allocateId });
    store.upsertRows(saved, { nextId });
    const after = store.countKnowledgeRecords();
    const report = buildInsertReport({ generatedAt, dryRun: false, dbPath: store.dbPath, dbBackupPath, before, after, recordsToInsert: plan.recordsToInsert, saved, skipped: plan.skipped });
    writeJsonFile(outputPath, report);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    store.close();
  }
}

async function main() {
  const mode = readArg('mode', '');
  if (mode === 'query-file') {
    const gapPath = path.resolve(readArg('gap-path', path.join(runtimeDir, 'jrcpcx-major-company-life-sharded-gaps.json')));
    const outputPath = path.resolve(readArg('output', path.join(runtimeDir, `jrcpcx-major-company-gap-${Date.now()}-queries.json`)));
    const queries = buildJrcpcxQueriesFromGap(readJsonFile(gapPath, {}));
    writeJsonFile(outputPath, { generatedAt: new Date().toISOString(), sourceGapPath: gapPath, targetCompanies: TARGET_COMPANIES, queries });
    process.stdout.write(`${JSON.stringify({ outputPath, queryCount: queries.length }, null, 2)}\n`);
    return;
  }
  if (mode === 'coverage') {
    const inputPath = path.resolve(readArg('input', ''));
    const outputPath = path.resolve(readArg('output', path.join(runtimeDir, `jrcpcx-major-company-gap-${Date.now()}-coverage-gap.json`)));
    const dbPath = path.resolve(readArg('db-path', process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH));
    const input = readJsonFile(inputPath, {});
    const local = await loadLocalRecords(dbPath);
    const detailRows = input.records || input.detailRows || [];
    const artifact = buildCoverageGapReport({ localRecords: local.records, detailRows });
    writeJsonFile(outputPath, artifact);
    process.stdout.write(`${JSON.stringify({ outputPath, ...artifact.summary }, null, 2)}\n`);
    return;
  }
  if (mode === 'insert') {
    await writeInsert({
      coveragePath: path.resolve(readArg('coverage-path', readArg('input', ''))),
      dbPath: path.resolve(readArg('db-path', process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH)),
      outputPath: path.resolve(readArg('output', path.join(runtimeDir, `jrcpcx-major-company-gap-${Date.now()}-insert-report.json`))),
      write: hasFlag('write'),
    });
    return;
  }
  throw new Error('Use --mode=query-file, --mode=coverage, or --mode=insert');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 2: Run the focused test**

Run:

```bash
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit helper and tests**

```bash
git add scripts/jrcpcx-major-company-gap-backfill.mjs tests/jrcpcx-major-company-gap-backfill.test.mjs
git commit -m "feat: add jrcpcx major company backfill helper"
```

## Task 3: Add Pipe Browser JRCPCX Runner

**Files:**
- Create: `scripts/jrcpcx-pipe-major-company-crawl.py`

- [ ] **Step 1: Create the Python pipe runner**

Create `scripts/jrcpcx-pipe-major-company-crawl.py` with these responsibilities:

- read the query file from `--query-file`
- load `server/scrapling-policy-crawler.py` via `importlib.util.spec_from_file_location`
- launch Playwright `chromium.launch_persistent_context(...)` with `headless=False`
- call `jrcpcx_set_visible_page_size`
- call `jrcpcx_query_visible_page` for each query
- checkpoint after each query
- call `jrcpcx_fetch_life_ins_detail` for deduped detail URLs
- checkpoint after each detail fetch
- write final JSON with `queries`, `products`, `records`, `detailResults`, and summary counts

Use the same runtime defaults as the successful Ping An pipe run:

```bash
--wait-ms=20000 --page-size=50 --max-pages=2 --max-detail-products=180
```

- [ ] **Step 2: Compile-check the Python script**

Run:

```bash
/Users/wenshuping/Documents/Scrapling/.venv/bin/python -m py_compile scripts/jrcpcx-pipe-major-company-crawl.py
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Commit the pipe runner**

```bash
git add scripts/jrcpcx-pipe-major-company-crawl.py
git commit -m "feat: add jrcpcx pipe major company crawler"
```

## Task 4: Generate Queries And Run A Dry Data Crawl

**Files:**
- Runtime only: `.runtime/jrcpcx-major-company-gap-<stamp>-queries.json`
- Runtime only: `.runtime/jrcpcx-major-company-gap-<stamp>-catalog.json`

- [ ] **Step 1: Generate a query file from existing gap candidates**

Run:

```bash
STAMP=$(date +%Y%m%d%H%M%S)
node scripts/jrcpcx-major-company-gap-backfill.mjs \
  --mode=query-file \
  --gap-path=.runtime/jrcpcx-major-company-life-sharded-gaps.json \
  --output=.runtime/jrcpcx-major-company-gap-${STAMP}-queries.json
```

Expected: JSON output with `queryCount` greater than `0`.

- [ ] **Step 2: Run the visible pipe crawler**

Run:

```bash
/Users/wenshuping/Documents/Scrapling/.venv/bin/python scripts/jrcpcx-pipe-major-company-crawl.py \
  --query-file=.runtime/jrcpcx-major-company-gap-${STAMP}-queries.json \
  --output=.runtime/jrcpcx-major-company-gap-${STAMP}-catalog.json \
  --pdf-archive-dir=.runtime/policy-material-pdfs/jrcpcx-major-company-gap-${STAMP} \
  --user-data-dir=.runtime/chrome-jrcpcx-major-company-gap-${STAMP} \
  --wait-ms=20000 \
  --page-size=50 \
  --max-pages=2 \
  --max-detail-products=180
```

Expected: visible browser opens JRCPCX. If slider appears, pause and let the user complete it. If `前方拥堵` appears, stop and keep the checkpoint file.

- [ ] **Step 3: Inspect crawl summary**

Run:

```bash
jq '{queryCount, productCount, recordCount, responsibilityCount, pdfArchiveDir, partial, code, message}' .runtime/jrcpcx-major-company-gap-${STAMP}-catalog.json
```

Expected: `recordCount` and `responsibilityCount` show real extracted records or the report clearly shows a verification/congestion blocker.

## Task 5: Build Coverage And Insert Plan

**Files:**
- Runtime only: `.runtime/jrcpcx-major-company-gap-<stamp>-coverage-gap.json`
- Runtime only: `.runtime/jrcpcx-major-company-gap-<stamp>-insert-plan.json`

- [ ] **Step 1: Build coverage gap report**

Run:

```bash
node scripts/jrcpcx-major-company-gap-backfill.mjs \
  --mode=coverage \
  --input=.runtime/jrcpcx-major-company-gap-${STAMP}-catalog.json \
  --output=.runtime/jrcpcx-major-company-gap-${STAMP}-coverage-gap.json \
  --db-path=.runtime/policy-ocr.sqlite
```

Expected: summary contains `insertableCount`, `representedCount`, `manualReviewCount`, and `invalidCount`.

- [ ] **Step 2: Build dry-run insert plan**

Run:

```bash
node scripts/jrcpcx-major-company-gap-backfill.mjs \
  --mode=insert \
  --coverage-path=.runtime/jrcpcx-major-company-gap-${STAMP}-coverage-gap.json \
  --output=.runtime/jrcpcx-major-company-gap-${STAMP}-insert-plan.json \
  --db-path=.runtime/policy-ocr.sqlite
```

Expected: `dryRun: true`, `plannedInsertCount` equals the eligible insertable count after existing URL dedupe, and `insertedCount: 0`.

- [ ] **Step 3: Check insert-plan quality**

Run:

```bash
jq '{
  plannedInsertCount,
  skippedCount,
  byCompany: (.recordsToInsert // [] | group_by(.company) | map({company: .[0].company, count: length})),
  blank: (.recordsToInsert // [] | map(select((.pageText // "") == "")) | length),
  missingPdf: (.recordsToInsert // [] | map(select((.pdfLocalPath // "") == "" or (.pdfSha256 // "") == "")) | length)
}' .runtime/jrcpcx-major-company-gap-${STAMP}-insert-plan.json
```

Expected: `blank: 0` and `missingPdf: 0`.

## Task 6: Write SQLite, Verify, And Sync Feishu

**Files:**
- Runtime only: `.runtime/policy-ocr.sqlite`
- Runtime only: `.runtime/policy-ocr.sqlite.backup-before-jrcpcx-major-company-gap-*`
- Runtime only: `.runtime/jrcpcx-major-company-gap-<stamp>-insert-report.json`
- Runtime only: `.runtime/jrcpcx-major-company-gap-<stamp>-feishu-sync-report.json`

- [ ] **Step 1: Write approved records to SQLite**

Run only if Task 5 shows valid insertable records:

```bash
node scripts/jrcpcx-major-company-gap-backfill.mjs \
  --mode=insert \
  --coverage-path=.runtime/jrcpcx-major-company-gap-${STAMP}-coverage-gap.json \
  --output=.runtime/jrcpcx-major-company-gap-${STAMP}-insert-report.json \
  --db-path=.runtime/policy-ocr.sqlite \
  --write
```

Expected: `dryRun: false`, `insertedCount > 0`, `after - before == insertedCount`, and `dbBackupPath` exists.

- [ ] **Step 2: Verify inserted rows locally**

Run:

```bash
MIN_ID=$(jq -r '.insertedMinId' .runtime/jrcpcx-major-company-gap-${STAMP}-insert-report.json)
MAX_ID=$(jq -r '.insertedMaxId' .runtime/jrcpcx-major-company-gap-${STAMP}-insert-report.json)
sqlite3 .runtime/policy-ocr.sqlite "
SELECT
  COUNT(*) AS inserted,
  SUM(CASE WHEN TRIM(COALESCE(json_extract(payload,'$.pageText'),''))='' THEN 1 ELSE 0 END) AS blank,
  SUM(CASE WHEN TRIM(COALESCE(json_extract(payload,'$.pdfLocalPath'),''))='' OR TRIM(COALESCE(json_extract(payload,'$.pdfSha256'),''))='' THEN 1 ELSE 0 END) AS missing_pdf
FROM knowledge_records
WHERE id BETWEEN ${MIN_ID} AND ${MAX_ID};
"
```

Expected: `blank` is `0` and `missing_pdf` is `0`.

- [ ] **Step 3: Feishu dry-run for each company with inserted rows**

For 阳光:

```bash
node scripts/sync-feishu-knowledge.mjs \
  --company=阳光人寿保险股份有限公司 \
  --config-path=.runtime/feishu-knowledge-sunshine-life.json \
  --base-token=IR6Tb9RoEaXb1tsunNzcfKIxnrd \
  --table-name=阳光人寿 \
  --local-id-min=${MIN_ID} \
  --local-id-max=${MAX_ID} \
  --create-only \
  --skip-existing-local-ids \
  --dry-run
```

For 人保:

```bash
node scripts/sync-feishu-knowledge.mjs \
  --company=中国人民人寿保险股份有限公司 \
  --config-path=.runtime/feishu-knowledge-picc-life.json \
  --base-token=IR6Tb9RoEaXb1tsunNzcfKIxnrd \
  --table-name=人保寿险 \
  --local-id-min=${MIN_ID} \
  --local-id-max=${MAX_ID} \
  --create-only \
  --skip-existing-local-ids \
  --dry-run
```

Expected: pending rows match per-company inserted counts and `duplicateKeyCount: 0`.

- [ ] **Step 4: Feishu write and post-sync dry-run**

Run the same commands without `--dry-run` and add `--batch-size=20`. Then run the dry-run commands again.

Expected after-sync dry-run: pending create count is `0` for each company that had inserted rows.

- [ ] **Step 5: Save final sync report**

Create `.runtime/jrcpcx-major-company-gap-${STAMP}-feishu-sync-report.json` with:

```json
{
  "stamp": "<STAMP>",
  "localIdMin": "<MIN_ID>",
  "localIdMax": "<MAX_ID>",
  "companies": [
    {
      "company": "阳光人寿保险股份有限公司",
      "configPath": ".runtime/feishu-knowledge-sunshine-life.json",
      "tableName": "阳光人寿",
      "beforeDryRunPending": 0,
      "writeCreated": 0,
      "afterDryRunPending": 0
    },
    {
      "company": "中国人民人寿保险股份有限公司",
      "configPath": ".runtime/feishu-knowledge-picc-life.json",
      "tableName": "人保寿险",
      "beforeDryRunPending": 0,
      "writeCreated": 0,
      "afterDryRunPending": 0
    }
  ]
}
```

Replace the numeric values with the actual command results.

## Task 7: Final Verification And Report

**Files:**
- Existing changed files from Tasks 1-3
- Runtime artifacts from Tasks 4-6

- [ ] **Step 1: Run focused tests**

Run:

```bash
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs tests/jrcpcx-insurance-catalog.test.mjs tests/ping-an-jrcpcx-backfill.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run syntax checks for changed scripts**

Run:

```bash
node --check scripts/jrcpcx-major-company-gap-backfill.mjs
/Users/wenshuping/Documents/Scrapling/.venv/bin/python -m py_compile scripts/jrcpcx-pipe-major-company-crawl.py
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Commit code changes**

```bash
git add scripts/jrcpcx-major-company-gap-backfill.mjs scripts/jrcpcx-pipe-major-company-crawl.py tests/jrcpcx-major-company-gap-backfill.test.mjs
git commit -m "feat: backfill jrcpcx major company gaps"
```

- [ ] **Step 4: Report data outcome**

Final report must include:

- query count
- unique product count
- downloaded PDF count
- responsibility extracted count
- inserted SQLite count and ID range
- per-company inserted count
- local blank responsibility count
- local missing PDF count
- Feishu before/write/after result per company
- skipped and unresolved reasons
- note that local production commands were not run

