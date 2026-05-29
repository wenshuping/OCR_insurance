# 个人现金流明细表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增"个人现金流明细"独立页面，展示年度现金流表、场景赔付表和被保人汇总表，纳入报告导出。

**Architecture:** 纯前端计算方案。新增 `src/cashflow-engine.mjs` 作为计算引擎（纯函数、可独立测试），UI 组件放在 `src/App.tsx` 中沿用现有模式。数据修复脚本先于 UI 开发执行。

**Tech Stack:** React 19, TypeScript 5.8, Tailwind CSS 4, Node.js 22 (内置 test runner), html2canvas + jsPDF

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `scripts/fix-cashflow-indicators.mjs` | 一次性修复畅行万里和安鑫护理指标数据 |
| Create | `src/cashflow-engine.mjs` | 现金流计算引擎（纯函数） |
| Create | `tests/cashflow-engine.test.mjs` | 计算引擎单元测试 |
| Modify | `src/api.ts` | 新增 CashflowEntry/ScenarioEntry/PolicyCashflowPlan/MemberAnnualSummary 类型 |
| Modify | `src/App.tsx` | UI 组件 + 页面路由 + 入口按钮 + 导出集成 |
| Modify | `tests/policy-ocr-flow.test.mjs` | 更新畅行万里旧指标测试数据 |

---

## Task 1: 数据修复脚本

**Files:**
- Create: `scripts/fix-cashflow-indicators.mjs`

- [ ] **Step 1: 创建修复脚本**

```javascript
// scripts/fix-cashflow-indicators.mjs
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const DB_PATH = process.argv[2] || path.resolve('.runtime/policy-ocr.sqlite');
const DRY_RUN = process.argv.includes('--dry-run');

function fixChangxingDiseaseDeath(db) {
  const old = db.prepare(
    `SELECT id FROM insurance_indicator_records
     WHERE product_name LIKE '%畅行万里%'
       AND liability LIKE '%疾病身故%'
       AND basis = '基本保额'`
  ).all();
  if (!old.length) { console.log('[skip] 畅行万里疾病身故已修复'); return 0; }

  const sourceId = old[0].id;
  const now = new Date().toISOString();

  if (!DRY_RUN) {
    const del = db.prepare(`DELETE FROM insurance_indicator_records WHERE id = ?`);
    old.forEach((r) => del.run(r.id));

    const insert = db.prepare(
      `INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const productName = '新华人寿保险股份有限公司畅行万里智赢版两全保险';
    const company = '新华保险';

    const rows = [
      { liability: '疾病身故/全残(41岁前)', value: 1.6, formulaText: '实际交纳保险费 × 1.6', condition: '41岁前' },
      { liability: '疾病身故/全残(41-61岁)', value: 1.4, formulaText: '实际交纳保险费 × 1.4', condition: '41-61岁' },
      { liability: '疾病身故/全残(61岁后)', value: 1.2, formulaText: '实际交纳保险费 × 1.2', condition: '61岁后' },
    ];

    rows.forEach((r, i) => {
      const id = `fix-changxing-disease-${i + 1}`;
      const payload = JSON.stringify({
        id, company, productName, coverageType: '人寿保障', liability: r.liability,
        value: r.value, valueText: String(r.value), unit: '倍', basis: '已交保费',
        formulaText: r.formulaText, condition: r.condition, sourceRecordId: sourceId, updatedAt: now,
      });
      insert.run(id, company, productName, '人寿保障', r.liability, payload);
    });
  }
  console.log(`[fix] 畅行万里疾病身故: 删除 ${old.length} 条, 插入 3 条`);
  return old.length;
}

function fixChangxingAccidentScenarios(db) {
  const old = db.prepare(
    `SELECT id FROM insurance_indicator_records
     WHERE product_name LIKE '%畅行万里%'
       AND coverage_type = '意外保障'
       AND liability LIKE '%特定意外%'`
  ).all();
  if (!old.length) { console.log('[skip] 畅行万里意外场景已拆分'); return 0; }

  const sourceId = old[0].id;
  const now = new Date().toISOString();

  if (!DRY_RUN) {
    const del = db.prepare(`DELETE FROM insurance_indicator_records WHERE id = ?`);
    old.forEach((r) => del.run(r.id));

    const insert = db.prepare(
      `INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const productName = '新华人寿保险股份有限公司畅行万里智赢版两全保险';
    const company = '新华保险';

    const scenarios = [
      { liability: '一般意外身故/全残', value: 10 },
      { liability: '步行/骑行交通意外', value: 15 },
      { liability: '驾乘意外', value: 20 },
      { liability: '高空坠物/抛物意外', value: 20 },
      { liability: '客运轮船/汽车意外', value: 30 },
      { liability: '电梯意外', value: 30 },
      { liability: '公共场所特定事故', value: 40 },
      { liability: '重大自然灾害', value: 40 },
      { liability: '客运列车/航空意外', value: 60 },
    ];

    scenarios.forEach((s, i) => {
      const id = `fix-changxing-accident-${i + 1}`;
      const payload = JSON.stringify({
        id, company, productName, coverageType: '意外保障', liability: s.liability,
        value: s.value, valueText: String(s.value), unit: '倍', basis: '基本保额',
        formulaText: `基本保额 × ${s.value}`, condition: '', sourceRecordId: sourceId, updatedAt: now,
      });
      insert.run(id, company, productName, '意外保障', s.liability, payload);
    });
  }
  console.log(`[fix] 畅行万里意外场景: 删除 ${old.length} 条, 插入 9 条`);
  return old.length;
}

function fixAnxinNursing(db) {
  const old = db.prepare(
    `SELECT id FROM insurance_indicator_records
     WHERE product_name LIKE '%安鑫优选%'
       AND (liability LIKE '%疾病身故%' OR liability LIKE '%护理%')
       AND basis = '基本保额'`
  ).all();
  if (!old.length) { console.log('[skip] 安鑫护理已拆分'); return 0; }

  const sourceId = old[0].id;
  const now = new Date().toISOString();

  if (!DRY_RUN) {
    const del = db.prepare(`DELETE FROM insurance_indicator_records WHERE id = ?`);
    old.forEach((r) => del.run(r.id));

    const insert = db.prepare(
      `INSERT INTO insurance_indicator_records (id, company, product_name, coverage_type, liability, payload)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const productName = '安鑫优选终身护理保险';
    const company = db.prepare(
      `SELECT company FROM insurance_indicator_records WHERE product_name LIKE '%安鑫优选%' LIMIT 1`
    ).get()?.company || '新华保险';

    const rows = [
      { liability: '护理金(18岁前)', value: null, unit: '公式',
        formulaText: '实际交纳保险费，现金价值不展示', condition: '18岁前' },
      { liability: '护理金(18-61岁)', value: 1.6, unit: '倍',
        formulaText: '实际交纳保险费 × 160%，现金价值不展示', condition: '18-61岁' },
      { liability: '护理金(61岁后)', value: 1.2, unit: '倍',
        formulaText: 'max(实际交纳保险费 × 120%, 基本保额)，现金价值不展示', condition: '61岁后' },
    ];

    rows.forEach((r, i) => {
      const id = `fix-anxin-nursing-${i + 1}`;
      const payload = JSON.stringify({
        id, company, productName, coverageType: '疾病保障', liability: r.liability,
        value: r.value, valueText: r.value != null ? String(r.value) : '', unit: r.unit,
        basis: '已交保费', formulaText: r.formulaText, condition: r.condition,
        sourceRecordId: sourceId, updatedAt: now,
      });
      insert.run(id, company, productName, '疾病保障', r.liability, payload);
    });
  }
  console.log(`[fix] 安鑫护理: 删除 ${old.length} 条, 插入 3 条`);
  return old.length;
}

console.log(`[info] DB: ${DB_PATH}, DRY_RUN: ${DRY_RUN}`);
const db = new Database(DB_PATH);
const total = fixChangxingDiseaseDeath(db) + fixChangxingAccidentScenarios(db) + fixAnxinNursing(db);
db.close();
console.log(`[done] 共修复 ${total} 条旧记录`);
```

- [ ] **Step 2: 验证脚本可运行（dry-run）**

Run: `node scripts/fix-cashflow-indicators.mjs --dry-run`
Expected: 输出 `[info]` 和 `[skip]` 或 `[fix]` 日志，无报错

- [ ] **Step 3: 执行修复**

Run: `node scripts/fix-cashflow-indicators.mjs`
Expected: 输出修复条数

- [ ] **Step 4: 确认现有测试不受影响**

Run: `npm run test`
Expected: 全部通过（如有测试引用旧指标数据，在 Task 6 中修复）

- [ ] **Step 5: Commit**

```bash
git add scripts/fix-cashflow-indicators.mjs
git commit -m "fix: correct cashflow indicator data for changxing and anxin products"
```

---

## Task 2: 现金流计算引擎

**Files:**
- Create: `src/cashflow-engine.mjs`
- Test: `tests/cashflow-engine.test.mjs`

- [ ] **Step 1: 写 condition 解析器的失败测试**

创建 `tests/cashflow-engine.test.mjs`：

```javascript
// tests/cashflow-engine.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseConditionYearRange,
  expandCashflowIndicator,
  buildScenarioEntries,
  buildPolicyCashflowPlans,
  buildMemberAnnualSummaries,
} from '../src/cashflow-engine.mjs';

