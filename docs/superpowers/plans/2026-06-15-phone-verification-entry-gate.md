# Phone Verification Entry Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require phone verification before policy photo OCR or policy save, while keeping the floating responsibility assistant publicly usable.

**Architecture:** Treat `/api/policy-responsibilities/*` as public responsibility lookup and `/api/policies/recognize`, `/api/policies/analyze`, and `/api/policies/scan` as authenticated policy-entry operations. The backend is the final gate; the frontend adds early dialogs so users are not blocked after selecting a file or pressing save.

**Tech Stack:** React/Vite TypeScript frontend, Node/Express ESM backend, Node test runner, existing SMS auth/session system.

---

## Files

- Modify: `server/routes/policies.routes.mjs`
  - Add a small `assertPolicyEntryAuthenticated` helper.
  - Require an authenticated user before recognize/analyze/scan.
  - Return `registrationRequiredNext: false` for successful authenticated policy-entry operations.
- Modify: `src/apps/customer/CustomerApp.tsx`
  - Replace second-policy guest gating with first-entry phone verification gating.
  - Keep the responsibility assistant path unchanged.
  - Update dialog messages for upload and save.
- Modify: `src/features/customer-auth/PhoneVerificationDialog.tsx`
  - Replace obsolete “first policy free” copy.
- Modify: `tests/policy-ocr-flow.test.mjs`
  - Replace the old guest-first-policy test with mandatory-auth tests for recognize/analyze/scan and a logged-in success path.
- Modify: `tests/customer-ui-style.test.mjs`
  - Add source-level regression coverage for the new verification copy and old-copy removal.

## Scope Check

This is one coherent change: auth boundary for customer policy entry. It touches one backend route module, one frontend app container, one auth dialog, and focused tests. No decomposition is needed.

## Task 1: Backend Regression Tests

**Files:**
- Modify: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Replace the old guest-first-policy test with mandatory-auth coverage**

Find the test named:

```js
test('guest can scan once without registering and must verify phone before the second policy', async () => {
```

Replace that whole test block with:

```js
test('guest must verify phone before policy OCR, analysis, or save', async () => {
  const scannedTexts = [];
  const app = createPolicyOcrApp({
    state: {
      ...createInitialState(),
      users: [],
      sessions: [],
      smsCodes: [],
      policies: [],
      nextId: 1,
    },
    scanner: async ({ ocrText }) => {
      scannedTexts.push(ocrText);
      return {
        ocrText,
        data: {
          company: '新华保险',
          name: '多倍保障重大疾病保险',
          applicant: '张三',
          insured: '张三',
          date: '2026-05-12',
          paymentPeriod: '20年交',
          coveragePeriod: '终身',
          amount: '500000',
          firstPremium: '12000',
        },
      };
    },
    analyzer: async () => ({
      report: '这是一份重疾保障保单。',
      coverageTable: [
        {
          coverageType: '重大疾病保险金',
          scenario: '确诊合同约定重大疾病',
          payout: '给付基本保险金额50万元',
          note: '给付后该项责任终止',
        },
      ],
    }),
    codeGenerator: () => '135790',
  });
  const server = await listen(app);

  try {
    for (const path of ['/api/policies/recognize', '/api/policies/analyze', '/api/policies/scan']) {
      const denied = await jsonFetch(server.baseUrl, path, {
        method: 'POST',
        body: JSON.stringify({
          guestId: 'guest-a',
          ocrText: '新华保险 多倍保障重大疾病保险 重大疾病保险金 50万元',
        }),
      });
      assert.equal(denied.response.status, 401, `${path} should require phone verification`);
      assert.equal(denied.payload.code, 'REGISTRATION_REQUIRED');
      assert.equal(denied.payload.registrationRequiredNext, true);
    }
    assert.equal(scannedTexts.length, 0);
    assert.equal(app.locals.state.policies.length, 0);

    const code = await jsonFetch(server.baseUrl, '/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ mobile: '13800000000' }),
    });
    assert.equal(code.response.status, 200);
    assert.equal(code.payload.devCode, '135790');

    const registered = await jsonFetch(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        mobile: '13800000000',
        code: '135790',
        guestId: 'guest-a',
      }),
    });
    assert.equal(registered.response.status, 200);
    assert.equal(registered.payload.migratedPolicyCount, 0);
    assert.ok(registered.payload.token);

    const auth = { authorization: `Bearer ${registered.payload.token}` };
    const recognized = await jsonFetch(server.baseUrl, '/api/policies/recognize', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        ocrText: '新华保险 多倍保障重大疾病保险 重大疾病保险金 50万元',
      }),
    });
    assert.equal(recognized.response.status, 200);
    assert.equal(recognized.payload.scan.data.company, '新华保险');
    assert.equal(recognized.payload.registrationRequiredNext, false);

    const saved = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        scan: recognized.payload.scan,
        analysis: recognized.payload.analysis,
      }),
    });
    assert.equal(saved.response.status, 201);
    assert.equal(saved.payload.policy.company, '新华保险');
    assert.equal(saved.payload.policy.userId, registered.payload.user.id);
    assert.equal(saved.payload.registrationRequiredNext, false);
    assert.equal(scannedTexts.length, 1);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the focused backend test and verify it fails**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "guest must verify phone before policy OCR, analysis, or save"
```

