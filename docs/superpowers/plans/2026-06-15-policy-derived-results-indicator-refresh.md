# Policy Derived Results Indicator Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist per-policy derived coverage results in SQLite and refresh only affected policies when product indicators change.

**Architecture:** Add a small derived-results domain module for product keys and payload assembly, extend the SQLite store with dedicated derived-result tables and narrow writers, then update policy read/write routes to use persisted derived results instead of re-matching large indicator and knowledge arrays on every list read. Indicator backfill writes will report changed product keys and can mark/recompute affected derived rows without blocking login or list reads.

**Tech Stack:** Node/Express ESM backend, Node `node:sqlite`, existing React/Vite frontend contracts, Node test runner, existing SQLite state store patterns.

---

## Files

- Create: `server/policy-derived-results.service.mjs`
  - Product key generation for policies and indicators.
  - Derived payload creation with `attachPolicyCoverageIndicators`.
  - Merge persisted derived rows into policy responses.
- Modify: `server/sqlite-state-store.mjs`
  - Add `policy_derived_results`, `product_indicator_versions`, and `indicator_update_batches` schema.
  - Load `policyDerivedResults` into state.
  - Add narrow writers for derived rows, indicator batches, product versions, and stale marking.
- Modify: `server/app.mjs`
  - Initialize `state.policyDerivedResults`.
  - Wire derived-result helpers and store methods into route context.
- Modify: `server/routes/policies.routes.mjs`
  - Save derived result when a policy is created.
  - Recompute derived result when a policy is updated.
  - Read list/detail responses from persisted derived result rows.
- Modify: `server/routes/auth.routes.mjs`
  - Stop using full indicator matching in login responses; return stored derived policy payloads when policies are returned, and support light login without policies.
- Modify: `src/api/client.ts`
  - Allow customer registration to request a light response.
- Modify: `src/apps/customer/CustomerApp.tsx`
  - Request light registration and let the existing background refresh load policies.
- Modify: `scripts/backfill-knowledge-responsibility-indicators.mjs`
  - Track changed product keys and expose affected-policy follow-up evidence.
- Modify tests:
  - `tests/policy-derived-results.test.mjs`
  - `tests/sqlite-state-store.test.mjs`
  - `tests/policy-ocr-flow.test.mjs`
  - `tests/backfill-knowledge-responsibility-indicators.test.mjs`
  - `tests/customer-ui-style.test.mjs`

## Scope Check

This is one subsystem: durable policy-derived result storage and invalidation. It touches auth/list performance because those routes currently compute derived results inline, but it does not change OCR, indicator extraction semantics, payment, SMS delivery, or family report persistence.

## Task 1: Product Key and Derived Payload Domain

**Files:**
- Create: `server/policy-derived-results.service.mjs`
- Test: `tests/policy-derived-results.test.mjs`

- [ ] **Step 1: Add tests for product keys and derived row merging**

Create `tests/policy-derived-results.test.mjs` with tests that import:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPolicyDerivedResult,
  deriveIndicatorProductKeys,
  derivePolicyProductKeys,
  mergePolicyDerivedResult,
  productKeyFromParts,
} from '../server/policy-derived-results.service.mjs';
```

Cover:

```js
test('product key prefers canonical product id and normalizes company product fallback', () => {
  assert.equal(productKeyFromParts({ canonicalProductId: 'product_abc' }), 'canonical:product_abc');
  assert.equal(productKeyFromParts({ company: ' 新华保险 ', productName: ' 多倍保障重大疾病保险 ' }), 'company_product:新华保险:多倍保障重大疾病保险');
});

