# Low-Coverage Official Product Backfill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add official-source insurance responsibility records for low-coverage insurers into the development SQLite knowledge library, then sync the verified new rows to the matching Feishu tables.

**Architecture:** Reuse the existing insurer-specific official crawler scripts for companies that already write through `createKnowledgeStateStore`, keep all writes pointed at `.runtime/local/policy-ocr.sqlite`, validate every inserted row against `policy-qa` source-citation rules and `policy-liability-qa` responsibility-text rules, then sync each company to its Feishu config with dry-run, write, and post-write readback.

**Tech Stack:** Node.js ESM scripts, existing SQLite knowledge state store, existing Scrapling Python crawler bridge, `sqlite3`, existing `sync-feishu-knowledge.mjs`, `.runtime` JSON/log artifacts.

---

## Files

- Read: `docs/superpowers/specs/2026-06-21-low-coverage-official-product-backfill-design.md`
- Read: `/Users/wenshuping/.codex/skills/policy-qa/SKILL.md`
- Read: `/Users/wenshuping/.agents/skills/policy-liability-qa/SKILL.md`
- Read: `docs/insurer-official-domain-whitelist.md`
- Read: `scripts/runtime-knowledge-state.mjs`
- Read: `scripts/sync-feishu-knowledge.mjs`
- Execute: `scripts/crawl-yingda-life-knowledge.mjs`
- Execute: `scripts/crawl-haibao-life-knowledge.mjs`
- Execute: `scripts/crawl-huahui-life-knowledge.mjs`
- Execute: `scripts/crawl-xiaokang-life-knowledge.mjs`
- Execute only for the 人保寿险 alias follow-up: `scripts/jrcpcx-major-company-gap-backfill.mjs`
- Runtime write target: `.runtime/local/policy-ocr.sqlite`
- Runtime backup target: `.runtime/local/backups/`
- Runtime artifacts:
  - `.runtime/low-coverage-official-backfill-$STAMP/baseline.json`
  - `.runtime/low-coverage-official-backfill-$STAMP/source-profile.json`
  - `.runtime/low-coverage-official-backfill-$STAMP/yingda-crawl.json`
  - `.runtime/low-coverage-official-backfill-$STAMP/haibao-crawl.json`
  - `.runtime/low-coverage-official-backfill-$STAMP/huahui-crawl.json`
  - `.runtime/low-coverage-official-backfill-$STAMP/xiaokang-crawl.json`
  - `.runtime/low-coverage-official-backfill-$STAMP/local-insert-validation.json`
  - `.runtime/low-coverage-official-backfill-$STAMP/feishu-*.log`
  - `.runtime/low-coverage-official-backfill-$STAMP/final-report.json`

## Batch Scope

Use this first execution batch:

- `英大人寿`
- `海保人寿`
- `华汇人寿`
- `小康人寿`

Alias follow-up:

- `中国人民人寿保险股份有限公司` maps to the existing `人保寿险` table. Do not use `scripts/crawl-picc-life-knowledge.mjs` for this batch because that script still writes through a state-file path instead of the required `.runtime/local/policy-ocr.sqlite` path. If 人保寿险 is included in the same execution run, use `scripts/jrcpcx-major-company-gap-backfill.mjs` with `--db-path=.runtime/local/policy-ocr.sqlite`.

Feishu config mapping:

- `英大人寿` -> `.runtime/feishu-knowledge-yingda-life.json`
- `华汇人寿` -> `.runtime/feishu-knowledge-huahui-life.json`
- `小康人寿` -> `.runtime/feishu-knowledge-xiaokang-life.json`
- `海保人寿` -> config must be confirmed before Feishu write. The current workspace did not show `.runtime/feishu-knowledge-haibao-life.json`; if still absent, local SQLite may be completed for 海保, but Feishu completion cannot be claimed until the matching config/table is available.

## Task 1: Prepare The Run And Lock The Active Database

