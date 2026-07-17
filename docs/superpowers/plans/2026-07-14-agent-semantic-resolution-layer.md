# Agent Semantic Resolution Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a versioned semantic resolution layer that turns Hermes, Direct, or rule-based interpretations into uniquely resolved, authorized, execution-ready Agent requests across current product, family, report, sales, and upload intents.

**Architecture:** Hermes and Direct emit the same constrained `SemanticProposal`; deterministic context, product, and family resolvers turn that proposal into a `ResolvedSemanticFrame`. A readiness gate decides execute, clarify, reject, or retry, then the existing question router remains the final authority for permissions, tools, evidence, and write confirmation.

**Tech Stack:** Node.js ESM, Express, SQLite via `node:sqlite`, DingTalk Stream gateway, Hermes CLI, DeepSeek-compatible chat completion API, Node test runner.

**Design:** `docs/superpowers/specs/2026-07-14-agent-semantic-resolution-layer-design.md`

---

## File map

### Create

- `server/agent-semantic-contract.mjs` — versioned proposal/frame enums, strict validation, and router-candidate conversion.
- `server/agent-semantic-preparser.mjs` — deterministic candidate-number, upload, and explicit-reference signals.
- `server/agent-product-entity-resolver.service.mjs` — company-scoped canonical product resolution without answering insurance facts.
- `server/agent-family-entity-resolver.service.mjs` — authorized-family-only exact, contextual, and ambiguous resolution.
- `server/agent-semantic-readiness.service.mjs` — intent requirements and execute/clarify/reject/retry decisions.
- `server/agent-semantic-resolver.service.mjs` — orchestration of preparse signals, context references, entity resolvers, and readiness.
- `tests/agent-semantic-contract.test.mjs`
- `tests/agent-product-entity-resolver.test.mjs`
- `tests/agent-family-entity-resolver.test.mjs`
- `tests/agent-semantic-resolver.test.mjs`

### Modify

- `server/hermes-conversation-client.service.mjs` — request and validate `SemanticProposal` instead of the legacy candidate.
- `server/agent-question-interpreter.service.mjs` — make Direct emit the same semantic contract.
- `server/product-catalog-search.mjs` — export the existing normalized product identity helper for deterministic reuse.
- `server/agent-conversation-context.service.mjs` — load and commit typed task state while reading legacy product state.
- `server/sqlite-state-store.mjs` — persist typed conversation entities and semantic audit events through narrow methods.
- `server/agent-conversation-runtime.service.mjs` — run semantic resolution, safe fallback, shadow/enforced modes, audit, and state updates.
- `server/agent-product-knowledge.service.mjs` — accept an already resolved official product identity without reinterpreting the whole question.
- `server/agent-question-handlers.service.mjs` — pass the resolved official product fields to product knowledge search.
- `server/app.mjs` — wire resolvers, audit store, authorized family loader, and rollout mode.
- `server/routes/agent.routes.mjs` — preserve safe public behavior while allowing runtime metadata to remain internal.
- `tests/agent-conversation-context.test.mjs`
- `tests/agent-conversation-runtime.test.mjs`
- `tests/agent-product-knowledge.test.mjs`
- `tests/agent-question-handlers.test.mjs`
- `tests/agent-question-routes.test.mjs`
- `tests/sqlite-state-store.test.mjs`
- `docs/harness-test-map.json` — map semantic-layer files to focused tests.

## Task 1: Add the versioned semantic contract and deterministic pre-parser

**Files:**

- Create: `server/agent-semantic-contract.mjs`
- Create: `server/agent-semantic-preparser.mjs`
- Create: `tests/agent-semantic-contract.test.mjs`

- [ ] **Step 1: Write failing contract and pre-parser tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSemanticProposal } from '../server/agent-semantic-contract.mjs';
import { preparseAgentMessage } from '../server/agent-semantic-preparser.mjs';

test('semantic proposal preserves exact mentions and separates intent confidence', () => {
  const question = '新华人寿保险股份有限公司康健无忧两全保险，这个保险主要保啥的';
  const proposal = normalizeSemanticProposal({
    semanticContractVersion: 1,
    intent: 'insurance_product_knowledge',
    operation: 'read',
    queryAspects: ['main_responsibilities'],
    mentions: [
      { type: 'insurer', rawText: '新华人寿保险股份有限公司' },
      { type: 'product', rawText: '康健无忧两全保险' },
    ],
    references: [{ type: 'current_product', rawText: '这个保险' }],
    requestedSteps: ['lookup'],
    confidence: { intent: 0.98, mentions: 0.95, references: 0.92 },
  }, question);
  assert.equal(proposal.mentions[0].rawText, '新华人寿保险股份有限公司');
  assert.equal(proposal.confidence.intent, 0.98);
});

test('semantic proposal rejects invented mention text and authority fields', () => {
  assert.throws(() => normalizeSemanticProposal({
    semanticContractVersion: 1,
    intent: 'family_summary',
    operation: 'read',
    queryAspects: ['family_overview'],
    mentions: [{ type: 'family', rawText: '不存在家庭' }],
    references: [],
    requestedSteps: ['lookup'],
    confidence: { intent: 1, mentions: 1, references: 1 },
    internalUserId: 7,
  }, '看看张三家庭'), /SEMANTIC_PROPOSAL_INVALID/u);
});

