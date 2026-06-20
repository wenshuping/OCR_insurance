# JRCPCX CDP Data Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Backfill additional human-insurance responsibility rows from JRCPCX terms PDFs into `.runtime/policy-ocr.sqlite` and the matching insurer Feishu tables.

**Architecture:** Use a fresh Chrome/CDP session for JRCPCX, run narrow issuer/status/keyword shards, extract only terms PDFs and responsibility text, then reconcile by normalized material URL before inserting. SQLite writes and Feishu syncs are separated by reports and before/after dry-runs so blocked or suspicious rows never become knowledge records.

**Tech Stack:** Node.js ESM scripts, Python Scrapling crawler through `server/scrapling-policy-crawler.py`, Playwright CDP, SQLite-backed `scripts/runtime-knowledge-state.mjs`, existing Feishu sync script.

---

## File Structure

- Read: `docs/superpowers/specs/2026-06-20-jrcpcx-cdp-data-backfill-design.md`
- Read: `scripts/crawl-jrcpcx-insurance-catalog.mjs`
- Read: `server/scrapling-policy-crawler.py`
- Read: `scripts/runtime-knowledge-state.mjs`
- Read: `scripts/sync-feishu-knowledge.mjs`
- Runtime create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-queries.json`
- Runtime create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-responsibilities.json`
- Runtime create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-insert-plan.json`
- Runtime create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-insert-report.json`
- Runtime create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-feishu-sync-report.json`
- Runtime create: `.runtime/policy-ocr.sqlite.backup-before-jrcpcx-cdp-backfill-${STAMP}`
- Runtime update: `.runtime/policy-ocr.sqlite`
- Runtime update: `.runtime/policy-material-pdfs/`

No source file should be modified in the normal data-only path. If a crawler bug is found, stop this plan and create a separate code-change plan.

## Task 1: Preflight And Batch Variables

**Files:**
- Read: `docs/superpowers/specs/2026-06-20-jrcpcx-cdp-data-backfill-design.md`
- Read: `.runtime/policy-ocr.sqlite`

- [ ] **Step 1: Set batch variables**

Run:

```bash
cd /Users/wenshuping/Documents/OCR_insurance
export STAMP="$(date +%Y%m%d%H%M%S)"
export JRCPCX_CDP_PORT=9226
export JRCPCX_CDP_URL="http://127.0.0.1:${JRCPCX_CDP_PORT}"
export JRCPCX_PROFILE_DIR="/tmp/chrome-jrcpcx-cdp-backfill-${JRCPCX_CDP_PORT}"
export POLICY_OCR_APP_DB_PATH=".runtime/policy-ocr.sqlite"
```

Expected: environment variables are available in the shell that will run the batch.

- [ ] **Step 2: Confirm the active SQLite path and count**

Run:

```bash
node --input-type=module - <<'NODE'
import { createKnowledgeStateStore } from './scripts/runtime-knowledge-state.mjs';
const store = await createKnowledgeStateStore();
try {
  console.log(JSON.stringify({ dbPath: store.dbPath, count: store.countKnowledgeRecords() }, null, 2));
} finally {
  store.close();
}
NODE
```

Expected: `dbPath` ends with `/Users/wenshuping/Documents/OCR_insurance/.runtime/policy-ocr.sqlite`.

- [ ] **Step 3: Confirm the fresh CDP port is free**

Run:

```bash
curl -sS --max-time 2 "${JRCPCX_CDP_URL}/json/version" || true
```

Expected: connection fails before Chrome is opened. If it returns JSON, choose a new unused port and update `JRCPCX_CDP_PORT`, `JRCPCX_CDP_URL`, and `JRCPCX_PROFILE_DIR`.

## Task 2: Create JRCPCX Query Shards

**Files:**
- Create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-queries.json`