test('parseConditionYearRange: 生效满5年', () => {
  const result = parseConditionYearRange('生效满5年首个周年日到养老年金开始前', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result.startYear, 2030);
  assert.equal(result.endYear, 2042);
});

test('parseConditionYearRange: 55周岁后首个保单周年日', () => {
  const result = parseConditionYearRange('女性55周岁后首个保单周年日到届满前', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result.startYear, 2043);
  assert.equal(result.endYear, 2072);
});

test('parseConditionYearRange: 保障期满', () => {
  const result = parseConditionYearRange('保障期满', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result.startYear, 2073);
  assert.equal(result.endYear, 2073);
});

test('parseConditionYearRange: 未知 condition 返回 null', () => {
  const result = parseConditionYearRange('完全无法识别的文本', {
    effectiveYear: 2025, birthYear: 1988, coverageEndYear: 2073,
  });
  assert.equal(result, null);
});
```

- [ ] **Step 2: 运行测试验证失败**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: FAIL — `Cannot find module '../src/cashflow-engine.mjs'`

- [ ] **Step 3: 实现 condition 解析器**

创建 `src/cashflow-engine.mjs`：

```javascript
// src/cashflow-engine.mjs

/**
 * 解析 condition 文本，返回 { startYear, endYear } 或 null。
 * @param {string} condition
 * @param {{ effectiveYear: number, birthYear: number, coverageEndYear: number }} ctx
 * @returns {{ startYear: number, endYear: number } | null}
 */
export function parseConditionYearRange(condition, ctx) {
  const text = String(condition || '').trim();
  if (!text) return null;

  // "生效满N年...到..."
  const effectiveMatch = text.match(/生效满(\d+)年/);
  if (effectiveMatch) {
    const startYear = ctx.effectiveYear + Number(effectiveMatch[1]);
    // 尝试解析 endYear: "...到养老年金开始前" / "...到届满前"
    let endYear = ctx.coverageEndYear - 1;
    if (/届满前|保障期满前/.test(text)) endYear = ctx.coverageEndYear - 1;
    // "...到养老年金开始前" — 调用者需要外部指定 endYear
    return { startYear, endYear };
  }

  // "N周岁后首个保单周年日...到届满前"
  const ageMatch = text.match(/(\d+)周岁后/);
  if (ageMatch) {
    const startYear = ctx.birthYear + Number(ageMatch[1]);
    const endYear = /届满前|保障期满前/.test(text) ? ctx.coverageEndYear - 1 : ctx.coverageEndYear;
    return { startYear, endYear };
  }

  // "保障期满" / "届满"
  if (/保障期满|届满/.test(text)) {
    return { startYear: ctx.coverageEndYear, endYear: ctx.coverageEndYear };
  }

  return null;
}
```

- [ ] **Step 4: 运行测试验证通过**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: 4 tests pass

- [ ] **Step 5: 写 expandCashflowIndicator 的失败测试**

追加到 `tests/cashflow-engine.test.mjs`：

```javascript
test('expandCashflowIndicator: 盛世恒盈年金生存金 13 条', () => {
  const indicator = {
    coverageType: '现金流', liability: '生存保险金',
    value: null, unit: '公式', basis: '基本保额',
    formulaText: '生存保险金 = 基本保额',
    condition: '生效满5年首个周年日到养老年金开始前',
  };
  const policy = {
    id: 1, name: '盛世恒盈年金', company: '新华保险',
    insured: '温舒萍', insuredBirthday: '1988-12-16',
    date: '2025-12-22', amount: 1465, firstPremium: 11000,
    paymentPeriod: '10年', coveragePeriod: '至85周岁',
  };
  const entries = expandCashflowIndicator(indicator, policy);
  assert.equal(entries.length, 13);
  assert.equal(entries[0].year, 2030);
  assert.equal(entries[0].amount, 1465);
  assert.equal(entries[12].year, 2042);
  assert.equal(entries[12].cumulative, 19045);
});

