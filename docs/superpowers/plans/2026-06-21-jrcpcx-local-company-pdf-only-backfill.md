# JRCPCX Local Company PDF-Only Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a JRCPCX-only PDF material backfill path that starts from local `knowledge_records`, finds local human-insurance companies, queries JRCPCX, and writes PDF-only artifacts without extracting responsibilities or mutating SQLite.

**Architecture:** Add a focused local-company orchestration script instead of widening the eight-company helper further. The new script reads SQLite in read-only mode, builds company inventory and query artifacts, then converts JRCPCX crawl output into dynamic all-company PDF-only artifacts while reusing the existing JRCPCX URL normalization and PDF manifest conventions.

**Tech Stack:** Node.js ESM, `node:sqlite` `DatabaseSync` read-only access, existing JRCPCX Python pipe crawler, JSON/CSV `.runtime` artifacts, Node test runner.

---

## File Structure

- Create: `scripts/jrcpcx-local-company-pdf-only-backfill.mjs`
  - Owns local-company inventory, query generation, dynamic all-company artifact writing, and CLI modes for this workflow.
  - Imports existing shared helpers from `scripts/jrcpcx-major-company-gap-backfill.mjs` where they are exported.
  - Does not write SQLite.
- Create: `tests/jrcpcx-local-company-pdf-only-backfill.test.mjs`
  - Covers inventory inclusion/exclusion, query generation, dynamic artifact writing, and CLI read-only SQLite behavior.
- Read/reuse only: `scripts/jrcpcx-pipe-major-company-crawl.py`
  - Existing visible-browser crawler already accepts arbitrary query files, `--pdf-only`, `--db-path`, and PDF archive paths.
- No planned changes: `server/scrapling-policy-crawler.py`
  - Do not change crawler internals unless a focused test or real dry run proves the generic query file is insufficient.

## Task 1: Local Company Inventory And Query Generation

**Files:**
- Create: `scripts/jrcpcx-local-company-pdf-only-backfill.mjs`
- Create: `tests/jrcpcx-local-company-pdf-only-backfill.test.mjs`

- [ ] **Step 1: Write failing inventory and query tests**

Add this initial test file:

```js
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  buildLocalCompanyInventory,
  buildLocalCompanyQueries,
} from '../scripts/jrcpcx-local-company-pdf-only-backfill.mjs';

test('buildLocalCompanyInventory includes local human-insurance companies and excludes property-only companies', () => {
  const records = [
    {
      id: 1,
      company: '阳光人寿保险股份有限公司',
      productName: '阳光人寿重大疾病保险',
      productType: '健康保险-疾病保险',
      url: 'https://example.test/sunshine',
      pdfLocalPath: '/tmp/sunshine.pdf',
    },
    {
      id: 2,
      company: '某财产保险股份有限公司',
      productName: '机动车商业保险',
      productType: '财产保险类',
      url: 'https://example.test/property',
    },
    {
      id: 3,
      company: '友邦人寿保险有限公司',
      productName: '友邦附加意外伤害保险',
      productType: '',
      pageText: '保险责任包括意外身故保险金。',
      url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=aia&t=1',
      pdfLocalPath: '/tmp/aia.pdf',
    },
  ];

  const inventory = buildLocalCompanyInventory(records);

  assert.equal(inventory.length, 3);
  assert.deepEqual(
    inventory.map((row) => [row.company, row.included, row.excludeReason]),
    [
      ['阳光人寿保险股份有限公司', true, ''],
      ['友邦人寿保险有限公司', true, ''],
      ['某财产保险股份有限公司', false, 'property_insurance_only'],
    ],
  );
  assert.equal(inventory[0].localKnowledgeRecordCount, 1);
  assert.equal(inventory[1].localJrcpcxClauseUrlCount, 1);
  assert.equal(inventory[1].localPdfPathCount, 1);
});

test('buildLocalCompanyQueries creates human-insurance status shards for included companies only', () => {
  const inventory = [
    { company: '阳光人寿保险股份有限公司', included: true },
    { company: '某财产保险股份有限公司', included: false, excludeReason: 'property_insurance_only' },
  ];

  const queries = buildLocalCompanyQueries(inventory);

  assert.deepEqual(
    queries.map((row) => [row.deptName, row.productTypeLabel, row.productTermLabel, row.productStateLabel]),
    [
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '在售'],
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '停售'],
      ['阳光人寿保险股份有限公司', '人身保险类', '全部', '停用'],
    ],
  );
});
```

- [ ] **Step 2: Run tests and verify import failure**

Run:

```bash
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
```

Expected: FAIL because `scripts/jrcpcx-local-company-pdf-only-backfill.mjs` does not exist.

- [ ] **Step 3: Create minimal inventory/query implementation**

Create `scripts/jrcpcx-local-company-pdf-only-backfill.mjs` with:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  normalizeClauseUrl,
} from './jrcpcx-major-company-gap-backfill.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const runtimeDir = path.join(projectRoot, '.runtime');
const DEFAULT_DB_PATH = path.join(runtimeDir, 'policy-ocr.sqlite');
const DEFAULT_STATUS_SHARDS = Object.freeze(['在售', '停售', '停用']);

function trim(value = '') {
  return String(value || '').trim();
}

function parseJson(value, fallback = {}) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function productNameOf(row = {}) {
  return trim(row.productName || row.product_name || row.name || row.payload?.productName);
}

function productTypeOf(row = {}) {
  return trim(row.productType || row.product_type || row.payload?.productType || row.detailFields?.产品类别 || row.detailFields?.产品类型);
}