- [ ] **Step 1: Generate the first-pass query file**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const stamp = process.env.STAMP;
if (!stamp) throw new Error('STAMP is required');
const issuers = [
  { deptName: '中国平安人寿保险股份有限公司', priority: 'high', keywords: ['附加', '终身', '年金', '两全', '医疗', '重疾', '疾病', '意外', '万能', '分红', '养老', '少儿', '护理', '教育', '金', '福', '安', '智', '鑫', '御', '盛世'] },
  { deptName: '中国人寿保险股份有限公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
  { deptName: '中国人民人寿保险股份有限公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
  { deptName: '中国太平洋人寿保险股份有限公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
  { deptName: '泰康人寿保险有限责任公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
  { deptName: '新华人寿保险股份有限公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
  { deptName: '阳光人寿保险股份有限公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
  { deptName: '友邦人寿保险有限公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
  { deptName: '太平人寿保险有限公司', priority: 'major', keywords: ['终身', '年金', '医疗', '重疾', '意外', '两全', '附加', '分红', '护理', '养老'] },
];
const statuses = ['在售', '停售', '停用'];
const queries = [];
for (const issuer of issuers) {
  for (const productStateLabel of statuses) {
    for (const productName of issuer.keywords) {
      queries.push({
        deptName: issuer.deptName,
        productName,
        productTypeLabel: '人身保险类',
        productTermLabel: '全部',
        productStateLabel,
        priority: issuer.priority,
      });
    }
  }
}
const out = `.runtime/jrcpcx-cdp-backfill-${stamp}-queries.json`;
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), queries }, null, 2) + '\n');
console.log(JSON.stringify({ out, queryCount: queries.length, issuerCount: issuers.length }, null, 2));
NODE
```

Expected: the output reports `issuerCount: 9` and `queryCount: 423`.

- [ ] **Step 2: Inspect the generated query file**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const stamp = process.env.STAMP;
const file = `.runtime/jrcpcx-cdp-backfill-${stamp}-queries.json`;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(JSON.stringify({ file, first: data.queries[0], last: data.queries.at(-1) }, null, 2));
NODE
```

Expected: the first and last rows have `productTypeLabel: "人身保险类"`.

## Task 3: Start Fresh Chrome/CDP Session

**Files:**
- Runtime directory: `/tmp/chrome-jrcpcx-cdp-backfill-9226`

- [ ] **Step 1: Launch Chrome on the selected CDP port**

Run:

```bash
"/Applications/Google Chrome 2.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port="${JRCPCX_CDP_PORT}" \
  --remote-allow-origins="${JRCPCX_CDP_URL}" \
  --user-data-dir="${JRCPCX_PROFILE_DIR}" \
  --no-first-run \
  --new-window "https://www.jrcpcx.cn/#/query" &
```

Expected: Chrome opens a new window at the JRCPCX query page.

- [ ] **Step 2: Verify CDP is reachable**

Run:

```bash
curl -sS "${JRCPCX_CDP_URL}/json/version"
```

Expected: JSON output includes a `webSocketDebuggerUrl`.

- [ ] **Step 3: Ask the user to complete verification**

Tell the user:

```text
我已经打开新的 JRCPCX 浏览器窗口。请在这个窗口里完成滑块验证；完成后回复“划好了”。
```

Expected: user confirms the slider or says there is no slider.

## Task 4: Run JRCPCX Detail Extraction

**Files:**
- Read: `.runtime/jrcpcx-cdp-backfill-${STAMP}-queries.json`
- Create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-responsibilities.json`
- Update: `.runtime/policy-material-pdfs/`

- [ ] **Step 1: Run the UI crawler with detail extraction**

Run:

```bash
npm run crawl:jrcpcx-insurance-catalog -- \
  --ui \
  --cdp-url="${JRCPCX_CDP_URL}" \
  --query-file=".runtime/jrcpcx-cdp-backfill-${STAMP}-queries.json" \
  --extract-responsibility \
  --write \
  --catalog-path=".runtime/jrcpcx-cdp-backfill-${STAMP}-responsibilities.json" \
  --pdf-archive-dir=".runtime/policy-material-pdfs" \
  --page-size=50 \
  --max-pages=2 \
  --max-detail-products=180 \
  --wait-ms=120000
```

Expected: command exits `0` and reports a nonzero `productCount` or a clear blocking code such as `JRCPCX_VERIFICATION_REQUIRED`.

- [ ] **Step 2: If verification is required, pause and retry once after user action**

Run this only when Step 1 reports `JRCPCX_VERIFICATION_REQUIRED`:

```bash
echo "JRCPCX needs slider verification. Ask the user to finish the slider in Chrome, then rerun Task 4 Step 1 once."
```

Expected: user completes the slider and the retry either succeeds or returns a different blocker.

- [ ] **Step 3: Stop on congestion**

Run this only when Step 1 reports `前方拥堵` or repeated verification failure:

```bash
echo "JRCPCX session is blocked. Stop this batch, keep the runtime report, and start a new CDP port/profile before retrying."
```

Expected: no SQLite or Feishu writes happen from a congested batch.

## Task 5: Build Insert Plan From Extracted Records

**Files:**
- Read: `.runtime/jrcpcx-cdp-backfill-${STAMP}-responsibilities.json`
- Read: `.runtime/policy-ocr.sqlite`
- Create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-insert-plan.json`

- [ ] **Step 1: Build the insert plan**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { createKnowledgeStateStore } from './scripts/runtime-knowledge-state.mjs';
const stamp = process.env.STAMP;
if (!stamp) throw new Error('STAMP is required');
const sourcePath = `.runtime/jrcpcx-cdp-backfill-${stamp}-responsibilities.json`;
const outPath = `.runtime/jrcpcx-cdp-backfill-${stamp}-insert-plan.json`;
const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
const rows = Array.isArray(source.records) ? source.records : [];
function trim(value) {
  return String(value || '').trim();
}
function normalizeClauseUrl(value = '') {
  const raw = trim(value);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.hostname === 'inspdinfo.iachina.cn' && /\/lifeIns\/clauseInfo\b/u.test(url.pathname)) {
      const params = [...url.searchParams.entries()]
        .filter(([key]) => key !== 't')
        .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
          if (leftKey === rightKey) return leftValue.localeCompare(rightValue);
          return leftKey.localeCompare(rightKey);
        });
      url.search = '';
      for (const [key, paramValue] of params) url.searchParams.append(key, paramValue);
    }
    return url.href;
  } catch {
    return raw;
  }
}
function companyOf(row) {
  return trim(row.company || row.issuerFullName || row.companyName || row.deptName || row.queryDeptName || row.detailFields?.公司名称);
}
function productOf(row) {
  return trim(row.productName || row.product || row.detailFields?.产品名称);
}
function productTypeOf(row) {
  return trim(row.productType || row.productTypeLabel || row.queryProductType || row.detailFields?.产品类型);
}
function statusOf(row) {
  return trim(row.salesStatus || row.productState || row.detailFields?.产品销售状态 || row.queryProductState);
}
function detailUrlOf(row) {
  for (const value of [row.detailUrl, row.sourceUrl, row.source, row.seedSourceUrl]) {
    try {
      const url = new URL(trim(value));
      if (url.hostname === 'inspdinfo.iachina.cn' && /\/lifeIns\/detail\b/u.test(url.pathname)) return url.href;
    } catch {}
  }
  return '';
}
function qualityOf(row) {
  return trim(row.qualityStatus || row.responsibilityQualityStatus);
}
function responsibilityTextOf(row) {
  return trim(row.responsibilityText || row.pageText);
}
function eligibility(row) {
  const reasons = [];
  const company = companyOf(row);
  const productName = productOf(row);
  const productType = productTypeOf(row);
  const clauseUrl = normalizeClauseUrl(row.clauseUrl || row.pdfOriginalUrl || row.url);
  const detailUrl = detailUrlOf(row);
  const text = responsibilityTextOf(row);
  const pdfLocalPath = trim(row.pdfLocalPath);
  const pdfSha256 = trim(row.pdfSha256);
  const quality = qualityOf(row);
  if (!company) reasons.push('missing_company');
  if (!productName) reasons.push('missing_product_name');
  if (!/人身保险/u.test(productType)) reasons.push(productType ? 'not_human_insurance' : 'missing_product_type');
  if (!clauseUrl) reasons.push('missing_clause_url');
  if (!detailUrl) reasons.push('missing_detail_url');
  if (!pdfLocalPath) reasons.push('missing_pdf_local_path');
  if (pdfLocalPath && !fs.existsSync(pdfLocalPath)) reasons.push('pdf_file_not_found');
  if (!pdfSha256) reasons.push('missing_pdf_sha256');
  if (!text) reasons.push('missing_responsibility_text');
  if (!['valid_complete', 'valid_partial'].includes(quality)) reasons.push(`quality_${quality || 'blank'}`);
  return { eligible: reasons.length === 0, reasons, clauseUrl, detailUrl, text, quality };
}
const store = await createKnowledgeStateStore();
try {
  const state = store.loadState();
  const existingUrls = new Set((state.knowledgeRecords || []).map((row) => normalizeClauseUrl(row.url)).filter(Boolean));
  const byUrl = new Map();
  const skipped = [];
  for (const row of rows) {
    const check = eligibility(row);
    if (!check.eligible) {
      skipped.push({ company: companyOf(row), productName: productOf(row), reason: check.reasons[0], reasons: check.reasons });
      continue;
    }
    if (existingUrls.has(check.clauseUrl)) {
      skipped.push({ company: companyOf(row), productName: productOf(row), reason: 'existing_url', clauseUrl: check.clauseUrl });
      continue;
    }
    if (!byUrl.has(check.clauseUrl)) {
      byUrl.set(check.clauseUrl, {
        ...row,
        company: companyOf(row),
        productName: productOf(row),
        productType: productTypeOf(row),
        salesStatus: statusOf(row),
        url: check.clauseUrl,
        seedSourceUrl: check.detailUrl,
        pageText: check.text,
        responsibilityText: check.text,
        sourceType: 'pdf',
        materialType: 'terms',
        official: true,
        evidenceLabel: '金融产品查询平台/中国保险行业协会条款 PDF',
        evidenceLevel: 'regulatory_industry_terms',
        officialDomain: 'inspdinfo.iachina.cn',
        qualityStatus: check.quality,
        responsibilityQualityStatus: check.quality,
      });
    }
  }
  const recordsToInsert = [...byUrl.values()];
  const byCompany = {};
  const byQualityStatus = {};
  for (const row of recordsToInsert) {
    byCompany[row.company] = (byCompany[row.company] || 0) + 1;
    byQualityStatus[row.qualityStatus] = (byQualityStatus[row.qualityStatus] || 0) + 1;
  }
  const report = {
    generatedAt: new Date().toISOString(),
    sourcePath,
    dbPath: store.dbPath,
    sourceRecordCount: rows.length,
    insertableCount: recordsToInsert.length,
    skippedCount: skipped.length,
    byCompany,
    byQualityStatus,
    skipped,
    recordsToInsert,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ outPath, insertableCount: report.insertableCount, byCompany, byQualityStatus, skippedCount: report.skippedCount }, null, 2));
} finally {
  store.close();
}
NODE
```

Expected: output contains `insertableCount`. If `insertableCount` is `0`, skip Tasks 6 and 7 and report blockers.

- [ ] **Step 2: Review insert plan quality**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const stamp = process.env.STAMP;
const plan = JSON.parse(fs.readFileSync(`.runtime/jrcpcx-cdp-backfill-${stamp}-insert-plan.json`, 'utf8'));
console.log(JSON.stringify({
  insertableCount: plan.insertableCount,
  skippedCount: plan.skippedCount,
  byCompany: plan.byCompany,
  byQualityStatus: plan.byQualityStatus,
  samples: plan.recordsToInsert.slice(0, 5).map((row) => ({
    company: row.company,
    productName: row.productName,
    qualityStatus: row.qualityStatus,
    textChars: String(row.responsibilityText || row.pageText || '').trim().length,
    pdfLocalPath: row.pdfLocalPath,
    url: row.url,
  })),
}, null, 2));
NODE
```

