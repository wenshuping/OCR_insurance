# Responsibility Card Standard Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one backend responsibility-card standardization layer that writes clear policy responsibility output and verifies existing indicators before any indicator is treated as calculable.

**Architecture:** Add a focused backend standardizer that turns policy responsibilities, existing coverage indicators, official knowledge records, and optional responsibility records into `responsibilityCards`. Integrate it into responsibility query responses and policy derived results so saved policies, detail views, and family/report flows receive the same card structure while old fields remain compatible. Indicator verification stays strict: every card generation re-checks `sourceUrl`, `sourceExcerpt`, semantic fields, calculation metadata, and cashflow treatment.

**Tech Stack:** Node/Express ESM backend, existing SQLite state store payload rows, TypeScript API contracts, React/Vite frontend, Node test runner.

---

## Files

- Create: `server/responsibility-card-standardizer.mjs`
  - Standardizes readable responsibility cards.
  - Re-checks existing `coverageIndicators` using `src/indicator-calculation.mjs`.
  - Assigns `cashflowTreatment` independently from `calculationEligible`.
- Create: `tests/responsibility-card-standardizer.test.mjs`
  - Unit coverage for strict indicator verification and card grouping.
- Modify: `server/policy-derived-results.service.mjs`
  - Add `responsibilityCards` to derived result rows.
  - Merge persisted cards into policy responses.
- Modify: `server/sqlite-state-store.mjs`
  - Preserve `responsibilityCards` inside normalized derived result payloads.
- Modify: `server/app.mjs`
  - Import and wire `buildResponsibilityCardsForPolicy` into route context.
  - Add cards to recognized local draft output where policy data is available.
- Modify: `server/routes/responsibilities.routes.mjs`
  - Add `analysis.responsibilityCards` to `/query` and `/local-draft`.
- Modify: `server/routes/policies.routes.mjs`
  - Add `responsibilityCards` to `/policies/analyze` drafts before save.
  - Keep save/update returning cards through derived results.
- Modify: `src/api/contracts/responsibility.ts`
  - Add `ResponsibilityCard`, `ResponsibilityCardCategory`, `CalculationStatus`, and `CashflowTreatment`.
- Modify: `src/api/contracts/policy.ts`
  - Add optional `responsibilityCards` to `Policy` and `PolicyAnalysisResult`.
- Modify: `src/shared/policy-report-ui.tsx`
  - Include responsibility card sources when building source links.
- Modify: `server/family-report-quality.service.mjs`
  - Include responsibility-card summaries in report quality evidence.
- Modify tests:
  - `tests/policy-derived-results.test.mjs`
  - `tests/sqlite-state-store.test.mjs`
  - `tests/policy-ocr-flow.test.mjs`
  - `tests/customer-ui-style.test.mjs`

## Scope Check

This is one subsystem: standard responsibility output and indicator verification. It touches API responses and derived result persistence because those are the existing paths for policy responsibility data. It does not change OCR extraction, official-source crawling, Feishu sync, production data, cash value tables, or the cashflow engine calculation rules.

## Task 1: Responsibility Card Standardizer Unit Tests

**Files:**
- Create: `tests/responsibility-card-standardizer.test.mjs`
- Create later in Task 2: `server/responsibility-card-standardizer.mjs`

- [ ] **Step 1: Write failing tests for existing-indicator verification**

