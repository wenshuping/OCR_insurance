# PP-StructureV3 Offline Inspection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only PP-StructureV3 inspection command that turns insurance policy images into raw StructureV3 outputs, normalized tables, field candidates, and a human-readable report without touching the production OCR flow.

**Architecture:** Keep the feature isolated from `server/`, `src/`, SQLite, and the existing OCR provider flow. Add one Python runner for PP-StructureV3, one Node normalizer for deterministic table/field extraction, and one Node CLI that writes inspection artifacts under `.structurev3-inspect/`. The normalizer owns all business rules: raw tables first, first valid product row is main, multiple riders allowed, and total premium stays separate from row premiums.

**Tech Stack:** Node ESM `.mjs`, `node:test`, local Python 3, PaddleOCR `PPStructureV3`, no new npm dependencies, generated inspection files ignored by git.

---

## File Structure

- Create: `ocr-service/policy-structurev3-normalizer.mjs`
  - Pure JavaScript normalizer. Converts raw StructureV3-like payloads and Markdown tables into `normalized` and `candidates` objects.
- Create: `tests/policy-structurev3-normalizer.test.mjs`
  - Focused tests for raw-table priority, main/rider row rules, total premium separation, Markdown fallback, and missing-field behavior.
- Create: `ocr-service/scripts/policy_ocr_structurev3.py`
  - Python runner. Accepts an input image and output directory, runs `PPStructureV3`, saves raw JSON/Markdown, and prints a compact JSON status payload.
- Create: `scripts/inspect-pp-structurev3.mjs`
  - CLI. Supports a file or directory input, calls the Python runner, normalizes output, writes `input.meta.json`, `normalized.json`, `candidates.json`, and `report.md`.
- Modify: `package.json`
  - Add `ocr:structurev3:inspect`.
- Modify: `.gitignore`
  - Ignore `.structurev3-inspect/`.

Implementation must not modify `server/`, `src/`, SQLite stores, OCR service router, or existing OCR provider config.

## Data Contract

The normalizer returns this shape:

```js
{
  normalized: {
    ocrText: '按阅读顺序拼接的文本',
    blocks: [
      { type: 'text', text: '投保人 张三', bbox: [], confidence: 0 }
    ],
    tables: [
      {
        title: '保险利益表',
        source: 'raw-table',
        headers: ['险种名称', '保险金额', '保险期间', '交费期间', '保险费'],
        rows: [
          ['主险名称', '100000', '终身', '20年交', '4334']
        ]
      }
    ],
    warnings: []
  },
  candidates: {
    policyFields: {
      company: { value: '新华保险', source: 'text', evidence: '新华保险' },
      productName: { value: '主险名称', source: 'plans[0].name', evidence: '保险利益表第1个有效产品行' },
      applicant: { value: '张三', source: 'text', evidence: '投保人 张三' },
      insured: { value: '李四', source: 'text', evidence: '被保险人 李四' },
      beneficiary: { value: '法定', source: 'text', evidence: '受益人 法定' },
      firstPremium: { value: '5000', source: 'premium-total-row', evidence: '首期保险费合计 5000' }
    },
    plans: [
      {
        role: 'main',
        name: '主险名称',
        amount: '100000',
        paymentPeriod: '20年交',
        coveragePeriod: '终身',
        premium: '4334',
        source: 'raw-table row 1'
      }
    ],
    missingFields: [],
    ambiguousFields: []
  }
}
```

## Task 1: Normalizer Tests

**Files:**
- Create: `tests/policy-structurev3-normalizer.test.mjs`
- Create later in Task 2: `ocr-service/policy-structurev3-normalizer.mjs`

- [ ] **Step 1: Write failing tests for raw table extraction**

Create `tests/policy-structurev3-normalizer.test.mjs` with this content:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildStructureV3InspectionReport,
  normalizeStructureV3Inspection,
} from '../ocr-service/policy-structurev3-normalizer.mjs';

const rawStructureFixture = {
  blocks: [
    { type: 'title', text: '新华保险 保险单' },
    { type: 'text', text: '投保人 张三' },
    { type: 'text', text: '被保险人 李四' },
    { type: 'text', text: '身故保险金受益人 法定' },
  ],
  tables: [
    {
      title: '保险利益表',
      source: 'raw-table',
      headers: ['险种名称', '基本保险金额', '保险期间', '交费期间', '保险费'],
      rows: [
        ['盛世荣耀终身寿险', '100000元', '终身', '20年交', '4334元'],
        ['附加住院医疗保险', '20000元', '1年', '1年交', '266元'],
        ['附加意外伤害保险', '50000元', '1年', '1年交', '400元'],
        ['首期保险费合计', '', '', '', '5000元'],
      ],
    },
  ],
};