test('pre-parser recognizes only high-certainty selection and upload signals', () => {
  assert.deepEqual(preparseAgentMessage('选择 2'), {
    candidateSelection: { index: 1, rawText: '选择 2' },
    operationHint: null,
  });
  assert.deepEqual(preparseAgentMessage('上传保单'), {
    candidateSelection: null,
    operationHint: 'upload_link',
  });
  assert.deepEqual(preparseAgentMessage('这个保险主要保什么'), {
    candidateSelection: null,
    operationHint: null,
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `node --test tests/agent-semantic-contract.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `agent-semantic-contract.mjs`.

- [ ] **Step 3: Implement the strict semantic contract**

Create `server/agent-semantic-contract.mjs` with these exact public exports and validation rules:

```js
export const SEMANTIC_CONTRACT_VERSION = 1;
export const SEMANTIC_INTENTS = Object.freeze([
  'chat', 'family_list', 'family_summary', 'coverage_report', 'sales_report',
  'sales_coaching', 'upload_link', 'insurance_product_knowledge',
]);
export const SEMANTIC_QUERY_ASPECTS = Object.freeze([
  'main_responsibilities', 'exclusions', 'waiting_period', 'deductible',
  'reimbursement_ratio', 'renewal', 'sales_status', 'comparison',
  'family_overview', 'coverage_gap', 'report_status', 'sales_guidance', 'upload',
]);
export const SEMANTIC_MENTION_TYPES = Object.freeze(['insurer', 'product', 'family']);
export const SEMANTIC_REFERENCE_TYPES = Object.freeze([
  'current_product', 'current_family', 'candidate_index', 'previous_result',
  'comparison_left', 'comparison_right',
]);
export const SEMANTIC_DECISIONS = Object.freeze(['execute', 'clarify', 'reject', 'retry_later']);

function invalid() {
  const error = new Error('SEMANTIC_PROPOSAL_INVALID');
  error.code = 'SEMANTIC_PROPOSAL_INVALID';
  throw error;
}

function bounded(value, limit) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > limit) invalid();
  return normalized;
}

function confidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) invalid();
  return number;
}

function controlledList(value, allowed, limit) {
  if (!Array.isArray(value) || value.length > limit) invalid();
  const normalized = value.map((item) => bounded(item, 80));
  if (normalized.some((item) => !allowed.includes(item))) invalid();
  return [...new Set(normalized)];
}

export function normalizeSemanticProposal(value, originalQuestion) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const allowedRoot = new Set([
    'semanticContractVersion', 'intent', 'operation', 'queryAspects',
    'mentions', 'references', 'requestedSteps', 'confidence',
  ]);
  if (Object.keys(value).some((key) => !allowedRoot.has(key))) invalid();
  if (Number(value.semanticContractVersion) !== SEMANTIC_CONTRACT_VERSION) invalid();
  const question = bounded(originalQuestion, 1_000);
  const intent = bounded(value.intent, 80);
  const operation = bounded(value.operation, 20);
  if (!SEMANTIC_INTENTS.includes(intent) || !['read', 'write'].includes(operation)) invalid();
  const mentions = Array.isArray(value.mentions) ? value.mentions.map((mention) => {
    if (!mention || typeof mention !== 'object' || Array.isArray(mention)
      || Object.keys(mention).some((key) => !['type', 'rawText'].includes(key))) invalid();
    const type = bounded(mention.type, 40);
    const rawText = bounded(mention.rawText, 200);
    if (!SEMANTIC_MENTION_TYPES.includes(type) || !question.includes(rawText)) invalid();
    return { type, rawText };
  }) : invalid();
  const references = Array.isArray(value.references) ? value.references.map((reference) => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)
      || Object.keys(reference).some((key) => !['type', 'rawText'].includes(key))) invalid();
    const type = bounded(reference.type, 40);
    const rawText = bounded(reference.rawText, 100);
    if (!SEMANTIC_REFERENCE_TYPES.includes(type) || !question.includes(rawText)) invalid();
    return { type, rawText };
  }) : invalid();
  const scores = value.confidence;
  if (!scores || typeof scores !== 'object' || Array.isArray(scores)
    || Object.keys(scores).some((key) => !['intent', 'mentions', 'references'].includes(key))) invalid();
  return {
    semanticContractVersion: SEMANTIC_CONTRACT_VERSION,
    intent,
    operation,
    queryAspects: controlledList(value.queryAspects || [], SEMANTIC_QUERY_ASPECTS, 8),
    mentions,
    references,
    requestedSteps: controlledList(value.requestedSteps || [], ['lookup', 'compare', 'generate', 'upload', 'continue'], 4),
    confidence: {
      intent: confidence(scores.intent),
      mentions: confidence(scores.mentions),
      references: confidence(scores.references),
    },
  };
}
```

- [ ] **Step 4: Implement the deterministic pre-parser**

Create `server/agent-semantic-preparser.mjs`:

```js
export function preparseAgentMessage(value) {
  const question = String(value || '').trim().slice(0, 1_000);
  const selection = question.match(/^(?:选择|选|第)?\s*(\d{1,2})(?:\s*(?:个|项|款|号))?$/u);
  const index = selection ? Number(selection[1]) - 1 : -1;
  return {
    candidateSelection: index >= 0 && index < 20 ? { index, rawText: question } : null,
    operationHint: /上传|录入/u.test(question) && /保单|资料/u.test(question) ? 'upload_link' : null,
  };
}
```

- [ ] **Step 5: Run the focused test and commit**

Run: `node --test tests/agent-semantic-contract.test.mjs`

Expected: PASS.

```bash
git add server/agent-semantic-contract.mjs server/agent-semantic-preparser.mjs tests/agent-semantic-contract.test.mjs
git commit -m "feat: add agent semantic contract"
```

## Task 2: Make Hermes and Direct emit the same semantic proposal

**Files:**

- Modify: `server/hermes-conversation-client.service.mjs`
- Modify: `server/agent-question-interpreter.service.mjs`
- Modify: `tests/agent-conversation-runtime.test.mjs`
- Modify: `tests/agent-question-interpreter.test.mjs`

- [ ] **Step 1: Update interpreter tests to require exact raw mentions and references**

Add a Hermes assertion to `tests/agent-conversation-runtime.test.mjs`:

```js
assert.deepEqual(first.proposal, {
  semanticContractVersion: 1,
  intent: 'insurance_product_knowledge',
  operation: 'read',
  queryAspects: ['comparison'],
  mentions: [{ type: 'product', rawText: '医药安欣' }],
  references: [{ type: 'comparison_left', rawText: '他' }],
  requestedSteps: ['compare'],
  confidence: { intent: 0.95, mentions: 0.95, references: 0.9 },
});
```

Replace the first Direct test response in `tests/agent-question-interpreter.test.mjs` with:

```js
return { ok: true, async json() { return { choices: [{ message: { content: JSON.stringify({
  semanticContractVersion: 1,
  intent: 'family_summary',
  operation: 'read',
  queryAspects: ['family_overview'],
  mentions: [{ type: 'family', rawText: '余贵祥家庭' }],
  references: [],
  requestedSteps: ['lookup'],
  confidence: { intent: 0.98, mentions: 0.98, references: 1 },
}) } }] }; } };
```

- [ ] **Step 2: Run both tests and verify they fail against the legacy candidate contract**

Run: `node --test tests/agent-conversation-runtime.test.mjs tests/agent-question-interpreter.test.mjs`

Expected: FAIL because Hermes returns `candidate` and Direct returns the legacy `entities` shape.

- [ ] **Step 3: Update Hermes normalization and prompt**

Import `normalizeSemanticProposal` and replace the legacy prompt contract with:

```js
return [
  '你是 OCR Insurance 的语义解释器，只提取用户意图、原文实体提及、上下文引用和查询维度。',
  '只输出 JSON；不得回答保险事实，不得输出内部 ID、权限判断或工具名称。',
  'semanticContractVersion 固定为 1。operation 只能是 read 或 write。',
  `intent 只能是：${SEMANTIC_INTENTS.join(', ')}。`,
  `queryAspects 只能是：${SEMANTIC_QUERY_ASPECTS.join(', ')}。`,
  'mentions 每项只能包含 type 和 rawText；rawText 必须逐字来自 USER_QUESTION。',
  '“这个保险、它、该产品”使用 current_product；“这个家庭、他家”使用 current_family。',
  '比较里的代词分别使用 comparison_left 或 comparison_right。不要把整句问题当产品名。',
  `SAFE_RECENT_CONTEXT=${JSON.stringify(history)}`,
  `USER_QUESTION=${JSON.stringify(redactDeepSeekDirectIdentifiers(question))}`,
].join('\n');
```

Return the normalized proposal:

```js
return {
  sessionId: returnedSessionId,
  proposal: normalizeSemanticProposal(parseJsonOutput(result.stdout), normalizedQuestion),
};
```

- [ ] **Step 4: Update Direct to use the same prompt and validator**

Make `createDeepSeekAgentQuestionInterpreter()` return:

```js
const raw = payload?.choices?.[0]?.message?.content;
const parsed = JSON.parse(String(raw || ''));
return normalizeSemanticProposal(parsed, normalizedQuestion);
```

Use the same allowed intent, aspect, mention, and reference lists in its system prompt; retain existing history limits, timeout, privacy redaction, and request sanitization.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test tests/agent-conversation-runtime.test.mjs tests/agent-question-interpreter.test.mjs`

