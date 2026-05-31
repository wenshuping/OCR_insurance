# Family Report Radar Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add amount-based radar charts to the family insurance report: one family balance radar in the hero and one member comparison radar before insured policy details.

**Architecture:** `src/family-report-engine.mjs` owns all radar amounts, relative scores, member selection, and notes. `src/FamilyReport.tsx` renders the engine-provided model with native SVG, following the existing cash value chart style and avoiding new chart dependencies. Tests first lock the engine model and UI placement before implementation.

**Tech Stack:** React 19, TypeScript, native SVG, Node test runner, existing Tailwind utility classes, no new runtime dependency.

---

## File Structure

- Modify `src/family-report-engine.mjs`
  - Add radar dimensions, amount aggregation helpers, relative score normalization, member selection, and `buildFamilyRadarReport`.
  - Add `radar: buildFamilyRadarReport(policies)` to `buildFamilyReport`.
- Modify `src/FamilyReport.tsx`
  - Extend the imported `FamilyReport` shape implicitly through usage.
  - Add `RadarChart`, `FamilyRadarSection`, `MemberRadarSection`, and small formatting helpers.
  - Render family radar inside `ReportHero`; render member radar between `InventorySection` and `InsuredPolicyDetailSection`.
- Modify `tests/family-report-engine.test.mjs`
  - Add amount aggregation, relative scoring, wealth calculation, formula exclusion, and member display limit tests.
- Modify `tests/customer-ui-style.test.mjs`
  - Add UI source tests for labels, order, SVG accessibility, and no chart dependency.
- Read-only reference `docs/superpowers/specs/2026-05-31-family-report-radar-design.md`
  - Use as the requirement source.

## Task 1: Add Failing Engine Tests

**Files:**
- Modify: `tests/family-report-engine.test.mjs`
- Test target: `src/family-report-engine.mjs`

- [ ] **Step 1: Add radar test helpers after `makePolicy`**

Add this code immediately after the existing `makePolicy` helper:

```js
function radarScore(series, key) {
  return series.scores.find((score) => score.key === key);
}

function radarMember(report, name) {
  return report.radar.members.find((member) => member.name === name);
}
```

- [ ] **Step 2: Add the first failing radar test**

Add this test near the existing `buildFamilyReport` tests:

```js
test('buildFamilyReport creates amount-based family radar using real amounts', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 101,
      insured: '妈妈',
      name: '重大疾病保险',
      amount: 500000,
      coverageIndicators: [
        { coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '重大疾病保险' },
      ],
    }),
    makePolicy({
      id: 102,
      insured: '爸爸',
      name: '综合意外保险',
      amount: 250000,
      coverageIndicators: [
        { coverageType: '意外保障', liability: '一般意外身故保险金', value: 250000, unit: '元', basis: '意外身故保额', productName: '综合意外保险' },
      ],
    }),
    makePolicy({
      id: 103,
      insured: '孩子',
      name: '百万医疗保险',
      amount: 0,
      coverageIndicators: [
        { coverageType: '医疗保障', liability: '住院医疗费用保险金', value: 100000, unit: '元', basis: '医疗费用限额', productName: '百万医疗保险' },
      ],
    }),
    makePolicy({
      id: 104,
      insured: '妈妈',
      name: '终身寿险',
      amount: 1000000,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '身故保险金', value: 1000000, unit: '元', basis: '身故保额', productName: '终身寿险' },
      ],
    }),
    makePolicy({
      id: 105,
      insured: '爸爸',
      name: '年金保险',
      amount: 0,
      cashValues: [{ policyYear: 1, cashValue: 80000 }, { policyYear: 2, cashValue: 150000 }],
      cashflowEntries: [
        { year: 2030, age: 42, amount: 30000, cumulative: 30000, liability: '生存金', policyId: 105, productName: '年金保险' },
        { year: 2031, age: 43, amount: 20000, cumulative: 50000, liability: '生存金', policyId: 105, productName: '年金保险' },
      ],
    }),
  ]);

  assert.deepEqual(report.radar.dimensions.map((dimension) => dimension.label), ['重疾', '意外', '医疗', '寿险', '财富']);
  assert.equal(radarScore(report.radar.family, 'critical').amount, 500000);
  assert.equal(radarScore(report.radar.family, 'accident').amount, 250000);
  assert.equal(radarScore(report.radar.family, 'medical').amount, 100000);
  assert.equal(radarScore(report.radar.family, 'life').amount, 1000000);
  assert.equal(radarScore(report.radar.family, 'wealth').amount, 200000);
  assert.equal(radarScore(report.radar.family, 'life').score, 100);
  assert.equal(radarScore(report.radar.family, 'critical').score, 50);
  assert.equal(radarScore(report.radar.family, 'accident').score, 25);
  assert.equal(radarScore(report.radar.family, 'medical').score, 10);
  assert.equal(radarScore(report.radar.family, 'wealth').score, 20);
  assert.match(radarScore(report.radar.family, 'wealth').note, /现金价值150,000/);
  assert.match(radarScore(report.radar.family, 'wealth').note, /未来领取50,000/);
});
```