**Files:**
- Read/write runtime only: `.runtime/local/policy-ocr.sqlite`
- Runtime only: `.runtime/low-coverage-official-backfill-$STAMP/baseline.json`

- [ ] **Step 1: Set environment variables for the development database**

Run:

```bash
cd /Users/wenshuping/Documents/OCR_insurance
export POLICY_OCR_APP_DB_PATH="$PWD/.runtime/local/policy-ocr.sqlite"
export POLICY_OCR_APP_STATE_PATH="$PWD/.runtime/local/state.json"
export STAMP="$(date +%Y%m%d-%H%M%S)"
export RUN_DIR="$PWD/.runtime/low-coverage-official-backfill-$STAMP"
mkdir -p "$RUN_DIR" "$PWD/.runtime/local/backups"
```

Expected: `$POLICY_OCR_APP_DB_PATH` is `/Users/wenshuping/Documents/OCR_insurance/.runtime/local/policy-ocr.sqlite` and `$RUN_DIR` exists.

- [ ] **Step 2: Confirm the active database exists**

Run:

```bash
node --input-type=module -e "import fs from 'node:fs'; const p=process.env.POLICY_OCR_APP_DB_PATH; if (!fs.existsSync(p)) throw new Error('missing db '+p); console.log(p);"
```

Expected output:

```text
/Users/wenshuping/Documents/OCR_insurance/.runtime/local/policy-ocr.sqlite
```

- [ ] **Step 3: Save the baseline counts**

Run:

```bash
node --input-type=module <<'NODE' > "$RUN_DIR/baseline.json"
import { createKnowledgeStateStore } from './scripts/runtime-knowledge-state.mjs';

const targets = ['英大人寿', '海保人寿', '华汇人寿', '小康人寿', '人保寿险', '中国人民人寿保险股份有限公司'];
const store = await createKnowledgeStateStore({
  dbPath: process.env.POLICY_OCR_APP_DB_PATH,
  seedStatePath: process.env.POLICY_OCR_APP_STATE_PATH,
});
try {
  const state = store.loadState();
  const rows = state.knowledgeRecords || [];
  const byCompany = Object.fromEntries(targets.map((company) => [company, rows.filter((row) => row.company === company).length]));
  const blankInvalid = rows.filter((row) => !String(row.pageText || '').trim()).length;
  console.log(JSON.stringify({
    dbPath: store.dbPath,
    total: rows.length,
    blankInvalid,
    byCompany,
    generatedAt: new Date().toISOString(),
  }, null, 2));
} finally {
  store.close();
}
NODE
```

Expected: `dbPath` points to `.runtime/local/policy-ocr.sqlite`, `total` is greater than `0`, and `blankInvalid` is `0`.

## Task 2: Confirm Official Source Boundaries

**Files:**
- Read: `docs/insurer-official-domain-whitelist.md`
- Runtime only: `.runtime/low-coverage-official-backfill-$STAMP/source-profile.json`

- [ ] **Step 1: Write the source profile from the existing whitelist and crawler paths**

Run:

```bash
node --input-type=module <<'NODE' > "$RUN_DIR/source-profile.json"
const profile = {
  generatedAt: new Date().toISOString(),
  sourceRule: 'policy-qa: official source URL and document citation required; refuse/skip when source is missing or low confidence',
  responsibilityRule: 'policy-liability-qa: responsibility text must include a concrete trigger plus payout, reimbursement, waiver, annuity, survival, maturity, death, disability, disease, or medical rule',
  targets: [
    {
      company: '英大人寿',
      script: 'scripts/crawl-yingda-life-knowledge.mjs',
      allowedOfficialDomains: ['ydthlife.com', 'www.ydthlife.com'],
      feishuConfigPath: '.runtime/feishu-knowledge-yingda-life.json',
      status: 'ready_for_sqlite_and_feishu',
    },
    {
      company: '海保人寿',
      script: 'scripts/crawl-haibao-life-knowledge.mjs',
      allowedOfficialDomains: ['haibao-life.com', 'www.haibao-life.com'],
      feishuConfigPath: '.runtime/feishu-knowledge-haibao-life.json',
      status: 'ready_for_sqlite; feishu_config_must_exist_before_write',
    },
    {
      company: '华汇人寿',
      script: 'scripts/crawl-huahui-life-knowledge.mjs',
      allowedOfficialDomains: ['sciclife.com', 'www.sciclife.com'],
      feishuConfigPath: '.runtime/feishu-knowledge-huahui-life.json',
      status: 'ready_for_sqlite_and_feishu',
    },
    {
      company: '小康人寿',
      script: 'scripts/crawl-xiaokang-life-knowledge.mjs',
      allowedOfficialDomains: ['livit-life.com', 'www.livit-life.com'],
      feishuConfigPath: '.runtime/feishu-knowledge-xiaokang-life.json',
      status: 'ready_for_sqlite_and_feishu',
    },
    {
      company: '中国人民人寿保险股份有限公司',
      canonicalCompany: '人保寿险',
      script: 'scripts/jrcpcx-major-company-gap-backfill.mjs',
      allowedOfficialDomains: ['inspdinfo.iachina.cn'],
      feishuConfigPath: '.runtime/feishu-knowledge-picc-life.json',
      status: 'alias_follow_up_only',
    },
  ],
};
console.log(JSON.stringify(profile, null, 2));
NODE
```

Expected: the JSON has exactly five entries and marks `海保人寿` as requiring Feishu config confirmation.

- [ ] **Step 2: Verify required crawler scripts exist**

Run:

```bash
node --input-type=module -e "import fs from 'node:fs'; for (const f of ['scripts/crawl-yingda-life-knowledge.mjs','scripts/crawl-haibao-life-knowledge.mjs','scripts/crawl-huahui-life-knowledge.mjs','scripts/crawl-xiaokang-life-knowledge.mjs','scripts/jrcpcx-major-company-gap-backfill.mjs']) { if (!fs.existsSync(f)) throw new Error('missing '+f); console.log(f); }"
```

Expected: all five script paths print.

## Task 3: Back Up SQLite Before Any Data Write

**Files:**
- Read: `.runtime/local/policy-ocr.sqlite`
- Create: `.runtime/local/backups/policy-ocr-before-low-coverage-official-backfill-$STAMP.sqlite`

- [ ] **Step 1: Create a SQLite backup**

Run:

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" "VACUUM INTO '$PWD/.runtime/local/backups/policy-ocr-before-low-coverage-official-backfill-$STAMP.sqlite';"
ls -lh "$PWD/.runtime/local/backups/policy-ocr-before-low-coverage-official-backfill-$STAMP.sqlite"
```

Expected: backup file exists and is non-empty.

- [ ] **Step 2: Record the pre-write total**

Run:

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" "SELECT COUNT(*) FROM knowledge_records;" | tee "$RUN_DIR/pre-write-count.txt"
```

Expected: the count matches `baseline.json.total`.

## Task 4: Run Official Crawlers For The First Batch

**Files:**
- Execute: `scripts/crawl-yingda-life-knowledge.mjs`
- Execute: `scripts/crawl-haibao-life-knowledge.mjs`
- Execute: `scripts/crawl-huahui-life-knowledge.mjs`
- Execute: `scripts/crawl-xiaokang-life-knowledge.mjs`
- Runtime outputs under `$RUN_DIR`

- [ ] **Step 1: Crawl 英大人寿 official materials**

Run:

```bash
node scripts/crawl-yingda-life-knowledge.mjs --source=all --sale-status=all --max-products=80 --max-workers=4 | tee "$RUN_DIR/yingda-crawl.json"
```

Expected: JSON has `ok: true`, `company: "英大人寿"`, `dbPath` equal to `.runtime/local/policy-ocr.sqlite`, and `newSavedRecordCount` is a number.