Create `tests/responsibility-card-standardizer.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildResponsibilityCardsForPolicy,
  standardizeResponsibilityIndicator,
} from '../server/responsibility-card-standardizer.mjs';

const basePolicy = {
  company: '新华保险',
  name: '尊享人生年金保险（分红型）',
  amount: 100000,
  firstPremium: 12000,
  paymentPeriod: '10年交',
  coveragePeriod: '终身',
};

test('standardizeResponsibilityIndicator keeps first basic responsibility premium distinct and scheduled cashflow', () => {
  const indicator = {
    id: 'ind_annuity_1',
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '关爱年金',
    value: 1,
    valueText: '1',
    unit: '%',
    basis: '首次交纳的基本责任的保险费',
    formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
    condition: '犹豫期结束次日、每年保单生效对应日生存',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
  };

  const result = standardizeResponsibilityIndicator(indicator, { policy: basePolicy });

  assert.equal(result.liability, '关爱年金');
  assert.equal(result.basisKey, 'first_basic_responsibility_premium');
  assert.equal(result.calculationKey, 'percent_of_first_premium');
  assert.equal(result.calculationEligible, true);
  assert.equal(result.cashflowTreatment, 'scheduled_cashflow');
  assert.equal(result.calculationReason, '');
});

test('standardizeResponsibilityIndicator blocks indicators without official source excerpt', () => {
  const result = standardizeResponsibilityIndicator({
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '满期保险金',
    basis: '基本保险金额',
    formulaText: '满期保险金 = 基本保险金额',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '',
  }, { policy: basePolicy });

  assert.equal(result.calculationEligible, false);
  assert.equal(result.cashflowTreatment, 'not_cashflow');
  assert.match(result.calculationReason, /缺少官方来源片段/u);
});

test('standardizeResponsibilityIndicator classifies claim-trigger benefits as claim_contingent even when amount is calculable', () => {
  const result = standardizeResponsibilityIndicator({
    company: '新华保险',
    productName: '测试重大疾病保险',
    coverageType: '疾病保障',
    liability: '重大疾病保险金',
    value: 100,
    unit: '%',
    basis: '基本保险金额',
    formulaText: '重大疾病保险金 = 基本保险金额 × 100%',
    condition: '被保险人确诊合同约定重大疾病',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/ci.pdf',
    sourceExcerpt: '被保险人确诊本合同所指重大疾病，本公司按基本保险金额给付重大疾病保险金。',
  }, { policy: { ...basePolicy, name: '测试重大疾病保险' } });

  assert.equal(result.calculationEligible, true);
  assert.equal(result.cashflowTreatment, 'claim_contingent');
  assert.equal(result.calculationKey, 'percent_of_basic_amount');
});

test('standardizeResponsibilityIndicator blocks table and expense dependent indicators from direct calculation', () => {
  const medical = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试医疗保险',
    coverageType: '医疗保障',
    liability: '住院医疗保险金',
    basis: '实际医疗费用',
    formulaText: '住院医疗保险金 = (实际合理医疗费用 - 免赔额) × 给付比例',
    sourceUrl: 'https://example.com/medical.pdf',
    sourceExcerpt: '本公司按实际合理医疗费用扣除免赔额后乘以约定给付比例给付住院医疗保险金。',
  }, { policy: basePolicy });

  assert.equal(medical.calculationEligible, false);
  assert.equal(medical.cashflowTreatment, 'claim_contingent');
  assert.equal(medical.calculationKey, 'medical_formula');

  const cashValue = standardizeResponsibilityIndicator({
    company: '测试保险',
    productName: '测试终身寿险',
    coverageType: '人寿保障',
    liability: '身故保险金',
    basis: '现金价值',
    formulaText: '身故保险金 = 现金价值、已交保险费、基本保险金额三者较大者',
    sourceUrl: 'https://example.com/life.pdf',
    sourceExcerpt: '身故保险金为现金价值、已交保险费、基本保险金额三者较大者。',
  }, { policy: basePolicy });

  assert.equal(cashValue.calculationEligible, false);
  assert.equal(cashValue.cashflowTreatment, 'claim_contingent');
  assert.equal(cashValue.calculationKey, 'manual_formula');
});

test('buildResponsibilityCardsForPolicy writes readable cards and re-checks existing indicators', () => {
  const cards = buildResponsibilityCardsForPolicy({
    policy: basePolicy,
    responsibilities: [{
      coverageType: '保险责任',
      scenario: '关爱年金 如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
      payout: '按首次交纳的基本责任的保险费的1%给付',
      note: '尊享人生年金保险（分红型）',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceTitle: '尊享人生年金保险（分红型）条款',
    }],
    coverageIndicators: [{
      id: 'ind_annuity_1',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 1,
      unit: '%',
      basis: '首次交纳的基本责任的保险费',
      formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
      condition: '犹豫期结束次日、每年保单生效对应日生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '关爱年金如被保险人于犹豫期结束的次日、每年保单生效对应日生存，本公司按首次交纳的基本责任的保险费的1%给付关爱年金。',
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, '关爱年金');
  assert.equal(cards[0].category, '现金流');
  assert.equal(cards[0].cashflowTreatment, 'scheduled_cashflow');
  assert.equal(cards[0].indicators.length, 1);
  assert.equal(cards[0].indicators[0].basisKey, 'first_basic_responsibility_premium');
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

Run:

```bash
node --test tests/responsibility-card-standardizer.test.mjs
```

Expected: FAIL with `Cannot find module '../server/responsibility-card-standardizer.mjs'`.

## Task 2: Implement the Responsibility Card Standardizer

**Files:**
- Create: `server/responsibility-card-standardizer.mjs`
- Test: `tests/responsibility-card-standardizer.test.mjs`

- [ ] **Step 1: Add the standardizer module**

Create `server/responsibility-card-standardizer.mjs` with these exported functions:

```js
import { normalizeIndicatorCalculation } from '../src/indicator-calculation.mjs';

function text(value) {
  return String(value || '').trim();
}

function compact(value) {
  return text(value).normalize('NFKC').replace(/\s+/gu, '');
}

function firstNonEmpty(...values) {
  return values.map(text).find(Boolean) || '';
}

function hasOfficialEvidence(indicator = {}) {
  return Boolean(text(indicator.sourceUrl || indicator.url) && text(indicator.sourceExcerpt || indicator.excerpt));
}

function liabilityName(indicator = {}) {
  return firstNonEmpty(indicator.liability, indicator.coverageType, indicator.title, indicator.name);
}

function isWeakLiabilityName(value = '') {
  return /^(?:该项保险金|相应保险金|保险责任|责任|给付责任|保障责任)$/u.test(text(value));
}