test('normalizeStructureV3Inspection prefers raw tables and separates main, riders, and total premium', () => {
  const result = normalizeStructureV3Inspection({
    raw: rawStructureFixture,
    markdown: '| 险种名称 | 基本保险金额 | 保险期间 | 交费期间 | 保险费 |\\n| --- | --- | --- | --- | --- |\\n| 错误主险 | 1元 | 1年 | 1年交 | 1元 |',
  });

  assert.equal(result.normalized.tables.length, 1);
  assert.equal(result.normalized.tables[0].source, 'raw-table');
  assert.equal(result.candidates.policyFields.company.value, '新华保险');
  assert.equal(result.candidates.policyFields.productName.value, '盛世荣耀终身寿险');
  assert.equal(result.candidates.policyFields.applicant.value, '张三');
  assert.equal(result.candidates.policyFields.insured.value, '李四');
  assert.equal(result.candidates.policyFields.beneficiary.value, '法定');
  assert.equal(result.candidates.policyFields.firstPremium.value, '5000');
  assert.deepEqual(result.candidates.plans.map((plan) => plan.role), ['main', 'rider', 'rider']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.name), [
    '盛世荣耀终身寿险',
    '附加住院医疗保险',
    '附加意外伤害保险',
  ]);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.amount), ['100000', '20000', '50000']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.paymentPeriod), ['20年交', '1年交', '1年交']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.coveragePeriod), ['终身', '1年', '1年']);
  assert.deepEqual(result.candidates.plans.map((plan) => plan.premium), ['4334', '266', '400']);
});

test('normalizeStructureV3Inspection falls back to markdown tables when raw tables are unavailable', () => {
  const markdown = [
    '| 险种名称 | 基本保险金额 | 保险期间 | 缴费期间 | 保险费 |',
    '| --- | --- | --- | --- | --- |',
    '| 鑫享终身寿险 | 80000元 | 终身 | 10年交 | 1234元 |',
    '| 附加豁免保险费疾病保险 | 0元 | 10年 | 10年交 | 88元 |',
    '| 首期保费合计 |  |  |  | 1322元 |',
  ].join('\\n');

  const result = normalizeStructureV3Inspection({
    raw: { blocks: [{ type: 'text', text: '中国平安保险 投保人 王五 被保险人 赵六 受益人 法定' }] },
    markdown,
  });

  assert.equal(result.normalized.tables[0].source, 'markdown-table');
  assert.equal(result.candidates.policyFields.company.value, '中国平安保险');
  assert.equal(result.candidates.policyFields.productName.value, '鑫享终身寿险');
  assert.equal(result.candidates.policyFields.firstPremium.value, '1322');
  assert.equal(result.candidates.plans[0].role, 'main');
  assert.equal(result.candidates.plans[1].role, 'rider');
});

test('normalizeStructureV3Inspection marks missing fields and does not borrow values across rows', () => {
  const result = normalizeStructureV3Inspection({
    raw: {
      blocks: [{ type: 'text', text: '新华保险 投保人 张三' }],
      tables: [
        {
          title: '保险利益表',
          headers: ['险种名称', '保险金额', '保险期间', '交费期间', '保险费'],
          rows: [
            ['主险A', '100000元', '终身', '20年交', ''],
            ['附加险B', '', '1年', '1年交', '100元'],
          ],
        },
      ],
    },
  });

  assert.equal(result.candidates.plans[0].premium, '');
  assert.equal(result.candidates.plans[1].amount, '');
  assert.ok(result.candidates.missingFields.includes('insured'));
  assert.ok(result.candidates.missingFields.includes('beneficiary'));
  assert.ok(result.normalized.warnings.some((warning) => warning.includes('缺少被保险人')));
});

