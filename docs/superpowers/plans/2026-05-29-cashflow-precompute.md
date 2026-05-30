# Cashflow Pre-computation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move cashflow calculation from frontend real-time computation to server-side pre-computation with DB storage. Frontend reads pre-computed results directly.

**Architecture:** Server-side compute on policy create/update. Templates stored in `knowledge_records.payload.cashflowTemplate`. Results stored in new `policy_cashflows` table. Three-path priority: template rules > responsibility text parsing > indicator fallback. Frontend falls back to real-time computation during migration.

**Tech Stack:** Node.js 22 (`node:sqlite` DatabaseSync), `node:test` framework, Express API, React 19, TypeScript 5.8

**Design Spec:** `docs/superpowers/specs/2026-05-29-cashflow-precompute-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `server/cashflow-compute.mjs` | Server-side cashflow computation engine (migrated from `src/cashflow-engine.mjs`) |
| Create | `server/cashflow-template.mjs` | Template matching + variable resolution from knowledge_records |
| Create | `server/cashflow-store.mjs` | DB operations for `policy_cashflows` table (CRUD, recompute) |
| Create | `tests/cashflow-compute.test.mjs` | Unit tests for server-side compute engine |
| Create | `tests/cashflow-template.test.mjs` | Unit tests for template matching + variable resolution |
| Create | `tests/cashflow-store.test.mjs` | Unit tests for DB operations |
| Modify | `server/sqlite-state-store.mjs` | Add `policy_cashflows` table schema + migration |
| Modify | `server/app.mjs` | Wire compute into scan/update endpoints, add admin recompute endpoint |
| Modify | `server/policy-ocr.domain.mjs` | Add `findProductCashflowTemplate()` helper |
| Modify | `src/api.ts` | Add `cashflowEntries`, `scenarioEntries`, `totalCashflow` to Policy type |
| Modify | `src/App.tsx` | Read pre-computed entries, fallback to real-time computation |

---

## Phase 1: Infrastructure

### Task 1: Add `policy_cashflows` table to DB schema

**Files:**
- Modify: `server/sqlite-state-store.mjs` (lines 78-188, `createSchema` function)
- Test: `tests/cashflow-store.test.mjs`

- [ ] **Step 1: Write failing test for table creation**

Create `tests/cashflow-store.test.mjs`:

```javascript
// tests/cashflow-store.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCashflowStore } from '../server/cashflow-store.mjs';

const TEST_DB_PATH = path.resolve('.runtime/test-cashflow-store.sqlite');

function setupTestDb() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  const db = new DatabaseSync(TEST_DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS policies (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      guest_id TEXT,
      company TEXT,
      name TEXT,
      insured TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
  `);
  return db;
}

function teardown() {
  try { fs.unlinkSync(TEST_DB_PATH); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-wal'); } catch {}
  try { fs.unlinkSync(TEST_DB_PATH + '-shm'); } catch {}
}

test('policy_cashflows table exists and has correct columns', () => {
  const db = setupTestDb();
  try {
    const store = createCashflowStore(db);
    // Insert a test policy first
    db.prepare(`INSERT INTO policies (id, payload) VALUES (1, '{}')`).run();
    // Should not throw
    store.replaceEntries(1, [
      { year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存保险金', calcText: '基本保额 = 1,465元' },
    ]);
    const rows = store.getEntries(1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].year, 2030);
    assert.equal(rows[0].age, 42);
    assert.equal(rows[0].amount, 1465);
    assert.equal(rows[0].cumulative, 1465);
    assert.equal(rows[0].liability, '生存保险金');
  } finally {
    db.close();
    teardown();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ./tests/cashflow-store.test.mjs`
Expected: FAIL - `createCashflowStore` does not exist.

- [ ] **Step 3: Create `server/cashflow-store.mjs`**

```javascript
// server/cashflow-store.mjs
import { DatabaseSync } from 'node:sqlite';

export function ensureCashflowTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS policy_cashflows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id   INTEGER NOT NULL REFERENCES policies(id),
      year        INTEGER NOT NULL,
      age         INTEGER NOT NULL,
      amount      REAL    NOT NULL,
      cumulative  REAL    NOT NULL,
      liability   TEXT    NOT NULL,
      calc_text   TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cashflows_policy ON policy_cashflows(policy_id);
  `);
}