- [ ] **Step 3: Add member normalization and hidden member test**

Add this test after the first radar test:

```js
test('buildFamilyReport normalizes member radar by dimension and limits displayed members', () => {
  const report = buildFamilyReport([
    makePolicy({ id: 201, insured: '妈妈', name: '妈妈重疾', amount: 1000000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '妈妈重疾' }] }),
    makePolicy({ id: 202, insured: '爸爸', name: '爸爸重疾', amount: 800000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '爸爸重疾' }] }),
    makePolicy({ id: 203, insured: '孩子', name: '孩子重疾', amount: 600000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '孩子重疾' }] }),
    makePolicy({ id: 204, insured: '老人', name: '老人重疾', amount: 400000, coverageIndicators: [{ coverageType: '重大疾病保障', liability: '重大疾病保险金', value: 100, unit: '%', basis: '基本保额', productName: '老人重疾' }] }),
    makePolicy({ id: 205, insured: '未成年二', name: '未成年二', amount: 0 }),
  ]);

  assert.equal(report.radar.members.length, 4);
  assert.deepEqual(report.radar.members.map((member) => member.name), ['妈妈', '爸爸', '孩子', '未成年二']);
  assert.deepEqual(report.radar.hiddenMembers.map((member) => member.name), ['老人']);
  assert.equal(radarScore(radarMember(report, '妈妈'), 'critical').score, 100);
  assert.equal(radarScore(radarMember(report, '爸爸'), 'critical').score, 80);
  assert.equal(radarScore(radarMember(report, '孩子'), 'critical').score, 60);
  assert.equal(radarScore(radarMember(report, '未成年二'), 'critical').score, 0);
});
```

- [ ] **Step 4: Add formula exclusion test**

Add this test after the member normalization test:

```js
test('buildFamilyReport keeps formula-only radar amounts out of numeric radar value', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 301,
      insured: '妈妈',
      name: '公式型寿险',
      amount: 0,
      coverageIndicators: [
        { coverageType: '人寿保障', liability: '身故保险金', unit: '公式', basis: '已交保费', formulaText: '取已交保费、现金价值、基本保额较大者', productName: '公式型寿险' },
      ],
    }),
  ]);

  const life = radarScore(report.radar.family, 'life');
  assert.equal(life.amount, 0);
  assert.equal(life.score, 0);
  assert.equal(life.amountText, '0元');
  assert.match(life.note, /公式型待确认/);
});
```

- [ ] **Step 5: Run the focused engine tests and confirm failure**

Run:

```bash
npm test -- tests/family-report-engine.test.mjs
```

Expected: FAIL with an error like `Cannot read properties of undefined (reading 'dimensions')` because `report.radar` is not implemented yet.

- [ ] **Step 6: Commit the failing tests**

```bash
git add tests/family-report-engine.test.mjs
git commit -m "test: cover family report radar model"
```