test('buildStructureV3InspectionReport summarizes source quality and plan rows', () => {
  const result = normalizeStructureV3Inspection({ raw: rawStructureFixture });
  const report = buildStructureV3InspectionReport({
    input: 'samples/policy.jpg',
    result,
    pythonStatus: { ok: true, device: 'gpu' },
  });

  assert.match(report, /PP-StructureV3 离线验证报告/u);
  assert.match(report, /原始表格: 可用/u);
  assert.match(report, /主险: 盛世荣耀终身寿险/u);
  assert.match(report, /附加险: 附加住院医疗保险/u);
  assert.match(report, /首期保费合计: 5000/u);
  assert.match(report, /建议接入正式流程|需要更多样本/u);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --test tests/policy-structurev3-normalizer.test.mjs
```

Expected: FAIL with `Cannot find module '../ocr-service/policy-structurev3-normalizer.mjs'`.

- [ ] **Step 3: Keep the failing test uncommitted until Task 2 passes**

Run:

```bash
git status --short tests/policy-structurev3-normalizer.test.mjs
```

Expected: output shows `?? tests/policy-structurev3-normalizer.test.mjs` or `A tests/policy-structurev3-normalizer.test.mjs`. Do not commit this failing test by itself.

## Task 2: Pure Normalizer

**Files:**
- Create: `ocr-service/policy-structurev3-normalizer.mjs`
- Test: `tests/policy-structurev3-normalizer.test.mjs`

- [ ] **Step 1: Implement the normalizer**

Create `ocr-service/policy-structurev3-normalizer.mjs` with this content:

```js
function text(value) {
  return String(value ?? '').trim();
}

function compact(value) {
  return text(value).replace(/\s+/gu, '');
}

function normalizeAmount(value) {
  const raw = text(value).replace(/[,，]/gu, '').replace(/[¥￥]/gu, '');
  if (!raw) return '';
  const wan = raw.match(/(\d+(?:\.\d+)?)\s*万/u);
  if (wan) return String(Math.round(Number(wan[1]) * 10000));
  const yuan = raw.match(/(\d+(?:\.\d+)?)\s*(?:元|圆)?/u);
  if (!yuan) return raw;
  const number = Number(yuan[1]);
  return Number.isFinite(number) ? String(Math.round(number)) : raw;
}

function normalizeBlock(block = {}) {
  const blockText = text(block.text || block.content || block.block_content || block.value);
  if (!blockText) return null;
  return {
    type: text(block.type || block.block_type || block.label || 'text') || 'text',
    text: blockText,
    bbox: Array.isArray(block.bbox || block.box) ? (block.bbox || block.box) : [],
    confidence: Number(block.confidence || block.score || 0) || 0,
  };
}

function rawPayloads(raw) {
  const payloads = [raw].filter(Boolean);
  if (Array.isArray(raw?.results)) payloads.push(...raw.results);
  if (raw?.res && typeof raw.res === 'object') payloads.push(raw.res);
  return payloads;
}

function collectBlocks(raw) {
  const candidates = [];
  for (const payload of rawPayloads(raw)) {
    if (Array.isArray(payload?.blocks)) candidates.push(...payload.blocks);
    if (Array.isArray(payload?.parsing_res_list)) candidates.push(...payload.parsing_res_list);
    if (Array.isArray(payload?.res?.parsing_res_list)) candidates.push(...payload.res.parsing_res_list);
  }
  return candidates.map(normalizeBlock).filter(Boolean);
}

function normalizeRows(rows = []) {
  return rows
    .filter((row) => Array.isArray(row))
    .map((row) => row.map((cell) => text(cell)))
    .filter((row) => row.some(Boolean));
}

function normalizeRawTable(table = {}, index = 0) {
  const headers = Array.isArray(table.headers) ? table.headers.map(text).filter(Boolean) : [];
  const rows = normalizeRows(table.rows);
  if (!headers.length || !rows.length) return null;
  return {
    title: text(table.title || table.name || `表格${index + 1}`),
    source: 'raw-table',
    headers,
    rows,
  };
}

function collectRawTables(raw) {
  const tables = [];
  for (const payload of rawPayloads(raw)) {
    if (Array.isArray(payload?.tables)) tables.push(...payload.tables);
    if (Array.isArray(payload?.res?.tables)) tables.push(...payload.res.tables);
  }
  return tables.map(normalizeRawTable).filter(Boolean);
}

function splitMarkdownRow(line) {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => text(cell.replace(/<br\s*\/?>/giu, ' ')));
}

function isMarkdownDivider(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(compact(cell)));
}

function collectMarkdownTables(markdown = '') {
  const tables = [];
  const lines = String(markdown || '').replace(/\r/gu, '\n').split('\n');
  let current = [];
  function flush() {
    if (current.length >= 2) {
      const rows = current.map(splitMarkdownRow);
      const headers = rows[0].map(text).filter(Boolean);
      const bodyRows = rows.slice(isMarkdownDivider(rows[1]) ? 2 : 1);
      const normalizedRows = normalizeRows(bodyRows);
      if (headers.length && normalizedRows.length) {
        tables.push({
          title: `Markdown表格${tables.length + 1}`,
          source: 'markdown-table',
          headers,
          rows: normalizedRows,
        });
      }
    }
    current = [];
  }
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      current.push(line);
    } else {
      flush();
    }
  }
  flush();
  return tables;
}

function headerIndex(headers, patterns) {
  return headers.findIndex((header) => patterns.some((pattern) => pattern.test(compact(header))));
}

function planColumns(headers = []) {
  return {
    name: headerIndex(headers, [/险种名称/u, /产品名称/u, /保险名称/u, /主险名称/u]),
    amount: headerIndex(headers, [/基本保险金额/u, /保险金额/u, /保额/u, /金额/u]),
    coveragePeriod: headerIndex(headers, [/保险期间/u, /保障期间/u]),
    paymentPeriod: headerIndex(headers, [/交费期间/u, /缴费期间/u, /缴费年期/u]),
    premium: headerIndex(headers, [/首期?保险费/u, /保险费/u, /保费/u]),
  };
}

function isTotalPremiumText(value) {
  return /首期保险费合计|首期保费合计|保险费合计|合计保费|应交保险费合计/u.test(compact(value));
}

function isHeaderLikeRow(row = [], headers = []) {
  const rowText = compact(row.join(''));
  if (!rowText) return true;
  const headerText = compact(headers.join(''));
  if (rowText === headerText) return true;
  return /险种名称|产品名称|基本保险金额|保险期间|交费期间|缴费期间/u.test(rowText)
    && row.filter(Boolean).length <= headers.length;
}

function looksLikePlanName(value) {
  const name = compact(value);
  if (!name) return false;
  if (isTotalPremiumText(name)) return false;
  return /保险|险|寿|年金|医疗|意外|重疾|疾病|两全|万能|豁免/u.test(name);
}

