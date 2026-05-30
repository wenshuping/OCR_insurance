# Family Policy Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a family-level insurance report that shows total family statistics, policy inventory, insured-person policy details, critical illness analysis, accident analysis, per-policy wealth cashflow/cash value, and family wealth aggregation.

**Architecture:** Add a pure front-end report engine that converts existing `Policy[]` into a structured `FamilyReport`; keep classification and wealth aggregation testable outside React. Render the report through focused React components imported into `src/App.tsx`, then extend the existing export pipeline so the family report can be exported as PDF/long image without losing its tables.

**Tech Stack:** React 19, TypeScript 5.8, Tailwind CSS 4, Vite 6, Node.js `node:test`, existing html2canvas + jsPDF export helpers.

---

## Scope Check

This is one coherent feature because all pieces serve one report surface and share one `FamilyReport` data model. It touches several layers, so the implementation is split into focused tasks that can be tested independently:

- Tasks 1-4 build and test the pure report engine.
- Task 5 creates the TypeScript declaration file for the engine.
- Tasks 6-8 add the React report page and wire it into the existing customer app.
- Task 9 extends export behavior for raw report content.
- Task 10 adds style/source tests and final verification.

## File Structure

| Action | File | Responsibility |
| --- | --- | --- |
| Create | `src/family-report-engine.mjs` | Pure data model builder for summary, inventory, critical illness, accident, wealth, and appendix sections. |
| Create | `src/family-report-engine.d.mts` | TypeScript declarations so `src/App.tsx` can import the `.mjs` engine safely. |
| Create | `tests/family-report-engine.test.mjs` | Unit tests for the data model, classification, cash value conversion, and family wealth aggregation. |
| Create | `src/FamilyReport.tsx` | Focused React components for the family report page and its section tables. |
| Modify | `src/App.tsx` | Import engine/components, add page state, add entry button, pass export helpers, and support raw export mode. |
| Modify | `tests/customer-ui-style.test.mjs` | Static tests for report order, section names, and export wiring. |
| Reference | `docs/superpowers/specs/2026-05-30-family-policy-report-design.md` | Product and data-design source of truth. |

## Task 1: Summary And Policy Inventory Engine

**Files:**
- Create: `src/family-report-engine.mjs`
- Test: `tests/family-report-engine.test.mjs`

- [ ] **Step 1: Write the failing summary/inventory tests**

Create `tests/family-report-engine.test.mjs` with this content:

```javascript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildFamilyReport,
  buildFamilyReportSummary,
  buildPolicyInventory,
} from '../src/family-report-engine.mjs';

function makePolicy(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    company: overrides.company ?? '新华保险',
    name: overrides.name ?? '健康无忧重大疾病保险',
    applicant: overrides.applicant ?? '投保人',
    beneficiary: overrides.beneficiary ?? '法定',
    applicantRelation: overrides.applicantRelation ?? '本人',
    insured: overrides.insured ?? '妈妈',
    insuredRelation: overrides.insuredRelation ?? '本人',
    insuredBirthday: overrides.insuredBirthday ?? '1988-12-16',
    date: overrides.date ?? '2025-12-22',
    paymentPeriod: overrides.paymentPeriod ?? '20年',
    coveragePeriod: overrides.coveragePeriod ?? '终身',
    amount: overrides.amount ?? 500000,
    firstPremium: overrides.firstPremium ?? 8600,
    plans: overrides.plans ?? [],
    ocrText: overrides.ocrText ?? '',
    responsibilities: overrides.responsibilities ?? [],
    coverageIndicators: overrides.coverageIndicators ?? [],
    report: overrides.report ?? '',
    reportStatus: overrides.reportStatus ?? 'ready',
    createdAt: overrides.createdAt ?? '2026-05-30T00:00:00.000Z',
    cashflowEntries: overrides.cashflowEntries ?? [],
    scenarioEntries: overrides.scenarioEntries ?? [],
    totalCashflow: overrides.totalCashflow ?? 0,
    cashValues: overrides.cashValues ?? [],
  };
}

test('buildFamilyReportSummary counts members, policies, premiums, coverage, cash value, and payouts', () => {
  const policies = [
    makePolicy({
      id: 1,
      insured: '爸爸',
      amount: 500000,
      firstPremium: 8600,
      cashValues: [{ policyYear: 1, age: 38, cashValue: 1000 }, { policyYear: 2, age: 39, cashValue: 2300 }],
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存金', policyId: 1, productName: 'A', calculationText: '' },
      ],
    }),
    makePolicy({
      id: 2,
      insured: '妈妈',
      amount: 300000,
      firstPremium: 19600,
      cashValues: [{ policyYear: 1, age: 37, cashValue: 282 }, { policyYear: 2, age: 38, cashValue: 663 }],
      cashflowEntries: [
        { year: 2073, age: 85, amount: 110100, cumulative: 173095, liability: '满期金', policyId: 2, productName: 'B', calculationText: '' },
      ],
    }),
  ];

  const summary = buildFamilyReportSummary(policies);
  assert.equal(summary.memberCount, 2);
  assert.equal(summary.policyCount, 2);
  assert.equal(summary.annualPremium, 28200);
  assert.equal(summary.totalCoverage, 800000);
  assert.equal(summary.cashValueTotal, 2963);
  assert.equal(summary.futurePayoutTotal, 111565);
  assert.deepEqual(summary.attentionItems, []);
});

test('buildPolicyInventory creates top inventory rows and insured detail groups', () => {
  const policies = [
    makePolicy({
      id: 1,
      insured: '妈妈',
      company: '新华保险',
      name: '盛世恒盈年金',
      firstPremium: 19600,
      amount: 0,
      paymentPeriod: '10年',
      coveragePeriod: '至85岁',
      date: '2025-12-22',
      beneficiary: '第一顺位',
      cashValues: [{ policyYear: 1, age: 37, cashValue: 282 }],
      cashflowEntries: [{ year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存金', policyId: 1, productName: '盛世恒盈年金', calculationText: '' }],
    }),
    makePolicy({
      id: 2,
      insured: '',
      company: '太平人寿',
      name: '意外险',
      firstPremium: 800,
      amount: 100000,
      reportStatus: 'generating',
    }),
  ];

  const inventory = buildPolicyInventory(policies);
  assert.equal(inventory.rows.length, 2);
  assert.equal(inventory.rows[0].member, '妈妈');
  assert.equal(inventory.rows[0].typeLabel, '财富/年金');
  assert.equal(inventory.rows[0].cashValueText, '282');
  assert.equal(inventory.rows[0].dataStatus, '现金价值已识别');
  assert.equal(inventory.rows[1].member, '未识别被保人');
  assert.equal(inventory.rows[1].dataStatus, '责任生成中');
  assert.equal(inventory.insuredGroups.length, 2);
  assert.equal(inventory.insuredGroups[0].member, '妈妈');
  assert.equal(inventory.insuredGroups[0].policies[0].beneficiary, '第一顺位');
});

test('buildFamilyReport includes summary and inventory sections', () => {
  const report = buildFamilyReport([makePolicy({ id: 1, insured: '爸爸' })]);
  assert.equal(report.summary.memberCount, 1);
  assert.equal(report.policyInventory.rows.length, 1);
  assert.equal(report.policyInventory.insuredGroups[0].member, '爸爸');
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
node --test tests/family-report-engine.test.mjs
```

Expected: FAIL with `Cannot find module '../src/family-report-engine.mjs'`.

- [ ] **Step 3: Create the minimal engine for summary and inventory**

Create `src/family-report-engine.mjs`:

```javascript
function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function memberName(policy) {
  const value = String(policy?.insured || '').trim();
  return value || '未识别被保人';
}

function latestCashValue(policy) {
  const rows = Array.isArray(policy?.cashValues) ? policy.cashValues : [];
  const sorted = rows
    .filter((row) => Number.isFinite(Number(row?.policyYear)) && Number.isFinite(Number(row?.cashValue)))
    .sort((left, right) => Number(left.policyYear) - Number(right.policyYear));
  return sorted.length ? asNumber(sorted[sorted.length - 1].cashValue) : 0;
}

function futurePayoutTotal(policy) {
  const entries = Array.isArray(policy?.cashflowEntries) ? policy.cashflowEntries : [];
  return entries.reduce((sum, entry) => sum + asNumber(entry?.amount), 0);
}

function formatNumberText(value) {
  return asNumber(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function policyTypeLabel(policy) {
  const text = `${policy?.name || ''} ${policy?.coveragePeriod || ''} ${policy?.responsibilities?.map?.((r) => `${r.coverageType || ''} ${r.scenario || ''} ${r.payout || ''}`).join(' ') || ''}`;
  if (/年金|教育金|生存金|满期|分红|万能|现金价值|终身寿|增额/u.test(text)) return '财富/年金';
  if (/重疾|重大疾病|中症|轻症|癌|防癌/u.test(text)) return '重疾';
  if (/意外|交通|航空|伤残|猝死/u.test(text)) return '意外';
  if (/医疗|住院|门诊|报销/u.test(text)) return '医疗';
  return '其他';
}

function coverageText(policy) {
  const amount = asNumber(policy?.amount);
  if (amount > 0) return amount >= 10000 ? `${formatNumberText(amount / 10000)}万` : formatNumberText(amount);
  const payout = futurePayoutTotal(policy);
  if (payout > 0) return `累计领取${formatNumberText(payout)}`;
  return '按条款';
}

function dataStatus(policy) {
  if (String(policy?.reportStatus || 'ready') === 'generating') return '责任生成中';
  if (String(policy?.reportStatus || 'ready') === 'failed') return '报告失败';
  if (latestCashValue(policy) > 0) return '现金价值已识别';
  if ((Array.isArray(policy?.coverageIndicators) && policy.coverageIndicators.length) || (Array.isArray(policy?.responsibilities) && policy.responsibilities.length)) return '责任已量化';
  return '待补充责任';
}

export function buildFamilyReportSummary(policies = []) {
  const members = new Set(policies.map(memberName));
  const attentionItems = [];
  for (const policy of policies) {
    if (String(policy?.reportStatus || 'ready') === 'generating') attentionItems.push(`${memberName(policy)}的${policy.name || '保单'}责任生成中`);
    if (String(policy?.reportStatus || 'ready') === 'failed') attentionItems.push(`${memberName(policy)}的${policy.name || '保单'}报告失败`);
  }
  return {
    memberCount: members.size,
    policyCount: policies.length,
    annualPremium: policies.reduce((sum, policy) => sum + asNumber(policy?.firstPremium), 0),
    totalCoverage: policies.reduce((sum, policy) => sum + asNumber(policy?.amount), 0),
    cashValueTotal: policies.reduce((sum, policy) => sum + latestCashValue(policy), 0),
    futurePayoutTotal: policies.reduce((sum, policy) => sum + futurePayoutTotal(policy), 0),
    attentionItems,
  };
}

export function buildPolicyInventory(policies = []) {
  const rows = policies.map((policy) => ({
    policyId: policy.id,
    member: memberName(policy),
    company: String(policy.company || ''),
    policyNumber: String(policy.policyNumber || ''),
    productName: String(policy.name || ''),
    typeLabel: policyTypeLabel(policy),
    annualPremium: asNumber(policy.firstPremium),
    annualPremiumText: formatNumberText(policy.firstPremium),
    paymentPeriod: String(policy.paymentPeriod || ''),
    coveragePeriod: String(policy.coveragePeriod || ''),
    effectiveDate: String(policy.date || ''),
    coverageText: coverageText(policy),
    beneficiary: String(policy.beneficiary || ''),
    totalPremiumText: formatNumberText(policy.firstPremium),
    cashValue: latestCashValue(policy),
    cashValueText: latestCashValue(policy) > 0 ? formatNumberText(latestCashValue(policy)) : '-',
    dataStatus: dataStatus(policy),
  }));

  const groupMap = new Map();
  for (const row of rows) {
    const existing = groupMap.get(row.member) || { member: row.member, policies: [], policyCount: 0, annualPremium: 0 };
    existing.policies.push(row);
    existing.policyCount += 1;
    existing.annualPremium += row.annualPremium;
    groupMap.set(row.member, existing);
  }

  return {
    rows,
    insuredGroups: [...groupMap.values()].sort((left, right) => right.policyCount - left.policyCount || left.member.localeCompare(right.member, 'zh-CN')),
  };
}

export function buildFamilyReport(policies = []) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    criticalIllness: { members: [] },
    accident: { members: [] },
    wealth: { memberReports: [], aggregateRows: [], keyPoints: [] },
    appendix: { policies: policies.map((policy) => ({ policyId: policy.id, productName: String(policy.name || ''), ocrText: String(policy.ocrText || '') })) },
  };
}
```

- [ ] **Step 4: Run the tests and verify they pass**

Run:

```bash
node --test tests/family-report-engine.test.mjs
```