Expected: PASS for client parsing and privacy assertions. Runtime tests that still construct legacy candidates may remain unchanged until Task 7; do not convert runtime orchestration in this task.

```bash
git add server/hermes-conversation-client.service.mjs server/agent-question-interpreter.service.mjs tests/agent-conversation-runtime.test.mjs tests/agent-question-interpreter.test.mjs
git commit -m "feat: unify agent semantic interpreters"
```

## Task 3: Resolve canonical products before product knowledge lookup

**Files:**

- Modify: `server/product-catalog-search.mjs`
- Create: `server/agent-product-entity-resolver.service.mjs`
- Create: `tests/agent-product-entity-resolver.test.mjs`

- [ ] **Step 1: Write failing exact, contextual, and ambiguous product tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createAgentProductEntityResolver } from '../server/agent-product-entity-resolver.service.mjs';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE knowledge_records (company TEXT, product_name TEXT, payload TEXT NOT NULL);
    CREATE TABLE product_customer_responsibility_summaries (company TEXT, product_name TEXT, status TEXT);
    CREATE TABLE insurance_products (
      canonical_product_id TEXT PRIMARY KEY, tenant_id TEXT, company TEXT, official_name TEXT,
      status TEXT, payload TEXT NOT NULL DEFAULT '{}'
    );
  `);
  return db;
}

test('company-scoped short name resolves the official Xinhua product', () => {
  const db = makeDb();
  db.prepare('INSERT INTO knowledge_records VALUES (?, ?, ?)').run(
    '新华保险', '新华人寿保险股份有限公司康健无忧两全保险', JSON.stringify({ sourceKind: 'insurer_official' }),
  );
  db.prepare('INSERT INTO insurance_products VALUES (?, ?, ?, ?, ?, ?)').run(
    'product-kjwy', 'default', '新华保险', '新华人寿保险股份有限公司康健无忧两全保险', 'active', '{}',
  );
  const resolver = createAgentProductEntityResolver({
    db,
    officialDomainProfiles: [{ company: '新华保险', aliases: ['新华', '新华人寿', '新华人寿保险股份有限公司'] }],
  });
  const result = resolver.resolve({ mentions: [
    { type: 'insurer', rawText: '新华人寿保险股份有限公司' },
    { type: 'product', rawText: '康健无忧两全保险' },
  ] });
  assert.deepEqual(result, {
    status: 'resolved',
    entity: {
      canonicalProductId: 'product-kjwy', company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险',
      matchType: 'company_scoped_normalized', confidence: 1,
    },
    candidates: [],
  });
  db.close();
});

test('same short name across companies stays ambiguous without an insurer', () => {
  const db = makeDb();
  const insert = db.prepare('INSERT INTO knowledge_records VALUES (?, ?, ?)');
  insert.run('新华保险', '新华人寿康健无忧两全保险', JSON.stringify({ sourceKind: 'insurer_official' }));
  insert.run('交银人寿', '交银康联附加康健无忧两全保险', JSON.stringify({ sourceKind: 'insurer_official' }));
  const result = createAgentProductEntityResolver({ db }).resolve({
    mentions: [{ type: 'product', rawText: '康健无忧两全保险' }],
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  db.close();
});
```

- [ ] **Step 2: Run the resolver test and verify it fails**