function isRiderName(value) {
  return /附加|附加险|附加合同|附加医疗|附加意外/u.test(compact(value));
}

function fieldFromRow(row, index) {
  return index >= 0 ? text(row[index]) : '';
}

function sourceLabel(table, rowIndex) {
  return `${table.source} row ${rowIndex + 1}`;
}

function extractPlansAndPremium(tables = []) {
  const plans = [];
  let totalPremium = null;
  for (const table of tables) {
    const columns = planColumns(table.headers);
    for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex += 1) {
      const row = table.rows[rowIndex];
      const joined = row.join(' ');
      if (isHeaderLikeRow(row, table.headers)) continue;
      if (isTotalPremiumText(joined)) {
        const premiumValue = fieldFromRow(row, columns.premium) || row.map(normalizeAmount).find(Boolean) || '';
        if (premiumValue) {
          totalPremium = {
            value: normalizeAmount(premiumValue),
            source: 'premium-total-row',
            evidence: joined,
          };
        }
        continue;
      }
      const name = fieldFromRow(row, columns.name) || row.find(looksLikePlanName) || '';
      if (!looksLikePlanName(name)) continue;
      const planIndex = plans.length;
      plans.push({
        role: planIndex === 0 ? 'main' : (isRiderName(name) ? 'rider' : 'unknown'),
        name,
        amount: normalizeAmount(fieldFromRow(row, columns.amount)),
        paymentPeriod: fieldFromRow(row, columns.paymentPeriod),
        coveragePeriod: fieldFromRow(row, columns.coveragePeriod),
        premium: normalizeAmount(fieldFromRow(row, columns.premium)),
        source: sourceLabel(table, rowIndex),
      });
    }
  }
  return { plans, totalPremium };
}

function findCompany(ocrText) {
  const patterns = [
    /新华(?:人寿)?保险(?:股份有限公司)?/u,
    /中国平安(?:人寿|保险)?(?:股份有限公司)?/u,
    /中国人寿(?:保险)?(?:股份有限公司)?/u,
    /中国太平洋(?:人寿)?保险(?:股份有限公司)?/u,
    /太平人寿/u,
    /泰康(?:人寿|保险)/u,
    /友邦(?:人寿|保险)/u,
  ];
  const matched = patterns.map((pattern) => ocrText.match(pattern)?.[0]).find(Boolean);
  return matched || '';
}

function findLabeledValue(ocrText, labels) {
  for (const label of labels) {
    const pattern = new RegExp(`${label}[:：\\s]*([^\\n\\s|，,；;]{1,24})`, 'u');
    const matched = ocrText.match(pattern);
    if (matched?.[1]) return matched[1].replace(/^姓名/u, '');
  }
  return '';
}

function buildPolicyFields({ ocrText, plans, totalPremium }) {
  const fields = {};
  const company = findCompany(ocrText);
  if (company) fields.company = { value: company, source: 'text', evidence: company };
  if (plans[0]?.name) {
    fields.productName = {
      value: plans[0].name,
      source: 'plans[0].name',
      evidence: '保险利益表第1个有效产品行',
    };
  }
  const applicant = findLabeledValue(ocrText, ['投保人', '设保人']);
  if (applicant) fields.applicant = { value: applicant, source: 'text', evidence: `投保人 ${applicant}` };
  const insured = findLabeledValue(ocrText, ['被保险人', '被保人', '受保人']);
  if (insured) fields.insured = { value: insured, source: 'text', evidence: `被保险人 ${insured}` };
  const beneficiary = findLabeledValue(ocrText, ['身故保险金受益人', '身故受益人', '受益人']);
  if (beneficiary) fields.beneficiary = { value: beneficiary, source: 'text', evidence: `受益人 ${beneficiary}` };
  if (totalPremium?.value) fields.firstPremium = totalPremium;
  return fields;
}

function missingCoreFields(fields, plans) {
  const required = ['company', 'productName', 'applicant', 'insured', 'beneficiary', 'firstPremium'];
  const missing = required.filter((field) => !fields[field]?.value);
  if (!plans.length) missing.push('plans');
  return missing;
}

function warningForMissing(field) {
  const labels = {
    company: '缺少保险公司',
    productName: '缺少产品名称',
    applicant: '缺少投保人',
    insured: '缺少被保险人',
    beneficiary: '缺少受益人',
    firstPremium: '缺少首期保费合计',
    plans: '缺少主险/附加险计划行',
  };
  return labels[field] || `缺少${field}`;
}