function pageTextOf(row = {}) {
  return trim(row.pageText || row.payload?.pageText || row.snippet || row.payload?.snippet);
}

function pdfLocalPathOf(row = {}) {
  return trim(row.pdfLocalPath || row.pdfFilePath || row.payload?.pdfLocalPath || row.payload?.pdfFilePath);
}

function companyOf(row = {}) {
  return trim(row.company || row.issuerFullName || row.payload?.company || row.payload?.issuerFullName);
}

const HUMAN_INSURANCE_RE = /人寿|寿险|健康保险|疾病保险|医疗保险|意外|年金|养老|两全|终身寿|定期寿|护理|重疾|少儿|教育金|保险责任/iu;
const PROPERTY_INSURANCE_RE = /财产保险|财险|车险|机动车|责任保险|保证保险|信用保险|农业保险|货运|船舶|工程保险|企业财产/iu;

export function isHumanInsuranceEvidence(row = {}) {
  const text = [companyOf(row), productNameOf(row), productTypeOf(row), pageTextOf(row)].filter(Boolean).join(' ');
  if (!text) return false;
  if (PROPERTY_INSURANCE_RE.test(text) && !HUMAN_INSURANCE_RE.test(text)) return false;
  return HUMAN_INSURANCE_RE.test(text);
}

function companySummaryFromRows(company, rows = []) {
  const localJrcpcxClauseUrlCount = rows.filter((row) => normalizeClauseUrl(row.url || row.payload?.url || row.pdfOriginalUrl || row.payload?.pdfOriginalUrl)).length;
  const localPdfPathCount = rows.filter((row) => pdfLocalPathOf(row)).length;
  const localHumanInsuranceEvidenceCount = rows.filter((row) => isHumanInsuranceEvidence(row)).length;
  const hasPropertyOnlyEvidence = rows.length > 0 && localHumanInsuranceEvidenceCount === 0 && rows.every((row) => PROPERTY_INSURANCE_RE.test([productNameOf(row), productTypeOf(row), pageTextOf(row)].join(' ')));
  const included = localHumanInsuranceEvidenceCount > 0;
  return {
    company,
    localCompanyName: company,
    submittedDeptName: company,
    localKnowledgeRecordCount: rows.length,
    localHumanInsuranceEvidenceCount,
    localJrcpcxClauseUrlCount,
    localPdfPathCount,
    included,
    excludeReason: included ? '' : (hasPropertyOnlyEvidence ? 'property_insurance_only' : 'no_human_insurance_evidence'),
  };
}

export function buildLocalCompanyInventory(records = []) {
  const byCompany = new Map();
  for (const raw of Array.isArray(records) ? records : []) {
    const payload = raw.payload && typeof raw.payload === 'string' ? parseJson(raw.payload, {}) : (raw.payload || {});
    const row = { ...payload, ...raw, payload };
    const company = companyOf(row);
    if (!company) continue;
    if (!byCompany.has(company)) byCompany.set(company, []);
    byCompany.get(company).push(row);
  }
  return [...byCompany.entries()]
    .map(([company, rows]) => companySummaryFromRows(company, rows))
    .sort((a, b) => {
      if (a.included !== b.included) return a.included ? -1 : 1;
      return b.localKnowledgeRecordCount - a.localKnowledgeRecordCount || a.company.localeCompare(b.company, 'zh-Hans-CN');
    });
}

export function buildLocalCompanyQueries(inventory = [], statusLabels = DEFAULT_STATUS_SHARDS) {
  const queries = [];
  for (const company of Array.isArray(inventory) ? inventory : []) {
    if (!company.included) continue;
    for (const productStateLabel of statusLabels) {
      queries.push({
        deptName: trim(company.submittedDeptName || company.company),
        localCompanyName: trim(company.localCompanyName || company.company),
        productTypeLabel: '人身保险类',
        productTermLabel: '全部',
        productStateLabel,
      });
    }
  }
  return queries;
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```bash
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
```

Expected: PASS for the two new tests.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/jrcpcx-local-company-pdf-only-backfill.mjs tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
git commit -m "feat: build jrcpcx local company inventory"
```

## Task 2: Query-File CLI With Read-Only SQLite

**Files:**
- Modify: `scripts/jrcpcx-local-company-pdf-only-backfill.mjs`
- Modify: `tests/jrcpcx-local-company-pdf-only-backfill.test.mjs`

- [ ] **Step 1: Add CLI test for inventory and query artifacts**

The initial test file already imports `spawnSync`, `fs`, `os`, `path`, and `DatabaseSync`. If the implementation worker created a narrower import block in Task 1, expand the import block to match Task 1 before adding this test.

Add:

```js
test('CLI query-file mode writes inventory and queries from read-only SQLite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-query-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE knowledge_records (
        id INTEGER PRIMARY KEY,
        company TEXT,
        product_name TEXT,
        url TEXT,
        payload TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(1, '阳光人寿保险股份有限公司', '阳光人寿重大疾病保险', 'https://example.test/sunshine', JSON.stringify({
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        productType: '健康保险-疾病保险',
        pageText: '保险责任包括重大疾病保险金。',
        pdfLocalPath: '/tmp/sunshine.pdf',
      }));
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(2, '某财产保险股份有限公司', '机动车商业保险', 'https://example.test/property', JSON.stringify({
        company: '某财产保险股份有限公司',
        productName: '机动车商业保险',
        productType: '财产保险类',
      }));
  } finally {
    db.close();
  }

  const result = spawnSync(process.execPath, [
    'scripts/jrcpcx-local-company-pdf-only-backfill.mjs',
    '--mode=query-file',
    `--db-path=${dbPath}`,
    `--output-dir=${dir}`,
    '--batch-name=jrcpcx-local-company-pdf-only-test',
    '--pretty',
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.localCompanyCount, 2);
  assert.equal(output.summary.includedCompanyCount, 1);
  assert.equal(output.summary.excludedCompanyCount, 1);
  assert.equal(output.summary.queryCount, 3);
  assert.equal(fs.existsSync(output.files.inventoryJson), true);
  assert.equal(fs.existsSync(output.files.inventoryCsv), true);
  assert.equal(fs.existsSync(output.files.queriesJson), true);
  const queries = JSON.parse(fs.readFileSync(output.files.queriesJson, 'utf8')).queries;
  assert.equal(queries.length, 3);
  assert.equal(queries[0].deptName, '阳光人寿保险股份有限公司');

  const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get().count, 2);
  } finally {
    readOnlyDb.close();
  }
});
```

- [ ] **Step 2: Run test and verify CLI mode failure**

Run:

```bash
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
```

Expected: FAIL with unsupported or missing CLI mode.

- [ ] **Step 3: Add read-only SQLite and query-file artifact code**

Add these helpers to `scripts/jrcpcx-local-company-pdf-only-backfill.mjs`:

```js
function timestampStamp(value = new Date().toISOString()) {
  return trim(value).replace(/[:.]/gu, '-');
}