function categoryFromText(value = '') {
  const target = compact(value);
  if (/豁免/u.test(target)) return '豁免';
  if (/医疗|住院|门诊|药品|报销|补偿|津贴/u.test(target)) return '医疗保障';
  if (/重疾|重大疾病|中症|轻症|疾病|癌|恶性肿瘤|护理/u.test(target)) return '疾病保障';
  if (/意外|伤残|残疾|交通|航空|驾乘/u.test(target)) return '意外保障';
  if (/年金|养老金|生存金|生存保险金|满期|祝寿|教育金|关爱年金/u.test(target)) return '现金流';
  if (/等待期|赔付方式|疾病种数|规则参数/u.test(target)) return '规则参数';
  if (/身故|全残|寿险/u.test(target)) return '人寿保障';
  return '其他';
}

function cashflowTreatmentFor(indicator = {}, meta = {}) {
  const target = compact([
    indicator.coverageType,
    indicator.liability,
    indicator.condition,
    indicator.formulaText,
    indicator.basis,
    indicator.sourceExcerpt,
  ].filter(Boolean).join(' '));
  if (/豁免/u.test(target)) return 'waiver_only';
  if (/等待期|赔付方式|疾病种数|规则参数/u.test(target)) return 'not_cashflow';
  if (/身故|全残|重疾|重大疾病|中症|轻症|疾病|恶性肿瘤|癌|意外|医疗|住院|门诊|药品|报销|伤残|残疾/u.test(target)) {
    return 'claim_contingent';
  }
  if (/年金|生存金|生存保险金|满期保险金|满期生存保险金|祝寿|教育金|关爱年金/u.test(target)) {
    if (meta.calculationEligible && !['cash_value', 'account_value', 'schedule_or_policy_table', 'medical_formula', 'daily_allowance', 'manual_formula', 'unknown'].includes(meta.calculationKey)) {
      return 'scheduled_cashflow';
    }
    return 'not_cashflow';
  }
  return meta.calculationEligible ? 'not_cashflow' : 'not_cashflow';
}

function calculationStatusFor(indicator = {}, normalized = {}) {
  if (normalized.cashflowTreatment === 'waiver_only') return 'waiver_only';
  if (normalized.cashflowTreatment === 'claim_contingent') return 'claim_contingent';
  if (normalized.cashflowTreatment === 'not_cashflow' && normalized.calculationEligible) return 'not_cashflow';
  if (normalized.calculationEligible) return 'calculable';
  if (/(现金价值|账户价值|表|医疗费用|免赔额|天数|比例)/u.test(normalized.calculationReason)) return 'needs_table';
  return 'needs_review';
}

function reasonWithEvidenceGate(indicator = {}, meta = {}) {
  const name = liabilityName(indicator);
  if (!hasOfficialEvidence(indicator)) return '缺少官方来源片段，不能进入计算';
  if (!name || isWeakLiabilityName(name)) return '责任名称不独立，不能进入计算';
  if (meta.calculationReason) return meta.calculationReason;
  return '';
}

export function standardizeResponsibilityIndicator(indicator = {}, { policy = {} } = {}) {
  const meta = normalizeIndicatorCalculation(indicator);
  const reason = reasonWithEvidenceGate(indicator, meta);
  const eligible = Boolean(meta.calculationEligible) && !reason;
  const normalized = {
    id: text(indicator.id),
    liability: liabilityName(indicator),
    triggerCondition: firstNonEmpty(indicator.triggerCondition, indicator.condition),
    basis: text(indicator.basis),
    formulaText: text(indicator.formulaText),
    basisKey: meta.basisKey,
    calculationKey: meta.calculationKey,
    calculationEligible: eligible,
    calculationReason: eligible ? '' : reason,
    value: indicator.value ?? null,
    unit: text(meta.unit || indicator.unit),
    sourceUrl: text(indicator.sourceUrl || indicator.url),
    sourceExcerpt: text(indicator.sourceExcerpt || indicator.excerpt),
  };
  normalized.cashflowTreatment = eligible
    ? cashflowTreatmentFor(indicator, meta)
    : cashflowTreatmentFor(indicator, { ...meta, calculationEligible: false });
  if (!eligible && !hasOfficialEvidence(indicator)) normalized.cashflowTreatment = 'not_cashflow';
  return normalized;
}

function cardIdFor(policy = {}, title = '', scope = '') {
  return `card_${compact(policy.company)}_${compact(policy.name)}_${compact(title)}_${compact(scope || 'basic')}`.slice(0, 160);
}

function plainSummaryFrom({ title, indicator, responsibility }) {
  const trigger = text(indicator?.triggerCondition || responsibility?.scenario);
  const payout = text(indicator?.formulaText || responsibility?.payout);
  return [title, trigger, payout].filter(Boolean).join('：').slice(0, 260);
}