export function createCashflowStore(db) {
  ensureCashflowTable(db);

  function getEntries(policyId) {
    return db.prepare(
      'SELECT year, age, amount, cumulative, liability, calc_text FROM policy_cashflows WHERE policy_id = ? ORDER BY year ASC'
    ).all(Number(policyId)).map(row => ({
      year: row.year,
      age: row.age,
      amount: row.amount,
      cumulative: row.cumulative,
      liability: row.liability,
      calcText: row.calc_text || '',
    }));
  }

  function replaceEntries(policyId, entries) {
    const pid = Number(policyId);
    db.prepare('DELETE FROM policy_cashflows WHERE policy_id = ?').run(pid);
    const insert = db.prepare(
      'INSERT INTO policy_cashflows (policy_id, year, age, amount, cumulative, liability, calc_text) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const e of entries) {
      insert.run(pid, e.year, e.age, e.amount, e.cumulative, e.liability, e.calcText || '');
    }
  }

  function getAllPolicyIds() {
    return db.prepare('SELECT DISTINCT policy_id FROM policy_cashflows').all().map(r => r.policy_id);
  }

  function getStatus() {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM policy_cashflows').get();
    const policies = db.prepare('SELECT COUNT(DISTINCT policy_id) as cnt FROM policy_cashflows').get();
    return { totalEntries: total.cnt, totalPolicies: policies.cnt };
  }

  return { getEntries, replaceEntries, getAllPolicyIds, getStatus };
}
```

- [ ] **Step 4: Wire `ensureCashflowTable` into `createSchema` in `sqlite-state-store.mjs`**

Add to the end of `createSchema` function (after the `state_documents` table, before `setMeta`):

```javascript
    CREATE TABLE IF NOT EXISTS policy_cashflows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      policy_id   INTEGER NOT NULL REFERENCES policies(id),
      year        INTEGER NOT NULL,
      age         INTEGER NOT NULL,
      amount      REAL    NOT NULL,
      cumulative  REAL    NOT NULL,
      liability   TEXT    NOT NULL,
      calc_text   TEXT,
      created_at  TEXT    DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cashflows_policy ON policy_cashflows(policy_id);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test ./tests/cashflow-store.test.mjs`
Expected: PASS

- [ ] **Step 6: Add more store tests**

Add tests for:
- `replaceEntries` clears old rows before inserting new ones
- `getEntries` returns empty array for unknown policy_id
- `getStatus` returns correct counts
- Multiple entries ordered by year

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```
feat: add policy_cashflows table and cashflow store module
```

---

### Task 2: Migrate core computation functions to server

**Files:**
- Create: `server/cashflow-compute.mjs`
- Test: `tests/cashflow-compute.test.mjs`

- [ ] **Step 1: Write failing tests for `computePolicyCashflow`**

Create `tests/cashflow-compute.test.mjs`:

```javascript
// tests/cashflow-compute.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { computePolicyCashflow } from '../server/cashflow-compute.mjs';

const basePolicy = {
  id: 1,
  name: '盛世恒盈年金保险',
  company: '新华保险',
  amount: 1465,
  date: '2025-12-22',
  insuredBirthday: '1988-12-16',
  insured: '温舒萍',
  paymentPeriod: '10年交',
  coveragePeriod: '至2073年12月22日',
};

test('computePolicyCashflow: no template, no responsibilities, no indicators → empty', () => {
  const entries = computePolicyCashflow(basePolicy, null, []);
  assert.equal(entries.length, 0);
});