Expected: every sample has non-empty `pdfLocalPath`, `url`, and `textChars > 0`.

## Task 6: Insert Approved Rows Into SQLite

**Files:**
- Read: `.runtime/jrcpcx-cdp-backfill-${STAMP}-insert-plan.json`
- Create: `.runtime/policy-ocr.sqlite.backup-before-jrcpcx-cdp-backfill-${STAMP}`
- Create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-insert-report.json`
- Modify: `.runtime/policy-ocr.sqlite`

- [ ] **Step 1: Back up SQLite**

Run:

```bash
cp .runtime/policy-ocr.sqlite ".runtime/policy-ocr.sqlite.backup-before-jrcpcx-cdp-backfill-${STAMP}"
ls -lh ".runtime/policy-ocr.sqlite.backup-before-jrcpcx-cdp-backfill-${STAMP}"
```

Expected: backup file exists and has nonzero size.

- [ ] **Step 2: Insert records**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { allocateId } from './server/policy-ocr.domain.mjs';
import { upsertKnowledgeRecords } from './server/policy-knowledge.service.mjs';
import { createKnowledgeStateStore } from './scripts/runtime-knowledge-state.mjs';
const stamp = process.env.STAMP;
if (!stamp) throw new Error('STAMP is required');
const planPath = `.runtime/jrcpcx-cdp-backfill-${stamp}-insert-plan.json`;
const outPath = `.runtime/jrcpcx-cdp-backfill-${stamp}-insert-report.json`;
const backupPath = `.runtime/policy-ocr.sqlite.backup-before-jrcpcx-cdp-backfill-${stamp}`;
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const recordsToSave = (plan.recordsToInsert || []).map((row) => ({
  ...row,
  id: undefined,
  migratedFrom: planPath,
  migratedAt: new Date().toISOString(),
}));
const store = await createKnowledgeStateStore();
try {
  const state = store.loadState();
  const before = store.countKnowledgeRecords();
  const saved = upsertKnowledgeRecords(state, recordsToSave, { allocateId });
  store.saveState(state);
  const ids = saved.map((row) => Number(row.id)).filter(Number.isFinite).sort((left, right) => left - right);
  const byCompany = {};
  const byQualityStatus = {};
  for (const row of saved) {
    byCompany[row.company] = (byCompany[row.company] || 0) + 1;
    byQualityStatus[row.qualityStatus || row.responsibilityQualityStatus || 'unknown'] = (byQualityStatus[row.qualityStatus || row.responsibilityQualityStatus || 'unknown'] || 0) + 1;
  }
  const report = {
    generatedAt: new Date().toISOString(),
    dbPath: store.dbPath,
    backupPath,
    before,
    after: store.countKnowledgeRecords(),
    insertedCount: saved.length,
    insertedMinId: ids[0] || null,
    insertedMaxId: ids.at(-1) || null,
    byCompany,
    byQualityStatus,
    saved,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({
    outPath,
    before: report.before,
    after: report.after,
    insertedCount: report.insertedCount,
    insertedMinId: report.insertedMinId,
    insertedMaxId: report.insertedMaxId,
    byCompany,
    byQualityStatus,
  }, null, 2));
} finally {
  store.close();
}
NODE
```

