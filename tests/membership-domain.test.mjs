import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialState } from '../server/policy-ocr.domain.mjs';
import {
  ANNUAL_MEMBERSHIP_DURATION_DAYS,
  ANNUAL_MEMBERSHIP_PRICE_CENTS,
  assertUserCanSavePolicy,
  assertUserReportRefreshAllowed,
  buildMembershipSnapshot,
  countUserReportRefreshesForDay,
  consumeWechatOAuthState,
  createMembershipOrder,
  createWechatOAuthState,
  defaultMembershipConfig,
  findUserWechatOpenid,
  markMembershipOrderPrepayCreated,
  normalizeMembershipConfig,
  processMembershipPaymentSuccess,
  recordUserReportRefresh,
  upsertUserWechatIdentity,
} from '../server/membership.domain.mjs';

const NOW = '2026-06-11T08:00:00.000Z';

test('normalizeMembershipConfig keeps price and duration fixed while accepting admin quota and enabled flag', () => {
  assert.deepEqual(normalizeMembershipConfig({
    enabled: false,
    registeredFreePolicyQuota: '5',
    familyReportDailyRefreshLimit: '7',
    familySalesReviewDailyRefreshLimit: '9',
    annualPriceCents: 1,
    annualDurationDays: 1,
  }, NOW), {
    enabled: false,
    annualPriceCents: ANNUAL_MEMBERSHIP_PRICE_CENTS,
    annualDurationDays: ANNUAL_MEMBERSHIP_DURATION_DAYS,
    registeredFreePolicyQuota: 5,
    familyReportDailyRefreshLimit: 7,
    familySalesReviewDailyRefreshLimit: 9,
    updatedAt: NOW,
  });
  assert.equal(defaultMembershipConfig(NOW).registeredFreePolicyQuota, 3);
  assert.equal(defaultMembershipConfig(NOW).familyReportDailyRefreshLimit, 3);
  assert.equal(defaultMembershipConfig(NOW).familySalesReviewDailyRefreshLimit, 3);
});

