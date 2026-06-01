# Canonical Product ID Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable `canonicalProductId` so OCR-recognized products, optional responsibilities, indicators, and reports match by product identity instead of fragile product-name text.

**Architecture:** Add one shared backend utility for deterministic product ids, then thread that id through OCR mapping, local product suggestions, policy normalization, indicator matching, optional responsibility review, frontend form state, and a one-time SQLite payload backfill. Name-based strict fallback stays for old records, but id matching wins whenever both sides have ids.

**Tech Stack:** Node ESM, `node:test`, `node:crypto`, experimental `node:sqlite`, Express backend, React + TypeScript frontend, SQLite JSON payload persistence.

---

## Working Notes

- Execute in an isolated worktree if possible because the current checkout has unrelated modified files.
- Do not add a product master table in this implementation.
- Do not use raw OCR product text to create `canonicalProductId`. Only use official product names from `matchedProductName`, local product candidates, knowledge records, indicator records, or optional responsibility records.
- Preserve existing `company`, `productName`, `name`, and `matchedProductName` behavior for display and legacy fallback.

## File Structure

- Create `server/canonical-product-id.mjs`
  - Owns normalization and deterministic id generation.
  - Provides helpers that add ids to knowledge, indicator, optional responsibility, policy, and plan objects.
- Create `tests/canonical-product-id.test.mjs`
  - Unit tests for id stability, version separation, alias normalization boundaries, and disallowed raw OCR behavior.
- Modify `server/policy-ocr-mapping.mjs`
  - Return `canonicalProductId` from product matching.
  - Attach ids to OCR-mapped plans and policy scan data.
- Modify `server/policy-knowledge.service.mjs`
  - Return `canonicalProductId` from local product candidates.
- Modify `server/app.mjs`
  - Preserve ids in policy create/update normalization.
  - Return ids in product suggestions.
  - Build local analysis drafts using main-plan product id.
- Modify `server/policy-ocr.domain.mjs`
  - Preserve ids in plan normalization.
  - Match indicators and optional responsibilities by id first.
- Modify `server/optional-responsibility-governance.mjs`
  - Match optional responsibility records by id first when available.
- Modify `src/api.ts`
  - Add `canonicalProductId` fields to API types.
- Modify `src/App.tsx`
  - Preserve ids in form state.
  - Set ids on product selection.
  - Clear ids when official product match is invalidated.
  - Keep main optional responsibilities when deleting riders.
- Create `scripts/backfill-canonical-product-ids.mjs`
  - Idempotently writes ids into existing SQLite payloads.
- Modify tests:
  - `tests/policy-ocr-mapping.test.mjs`
  - `tests/policy-responsibility-query.test.mjs`
  - `tests/policy-optional-responsibility.test.mjs`
  - `tests/policy-ocr-flow.test.mjs`
  - `tests/customer-ui-style.test.mjs`

---

### Task 1: Shared Canonical Product ID Utility

**Files:**
- Create: `server/canonical-product-id.mjs`
- Create: `tests/canonical-product-id.test.mjs`

- [ ] **Step 1: Write failing tests for stable ids**

Create `tests/canonical-product-id.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCanonicalProductId,
  canonicalProductIdFromOfficialProduct,
  normalizeCanonicalProductPart,
  withCanonicalProductId,
} from '../server/canonical-product-id.mjs';

test('canonical product id is stable for the same official company and product', () => {
  const left = buildCanonicalProductId({
    company: ' 新华保险 ',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });
  const right = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });

  assert.match(left, /^product_[a-f0-9]{16}$/u);
  assert.equal(left, right);
});

test('canonical product id preserves product edition words', () => {
  const xiang = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });
  const ying = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
  });
  const qingdian = buildCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（庆典版）',
  });

  assert.notEqual(xiang, ying);
  assert.notEqual(xiang, qingdian);
  assert.notEqual(ying, qingdian);
});

test('canonical product id helper returns empty id without official product source', () => {
  assert.equal(canonicalProductIdFromOfficialProduct({ company: '新华保险', productName: '' }), '');
  assert.equal(canonicalProductIdFromOfficialProduct({ company: '', productName: '测试产品' }), '');
});

test('normalize canonical product part removes spacing but keeps version markers', () => {
  assert.equal(
    normalizeCanonicalProductPart(' 多 倍 保障 重大疾病保险（智享版） '),
    '多倍保障重大疾病保险(智享版)',
  );
});

test('withCanonicalProductId fills missing id and preserves existing id', () => {
  const filled = withCanonicalProductId({
    company: '新华保险',
    productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
  });
  const preserved = withCanonicalProductId({
    company: '新华保险',
    productName: '不同产品',
    canonicalProductId: 'product_existing',
  });

  assert.match(filled.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(preserved.canonicalProductId, 'product_existing');
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node --test tests/canonical-product-id.test.mjs
```

Expected: FAIL with `Cannot find module '../server/canonical-product-id.mjs'`.

- [ ] **Step 3: Implement the utility**

Create `server/canonical-product-id.mjs`:

```js
import { createHash } from 'node:crypto';

function trim(value) {
  return String(value || '').trim();
}

export function normalizeCanonicalProductPart(value) {
  return trim(value)
    .normalize('NFKC')
    .replace(/[（]/gu, '(')
    .replace(/[）]/gu, ')')
    .replace(/\s+/gu, '');
}

export function buildCanonicalProductId({ company = '', productName = '' } = {}) {
  const normalizedCompany = normalizeCanonicalProductPart(company);
  const normalizedProductName = normalizeCanonicalProductPart(productName);
  if (!normalizedCompany || !normalizedProductName) return '';
  const digest = createHash('sha1')
    .update(`${normalizedCompany}\u001f${normalizedProductName}`)
    .digest('hex')
    .slice(0, 16);
  return `product_${digest}`;
}

export function canonicalProductIdFromOfficialProduct({ company = '', productName = '' } = {}) {
  return buildCanonicalProductId({ company, productName });
}

export function resolveRecordProductName(record = {}) {
  return trim(record.productName || record.product_name || record.matchedProductName);
}

export function resolveRecordCompany(record = {}, fallbackCompany = '') {
  return trim(record.company || record.companyName || fallbackCompany);
}

export function withCanonicalProductId(record = {}, fallbackCompany = '') {
  const existing = trim(record.canonicalProductId || record.productId);
  if (existing) return { ...record, canonicalProductId: existing };
  const company = resolveRecordCompany(record, fallbackCompany);
  const productName = resolveRecordProductName(record);
  const canonicalProductId = canonicalProductIdFromOfficialProduct({ company, productName });
  return canonicalProductId ? { ...record, canonicalProductId } : { ...record };
}

export function canonicalProductIdForRecord(record = {}, fallbackCompany = '') {
  return trim(record.canonicalProductId || record.productId)
    || withCanonicalProductId(record, fallbackCompany).canonicalProductId
    || '';
}
```

- [ ] **Step 4: Run utility tests**

Run:

```bash
node --test tests/canonical-product-id.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

Run:

```bash
git add server/canonical-product-id.mjs tests/canonical-product-id.test.mjs
git commit -m "feat: add canonical product id utility"
```

---

### Task 2: OCR Product Matching Returns IDs

**Files:**
- Modify: `server/policy-ocr-mapping.mjs`
- Modify: `tests/policy-ocr-mapping.test.mjs`

- [ ] **Step 1: Add failing assertions to OCR mapping tests**

In `tests/policy-ocr-mapping.test.mjs`, update the test `OCR mapping infers insurer and matched products from recognized plan names`:

```js
  assert.match(mapped.data.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(mapped.data.canonicalProductId, mapped.data.plans[0].canonicalProductId);
  assert.match(mapped.data.plans[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.match(mapped.data.plans[1].canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(mapped.data.plans[0].canonicalProductId, mapped.data.plans[1].canonicalProductId);
```

Add a second test near the New China OCR mapping tests:

```js
test('OCR mapping gives similar New China product editions different canonical ids', () => {
  const state = {
    policies: [],
    knowledgeRecords: [
      { company: '新华保险', productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）' },
      { company: '新华保险', productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）' },
      { company: '新华保险', productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（庆典版）' },
    ],
  };
  const xiang = enhancePolicyScanWithOcrMapping({
    state,
    scan: {
      ocrText: '新华保险 多倍保障重大疾病保险（智享版） 基本责任和可选责任',
      data: {
        company: '新华保险',
        name: '多倍保障重大疾病保险（智享版）',
        plans: [{ role: 'main', name: '多倍保障重大疾病保险（智享版）' }],
      },
    },
  });
  const ying = enhancePolicyScanWithOcrMapping({
    state,
    scan: {
      ocrText: '新华保险 多倍保障重大疾病保险（智赢版） 基本责任和可选责任',
      data: {
        company: '新华保险',
        name: '多倍保障重大疾病保险（智赢版）',
        plans: [{ role: 'main', name: '多倍保障重大疾病保险（智赢版）' }],
      },
    },
  });

  assert.equal(xiang.data.name, '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）');
  assert.equal(ying.data.name, '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）');
  assert.match(xiang.data.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.match(ying.data.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.notEqual(xiang.data.canonicalProductId, ying.data.canonicalProductId);
});
```

- [ ] **Step 2: Run mapping tests to verify failure**

Run:

```bash
node --test tests/policy-ocr-mapping.test.mjs
```

Expected: FAIL because `canonicalProductId` is undefined.

- [ ] **Step 3: Thread ids through OCR mapping**

Modify `server/policy-ocr-mapping.mjs`.

Add import:

```js
import { canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
```

In `buildKnownProductStats`, store ids:

```js
    const canonicalProductId = canonicalProductIdFromOfficialProduct({
      company: sourceCompany,
      productName: name,
    });
    const current = stats.get(key) || {
      company: sourceCompany,
      productName: name,
      canonicalProductId,
      recordCount: 0,
    };
```

In `matchInsuranceProductFromOcr`, include the id in each match:

```js
      matches.push({
        company: product.company,
        productName: product.productName,
        canonicalProductId: product.canonicalProductId || canonicalProductIdFromOfficialProduct({
          company: product.company,
          productName: product.productName,
        }),
        keyword: keyword.raw,
        score: keyword.normalized.length * 2 + Math.min(product.recordCount, 20) / 10,
      });
```

In `normalizePolicyPlan`, preserve existing ids:

```js
    canonicalProductId: trim(plan.canonicalProductId),
```

In `attachPlanProductMatches`, set the id:

```js
      canonicalProductId: match.canonicalProductId || canonicalProductIdFromOfficialProduct({
        company: match.company || plan.company || company,
        productName: match.productName,
      }),
```

In `enhancePolicyScanWithOcrMapping`, after `productMatch`, resolve the main id:

```js
  const canonicalProductId =
    productMatch?.canonicalProductId
    || mainPlan?.canonicalProductId
    || '';
```

Then add it to returned data:

```js
      ...(canonicalProductId ? { canonicalProductId } : {}),
```

- [ ] **Step 4: Run mapping tests**

Run:

```bash
node --test tests/policy-ocr-mapping.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

Run:

```bash
git add server/policy-ocr-mapping.mjs tests/policy-ocr-mapping.test.mjs
git commit -m "feat: attach canonical product ids during ocr mapping"
```

---

### Task 3: Product Suggestions And Matches Expose IDs

**Files:**
- Modify: `server/policy-knowledge.service.mjs`
- Modify: `server/app.mjs`
- Modify: `src/api.ts`
- Modify: `tests/policy-responsibility-query.test.mjs`
- Modify: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add failing service test for local product candidates**

In `tests/policy-responsibility-query.test.mjs`, add assertions to `knowledge product candidates fuzzy match similar local official products`:

```js
  for (const match of matches) {
    assert.match(match.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  }
  const zunxiang = matches.find((match) => match.productName === '尊享人生年金保险（分红型）');
  const zunshang = matches.find((match) => match.productName === '新华人寿保险股份有限公司尊尚人生两全保险（分红型）');
  assert.notEqual(zunxiang.canonicalProductId, zunshang.canonicalProductId);
```

- [ ] **Step 2: Add failing route test for product suggestions**

In `tests/policy-ocr-flow.test.mjs`, add a route test near existing product suggestion tests:

```js
test('product suggestions return canonical product id', async () => {
  const app = createTestApp({
    state: {
      ...createInitialState(),
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
          title: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/xiang.pdf',
          pageText: '保险责任。',
          official: true,
          sourceType: 'pdf',
          materialType: 'terms',
        },
      ],
    },
  });

  const response = await request(app)
    .get('/api/policy-responsibilities/product-suggestions')
    .query({ company: '新华保险', q: '多倍保障', limit: 10 });

  assert.equal(response.status, 200);
  assert.equal(response.body.suggestions[0].productName, '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）');
  assert.match(response.body.suggestions[0].canonicalProductId, /^product_[a-f0-9]{16}$/u);
});
```

If this test file does not use `request(app).get().query()`, adapt only the request wrapper to the file's existing HTTP test style. Keep the assertions exactly as above.

- [ ] **Step 3: Run focused tests to verify failure**

Run:

```bash
node --test tests/policy-responsibility-query.test.mjs tests/policy-ocr-flow.test.mjs
```

Expected: FAIL because candidates and suggestions do not include `canonicalProductId`.

- [ ] **Step 4: Add ids to knowledge candidates**

Modify `server/policy-knowledge.service.mjs`.

Add import:

```js
import { canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
```

Inside `findKnowledgeProductCandidates`, when creating a grouped item, add:

```js
        canonicalProductId: canonicalProductIdFromOfficialProduct({
          company: record.company,
          productName: record.productName,
        }),
```

When returning mapped values, preserve it:

```js
      canonicalProductId: item.canonicalProductId || canonicalProductIdFromOfficialProduct({
        company: item.company,
        productName: item.productName,
      }),
```

- [ ] **Step 5: Add ids to product suggestions**

Modify `server/app.mjs`.

Add import:

```js
import { canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
```

In `buildResponsibilityProductSuggestions`, change the final map:

```js
    .map(({ company: itemCompany, productName, recordCount }) => ({
      company: itemCompany,
      productName,
      recordCount,
      canonicalProductId: canonicalProductIdFromOfficialProduct({
        company: itemCompany,
        productName,
      }),
    }));
```

- [ ] **Step 6: Add frontend API types**

Modify `src/api.ts`.

In `PolicyKnowledgeMatch`, add:

```ts
  canonicalProductId?: string;
```

In `PolicyProductSuggestion`, add:

```ts
  canonicalProductId?: string;
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test tests/policy-responsibility-query.test.mjs tests/policy-ocr-flow.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 3**

Run:

```bash
git add server/policy-knowledge.service.mjs server/app.mjs src/api.ts tests/policy-responsibility-query.test.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: expose canonical product ids in product lookup"
```

---

### Task 4: Preserve IDs In Policy Normalization And Frontend Form State

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Modify: `src/api.ts`
- Modify: `src/App.tsx`
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing source-style tests for frontend preservation**

In `tests/customer-ui-style.test.mjs`, add a source inspection test:

```js
test('entry form preserves canonical product id and clears it when product name changes', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(source, /canonicalProductId: String\\(plan\\?\\.canonicalProductId \\|\\| ''\\)\\.trim\\(\\)/u);
  assert.match(source, /matchedProductName: productChanged \\? '' : plan\\.matchedProductName/u);
  assert.match(source, /canonicalProductId: productChanged \\? '' : plan\\.canonicalProductId/u);
  assert.match(source, /canonicalProductId: String\\(match\\.canonicalProductId \\|\\| ''\\)\\.trim\\(\\)/u);
  assert.match(source, /canonicalProductId: String\\(suggestion\\.canonicalProductId \\|\\| ''\\)\\.trim\\(\\)/u);
});
```

If `readFileSync` is not imported at the top of the file, add:

```js
import { readFileSync } from 'node:fs';
```

- [ ] **Step 2: Add failing backend normalization assertions**

In an existing backend normalization test in `tests/policy-ocr-flow.test.mjs`, add a saved policy assertion after OCR scan save:

```js
assert.match(saved.payload.policy.canonicalProductId, /^product_[a-f0-9]{16}$/u);
assert.equal(saved.payload.policy.canonicalProductId, saved.payload.policy.plans[0].canonicalProductId);
```

Choose a test that already saves an OCR-mapped policy with `matchedProductName`, such as the New China plan mapping flow.

- [ ] **Step 3: Run focused tests to verify failure**

Run:

```bash
node --test tests/customer-ui-style.test.mjs tests/policy-ocr-flow.test.mjs
```

Expected: FAIL because ids are not preserved through form and backend normalization.

- [ ] **Step 4: Preserve ids in backend plan normalization**

Modify `server/policy-ocr.domain.mjs`.

In `normalizePolicyPlans`, add:

```js
        canonicalProductId: String(plan?.canonicalProductId || '').trim(),
```

Modify `server/app.mjs`.

In `normalizePolicyScanData`, include:

```js
  const canonicalProductId = trim(value.canonicalProductId);
  if (canonicalProductId) data.canonicalProductId = canonicalProductId;
```

Inside scan-data plan mapping, add:

```js
        canonicalProductId: trim(plan?.canonicalProductId),
```

In `normalizePolicyUpdateData`, add:

```js
  if (hasOwn(input, 'canonicalProductId')) data.canonicalProductId = trim(input.canonicalProductId);
```

After normalizing plans, mirror the main plan id when present:

```js
  if (Array.isArray(data.plans) && data.plans.length && !data.canonicalProductId) {
    const primaryPlan = data.plans.find((plan) => plan.role === 'main') || data.plans[0];
    if (primaryPlan?.canonicalProductId) data.canonicalProductId = primaryPlan.canonicalProductId;
  }
```

- [ ] **Step 5: Add frontend API type fields**

Modify `src/api.ts`.

In `Policy`, `PolicyScanData`, `PolicyFormData`, and `PolicyPlan`, add:

```ts
  canonicalProductId?: string;
```

- [ ] **Step 6: Preserve ids in frontend form normalization**

Modify `src/App.tsx`.

In `normalizePolicyPlanList`, add:

```ts
      canonicalProductId: String(plan?.canonicalProductId || '').trim(),
```

In `policyToForm`, add:

```ts
    canonicalProductId: policy.canonicalProductId || '',
```

In `buildPolicyUpdateData`, when product changes for the main plan, clear the id too:

```ts
        matchedProductName: productChanged ? '' : plan.matchedProductName,
        canonicalProductId: productChanged ? '' : plan.canonicalProductId,
```

In `scanToForm`, make sure `canonicalProductId` is copied from scan data:

```ts
    canonicalProductId: String(data.canonicalProductId || ''),
```

- [ ] **Step 7: Set ids when selecting local products**

Modify `src/App.tsx`.

In `selectFormProductMatch`, resolve:

```ts
    const canonicalProductId = String(match.canonicalProductId || '').trim();
    const nextPlans = normalizePolicyPlanList(formData.plans, company, { keepEmpty: true });
    const primaryIndex = Math.max(0, nextPlans.findIndex((plan) => plan.role === 'main'));
    const plans = nextPlans.length
      ? nextPlans.map((plan, index) => index === primaryIndex
        ? { ...plan, company, name, matchedProductName: name, canonicalProductId }
        : plan)
      : [{
          company,
          role: 'main',
          name,
          matchedProductName: name,
          canonicalProductId,
          productType: '',
          amount: '',
          coveragePeriod: '',
          paymentMode: '',
          paymentPeriod: '',
          premium: '',
          premiumText: '',
          matchScore: Number(match.score || 0) || 0,
          matchReason: match.matchReason || '本地产品名称匹配',
        }];
    const nextData = { ...formData, company, name, canonicalProductId, plans };
```

In `selectFormProductSuggestion`, use the same shape with:

```ts
    const canonicalProductId = String(suggestion.canonicalProductId || '').trim();
```

- [ ] **Step 8: Run focused tests**

Run:

```bash
node --test tests/customer-ui-style.test.mjs tests/policy-ocr-flow.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

Run:

```bash
git add server/app.mjs server/policy-ocr.domain.mjs src/api.ts src/App.tsx tests/customer-ui-style.test.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: preserve canonical product ids in policy forms"
```

---

### Task 5: ID-First Indicator And Optional Responsibility Matching

**Files:**
- Modify: `server/policy-ocr.domain.mjs`
- Modify: `server/optional-responsibility-governance.mjs`
- Modify: `tests/policy-optional-responsibility.test.mjs`
- Modify: `tests/optional-responsibility-governance.test.mjs`

- [ ] **Step 1: Add failing test for similar products not sharing indicators**

In `tests/policy-optional-responsibility.test.mjs`, add:

```js
test('canonical product id prevents similar product editions from sharing optional indicators', () => {
  const xiangId = 'product_xiang';
  const yingId = 'product_ying';
  const policy = {
    company: '新华保险',
    name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
    canonicalProductId: xiangId,
    plans: [
      {
        role: 'main',
        company: '新华保险',
        name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        matchedProductName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        canonicalProductId: xiangId,
      },
    ],
    optionalResponsibilities: [
      {
        id: 'opt_xiang_2',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        canonicalProductId: xiangId,
        liability: '可选责任二',
        selectionStatus: 'selected',
        quantificationStatus: 'quantified',
        indicatorIds: ['ind_xiang_cancer'],
      },
    ],
  };
  const indicators = findPolicyCoverageIndicators(policy, [
    {
      id: 'ind_xiang_cancer',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      canonicalProductId: xiangId,
      coverageType: '重大疾病保障',
      liability: '重度恶性肿瘤多次给付保险金',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_xiang_2',
      quantificationStatus: 'quantified',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
    },
    {
      id: 'ind_ying_cancer',
      company: '新华保险',
      productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
      canonicalProductId: yingId,
      coverageType: '重大疾病保障',
      liability: '重度恶性肿瘤多次给付保险金',
      responsibilityScope: 'optional',
      optionalResponsibilityId: 'opt_ying_2',
      quantificationStatus: 'quantified',
      value: 100,
      unit: '%',
      basis: '基本保险金额',
    },
  ]);

  assert.deepEqual(indicators.map((item) => item.id), ['ind_xiang_cancer']);
  assert.deepEqual(selectedCoverageIndicators(indicators).map((item) => item.id), ['ind_xiang_cancer']);
});
```

- [ ] **Step 2: Add failing test for optional responsibility review by id**

In `tests/optional-responsibility-governance.test.mjs`, add:

```js
test('optional responsibility review matches records by canonical product id before name fallback', () => {
  const records = buildOptionalResponsibilityReview(
    {
      company: '新华保险',
      name: 'OCR短名',
      canonicalProductId: 'product_xiang',
      plans: [
        {
          role: 'main',
          company: '新华保险',
          name: 'OCR短名',
          matchedProductName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
          canonicalProductId: 'product_xiang',
        },
      ],
    },
    [],
    [],
    [
      {
        id: 'opt_xiang_1',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
        canonicalProductId: 'product_xiang',
        liability: '可选责任一',
        quantificationStatus: 'quantified',
      },
      {
        id: 'opt_ying_1',
        company: '新华保险',
        productName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智赢版）',
        canonicalProductId: 'product_ying',
        liability: '可选责任一',
        quantificationStatus: 'quantified',
      },
    ],
  );

  assert.deepEqual(records.map((record) => record.id), ['opt_xiang_1']);
});
```

- [ ] **Step 3: Run focused tests to verify failure**

Run:

```bash
node --test tests/policy-optional-responsibility.test.mjs tests/optional-responsibility-governance.test.mjs
```

Expected: FAIL because id-first matching is not implemented.

- [ ] **Step 4: Implement id-aware policy product identities**

Modify `server/policy-ocr.domain.mjs`.

Add import:

```js
import { canonicalProductIdForRecord, canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
```

Add helper near `policyProductIndicatorKeys`:

```js
function policyCanonicalProductIds(policy = {}) {
  const ids = [];
  const addId = (value) => {
    const id = String(value || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  const addOfficialProduct = (company, productName) => {
    const id = canonicalProductIdFromOfficialProduct({ company: company || policy.company, productName });
    addId(id);
  };

  addId(policy.canonicalProductId);
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    addId(plan?.canonicalProductId);
    addOfficialProduct(plan?.company || policy.company, plan?.matchedProductName);
  }
  return ids;
}
```

Keep `policyProductIndicatorKeys` for strict fallback.

Update `findPolicyCoverageIndicators`:

```js
export function findPolicyCoverageIndicators(policy = {}, indicatorRecords = []) {
  const ids = new Set(policyCanonicalProductIds(policy));
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!ids.size && !keys.size) return [];
  return dedupePolicyIndicatorRows(
    (Array.isArray(indicatorRecords) ? indicatorRecords : []).filter((record) => {
      const recordId = canonicalProductIdForRecord(record);
      if (ids.size && recordId && ids.has(recordId)) return true;
      return keys.has(`${normalizeLookupText(record?.company)}\u001f${normalizeLookupText(record?.productName)}`);
    }),
  ).map((record) => annotateCoverageIndicatorSelection(policy, record));
}
```

- [ ] **Step 5: Implement id-aware optional responsibility matching**

Modify `server/policy-ocr.domain.mjs`.

Update `optionalResponsibilityRecordMatchesPolicy`:

```js
function optionalResponsibilityRecordMatchesPolicy(policy = {}, record = {}) {
  const ids = new Set(policyCanonicalProductIds(policy));
  const recordId = canonicalProductIdForRecord(record);
  if (ids.size && recordId && ids.has(recordId)) return true;
  const keys = new Set(policyProductIndicatorKeys(policy));
  if (!keys.size) return false;
  const company = normalizeLookupText(record?.company || policy.company);
  const productName = normalizeLookupText(record?.productName || record?.name || record?.title);
  return productName && keys.has(`${company}\u001f${productName}`);
}
```

Modify `server/optional-responsibility-governance.mjs` similarly if it has its own product match helper:

```js
import { canonicalProductIdForRecord, canonicalProductIdFromOfficialProduct } from './canonical-product-id.mjs';
```

Use ids before name keys:

```js
function policyCanonicalProductIds(policy = {}) {
  const ids = [];
  const add = (value) => {
    const id = String(value || '').trim();
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(policy.canonicalProductId);
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    add(plan?.canonicalProductId);
    add(canonicalProductIdFromOfficialProduct({
      company: plan?.company || policy.company,
      productName: plan?.matchedProductName,
    }));
  }
  return ids;
}
```

Then in record filtering:

```js
const policyIds = new Set(policyCanonicalProductIds(policy));
const recordId = canonicalProductIdForRecord(record);
if (policyIds.size && recordId && !policyIds.has(recordId)) return false;
```

Keep existing strict name fallback when either side lacks ids.

- [ ] **Step 6: Ensure annotated indicators carry ids**

In `annotateCoverageIndicatorSelection` or the object returned from indicator normalization, include:

```js
canonicalProductId: canonicalProductIdForRecord(record),
```

In optional responsibility review items, include:

```js
canonicalProductId: canonicalProductIdForRecord(record),
```

- [ ] **Step 7: Run focused tests**

Run:

```bash
node --test tests/policy-optional-responsibility.test.mjs tests/optional-responsibility-governance.test.mjs
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

Run:

```bash
git add server/policy-ocr.domain.mjs server/optional-responsibility-governance.mjs tests/policy-optional-responsibility.test.mjs tests/optional-responsibility-governance.test.mjs
git commit -m "feat: match policy indicators by canonical product id"
```

---

### Task 6: Main-Product Optional Responsibilities Survive Rider Deletion

**Files:**
- Modify: `src/App.tsx`
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add failing source-style test for rider deletion behavior**

In `tests/customer-ui-style.test.mjs`, add:

```js
test('deleting a rider does not force-refresh optional responsibilities when main product is unchanged', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');

  assert.match(source, /function mainProductIdentityKey\\(/u);
  assert.match(source, /const beforeMainProductKey = mainProductIdentityKey\\(formData\\)/u);
  assert.match(source, /const afterMainProductKey = mainProductIdentityKey\\(nextData\\)/u);
  assert.match(source, /if \\(beforeMainProductKey !== afterMainProductKey\\)/u);
  assert.doesNotMatch(source, /已删除附加险，正在重新带出可选责任['"`]\\);\\s*void loadFormProductAnalysisDraft\\(nextData/u);
});
```

- [ ] **Step 2: Run frontend style test to verify failure**

Run:

```bash
node --test tests/customer-ui-style.test.mjs
```

Expected: FAIL because `removePolicyPlan` still refreshes unconditionally.

- [ ] **Step 3: Add main product identity helper**

Modify `src/App.tsx`.

Add near `primaryPlanFromPolicyForm`:

```ts
function mainProductIdentityKey(form: PolicyFormData) {
  const primary = primaryPlanFromPolicyForm(form);
  return [
    String(primary?.canonicalProductId || form.canonicalProductId || '').trim(),
    String(primary?.matchedProductName || '').trim(),
    String(primary?.company || form.company || '').trim(),
    String(primary?.name || form.name || '').trim(),
  ].join('\u001f');
}
```

- [ ] **Step 4: Guard rider deletion refresh**

Modify `removePolicyPlan` in `src/App.tsx`:

```ts
  function removePolicyPlan(index: number) {
    setShowAnalysisReport(false);
    const beforeMainProductKey = mainProductIdentityKey(formData);
    const plans = normalizePolicyPlanList(formData.plans, formData.company, { keepEmpty: true }).filter((_plan, planIndex) => planIndex !== index);
    const primary = plans.find((plan) => plan.role === 'main') || plans[0] || null;
    const nextData = {
      ...formData,
      plans,
      ...(primary
        ? {
            name: primary.matchedProductName || primary.name || formData.name,
            canonicalProductId: primary.canonicalProductId || formData.canonicalProductId,
            amount: primary.amount ? String(primary.amount) : formData.amount,
            coveragePeriod: primary.coveragePeriod || formData.coveragePeriod,
            paymentPeriod: primary.paymentPeriod || formData.paymentPeriod,
          }
        : {}),
    };
    const afterMainProductKey = mainProductIdentityKey(nextData);
    setFormData(nextData);
    if (beforeMainProductKey !== afterMainProductKey) {
      setMessage('已删除险种，正在重新带出可选责任');
      void loadFormProductAnalysisDraft(nextData, '已删除险种，已重新带出可选责任');
      return;
    }
    setMessage('已删除附加险');
  }
```

- [ ] **Step 5: Run frontend tests**

Run:

```bash
node --test tests/customer-ui-style.test.mjs
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 6**

Run:

```bash
git add src/App.tsx tests/customer-ui-style.test.mjs
git commit -m "fix: keep main optional responsibilities when deleting riders"
```

---

### Task 7: SQLite Backfill Script

**Files:**
- Create: `scripts/backfill-canonical-product-ids.mjs`
- Create or Modify: `tests/canonical-product-id.test.mjs`

- [ ] **Step 1: Add helper test for payload backfill behavior**

In `tests/canonical-product-id.test.mjs`, add:

```js
import {
  backfillCanonicalProductIdsInObject,
} from '../scripts/backfill-canonical-product-ids.mjs';

test('backfill helper adds ids to policy and plan payload without changing names', () => {
  const input = {
    company: '新华保险',
    name: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
    plans: [
      {
        role: 'main',
        company: '新华保险',
        name: '多倍保障重大疾病保险（智享版）',
        matchedProductName: '新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）',
      },
    ],
  };

  const output = backfillCanonicalProductIdsInObject(input);

  assert.equal(output.name, input.name);
  assert.match(output.canonicalProductId, /^product_[a-f0-9]{16}$/u);
  assert.equal(output.canonicalProductId, output.plans[0].canonicalProductId);
});
```

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
node --test tests/canonical-product-id.test.mjs
```

Expected: FAIL because the script does not exist or helper is not exported.

- [ ] **Step 3: Implement the backfill script**

Create `scripts/backfill-canonical-product-ids.mjs`:

```js
#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { canonicalProductIdFromOfficialProduct, withCanonicalProductId } from '../server/canonical-product-id.mjs';

function parseJson(value) {
  try {
    return value ? JSON.parse(value) : {};
  } catch {
    return {};
  }
}

function stringify(value) {
  return JSON.stringify(value);
}

function trim(value) {
  return String(value || '').trim();
}

function backfillPlan(plan = {}, fallbackCompany = '') {
  const productName = trim(plan.matchedProductName || plan.productName);
  const canonicalProductId = trim(plan.canonicalProductId)
    || canonicalProductIdFromOfficialProduct({
      company: trim(plan.company || fallbackCompany),
      productName,
    });
  return canonicalProductId ? { ...plan, canonicalProductId } : { ...plan };
}

export function backfillCanonicalProductIdsInObject(input = {}) {
  const record = { ...input };
  const company = trim(record.company);
  if (!record.canonicalProductId) {
    const productName = trim(record.productName || record.product_name || record.matchedProductName || record.name);
    const id = canonicalProductIdFromOfficialProduct({ company, productName });
    if (id) record.canonicalProductId = id;
  }
  if (Array.isArray(record.plans)) {
    record.plans = record.plans.map((plan) => backfillPlan(plan, company));
    const primary = record.plans.find((plan) => plan.role === 'main') || record.plans[0];
    if (!record.canonicalProductId && primary?.canonicalProductId) {
      record.canonicalProductId = primary.canonicalProductId;
    }
  }
  return record;
}

function updatePayloadTable(db, tableName, idColumn = 'id', dryRun = true) {
  const rows = db.prepare(`SELECT ${idColumn} AS id, company, product_name, payload FROM ${tableName}`).all();
  const update = db.prepare(`UPDATE ${tableName} SET payload = ? WHERE ${idColumn} = ?`);
  let changed = 0;
  for (const row of rows) {
    const payload = parseJson(row.payload);
    const next = backfillCanonicalProductIdsInObject({
      ...payload,
      company: payload.company || row.company,
      productName: payload.productName || row.product_name,
    });
    if (JSON.stringify(payload) === JSON.stringify(next)) continue;
    changed += 1;
    if (!dryRun) update.run(stringify(next), row.id);
  }
  return changed;
}

function updatePolicies(db, dryRun = true) {
  const rows = db.prepare('SELECT id, company, name, payload FROM policies').all();
  const update = db.prepare('UPDATE policies SET payload = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    const payload = parseJson(row.payload);
    const next = backfillCanonicalProductIdsInObject({
      ...payload,
      company: payload.company || row.company,
      name: payload.name || row.name,
    });
    if (JSON.stringify(payload) === JSON.stringify(next)) continue;
    changed += 1;
    if (!dryRun) update.run(stringify(next), row.id);
  }
  return changed;
}

export function backfillDatabase(dbPath, { dryRun = true } = {}) {
  const db = new DatabaseSync(dbPath);
  const result = {};
  db.exec('BEGIN IMMEDIATE');
  try {
    result.knowledgeRecords = updatePayloadTable(db, 'knowledge_records', 'id', dryRun);
    result.insuranceIndicatorRecords = updatePayloadTable(db, 'insurance_indicator_records', 'id', dryRun);
    result.optionalResponsibilityRecords = updatePayloadTable(db, 'optional_responsibility_records', 'id', dryRun);
    result.policies = updatePolicies(db, dryRun);
    if (dryRun) db.exec('ROLLBACK');
    else db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dbArgIndex = process.argv.indexOf('--db');
  const dbPath = dbArgIndex >= 0 ? process.argv[dbArgIndex + 1] : '';
  const write = process.argv.includes('--write');
  if (!dbPath) {
    console.error('Usage: node scripts/backfill-canonical-product-ids.mjs --db <path> [--write]');
    process.exit(1);
  }
  const result = backfillDatabase(dbPath, { dryRun: !write });
  console.log(JSON.stringify({ dryRun: !write, ...result }, null, 2));
}
```

- [ ] **Step 4: Run unit test**

Run:

```bash
node --test tests/canonical-product-id.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Dry-run backfill against dev and prod DBs**

Run:

```bash
node scripts/backfill-canonical-product-ids.mjs --db .runtime/local/policy-ocr.sqlite
node scripts/backfill-canonical-product-ids.mjs --db .runtime/policy-ocr.sqlite
```

Expected: JSON output with `dryRun: true` and changed counts. The DB files should not be modified.

- [ ] **Step 6: Commit Task 7**

Run:

```bash
git add scripts/backfill-canonical-product-ids.mjs tests/canonical-product-id.test.mjs
git commit -m "feat: add canonical product id backfill"
```

---

### Task 8: Full Validation And Backfill Execution Decision

**Files:**
- No new source files unless previous tasks exposed missed type/test fixes.

- [ ] **Step 1: Run full automated checks**

Run:

```bash
npm run check
npm run typecheck
npm test
```

Expected: all PASS.

- [ ] **Step 2: Build frontend**

Run:

```bash
npm run build
```

Expected: Vite build succeeds.

- [ ] **Step 3: Inspect current stack status**

Run:

```bash
npm run local:status
```

Expected: identify dev/prod ports before browser verification.

- [ ] **Step 4: Start dev stack if needed**

Run only if dev stack is not running:

```bash
npm run local:dev
```

Expected: frontend and API start on the configured dev ports.

- [ ] **Step 5: Browser verification**

Use the local frontend and verify:

1. OCR or manual entry for `新华人寿保险股份有限公司多倍保障重大疾病保险（智享版）` stays on the policy entry page.
2. Main product area shows the matched official product.
3. Optional responsibility confirmation appears in the main product area.
4. `可选责任一` and `可选责任二` are visible.
5. Add a rider, then delete the rider. Optional responsibilities remain visible.
6. Select `可选责任二` and save.
7. Confirm the saved policy/report includes the `重度恶性肿瘤多次给付保险金` indicator and does not pull `智赢版` or `庆典版` indicators.

- [ ] **Step 6: Decide whether to write backfill to DB**

If code validation passes, ask the user before mutating real SQLite files:

```text
代码已经通过测试。现在是否执行 canonicalProductId 回填到 dev/prod SQLite？
```

Only run write mode after explicit approval:

```bash
node scripts/backfill-canonical-product-ids.mjs --db .runtime/local/policy-ocr.sqlite --write
node scripts/backfill-canonical-product-ids.mjs --db .runtime/policy-ocr.sqlite --write
```

- [ ] **Step 7: Final commit**

If Task 8 required follow-up fixes, commit them:

```bash
git add <changed-files>
git commit -m "test: validate canonical product id flow"
```

If there are no code changes after Task 7, skip this commit.

---

## Self-Review Checklist

- Spec requirement: stable `canonicalProductId` from official company + product name.
  - Covered by Task 1.
- Spec requirement: OCR returns `matchedProductName + canonicalProductId`.
  - Covered by Task 2.
- Spec requirement: manual product selection returns and stores ids.
  - Covered by Tasks 3 and 4.
- Spec requirement: optional responsibilities belong to main product and survive rider deletion.
  - Covered by Tasks 4 and 6.
- Spec requirement: report backend matches indicators and optional responsibilities by id first.
  - Covered by Task 5.
- Spec requirement: historical strict name fallback remains.
  - Covered by Task 5 and regression tests.
- Spec requirement: progressive backfill.
  - Covered by Task 7.
- Spec requirement: end-to-end acceptance for New China `智享版`.
  - Covered by Task 8.

No incomplete markers are intentional in this plan. If any exact line numbers drift before execution, locate the named function in the listed file and apply the shown code in that function only.