Expected: `after - before` equals `insertedCount`, and `insertedCount` equals the insert plan's `insertableCount`.

## Task 7: Sync Inserted Rows To Feishu

**Files:**
- Read: `.runtime/jrcpcx-cdp-backfill-${STAMP}-insert-report.json`
- Create: `.runtime/jrcpcx-cdp-backfill-${STAMP}-feishu-sync-report.json`

- [ ] **Step 1: Run Feishu dry-run, write, and post-check for each company**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const stamp = process.env.STAMP;
if (!stamp) throw new Error('STAMP is required');
const insertReportPath = `.runtime/jrcpcx-cdp-backfill-${stamp}-insert-report.json`;
const outPath = `.runtime/jrcpcx-cdp-backfill-${stamp}-feishu-sync-report.json`;
const insertReport = JSON.parse(fs.readFileSync(insertReportPath, 'utf8'));
const configByCompany = {
  '中国平安人寿保险股份有限公司': { configPath: '.runtime/feishu-knowledge-ping-an.json', tableName: '中国平安' },
  '中国人寿保险股份有限公司': { configPath: '.runtime/feishu-knowledge-china-life.json', tableName: '中国人寿' },
  '中国人民人寿保险股份有限公司': { configPath: '.runtime/feishu-knowledge-picc-life.json', tableName: '人保寿险' },
  '中国太平洋人寿保险股份有限公司': { configPath: '.runtime/feishu-knowledge-cpic-life.json', tableName: '太保寿险' },
  '泰康人寿保险有限责任公司': { configPath: '.runtime/feishu-knowledge-taikang.json', tableName: '泰康' },
  '新华人寿保险股份有限公司': { configPath: '.runtime/feishu-knowledge.json', tableName: '新华保险' },
  '阳光人寿保险股份有限公司': { configPath: '.runtime/feishu-knowledge-sunshine-life.json', tableName: '阳光人寿' },
  '友邦人寿保险有限公司': { configPath: '.runtime/feishu-knowledge-aia.json', tableName: '友邦' },
  '太平人寿保险有限公司': { configPath: '.runtime/feishu-knowledge-china-taiping.json', tableName: '中国太平' },
};
function parsePlan(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
function runSync({ company, configPath, tableName, minId, maxId, dryRun }) {
  const args = [
    'scripts/sync-feishu-knowledge.mjs',
    `--company=${company}`,
    `--config-path=${configPath}`,
    '--base-token=IR6Tb9RoEaXb1tsunNzcfKIxnrd',
    `--table-name=${tableName}`,
    `--local-id-min=${minId}`,
    `--local-id-max=${maxId}`,
    '--create-only',
    '--skip-existing-local-ids',
    dryRun ? '--dry-run' : '--batch-size=20',
  ];
  const child = spawnSync('node', args, { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
  return {
    status: child.status,
    stdout: child.stdout,
    stderr: child.stderr,
    plan: dryRun ? parsePlan(child.stdout) : null,
    syncLine: dryRun ? '' : ((child.stdout.match(/已同步 \d+ 条知识库记录：新增 \d+，更新 \d+/u) || [''])[0]),
  };
}
const rowsByCompany = new Map();
for (const row of insertReport.saved || []) {
  const list = rowsByCompany.get(row.company) || [];
  list.push(row);
  rowsByCompany.set(row.company, list);
}
const results = [];
for (const [company, rows] of rowsByCompany.entries()) {
  const config = configByCompany[company];
  const ids = rows.map((row) => Number(row.id)).filter(Number.isFinite).sort((left, right) => left - right);
  if (!config) {
    results.push({ company, status: 'blocked_missing_feishu_config', count: rows.length, minId: ids[0] || null, maxId: ids.at(-1) || null });
    continue;
  }
  const minId = ids[0];
  const maxId = ids.at(-1);
  const before = runSync({ company, ...config, minId, maxId, dryRun: true });
  if (before.status !== 0 || !before.plan || before.plan.duplicateKeyCount !== 0) {
    results.push({ company, tableName: config.tableName, status: 'blocked_dry_run_before', minId, maxId, beforeStatus: before.status, beforePlan: before.plan, stderr: before.stderr });
    continue;
  }
  const write = runSync({ company, ...config, minId, maxId, dryRun: false });
  if (write.status !== 0) {
    results.push({ company, tableName: config.tableName, status: 'blocked_write', minId, maxId, beforePlan: before.plan, writeStatus: write.status, stderr: write.stderr });
    continue;
  }
  const after = runSync({ company, ...config, minId, maxId, dryRun: true });
  const afterPending = after.plan?.count;
  results.push({
    company,
    tableName: config.tableName,
    status: after.status === 0 && afterPending === 0 ? 'synced' : 'blocked_post_check',
    minId,
    maxId,
    expectedCount: rows.length,
    beforePending: before.plan.count,
    duplicateKeyCountBefore: before.plan.duplicateKeyCount,
    writeLine: write.syncLine,
    afterPending,
    duplicateKeyCountAfter: after.plan?.duplicateKeyCount ?? null,
  });
}
const report = {
  generatedAt: new Date().toISOString(),
  insertReportPath,
  outPath,
  results,
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
const failed = results.filter((row) => row.status !== 'synced');
if (failed.length) process.exitCode = 1;
NODE
```

Expected: every result has `status: "synced"` and `afterPending: 0`.

## Task 8: Final Verification And Report

**Files:**
- Read: `.runtime/jrcpcx-cdp-backfill-${STAMP}-insert-report.json`
- Read: `.runtime/jrcpcx-cdp-backfill-${STAMP}-feishu-sync-report.json`
- Read: `.runtime/policy-ocr.sqlite`

- [ ] **Step 1: Verify inserted rows locally**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { createKnowledgeStateStore } from './scripts/runtime-knowledge-state.mjs';
const stamp = process.env.STAMP;
const insertReport = JSON.parse(fs.readFileSync(`.runtime/jrcpcx-cdp-backfill-${stamp}-insert-report.json`, 'utf8'));
const minId = insertReport.insertedMinId;
const maxId = insertReport.insertedMaxId;
const store = await createKnowledgeStateStore();
try {
  const rows = (store.loadState().knowledgeRecords || []).filter((row) => Number(row.id) >= minId && Number(row.id) <= maxId);
  const byCompany = {};
  const byQualityStatus = {};
  let blank = 0;
  let missingPdf = 0;
  for (const row of rows) {
    byCompany[row.company] = (byCompany[row.company] || 0) + 1;
    byQualityStatus[row.qualityStatus || row.responsibilityQualityStatus || 'unknown'] = (byQualityStatus[row.qualityStatus || row.responsibilityQualityStatus || 'unknown'] || 0) + 1;
    if (!String(row.responsibilityText || row.pageText || '').trim()) blank += 1;
    if (!String(row.pdfLocalPath || '').trim() || !fs.existsSync(String(row.pdfLocalPath || '').trim())) missingPdf += 1;
  }
  console.log(JSON.stringify({
    total: store.countKnowledgeRecords(),
    minId,
    maxId,
    count: rows.length,
    blank,
    missingPdf,
    byCompany,
    byQualityStatus,
  }, null, 2));
} finally {
  store.close();
}
NODE
```

Expected: `blank: 0`, `missingPdf: 0`, and `count` equals the insert report's `insertedCount`.

- [ ] **Step 2: Verify Feishu sync report**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const stamp = process.env.STAMP;
const report = JSON.parse(fs.readFileSync(`.runtime/jrcpcx-cdp-backfill-${stamp}-feishu-sync-report.json`, 'utf8'));
console.log(JSON.stringify({
  resultCount: report.results.length,
  statuses: report.results.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] || 0) + 1;
    return acc;
  }, {}),
  results: report.results.map((row) => ({
    company: row.company,
    tableName: row.tableName,
    status: row.status,
    expectedCount: row.expectedCount,
    beforePending: row.beforePending,
    afterPending: row.afterPending,
  })),
}, null, 2));
NODE
```

Expected: all statuses are `synced` and every `afterPending` is `0`.

- [ ] **Step 3: Confirm no source files changed during data run**

Run:

```bash
git status --short
```

Expected: no new source-code changes from this data run. Existing unrelated dirty files may still appear and should not be reverted.

- [ ] **Step 4: Summarize for the user**

Run:

```bash
node --input-type=module - <<'NODE'
import fs from 'node:fs';
const stamp = process.env.STAMP;
const insertReport = JSON.parse(fs.readFileSync(`.runtime/jrcpcx-cdp-backfill-${stamp}-insert-report.json`, 'utf8'));
const syncReport = JSON.parse(fs.readFileSync(`.runtime/jrcpcx-cdp-backfill-${stamp}-feishu-sync-report.json`, 'utf8'));
const synced = syncReport.results.filter((row) => row.status === 'synced');
const blocked = syncReport.results.filter((row) => row.status !== 'synced');
const lines = [
  '本轮 JRCPCX/CDP 补库完成：',
  `- 本地新增: ${insertReport.insertedCount}`,
  `- ID 范围: ${insertReport.insertedMinId}-${insertReport.insertedMaxId}`,
  `- 公司分布: ${JSON.stringify(insertReport.byCompany)}`,
  `- 质量: ${JSON.stringify(insertReport.byQualityStatus)}`,
  `- 飞书: ${synced.length} 家公司同步后 dry-run 待创建 0`,
  `- 阻塞: ${blocked.length ? JSON.stringify(blocked.map((row) => ({ company: row.company, status: row.status }))) : '无'}`,
  '- 未改源码；未跑测试，原因是本轮为数据操作',
];
console.log(lines.join('\n'));
NODE
```

Expected: the user can see local count, ID range, company split, quality split, Feishu parity, and blocked rows.
