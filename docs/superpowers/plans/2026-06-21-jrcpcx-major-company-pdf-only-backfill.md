# JRCPCX Major Company PDF-Only Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and run an eight-company JRCPCX PDF-only material backfill that stores missing terms PDFs and traceable JSON/CSV manifests without extracting responsibility text, writing SQLite, or syncing Feishu.

**Architecture:** Extend the existing major-company JRCPCX helper and pipe crawler instead of creating a parallel crawler. Python fetches visible JRCPCX details and archives PDFs in a new `--pdf-only` mode that skips responsibility extraction; Node turns the crawl output into downloaded/skipped/blocked artifacts and validates PDF paths and hashes.

**Tech Stack:** Node ESM, `node:test`, existing `scripts/jrcpcx-major-company-gap-backfill.mjs`, existing `scripts/jrcpcx-pipe-major-company-crawl.py`, existing JRCPCX helpers in `server/scrapling-policy-crawler.py`, JSON/CSV runtime artifacts under `.runtime/`.

---

## Files

- Modify: `tests/jrcpcx-major-company-gap-backfill.test.mjs`
  - Add PDF-only unit tests for manifest rows, report grouping, validation, and CLI artifact output.
- Modify: `scripts/jrcpcx-major-company-gap-backfill.mjs`
  - Add PDF-only report helpers, CSV artifact writing, validation, and `--mode=pdf-only`.
- Modify: `server/scrapling-policy-crawler.py`
  - Add an `extract_responsibility` flag to `jrcpcx_fetch_life_ins_detail`; default remains current behavior.
- Modify: `scripts/jrcpcx-pipe-major-company-crawl.py`
  - Add `--pdf-only` and pass `extract_responsibility=False` into detail fetches.
- Runtime artifacts during execution:
  - `.runtime/jrcpcx-major-company-pdf-only-<stamp>-queries.json`
  - `.runtime/jrcpcx-major-company-pdf-only-<stamp>-crawl.json`
  - `.runtime/jrcpcx-major-company-pdf-only-<stamp>-summary.json`
  - `.runtime/jrcpcx-major-company-pdf-only-<stamp>-downloaded.csv`
  - `.runtime/jrcpcx-major-company-pdf-only-<stamp>-skipped-existing.csv`
  - `.runtime/jrcpcx-major-company-pdf-only-<stamp>-blocked.csv`
  - Per-company JSON/CSV files with the same downloaded, skipped-existing, blocked, and summary groups.

## Task 1: Add PDF-Only Tests

**Files:**
- Modify: `tests/jrcpcx-major-company-gap-backfill.test.mjs`
- Later modify: `scripts/jrcpcx-major-company-gap-backfill.mjs`

- [ ] **Step 1: Extend imports for PDF-only helpers**

Add these named imports to the existing import from `../scripts/jrcpcx-major-company-gap-backfill.mjs`:

```js
  buildPdfOnlyReport,
  buildSuggestedReadableName,
  validatePdfOnlyReport,
  writePdfOnlyArtifacts,
```

- [ ] **Step 2: Add PDF-only manifest row test**

Append this test to `tests/jrcpcx-major-company-gap-backfill.test.mjs`:

```js
test('buildPdfOnlyReport records downloaded PDF metadata for later extraction', () => {
  const pdfPath = ensurePdfFixture();
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    crawlResult: {
      records: [
        {
          company: '阳光人寿保险股份有限公司',
          productName: '阳光人寿附加意外伤害保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=1',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=1&info=abc',
          clauseFileName: 'abc_TERMS.PDF',
          pdfOriginalUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?t=1&info=abc',
          pdfLocalPath: pdfPath,
          pdfSha256: 'abc123',
          pdfBytes: 24,
          pdfContentType: 'application/pdf',
          pdfArchivedAt: '2026-06-21T08:00:01Z',
          detailFields: { 产品条款文字编码: '阳光人寿〔2020〕意外伤害保险001号' },
          responsibilityDeferred: true,
          futureExtractionStatus: 'pending',
        },
      ],
      detailResults: [],
    },
  });

  assert.equal(report.summary.downloadedCount, 1);
  assert.equal(report.summary.skippedExistingCount, 0);
  assert.equal(report.summary.blockedCount, 0);
  assert.equal(report.downloaded[0].issuerFullName, '阳光人寿保险股份有限公司');
  assert.equal(report.downloaded[0].normalizedClauseUrl, 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=abc');
  assert.equal(report.downloaded[0].pdfFileName, path.basename(pdfPath));
  assert.equal(report.downloaded[0].clauseFileName, 'abc_TERMS.PDF');
  assert.equal(report.downloaded[0].futureExtractionStatus, 'pending');
  assert.equal(report.downloaded[0].responsibilityDeferred, true);
  assert.match(report.downloaded[0].suggestedReadableName, /阳光人寿保险股份有限公司__阳光人寿附加意外伤害保险/u);
});
```

- [ ] **Step 3: Add skipped-existing and blocked report test**

Append this test:

```js
test('buildPdfOnlyReport separates skipped-existing and blocked rows', () => {
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    crawlResult: {
      records: [
        {
          company: '中国人民人寿保险股份有限公司',
          productName: '人保寿险示例年金保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=2',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=old',
          clauseFileName: 'old_TERMS.PDF',
          qualityStatus: 'represented_local_url',
        },
      ],
      detailResults: [
        {
          ok: false,
          code: 'JRCPCX_CLAUSE_PDF_FETCH_FAILED',
          message: 'html response',
          productName: '人保寿险失败示例',
          company: '中国人民人寿保险股份有限公司',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=3',
        },
      ],
    },
  });

  assert.equal(report.summary.downloadedCount, 0);
  assert.equal(report.summary.skippedExistingCount, 1);
  assert.equal(report.summary.blockedCount, 1);
  assert.equal(report.skippedExisting[0].reason, 'existing_url');
  assert.equal(report.blocked[0].reason, 'JRCPCX_CLAUSE_PDF_FETCH_FAILED');
});
```

- [ ] **Step 4: Add validation test for missing local PDF**

Append this test:

```js
test('validatePdfOnlyReport catches missing PDF files', () => {
  const report = buildPdfOnlyReport({
    crawlResult: {
      records: [
        {
          company: '友邦人寿保险有限公司',
          productName: '友邦附加意外伤害保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=4',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=missing',
          clauseFileName: 'missing_TERMS.PDF',
          pdfLocalPath: '/tmp/nonexistent-jrcpcx-pdf-only.pdf',
          pdfSha256: 'missing123',
          pdfBytes: 10,
        },
      ],
    },
  });

  const validation = validatePdfOnlyReport(report);

  assert.equal(validation.ok, false);
  assert.equal(validation.missingPdfPathCount, 1);
  assert.match(validation.issues[0].reason, /pdf_file_not_found/u);
});
```

- [ ] **Step 5: Add artifact writer test**

Append this test:

```js
test('writePdfOnlyArtifacts writes aggregate and per-company JSON and CSV files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jrcpcx-pdf-only-artifacts-'));
  const pdfPath = ensurePdfFixture();
  const report = buildPdfOnlyReport({
    generatedAt: '2026-06-21T08:00:00.000Z',
    crawlResult: {
      records: [
        {
          company: '太平人寿保险有限公司',
          productName: '太平团体年金保险',
          productType: '人身保险类',
          salesStatus: '停售',
          detailUrl: 'https://inspdinfo.iachina.cn/lifeIns/detail?data=5',
          clauseUrl: 'https://inspdinfo.iachina.cn/prod-api/lifeIns/clauseInfo?info=taiping',
          clauseFileName: 'taiping_TERMS.PDF',
          pdfLocalPath: pdfPath,
          pdfSha256: 'taiping123',
          pdfBytes: 24,
        },
      ],
    },
  });

  const files = writePdfOnlyArtifacts({
    report,
    outputDir: dir,
    batchName: 'jrcpcx-major-company-pdf-only-test',
  });

  assert.equal(fs.existsSync(files.aggregate.summaryJson), true);
  assert.equal(fs.existsSync(files.aggregate.downloadedCsv), true);
  assert.equal(fs.existsSync(files.byCompany['太平人寿保险有限公司'].downloadedJson), true);
  assert.match(fs.readFileSync(files.aggregate.downloadedCsv, 'utf8'), /太平团体年金保险/u);
});
```