Run: `node --test tests/agent-product-entity-resolver.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Export normalized catalog identity**

In `server/product-catalog-search.mjs`, rename the private helper and update internal calls:

```js
export function catalogProductIdentity(value) {
  return comparable(value).replace(/^[\p{Script=Han}]{2,24}?保险(?:股份)?有限公司/gu, '');
}
```

- [ ] **Step 4: Implement deterministic product resolution**

Create `createAgentProductEntityResolver({ db, officialDomainProfiles })` with this public result contract:

```js
return {
  resolve({ mentions = [], activeProduct = null } = {}) {
    const insurerText = mentions.find((item) => item.type === 'insurer')?.rawText || '';
    const productText = mentions.find((item) => item.type === 'product')?.rawText || '';
    if (!productText && activeProduct?.officialName) {
      return { status: 'resolved', entity: activeProduct, candidates: [] };
    }
    if (!productText) return { status: 'missing', entity: null, candidates: [] };
    const company = resolveCatalogCompany(insurerText, productText, officialDomainProfiles, db);
    const candidates = searchProductCatalog({ db, company, query: productText, limit: 20, visibility: 'public' });
    const ranked = candidates.map((item) => toResolvedCandidate(db, item, productText));
    const first = ranked[0];
    const second = ranked[1];
    if (!first) return { status: 'not_found', entity: null, candidates: [] };
    const unique = first.confidence >= 0.90 && (!second || first.confidence - second.confidence >= 0.15);
    if (!unique) return { status: 'ambiguous', entity: null, candidates: ranked.slice(0, 10) };
    return { status: 'resolved', entity: first, candidates: [] };
  },
};
```

`resolveCatalogCompany()` must match direct catalog company names first, then approved profile aliases. `toResolvedCandidate()` must use exact official name, approved `insurance_products.payload.aliases` only when `aliasReviewStatus === 'approved'`, normalized identity, and finally normalized score. Convert catalog scores to `0..1`; exact and company-scoped normalized containment return `1`. Read `canonical_product_id` when present and otherwise return an empty string rather than inventing an ID.

- [ ] **Step 5: Run product resolver and catalog tests, then commit**

Run: `node --test tests/agent-product-entity-resolver.test.mjs tests/product-catalog-search.test.mjs`

Expected: PASS.

```bash
git add server/product-catalog-search.mjs server/agent-product-entity-resolver.service.mjs tests/agent-product-entity-resolver.test.mjs
git commit -m "feat: resolve canonical agent products"
```

## Task 4: Resolve authorized families and gate execution readiness

**Files:**

- Create: `server/agent-family-entity-resolver.service.mjs`
- Create: `server/agent-semantic-readiness.service.mjs`
- Create: `tests/agent-family-entity-resolver.test.mjs`

- [ ] **Step 1: Write failing family authorization and readiness tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentFamilyEntityResolver } from '../server/agent-family-entity-resolver.service.mjs';
import { decideSemanticReadiness } from '../server/agent-semantic-readiness.service.mjs';

test('family resolver only returns families from the authorized loader', async () => {
  const resolver = createAgentFamilyEntityResolver({
    listAuthorizedFamilies: async () => [
      { id: 10, familyName: '张三家庭' },
      { id: 20, familyName: '张三父母家庭' },
    ],
  });
  const exact = await resolver.resolve({ internalUserId: 7, mentions: [{ type: 'family', rawText: '张三家庭' }] });
  assert.equal(exact.entity.familyId, 10);
  const missing = await resolver.resolve({ internalUserId: 7, mentions: [{ type: 'family', rawText: '未授权家庭' }] });
  assert.equal(missing.status, 'not_found');
});

test('readiness clarifies missing product despite high intent confidence', () => {
  const result = decideSemanticReadiness({
    proposal: { intent: 'insurance_product_knowledge', operation: 'read', confidence: { intent: 0.99 } },
    resolutions: { product: { status: 'missing' } },
    runtime: 'hermes',
  });
  assert.deepEqual(result, {
    decision: 'clarify', decisionReason: 'product_required', missingFields: ['product'], ambiguities: [],
  });
});

test('write proposal never becomes direct execution', () => {
  const result = decideSemanticReadiness({
    proposal: { intent: 'chat', operation: 'write', confidence: { intent: 1 } },
    resolutions: {}, runtime: 'direct',
  });
  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'unsafe_fallback_operation');
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/agent-family-entity-resolver.test.mjs`

Expected: FAIL with missing resolver modules.

- [ ] **Step 3: Implement the authorized-family resolver**

The resolver must call only the injected authorized loader and return one of `resolved`, `ambiguous`, `missing`, or `not_found`:

```js
export function createAgentFamilyEntityResolver({ listAuthorizedFamilies } = {}) {
  if (typeof listAuthorizedFamilies !== 'function') throw new TypeError('Authorized family loader is required');
  return {
    async resolve({ internalUserId, mentions = [], activeFamily = null } = {}) {
      const families = await listAuthorizedFamilies({ internalUserId: Number(internalUserId) });
      const requested = String(mentions.find((item) => item.type === 'family')?.rawText || '').trim();
      if (!requested && activeFamily) {
        const current = families.find((item) => Number(item.id) === Number(activeFamily.familyId));
        return current ? { status: 'resolved', entity: toEntity(current), candidates: [] }
          : { status: 'missing', entity: null, candidates: [] };
      }
      if (!requested) return { status: 'missing', entity: null, candidates: [] };
      const exact = families.filter((item) => normalizeFamily(item.familyName) === normalizeFamily(requested));
      if (exact.length === 1) return { status: 'resolved', entity: toEntity(exact[0]), candidates: [] };
      const similar = exact.length > 1 ? exact : families.filter((item) => familyNamesOverlap(item.familyName, requested));
      if (similar.length === 1) return { status: 'resolved', entity: toEntity(similar[0]), candidates: [] };
      if (similar.length > 1) return { status: 'ambiguous', entity: null, candidates: similar.map(toEntity) };
      return { status: 'not_found', entity: null, candidates: [] };
    },
  };
}
```

Keep `normalizeFamily`, `familyNamesOverlap`, and `toEntity` private. `toEntity` returns `{ familyId, displayName, matchType, confidence }`; it does not expose unrelated family payload fields.

- [ ] **Step 4: Implement the readiness matrix**

```js
const REQUIRED_ENTITIES = Object.freeze({
  insurance_product_knowledge: ['product'],
  family_summary: ['family'],
  coverage_report: ['family'],
  sales_report: ['family'],
  sales_coaching: ['family'],
});

export function decideSemanticReadiness({ proposal, resolutions = {}, runtime = 'rule' } = {}) {
  if (!proposal) return { decision: 'retry_later', decisionReason: 'semantic_proposal_unavailable', missingFields: [], ambiguities: [] };
  if (runtime !== 'hermes' && proposal.operation === 'write') {
    return { decision: 'clarify', decisionReason: 'unsafe_fallback_operation', missingFields: [], ambiguities: [] };
  }
  const required = REQUIRED_ENTITIES[proposal.intent] || [];
  const ambiguous = required.filter((key) => resolutions[key]?.status === 'ambiguous');
  if (ambiguous.length) return { decision: 'clarify', decisionReason: 'entity_ambiguous', missingFields: [], ambiguities: ambiguous };
  const missing = required.filter((key) => resolutions[key]?.status !== 'resolved');
  if (missing.length) return { decision: 'clarify', decisionReason: `${missing[0]}_required`, missingFields: missing, ambiguities: [] };
  return { decision: 'execute', decisionReason: 'unique_authorized_entity', missingFields: [], ambiguities: [] };
}
```