## Task 2: Implement Radar Data In The Engine

**Files:**
- Modify: `src/family-report-engine.mjs`
- Test: `tests/family-report-engine.test.mjs`

- [ ] **Step 1: Add radar constants and helpers before `buildFamilyReportSummary`**

Insert this block before `export function buildFamilyReportSummary`:

```js
const RADAR_DIMENSIONS = [
  { key: 'critical', label: '重疾' },
  { key: 'accident', label: '意外' },
  { key: 'medical', label: '医疗' },
  { key: 'life', label: '寿险' },
  { key: 'wealth', label: '财富' },
];

function formatRadarMoney(value) {
  return `${formatNumberText(value)}元`;
}

function radarPolicyText(policy) {
  return [
    policy?.company,
    policy?.name,
    policy?.coveragePeriod,
    policy?.report,
    policy?.ocrText,
    ...(Array.isArray(policy?.plans) ? policy.plans : []).map((plan) => {
      if (typeof plan === 'string') return plan;
      return [plan?.name, plan?.title, plan?.liability, plan?.type, plan?.matchedProductName].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.responsibilities) ? policy.responsibilities : []).map((item) => {
      if (typeof item === 'string') return item;
      return [
        item?.name,
        item?.title,
        item?.liability,
        item?.type,
        item?.coverageType,
        item?.scenario,
        item?.payout,
        item?.note,
      ].filter(Boolean).join(' ');
    }),
    ...(Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : []).map(indicatorText),
  ].filter(Boolean).join(' ').normalize('NFKC');
}

function indicatorIsFormulaOnly(indicator) {
  const unit = String(indicator?.unit || '').normalize('NFKC');
  return unit === '公式' && resolveIndicatorAmount(indicator, {}) <= 0;
}

function indicatorAmountForPolicy(indicator, policy) {
  if (indicatorIsFormulaOnly(indicator)) return 0;
  return resolveIndicatorAmount(indicator, policy);
}

function amountPartsTotal(parts) {
  return parts.reduce((total, part) => total + asNumber(part.amount), 0);
}

function uniquePolicyCount(parts) {
  return new Set(parts.map((part) => part.policyId).filter((id) => id !== undefined && id !== null)).size;
}

function radarAmountResult(amount, parts, fallbackNote = '') {
  const note = amount > 0
    ? parts.map((part) => `${part.label}${formatNumberText(part.amount)}`).join('，')
    : fallbackNote || '未识别到可落地金额';
  return {
    amount,
    policyCount: uniquePolicyCount(parts),
    note,
  };
}
```

- [ ] **Step 2: Add dimension amount functions after the helper block**

Insert this block immediately after the helpers from Step 1:

```js
function criticalRadarAmount(policies) {
  const { rows } = buildMemberCriticalRows(policies);
  const first = rows.find((row) => row.key === 'critical_first');
  const formulaOnly = rows.some((row) => row.status === 'formula');
  const amount = asNumber(first?.amount);
  return radarAmountResult(
    amount,
    amount > 0 ? [{ policyId: first.sourcePolicies[0]?.policyId, label: '重疾保额', amount }] : [],
    formulaOnly ? '公式型待确认' : '未识别到可落地金额',
  );
}

function accidentRadarAmount(policies) {
  const { rows } = buildMemberAccidentRows(policies);
  const keys = new Set(['general_accident', 'traffic', 'driving', 'public_transport', 'aviation', 'rail_ship', 'sudden_death']);
  const parts = rows
    .filter((row) => keys.has(row.key) && row.amount > 0)
    .map((row) => ({
      policyId: row.sourcePolicies[0]?.policyId,
      label: row.label,
      amount: row.amount,
    }));
  return radarAmountResult(amountPartsTotal(parts), parts);
}

function medicalRadarAmount(policies) {
  const parts = [];
  let hasFormula = false;
  for (const policy of policies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      const text = indicatorText(indicator);
      if (!/(医疗|住院|门诊|报销|百万医疗|手术|医疗费用)/u.test(text)) continue;
      if (indicatorIsFormulaOnly(indicator)) {
        hasFormula = true;
        continue;
      }
      const amount = indicatorAmountForPolicy(indicator, policy);
      if (amount > 0) parts.push({ policyId: policy?.id, label: String(indicator?.liability || '医疗额度'), amount });
    }
    if (!parts.some((part) => part.policyId === policy?.id) && policyTypeLabel(policy) === '医疗') {
      const amount = asNumber(policy?.amount);
      if (amount > 0) parts.push({ policyId: policy?.id, label: '医疗额度', amount });
    }
  }
  return radarAmountResult(amountPartsTotal(parts), parts, hasFormula ? '公式型待确认' : '未识别到可落地金额');
}

function lifeRadarAmount(policies) {
  const parts = [];
  let hasFormula = false;
  for (const policy of policies) {
    const indicators = Array.isArray(policy?.coverageIndicators) ? policy.coverageIndicators : [];
    for (const indicator of indicators) {
      const text = indicatorText(indicator);
      if (!/(身故|全残|终身寿|人寿保障|护理)/u.test(text)) continue;
      if (indicatorImpliesAccident(indicator)) continue;
      if (/(重疾|重大疾病|中症|轻症|恶性肿瘤|癌)/u.test(text)) continue;
      if (indicatorIsFormulaOnly(indicator)) {
        hasFormula = true;
        continue;
      }
      const amount = indicatorAmountForPolicy(indicator, policy);
      if (amount > 0) parts.push({ policyId: policy?.id, label: String(indicator?.liability || '寿险保额'), amount });
    }
    const text = radarPolicyText(policy);
    if (!parts.some((part) => part.policyId === policy?.id) && /(终身寿|人寿|寿险|身故|全残|护理)/u.test(text) && !/(重疾|意外)/u.test(text)) {
      const amount = asNumber(policy?.amount);
      if (amount > 0) parts.push({ policyId: policy?.id, label: '寿险保额', amount });
    }
  }
  return radarAmountResult(amountPartsTotal(parts), parts, hasFormula ? '公式型待确认' : '未识别到可落地金额');
}

function wealthRadarAmount(policies) {
  const cashValue = policies.reduce((total, policy) => total + (latestCashValue(policy)?.cashValue || 0), 0);
  const futurePayout = policies.reduce((total, policy) => total + futurePayoutTotal(policy), 0);
  const amount = cashValue + futurePayout;
  const parts = [
    cashValue > 0 ? { label: '现金价值', amount: cashValue } : null,
    futurePayout > 0 ? { label: '未来领取', amount: futurePayout } : null,
  ].filter(Boolean);
  return {
    amount,
    policyCount: policies.filter((policy) => (latestCashValue(policy)?.cashValue || 0) > 0 || futurePayoutTotal(policy) > 0).length,
    note: amount > 0 ? `现金价值${formatNumberText(cashValue)}，未来领取${formatNumberText(futurePayout)}` : '未识别到可落地金额',
  };
}

function radarAmountForDimension(policies, key) {
  if (key === 'critical') return criticalRadarAmount(policies);
  if (key === 'accident') return accidentRadarAmount(policies);
  if (key === 'medical') return medicalRadarAmount(policies);
  if (key === 'life') return lifeRadarAmount(policies);
  return wealthRadarAmount(policies);
}
```

- [ ] **Step 3: Add series builders and member selection**

Insert this block after the dimension functions:

```js
function buildRadarScores(policies) {
  return RADAR_DIMENSIONS.map((dimension) => {
    const result = radarAmountForDimension(policies, dimension.key);
    return {
      key: dimension.key,
      label: dimension.label,
      amount: result.amount,
      score: 0,
      amountText: formatRadarMoney(result.amount),
      policyCount: result.policyCount,
      note: result.note,
    };
  });
}

function normalizeFamilyScores(scores) {
  const maxAmount = Math.max(0, ...scores.map((score) => score.amount));
  return scores.map((score) => ({
    ...score,
    score: maxAmount > 0 ? Math.round((score.amount / maxAmount) * 100) : 0,
  }));
}

function normalizeMemberScores(memberSeries) {
  const maxByDimension = new Map();
  for (const dimension of RADAR_DIMENSIONS) {
    maxByDimension.set(dimension.key, Math.max(0, ...memberSeries.map((series) => radarScoreAmount(series, dimension.key))));
  }
  return memberSeries.map((series) => ({
    ...series,
    scores: series.scores.map((score) => {
      const maxAmount = maxByDimension.get(score.key) || 0;
      return {
        ...score,
        score: maxAmount > 0 ? Math.round((score.amount / maxAmount) * 100) : 0,
      };
    }),
  }));
}

function radarScoreAmount(series, key) {
  return asNumber(series.scores.find((score) => score.key === key)?.amount);
}

function buildRadarSeries(name, policies) {
  const scores = buildRadarScores(policies);
  const totalAmount = scores.reduce((total, score) => total + score.amount, 0);
  const missingLabels = scores.filter((score) => score.amount <= 0).map((score) => score.label);
  return {
    name,
    scores,
    totalAmount,
    notes: missingLabels.length ? [`缺口维度: ${missingLabels.join('、')}`] : [],
  };
}

function selectDisplayedRadarMembers(memberSeries) {
  if (memberSeries.length <= 4) return { members: memberSeries, hiddenMembers: [] };
  const byHigh = [...memberSeries].sort((a, b) => b.totalAmount - a.totalAmount);
  const lowest = [...memberSeries].sort((a, b) => a.totalAmount - b.totalAmount)[0];
  const selected = [];
  for (const series of [...byHigh.slice(0, 3), lowest, ...byHigh]) {
    if (selected.length >= 4) break;
    if (!selected.some((item) => item.name === series.name)) selected.push(series);
  }
  return {
    members: selected,
    hiddenMembers: memberSeries.filter((series) => !selected.some((item) => item.name === series.name)),
  };
}

export function buildFamilyRadarReport(policies = []) {
  const family = {
    ...buildRadarSeries('全家', policies),
    scores: normalizeFamilyScores(buildRadarScores(policies)),
  };

  const groupMap = new Map();
  for (const policy of policies) {
    const member = memberName(policy);
    if (!groupMap.has(member)) groupMap.set(member, []);
    groupMap.get(member).push(policy);
  }

  const allMembers = normalizeMemberScores(Array.from(groupMap, ([member, memberPolicies]) => buildRadarSeries(member, memberPolicies)));
  const { members, hiddenMembers } = selectDisplayedRadarMembers(allMembers);

  return {
    dimensions: RADAR_DIMENSIONS,
    family,
    members,
    hiddenMembers,
  };
}
```

- [ ] **Step 4: Wire radar into `buildFamilyReport`**

Change `buildFamilyReport` to include the new field:

```js
export function buildFamilyReport(policies = []) {
  return {
    summary: buildFamilyReportSummary(policies),
    policyInventory: buildPolicyInventory(policies),
    criticalIllness: buildCriticalIllnessSection(policies),
    accident: buildAccidentSection(policies),
    wealth: buildWealthSection(policies),
    radar: buildFamilyRadarReport(policies),
    appendix: {
      policies: policies.map((policy) => ({
        policyId: policy.id,
        productName: String(policy.name || ''),
        ocrText: String(policy.ocrText || ''),
      })),
    },
  };
}
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
npm test -- tests/family-report-engine.test.mjs
```

Expected: PASS for the three new radar tests and existing family report engine tests.

- [ ] **Step 6: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit engine implementation**

```bash
git add src/family-report-engine.mjs tests/family-report-engine.test.mjs
git commit -m "feat: add family report radar model"
```

## Task 3: Add Failing UI Source Tests