function parseCliArgs(argv = []) {
  const args = {};
  const booleanArgs = new Set(['pretty']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;
    const [key, inlineValue] = arg.slice(2).split('=', 2);
    if (booleanArgs.has(key) && inlineValue === undefined) {
      args[key] = true;
      continue;
    }
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined && !booleanArgs.has(key)) index += 1;
    args[key] = value;
  }
  return args;
}

function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function writeJsonFile(filePath, value, pretty = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function writeCsvFile(filePath, rows = [], headers = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = ['\ufeff' + headers.join(',')];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

async function readKnowledgeRecordsReadOnly(dbPath) {
  const resolvedDbPath = path.resolve(dbPath);
  if (!fs.existsSync(resolvedDbPath)) throw new Error(`SQLite DB not found: ${resolvedDbPath}`);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(resolvedDbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, company, product_name, url, payload FROM knowledge_records ORDER BY id ASC')
      .all()
      .map((row) => {
        const payload = parseJson(row.payload, {});
        return {
          ...payload,
          id: row.id,
          company: row.company || payload.company,
          productName: row.product_name || payload.productName,
          url: row.url || payload.url,
          payload,
        };
      });
  } finally {
    db.close();
  }
}

const INVENTORY_CSV_HEADERS = Object.freeze([
  'company',
  'localCompanyName',
  'submittedDeptName',
  'localKnowledgeRecordCount',
  'localHumanInsuranceEvidenceCount',
  'localJrcpcxClauseUrlCount',
  'localPdfPathCount',
  'included',
  'excludeReason',
]);

const QUERY_CSV_HEADERS = Object.freeze([
  'deptName',
  'localCompanyName',
  'productTypeLabel',
  'productTermLabel',
  'productStateLabel',
]);

export function writeLocalCompanyQueryArtifacts({
  inventory = [],
  queries = [],
  outputDir = runtimeDir,
  batchName = `jrcpcx-local-company-pdf-only-${timestampStamp()}`,
  generatedAt = new Date().toISOString(),
  dbPath = '',
  pretty = false,
} = {}) {
  const files = {
    inventoryJson: path.join(outputDir, `${batchName}-company-inventory.json`),
    inventoryCsv: path.join(outputDir, `${batchName}-company-inventory.csv`),
    queriesJson: path.join(outputDir, `${batchName}-queries.json`),
    queriesCsv: path.join(outputDir, `${batchName}-queries.csv`),
  };
  const inventoryArtifact = {
    schemaVersion: 'jrcpcx-local-company-inventory/v1',
    generatedAt,
    dbPath,
    inventory,
  };
  const queryArtifact = {
    schemaVersion: 'jrcpcx-local-company-query-file/v1',
    generatedAt,
    dbPath,
    inventorySummary: {
      localCompanyCount: inventory.length,
      includedCompanyCount: inventory.filter((row) => row.included).length,
      excludedCompanyCount: inventory.filter((row) => !row.included).length,
    },
    queries,
  };
  writeJsonFile(files.inventoryJson, inventoryArtifact, pretty);
  writeCsvFile(files.inventoryCsv, inventory, INVENTORY_CSV_HEADERS);
  writeJsonFile(files.queriesJson, queryArtifact, pretty);
  writeCsvFile(files.queriesCsv, queries, QUERY_CSV_HEADERS);
  return files;
}
```

Add CLI:

```js
async function runQueryFileCli(args) {
  const generatedAt = new Date().toISOString();
  const dbPath = path.resolve(args['db-path'] || process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH);
  const outputDir = path.resolve(args['output-dir'] || runtimeDir);
  const batchName = trim(args['batch-name']) || `jrcpcx-local-company-pdf-only-${timestampStamp(generatedAt)}`;
  const records = await readKnowledgeRecordsReadOnly(dbPath);
  const inventory = buildLocalCompanyInventory(records);
  const queries = buildLocalCompanyQueries(inventory);
  const files = writeLocalCompanyQueryArtifacts({
    inventory,
    queries,
    outputDir,
    batchName,
    generatedAt,
    dbPath,
    pretty: Boolean(args.pretty),
  });
  const summary = {
    localCompanyCount: inventory.length,
    includedCompanyCount: inventory.filter((row) => row.included).length,
    excludedCompanyCount: inventory.filter((row) => !row.included).length,
    queryCount: queries.length,
  };
  process.stdout.write(`${JSON.stringify({ summary, files }, null, 2)}\n`);
  return { summary, files, inventory, queries };
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.mode === 'query-file') return runQueryFileCli(args);
  throw new Error(`Unsupported --mode ${args.mode || '(missing)'}. Use query-file.`);
}

if (process.argv[1] && __filename === fs.realpathSync(process.argv[1])) {
  try {
    await runCli();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run tests and syntax check**

Run:

```bash
node --check scripts/jrcpcx-local-company-pdf-only-backfill.mjs
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
```

Expected: both PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add scripts/jrcpcx-local-company-pdf-only-backfill.mjs tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
git commit -m "feat: write jrcpcx local company query artifacts"
```

## Task 3: Dynamic All-Company PDF-Only Artifact Writer

**Files:**
- Modify: `scripts/jrcpcx-local-company-pdf-only-backfill.mjs`
- Modify: `tests/jrcpcx-local-company-pdf-only-backfill.test.mjs`

- [ ] **Step 1: Add report and artifact tests**

The initial test file already imports `crypto`. If the implementation worker created a narrower import block in Task 1, add `import crypto from 'node:crypto';` at the top before adding the helper below.

Add helper:

```js
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}
```

Add test:

```js
test('buildLocalCompanyPdfOnlyReport writes dynamic company PDF manifests', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-report-'));
  const pdfPath = path.join(dir, 'existing.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n% local company existing pdf\n');
  const pdfSha256 = sha256File(pdfPath);
  const inventory = [
    {
      company: '阳光人寿保险股份有限公司',
      localCompanyName: '阳光人寿保险股份有限公司',
      submittedDeptName: '阳光人寿保险股份有限公司',
      included: true,
    },
  ];
  const report = buildLocalCompanyPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    inventory,
    crawlResult: {
      products: [
        {
          company: '阳光人寿保险股份有限公司',
          productName: '阳光人寿重大疾病保险',
          productType: '健康保险-疾病保险',
          productState: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=sunshine',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine',
          clauseFileName: 'sunshine_TERMS.PDF',
        },
      ],
      records: [
        {
          company: '阳光人寿保险股份有限公司',
          productName: '阳光人寿重大疾病保险',
          productType: '健康保险-疾病保险',
          salesStatus: '停售',
          industryCode: '阳光人寿〔2020〕疾病保险001号',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=sunshine',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine&t=2',
          clauseFileName: 'sunshine_TERMS.PDF',
          skippedExisting: true,
          skippedReason: 'existing_url',
        },
      ],
    },
    localPdfRecords: [
      {
        id: 101,
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        url: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=sunshine&t=1',
        pdfLocalPath: pdfPath,
        pdfSha256,
        pdfBytes: fs.statSync(pdfPath).size,
        pdfContentType: 'application/pdf',
        pdfArchivedAt: '2026-06-18T12:00:00Z',
      },
    ],
  });

  assert.equal(report.schemaVersion, 'jrcpcx-local-company-pdf-only/v1');
  assert.equal(report.summary.localCompanyCount, 1);
  assert.equal(report.summary.existingPdfManifestCount, 1);
  assert.equal(report.existingPdfManifest[0].localCompanyName, '阳光人寿保险股份有限公司');
  assert.equal(report.existingPdfManifest[0].submittedDeptName, '阳光人寿保险股份有限公司');
  assert.equal(report.existingPdfManifest[0].pdfLocalPath, pdfPath);
});