test('policy product keys include main policy and plan products', () => {
  const keys = derivePolicyProductKeys({
    company: '新华保险',
    name: '多倍保障重大疾病保险',
    canonicalProductId: 'product_main',
    plans: [
      { name: '附加住院医疗', company: '新华保险' },
      { matchedProductName: '附加重疾豁免', canonicalProductId: 'product_rider' },
    ],
  });
  assert.deepEqual(keys, [
    'canonical:product_main',
    'company_product:新华保险:多倍保障重大疾病保险',
    'company_product:新华保险:附加住院医疗',
    'canonical:product_rider',
    'company_product:新华保险:附加重疾豁免',
  ]);
});

test('indicator product keys mirror policy key priority', () => {
  assert.deepEqual(deriveIndicatorProductKeys({ canonicalProductId: 'product_main', company: '新华保险', productName: '多倍保障重大疾病保险' }), [
    'canonical:product_main',
    'company_product:新华保险:多倍保障重大疾病保险',
  ]);
});

test('buildPolicyDerivedResult stores attached indicators and status metadata', () => {
  const policy = { id: 10, company: '新华保险', name: '多倍保障重大疾病保险', amount: 500000 };
  const indicator = { id: 'ind_1', company: '新华保险', productName: '多倍保障重大疾病保险', coverageType: '重疾', liability: '重大疾病保险金' };
  const row = buildPolicyDerivedResult({
    policy,
    indicatorRecords: [indicator],
    knowledgeRecords: [],
    optionalResponsibilityRecords: [],
    productIndicatorVersions: [{ productKey: 'company_product:新华保险:多倍保障重大疾病保险', version: 3 }],
    now: '2026-06-15T00:00:00.000Z',
  });
  assert.equal(row.policyId, 10);
  assert.equal(row.status, 'ready');
  assert.deepEqual(row.productKeys, ['company_product:新华保险:多倍保障重大疾病保险']);
  assert.equal(row.coverageIndicators.length, 1);
  assert.deepEqual(row.indicatorVersions, { 'company_product:新华保险:多倍保障重大疾病保险': 3 });
});