**Files:**
- Modify: `tests/customer-ui-style.test.mjs`
- Test target: `src/FamilyReport.tsx`, `package.json`

- [ ] **Step 1: Add UI radar test after `family report labels match the agreed report structure`**

Insert this test:

```js
test('family report renders amount-based radar sections in the agreed order without chart dependencies', () => {
  const familySource = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');
  const packageSource = fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8');

  assert.match(familySource, /function RadarChart/);
  assert.match(familySource, /aria-label=\{ariaLabel\}/);
  assert.match(familySource, /全家保障均衡雷达/);
  assert.match(familySource, /家庭成员保障对比雷达/);
  assert.match(familySource, /雷达图按本家庭内部金额比例绘制，非行业达标分。/);
  assert.match(familySource, /<FamilyRadarSection report=\{report\} \/>/);
  assert.match(familySource, /<MemberRadarSection report=\{report\} \/>/);
  assert.ok(familySource.indexOf('<FamilyRadarSection report={report} />') < familySource.indexOf('<InventorySection rows={report.policyInventory.rows} />'));
  assert.ok(familySource.indexOf('<MemberRadarSection report={report} />') < familySource.indexOf('<InsuredPolicyDetailSection rows={report.policyInventory.rows} />'));
  assert.doesNotMatch(packageSource, /recharts|victory|d3|chart\.js|echarts/);
});
```

- [ ] **Step 2: Run focused UI source tests and confirm failure**

Run:

```bash
npm test -- tests/customer-ui-style.test.mjs
```

Expected: FAIL because `RadarChart`, `FamilyRadarSection`, and `MemberRadarSection` do not exist yet.

- [ ] **Step 3: Commit failing UI test**

```bash
git add tests/customer-ui-style.test.mjs
git commit -m "test: cover family report radar UI"
```

## Task 4: Render Radar Charts In The Family Report

**Files:**
- Modify: `src/FamilyReport.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add radar helper types and colors after `TableWrap`**

Insert this code after the `TableWrap` function:

```tsx
type RadarSeries = FamilyReport['radar']['family'];

const radarColors = ['#0EA5E9', '#22C55E', '#F97316', '#8B5CF6'];

function scoreByKey(series: RadarSeries, key: string) {
  return series.scores.find((score) => score.key === key);
}