export function normalizeStructureV3Inspection({ raw = {}, markdown = '' } = {}) {
  const blocks = collectBlocks(raw);
  const rawTables = collectRawTables(raw);
  const markdownTables = rawTables.length ? [] : collectMarkdownTables(markdown);
  const tables = rawTables.length ? rawTables : markdownTables;
  const ocrText = [
    ...blocks.map((block) => block.text),
    ...tables.flatMap((table) => [table.headers.join(' '), ...table.rows.map((row) => row.join(' '))]),
  ].filter(Boolean).join('\n');
  const { plans, totalPremium } = extractPlansAndPremium(tables);
  const policyFields = buildPolicyFields({ ocrText, plans, totalPremium });
  const missingFields = missingCoreFields(policyFields, plans);
  const warnings = [
    ...(!rawTables.length && markdownTables.length ? ['原始表格不可用，已降级使用 Markdown 表格'] : []),
    ...(!tables.length ? ['未识别到可用表格'] : []),
    ...missingFields.map(warningForMissing),
  ];
  return {
    normalized: {
      ocrText,
      blocks,
      tables,
      warnings,
    },
    candidates: {
      policyFields,
      plans,
      missingFields,
      ambiguousFields: plans.some((plan) => plan.role === 'unknown') ? ['planRole'] : [],
    },
  };
}

function fieldLine(label, field) {
  return `- ${label}: ${field?.value || '未识别'}${field?.source ? ` (${field.source})` : ''}`;
}

function planLine(plan) {
  const roleLabel = plan.role === 'main' ? '主险' : plan.role === 'rider' ? '附加险' : '待确认';
  return `- ${roleLabel}: ${plan.name || '未识别'} | 保额 ${plan.amount || '缺失'} | 缴费期间 ${plan.paymentPeriod || '缺失'} | 保障期间 ${plan.coveragePeriod || '缺失'} | 保费 ${plan.premium || '缺失'} | ${plan.source}`;
}

function recommendation(result) {
  const hasRawTable = result.normalized.tables.some((table) => table.source === 'raw-table');
  const plans = result.candidates.plans;
  const missing = result.candidates.missingFields;
  if (hasRawTable && plans.length && missing.length <= 2) return '建议接入正式流程';
  if (plans.length) return '需要更多样本';
  return '暂不建议接入';
}

