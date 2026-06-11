# WeChat Pay Annual Membership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a 300 RMB annual membership flow for logged-in公众号 H5 users, backed by WeChat Pay JSAPI orders and enforced by server-side saved-policy quota checks.

**Architecture:** Add a focused membership domain module that owns quota, order, OAuth state, and membership activation rules; persist that state through SQLite beside existing app-owned tables. Wire user and admin membership routes into the Express app, gate `POST /api/policies/scan` on the domain decision, then add a small React purchase/status UI that uses mock payment in development and JSAPI parameters in live mode.

**Tech Stack:** Node.js ESM, Express, Node `node:test`, `node:sqlite`, Node `crypto`, React 19, TypeScript, Vite, existing API client patterns.

---

## Scope Check

The approved spec spans membership state, WeChat Pay order creation, OAuth openid binding, policy-save authorization, admin config, and React purchase UI. These parts are coupled by one invariant: only the server can decide whether a logged-in user may save another policy. This plan keeps one track but makes each task independently testable before the next layer depends on it.

## File Structure

- Create: `server/membership.domain.mjs`
  - Owns membership config normalization, quota snapshots, order creation, paid-order activation, OAuth state creation/consumption, and openid lookup.
- Create: `server/wechat-pay.service.mjs`
  - Owns WeChat Pay mode/config resolution, mock prepay output, live JSAPI request signing, JSAPI pay parameter signing, notify signature verification, and AES-256-GCM resource decryption.
- Create: `server/routes/membership.routes.mjs`
  - Exposes `/api/membership/me`, `/api/membership/orders`, `/api/membership/orders/:id`, OAuth start/callback, notify, and dev-only mock confirmation.
- Modify: `server/policy-ocr.domain.mjs`
  - Adds membership arrays/documents to initial state.
- Modify: `server/sqlite-state-store.mjs`
  - Persists membership config, orders, memberships, user WeChat identities, and OAuth states.
- Modify: `server/http/errors.mjs`
  - Allows membership metadata in JSON error responses.
- Modify: `server/routes/policies.routes.mjs`
  - Calls membership entitlement checks before saving a logged-in user's policy.
- Modify: `server/routes/admin.routes.mjs`
  - Adds admin membership config read/update endpoints.
- Modify: `server/app.mjs`
  - Imports membership modules, initializes membership state, adds route context entries, and mounts membership routes.
- Create: `src/api/contracts/membership.ts`
  - Defines user-side membership API contracts.
- Modify: `src/api/contracts/admin.ts`
  - Adds admin membership config contracts.
- Create: `src/features/customer-membership/MembershipPurchaseDialog.tsx`
  - Displays quota, price, and purchase actions.
- Modify: `src/features/customer-auth/CustomerAccountSheet.tsx`
  - Displays membership or free quota status.
- Modify: `src/apps/customer/CustomerApp.tsx`
  - Loads membership status, handles `MEMBERSHIP_REQUIRED`, starts OAuth, creates orders, invokes WeChat JSAPI, and refreshes status.
- Modify: `src/apps/admin/AdminApp.tsx`
  - Adds a compact membership settings panel.
- Test: `tests/membership-domain.test.mjs`
- Test: `tests/wechat-pay-service.test.mjs`
- Test: `tests/sqlite-state-store.test.mjs`
- Test: `tests/membership-routes.test.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`
- Test: `tests/customer-membership-ui.test.mjs`

## Task 1: Membership Domain

**Files:**
- Create: `server/membership.domain.mjs`
- Modify: `server/policy-ocr.domain.mjs`
- Test: `tests/membership-domain.test.mjs`

- [ ] **Step 1: Write the failing domain tests**

Create `tests/membership-domain.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialState } from '../server/policy-ocr.domain.mjs';
import {
  ANNUAL_MEMBERSHIP_DURATION_DAYS,
  ANNUAL_MEMBERSHIP_PRICE_CENTS,
  assertUserCanSavePolicy,
  buildMembershipSnapshot,
  consumeWechatOAuthState,
  createMembershipOrder,
  createWechatOAuthState,
  defaultMembershipConfig,
  findUserWechatOpenid,
  markMembershipOrderPrepayCreated,
  normalizeMembershipConfig,
  processMembershipPaymentSuccess,
  upsertUserWechatIdentity,
} from '../server/membership.domain.mjs';

const NOW = '2026-06-11T08:00:00.000Z';

test('normalizeMembershipConfig keeps price and duration fixed while accepting admin quota and enabled flag', () => {
  assert.deepEqual(normalizeMembershipConfig({
    enabled: false,
    registeredFreePolicyQuota: '5',
    annualPriceCents: 1,
    annualDurationDays: 1,
  }, NOW), {
    enabled: false,
    annualPriceCents: ANNUAL_MEMBERSHIP_PRICE_CENTS,
    annualDurationDays: ANNUAL_MEMBERSHIP_DURATION_DAYS,
    registeredFreePolicyQuota: 5,
    updatedAt: NOW,
  });
  assert.equal(defaultMembershipConfig(NOW).registeredFreePolicyQuota, 3);
});

test('buildMembershipSnapshot reports active membership and saved policy quota', () => {
  const state = {
    ...createInitialState(),
    membershipConfig: { ...defaultMembershipConfig(NOW), registeredFreePolicyQuota: 2 },
    policies: [
      { id: 1, userId: 8, guestId: '', name: 'A' },
      { id: 2, userId: 8, guestId: '', name: 'B' },
      { id: 3, userId: 9, guestId: '', name: 'C' },
    ],
    memberships: [
      { userId: 8, plan: 'annual', status: 'active', startedAt: NOW, expiresAt: '2026-07-11T08:00:00.000Z', lastOrderId: 30, updatedAt: NOW },
    ],
  };

  assert.deepEqual(buildMembershipSnapshot(state, { id: 8 }, { now: NOW }), {
    membership: { active: true, plan: 'annual', expiresAt: '2026-07-11T08:00:00.000Z' },
    quota: { savedPolicyCount: 2, freeQuota: 2, requiresMembership: false },
    purchase: { enabled: true, annualPriceCents: 30000, annualDurationDays: 365, wechatOpenidBound: false },
  });
});

test('assertUserCanSavePolicy rejects logged-in users over free quota without active membership', () => {
  const state = {
    ...createInitialState(),
    membershipConfig: { ...defaultMembershipConfig(NOW), registeredFreePolicyQuota: 1 },
    policies: [{ id: 1, userId: 8, guestId: '', name: 'A' }],
  };

  assert.throws(
    () => assertUserCanSavePolicy(state, { id: 8 }, { now: NOW }),
    (error) => {
      assert.equal(error.code, 'MEMBERSHIP_REQUIRED');
      assert.equal(error.status, 402);
      assert.deepEqual(error.membership, { savedPolicyCount: 1, freeQuota: 1, annualPriceCents: 30000 });
      return true;
    },
  );
});

test('processMembershipPaymentSuccess activates new membership and is idempotent for duplicate notifications', () => {
  const state = { ...createInitialState() };
  const order = createMembershipOrder(state, { userId: 8, now: NOW, randomBytes: Buffer.from('0011223344556677', 'hex') });
  markMembershipOrderPrepayCreated(state, order.outTradeNo, { prepayId: 'wx-prepay', now: NOW });

  const first = processMembershipPaymentSuccess(state, {
    outTradeNo: order.outTradeNo,
    transactionId: '4200001',
    amountCents: 30000,
    paidAt: NOW,
  });
  const duplicate = processMembershipPaymentSuccess(state, {
    outTradeNo: order.outTradeNo,
    transactionId: '4200001',
    amountCents: 30000,
    paidAt: '2026-06-11T08:05:00.000Z',
  });

  assert.equal(first.applied, true);
  assert.equal(duplicate.applied, false);
  assert.equal(state.memberships.length, 1);
  assert.equal(state.memberships[0].expiresAt, '2027-06-11T08:00:00.000Z');
});

test('processMembershipPaymentSuccess extends from current expiry when membership is active', () => {
  const state = {
    ...createInitialState(),
    memberships: [{ userId: 8, plan: 'annual', status: 'active', startedAt: NOW, expiresAt: '2026-12-01T00:00:00.000Z', lastOrderId: 2, updatedAt: NOW }],
  };
  const order = createMembershipOrder(state, { userId: 8, now: NOW, randomBytes: Buffer.from('8899aabbccddeeff', 'hex') });
  markMembershipOrderPrepayCreated(state, order.outTradeNo, { prepayId: 'wx-prepay', now: NOW });

  processMembershipPaymentSuccess(state, {
    outTradeNo: order.outTradeNo,
    transactionId: '4200002',
    amountCents: 30000,
    paidAt: NOW,
  });

  assert.equal(state.memberships[0].expiresAt, '2027-12-01T00:00:00.000Z');
});

test('wechat identity and OAuth state bind openid without putting bearer token in URL', () => {
  const state = { ...createInitialState() };
  const oauth = createWechatOAuthState(state, {
    userId: 8,
    appId: 'wx123',
    redirectUrl: '/#/member',
    now: NOW,
    randomBytes: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
  });
  const consumed = consumeWechatOAuthState(state, oauth.state, { now: '2026-06-11T08:01:00.000Z' });
  upsertUserWechatIdentity(state, { userId: consumed.userId, appId: consumed.appId, openid: 'openid-8', now: NOW });

  assert.equal(findUserWechatOpenid(state, { userId: 8, appId: 'wx123' }), 'openid-8');
  assert.ok(state.wechatOAuthStates[0].usedAt);
  assert.throws(() => consumeWechatOAuthState(state, oauth.state, { now: '2026-06-11T08:02:00.000Z' }), /WECHAT_OAUTH_STATE_USED/);
});
```

