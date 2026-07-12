# Hermes Configurable Question Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a configurable OCR Insurance policy router that turns Hermes intent candidates into authorized, auditable DingTalk answers, report links, clarifications, and confirmed write workflows.

**Architecture:** Hermes remains an untrusted natural-language interpreter. A new server-side policy service normalizes the candidate intent, resolves authorized resources, selects an allow-listed handler, and returns a channel-neutral interaction model. SQLite stores policy versions, unknown-intent events, confirmations, and audit records; the admin UI edits drafts, runs non-mutating simulations, publishes versions, and rolls back.

**Tech Stack:** Node.js ESM, Express, SQLite-backed state store, Node test runner, React, TypeScript, Vite, existing insurance expert/sales/report services.

---

## Scope and file map

This plan implements the first deployable slice from the approved design. It includes built-in read strategies, family/report routing, unknown-intent fallback, policy administration, audit, and one confirmed policy-transfer workflow. It does not add C-end-user access, DingTalk policy-file upload, group-chat customer access, or arbitrary database actions.

New files have one responsibility each:

- `server/agent-question-policy.service.mjs`: built-in policy schema, validation, matching, and published-version selection.
- `server/agent-question-router.service.mjs`: authorized routing and channel-neutral decisions.
- `server/agent-question-handlers.service.mjs`: allow-listed read handlers and report orchestration.
- `server/agent-confirmation.service.mjs`: expiring confirmations and transfer execution.
- `server/routes/agent.routes.mjs`: thin Hermes gateway endpoints.
- `src/apps/admin/pages/AdminAgentPoliciesPage.tsx`: policy list/editor/test/publish UI.
- `tests/agent-question-*.test.mjs`: focused domain, route, persistence, and safety tests.

Existing files are modified only to wire these units into the application, persistence, admin API, and navigation.

### Task 1: Define and validate the built-in question policies

**Files:**
- Create: `server/agent-question-policy.service.mjs`
- Create: `tests/agent-question-policy.test.mjs`

- [ ] **Step 1: Write the failing tests for safe defaults and validation**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BUILTIN_AGENT_QUESTION_POLICIES,
  validateAgentQuestionPolicy,
  chooseAgentQuestionPolicy,
} from '../server/agent-question-policy.service.mjs';

test('built-ins route reports to separate domain agents', () => {
  assert.equal(chooseAgentQuestionPolicy({ intent: 'view_family_coverage_report' }).handler, 'insurance_expert');
  assert.equal(chooseAgentQuestionPolicy({ intent: 'view_sales_advice_report' }).handler, 'sales_champion');
});

test('unknown writes are denied while unknown knowledge remains read-only', () => {
  assert.equal(chooseAgentQuestionPolicy({ intent: 'unknown', requestedOperation: 'read' }).decision, 'execute');
  assert.equal(chooseAgentQuestionPolicy({ intent: 'unknown', requestedOperation: 'write' }).decision, 'deny');
});

test('policy validation rejects arbitrary tools and unconfirmed writes', () => {
  assert.throws(() => validateAgentQuestionPolicy({
    key: 'bad', handler: 'deterministic', allowedTools: ['shell'], operation: 'write', confirmation: 'none',
  }), /tool_not_allowed|write_requires_confirmation/u);
});