function sourceFrom(indicator = {}, responsibility = {}, knowledge = {}) {
  return {
    sourceUrl: firstNonEmpty(indicator.sourceUrl, responsibility.sourceUrl, knowledge.url),
    sourceTitle: firstNonEmpty(responsibility.sourceTitle, knowledge.title, indicator.liability),
    sourceExcerpt: firstNonEmpty(indicator.sourceExcerpt, responsibility.scenario, knowledge.pageText),
  };
}

function normalizeResponsibility(row = {}) {
  return {
    title: firstNonEmpty(row.coverageType, row.title, row.name, '保险责任'),
    scenario: text(row.scenario || row.description || row.desc),
    payout: text(row.payout || row.limit || row.amount),
    note: text(row.note || row.remark),
    sourceUrl: text(row.sourceUrl),
    sourceTitle: text(row.sourceTitle),
  };
}

export function buildResponsibilityCardsForPolicy({
  policy = {},
  responsibilities = policy.responsibilities,
  coverageIndicators = policy.coverageIndicators,
  knowledgeRecords = [],
  optionalResponsibilityRecords = [],
} = {}) {
  const normalizedIndicators = (Array.isArray(coverageIndicators) ? coverageIndicators : [])
    .map((indicator) => standardizeResponsibilityIndicator(indicator, { policy }));
  const normalizedResponsibilities = (Array.isArray(responsibilities) ? responsibilities : []).map(normalizeResponsibility);
  const cardsByTitle = new Map();

  for (const indicator of normalizedIndicators) {
    const title = indicator.liability || '保险责任';
    const key = `${compact(title)}:${indicator.cashflowTreatment}`;
    const existing = cardsByTitle.get(key);
    const source = sourceFrom(indicator);
    const category = categoryFromText(`${title} ${indicator.triggerCondition} ${indicator.formulaText}`);
    const next = existing || {
      id: cardIdFor(policy, title, 'basic'),
      company: text(policy.company),
      productName: text(policy.name || indicator.productName),
      title,
      category,
      plainSummary: plainSummaryFrom({ title, indicator }),
      triggerCondition: indicator.triggerCondition,
      payoutSummary: indicator.formulaText || indicator.basis,
      ...source,
      confidence: indicator.calculationEligible ? 'high' : 'medium',
      calculationStatus: calculationStatusFor(indicator, indicator),
      calculationReason: indicator.calculationReason,
      cashflowTreatment: indicator.cashflowTreatment,
      indicators: [],
    };
    next.indicators.push(indicator);
    if (!next.sourceExcerpt && source.sourceExcerpt) next.sourceExcerpt = source.sourceExcerpt;
    cardsByTitle.set(key, next);
  }

  for (const responsibility of normalizedResponsibilities) {
    const title = responsibility.title || '保险责任';
    const key = `${compact(title)}:responsibility`;
    if (cardsByTitle.has(key) || [...cardsByTitle.values()].some((card) => compact(card.title) === compact(title))) continue;
    const category = categoryFromText(`${title} ${responsibility.scenario} ${responsibility.payout}`);
    const treatment = category === '豁免' ? 'waiver_only' : category === '现金流' ? 'not_cashflow' : category === '规则参数' ? 'not_cashflow' : 'claim_contingent';
    cardsByTitle.set(key, {
      id: cardIdFor(policy, title, 'responsibility'),
      company: text(policy.company),
      productName: text(policy.name),
      title,
      category,
      plainSummary: plainSummaryFrom({ title, responsibility }),
      triggerCondition: responsibility.scenario,
      payoutSummary: responsibility.payout,
      sourceUrl: responsibility.sourceUrl,
      sourceTitle: responsibility.sourceTitle,
      sourceExcerpt: responsibility.scenario,
      confidence: responsibility.sourceUrl ? 'medium' : 'low',
      calculationStatus: treatment === 'claim_contingent' ? 'claim_contingent' : 'needs_review',
      calculationReason: '未匹配到通过核对的结构化指标',
      cashflowTreatment: treatment,
      indicators: [],
    });
  }

  return [...cardsByTitle.values()].filter((card) => card.title);
}
```

- [ ] **Step 2: Run unit tests**

Run:

```bash
node --test tests/responsibility-card-standardizer.test.mjs
```

Expected: PASS.

- [ ] **Step 3: Commit the standardizer and tests**

```bash
git add server/responsibility-card-standardizer.mjs tests/responsibility-card-standardizer.test.mjs
git commit -m "feat: add responsibility card standardizer"
```

## Task 3: Add Responsibility Cards to Derived Results

**Files:**
- Modify: `server/policy-derived-results.service.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Modify: `tests/policy-derived-results.test.mjs`
- Modify: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Add failing derived-result tests**

In `tests/policy-derived-results.test.mjs`, extend the import:

```js
import {
  buildPolicyDerivedResult,
  deriveIndicatorProductKeys,
  derivePolicyProductKeys,
  mergePolicyDerivedResult,
  productKeyFromParts,
} from '../server/policy-derived-results.service.mjs';
```

Add:

```js
test('buildPolicyDerivedResult stores responsibility cards and verifies existing indicators', () => {
  const policy = {
    id: 10,
    company: '新华保险',
    name: '尊享人生年金保险（分红型）',
    amount: 100000,
    firstPremium: 12000,
  };
  const indicator = {
    id: 'ind_annuity_1',
    company: '新华保险',
    productName: '尊享人生年金保险（分红型）',
    coverageType: '现金流',
    liability: '关爱年金',
    value: 1,
    unit: '%',
    basis: '首次交纳的基本责任的保险费',
    formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
    condition: '生存',
    sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
    sourceExcerpt: '关爱年金如被保险人生存，本公司按首次交纳的基本责任的保险费的1%给付。',
  };

  const row = buildPolicyDerivedResult({
    policy,
    indicatorRecords: [indicator],
    knowledgeRecords: [],
    optionalResponsibilityRecords: [],
    productIndicatorVersions: [],
    now: '2026-06-22T00:00:00.000Z',
  });

  assert.equal(row.responsibilityCards.length, 1);
  assert.equal(row.responsibilityCards[0].title, '关爱年金');
  assert.equal(row.responsibilityCards[0].indicators[0].calculationEligible, true);
  assert.equal(row.responsibilityCards[0].indicators[0].basisKey, 'first_basic_responsibility_premium');
});

test('mergePolicyDerivedResult attaches responsibility cards from persisted derived row', () => {
  const merged = mergePolicyDerivedResult({ id: 10, company: '新华保险', name: '尊享人生年金保险（分红型）' }, {
    policyId: 10,
    status: 'ready',
    responsibilityCards: [{ id: 'card_1', title: '关爱年金', indicators: [] }],
    coverageIndicators: [],
    optionalResponsibilities: [],
    generatedAt: '2026-06-22T00:00:00.000Z',
  });

  assert.deepEqual(merged.responsibilityCards, [{ id: 'card_1', title: '关爱年金', indicators: [] }]);
  assert.equal(merged.derivedStatus, 'ready');
});
```

In `tests/sqlite-state-store.test.mjs`, extend the existing policy-derived result persistence row with:

```js
responsibilityCards: [{ id: 'card_1', title: '关爱年金', indicators: [{ id: 'ind_1' }] }],
```

Add an assertion after reload:

```js
assert.deepEqual(reloaded.policyDerivedResults[0].responsibilityCards, [{ id: 'card_1', title: '关爱年金', indicators: [{ id: 'ind_1' }] }]);
```

- [ ] **Step 2: Run tests and verify failures**

Run:

```bash
node --test tests/policy-derived-results.test.mjs tests/sqlite-state-store.test.mjs
```

Expected: FAIL because derived results do not include or normalize `responsibilityCards`.

- [ ] **Step 3: Modify `server/policy-derived-results.service.mjs`**

Add import:

```js
import { buildResponsibilityCardsForPolicy } from './responsibility-card-standardizer.mjs';
```

Inside `buildPolicyDerivedResult`, after `attached` is built, add:

```js
const responsibilityCards = buildResponsibilityCardsForPolicy({
  policy: attached,
  responsibilities: attached.responsibilities,
  coverageIndicators: attached.coverageIndicators,
  knowledgeRecords,
  optionalResponsibilityRecords,
});
```

Add to returned object:

```js
responsibilityCards,
```

Inside `mergePolicyDerivedResult`, add both branches:

```js
responsibilityCards: Array.isArray(derived.responsibilityCards) ? derived.responsibilityCards : [],
```

For the no-derived fallback branch, preserve policy cards if present:

```js
responsibilityCards: Array.isArray(policy.responsibilityCards) ? policy.responsibilityCards : [],
```

- [ ] **Step 4: Modify `server/sqlite-state-store.mjs` normalization**

In `normalizePolicyDerivedResult(row = {})`, add:

```js
responsibilityCards: normalizeArray(row.responsibilityCards),
```

No schema change is needed because `policy_derived_results.payload` stores the full JSON payload.

- [ ] **Step 5: Run tests**

```bash
node --test tests/policy-derived-results.test.mjs tests/sqlite-state-store.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit derived result integration**

```bash
git add server/policy-derived-results.service.mjs server/sqlite-state-store.mjs tests/policy-derived-results.test.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: persist responsibility cards in derived results"
```

## Task 4: Add Cards to Responsibility Query and Draft Analysis APIs

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/routes/responsibilities.routes.mjs`
- Modify: `server/routes/policies.routes.mjs`
- Modify: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add API tests for responsibility query and analyze**

In `tests/policy-ocr-flow.test.mjs`, update the existing `/api/policy-responsibilities/query` test to assert:

```js
assert.ok(Array.isArray(result.payload.analysis.responsibilityCards));
assert.ok(result.payload.analysis.responsibilityCards.length >= 1);
assert.equal(result.payload.analysis.responsibilityCards[0].indicators.every((item) => item.sourceUrl && item.sourceExcerpt), true);
```

Add a focused analyze/save-adjacent test:

```js
test('policy analyze returns responsibility cards that verify matching existing indicators', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '13800000000', createdAt: '2026-06-22T00:00:00.000Z', updatedAt: '2026-06-22T00:00:00.000Z' }],
    sessions: [{ token: 'user-token', userId: 1, createdAt: '2026-06-22T00:00:00.000Z' }],
    insuranceIndicatorRecords: [{
      id: 'ind_annuity_1',
      company: '新华保险',
      productName: '尊享人生年金保险（分红型）',
      coverageType: '现金流',
      liability: '关爱年金',
      value: 1,
      unit: '%',
      basis: '首次交纳的基本责任的保险费',
      formulaText: '关爱年金 = 首次交纳的基本责任的保险费 × 1%',
      condition: '生存',
      sourceUrl: 'https://static-cdn.newchinalife.com/ncl/pdf/zunxiang.pdf',
      sourceExcerpt: '关爱年金如被保险人生存，本公司按首次交纳的基本责任的保险费的1%给付。',
    }],
    knowledgeRecords: [],
    optionalResponsibilityRecords: [],
  };
  const app = createPolicyOcrApp({
    state,
    scanner: async () => ({
      ocrText: '新华保险 尊享人生年金保险（分红型）',
      data: {
        company: '新华保险',
        name: '尊享人生年金保险（分红型）',
        amount: 100000,
        firstPremium: 12000,
      },
    }),
    analyzer: async () => ({
      report: '责任分析',
      coverageTable: [{
        coverageType: '关爱年金',
        scenario: '被保险人生存',
        payout: '按首次交纳的基本责任的保险费的1%给付',
      }],
    }),
  });
  const server = await listen(app);
  try {
    const analyzed = await jsonFetch(server.baseUrl, '/api/policies/analyze', {
      method: 'POST',
      headers: { authorization: 'Bearer user-token' },
      body: JSON.stringify({ imageData: 'data:image/png;base64,AA==' }),
    });
    assert.equal(analyzed.response.status, 200);
    assert.ok(Array.isArray(analyzed.payload.analysis.responsibilityCards));
    assert.equal(analyzed.payload.analysis.responsibilityCards[0].indicators[0].basisKey, 'first_basic_responsibility_premium');
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the API tests and verify failures**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "policy analyze returns responsibility cards|policy responsibilities"
```

Expected: FAIL because API responses do not include `responsibilityCards`.

- [ ] **Step 3: Wire standardizer in `server/app.mjs`**

Add import:

```js
import { buildResponsibilityCardsForPolicy } from './responsibility-card-standardizer.mjs';
```

In the route context object passed to policy and responsibility routes, add:

```js
buildResponsibilityCardsForPolicy,
```

In `buildRecognizedPolicyAnalysisDraft`, after `localAnalysis` and `optionalResponsibilities` are built, add:

```js
const coverageIndicators = findPolicyCoverageIndicators(primaryOptionalPolicyDraft, state?.insuranceIndicatorRecords || []);
const responsibilityCards = buildResponsibilityCardsForPolicy({
  policy: primaryOptionalPolicyDraft,
  responsibilities: localAnalysis.coverageTable,
  coverageIndicators,
  knowledgeRecords: state?.knowledgeRecords || [],
  optionalResponsibilityRecords: state?.optionalResponsibilityRecords || [],
});
```

Return it with the analysis:

```js
responsibilityCards,
```

- [ ] **Step 4: Modify `server/routes/responsibilities.routes.mjs`**

Destructure from context:

```js
buildResponsibilityCardsForPolicy,
findPolicyCoverageIndicators,
```

After `const analysis = await assistantAnalyzer(...)` in `/query`, add:

```js
const policyDraft = { company: input.company, name: input.name };
const coverageIndicators = typeof findPolicyCoverageIndicators === 'function'
  ? findPolicyCoverageIndicators(policyDraft, state.insuranceIndicatorRecords)
  : [];
analysis.responsibilityCards = typeof buildResponsibilityCardsForPolicy === 'function'
  ? buildResponsibilityCardsForPolicy({
      policy: policyDraft,
      responsibilities: analysis.coverageTable,
      coverageIndicators,
      knowledgeRecords: state.knowledgeRecords,
      optionalResponsibilityRecords: state.optionalResponsibilityRecords,
    })
  : [];
```

In `/local-draft`, after `analysis` is built, ensure it also includes cards:

```js
if (analysis && typeof buildResponsibilityCardsForPolicy === 'function') {
  const policyDraft = { ...data, plans: scan.data.plans };
  const coverageIndicators = typeof findPolicyCoverageIndicators === 'function'
    ? findPolicyCoverageIndicators(policyDraft, state.insuranceIndicatorRecords)
    : [];
  analysis.responsibilityCards = buildResponsibilityCardsForPolicy({
    policy: policyDraft,
    responsibilities: analysis.coverageTable,
    coverageIndicators,
    knowledgeRecords: state.knowledgeRecords,
    optionalResponsibilityRecords: state.optionalResponsibilityRecords,
  });
}
```

- [ ] **Step 5: Modify `server/routes/policies.routes.mjs`**

Destructure from context:

```js
buildResponsibilityCardsForPolicy,
```

