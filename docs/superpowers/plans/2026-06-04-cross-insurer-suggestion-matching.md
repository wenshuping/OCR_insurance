# Cross-Insurer Suggestion Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make insurer and product suggestion dropdowns work consistently across insurers by combining configured alias matching with conservative generic fallback matching, while keeping product suggestions scoped to the selected insurer.

**Architecture:** Suggestion ranking stays backend-owned. The backend resolves insurer candidates with a two-layer model, then ranks same-insurer product candidates with exact, contains, and fuzzy scoring. The frontend becomes a thin request-and-display layer and stops re-filtering backend suggestions.

**Tech Stack:** Node.js ESM, Express, React, TypeScript, Node test runner, Vite

---

## File Structure

### Files to Modify

- `server/policy-knowledge.service.mjs`
  - Keep shared insurer and product scoring helpers here
  - Add or refine generic company normalization and company suggestion scoring helpers
- `server/app.mjs`
  - Build ranked company and product suggestions using backend-owned match metadata
- `server/routes/responsibilities.routes.mjs`
  - Keep route surface stable while returning richer ranked payloads
- `src/api/contracts/responsibility.ts`
  - Add response typing for backend-provided `matchType`
- `src/apps/customer/CustomerApp.tsx`
  - Request live company suggestions and stop relying on preloaded company lists
- `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`
  - Render backend-ranked suggestions without local substring filtering
- `src/features/policy-entry/UploadPolicyPage.tsx`
  - Render backend-ranked suggestions without local substring filtering
- `src/features/policy-detail/PolicyDetailSheet.tsx`
  - Render backend-ranked suggestions without local substring filtering
- `src/shared/customer-policy-components.tsx`
  - Keep shared rider suggestion UI display-only
- `tests/policy-ocr-flow.test.mjs`
  - Add endpoint-level regression tests for company and product suggestions

### Files to Read During Implementation

- `server/c-policy-analysis.service.mjs`
  - Reuse default insurer alias and company alias profiles
- `docs/superpowers/specs/2026-06-04-cross-insurer-suggestion-matching-design.md`
  - Follow the approved design contract

---

### Task 1: Lock Down Backend Company Suggestion Behavior