Expected: PASS for all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add src/family-report-engine.mjs tests/family-report-engine.test.mjs
git commit -m "feat: add family report summary engine"
```

## Task 2: Critical Illness Section Engine

**Files:**
- Modify: `src/family-report-engine.mjs`
- Modify: `tests/family-report-engine.test.mjs`

- [ ] **Step 1: Add failing critical illness tests**

Append to `tests/family-report-engine.test.mjs`:

```javascript
test('buildFamilyReport creates critical illness rows per family member', () => {
  const policies = [
    makePolicy({
      id: 10,
      insured: '爸爸',
      name: '健康无忧重大疾病保险',
      amount: 500000,
      coverageIndicators: [
        { coverageType: '疾病保障', liability: '重疾(首次给付)', value: 100, unit: '%', basis: '基本保险金额', formulaText: '基本保额100%', productName: '健康无忧重大疾病保险' },
        { coverageType: '疾病保障', liability: '中症(首次给付)', value: 60, unit: '%', basis: '基本保险金额', formulaText: '基本保额60%', productName: '健康无忧重大疾病保险' },
        { coverageType: '疾病保障', liability: '轻症(首次给付)', value: 30, unit: '%', basis: '基本保险金额', formulaText: '基本保额30%', productName: '健康无忧重大疾病保险' },
        { coverageType: '疾病保障', liability: '特定疾病', value: 2, unit: '倍', basis: '基本保险金额', formulaText: '基本保额2倍', productName: '健康无忧重大疾病保险' },
      ],
    }),
    makePolicy({ id: 11, insured: '老人', name: '老人意外险', amount: 100000 }),
  ];

  const report = buildFamilyReport(policies);
  const father = report.criticalIllness.members.find((item) => item.member === '爸爸');
  const elder = report.criticalIllness.members.find((item) => item.member === '老人');

  assert.equal(father.rows.find((row) => row.key === 'critical_first').amountText, '50万');
  assert.equal(father.rows.find((row) => row.key === 'moderate').amountText, '30万');
  assert.equal(father.rows.find((row) => row.key === 'mild').amountText, '15万');
  assert.equal(father.rows.find((row) => row.key === 'specific_disease').amountText, '100万');
  assert.equal(elder.rows.find((row) => row.key === 'critical_first').status, 'missing');
  assert.ok(elder.attentionItems.includes('重疾首次给付缺失'));
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="critical illness"
```

Expected: FAIL because `report.criticalIllness.members` is empty.

- [ ] **Step 3: Add critical illness classification and section builder**

Insert this code in `src/family-report-engine.mjs` before `export function buildFamilyReport`:

```javascript
const CRITICAL_ROWS = [
  { key: 'critical_first', label: '重疾首次给付', patterns: [/重疾/u, /重大疾病/u, /重度疾病/u] },
  { key: 'critical_multiple', label: '重疾多次给付', patterns: [/多次/u, /第二次/u, /第2次/u, /再次/u] },
  { key: 'moderate', label: '中症给付', patterns: [/中症/u, /中度疾病/u] },
  { key: 'mild', label: '轻症给付', patterns: [/轻症/u, /轻度疾病/u] },
  { key: 'specific_disease', label: '特定疾病/少儿特疾/癌症', patterns: [/特定疾病/u, /少儿特疾/u, /女性特疾/u, /男性特疾/u, /恶性肿瘤/u, /癌/u] },
  { key: 'terminal', label: '疾病终末期', patterns: [/终末期/u] },
  { key: 'death_disability', label: '身故/全残', patterns: [/身故/u, /全残/u] },
  { key: 'waiver', label: '保费豁免', patterns: [/豁免/u] },
];

function indicatorText(indicator) {
  return [indicator?.coverageType, indicator?.liability, indicator?.formulaText, indicator?.condition, indicator?.basis, indicator?.sourceExcerpt]
    .map((value) => String(value || ''))
    .join(' ');
}

function classifyByDefinitions(text, definitions) {
  const normalized = String(text || '').normalize('NFKC');
  return definitions.find((definition) => definition.patterns.some((pattern) => pattern.test(normalized))) || null;
}

function resolveIndicatorAmount(indicator, policy) {
  const policyAmount = asNumber(policy?.amount);
  const value = Number(indicator?.value);
  const unit = String(indicator?.unit || '');
  const basis = String(indicator?.basis || '');
  const text = indicatorText(indicator);
  if (Number.isFinite(value) && /%/u.test(unit) && /基本保险金额|基本保额|保险金额/u.test(basis)) return policyAmount * value / 100;
  if (Number.isFinite(value) && /倍/u.test(unit) && /基本保险金额|基本保额|保险金额/u.test(basis)) return policyAmount * value;
  const wan = text.match(/(\d+(?:\.\d+)?)万/u);
  if (wan?.[1]) return Number(wan[1]) * 10000;
  const yuan = text.match(/(\d+(?:\.\d+)?)(?:元|圆)/u);
  if (yuan?.[1]) return Number(yuan[1]);
  if (/基本保险金额|基本保额/u.test(text) && policyAmount > 0) return policyAmount;
  return 0;
}

function amountDisplay(amount, fallback = '') {
  if (amount > 0) return amount >= 10000 ? `${formatNumberText(amount / 10000)}万` : formatNumberText(amount);
  return fallback || '待识别';
}

function baseProtectionRow(definition) {
  return {
    key: definition.key,
    label: definition.label,
    amountText: '未识别',
    countText: '-',
    status: 'missing',
    conditionText: '未识别到该责任',
    sourcePolicies: [],
  };
}

function applyIndicatorToRow(row, indicator, policy) {
  const amount = resolveIndicatorAmount(indicator, policy);
  const countText = /多次|2次|两次/u.test(indicatorText(indicator)) ? '多次' : /3次/u.test(indicatorText(indicator)) ? '3次' : /2次|两次/u.test(indicatorText(indicator)) ? '2次' : '1次';
  return {
    ...row,
    amountText: amountDisplay(amount, String(indicator?.formulaText || '').trim()),
    countText,
    status: amount > 0 ? 'covered' : 'formula',
    conditionText: String(indicator?.condition || indicator?.formulaText || indicator?.basis || '按条款').trim(),
    sourcePolicies: [...new Set([...row.sourcePolicies, policy.name || indicator?.productName || '保单'])],
  };
}

function buildMemberCriticalRows(memberPolicies) {
  const rows = CRITICAL_ROWS.map(baseProtectionRow);
  for (const policy of memberPolicies) {
    const indicators = Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      const definition = classifyByDefinitions(indicatorText(indicator), CRITICAL_ROWS);
      if (!definition) continue;
      const index = rows.findIndex((row) => row.key === definition.key);
      rows[index] = applyIndicatorToRow(rows[index], indicator, policy);
    }
    if (!indicators.length && /重疾|重大疾病|中症|轻症|防癌|癌/u.test(`${policy.name || ''} ${policy.responsibilities?.map?.((row) => `${row.coverageType || ''} ${row.scenario || ''} ${row.payout || ''}`).join(' ') || ''}`)) {
      const index = rows.findIndex((row) => row.key === 'critical_first');
      rows[index] = {
        ...rows[index],
        amountText: amountDisplay(asNumber(policy.amount)),
        countText: '1次',
        status: asNumber(policy.amount) > 0 ? 'covered' : 'unknown',
        conditionText: '按保单基础保额估算',
        sourcePolicies: [...new Set([...rows[index].sourcePolicies, policy.name || '保单'])],
      };
    }
  }
  const attentionItems = rows.filter((row) => row.status === 'missing').map((row) => `${row.label}缺失`);
  return { rows, attentionItems };
}

export function buildCriticalIllnessSection(policies = []) {
  const groupMap = new Map();
  for (const policy of policies) {
    const member = memberName(policy);
    const list = groupMap.get(member) || [];
    list.push(policy);
    groupMap.set(member, list);
  }
  return {
    members: [...groupMap.entries()].map(([member, memberPolicies]) => ({
      member,
      ...buildMemberCriticalRows(memberPolicies),
    })),
  };
}
```

Then update `buildFamilyReport`:

```javascript
export function buildFamilyReport(policies = []) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    criticalIllness: buildCriticalIllnessSection(policies),
    accident: { members: [] },
    wealth: { memberReports: [], aggregateRows: [], keyPoints: [] },
    appendix: { policies: policies.map((policy) => ({ policyId: policy.id, productName: String(policy.name || ''), ocrText: String(policy.ocrText || '') })) },
  };
}
```

- [ ] **Step 4: Run the targeted test and verify it passes**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="critical illness"
```

Expected: PASS.

- [ ] **Step 5: Run all engine tests**

Run:

```bash
node --test tests/family-report-engine.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/family-report-engine.mjs tests/family-report-engine.test.mjs
git commit -m "feat: add family critical illness analysis"
```

## Task 3: Accident Section Engine

**Files:**
- Modify: `src/family-report-engine.mjs`
- Modify: `tests/family-report-engine.test.mjs`

- [ ] **Step 1: Add failing accident tests**

Append to `tests/family-report-engine.test.mjs`:

```javascript
test('buildFamilyReport creates accident rows per family member without merging scenarios', () => {
  const policies = [
    makePolicy({
      id: 20,
      insured: '爸爸',
      name: '综合意外险',
      amount: 100000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故/全残', value: 10, unit: '倍', basis: '基本保险金额', formulaText: '基本保额10倍', productName: '综合意外险' },
        { coverageType: '意外保障', liability: '交通意外', value: 20, unit: '倍', basis: '基本保险金额', formulaText: '基本保额20倍', condition: '公共交通/自驾/网约车分别列', productName: '综合意外险' },
        { coverageType: '意外保障', liability: '航空意外', value: 50, unit: '倍', basis: '基本保险金额', formulaText: '基本保额50倍', productName: '综合意外险' },
        { coverageType: '意外保障', liability: '意外医疗', value: 20000, unit: '元', basis: '医疗费用', formulaText: '限额2万元', productName: '综合意外险' },
      ],
    }),
    makePolicy({ id: 21, insured: '妈妈', name: '年金保险', amount: 0 }),
  ];

  const report = buildFamilyReport(policies);
  const father = report.accident.members.find((item) => item.member === '爸爸');
  const mother = report.accident.members.find((item) => item.member === '妈妈');

  assert.equal(father.rows.find((row) => row.key === 'general_accident').amountText, '100万');
  assert.equal(father.rows.find((row) => row.key === 'traffic').amountText, '200万');
  assert.equal(father.rows.find((row) => row.key === 'aviation').amountText, '500万');
  assert.equal(father.rows.find((row) => row.key === 'accident_medical').amountText, '2万');
  assert.equal(mother.rows.find((row) => row.key === 'general_accident').status, 'missing');
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="accident rows"
```

Expected: FAIL because `report.accident.members` is empty.

- [ ] **Step 3: Add accident section builder**

Insert this code in `src/family-report-engine.mjs` after `buildCriticalIllnessSection`:

```javascript
const ACCIDENT_ROWS = [
  { key: 'general_accident', label: '一般意外身故/全残', patterns: [/一般意外/u, /意外身故/u, /意外全残/u] },
  { key: 'accident_disability', label: '意外伤残', patterns: [/意外伤残/u, /残疾/u, /伤残等级/u] },
  { key: 'accident_medical', label: '意外医疗', patterns: [/意外医疗/u, /医疗费用/u, /报销/u] },
  { key: 'traffic', label: '交通意外', patterns: [/交通意外/u, /公共交通/u, /网约车/u] },
  { key: 'driving', label: '自驾/驾乘', patterns: [/自驾/u, /驾乘/u, /驾驶/u] },
  { key: 'public_transport', label: '公共交通', patterns: [/公共交通/u, /客运汽车/u, /客运轮船/u] },
  { key: 'aviation', label: '航空意外', patterns: [/航空/u, /民航/u, /飞机/u] },
  { key: 'rail_ship', label: '轨道/轮船', patterns: [/轨道/u, /列车/u, /轮船/u] },
  { key: 'sudden_death', label: '猝死', patterns: [/猝死/u] },
  { key: 'hospital_allowance', label: '住院津贴', patterns: [/住院津贴/u, /津贴/u] },
];

function buildMemberAccidentRows(memberPolicies) {
  const rows = ACCIDENT_ROWS.map(baseProtectionRow);
  for (const policy of memberPolicies) {
    const indicators = Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      if (String(indicator?.coverageType || '') !== '意外保障') continue;
      const definition = classifyByDefinitions(indicatorText(indicator), ACCIDENT_ROWS);
      if (!definition) continue;
      const index = rows.findIndex((row) => row.key === definition.key);
      const amount = resolveIndicatorAmount(indicator, policy);
      rows[index] = {
        ...rows[index],
        amountText: amountDisplay(amount, String(indicator?.formulaText || '').trim()),
        countText: /医疗|报销/u.test(indicatorText(indicator)) ? '报销型' : /津贴/u.test(indicatorText(indicator)) ? '津贴' : '定额给付',
        status: amount > 0 ? 'covered' : 'formula',
        conditionText: String(indicator?.condition || indicator?.formulaText || indicator?.basis || '按条款').trim(),
        sourcePolicies: [...new Set([...rows[index].sourcePolicies, policy.name || indicator?.productName || '保单'])],
      };
    }
    if (!indicators.length && /意外/u.test(`${policy.name || ''} ${policy.responsibilities?.map?.((row) => `${row.coverageType || ''} ${row.scenario || ''} ${row.payout || ''}`).join(' ') || ''}`)) {
      const index = rows.findIndex((row) => row.key === 'general_accident');
      rows[index] = {
        ...rows[index],
        amountText: amountDisplay(asNumber(policy.amount)),
        countText: '定额给付',
        status: asNumber(policy.amount) > 0 ? 'covered' : 'unknown',
        conditionText: '按保单基础保额估算',
        sourcePolicies: [...new Set([...rows[index].sourcePolicies, policy.name || '保单'])],
      };
    }
  }
  const attentionItems = rows.filter((row) => row.status === 'missing').map((row) => `${row.label}缺失`);
  return { rows, attentionItems };
}

export function buildAccidentSection(policies = []) {
  const groupMap = new Map();
  for (const policy of policies) {
    const member = memberName(policy);
    const list = groupMap.get(member) || [];
    list.push(policy);
    groupMap.set(member, list);
  }
  return {
    members: [...groupMap.entries()].map(([member, memberPolicies]) => ({
      member,
      ...buildMemberAccidentRows(memberPolicies),
    })),
  };
}
```

Then update `buildFamilyReport`:

```javascript
export function buildFamilyReport(policies = []) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    criticalIllness: buildCriticalIllnessSection(policies),
    accident: buildAccidentSection(policies),
    wealth: { memberReports: [], aggregateRows: [], keyPoints: [] },
    appendix: { policies: policies.map((policy) => ({ policyId: policy.id, productName: String(policy.name || ''), ocrText: String(policy.ocrText || '') })) },
  };
}
```

- [ ] **Step 4: Run the targeted test and verify it passes**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="accident rows"
```

Expected: PASS.

- [ ] **Step 5: Run all engine tests**

Run:

```bash
node --test tests/family-report-engine.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/family-report-engine.mjs tests/family-report-engine.test.mjs
git commit -m "feat: add family accident analysis"
```

## Task 4: Wealth Section And Family Wealth Aggregation

**Files:**
- Modify: `src/family-report-engine.mjs`
- Modify: `tests/family-report-engine.test.mjs`

- [ ] **Step 1: Add failing wealth tests**

Append to `tests/family-report-engine.test.mjs`:

```javascript
test('buildFamilyReport creates per-member wealth policies and calendar-year aggregate rows', () => {
  const policies = [
    makePolicy({
      id: 30,
      insured: '妈妈',
      name: '盛世恒盈年金',
      firstPremium: 19600,
      date: '2025-12-22',
      paymentPeriod: '2年',
      cashflowEntries: [
        { year: 2030, age: 42, amount: 1465, cumulative: 1465, liability: '生存金', policyId: 30, productName: '盛世恒盈年金', calculationText: '' },
        { year: 2073, age: 85, amount: 110100, cumulative: 173095, liability: '满期金', policyId: 30, productName: '盛世恒盈年金', calculationText: '' },
      ],
      cashValues: [
        { policyYear: 1, age: 37, cashValue: 282 },
        { policyYear: 2, age: 38, cashValue: 663 },
        { policyYear: 49, age: 85, cashValue: 56208 },
      ],
    }),
    makePolicy({
      id: 31,
      insured: '孩子',
      name: '教育年金',
      firstPremium: 20000,
      date: '2026-01-01',
      paymentPeriod: '1年',
      cashflowEntries: [
        { year: 2044, age: 18, amount: 30000, cumulative: 30000, liability: '教育金', policyId: 31, productName: '教育年金', calculationText: '' },
      ],
      cashValues: [{ policyYear: 1, age: 0, cashValue: 1000 }],
    }),
  ];

  const report = buildFamilyReport(policies);
  const mother = report.wealth.memberReports.find((item) => item.member === '妈妈');
  const row2025 = report.wealth.aggregateRows.find((row) => row.year === 2025);
  const row2030 = report.wealth.aggregateRows.find((row) => row.year === 2030);
  const row2073 = report.wealth.aggregateRows.find((row) => row.year === 2073);

  assert.equal(mother.policies[0].productName, '盛世恒盈年金');
  assert.equal(mother.policies[0].cashValueRows[0].calendarYear, 2025);
  assert.equal(row2025.premiumOutflow, 19600);
  assert.equal(row2025.cashValueTotal, 282);
  assert.equal(row2030.payoutInflow, 1465);
  assert.equal(row2073.payoutInflow, 110100);
  assert.ok(report.wealth.keyPoints.some((point) => point.label === '领取高峰年' && point.value === '2073'));
});
```

- [ ] **Step 2: Run the targeted test and verify it fails**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="wealth policies"
```

Expected: FAIL because `report.wealth.memberReports` is empty.

- [ ] **Step 3: Add wealth section builder**

Insert this code in `src/family-report-engine.mjs` after `buildAccidentSection`:

```javascript
function parsePaymentYears(value) {
  const text = String(value || '').normalize('NFKC');
  if (/趸交|一次交清/u.test(text)) return 1;
  const year = text.match(/(\d+(?:\.\d+)?)年/u);
  if (year?.[1]) return Math.max(1, Math.floor(Number(year[1])));
  const period = text.match(/(\d+(?:\.\d+)?)期/u);
  if (period?.[1]) return Math.max(1, Math.floor(Number(period[1])));
  return 1;
}

function effectiveYear(policy) {
  const year = new Date(policy?.date || '').getFullYear();
  return Number.isFinite(year) ? year : 0;
}

function cashValueRows(policy) {
  const year = effectiveYear(policy);
  return (Array.isArray(policy?.cashValues) ? policy.cashValues : [])
    .filter((row) => Number.isFinite(Number(row?.policyYear)) && Number.isFinite(Number(row?.cashValue)))
    .map((row) => ({
      policyYear: Number(row.policyYear),
      age: row.age == null ? null : Number(row.age),
      calendarYear: year > 0 ? year + Number(row.policyYear) - 1 : 0,
      cashValue: asNumber(row.cashValue),
    }))
    .sort((left, right) => left.policyYear - right.policyYear);
}

function cashflowRows(policy) {
  return (Array.isArray(policy?.cashflowEntries) ? policy.cashflowEntries : [])
    .filter((row) => Number.isFinite(Number(row?.year)))
    .map((row) => ({
      year: Number(row.year),
      age: Number(row.age) || 0,
      amount: asNumber(row.amount),
      cumulative: asNumber(row.cumulative),
      liability: String(row.liability || ''),
      policyId: policy.id,
      productName: String(policy.name || row.productName || ''),
    }))
    .sort((left, right) => left.year - right.year);
}

function isWealthPolicy(policy) {
  const text = `${policy?.name || ''} ${policy?.coveragePeriod || ''} ${policy?.responsibilities?.map?.((row) => `${row.coverageType || ''} ${row.scenario || ''} ${row.payout || ''}`).join(' ') || ''}`;
  return cashValueRows(policy).length > 0 || cashflowRows(policy).length > 0 || /年金|教育金|生存金|满期|分红|万能|现金价值|终身寿|增额/u.test(text);
}

function premiumOutflows(policy) {
  const startYear = effectiveYear(policy);
  const years = parsePaymentYears(policy?.paymentPeriod);
  if (!startYear) return [];
  return Array.from({ length: years }, (_item, index) => ({
    year: startYear + index,
    amount: asNumber(policy?.firstPremium),
    policyId: policy.id,
    productName: String(policy.name || ''),
    member: memberName(policy),
  }));
}

function buildWealthPolicyReport(policy) {
  const policyCashflowRows = cashflowRows(policy);
  const policyCashValueRows = cashValueRows(policy);
  const largestPayout = policyCashflowRows.reduce((best, row) => (row.amount > best.amount ? row : best), { year: 0, amount: 0 });
  const latestValue = policyCashValueRows.length ? policyCashValueRows[policyCashValueRows.length - 1] : null;
  const keyPoints = [];
  if (policyCashflowRows.length) keyPoints.push({ label: '开始领取', value: String(policyCashflowRows[0].year), year: policyCashflowRows[0].year });
  if (largestPayout.year) keyPoints.push({ label: '单年最高领取', value: `${largestPayout.year} / ${formatNumberText(largestPayout.amount)}`, year: largestPayout.year });
  if (latestValue) keyPoints.push({ label: '末期现金价值', value: formatNumberText(latestValue.cashValue), year: latestValue.calendarYear });
  return {
    policyId: policy.id,
    productName: String(policy.name || ''),
    company: String(policy.company || ''),
    annualPremium: asNumber(policy.firstPremium),
    cashflowRows: policyCashflowRows,
    cashValueRows: policyCashValueRows,
    keyPoints,
  };
}

export function buildWealthSection(policies = []) {
  const wealthPolicies = policies.filter(isWealthPolicy);
  const memberMap = new Map();
  for (const policy of wealthPolicies) {
    const member = memberName(policy);
    const existing = memberMap.get(member) || { member, policies: [], attentionItems: [] };
    existing.policies.push(buildWealthPolicyReport(policy));
    if (!cashValueRows(policy).length) existing.attentionItems.push(`${policy.name || '保单'}缺少现金价值表`);
    memberMap.set(member, existing);
  }

  const aggregateMap = new Map();
  for (const policy of wealthPolicies) {
    for (const premium of premiumOutflows(policy)) {
      const row = aggregateMap.get(premium.year) || { year: premium.year, premiumOutflow: 0, payoutInflow: 0, netCashflow: 0, cumulativeNetCashflow: 0, cashValueTotal: 0, details: [] };
      row.premiumOutflow += premium.amount;
      row.details.push({ type: 'premium', ...premium });
      aggregateMap.set(premium.year, row);
    }
    for (const payout of cashflowRows(policy)) {
      const row = aggregateMap.get(payout.year) || { year: payout.year, premiumOutflow: 0, payoutInflow: 0, netCashflow: 0, cumulativeNetCashflow: 0, cashValueTotal: 0, details: [] };
      row.payoutInflow += payout.amount;
      row.details.push({ type: 'payout', policyId: policy.id, productName: policy.name || '', member: memberName(policy), amount: payout.amount });
      aggregateMap.set(payout.year, row);
    }
    for (const value of cashValueRows(policy)) {
      if (!value.calendarYear) continue;
      const row = aggregateMap.get(value.calendarYear) || { year: value.calendarYear, premiumOutflow: 0, payoutInflow: 0, netCashflow: 0, cumulativeNetCashflow: 0, cashValueTotal: 0, details: [] };
      row.cashValueTotal += value.cashValue;
      row.details.push({ type: 'cashValue', policyId: policy.id, productName: policy.name || '', member: memberName(policy), amount: value.cashValue });
      aggregateMap.set(value.calendarYear, row);
    }
  }

  let cumulative = 0;
  const aggregateRows = [...aggregateMap.values()]
    .sort((left, right) => left.year - right.year)
    .map((row) => {
      const netCashflow = row.payoutInflow - row.premiumOutflow;
      cumulative += netCashflow;
      return { ...row, netCashflow, cumulativeNetCashflow: cumulative };
    });

  const payoutPeak = aggregateRows.reduce((best, row) => (row.payoutInflow > best.payoutInflow ? row : best), { year: 0, payoutInflow: 0 });
  const keyPoints = [];
  if (payoutPeak.year) keyPoints.push({ label: '领取高峰年', value: String(payoutPeak.year), year: payoutPeak.year });

  return {
    memberReports: [...memberMap.values()],
    aggregateRows,
    keyPoints,
  };
}
```

Then update `buildFamilyReport`:

```javascript
export function buildFamilyReport(policies = []) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    criticalIllness: buildCriticalIllnessSection(policies),
    accident: buildAccidentSection(policies),
    wealth: buildWealthSection(policies),
    appendix: { policies: policies.map((policy) => ({ policyId: policy.id, productName: String(policy.name || ''), ocrText: String(policy.ocrText || '') })) },
  };
}
```

- [ ] **Step 4: Run the targeted test and verify it passes**

Run:

```bash
node --test tests/family-report-engine.test.mjs --test-name-pattern="wealth policies"
```

Expected: PASS.

- [ ] **Step 5: Run all engine tests**

Run:

```bash
node --test tests/family-report-engine.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/family-report-engine.mjs tests/family-report-engine.test.mjs
git commit -m "feat: add family wealth aggregation"
```

## Task 5: TypeScript Declarations For Family Report Engine

**Files:**
- Create: `src/family-report-engine.d.mts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Create the declaration file**

Create `src/family-report-engine.d.mts`:

```typescript
import type { Policy } from './api';

export type FamilyReportSummary = {
  memberCount: number;
  policyCount: number;
  annualPremium: number;
  totalCoverage: number;
  cashValueTotal: number;
  futurePayoutTotal: number;
  attentionItems: string[];
};

export type FamilyPolicyInventoryRow = {
  policyId: number;
  member: string;
  company: string;
  policyNumber: string;
  productName: string;
  typeLabel: string;
  annualPremium: number;
  annualPremiumText: string;
  paymentPeriod: string;
  coveragePeriod: string;
  effectiveDate: string;
  coverageText: string;
  beneficiary: string;
  totalPremiumText: string;
  cashValue: number;
  cashValueText: string;
  dataStatus: string;
};

export type FamilyInsuredPolicyGroup = {
  member: string;
  policies: FamilyPolicyInventoryRow[];
  policyCount: number;
  annualPremium: number;
};

export type FamilyPolicyInventory = {
  rows: FamilyPolicyInventoryRow[];
  insuredGroups: FamilyInsuredPolicyGroup[];
};

export type FamilyProtectionRow = {
  key: string;
  label: string;
  amountText: string;
  countText: string;
  status: 'covered' | 'partial' | 'missing' | 'formula' | 'unknown';
  conditionText: string;
  sourcePolicies: string[];
};

export type FamilyMemberProtectionReport = {
  member: string;
  rows: FamilyProtectionRow[];
  attentionItems: string[];
};

export type FamilySectionReport = {
  members: FamilyMemberProtectionReport[];
};

export type FamilyWealthPolicyCashflowRow = {
  year: number;
  age: number;
  amount: number;
  cumulative: number;
  liability: string;
  policyId: number;
  productName: string;
};

export type FamilyWealthPolicyCashValueRow = {
  policyYear: number;
  age: number | null;
  calendarYear: number;
  cashValue: number;
};

export type FamilyWealthKeyPoint = {
  label: string;
  value: string;
  year: number;
};