- [ ] **Step 2: Run the domain tests and verify they fail**

Run:

```bash
node --test tests/membership-domain.test.mjs
```

Expected: FAIL with `Cannot find module '../server/membership.domain.mjs'`.

- [ ] **Step 3: Add membership state keys**

Modify `server/policy-ocr.domain.mjs` inside `createInitialState()` by adding these keys after `familyReportShares`:

```js
    membershipConfig: null,
    membershipOrders: [],
    memberships: [],
    userWechatIdentities: [],
    wechatOAuthStates: [],
```

- [ ] **Step 4: Implement the membership domain module**

Create `server/membership.domain.mjs` with these exports and behavior:

```js
import crypto from 'node:crypto';

import { allocateId } from './policy-ocr.domain.mjs';

export const ANNUAL_MEMBERSHIP_PRICE_CENTS = 30000;
export const ANNUAL_MEMBERSHIP_DURATION_DAYS = 365;
export const DEFAULT_REGISTERED_FREE_POLICY_QUOTA = 3;
export const MEMBERSHIP_PRODUCT_CODE = 'annual_membership';

function trim(value) {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(baseIso, days) {
  const base = new Date(baseIso);
  return new Date(base.getTime() + Number(days) * 24 * 60 * 60 * 1000).toISOString();
}

function randomHex(bytes = 8) {
  return crypto.randomBytes(bytes).toString('hex');
}

function ensureMembershipArrays(state) {
  if (!state.membershipConfig) state.membershipConfig = defaultMembershipConfig(nowIso());
  if (!Array.isArray(state.membershipOrders)) state.membershipOrders = [];
  if (!Array.isArray(state.memberships)) state.memberships = [];
  if (!Array.isArray(state.userWechatIdentities)) state.userWechatIdentities = [];
  if (!Array.isArray(state.wechatOAuthStates)) state.wechatOAuthStates = [];
}

export function defaultMembershipConfig(updatedAt = nowIso()) {
  return {
    enabled: true,
    annualPriceCents: ANNUAL_MEMBERSHIP_PRICE_CENTS,
    annualDurationDays: ANNUAL_MEMBERSHIP_DURATION_DAYS,
    registeredFreePolicyQuota: DEFAULT_REGISTERED_FREE_POLICY_QUOTA,
    updatedAt,
  };
}

export function normalizeMembershipConfig(input = {}, updatedAt = nowIso()) {
  const quota = Math.max(0, Math.floor(Number(input.registeredFreePolicyQuota ?? DEFAULT_REGISTERED_FREE_POLICY_QUOTA)));
  return {
    enabled: input.enabled !== false,
    annualPriceCents: ANNUAL_MEMBERSHIP_PRICE_CENTS,
    annualDurationDays: ANNUAL_MEMBERSHIP_DURATION_DAYS,
    registeredFreePolicyQuota: Number.isFinite(quota) ? quota : DEFAULT_REGISTERED_FREE_POLICY_QUOTA,
    updatedAt,
  };
}

export function getMembershipConfig(state, now = nowIso()) {
  ensureMembershipArrays(state);
  state.membershipConfig = normalizeMembershipConfig(state.membershipConfig || {}, state.membershipConfig?.updatedAt || now);
  return state.membershipConfig;
}

export function updateMembershipConfig(state, input = {}, now = nowIso()) {
  ensureMembershipArrays(state);
  state.membershipConfig = normalizeMembershipConfig({ ...state.membershipConfig, ...input }, now);
  return state.membershipConfig;
}

export function countSavedPoliciesForUser(state, userId) {
  const id = Number(userId || 0);
  if (!id) return 0;
  return (state.policies || []).filter((policy) => Number(policy.userId || 0) === id).length;
}

export function activeMembershipForUser(state, userId, { now = nowIso() } = {}) {
  const id = Number(userId || 0);
  const nowTime = new Date(now).getTime();
  return (state.memberships || []).find((membership) => (
    Number(membership.userId || 0) === id &&
    membership.status === 'active' &&
    new Date(membership.expiresAt || 0).getTime() > nowTime
  )) || null;
}

export function findUserWechatOpenid(state, { userId, appId }) {
  const row = (state.userWechatIdentities || []).find((identity) => (
    Number(identity.userId || 0) === Number(userId || 0) &&
    trim(identity.appId) === trim(appId)
  ));
  return trim(row?.openid);
}

export function buildMembershipSnapshot(state, user, { now = nowIso(), appId = '' } = {}) {
  const config = getMembershipConfig(state, now);
  const membership = activeMembershipForUser(state, user?.id, { now });
  const savedPolicyCount = countSavedPoliciesForUser(state, user?.id);
  const active = Boolean(membership);
  return {
    membership: {
      active,
      plan: active ? 'annual' : null,
      expiresAt: active ? membership.expiresAt : null,
    },
    quota: {
      savedPolicyCount,
      freeQuota: config.registeredFreePolicyQuota,
      requiresMembership: !active && savedPolicyCount >= config.registeredFreePolicyQuota,
    },
    purchase: {
      enabled: config.enabled,
      annualPriceCents: config.annualPriceCents,
      annualDurationDays: config.annualDurationDays,
      wechatOpenidBound: Boolean(appId && findUserWechatOpenid(state, { userId: user?.id, appId })),
    },
  };
}

export function assertUserCanSavePolicy(state, user, { now = nowIso() } = {}) {
  if (!user?.id) return;
  const snapshot = buildMembershipSnapshot(state, user, { now });
  if (!snapshot.quota.requiresMembership) return;
  const error = new Error('免费保单额度已用完，请开通会员继续录入');
  error.code = 'MEMBERSHIP_REQUIRED';
  error.status = 402;
  error.membership = {
    savedPolicyCount: snapshot.quota.savedPolicyCount,
    freeQuota: snapshot.quota.freeQuota,
    annualPriceCents: snapshot.purchase.annualPriceCents,
  };
  throw error;
}

export function createMembershipOrder(state, { userId, now = nowIso(), randomBytes } = {}) {
  ensureMembershipArrays(state);
  const bytes = randomBytes || crypto.randomBytes(8);
  const random = Buffer.isBuffer(bytes) ? bytes.toString('hex') : randomHex(8);
  const id = allocateId(state);
  const outTradeNo = `mem_${Number(userId)}_${Date.parse(now)}_${random}`.slice(0, 64);
  const order = {
    id,
    outTradeNo,
    userId: Number(userId),
    productCode: MEMBERSHIP_PRODUCT_CODE,
    amountCents: ANNUAL_MEMBERSHIP_PRICE_CENTS,
    currency: 'CNY',
    status: 'created',
    prepayId: '',
    transactionId: '',
    paidAt: '',
    expiresAt: addDaysIso(now, 30 / (24 * 60)),
    createdAt: now,
    updatedAt: now,
    payload: {},
  };
  state.membershipOrders.push(order);
  return order;
}

export function findMembershipOrderByOutTradeNo(state, outTradeNo) {
  return (state.membershipOrders || []).find((order) => trim(order.outTradeNo) === trim(outTradeNo)) || null;
}

export function markMembershipOrderPrepayCreated(state, outTradeNo, { prepayId, now = nowIso(), payload = {} } = {}) {
  const order = findMembershipOrderByOutTradeNo(state, outTradeNo);
  if (!order) {
    const error = new Error('ORDER_NOT_FOUND');
    error.code = 'ORDER_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  order.status = 'prepay_created';
  order.prepayId = trim(prepayId);
  order.updatedAt = now;
  order.payload = { ...(order.payload || {}), prepay: payload };
  return order;
}

export function processMembershipPaymentSuccess(state, { outTradeNo, transactionId, amountCents, paidAt = nowIso(), notifyPayload = {} } = {}) {
  ensureMembershipArrays(state);
  const order = findMembershipOrderByOutTradeNo(state, outTradeNo);
  if (!order) {
    const error = new Error('ORDER_NOT_FOUND');
    error.code = 'ORDER_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (Number(amountCents) !== Number(order.amountCents)) {
    const error = new Error('WECHAT_NOTIFY_AMOUNT_MISMATCH');
    error.code = 'WECHAT_NOTIFY_AMOUNT_MISMATCH';
    error.status = 400;
    throw error;
  }
  order.payload = { ...(order.payload || {}), notify: notifyPayload };
  if (order.status === 'paid') {
    order.updatedAt = paidAt;
    return { applied: false, order, membership: activeMembershipForUser(state, order.userId, { now: paidAt }) };
  }
  const current = activeMembershipForUser(state, order.userId, { now: paidAt });
  const base = current?.expiresAt || paidAt;
  const expiresAt = addDaysIso(base, ANNUAL_MEMBERSHIP_DURATION_DAYS);
  const membership = current || {
    userId: order.userId,
    plan: 'annual',
    status: 'active',
    startedAt: paidAt,
    expiresAt,
    lastOrderId: order.id,
    updatedAt: paidAt,
  };
  membership.status = 'active';
  membership.expiresAt = expiresAt;
  membership.lastOrderId = order.id;
  membership.updatedAt = paidAt;
  if (!current) state.memberships.push(membership);
  order.status = 'paid';
  order.transactionId = trim(transactionId);
  order.paidAt = paidAt;
  order.updatedAt = paidAt;
  return { applied: true, order, membership };
}

export function createWechatOAuthState(state, { userId, appId, redirectUrl, now = nowIso(), randomBytes } = {}) {
  ensureMembershipArrays(state);
  const bytes = randomBytes || crypto.randomBytes(16);
  const stateToken = Buffer.isBuffer(bytes) ? bytes.toString('hex') : randomHex(16);
  const row = {
    state: stateToken,
    userId: Number(userId),
    appId: trim(appId),
    redirectUrl: trim(redirectUrl || '/'),
    usedAt: '',
    expiresAt: addDaysIso(now, 10 / (24 * 60)),
    createdAt: now,
  };
  state.wechatOAuthStates.push(row);
  return row;
}

export function consumeWechatOAuthState(state, stateToken, { now = nowIso() } = {}) {
  const row = (state.wechatOAuthStates || []).find((item) => trim(item.state) === trim(stateToken));
  if (!row) {
    const error = new Error('WECHAT_OAUTH_STATE_NOT_FOUND');
    error.code = 'WECHAT_OAUTH_STATE_NOT_FOUND';
    error.status = 400;
    throw error;
  }
  if (row.usedAt) {
    const error = new Error('WECHAT_OAUTH_STATE_USED');
    error.code = 'WECHAT_OAUTH_STATE_USED';
    error.status = 400;
    throw error;
  }
  if (new Date(row.expiresAt).getTime() <= new Date(now).getTime()) {
    const error = new Error('WECHAT_OAUTH_STATE_EXPIRED');
    error.code = 'WECHAT_OAUTH_STATE_EXPIRED';
    error.status = 400;
    throw error;
  }
  row.usedAt = now;
  return row;
}

export function upsertUserWechatIdentity(state, { userId, appId, openid, now = nowIso() } = {}) {
  ensureMembershipArrays(state);
  const existing = (state.userWechatIdentities || []).find((identity) => (
    Number(identity.userId || 0) === Number(userId || 0) &&
    trim(identity.appId) === trim(appId)
  ));
  const row = existing || {
    userId: Number(userId),
    appId: trim(appId),
    openid: '',
    scope: 'snsapi_base',
    createdAt: now,
    updatedAt: now,
  };
  row.openid = trim(openid);
  row.updatedAt = now;
  if (!existing) state.userWechatIdentities.push(row);
  return row;
}
```