export function buildStructureV3InspectionReport({ input = '', result, pythonStatus = {} } = {}) {
  const fields = result?.candidates?.policyFields || {};
  const plans = result?.candidates?.plans || [];
  const rawTableUsable = result?.normalized?.tables?.some((table) => table.source === 'raw-table');
  const lines = [
    '# PP-StructureV3 离线验证报告',
    '',
    `- 输入: ${input || '未记录'}`,
    `- 运行状态: ${pythonStatus.ok ? '成功' : '失败'}`,
    `- 设备: ${pythonStatus.device || '未记录'}`,
    `- 原始表格: ${rawTableUsable ? '可用' : '不可用'}`,
    '',
    '## 核心字段',
    '',
    fieldLine('保险公司', fields.company),
    fieldLine('产品名称', fields.productName),
    fieldLine('投保人', fields.applicant),
    fieldLine('被保险人', fields.insured),
    fieldLine('受益人', fields.beneficiary),
    fieldLine('首期保费合计', fields.firstPremium),
    '',
    '## 主险和附加险',
    '',
    ...(plans.length ? plans.map(planLine) : ['- 未识别到计划行']),
    '',
    `主险: ${plans.find((plan) => plan.role === 'main')?.name || '未识别'}`,
    ...plans.filter((plan) => plan.role === 'rider').map((plan) => `附加险: ${plan.name}`),
    `首期保费合计: ${fields.firstPremium?.value || '未识别'}`,
    '',
    '## 缺失和警告',
    '',
    ...(result?.normalized?.warnings?.length ? result.normalized.warnings.map((warning) => `- ${warning}`) : ['- 无']),
    '',
    `## 结论: ${recommendation(result)}`,
    '',
  ];
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 2: Run the normalizer test and verify it passes**

Run:

```bash
node --test tests/policy-structurev3-normalizer.test.mjs
```

Expected: PASS for all four tests.

- [ ] **Step 3: Run syntax check for the new module**

Run:

```bash
node --check ocr-service/policy-structurev3-normalizer.mjs
```

Expected: no output and exit code 0.

- [ ] **Step 4: Commit normalizer and passing test**

Run:

```bash
git add ocr-service/policy-structurev3-normalizer.mjs tests/policy-structurev3-normalizer.test.mjs
git commit -m "feat: normalize pp-structurev3 policy tables"
```

Expected: commit includes the normalizer and updated passing tests only.

## Task 3: PP-StructureV3 Python Runner

**Files:**
- Create: `ocr-service/scripts/policy_ocr_structurev3.py`

- [ ] **Step 1: Add the Python runner**

Create `ocr-service/scripts/policy_ocr_structurev3.py` with this content:

```python
#!/usr/bin/env python3
import json
import os
import shutil
import sys
from pathlib import Path

os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")
os.environ.setdefault("PADDLE_PDX_MODEL_SOURCE", "BOS")


def fail(message: str, code: int = 1) -> None:
    sys.stderr.write(f"{message}\n")
    raise SystemExit(code)


def has_flag(name: str) -> bool:
    return name in sys.argv[1:]


def read_arg(name: str, default: str = "") -> str:
    args = sys.argv[1:]
    for item in args:
        if item.startswith(name + "="):
            return item[len(name) + 1:]
    if name in args:
        index = args.index(name)
        if index + 1 < len(args):
            return args[index + 1]
    return default


def load_input_path() -> Path:
    raw = read_arg("--input") or (sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "")
    if not raw:
        fail("POLICY_STRUCTUREV3_INPUT_REQUIRED")
    input_path = Path(raw).expanduser().resolve()
    if not input_path.exists():
        fail("POLICY_STRUCTUREV3_INPUT_NOT_FOUND")
    return input_path


def load_output_dir() -> Path:
    raw = read_arg("--output-dir")
    if not raw:
        fail("POLICY_STRUCTUREV3_OUTPUT_REQUIRED")
    output_dir = Path(raw).expanduser().resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    return output_dir


def env_flag(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in ("0", "false", "no", "off", "")


def bootstrap_project_dir() -> None:
    project_dir = os.environ.get("POLICY_OCR_PADDLE_PROJECT_DIR", "").strip()
    if project_dir and project_dir not in sys.path:
        sys.path.insert(0, project_dir)


def materialize(value):
    if callable(value):
        try:
            return value()
        except Exception:
            return None
    return value


def to_jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): to_jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(item) for item in value]
    if hasattr(value, "tolist"):
        return value.tolist()
    if hasattr(value, "__dict__"):
        return to_jsonable(vars(value))
    return str(value)


def collect_result_payloads(results) -> list[dict]:
    payloads = []
    for item in results or []:
        payload = materialize(getattr(item, "json", None))
        if payload is None:
            payload = materialize(getattr(item, "res", None))
        if payload is None:
            payload = item
        payloads.append(to_jsonable(payload))
    return payloads


def find_first_file(root: Path, suffix: str) -> Path | None:
    matches = sorted(root.rglob("*" + suffix))
    return matches[0] if matches else None


def copy_generated_file(source: Path | None, target: Path) -> bool:
    if not source or not source.exists():
        return False
    shutil.copyfile(source, target)
    return True


def main() -> None:
    bootstrap_project_dir()

    if has_flag("--warmup"):
        try:
            from paddleocr import PPStructureV3  # noqa: F401
        except Exception:
            fail("POLICY_STRUCTUREV3_IMPORT_FAILED")
        sys.stdout.write(json.dumps({"ok": True, "warmup": True, "pipeline": "pp_structurev3"}, ensure_ascii=False))
        return

    input_path = load_input_path()
    output_dir = load_output_dir()
    raw_json_path = output_dir / "raw.structurev3.json"
    raw_md_path = output_dir / "raw.structurev3.md"
    generated_dir = output_dir / "_structurev3-generated"
    generated_dir.mkdir(parents=True, exist_ok=True)

    try:
        from paddleocr import PPStructureV3
    except Exception:
        fail("POLICY_STRUCTUREV3_IMPORT_FAILED")

    device = os.environ.get("POLICY_OCR_STRUCTUREV3_DEVICE", os.environ.get("POLICY_OCR_PADDLE_DEVICE", "gpu")).strip() or "gpu"

    try:
        pipeline = PPStructureV3(
            device=device,
            use_doc_orientation_classify=env_flag("POLICY_OCR_STRUCTUREV3_USE_DOC_ORIENTATION_CLASSIFY", True),
            use_doc_unwarping=env_flag("POLICY_OCR_STRUCTUREV3_USE_DOC_UNWARPING", True),
            use_textline_orientation=env_flag("POLICY_OCR_STRUCTUREV3_USE_TEXTLINE_ORIENTATION", True),
            use_formula_recognition=env_flag("POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION", False),
            use_chart_recognition=env_flag("POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION", False),
        )
        results = pipeline.predict(str(input_path))
        payload = {
            "ok": True,
            "pipeline": "pp_structurev3",
            "device": device,
            "results": collect_result_payloads(results),
        }
        raw_json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

        for item in results or []:
            if hasattr(item, "save_to_json"):
                item.save_to_json(save_path=str(generated_dir))
            if hasattr(item, "save_to_markdown"):
                item.save_to_markdown(save_path=str(generated_dir))

        generated_json = find_first_file(generated_dir, ".json")
        generated_md = find_first_file(generated_dir, ".md")
        if generated_json and generated_json != raw_json_path:
            copy_generated_file(generated_json, raw_json_path)
        copied_markdown = copy_generated_file(generated_md, raw_md_path)
        if not copied_markdown:
            raw_md_path.write_text("", encoding="utf-8")

    except Exception as exc:
        sys.stderr.write(f"PP-StructureV3 error: {exc}\n")
        fail("POLICY_STRUCTUREV3_RUNTIME_FAILED")

    status = {
        "ok": True,
        "pipeline": "pp_structurev3",
        "device": device,
        "rawJsonPath": str(raw_json_path),
        "rawMarkdownPath": str(raw_md_path),
    }
    sys.stdout.write(json.dumps(status, ensure_ascii=False))


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run Python syntax check**

Run:

```bash
python3 -m py_compile ocr-service/scripts/policy_ocr_structurev3.py
```

Expected: no output and exit code 0.

- [ ] **Step 3: Run warmup when PP-StructureV3 is installed**

Run:

```bash
POLICY_OCR_STRUCTUREV3_DEVICE=gpu python3 ocr-service/scripts/policy_ocr_structurev3.py --warmup
```

Expected if installed: JSON containing `"ok": true` and `"pipeline": "pp_structurev3"`.

Expected if not installed: stderr contains `POLICY_STRUCTUREV3_IMPORT_FAILED`; record this as environment-not-ready, not a code failure.

- [ ] **Step 4: Commit Python runner**

Run:

```bash
git add ocr-service/scripts/policy_ocr_structurev3.py
git commit -m "feat: add pp-structurev3 runner"
```

Expected: commit includes only `ocr-service/scripts/policy_ocr_structurev3.py`.

## Task 4: Inspection CLI And Report Writer

**Files:**
- Create: `scripts/inspect-pp-structurev3.mjs`
- Modify later in Task 5: `package.json`
- Modify later in Task 5: `.gitignore`

- [ ] **Step 1: Add the CLI**

Create `scripts/inspect-pp-structurev3.mjs` with this content:

```js
#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  buildStructureV3InspectionReport,
  normalizeStructureV3Inspection,
} from '../ocr-service/policy-structurev3-normalizer.mjs';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, '..');
const PYTHON_SCRIPT = path.join(PROJECT_ROOT, 'ocr-service/scripts/policy_ocr_structurev3.py');
const OUTPUT_ROOT = path.join(PROJECT_ROOT, '.structurev3-inspect');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff']);