test('computePolicyCashflow: with template rules → uses template', () => {
  const template = {
    version: 1,
    rules: [
      {
        liability: '满期生存保险金',
        timing: { type: 'maturity' },
        amount: { basis: '已交保费' },
      },
    ],
  };
  const entries = computePolicyCashflow(basePolicy, template, []);
  assert.ok(entries.length >= 1);
  const maturity = entries.find(e => e.liability === '满期生存保险金');
  assert.ok(maturity);
  // 已交保费 = firstPremium * paymentYears = need to set firstPremium
});

test('computePolicyCashflow: cumulative is calculated', () => {
  const template = {
    version: 1,
    rules: [
      {
        liability: '生存保险金',
        timing: { type: 'range', start: { policyYear: 5 }, end: { policyYear: 7 } },
        amount: { basis: '基本保额' },
      },
    ],
  };
  const entries = computePolicyCashflow(basePolicy, template, []);
  assert.ok(entries.length >= 2);
  // Cumulative should accumulate
  assert.equal(entries[0].cumulative, entries[0].amount);
  assert.equal(entries[1].cumulative, entries[0].amount + entries[1].amount);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ./tests/cashflow-compute.test.mjs`
Expected: FAIL - `server/cashflow-compute.mjs` does not exist.

- [ ] **Step 3: Create `server/cashflow-compute.mjs` with migrated functions**

Migrate the following functions from `src/cashflow-engine.mjs`:
- `parsePaymentYearsFromText` (line 42)
- `parseCoverageEndYear` (line 52)
- `resolveIndicatorAmountForCashflow` (line 75)
- `formatCashflowCalculation` (line 92)
- `expandCashflowIndicator` (line 110)
- `resolveScenarioAmount` (line 147)
- `buildScenarioFormula` (line 179)
- `buildScenarioEntries` (line 200)
- `splitResponsibilitySections` (line 292)
- `parseBenefitSection` (line 328)
- `resolveBenefitAmount` (line 406)
- `extractAgeList` (line 434)
- `parseMinPolicyYear` (line 443)
- `parseChineseNumber` (line 450)
- `buildCalcText` (line 460)
- `synthesizeCashflowFromIndicatorsOnly` (line 468)
- `parseConditionYearRange` (line 9)

Add new functions:
- `buildContext(policy)` - extracts effectiveYear, birthYear, coverageEndYear, paymentYears, firstPremium from policy
- `computeFromTemplate(rules, params, ctx, indicators)` - applies template rules
- `computeFromResponsibilities(policy, ctx, indicators)` - parses responsibility text
- `computeFromIndicators(indicators, ctx)` - indicator fallback
- `expandRule(rule, ctx, resolvedParams)` - expands a single template rule into entries
- `computePolicyCashflow(policy, template, indicators)` - main entry point
- `computeScenarioEntries(policy, indicators)` - scenario entries computation

The main entry point:

```javascript
export function computePolicyCashflow(policy, template, indicators) {
  const ctx = buildContext(policy);
  const cashflowIndicators = indicators.filter(i => i.coverageType === '现金流');
  const rules = template?.rules || [];

  let entries = [];

  // Path 1: template rules
  if (rules.length) {
    entries = computeFromTemplate(rules, template.params, ctx, cashflowIndicators);
  }

  // Path 2: responsibility text parsing
  if (!entries.length && policy.responsibilities?.length) {
    entries = computeFromResponsibilities(policy, ctx, cashflowIndicators);
  }

  // Path 3: indicator fallback
  if (!entries.length && cashflowIndicators.length) {
    entries = computeFromIndicators(cashflowIndicators, ctx);
  }

  // Calculate cumulative
  let cumulative = 0;
  entries = entries
    .sort((a, b) => a.year - b.year)
    .map(e => { cumulative += e.amount; return { ...e, cumulative }; });

  return entries;
}
```

- [ ] **Step 4: Implement `buildContext`**

```javascript
function buildContext(policy) {
  const effectiveYear = parseYearFromDate(policy.date);
  const birthYear = parseYearFromDate(policy.insuredBirthday);
  const coverageEndYear = parseCoverageEndYear(policy);
  const paymentYears = parsePaymentYearsFromText(policy.paymentPeriod);
  const firstPremium = Number(policy.premium || policy.firstPremium || 0);
  const basicAmount = Number(policy.amount || 0);
  const totalPremium = firstPremium * paymentYears;
  return { effectiveYear, birthYear, coverageEndYear, paymentYears, firstPremium, basicAmount, totalPremium, policy };
}

function parseYearFromDate(dateStr) {
  if (!dateStr) return 0;
  const m = String(dateStr).match(/(\d{4})/);
  return m ? Number(m[1]) : 0;
}
```

- [ ] **Step 5: Implement `expandRule` for all timing types**

```javascript
function expandRule(rule, ctx, resolvedParams) {
  const entries = [];
  const amount = resolveRuleAmount(rule.amount, ctx);
  const timing = rule.timing || {};
  const productName = ctx.policy.name || '';

  switch (timing.type) {
    case 'range': {
      const startYear = resolveTimingBound(timing.start, ctx, resolvedParams, 'start');
      const endYear = resolveTimingBound(timing.end, ctx, resolvedParams, 'end');
      for (let year = startYear; year <= endYear; year++) {
        entries.push({
          year, age: year - ctx.birthYear, amount,
          liability: rule.liability, productName,
          policyId: ctx.policy.id,
          calcText: buildRuleCalcText(rule, ctx),
        });
      }
      break;
    }
    case 'pointList': {
      const ages = timing.ages || [];
      const minPolicyYear = timing.minPolicyYear || 0;
      for (const age of ages) {
        const year = ctx.birthYear + age;
        const policyYear = year - ctx.effectiveYear;
        if (policyYear >= minPolicyYear && year >= ctx.effectiveYear && year <= ctx.coverageEndYear) {
          entries.push({
            year, age, amount,
            liability: rule.liability, productName,
            policyId: ctx.policy.id,
            calcText: buildRuleCalcText(rule, ctx),
          });
        }
      }
      break;
    }
    case 'singleAge': {
      const age = timing.age;
      const year = ctx.birthYear + age;
      if (year >= ctx.effectiveYear && year <= ctx.coverageEndYear) {
        entries.push({
          year, age, amount,
          liability: rule.liability, productName,
          policyId: ctx.policy.id,
          calcText: buildRuleCalcText(rule, ctx),
        });
      }
      break;
    }
    case 'maturity': {
      if (ctx.coverageEndYear > 0) {
        entries.push({
          year: ctx.coverageEndYear,
          age: ctx.coverageEndYear - ctx.birthYear,
          amount,
          liability: rule.liability, productName,
          policyId: ctx.policy.id,
          calcText: buildRuleCalcText(rule, ctx),
        });
      }
      break;
    }
  }
  return entries;
}
```

- [ ] **Step 6: Implement `resolveRuleAmount` and `resolveTimingBound`**

```javascript
function resolveRuleAmount(amountSpec, ctx) {
  if (!amountSpec) return 0;
  const basis = String(amountSpec.basis || '');
  const factor = Number(amountSpec.factor || 1);
  if (/基本保额/.test(basis)) return ctx.basicAmount * factor;
  if (/已交保费/.test(basis)) return ctx.totalPremium * factor;
  if (/max/.test(basis)) return Math.max(ctx.totalPremium, ctx.basicAmount) * factor;
  if (amountSpec.fixed) return Number(amountSpec.fixed);
  return 0;
}

function resolveTimingBound(bound, ctx, resolvedParams, direction) {
  if (!bound) {
    return direction === 'start' ? ctx.effectiveYear : ctx.coverageEndYear;
  }
  if (bound.policyYear != null) return ctx.effectiveYear + Number(bound.policyYear);
  if (bound.age != null) {
    const age = typeof bound.age === 'string' && bound.age.startsWith('{{')
      ? Number(resolvedParams[bound.age.replace(/[{}]/g, '')] || 0)
      : Number(bound.age);
    return ctx.birthYear + age;
  }
  if (bound.beforeEvent === 'pensionStart') {
    const pensionAge = Number(resolvedParams['领取起始年龄'] || 55);
    return ctx.birthYear + pensionAge - 1;
  }
  if (bound.beforeEvent === 'coverageEnd') return ctx.coverageEndYear - 1;
  if (bound.year) return Number(bound.year);
  return direction === 'start' ? ctx.effectiveYear : ctx.coverageEndYear;
}
```

- [ ] **Step 7: Implement `computeFromResponsibilities` and `computeFromIndicators`**

Migrate the existing `synthesizeCashflowFromParams` logic (which calls `splitResponsibilitySections` + `parseBenefitSection`) and `synthesizeCashflowFromIndicatorsOnly` from `src/cashflow-engine.mjs`.

- [ ] **Step 8: Run tests**

Run: `node --test ./tests/cashflow-compute.test.mjs`
Expected: All tests pass

- [ ] **Step 9: Add more compute tests**

Add tests for:
- Template with `range` timing (盛世恒盈 生存保险金)
- Template with `maturity` timing (畅行万里 满期金)
- Template with `pointList` timing (教育金 ages 15/18/21/24)
- Template with `singleAge` timing (成家立业金 age 30)
- Responsibility text fallback (no template)
- Indicator fallback (no template, no responsibilities)
- Cumulative calculation correctness
- Year filtering (before effectiveYear excluded, after coverageEndYear excluded)

- [ ] **Step 10: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 11: Commit**

```
feat: add server-side cashflow computation engine
```

---

### Task 3: Template matching from knowledge_records

**Files:**
- Create: `server/cashflow-template.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Test: `tests/cashflow-template.test.mjs`

- [ ] **Step 1: Write failing test for template matching**

Create `tests/cashflow-template.test.mjs`:

```javascript
// tests/cashflow-template.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { findProductCashflowTemplate } from '../server/cashflow-template.mjs';

test('findProductCashflowTemplate: matches by company + productName', () => {
  const knowledgeRecords = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: JSON.stringify({
        cashflowTemplate: {
          version: 1,
          rules: [{ liability: '生存保险金', timing: { type: 'range' }, amount: { basis: '基本保额' } }],
        },
      }),
    },
  ];
  const policy = { company: '新华保险', name: '盛世恒盈年金保险' };
  const template = findProductCashflowTemplate(policy, knowledgeRecords);
  assert.ok(template);
  assert.equal(template.version, 1);
  assert.equal(template.rules.length, 1);
});

test('findProductCashflowTemplate: returns null when no match', () => {
  const template = findProductCashflowTemplate(
    { company: '未知公司', name: '未知产品' },
    [],
  );
  assert.equal(template, null);
});

test('findProductCashflowTemplate: returns null when record has no cashflowTemplate', () => {
  const knowledgeRecords = [
    {
      company: '新华保险',
      productName: '盛世恒盈年金保险',
      payload: JSON.stringify({ someOtherField: true }),
    },
  ];
  const template = findProductCashflowTemplate(
    { company: '新华保险', name: '盛世恒盈年金保险' },
    knowledgeRecords,
  );
  assert.equal(template, null);
});

test('findProductCashflowTemplate: normalizes company name for matching', () => {
  const knowledgeRecords = [
    {
      company: '新华人寿保险股份有限公司',
      productName: '盛世恒盈年金保险',
      payload: JSON.stringify({
        cashflowTemplate: { version: 1, rules: [] },
      }),
    },
  ];
  const policy = { company: '新华保险', name: '盛世恒盈年金保险' };
  const template = findProductCashflowTemplate(policy, knowledgeRecords);
  assert.ok(template);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test ./tests/cashflow-template.test.mjs`
Expected: FAIL - module does not exist.

- [ ] **Step 3: Create `server/cashflow-template.mjs`**

```javascript
// server/cashflow-template.mjs

function normalizeLookupText(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/股份有限公司/g, '')
    .replace(/有限责任公司/g, '')
    .replace(/有限公司/g, '')
    .toLowerCase();
}

function policyProductKeys(policy) {
  const keys = new Set();
  const company = normalizeLookupText(policy?.company);
  const add = (name) => {
    const n = normalizeLookupText(name);
    if (company && n) keys.add(`${company}\x1f${n}`);
  };
  add(policy?.name);
  add(policy?.productName);
  return keys;
}

export function findProductCashflowTemplate(policy, knowledgeRecords) {
  const keys = policyProductKeys(policy);
  if (!keys.size) return null;

  for (const record of knowledgeRecords || []) {
    const recordKey = `${normalizeLookupText(record.company)}\x1f${normalizeLookupText(record.productName)}`;
    if (keys.has(recordKey)) {
      let payload = record.payload;
      if (typeof payload === 'string') {
        try { payload = JSON.parse(payload); } catch { continue; }
      }
      if (payload?.cashflowTemplate) {
        return payload.cashflowTemplate;
      }
    }
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test ./tests/cashflow-template.test.mjs`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```
feat: add cashflow template matching from knowledge_records
```

---

## Phase 2: Write Path

### Task 4: Wire cashflow compute into policy scan endpoint

**Files:**
- Modify: `server/app.mjs` (lines 1618-1690, `POST /api/policies/scan`)

- [ ] **Step 1: Import new modules in `app.mjs`**

Add near the top imports:

```javascript
import { computePolicyCashflow, computeScenarioEntries } from './cashflow-compute.mjs';
import { findProductCashflowTemplate } from './cashflow-template.mjs';
import { createCashflowStore } from './cashflow-store.mjs';
```

- [ ] **Step 2: Initialize cashflow store after DB creation**

After `createSqliteStateStore` initialization, add:

```javascript
const cashflowStore = createCashflowStore(store.db || db);
```

Note: The store needs access to the raw `DatabaseSync` instance. This may require exposing it from `sqlite-state-store.mjs` or passing it in a different way. Investigate how `app.mjs` accesses the DB.

- [ ] **Step 3: Add compute + store logic after policy save in scan endpoint**

After line 1663 (`await persist(state)`), before the response:

```javascript
// Compute and store cashflow
const policyIndicators = findPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords);
const template = findProductCashflowTemplate(policy, state.knowledgeRecords);
const cashflowEntries = computePolicyCashflow(policy, template, policyIndicators);
const scenarioEntries = computeScenarioEntries(policyIndicators, policy);
const totalCashflow = cashflowEntries.reduce((sum, e) => sum + e.amount, 0);

if (cashflowEntries.length) {
  cashflowStore.replaceEntries(policy.id, cashflowEntries);
}
```

- [ ] **Step 4: Include pre-computed entries in scan response**

Modify the response at line 1684:

```javascript
res.status(201).json({
  ok: true,
  policy: {
    ...attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords),
    cashflowEntries,
    scenarioEntries,
    totalCashflow,
  },
  registrationRequiredNext: guestRegistrationRequiredNext({ state, user, guestId }),
});
```

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Manual test — scan a new policy**

Start dev server, scan a new 盛世恒盈 policy. Verify `cashflowEntries` appears in the response and rows exist in `policy_cashflows` table.

- [ ] **Step 7: Commit**

```
feat: compute and store cashflow on policy scan
```

---

### Task 5: Wire cashflow compute into policy update endpoint

**Files:**
- Modify: `server/app.mjs` (lines 1707-1746, `PATCH /api/policies/:id`)

- [ ] **Step 1: Add compute + store logic after policy update**

After line 1726 (`await persist(state)`), add the same compute + store logic from Task 4:

```javascript
// Recompute cashflow on update
const policyIndicators = findPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords);
const template = findProductCashflowTemplate(policy, state.knowledgeRecords);
const cashflowEntries = computePolicyCashflow(policy, template, policyIndicators);
const scenarioEntries = computeScenarioEntries(policyIndicators, policy);
const totalCashflow = cashflowEntries.reduce((sum, e) => sum + e.amount, 0);

cashflowStore.replaceEntries(policy.id, cashflowEntries);
```

- [ ] **Step 2: Include entries in update response**

Modify the response at line 1738:

```javascript
res.status(identityChanged ? 202 : 200).json({
  ok: true,
  policy: {
    ...attachPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords),
    cashflowEntries,
    scenarioEntries,
    totalCashflow,
  },
  reportRegenerating: identityChanged,
});
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```
feat: recompute cashflow on policy update
```

---

### Task 6: Add pre-computed entries to GET /api/policies response

**Files:**
- Modify: `server/app.mjs` (lines 1692-1705, `GET /api/policies`)

- [ ] **Step 1: Attach cashflow entries from DB to policy list**

After line 1704, before the response, load pre-computed entries:

```javascript
const policiesWithIndicators = attachPoliciesCoverageIndicators(policies, state.insuranceIndicatorRecords);
const policiesWithCashflow = policiesWithIndicators.map(p => {
  const entries = cashflowStore.getEntries(p.id);
  return {
    ...p,
    cashflowEntries: entries.length ? entries : undefined,
  };
});
res.json({ ok: true, policies: policiesWithCashflow });
```

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Manual test — GET /api/policies**

Verify policies include `cashflowEntries` for policies that have been scanned/updated after Task 4/5.

- [ ] **Step 4: Commit**

```
feat: include pre-computed cashflow in policy list response
```

---

### Task 7: Admin recompute endpoint

**Files:**
- Modify: `server/app.mjs` (add new endpoint near admin section)

- [ ] **Step 1: Add `POST /api/admin/cashflow/recompute` endpoint**

```javascript
app.post('/api/admin/cashflow/recompute', async (req, res) => {
  try {
    // Optional: filter by product name
    const productFilter = String(req.query?.product || '').trim();
    let count = 0;

    for (const policy of state.policies) {
      if (productFilter && !policy.name?.includes(productFilter)) continue;

      const indicators = findPolicyCoverageIndicators(policy, state.insuranceIndicatorRecords);
      const template = findProductCashflowTemplate(policy, state.knowledgeRecords);
      const entries = computePolicyCashflow(policy, template, indicators);

      if (entries.length) {
        cashflowStore.replaceEntries(policy.id, entries);
        count++;
      }
    }

    res.json({ ok: true, recomputed: count });
  } catch (error) {
    sendError(res, error);
  }
});
```

- [ ] **Step 2: Add `GET /api/admin/cashflow/status` endpoint**

```javascript
app.get('/api/admin/cashflow/status', async (req, res) => {
  try {
    const status = cashflowStore.getStatus();
    res.json({ ok: true, ...status });
  } catch (error) {
    sendError(res, error);
  }
});
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 4: Commit**

```
feat: add admin cashflow recompute and status endpoints
```

---

## Phase 3: Read Path Switch

### Task 8: Update TypeScript types

**Files:**
- Modify: `src/api.ts` (Policy type around lines 39-65)

- [ ] **Step 1: Add new fields to Policy type**

```typescript
export type Policy = {
  // ... existing fields ...
  cashflowEntries?: CashflowEntry[];
  scenarioEntries?: ScenarioEntry[];
  totalCashflow?: number;
};
```

- [ ] **Step 2: Add ScenarioEntry type**

```typescript
export type ScenarioEntry = {
  scenario: string;
  formula: string;
  amount: number;
  condition?: string;
  calcText?: string;
};
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```
feat: add cashflow pre-compute fields to Policy type
```

---

### Task 9: Frontend reads pre-computed with fallback

**Files:**
- Modify: `src/App.tsx` (cashflow detail page)

- [ ] **Step 1: Update CashflowDetailPage to prefer pre-computed entries**

Where `buildPolicyCashflowPlans` is called, add fallback logic:

```typescript
function buildPlansFromPolicies(policies: Policy[]) {
  return policies.map(p => {
    // Prefer pre-computed entries from server
    if (p.cashflowEntries?.length) {
      return {
        policyId: p.id,
        productName: p.name || '',
        company: p.company || '',
        insured: p.insured || '',
        insuredBirthday: p.insuredBirthday || '',
        effectiveDate: p.date || '',
        annualEntries: p.cashflowEntries,
        scenarioEntries: p.scenarioEntries || [],
        totalDeterministicCashflow: p.totalCashflow || 0,
        expired: false,
      };
    }
    // Fallback: compute on frontend
    return null;
  });
}
```

- [ ] **Step 2: Use fallback for policies without pre-computed entries**

```typescript
const preComputedPlans = buildPlansFromPolicies(memberPolicies).filter(Boolean);
const fallbackPolicies = memberPolicies.filter(p => !p.cashflowEntries?.length);
const fallbackPlans = fallbackPolicies.length
  ? buildPolicyCashflowPlans(fallbackPolicies)
  : [];
const plans = [...preComputedPlans, ...fallbackPlans];
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Manual test**

Open the cashflow detail page. Verify:
- Policies with pre-computed entries show correct data
- Policies without pre-computed entries fall back to frontend computation
- Member-level summaries still aggregate correctly

- [ ] **Step 5: Commit**

```
feat: frontend reads pre-computed cashflow with fallback
```

---

## Phase 4: Backfill + Cleanup

### Task 10: Backfill all existing policies

- [ ] **Step 1: Start dev server**

- [ ] **Step 2: Call recompute endpoint**

```bash
curl -X POST http://localhost:4207/api/admin/cashflow/recompute
```

Expected: `{ "ok": true, "recomputed": N }` where N > 0

- [ ] **Step 3: Verify all policies have entries**

```bash
curl http://localhost:4207/api/admin/cashflow/status
```

Expected: `totalPolicies` matches number of policies with cashflow products

- [ ] **Step 4: Spot-check specific policies**

Verify:
- 盛世恒盈 (500549): has 生存保险金 + 养老年金 + 满期金 entries
- 畅行万里 (500552): has 满期生存保险金 entry
- 安鑫优选 (500534): has 0 entries (care insurance, no cashflow)

- [ ] **Step 5: Commit (if any adjustments needed)**

---

### Task 11: Remove frontend computation code

**Files:**
- Modify: `src/App.tsx` (remove fallback logic)
- Modify: `src/cashflow-engine.mjs` (remove migrated functions, keep `buildMemberAnnualSummaries` + `fillCashflowYears`)

- [ ] **Step 1: Remove fallback from App.tsx**

Replace the dual-path logic with direct read:

```typescript
const plans = memberPolicies.map(p => ({
  policyId: p.id,
  productName: p.name || '',
  company: p.company || '',
  insured: p.insured || '',
  insuredBirthday: p.insuredBirthday || '',
  effectiveDate: p.date || '',
  annualEntries: p.cashflowEntries || [],
  scenarioEntries: p.scenarioEntries || [],
  totalDeterministicCashflow: p.totalCashflow || 0,
  expired: false,
}));
```

- [ ] **Step 2: Remove migrated functions from `src/cashflow-engine.mjs`**

Remove:
- `parseBenefitSection`, `splitResponsibilitySections`
- `resolveBenefitAmount`, `extractAgeList`, `parseMinPolicyYear`, `parseChineseNumber`
- `synthesizeCashflowFromParams`, `synthesizeCashflowFromIndicatorsOnly`
- `expandCashflowIndicator`, `parseConditionYearRange`
- `buildScenarioEntries`, `resolveScenarioAmount`, `buildScenarioFormula`
- `buildPolicyCashflowPlans`

Keep:
- `buildMemberAnnualSummaries` (cross-policy aggregation, display-only)
- `fillCashflowYears` (table fill helper, display-only)

- [ ] **Step 3: Update `tests/cashflow-engine.test.mjs`**

Remove tests for migrated functions. Keep tests for `buildMemberAnnualSummaries` and `fillCashflowYears`.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 5: Run full test suite**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```
refactor: remove frontend cashflow computation, use pre-computed results
```

---

## Execution Options

**Option A: Subagent-Driven (recommended)**
Each task is dispatched to a fresh subagent. Between tasks, review output and fix issues before proceeding. Best for catching problems early.

**Option B: Inline Execution**
Execute all tasks in this session sequentially. Faster but uses more context. Good if you want to watch progress in real-time.