- [ ] **Step 5: Run the domain tests and commit**

Run:

```bash
node --test tests/membership-domain.test.mjs
```

Expected: PASS.

Commit:

```bash
git add server/membership.domain.mjs server/policy-ocr.domain.mjs tests/membership-domain.test.mjs
git commit -m "feat: add membership domain"
```

## Task 2: SQLite Persistence

**Files:**
- Modify: `server/sqlite-state-store.mjs`
- Test: `tests/sqlite-state-store.test.mjs`

- [ ] **Step 1: Add failing SQLite persistence test**

Append this test to `tests/sqlite-state-store.test.mjs`:

```js
test('sqlite state store persists membership orders, memberships, wechat identities, and oauth states', async () => {
  const dir = await makeTempDir();
  const dbPath = path.join(dir, 'policy-ocr.sqlite');
  const seedStatePath = path.join(dir, 'state.json');
  await writeJson(seedStatePath, {
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    membershipConfig: { enabled: true, annualPriceCents: 30000, annualDurationDays: 365, registeredFreePolicyQuota: 2, updatedAt: '2026-06-11T08:00:00.000Z' },
    membershipOrders: [{
      id: 20,
      outTradeNo: 'mem_1_1790000000000_abcdef',
      userId: 1,
      productCode: 'annual_membership',
      amountCents: 30000,
      currency: 'CNY',
      status: 'paid',
      prepayId: 'wx-prepay',
      transactionId: '4200001',
      paidAt: '2026-06-11T08:01:00.000Z',
      expiresAt: '2026-06-11T08:30:00.000Z',
      createdAt: '2026-06-11T08:00:00.000Z',
      updatedAt: '2026-06-11T08:01:00.000Z',
      payload: { notify: { trade_state: 'SUCCESS' } },
    }],
    memberships: [{ userId: 1, plan: 'annual', status: 'active', startedAt: '2026-06-11T08:01:00.000Z', expiresAt: '2027-06-11T08:01:00.000Z', lastOrderId: 20, updatedAt: '2026-06-11T08:01:00.000Z' }],
    userWechatIdentities: [{ userId: 1, appId: 'wx123', openid: 'openid-1', scope: 'snsapi_base', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    wechatOAuthStates: [{ state: 'oauth-state-1', userId: 1, appId: 'wx123', redirectUrl: '/#/member', usedAt: '', expiresAt: '2026-06-11T08:10:00.000Z', createdAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 21,
  });

  const store = await createSqliteStateStore({ dbPath, seedStatePath });
  const imported = await store.load();
  assert.equal(imported.membershipConfig.registeredFreePolicyQuota, 2);
  assert.equal(imported.membershipOrders[0].outTradeNo, 'mem_1_1790000000000_abcdef');
  assert.equal(imported.memberships[0].expiresAt, '2027-06-11T08:01:00.000Z');
  assert.equal(imported.userWechatIdentities[0].openid, 'openid-1');
  assert.equal(imported.wechatOAuthStates[0].state, 'oauth-state-1');
  assert.equal(imported.nextId, 21);

  imported.membershipConfig = { ...imported.membershipConfig, registeredFreePolicyQuota: 4, updatedAt: '2026-06-11T09:00:00.000Z' };
  imported.membershipOrders.push({
    id: 21,
    outTradeNo: 'mem_1_1790000000001_bcdefa',
    userId: 1,
    productCode: 'annual_membership',
    amountCents: 30000,
    currency: 'CNY',
    status: 'prepay_created',
    prepayId: 'wx-prepay-2',
    transactionId: '',
    paidAt: '',
    expiresAt: '2026-06-11T09:30:00.000Z',
    createdAt: '2026-06-11T09:00:00.000Z',
    updatedAt: '2026-06-11T09:00:00.000Z',
    payload: {},
  });
  imported.nextId = 22;
  await store.persist(imported);
  store.close();

  const reopened = await createSqliteStateStore({ dbPath, seedStatePath });
  const reloaded = await reopened.load();
  assert.equal(reloaded.membershipConfig.registeredFreePolicyQuota, 4);
  assert.equal(reloaded.membershipOrders.length, 2);
  assert.equal(reloaded.membershipOrders[1].prepayId, 'wx-prepay-2');
  assert.equal(reloaded.memberships.length, 1);
  assert.equal(reloaded.userWechatIdentities.length, 1);
  assert.equal(reloaded.wechatOAuthStates.length, 1);
  assert.equal(reloaded.nextId, 22);
  reopened.close();
});
```

- [ ] **Step 2: Run the SQLite test and verify it fails**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "membership orders"
```

Expected: FAIL because the store does not load membership rows.

- [ ] **Step 3: Extend DB-owned keys and nextId resolution**

Modify `server/sqlite-state-store.mjs`:

```js
const DB_OWNED_KEYS = new Set([
  'users',
  'sessions',
  'adminSessions',
  'smsCodes',
  'policies',
  'pendingScans',
  'sourceRecords',
  'knowledgeRecords',
  'insuranceIndicatorRecords',
  'optionalResponsibilityRecords',
  'officialDomainProfiles',
  'familyProfiles',
  'familyMembers',
  'familyReportShares',
  'membershipConfig',
  'membershipOrders',
  'memberships',
  'userWechatIdentities',
  'wechatOAuthStates',
  'nextId',
]);
```

Update `resolveNextId()` so it also considers `state.membershipOrders`:

```js
    maxNumericId(state.familyReportShares),
    maxNumericId(state.membershipOrders),