- [ ] **Step 2: Crawl 海保人寿 official materials**

Run:

```bash
node scripts/crawl-haibao-life-knowledge.mjs --sale-status=all --max-products=80 --max-workers=4 | tee "$RUN_DIR/haibao-crawl.json"
```

Expected: JSON has `ok: true`, `company: "海保人寿"`, `dbPath` equal to `.runtime/local/policy-ocr.sqlite`, and `newSavedRecordCount` is a number.

- [ ] **Step 3: Crawl 华汇人寿 official materials**

Run:

```bash
node scripts/crawl-huahui-life-knowledge.mjs --sale-status=all --new-only=1 --max-products=80 --max-workers=4 | tee "$RUN_DIR/huahui-crawl.json"
```

Expected: JSON has `ok: true`, `company: "华汇人寿"`, `newOnly: true`, `dbPath` equal to `.runtime/local/policy-ocr.sqlite`, and `newSavedRecordCount` is a number.

- [ ] **Step 4: Crawl 小康人寿 official materials**

Run:

```bash
node scripts/crawl-xiaokang-life-knowledge.mjs --sale-status=all --skip-existing --max-products=80 --max-workers=4 | tee "$RUN_DIR/xiaokang-crawl.json"
```

Expected: JSON has `ok: true`, `company: "小康人寿"`, `skipExisting: true`, `dbPath` equal to `.runtime/local/policy-ocr.sqlite`, and `newSavedRecordCount` is a number.

- [ ] **Step 5: Stop on anti-bot or official-source failure**

If any crawler returns human verification, request congestion, a login wall, non-official redirect, non-material HTML, missing official domain, or a failed download, stop that company and record the blocker in `$RUN_DIR/final-report.json`. Continue only with companies whose crawler completed and whose inserted rows can be validated.

## Task 5: Validate Inserted Local Rows Against The Two Quality Skills

**Files:**
- Read: `$RUN_DIR/*-crawl.json`
- Read: `.runtime/local/policy-ocr.sqlite`
- Runtime output: `$RUN_DIR/local-insert-validation.json`

- [ ] **Step 1: Build a validation report from the crawler outputs**

Run:

```bash
node --input-type=module <<'NODE' > "$RUN_DIR/local-insert-validation.json"
import fs from 'node:fs';
import path from 'node:path';
import { createKnowledgeStateStore } from './scripts/runtime-knowledge-state.mjs';

const runDir = process.env.RUN_DIR;
const reports = ['yingda', 'haibao', 'huahui', 'xiaokang']
  .map((name) => {
    const filePath = path.join(runDir, `${name}-crawl.json`);
    const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const jsonText = raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    return { name, filePath, report: jsonText ? JSON.parse(jsonText) : null };
  });

const idRanges = reports
  .map(({ name, report }) => ({
    name,
    company: report?.company || '',
    min: Number(report?.newSavedMinId || 0),
    max: Number(report?.newSavedMaxId || 0),
    newSavedRecordCount: Number(report?.newSavedRecordCount || 0),
    dbPath: report?.dbPath || '',
  }))
  .filter((item) => item.min > 0 && item.max >= item.min && item.newSavedRecordCount > 0);

const triggerPattern = /(身故|全残|伤残|疾病|确诊|医疗费用|住院|津贴|年金|生存|满期|祝寿|豁免|养老|领取|给付|赔付|报销|补偿|保险金)/u;
const payoutPattern = /(给付|赔付|报销|补偿|免交|豁免|基本保险金额|已交保险费|累计已交|现金价值|账户价值|实际发生|医疗费用|领取金额|保险金金额|按.*%|乘以)/u;
const officialDomains = {
  '英大人寿': ['ydthlife.com'],
  '海保人寿': ['haibao-life.com'],
  '华汇人寿': ['sciclife.com'],
  '小康人寿': ['livit-life.com'],
};

const store = await createKnowledgeStateStore({
  dbPath: process.env.POLICY_OCR_APP_DB_PATH,
  seedStatePath: process.env.POLICY_OCR_APP_STATE_PATH,
});
try {
  const rows = store.loadState().knowledgeRecords || [];
  const inserted = [];
  for (const range of idRanges) {
    for (const row of rows) {
      const id = Number(row.id || 0);
      if (id >= range.min && id <= range.max && row.company === range.company) inserted.push(row);
    }
  }
  const invalid = inserted.filter((row) => {
    const text = String(row.pageText || '').trim();
    const domain = String(row.officialDomain || row.url || '').trim();
    const allowed = officialDomains[row.company] || [];
    return !text
      || !String(row.url || '').trim()
      || !allowed.some((item) => domain.includes(item))
      || !triggerPattern.test(text)
      || !payoutPattern.test(text);
  }).map((row) => ({
    id: row.id,
    company: row.company,
    productName: row.productName,
    title: row.title,
    url: row.url,
    officialDomain: row.officialDomain,
    pageTextLength: String(row.pageText || '').trim().length,
  }));
  const byCompany = {};
  for (const row of inserted) byCompany[row.company] = (byCompany[row.company] || 0) + 1;
  console.log(JSON.stringify({
    dbPath: store.dbPath,
    idRanges,
    insertedCount: inserted.length,
    byCompany,
    invalidCount: invalid.length,
    invalid,
    validationBasis: [
      'policy-qa: official URL/domain must be present and source-supported',
      'policy-liability-qa: responsibility text must include both trigger and payout/reimbursement/waiver/cashflow obligation language',
    ],
    generatedAt: new Date().toISOString(),
  }, null, 2));
} finally {
  store.close();
}
NODE
```

Expected: `invalidCount` is `0`. If `invalidCount` is greater than `0`, do not sync those IDs to Feishu; inspect and repair or exclude them first.

- [ ] **Step 2: Confirm local count increased by the crawler-reported amount**

Run:

```bash
sqlite3 "$POLICY_OCR_APP_DB_PATH" "SELECT COUNT(*) FROM knowledge_records;" | tee "$RUN_DIR/post-write-count.txt"
node --input-type=module -e "import fs from 'node:fs'; const before=Number(fs.readFileSync(process.env.RUN_DIR+'/pre-write-count.txt','utf8').trim()); const after=Number(fs.readFileSync(process.env.RUN_DIR+'/post-write-count.txt','utf8').trim()); const v=JSON.parse(fs.readFileSync(process.env.RUN_DIR+'/local-insert-validation.json','utf8')); if (after-before !== v.insertedCount) throw new Error(`count mismatch before=${before} after=${after} validated=${v.insertedCount}`); console.log(JSON.stringify({before, after, delta: after-before, validated: v.insertedCount}, null, 2));"
```

Expected: `delta` equals `validated`.

## Task 6: Sync Verified Rows To Feishu

**Files:**
- Read: `$RUN_DIR/local-insert-validation.json`
- Execute: `scripts/sync-feishu-knowledge.mjs`
- Runtime logs: `$RUN_DIR/feishu-*.log`

- [ ] **Step 1: Generate per-company Feishu sync commands**

Run:

```bash
node --input-type=module <<'NODE' > "$RUN_DIR/feishu-command-plan.sh"
import fs from 'node:fs';

const validation = JSON.parse(fs.readFileSync(`${process.env.RUN_DIR}/local-insert-validation.json`, 'utf8'));
const config = {
  '英大人寿': { configPath: '.runtime/feishu-knowledge-yingda-life.json', tableName: '英大人寿' },
  '华汇人寿': { configPath: '.runtime/feishu-knowledge-huahui-life.json', tableName: '华汇人寿' },
  '小康人寿': { configPath: '.runtime/feishu-knowledge-xiaokang-life.json', tableName: '小康人寿' },
  '海保人寿': { configPath: '.runtime/feishu-knowledge-haibao-life.json', tableName: '海保人寿' },
};

const lines = [
  'set -euo pipefail',
  'cd /Users/wenshuping/Documents/OCR_insurance',
  'export POLICY_OCR_APP_DB_PATH="$PWD/.runtime/local/policy-ocr.sqlite"',
  'export POLICY_OCR_APP_STATE_PATH="$PWD/.runtime/local/state.json"',
];

for (const range of validation.idRanges) {
  const item = config[range.company];
  if (!item) continue;
  if (!fs.existsSync(item.configPath)) {
    lines.push(`echo "SKIP_FEISHU_CONFIG_MISSING ${range.company} ${item.configPath}" | tee "$RUN_DIR/feishu-${range.name}-missing-config.log"`);
    continue;
  }
  lines.push(`node scripts/sync-feishu-knowledge.mjs --company=${range.company} --config-path=${item.configPath} --table-name=${item.tableName} --local-id-min=${range.min} --local-id-max=${range.max} --create-only --skip-existing-local-ids --dry-run | tee "$RUN_DIR/feishu-${range.name}-dry-run-before.log"`);
  lines.push(`node scripts/sync-feishu-knowledge.mjs --company=${range.company} --config-path=${item.configPath} --table-name=${item.tableName} --local-id-min=${range.min} --local-id-max=${range.max} --create-only --skip-existing-local-ids --batch-size=10 | tee "$RUN_DIR/feishu-${range.name}-write.log"`);
  lines.push(`node scripts/sync-feishu-knowledge.mjs --company=${range.company} --config-path=${item.configPath} --table-name=${item.tableName} --local-id-min=${range.min} --local-id-max=${range.max} --create-only --skip-existing-local-ids --dry-run | tee "$RUN_DIR/feishu-${range.name}-dry-run-after.log"`);
}

console.log(lines.join('\n'));
NODE
```

Expected: command file contains dry-run, write, and post-write dry-run for each company that has a Feishu config. For 海保人寿, the command file may contain `SKIP_FEISHU_CONFIG_MISSING` if the config is still absent.

- [ ] **Step 2: Run Feishu sync commands**

Run:

```bash
bash "$RUN_DIR/feishu-command-plan.sh"
```

Expected:

- Before dry-run: pending rows equal the local inserted count for that company after skipping remote existing IDs.
- Write: script reports created row count.
- After dry-run: pending rows are `0` for each synced company.
- Missing config: the company is reported as not synced rather than silently claimed complete.

## Task 7: Build The Final Report

**Files:**
- Read: `$RUN_DIR/baseline.json`
- Read: `$RUN_DIR/local-insert-validation.json`
- Read: `$RUN_DIR/feishu-*.log`
- Create: `$RUN_DIR/final-report.json`

- [ ] **Step 1: Summarize local and Feishu results**

Run:

```bash
node --input-type=module <<'NODE' > "$RUN_DIR/final-report.json"
import fs from 'node:fs';
import path from 'node:path';

const runDir = process.env.RUN_DIR;
const baseline = JSON.parse(fs.readFileSync(path.join(runDir, 'baseline.json'), 'utf8'));
const validation = JSON.parse(fs.readFileSync(path.join(runDir, 'local-insert-validation.json'), 'utf8'));
const logNames = fs.readdirSync(runDir).filter((name) => name.startsWith('feishu-') && name.endsWith('.log')).sort();
const feishu = logNames.map((name) => {
  const text = fs.readFileSync(path.join(runDir, name), 'utf8');
  const pendingMatch = text.match(/"count":\s*(\d+)/u);
  const createdMatch = text.match(/已同步\s+(\d+)\s+条知识库记录：新增\s+(\d+)/u);
  return {
    file: name,
    pendingCount: pendingMatch ? Number(pendingMatch[1]) : null,
    syncedCount: createdMatch ? Number(createdMatch[1]) : null,
    createdCount: createdMatch ? Number(createdMatch[2]) : null,
    skippedMissingConfig: text.includes('SKIP_FEISHU_CONFIG_MISSING'),
  };
});

const report = {
  runDir,
  dbPath: validation.dbPath,
  baselineTotal: baseline.total,
  insertedCount: validation.insertedCount,
  insertedByCompany: validation.byCompany,
  invalidCount: validation.invalidCount,
  idRanges: validation.idRanges,
  feishu,
  completionRule: 'A company is complete only when local validation passed and post-write Feishu dry-run has pendingCount 0. A missing config is local-only, not Feishu-complete.',
  generatedAt: new Date().toISOString(),
};
console.log(JSON.stringify(report, null, 2));
NODE
```

