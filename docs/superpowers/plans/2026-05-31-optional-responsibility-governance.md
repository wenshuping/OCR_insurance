# Optional Responsibility Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a governance loop that detects every product optional responsibility, tracks quantification status, and only counts optional indicators when the policy selected them and the indicators are quantified.

**Architecture:** Add a product-level optional responsibility record set, backed by SQLite and derived from official knowledge records. A focused governance module owns optional section extraction, quantification status, gap generation, and selected-indicator filtering; existing policy/domain, cashflow, family report, admin, and entry UI code call this module instead of duplicating rules.

**Tech Stack:** Node.js ESM, Express, Node `node:test`, SQLite payload tables, React + TypeScript, Vite.

---

## File Structure

- Create `server/optional-responsibility-governance.mjs`
  - Pure functions for optional responsibility extraction, normalization, quantification status, selected-indicator filtering, and governance gap rows.
- Modify `server/policy-ocr.domain.mjs`
  - State defaults, policy attachment, optional review normalization, and imports from the governance module.
- Modify `server/sqlite-state-store.mjs`
  - Persist `optionalResponsibilityRecords` in a DB-owned payload table.
- Modify `server/app.mjs`
  - Build admin overview gap rows, expose admin actions, and pass product optional records into policy attachment.
- Modify `server/cashflow-compute.mjs`
  - Exclude optional indicators unless selected and quantified.
- Modify `src/family-report-engine.mjs`
  - Exclude optional indicators unless selected and quantified, and emit selected-but-unquantified gaps.
- Modify `src/FamilyReport.tsx`
  - Render the family report optional responsibility gap section.
- Modify `src/api.ts`
  - Add `quantificationStatus`, `quantificationReason`, `indicatorIds`, and admin gap types.
- Modify `src/App.tsx`
  - Display quantification status in entry/detail optional review, warning for selected gaps, and admin governance list/actions.
- Create `scripts/backfill-optional-responsibility-governance.mjs`
  - Rebuild product-level optional responsibility records and optional indicators from local knowledge records.
- Create tests:
  - `tests/optional-responsibility-governance.test.mjs`
  - Extend `tests/policy-optional-responsibility.test.mjs`
  - Extend `tests/sqlite-state-store.test.mjs`
  - Extend `tests/cashflow-compute.test.mjs`
  - Extend `tests/family-report-engine.test.mjs`
  - Extend `tests/policy-ocr-flow.test.mjs`
  - Extend `tests/customer-ui-style.test.mjs`

## Task 1: Product-Level Optional Responsibility Persistence

**Files:**
- Modify: `server/policy-ocr.domain.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Write the failing persistence test**

Append this test to `tests/sqlite-state-store.test.mjs`:

```js
test('sqlite state store persists product optional responsibility records', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'policy-ocr-optional-'));
  const dbPath = path.join(dir, 'state.sqlite');
  const store = createSqliteStateStore({
    dbPath,
    jsonPath: path.join(dir, 'state.json'),
  });
  const state = {
    ...createInitialState(),
    optionalResponsibilityRecords: [
      {
        id: 'optrec_xinhua_zhixiang_1',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        liability: '可选责任一',
        title: '可选责任一',
        quantificationStatus: 'pending_review',
        quantificationReason: '缺少结构化指标',
        indicatorIds: [],
        sourceExcerpt: '3.可选责任一 （1）轻度疾病保险金。',
      },
    ],
  };

  await store.saveState(state);
  const reloaded = await store.loadState();

  assert.equal(reloaded.optionalResponsibilityRecords.length, 1);
  assert.equal(reloaded.optionalResponsibilityRecords[0].liability, '可选责任一');
  assert.equal(reloaded.optionalResponsibilityRecords[0].quantificationStatus, 'pending_review');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs
```

Expected: FAIL because `optionalResponsibilityRecords` is not loaded from SQLite.

- [ ] **Step 3: Add state default**

In `server/policy-ocr.domain.mjs`, add this key in `createInitialState()`:

```js
optionalResponsibilityRecords: [],
```

- [ ] **Step 4: Add SQLite table and owned state key**

In `server/sqlite-state-store.mjs`, add `optionalResponsibilityRecords` to `DB_OWNED_KEYS`:

```js
'optionalResponsibilityRecords',
```

In `createSchema(db)`, add:

```sql
CREATE TABLE IF NOT EXISTS optional_responsibility_records (
  id TEXT PRIMARY KEY,
  company TEXT,
  product_name TEXT,
  liability TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_optional_responsibility_records_company ON optional_responsibility_records(company);
CREATE INDEX IF NOT EXISTS idx_optional_responsibility_records_product_name ON optional_responsibility_records(product_name);
```

In the save transaction, clear the table with the other DB-owned tables:

```js
DELETE FROM optional_responsibility_records;
```

Then insert rows:

```js
const insertOptionalResponsibilityRecord = db.prepare(`
  INSERT INTO optional_responsibility_records (id, company, product_name, liability, payload)
  VALUES (?, ?, ?, ?, ?)
`);
for (const record of normalizeArray(state.optionalResponsibilityRecords)) {
  const id = String(record?.id || '').trim();
  if (!id) continue;
  insertOptionalResponsibilityRecord.run(
    id,
    String(record.company || ''),
    String(record.productName || ''),
    String(record.liability || ''),
    jsonPayload(record),
  );
}
```

In `loadDbOwnedState(db)`, add:

```js
optionalResponsibilityRecords: loadPayloadRows(
  db,
  'optional_responsibility_records',
  'product_name ASC, liability ASC, id ASC',
),
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/policy-ocr.domain.mjs server/sqlite-state-store.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: persist optional responsibility records"
```

## Task 2: Governance Module And Quantification Status

**Files:**
- Create: `server/optional-responsibility-governance.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Modify: `src/api.ts`
- Test: `tests/optional-responsibility-governance.test.mjs`

- [ ] **Step 1: Write the failing module tests**

Create `tests/optional-responsibility-governance.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOptionalResponsibilityId,
  buildOptionalResponsibilityRecords,
  isSelectedQuantifiedIndicator,
  normalizeOptionalResponsibilityRecord,
} from '../server/optional-responsibility-governance.mjs';

const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';

test('buildOptionalResponsibilityRecords extracts optional sections and links quantified indicators', () => {
  const policy = {
    company: '新华保险',
    name: productName,
    ocrText: '保险责任包含基本责任和可选责任一。',
  };
  const knowledgeRecords = [
    {
      company: '新华保险',
      productName,
      pageText: '保险责任 本合同分为基本责任和可选责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。（2）中度疾病保险金 按基本保险金额的50%给付。',
    },
  ];
  const optionalId = buildOptionalResponsibilityId({
    company: '新华保险',
    productName,
    liability: '可选责任一',
  });
  const indicators = [
    {
      id: 'ind_light',
      company: '新华保险',
      productName,
      coverageType: '疾病保障',
      liability: '轻度疾病保险金',
      value: 20,
      unit: '%',
      basis: '基本保险金额',
      formulaText: '基本保额 × 20%',
      responsibilityScope: 'optional',
      optionalResponsibilityId: optionalId,
      quantificationStatus: 'quantified',
    },
  ];

  const records = buildOptionalResponsibilityRecords({
    policy,
    knowledgeRecords,
    indicators,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].id, optionalId);
  assert.equal(records[0].liability, '可选责任一');
  assert.equal(records[0].selectionStatus, 'selected');
  assert.equal(records[0].quantificationStatus, 'quantified');
  assert.deepEqual(records[0].indicatorIds, ['ind_light']);
  assert.match(records[0].sourceExcerpt, /轻度疾病保险金/u);
});

test('buildOptionalResponsibilityRecords marks unlinked optional sections as pending review', () => {
  const records = buildOptionalResponsibilityRecords({
    policy: { company: '新华保险', name: productName },
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。',
      },
    ],
    indicators: [],
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].quantificationStatus, 'pending_review');
  assert.equal(records[0].quantificationReason, '缺少可计算结构化指标');
});

test('normalizeOptionalResponsibilityRecord preserves manual not quantifiable state', () => {
  const normalized = normalizeOptionalResponsibilityRecord({
    company: '新华保险',
    productName,
    liability: '可选责任二',
    quantificationStatus: 'not_quantifiable',
    quantificationReason: '条款仅提示权益，不进入金额计算',
    selectionStatus: 'selected',
    indicatorIds: [''],
  });

  assert.equal(normalized.quantificationStatus, 'not_quantifiable');
  assert.equal(normalized.quantificationReason, '条款仅提示权益，不进入金额计算');
  assert.deepEqual(normalized.indicatorIds, []);
});

test('isSelectedQuantifiedIndicator requires selected optional status and quantified status', () => {
  assert.equal(isSelectedQuantifiedIndicator({ responsibilityScope: 'basic' }), true);
  assert.equal(isSelectedQuantifiedIndicator({
    responsibilityScope: 'optional',
    selectionStatus: 'selected',
    quantificationStatus: 'quantified',
  }), true);
  assert.equal(isSelectedQuantifiedIndicator({
    responsibilityScope: 'optional',
    selectionStatus: 'selected',
    quantificationStatus: 'pending_review',
  }), false);
  assert.equal(isSelectedQuantifiedIndicator({
    responsibilityScope: 'optional',
    selectionStatus: 'unknown',
    quantificationStatus: 'quantified',
  }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/optional-responsibility-governance.test.mjs
```

Expected: FAIL because `server/optional-responsibility-governance.mjs` does not exist.

- [ ] **Step 3: Create the governance module**

Create `server/optional-responsibility-governance.mjs` with these exports and behavior:

```js
import crypto from 'node:crypto';

export const RESPONSIBILITY_SELECTION_STATUSES = new Set(['selected', 'not_selected', 'unknown']);
export const QUANTIFICATION_STATUSES = new Set(['quantified', 'pending_review', 'not_quantifiable']);

const OPTIONAL_SECTION_PATTERN = /(?:^|[。；;:：]\s*|\d+[.．、]\s*)可选(?:保险)?责任\s*([一二三四五六七八九十\d]*)/gu;
const OPTIONAL_WORDING_PATTERN = /可选(?:保险)?责任|可选部分|可选保障|可选择投保/u;
const OPTIONAL_NEGATIVE_PATTERN = /不含可选(?:保险)?责任|不包含.{0,30}可选(?:保险)?责任/u;

export function normalizeLookupText(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, '').trim();
}

export function normalizeSelectionStatus(value, fallback = 'unknown') {
  const status = String(value || '').trim();
  return RESPONSIBILITY_SELECTION_STATUSES.has(status) ? status : fallback;
}

export function normalizeQuantificationStatus(value, fallback = 'pending_review') {
  const status = String(value || '').trim();
  return QUANTIFICATION_STATUSES.has(status) ? status : fallback;
}

export function buildOptionalResponsibilityId({ company = '', productName = '', liability = '' } = {}) {
  const digest = crypto
    .createHash('sha1')
    .update([company, productName, liability].map(normalizeLookupText).join('\u001f'))
    .digest('hex')
    .slice(0, 16);
  return `opt_${digest}`;
}

function parsePayload(record = {}) {
  if (record?.payload && typeof record.payload === 'object') return record.payload;
  if (typeof record?.payload !== 'string') return {};
  try {
    const parsed = JSON.parse(record.payload);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function knowledgeText(record = {}) {
  const payload = parsePayload(record);
  return [
    record.pageText,
    record.text,
    record.content,
    payload.pageText,
    payload.text,
    payload.content,
    ...(Array.isArray(payload.pages) ? payload.pages.map((page) => page.pageText || page.text || page.content || '') : []),
  ].map((item) => String(item || '').trim()).filter(Boolean).join('\n');
}

function productNames(record = {}) {
  const payload = parsePayload(record);
  return [record.productName, record.name, record.title, payload.productName, payload.name, payload.title]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function recordMatchesPolicy(record = {}, policy = {}) {
  const company = normalizeLookupText(record.company || parsePayload(record).company || policy.company);
  const policyCompany = normalizeLookupText(policy.company);
  if (policyCompany && company && company !== policyCompany) return false;
  const policyNames = [policy.name, policy.productName, ...(Array.isArray(policy.plans) ? policy.plans.map((plan) => plan.matchedProductName || plan.productName || plan.name) : [])]
    .map(normalizeLookupText)
    .filter(Boolean);
  return productNames(record).some((name) => policyNames.includes(normalizeLookupText(name)));
}

function excerptAround(text, index, length = 320) {
  const normalized = String(text || '').replace(/\s+/gu, ' ').trim();
  return normalized.slice(Math.max(0, Number(index || 0) - 24), Math.max(0, Number(index || 0) - 24) + length).trim();
}

function extractSections(text = '') {
  const source = String(text || '').replace(/\s+/gu, ' ').trim();
  if (!OPTIONAL_WORDING_PATTERN.test(source) || OPTIONAL_NEGATIVE_PATTERN.test(source)) return [];
  const matches = [...source.matchAll(OPTIONAL_SECTION_PATTERN)];
  return matches
    .map((match) => {
      const suffix = String(match[1] || '').trim();
      return {
        liability: `可选责任${suffix}`,
        sourceExcerpt: excerptAround(source, match.index),
      };
    })
    .filter((section, index, list) => list.findIndex((item) => item.liability === section.liability) === index);
}

function indicatorLinkedTo(record, indicator) {
  if (indicator?.optionalResponsibilityId && indicator.optionalResponsibilityId === record.id) return true;
  const text = normalizeLookupText([indicator?.coverageType, indicator?.liability, indicator?.sourceExcerpt].join(' '));
  return normalizeLookupText(record.liability).length >= 2 && text.includes(normalizeLookupText(record.liability));
}

function indicatorIsQuantified(indicator = {}) {
  if (normalizeQuantificationStatus(indicator.quantificationStatus, '') === 'quantified') return true;
  if (indicator.value !== undefined && indicator.value !== null && String(indicator.unit || indicator.formulaText || '').trim()) return true;
  if (String(indicator.formulaText || '').trim() && !/按条款|以条款/u.test(String(indicator.formulaText || ''))) return true;
  return false;
}

function inferSelectionStatus(policy = {}, liability = '') {
  const text = normalizeLookupText([policy.ocrText, policy.report].join(' '));
  const suffix = normalizeLookupText(liability).replace(/^可选(?:保险)?责任/u, '');
  if (suffix && /(?:包含|含)基本(?:保险)?责任和可选(?:保险)?责任/u.test(text)) {
    return text.includes(`可选责任${suffix}`) || text.includes(`可选保险责任${suffix}`) ? 'selected' : 'not_selected';
  }
  if (suffix && new RegExp(`不含.{0,16}可选(?:保险)?责任${suffix}`, 'u').test(text)) return 'not_selected';
  if (suffix && new RegExp(`(?:包含|含|投保).{0,16}可选(?:保险)?责任${suffix}`, 'u').test(text)) return 'selected';
  return 'unknown';
}

export function normalizeOptionalResponsibilityRecord(record = {}) {
  const company = String(record.company || '').trim();
  const productName = String(record.productName || '').trim();
  const liability = String(record.liability || record.title || '可选责任').trim();
  const id = String(record.id || '').trim() || buildOptionalResponsibilityId({ company, productName, liability });
  const indicatorIds = (Array.isArray(record.indicatorIds) ? record.indicatorIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return {
    id,
    company,
    productName,
    liability,
    title: String(record.title || liability).trim(),
    responsibilityScope: 'optional',
    selectionStatus: normalizeSelectionStatus(record.selectionStatus),
    selectionEvidence: String(record.selectionEvidence || 'official_terms').trim() || 'official_terms',
    quantificationStatus: normalizeQuantificationStatus(record.quantificationStatus),
    quantificationReason: String(record.quantificationReason || '').trim(),
    indicatorIds,
    sourceExcerpt: String(record.sourceExcerpt || '').trim().slice(0, 800),
  };
}

export function buildOptionalResponsibilityRecords({ policy = {}, knowledgeRecords = [], indicators = [], existingRecords = [] } = {}) {
  const existingById = new Map((Array.isArray(existingRecords) ? existingRecords : []).map((row) => [String(row.id || ''), row]));
  const candidates = [];
  for (const knowledgeRecord of Array.isArray(knowledgeRecords) ? knowledgeRecords : []) {
    if (!recordMatchesPolicy(knowledgeRecord, policy)) continue;
    for (const section of extractSections(knowledgeText(knowledgeRecord))) {
      const base = normalizeOptionalResponsibilityRecord({
        company: policy.company || knowledgeRecord.company,
        productName: policy.name || productNames(knowledgeRecord)[0],
        liability: section.liability,
        sourceExcerpt: section.sourceExcerpt,
        selectionStatus: inferSelectionStatus(policy, section.liability),
      });
      const linkedIndicators = (Array.isArray(indicators) ? indicators : []).filter((indicator) => indicatorLinkedTo(base, indicator));
      const quantifiedIds = linkedIndicators.filter(indicatorIsQuantified).map((indicator) => String(indicator.id || '').trim()).filter(Boolean);
      const existing = existingById.get(base.id);
      const status = existing?.quantificationStatus === 'not_quantifiable'
        ? 'not_quantifiable'
        : quantifiedIds.length
          ? 'quantified'
          : 'pending_review';
      candidates.push(normalizeOptionalResponsibilityRecord({
        ...base,
        ...existing,
        indicatorIds: quantifiedIds,
        quantificationStatus: status,
        quantificationReason: status === 'pending_review' ? '缺少可计算结构化指标' : existing?.quantificationReason || '',
      }));
    }
  }
  return candidates.sort((left, right) =>
    left.productName.localeCompare(right.productName, 'zh-CN') ||
    left.liability.localeCompare(right.liability, 'zh-CN')
  );
}

export function isSelectedQuantifiedIndicator(indicator = {}) {
  const scope = String(indicator?.responsibilityScope || 'basic');
  if (scope !== 'optional') return true;
  return normalizeSelectionStatus(indicator.selectionStatus) === 'selected'
    && normalizeQuantificationStatus(indicator.quantificationStatus) === 'quantified';
}
```

- [ ] **Step 4: Add API types**

In `src/api.ts`, extend `OptionalResponsibility`:

```ts
export type QuantificationStatus = 'quantified' | 'pending_review' | 'not_quantifiable';

export type OptionalResponsibility = {
  id: string;
  company?: string;
  productName?: string;
  coverageType?: string;
  liability?: string;
  title?: string;
  responsibilityScope: 'optional';
  selectionStatus: ResponsibilitySelectionStatus;
  selectionEvidence?: string;
  quantificationStatus?: QuantificationStatus;
  quantificationReason?: string;
  indicatorIds?: string[];
  sourceExcerpt?: string;
};
```

Extend `CoverageIndicator`:

```ts
quantificationStatus?: QuantificationStatus;
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test tests/optional-responsibility-governance.test.mjs
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add server/optional-responsibility-governance.mjs src/api.ts tests/optional-responsibility-governance.test.mjs
git commit -m "feat: add optional responsibility governance module"
```

## Task 3: Attach Governance Records To Policies

**Files:**
- Modify: `server/policy-ocr.domain.mjs`
- Modify: `server/app.mjs`
- Test: `tests/policy-optional-responsibility.test.mjs`

- [ ] **Step 1: Write the failing policy attachment test**

Append this test to `tests/policy-optional-responsibility.test.mjs`:

```js
test('policy attachment uses product optional records and filters unquantified optional indicators', () => {
  const policy = {
    company: '新华保险',
    name: '测试重疾',
    ocrText: '保险责任包含基本责任和可选责任一。',
  };
  const optionalResponsibilityRecords = [
    {
      id: 'opt_test_1',
      company: '新华保险',
      productName: '测试重疾',
      liability: '可选责任一',
      responsibilityScope: 'optional',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
      quantificationReason: '缺少可计算结构化指标',
      indicatorIds: [],
    },
  ];
  const indicatorRecords = [
    {
      id: 'ind_basic',
      company: '新华保险',
      productName: '测试重疾',
      coverageType: '疾病保障',
      liability: '重疾首次给付',
      value: 100,
      unit: '%',
      basis: '基本保额',
    },
  ];

  const attached = attachPolicyCoverageIndicators(policy, indicatorRecords, [], optionalResponsibilityRecords);

  assert.equal(attached.optionalResponsibilities.length, 1);
  assert.equal(attached.optionalResponsibilities[0].quantificationStatus, 'pending_review');
  assert.equal(attached.coverageIndicators.length, 1);
  assert.equal(selectedCoverageIndicators(attached.coverageIndicators).length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/policy-optional-responsibility.test.mjs
```

Expected: FAIL because `attachPolicyCoverageIndicators` does not accept product optional records.

- [ ] **Step 3: Import governance helpers into domain**

In `server/policy-ocr.domain.mjs`, import:

```js
import {
  buildOptionalResponsibilityRecords,
  isSelectedQuantifiedIndicator,
  normalizeOptionalResponsibilityRecord,
  normalizeQuantificationStatus,
  normalizeSelectionStatus,
} from './optional-responsibility-governance.mjs';
```

Replace local selection normalization calls with `normalizeSelectionStatus`.

- [ ] **Step 4: Normalize optional responsibility records**

Update `normalizeOptionalResponsibilities(items = [])` so returned items include:

```js
company: String(item?.company || '').trim(),
title: String(item?.title || item?.liability || item?.coverageType || '').trim(),
quantificationStatus: normalizeQuantificationStatus(item?.quantificationStatus),
quantificationReason: String(item?.quantificationReason || '').trim(),
indicatorIds: (Array.isArray(item?.indicatorIds) ? item.indicatorIds : []).map((id) => String(id || '').trim()).filter(Boolean),
```

Use `normalizeOptionalResponsibilityRecord` for each row after computing product and liability.

- [ ] **Step 5: Attach product records**

Add this merge helper near `buildOptionalResponsibilityReview`:

```js
function mergeOptionalResponsibilityReviewItems(items = []) {
  const byId = new Map();
  for (const item of items.map(normalizeOptionalResponsibilityRecord)) {
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, item);
      continue;
    }
    byId.set(item.id, {
      ...existing,
      ...item,
      selectionStatus: existing.selectionEvidence === 'manual' ? existing.selectionStatus : item.selectionStatus,
      selectionEvidence: existing.selectionEvidence === 'manual' ? existing.selectionEvidence : item.selectionEvidence,
      quantificationStatus: item.quantificationStatus || existing.quantificationStatus,
      quantificationReason: item.quantificationReason || existing.quantificationReason,
      indicatorIds: item.indicatorIds?.length ? item.indicatorIds : existing.indicatorIds,
      sourceExcerpt: item.sourceExcerpt || existing.sourceExcerpt,
    });
  }
  return [...byId.values()].sort((left, right) =>
    String(left.productName || '').localeCompare(String(right.productName || ''), 'zh-CN') ||
    String(left.liability || '').localeCompare(String(right.liability || ''), 'zh-CN')
  );
}
```

Change signatures:

```js
export function buildOptionalResponsibilityReview(policy = {}, indicators = [], knowledgeRecords = [], optionalResponsibilityRecords = []) {
  const productRecords = buildOptionalResponsibilityRecords({
    policy,
    knowledgeRecords,
    indicators,
    existingRecords: optionalResponsibilityRecords,
  });
  const indicatorRecords = (Array.isArray(indicators) ? indicators : [])
    .filter((indicator) => String(indicator.responsibilityScope || 'basic') === 'optional')
    .map((indicator) => normalizeOptionalResponsibilityRecord({
      id: indicator.optionalResponsibilityId,
      company: indicator.company || policy.company,
      productName: indicator.productName || policy.name,
      liability: indicator.optionalResponsibilityLiability || indicator.liability || indicator.coverageType,
      selectionStatus: indicator.selectionStatus,
      quantificationStatus: indicator.quantificationStatus,
      indicatorIds: [indicator.id].filter(Boolean),
      sourceExcerpt: indicator.sourceExcerpt,
    }));
  const persistedRecords = normalizeOptionalResponsibilities(policy.optionalResponsibilities);
  return mergeOptionalResponsibilityReviewItems([...productRecords, ...indicatorRecords, ...persistedRecords]);
}

export function attachPolicyCoverageIndicators(policy = {}, indicatorRecords = [], knowledgeRecords = [], optionalResponsibilityRecords = []) {
  const coverageIndicators = findPolicyCoverageIndicators(policy, indicatorRecords);
  const optionalResponsibilities = buildOptionalResponsibilityReview(policy, coverageIndicators, knowledgeRecords, optionalResponsibilityRecords);
  return { ...policy, coverageIndicators, optionalResponsibilities };
}
```

When annotating optional indicators, copy `quantificationStatus` from linked product optional record. If an optional indicator has no linked record, default to:

```js
quantificationStatus: 'pending_review'
```

- [ ] **Step 6: Update app call sites**

In `server/app.mjs`, pass `state.optionalResponsibilityRecords` anywhere `attachPolicyCoverageIndicators`, `attachPoliciesCoverageIndicators`, or `buildOptionalResponsibilityReview` is called.

Example:

```js
attachPoliciesCoverageIndicators(
  policyRows,
  state.insuranceIndicatorRecords,
  state.knowledgeRecords,
  state.optionalResponsibilityRecords,
)
```

- [ ] **Step 7: Update selected indicator predicate**

In `server/policy-ocr.domain.mjs`, change `isSelectedCoverageIndicator` to:

```js
export function isSelectedCoverageIndicator(indicator = {}) {
  return isSelectedQuantifiedIndicator(indicator);
}
```

- [ ] **Step 8: Run tests**

Run:

```bash
node --test tests/policy-optional-responsibility.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add server/policy-ocr.domain.mjs server/app.mjs tests/policy-optional-responsibility.test.mjs
git commit -m "feat: attach optional responsibility governance to policies"
```

## Task 4: Backfill Optional Responsibility Records And Optional Indicators

**Files:**
- Modify: `server/optional-responsibility-governance.mjs`
- Create: `scripts/backfill-optional-responsibility-governance.mjs`
- Test: `tests/optional-responsibility-governance.test.mjs`

- [ ] **Step 1: Add failing extraction tests**

Update the import created in Task 2 at the top of `tests/optional-responsibility-governance.test.mjs` so it also imports:

```js
  extractOptionalIndicatorsFromSection,
  rebuildOptionalResponsibilityGovernance,
```

Then append these tests to `tests/optional-responsibility-governance.test.mjs`:

```js

test('extractOptionalIndicatorsFromSection builds quantified disease indicators', () => {
  const section = {
    company: '新华保险',
    productName,
    liability: '可选责任一',
    sourceExcerpt: '3.可选责任一 （1）轻度疾病保险金 被保险人确诊轻度疾病，我们按基本保险金额的20%给付轻度疾病保险金。（2）中度疾病保险金 按基本保险金额的50%给付。',
  };

  const indicators = extractOptionalIndicatorsFromSection(section);

  assert.deepEqual(
    indicators.map((row) => ({
      coverageType: row.coverageType,
      liability: row.liability,
      value: row.value,
      unit: row.unit,
      basis: row.basis,
      responsibilityScope: row.responsibilityScope,
      quantificationStatus: row.quantificationStatus,
    })),
    [
      {
        coverageType: '疾病保障',
        liability: '轻度疾病保险金',
        value: 20,
        unit: '%',
        basis: '基本保险金额',
        responsibilityScope: 'optional',
        quantificationStatus: 'quantified',
      },
      {
        coverageType: '疾病保障',
        liability: '中度疾病保险金',
        value: 50,
        unit: '%',
        basis: '基本保险金额',
        responsibilityScope: 'optional',
        quantificationStatus: 'quantified',
      },
    ],
  );
});

test('rebuildOptionalResponsibilityGovernance produces records and indicators from knowledge records', () => {
  const state = {
    knowledgeRecords: [
      {
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 按基本保险金额的20%给付。',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
  };

  const next = rebuildOptionalResponsibilityGovernance(state);

  assert.equal(next.optionalResponsibilityRecords.length, 1);
  assert.equal(next.optionalResponsibilityRecords[0].quantificationStatus, 'quantified');
  assert.equal(next.insuranceIndicatorRecords.some((row) => row.responsibilityScope === 'optional'), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/optional-responsibility-governance.test.mjs
```

Expected: FAIL because the extraction exports do not exist.

- [ ] **Step 3: Implement section indicator extraction**

In `server/optional-responsibility-governance.mjs`, add:

```js
function indicatorIdFor({ company = '', productName = '', liability = '', optionalResponsibilityId = '' } = {}) {
  const digest = crypto
    .createHash('sha1')
    .update(['optional-indicator', company, productName, liability, optionalResponsibilityId].map(normalizeLookupText).join('\u001f'))
    .digest('hex')
    .slice(0, 18);
  return `ind_opt_${digest}`;
}

function splitBenefitClauses(text = '') {
  return String(text || '')
    .replace(/\s+/gu, ' ')
    .split(/(?=（\d+）|第[一二三四五六七八九十\d]+项|[。；;]\s*)/u)
    .map((item) => item.trim())
    .filter((item) => /保险金|豁免|给付|领取/u.test(item));
}

function classifyCoverageType(liability) {
  if (/轻度疾病|中度疾病|重度疾病|重大疾病|特定疾病|豁免/u.test(liability)) return '疾病保障';
  if (/身故|全残/u.test(liability)) return '人寿保障';
  if (/生存|年金|满期|领取/u.test(liability)) return '现金流';
  if (/医疗|住院|津贴/u.test(liability)) return '医疗保障';
  return '保险责任';
}

function extractLiability(clause) {
  const match = String(clause || '').match(/(?:（\d+）)?\s*([一-龥A-Za-z0-9（）()]{2,30}?(?:保险金|豁免|年金|津贴|给付))/u);
  return match?.[1] || '';
}

function extractFormula(clause) {
  const text = String(clause || '').normalize('NFKC');
  const percent = text.match(/基本保险金额的\s*(\d+(?:\.\d+)?)\s*%/u);
  if (percent) {
    return {
      value: Number(percent[1]),
      unit: '%',
      basis: '基本保险金额',
      formulaText: `基本保额 × ${percent[1]}%`,
    };
  }
  const multiple = text.match(/基本保险金额的\s*(\d+(?:\.\d+)?)\s*倍/u);
  if (multiple) {
    return {
      value: Number(multiple[1]),
      unit: '倍',
      basis: '基本保险金额',
      formulaText: `基本保额 × ${multiple[1]}`,
    };
  }
  const fixed = text.match(/(\d+(?:,\d{3})*(?:\.\d+)?)\s*元/u);
  if (fixed) {
    return {
      value: Number(fixed[1].replace(/,/gu, '')),
      unit: '元',
      basis: '固定金额',
      formulaText: `${fixed[1]}元`,
    };
  }
  if (/豁免/u.test(text)) {
    return {
      value: null,
      unit: '公式',
      basis: '后续保险费',
      formulaText: '豁免后续应交保险费',
    };
  }
  return null;
}

export function extractOptionalIndicatorsFromSection(section = {}) {
  const optionalResponsibilityId = String(section.id || '').trim()
    || buildOptionalResponsibilityId(section);
  return splitBenefitClauses(section.sourceExcerpt)
    .map((clause) => {
      const liability = extractLiability(clause);
      const formula = extractFormula(clause);
      if (!liability || !formula) return null;
      return {
        id: indicatorIdFor({ ...section, liability, optionalResponsibilityId }),
        company: String(section.company || '').trim(),
        productName: String(section.productName || '').trim(),
        coverageType: classifyCoverageType(liability),
        liability,
        ...formula,
        condition: '',
        responsibilityScope: 'optional',
        optionalResponsibilityId,
        quantificationStatus: 'quantified',
        sourceExcerpt: clause.slice(0, 500),
        extractionMethod: 'optional_terms_rule',
        updatedAt: new Date().toISOString(),
      };
    })
    .filter(Boolean);
}
```

- [ ] **Step 4: Implement state rebuild**

Add:

```js
export function rebuildOptionalResponsibilityGovernance(state = {}) {
  const productPolicies = (Array.isArray(state.knowledgeRecords) ? state.knowledgeRecords : []).map((record) => ({
    company: record.company,
    name: record.productName || record.title,
  }));
  const optionalRecords = [];
  const optionalIndicators = [];
  for (const policy of productPolicies) {
    const records = buildOptionalResponsibilityRecords({
      policy,
      knowledgeRecords: state.knowledgeRecords,
      indicators: state.insuranceIndicatorRecords,
      existingRecords: state.optionalResponsibilityRecords,
    });
    for (const record of records) {
      const derivedIndicators = extractOptionalIndicatorsFromSection(record);
      const nextRecord = normalizeOptionalResponsibilityRecord({
        ...record,
        indicatorIds: derivedIndicators.map((indicator) => indicator.id),
        quantificationStatus: derivedIndicators.length ? 'quantified' : record.quantificationStatus,
        quantificationReason: derivedIndicators.length ? '' : record.quantificationReason,
      });
      optionalRecords.push(nextRecord);
      optionalIndicators.push(...derivedIndicators);
    }
  }
  const existingNonOptionalIndicators = (Array.isArray(state.insuranceIndicatorRecords) ? state.insuranceIndicatorRecords : [])
    .filter((indicator) => String(indicator.responsibilityScope || 'basic') !== 'optional');
  return {
    ...state,
    optionalResponsibilityRecords: optionalRecords,
    insuranceIndicatorRecords: [...existingNonOptionalIndicators, ...optionalIndicators],
  };
}
```

- [ ] **Step 5: Create backfill script**

Create `scripts/backfill-optional-responsibility-governance.mjs`:

```js
import { createSqliteStateStore } from '../server/sqlite-state-store.mjs';
import { rebuildOptionalResponsibilityGovernance } from '../server/optional-responsibility-governance.mjs';

const dbPath = process.env.POLICY_OCR_APP_DB_PATH || '.runtime/local/policy-ocr.sqlite';
const jsonPath = process.env.POLICY_OCR_STATE_PATH || '.runtime/local/state.json';
const store = createSqliteStateStore({ dbPath, jsonPath });

const state = await store.loadState();
const next = rebuildOptionalResponsibilityGovernance(state);
await store.saveState(next);

console.log(JSON.stringify({
  optionalResponsibilityCount: next.optionalResponsibilityRecords.length,
  optionalIndicatorCount: next.insuranceIndicatorRecords.filter((row) => row.responsibilityScope === 'optional').length,
}, null, 2));
```

- [ ] **Step 6: Run tests and dry backfill**

Run:

```bash
node --test tests/optional-responsibility-governance.test.mjs
POLICY_OCR_APP_DB_PATH=:memory: node scripts/backfill-optional-responsibility-governance.mjs
```

Expected: test PASS. The memory DB command prints JSON counts without touching local data.

- [ ] **Step 7: Commit**

```bash
git add server/optional-responsibility-governance.mjs scripts/backfill-optional-responsibility-governance.mjs tests/optional-responsibility-governance.test.mjs
git commit -m "feat: backfill optional responsibility indicators"
```

## Task 5: Calculation Gating For Quantification Status

**Files:**
- Modify: `server/cashflow-compute.mjs`
- Modify: `src/family-report-engine.mjs`
- Test: `tests/cashflow-compute.test.mjs`
- Test: `tests/family-report-engine.test.mjs`

- [ ] **Step 1: Add failing cashflow tests**

Append to `tests/cashflow-compute.test.mjs`:

```js
test('computeScenarioEntries skips selected optional indicators that are not quantified', () => {
  const indicators = [
    {
      coverageType: '意外保障',
      liability: '可选航空意外',
      value: 20,
      unit: '倍',
      basis: '基本保额',
      responsibilityScope: 'optional',
      selectionStatus: 'selected',
      quantificationStatus: 'pending_review',
    },
  ];

  assert.deepEqual(computeScenarioEntries(indicators, changxingPolicy), []);
});

test('computePolicyCashflow skips selected optional cashflow indicators that are not quantified', () => {
  const indicator = {
    coverageType: '现金流',
    liability: '可选满期金',
    value: 100,
    unit: '%',
    basis: '基本保额',
    formulaText: '基本保额 × 100%',
    responsibilityScope: 'optional',
    selectionStatus: 'selected',
    quantificationStatus: 'pending_review',
  };

  assert.deepEqual(computePolicyCashflow(shengshiPolicy, null, [indicator]), []);
});
```

- [ ] **Step 2: Add failing family report test**

Append to `tests/family-report-engine.test.mjs`:

```js
test('buildFamilyReport reports selected optional responsibilities that are not quantified as gaps', () => {
  const report = buildFamilyReport([
    makePolicy({
      id: 90,
      insured: '妈妈',
      name: '测试重疾',
      optionalResponsibilities: [
        {
          id: 'opt_gap',
          productName: '测试重疾',
          liability: '可选责任一',
          responsibilityScope: 'optional',
          selectionStatus: 'selected',
          quantificationStatus: 'pending_review',
          quantificationReason: '缺少可计算结构化指标',
        },
      ],
      coverageIndicators: [
        {
          coverageType: '疾病保障',
          liability: '轻症保险金',
          value: 30,
          unit: '%',
          basis: '基本保额',
          responsibilityScope: 'optional',
          selectionStatus: 'selected',
          quantificationStatus: 'pending_review',
        },
      ],
    }),
  ]);

  assert.equal(report.optionalResponsibilityGaps.length, 1);
  assert.equal(report.optionalResponsibilityGaps[0].member, '妈妈');
  assert.equal(report.optionalResponsibilityGaps[0].liability, '可选责任一');
  assert.equal(report.criticalIllness.members[0].rows.find((row) => row.key === 'mild').amount, 0);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/cashflow-compute.test.mjs tests/family-report-engine.test.mjs
```

Expected: FAIL because selected optional pending indicators still count or gaps do not exist.

- [ ] **Step 4: Update cashflow filter**

In `server/cashflow-compute.mjs`, update local optional predicate:

```js
function indicatorIsSelectedAndQuantified(indicator = {}) {
  const scope = String(indicator?.responsibilityScope || 'basic');
  if (scope !== 'optional') return true;
  return String(indicator?.selectionStatus || 'unknown') === 'selected'
    && String(indicator?.quantificationStatus || 'pending_review') === 'quantified';
}
```

Apply this predicate before scenario and cashflow indicator use:

```js
const usableIndicators = (Array.isArray(indicators) ? indicators : []).filter(indicatorIsSelectedAndQuantified);
```

- [ ] **Step 5: Update family report filter and gap model**

In `src/family-report-engine.mjs`, update `isSelectedCoverageIndicator`:

```js
function isSelectedCoverageIndicator(indicator = {}) {
  const scope = String(indicator?.responsibilityScope || 'basic');
  if (scope !== 'optional') return true;
  return String(indicator?.selectionStatus || 'unknown') === 'selected'
    && String(indicator?.quantificationStatus || 'pending_review') === 'quantified';
}
```

Add:

```js
function buildOptionalResponsibilityGaps(policies = []) {
  const gaps = [];
  for (const policy of Array.isArray(policies) ? policies : []) {
    for (const item of Array.isArray(policy?.optionalResponsibilities) ? policy.optionalResponsibilities : []) {
      if (String(item?.selectionStatus || '') !== 'selected') continue;
      if (String(item?.quantificationStatus || '') === 'quantified') continue;
      gaps.push({
        member: memberName(policy),
        policyId: policy?.id,
        productName: String(policy?.name || item?.productName || ''),
        liability: String(item?.liability || item?.title || '可选责任'),
        quantificationStatus: String(item?.quantificationStatus || 'pending_review'),
        quantificationReason: String(item?.quantificationReason || '缺少可计算结构化指标'),
      });
    }
  }
  return gaps;
}
```

In the object returned by `buildFamilyReport`, include:

```js
optionalResponsibilityGaps: buildOptionalResponsibilityGaps(activePolicies),
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --test tests/cashflow-compute.test.mjs tests/family-report-engine.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/cashflow-compute.mjs src/family-report-engine.mjs tests/cashflow-compute.test.mjs tests/family-report-engine.test.mjs
git commit -m "feat: gate optional calculations by quantification status"
```

## Task 6: Entry, Detail, And Family Report Gap UI

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/FamilyReport.tsx`
- Modify: `src/api.ts`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing UI source tests**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('optional responsibility review displays quantification status and selected gap warning', () => {
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');
  const reviewSource = componentSource('OptionalResponsibilityReview', 'PolicyPlanEditor');

  assert.match(apiSource, /quantificationStatus\?: QuantificationStatus/);
  assert.match(reviewSource, /量化状态/);
  assert.match(reviewSource, /该可选责任已确认投保，但尚未完成指标量化/);
  assert.match(reviewSource, /optionalResponsibilityQuantificationLabel/);
});

test('family report renders optional responsibility gaps', () => {
  const source = fs.readFileSync(new URL('../src/FamilyReport.tsx', import.meta.url), 'utf8');

  assert.match(source, /optionalResponsibilityGaps/);
  assert.match(source, /已投保但未量化责任/);
  assert.match(source, /quantificationReason/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/customer-ui-style.test.mjs
```

Expected: FAIL because the warning and family report gap section are missing.

- [ ] **Step 3: Add frontend status label helpers**

In `src/App.tsx`, add near existing optional status helpers:

```ts
function optionalResponsibilityQuantificationLabel(status?: string) {
  if (status === 'quantified') return '已量化';
  if (status === 'not_quantifiable') return '不进入量化';
  return '待量化';
}

function optionalResponsibilityHasQuantificationGap(item: OptionalResponsibility) {
  return item.selectionStatus === 'selected' && item.quantificationStatus !== 'quantified';
}
```

- [ ] **Step 4: Render status and warning**

In `OptionalResponsibilityReview`, add a status badge beside the selection badge:

```tsx
<span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-black text-slate-600 ring-1 ring-slate-200">
  量化状态：{optionalResponsibilityQuantificationLabel(item.quantificationStatus)}
</span>
```

Under `sourceExcerpt`, add:

```tsx
{optionalResponsibilityHasQuantificationGap(item) ? (
  <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs font-black leading-5 text-amber-700 ring-1 ring-amber-100">
    该可选责任已确认投保，但尚未完成指标量化，暂不进入家庭报告计算。
  </p>
) : null}
```

- [ ] **Step 5: Add family report gap section**

The `buildFamilyReport` return object already receives `optionalResponsibilityGaps` in Task 5. In `src/FamilyReport.tsx`, add:

```tsx
function OptionalResponsibilityGapSection({ gaps }: { gaps: FamilyReport['optionalResponsibilityGaps'] }) {
  if (!gaps?.length) return null;
  return (
    <Section title="已投保但未量化责任">
      <div className="space-y-2">
        {gaps.map((gap, index) => (
          <div key={`${gap.policyId}-${gap.liability}-${index}`} className="rounded-xl bg-amber-50 px-3 py-2 text-xs font-semibold leading-5 text-amber-800 ring-1 ring-amber-100">
            <p className="font-black">{gap.member} · {gap.productName}</p>
            <p>{gap.liability}</p>
            <p>{gap.quantificationReason || '缺少可计算结构化指标'}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}
```

Render it after `AttentionSection`:

```tsx
<OptionalResponsibilityGapSection gaps={report.optionalResponsibilityGaps} />
```

- [ ] **Step 6: Run tests**

Run:

```bash
node --test tests/customer-ui-style.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/App.tsx src/FamilyReport.tsx src/api.ts tests/customer-ui-style.test.mjs
git commit -m "feat: show optional responsibility quantification gaps"
```

## Task 7: Admin Governance List And Actions

**Files:**
- Modify: `server/optional-responsibility-governance.mjs`
- Modify: `server/app.mjs`
- Modify: `src/api.ts`
- Modify: `src/App.tsx`
- Test: `tests/policy-ocr-flow.test.mjs`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing API test**

Append to `tests/policy-ocr-flow.test.mjs`:

```js
test('admin overview lists optional responsibility quantification gaps and can mark one not quantifiable', async () => {
  const state = {
    users: [],
    adminSessions: [],
    sessions: [],
    smsCodes: [],
    policies: [
      {
        id: 1,
        userId: null,
        guestId: 'guest-gap',
        company: '新华保险',
        name: '测试重疾',
        insured: '妈妈',
        optionalResponsibilities: [
          {
            id: 'opt_gap',
            productName: '测试重疾',
            liability: '可选责任一',
            responsibilityScope: 'optional',
            selectionStatus: 'selected',
            quantificationStatus: 'pending_review',
            quantificationReason: '缺少可计算结构化指标',
          },
        ],
        createdAt: '2026-05-31T00:00:00.000Z',
      },
    ],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [
      {
        id: 'opt_gap',
        company: '新华保险',
        productName: '测试重疾',
        liability: '可选责任一',
        quantificationStatus: 'pending_review',
        quantificationReason: '缺少可计算结构化指标',
        indicatorIds: [],
      },
    ],
    nextId: 2,
  };
  const app = createPolicyOcrApp({ state, adminPassword: 'admin123456' });
  const server = await listen(app);

  try {
    const login = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'admin123456' }),
    });
    const token = login.payload.token;

    const overview = await jsonFetch(server.baseUrl, '/api/admin/overview', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(overview.payload.optionalResponsibilityGaps.length, 1);
    assert.equal(overview.payload.optionalResponsibilityGaps[0].recentPolicyCount, 1);

    const updated = await jsonFetch(server.baseUrl, '/api/admin/optional-responsibilities/opt_gap/not-quantifiable', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ reason: '该责任仅提示权益，不进入金额计算' }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.record.quantificationStatus, 'not_quantifiable');
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs
```

Expected: FAIL because overview does not include `optionalResponsibilityGaps` and the admin action route does not exist.

- [ ] **Step 3: Add gap builder**

In `server/optional-responsibility-governance.mjs`, add:

```js
export function buildOptionalResponsibilityGaps({ optionalResponsibilityRecords = [], policies = [] } = {}) {
  const recentPolicyCounts = new Map();
  for (const policy of Array.isArray(policies) ? policies : []) {
    for (const item of Array.isArray(policy?.optionalResponsibilities) ? policy.optionalResponsibilities : []) {
      if (String(item.selectionStatus || '') !== 'selected') continue;
      const id = String(item.id || '').trim();
      if (!id) continue;
      recentPolicyCounts.set(id, (recentPolicyCounts.get(id) || 0) + 1);
    }
  }
  return (Array.isArray(optionalResponsibilityRecords) ? optionalResponsibilityRecords : [])
    .filter((record) => normalizeQuantificationStatus(record.quantificationStatus) === 'pending_review')
    .map((record) => ({
      id: record.id,
      company: record.company,
      productName: record.productName,
      liability: record.liability,
      quantificationStatus: record.quantificationStatus,
      quantificationReason: record.quantificationReason || '缺少可计算结构化指标',
      missingFields: record.indicatorIds?.length ? [] : ['indicatorIds'],
      sourceExcerpt: record.sourceExcerpt || '',
      recentPolicyCount: recentPolicyCounts.get(record.id) || 0,
    }))
    .sort((left, right) => right.recentPolicyCount - left.recentPolicyCount || left.productName.localeCompare(right.productName, 'zh-CN'));
}
```

- [ ] **Step 4: Include gaps in overview**

In `server/app.mjs`, import `buildOptionalResponsibilityGaps` and add to `buildAdminOverview(state)` return:

```js
optionalResponsibilityGaps: buildOptionalResponsibilityGaps({
  optionalResponsibilityRecords: state.optionalResponsibilityRecords,
  policies: policyRows,
}),
```

Add summary:

```js
optionalResponsibilityGapCount: buildOptionalResponsibilityGaps({
  optionalResponsibilityRecords: state.optionalResponsibilityRecords,
  policies: policyRows,
}).length,
```

- [ ] **Step 5: Add admin actions**

In `server/app.mjs`, add route:

```js
app.post('/api/admin/optional-responsibilities/:id/not-quantifiable', async (req, res) => {
  try {
    assertAdminRequest(req, state);
    const id = String(req.params.id || '').trim();
    const record = (state.optionalResponsibilityRecords || []).find((row) => String(row.id || '') === id);
    if (!record) return res.status(404).json({ ok: false, code: 'OPTIONAL_RESPONSIBILITY_NOT_FOUND', message: '可选责任不存在' });
    record.quantificationStatus = 'not_quantifiable';
    record.quantificationReason = String(req.body?.reason || '不进入量化计算').trim();
    record.updatedAt = new Date().toISOString();
    await persist(state);
    res.json({ ok: true, record });
  } catch (error) {
    sendError(res, error);
  }
});
```

Add re-extract route:

```js
app.post('/api/admin/optional-responsibilities/reextract', async (req, res) => {
  try {
    assertAdminRequest(req, state);
    Object.assign(state, rebuildOptionalResponsibilityGovernance(state));
    await persist(state);
    res.json({
      ok: true,
      optionalResponsibilityCount: state.optionalResponsibilityRecords.length,
      optionalIndicatorCount: state.insuranceIndicatorRecords.filter((row) => row.responsibilityScope === 'optional').length,
    });
  } catch (error) {
    sendError(res, error);
  }
});
```

- [ ] **Step 6: Add API types and client functions**

In `src/api.ts`, add:

```ts
export type OptionalResponsibilityGap = {
  id: string;
  company: string;
  productName: string;
  liability: string;
  quantificationStatus: QuantificationStatus;
  quantificationReason: string;
  missingFields: string[];
  sourceExcerpt: string;
  recentPolicyCount: number;
};
```

Extend `AdminOverview`:

```ts
optionalResponsibilityGaps: OptionalResponsibilityGap[];
```

Add:

```ts
export function markOptionalResponsibilityNotQuantifiable(token: string, id: string, reason: string) {
  return request<{ ok: true; record: OptionalResponsibility }>(`/api/admin/optional-responsibilities/${encodeURIComponent(id)}/not-quantifiable`, {
    token,
    method: 'POST',
    body: { reason },
  });
}

export function reextractOptionalResponsibilities(token: string) {
  return request<{ ok: true; optionalResponsibilityCount: number; optionalIndicatorCount: number }>('/api/admin/optional-responsibilities/reextract', {
    token,
    method: 'POST',
  });
}
```

- [ ] **Step 7: Add admin panel source test**

Append to `tests/customer-ui-style.test.mjs`:

```js
test('admin app exposes optional responsibility quantification governance list', () => {
  const appSource = fs.readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

  assert.match(apiSource, /OptionalResponsibilityGap/);
  assert.match(apiSource, /markOptionalResponsibilityNotQuantifiable/);
  assert.match(apiSource, /reextractOptionalResponsibilities/);
  assert.match(appSource, /AdminOptionalResponsibilityGapPanel/);
  assert.match(appSource, /可选责任量化缺口/);
  assert.match(appSource, /标记不可量化/);
  assert.match(appSource, /重新拆解/);
});
```

- [ ] **Step 8: Implement admin panel**

In `src/App.tsx`, import the new API functions. Add `AdminOptionalResponsibilityGapPanel` near other admin panels:

```tsx
function AdminOptionalResponsibilityGapPanel({
  gaps,
  loading,
  onMarkNotQuantifiable,
  onReextract,
}: {
  gaps: OptionalResponsibilityGap[];
  loading: boolean;
  onMarkNotQuantifiable: (gap: OptionalResponsibilityGap) => void;
  onReextract: () => void;
}) {
  return (
    <section className="rounded-[20px] border border-slate-200 bg-white p-4 shadow-[0_18px_50px_-42px_rgba(15,23,42,0.45)]">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-black">可选责任量化缺口</p>
          <p className="mt-1 text-xs font-medium text-slate-400">已识别但未完成结构化指标的可选责任</p>
        </div>
        <button type="button" disabled={loading} onClick={onReextract} className="rounded-xl bg-slate-950 px-3 py-1.5 text-xs font-black text-white disabled:opacity-50">
          重新拆解
        </button>
      </div>
      <div className="max-h-[320px] space-y-2 overflow-auto pr-1">
        {gaps.map((gap) => (
          <article key={gap.id} className="rounded-[16px] border border-amber-100 bg-amber-50 px-3 py-2.5 text-xs">
            <p className="font-black text-amber-900">{gap.productName}</p>
            <p className="mt-1 font-semibold text-amber-800">{gap.company} · {gap.liability}</p>
            <p className="mt-1 leading-5 text-amber-700">{gap.quantificationReason}</p>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="rounded-full bg-white px-2.5 py-1 font-black text-amber-700">{gap.recentPolicyCount} 张相关保单</span>
              <button type="button" disabled={loading} onClick={() => onMarkNotQuantifiable(gap)} className="rounded-full bg-white px-2.5 py-1 font-black text-slate-700 ring-1 ring-amber-100 disabled:opacity-50">
                标记不可量化
              </button>
            </div>
          </article>
        ))}
        {!gaps.length ? <p className="rounded-[16px] bg-slate-50 px-3 py-4 text-sm font-bold text-slate-400">暂无量化缺口</p> : null}
      </div>
    </section>
  );
}
```

Render it in the admin sidebar before `AdminKnowledgePanel`:

```tsx
<AdminOptionalResponsibilityGapPanel
  gaps={overview?.optionalResponsibilityGaps || []}
  loading={loading}
  onMarkNotQuantifiable={(gap) => void handleMarkOptionalNotQuantifiable(gap)}
  onReextract={() => void handleReextractOptionalResponsibilities()}
/>
```

Add handlers:

```tsx
async function handleMarkOptionalNotQuantifiable(gap: OptionalResponsibilityGap) {
  if (!adminToken || loading) return;
  setLoading(true);
  setMessage('正在标记可选责任不可量化');
  try {
    await markOptionalResponsibilityNotQuantifiable(adminToken, gap.id, '该责任暂不进入金额量化计算');
    await loadOverview(adminToken);
    setMessage('可选责任已标记为不可量化');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '标记失败');
  } finally {
    setLoading(false);
  }
}

async function handleReextractOptionalResponsibilities() {
  if (!adminToken || loading) return;
  setLoading(true);
  setMessage('正在重新拆解可选责任');
  try {
    await reextractOptionalResponsibilities(adminToken);
    await loadOverview(adminToken);
    setMessage('可选责任拆解已刷新');
  } catch (error) {
    setMessage(error instanceof Error ? error.message : '重新拆解失败');
  } finally {
    setLoading(false);
  }
}
```

- [ ] **Step 9: Run tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs tests/customer-ui-style.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add server/optional-responsibility-governance.mjs server/app.mjs src/api.ts src/App.tsx tests/policy-ocr-flow.test.mjs tests/customer-ui-style.test.mjs
git commit -m "feat: add optional responsibility governance admin panel"
```

## Task 8: End-To-End Verification With Xinhua Optional Product

**Files:**
- Modify: `tests/policy-ocr-flow.test.mjs`
- No production file expected unless this test exposes a wiring bug.

- [ ] **Step 1: Add end-to-end regression test**

Append to `tests/policy-ocr-flow.test.mjs`:

```js
test('xinhua optional critical illness policy shows selected quantified optional responsibility', async () => {
  const productName = '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）';
  const state = {
    users: [],
    sessions: [],
    smsCodes: [],
    adminSessions: [],
    policies: [],
    pendingScans: [],
    sourceRecords: [],
    knowledgeRecords: [
      {
        id: 1,
        company: '新华保险',
        productName,
        pageText: '保险责任。3.可选责任一 （1）轻度疾病保险金 被保险人确诊轻度疾病，我们按基本保险金额的20%给付轻度疾病保险金。（2）中度疾病保险金 按基本保险金额的50%给付。',
      },
    ],
    insuranceIndicatorRecords: [],
    optionalResponsibilityRecords: [],
    nextId: 2,
  };
  Object.assign(state, rebuildOptionalResponsibilityGovernance(state));
  const app = createPolicyOcrApp({
    state,
    analyzer: async () => ({
      report: '测试报告',
      coverageTable: [],
      optionalResponsibilities: [],
    }),
  });
  const server = await listen(app);

  try {
    const analyzed = await jsonFetch(server.baseUrl, '/api/policies/analyze', {
      method: 'POST',
      body: JSON.stringify({
        guestId: 'guest-xinhua-optional',
        scan: {
          ocrText: '备注:《多倍保障重大疾病保险（智赢版）》的保险责任包含基本责任和可选责任一。可选责任一经确定，在本合同保险期间内不得变更。',
          data: {
            company: '新华保险',
            name: productName,
            applicant: '温舒萍',
            insured: '温舒萍',
            date: '2024-11-01',
            paymentPeriod: '15年交',
            coveragePeriod: '终身',
            amount: 60000,
            firstPremium: 3030,
          },
        },
      }),
    });

    const optionalOne = analyzed.payload.analysis.optionalResponsibilities.find((item) => item.liability === '可选责任一');
    assert.equal(optionalOne.selectionStatus, 'selected');
    assert.equal(optionalOne.quantificationStatus, 'quantified');
    assert.ok(optionalOne.indicatorIds.length >= 1);
  } finally {
    await server.close();
  }
});
```

Add import at the top:

```js
import { rebuildOptionalResponsibilityGovernance } from '../server/optional-responsibility-governance.mjs';
```

- [ ] **Step 2: Run test**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs
```

Expected: PASS with `可选责任一` returned as `selected` and `quantified`. A failure means one of Tasks 3 or 4 did not wire product records into the analyze response; return to that task, complete the missing step, then rerun this test.

- [ ] **Step 3: Run full verification**

Run:

```bash
npm run check
npm run typecheck
npm test
npm run build
```

Expected: all PASS.

- [ ] **Step 4: Run local backfill on development DB**

Only after the tests pass, run:

```bash
node scripts/backfill-optional-responsibility-governance.mjs
```

Expected output shape:

```json
{
  "optionalResponsibilityCount": 0,
  "optionalIndicatorCount": 0
}
```

The exact counts depend on the real local DB. They must both be non-negative integers, and `optionalResponsibilityCount` must be greater than zero if the local DB contains products with optional responsibilities.

- [ ] **Step 5: Restart local dev stack**

Run:

```bash
npm run local:dev:stop
npm run local:dev
```

Expected:

```text
开发地址: http://localhost:3014/
```

- [ ] **Step 6: Commit**

```bash
git add tests/policy-ocr-flow.test.mjs
git commit -m "test: verify xinhua optional responsibility governance"
```

## Final Verification Checklist

- [ ] `npm run check`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run local:dev:status`
- [ ] Manual smoke: open `http://localhost:3014/`, recognize a Xinhua optional responsibility policy, generate responsibility, and confirm `可选责任一` shows `已投保` and `已量化`.
- [ ] Manual smoke: open `http://localhost:3014/admin`, verify `可选责任量化缺口` is visible and either lists pending records or shows `暂无量化缺口`.