test('expandCashflowIndicator: 满期生存保险金 1 条', () => {
  const indicator = {
    coverageType: '现金流', liability: '满期生存保险金',
    value: null, unit: '公式', basis: '已交保费',
    formulaText: '满期生存保险金 = 实际交纳保险费',
    condition: '保障期满',
  };
  const policy = {
    id: 1, name: '盛世恒盈年金', company: '新华保险',
    insured: '温舒萍', insuredBirthday: '1988-12-16',
    date: '2025-12-22', amount: 1465, firstPremium: 11000,
    paymentPeriod: '10年', coveragePeriod: '至85周岁',
  };
  const entries = expandCashflowIndicator(indicator, policy);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].year, 2073);
  assert.equal(entries[0].amount, 110000);
  assert.equal(entries[0].liability, '满期生存保险金');
});
```

- [ ] **Step 6: 运行测试验证失败**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: FAIL — `expandCashflowIndicator is not a function`

- [ ] **Step 7: 实现 expandCashflowIndicator**

追加到 `src/cashflow-engine.mjs`：

```javascript
function parsePaymentYearsFromText(value) {
  const text = String(value || '').replace(/\s/g, '');
  if (/趸交|一次交清/.test(text)) return 1;
  const yearMatch = text.match(/(\d+(?:\.\d+)?)年/);
  if (yearMatch) return Number(yearMatch[1]);
  const periodMatch = text.match(/(\d+(?:\.\d+)?)期/);
  if (periodMatch) return Number(periodMatch[1]);
  return 0;
}

function parseCoverageEndYear(policy) {
  const text = String(policy.coveragePeriod || '').trim();
  // "至85周岁" / "至 85 周岁"
  const ageMatch = text.match(/(\d+)\s*周岁/);
  if (ageMatch && policy.insuredBirthday) {
    const birthYear = new Date(policy.insuredBirthday).getFullYear();
    return birthYear + Number(ageMatch[1]);
  }
  // "2068-09-30" / "至2068-09-30"
  const dateMatch = text.match(/(\d{4})-\d{2}-\d{2}/);
  if (dateMatch) return Number(dateMatch[1]);
  // "20年" / "30年"
  const yearMatch = text.match(/(\d+)\s*年/);
  if (yearMatch && policy.date) {
    const effectiveYear = new Date(policy.date).getFullYear();
    return effectiveYear + Number(yearMatch[1]);
  }
  return 0;
}

function resolveIndicatorAmountForCashflow(indicator, policy) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''} ${indicator.liability || ''}`;
  // 已交保费 / 实际交纳保险费
  if (/实际交纳|已交保费|所交保费/.test(text)) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    return premium * years;
  }
  const value = Number(indicator.value);
  const unit = String(indicator.unit || '').trim();
  const basis = String(indicator.basis || '').trim();
  const amount = Number(policy.amount || 0);
  if (/%/.test(unit) && /基本保额/.test(basis)) return amount * value / 100;
  if (/倍/.test(unit) && /基本保额/.test(basis)) return amount * value;
  if (/基本保额/.test(basis) && /公式/.test(unit)) return amount;
  return amount || 0;
}

function formatCashflowCalculation(indicator, policy, amount) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''}`;
  if (/实际交纳|已交保费/.test(text)) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    if (years > 1) return `${premium.toLocaleString('zh-CN')} × ${years} = ${amount.toLocaleString('zh-CN')}元`;
    return `保费 = ${amount.toLocaleString('zh-CN')}元`;
  }
  if (/基本保额/.test(text)) return `基本保额 = ${amount.toLocaleString('zh-CN')}元`;
  return indicator.formulaText || `${amount.toLocaleString('zh-CN')}元`;
}

/**
 * 将单个现金流指标展开为年度条目。
 * @param {object} indicator - CoverageIndicator
 * @param {object} policy - Policy
 * @returns {Array<object>} CashflowEntry[]
 */
export function expandCashflowIndicator(indicator, policy) {
  if (!policy.insuredBirthday || !policy.date) return [];
  const effectiveYear = new Date(policy.date).getFullYear();
  const birthYear = new Date(policy.insuredBirthday).getFullYear();
  const coverageEndYear = parseCoverageEndYear(policy);
  if (!coverageEndYear) return [];

  const range = parseConditionYearRange(indicator.condition, { effectiveYear, birthYear, coverageEndYear });
  if (!range) return [];

  // 特殊处理: 生存金结束年份需要排除养老年金开始后的年份
  const conditionText = String(indicator.condition || '');
  if (/到养老年金开始前/.test(conditionText)) {
    // 养老年金从 55 周岁开始
    const pensionStartYear = birthYear + 55;
    range.endYear = Math.min(range.endYear, pensionStartYear - 1);
  }

  const amount = resolveIndicatorAmountForCashflow(indicator, policy);
  if (amount <= 0) return [];

  const entries = [];
  let cumulative = 0;
  for (let year = range.startYear; year <= range.endYear; year++) {
    cumulative += amount;
    entries.push({
      year,
      age: year - birthYear,
      amount,
      cumulative,
      liability: indicator.liability || '现金流',
      policyId: policy.id,
      productName: policy.name || indicator.productName || '',
      calculationText: formatCashflowCalculation(indicator, policy, amount),
    });
  }
  return entries;
}
```

- [ ] **Step 8: 运行测试验证通过**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: 6 tests pass

- [ ] **Step 9: 写 buildScenarioEntries 的失败测试**

追加到 `tests/cashflow-engine.test.mjs`：

```javascript
test('buildScenarioEntries: 畅行万里意外场景 9 条', () => {
  const indicators = [
    { coverageType: '意外保障', liability: '一般意外身故/全残', value: 10, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 10', condition: '' },
    { coverageType: '意外保障', liability: '步行/骑行交通意外', value: 15, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 15', condition: '' },
    { coverageType: '意外保障', liability: '客运列车/航空意外', value: 60, unit: '倍', basis: '基本保额', formulaText: '基本保额 × 60', condition: '' },
  ];
  const policy = {
    id: 2, name: '畅行万里智赢版两全保险', company: '新华保险',
    amount: 60000, firstPremium: 3156, paymentPeriod: '10年',
  };
  const entries = buildScenarioEntries(indicators, policy);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].amount, 600000);
  assert.equal(entries[1].amount, 900000);
  assert.equal(entries[2].amount, 3600000);
});