function text(value) {
  return String(value ?? '').trim();
}

function readArg(args, name, fallback = '') {
  const prefixed = args.find((arg) => arg.startsWith(`${name}=`));
  if (prefixed) return prefixed.slice(name.length + 1);
  const index = args.indexOf(name);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function positionalInput(args) {
  return args.find((arg) => !arg.startsWith('--')) || '';
}

function timestampForPath(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join('-');
}

function slugForFile(filePath) {
  return path.basename(filePath, path.extname(filePath)).replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'policy';
}

async function collectInputFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const stat = await fs.stat(resolved);
  if (stat.isFile()) return [resolved];
  if (!stat.isDirectory()) return [];
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(resolved, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectInputFiles(child));
      continue;
    }
    if (entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(child);
    }
  }
  return files.sort();
}

async function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, payload) {
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');
}

function configuredPython(args) {
  return text(readArg(args, '--python')) || text(process.env.POLICY_OCR_STRUCTUREV3_PYTHON) || text(process.env.POLICY_OCR_PADDLE_PYTHON) || 'python3';
}

function buildPythonEnv() {
  return {
    ...process.env,
    POLICY_OCR_STRUCTUREV3_DEVICE: text(process.env.POLICY_OCR_STRUCTUREV3_DEVICE || process.env.POLICY_OCR_PADDLE_DEVICE || 'gpu'),
    POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION: text(process.env.POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION || 'false'),
    POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION: text(process.env.POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION || 'false'),
  };
}

