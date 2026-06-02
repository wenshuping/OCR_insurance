# Project Boundary Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the current large backend and frontend entry files into owner-based route/service and feature modules while preserving existing behavior.

**Architecture:** Keep the app as a modular monolith with an OCR sidecar. Refactor by ownership: first create shared backend route context and move Express routes into route modules, then move frontend utilities/components into feature folders, then split API contracts by owner. No API URL, response shape, database table, UI design, or deployment behavior should change.

**Tech Stack:** Node.js ESM, Express 4, React 19, TypeScript, Vite, SQLite via `node:sqlite`, existing Node test runner, existing `zod` dependency.

---

## Scope Notes

This plan implements the first optimization slice from `docs/superpowers/specs/2026-06-02-project-boundary-optimization-design.md`.

It does not:

- Change product behavior.
- Change API URLs.
- Change database schema.
- Replace SQLite.
- Split runtime services beyond the existing OCR sidecar.
- Introduce Redux, Zustand, or a new routing framework.
- Refactor insurer crawler behavior.

The current checkout may contain unrelated uncommitted application changes and `graphify-out/`. Before every task, run `git status --short` and stage only files listed in that task.

## Files

Backend route shell and owner modules:

- Modify: `server/app.mjs`
  - Keep `createPolicyOcrApp(options)` as the public factory.
  - Reduce it to app/context creation and route mounting.
- Create: `server/http/context.mjs`
  - Build route context from the existing `createPolicyOcrApp` dependencies.
- Create: `server/http/errors.mjs`
  - Host shared route error helpers moved from `server/app.mjs`.
- Create: `server/routes/wechat.routes.mjs`
- Create: `server/routes/auth.routes.mjs`
- Create: `server/routes/responsibilities.routes.mjs`
- Create: `server/routes/families.routes.mjs`
- Create: `server/routes/cashflow.routes.mjs`
- Create: `server/routes/policies.routes.mjs`
- Create: `server/routes/admin.routes.mjs`
- Create: `server/services/policy-workflow.service.mjs`
  - Host cross-owner policy scan/report orchestration that does not belong in route handlers.
- Create: `server/services/family-workflow.service.mjs`
  - Host family binding and share orchestration that crosses policy/family state.

Frontend feature modules:

- Modify: `src/App.tsx`
  - Reduce toward app shell and top-level composition.
- Create: `src/shared/formatters.ts`
- Create: `src/shared/errors.ts`
- Create: `src/shared/image-utils.ts`
- Create: `src/features/report-export/report-export.ts`
- Create: `src/apps/customer/CustomerApp.tsx`
- Create: `src/apps/admin/AdminApp.tsx`
- Create: `src/features/family-profile/FamilyProfileManager.tsx`
- Create: `src/features/policy-entry/UploadPolicyPage.tsx`
- Create: `src/features/policy-detail/PolicyDetailSheet.tsx`
- Create: `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`

API grouping:

- Modify: `src/api.ts`
  - Keep as compatibility barrel during the first slice.
- Create: `src/api/client.ts`
- Create: `src/api/contracts/policy.ts`
- Create: `src/api/contracts/family.ts`
- Create: `src/api/contracts/admin.ts`
- Create: `src/api/contracts/responsibility.ts`
- Create: `src/api/contracts/cashflow.ts`

Documentation:

- Create: `docs/architecture/owner-map.md`

Tests:

- Existing: `tests/policy-ocr-flow.test.mjs`
- Existing: `tests/family-profile-domain.test.mjs`
- Existing: `tests/family-report-engine.test.mjs`
- Existing: `tests/cashflow-store.test.mjs`
- Existing: `tests/policy-responsibility-query.test.mjs`
- Existing: `tests/customer-ui-style.test.mjs`

## Task 1: Baseline and Safety Checks

**Files:**
- Read only: `server/app.mjs`
- Read only: `src/App.tsx`
- Read only: `src/api.ts`
- Read only: `graphify-out/GRAPH_REPORT.md`

- [ ] **Step 1: Confirm dirty worktree boundaries**

Run:

```bash
git status --short
```

Expected: existing unrelated modified files may appear. Do not stage any file unless the current task lists it.

- [ ] **Step 2: Confirm current test baseline**

Run:

```bash
npm run check
npm run typecheck
npm run test
```

Expected: all commands pass before refactoring. If a command fails because of unrelated current dirty work, record the failure text in the task notes and do not treat the route split as the cause.

- [ ] **Step 3: Confirm current build baseline**

Run:

```bash
npm run build
```

Expected: Vite build completes and writes `dist/`.

- [ ] **Step 4: Record current API route count**

Run:

```bash
rg -n "app\\.(get|post|put|patch|delete)\\(" server/app.mjs | wc -l
```

Expected: current route count is around `43`. Use this number later to confirm routes were moved, not lost.

## Task 2: Create Backend HTTP Context and Error Helpers

**Files:**
- Create: `server/http/context.mjs`
- Create: `server/http/errors.mjs`
- Modify: `server/app.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Create `server/http/errors.mjs`**

Create `server/http/errors.mjs` with shared error helpers moved from `server/app.mjs`:

```js
export function codeFromError(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

export function statusFromError(error) {
  const code = codeFromError(error);
  if (code.endsWith('_UNAUTHORIZED') || code === 'AUTH_REQUIRED') return 401;
  if (code.endsWith('_FORBIDDEN')) return 403;
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code.endsWith('_CONFLICT')) return 409;
  if (code.endsWith('_INVALID') || code.endsWith('_MISSING')) return 400;
  return 500;
}