test('writeLocalCompanyPdfOnlyArtifacts writes aggregate and dynamic per-company files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-artifacts-'));
  const report = {
    schemaVersion: 'jrcpcx-local-company-pdf-only/v1',
    generatedAt: '2026-06-21T08:00:00.000Z',
    companyInventory: [
      { company: '阳光人寿保险股份有限公司', included: true },
    ],
    summary: {
      localCompanyCount: 1,
      includedCompanyCount: 1,
      excludedCompanyCount: 0,
      catalogRowCount: 0,
      downloadedCount: 0,
      existingPdfManifestCount: 0,
      blockedCount: 0,
      byCompany: {},
    },
    catalog: [],
    downloaded: [],
    skippedExisting: [],
    existingPdfManifest: [],
    blocked: [],
  };

  const files = writeLocalCompanyPdfOnlyArtifacts({
    report,
    outputDir: dir,
    batchName: 'jrcpcx-local-company-pdf-only-test',
    pretty: true,
  });

  assert.equal(fs.existsSync(files.aggregate.summaryJson), true);
  assert.equal(fs.existsSync(files.aggregate.existingPdfManifestCsv), true);
  assert.equal(fs.existsSync(files.byCompany['阳光人寿保险股份有限公司'].summaryJson), true);
});
```

Also update the import list:

```js
import {
  buildLocalCompanyInventory,
  buildLocalCompanyPdfOnlyReport,
  buildLocalCompanyQueries,
  writeLocalCompanyPdfOnlyArtifacts,
} from '../scripts/jrcpcx-local-company-pdf-only-backfill.mjs';
```

- [ ] **Step 2: Run tests and verify missing exports**

Run:

```bash
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
```

Expected: FAIL because `buildLocalCompanyPdfOnlyReport` and `writeLocalCompanyPdfOnlyArtifacts` are not defined.

- [ ] **Step 3: Add dynamic report implementation**

Import existing helpers:

```js
import {
  buildPdfOnlyReport,
  normalizeClauseUrl,
  validatePdfOnlyReport,
} from './jrcpcx-major-company-gap-backfill.mjs';
```

Replace the previous import of `normalizeClauseUrl` with this combined import.

Add:

```js
function companyKey(value = '') {
  return trim(value).replace(/\s+/gu, '');
}