- [ ] **Step 6: Run tests to verify failure**

Run:

```bash
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs
```

Expected: FAIL because `buildPdfOnlyReport`, `buildSuggestedReadableName`, `validatePdfOnlyReport`, and `writePdfOnlyArtifacts` are not exported yet.

## Task 2: Implement Node PDF-Only Report Helpers

**Files:**
- Modify: `scripts/jrcpcx-major-company-gap-backfill.mjs`
- Test: `tests/jrcpcx-major-company-gap-backfill.test.mjs`

- [ ] **Step 1: Add helper functions above `buildCoverageGapReport`**

Add these functions after `skippedCoverageRow`:

```js
function compactFileNamePart(value = '') {
  return trim(value)
    .replace(/[\\/:*?"<>|]+/gu, '_')
    .replace(/\s+/gu, '')
    .slice(0, 80);
}

export function buildSuggestedReadableName(row = {}) {
  const issuer = compactFileNamePart(issuerFullNameOf(row)) || '未知机构';
  const product = compactFileNamePart(productNameOf(row)) || '未知产品';
  const code = compactFileNamePart(termsTextCodeOf(row));
  return [issuer, product, code || '条款'].filter(Boolean).join('__') + '.pdf';
}

function pdfFileNameOf(row = {}) {
  const localPath = pdfLocalPathOf(row);
  return localPath ? path.basename(localPath) : '';
}

function pdfBytesOf(row = {}) {
  return Number(row.pdfBytes || row.bytes || 0) || 0;
}

function pdfContentTypeOf(row = {}) {
  return trim(row.pdfContentType || row.contentType);
}

function pdfOnlyBaseRow(row = {}, status, reason = '') {
  const clauseUrl = clauseUrlOf(row);
  return {
    status,
    reason,
    issuerFullName: issuerFullNameOf(row),
    productName: productNameOf(row),
    productType: productTypeOf(row),
    productState: productStateOf(row),
    industryCode: termsTextCodeOf(row),
    detailUrl: detailUrlOf(row) || trim(row.detailUrl),
    clauseUrl,
    normalizedClauseUrl: clauseUrl,
    clauseFileName: trim(row.clauseFileName || row.fileName),
    pdfOriginalUrl: trim(row.pdfOriginalUrl || row.clauseUrl),
    pdfLocalPath: pdfLocalPathOf(row),
    pdfFileName: pdfFileNameOf(row),
    pdfSha256: pdfSha256Of(row),
    pdfBytes: pdfBytesOf(row),
    pdfContentType: pdfContentTypeOf(row),
    pdfArchivedAt: trim(row.pdfArchivedAt),
    suggestedReadableName: buildSuggestedReadableName(row),
    futureExtractionStatus: 'pending',
    responsibilityDeferred: true,
    sourceAttemptFile: trim(row.sourceAttemptFile),
    detailFields: row.detailFields || row.fields || {},
  };
}

function isSkippedExistingRecord(row = {}) {
  return Boolean(row.skippedExisting) || trim(row.qualityStatus) === 'represented_local_url';
}

function pdfOnlyRowsFromCrawl(crawlResult = {}) {
  const records = rowsOf(crawlResult.records ? { rows: crawlResult.records } : crawlResult);
  const downloaded = [];
  const skippedExisting = [];
  const blocked = [];

  for (const row of records) {
    if (isSkippedExistingRecord(row)) {
      skippedExisting.push(pdfOnlyBaseRow(row, 'skipped_existing', 'existing_url'));
    } else if (pdfLocalPathOf(row)) {
      downloaded.push(pdfOnlyBaseRow(row, 'downloaded'));
    } else if (detailUrlOf(row) || trim(row.detailUrl)) {
      blocked.push(pdfOnlyBaseRow(row, 'blocked', 'missing_pdf_local_path'));
    }
  }

  for (const result of Array.isArray(crawlResult.detailResults) ? crawlResult.detailResults : []) {
    if (result && result.ok === false) {
      blocked.push(pdfOnlyBaseRow(result, 'blocked', trim(result.code) || 'detail_failed'));
    }
  }

  return { downloaded, skippedExisting, blocked };
}
```