Expected before implementation:

```text
not ok ... guest must verify phone before policy OCR, analysis, or save
```

The failure should show at least one unauthenticated `/api/policies/*` route returning success instead of `401 REGISTRATION_REQUIRED`.

## Task 2: Backend Auth Gate

**Files:**
- Modify: `server/routes/policies.routes.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add a policy-entry auth helper**

Near the top of `server/routes/policies.routes.mjs`, after `recognizePendingScanKey`, add:

```js
function assertPolicyEntryAuthenticated(user, message = '录入或上传保单前需要先完成手机验证码') {
  if (user?.id) return;
  const error = new Error(message);
  error.code = 'REGISTRATION_REQUIRED';
  error.status = 401;
  error.registrationRequiredNext = true;
  throw error;
}
```

- [ ] **Step 2: Require auth in `/api/policies/recognize`**

In the recognize route, replace:

```js
const user = resolveAuthUser(req, state);
const guestId = normalizeGuestId(req.body?.guestId);
assertGuestCanScan({ state, user, guestId });
```

with:

```js
const user = resolveAuthUser(req, state);
assertPolicyEntryAuthenticated(user, '上传保单照片前需要先验证手机号');
const guestId = normalizeGuestId(req.body?.guestId);
```

In the response payload, replace:

```js
registrationRequiredNext: guestRegistrationRequiredNext({ state, user, guestId }),
```

with:

```js
registrationRequiredNext: false,
```

- [ ] **Step 3: Require auth in `/api/policies/analyze`**

In the analyze route, replace:

```js
const user = resolveAuthUser(req, state);
const guestId = normalizeGuestId(req.body?.guestId);
assertGuestCanScan({ state, user, guestId });
```

with:

```js
const user = resolveAuthUser(req, state);
assertPolicyEntryAuthenticated(user);
const guestId = normalizeGuestId(req.body?.guestId);
```

In the response payload, replace:

```js
registrationRequiredNext: guestRegistrationRequiredNext({ state, user, guestId }),
```

with:

```js
registrationRequiredNext: false,
```

- [ ] **Step 4: Require auth in `/api/policies/scan`**

In the scan route, replace:

```js
const user = resolveAuthUser(req, state);
const guestId = normalizeGuestId(req.body?.guestId);
assertGuestCanScan({ state, user, guestId });
```

with:

```js
const user = resolveAuthUser(req, state);
assertPolicyEntryAuthenticated(user, '保存保单前需要先验证手机号');
const guestId = normalizeGuestId(req.body?.guestId);
```

In the response payload, replace:

```js
registrationRequiredNext: guestRegistrationRequiredNext({ state, user, guestId }),
```

with:

```js
registrationRequiredNext: false,
```

- [ ] **Step 5: Remove unused destructured route dependencies**

In the `createPolicyRoutes` context destructuring, remove these now-unused entries:

```js
assertGuestCanScan,
guestRegistrationRequiredNext,
```

Leave the functions in `server/app.mjs` for now if they are still needed by legacy migration paths or if removing them would expand scope. This task should be surgical.

- [ ] **Step 6: Run the focused backend test and verify it passes**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "guest must verify phone before policy OCR, analysis, or save"
```

Expected:

```text
ok ... guest must verify phone before policy OCR, analysis, or save
```