export type FamilyWealthPolicyReport = {
  policyId: number;
  productName: string;
  company: string;
  annualPremium: number;
  cashflowRows: FamilyWealthPolicyCashflowRow[];
  cashValueRows: FamilyWealthPolicyCashValueRow[];
  keyPoints: FamilyWealthKeyPoint[];
};

export type FamilyMemberWealthReport = {
  member: string;
  policies: FamilyWealthPolicyReport[];
  attentionItems: string[];
};

export type FamilyWealthAggregateRow = {
  year: number;
  premiumOutflow: number;
  payoutInflow: number;
  netCashflow: number;
  cumulativeNetCashflow: number;
  cashValueTotal: number;
  details: Array<{ type: string; policyId: number; productName: string; member: string; amount: number }>;
};

export type FamilyWealthReport = {
  memberReports: FamilyMemberWealthReport[];
  aggregateRows: FamilyWealthAggregateRow[];
  keyPoints: FamilyWealthKeyPoint[];
};

export type FamilyReport = {
  summary: FamilyReportSummary;
  policyInventory: FamilyPolicyInventory;
  criticalIllness: FamilySectionReport;
  accident: FamilySectionReport;
  wealth: FamilyWealthReport;
  appendix: { policies: Array<{ policyId: number; productName: string; ocrText: string }> };
};

export function buildFamilyReport(policies: Policy[]): FamilyReport;
export function buildFamilyReportSummary(policies: Policy[]): FamilyReportSummary;
export function buildPolicyInventory(policies: Policy[]): FamilyPolicyInventory;
```

- [ ] **Step 2: Run typecheck and verify it still passes before integration**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/family-report-engine.d.mts
git commit -m "feat: type family report engine"
```

## Task 6: Family Report React Components

**Files:**
- Create: `src/FamilyReport.tsx`

- [ ] **Step 1: Create the report component file**

Create `src/FamilyReport.tsx`:

```tsx
import { useRef } from 'react';
import { ChevronLeft, Download } from 'lucide-react';
import type {
  FamilyReport,
  FamilyMemberProtectionReport,
  FamilyPolicyInventoryRow,
  FamilyWealthPolicyReport,
  FamilyWealthAggregateRow,
} from './family-report-engine.mjs';

function formatCurrency(value: number) {
  return Number(value || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function statusClassName(status: string) {
  if (status === 'covered') return 'text-emerald-700';
  if (status === 'partial' || status === 'formula') return 'text-amber-700';
  if (status === 'missing') return 'text-red-600';
  return 'text-slate-500';
}

function FamilyMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#DCE8F5] bg-white px-3 py-2">
      <p className="text-[11px] font-bold text-[#6C87A5]">{label}</p>
      <p className="mt-1 text-lg font-black text-[#0F172A]">{value}</p>
    </div>
  );
}

function InventoryCompactTable({ rows }: { rows: FamilyPolicyInventoryRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr>
            {['被保人', '保单/产品', '类型', '年交保费', '保障/保额', '现金价值', '数据状态'].map((header, index, all) => (
              <th key={header} className={`bg-[#0B72B9] px-3 py-2 font-black text-white ${index === 0 ? 'rounded-tl-xl' : ''} ${index === all.length - 1 ? 'rounded-tr-xl' : ''}`}>{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.policyId}>
              <td className="bg-white px-3 py-2 font-black ring-1 ring-[#E1EAF5]">{row.member}</td>
              <td className="bg-white px-3 py-2 ring-1 ring-[#E1EAF5]">{row.productName}</td>
              <td className="bg-white px-3 py-2 ring-1 ring-[#E1EAF5]">{row.typeLabel}</td>
              <td className="bg-white px-3 py-2 text-right ring-1 ring-[#E1EAF5]">{row.annualPremiumText}</td>
              <td className="bg-white px-3 py-2 ring-1 ring-[#E1EAF5]">{row.coverageText}</td>
              <td className="bg-white px-3 py-2 text-right ring-1 ring-[#E1EAF5]">{row.cashValueText}</td>
              <td className="bg-white px-3 py-2 font-bold text-slate-600 ring-1 ring-[#E1EAF5]">{row.dataStatus}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InsuredPolicyDetailTables({ report }: { report: FamilyReport }) {
  return (
    <section className="rounded-[20px] border border-[#D9E6F4] bg-white p-4 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]">
      <h2 className="text-lg font-black text-[#0F172A]">被保人保单明细</h2>
      <div className="mt-3 space-y-4">
        {report.policyInventory.insuredGroups.map((group) => (
          <article key={group.member} className="overflow-hidden rounded-xl border border-[#D9E6F4]">
            <div className="flex items-center justify-between bg-[#075985] px-3 py-2 text-white">
              <h3 className="font-black">{group.member}</h3>
              <span className="text-xs font-bold">有效保单 {group.policyCount} · 年交 {formatCurrency(group.annualPremium)}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[860px] border-separate border-spacing-0 text-left text-xs">
                <thead>
                  <tr>
                    {['保险公司/保单号', '险种名称', '保费(元)', '交费期', '保障期', '生效日期', '保额(元)', '身故受益人', '期交总保费'].map((header) => (
                      <th key={header} className="bg-slate-100 px-3 py-2 font-black text-slate-700">{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {group.policies.map((policy) => (
                    <tr key={policy.policyId}>
                      <td className="px-3 py-2 ring-1 ring-slate-100">{policy.company}{policy.policyNumber ? <><br />{policy.policyNumber}</> : null}</td>
                      <td className="px-3 py-2 font-bold ring-1 ring-slate-100">{policy.productName}</td>
                      <td className="px-3 py-2 text-right ring-1 ring-slate-100">{policy.annualPremiumText}</td>
                      <td className="px-3 py-2 ring-1 ring-slate-100">{policy.paymentPeriod || '-'}</td>
                      <td className="px-3 py-2 ring-1 ring-slate-100">{policy.coveragePeriod || '-'}</td>
                      <td className="px-3 py-2 ring-1 ring-slate-100">{policy.effectiveDate || '-'}</td>
                      <td className="px-3 py-2 ring-1 ring-slate-100">{policy.coverageText}</td>
                      <td className="px-3 py-2 ring-1 ring-slate-100">{policy.beneficiary || '-'}</td>
                      <td className="px-3 py-2 text-right ring-1 ring-slate-100">{policy.totalPremiumText}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function ProtectionMemberTable({ title, memberReport }: { title: string; memberReport: FamilyMemberProtectionReport }) {
  return (
    <article className="overflow-hidden rounded-xl border border-[#D9E6F4]">
      <div className="flex items-center justify-between bg-slate-900 px-3 py-2 text-white">
        <h3 className="font-black">{memberReport.member}｜{title}</h3>
        <span className="text-xs font-bold">{memberReport.attentionItems.length ? `${memberReport.attentionItems.length} 项待关注` : '已分析'}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[780px] border-separate border-spacing-0 text-left text-xs">
          <thead>
            <tr>
              {['责任颗粒度', '金额/比例', '次数/方式', '状态', '条件/说明', '来源保单'].map((header) => (
                <th key={header} className="bg-slate-100 px-3 py-2 font-black text-slate-700">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {memberReport.rows.map((row) => (
              <tr key={row.key}>
                <td className="px-3 py-2 font-black ring-1 ring-slate-100">{row.label}</td>
                <td className="px-3 py-2 font-black ring-1 ring-slate-100">{row.amountText}</td>
                <td className="px-3 py-2 ring-1 ring-slate-100">{row.countText}</td>
                <td className={`px-3 py-2 font-black ring-1 ring-slate-100 ${statusClassName(row.status)}`}>{row.status}</td>
                <td className="px-3 py-2 ring-1 ring-slate-100">{row.conditionText}</td>
                <td className="px-3 py-2 ring-1 ring-slate-100">{row.sourcePolicies.join('、') || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function ProtectionSection({ title, reports }: { title: string; reports: FamilyMemberProtectionReport[] }) {
  return (
    <section className="rounded-[20px] border border-[#D9E6F4] bg-white p-4 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]">
      <h2 className="text-lg font-black text-[#0F172A]">{title}</h2>
      <div className="mt-3 space-y-4">
        {reports.map((memberReport) => <ProtectionMemberTable key={memberReport.member} title={title} memberReport={memberReport} />)}
      </div>
    </section>
  );
}

function WealthPolicyCard({ policy }: { policy: FamilyWealthPolicyReport }) {
  return (
    <article className="rounded-xl border border-emerald-100 bg-white p-3">
      <h3 className="font-black text-slate-900">{policy.productName}</h3>
      <p className="mt-1 text-xs font-semibold text-slate-500">{policy.company} · 年交 {formatCurrency(policy.annualPremium)}</p>
      <div className="mt-3 overflow-x-auto">
        <table className="min-w-[420px] border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              {['年份/年龄', '领取金额', '累计领取', '现金价值'].map((header) => (
                <th key={header} className="bg-emerald-50 px-2 py-1 font-black text-emerald-800">{header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {policy.cashflowRows.slice(0, 8).map((row) => {
              const cashValue = policy.cashValueRows.find((value) => value.calendarYear === row.year)?.cashValue;
              return (
                <tr key={`${policy.policyId}-${row.year}`}>
                  <td className="px-2 py-1 ring-1 ring-emerald-50">{row.year}/{row.age || '-'}</td>
                  <td className="px-2 py-1 text-right font-black text-blue-700 ring-1 ring-emerald-50">{formatCurrency(row.amount)}</td>
                  <td className="px-2 py-1 text-right ring-1 ring-emerald-50">{formatCurrency(row.cumulative)}</td>
                  <td className="px-2 py-1 text-right ring-1 ring-emerald-50">{cashValue == null ? '-' : formatCurrency(cashValue)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!policy.cashflowRows.length && !policy.cashValueRows.length ? <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700">待上传现金价值表/现金流数据</p> : null}
    </article>
  );
}

function WealthAggregateTable({ rows }: { rows: FamilyWealthAggregateRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[760px] border-separate border-spacing-0 text-left text-xs">
        <thead>
          <tr>
            {['年份', '保费支出', '领取收入', '年度净现金流', '累计净现金流', '现金价值合计'].map((header) => (
              <th key={header} className="bg-slate-800 px-3 py-2 font-black text-white">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 24).map((row) => (
            <tr key={row.year}>
              <td className="px-3 py-2 font-black ring-1 ring-slate-100">{row.year}</td>
              <td className="px-3 py-2 text-right text-orange-700 ring-1 ring-slate-100">{formatCurrency(row.premiumOutflow)}</td>
              <td className="px-3 py-2 text-right text-emerald-700 ring-1 ring-slate-100">{formatCurrency(row.payoutInflow)}</td>
              <td className="px-3 py-2 text-right font-black ring-1 ring-slate-100">{formatCurrency(row.netCashflow)}</td>
              <td className="px-3 py-2 text-right ring-1 ring-slate-100">{formatCurrency(row.cumulativeNetCashflow)}</td>
              <td className="px-3 py-2 text-right ring-1 ring-slate-100">{formatCurrency(row.cashValueTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WealthSection({ report }: { report: FamilyReport }) {
  return (
    <section className="rounded-[20px] border border-emerald-100 bg-white p-4 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]">
      <h2 className="text-lg font-black text-[#0F172A]">财富分析</h2>
      <div className="mt-3 space-y-4">
        {report.wealth.memberReports.map((memberReport) => (
          <article key={memberReport.member} className="rounded-xl border border-emerald-100 bg-emerald-50/30 p-3">
            <h3 className="font-black text-emerald-900">{memberReport.member}</h3>
            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              {memberReport.policies.map((policy) => <WealthPolicyCard key={policy.policyId} policy={policy} />)}
            </div>
          </article>
        ))}
        <article className="rounded-xl border border-slate-200 bg-white p-3">
          <h3 className="mb-3 font-black text-slate-900">全家财富统计</h3>
          <WealthAggregateTable rows={report.wealth.aggregateRows} />
        </article>
      </div>
    </section>
  );
}

export function FamilyReportPage({
  report,
  onBack,
  onExport,
}: {
  report: FamilyReport;
  onBack: () => void;
  onExport: (target: HTMLElement | null, title: string) => void | Promise<void>;
}) {
  const reportRef = useRef<HTMLElement | null>(null);
  return (
    <div className="min-h-screen bg-[#F4F8FC] pb-10">
      <header className="no-print sticky top-0 z-20 flex items-center justify-between border-b border-slate-100 bg-white/90 px-4 py-4 backdrop-blur">
        <button onClick={onBack} className="-ml-2 rounded-full p-2 text-slate-700 active:bg-slate-100" type="button">
          <ChevronLeft size={24} />
        </button>
        <div className="text-center">
          <h1 className="text-lg font-black text-slate-950">家庭保障分析报告</h1>
          <p className="mt-0.5 text-[11px] font-medium text-slate-400">全家统计 · 保单清单 · 三大板块</p>
        </div>
        <button
          type="button"
          onClick={() => void onExport(reportRef.current, '家庭保障分析报告')}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-50 text-blue-600 active:bg-blue-100"
          aria-label="导出家庭报告"
          title="导出家庭报告"
        >
          <Download size={19} />
        </button>
      </header>

      <main ref={reportRef} className="print-policy-report space-y-4 p-4">
        <section className="rounded-[20px] border border-[#D9E6F4] bg-[#F8FBFF] p-4 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]">
          <h2 className="text-lg font-black text-[#0F172A]">全家总统计</h2>
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 lg:grid-cols-6">
            <FamilyMetric label="家庭成员" value={`${report.summary.memberCount} 人`} />
            <FamilyMetric label="有效保单" value={`${report.summary.policyCount} 张`} />
            <FamilyMetric label="年交保费" value={formatCurrency(report.summary.annualPremium)} />
            <FamilyMetric label="保障总额" value={report.summary.totalCoverage >= 10000 ? `${formatCurrency(report.summary.totalCoverage / 10000)}万` : formatCurrency(report.summary.totalCoverage)} />
            <FamilyMetric label="现金价值合计" value={formatCurrency(report.summary.cashValueTotal)} />
            <FamilyMetric label="待关注" value={`${report.summary.attentionItems.length} 项`} />
          </div>
        </section>

        <section className="rounded-[20px] border border-[#D9E6F4] bg-white p-4 shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]">
          <h2 className="text-lg font-black text-[#0F172A]">家庭保单清单</h2>
          <div className="mt-3">
            <InventoryCompactTable rows={report.policyInventory.rows} />
          </div>
        </section>

        <InsuredPolicyDetailTables report={report} />
        <ProtectionSection title="重疾分析" reports={report.criticalIllness.members} />
        <ProtectionSection title="意外分析" reports={report.accident.members} />
        <WealthSection report={report} />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck and verify the component compiles**

Run:

```bash
npm run typecheck
```

Expected: PASS after Task 5 declarations exist.

- [ ] **Step 3: Commit**

```bash
git add src/FamilyReport.tsx
git commit -m "feat: add family report components"
```

## Task 7: Wire Family Report Into Customer App

**Files:**
- Modify: `src/App.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing static UI test**

Append to `tests/customer-ui-style.test.mjs`:

```javascript
test('customer app exposes family report after policy inventory and before section analysis', () => {
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /buildFamilyReport/);
  assert.match(appSource, /FamilyReportPage/);
  assert.match(appSource, /setShowFamilyReport\(true\)/);
  assert.match(familySource, /全家总统计/);
  assert.match(familySource, /家庭保单清单/);
  assert.match(familySource, /被保人保单明细/);
  assert.match(familySource, /重疾分析/);
  assert.match(familySource, /意外分析/);
  assert.match(familySource, /财富分析/);
  assert.ok(familySource.indexOf('家庭保单清单') < familySource.indexOf('被保人保单明细'));
  assert.ok(familySource.indexOf('被保人保单明细') < familySource.indexOf('重疾分析'));
  assert.ok(familySource.indexOf('重疾分析') < familySource.indexOf('意外分析'));
  assert.ok(familySource.indexOf('意外分析') < familySource.indexOf('财富分析'));
});
```

- [ ] **Step 2: Run the static test and verify it fails**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family report"
```

Expected: FAIL because `App.tsx` does not import or render `FamilyReportPage`.

- [ ] **Step 3: Import engine and component**

In `src/App.tsx`, add these imports near the existing imports:

```typescript
import { FamilyReportPage } from './FamilyReport';
import { buildFamilyReport } from './family-report-engine.mjs';
```

- [ ] **Step 4: Add family report state and derived model**

Inside `CustomerApp`, near the existing state declarations for `cashflowMember`, add:

```typescript
const [showFamilyReport, setShowFamilyReport] = useState(false);
const familyReport = useMemo(() => buildFamilyReport(policies), [policies]);
```

- [ ] **Step 5: Add page switch before the `cashflowMember` switch**

In `CustomerApp`, before the existing `if (cashflowMember) { ... }` block, add:

```tsx
if (showFamilyReport) {
  return (
    <FamilyReportPage
      report={familyReport}
      onBack={() => setShowFamilyReport(false)}
      onExport={(target, title) => void downloadReportPdf(target, title, undefined, { rawTarget: true })}
    />
  );
}
```

- [ ] **Step 6: Add the report entry button near `FamilyCoverageOverview`**

Find the main policies page where `FamilyCoverageOverview` is rendered. Replace:

```tsx
<FamilyCoverageOverview overview={familyCoverageOverview} policies={policies} onViewCashflow={(member) => setCashflowMember(member)} />
```

with:

```tsx
<FamilyCoverageOverview overview={familyCoverageOverview} policies={policies} onViewCashflow={(member) => setCashflowMember(member)} />
{policies.length ? (
  <section className="px-4 pt-3">
    <button
      type="button"
      className="flex w-full items-center justify-between rounded-[20px] border border-[#D9E6F4] bg-white px-4 py-3 text-left shadow-[0_14px_28px_-24px_rgba(15,23,42,0.14)]"
      onClick={() => setShowFamilyReport(true)}
    >
      <span>
        <span className="block text-sm font-black text-[#0F172A]">家庭保障分析报告</span>
        <span className="mt-1 block text-xs font-semibold text-[#7890AA]">全家统计、保单清单、重疾、意外、财富分析</span>
      </span>
      <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-black text-blue-600">查看</span>
    </button>
  </section>
) : null}
```

- [ ] **Step 7: Run the static UI test and verify it passes after Task 8 export signature exists**

Run after completing Task 9:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family report"
```

Expected: PASS.

- [ ] **Step 8: Commit after Task 9 passes**

```bash
git add src/App.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: wire family report into customer app"
```

## Task 8: Export Raw Family Report Content

**Files:**
- Modify: `src/App.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing static export test**

Append to `tests/customer-ui-style.test.mjs`:

```javascript
test('family report export uses raw target mode', () => {
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(appSource, /type ReportExportOptions = \{ rawTarget\?: boolean \}/);
  assert.match(appSource, /rawTarget: true/);
  assert.match(appSource, /createPdfRenderTarget\(target,\s*fileName,\s*policy,\s*options\)/);
});
```

- [ ] **Step 2: Run the static export test and verify it fails**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="raw target"
```

Expected: FAIL because the export helpers do not support `rawTarget`.

- [ ] **Step 3: Add export options type**

In `src/App.tsx`, near the printable report helpers, add:

```typescript
type ReportExportOptions = { rawTarget?: boolean };
```

- [ ] **Step 4: Update `createPdfRenderTarget`**

Replace the existing `createPdfRenderTarget` function signature and body with:

```typescript
function createPdfRenderTarget(target: HTMLElement, title: string, policy?: Policy, options: ReportExportOptions = {}) {
  const wrapper = document.createElement('div');
  const width = 760;
  wrapper.setAttribute(
    'style',
    [
      'position:fixed',
      'left:-100000px',
      'top:0',
      `width:${width}px`,
      'min-height:1px',
      'background:#ffffff',
      'color:#0f172a',
      'z-index:-1',
      'overflow:visible',
      'pointer-events:none',
    ].join(';'),
  );

  const reportNode = options.rawTarget
    ? target.cloneNode(true) as HTMLElement
    : createPrintableReportNode(target, title, policy);
  reportNode.classList?.add?.('print-policy-report');
  wrapper.appendChild(reportNode);
  document.body.appendChild(wrapper);

  return {
    node: reportNode,
    width,
    cleanup() {
      wrapper.remove();
    },
  };
}
```

- [ ] **Step 5: Update `downloadReportPdf` signature and call**

Replace the existing `downloadReportPdf` signature:

```typescript
async function downloadReportPdf(target: HTMLElement | null, title: string, policy?: Policy) {
```

with:

```typescript
async function downloadReportPdf(target: HTMLElement | null, title: string, policy?: Policy, options: ReportExportOptions = {}) {
```

Then replace the render target call:

```typescript
renderTarget = createPdfRenderTarget(target, fileName, policy);
```

with:

```typescript
renderTarget = createPdfRenderTarget(target, fileName, policy, options);
```

- [ ] **Step 6: Run typecheck and static export test**

Run:

```bash
npm run typecheck
node --test tests/customer-ui-style.test.mjs --test-name-pattern="raw target"
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: support raw family report export"
```

## Task 9: Report Visual Polish And Source Tests

**Files:**
- Modify: `src/FamilyReport.tsx`
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add source tests for required labels and no nested card wording drift**

Append to `tests/customer-ui-style.test.mjs`:

```javascript
test('family report labels match the agreed report structure', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  [
    '全家总统计',
    '家庭保单清单',
    '被保人保单明细',
    '重疾分析',
    '意外分析',
    '财富分析',
    '全家财富统计',
    '保险公司/保单号',
    '险种名称',
    '保费(元)',
    '交费期',
    '保障期',
    '生效日期',
    '保额(元)',
    '身故受益人',
    '期交总保费',
  ].forEach((label) => assert.match(source, new RegExp(label)));
  assert.doesNotMatch(source, /营销落地页|立即购买|推荐产品/);
});
```

- [ ] **Step 2: Run the source tests**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family report labels"
```

Expected: PASS.

- [ ] **Step 3: Run typecheck and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git add src/FamilyReport.tsx tests/customer-ui-style.test.mjs
git commit -m "test: cover family report structure"
```

## Task 10: Final Verification

**Files:**
- Verify only.

- [ ] **Step 1: Run engine tests**

Run:

```bash
node --test tests/family-report-engine.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run UI source tests**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern="family report"
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm run test
```

Expected: PASS.

- [ ] **Step 4: Run static checks and typecheck**

Run:

```bash
npm run check
npm run typecheck
npm run build
```

Expected: all PASS.

- [ ] **Step 5: Manual browser verification**

Run the local app:

```bash
npm run dev
```

Open the printed Vite URL, then verify:

- The policies page shows a “家庭保障分析报告” entry when at least one policy exists.
- The report order is 全家总统计 → 家庭保单清单 → 被保人保单明细 → 重疾分析 → 意外分析 → 财富分析.
- Each critical illness member table has rows for 重疾首次、中症、轻症、特定疾病/癌症、身故/全残.
- Each accident member table has rows for 一般意外、意外伤残、意外医疗、交通、自驾/驾乘、航空.
- Wealth section shows per-member policies and the family aggregate table.
- Export button generates a PDF/long image containing the family report tables.

- [ ] **Step 6: Final commit if verification changed docs or tests**

If any verification-only fix was needed:

```bash
git add src/family-report-engine.mjs src/family-report-engine.d.mts src/FamilyReport.tsx src/App.tsx tests/family-report-engine.test.mjs tests/customer-ui-style.test.mjs
git commit -m "fix: polish family report verification"
```

If no files changed, skip this step.

## Self-Review

- Spec coverage: The plan covers top family statistics, policy inventory, insured-person detail tables, critical illness member tables, accident member tables, wealth per-policy cashflow/cash value, family wealth aggregation, export, and tests.
- Placeholder scan: No deferred sections, undefined tasks, or unspecified test commands remain.
- Type consistency: The engine, declaration file, and React component all use `FamilyReport`, `FamilyPolicyInventoryRow`, `FamilyMemberProtectionReport`, `FamilyWealthPolicyReport`, and `FamilyWealthAggregateRow` consistently.