test('buildScenarioEntries: 安鑫护理 3 条含现金价值标记', () => {
  const indicators = [
    { coverageType: '疾病保障', liability: '护理金(18岁前)', value: null, unit: '公式', basis: '已交保费', formulaText: '实际交纳保险费，现金价值不展示', condition: '18岁前' },
    { coverageType: '疾病保障', liability: '护理金(18-61岁)', value: 1.6, unit: '倍', basis: '已交保费', formulaText: '实际交纳保险费 × 160%，现金价值不展示', condition: '18-61岁' },
    { coverageType: '疾病保障', liability: '护理金(61岁后)', value: 1.2, unit: '倍', basis: '已交保费', formulaText: 'max(实际交纳保险费 × 120%, 基本保额)，现金价值不展示', condition: '61岁后' },
  ];
  const policy = {
    id: 4, name: '安鑫优选终身护理', company: '新华保险',
    amount: 60312, firstPremium: 2400, paymentPeriod: '10年',
  };
  const entries = buildScenarioEntries(indicators, policy);
  assert.equal(entries.length, 3);
  assert.equal(entries[0].amount, 24000);
  assert.equal(entries[1].amount, 38400);
  assert.equal(entries[2].amount, 60312);
});
```

- [ ] **Step 10: 运行测试验证失败**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: FAIL — `buildScenarioEntries is not a function`

- [ ] **Step 11: 实现 buildScenarioEntries**

追加到 `src/cashflow-engine.mjs`：

```javascript
/**
 * 为非现金流指标（意外/疾病/护理）构建场景条目。
 * @param {Array<object>} indicators - CoverageIndicator[]
 * @param {object} policy - Policy
 * @returns {Array<object>} ScenarioEntry[]
 */
export function buildScenarioEntries(indicators, policy) {
  const entries = [];
  for (const indicator of indicators) {
    if (indicator.coverageType === '现金流') continue;
    if (/账户价值|现金价值/.test(indicator.formulaText || '') &&
        !/现金价值不展示/.test(indicator.formulaText || '')) continue;

    const amount = resolveScenarioAmount(indicator, policy);
    const formula = buildScenarioFormula(indicator, policy, amount);

    entries.push({
      scenario: indicator.liability || indicator.coverageType || '保障责任',
      formula,
      amount,
      condition: indicator.condition || '',
      policyId: policy.id,
      productName: policy.name || indicator.productName || '',
      calculationText: `${formula} = ${amount.toLocaleString('zh-CN')}元`,
    });
  }
  return entries;
}

function resolveScenarioAmount(indicator, policy) {
  const text = `${indicator.formulaText || ''} ${indicator.basis || ''}`;
  if (/实际交纳|已交保费/.test(text)) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    const totalPremium = premium * years;
    const value = Number(indicator.value);
    if (value && /倍|×/.test(String(indicator.unit || '') + indicator.formulaText || '')) {
      return Math.round(totalPremium * value);
    }
    return totalPremium;
  }
  const value = Number(indicator.value);
  const basis = String(indicator.basis || '');
  const amount = Number(policy.amount || 0);
  if (value && /基本保额/.test(basis)) {
    if (/倍/.test(indicator.unit || '')) return amount * value;
    if (/%/.test(indicator.unit || '')) return Math.round(amount * value / 100);
  }
  if (/max/.test(indicator.formulaText || '')) {
    const premium = Number(policy.firstPremium || 0);
    const years = parsePaymentYearsFromText(policy.paymentPeriod) || 1;
    const totalPremium = premium * years;
    const factorMatch = (indicator.formulaText || '').match(/(\d+)%/);
    const factor = factorMatch ? Number(factorMatch[1]) / 100 : 1;
    return Math.max(Math.round(totalPremium * factor), amount);
  }
  return amount;
}

function buildScenarioFormula(indicator, policy, amount) {
  if (indicator.formulaText) return indicator.formulaText;
  const value = Number(indicator.value);
  const basis = String(indicator.basis || '');
  if (/基本保额/.test(basis) && value) {
    return `${Number(policy.amount || 0).toLocaleString('zh-CN')} × ${value}`;
  }
  return `${amount.toLocaleString('zh-CN')}`;
}
```

- [ ] **Step 12: 运行测试验证通过**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: 8 tests pass

- [ ] **Step 13: 写 buildPolicyCashflowPlans 和 buildMemberAnnualSummaries 的失败测试**

追加到 `tests/cashflow-engine.test.mjs`：

```javascript
test('buildPolicyCashflowPlans: 盛世恒盈年金完整计划', () => {
  const policies = [{
    id: 1, name: '盛世恒盈年金', company: '新华保险',
    insured: '温舒萍', insuredBirthday: '1988-12-16',
    date: '2025-12-22', amount: 1465, firstPremium: 11000,
    paymentPeriod: '10年', coveragePeriod: '至85周岁',
    coverageIndicators: [
      { coverageType: '现金流', liability: '生存保险金', value: null, unit: '公式', basis: '基本保额', formulaText: '生存保险金 = 基本保额', condition: '生效满5年首个周年日到养老年金开始前' },
      { coverageType: '现金流', liability: '养老年金', value: null, unit: '公式', basis: '基本保额', formulaText: '养老年金 = 基本保额', condition: '女性55周岁后首个保单周年日到届满前' },
      { coverageType: '现金流', liability: '满期生存保险金', value: null, unit: '公式', basis: '已交保费', formulaText: '满期生存保险金 = 实际交纳保险费', condition: '保障期满' },
    ],
    responsibilities: [],
  }];
  const plans = buildPolicyCashflowPlans(policies);
  assert.equal(plans.length, 1);
  assert.equal(plans[0].annualEntries.length, 44); // 13 + 30 + 1
  assert.equal(plans[0].totalDeterministicCashflow, 172995);
  assert.equal(plans[0].expired, false);
});

test('buildMemberAnnualSummaries: 合并同年领取', () => {
  const plans = [
    {
      policyId: 1, productName: 'A', company: 'X', insured: '温舒萍',
      insuredBirthday: '1988-12-16', effectiveDate: '2025-12-22', expired: false,
      annualEntries: [
        { year: 2030, age: 42, amount: 1000, cumulative: 1000, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
        { year: 2031, age: 43, amount: 1000, cumulative: 2000, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
      ],
      scenarioEntries: [], totalDeterministicCashflow: 2000,
    },
    {
      policyId: 2, productName: 'B', company: 'X', insured: '温舒萍',
      insuredBirthday: '1988-12-16', effectiveDate: '2025-01-01', expired: false,
      annualEntries: [
        { year: 2030, age: 42, amount: 500, cumulative: 500, liability: '年金', policyId: 2, productName: 'B', calculationText: '' },
      ],
      scenarioEntries: [], totalDeterministicCashflow: 500,
    },
  ];
  const summaries = buildMemberAnnualSummaries(plans);
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].member, '温舒萍');
  assert.equal(summaries[0].entries.length, 2);
  assert.equal(summaries[0].entries[0].totalAmount, 1500); // 1000 + 500
  assert.equal(summaries[0].entries[0].details.length, 2);
  assert.equal(summaries[0].entries[1].totalAmount, 1000);
  assert.equal(summaries[0].entries[1].cumulative, 2500); // 1500 + 1000
});