- [ ] **Step 2: Add report builder and validation helpers**

Add these functions after `pdfOnlyRowsFromCrawl`:

```js
function countByCompany(rows = []) {
  const counts = {};
  for (const row of rows) {
    const company = trim(row.issuerFullName) || '未知机构';
    counts[company] = (counts[company] || 0) + 1;
  }
  return counts;
}

export function buildPdfOnlyReport({
  crawlResult = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const { downloaded, skippedExisting, blocked } = pdfOnlyRowsFromCrawl(crawlResult);
  const catalogRows = Array.isArray(crawlResult.products) ? crawlResult.products : [];
  return {
    schemaVersion: 'jrcpcx-major-company-pdf-only/v1',
    generatedAt,
    sourceCrawlPath: trim(crawlResult.sourceCrawlPath),
    targetCompanies: targetCompanySummaries(),
    summary: {
      catalogRowCount: catalogRows.length,
      downloadedCount: downloaded.length,
      skippedExistingCount: skippedExisting.length,
      blockedCount: blocked.length,
      failedCount: blocked.length,
      missingPdfPathCount: downloaded.filter((row) => !trim(row.pdfLocalPath)).length,
      byCompany: {
        downloaded: countByCompany(downloaded),
        skippedExisting: countByCompany(skippedExisting),
        blocked: countByCompany(blocked),
      },
    },
    catalog: catalogRows,
    downloaded,
    skippedExisting,
    blocked,
  };
}

export function validatePdfOnlyReport(report = {}, existsFn = fs.existsSync) {
  const issues = [];
  for (const row of Array.isArray(report.downloaded) ? report.downloaded : []) {
    if (!trim(row.pdfLocalPath)) issues.push({ row, reason: 'missing_pdf_local_path' });
    else if (!existsFn(row.pdfLocalPath)) issues.push({ row, reason: 'pdf_file_not_found' });
    if (!trim(row.pdfSha256)) issues.push({ row, reason: 'missing_pdf_sha256' });
    if (Number(row.pdfBytes || 0) <= 0) issues.push({ row, reason: 'invalid_pdf_bytes' });
    if (!trim(row.productName)) issues.push({ row, reason: 'missing_product_name' });
    if (!trim(row.issuerFullName)) issues.push({ row, reason: 'missing_issuer_full_name' });
    if (!trim(row.clauseUrl)) issues.push({ row, reason: 'missing_clause_url' });
    if (row.futureExtractionStatus !== 'pending') issues.push({ row, reason: 'future_extraction_status_not_pending' });
  }
  return {
    ok: issues.length === 0,
    issueCount: issues.length,
    missingPdfPathCount: issues.filter((issue) => ['missing_pdf_local_path', 'pdf_file_not_found'].includes(issue.reason)).length,
    issues,
  };
}
```

- [ ] **Step 3: Run tests to verify helper behavior**

Run:

```bash
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs
```

Expected: FAIL only on `writePdfOnlyArtifacts` export until artifact writing is added.

## Task 3: Add PDF-Only Artifact Writer And CLI Mode

**Files:**
- Modify: `scripts/jrcpcx-major-company-gap-backfill.mjs`
- Test: `tests/jrcpcx-major-company-gap-backfill.test.mjs`

- [ ] **Step 1: Add CSV helpers**

Add these functions near `writeJsonFile`:

```js
function csvCell(value) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  return /[",\n\r]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function writeCsvFile(filePath, rows = [], headers = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = ['\ufeff' + headers.join(',')];
  for (const row of rows) lines.push(headers.map((header) => csvCell(row[header])).join(','));
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
}

const PDF_ONLY_CSV_HEADERS = Object.freeze([
  'status',
  'reason',
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
]);
```

- [ ] **Step 2: Add artifact writer**

Add this exported function before CLI functions:

```js
function companySlug(value = '') {
  const config = companyConfigForIssuer(value);
  if (config?.localCompany) return compactFileNamePart(config.localCompany);
  return compactFileNamePart(value) || 'unknown-company';
}

function rowsForCompany(rows = [], company = '') {
  return rows.filter((row) => normalizeIssuerName(row.issuerFullName) === normalizeIssuerName(company));
}

export function writePdfOnlyArtifacts({
  report,
  outputDir = runtimeDir,
  batchName = `jrcpcx-major-company-pdf-only-${timestampStamp(report?.generatedAt || new Date().toISOString())}`,
  pretty = true,
} = {}) {
  const aggregate = {
    summaryJson: path.join(outputDir, `${batchName}-summary.json`),
    downloadedJson: path.join(outputDir, `${batchName}-downloaded.json`),
    downloadedCsv: path.join(outputDir, `${batchName}-downloaded.csv`),
    skippedExistingJson: path.join(outputDir, `${batchName}-skipped-existing.json`),
    skippedExistingCsv: path.join(outputDir, `${batchName}-skipped-existing.csv`),
    blockedJson: path.join(outputDir, `${batchName}-blocked.json`),
    blockedCsv: path.join(outputDir, `${batchName}-blocked.csv`),
  };

  writeJsonFile(aggregate.summaryJson, { ...report, catalog: undefined, downloaded: undefined, skippedExisting: undefined, blocked: undefined }, pretty);
  writeJsonFile(aggregate.downloadedJson, report.downloaded || [], pretty);
  writeCsvFile(aggregate.downloadedCsv, report.downloaded || [], PDF_ONLY_CSV_HEADERS);
  writeJsonFile(aggregate.skippedExistingJson, report.skippedExisting || [], pretty);
  writeCsvFile(aggregate.skippedExistingCsv, report.skippedExisting || [], PDF_ONLY_CSV_HEADERS);
  writeJsonFile(aggregate.blockedJson, report.blocked || [], pretty);
  writeCsvFile(aggregate.blockedCsv, report.blocked || [], PDF_ONLY_CSV_HEADERS);

  const byCompany = {};
  for (const config of TARGET_COMPANIES) {
    const slug = companySlug(config.issuerFullName);
    const prefix = path.join(outputDir, `${batchName}-${slug}`);
    const companyFiles = {
      downloadedJson: `${prefix}-downloaded.json`,
      downloadedCsv: `${prefix}-downloaded.csv`,
      skippedExistingJson: `${prefix}-skipped-existing.json`,
      skippedExistingCsv: `${prefix}-skipped-existing.csv`,
      blockedJson: `${prefix}-blocked.json`,
      blockedCsv: `${prefix}-blocked.csv`,
      summaryJson: `${prefix}-summary.json`,
    };
    const downloaded = rowsForCompany(report.downloaded || [], config.issuerFullName);
    const skippedExisting = rowsForCompany(report.skippedExisting || [], config.issuerFullName);
    const blocked = rowsForCompany(report.blocked || [], config.issuerFullName);
    writeJsonFile(companyFiles.downloadedJson, downloaded, pretty);
    writeCsvFile(companyFiles.downloadedCsv, downloaded, PDF_ONLY_CSV_HEADERS);
    writeJsonFile(companyFiles.skippedExistingJson, skippedExisting, pretty);
    writeCsvFile(companyFiles.skippedExistingCsv, skippedExisting, PDF_ONLY_CSV_HEADERS);
    writeJsonFile(companyFiles.blockedJson, blocked, pretty);
    writeCsvFile(companyFiles.blockedCsv, blocked, PDF_ONLY_CSV_HEADERS);
    writeJsonFile(companyFiles.summaryJson, {
      issuerFullName: config.issuerFullName,
      downloadedCount: downloaded.length,
      skippedExistingCount: skippedExisting.length,
      blockedCount: blocked.length,
    }, pretty);
    byCompany[config.issuerFullName] = companyFiles;
  }

  return { aggregate, byCompany };
}
```