function companySlug(value = '') {
  return trim(value)
    .replace(/[\\/:*?"<>|]+/gu, '_')
    .replace(/\s+/gu, '')
    .slice(0, 80) || 'unknown-company';
}

function inventoryMaps(inventory = []) {
  const bySubmitted = new Map();
  const byLocal = new Map();
  for (const row of Array.isArray(inventory) ? inventory : []) {
    if (row.submittedDeptName) bySubmitted.set(companyKey(row.submittedDeptName), row);
    if (row.company) byLocal.set(companyKey(row.company), row);
    if (row.localCompanyName) byLocal.set(companyKey(row.localCompanyName), row);
  }
  return { bySubmitted, byLocal };
}

function attachLocalCompanyMetadata(rows = [], inventory = []) {
  const { bySubmitted, byLocal } = inventoryMaps(inventory);
  return rows.map((row) => {
    const issuer = trim(row.issuerFullName || row.company);
    const inventoryRow = bySubmitted.get(companyKey(issuer)) || byLocal.get(companyKey(issuer)) || {};
    return {
      ...row,
      localCompanyName: trim(inventoryRow.localCompanyName || inventoryRow.company || issuer),
      submittedDeptName: trim(inventoryRow.submittedDeptName || issuer),
    };
  });
}

function countByLocalCompany(rows = []) {
  const counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const company = trim(row.localCompanyName || row.issuerFullName || row.company) || '未知机构';
    counts[company] = (counts[company] || 0) + 1;
  }
  return counts;
}

export function buildLocalCompanyPdfOnlyReport({
  crawlResult = {},
  inventory = [],
  localPdfRecords = [],
  generatedAt = new Date().toISOString(),
} = {}) {
  const baseReport = buildPdfOnlyReport({
    crawlResult,
    generatedAt,
    localPdfRecords,
  });
  const catalog = attachLocalCompanyMetadata(baseReport.catalog || [], inventory);
  const downloaded = attachLocalCompanyMetadata(baseReport.downloaded || [], inventory);
  const skippedExisting = attachLocalCompanyMetadata(baseReport.skippedExisting || [], inventory);
  const existingPdfManifest = attachLocalCompanyMetadata(baseReport.existingPdfManifest || [], inventory);
  const blocked = attachLocalCompanyMetadata(baseReport.blocked || [], inventory);
  const includedCompanyCount = inventory.filter((row) => row.included).length;
  const excludedCompanyCount = inventory.filter((row) => !row.included).length;
  return {
    ...baseReport,
    schemaVersion: 'jrcpcx-local-company-pdf-only/v1',
    companyInventory: inventory,
    summary: {
      ...baseReport.summary,
      localCompanyCount: inventory.length,
      includedCompanyCount,
      excludedCompanyCount,
      byCompany: {
        ...baseReport.summary.byCompany,
        catalog: countByLocalCompany(catalog),
        downloaded: countByLocalCompany(downloaded),
        skippedExisting: countByLocalCompany(skippedExisting),
        existingPdfManifest: countByLocalCompany(existingPdfManifest),
        blocked: countByLocalCompany(blocked),
      },
    },
    catalog,
    downloaded,
    skippedExisting,
    existingPdfManifest,
    blocked,
  };
}
```

- [ ] **Step 4: Add dynamic artifact writer**

Add:

```js
const PDF_ONLY_HEADERS = Object.freeze([
  'status',
  'reason',
  'localCompanyName',
  'submittedDeptName',
  'issuerFullName',
  'productName',
  'productType',
  'productState',
  'industryCode',
  'detailUrl',
  'clauseUrl',
  'normalizedClauseUrl',
  'clauseFileName',
  'pdfOriginalUrl',
  'pdfLocalPath',
  'pdfFileName',
  'pdfSha256',
  'pdfBytes',
  'pdfContentType',
  'pdfArchivedAt',
  'suggestedReadableName',
  'futureExtractionStatus',
  'responsibilityDeferred',
  'existingPdfPathExists',
  'pdfSha256MatchesFile',
  'sourceKnowledgeRecordId',
  'sourceKnowledgeCompany',
  'sourceKnowledgeProductName',
  'sourceKnowledgeUrl',
]);

const CATALOG_HEADERS = Object.freeze([
  'localCompanyName',
  'submittedDeptName',
  'issuerFullName',
  'productName',
  'productType',
  'productState',
  'industryCode',
  'detailUrl',
  'clauseUrl',
  'normalizedClauseUrl',
  'clauseFileName',
]);

function rowsForLocalCompany(rows = [], company = '') {
  const wanted = companyKey(company);
  return rows.filter((row) => companyKey(row.localCompanyName || row.issuerFullName || row.company) === wanted);
}

export function writeLocalCompanyPdfOnlyArtifacts({
  report,
  outputDir = runtimeDir,
  batchName = `jrcpcx-local-company-pdf-only-${timestampStamp(report?.generatedAt || new Date().toISOString())}`,
  pretty = false,
} = {}) {
  const aggregate = {
    summaryJson: path.join(outputDir, `${batchName}-summary.json`),
    catalogJson: path.join(outputDir, `${batchName}-catalog.json`),
    catalogCsv: path.join(outputDir, `${batchName}-catalog.csv`),
    downloadedJson: path.join(outputDir, `${batchName}-downloaded.json`),
    downloadedCsv: path.join(outputDir, `${batchName}-downloaded.csv`),
    existingPdfManifestJson: path.join(outputDir, `${batchName}-existing-pdf-manifest.json`),
    existingPdfManifestCsv: path.join(outputDir, `${batchName}-existing-pdf-manifest.csv`),
    skippedExistingJson: path.join(outputDir, `${batchName}-skipped-existing.json`),
    skippedExistingCsv: path.join(outputDir, `${batchName}-skipped-existing.csv`),
    blockedJson: path.join(outputDir, `${batchName}-blocked.json`),
    blockedCsv: path.join(outputDir, `${batchName}-blocked.csv`),
  };

  writeJsonFile(aggregate.summaryJson, { ...report, catalog: undefined, downloaded: undefined, existingPdfManifest: undefined, skippedExisting: undefined, blocked: undefined }, pretty);
  writeJsonFile(aggregate.catalogJson, report.catalog || [], pretty);
  writeCsvFile(aggregate.catalogCsv, report.catalog || [], CATALOG_HEADERS);
  writeJsonFile(aggregate.downloadedJson, report.downloaded || [], pretty);
  writeCsvFile(aggregate.downloadedCsv, report.downloaded || [], PDF_ONLY_HEADERS);
  writeJsonFile(aggregate.existingPdfManifestJson, report.existingPdfManifest || [], pretty);
  writeCsvFile(aggregate.existingPdfManifestCsv, report.existingPdfManifest || [], PDF_ONLY_HEADERS);
  writeJsonFile(aggregate.skippedExistingJson, report.skippedExisting || [], pretty);
  writeCsvFile(aggregate.skippedExistingCsv, report.skippedExisting || [], PDF_ONLY_HEADERS);
  writeJsonFile(aggregate.blockedJson, report.blocked || [], pretty);
  writeCsvFile(aggregate.blockedCsv, report.blocked || [], PDF_ONLY_HEADERS);

  const byCompany = {};
  for (const company of report.companyInventory || []) {
    const name = trim(company.localCompanyName || company.company);
    if (!name) continue;
    const prefix = path.join(outputDir, `${batchName}-${companySlug(name)}`);
    const companyFiles = {
      summaryJson: `${prefix}-summary.json`,
      catalogJson: `${prefix}-catalog.json`,
      catalogCsv: `${prefix}-catalog.csv`,
      downloadedJson: `${prefix}-downloaded.json`,
      downloadedCsv: `${prefix}-downloaded.csv`,
      existingPdfManifestJson: `${prefix}-existing-pdf-manifest.json`,
      existingPdfManifestCsv: `${prefix}-existing-pdf-manifest.csv`,
      skippedExistingJson: `${prefix}-skipped-existing.json`,
      skippedExistingCsv: `${prefix}-skipped-existing.csv`,
      blockedJson: `${prefix}-blocked.json`,
      blockedCsv: `${prefix}-blocked.csv`,
    };
    const catalog = rowsForLocalCompany(report.catalog || [], name);
    const downloaded = rowsForLocalCompany(report.downloaded || [], name);
    const existingPdfManifest = rowsForLocalCompany(report.existingPdfManifest || [], name);
    const skippedExisting = rowsForLocalCompany(report.skippedExisting || [], name);
    const blocked = rowsForLocalCompany(report.blocked || [], name);
    writeJsonFile(companyFiles.summaryJson, {
      company: name,
      included: Boolean(company.included),
      excludeReason: trim(company.excludeReason),
      catalogRowCount: catalog.length,
      downloadedCount: downloaded.length,
      existingPdfManifestCount: existingPdfManifest.length,
      skippedExistingCount: skippedExisting.length,
      blockedCount: blocked.length,
    }, pretty);
    writeJsonFile(companyFiles.catalogJson, catalog, pretty);
    writeCsvFile(companyFiles.catalogCsv, catalog, CATALOG_HEADERS);
    writeJsonFile(companyFiles.downloadedJson, downloaded, pretty);
    writeCsvFile(companyFiles.downloadedCsv, downloaded, PDF_ONLY_HEADERS);
    writeJsonFile(companyFiles.existingPdfManifestJson, existingPdfManifest, pretty);
    writeCsvFile(companyFiles.existingPdfManifestCsv, existingPdfManifest, PDF_ONLY_HEADERS);
    writeJsonFile(companyFiles.skippedExistingJson, skippedExisting, pretty);
    writeCsvFile(companyFiles.skippedExistingCsv, skippedExisting, PDF_ONLY_HEADERS);
    writeJsonFile(companyFiles.blockedJson, blocked, pretty);
    writeCsvFile(companyFiles.blockedCsv, blocked, PDF_ONLY_HEADERS);
    byCompany[name] = companyFiles;
  }
  return { aggregate, byCompany };
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --check scripts/jrcpcx-local-company-pdf-only-backfill.mjs
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add scripts/jrcpcx-local-company-pdf-only-backfill.mjs tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
git commit -m "feat: write local company pdf-only artifacts"
```

## Task 4: PDF-Only CLI Mode And Verification

**Files:**
- Modify: `scripts/jrcpcx-local-company-pdf-only-backfill.mjs`
- Modify: `tests/jrcpcx-local-company-pdf-only-backfill.test.mjs`

- [ ] **Step 1: Add CLI pdf-only test with temp SQLite**

Add:

```js
test('CLI pdf-only mode writes dynamic manifests and leaves SQLite unchanged', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-local-company-pdf-cli-'));
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const inputPath = path.join(dir, 'crawl.json');
  const inventoryPath = path.join(dir, 'inventory.json');
  const pdfPath = path.join(dir, 'existing.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n% existing local company pdf\n');
  const pdfSha256 = sha256File(pdfPath);
  const clauseUrl = 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=local-cli&t=1';

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE knowledge_records (
        id INTEGER PRIMARY KEY,
        company TEXT,
        product_name TEXT,
        url TEXT,
        payload TEXT NOT NULL
      );
    `);
    db.prepare('INSERT INTO knowledge_records (id, company, product_name, url, payload) VALUES (?, ?, ?, ?, ?)')
      .run(1, '阳光人寿保险股份有限公司', '阳光人寿重大疾病保险', clauseUrl, JSON.stringify({
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        productType: '健康保险-疾病保险',
        url: clauseUrl,
        pdfLocalPath: pdfPath,
        pdfSha256,
        pdfBytes: fs.statSync(pdfPath).size,
        pdfContentType: 'application/pdf',
        pdfArchivedAt: '2026-06-18T12:00:00Z',
      }));
  } finally {
    db.close();
  }

  fs.writeFileSync(inventoryPath, `${JSON.stringify({
    inventory: [
      {
        company: '阳光人寿保险股份有限公司',
        localCompanyName: '阳光人寿保险股份有限公司',
        submittedDeptName: '阳光人寿保险股份有限公司',
        included: true,
      },
    ],
  })}\n`);

  fs.writeFileSync(inputPath, `${JSON.stringify({
    generatedAt: '2026-06-21T08:00:00.000Z',
    records: [
      {
        company: '阳光人寿保险股份有限公司',
        productName: '阳光人寿重大疾病保险',
        productType: '健康保险-疾病保险',
        productState: '停售',
        industryCode: '阳光人寿〔2020〕疾病保险001号',
        detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=local-cli',
        clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=local-cli&t=2',
        clauseFileName: 'local_cli_TERMS.PDF',
        skippedExisting: true,
        skippedReason: 'existing_url',
      },
    ],
  })}\n`);

  const result = spawnSync(process.execPath, [
    'scripts/jrcpcx-local-company-pdf-only-backfill.mjs',
    '--mode=pdf-only',
    `--input=${inputPath}`,
    `--inventory=${inventoryPath}`,
    `--db-path=${dbPath}`,
    `--output-dir=${dir}`,
    '--batch-name=jrcpcx-local-company-pdf-only-cli-test',
    '--pretty',
  ], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary.existingPdfManifestCount, 1);
  assert.equal(output.validation.ok, true);
  assert.equal(fs.existsSync(output.files.aggregate.existingPdfManifestJson), true);
  const manifest = JSON.parse(fs.readFileSync(output.files.aggregate.existingPdfManifestJson, 'utf8'));
  assert.equal(manifest[0].pdfLocalPath, pdfPath);

  const readOnlyDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(readOnlyDb.prepare('SELECT COUNT(*) AS count FROM knowledge_records').get().count, 1);
  } finally {
    readOnlyDb.close();
  }
});
```

- [ ] **Step 2: Run test and verify pdf-only CLI failure**

Run:

```bash
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
```

Expected: FAIL because `--mode=pdf-only` is not wired.

- [ ] **Step 3: Add pdf-only CLI**

Add:

```js
function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function inventoryFromArtifact(filePath) {
  const input = readJsonFile(filePath);
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.inventory)) return input.inventory;
  throw new Error(`Inventory file must contain an inventory array: ${filePath}`);
}

async function readKnownJrcpcxPdfRecords(dbPath) {
  const records = await readKnowledgeRecordsReadOnly(dbPath);
  return records.filter((row) => normalizeClauseUrl(row.url || row.pdfOriginalUrl));
}

async function runPdfOnlyCli(args) {
  const generatedAt = new Date().toISOString();
  if (!args.input) throw new Error('Missing --input <json>');
  if (!args.inventory) throw new Error('Missing --inventory <json>');
  const dbPath = path.resolve(args['db-path'] || process.env.POLICY_OCR_APP_DB_PATH || DEFAULT_DB_PATH);
  const inputPath = path.resolve(args.input);
  const inventoryPath = path.resolve(args.inventory);
  const outputDir = path.resolve(args['output-dir'] || runtimeDir);
  const input = readJsonFile(inputPath);
  const inventory = inventoryFromArtifact(inventoryPath);
  const localPdfRecords = await readKnownJrcpcxPdfRecords(dbPath);
  const report = buildLocalCompanyPdfOnlyReport({
    crawlResult: { ...input, sourceCrawlPath: inputPath },
    inventory,
    localPdfRecords,
    generatedAt: input.generatedAt || generatedAt,
  });
  const validation = validatePdfOnlyReport(report);
  const batchName = trim(args['batch-name']) || `jrcpcx-local-company-pdf-only-${timestampStamp(report.generatedAt)}`;
  const files = writeLocalCompanyPdfOnlyArtifacts({
    report: { ...report, validation },
    outputDir,
    batchName,
    pretty: Boolean(args.pretty),
  });
  process.stdout.write(`${JSON.stringify({ summary: report.summary, validation, files }, null, 2)}\n`);
  return { report, validation, files };
}
```

Update `runCli`:

```js
async function runCli(argv = process.argv.slice(2)) {
  const args = parseCliArgs(argv);
  if (args.mode === 'query-file') return runQueryFileCli(args);
  if (args.mode === 'pdf-only') return runPdfOnlyCli(args);
  throw new Error(`Unsupported --mode ${args.mode || '(missing)'}. Use query-file or pdf-only.`);
}
```

- [ ] **Step 4: Run all focused tests and syntax checks**

Run:

```bash
node --check scripts/jrcpcx-local-company-pdf-only-backfill.mjs
node --test tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Compile Python crawler wrapper**

Run:

```bash
/Users/wenshuping/Documents/Scrapling/.venv/bin/python -m py_compile scripts/jrcpcx-pipe-major-company-crawl.py server/scrapling-policy-crawler.py
```

Expected: PASS. If the venv is missing, use `python3 -m py_compile ...` and record the environment difference in the final report.

- [ ] **Step 6: Commit Task 4**

```bash
git add scripts/jrcpcx-local-company-pdf-only-backfill.mjs tests/jrcpcx-local-company-pdf-only-backfill.test.mjs
git commit -m "feat: add local company pdf-only cli"
```

## Task 5: Real Data Run Procedure

**Files:**
- Runtime artifacts only under `.runtime/`
- No code changes expected

- [ ] **Step 1: Record baseline SQLite row count**

Run:

```bash
sqlite3 .runtime/policy-ocr.sqlite "select count(*) from knowledge_records;"
```

Expected: record the number. It must match after the PDF-only run.

- [ ] **Step 2: Generate local company inventory and query file**

Run:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
node scripts/jrcpcx-local-company-pdf-only-backfill.mjs \
  --mode=query-file \
  --db-path=.runtime/policy-ocr.sqlite \
  --output-dir=.runtime \
  --batch-name=jrcpcx-local-company-pdf-only-${STAMP} \
  --pretty
```

Expected: stdout includes `localCompanyCount`, `includedCompanyCount`, and `queryCount`. Inspect the generated `company-inventory.csv` before crawling. If many excluded rows look like real life insurers, stop and adjust the inventory heuristic in a new code task.

- [ ] **Step 3: Run the visible JRCPCX PDF-only crawler**

Run with the Scrapling venv:

```bash
/Users/wenshuping/Documents/Scrapling/.venv/bin/python scripts/jrcpcx-pipe-major-company-crawl.py \
  --query-file=.runtime/jrcpcx-local-company-pdf-only-${STAMP}-queries.json \
  --output=.runtime/jrcpcx-local-company-pdf-only-${STAMP}-crawl.json \
  --pdf-archive-dir=.runtime/policy-material-pdfs/jrcpcx-local-company-pdf-only-${STAMP} \
  --user-data-dir=.runtime/chrome-jrcpcx-local-company-pdf-only-${STAMP} \
  --page-size=50 \
  --max-pages=2 \
  --max-detail-products=400 \
  --db-path=.runtime/policy-ocr.sqlite \
  --pdf-only
```

Expected: command may stop with verification/congestion. If it does, preserve the partial crawl JSON and report the `code` and `completedQueryCount`. Do not delete the partial artifact.

- [ ] **Step 4: Convert crawl output to dynamic PDF-only artifacts**

Run only after the crawler produced a crawl JSON:

```bash
node scripts/jrcpcx-local-company-pdf-only-backfill.mjs \
  --mode=pdf-only \
  --input=.runtime/jrcpcx-local-company-pdf-only-${STAMP}-crawl.json \
  --inventory=.runtime/jrcpcx-local-company-pdf-only-${STAMP}-company-inventory.json \
  --db-path=.runtime/policy-ocr.sqlite \
  --output-dir=.runtime \
  --batch-name=jrcpcx-local-company-pdf-only-${STAMP} \
  --pretty
```

Expected: validation `ok: true` for available PDF rows. If validation is false, inspect `issues` before calling the run complete.

- [ ] **Step 5: Verify SQLite row count is unchanged**

Run:

```bash
sqlite3 .runtime/policy-ocr.sqlite "select count(*) from knowledge_records;"
```

Expected: same number as Step 1.

- [ ] **Step 6: Summarize usable PDF material counts**

Run:

```bash
STAMP=${STAMP} node --input-type=module <<'EOF'
import fs from 'node:fs';
const stamp = process.env.STAMP;
const base = `.runtime/jrcpcx-local-company-pdf-only-${stamp}`;
const summary = JSON.parse(fs.readFileSync(`${base}-summary.json`, 'utf8')).summary;
console.log(JSON.stringify({
  localCompanyCount: summary.localCompanyCount,
  includedCompanyCount: summary.includedCompanyCount,
  catalogRowCount: summary.catalogRowCount,
  downloadedCount: summary.downloadedCount,
  existingPdfManifestCount: summary.existingPdfManifestCount,
  blockedCount: summary.blockedCount,
  missingExistingPdfPathCount: summary.missingExistingPdfPathCount,
  missingExistingPdfFileCount: summary.missingExistingPdfFileCount,
  existingPdfSha256MismatchCount: summary.existingPdfSha256MismatchCount,
}, null, 2));
EOF
```

Expected: counts are reported in the final answer with links to the aggregate summary, existing PDF manifest, downloaded manifest, and blocked file.

## Self-Review Checklist

- Spec coverage:
  - Company inventory: Task 1 and Task 2.
  - JRCPCX-only query file: Task 2 and Task 5.
  - PDF-only dynamic artifacts: Task 3 and Task 4.
  - No SQLite writes: Task 2 CLI test, Task 4 CLI test, Task 5 baseline checks.
  - No responsibility extraction or Feishu sync: Task 5 command set uses only `--pdf-only` and local artifact conversion.
- Placeholder scan:
  - No task uses `TBD`, `TODO`, or "write tests for the above" without a concrete test body.
- Type consistency:
  - `company`, `localCompanyName`, `submittedDeptName`, `included`, and `excludeReason` are used consistently across inventory, query, and report tasks.
  - PDF manifest fields align with the previous major-company PDF-only manifest conventions.