test('mergePolicyDerivedResult attaches persisted payload and derived status without recomputing', () => {
  const policy = { id: 10, company: '新华保险', name: '多倍保障重大疾病保险' };
  const merged = mergePolicyDerivedResult(policy, {
    policyId: 10,
    status: 'ready',
    staleReason: '',
    coverageIndicators: [{ id: 'ind_1' }],
    optionalResponsibilities: [{ id: 'opt_1' }],
    generatedAt: '2026-06-15T00:00:00.000Z',
  });
  assert.deepEqual(merged.coverageIndicators, [{ id: 'ind_1' }]);
  assert.deepEqual(merged.optionalResponsibilities, [{ id: 'opt_1' }]);
  assert.equal(merged.derivedStatus, 'ready');
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```bash
node --test tests/policy-derived-results.test.mjs
```

Expected: FAIL with module not found for `server/policy-derived-results.service.mjs`.

- [ ] **Step 3: Implement `server/policy-derived-results.service.mjs`**

Create the module with:

```js
import { attachPolicyCoverageIndicators } from './policy-ocr.domain.mjs';

function normalizeKeyPart(value) {
  return String(value || '').trim().replace(/\s+/gu, '');
}

function unique(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function productKeyFromParts({ canonicalProductId = '', company = '', productName = '' } = {}) {
  const canonical = String(canonicalProductId || '').trim();
  if (canonical) return `canonical:${canonical}`;
  const normalizedCompany = normalizeKeyPart(company);
  const normalizedProductName = normalizeKeyPart(productName);
  if (!normalizedCompany || !normalizedProductName) return '';
  return `company_product:${normalizedCompany}:${normalizedProductName}`;
}

export function deriveIndicatorProductKeys(indicator = {}) {
  return unique([
    productKeyFromParts({ canonicalProductId: indicator.canonicalProductId }),
    productKeyFromParts({ company: indicator.company, productName: indicator.productName }),
  ]);
}

export function derivePolicyProductKeys(policy = {}) {
  const keys = [
    productKeyFromParts({ canonicalProductId: policy.canonicalProductId }),
    productKeyFromParts({ company: policy.company, productName: policy.name }),
  ];
  for (const plan of Array.isArray(policy.plans) ? policy.plans : []) {
    keys.push(productKeyFromParts({ canonicalProductId: plan?.canonicalProductId }));
    keys.push(productKeyFromParts({
      company: plan?.company || policy.company,
      productName: plan?.matchedProductName || plan?.name,
    }));
  }
  return unique(keys);
}

export function buildPolicyDerivedResult({
  policy,
  indicatorRecords = [],
  knowledgeRecords = [],
  optionalResponsibilityRecords = [],
  productIndicatorVersions = [],
  now = new Date().toISOString(),
} = {}) {
  const productKeys = derivePolicyProductKeys(policy);
  const attached = attachPolicyCoverageIndicators(policy, indicatorRecords, knowledgeRecords, optionalResponsibilityRecords);
  const versionByKey = new Map((Array.isArray(productIndicatorVersions) ? productIndicatorVersions : []).map((row) => [
    String(row.productKey || row.product_key || '').trim(),
    Number(row.version || 0) || 0,
  ]));
  const indicatorVersions = {};
  for (const key of productKeys) indicatorVersions[key] = versionByKey.get(key) || 0;
  return {
    policyId: Number(policy?.id || 0),
    productKeys,
    coverageIndicators: Array.isArray(attached.coverageIndicators) ? attached.coverageIndicators : [],
    optionalResponsibilities: Array.isArray(attached.optionalResponsibilities) ? attached.optionalResponsibilities : [],
    indicatorVersions,
    knowledgeVersion: 0,
    status: 'ready',
    staleReason: '',
    generatedAt: now,
    error: '',
  };
}

export function mergePolicyDerivedResult(policy = {}, derived = null) {
  if (!derived) {
    return {
      ...policy,
      coverageIndicators: Array.isArray(policy.coverageIndicators) ? policy.coverageIndicators : [],
      optionalResponsibilities: Array.isArray(policy.optionalResponsibilities) ? policy.optionalResponsibilities : [],
      derivedStatus: 'stale',
      derivedStaleReason: 'missing',
    };
  }
  return {
    ...policy,
    coverageIndicators: Array.isArray(derived.coverageIndicators) ? derived.coverageIndicators : [],
    optionalResponsibilities: Array.isArray(derived.optionalResponsibilities) ? derived.optionalResponsibilities : [],
    derivedStatus: String(derived.status || 'stale'),
    derivedStaleReason: String(derived.staleReason || ''),
    derivedGeneratedAt: String(derived.generatedAt || ''),
    derivedError: String(derived.error || ''),
  };
}
```

- [ ] **Step 4: Verify the new domain tests pass**

Run:

```bash
node --test tests/policy-derived-results.test.mjs
```

Expected: PASS.

## Task 2: SQLite Tables and Narrow Store Methods

**Files:**
- Modify: `server/sqlite-state-store.mjs`
- Modify: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Add failing SQLite tests**

Append tests to `tests/sqlite-state-store.test.mjs` covering:

```js
test('sqlite store persists and reloads policy derived results', async () => {
  const { dbPath, cleanup } = testDbPath('policy-derived-results');
  try {
    const store = await createSqliteStateStore({ dbPath });
    const state = await store.load();
    const row = {
      policyId: 101,
      productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
      coverageIndicators: [{ id: 'ind_1' }],
      optionalResponsibilities: [{ id: 'opt_1' }],
      indicatorVersions: { 'company_product:新华保险:多倍保障重大疾病保险': 2 },
      knowledgeVersion: 0,
      status: 'ready',
      staleReason: '',
      generatedAt: '2026-06-15T00:00:00.000Z',
      error: '',
    };
    await store.persistPolicyDerivedResult({ state, derivedResult: row });
    const reloaded = await store.load();
    assert.equal(reloaded.policyDerivedResults.length, 1);
    assert.equal(reloaded.policyDerivedResults[0].policyId, 101);
    assert.deepEqual(reloaded.policyDerivedResults[0].coverageIndicators, [{ id: 'ind_1' }]);
  } finally {
    cleanup();
  }
});

test('sqlite store marks derived results stale by changed product keys', async () => {
  const { dbPath, cleanup } = testDbPath('policy-derived-stale');
  try {
    const store = await createSqliteStateStore({ dbPath });
    const state = await store.load();
    await store.persistPolicyDerivedResult({
      state,
      derivedResult: {
        policyId: 201,
        productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
        coverageIndicators: [],
        optionalResponsibilities: [],
        indicatorVersions: {},
        knowledgeVersion: 0,
        status: 'ready',
        staleReason: '',
        generatedAt: '2026-06-15T00:00:00.000Z',
        error: '',
      },
    });
    const marked = await store.markPolicyDerivedResultsStaleByProductKeys({
      state,
      productKeys: ['company_product:新华保险:多倍保障重大疾病保险'],
      staleReason: 'indicator_updated',
    });
    assert.deepEqual(marked.policyIds, [201]);
    const reloaded = await store.load();
    assert.equal(reloaded.policyDerivedResults[0].status, 'stale');
    assert.equal(reloaded.policyDerivedResults[0].staleReason, 'indicator_updated');
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Run the focused SQLite tests and verify they fail**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "policy derived"
```

Expected: FAIL because store methods and table do not exist.

- [ ] **Step 3: Add schema and loaders to `server/sqlite-state-store.mjs`**

Add `policyDerivedResults` to `DB_OWNED_KEYS`, create tables in `createSchema`, load derived rows in `loadDbOwnedState`, and add parser/serializer helpers for:

- `policy_derived_results`
- `product_indicator_versions`
- `indicator_update_batches`

Use JSON payload columns and keep functions local to this file.

- [ ] **Step 4: Add narrow store methods**

Add methods returned by `createSqliteStateStore`:

- `persistPolicyDerivedResult({ state, derivedResult })`
- `markPolicyDerivedResultsStaleByProductKeys({ state, productKeys, staleReason })`
- `upsertProductIndicatorVersions({ state, productKeys, batchId })`
- `recordIndicatorUpdateBatch({ state, batch })`

Each method must update both SQLite and the in-memory `state` arrays passed by the app.

- [ ] **Step 5: Verify SQLite tests pass**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "policy derived"
```

Expected: PASS.

## Task 3: Wire Derived Results Into Policy Create, Update, Detail, and List

**Files:**
- Modify: `server/app.mjs`
- Modify: `server/routes/policies.routes.mjs`
- Modify: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add failing flow tests**

Add tests to `tests/policy-ocr-flow.test.mjs` that prove:

- Saving a policy calls `persistPolicyDerivedResult`.
- `GET /api/policies` uses persisted `coverageIndicators`.
- `GET /api/policies` does not call the inline matcher when a derived result exists.
- Updating a policy recomputes and persists the derived result.

- [ ] **Step 2: Run focused tests and verify they fail**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "derived result"
```

Expected: FAIL because policy routes do not use derived results.

- [ ] **Step 3: Wire app context**

In `server/app.mjs`:

- initialize `state.policyDerivedResults = []` when missing;
- import derived helpers;
- create wrappers for `persistPolicyDerivedResult`;
- pass helper functions and store methods into route context.

- [ ] **Step 4: Update policy routes**

In `server/routes/policies.routes.mjs`:

- build derived result after policy save and persist it through `persistPolicyDerivedResult`;
- on policy update, rebuild and persist derived result after applying changes;
- list/detail responses should merge persisted derived rows with `mergePolicyDerivedResult`;
- only fall back to inline `attachPolicyCoverageIndicators` for the just-created or just-updated policy when the derived row was just computed in memory.

- [ ] **Step 5: Verify focused policy tests pass**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "derived result"
```

Expected: PASS.

## Task 4: Light Customer Login and Background Policy Loading

**Files:**
- Modify: `server/routes/auth.routes.mjs`
- Modify: `src/api/client.ts`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Modify: `tests/policy-ocr-flow.test.mjs`
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add tests for light register response**

Add backend and source-level frontend tests proving:

- `POST /api/auth/register` with `{ includePolicies: false }` returns token/user and no `policies` array.
- Customer app calls `register` with `includePolicies: false`.

- [ ] **Step 2: Implement light registration**

In `server/routes/auth.routes.mjs`, when `req.body?.includePolicies === false`, return:

```js
{
  ok: true,
  token,
  user: publicUser(user),
  migratedPolicyCount,
  policies: [],
  policiesDeferred: true
}
```

Do not call `attachPoliciesCoverageIndicators` in that branch.

- [ ] **Step 3: Update frontend register contract and caller**

In `src/api/client.ts`, accept `includePolicies?: boolean` on `register`.

In `CustomerApp.tsx`, call:

```ts
const payload = await register({ mobile: normalizedMobile, code: normalizedCode, guestId, includePolicies: false });
```

If `payload.policiesDeferred`, do not overwrite existing policy state with an empty array; let the existing token effect refresh policies.

- [ ] **Step 4: Run focused tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "register"
node --test tests/customer-ui-style.test.mjs --test-name-pattern "register"
```

Expected: PASS for the new focused tests.

## Task 5: Indicator Update Batch Follow-Up

**Files:**
- Modify: `scripts/backfill-knowledge-responsibility-indicators.mjs`
- Modify: `tests/backfill-knowledge-responsibility-indicators.test.mjs`

- [ ] **Step 1: Add tests for changed product keys**

Extend the backfill tests to assert that dry-run/write summaries include:

- `changedProductKeys`
- `changedProductKeyCount`
- `affectedPolicyCount` when a DB has matching `policy_derived_results`

- [ ] **Step 2: Implement changed product key tracking**

In the indicator backfill script:

- collect product keys for rows that would be inserted or updated;
- include them in the result summary;
- after write, call store methods or direct SQL helper to record the batch and mark affected policy rows stale.

- [ ] **Step 3: Verify focused backfill tests pass**

Run:

```bash
node --test tests/backfill-knowledge-responsibility-indicators.test.mjs
```

Expected: PASS.

## Task 6: Migration Script for Existing Policies

**Files:**
- Create: `scripts/backfill-policy-derived-results.mjs`
- Create: `tests/backfill-policy-derived-results.test.mjs`

- [ ] **Step 1: Add migration tests**

Test dry-run and write modes:

- dry-run reports candidate policy count and does not write rows;
- write creates `policy_derived_results`;
- rerun is idempotent.

- [ ] **Step 2: Implement migration script**

Create a script that:

- opens a SQLite DB path;
- loads state through `createSqliteStateStore`;
- builds missing/stale derived rows;
- writes with `persistPolicyDerivedResult`;
- prints JSON summary.

- [ ] **Step 3: Verify migration tests pass**

Run:

```bash
node --test tests/backfill-policy-derived-results.test.mjs
```

Expected: PASS.

## Task 7: Full Verification

**Files:**
- No additional files.

- [ ] **Step 1: Run targeted checks**

Run:

```bash
npm run check
npm run typecheck
node --test tests/policy-derived-results.test.mjs
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "policy derived"
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "derived result|register"
node --test tests/backfill-knowledge-responsibility-indicators.test.mjs
```

- [ ] **Step 2: Run broader required checks for cross-boundary change**

Run:

```bash
npm test
npm run build
```

- [ ] **Step 3: Report status**

Report:

- changed files;
- verification commands and outcomes;
- whether any pre-existing dirty worktree files were left untouched;
- whether local production was untouched.