test('user report refresh counters only count explicit user refresh events for the same day', () => {
  const state = {
    ...createInitialState(),
    membershipConfig: {
      ...defaultMembershipConfig(NOW),
      familyReportDailyRefreshLimit: 1,
      familySalesReviewDailyRefreshLimit: 2,
    },
    nextId: 100,
  };
  const owner = { userId: 8 };

  assert.deepEqual(assertUserReportRefreshAllowed(state, owner, 'familyReport', { familyId: 20, now: NOW }), {
    limit: 1,
    used: 0,
    remaining: 1,
  });

  const event = recordUserReportRefresh(state, owner, 'familyReport', {
    familyId: 20,
    reportId: 30,
    now: NOW,
    allocateId: (targetState) => {
      const id = targetState.nextId;
      targetState.nextId += 1;
      return id;
    },
  });

  state.familyReports.push({
    id: 31,
    familyId: 20,
    ownerUserId: 8,
    status: 'active',
    generatedAt: NOW,
  });

  assert.equal(event.id, 100);
  assert.equal(countUserReportRefreshesForDay(state, owner, 'familyReport', { familyId: 20, now: NOW }), 1);
  assert.throws(
    () => assertUserReportRefreshAllowed(state, owner, 'familyReport', { familyId: 20, now: NOW }),
    (error) => {
      assert.equal(error.code, 'FAMILY_REPORT_DAILY_REFRESH_LIMIT_EXCEEDED');
      assert.equal(error.status, 429);
      return true;
    },
  );
  assert.equal(countUserReportRefreshesForDay(state, owner, 'familySalesReview', { familyId: 20, now: NOW }), 0);
  assert.equal(
    countUserReportRefreshesForDay(state, owner, 'familyReport', { familyId: 20, now: '2026-06-12T08:00:00.000Z' }),
    0,
  );
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

test('processMembershipPaymentSuccess rejects orders before prepay is created', () => {
  const state = { ...createInitialState() };
  const order = createMembershipOrder(state, { userId: 8, now: NOW, randomBytes: Buffer.from('0011223344556677', 'hex') });

  assert.throws(
    () => processMembershipPaymentSuccess(state, {
      outTradeNo: order.outTradeNo,
      transactionId: '4200001',
      amountCents: 30000,
      paidAt: NOW,
    }),
    (error) => {
      assert.equal(error.code, 'ORDER_NOT_PAYABLE');
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(order.status, 'created');
  assert.equal(state.memberships.length, 0);
});

test('createMembershipOrder uses a compact WeChat Pay-safe outTradeNo', () => {
  const state = { ...createInitialState(), nextId: 123456789 };
  const order = createMembershipOrder(state, {
    userId: 987654321,
    now: NOW,
    randomBytes: Buffer.from('0011223344556677', 'hex'),
  });

  assert.ok(order.outTradeNo.length <= 32);
  assert.match(order.outTradeNo, /^[A-Za-z0-9_-]+$/);
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

test('processMembershipPaymentSuccess renews expired membership in place', () => {
  const state = {
    ...createInitialState(),
    memberships: [{
      userId: 8,
      plan: 'annual',
      status: 'active',
      startedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:00:00.000Z',
      lastOrderId: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  };
  const order = createMembershipOrder(state, { userId: 8, now: NOW, randomBytes: Buffer.from('0123456789abcdef', 'hex') });
  markMembershipOrderPrepayCreated(state, order.outTradeNo, { prepayId: 'wx-prepay', now: NOW });

  processMembershipPaymentSuccess(state, {
    outTradeNo: order.outTradeNo,
    transactionId: '4200003',
    amountCents: 30000,
    paidAt: NOW,
  });

  assert.equal(state.memberships.length, 1);
  assert.equal(state.memberships[0].startedAt, NOW);
  assert.equal(state.memberships[0].expiresAt, '2027-06-11T08:00:00.000Z');
  assert.equal(state.memberships[0].lastOrderId, order.id);
});

test('markMembershipOrderPrepayCreated does not downgrade paid orders', () => {
  const state = { ...createInitialState() };
  const order = createMembershipOrder(state, { userId: 8, now: NOW, randomBytes: Buffer.from('fedcba9876543210', 'hex') });
  markMembershipOrderPrepayCreated(state, order.outTradeNo, { prepayId: 'wx-prepay', now: NOW });
  processMembershipPaymentSuccess(state, {
    outTradeNo: order.outTradeNo,
    transactionId: '4200004',
    amountCents: 30000,
    paidAt: NOW,
  });

  markMembershipOrderPrepayCreated(state, order.outTradeNo, {
    prepayId: 'wx-prepay-new',
    now: '2026-06-11T08:10:00.000Z',
  });
  const duplicate = processMembershipPaymentSuccess(state, {
    outTradeNo: order.outTradeNo,
    transactionId: '4200004',
    amountCents: 30000,
    paidAt: '2026-06-11T08:11:00.000Z',
  });

  assert.equal(order.status, 'paid');
  assert.equal(order.prepayId, 'wx-prepay');
  assert.equal(order.transactionId, '4200004');
  assert.equal(duplicate.applied, false);
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

test('createWechatOAuthState rejects off-site redirect URLs', () => {
  const state = { ...createInitialState() };

  for (const redirectUrl of ['https://evil.test', '//evil.test']) {
    assert.throws(
      () => createWechatOAuthState(state, {
        userId: 8,
        appId: 'wx123',
        redirectUrl,
        now: NOW,
        randomBytes: Buffer.from('00112233445566778899aabbccddeeff', 'hex'),
      }),
      (error) => {
        assert.equal(error.code, 'WECHAT_OAUTH_REDIRECT_URL_INVALID');
        assert.equal(error.status, 400);
        return true;
      },
    );
  }
  assert.equal(state.wechatOAuthStates.length, 0);
});