test('buildMemberAnnualSummaries: 排除已过期保单', () => {
  const plans = [
    {
      policyId: 3, productName: 'Expired', company: 'X', insured: '冯力',
      insuredBirthday: '1987-12-07', effectiveDate: '2020-01-01', expired: true,
      annualEntries: [
        { year: 2025, age: 38, amount: 100, cumulative: 100, liability: 'x', policyId: 3, productName: 'Expired', calculationText: '' },
      ],
      scenarioEntries: [], totalDeterministicCashflow: 100,
    },
  ];
  const summaries = buildMemberAnnualSummaries(plans);
  assert.equal(summaries.length, 0);
});
```

- [ ] **Step 14: 运行测试验证失败**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: FAIL — `buildPolicyCashflowPlans is not a function`

- [ ] **Step 15: 实现 buildPolicyCashflowPlans 和 buildMemberAnnualSummaries**

追加到 `src/cashflow-engine.mjs`：

```javascript
/**
 * 为保单列表生成现金流计划。
 * @param {Array<object>} policies
 * @returns {Array<object>} PolicyCashflowPlan[]
 */
export function buildPolicyCashflowPlans(policies) {
  const now = new Date();
  return policies.map((policy) => {
    const indicators = Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : [];
    const coverageEndYear = parseCoverageEndYear(policy);
    const expired = coverageEndYear > 0 && coverageEndYear < now.getFullYear();

    const cashflowIndicators = indicators.filter((i) => i.coverageType === '现金流');
    const scenarioIndicators = indicators.filter((i) => i.coverageType !== '现金流');

    let annualEntries = [];
    for (const indicator of cashflowIndicators) {
      const entries = expandCashflowIndicator(indicator, policy);
      annualEntries.push(...entries);
    }
    annualEntries.sort((a, b) => a.year - b.year);
    // 重算 cumulative（多指标合并后需要重新累加）
    let cumulative = 0;
    annualEntries = annualEntries.map((entry) => {
      cumulative += entry.amount;
      return { ...entry, cumulative };
    });

    const scenarioEntries = buildScenarioEntries(scenarioIndicators, policy);
    const totalDeterministicCashflow = annualEntries.reduce((sum, e) => sum + e.amount, 0);

    return {
      policyId: policy.id,
      productName: policy.name || '',
      company: policy.company || '',
      insured: policy.insured || '',
      insuredBirthday: policy.insuredBirthday || '',
      effectiveDate: policy.date || '',
      annualEntries,
      scenarioEntries,
      totalDeterministicCashflow,
      expired,
    };
  });
}

/**
 * 按被保人汇总年度现金流。
 * @param {Array<object>} plans - PolicyCashflowPlan[]
 * @returns {Array<object>} MemberAnnualSummary[]
 */
export function buildMemberAnnualSummaries(plans) {
  const activePlans = plans.filter((p) => !p.expired);
  const memberMap = new Map();

  for (const plan of activePlans) {
    const member = plan.insured || '未识别被保人';
    if (!memberMap.has(member)) {
      memberMap.set(member, { member, birthday: plan.insuredBirthday, yearMap: new Map() });
    }
    const data = memberMap.get(member);
    if (!data.birthday && plan.insuredBirthday) data.birthday = plan.insuredBirthday;

    for (const entry of plan.annualEntries) {
      const existing = data.yearMap.get(entry.year) || { year: entry.year, age: entry.age, totalAmount: 0, details: [] };
      existing.totalAmount += entry.amount;
      existing.details.push(entry);
      data.yearMap.set(entry.year, existing);
    }
  }

  return Array.from(memberMap.values()).map((data) => {
    const entries = Array.from(data.yearMap.values())
      .sort((a, b) => a.year - b.year);
    let cumulative = 0;
    for (const entry of entries) {
      cumulative += entry.totalAmount;
      entry.cumulative = cumulative;
    }
    return {
      member: data.member,
      birthday: data.birthday || '',
      entries,
      totalCashflow: cumulative,
    };
  });
}
```

- [ ] **Step 16: 运行测试验证全部通过**

Run: `node --test tests/cashflow-engine.test.mjs`
Expected: 11 tests pass

- [ ] **Step 17: Commit**

```bash
git add src/cashflow-engine.mjs tests/cashflow-engine.test.mjs
git commit -m "feat: add cashflow calculation engine with tests"
```

---

## Task 3: TypeScript 类型定义

**Files:**
- Modify: `src/api.ts` (追加类型，约第 300 行之前)

- [ ] **Step 1: 在 api.ts 中追加现金流相关类型**

在 `src/api.ts` 的 `PolicyFormData` 类型定义之前（约第 283 行），追加：

```typescript
export type CashflowEntry = {
  year: number;
  age: number;
  amount: number;
  cumulative: number;
  liability: string;
  policyId: number;
  productName: string;
  calculationText: string;
};

export type ScenarioEntry = {
  scenario: string;
  formula: string;
  amount: number;
  condition: string;
  policyId: number;
  productName: string;
  calculationText: string;
};

export type PolicyCashflowPlan = {
  policyId: number;
  productName: string;
  company: string;
  insured: string;
  insuredBirthday: string;
  effectiveDate: string;
  annualEntries: CashflowEntry[];
  scenarioEntries: ScenarioEntry[];
  totalDeterministicCashflow: number;
  expired: boolean;
};

export type MemberYearEntry = {
  year: number;
  age: number;
  totalAmount: number;
  cumulative: number;
  details: CashflowEntry[];
};

export type MemberAnnualSummary = {
  member: string;
  birthday: string;
  entries: MemberYearEntry[];
  totalCashflow: number;
};
```

- [ ] **Step 2: 运行 typecheck 确认无错**

Run: `npm run typecheck`
Expected: 无类型错误

- [ ] **Step 3: Commit**

```bash
git add src/api.ts
git commit -m "feat: add cashflow TypeScript type definitions"
```

---

## Task 4: 页面状态与路由 + 入口按钮

**Files:**
- Modify: `src/App.tsx` (~第 2009 行 state 定义, ~第 3164-3244 行 FamilyCoverageOverview)

- [ ] **Step 1: 在 CustomerApp 中新增 cashflowMember 状态**

在 `src/App.tsx` 第 2041 行（`confirmedProductMatchKey` 之后）追加：

```typescript
  const [cashflowMember, setCashflowMember] = useState<string | null>(null);