export function sendError(res, error, fallbackStatus = 500) {
  const status = statusFromError(error) || fallbackStatus;
  const code = codeFromError(error) || 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : '请求处理失败';
  return res.status(status).json({ ok: false, code, message });
}
```

- [ ] **Step 2: Create `server/http/context.mjs`**

Create `server/http/context.mjs`:

```js
export function createRouteContext(options) {
  return Object.freeze({ ...options });
}
```

This intentionally starts small. It creates one named object that route modules can receive without changing behavior.

- [ ] **Step 3: Import helpers in `server/app.mjs`**

In `server/app.mjs`, import:

```js
import { createRouteContext } from './http/context.mjs';
import { codeFromError, sendError, statusFromError } from './http/errors.mjs';
```

Remove the local `codeFromError`, `statusFromError`, and `sendError` function declarations from `server/app.mjs`.

- [ ] **Step 4: Create route context in `createPolicyOcrApp`**

Inside `createPolicyOcrApp(options)`, after all existing shared values are initialized and before routes are mounted, add:

```js
  const routeContext = createRouteContext({
    state,
    persist,
    scanner,
    analyzer,
    adminPassword,
    performanceLogger,
    cashflowStore,
    cashValueStore,
    computeAndStoreCashflow,
    recomputeAllCashflow,
  });
```

Do not use `routeContext` yet in this task.

- [ ] **Step 5: Run focused backend flow test**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Run syntax check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add server/http/context.mjs server/http/errors.mjs server/app.mjs
git commit -m "refactor: add backend route context helpers"
```

## Task 3: Extract WeChat and Client Performance Routes