- [ ] **Step 7: Run the membership quota focused tests**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "registered user over free quota|active member can save over configured free quota"
```

Expected:

```text
ok ... registered user over free quota must buy membership before saving another policy
ok ... active member can save over configured free quota
```

## Task 3: Frontend Entry Gate and Dialog Copy

**Files:**
- Modify: `src/apps/customer/CustomerApp.tsx`
- Modify: `src/features/customer-auth/PhoneVerificationDialog.tsx`
- Test: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Rename the guest gating helper**

In `src/apps/customer/CustomerApp.tsx`, replace:

```ts
function blockSecondGuestPolicyIfNeeded() {
  if (token || policies.length < 1) return false;
  openPhoneVerificationDialog('第一次录入不用验证码；第二次录入请先验证手机号');
  return true;
}
```

with:

```ts
function blockPolicyEntryIfUnauthenticated(reason = '录入或上传保单前需要先验证手机号') {
  if (token) return false;
  openPhoneVerificationDialog(reason);
  return true;
}
```

- [ ] **Step 2: Gate upload before opening the file picker**

In `handleScanClick`, replace:

```ts
if (blockSecondGuestPolicyIfNeeded()) return;
```

with:

```ts
if (blockPolicyEntryIfUnauthenticated('上传保单照片前需要先验证手机号')) return;
```

In `handleFileChange`, replace:

```ts
if (blockSecondGuestPolicyIfNeeded()) {
```

with:

```ts
if (blockPolicyEntryIfUnauthenticated('上传保单照片前需要先验证手机号')) {
```

- [ ] **Step 3: Gate save before validation and API calls**

In `handleSubmit`, replace:

```ts
if (blockSecondGuestPolicyIfNeeded()) return;
```

with:

```ts
if (blockPolicyEntryIfUnauthenticated('保存保单前需要先验证手机号')) return;
```

- [ ] **Step 4: Gate hidden analysis entry if the function remains wired**

In `handleGenerateAnalysis`, replace:

```ts
if (blockSecondGuestPolicyIfNeeded()) return;
```

with:

```ts
if (blockPolicyEntryIfUnauthenticated()) return;
```

This keeps old or hidden UI paths aligned with the backend without adding a new button.

- [ ] **Step 5: Remove obsolete post-save second-entry suffix**

In `handleSubmit`, replace:

```ts
const suffix = payload.registrationRequiredNext ? '；第二次录入需要手机验证码' : '';
setMessage(isPolicyReportGenerating(payload.policy) ? `保单已保存，报告正在后台生成${suffix}` : `保单已保存到我的保单${suffix}`);
```

with:

```ts
setMessage(isPolicyReportGenerating(payload.policy) ? '保单已保存，报告正在后台生成' : '保单已保存到我的保单');
```

- [ ] **Step 6: Update the phone verification dialog copy**

In `src/features/customer-auth/PhoneVerificationDialog.tsx`, replace:

```tsx
<p className="mt-1 text-sm leading-6 text-slate-500">第一张保单可直接录入，第二张开始需要验证手机号。</p>
```

with:

```tsx
<p className="mt-1 text-sm leading-6 text-slate-500">录入或上传保单前需要验证手机号；仅查询保险责任无需验证。</p>
```

## Task 4: Frontend Source Regression Tests

**Files:**
- Modify: `tests/customer-ui-style.test.mjs`

- [ ] **Step 1: Add verification-copy regression coverage**

After the existing test named `phone verification send-code button uses the blue primary style`, add:

```js
test('phone verification copy matches policy entry gate rules', () => {
  const source = extractedOrBoundedComponentSource('PhoneVerificationDialog', null);
  assert.match(source, /录入或上传保单前需要验证手机号；仅查询保险责任无需验证/);
  assert.doesNotMatch(source, /第一张保单可直接录入/);
  assert.doesNotMatch(source, /第二张开始需要验证手机号/);
});
```

- [ ] **Step 2: Add CustomerApp gate source coverage**

After the test above, add:

```js
test('customer policy entry gates upload and save before phone verification', () => {
  const source = componentSource('CustomerApp', 'FamilyCoverageOverview');
  assert.match(source, /function blockPolicyEntryIfUnauthenticated/);
  assert.match(source, /handleScanClick\(\)[\s\S]*blockPolicyEntryIfUnauthenticated\('上传保单照片前需要先验证手机号'\)/);
  assert.match(source, /handleFileChange[\s\S]*blockPolicyEntryIfUnauthenticated\('上传保单照片前需要先验证手机号'\)/);
  assert.match(source, /handleSubmit\(\)[\s\S]*blockPolicyEntryIfUnauthenticated\('保存保单前需要先验证手机号'\)/);
  assert.doesNotMatch(source, /blockSecondGuestPolicyIfNeeded/);
  assert.doesNotMatch(source, /第二次录入需要手机验证码/);
});
```

- [ ] **Step 3: Run the focused frontend source tests**

Run:

```bash
node --test tests/customer-ui-style.test.mjs --test-name-pattern "phone verification copy|customer policy entry gates"
```

Expected:

```text
ok ... phone verification copy matches policy entry gate rules
ok ... customer policy entry gates upload and save before phone verification
```

## Task 5: Public Responsibility Lookup Regression

**Files:**
- Modify: `tests/policy-ocr-flow.test.mjs`
- Test: `server/routes/responsibilities.routes.mjs` behavior through app

- [ ] **Step 1: Add an unauthenticated responsibility-query test**

Near the policy auth tests in `tests/policy-ocr-flow.test.mjs`, add:

```js
test('public responsibility lookup remains available without phone verification', async () => {
  const app = createPolicyOcrApp({
    state: {
      ...createInitialState(),
      knowledgeRecords: [{
        id: 1,
        company: '新华保险',
        productName: '多倍保障重大疾病保险',
        url: 'https://example.test/product.pdf',
        payload: {
          company: '新华保险',
          productName: '多倍保障重大疾病保险',
          pageText: '保险责任 在本合同保险期间内，本公司承担重大疾病保险金责任。',
        },
      }],
    },
    analyzer: async () => {
      throw new Error('public local responsibility lookup should not need policy-entry auth');
    },
  });
  const server = await listen(app);

  try {
    const result = await jsonFetch(server.baseUrl, '/api/policy-responsibilities/query', {
      method: 'POST',
      body: JSON.stringify({
        company: '新华保险',
        name: '多倍保障重大疾病保险',
      }),
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.ok, true);
    assert.ok(result.payload.analysis.coverageTable.length >= 1);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the public lookup test**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "public responsibility lookup remains available"
```

Expected:

```text
ok ... public responsibility lookup remains available without phone verification
```

## Task 6: Full Verification and Commit

**Files:**
- Modify: `server/routes/policies.routes.mjs`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Modify: `src/features/customer-auth/PhoneVerificationDialog.tsx`
- Modify: `tests/policy-ocr-flow.test.mjs`
- Modify: `tests/customer-ui-style.test.mjs`
- Modify: `docs/superpowers/plans/2026-06-15-phone-verification-entry-gate.md`

- [ ] **Step 1: Run required verification**

Run:

```bash
npm run check
npm run typecheck
npm test
npm run build
```

Expected: all commands exit `0`.

- [ ] **Step 2: Inspect diffs for unrelated changes**

Run:

```bash
git diff -- server/routes/policies.routes.mjs src/apps/customer/CustomerApp.tsx src/features/customer-auth/PhoneVerificationDialog.tsx tests/policy-ocr-flow.test.mjs tests/customer-ui-style.test.mjs docs/superpowers/plans/2026-06-15-phone-verification-entry-gate.md
git status --short
```

Expected:

- The diff only implements the phone verification entry gate.
- Pre-existing unrelated dirty files remain unstaged.

- [ ] **Step 3: Stage only this task's files**

Run:

```bash
git add server/routes/policies.routes.mjs src/apps/customer/CustomerApp.tsx src/features/customer-auth/PhoneVerificationDialog.tsx tests/policy-ocr-flow.test.mjs tests/customer-ui-style.test.mjs docs/superpowers/plans/2026-06-15-phone-verification-entry-gate.md
git diff --cached --name-only
```

Expected staged files:

```text
docs/superpowers/plans/2026-06-15-phone-verification-entry-gate.md
server/routes/policies.routes.mjs
src/apps/customer/CustomerApp.tsx
src/features/customer-auth/PhoneVerificationDialog.tsx
tests/customer-ui-style.test.mjs
tests/policy-ocr-flow.test.mjs
```

- [ ] **Step 4: Commit**

Run:

```bash
git commit -m "feat: require phone verification for policy entry"
```

Expected:

```text
[branch <sha>] feat: require phone verification for policy entry
```

## Self-Review

- Spec coverage: Public responsibility lookup remains unauthenticated in Task 5. Policy OCR/analyze/save require login in Tasks 1 and 2. Frontend upload/save preflight dialogs and copy changes are covered in Tasks 3 and 4. Membership quota preservation is covered in Task 2 focused tests.
- Placeholder scan: No unresolved placeholder markers are present.
- Type consistency: Existing route response fields keep `registrationRequiredNext: boolean`; frontend keeps using the existing token and `PhoneVerificationDialog`.