```

- [ ] **Step 2: 修改 FamilyCoverageOverview 接受 onViewCashflow 回调**

修改 `FamilyCoverageOverview` 组件签名（第 3164 行），增加 `onViewCashflow` prop：

```typescript
function FamilyCoverageOverview({
  overview, policies, onViewCashflow,
}: {
  overview: FamilyCoverageOverviewData;
  policies: Policy[];
  onViewCashflow: (member: string) => void;
}) {
```

- [ ] **Step 3: 在成员卡片中添加"查看现金流"按钮**

在 `FamilyCoverageOverview` 的成员网格中（第 3180-3189 行），修改每个成员卡片：

```typescript
        <div className="mb-4 grid gap-2 sm:grid-cols-3">
          {overview.members.map((member) => {
            const memberPlans = buildPolicyCashflowPlans(
              policies.filter((p) => (p.insured || '').trim() === member)
            );
            const hasCashflow = memberPlans.some((p) => p.annualEntries.length > 0 || p.scenarioEntries.length > 0);
            return (
              <div key={member} className="rounded-2xl bg-[#F8FBFF] px-3 py-2 ring-1 ring-[#E1EAF5]">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-black text-slate-900">{member}</p>
                  {hasCashflow ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-bold text-blue-600 hover:bg-blue-100"
                      onClick={() => onViewCashflow(member)}
                    >
                      现金流 →
                    </button>
                  ) : null}
                </div>
                <p className="mt-1 text-xs font-bold text-[#7890AA]">
                  生日 {memberBirthdays.get(member) || '待识别'}
                </p>
              </div>
            );
          })}
        </div>
```

- [ ] **Step 4: 在 App.tsx 顶部 import cashflow-engine**

在 `src/App.tsx` 的 import 区域（第 69 行 `} from './api';` 之后）追加：

```typescript
import {
  buildPolicyCashflowPlans,
  buildMemberAnnualSummaries,
} from './cashflow-engine.mjs';
```

- [ ] **Step 5: 更新 FamilyCoverageOverview 调用点传入回调**

在 `src/App.tsx` 第 3100 行，修改 `FamilyCoverageOverview` 调用：

```typescript
<FamilyCoverageOverview
  overview={familyCoverageOverview}
  policies={policies}
  onViewCashflow={(member) => setCashflowMember(member)}
/>
```

- [ ] **Step 6: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无类型错误（`buildPolicyCashflowPlans` 从 `.mjs` import 可能需要类型声明）

如果 typecheck 报错找不到 `.mjs` 模块的类型，创建 `src/cashflow-engine.d.ts`：

```typescript
// src/cashflow-engine.d.ts
export function parseConditionYearRange(
  condition: string,
  ctx: { effectiveYear: number; birthYear: number; coverageEndYear: number },
): { startYear: number; endYear: number } | null;

export function expandCashflowIndicator(indicator: any, policy: any): import('./api').CashflowEntry[];
export function buildScenarioEntries(indicators: any[], policy: any): import('./api').ScenarioEntry[];
export function buildPolicyCashflowPlans(policies: any[]): import('./api').PolicyCashflowPlan[];
export function buildMemberAnnualSummaries(plans: import('./api').PolicyCashflowPlan[]): import('./api').MemberAnnualSummary[];
```

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/api.ts src/cashflow-engine.d.ts
git commit -m "feat: add cashflow page state and family overview entry button"
```

---

## Task 5: 现金流明细页面 UI 组件

**Files:**
- Modify: `src/App.tsx` (追加组件 + 页面渲染)

- [ ] **Step 1: 实现 CashflowAnnualTable 组件**

在 `FamilyCoverageOverview` 函数之前追加：