async function inspectOne(inputFile, args) {
  const runId = `${timestampForPath()}-${slugForFile(inputFile)}`;
  const outputDir = path.join(OUTPUT_ROOT, runId);
  await fs.mkdir(outputDir, { recursive: true });

  const python = configuredPython(args);
  const meta = {
    input: path.relative(PROJECT_ROOT, inputFile),
    inputPath: inputFile,
    ranAt: new Date().toISOString(),
    python,
    device: text(process.env.POLICY_OCR_STRUCTUREV3_DEVICE || process.env.POLICY_OCR_PADDLE_DEVICE || 'gpu'),
    useFormulaRecognition: text(process.env.POLICY_OCR_STRUCTUREV3_USE_FORMULA_RECOGNITION || 'false') !== 'false',
    useChartRecognition: text(process.env.POLICY_OCR_STRUCTUREV3_USE_CHART_RECOGNITION || 'false') !== 'false',
  };
  await writeJson(path.join(outputDir, 'input.meta.json'), meta);

  let pythonStatus = null;
  try {
    const { stdout } = await execFileAsync(
      python,
      [PYTHON_SCRIPT, '--input', inputFile, '--output-dir', outputDir],
      {
        cwd: PROJECT_ROOT,
        env: buildPythonEnv(),
        timeout: 600000,
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    pythonStatus = JSON.parse(stdout || '{}');
  } catch (error) {
    pythonStatus = {
      ok: false,
      error: text(error?.stderr || error?.message || error),
      device: meta.device,
    };
    await writeJson(path.join(outputDir, 'error.json'), pythonStatus);
  }

  const rawJsonPath = path.join(outputDir, 'raw.structurev3.json');
  const rawMarkdownPath = path.join(outputDir, 'raw.structurev3.md');
  const raw = await readJson(rawJsonPath, {});
  const markdown = fsSync.existsSync(rawMarkdownPath) ? await fs.readFile(rawMarkdownPath, 'utf-8') : '';
  const result = normalizeStructureV3Inspection({ raw, markdown });
  await writeJson(path.join(outputDir, 'normalized.json'), result.normalized);
  await writeJson(path.join(outputDir, 'candidates.json'), result.candidates);
  await fs.writeFile(path.join(outputDir, 'report.md'), buildStructureV3InspectionReport({
    input: meta.input,
    result,
    pythonStatus,
  }), 'utf-8');
  return { outputDir, ok: Boolean(pythonStatus?.ok), input: inputFile };
}

async function main(args = process.argv.slice(2)) {
  const input = text(readArg(args, '--input')) || positionalInput(args);
  if (!input) {
    console.error('Usage: npm run ocr:structurev3:inspect -- <image-or-directory>');
    process.exitCode = 1;
    return;
  }
  if (!fsSync.existsSync(PYTHON_SCRIPT)) {
    console.error(`Missing Python runner: ${PYTHON_SCRIPT}`);
    process.exitCode = 1;
    return;
  }
  await fs.mkdir(OUTPUT_ROOT, { recursive: true });
  const files = await collectInputFiles(input);
  if (!files.length) {
    console.error(`No supported image files found: ${input}`);
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (const file of files) {
    results.push(await inspectOne(file, args));
  }
  for (const result of results) {
    console.log(`${result.ok ? 'OK' : 'FAIL'} ${path.relative(PROJECT_ROOT, result.input)} -> ${path.relative(PROJECT_ROOT, result.outputDir)}`);
  }
  process.exitCode = results.every((result) => result.ok) ? 0 : 1;
  if (os.platform() === 'win32') {
    process.exitCode = results.some((result) => result.ok) ? 0 : process.exitCode;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Run syntax check for the CLI**

Run:

```bash
node --check scripts/inspect-pp-structurev3.mjs
```

Expected: no output and exit code 0.

- [ ] **Step 3: Run CLI failure path with missing input**

Run:

```bash
node scripts/inspect-pp-structurev3.mjs
```

Expected: exit code 1 and output contains `Usage: npm run ocr:structurev3:inspect -- <image-or-directory>`.

- [ ] **Step 4: Commit CLI**

Run:

```bash
git add scripts/inspect-pp-structurev3.mjs
git commit -m "feat: add pp-structurev3 inspection cli"
```

Expected: commit includes only `scripts/inspect-pp-structurev3.mjs`.

## Task 5: npm Script, Ignore Rule, And Final Verification

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Test: `tests/policy-structurev3-normalizer.test.mjs`

- [ ] **Step 1: Add generated output ignore rule**

Modify `.gitignore` under `# Outputs (generated reports/files)`:

```gitignore
# Outputs (generated reports/files)
outputs/
.structurev3-inspect/
```

- [ ] **Step 2: Add npm script**

Modify `package.json` inside `"scripts"` near the OCR/local scripts:

```json
"ocr:structurev3:inspect": "node scripts/inspect-pp-structurev3.mjs",
```

Keep the existing JSON comma placement valid.

- [ ] **Step 3: Run focused tests**

Run:

```bash
node --test tests/policy-structurev3-normalizer.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run syntax checks for touched JavaScript**

Run:

```bash
node --check ocr-service/policy-structurev3-normalizer.mjs
node --check scripts/inspect-pp-structurev3.mjs
node --check tests/policy-structurev3-normalizer.test.mjs
```

Expected: each command exits 0 with no output.

- [ ] **Step 5: Run Python syntax check**

Run:

```bash
python3 -m py_compile ocr-service/scripts/policy_ocr_structurev3.py
```

Expected: no output and exit code 0.

- [ ] **Step 6: Run project check**

Run:

```bash
npm run check
```

Expected: PASS. If it fails on pre-existing dirty-worktree files unrelated to this plan, record the exact failing file and still report the focused checks from Steps 3-5.

- [ ] **Step 7: Optional real-image smoke test**

Run this only when a local sample image is available and PP-StructureV3 imports successfully:

```bash
npm run ocr:structurev3:inspect -- ./samples/policy.jpg
```

Expected on a configured machine: output like:

```text
OK samples/policy.jpg -> .structurev3-inspect/<timestamp>-policy
```

Then inspect:

```bash
ls .structurev3-inspect/*/report.md | tail -1
```

Expected: a generated `report.md` path.

If PP-StructureV3 is not installed, expected stderr includes `POLICY_STRUCTUREV3_IMPORT_FAILED`; record this as environment-not-ready.

- [ ] **Step 8: Commit npm script and ignore rule**

Run:

```bash
git add .gitignore package.json
git commit -m "chore: wire pp-structurev3 inspection command"
```

Expected: commit includes only `.gitignore` and `package.json`.

## Final Completion Checklist

- [ ] `node --test tests/policy-structurev3-normalizer.test.mjs` passed.
- [ ] `node --check ocr-service/policy-structurev3-normalizer.mjs` passed.
- [ ] `node --check scripts/inspect-pp-structurev3.mjs` passed.
- [ ] `node --check tests/policy-structurev3-normalizer.test.mjs` passed.
- [ ] `python3 -m py_compile ocr-service/scripts/policy_ocr_structurev3.py` passed.
- [ ] `npm run check` passed, or exact unrelated pre-existing failures were recorded.
- [ ] Local production commands were not run.
- [ ] `.env.local`, `.runtime/`, generated production data, `server/`, and `src/` were not modified.
- [ ] `.structurev3-inspect/` is ignored and no generated inspection files are staged.