test('built-in keys are unique', () => {
  assert.equal(new Set(BUILTIN_AGENT_QUESTION_POLICIES.map((row) => row.key)).size, BUILTIN_AGENT_QUESTION_POLICIES.length);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test tests/agent-question-policy.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the minimal immutable policy catalog**

Define explicit enums for `decision`, `handler`, `operation`, `confirmation`, `outputMode`, and an allow-list of tool names. Include policies for family summary, coverage report, sales report, insurance/product knowledge, sales coaching, upload-link, memory proposal, transfer preview, system help, chat, unknown read, and unknown write. `chooseAgentQuestionPolicy` must match exact normalized intent first and then select the operation-specific unknown policy; it must never use free-form model text as a tool name.

```js
export function chooseAgentQuestionPolicy(candidate = {}, policies = BUILTIN_AGENT_QUESTION_POLICIES) {
  const intent = normalizeIntent(candidate.intent);
  const exact = policies.find((row) => row.enabled !== false && row.intents.includes(intent));
  if (exact) return structuredClone(exact);
  const fallbackKey = candidate.requestedOperation === 'write' ? 'unknown_write' : 'unknown_read';
  return structuredClone(policies.find((row) => row.key === fallbackKey));
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `node --test tests/agent-question-policy.test.mjs`  
Expected: 4 passing tests.

- [ ] **Step 5: Commit the policy domain**

```bash
git add server/agent-question-policy.service.mjs tests/agent-question-policy.test.mjs
git commit -m "feat: define safe agent question policies"
```

### Task 2: Persist versioned policies, unknown questions, confirmations, and audit

**Files:**
- Modify: `server/sqlite-state-store.mjs`
- Modify: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Add failing persistence tests**

Add a test that opens a temporary SQLite store and verifies:

```js
const draft = store.createAgentQuestionPolicyDraft({ adminUser: 'admin', policies: BUILTIN_AGENT_QUESTION_POLICIES });
const published = store.publishAgentQuestionPolicyVersion({ draftId: draft.id, adminUser: 'admin' });
assert.equal(store.getPublishedAgentQuestionPolicyVersion().id, published.id);

const unknown = store.appendAgentUnknownQuestion({ userId: 8, messageRef: 'msg-1', normalizedQuestion: '办理家庭转交', fallbackDecision: 'deny' });
assert.equal(store.listAgentUnknownQuestions({ limit: 10 })[0].id, unknown.id);

const confirmation = store.createAgentActionConfirmation({ userId: 8, action: 'transfer_policy', payload: { policyId: 3 }, expiresAt: '2099-01-01T00:00:00.000Z' });
assert.equal(store.consumeAgentActionConfirmation({ id: confirmation.id, userId: 8 }).status, 'consumed');
assert.equal(store.consumeAgentActionConfirmation({ id: confirmation.id, userId: 8 }).status, 'already_consumed');
```

- [ ] **Step 2: Run the focused persistence test and verify it fails**

Run: `node --test tests/sqlite-state-store.test.mjs --test-name-pattern "agent question"`  
Expected: FAIL because the four store methods do not exist.

- [ ] **Step 3: Add four narrow SQLite tables and store methods**

Add `agent_question_policy_versions`, `agent_unknown_questions`, `agent_action_confirmations`, and `agent_route_audit_events`. Store policy and bounded decision payloads as JSON, with timestamps, actor, status, and version. Add narrow methods only; route handlers must not call `persist(state)`.

```sql
CREATE TABLE IF NOT EXISTS agent_question_policy_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL CHECK(status IN ('draft','published','archived')),
  policies_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT
);
```

Confirmation consumption must use one transaction and update only a matching unconsumed, unexpired row owned by the internal user.

- [ ] **Step 4: Run SQLite tests**

Run: `node --test tests/sqlite-state-store.test.mjs`  
Expected: PASS, including duplicate consumption protection.

- [ ] **Step 5: Commit persistence**

```bash
git add server/sqlite-state-store.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: persist agent routing policies and audit"
```

### Task 3: Build the authorized question router and family resolver

**Files:**
- Create: `server/agent-question-router.service.mjs`
- Create: `tests/agent-question-router.test.mjs`

- [ ] **Step 1: Write failing routing tests**

Cover unique family resolution, ambiguous family clarification, pronoun context expiry, unauthorized-family nondisclosure, low-confidence clarification, and unknown-write denial.

```js
test('routes a uniquely named family without listing all families', async () => {
  const result = await router.route({
    internalUserId: 8,
    candidate: { intent: 'family_policy_summary', entities: { familyName: '余贵祥' }, confidence: 0.95 },
  });
  assert.equal(result.decision, 'execute');
  assert.equal(result.authorizedContext.familyId, 61);
  assert.equal(result.interaction.type, 'answer');
  assert.doesNotMatch(JSON.stringify(result), /全部家庭/u);
});

test('does not reveal an inaccessible family', async () => {
  const result = await router.route({
    internalUserId: 9,
    candidate: { intent: 'family_policy_summary', entities: { familyName: '余贵祥' }, confidence: 0.95 },
  });
  assert.equal(result.decision, 'clarify');
  assert.doesNotMatch(result.interaction.text, /存在|余贵祥/u);
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `node --test tests/agent-question-router.test.mjs`  
Expected: FAIL with missing router module.

- [ ] **Step 3: Implement server-owned routing**

Export `createAgentQuestionRouter({ store, handlers, clock })`. Normalize Hermes input, reject unknown fields, select the published policy, apply its confidence threshold, resolve family names only inside the current user’s authorized family set, and create a channel-neutral interaction object. Never accept a Hermes-provided `familyId` as authorization evidence.

The interaction type must be one of `answer`, `clarification`, `confirmation`, `progress`, `secure_link`, or `denied`.

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/agent-question-router.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit routing**

```bash
git add server/agent-question-router.service.mjs tests/agent-question-router.test.mjs
git commit -m "feat: route Hermes questions with server authorization"
```

### Task 4: Add allow-listed handlers for summaries, reports, knowledge, and upload links

**Files:**
- Create: `server/agent-question-handlers.service.mjs`
- Create: `tests/agent-question-handlers.test.mjs`
- Modify: `server/family-policy-analysis-report.service.mjs`
- Modify: `server/family-sales-review.service.mjs`

- [ ] **Step 1: Write failing handler tests**

Test that policy counts come from current family records, stale/missing coverage and sales reports enqueue regeneration, existing fresh reports return a masked summary and secure authenticated URL, product answers include sources, and upload requests return the C-end upload URL without accepting an attachment.

```js
assert.deepEqual(await handlers.execute('family_policy_summary', context), {
  kind: 'answer',
  facts: { familyName: '余贵祥', memberCount: 3, activePolicyCount: 5 },
  sensitiveFields: [],
});

const pending = await handlers.execute('view_family_coverage_report', staleContext);
assert.equal(pending.kind, 'progress');
assert.equal(pending.jobType, 'family_coverage_report');
```

- [ ] **Step 2: Verify the handler tests fail**

Run: `node --test tests/agent-question-handlers.test.mjs`  
Expected: FAIL with missing module.

- [ ] **Step 3: Implement the handler registry**

Use an immutable registry keyed by policy handler action. Reuse existing family report, policy-analysis report, sales-review, product knowledge, and share-link services. Add narrow freshness helpers to the two report services instead of duplicating timestamp logic in the router. Return facts and provenance separately from presentation text so Hermes cannot alter protected values.

- [ ] **Step 4: Run report and handler tests**

Run: `node --test tests/agent-question-handlers.test.mjs tests/family-policy-analysis-report.test.mjs tests/family-sales-review.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit handlers**

```bash
git add server/agent-question-handlers.service.mjs server/family-policy-analysis-report.service.mjs server/family-sales-review.service.mjs tests/agent-question-handlers.test.mjs
git commit -m "feat: add agent question handlers"
```

### Task 5: Expose a thin authenticated Hermes gateway

**Files:**
- Create: `server/routes/agent.routes.mjs`
- Modify: `server/app.mjs`
- Create: `tests/agent-question-routes.test.mjs`

- [ ] **Step 1: Write failing route tests**

Cover missing service authentication, unregistered DingTalk user, valid internal-user mapping, malformed candidate JSON, read routing, and denial of raw policy attachments.

```js
const response = await request(app).post('/api/agent/questions/route').send({
  channel: 'dingtalk',
  channelUserId: 'ding-user-8',
  messageRef: 'msg-18',
  candidate: { intent: 'view_family_coverage_report', entities: { familyName: '余贵祥' }, confidence: 0.96 },
});
assert.equal(response.status, 200);
assert.equal(response.body.interaction.type, 'secure_link');
```

- [ ] **Step 2: Verify route tests fail**

Run: `node --test tests/agent-question-routes.test.mjs`  
Expected: FAIL because the endpoint is absent.

- [ ] **Step 3: Implement and wire the route**

Add `POST /api/agent/questions/route` and `POST /api/agent/actions/:confirmationId/confirm`. Reuse the existing DingTalk-to-internal-user resolver; if this resolver is currently outside the repository, inject it through `createApp` rather than duplicating phone matching. Require a service credential at the gateway boundary and pass only the resolved internal `userId` to domain services. Cap question length and reject attachments with `DINGTALK_POLICY_UPLOAD_DISABLED` plus the secure upload link action.

- [ ] **Step 4: Run API tests**

Run: `node --test tests/agent-question-routes.test.mjs tests/agent-policy-import.test.mjs`  
Expected: PASS and existing policy-upload privacy behavior unchanged.

- [ ] **Step 5: Commit the gateway**

```bash
git add server/routes/agent.routes.mjs server/app.mjs tests/agent-question-routes.test.mjs
git commit -m "feat: expose authenticated Hermes question gateway"
```

### Task 6: Implement confirmed cross-family policy transfer

**Files:**
- Create: `server/agent-confirmation.service.mjs`
- Create: `tests/agent-confirmation.test.mjs`
- Modify: `server/sqlite-state-store.mjs`
- Modify: `docs/harness-test-map.json`

- [ ] **Step 1: Write failing preview and execution tests**

Test unique preview, similar-policy clarification, missing target member, unauthorized target, duplicate target policy, expired confirmation, double confirmation, and successful transaction with report invalidation.

```js
const preview = await service.previewPolicyTransfer({
  userId: 8,
  sourceFamilyName: '余贵祥',
  targetFamilyName: '温萍',
  policyHint: '平安福重疾险',
});
assert.equal(preview.interaction.type, 'confirmation');
assert.match(preview.interaction.text, /尾号 3812/u);

const result = await service.confirm({ userId: 8, confirmationId: preview.confirmationId });
assert.equal(result.status, 'completed');
assert.equal(store.getPolicy(3).familyId, 72);
assert.equal(store.getFamilyReport(61).status, 'stale');
assert.equal(store.getFamilyReport(72).status, 'stale');
```

- [ ] **Step 2: Verify the tests fail**

Run: `node --test tests/agent-confirmation.test.mjs`  
Expected: FAIL with missing confirmation service.

- [ ] **Step 3: Implement preview and atomic transfer**

The preview reads current state and stores only internal IDs plus a state version/hash. Confirmation consumes the token once, rechecks authorization and preconditions, updates the policy family through a narrow SQLite transaction, records before/after IDs, marks both coverage and sales reports stale, and enqueues regeneration. Never modify OCR evidence or source records.

- [ ] **Step 4: Map and run the high-risk focused test**

Add the new service/test mapping to `docs/harness-test-map.json`.

Run: `node --test tests/agent-confirmation.test.mjs && npm run harness:audit`  
Expected: PASS with no naked route persistence warning.

- [ ] **Step 5: Commit transfer workflow**

```bash
git add server/agent-confirmation.service.mjs server/sqlite-state-store.mjs tests/agent-confirmation.test.mjs docs/harness-test-map.json
git commit -m "feat: confirm cross-family policy transfers"
```

### Task 7: Add admin policy APIs and non-mutating simulation

**Files:**
- Modify: `server/routes/admin.routes.mjs`
- Create: `tests/admin-agent-question-policy.test.mjs`

- [ ] **Step 1: Write failing admin API tests**

Cover list/current version, create draft, reject invalid tool, simulate without data mutation, publish, and rollback.

```js
const before = snapshotBusinessCounts(store);
const simulation = await admin.post('/api/admin/agent-question-policies/simulate').send({
  question: '把余贵祥家庭的平安福转到温萍家庭',
  candidate: { intent: 'transfer_policy_between_families', confidence: 0.96 },
});
assert.equal(simulation.status, 200);
assert.equal(simulation.body.decision.confirmation, 'required');
assert.deepEqual(snapshotBusinessCounts(store), before);
```

- [ ] **Step 2: Verify admin tests fail**

Run: `node --test tests/admin-agent-question-policy.test.mjs`  
Expected: FAIL with 404 responses.

- [ ] **Step 3: Add thin admin endpoints**

Add:

- `GET /api/admin/agent-question-policies`
- `POST /api/admin/agent-question-policies/drafts`
- `PATCH /api/admin/agent-question-policies/drafts/:id`
- `POST /api/admin/agent-question-policies/simulate`
- `POST /api/admin/agent-question-policies/drafts/:id/publish`
- `POST /api/admin/agent-question-policies/versions/:id/rollback`
- `GET /api/admin/agent-unknown-questions`

Routes validate input and delegate to policy/router/store services. Simulation must use fixtures or read-only state and force all write decisions to preview-only.

- [ ] **Step 4: Run admin tests**

Run: `node --test tests/admin-agent-question-policy.test.mjs`  
Expected: PASS.

- [ ] **Step 5: Commit admin APIs**

```bash
git add server/routes/admin.routes.mjs tests/admin-agent-question-policy.test.mjs
git commit -m "feat: administer agent question policies"
```

### Task 8: Build the Agent strategy admin page

**Files:**
- Modify: `src/api/contracts/admin.ts`
- Modify: `src/apps/admin/adminPages.ts`
- Modify: `src/apps/admin/AdminApp.tsx`
- Create: `src/apps/admin/pages/AdminAgentPoliciesPage.tsx`
- Create: `tests/admin-agent-policies-ui.test.mjs`

- [ ] **Step 1: Write a failing UI contract test**

Following existing static UI tests, assert that the page exposes status, handler, allowed tools, data scope, confirmation, output mode, threshold, simulation result, publish, rollback, and unknown-question controls; assert there is no free-form system Prompt editor.

- [ ] **Step 2: Verify the UI test fails**

Run: `node --test tests/admin-agent-policies-ui.test.mjs`  
Expected: FAIL because the page does not exist.

- [ ] **Step 3: Add typed API contracts**

Define `AdminAgentQuestionPolicy`, `AdminAgentQuestionPolicyVersion`, `AdminAgentQuestionSimulation`, and `AdminAgentUnknownQuestion`, plus request helpers for the Task 7 endpoints. Use literal unions matching Task 1 enums.

- [ ] **Step 4: Implement the focused admin page**

Add “Agent 策略管理” under the system group. Render built-in policies as editable cards using selects, numeric threshold input, switches, and tool checkboxes. Add a simulation panel that displays intent, entity, family-match result, handler, tools, confirmation, and masking rules. Keep draft changes local until “保存草稿”; require an explicit “发布” action and show current version. Do not expose arbitrary Prompt text editing.

- [ ] **Step 5: Run frontend verification**

Run: `node --test tests/admin-agent-policies-ui.test.mjs && npm run typecheck && npm run build`  
Expected: all commands PASS.

- [ ] **Step 6: Commit the admin UI**

```bash
git add src/api/contracts/admin.ts src/apps/admin/adminPages.ts src/apps/admin/AdminApp.tsx src/apps/admin/pages/AdminAgentPoliciesPage.tsx tests/admin-agent-policies-ui.test.mjs
git commit -m "feat: add agent strategy administration"
```

### Task 9: End-to-end safety and regression verification

**Files:**
- Modify: `tests/agent-question-routes.test.mjs`
- Modify: `docs/superpowers/specs/2026-07-12-hermes-configurable-question-routing-design.md`

- [ ] **Step 1: Add acceptance scenarios from the spec**

Add table-driven route tests for:

- “余贵祥家庭有几个保单” → exact authorized count;
- “看余贵祥家庭保障报告” → fresh summary or regeneration progress;
- “给我销售建议” → sales champion handler;
- “那我该怎么跟他聊” → reuse explicit unexpired family context;
- unknown public knowledge → read-only answer;
- unknown write → denial without tool execution;
- transfer → confirmation card, never immediate mutation;
- raw DingTalk policy attachment → secure C-end upload link;
- Hermes outage → stable retry response without guessed insurance facts.

- [ ] **Step 2: Run focused Agent verification**

Run: `node --test tests/agent-question-policy.test.mjs tests/agent-question-router.test.mjs tests/agent-question-handlers.test.mjs tests/agent-question-routes.test.mjs tests/agent-confirmation.test.mjs tests/admin-agent-question-policy.test.mjs tests/admin-agent-policies-ui.test.mjs`  
Expected: PASS.

- [ ] **Step 3: Run the required cross-boundary gate**

Run: `npm run check && npm run typecheck && npm test && npm run build`  
Expected: PASS. If unrelated pre-existing dirty-worktree failures occur, record the exact failing command and isolate whether changed files caused it before proceeding.

- [ ] **Step 4: Update implementation status in the design**

Change the design status to implemented only after the API, UI, persistence, safety tests, and verification gate pass. Record any real DingTalk/Hermes credential or enterprise test that remains manual; do not claim production validation from local tests.

- [ ] **Step 5: Commit acceptance coverage and status**

```bash
git add tests/agent-question-routes.test.mjs docs/superpowers/specs/2026-07-12-hermes-configurable-question-routing-design.md
git commit -m "test: verify Hermes question routing workflows"
```

## Completion criteria

- Every Hermes candidate is re-authorized and constrained by a published OCR Insurance strategy.
- Family questions use natural unique matching and minimal clarification, never a mechanical full-family list.
- Coverage and sales reports route to the correct domain Agent and automatically refresh when stale.
- Unknown read questions have a safe answer path; unknown writes cannot execute.
- Policy transfer is previewed, confirmed, atomic, auditable, and invalidates both families’ reports.
- Admins can draft, simulate, publish, roll back, and review unknown questions without editing raw system prompts.
- DingTalk policy originals remain disabled and are redirected to a secure C-end upload link.
- Focused tests and the project’s cross-boundary verification gate pass.