In `/policies/analyze`, after `analysisWithOptionalResponsibilities` is created, compute cards:

```js
const coverageIndicators = findPolicyCoverageIndicators(policyDraft, state.insuranceIndicatorRecords);
analysisWithOptionalResponsibilities.responsibilityCards = typeof buildResponsibilityCardsForPolicy === 'function'
  ? buildResponsibilityCardsForPolicy({
      policy: policyDraft,
      responsibilities: analysisWithOptionalResponsibilities.coverageTable,
      coverageIndicators,
      knowledgeRecords: state.knowledgeRecords,
      optionalResponsibilityRecords: state.optionalResponsibilityRecords,
    })
  : [];
```

- [ ] **Step 6: Run focused API tests**

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "policy analyze returns responsibility cards|policy responsibilities"
```

Expected: PASS.

- [ ] **Step 7: Commit API integration**

```bash
git add server/app.mjs server/routes/responsibilities.routes.mjs server/routes/policies.routes.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: return responsibility cards from policy APIs"
```

## Task 5: Add API Contract Types and Source Link Support

**Files:**
- Modify: `src/api/contracts/responsibility.ts`
- Modify: `src/api/contracts/policy.ts`
- Modify: `src/shared/policy-report-ui.tsx`
- Modify: `server/family-report-quality.service.mjs`
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add contract/style tests**

In `tests/customer-ui-style.test.mjs`, add assertions to the existing API contract source test:

```js
assert.match(apiSource, /responsibilityCards\\?: ResponsibilityCard\\[\\]/u);
assert.match(responsibilityContractSource, /export type ResponsibilityCard/u);
assert.match(responsibilityContractSource, /cashflowTreatment/u);
```

Add a source-link helper assertion:

```js
const reportUiSource = fs.readFileSync(path.join(projectRoot, 'src/shared/policy-report-ui.tsx'), 'utf8');
assert.match(reportUiSource, /policy\\.responsibilityCards/u);
assert.match(reportUiSource, /card\\.sourceUrl/u);
```

- [ ] **Step 2: Run the style tests and verify failure**

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "coverageIndicators|responsibilityCards|source"
```

Expected: FAIL because the contract and source helper do not mention `responsibilityCards`.

- [ ] **Step 3: Modify `src/api/contracts/responsibility.ts`**

Add:

```ts
export type CashflowTreatment = 'scheduled_cashflow' | 'claim_contingent' | 'waiver_only' | 'not_cashflow';

export type ResponsibilityCardCategory =
  | '现金流'
  | '人寿保障'
  | '疾病保障'
  | '医疗保障'
  | '意外保障'
  | '豁免'
  | '规则参数'
  | '其他';

export type CalculationStatus =
  | 'calculable'
  | 'needs_table'
  | 'claim_contingent'
  | 'waiver_only'
  | 'not_cashflow'
  | 'needs_review';

export type QuantifiedResponsibilityIndicator = CoverageIndicator & {
  triggerCondition?: string;
  calculationEligible: boolean;
  calculationReason: string;
  cashflowTreatment: CashflowTreatment;
  sourceUrl: string;
  sourceExcerpt: string;
};

export type ResponsibilityCard = {
  id: string;
  company: string;
  productName: string;
  title: string;
  category: ResponsibilityCardCategory;
  plainSummary: string;
  triggerCondition: string;
  payoutSummary: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceExcerpt: string;
  confidence: 'high' | 'medium' | 'low';
  calculationStatus: CalculationStatus;
  calculationReason: string;
  cashflowTreatment: CashflowTreatment;
  indicators: QuantifiedResponsibilityIndicator[];
};
```

- [ ] **Step 4: Modify `src/api/contracts/policy.ts`**

Change import:

```ts
import type { CoverageIndicator, OptionalResponsibility, Responsibility, ResponsibilityCard } from './responsibility';
```

Add to `Policy`:

```ts
responsibilityCards?: ResponsibilityCard[];
```

Add to `PolicyAnalysisResult`:

```ts
responsibilityCards?: ResponsibilityCard[];
```

- [ ] **Step 5: Modify `src/shared/policy-report-ui.tsx`**

Inside `getPolicyResponsibilitySourceLinks`, add before `coverageIndicators`:

```ts
(policy.responsibilityCards || []).forEach((card) => {
  pushLink({
    title: card.sourceTitle || card.title,
    url: card.sourceUrl,
    official: true,
    evidenceLevel: 'insurer_official',
  });
  (card.indicators || []).forEach((indicator) => {
    pushLink({
      title: indicator.liability || card.title,
      url: indicator.sourceUrl,
      official: true,
      evidenceLevel: 'insurer_official',
    });
  });
});
```

- [ ] **Step 6: Modify `server/family-report-quality.service.mjs`**

In the policy summary object, add:

```js
responsibilityCards: take(policy.responsibilityCards, 16).map((card) => ({
  title: trim(card?.title),
  category: trim(card?.category),
  plainSummary: trim(card?.plainSummary),
  cashflowTreatment: trim(card?.cashflowTreatment),
  calculationStatus: trim(card?.calculationStatus),
  calculationReason: trim(card?.calculationReason),
  sourceUrl: trim(card?.sourceUrl),
})),
```