- [ ] **Step 3: Add CLI mode**

Add this function near `runInsertCli`:

```js
async function runPdfOnlyCli(args) {
  const generatedAt = new Date().toISOString();
  if (!args.input) throw new Error('Missing --input <json>');
  const inputPath = path.resolve(args.input);
  const input = readJsonFile(inputPath);
  const report = buildPdfOnlyReport({
    crawlResult: { ...input, sourceCrawlPath: inputPath },
    generatedAt: input.generatedAt || generatedAt,
  });
  const validation = validatePdfOnlyReport(report);
  const outputDir = path.resolve(args['output-dir'] || runtimeDir);
  const batchName = trim(args['batch-name']) || `jrcpcx-major-company-pdf-only-${timestampStamp(report.generatedAt)}`;
  const files = writePdfOnlyArtifacts({
    report: { ...report, validation },
    outputDir,
    batchName,
    pretty: Boolean(args.pretty),
  });
  process.stdout.write(`${JSON.stringify({ summary: report.summary, validation, files }, null, 2)}\n`);
  return { report, validation, files };
}
```

Then update `runCli`:

```js
  if (args.mode === 'pdf-only') return runPdfOnlyCli(args);
```

Update the unsupported-mode error text to:

```js
  throw new Error(`Unsupported --mode ${args.mode || '(missing)'}. Use query-file, coverage, insert, or pdf-only.`);
```

- [ ] **Step 4: Run tests**

Run:

```bash
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs
```

Expected: PASS for all major-company tests.

## Task 4: Add Python PDF-Only Detail Fetch Mode

**Files:**
- Modify: `server/scrapling-policy-crawler.py`
- Modify: `scripts/jrcpcx-pipe-major-company-crawl.py`

- [ ] **Step 1: Extend `jrcpcx_fetch_life_ins_detail` signature**

In `server/scrapling-policy-crawler.py`, change the function signature from:

```python
def jrcpcx_fetch_life_ins_detail(
    product: dict[str, Any],
    pdf_archive_dir: str = "",
    skip_clause_urls: set[str] | None = None,
) -> dict[str, Any]:
```

to:

```python
def jrcpcx_fetch_life_ins_detail(
    product: dict[str, Any],
    pdf_archive_dir: str = "",
    skip_clause_urls: set[str] | None = None,
    extract_responsibility: bool = True,
) -> dict[str, Any]:
```

- [ ] **Step 2: Skip responsibility extraction when requested**

Replace this block:

```python
    extracted = extract_pdf_text_with_system_python(pdf_bytes)
    page_text = focused_responsibility_excerpt(extracted.get("text", ""))
    archive = archive_pdf_bytes(pdf_bytes, pdf_archive_dir, clause_url) if pdf_archive_dir else {}
```

with:

```python
    if extract_responsibility:
        extracted = extract_pdf_text_with_system_python(pdf_bytes)
        page_text = focused_responsibility_excerpt(extracted.get("text", ""))
        quality_status = "valid_complete" if page_text else "invalid_empty"
        snippet = "金融产品查询平台/中国保险行业协会条款 PDF，已截取保险责任正文段。" if page_text else ""
        pages = extracted.get("pages", 0)
    else:
        page_text = ""
        quality_status = "pdf_only_deferred"
        snippet = "金融产品查询平台/中国保险行业协会条款 PDF，PDF 已归档，保险责任待后续抽取。"
        pages = 0
    archive = archive_pdf_bytes(pdf_bytes, pdf_archive_dir, clause_url) if pdf_archive_dir else {}
```