**Files:**
- Modify: `tests/policy-ocr-flow.test.mjs`
- Modify: `server/policy-knowledge.service.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Add failing company suggestion regression tests**

Add or keep tests in `tests/policy-ocr-flow.test.mjs` that cover:

```js
test('responsibility assistant company suggestions honor insurer aliases', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          title: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/health-a.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/company-suggestions?q=新华人寿');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(suggested.payload.suggestions.some((item) => item.company === '新华保险'));
  } finally {
    await server.close();
  }
});
```

Add one more test in the same file for generic normalization fallback:

```js
test('responsibility assistant company suggestions match legal-suffix variants without curated aliases', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '测试人寿保险股份有限公司',
          productName: '测试产品',
          title: '测试产品',
          url: 'https://example.test/policy.pdf',
          pageText: '保险责任。',
          official: true,
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/company-suggestions?q=测试人寿');
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(suggested.payload.suggestions.some((item) => item.company === '测试人寿保险股份有限公司'));
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the focused company suggestion tests and verify at least one fails before the implementation**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "company suggestions"
```

Expected: at least one FAIL before the company suggestion scoring work is complete.

- [ ] **Step 3: Add shared company suggestion scoring helpers in `server/policy-knowledge.service.mjs`**

Add helpers that make company matching reusable and explicit:

```js
export function normalizeComparableCompany(value = '') {
  return normalizeComparableFact(value)
    .replace(/(?:人寿|财产|养老|健康)?保险股份有限公司/gu, '')
    .replace(/(?:人寿|财产|养老|健康)?保险有限责任公司/gu, '')
    .replace(/(?:人寿|财产|养老|健康)?保险有限公司/gu, '')
    .replace(/保险股份有限公司|保险有限责任公司|股份有限公司|有限责任公司|有限公司/gu, '')
    .trim();
}

function companyAliasSet(company = '', officialDomainProfiles = []) {
  const profile = resolveOfficialProfile({ company }, officialDomainProfiles);
  const values = [company];
  if (profile) values.push(...(Array.isArray(profile.companyAliases) ? profile.companyAliases : []));
  return new Set(values.map(normalizeComparableCompany).filter(Boolean));
}

export function companiesMatch(left = '', right = '', officialDomainProfiles = []) {
  const leftAliases = companyAliasSet(left, officialDomainProfiles);
  const rightAliases = companyAliasSet(right, officialDomainProfiles);
  if (!leftAliases.size || !rightAliases.size) return false;
  for (const alias of leftAliases) {
    if (rightAliases.has(alias)) return true;
  }
  return false;
}
```

Add a backend-only suggestion scoring helper in the same file:

```js
export function scoreCompanySuggestionMatch(query = '', candidate = '', officialDomainProfiles = []) {
  const normalizedQuery = normalizeComparableCompany(query);
  const normalizedCandidate = normalizeComparableCompany(candidate);
  if (!normalizedQuery || !normalizedCandidate) return { matched: false, score: 0, matchType: 'none' };
  if (companiesMatch(query, candidate, officialDomainProfiles)) {
    if (normalizedQuery === normalizedCandidate) return { matched: true, score: 1, matchType: 'alias_exact' };
    if (normalizedCandidate.startsWith(normalizedQuery) || normalizedQuery.startsWith(normalizedCandidate)) {
      return { matched: true, score: 0.96, matchType: 'alias_prefix' };
    }
    return { matched: true, score: 0.92, matchType: 'alias_contains' };
  }
  if (normalizedQuery === normalizedCandidate) return { matched: true, score: 0.88, matchType: 'normalized_exact' };
  if (normalizedCandidate.includes(normalizedQuery) || normalizedQuery.includes(normalizedCandidate)) {
    return { matched: true, score: 0.8, matchType: 'normalized_contains' };
  }
  return { matched: false, score: 0, matchType: 'none' };
}
```

- [ ] **Step 4: Use backend scoring in `server/app.mjs` company suggestions**

Update imports and ranking in `server/app.mjs`:

```js
import {
  crawlOfficialKnowledge,
  buildKnowledgeSearchArtifacts,
  findKnowledgeProductCandidates,
  companiesMatch,
  normalizeKnowledgeRecord,
  scoreCompanySuggestionMatch,
  scoreProductNameMatch,
  upsertKnowledgeRecords,
} from './policy-knowledge.service.mjs';
```

Replace the company suggestion mapping block with:

```js
function buildResponsibilityCompanySuggestions(state, query = '', maxResults = 12) {
  const normalizedQuery = normalizeSuggestionText(query);
  const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
  const stats = new Map();
  const addCompany = (company, weight = 1) => {
    const name = trim(company);
    if (!name) return;
    const current = stats.get(name) || { company: name, recordCount: 0 };
    current.recordCount += weight;
    stats.set(name, current);
  };
  for (const record of state.knowledgeRecords || []) addCompany(record.company, 1);
  for (const policy of state.policies || []) addCompany(policy.company, 1);
  for (const profile of officialDomainProfiles) addCompany(profile.company, 0);

  return [...stats.values()]
    .map((item) => {
      const normalizedCompany = normalizeSuggestionText(item.company);
      const match = normalizedQuery
        ? scoreCompanySuggestionMatch(query, item.company, officialDomainProfiles)
        : { matched: true, score: 1, matchType: 'default' };
      return {
        ...item,
        matchType: match.matchType,
        rankingScore: match.score,
        startsWith: Boolean(normalizedQuery && normalizedCompany.startsWith(normalizedQuery)),
      };
    })
    .filter((item) => !normalizedQuery || item.rankingScore > 0)
    .sort(
      (left, right) =>
        right.rankingScore - left.rankingScore ||
        Number(right.startsWith) - Number(left.startsWith) ||
        right.recordCount - left.recordCount ||
        left.company.localeCompare(right.company, 'zh-CN'),
    )
    .slice(0, maxResults)
    .map(({ company, recordCount, matchType }) => ({ company, recordCount, matchType }));
}
```

- [ ] **Step 5: Re-run the focused company suggestion tests and verify they pass**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "company suggestions"
```

Expected: PASS for alias and generic-normalization company suggestion tests.

- [ ] **Step 6: Commit the backend company suggestion slice**

```bash
git add tests/policy-ocr-flow.test.mjs server/policy-knowledge.service.mjs server/app.mjs
git commit -m "feat: rank insurer suggestions with alias and fallback matching"
```

---

### Task 2: Lock Down Backend Product Suggestion Behavior

**Files:**
- Modify: `tests/policy-ocr-flow.test.mjs`
- Modify: `server/policy-knowledge.service.mjs`
- Modify: `server/app.mjs`

- [ ] **Step 1: Add failing product suggestion regression tests**

Keep or add these focused tests in `tests/policy-ocr-flow.test.mjs`:

```js
test('responsibility assistant product suggestions honor insurer aliases and fuzzy product names', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '新华保险',
          productName: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          title: '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
          url: 'https://static-cdn.newchinalife.com/ncl/pdf/health-a.pdf',
          pageText: '保险责任包括重大疾病保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 2,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(
      server.baseUrl,
      '/api/policy-responsibilities/product-suggestions?company=新华人寿&q=健康无忧重疾',
    );
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.ok(
      suggested.payload.suggestions.some(
        (item) => item.productName === '新华人寿保险股份有限公司健康无忧A款重大疾病保险',
      ),
    );
  } finally {
    await server.close();
  }
});
```

Add a strict insurer-scope test:

```js
test('responsibility assistant product suggestions never cross into another insurer', async () => {
  const app = createPolicyOcrApp({
    state: {
      users: [],
      sessions: [],
      adminSessions: [],
      smsCodes: [],
      sourceRecords: [],
      pendingScans: [],
      officialDomainProfiles: [],
      knowledgeRecords: [
        {
          id: 1,
          company: '中国平安',
          productName: '平安e生保医疗保险',
          title: '平安e生保医疗保险',
          url: 'https://pingan.example/e.pdf',
          pageText: '保险责任包括医疗保险金。',
          official: true,
        },
        {
          id: 2,
          company: '中国太平',
          productName: '太平e生保医疗保险',
          title: '太平e生保医疗保险',
          url: 'https://taiping.example/e.pdf',
          pageText: '保险责任包括医疗保险金。',
          official: true,
        },
      ],
      policies: [],
      nextId: 3,
    },
  });
  const server = await listen(app);

  try {
    const suggested = await jsonFetch(
      server.baseUrl,
      '/api/policy-responsibilities/product-suggestions?company=中国平安&q=e生',
    );
    assert.equal(suggested.response.status, 200);
    assert.equal(suggested.payload.ok, true);
    assert.equal(suggested.payload.suggestions.some((item) => item.company === '中国太平'), false);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the focused product suggestion tests and verify at least one fails before the implementation**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "product suggestions"
```

Expected: at least one FAIL before backend product suggestion ranking is complete.

- [ ] **Step 3: Export and reuse the existing fuzzy product scoring helper**

In `server/policy-knowledge.service.mjs`, export the already used product scoring helper:

```js
export function scoreProductNameMatch(queryName = '', candidateName = '', company = '') {
  const query = normalizeProductMatchText(queryName, company);
  const candidate = normalizeProductMatchText(candidateName, company);
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  const containsScore = candidate.includes(query) || query.includes(candidate) ? 0.92 : 0;
  const charScore = jaccardScore(toCharSet(query), toCharSet(candidate));
  const bigramScore = jaccardScore(ngrams(query, 2), ngrams(candidate, 2));
  const trigramScore = jaccardScore(ngrams(query, 3), ngrams(candidate, 3));
  const lcsScore = longestCommonSubstringLength(query, candidate) / Math.min(Array.from(query).length, Array.from(candidate).length);
  const queryTypes = productTypeTerms(queryName);
  const candidateTypes = productTypeTerms(candidateName);
  const hasTypeOverlap = queryTypes.some((term) => candidateTypes.includes(term));
  const hasTypeConflict = queryTypes.length && candidateTypes.length && !hasTypeOverlap;
  let score = Math.max(containsScore, trigramScore * 0.35 + bigramScore * 0.25 + charScore * 0.2 + lcsScore * 0.2);
  if (hasTypeOverlap) score += 0.08;
  if (hasTypeConflict && lcsScore < 0.75) score -= 0.06;
  return Math.max(0, Math.min(1, score));
}
```

- [ ] **Step 4: Move product suggestion ranking fully to the backend**

Update `server/app.mjs` product suggestion logic:

```js
function buildResponsibilityProductSuggestions(state, { company = '', query = '', maxResults = 12 } = {}) {
  if (!normalizeSuggestionText(company)) return [];
  const normalizedQuery = normalizeSuggestionText(query);
  const officialDomainProfiles = buildEffectiveOfficialDomainProfiles(state);
  const stats = new Map();
  const addProduct = (recordCompany, productName, weight = 1, { official = false } = {}) => {
    const sourceCompany = trim(recordCompany);
    const name = trim(productName);
    if (!sourceCompany || !name) return;
    if (!companiesMatch(company, sourceCompany, officialDomainProfiles)) return;
    const key = `${sourceCompany}\u001f${name}`;
    const current = stats.get(key) || { company: sourceCompany, productName: name, canonicalProductId: '', recordCount: 0 };
    if (official && !current.canonicalProductId) {
      current.canonicalProductId = canonicalProductIdFromOfficialProduct({
        company: sourceCompany,
        productName: name,
      });
    }
    current.recordCount += weight;
    stats.set(key, current);
  };
  for (const record of state.knowledgeRecords || []) addProduct(record.company, record.productName, 1, { official: record.official === true });
  for (const policy of state.policies || []) addProduct(policy.company, policy.name, 1, { official: false });

  return [...stats.values()]
    .map((item) => {
      const normalizedProduct = normalizeSuggestionText(item.productName);
      const fuzzyScore = normalizedQuery ? scoreProductNameMatch(query, item.productName, company) : 1;
      const containsMatch = Boolean(normalizedQuery && normalizedProduct.includes(normalizedQuery));
      const exact = Boolean(normalizedQuery && normalizedProduct === normalizedQuery);
      return {
        ...item,
        matchType: exact ? 'product_exact' : containsMatch ? 'product_contains' : 'product_fuzzy',
        rankingScore: exact ? 1 : containsMatch ? 0.92 : fuzzyScore,
      };
    })
    .filter((item) => !normalizedQuery || item.rankingScore >= 0.1)
    .sort(
      (left, right) =>
        right.rankingScore - left.rankingScore ||
        right.recordCount - left.recordCount ||
        left.productName.localeCompare(right.productName, 'zh-CN'),
    )
    .slice(0, maxResults)
    .map(({ company: itemCompany, productName, canonicalProductId, recordCount, matchType }) => ({
      company: itemCompany,
      productName,
      canonicalProductId: canonicalProductId || undefined,
      recordCount,
      matchType,
    }));
}
```

- [ ] **Step 5: Re-run the focused product suggestion tests and verify they pass**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "product suggestions"
```

Expected: PASS for fuzzy same-insurer matching and non-cross-insurer filtering.

- [ ] **Step 6: Commit the backend product suggestion slice**

```bash
git add tests/policy-ocr-flow.test.mjs server/policy-knowledge.service.mjs server/app.mjs
git commit -m "feat: rank insurer-scoped product suggestions on the backend"
```

---

### Task 3: Expose Match Metadata Through API Contracts

**Files:**
- Modify: `src/api/contracts/responsibility.ts`

- [ ] **Step 1: Update the suggestion response types**

In `src/api/contracts/responsibility.ts`, expand the suggestion types:

```ts
export type PolicyCompanySuggestion = {
  company: string;
  recordCount: number;
  matchType: string;
};

export type PolicyProductSuggestion = {
  company: string;
  productName: string;
  canonicalProductId?: string;
  recordCount: number;
  matchType: string;
};
```

- [ ] **Step 2: Verify TypeScript accepts the richer suggestion payloads**

Run:

```bash
npm run typecheck
```

Expected: PASS for contract typing after the field additions.

- [ ] **Step 3: Commit the API contract slice**

```bash
git add src/api/contracts/responsibility.ts
git commit -m "chore: type suggestion match metadata"
```

---

### Task 4: Make Customer App Request Live Company Suggestions

**Files:**
- Modify: `src/apps/customer/CustomerApp.tsx`

- [ ] **Step 1: Replace preloaded company suggestion fetches with query-driven fetches**

In `src/apps/customer/CustomerApp.tsx`, replace the one-time company preload effect for the assistant with a query-driven effect:

```tsx
useEffect(() => {
  const q = assistantCompany.trim();
  if (!assistantOpen || !q) {
    setAssistantCompanySuggestions([]);
    setAssistantCompanySuggestionLoading(false);
    return;
  }
  let cancelled = false;
  const timer = window.setTimeout(() => {
    setAssistantCompanySuggestions([]);
    setAssistantCompanySuggestionLoading(true);
    listPolicyResponsibilityCompanySuggestions({ q, limit: 50 })
      .then((payload) => {
        if (!cancelled) setAssistantCompanySuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
      })
      .catch(() => {
        if (!cancelled) setAssistantCompanySuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setAssistantCompanySuggestionLoading(false);
      });
  }, 220);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}, [assistantOpen, assistantCompany]);
```

Apply the same pattern for:

- entry form company suggestions using `formData.company`
- clearing stale product suggestion lists before a new request resolves

- [ ] **Step 2: Keep rider product suggestion requests scoped and fresh**

Update the rider product suggestion effect in the same file so stale results are cleared before the request:

```tsx
useEffect(() => {
  const index = formPlanProductQuery.index;
  const company = formPlanProductQuery.company.trim();
  const q = formPlanProductQuery.q.trim();
  if (activeTab !== 'entry' || index === null || !company) {
    setFormPlanProductSuggestions([]);
    setFormPlanProductSuggestionLoading(false);
    return;
  }
  let cancelled = false;
  const timer = window.setTimeout(() => {
    setFormPlanProductSuggestions([]);
    setFormPlanProductSuggestionLoading(true);
    listPolicyResponsibilityProductSuggestions({ company, q, limit: 50 })
      .then((payload) => {
        if (!cancelled) setFormPlanProductSuggestions(Array.isArray(payload.suggestions) ? payload.suggestions : []);
      })
      .catch(() => {
        if (!cancelled) setFormPlanProductSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setFormPlanProductSuggestionLoading(false);
      });
  }, 220);
  return () => {
    cancelled = true;
    window.clearTimeout(timer);
  };
}, [activeTab, formPlanProductQuery]);
```

- [ ] **Step 3: Run typecheck to verify the customer app still compiles**

Run:

```bash
npm run typecheck
```

Expected: PASS for the updated effects.

- [ ] **Step 4: Commit the live request orchestration slice**

```bash
git add src/apps/customer/CustomerApp.tsx
git commit -m "feat: request insurer suggestions from live input"
```

---

### Task 5: Make Shared Suggestion UIs Display Backend-Ranked Results Only

**Files:**
- Modify: `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`
- Modify: `src/features/policy-entry/UploadPolicyPage.tsx`
- Modify: `src/features/policy-detail/PolicyDetailSheet.tsx`
- Modify: `src/shared/customer-policy-components.tsx`

- [ ] **Step 1: Remove local company substring filtering from the responsibility assistant**

In `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`, simplify company and product suggestion derivation:

```tsx
const visibleCompanySuggestions = useMemo(() => {
  const normalizedQuery = normalizeSuggestionQuery(companyQuery);
  if (!normalizedQuery) return [];
  return (Array.isArray(companySuggestions) ? companySuggestions : [])
    .filter((suggestion) => normalizeSuggestionQuery(suggestion.company) !== normalizedQuery)
    .slice(0, 8);
}, [companyQuery, companySuggestions]);

const visibleProductSuggestions = useMemo(() => {
  const normalizedQuery = normalizeSuggestionQuery(productQuery);
  if (!normalizeSuggestionQuery(companyQuery)) return [];
  return (Array.isArray(productSuggestions) ? productSuggestions : [])
    .filter((suggestion) => normalizeSuggestionQuery(suggestion.productName) !== normalizedQuery)
    .slice(0, 8);
}, [companyQuery, productQuery, productSuggestions]);
```

- [ ] **Step 2: Apply the same display-only filtering to entry and edit flows**

Use the same pattern in:

- `src/features/policy-entry/UploadPolicyPage.tsx`
- `src/features/policy-detail/PolicyDetailSheet.tsx`
- `src/shared/customer-policy-components.tsx`

For the shared rider editor helper:

```tsx
function productSuggestionsForPlan(plan: NonNullable<PolicyFormData['plans']>[number]) {
  const productQuery = String(plan.name || '').trim();
  const normalizedQuery = normalizeSuggestionQuery(productQuery);
  if (!String(plan.company || company || '').trim()) return [];
  return (Array.isArray(productSuggestions) ? productSuggestions : [])
    .filter((suggestion) => normalizeSuggestionQuery(suggestion.productName) !== normalizedQuery)
    .slice(0, 8);
}
```

- [ ] **Step 3: Run typecheck to verify the shared UI still compiles**

Run:

```bash
npm run typecheck
```

Expected: PASS for the simplified dropdown filtering.

- [ ] **Step 4: Commit the display-only UI slice**

```bash
git add src/features/responsibility-assistant/ResponsibilityAssistant.tsx src/features/policy-entry/UploadPolicyPage.tsx src/features/policy-detail/PolicyDetailSheet.tsx src/shared/customer-policy-components.tsx
git commit -m "feat: render backend-ranked insurer suggestions without local filtering"
```

---

### Task 6: Run Full Cross-Boundary Verification

**Files:**
- Modify: `tests/policy-ocr-flow.test.mjs` if any final assertion cleanup is needed

- [ ] **Step 1: Run syntax and contract checks**

Run:

```bash
npm run check
```

Expected: PASS

- [ ] **Step 2: Run TypeScript validation**

Run:

```bash
npm run typecheck
```

Expected: PASS

- [ ] **Step 3: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS

- [ ] **Step 4: Run production build**

Run:

```bash
npm run build
```

Expected: PASS

- [ ] **Step 5: Commit any final assertion-only cleanup**

If no cleanup is needed:

```bash
git status --short
```

Expected: no additional suggestion-matching edits beyond the committed work.

If cleanup is needed:

```bash
git add tests/policy-ocr-flow.test.mjs
git commit -m "test: finalize cross-insurer suggestion matching coverage"
```

---

## Self-Review

### Spec Coverage

- Two-layer insurer matching: covered in Task 1
- Same-insurer fuzzy product suggestion ranking: covered in Task 2
- Match metadata through API responses: covered in Task 3
- Live company suggestion requests and removal of client-side re-filtering: covered in Tasks 4 and 5
- Verification and regression protection: covered in Task 6

### Placeholder Scan

- No `TBD`, `TODO`, or “similar to Task N” shortcuts remain
- Every code-changing step includes concrete code blocks
- Every validation step includes concrete commands and expected outcomes

### Type Consistency

- `matchType` is defined in both company and product suggestion contracts
- `scoreCompanySuggestionMatch(...)`, `companiesMatch(...)`, and `scoreProductNameMatch(...)` names are used consistently
- Suggestion UI tasks rely on backend-ranked arrays and only remove exact self-duplicates