```typescript
function CashflowAnnualTable({ entries }: { entries: CashflowEntry[] }) {
  if (!entries.length) return null;
  const columnSize = 12;
  const columns: CashflowEntry[][] = [];
  for (let i = 0; i < entries.length; i += columnSize) {
    columns.push(entries.slice(i, i + columnSize));
  }

  const liabilityColor = (liability: string) => {
    if (/满期/.test(liability)) return 'text-orange-600 bg-orange-50';
    if (/养老/.test(liability)) return 'text-emerald-600 bg-emerald-50';
    return 'text-blue-600 bg-blue-50';
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-black text-slate-800">个人现金流明细</h4>
        <span className="text-xs text-slate-400">(单位:元)</span>
      </div>
      <div className="overflow-x-auto">
        <div className="flex gap-3 min-w-max">
          {columns.map((col, colIndex) => (
            <table key={colIndex} className="border-separate border-spacing-0 text-xs">
              <thead>
                {col.map((entry, i) =>
                  i === 0 ? (
                    <tr key="header">
                      <th className="rounded-tl-lg bg-[#0B72B9] px-2 py-1 text-white font-bold">年份/年龄</th>
                      <th className="bg-[#0B72B9] px-2 py-1 text-white font-bold">领取</th>
                      <th className="rounded-tr-lg bg-[#0B72B9] px-2 py-1 text-white font-bold">累计</th>
                    </tr>
                  ) : null
                )}
              </thead>
              <tbody>
                {col.map((entry) => (
                  <tr key={entry.year} className={entry.year === entries[entries.length - 1]?.year && /满期/.test(entry.liability) ? 'bg-orange-50 font-black' : ''}>
                    <td className="px-2 py-1 font-bold text-slate-600 ring-1 ring-slate-100">
                      {entry.year}/{entry.age}
                    </td>
                    <td className="px-2 py-1 ring-1 ring-slate-100">
                      <span className={`inline-block rounded px-1 text-[10px] font-bold ${liabilityColor(entry.liability)}`}>
                        {entry.amount.toLocaleString('zh-CN')}
                      </span>
                    </td>
                    <td className="px-2 py-1 text-right font-semibold text-slate-500 ring-1 ring-slate-100">
                      {entry.cumulative.toLocaleString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 实现 ScenarioDetailTable 组件**

紧接 `CashflowAnnualTable` 之后追加：

```typescript
function ScenarioDetailTable({ entries }: { entries: ScenarioEntry[] }) {
  if (!entries.length) return null;

  const depthColor = (amount: number) => {
    if (amount >= 2000000) return 'text-blue-800 font-black';
    if (amount >= 1000000) return 'text-blue-700 font-bold';
    if (amount >= 500000) return 'text-blue-600 font-semibold';
    return 'text-slate-700';
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-black text-slate-800">保障责任明细</h4>
        <span className="text-xs text-slate-400">(单位:元)</span>
      </div>
      <table className="w-full border-separate border-spacing-0 text-xs">
        <thead>
          <tr>
            <th className="rounded-tl-lg bg-[#0B72B9] px-3 py-2 text-left font-bold text-white">场景</th>
            <th className="bg-[#0B72B9] px-3 py-2 text-left font-bold text-white">计算公式</th>
            <th className="rounded-tr-lg bg-[#0B72B9] px-3 py-2 text-right font-bold text-white">金额</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr key={i} className={entry.condition ? 'bg-slate-50' : ''}>
              <td className={`px-3 py-2 ring-1 ring-slate-100 ${entry.condition ? 'pl-6' : ''}`}>
                <span className="font-bold text-slate-800">{entry.scenario}</span>
                {entry.condition ? (
                  <span className="ml-1 text-[10px] text-slate-400">({entry.condition})</span>
                ) : null}
              </td>
              <td className="px-3 py-2 text-slate-500 ring-1 ring-slate-100">{entry.formula}</td>
              <td className={`px-3 py-2 text-right ring-1 ring-slate-100 ${depthColor(entry.amount)}`}>
                {entry.amount.toLocaleString('zh-CN')}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: 实现 CashflowDetailPage 组件**

在 `ScenarioDetailTable` 之后追加：

```typescript
function CashflowDetailPage({
  member, policies, onBack,
}: {
  member: string;
  policies: Policy[];
  onBack: () => void;
}) {
  const memberPolicies = policies.filter((p) => (p.insured || '').trim() === member);
  const plans = buildPolicyCashflowPlans(memberPolicies);
  const summaries = buildMemberAnnualSummaries(plans);
  const summary = summaries[0];
  const notes: string[] = [];

  for (const plan of plans) {
    if (!plan.insuredBirthday) notes.push(`${plan.productName}缺少被保险人生日，年度现金流无法生成。`);
    if (!plan.effectiveDate) notes.push(`${plan.productName}缺少生效日，年度现金流无法生成。`);
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-slate-100 bg-white/80 px-4 py-4 backdrop-blur-md">
        <button type="button" onClick={onBack} className="rounded-full p-1 hover:bg-slate-100">
          <ChevronLeft size={20} className="text-slate-600" />
        </button>
        <div>
          <h1 className="text-lg font-black text-slate-900">{member} · 现金流明细</h1>
          <p className="text-[11px] font-medium text-slate-400">{plans.length} 张保单</p>
        </div>
      </header>

      <main className="space-y-4 p-4">
        {notes.length ? (
          <div className="space-y-1 rounded-2xl bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            {notes.map((n) => <p key={n}>* {n}</p>)}
          </div>
        ) : null}

        {plans.map((plan) => (
          <section key={plan.policyId} className="rounded-[20px] border border-[#D9E6F4] bg-white p-4 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.12)]">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div>
                <h3 className="text-base font-black text-slate-900">{plan.productName}</h3>
                <p className="mt-1 text-xs text-slate-400">{plan.company}</p>
              </div>
              {plan.expired ? (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-400">已过期</span>
              ) : null}
            </div>
            <div className="mb-3 flex flex-wrap gap-2 text-xs text-slate-500">
              {plan.effectiveDate ? <span>生效 {plan.effectiveDate}</span> : null}
              {plan.insuredBirthday ? <span>生日 {plan.insuredBirthday}</span> : null}
            </div>

            {plan.annualEntries.length ? (
              <div className="mb-3">
                <CashflowAnnualTable entries={plan.annualEntries} />
                <p className="mt-2 text-right text-sm font-black text-slate-800">
                  确定现金流合计: {plan.totalDeterministicCashflow.toLocaleString('zh-CN')}元
                </p>
              </div>
            ) : null}

            {plan.scenarioEntries.length ? (
              <ScenarioDetailTable entries={plan.scenarioEntries} />
            ) : null}

            {!plan.annualEntries.length && !plan.scenarioEntries.length ? (
              <p className="py-6 text-center text-sm text-slate-400">暂无现金流或保障责任数据</p>
            ) : null}
          </section>
        ))}

        {summary && summary.entries.length ? (
          <section className="rounded-[20px] border-2 border-blue-200 bg-white p-4 shadow-[0_12px_24px_-20px_rgba(37,99,235,0.16)]">
            <h3 className="mb-3 text-base font-black text-blue-700">年度现金流汇总</h3>
            <MemberAnnualSummaryTable summary={summary} />
            <p className="mt-2 text-right text-sm font-black text-blue-800">
              合计: {summary.totalCashflow.toLocaleString('zh-CN')}元
            </p>
          </section>
        ) : null}
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 实现 MemberAnnualSummaryTable 组件**

在 `CashflowDetailPage` 之后追加：

```typescript
function MemberAnnualSummaryTable({ summary }: { summary: MemberAnnualSummary }) {
  const [expandedYear, setExpandedYear] = useState<number | null>(null);
  const columnSize = 12;
  const columns: MemberYearEntry[][] = [];
  for (let i = 0; i < summary.entries.length; i += columnSize) {
    columns.push(summary.entries.slice(i, i + columnSize));
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-3 min-w-max">
        {columns.map((col, colIndex) => (
          <table key={colIndex} className="border-separate border-spacing-0 text-xs">
            <thead>
              <tr>
                <th className="rounded-tl-lg bg-blue-600 px-2 py-1 text-white font-bold">年份/年龄</th>
                <th className="bg-blue-600 px-2 py-1 text-white font-bold">领取</th>
                <th className="rounded-tr-lg bg-blue-600 px-2 py-1 text-white font-bold">累计</th>
              </tr>
            </thead>
            <tbody>
              {col.map((entry) => (
                <>
                  <tr
                    key={entry.year}
                    className="cursor-pointer hover:bg-blue-50"
                    onClick={() => setExpandedYear(expandedYear === entry.year ? null : entry.year)}
                  >
                    <td className="px-2 py-1 font-bold text-slate-600 ring-1 ring-slate-100">
                      {entry.year}/{entry.age}
                    </td>
                    <td className="px-2 py-1 text-right font-black text-slate-800 ring-1 ring-slate-100">
                      {entry.totalAmount.toLocaleString('zh-CN')}
                    </td>
                    <td className="px-2 py-1 text-right font-semibold text-slate-500 ring-1 ring-slate-100">
                      {entry.cumulative.toLocaleString('zh-CN')}
                    </td>
                  </tr>
                  {expandedYear === entry.year ? (
                    <tr key={`${entry.year}-detail`}>
                      <td colSpan={3} className="bg-blue-50 px-3 py-2 ring-1 ring-blue-100">
                        {entry.details.map((d, i) => (
                          <p key={i} className="text-[11px] text-blue-700">
                            {d.productName} - {d.liability}: {d.amount.toLocaleString('zh-CN')}元
                          </p>
                        ))}
                      </td>
                    </tr>
                  ) : null}
                </>
              ))}
            </tbody>
          </table>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 在 CustomerApp 渲染逻辑中添加 cashflowDetail 页面分支**

在保单列表渲染逻辑之前（约第 3053 行 `return` 语句之前），追加条件渲染：

```typescript
  if (cashflowMember) {
    return (
      <CashflowDetailPage
        member={cashflowMember}
        policies={policies}
        onBack={() => setCashflowMember(null)}
      />
    );
  }
```

- [ ] **Step 6: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无类型错误

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx
git commit -m "feat: add cashflow detail page with annual, scenario and summary tables"
```

---

## Task 6: 报告导出集成

**Files:**
- Modify: `src/App.tsx` (修改 `createPrintableReportNode` + 新增打印渲染函数)

- [ ] **Step 1: 新增 appendPrintableCashflowTable 函数**

在 `createPrintableReportNode` 函数附近追加：

```typescript
function appendPrintableCashflowTable(parent: HTMLElement, entries: CashflowEntry[]) {
  if (!entries.length) return;
  const section = document.createElement('section');
  section.setAttribute('style', 'margin-bottom:20px;break-inside:avoid');

  const title = document.createElement('h2');
  title.setAttribute('style', 'margin:0 0 14px;font-size:18px;line-height:1.35;font-weight:800;color:#0f172a');
  title.textContent = `现金流明细（${entries.length}年）`;
  section.appendChild(title);

  const table = document.createElement('table');
  table.setAttribute('style', 'width:100%;border-collapse:collapse;font-size:12px;line-height:1.6');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['年份/年龄', '领取金额', '累计领取'].forEach((label) => {
    const th = document.createElement('th');
    th.setAttribute('style', 'background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-weight:700');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.setAttribute('style', i % 2 === 0 ? '' : 'background:#f8fafc');
    const isLastAndMaturity = /满期/.test(entry.liability) && i === entries.length - 1;
    if (isLastAndMaturity) tr.setAttribute('style', 'background:#fff7ed;font-weight:800;border-left:4px solid #f97316');

    const cells = [
      `${entry.year}/${entry.age}`,
      entry.amount.toLocaleString('zh-CN'),
      entry.cumulative.toLocaleString('zh-CN'),
    ];
    cells.forEach((text, ci) => {
      const td = document.createElement('td');
      td.setAttribute('style', `padding:6px 10px;border-bottom:1px solid #e2e8f0;${ci > 0 ? 'text-align:right' : ''}`);
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);
  parent.appendChild(section);
}
```

- [ ] **Step 2: 新增 appendPrintableScenarioTable 函数**

紧接上面追加：

```typescript
function appendPrintableScenarioTable(parent: HTMLElement, entries: ScenarioEntry[]) {
  if (!entries.length) return;
  const section = document.createElement('section');
  section.setAttribute('style', 'margin-bottom:20px');

  const title = document.createElement('h2');
  title.setAttribute('style', 'margin:0 0 14px;font-size:18px;line-height:1.35;font-weight:800;color:#0f172a');
  title.textContent = `保障责任明细（${entries.length}项）`;
  section.appendChild(title);

  const table = document.createElement('table');
  table.setAttribute('style', 'width:100%;border-collapse:collapse;font-size:12px;line-height:1.6');

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['场景', '计算公式', '金额'].forEach((label) => {
    const th = document.createElement('th');
    th.setAttribute('style', 'background:#2563eb;color:#fff;padding:8px 10px;text-align:left;font-weight:700');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  entries.forEach((entry, i) => {
    const tr = document.createElement('tr');
    tr.setAttribute('style', i % 2 === 0 ? '' : 'background:#f8fafc');
    const isBold = entry.amount >= 1000000;

    [
      { text: entry.scenario, style: `${entry.condition ? 'padding-left:24px;' : ''}${isBold ? 'font-weight:800' : ''}` },
      { text: entry.formula, style: 'color:#64748b' },
      { text: entry.amount.toLocaleString('zh-CN'), style: `text-align:right;${isBold ? 'font-weight:800;color:#1e40af' : ''}` },
    ].forEach(({ text, style }) => {
      const td = document.createElement('td');
      td.setAttribute('style', `padding:6px 10px;border-bottom:1px solid #e2e8f0;${style}`);
      td.textContent = text;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);
  parent.appendChild(section);
}
```

- [ ] **Step 3: 修改 createPrintableReportNode 集成现金流表格**

在 `createPrintableReportNode` 函数中，在 `report.appendChild(responsibilitySection)` 之后、`report.appendChild(footer)` 之前，追加：

```typescript
  // 现金流明细（如果有）
  const cashflowPlans = buildPolicyCashflowPlans([policy]);
  for (const plan of cashflowPlans) {
    if (plan.annualEntries.length) {
      appendPrintableCashflowTable(report, plan.annualEntries);
    }
    if (plan.scenarioEntries.length) {
      appendPrintableScenarioTable(report, plan.scenarioEntries);
    }
  }
```

注意：`createPrintableReportNode` 当前只接受 `target: HTMLElement` 和 `title: string`。需要修改签名以接受 `policy: Policy` 参数，或在调用处传入。在调用 `createPrintableReportNode` 的 `downloadReportPdf` 和 `createPdfRenderTarget` 中一并修改。

- [ ] **Step 4: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat: integrate cashflow tables into report PDF/long-image export"
```

---

## Task 7: 更新现有测试数据

**Files:**
- Modify: `tests/policy-ocr-flow.test.mjs` (更新畅行万里指标测试数据)

- [ ] **Step 1: 搜索 policy-ocr-flow.test.mjs 中畅行万里相关的测试数据**

Run: `grep -n '畅行万里' tests/policy-ocr-flow.test.mjs`
找到相关行号。

- [ ] **Step 2: 更新畅行万里指标数据为修复后的结构**

将旧的 `特定意外身故/全残, 20倍` 单条记录替换为修复后的 9 条场景记录 + 3 条疾病身故记录。保持测试断言逻辑不变，只更新 fixture 数据。

- [ ] **Step 3: 运行全部测试**

Run: `npm run test`
Expected: 全部通过

- [ ] **Step 4: 运行 typecheck**

Run: `npm run typecheck`
Expected: 无类型错误

- [ ] **Step 5: Commit**

```bash
git add tests/policy-ocr-flow.test.mjs
git commit -m "test: update changxing indicator fixtures to match fixed data"
```

---

## Task 8: 手动验证

- [ ] **Step 1: 启动开发环境**

Run: `npm run local:dev`
Expected: 前端 :3014, API :4207, OCR :4109 均启动

- [ ] **Step 2: 验证现金流明细页面**

用 `18616135811` 登录 → 保单列表 → 家庭保障总览 → 点击"温舒萍"旁的"现金流 →"按钮 → 验证：
- 盛世恒盈年金年度表：2030 开始每年 1,465，2073 满期 110,000
- 畅行万里场景表：9 种意外场景 + 3 个年龄段疾病身故
- 安鑫护理场景表：3 个年龄段护理金
- 被保人汇总表：同年金额合并正确
- 已过期保单显示灰色标签

- [ ] **Step 3: 验证报告导出**

在现金流明细页面（或保单详情），导出 PDF/长图 → 验证：
- 表格完整渲染，无截断
- 满期金行橙色高亮
- 数字千分位格式正确

- [ ] **Step 4: 验证移动端适配**

在微信 WebView 或手机浏览器中打开 → 验证：
- 表格列数自适应（默认 2 列）
- 无横向滚动溢出
- 按钮和文字可读性正常