**Files:**
- Create: `server/routes/wechat.routes.mjs`
- Create: `server/routes/client-performance.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Create `server/routes/wechat.routes.mjs`**

Create:

```js
import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createWechatRoutes(context) {
  const router = express.Router();
  const { createWechatJsSdkSignature } = context;

  router.get('/js-sdk-signature', async (req, res) => {
    try {
      const payload = await createWechatJsSdkSignature(req.query?.url);
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
```

- [ ] **Step 2: Create `server/routes/client-performance.routes.mjs`**

Create:

```js
import express from 'express';

export function createClientPerformanceRoutes(context) {
  const router = express.Router();
  const { performanceLogger, sanitizeClientPerformancePayload, logPerformance } = context;

  router.post('/', (req, res) => {
    const payload = sanitizeClientPerformancePayload(req.body || {});
    logPerformance(performanceLogger, 'client-perf', payload);
    return res.json({ ok: true });
  });

  return router;
}
```

- [ ] **Step 3: Export private helpers through context**

In `server/app.mjs`, include these existing local functions in `routeContext`:

```js
    createWechatJsSdkSignature,
    sanitizeClientPerformancePayload,
    logPerformance,
```

- [ ] **Step 4: Mount the route modules**

In `server/app.mjs`, import:

```js
import { createWechatRoutes } from './routes/wechat.routes.mjs';
import { createClientPerformanceRoutes } from './routes/client-performance.routes.mjs';
```

Replace the existing route handlers for:

```text
GET /api/wechat/js-sdk-signature
POST /api/client-perf
```

with:

```js
  app.use('/api/wechat', createWechatRoutes(routeContext));
  app.use('/api/client-perf', createClientPerformanceRoutes(routeContext));
```

- [ ] **Step 5: Run syntax and flow tests**

Run:

```bash
npm run check
node --test tests/policy-ocr-flow.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add server/app.mjs server/routes/wechat.routes.mjs server/routes/client-performance.routes.mjs
git commit -m "refactor: extract wechat and client performance routes"
```

## Task 4: Extract Auth Routes

**Files:**
- Create: `server/routes/auth.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`
- Test: `tests/sms-delivery-config.test.mjs`

- [ ] **Step 1: Create `server/routes/auth.routes.mjs`**

Create an Express router that owns:

```text
POST /send-code
POST /register
POST /logout
```

The module signature must be:

```js
import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createAuthRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    requireAuth,
    normalizeMobile,
    assertValidMobile,
    normalizeSmsCode,
    latestValidSmsCode,
    publicUser,
    createSession,
    deleteSession,
    smsDelivery,
    assertSmsSendAllowed,
    hasPendingSmsCode,
    normalizeSmsSendError,
  } = context;

  router.post('/send-code', async (req, res) => {
    try {
      const mobile = normalizeMobile(req.body?.mobile);
      assertValidMobile(mobile);
      assertSmsSendAllowed(state, mobile);
      const delivery = await smsDelivery.send({ mobile });
      state.smsCodes.push(delivery.smsCode);
      await persist(state);
      return res.json({
        ok: true,
        mobile,
        expiresAt: delivery.smsCode.expiresAt,
        alreadyPending: hasPendingSmsCode(state, mobile),
      });
    } catch (error) {
      return sendError(res, normalizeSmsSendError(error));
    }
  });

  router.post('/register', async (req, res) => {
    try {
      const mobile = normalizeMobile(req.body?.mobile);
      const code = normalizeSmsCode(req.body?.code);
      assertValidMobile(mobile);
      const smsCode = latestValidSmsCode(state, { mobile, code });
      if (!smsCode) {
        return res.status(400).json({ ok: false, code: 'SMS_CODE_INVALID', message: '验证码无效或已过期' });
      }
      smsCode.used = true;
      const now = new Date().toISOString();
      let user = state.users.find((row) => row.mobile === mobile);
      if (!user) {
        user = { id: context.allocateId(state), mobile, createdAt: now, updatedAt: now };
        state.users.push(user);
      } else {
        user.updatedAt = now;
      }
      const token = createSession(state, user.id);
      await persist(state);
      return res.json({ ok: true, token, user: publicUser(user) });
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/logout', async (req, res) => {
    const user = requireAuth(req, res, state);
    if (!user) return undefined;
    deleteSession(state, req.token);
    await persist(state);
    return res.json({ ok: true });
  });

  return router;
}
```

Implementation requirement: compare the new auth router against the current auth handlers in `server/app.mjs` before deleting the old handlers. Any response field currently returned by the old handlers must still be returned by the new router. This is a behavior-preserving move, not a rewrite.

- [ ] **Step 2: Add auth dependencies to `routeContext`**

In `server/app.mjs`, add the existing imported/local helpers and services used by auth routes to `routeContext`.

At minimum include:

```js
    requireAuth,
    normalizeMobile,
    assertValidMobile,
    normalizeSmsCode,
    latestValidSmsCode,
    publicUser,
    createSession,
    deleteSession,
    allocateId,
    smsDelivery,
    assertSmsSendAllowed,
    hasPendingSmsCode,
    normalizeSmsSendError,
```

- [ ] **Step 3: Mount auth router**

In `server/app.mjs`, import:

```js
import { createAuthRoutes } from './routes/auth.routes.mjs';
```

Replace the existing `/api/auth/*` route declarations with:

```js
  app.use('/api/auth', createAuthRoutes(routeContext));
```

- [ ] **Step 4: Run auth-related tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs
node --test tests/sms-delivery-config.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Run syntax check**

Run:

```bash
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add server/app.mjs server/routes/auth.routes.mjs
git commit -m "refactor: extract auth routes"
```

## Task 5: Extract Responsibility Routes

**Files:**
- Create: `server/routes/responsibilities.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/policy-responsibility-query.test.mjs`
- Test: `tests/policy-optional-responsibility.test.mjs`

- [ ] **Step 1: Create `server/routes/responsibilities.routes.mjs`**

Create an Express router that owns these routes under `/api/policy-responsibilities`:

```text
POST /query
POST /local-draft
GET /company-suggestions
GET /product-suggestions
POST /matches
```

Use this module shell:

```js
import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createResponsibilityRoutes(context) {
  const router = express.Router();
  const {
    state,
    normalizeResponsibilityQueryInput,
    buildResponsibilityCompanySuggestions,
    buildResponsibilityProductSuggestions,
    buildRecognizedPolicyAnalysisDraft,
    queryPolicyResponsibilities,
    matchPolicyResponsibilities,
  } = context;

  router.post('/query', async (req, res) => {
    try {
      const input = normalizeResponsibilityQueryInput(req.body || {});
      const payload = await queryPolicyResponsibilities({ state, input });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.post('/local-draft', (req, res) => {
    try {
      const payload = buildRecognizedPolicyAnalysisDraft({ state, scan: req.body?.scan || req.body || {} });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  router.get('/company-suggestions', async (req, res) => {
    const query = String(req.query?.query || req.query?.q || '');
    return res.json({ ok: true, suggestions: buildResponsibilityCompanySuggestions(state, query) });
  });

  router.get('/product-suggestions', async (req, res) => {
    const company = String(req.query?.company || '');
    const query = String(req.query?.query || req.query?.q || '');
    return res.json({ ok: true, suggestions: buildResponsibilityProductSuggestions(state, { company, query }) });
  });

  router.post('/matches', async (req, res) => {
    try {
      const payload = await matchPolicyResponsibilities({ state, body: req.body || {} });
      return res.json(payload);
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
```

Implementation requirement: compare each new responsibility handler against its current handler in `server/app.mjs` before deleting the old handler. Keep the current response field names and error codes unchanged.

- [ ] **Step 2: Move matching helper functions if needed**

Create `server/services/responsibility-workflow.service.mjs` with:

```js
export async function queryPolicyResponsibilities({ state, input, analyzer }) {
  return analyzer.queryResponsibilities({ state, input });
}

export async function matchPolicyResponsibilities({ state, body, matcher }) {
  return matcher.match({ state, body });
}
```

Implementation requirement: replace the stub delegations above with the current inline logic from `server/app.mjs` during this task. The service functions are the new ownership location for that logic.

- [ ] **Step 3: Add dependencies to `routeContext`**

In `server/app.mjs`, include:

```js
    normalizeResponsibilityQueryInput,
    buildResponsibilityCompanySuggestions,
    buildResponsibilityProductSuggestions,
    buildRecognizedPolicyAnalysisDraft,
    queryPolicyResponsibilities,
    matchPolicyResponsibilities,
```

- [ ] **Step 4: Mount responsibility router**

Import and mount:

```js
import { createResponsibilityRoutes } from './routes/responsibilities.routes.mjs';

  app.use('/api/policy-responsibilities', createResponsibilityRoutes(routeContext));
```

Remove the old inline responsibility route declarations from `server/app.mjs`.

- [ ] **Step 5: Run responsibility tests**

Run:

```bash
node --test tests/policy-responsibility-query.test.mjs
node --test tests/policy-optional-responsibility.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```bash
git add server/app.mjs server/routes/responsibilities.routes.mjs server/services/responsibility-workflow.service.mjs
git commit -m "refactor: extract responsibility routes"
```

If `server/services/responsibility-workflow.service.mjs` was not needed, omit it from `git add`.

## Task 6: Extract Family Routes and Family Workflow Service

**Files:**
- Create: `server/routes/families.routes.mjs`
- Create: `server/services/family-workflow.service.mjs`
- Modify: `server/app.mjs`
- Test: `tests/family-profile-domain.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Create `server/services/family-workflow.service.mjs`**

Move family orchestration helpers from `server/app.mjs` into this service where they are not pure domain functions:

```js
export function resolveFamilyRequestOwner(req, res, { requireAuth, state }) {
  return requireAuth(req, res, state);
}

export function findOwnedFamily(state, familyId, owner, { familyOwnerMatches }) {
  const family = state.familyProfiles.find((row) => Number(row.id) === Number(familyId));
  if (!family || !familyOwnerMatches(family, owner)) return null;
  return family;
}

export function familyWithMembers(state, family, { listFamilyMembers }) {
  return { ...family, members: listFamilyMembers(state, family.id) };
}
```

Implementation requirement: compare the moved family helpers against the current helpers in `server/app.mjs`. Share-specific filtering and response fields must stay unchanged.

- [ ] **Step 2: Create `server/routes/families.routes.mjs`**

Create a router that owns:

```text
GET /api/family-profiles
POST /api/family-profiles
POST /api/family-profiles/default
POST /api/family-profiles/:id/members
PATCH /api/family-profiles/:id/members/:memberId
PATCH /api/family-profiles/:id/core
POST /api/family-profiles/:id/share
GET /api/family-report-shares/:token
```

Use:

```js
import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createFamilyRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    requireAuth,
    createFamilyProfile,
    createFamilyMember,
    listFamilyProfilesForOwner,
    listFamilyMembers,
    updateFamilyMemberRelation,
    setFamilyCoreMember,
    ensureDefaultFamilyProfileForPrincipal,
    familyOwnerMatches,
    buildFamilySharePayload,
  } = context;

  router.get('/family-profiles', async (req, res) => {
    const owner = requireAuth(req, res, state);
    if (!owner) return undefined;
    const families = listFamilyProfilesForOwner(state, owner).map((family) => ({
      ...family,
      members: listFamilyMembers(state, family.id),
    }));
    return res.json({ ok: true, families });
  });

  router.post('/family-profiles', async (req, res) => {
    try {
      const owner = requireAuth(req, res, state);
      if (!owner) return undefined;
      const family = createFamilyProfile(state, req.body || {}, owner);
      await persist(state);
      return res.json({ ok: true, family: { ...family, members: listFamilyMembers(state, family.id) } });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
```

Then move the remaining family handlers from `server/app.mjs` into this module, preserving the existing response shapes exactly.

- [ ] **Step 3: Mount family routes without changing URLs**

In `server/app.mjs`, mount at `/api` because this router owns two URL roots:

```js
import { createFamilyRoutes } from './routes/families.routes.mjs';

  app.use('/api', createFamilyRoutes(routeContext));
```

- [ ] **Step 4: Run family tests**

Run:

```bash
node --test tests/family-profile-domain.test.mjs
node --test tests/policy-ocr-flow.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add server/app.mjs server/routes/families.routes.mjs server/services/family-workflow.service.mjs
git commit -m "refactor: extract family routes"
```

## Task 7: Extract Cashflow Routes

**Files:**
- Create: `server/routes/cashflow.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/cashflow-store.test.mjs`
- Test: `tests/cash-value-store.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Create `server/routes/cashflow.routes.mjs`**

Create a router that owns:

```text
POST /api/admin/cashflow/recompute
GET /api/admin/cashflow/status
POST /api/policies/:id/cash-value/scan
POST /api/policies/:id/cash-value/confirm
```

Use:

```js
import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createCashflowRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    requireAdmin,
    adminPassword,
    findPolicyForReportRequest,
    scanner,
    cashflowStore,
    cashValueStore,
    recomputeAllCashflow,
    computeAndStoreCashflow,
  } = context;

  router.post('/admin/cashflow/recompute', async (req, res) => {
    const admin = requireAdmin(req, res, state, adminPassword);
    if (!admin) return undefined;
    const status = recomputeAllCashflow();
    await persist(state);
    return res.json({ ok: true, status });
  });

  router.get('/admin/cashflow/status', async (req, res) => {
    const admin = requireAdmin(req, res, state, adminPassword);
    if (!admin) return undefined;
    return res.json({ ok: true, status: cashflowStore.getStatus() });
  });

  return router;
}
```

Move the two policy cash-value handlers from `server/app.mjs` into this module and preserve their exact response bodies.

- [ ] **Step 2: Mount cashflow router**

In `server/app.mjs`, mount at `/api`:

```js
import { createCashflowRoutes } from './routes/cashflow.routes.mjs';

  app.use('/api', createCashflowRoutes(routeContext));
```

- [ ] **Step 3: Run cashflow tests**

Run:

```bash
node --test tests/cashflow-store.test.mjs
node --test tests/cash-value-store.test.mjs
node --test tests/policy-ocr-flow.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 4: Commit Task 7**

```bash
git add server/app.mjs server/routes/cashflow.routes.mjs
git commit -m "refactor: extract cashflow routes"
```

## Task 8: Extract Policy Routes and Policy Workflow Service

**Files:**
- Create: `server/routes/policies.routes.mjs`
- Create: `server/services/policy-workflow.service.mjs`
- Modify: `server/app.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`
- Test: `tests/policy-ocr-mapping.test.mjs`
- Test: `tests/cash-value-scan-order.test.mjs`

- [ ] **Step 1: Create `server/services/policy-workflow.service.mjs`**

Move cross-owner policy orchestration helpers from `server/app.mjs` into this service:

```js
export async function recognizePolicyInputWorkflow({ scanner, body, state, applyManualData = true, recognizePolicyInput }) {
  return recognizePolicyInput({ scanner, body, state, applyManualData });
}

export async function resolvePolicyScanInputWorkflow({ scanner, body, state, resolvePolicyScanInput }) {
  return resolvePolicyScanInput({ scanner, body, state });
}

export function startPolicyReportGenerationWorkflow(options) {
  return options.startPolicyReportGeneration(options);
}
```

Implementation requirement: move the current helper bodies from `server/app.mjs` into this service during the task. The examples above show the target function names and signatures; the moved bodies must preserve current behavior.

- [ ] **Step 2: Create `server/routes/policies.routes.mjs`**

Create a router that owns:

```text
POST /api/policies/recognize
POST /api/policies/analyze
POST /api/policies/scan
GET /api/policies
PATCH /api/policies/:id
DELETE /api/policies/:id
POST /api/policies/:id/report
GET /api/policies/:id
```

Use this shell:

```js
import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createPolicyRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    requireAuth,
    scanner,
    analyzer,
    performanceLogger,
    recognizePolicyInput,
    resolvePolicyScanInput,
    buildPolicyFromScan,
    attachPolicyFamilyDisplay,
    computeAndStoreCashflow,
    startPolicyReportGeneration,
  } = context;

  router.post('/recognize', async (req, res) => {
    try {
      const scan = await recognizePolicyInput({ scanner, body: req.body || {}, state });
      return res.json({ ok: true, scan });
    } catch (error) {
      return sendError(res, error);
    }
  });

  return router;
}
```

Move the remaining policy handlers from `server/app.mjs` into this module, preserving existing auth behavior, guest behavior, report generation behavior, and response shapes.

- [ ] **Step 3: Mount policy router**

In `server/app.mjs`, mount:

```js
import { createPolicyRoutes } from './routes/policies.routes.mjs';

  app.use('/api/policies', createPolicyRoutes(routeContext));
```

- [ ] **Step 4: Run policy tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs
node --test tests/policy-ocr-mapping.test.mjs
node --test tests/cash-value-scan-order.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit Task 8**

```bash
git add server/app.mjs server/routes/policies.routes.mjs server/services/policy-workflow.service.mjs
git commit -m "refactor: extract policy routes"
```

## Task 9: Extract Admin Routes

**Files:**
- Create: `server/routes/admin.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/optional-responsibility-governance.test.mjs`
- Test: `tests/indicator-remaining-governance.test.mjs`
- Test: `tests/indicator-source-governance.test.mjs`
- Test: `tests/ocr-config.test.mjs`

- [ ] **Step 1: Create `server/routes/admin.routes.mjs`**

Create a router that owns all remaining `/api/admin/*` routes not moved by Task 7:

```text
POST /api/admin/login
GET /api/admin/overview
POST /api/admin/optional-responsibilities/:id/not-quantifiable
POST /api/admin/optional-responsibilities/reextract
GET /api/admin/ocr-config
POST /api/admin/ocr-config
GET /api/admin/official-domain-profiles
POST /api/admin/official-domain-profiles
POST /api/admin/official-domain-profiles/:id
DELETE /api/admin/official-domain-profiles/:id
GET /api/admin/knowledge-records
POST /api/admin/knowledge-crawl
```

Use:

```js
import express from 'express';
import { sendError } from '../http/errors.mjs';

export function createAdminRoutes(context) {
  const router = express.Router();
  const {
    state,
    persist,
    adminPassword,
    requireAdmin,
    createAdminSession,
    buildAdminOverview,
    buildAdminOfficialDomainProfiles,
    normalizeAdminOfficialDomainProfileInput,
    buildAdminKnowledgeRecords,
    normalizeAdminKnowledgeCrawlInput,
  } = context;

  router.post('/login', async (req, res) => {
    const password = String(req.body?.password || '');
    if (password !== adminPassword) {
      return res.status(401).json({ ok: false, code: 'ADMIN_PASSWORD_INVALID', message: '管理员密码错误' });
    }
    const session = createAdminSession(state);
    await persist(state);
    return res.json({ ok: true, token: session.token, expiresAt: session.expiresAt });
  });

  router.get('/overview', async (req, res) => {
    const admin = requireAdmin(req, res, state, adminPassword);
    if (!admin) return undefined;
    return res.json({ ok: true, overview: buildAdminOverview(state) });
  });

  return router;
}
```

Move the remaining admin handlers from `server/app.mjs`, preserving exact response shapes and admin checks.

- [ ] **Step 2: Mount admin router**

In `server/app.mjs`, mount:

```js
import { createAdminRoutes } from './routes/admin.routes.mjs';

  app.use('/api/admin', createAdminRoutes(routeContext));
```

- [ ] **Step 3: Run admin/gov tests**

Run:

```bash
node --test tests/optional-responsibility-governance.test.mjs
node --test tests/indicator-remaining-governance.test.mjs
node --test tests/indicator-source-governance.test.mjs
node --test tests/ocr-config.test.mjs
npm run check
```

Expected: PASS.

- [ ] **Step 4: Confirm backend route count preservation**

Run:

```bash
rg -n "router\\.(get|post|put|patch|delete)\\(" server/routes server/app.mjs | wc -l
```

Expected: count is at least the original route count from Task 1, allowing extra route declarations only if they are compatibility aliases.

- [ ] **Step 5: Commit Task 9**

```bash
git add server/app.mjs server/routes/admin.routes.mjs
git commit -m "refactor: extract admin routes"
```

## Task 10: Split API Client and Owner Contracts

**Files:**
- Create: `src/api/client.ts`
- Create: `src/api/contracts/policy.ts`
- Create: `src/api/contracts/family.ts`
- Create: `src/api/contracts/admin.ts`
- Create: `src/api/contracts/responsibility.ts`
- Create: `src/api/contracts/cashflow.ts`
- Modify: `src/api.ts`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create shared API client**

Create `src/api/client.ts`:

```ts
export async function requestJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload
      ? String((payload as { message?: unknown }).message || '')
      : `请求失败: ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}
```

- [ ] **Step 2: Move policy types**

Create `src/api/contracts/policy.ts` and move policy-related exported types from `src/api.ts`:

```ts
export type ResponsibilitySelectionStatus = 'selected' | 'not_selected' | 'unknown';
export type QuantificationStatus = 'quantified' | 'pending_review' | 'not_quantifiable';
export type ResponsibilityScope = 'basic' | 'optional' | 'rider' | 'plan' | string;
```

Then move the existing `Responsibility`, `PolicySource`, `OptionalResponsibility`, `CoverageIndicator`, `Policy`, `PolicyPlan`, `SourceRecord`, and policy scan/analysis response types from `src/api.ts` into this file without changing property names.

- [ ] **Step 3: Move family types**

Create `src/api/contracts/family.ts` and move:

```ts
export type FamilyRelationToCore =
  | 'self'
  | 'spouse'
  | 'son'
  | 'daughter'
  | 'child'
  | 'father'
  | 'mother'
  | 'parent'
  | 'parent_in_law'
  | 'grandparent'
  | 'sibling'
  | 'other'
  | 'pending';
```

Then move existing `FamilyMember`, `FamilyProfile`, `FamilyReportShare`, and `FamilyReportSharePayload` definitions from `src/api.ts` into this file.

- [ ] **Step 4: Move admin/responsibility/cashflow types**

Create owner contract files and move existing matching types:

```text
src/api/contracts/admin.ts
src/api/contracts/responsibility.ts
src/api/contracts/cashflow.ts
```

Keep each exported type name unchanged.

- [ ] **Step 5: Keep `src/api.ts` as compatibility barrel**

At the top of `src/api.ts`, export owner contracts:

```ts
export * from './api/contracts/policy';
export * from './api/contracts/family';
export * from './api/contracts/admin';
export * from './api/contracts/responsibility';
export * from './api/contracts/cashflow';
```

Keep existing API functions exported from `src/api.ts` in this first slice. Remove only the type definitions that were moved to contract files.

- [ ] **Step 6: Run typecheck and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit Task 10**

```bash
git add src/api.ts src/api/client.ts src/api/contracts
git commit -m "refactor: group api contracts by owner"
```

## Task 11: Extract Frontend Shared Utilities and Report Export

**Files:**
- Create: `src/shared/formatters.ts`
- Create: `src/shared/errors.ts`
- Create: `src/shared/image-utils.ts`
- Create: `src/features/report-export/report-export.ts`
- Modify: `src/App.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create `src/shared/formatters.ts`**

Move these existing pure functions from `src/App.tsx` into `src/shared/formatters.ts` without changing function bodies:

```text
normalizeParticipantName
areSameParticipantName
normalizePolicyPlanRoleLabel
policyPlanRoleOrder
normalizeBeneficiaryValue
formatBeneficiaryValue
formatCoverageAmount
formatCurrency
formatDateLabel
maskMobile
formatOcrModeLabel
formatNumberText
formatFileSize
```

Export every moved function.

- [ ] **Step 2: Create `src/shared/errors.ts`**

Move these functions from `src/App.tsx` into `src/shared/errors.ts`:

```text
createCodedError
getErrorCode
getErrorMessage
```

Export every moved function.

- [ ] **Step 3: Create `src/shared/image-utils.ts`**

Move these functions/constants from `src/App.tsx` into `src/shared/image-utils.ts`:

```text
MAX_POLICY_UPLOAD_BYTES
MAX_OCR_IMAGE_DIMENSION
OCR_IMAGE_JPEG_QUALITY
OCR_IMAGE_DIRECT_UPLOAD_BYTES
dataUrlByteSize
compressImageForOcr
```

If `compressImageForOcr` is currently nested or uses local helpers, move those helpers into the same file.

- [ ] **Step 4: Create `src/features/report-export/report-export.ts`**

Move report export functions from `src/App.tsx` into `src/features/report-export/report-export.ts`:

```text
normalizePdfFileName
exportCurrentReportAsPdf
createPrintableReportNode
convertCssOklchToRgb
normalizeCanvasColorValues
createPdfRenderTarget
renderReportToLongImage
createInPageReportExportPanel
openPdfPreviewWindow
showPdfExportFeedback
writePdfPreviewWindow
writePdfPreviewError
```

Keep behavior and exported function names unchanged.

- [ ] **Step 5: Import moved utilities in `src/App.tsx`**

Add imports from:

```ts
import { formatCurrency, formatDateLabel, formatFileSize } from './shared/formatters';
import { getErrorCode, getErrorMessage } from './shared/errors';
import { compressImageForOcr } from './shared/image-utils';
import { renderReportToLongImage, exportCurrentReportAsPdf } from './features/report-export/report-export';
```

Include every moved function actually used by `src/App.tsx`.

- [ ] **Step 6: Run frontend checks**

Run:

```bash
npm run typecheck
npm run build
node --test tests/customer-ui-style.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 11**

```bash
git add src/App.tsx src/shared src/features/report-export
git commit -m "refactor: extract frontend utilities and report export"
```

## Task 12: Extract Customer and Admin App Components

**Files:**
- Create: `src/apps/customer/CustomerApp.tsx`
- Create: `src/apps/admin/AdminApp.tsx`
- Modify: `src/App.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Create `src/apps/customer/CustomerApp.tsx`**

Move the existing `CustomerApp` component and its customer-only helper types from `src/App.tsx` into this file.

The file must export:

```tsx
export function CustomerApp() {
  // existing CustomerApp body moved from src/App.tsx
}
```

Move only helpers that are exclusively used by `CustomerApp`. Shared helpers must remain in `src/App.tsx` or a shared module until their owner is clear.

- [ ] **Step 2: Create `src/apps/admin/AdminApp.tsx`**

Move the existing `AdminApp` component and admin-only helper components from `src/App.tsx` into this file.

The file must export:

```tsx
export function AdminApp() {
  // existing AdminApp body moved from src/App.tsx
}
```

Move admin-only components such as admin stat cards, OCR mode panel, knowledge panel, and governance panels with `AdminApp` unless they are already assigned to a later feature module task.

- [ ] **Step 3: Update `src/App.tsx` app shell**

Import:

```tsx
import { CustomerApp } from './apps/customer/CustomerApp';
import { AdminApp } from './apps/admin/AdminApp';
```

Keep the existing top-level `App` routing/selection logic unchanged. Replace local component declarations with the imported components.

- [ ] **Step 4: Run typecheck/build/UI style test**

Run:

```bash
npm run typecheck
npm run build
node --test tests/customer-ui-style.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit Task 12**

```bash
git add src/App.tsx src/apps
git commit -m "refactor: extract frontend app shells"
```

## Task 13: Extract Main Frontend Feature Components

**Files:**
- Create: `src/features/family-profile/FamilyProfileManager.tsx`
- Create: `src/features/policy-entry/UploadPolicyPage.tsx`
- Create: `src/features/policy-detail/PolicyDetailSheet.tsx`
- Create: `src/features/responsibility-assistant/ResponsibilityAssistant.tsx`
- Modify: `src/App.tsx`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Modify: `src/apps/admin/AdminApp.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Extract `FamilyProfileManager`**

Move the existing `FamilyProfileManager` component from `src/App.tsx` into:

```text
src/features/family-profile/FamilyProfileManager.tsx
```

Export:

```tsx
export function FamilyProfileManager(props: FamilyProfileManagerProps) {
  // existing body moved from src/App.tsx
}
```

Move or export the existing props type with the component.

- [ ] **Step 2: Extract `UploadPolicyPage`**

Move the existing `UploadPolicyPage` component from `src/App.tsx` into:

```text
src/features/policy-entry/UploadPolicyPage.tsx
```

Export:

```tsx
export function UploadPolicyPage(props: UploadPolicyPageProps) {
  // existing body moved from src/App.tsx
}
```

- [ ] **Step 3: Extract `PolicyDetailSheet`**

Move the existing `PolicyDetailSheet` component from `src/App.tsx` into:

```text
src/features/policy-detail/PolicyDetailSheet.tsx
```

Export:

```tsx
export function PolicyDetailSheet(props: PolicyDetailSheetProps) {
  // existing body moved from src/App.tsx
}
```

- [ ] **Step 4: Extract `ResponsibilityAssistant`**

Move the existing `ResponsibilityAssistant` component from `src/App.tsx` into:

```text
src/features/responsibility-assistant/ResponsibilityAssistant.tsx
```

Export:

```tsx
export function ResponsibilityAssistant(props: ResponsibilityAssistantProps) {
  // existing body moved from src/App.tsx
}
```

- [ ] **Step 5: Update imports**

Update `src/App.tsx`, `src/apps/customer/CustomerApp.tsx`, and `src/apps/admin/AdminApp.tsx` to import moved feature components from their new paths.

- [ ] **Step 6: Run frontend verification**

Run:

```bash
npm run typecheck
npm run build
node --test tests/customer-ui-style.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit Task 13**

```bash
git add src/App.tsx src/apps src/features/family-profile src/features/policy-entry src/features/policy-detail src/features/responsibility-assistant
git commit -m "refactor: extract frontend feature components"
```

## Task 14: Add Owner Map Documentation

**Files:**
- Create: `docs/architecture/owner-map.md`

- [ ] **Step 1: Create owner map document**

Create `docs/architecture/owner-map.md`:

```markdown
# OCR Insurance Owner Map

Date: 2026-06-02

## Runtime Shape

The project is a modular monolith with an OCR sidecar.

```text
React frontend
  -> Express API server
  -> SQLite database
  -> OCR service sidecar
  -> insurer crawler scripts and Feishu sync scripts
```

## Backend Owners

| Owner | Routes | State | Primary Files |
| --- | --- | --- | --- |
| Auth | `/api/auth/*` | `users`, `sessions`, `adminSessions`, `smsCodes` | `server/routes/auth.routes.mjs`, `server/policy-ocr.domain.mjs` |
| Policy | `/api/policies/*` | `policies`, `sourceRecords` | `server/routes/policies.routes.mjs`, `server/services/policy-workflow.service.mjs`, `server/policy-ocr.domain.mjs` |
| Family | `/api/family-profiles/*`, `/api/family-report-shares/*` | `familyProfiles`, `familyMembers`, `familyReportShares` | `server/routes/families.routes.mjs`, `server/family-profile.domain.mjs` |
| Responsibility | `/api/policy-responsibilities/*` | `knowledgeRecords`, `insuranceIndicatorRecords`, `optionalResponsibilityRecords` | `server/routes/responsibilities.routes.mjs`, `server/policy-responsibility-query.mjs` |
| Admin | `/api/admin/*` | admin and governance state | `server/routes/admin.routes.mjs` |
| Cashflow | `/api/admin/cashflow/*`, `/api/policies/:id/cash-value/*` | `policy_cashflows`, `policy_cash_values` | `server/routes/cashflow.routes.mjs`, `server/cashflow-store.mjs` |
| WeChat | `/api/wechat/*` | none | `server/routes/wechat.routes.mjs` |

## Frontend Owners

| Owner | Responsibility | Primary Files |
| --- | --- | --- |
| Customer App | Customer navigation and top-level customer state | `src/apps/customer/CustomerApp.tsx` |
| Admin App | Admin navigation and top-level admin state | `src/apps/admin/AdminApp.tsx` |
| Policy Entry | Upload, OCR, manual policy entry | `src/features/policy-entry/` |
| Policy Detail | Policy detail, edit, delete, cash value actions | `src/features/policy-detail/` |
| Family Profile | Family, members, core member, shares | `src/features/family-profile/` |
| Family Report | Report rendering and family radar | `src/features/family-report/`, `src/family-report-engine.mjs` |
| Report Export | PDF, JPG, canvas export | `src/features/report-export/` |
| Responsibility Assistant | Suggestions and responsibility matching UI | `src/features/responsibility-assistant/` |

## Rules

- Route modules may depend on shared route context and owner services.
- Route modules should not create stores or reload environment files.
- Cross-owner workflows must live in named services.
- Frontend feature modules may import shared API/contracts/utilities.
- Shared utilities must not import feature modules.
- Keep API URLs and response shapes stable unless a separate product spec approves a contract change.
```

- [ ] **Step 2: Commit owner map**

```bash
git add docs/architecture/owner-map.md
git commit -m "docs: add ocr insurance owner map"
```

## Task 15: Final Verification and Graph Refresh

**Files:**
- Verify only unless graph output is intentionally committed later.

- [ ] **Step 1: Run full checks**

Run:

```bash
npm run check
npm run typecheck
npm run build
npm run test
```

Expected: all PASS.

- [ ] **Step 2: Confirm local stack routing**

Run:

```bash
npm run local:status
```

Expected: output clearly shows dev/prod ports and SQLite paths. Confirm the refactor did not change DB routing.

- [ ] **Step 3: Confirm route count did not shrink unexpectedly**

Run:

```bash
rg -n "(app|router)\\.(get|post|put|patch|delete)\\(" server/app.mjs server/routes | wc -l
```

Expected: count is at least the baseline from Task 1.

- [ ] **Step 4: Refresh graph after refactor**

Run:

```bash
graphify update .
graphify cluster-only /Users/wenshuping/Documents/OCR_insurance
```

Expected: `graphify-out/graph.json`, `graphify-out/GRAPH_REPORT.md`, and `graphify-out/graph.html` update successfully.

- [ ] **Step 5: Review final diff**

Run:

```bash
git status --short
git log --oneline -10
```

Expected: only expected files are dirty, or the implementation commits have already captured the refactor slices.