- [ ] **Step 5: Run the focused test and commit**

Run: `node --test tests/agent-family-entity-resolver.test.mjs`

Expected: PASS.

```bash
git add server/agent-family-entity-resolver.service.mjs server/agent-semantic-readiness.service.mjs tests/agent-family-entity-resolver.test.mjs
git commit -m "feat: resolve authorized agent families"
```

## Task 5: Build the semantic resolver and typed router candidate

**Files:**

- Create: `server/agent-semantic-resolver.service.mjs`
- Create: `tests/agent-semantic-resolver.test.mjs`
- Modify: `server/agent-semantic-contract.mjs`
- Modify: `server/agent-question-router.service.mjs`
- Modify: `server/routes/agent.routes.mjs`
- Modify: `tests/agent-question-router.test.mjs`
- Modify: `tests/agent-question-routes.test.mjs`

- [ ] **Step 1: Write failing current-product, explicit-product, and candidate-selection tests**

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentSemanticResolver } from '../server/agent-semantic-resolver.service.mjs';

test('current_product resolves from confirmed task state', async () => {
  const resolver = createAgentSemanticResolver({
    productResolver: { resolve: () => ({ status: 'resolved', entity: {
      canonicalProductId: 'product-kjwy', company: '新华保险',
      officialName: '新华人寿保险股份有限公司康健无忧两全保险', matchType: 'context', confidence: 1,
    }, candidates: [] }) },
    familyResolver: { resolve: async () => ({ status: 'missing', entity: null, candidates: [] }) },
  });
  const result = await resolver.resolve({
    internalUserId: 7,
    question: '主要保啥的呀，这个保险',
    runtime: 'hermes',
    proposal: {
      intent: 'insurance_product_knowledge', operation: 'read', queryAspects: ['main_responsibilities'],
      mentions: [], references: [{ type: 'current_product', rawText: '这个保险' }],
      requestedSteps: ['lookup'], confidence: { intent: 0.98, mentions: 1, references: 0.95 },
    },
    context: { taskState: { activeEntities: { product: { canonicalProductId: 'product-kjwy', officialName: '新华人寿保险股份有限公司康健无忧两全保险' } } } },
  });
  assert.equal(result.decision, 'execute');
  assert.equal(result.candidate.entities.productName, '新华人寿保险股份有限公司康健无忧两全保险');
  assert.equal(result.candidate.entities.productCanonicalId, 'product-kjwy');
});