In `officialEvidenceForPolicy`, include cards in the `indicators` evidence source by adding:

```js
...(Array.isArray(policy.responsibilityCards)
  ? policy.responsibilityCards.flatMap((card) => Array.isArray(card?.indicators) ? card.indicators : [])
  : []),
```

- [ ] **Step 7: Run typecheck and style tests**

```bash
npm run typecheck
node --test tests/customer-ui-style.test.mjs --test-name-pattern "coverageIndicators|responsibilityCards|source"
```

Expected: PASS.

- [ ] **Step 8: Commit contracts and helper support**

```bash
git add src/api/contracts/responsibility.ts src/api/contracts/policy.ts src/shared/policy-report-ui.tsx server/family-report-quality.service.mjs tests/customer-ui-style.test.mjs
git commit -m "feat: type and surface responsibility cards"
```

## Task 6: End-to-End Verification and Regression Pass

**Files:**
- Modify if failures require scoped fixes:
  - `server/responsibility-card-standardizer.mjs`
  - `server/policy-derived-results.service.mjs`
  - `server/routes/responsibilities.routes.mjs`
  - `server/routes/policies.routes.mjs`
  - `src/api/contracts/responsibility.ts`
  - `src/api/contracts/policy.ts`

- [ ] **Step 1: Run focused backend tests**

```bash
node --test tests/responsibility-card-standardizer.test.mjs tests/policy-derived-results.test.mjs tests/sqlite-state-store.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run focused API flow tests**

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "policy analyze returns responsibility cards|policy responsibilities|policy derived result"
```

Expected: PASS.

- [ ] **Step 3: Run project checks required for backend and contract changes**

```bash
npm run check
npm run typecheck
npm test
```

Expected: all commands pass. If `npm test` is too slow for the local session, run the focused tests above plus the nearest changed-domain tests, and record the skipped full command in the final implementation report.

- [ ] **Step 4: Manual SQLite smoke check against current dev DB**

Run:

```bash
POLICY_OCR_APP_DB_PATH=.runtime/local/policy-ocr.sqlite node --input-type=module <<'EOF'
import { createSqliteStateStore } from './server/sqlite-state-store.mjs';
import { buildPolicyDerivedResult } from './server/policy-derived-results.service.mjs';

const store = await createSqliteStateStore({ dbPath: '.runtime/local/policy-ocr.sqlite' });
const state = await store.load();
const policy = state.policies.find((row) => String(row.name || '').includes('尊享人生')) || state.policies[0];
if (!policy) throw new Error('No policy available for smoke check');
const row = buildPolicyDerivedResult({
  policy,
  indicatorRecords: state.insuranceIndicatorRecords,
  knowledgeRecords: state.knowledgeRecords,
  optionalResponsibilityRecords: state.optionalResponsibilityRecords,
  productIndicatorVersions: state.productIndicatorVersions,
  now: new Date().toISOString(),
});
console.log(JSON.stringify({
  policyId: row.policyId,
  cardCount: row.responsibilityCards.length,
  indicatorCount: row.responsibilityCards.reduce((sum, card) => sum + card.indicators.length, 0),
  calculableIndicatorCount: row.responsibilityCards.flatMap((card) => card.indicators).filter((item) => item.calculationEligible).length,
  missingEvidenceCalculableCount: row.responsibilityCards.flatMap((card) => card.indicators).filter((item) => item.calculationEligible && (!item.sourceUrl || !item.sourceExcerpt)).length,
}, null, 2));
store.close();
EOF
```

Expected:

```json
{
  "cardCount": 1,
  "missingEvidenceCalculableCount": 0
}
```

The exact `policyId`, `cardCount`, and `indicatorCount` may vary by local data, but `missingEvidenceCalculableCount` must be `0`.

- [ ] **Step 5: Commit final fixes if any**

If Step 1-4 required fixes:

```bash
git add server/responsibility-card-standardizer.mjs server/policy-derived-results.service.mjs server/routes/responsibilities.routes.mjs server/routes/policies.routes.mjs src/api/contracts/responsibility.ts src/api/contracts/policy.ts tests/responsibility-card-standardizer.test.mjs tests/policy-derived-results.test.mjs tests/policy-ocr-flow.test.mjs
git commit -m "fix: verify responsibility card integration"
```

If no fixes were needed, do not create an empty commit.

## Implementation Notes

- Existing indicators are not trusted blindly. Every responsibility-card generation must pass them through `standardizeResponsibilityIndicator`.
- `calculationEligible` is not the same as `cashflowTreatment`. A claim-trigger benefit can be calculable for insured amount but still be `claim_contingent`.
- `sourceUrl + sourceExcerpt` is mandatory for a calculable indicator.
- No production DB, `.env.local`, or `.runtime/` file should be modified during implementation.
- Keep old response fields until follow-up cleanup is explicitly requested.