Then change the record fields:

```python
        "pageText": page_text,
        "qualityStatus": "valid_complete" if page_text else "invalid_empty",
        "snippet": "金融产品查询平台/中国保险行业协会条款 PDF，已截取保险责任正文段。" if page_text else "",
```

to:

```python
        "pageText": page_text,
        "qualityStatus": quality_status,
        "snippet": snippet,
        "futureExtractionStatus": "pending" if not extract_responsibility else "",
        "responsibilityDeferred": not extract_responsibility,
```

And change:

```python
        "pages": extracted.get("pages", 0),
```

to:

```python
        "pages": pages,
```

- [ ] **Step 3: Add `--pdf-only` to the pipe crawler**

In `scripts/jrcpcx-pipe-major-company-crawl.py`, add this parser argument:

```python
    parser.add_argument("--pdf-only", dest="pdf_only", action="store_true", default=False)
```

Add this state field in `build_initial_state`:

```python
        "pdfOnly": bool(args.pdf_only),
```

Pass the flag in `run_details`:

```python
            detail_result = crawler.jrcpcx_fetch_life_ins_detail(
                product,
                args.pdf_archive_dir,
                skip_clause_urls=known_clause_urls,
                extract_responsibility=not args.pdf_only,
            )
```

Add this field in `compact_summary`:

```python
        "pdfOnly": state.get("pdfOnly"),
```

- [ ] **Step 4: Verify Python syntax**

Run:

```bash
python3 -m py_compile server/scrapling-policy-crawler.py scripts/jrcpcx-pipe-major-company-crawl.py
```

Expected: command exits 0.

## Task 5: Run Focused Verification

**Files:**
- Modified code and tests from Tasks 1-4.

- [ ] **Step 1: Run Node syntax and focused tests**

Run:

```bash
node --check scripts/jrcpcx-major-company-gap-backfill.mjs
node --test tests/jrcpcx-major-company-gap-backfill.test.mjs
```

Expected: both commands exit 0.

- [ ] **Step 2: Run Python syntax**

Run:

```bash
python3 -m py_compile server/scrapling-policy-crawler.py scripts/jrcpcx-pipe-major-company-crawl.py
```

Expected: command exits 0.

- [ ] **Step 3: Commit implementation**

Commit only the files touched for this feature:

```bash
git add \
  tests/jrcpcx-major-company-gap-backfill.test.mjs \
  scripts/jrcpcx-major-company-gap-backfill.mjs \
  server/scrapling-policy-crawler.py \
  scripts/jrcpcx-pipe-major-company-crawl.py
git commit -m "feat: add jrcpcx pdf-only backfill mode"
```

Expected: a commit containing only PDF-only implementation files.

## Task 6: Execute The Eight-Company PDF-Only Data Run

**Files:**
- Read: `.runtime/jrcpcx-major-company-life-sharded-gaps.json`
- Write runtime artifacts under `.runtime/`
- Write PDFs under `.runtime/policy-material-pdfs/`

- [ ] **Step 1: Create a timestamp variable**

Run:

```bash
export STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
echo "$STAMP"
```

Expected: prints a UTC timestamp such as `20260621T090000Z`.

- [ ] **Step 2: Generate the query file from existing gap data**

Run:

```bash
node scripts/jrcpcx-major-company-gap-backfill.mjs \
  --mode=query-file \
  --gap-path=.runtime/jrcpcx-major-company-life-sharded-gaps.json \
  --output=".runtime/jrcpcx-major-company-pdf-only-${STAMP}-queries.json" \
  --pretty
```

Expected: stdout shows a positive `queryCount`; output file exists and contains only the eight target companies and `人身保险类` rows.

- [ ] **Step 3: Run the visible pipe crawler in PDF-only mode**

Run:

```bash
python3 scripts/jrcpcx-pipe-major-company-crawl.py \
  --query-file=".runtime/jrcpcx-major-company-pdf-only-${STAMP}-queries.json" \
  --output=".runtime/jrcpcx-major-company-pdf-only-${STAMP}-crawl.json" \
  --pdf-archive-dir=".runtime/policy-material-pdfs/jrcpcx-major-company-pdf-only-${STAMP}" \
  --user-data-dir=".runtime/chrome-jrcpcx-major-company-pdf-only-${STAMP}" \
  --page-size=50 \
  --max-pages=2 \
  --max-detail-products=240 \
  --db-path=.runtime/policy-ocr.sqlite \
  --pdf-only
```

Expected: visible browser opens. If a slider appears, wait for the user to complete it, then rerun the same command. If stdout returns `partial:true`, inspect `.runtime/jrcpcx-major-company-pdf-only-${STAMP}-crawl.json` before continuing.

- [ ] **Step 4: Build PDF-only artifacts from the crawl output**

Run:

```bash
node scripts/jrcpcx-major-company-gap-backfill.mjs \
  --mode=pdf-only \
  --input=".runtime/jrcpcx-major-company-pdf-only-${STAMP}-crawl.json" \
  --output-dir=.runtime \
  --batch-name="jrcpcx-major-company-pdf-only-${STAMP}" \
  --pretty
```

Expected: stdout includes summary and validation. Aggregate and per-company downloaded/skipped-existing/blocked files exist.

- [ ] **Step 5: Verify downloaded PDF paths and hashes**

Run:

```bash
node - <<'JS'
const fs = require('fs');
const crypto = require('crypto');
const stamp = process.env.STAMP;
const rows = JSON.parse(fs.readFileSync(`.runtime/jrcpcx-major-company-pdf-only-${stamp}-downloaded.json`, 'utf8'));
const bad = [];
for (const row of rows) {
  if (!row.pdfLocalPath || !fs.existsSync(row.pdfLocalPath)) {
    bad.push({ productName: row.productName, reason: 'missing_pdfLocalPath' });
    continue;
  }
  const bytes = fs.readFileSync(row.pdfLocalPath);
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha !== row.pdfSha256) bad.push({ productName: row.productName, reason: 'sha_mismatch' });
  if (!bytes.subarray(0, 8).toString('latin1').includes('%PDF')) bad.push({ productName: row.productName, reason: 'not_pdf' });
}
console.log(JSON.stringify({ rowCount: rows.length, badCount: bad.length, bad }, null, 2));
if (bad.length) process.exit(1);
JS
```

Expected: `badCount` is `0`.

- [ ] **Step 6: Confirm SQLite row count did not change**

Run before and after the data command if this task is executed fresh:

```bash
sqlite3 .runtime/policy-ocr.sqlite 'select count(*) from knowledge_records;'
```

Expected: the count is unchanged by Task 6 because the PDF-only workflow writes only runtime artifacts and PDF files.

- [ ] **Step 7: Commit no runtime data**

Run:

```bash
git status --short
```

Expected: implementation files are already committed from Task 5. `.runtime/` data and PDFs are not staged or committed.

## Task 7: Final Report

**Files:**
- Read generated `.runtime/jrcpcx-major-company-pdf-only-<stamp>-summary.json`
- Read aggregate downloaded/skipped-existing/blocked CSVs

- [ ] **Step 1: Summarize per-company results**

Read the aggregate summary and report these counts:

```bash
node - <<'JS'
const fs = require('fs');
const stamp = process.env.STAMP;
const summary = JSON.parse(fs.readFileSync(`.runtime/jrcpcx-major-company-pdf-only-${stamp}-summary.json`, 'utf8'));
console.log(JSON.stringify(summary.summary, null, 2));
JS
```

Expected: output includes downloaded, skipped-existing, blocked, and per-company count groups.

- [ ] **Step 2: Report exact artifact paths**

The final user-facing report must include:

- aggregate downloaded CSV path;
- aggregate skipped-existing CSV path;
- aggregate blocked CSV path;
- PDF archive directory;
- whether any rows remain blocked;
- verification commands run;
- confirmation that SQLite and Feishu were not touched.