Expected: final report separates local-only companies from Feishu-complete companies.

- [ ] **Step 2: Verify completion criteria before reporting to the user**

Run:

```bash
node --input-type=module -e "import fs from 'node:fs'; const r=JSON.parse(fs.readFileSync(process.env.RUN_DIR+'/final-report.json','utf8')); if (r.invalidCount !== 0) throw new Error('invalid local rows remain'); console.log(JSON.stringify({insertedCount:r.insertedCount, insertedByCompany:r.insertedByCompany, feishu:r.feishu}, null, 2));"
```

Expected: inserted rows are reported by company. Feishu-complete companies have a post-write dry-run pending count of `0`.

## Task 8: Optional 人保寿险 Alias Follow-Up

**Files:**
- Execute: `scripts/jrcpcx-major-company-gap-backfill.mjs`
- Runtime only: `.runtime/jrcpcx-major-company-gap-*`
- Runtime only: `.runtime/feishu-knowledge-picc-life.json`

- [ ] **Step 1: Confirm the existing JRCPCX path before any 人保寿险 execution**

Use this only after Tasks 1-7 complete or when a subagent is assigned specifically to the 人保寿险 alias gap. This plan does not use `scripts/crawl-picc-life-knowledge.mjs`.

Run:

```bash
rg -n "中国人民人寿保险股份有限公司|人保寿险|feishu-knowledge-picc-life|--mode=insert" docs/superpowers/plans/2026-06-21-jrcpcx-major-company-gap-backfill.md scripts/jrcpcx-major-company-gap-backfill.mjs
```

Expected: output shows the existing 人保寿险 mapping, `.runtime/feishu-knowledge-picc-life.json`, and the supported `--mode=insert` path.

- [ ] **Step 2: Execute 人保寿险 through the existing JRCPCX plan when requested**

Run the existing plan task sequence in:

```bash
sed -n '720,840p' docs/superpowers/plans/2026-06-21-jrcpcx-major-company-gap-backfill.md
```

Expected: the execution commands use `scripts/jrcpcx-major-company-gap-backfill.mjs --mode=insert`, pass `--db-path=.runtime/local/policy-ocr.sqlite` when applying this development-database rule, and sync to `.runtime/feishu-knowledge-picc-life.json`.

## Final Verification

- [ ] Active local database is `.runtime/local/policy-ocr.sqlite`.
- [ ] SQLite backup exists before any write.
- [ ] New local rows have official URL, official domain, parser/source fields, non-empty `pageText`, and valid responsibility wording.
- [ ] No row is inserted from third-party pages, catalogs without material links, pure exclusions, claim procedures, cash-value-only text, OCR garbage, or continuation fragments.
- [ ] Local count delta equals validated inserted count.
- [ ] Feishu dry-run runs before write for every synced company.
- [ ] Feishu post-write dry-run shows pending create count `0` for every company claimed complete.
- [ ] 海保人寿 is reported as local-only if `.runtime/feishu-knowledge-haibao-life.json` is still absent.
- [ ] Final report includes inserted, skipped, blocked, local-only, and Feishu-complete counts by company.