test('expired selection produces clarification instead of choosing a product', async () => {
  const resolver = createAgentSemanticResolver({
    productResolver: { resolve: () => ({ status: 'missing', entity: null, candidates: [] }) },
    familyResolver: { resolve: async () => ({ status: 'missing', entity: null, candidates: [] }) },
  });
  const result = await resolver.resolve({
    internalUserId: 7, question: '2', runtime: 'rule', proposal: null,
    context: { taskState: { candidateSets: { product: [] }, pendingClarification: null } },
  });
  assert.equal(result.decision, 'clarify');
  assert.equal(result.decisionReason, 'candidate_selection_expired');
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `node --test tests/agent-semantic-resolver.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Add router-candidate conversion to the contract module**

```js
export function semanticFrameToRouterCandidate(frame, question) {
  const entities = {};
  const product = frame.resolvedEntities?.product;
  const family = frame.resolvedEntities?.family;
  if (product?.officialName) entities.productName = product.officialName;
  if (product?.canonicalProductId) entities.productCanonicalId = product.canonicalProductId;
  if (product?.company) entities.productCompany = product.company;
  if (family?.displayName) entities.familyName = family.displayName;
  return {
    intent: frame.intent,
    question: String(question || '').trim().slice(0, 1_000),
    confidence: Number(frame.confidence?.intent || 0),
    requestedOperation: frame.operation,
    ...(Object.keys(entities).length ? { entities } : {}),
  };
}
```

Add `productCanonicalId` and `productCompany` to the in-process router entity allow-list. In `server/routes/agent.routes.mjs`, delete those two keys from externally submitted candidate entities before calling `questionRouter.route()`. Add a route test that submits both keys and asserts neither reaches the router. Only the in-process semantic runtime may add them.

- [ ] **Step 4: Implement semantic orchestration**

`createAgentSemanticResolver()` must:

1. run `preparseAgentMessage(question)`;
2. resolve a valid typed candidate selection before interpreting free text;
3. pass only confirmed active product/family entities when the proposal contains the matching reference;
4. call product and family resolvers only for intents that need them;
5. call `decideSemanticReadiness()`;
6. return `{ decision, decisionReason, proposal, resolvedEntities, candidate, nextTaskState }`;
7. build generic, non-sensitive clarification candidates from typed candidate sets;
8. never place a family ID in the router candidate.

When both model interpreters are unavailable, the resolver may synthesize a rule proposal only for the pre-parser's explicit upload signal:

```js
const effectiveProposal = proposal || (preparsed.operationHint === 'upload_link' ? {
  semanticContractVersion: 1,
  intent: 'upload_link',
  operation: 'read',
  queryAspects: ['upload'],
  mentions: [],
  references: [],
  requestedSteps: ['upload'],
  confidence: { intent: 1, mentions: 1, references: 1 },
} : null);
```

Do not synthesize product, family, report, or sales entities from keywords when both interpreters fail. Candidate-number selection is allowed only when a non-expired typed candidate set is already stored.

Use this exact successful return shape:

```js
return {
  ...readiness,
  proposal: effectiveProposal,
  resolvedEntities,
  candidate: readiness.decision === 'execute'
    ? semanticFrameToRouterCandidate({ ...effectiveProposal, resolvedEntities }, question)
    : null,
  nextTaskState: buildNextTaskState({ context, proposal: effectiveProposal, resolutions, readiness, now }),
};
```

- [ ] **Step 5: Run semantic tests and commit**

Run: `node --test tests/agent-semantic-contract.test.mjs tests/agent-product-entity-resolver.test.mjs tests/agent-family-entity-resolver.test.mjs tests/agent-semantic-resolver.test.mjs`

Expected: PASS.

```bash
git add server/agent-semantic-contract.mjs server/agent-semantic-resolver.service.mjs server/agent-question-router.service.mjs server/routes/agent.routes.mjs tests/agent-semantic-resolver.test.mjs tests/agent-question-router.test.mjs tests/agent-question-routes.test.mjs
git commit -m "feat: add agent semantic resolution pipeline"
```

## Task 6: Persist typed conversation state with legacy read compatibility

**Files:**

- Modify: `server/agent-conversation-context.service.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Modify: `tests/agent-conversation-context.test.mjs`
- Modify: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Write failing typed-state round-trip and TTL tests**

Add to `tests/sqlite-state-store.test.mjs`:

```js
const saved = await store.saveAgentConversationContext({
  conversationId: conversation.id,
  expectedVersion: 1,
  history: [],
  hermesSessionId: 'session-typed',
  taskState: {
    activeIntent: 'insurance_product_knowledge',
    activeEntities: {
      product: { canonicalProductId: 'product-kjwy', company: '新华保险', officialName: '新华人寿保险股份有限公司康健无忧两全保险', updatedAt: 1_720_000_000_000 },
      family: { familyId: 10, displayName: '张三家庭', updatedAt: 1_720_000_000_000 },
    },
    candidateSets: { product: [], family: [] },
    pendingClarification: null,
    lastCompletedAction: { intent: 'insurance_product_knowledge', entityType: 'product' },
  },
  question: null,
  updatedAt: 1_720_000_000_000,
  activeContextExpiresAt: '2024-07-03T10:16:40.000Z',
});
assert.equal(saved.taskState.activeEntities.product.canonicalProductId, 'product-kjwy');
assert.equal(saved.taskState.activeEntities.family.familyId, 10);
```

Add to `tests/agent-conversation-context.test.mjs` an assertion that an expired product is removed while an independently refreshed family remains available.

- [ ] **Step 2: Run persistence tests and verify typed state is lost**

Run: `node --test tests/agent-conversation-context.test.mjs tests/sqlite-state-store.test.mjs`

Expected: FAIL because `taskState` is not persisted or loaded.

- [ ] **Step 3: Store typed entities in `agent_conversation_entities.payload`**

Change entity reads to select `payload`, parse `entityType`, and group current/candidate rows by type. Store current product at ordinal `0`, current family at ordinal `1`, product candidates from ordinal `100`, and family candidates from ordinal `200`. Each entity payload contains only its type-specific confirmed fields.

Persist this bounded conversation payload:

```js
const payload = JSON.stringify({
  history,
  question,
  hermesSessionId: String(hermesSessionId || '').trim().slice(0, 200),
  activeIntent: String(taskState?.activeIntent || '').trim().slice(0, 80),
  pendingClarification: taskState?.pendingClarification || null,
  lastCompletedAction: taskState?.lastCompletedAction || null,
});
```

Retain legacy reads: when typed product rows are absent, construct `taskState.activeEntities.product` from the old current product row; when typed candidates are absent, construct `candidateSets.product` from old candidate rows.

- [ ] **Step 4: Update context service TTL filtering**

Return both `taskState` and the existing compatibility fields. Filter each `activeEntities` and `candidateSets` entry independently by its own `updatedAt`; do not expire the current family because the product expired.

- [ ] **Step 5: Run context and store tests, then commit**

Run: `node --test tests/agent-conversation-context.test.mjs tests/sqlite-state-store.test.mjs`

Expected: PASS.

```bash
git add server/agent-conversation-context.service.mjs server/sqlite-state-store.mjs tests/agent-conversation-context.test.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: persist typed agent conversation state"
```

## Task 7: Add narrow semantic audit persistence

**Files:**

- Modify: `server/sqlite-state-store.mjs`
- Modify: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Write a failing redacted semantic audit round-trip test**

```js
const audit = await store.createAgentSemanticAuditEvent({
  userId: 7,
  messageRef: 'semantic-1',
  runtime: 'hermes',
  fallbackReason: '',
  intent: 'insurance_product_knowledge',
  operation: 'read',
  decision: 'execute',
  decisionReason: 'unique_authorized_entity',
  createdAt: '2026-07-14T01:00:00.000Z',
  payload: {
    semanticContractVersion: 1,
    redactedMentions: [{ type: 'product', value: '康健无忧两全保险' }],
    resolution: { productMatchType: 'company_scoped_normalized', candidateCount: 1, selectedCanonicalProductId: 'product-kjwy' },
  },
});
assert.equal(audit.runtime, 'hermes');
assert.equal(JSON.stringify(audit).includes('13800138000'), false);
assert.equal((await store.listAgentSemanticAuditEvents({ userId: 7 }))[0].messageRef, 'semantic-1');
```

- [ ] **Step 2: Run the store test and verify the missing-method failure**

Run: `node --test tests/sqlite-state-store.test.mjs`

Expected: FAIL because `createAgentSemanticAuditEvent` is undefined.

- [ ] **Step 3: Add the semantic audit table and indexes**

Add idempotent schema creation:

```sql
CREATE TABLE IF NOT EXISTS agent_semantic_audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  message_ref TEXT NOT NULL,
  runtime TEXT NOT NULL CHECK (runtime IN ('hermes', 'direct', 'rule')),
  fallback_reason TEXT NOT NULL DEFAULT '',
  intent TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('read', 'write')),
  decision TEXT NOT NULL CHECK (decision IN ('execute', 'clarify', 'reject', 'retry_later')),
  decision_reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_agent_semantic_audit_user_created
  ON agent_semantic_audit_events(user_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_agent_semantic_audit_message_ref
  ON agent_semantic_audit_events(message_ref);
```

- [ ] **Step 4: Implement narrow create/list store methods**

`createAgentSemanticAuditEvent()` must allow only the documented fields, normalize timestamps, cap `fallbackReason` and `decisionReason`, and validate the payload with existing bounded JSON helpers. `listAgentSemanticAuditEvents()` must support only bounded `limit` and optional positive `userId`. Export both methods from the store object.

- [ ] **Step 5: Run the store test and commit**

Run: `node --test tests/sqlite-state-store.test.mjs`

Expected: PASS.

```bash
git add server/sqlite-state-store.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: persist agent semantic audits"
```

## Task 8: Integrate semantic resolution, safe fallback, and rollout modes

**Files:**

- Modify: `server/agent-conversation-runtime.service.mjs`
- Modify: `server/agent-semantic-contract.mjs`
- Modify: `server/agent-product-knowledge.service.mjs`
- Modify: `server/agent-question-handlers.service.mjs`
- Modify: `server/agent-question-router.service.mjs`
- Modify: `server/app.mjs`
- Modify: `server/routes/agent.routes.mjs`
- Modify: `tests/agent-conversation-runtime.test.mjs`
- Modify: `tests/agent-product-knowledge.test.mjs`
- Modify: `tests/agent-question-handlers.test.mjs`
- Modify: `tests/agent-question-router.test.mjs`
- Modify: `tests/agent-question-routes.test.mjs`

- [ ] **Step 1: Add failing regressions for both observed DingTalk failures**

Add runtime tests for:

```js
await runtime.processMessage(envelope('ding-a', 'product-followup', 'p-1', '新华人寿保险股份有限公司康健无忧两全保险'));
await runtime.processMessage(envelope('ding-a', 'product-followup', 'p-2', '主要保啥的呀，这个保险'));
assert.equal(routed[1].candidate.entities.productName, '新华人寿保险股份有限公司康健无忧两全保险');
```

and:

```js
await runtime.processMessage(envelope('ding-a', 'explicit-product', 'p-3', '新华人寿保险股份有限公司康健无忧两全保险，这个保险主要保啥的'));
assert.equal(routed[0].candidate.entities.productName, '新华人寿保险股份有限公司康健无忧两全保险');
```

Add a fallback test asserting `runtime === 'direct'`, the audit has `fallbackReason === 'HERMES_PROVIDER_FAILED'`, and a vague Direct result returns clarification instead of routing.

- [ ] **Step 2: Run the focused runtime tests and verify the regressions fail**

Run: `node --test tests/agent-conversation-runtime.test.mjs tests/agent-product-knowledge.test.mjs tests/agent-question-handlers.test.mjs tests/agent-question-routes.test.mjs`

Expected: FAIL because current product references and canonical product fields are not resolved before routing.

- [ ] **Step 3: Add runtime modes without changing the default production path**

Support constructor option `semanticResolutionMode` with allowed values:

```js
const semanticMode = ['legacy', 'shadow', 'enforced'].includes(semanticResolutionMode)
  ? semanticResolutionMode
  : 'shadow';
```

Behavior:

- `legacy`: route the compatibility candidate and write no semantic state;
- `shadow`: resolve and audit, but route the legacy candidate;
- `enforced`: route only an execution-ready semantic candidate; return controlled clarification otherwise.

Read `AGENT_SEMANTIC_RESOLUTION_MODE` in `server/app.mjs` without editing `.env.local`. Keep default `shadow` until shadow evaluation is accepted.

Add this compatibility converter in `server/agent-semantic-contract.mjs` for `legacy` and `shadow` routing only:

```js
export function semanticProposalToLegacyCandidate(proposal, question) {
  const productName = proposal.mentions.find((item) => item.type === 'product')?.rawText || '';
  const familyName = proposal.mentions.find((item) => item.type === 'family')?.rawText || '';
  return {
    intent: proposal.intent,
    question: String(question || '').trim().slice(0, 1_000),
    confidence: Number(proposal.confidence.intent || 0),
    requestedOperation: proposal.operation,
    ...((productName || familyName) ? { entities: {
      ...(productName ? { productName } : {}),
      ...(familyName ? { familyName } : {}),
    } } : {}),
  };
}
```

`legacy` keeps the compatibility candidate path during the migration window. `shadow` derives the same compatibility candidate from the validated proposal, routes it, and separately records the resolved candidate for comparison. `enforced` routes only the resolved candidate.

- [ ] **Step 4: Replace runtime interpretation flow with proposal plus resolver**

Track actual runtime and fallback reason:

```js
let proposal = null;
let usedRuntime = 'rule';
let fallbackReason = '';
try {
  const interpreted = await hermesClient.runTurn({
    sessionId: hermesSessionId,
    question,
    safeRecentContext: { history },
    requestId: String(channelEnvelope?.messageRef || ''),
  });
  proposal = interpreted.proposal;
  hermesSessionId = interpreted.sessionId;
  usedRuntime = 'hermes';
} catch (error) {
  fallbackReason = String(error?.code || 'HERMES_PROVIDER_FAILED');
}
if (!proposal) {
  try {
    proposal = await directInterpreter({ question, history, recentMessageLimit: settings.fallbackHistoryMessageLimit });
    usedRuntime = 'direct';
  } catch (error) {
    fallbackReason = fallbackReason || String(error?.code || 'AGENT_DIRECT_INTERPRETER_FAILED');
  }
}
const semantic = await semanticResolver.resolve({
  internalUserId: identity.internalUserId,
  question,
  proposal,
  runtime: usedRuntime,
  context,
  now: Number(now()),
});
```

For `clarify`, return a stable `interaction.type = 'clarification'`. Before routing or committing state, repeat the existing identity refresh check. On context version conflict, reload and retry one semantic commit; never overwrite another turn.

- [ ] **Step 5: Write the redacted semantic audit and commit confirmed task state**

Inject `semanticAuditStore`. Write only contract version, runtime, fallback reason, redacted mentions, match types, candidate counts, selected canonical IDs, decision, and reason. Do not copy full history or prompt into the semantic audit. Audit failure emits `AGENT_SEMANTIC_AUDIT_FAILED`; it does not relax semantic or router decisions.

- [ ] **Step 6: Pass canonical product identity to knowledge lookup**

In `server/agent-question-router.service.mjs`, include the internally normalized canonical fields only for the product knowledge handler:

```js
...(policy?.key === 'insurance_product_knowledge' ? {
  ...(candidate.entities.productName ? { productName: candidate.entities.productName } : {}),
  ...(candidate.entities.productCanonicalId ? { productCanonicalId: candidate.entities.productCanonicalId } : {}),
  ...(candidate.entities.productCompany ? { productCompany: candidate.entities.productCompany } : {}),
} : {}),
```

In the handler, call:

```js
await productKnowledge.search({
  question,
  productName,
  resolvedProduct: productCanonicalId || productCompany
    ? { canonicalProductId: productCanonicalId, company: productCompany, officialName: productName }
    : null,
  scope: 'public_read_only',
});
```

In product knowledge search, when `resolvedProduct.officialName` is present, start from that exact company/product pair and verify its persisted evidence. Do not re-run open-ended product-name extraction against the whole question. If the exact product exists but verified sources are absent, return the existing evidence-insufficient guidance.

- [ ] **Step 7: Keep runtime metadata internal to public responses**

Assert in `tests/agent-question-routes.test.mjs` that `/api/agent/messages` returns only the existing bounded public interaction while the semantic audit store receives the actual runtime. Do not expose candidate, internal IDs, fallback stack details, or audit payload through DingTalk.

- [ ] **Step 8: Run integration tests and commit**

Run: `node --test tests/agent-conversation-runtime.test.mjs tests/agent-product-knowledge.test.mjs tests/agent-question-handlers.test.mjs tests/agent-question-router.test.mjs tests/agent-question-routes.test.mjs`

Expected: PASS, including both 康健无忧 regressions and safe Direct fallback.

```bash
git add server/agent-conversation-runtime.service.mjs server/agent-semantic-contract.mjs server/agent-product-knowledge.service.mjs server/agent-question-handlers.service.mjs server/agent-question-router.service.mjs server/app.mjs server/routes/agent.routes.mjs tests/agent-conversation-runtime.test.mjs tests/agent-product-knowledge.test.mjs tests/agent-question-handlers.test.mjs tests/agent-question-router.test.mjs tests/agent-question-routes.test.mjs
git commit -m "feat: integrate agent semantic resolution"
```

## Task 9: Add evaluation fixtures, harness mapping, and staged acceptance gates

**Files:**

- Create: `tests/fixtures/agent-semantic-utterances.json`
- Modify: `tests/agent-semantic-resolver.test.mjs`
- Modify: `docs/harness-test-map.json`
- Modify: `docs/superpowers/specs/2026-07-14-agent-semantic-resolution-layer-design.md`

- [ ] **Step 1: Add a versioned, synthetic semantic utterance fixture**

Create exactly this initial synthetic fixture. Future additions must arrive through reviewed test changes and must not contain real customer data:

```json
[
  {
    "id": "product-explicit-kjwy",
    "question": "新华人寿保险股份有限公司康健无忧两全保险，这个保险主要保啥的",
    "expectedIntent": "insurance_product_knowledge",
    "expectedAspect": "main_responsibilities",
    "expectedProduct": "新华人寿保险股份有限公司康健无忧两全保险",
    "expectedDecision": "execute"
  },
  {
    "id": "product-current-reference",
    "question": "主要保啥的呀，这个保险",
    "activeProduct": "新华人寿保险股份有限公司康健无忧两全保险",
    "expectedIntent": "insurance_product_knowledge",
    "expectedProduct": "新华人寿保险股份有限公司康健无忧两全保险",
    "expectedDecision": "execute"
  },
  {
    "id": "family-current-reference",
    "question": "这个家庭保障缺口呢",
    "activeFamily": "测试家庭甲",
    "expectedIntent": "coverage_report",
    "expectedFamily": "测试家庭甲",
    "expectedDecision": "execute"
  },
  {
    "id": "ambiguous-product",
    "question": "康健无忧两全保险保什么",
    "expectedIntent": "insurance_product_knowledge",
    "expectedDecision": "clarify"
  }
]
```

- [ ] **Step 2: Add a table-driven resolver evaluation test**

Load the fixture with `readFile` and assert every case's intent, aspect, resolved display name, and decision. The test must fail on any silent selection in an ambiguous case and must assert unauthorized families never appear in candidates.

- [ ] **Step 3: Map semantic files to focused harness tests**

Extend `hermes-question-routing` patterns with all `server/agent-semantic-*.mjs`, both entity resolvers, the conversation runtime/client/context files, and their focused tests. Add commands:

```json
"node --test tests/agent-semantic-contract.test.mjs",
"node --test tests/agent-product-entity-resolver.test.mjs",
"node --test tests/agent-family-entity-resolver.test.mjs",
"node --test tests/agent-semantic-resolver.test.mjs",
"node --test tests/agent-conversation-runtime.test.mjs"
```

- [ ] **Step 4: Run the complete backend verification gate**

Run: `npm run check`

Expected: PASS.

Run: `npm test`

Expected: PASS.

Run: `npm run harness:audit`

Expected: PASS with the semantic focused tests selected by the harness map.

- [ ] **Step 5: Record implemented and manual rollout status in the design**

Change the design status to `已实施，待影子流量验收` only after the prior commands pass. Record these remaining manual gates explicitly:

- development DingTalk shadow traffic comparison;
- review of semantic audit redaction samples;
- approval to change `AGENT_SEMANTIC_RESOLUTION_MODE` from `shadow` to `enforced`;
- synthetic end-to-end test in the DingTalk test enterprise.

- [ ] **Step 6: Commit the evaluation and harness gate**

```bash
git add tests/fixtures/agent-semantic-utterances.json tests/agent-semantic-resolver.test.mjs docs/harness-test-map.json docs/superpowers/specs/2026-07-14-agent-semantic-resolution-layer-design.md
git commit -m "test: gate agent semantic resolution rollout"
```

## Final implementation review

- [ ] Confirm every model output passes `normalizeSemanticProposal()` before use.
- [ ] Confirm no external request can supply a trusted internal user, family, or product ID.
- [ ] Confirm ambiguous products and families produce clarification rather than silent selection.
- [ ] Confirm product and family active contexts expire independently.
- [ ] Confirm Hermes, Direct, and rule runtime are recorded per request.
- [ ] Confirm semantic audit contains no full prompt, full history, phone number, policy number, or raw attachment.
- [ ] Confirm write operations still enter the existing confirmation path.
- [ ] Confirm product facts still come only from verified OCR Insurance evidence.
- [ ] Confirm no `.env.local`, `.runtime/`, production data, or production process was modified.
