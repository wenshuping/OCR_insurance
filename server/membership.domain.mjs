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