```

- [ ] **Step 4: Add schema tables**

Inside `createSchema(db)`, after `family_report_shares`, add:

```sql
    CREATE TABLE IF NOT EXISTS membership_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS membership_orders (
      id INTEGER PRIMARY KEY,
      out_trade_no TEXT NOT NULL,
      user_id INTEGER,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_membership_orders_out_trade_no ON membership_orders(out_trade_no);
    CREATE INDEX IF NOT EXISTS idx_membership_orders_user_id ON membership_orders(user_id);

    CREATE TABLE IF NOT EXISTS memberships (
      user_id INTEGER PRIMARY KEY,
      status TEXT,
      expires_at TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_wechat_identities (
      user_id INTEGER,
      app_id TEXT,
      openid TEXT,
      updated_at TEXT,
      payload TEXT NOT NULL,
      PRIMARY KEY (user_id, app_id)
    );

    CREATE TABLE IF NOT EXISTS wechat_oauth_states (
      state TEXT PRIMARY KEY,
      user_id INTEGER,
      app_id TEXT,
      expires_at TEXT,
      used_at TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wechat_oauth_states_user_id ON wechat_oauth_states(user_id);
```

- [ ] **Step 5: Insert and load membership rows**

Add insert helpers near existing insert blocks:

```js
  if (state.membershipConfig) {
    db.prepare(`
      INSERT INTO membership_config (id, payload)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET payload = excluded.payload
    `).run(jsonPayload(state.membershipConfig));
  }

  const insertMembershipOrder = db.prepare(`
    INSERT INTO membership_orders (id, out_trade_no, user_id, status, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const order of normalizeArray(state.membershipOrders)) {
    insertMembershipOrder.run(
      Number(order.id),
      String(order.outTradeNo || ''),
      Number(order.userId || 0) || null,
      String(order.status || ''),
      String(order.createdAt || ''),
      String(order.updatedAt || ''),
      jsonPayload(order),
    );
  }

  const insertMembership = db.prepare(`
    INSERT INTO memberships (user_id, status, expires_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const membership of normalizeArray(state.memberships)) {
    insertMembership.run(
      Number(membership.userId || 0),
      String(membership.status || ''),
      String(membership.expiresAt || ''),
      String(membership.updatedAt || ''),
      jsonPayload(membership),
    );
  }

  const insertWechatIdentity = db.prepare(`
    INSERT INTO user_wechat_identities (user_id, app_id, openid, updated_at, payload)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const identity of normalizeArray(state.userWechatIdentities)) {
    insertWechatIdentity.run(
      Number(identity.userId || 0),
      String(identity.appId || ''),
      String(identity.openid || ''),
      String(identity.updatedAt || ''),
      jsonPayload(identity),
    );
  }

  const insertOauthState = db.prepare(`
    INSERT INTO wechat_oauth_states (state, user_id, app_id, expires_at, used_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  for (const oauth of normalizeArray(state.wechatOAuthStates)) {
    insertOauthState.run(
      String(oauth.state || ''),
      Number(oauth.userId || 0) || null,
      String(oauth.appId || ''),
      String(oauth.expiresAt || ''),
      String(oauth.usedAt || ''),
      jsonPayload(oauth),
    );
  }
```

Extend `loadDbOwnedState(db)`:

```js
    membershipConfig: parseJson(db.prepare('SELECT payload FROM membership_config WHERE id = 1').get()?.payload, null),
    membershipOrders: loadPayloadRows(db, 'membership_orders', 'id ASC'),
    memberships: loadPayloadRows(db, 'memberships', 'user_id ASC'),
    userWechatIdentities: loadPayloadRows(db, 'user_wechat_identities', 'user_id ASC, app_id ASC'),
    wechatOAuthStates: loadPayloadRows(db, 'wechat_oauth_states', 'created_at ASC'),
```

- [ ] **Step 6: Run the SQLite test and commit**

Run:

```bash
node --test tests/sqlite-state-store.test.mjs --test-name-pattern "membership orders"
```

Expected: PASS.

Commit:

```bash
git add server/sqlite-state-store.mjs tests/sqlite-state-store.test.mjs
git commit -m "feat: persist membership state"
```

## Task 3: User Membership Routes With Mock Payment

**Files:**
- Create: `server/routes/membership.routes.mjs`
- Create: `tests/membership-routes.test.mjs`
- Modify: `server/app.mjs`
- Modify: `server/http/errors.mjs`

- [ ] **Step 1: Write route tests**

Create `tests/membership-routes.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPolicyOcrApp } from '../server/app.mjs';
import { createInitialState } from '../server/policy-ocr.domain.mjs';
import { defaultMembershipConfig } from '../server/membership.domain.mjs';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function jsonFetch(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const payload = await response.json();
  return { response, payload };
}

test('membership routes expose status, create mock order, and confirm mock payment', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    membershipConfig: { ...defaultMembershipConfig('2026-06-11T08:00:00.000Z'), registeredFreePolicyQuota: 2 },
    policies: [{ id: 2, userId: 1, guestId: '', name: '已保存保单' }],
    nextId: 10,
  };
  const persisted = [];
  const app = createPolicyOcrApp({
    state,
    persist: async (nextState) => persisted.push(JSON.parse(JSON.stringify(nextState))),
    wechatPayMode: 'mock',
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const auth = { authorization: 'Bearer token-1' };
    const status = await jsonFetch(server.baseUrl, '/api/membership/me', { headers: auth });
    assert.equal(status.response.status, 200);
    assert.equal(status.payload.quota.savedPolicyCount, 1);
    assert.equal(status.payload.quota.freeQuota, 2);
    assert.equal(status.payload.membership.active, false);

    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', { headers: auth, method: 'POST', body: '{}' });
    assert.equal(created.response.status, 200);
    assert.equal(created.payload.order.status, 'prepay_created');
    assert.equal(created.payload.payParams.package.startsWith('prepay_id=mock_'), true);

    const confirmed = await jsonFetch(server.baseUrl, `/api/membership/orders/${created.payload.order.id}/mock-confirm`, { headers: auth, method: 'POST', body: '{}' });
    assert.equal(confirmed.response.status, 200);
    assert.equal(confirmed.payload.membership.active, true);

    const refreshed = await jsonFetch(server.baseUrl, '/api/membership/me', { headers: auth });
    assert.equal(refreshed.payload.membership.active, true);
    assert.equal(persisted.length >= 2, true);
  } finally {
    await server.close();
  }
});

test('membership order creation requires login', async () => {
  const app = createPolicyOcrApp({ state: createInitialState(), wechatPayMode: 'mock' });
  const server = await listen(app);
  try {
    const created = await jsonFetch(server.baseUrl, '/api/membership/orders', { method: 'POST', body: '{}' });
    assert.equal(created.response.status, 401);
    assert.equal(created.payload.code, 'UNAUTHORIZED');
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run route tests and verify they fail**

Run:

```bash
node --test tests/membership-routes.test.mjs
```

Expected: FAIL with 404 responses for `/api/membership/me`.

- [ ] **Step 3: Allow metadata in API errors**

Modify `server/http/errors.mjs`:

```js
  if (error?.registrationRequiredNext) payload.registrationRequiredNext = true;
  if (error?.membership) payload.membership = error.membership;
```

- [ ] **Step 4: Create membership routes**

Create `server/routes/membership.routes.mjs` with routes that use these context entries: `state`, `persist`, `resolveAuthUser`, `getBearerToken`, `buildMembershipSnapshot`, `createMembershipOrder`, `markMembershipOrderPrepayCreated`, `processMembershipPaymentSuccess`, `createMockJsapiPayParams`, and `nowIso`.

The route file must include this login helper:

```js
function requireUser(req, state, resolveAuthUser) {
  const user = resolveAuthUser(req, state);
  if (user) return user;
  const error = new Error('缺少登录信息');
  error.code = 'UNAUTHORIZED';
  error.status = 401;
  throw error;
}
```

Implement these endpoints:

```js
router.get('/me', async (req, res) => {
  try {
    const user = requireUser(req, state, resolveAuthUser);
    res.json({ ok: true, ...buildMembershipSnapshot(state, user, { now: nowIso() }) });
  } catch (error) {
    sendError(res, error, 401);
  }
});

router.post('/orders', async (req, res) => {
  try {
    const user = requireUser(req, state, resolveAuthUser);
    const order = createMembershipOrder(state, { userId: user.id, now: nowIso() });
    const payParams = createMockJsapiPayParams(order);
    markMembershipOrderPrepayCreated(state, order.outTradeNo, { prepayId: payParams.package.replace('prepay_id=', ''), now: nowIso(), payload: { mode: 'mock' } });
    await persist(state);
    res.json({ ok: true, order: { id: order.id, outTradeNo: order.outTradeNo, status: order.status, expiresAt: order.expiresAt }, payParams });
  } catch (error) {
    sendError(res, error, 400);
  }
});

router.get('/orders/:id', async (req, res) => {
  try {
    const user = requireUser(req, state, resolveAuthUser);
    const order = (state.membershipOrders || []).find((row) => Number(row.id) === Number(req.params.id) && Number(row.userId) === Number(user.id));
    if (!order) {
      const error = new Error('ORDER_NOT_FOUND');
      error.code = 'ORDER_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    res.json({ ok: true, order });
  } catch (error) {
    sendError(res, error, 404);
  }
});

router.post('/orders/:id/mock-confirm', async (req, res) => {
  try {
    const user = requireUser(req, state, resolveAuthUser);
    const order = (state.membershipOrders || []).find((row) => Number(row.id) === Number(req.params.id) && Number(row.userId) === Number(user.id));
    if (!order) {
      const error = new Error('ORDER_NOT_FOUND');
      error.code = 'ORDER_NOT_FOUND';
      error.status = 404;
      throw error;
    }
    processMembershipPaymentSuccess(state, {
      outTradeNo: order.outTradeNo,
      transactionId: `mock_${order.outTradeNo}`,
      amountCents: order.amountCents,
      paidAt: nowIso(),
      notifyPayload: { mode: 'mock' },
    });
    await persist(state);
    res.json({ ok: true, order, ...buildMembershipSnapshot(state, user, { now: nowIso() }) });
  } catch (error) {
    sendError(res, error, 400);
  }
});
```

- [ ] **Step 5: Wire routes into the app**

Modify `server/app.mjs`:

```js
import { createMembershipRoutes } from './routes/membership.routes.mjs';
import {
  buildMembershipSnapshot,
  createMembershipOrder,
  markMembershipOrderPrepayCreated,
  processMembershipPaymentSuccess,
} from './membership.domain.mjs';
import { createMockJsapiPayParams } from './wechat-pay.service.mjs';
```

Ensure arrays exist in `createPolicyOcrApp`:

```js
  if (!state.membershipConfig) state.membershipConfig = null;
  if (!Array.isArray(state.membershipOrders)) state.membershipOrders = [];
  if (!Array.isArray(state.memberships)) state.memberships = [];
  if (!Array.isArray(state.userWechatIdentities)) state.userWechatIdentities = [];
  if (!Array.isArray(state.wechatOAuthStates)) state.wechatOAuthStates = [];
```

Add to `routeContext`:

```js
    buildMembershipSnapshot,
    createMembershipOrder,
    markMembershipOrderPrepayCreated,
    processMembershipPaymentSuccess,
    createMockJsapiPayParams,
    nowIso: typeof options.now === 'function' ? options.now : () => new Date().toISOString(),
```

Mount before policy routes:

```js
  app.use('/api/membership', createMembershipRoutes(routeContext));
```

- [ ] **Step 6: Implement mock pay params**

Create `server/wechat-pay.service.mjs` with:

```js
export function createMockJsapiPayParams(order) {
  return {
    appId: 'mock-wechat-appid',
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: `mock_${order.id}`,
    package: `prepay_id=mock_${order.outTradeNo}`,
    signType: 'RSA',
    paySign: `mock_sign_${order.id}`,
  };
}
```

- [ ] **Step 7: Run route tests and commit**

Run:

```bash
node --test tests/membership-routes.test.mjs
```

Expected: PASS.

Commit:

```bash
git add server/app.mjs server/http/errors.mjs server/routes/membership.routes.mjs server/wechat-pay.service.mjs tests/membership-routes.test.mjs
git commit -m "feat: add mock membership routes"
```

## Task 4: Policy Save Entitlement Gate

**Files:**
- Modify: `server/routes/policies.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/policy-ocr-flow.test.mjs`

- [ ] **Step 1: Add failing policy gate tests**

Append these tests to `tests/policy-ocr-flow.test.mjs`:

```js
test('registered user over free quota must buy membership before saving another policy', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    membershipConfig: { enabled: true, annualPriceCents: 30000, annualDurationDays: 365, registeredFreePolicyQuota: 1, updatedAt: '2026-06-11T08:00:00.000Z' },
    policies: [{ id: 10, userId: 1, guestId: '', company: '新华保险', name: '已有保单', insured: '张三', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 20,
  };
  const app = createPolicyOcrApp({
    state,
    scanner: async () => ({ ocrText: '保单文本', data: { company: '新华保险', name: '新保单', insured: '张三', applicant: '张三' } }),
    analyzer: async () => ({ coverageTable: [] }),
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const result = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      headers: { authorization: 'Bearer token-1' },
      method: 'POST',
      body: JSON.stringify({
        guestId: '',
        ocrText: '保单文本',
        uploadItem: null,
        manualData: { company: '新华保险', name: '新保单', insured: '张三', applicant: '张三' },
      }),
    });
    assert.equal(result.response.status, 402);
    assert.equal(result.payload.code, 'MEMBERSHIP_REQUIRED');
    assert.deepEqual(result.payload.membership, { savedPolicyCount: 1, freeQuota: 1, annualPriceCents: 30000 });
    assert.equal(state.policies.length, 1);
  } finally {
    await server.close();
  }
});

test('active member can save over configured free quota', async () => {
  const state = {
    ...createInitialState(),
    users: [{ id: 1, mobile: '18616135811', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    sessions: [{ token: 'token-1', userId: 1, createdAt: '2026-06-11T08:00:00.000Z' }],
    membershipConfig: { enabled: true, annualPriceCents: 30000, annualDurationDays: 365, registeredFreePolicyQuota: 1, updatedAt: '2026-06-11T08:00:00.000Z' },
    memberships: [{ userId: 1, plan: 'annual', status: 'active', startedAt: '2026-06-11T08:00:00.000Z', expiresAt: '2027-06-11T08:00:00.000Z', lastOrderId: 9, updatedAt: '2026-06-11T08:00:00.000Z' }],
    policies: [{ id: 10, userId: 1, guestId: '', company: '新华保险', name: '已有保单', insured: '张三', createdAt: '2026-06-11T08:00:00.000Z', updatedAt: '2026-06-11T08:00:00.000Z' }],
    nextId: 20,
  };
  const app = createPolicyOcrApp({
    state,
    scanner: async () => ({ ocrText: '保单文本', data: { company: '新华保险', name: '新保单', insured: '张三', applicant: '张三' } }),
    analyzer: async () => ({ coverageTable: [] }),
    now: () => '2026-06-11T08:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const result = await jsonFetch(server.baseUrl, '/api/policies/scan', {
      headers: { authorization: 'Bearer token-1' },
      method: 'POST',
      body: JSON.stringify({
        guestId: '',
        ocrText: '保单文本',
        uploadItem: null,
        manualData: { company: '新华保险', name: '新保单', insured: '张三', applicant: '张三' },
      }),
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.policy.userId, 1);
    assert.equal(state.policies.length, 2);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run focused policy tests and verify failure**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "free quota|active member"
```

Expected: first new test FAILS because no membership gate exists.

- [ ] **Step 3: Pass the entitlement checker through route context**

Modify `server/app.mjs` imports:

```js
import { assertUserCanSavePolicy } from './membership.domain.mjs';
```

Add to `routeContext`:

```js
    assertUserCanSavePolicy,
```

- [ ] **Step 4: Gate policy save after resolving user**

Modify `server/routes/policies.routes.mjs` context destructuring to include `assertUserCanSavePolicy`.

Inside `router.post('/policies/scan')`, after:

```js
      assertGuestCanScan({ state, user, guestId });
```

add:

```js
      if (typeof assertUserCanSavePolicy === 'function') {
        assertUserCanSavePolicy(state, user);
      }
```

This keeps OCR recognition and analysis free for logged-in users while enforcing membership on successful save attempts.

- [ ] **Step 5: Run focused policy tests and commit**

Run:

```bash
node --test tests/policy-ocr-flow.test.mjs --test-name-pattern "free quota|active member"
```

Expected: PASS.

Commit:

```bash
git add server/app.mjs server/routes/policies.routes.mjs tests/policy-ocr-flow.test.mjs
git commit -m "feat: gate policy saves by membership"
```

## Task 5: Admin Membership Config

**Files:**
- Modify: `server/routes/admin.routes.mjs`
- Modify: `server/app.mjs`
- Modify: `src/api/contracts/admin.ts`
- Test: `tests/membership-routes.test.mjs`

- [ ] **Step 1: Add failing admin route test**

Append to `tests/membership-routes.test.mjs`:

```js
test('admin can update membership purchase flag and free quota only', async () => {
  const state = { ...createInitialState(), membershipConfig: defaultMembershipConfig('2026-06-11T08:00:00.000Z') };
  const app = createPolicyOcrApp({
    state,
    adminPassword: 'admin123456',
    wechatPayMode: 'mock',
    now: () => '2026-06-11T09:00:00.000Z',
  });
  const server = await listen(app);
  try {
    const login = await jsonFetch(server.baseUrl, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: 'admin123456' }),
    });
    const auth = { authorization: `Bearer ${login.payload.token}` };
    const updated = await jsonFetch(server.baseUrl, '/api/admin/membership-config', {
      headers: auth,
      method: 'PATCH',
      body: JSON.stringify({
        enabled: false,
        registeredFreePolicyQuota: 6,
        annualPriceCents: 1,
        annualDurationDays: 1,
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.payload.config.enabled, false);
    assert.equal(updated.payload.config.registeredFreePolicyQuota, 6);
    assert.equal(updated.payload.config.annualPriceCents, 30000);
    assert.equal(updated.payload.config.annualDurationDays, 365);

    const fetched = await jsonFetch(server.baseUrl, '/api/admin/membership-config', { headers: auth });
    assert.deepEqual(fetched.payload.config, updated.payload.config);
  } finally {
    await server.close();
  }
});
```

- [ ] **Step 2: Run the admin route test and verify failure**

Run:

```bash
node --test tests/membership-routes.test.mjs --test-name-pattern "admin can update membership"
```

Expected: FAIL with 404 for `/api/admin/membership-config`.

- [ ] **Step 3: Add admin route dependencies**

Modify `server/app.mjs` imports:

```js
import { getMembershipConfig, updateMembershipConfig } from './membership.domain.mjs';
```

Add to `routeContext`:

```js
    getMembershipConfig,
    updateMembershipConfig,
```

- [ ] **Step 4: Add admin endpoints**

Modify `server/routes/admin.routes.mjs` destructuring to include `getMembershipConfig` and `updateMembershipConfig`.

Add before `return router;`:

```js
  router.get('/membership-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    res.json({ ok: true, config: getMembershipConfig(state) });
  });

  router.patch('/membership-config', async (req, res) => {
    const session = requireAdmin(req, res, state, adminPassword);
    if (!session) return;
    try {
      const config = updateMembershipConfig(state, {
        enabled: req.body?.enabled,
        registeredFreePolicyQuota: req.body?.registeredFreePolicyQuota,
      });
      await persist(state);
      res.json({ ok: true, config });
    } catch (error) {
      sendError(res, error, 400);
    }
  });
```

- [ ] **Step 5: Add admin TypeScript contract**

Modify `src/api/contracts/admin.ts`:

```ts
export type AdminMembershipConfig = {
  enabled: boolean;
  annualPriceCents: 30000;
  annualDurationDays: 365;
  registeredFreePolicyQuota: number;
  updatedAt: string;
};

export function getAdminMembershipConfig(token: string) {
  return request<{ ok: true; config: AdminMembershipConfig }>('/api/admin/membership-config', { token });
}

export function updateAdminMembershipConfig(token: string, input: { enabled: boolean; registeredFreePolicyQuota: number }) {
  return request<{ ok: true; config: AdminMembershipConfig }>('/api/admin/membership-config', {
    token,
    method: 'PATCH',
    body: input,
  });
}
```

- [ ] **Step 6: Run route and type checks, then commit**

Run:

```bash
node --test tests/membership-routes.test.mjs --test-name-pattern "admin can update membership"
npm run typecheck
```

Expected: both PASS.

Commit:

```bash
git add server/app.mjs server/routes/admin.routes.mjs src/api/contracts/admin.ts tests/membership-routes.test.mjs
git commit -m "feat: add membership admin config"
```

## Task 6: Customer API and Purchase UI

**Files:**
- Create: `src/api/contracts/membership.ts`
- Create: `src/features/customer-membership/MembershipPurchaseDialog.tsx`
- Modify: `src/features/customer-auth/CustomerAccountSheet.tsx`
- Modify: `src/apps/customer/CustomerApp.tsx`
- Test: `tests/customer-membership-ui.test.mjs`

- [ ] **Step 1: Add source-level UI tests**

Create `tests/customer-membership-ui.test.mjs`:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (file) => fs.readFileSync(file, 'utf8');

test('customer membership API contract exposes status, order creation, order lookup, oauth start, and mock confirm', () => {
  const source = read('src/api/contracts/membership.ts');
  assert.match(source, /export function getMembershipStatus/);
  assert.match(source, /export function createMembershipOrder/);
  assert.match(source, /export function getMembershipOrder/);
  assert.match(source, /export function startMembershipWechatOAuth/);
  assert.match(source, /export function confirmMockMembershipOrder/);
});

test('customer account sheet displays membership status and purchase action', () => {
  const source = read('src/features/customer-auth/CustomerAccountSheet.tsx');
  assert.match(source, /membershipStatus/);
  assert.match(source, /会员有效至/);
  assert.match(source, /已保存/);
  assert.match(source, /onOpenMembership/);
});

test('customer app handles membership required errors and invokes WeixinJSBridge only through purchase flow', () => {
  const source = read('src/apps/customer/CustomerApp.tsx');
  assert.match(source, /MEMBERSHIP_REQUIRED/);
  assert.match(source, /setShowMembershipDialog\(true\)/);
  assert.match(source, /createMembershipOrder/);
  assert.match(source, /getBrandWCPayRequest/);
  assert.match(source, /confirmMockMembershipOrder/);
});
```

- [ ] **Step 2: Run UI tests and verify they fail**

Run:

```bash
node --test tests/customer-membership-ui.test.mjs
```

Expected: FAIL because the membership frontend files do not exist.

- [ ] **Step 3: Add customer membership API contract**

Create `src/api/contracts/membership.ts`:

```ts
import { request } from '../client';

export type MembershipStatus = {
  ok: true;
  membership: {
    active: boolean;
    plan: 'annual' | null;
    expiresAt: string | null;
  };
  quota: {
    savedPolicyCount: number;
    freeQuota: number;
    requiresMembership: boolean;
  };
  purchase: {
    enabled: boolean;
    annualPriceCents: 30000;
    annualDurationDays: 365;
    wechatOpenidBound: boolean;
  };
};

export type MembershipOrder = {
  id: number;
  outTradeNo: string;
  status: 'created' | 'prepay_created' | 'paid' | 'closed' | 'failed';
  expiresAt: string;
};

export type WechatPayParams = {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
};

export function getMembershipStatus(token: string) {
  return request<MembershipStatus>('/api/membership/me', { token });
}

export function createMembershipOrder(token: string) {
  return request<{ ok: true; order: MembershipOrder; payParams: WechatPayParams }>('/api/membership/orders', {
    token,
    body: {},
  });
}

export function getMembershipOrder(token: string, id: number) {
  return request<{ ok: true; order: MembershipOrder }>(`/api/membership/orders/${id}`, { token });
}

export function startMembershipWechatOAuth(token: string, redirectUrl: string) {
  return request<{ ok: true; authorizeUrl: string }>('/api/membership/wechat-oauth/start', {
    token,
    body: { redirectUrl },
  });
}

export function confirmMockMembershipOrder(token: string, id: number) {
  return request<MembershipStatus & { order: MembershipOrder }>(`/api/membership/orders/${id}/mock-confirm`, {
    token,
    body: {},
  });
}
```

- [ ] **Step 4: Add purchase dialog component**

Create `src/features/customer-membership/MembershipPurchaseDialog.tsx`:

```tsx
import { Crown, RefreshCw, X } from 'lucide-react';

import type { MembershipStatus } from '../../api/contracts/membership';

function priceText(cents: number) {
  return `￥${(cents / 100).toFixed(0)}`;
}

export function MembershipPurchaseDialog(props: {
  loading: boolean;
  message: string;
  membershipStatus: MembershipStatus | null;
  onClose: () => void;
  onPurchase: () => void;
  onRefresh: () => void;
}) {
  const { loading, message, membershipStatus, onClose, onPurchase, onRefresh } = props;
  const price = membershipStatus?.purchase.annualPriceCents ?? 30000;
  const saved = membershipStatus?.quota.savedPolicyCount ?? 0;
  const quota = membershipStatus?.quota.freeQuota ?? 0;
  return (
    <div className="fixed inset-0 z-[90] flex items-end bg-slate-950/40 px-4 pb-4 sm:items-center sm:justify-center">
      <section className="w-full rounded-[24px] bg-white p-5 shadow-2xl sm:max-w-md">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-500 text-white shadow-lg shadow-amber-500/25">
              <Crown size={23} />
            </div>
            <div className="min-w-0">
              <h2 className="text-lg font-black text-slate-950">年费会员</h2>
              <p className="mt-1 text-sm font-semibold text-slate-500">继续录入和保存更多保单</p>
            </div>
          </div>
          <button className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500" type="button" onClick={onClose} aria-label="关闭会员">
            <X size={18} />
          </button>
        </div>
        <div className="mt-5 rounded-2xl border border-amber-100 bg-amber-50 p-4">
          <p className="text-xs font-black text-amber-700">年费</p>
          <p className="mt-2 text-3xl font-black text-slate-950">{priceText(price)}</p>
          <p className="mt-1 text-sm font-bold text-slate-600">有效期 365 天</p>
        </div>
        <div className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm font-bold text-slate-600">已保存 {saved}/{quota} 张免费保单</p>
        </div>
        {message ? <p className="mt-3 text-sm font-semibold text-slate-600">{message}</p> : null}
        <button className="mt-4 flex h-12 w-full items-center justify-center rounded-xl bg-amber-500 text-sm font-black text-white shadow-lg shadow-amber-500/25 disabled:opacity-60" type="button" onClick={onPurchase} disabled={loading}>
          {loading ? '处理中...' : `微信支付 ${priceText(price)}`}
        </button>
        <button className="mt-2 flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white text-sm font-black text-slate-700" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={17} />
          刷新会员状态
        </button>
      </section>
    </div>
  );
}
```

- [ ] **Step 5: Extend account sheet props and display**

Modify `src/features/customer-auth/CustomerAccountSheet.tsx` props:

```ts
  membershipStatus: MembershipStatus | null;
  onOpenMembership: () => void;
```

Import the type:

```ts
import type { MembershipStatus } from '../../api/contracts/membership';
```

Add a status block under the login account block:

```tsx
        {isLoggedIn ? (
          <div className="mt-3 rounded-2xl border border-amber-100 bg-amber-50 p-4">
            <p className="text-xs font-black text-amber-700">会员</p>
            <p className="mt-2 text-sm font-black text-slate-950">
              {membershipStatus?.membership.active && membershipStatus.membership.expiresAt
                ? `会员有效至 ${membershipStatus.membership.expiresAt.slice(0, 10)}`
                : `已保存 ${membershipStatus?.quota.savedPolicyCount ?? policyCount}/${membershipStatus?.quota.freeQuota ?? 0} 张免费保单`}
            </p>
            <button className="mt-3 flex h-10 w-full items-center justify-center rounded-xl bg-amber-500 text-sm font-black text-white" type="button" onClick={onOpenMembership}>
              开通年费会员
            </button>
          </div>
        ) : null}
```

- [ ] **Step 6: Wire membership state in CustomerApp**

Modify `src/apps/customer/CustomerApp.tsx` imports:

```ts
import {
  confirmMockMembershipOrder,
  createMembershipOrder,
  getMembershipStatus,
  startMembershipWechatOAuth,
  type MembershipStatus,
  type WechatPayParams,
} from '../../api/contracts/membership';
import { MembershipPurchaseDialog } from '../../features/customer-membership/MembershipPurchaseDialog';
```

Add state near account sheet state:

```ts
  const [membershipStatus, setMembershipStatus] = useState<MembershipStatus | null>(null);
  const [showMembershipDialog, setShowMembershipDialog] = useState(false);
  const [membershipLoading, setMembershipLoading] = useState(false);
  const [membershipMessage, setMembershipMessage] = useState('');
```

Add helpers:

```ts
  async function refreshMembershipStatus(nextToken = token) {
    if (!nextToken) {
      setMembershipStatus(null);
      return null;
    }
    const payload = await getMembershipStatus(nextToken);
    setMembershipStatus(payload);
    return payload;
  }

  function invokeWechatPay(payParams: WechatPayParams) {
    return new Promise<'ok' | 'cancel' | 'fail'>((resolve) => {
      const bridge = (window as Window & { WeixinJSBridge?: { invoke: (name: string, params: WechatPayParams, cb: (res: { err_msg?: string }) => void) => void } }).WeixinJSBridge;
      if (!bridge) {
        resolve('fail');
        return;
      }
      bridge.invoke('getBrandWCPayRequest', payParams, (res) => {
        const message = String(res?.err_msg || '');
        if (message.includes(':ok')) resolve('ok');
        else if (message.includes(':cancel')) resolve('cancel');
        else resolve('fail');
      });
    });
  }

  async function handleMembershipPurchase() {
    if (!token || membershipLoading) return;
    setMembershipLoading(true);
    setMembershipMessage('正在创建会员订单');
    try {
      const created = await createMembershipOrder(token);
      if (created.payParams.appId === 'mock-wechat-appid') {
        await confirmMockMembershipOrder(token, created.order.id);
        await refreshMembershipStatus(token);
        setMembershipMessage('会员已开通');
        return;
      }
      setMembershipMessage('请在微信中确认支付');
      const result = await invokeWechatPay(created.payParams);
      setMembershipMessage(result === 'ok' ? '支付确认中，请稍候刷新' : result === 'cancel' ? '已取消支付' : '支付未完成，请重试');
      await refreshMembershipStatus(token);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'WECHAT_OPENID_REQUIRED') {
        const started = await startMembershipWechatOAuth(token, `${window.location.pathname}${window.location.hash}`);
        window.location.href = started.authorizeUrl;
        return;
      }
      setMembershipMessage(error instanceof Error ? error.message : '会员购买失败');
    } finally {
      setMembershipLoading(false);
    }
  }
```

Call `refreshMembershipStatus` after login success and in initial authenticated loading path. In `handleVerifyAuthCode`, after `setToken(payload.token)`, add:

```ts
      void refreshMembershipStatus(payload.token).catch(() => undefined);
```

In save error handling, before `setMessage(...)`, add:

```ts
      if (error instanceof ApiError && error.code === 'MEMBERSHIP_REQUIRED') {
        setShowMembershipDialog(true);
        void refreshMembershipStatus().catch(() => undefined);
        setMessage(error.message || '免费额度已用完，请开通会员继续录入');
        return;
      }
```

Pass `membershipStatus` and `onOpenMembership` to `CustomerAccountSheet`.

Render the dialog beside `accountSheet`:

```tsx
  const membershipDialog = showMembershipDialog ? (
    <MembershipPurchaseDialog
      loading={membershipLoading}
      message={membershipMessage}
      membershipStatus={membershipStatus}
      onClose={() => setShowMembershipDialog(false)}
      onPurchase={handleMembershipPurchase}
      onRefresh={() => {
        setMembershipMessage('正在刷新会员状态');
        void refreshMembershipStatus().then(() => setMembershipMessage('会员状态已刷新')).catch((error) => setMembershipMessage(error instanceof Error ? error.message : '刷新失败'));
      }}
    />
  ) : null;
```

Include `{membershipDialog}` in each main render branch that already includes `{accountSheet}`.

- [ ] **Step 7: Run frontend checks and commit**

Run:

```bash
node --test tests/customer-membership-ui.test.mjs
npm run typecheck
npm run build
```

Expected: all PASS.

Commit:

```bash
git add src/api/contracts/membership.ts src/features/customer-membership/MembershipPurchaseDialog.tsx src/features/customer-auth/CustomerAccountSheet.tsx src/apps/customer/CustomerApp.tsx tests/customer-membership-ui.test.mjs
git commit -m "feat: add customer membership purchase UI"
```

## Task 7: Admin UI

**Files:**
- Modify: `src/apps/admin/AdminApp.tsx`
- Test: `tests/customer-membership-ui.test.mjs`

- [ ] **Step 1: Add static admin UI assertions**

Append to `tests/customer-membership-ui.test.mjs`:

```js
test('admin app exposes membership settings controls', () => {
  const source = read('src/apps/admin/AdminApp.tsx');
  assert.match(source, /getAdminMembershipConfig/);
  assert.match(source, /updateAdminMembershipConfig/);
  assert.match(source, /会员设置/);
  assert.match(source, /注册用户免费保存保单数/);
});
```

- [ ] **Step 2: Run static test and verify failure**

Run:

```bash
node --test tests/customer-membership-ui.test.mjs --test-name-pattern "admin app exposes"
```

Expected: FAIL because the admin app has no membership settings UI.

- [ ] **Step 3: Add admin membership config state and handlers**

Modify `src/apps/admin/AdminApp.tsx` imports:

```ts
import {
  getAdminMembershipConfig,
  updateAdminMembershipConfig,
  type AdminMembershipConfig,
} from '../../api/contracts/admin';
```

Add state:

```ts
  const [membershipConfig, setMembershipConfig] = useState<AdminMembershipConfig | null>(null);
  const [membershipQuotaInput, setMembershipQuotaInput] = useState('3');
```

Add loader:

```ts
  async function loadMembershipConfig(token = adminToken) {
    if (!token) return;
    const payload = await getAdminMembershipConfig(token);
    setMembershipConfig(payload.config);
    setMembershipQuotaInput(String(payload.config.registeredFreePolicyQuota));
  }
```

Call `loadMembershipConfig(payload.token)` after admin login and in the existing admin data refresh path.

Add save handler:

```ts
  async function handleSaveMembershipConfig() {
    if (!adminToken || !membershipConfig) return;
    const quota = Math.max(0, Math.floor(Number(membershipQuotaInput || 0)));
    const payload = await updateAdminMembershipConfig(adminToken, {
      enabled: membershipConfig.enabled,
      registeredFreePolicyQuota: quota,
    });
    setMembershipConfig(payload.config);
    setMembershipQuotaInput(String(payload.config.registeredFreePolicyQuota));
    setMessage('会员设置已保存');
  }
```

- [ ] **Step 4: Add compact settings panel**

Render a panel in the admin dashboard:

```tsx
        <section className="rounded-2xl border border-slate-200 bg-white p-4">
          <h2 className="text-base font-black text-slate-950">会员设置</h2>
          <label className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-slate-200 px-3 py-2">
            <span className="text-sm font-bold text-slate-700">开放会员购买</span>
            <input
              type="checkbox"
              checked={membershipConfig?.enabled ?? true}
              onChange={(event) => setMembershipConfig((current) => current ? { ...current, enabled: event.target.checked } : current)}
            />
          </label>
          <label className="mt-3 block">
            <span className="text-xs font-black text-slate-400">注册用户免费保存保单数</span>
            <input
              className="mt-1 h-11 w-full rounded-xl border border-slate-200 px-3 text-sm font-bold text-slate-900"
              type="number"
              min="0"
              value={membershipQuotaInput}
              onChange={(event) => setMembershipQuotaInput(event.target.value)}
            />
          </label>
          <p className="mt-3 text-xs font-semibold text-slate-500">年费价格 300 元，有效期 365 天。免费额度只按已成功保存保单数计算。</p>
          <button className="mt-4 h-11 rounded-xl bg-slate-900 px-4 text-sm font-black text-white" type="button" onClick={handleSaveMembershipConfig}>
            保存会员设置
          </button>
        </section>
```

- [ ] **Step 5: Run frontend checks and commit**

Run:

```bash
node --test tests/customer-membership-ui.test.mjs --test-name-pattern "admin app exposes"
npm run typecheck
npm run build
```

Expected: all PASS.

Commit:

```bash
git add src/apps/admin/AdminApp.tsx tests/customer-membership-ui.test.mjs
git commit -m "feat: add admin membership settings"
```

## Task 8: OAuth and Live WeChat Pay Service

**Files:**
- Modify: `server/wechat-pay.service.mjs`
- Modify: `server/routes/membership.routes.mjs`
- Modify: `server/app.mjs`
- Test: `tests/wechat-pay-service.test.mjs`
- Test: `tests/membership-routes.test.mjs`
- Modify: `.env.example`

- [ ] **Step 1: Write WeChat Pay service tests**

Create `tests/wechat-pay-service.test.mjs`:

```js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  decryptWechatPayResource,
  resolveWechatPayConfig,
  signWechatPayMessage,
  verifyWechatPaySignature,
} from '../server/wechat-pay.service.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });

test('resolveWechatPayConfig reports mock and live readiness', () => {
  assert.equal(resolveWechatPayConfig({ WECHAT_PAY_MODE: 'mock' }).mode, 'mock');
  const live = resolveWechatPayConfig({
    WECHAT_PAY_MODE: 'live',
    WECHAT_H5_APP_ID: 'wx123',
    WECHAT_PAY_MCH_ID: 'mch123',
    WECHAT_PAY_API_V3_KEY: '12345678901234567890123456789012',
    WECHAT_PAY_SERIAL_NO: 'serial123',
    WECHAT_PAY_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID: 'PUB_KEY_ID_1',
    WECHAT_PAY_NOTIFY_URL: 'https://app.example.com/api/membership/wechatpay/notify',
  });
  assert.equal(live.ready, true);
});

test('signWechatPayMessage and verifyWechatPaySignature round trip', () => {
  const body = '{"id":"notify"}';
  const timestamp = '1790000000';
  const nonce = 'nonce-1';
  const signature = signWechatPayMessage(`${timestamp}\n${nonce}\n${body}\n`, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  assert.equal(verifyWechatPaySignature({ timestamp, nonce, body, signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), true);
  assert.equal(verifyWechatPaySignature({ timestamp, nonce, body: '{}', signature, publicKey: publicKey.export({ type: 'spki', format: 'pem' }) }), false);
});

test('decryptWechatPayResource decrypts AES-256-GCM resource payload', () => {
  const apiV3Key = '12345678901234567890123456789012';
  const nonce = '0123456789ab';
  const associatedData = 'transaction';
  const plain = JSON.stringify({ out_trade_no: 'mem_1', trade_state: 'SUCCESS', amount: { total: 30000 } });
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, authTag]).toString('base64');
  assert.deepEqual(decryptWechatPayResource({ apiV3Key, nonce, associatedData, ciphertext }), JSON.parse(plain));
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run:

```bash
node --test tests/wechat-pay-service.test.mjs
```

Expected: FAIL because live helpers are not exported.

- [ ] **Step 3: Implement crypto/config helpers**

Extend `server/wechat-pay.service.mjs` with these exported functions:

```js
import crypto from 'node:crypto';
import fs from 'node:fs';

function trim(value) {
  return String(value || '').trim();
}

function readSecret(env, valueKey, pathKey) {
  const direct = trim(env[valueKey]);
  if (direct) return direct.replace(/\\n/g, '\n');
  const filePath = trim(env[pathKey]);
  return filePath ? fs.readFileSync(filePath, 'utf8') : '';
}

export function resolveWechatPayConfig(env = process.env) {
  const mode = trim(env.WECHAT_PAY_MODE) || 'mock';
  const config = {
    mode,
    appId: trim(env.WECHAT_H5_APP_ID || env.WECHAT_APP_ID),
    mchId: trim(env.WECHAT_PAY_MCH_ID),
    apiV3Key: trim(env.WECHAT_PAY_API_V3_KEY),
    serialNo: trim(env.WECHAT_PAY_SERIAL_NO),
    privateKey: readSecret(env, 'WECHAT_PAY_PRIVATE_KEY', 'WECHAT_PAY_PRIVATE_KEY_PATH'),
    platformPublicKey: readSecret(env, 'WECHAT_PAY_PLATFORM_PUBLIC_KEY', 'WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH'),
    platformPublicKeyId: trim(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID),
    notifyUrl: trim(env.WECHAT_PAY_NOTIFY_URL),
  };
  config.ready = mode === 'mock' || Boolean(config.appId && config.mchId && config.apiV3Key && config.serialNo && config.privateKey && config.platformPublicKey && config.notifyUrl);
  return config;
}

export function signWechatPayMessage(message, privateKey) {
  return crypto.createSign('RSA-SHA256').update(message).sign(privateKey, 'base64');
}

export function verifyWechatPaySignature({ timestamp, nonce, body, signature, publicKey }) {
  try {
    return crypto.createVerify('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${body}\n`)
      .verify(publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

export function decryptWechatPayResource({ apiV3Key, nonce, associatedData, ciphertext }) {
  const encrypted = Buffer.from(ciphertext, 'base64');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  decipher.setAuthTag(authTag);
  if (associatedData) decipher.setAAD(Buffer.from(associatedData));
  const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  return JSON.parse(plain);
}
```

- [ ] **Step 4: Add JSAPI pay signing and live prepay**

Add to `server/wechat-pay.service.mjs`:

```js
export function buildJsapiPayParams({ appId, prepayId, privateKey, nonceStr = crypto.randomBytes(16).toString('hex'), timeStamp = String(Math.floor(Date.now() / 1000)) }) {
  const packageValue = `prepay_id=${prepayId}`;
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${packageValue}\n`;
  return {
    appId,
    timeStamp,
    nonceStr,
    package: packageValue,
    signType: 'RSA',
    paySign: signWechatPayMessage(message, privateKey),
  };
}

export async function createWechatPayJsapiPrepay({ config, order, openid, fetchImpl = fetch }) {
  if (!config.ready || config.mode !== 'live') {
    const error = new Error('WECHAT_PAY_NOT_CONFIGURED');
    error.code = 'WECHAT_PAY_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  const body = JSON.stringify({
    appid: config.appId,
    mchid: config.mchId,
    description: 'OCR Insurance 年费会员',
    out_trade_no: order.outTradeNo,
    time_expire: order.expiresAt,
    notify_url: config.notifyUrl,
    amount: { total: order.amountCents, currency: order.currency },
    payer: { openid },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString('hex');
  const urlPath = '/v3/pay/transactions/jsapi';
  const signature = signWechatPayMessage(`POST\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`, config.privateKey);
  const response = await fetchImpl(`https://api.mch.weixin.qq.com${urlPath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.serialNo}",signature="${signature}"`,
    },
    body,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.prepay_id) {
    const error = new Error(payload?.message || 'WECHAT_PAY_PREPAY_FAILED');
    error.code = payload?.code || 'WECHAT_PAY_PREPAY_FAILED';
    error.status = 502;
    throw error;
  }
  return { prepayId: payload.prepay_id, payParams: buildJsapiPayParams({ appId: config.appId, prepayId: payload.prepay_id, privateKey: config.privateKey }) };
}
```

- [ ] **Step 5: Wire OAuth start/callback and notify routes**

Extend `server/routes/membership.routes.mjs` to:

- Use `resolveWechatPayConfig()` from route context.
- In live `POST /orders`, require `wechatOpenidBound`; if absent, throw `WECHAT_OPENID_REQUIRED`.
- Add `POST /wechat-oauth/start` using `createWechatOAuthState`.
- Add `GET /wechat-oauth/callback` using `consumeWechatOAuthState`, `upsertUserWechatIdentity`, and a context `fetchWechatOAuthOpenid` function.
- Add `POST /wechatpay/notify` that reads the JSON body, verifies signature, decrypts resource, validates `trade_state`, `appid`, `mchid`, and amount, then calls `processMembershipPaymentSuccess`.

Use this response for successful notify:

```js
res.json({ code: 'SUCCESS', message: '成功' });
```

- [ ] **Step 6: Wire app context and raw body policy**

Modify `server/app.mjs` imports:

```js
import {
  createWechatPayJsapiPrepay,
  decryptWechatPayResource,
  resolveWechatPayConfig,
  verifyWechatPaySignature,
} from './wechat-pay.service.mjs';
import {
  consumeWechatOAuthState,
  createWechatOAuthState,
  findUserWechatOpenid,
  upsertUserWechatIdentity,
} from './membership.domain.mjs';
```

Add an OAuth helper near the existing WeChat JS-SDK helpers:

```js
async function fetchWechatOAuthOpenid(code) {
  const config = resolveWechatConfig();
  assertWechatConfigReady(config);
  const url = new URL('https://api.weixin.qq.com/sns/oauth2/access_token');
  url.searchParams.set('appid', config.appId);
  url.searchParams.set('secret', config.appSecret);
  url.searchParams.set('code', String(code || '').trim());
  url.searchParams.set('grant_type', 'authorization_code');
  const payload = await fetchWechatJson(url);
  const openid = String(payload?.openid || '').trim();
  if (!openid) {
    const error = new Error('WECHAT_OPENID_NOT_FOUND');
    error.code = 'WECHAT_OPENID_NOT_FOUND';
    error.status = 502;
    throw error;
  }
  return openid;
}
```

Add to `routeContext`:

```js
    consumeWechatOAuthState,
    createWechatOAuthState,
    findUserWechatOpenid,
    upsertUserWechatIdentity,
    resolveWechatPayConfig: () => resolveWechatPayConfig(process.env),
    createWechatPayJsapiPrepay,
    decryptWechatPayResource,
    verifyWechatPaySignature,
    fetchWechatOAuthOpenid,
```

If notify signature verification needs exact raw body, configure Express JSON with a verify hook:

```js
  app.use(express.json({
    limit: JSON_BODY_LIMIT,
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }));
```

- [ ] **Step 7: Add environment examples**

Append to `.env.example`:

```bash
# WeChat Pay annual membership
WECHAT_PAY_MODE=mock
WECHAT_PAY_MCH_ID=
WECHAT_PAY_API_V3_KEY=
WECHAT_PAY_SERIAL_NO=
WECHAT_PAY_PRIVATE_KEY_PATH=
WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH=
WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID=
WECHAT_PAY_NOTIFY_URL=
```

- [ ] **Step 8: Run service and route tests, then commit**

Run:

```bash
node --test tests/wechat-pay-service.test.mjs
node --test tests/membership-routes.test.mjs
```

Expected: both PASS.

Commit:

```bash
git add server/wechat-pay.service.mjs server/routes/membership.routes.mjs server/app.mjs tests/wechat-pay-service.test.mjs tests/membership-routes.test.mjs .env.example
git commit -m "feat: add live wechat pay membership support"
```

## Task 9: Final Verification

**Files:**
- No planned source edits unless verification reveals a defect.

- [ ] **Step 1: Run backend syntax and tests**

Run:

```bash
npm run check
npm test
```

Expected: both PASS.

- [ ] **Step 2: Run frontend typecheck and build**

Run:

```bash
npm run typecheck
npm run build
```

Expected: both PASS.

- [ ] **Step 3: Check working tree**

Run:

```bash
git status --short
```

Expected: no uncommitted membership changes remain. If verification exposed a defect, fix it in the smallest relevant task area, rerun the failed command, and create a normal focused commit using the actual paths shown by `git status --short`. Do not stage unrelated pre-existing modifications.