function radarShortAmount(score: RadarSeries['scores'][number]) {
  return score.amountText || formatMoneyWithUnit(score.amount);
}
```

- [ ] **Step 2: Add reusable `RadarChart` before `InventorySection`**

Insert this component before `function InventorySection`:

```tsx
function RadarChart({
  dimensions,
  series,
  ariaLabel,
}: {
  dimensions: FamilyReport['radar']['dimensions'];
  series: RadarSeries[];
  ariaLabel: string;
}) {
  const width = 320;
  const height = 250;
  const centerX = width / 2;
  const centerY = 118;
  const radius = 82;
  const rings = [0.25, 0.5, 0.75, 1];
  const axisPoints = dimensions.map((dimension, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / dimensions.length;
    return {
      ...dimension,
      angle,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      labelX: centerX + Math.cos(angle) * (radius + 24),
      labelY: centerY + Math.sin(angle) * (radius + 24),
    };
  });
  const hasShape = series.some((item) => item.scores.some((score) => score.score > 0));

  if (!hasShape) return <EmptyState text="暂无可绘制雷达图的金额数据" />;

  const polygonForSeries = (item: RadarSeries) => axisPoints.map((point) => {
    const score = Math.max(0, Math.min(100, scoreByKey(item, point.key)?.score || 0));
    const pointRadius = radius * score / 100;
    return `${(centerX + Math.cos(point.angle) * pointRadius).toFixed(1)},${(centerY + Math.sin(point.angle) * pointRadius).toFixed(1)}`;
  }).join(' ');

  return (
    <svg className="h-auto w-full" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
      <rect x="0" y="0" width={width} height={height} rx="16" fill="#FFFFFF" />
      {rings.map((ring) => (
        <polygon
          key={ring}
          points={axisPoints.map((point) => `${(centerX + Math.cos(point.angle) * radius * ring).toFixed(1)},${(centerY + Math.sin(point.angle) * radius * ring).toFixed(1)}`).join(' ')}
          fill="none"
          stroke="#E2E8F0"
          strokeWidth="1"
        />
      ))}
      {axisPoints.map((point) => (
        <g key={point.key}>
          <line x1={centerX} y1={centerY} x2={point.x} y2={point.y} stroke="#E2E8F0" strokeWidth="1" />
          <text x={point.labelX} y={point.labelY + 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">
            {point.label}
          </text>
        </g>
      ))}
      {series.map((item, index) => {
        const color = radarColors[index % radarColors.length];
        return (
          <g key={item.name}>
            <polygon points={polygonForSeries(item)} fill={color} opacity={series.length === 1 ? 0.18 : 0.1} stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
          </g>
        );
      })}
      <g transform="translate(16 218)">
        {series.map((item, index) => {
          const color = radarColors[index % radarColors.length];
          const x = index * 76;
          return (
            <g key={item.name} transform={`translate(${x} 0)`}>
              <rect x="0" y="0" width="10" height="10" rx="2" fill={color} />
              <text x="14" y="9" fontSize="10" fontWeight="700" fill="#475569">{item.name}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
```

- [ ] **Step 3: Add family and member radar sections before `InventorySection`**

Insert these components immediately after `RadarChart`:

```tsx
function FamilyRadarSection({ report }: { report: FamilyReport }) {
  const family = report.radar.family;
  const wealth = scoreByKey(family, 'wealth');

  return (
    <div className="mt-5 rounded-2xl bg-white/15 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-black text-white">全家保障均衡雷达</h3>
        <span className="text-[11px] font-bold text-white/75">雷达图按本家庭内部金额比例绘制，非行业达标分。</span>
      </div>
      <div className="grid gap-3 lg:grid-cols-[minmax(0,360px)_1fr]">
        <RadarChart dimensions={report.radar.dimensions} series={[family]} ariaLabel="全家保障均衡雷达" />
        <div className="grid gap-2 sm:grid-cols-2">
          {family.scores.map((score) => (
            <div key={score.key} className="rounded-xl bg-white/15 px-3 py-2">
              <p className="text-[11px] font-bold text-white/70">{score.label}</p>
              <p className="mt-0.5 text-sm font-black text-white">{radarShortAmount(score)}</p>
              <p className="mt-1 text-[11px] font-semibold leading-4 text-white/75">{score.note}</p>
            </div>
          ))}
          {wealth ? (
            <div className="rounded-xl bg-white/15 px-3 py-2 sm:col-span-2">
              <p className="text-[11px] font-bold text-white/70">财富拆分</p>
              <p className="mt-1 text-[11px] font-semibold leading-4 text-white/80">{wealth.note}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function MemberRadarSection({ report }: { report: FamilyReport }) {
  const members = report.radar.members;
  if (!members.length) return null;

  return (
    <Section title="家庭成员保障对比雷达">
      <div className="rounded-xl bg-[#F8FBFF] p-3 ring-1 ring-[#E1EAF5]">
        <p className="mb-3 text-xs font-bold text-[#7890AA]">雷达图按本家庭内部金额比例绘制，非行业达标分。</p>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,420px)_1fr]">
          <RadarChart dimensions={report.radar.dimensions} series={members} ariaLabel="家庭成员保障对比雷达" />
          <div className="space-y-2">
            {members.map((member) => (
              <div key={member.name} className="rounded-xl bg-white px-3 py-2 ring-1 ring-[#E1EAF5]">
                <p className="text-xs font-black text-[#0F172A]">{member.name} · 合计 {formatMoneyWithUnit(member.totalAmount)}</p>
                <p className="mt-1 text-[11px] font-semibold leading-4 text-[#7890AA]">
                  {member.notes.length ? member.notes.join('；') : '五维均有可落地金额'}
                </p>
              </div>
            ))}
            {report.radar.hiddenMembers.length ? (
              <div className="rounded-xl bg-amber-50 px-3 py-2 text-[11px] font-semibold leading-4 text-amber-700 ring-1 ring-amber-100">
                未展示成员: {report.radar.hiddenMembers.map((member) => `${member.name}(${formatMoneyWithUnit(member.totalAmount)})`).join('、')}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </Section>
  );
}
```

- [ ] **Step 4: Render family radar inside the hero**

In `ReportHero`, after the metric grid block, add:

```tsx
      <FamilyRadarSection report={report} />
```

The end of `ReportHero` should include this order:

```tsx
      <div className="mt-5">
        <p className="text-xs font-black text-white/70">全家总统计</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {metrics.map((metric) => (
            <div key={metric.label} className="min-w-0 rounded-2xl bg-white/15 px-3 py-3">
              <p className="text-xs font-bold text-white/70">{metric.label}</p>
              <p className="mt-1 break-words text-base font-black leading-tight text-white">{metric.value}</p>
            </div>
          ))}
        </div>
      </div>
      <FamilyRadarSection report={report} />
```

- [ ] **Step 5: Render member radar before insured policy details**

Change the `main` content order to:

```tsx
      <main ref={reportRef} className="print-policy-report space-y-4 p-4">
        <ReportHero report={report} attentionItems={attentionItems} />
        <AttentionSection attentionItems={attentionItems} />
        <InventorySection rows={report.policyInventory.rows} />
        <MemberRadarSection report={report} />
        <InsuredPolicyDetailSection rows={report.policyInventory.rows} />
        <ProtectionSection title="重疾分析" members={report.criticalIllness.members} />
        <ProtectionSection title="意外分析" members={report.accident.members} />
        <WealthSection report={report} />
      </main>
```

- [ ] **Step 6: Run UI source tests**

Run:

```bash
npm test -- tests/customer-ui-style.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit UI implementation**

```bash
git add src/FamilyReport.tsx tests/customer-ui-style.test.mjs
git commit -m "feat: render family report radar charts"
```

## Task 5: Full Verification And Integration

**Files:**
- Verify: `src/family-report-engine.mjs`
- Verify: `src/FamilyReport.tsx`
- Verify: `tests/family-report-engine.test.mjs`
- Verify: `tests/customer-ui-style.test.mjs`
- Verify: `package.json`

- [ ] **Step 1: Run full tests**

Run:

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run production build**

Run:

```bash
npm run build
```

Expected: Vite build completes successfully and no new chart dependency appears in the output.

- [ ] **Step 4: Confirm package dependency boundary**

Run:

```bash
node -e "const p=require('./package.json'); const deps={...p.dependencies,...p.devDependencies}; const banned=['recharts','victory','d3','chart.js','echarts']; const found=banned.filter((name)=>deps[name]); if(found.length){throw new Error(found.join(','));} console.log('no chart deps')"
```

Expected output:

```txt
no chart deps
```

- [ ] **Step 5: Inspect final diff**

Run:

```bash
git diff --stat HEAD~3..HEAD
git status --short
```

Expected:

- Commits include only radar tests, radar engine implementation, and radar UI implementation.
- `git status --short` may still show pre-existing unrelated user changes; do not revert them.

- [ ] **Step 6: Report verification result**

Record the exact result of:

```bash
npm test
npm run typecheck
npm run build
```

Expected: all three commands pass.

## Self-Review Notes

- Spec coverage: The plan covers engine data model, five amount dimensions, family normalization, member normalization, member limit and hidden members, SVG UI, section order, no chart dependency, and verification.
- Placeholder scan: No task uses TBD/TODO/fill-in placeholders. Each code-changing step includes concrete code or an exact replacement target.
- Type consistency: The plan consistently uses `report.radar`, `dimensions`, `family`, `members`, `hiddenMembers`, `scores`, `amount`, `score`, `amountText`, `policyCount`, and `note`.
