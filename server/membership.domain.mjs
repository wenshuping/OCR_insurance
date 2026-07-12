import crypto from 'node:crypto';

import { allocateId } from './policy-ocr.domain.mjs';

export const ANNUAL_MEMBERSHIP_PRICE_CENTS = 30000;
export const ANNUAL_MEMBERSHIP_DURATION_DAYS = 365;
export const DEFAULT_REGISTERED_FREE_POLICY_QUOTA = 3;
export const DEFAULT_FAMILY_REPORT_DAILY_REFRESH_LIMIT = 3;
export const DEFAULT_FAMILY_SALES_REVIEW_DAILY_REFRESH_LIMIT = 3;
export const MEMBERSHIP_PRODUCT_CODE = 'annual_membership';
const REPORT_REFRESH_TIME_ZONE = 'Asia/Shanghai';

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

function toBase36(value) {
  const number = Math.max(0, Math.floor(Number(value) || 0));
  return number.toString(36);
}

function buildOutTradeNo({ userId, orderId, now, random }) {
  return `m${toBase36(userId)}${toBase36(orderId)}${toBase36(Date.parse(now))}${random}`.slice(0, 32);
}

function assertSameSiteRedirectUrl(value) {
  const redirectUrl = trim(value || '/');
  if (!redirectUrl.startsWith('/') || redirectUrl.startsWith('//')) {
    const error = new Error('WECHAT_OAUTH_REDIRECT_URL_INVALID');
    error.code = 'WECHAT_OAUTH_REDIRECT_URL_INVALID';
    error.status = 400;
    throw error;
  }
  return redirectUrl;
}

function ensureMembershipArrays(state) {
  if (!state.membershipConfig) state.membershipConfig = defaultMembershipConfig(nowIso());
  if (!Array.isArray(state.reportRefreshEvents)) state.reportRefreshEvents = [];
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
    familyReportDailyRefreshLimit: DEFAULT_FAMILY_REPORT_DAILY_REFRESH_LIMIT,
    familySalesReviewDailyRefreshLimit: DEFAULT_FAMILY_SALES_REVIEW_DAILY_REFRESH_LIMIT,
    updatedAt,
  };
}

function normalizeNonNegativeInteger(value, fallback) {
  const number = Math.max(0, Math.floor(Number(value ?? fallback)));
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeMembershipConfig(input = {}, updatedAt = nowIso()) {
  return {
    enabled: input.enabled !== false,
    annualPriceCents: ANNUAL_MEMBERSHIP_PRICE_CENTS,
    annualDurationDays: ANNUAL_MEMBERSHIP_DURATION_DAYS,
    registeredFreePolicyQuota: normalizeNonNegativeInteger(input.registeredFreePolicyQuota, DEFAULT_REGISTERED_FREE_POLICY_QUOTA),
    familyReportDailyRefreshLimit: normalizeNonNegativeInteger(input.familyReportDailyRefreshLimit, DEFAULT_FAMILY_REPORT_DAILY_REFRESH_LIMIT),
    familySalesReviewDailyRefreshLimit: normalizeNonNegativeInteger(input.familySalesReviewDailyRefreshLimit, DEFAULT_FAMILY_SALES_REVIEW_DAILY_REFRESH_LIMIT),
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

function membershipsForUser(state, userId) {
  const id = Number(userId || 0);
  return (state.memberships || []).filter((membership) => Number(membership.userId || 0) === id);
}

function membershipForUser(state, userId) {
  return membershipsForUser(state, userId)[0] || null;
}

function membershipIsActive(membership, now) {
  if (!membership) return false;
  const nowTime = new Date(now).getTime();
  return (
    membership.status === 'active' &&
    new Date(membership.expiresAt || 0).getTime() > nowTime
  );
}

export function activeMembershipForUser(state, userId, { now = nowIso() } = {}) {
  return membershipsForUser(state, userId).find((membership) => membershipIsActive(membership, now)) || null;
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

function ownerMatchesRecord(record = {}, owner = {}) {
  if (owner.userId) return Number(record.ownerUserId || 0) === Number(owner.userId);
  if (owner.guestId) return trim(record.ownerGuestId) === trim(owner.guestId) && !Number(record.ownerUserId || 0);
  return false;
}

function reportRefreshDayKey(value) {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: REPORT_REFRESH_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function reportRefreshLimitForKind(config, kind) {
  return kind === 'familySalesReview'
    ? config.familySalesReviewDailyRefreshLimit
    : config.familyReportDailyRefreshLimit;
}

function reportRefreshLabel(kind) {
  return kind === 'familySalesReview' ? '营销建议报告' : '家庭保单分析报告';
}

export function countUserReportRefreshesForDay(state, owner, kind, { familyId, now = nowIso() } = {}) {
  const dayKey = reportRefreshDayKey(now);
  const targetFamilyId = Number(familyId || 0);
  if (!dayKey || !targetFamilyId) return 0;
  ensureMembershipArrays(state);
  return state.reportRefreshEvents.filter((event) => (
    String(event?.kind || '') === kind &&
    Number(event.familyId || 0) === targetFamilyId &&
    ownerMatchesRecord(event, owner) &&
    reportRefreshDayKey(event.createdAt) === dayKey
  )).length;
}

export function assertUserReportRefreshAllowed(state, owner, kind, { familyId, now = nowIso() } = {}) {
  const config = getMembershipConfig(state, now);
  const limit = reportRefreshLimitForKind(config, kind);
  const used = countUserReportRefreshesForDay(state, owner, kind, { familyId, now });
  if (used < limit) return { limit, used, remaining: Math.max(0, limit - used) };
  const label = reportRefreshLabel(kind);
  const error = new Error(`今日${label}刷新次数已用完（${used}/${limit}），请明天再试`);
  error.code = kind === 'familySalesReview'
    ? 'FAMILY_SALES_REVIEW_DAILY_REFRESH_LIMIT_EXCEEDED'
    : 'FAMILY_REPORT_DAILY_REFRESH_LIMIT_EXCEEDED';
  error.status = 429;
  throw error;
}

export function recordUserReportRefresh(state, owner, kind, { familyId, reportId, now = nowIso(), allocateId } = {}) {
  ensureMembershipArrays(state);
  const ownerUserId = Number(owner?.userId || owner?.ownerUserId || 0) || null;
  const event = {
    id: typeof allocateId === 'function' ? allocateId(state) : Date.now(),
    kind,
    familyId: Number(familyId || 0),
    reportId: Number(reportId || 0) || null,
    ownerUserId,
    ownerGuestId: ownerUserId ? '' : trim(owner?.guestId || owner?.ownerGuestId),
    createdAt: now,
  };
  state.reportRefreshEvents.push(event);
  return event;
}

export function createMembershipOrder(state, { userId, now = nowIso(), randomBytes } = {}) {
  ensureMembershipArrays(state);
  const bytes = randomBytes || crypto.randomBytes(8);
  const random = (Buffer.isBuffer(bytes) ? bytes.toString('hex') : randomHex(8)).slice(0, 8);
  const id = allocateId(state);
  const outTradeNo = buildOutTradeNo({ userId, orderId: id, now, random });
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
  if (order.status === 'paid') return order;
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
  if (!['prepay_created', 'paid'].includes(order.status)) {
    const error = new Error('ORDER_NOT_PAYABLE');
    error.code = 'ORDER_NOT_PAYABLE';
    error.status = 400;
    throw error;
  }
  order.payload = { ...(order.payload || {}), notify: notifyPayload };
  if (order.status === 'paid') {
    order.updatedAt = paidAt;
    return { applied: false, order, membership: activeMembershipForUser(state, order.userId, { now: paidAt }) || membershipForUser(state, order.userId) };
  }
  const active = activeMembershipForUser(state, order.userId, { now: paidAt });
  const current = active || membershipForUser(state, order.userId);
  const currentActive = membershipIsActive(current, paidAt);
  const base = currentActive ? current.expiresAt : paidAt;
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
  membership.userId = order.userId;
  membership.plan = 'annual';
  membership.status = 'active';
  if (!currentActive) membership.startedAt = paidAt;
  membership.expiresAt = expiresAt;
  membership.lastOrderId = order.id;
  membership.updatedAt = paidAt;
  if (!current) state.memberships.push(membership);
  state.memberships = state.memberships.filter((item) => (
    item === membership || Number(item.userId || 0) !== Number(order.userId || 0)
  ));
  order.status = 'paid';
  order.transactionId = trim(transactionId);
  order.paidAt = paidAt;
  order.updatedAt = paidAt;
  return { applied: true, order, membership };
}

export function createWechatOAuthState(state, { userId, appId, redirectUrl, now = nowIso(), randomBytes } = {}) {
  const safeRedirectUrl = assertSameSiteRedirectUrl(redirectUrl);
  ensureMembershipArrays(state);
  const bytes = randomBytes || crypto.randomBytes(16);
  const stateToken = Buffer.isBuffer(bytes) ? bytes.toString('hex') : randomHex(16);
  const row = {
    state: stateToken,
    userId: Number(userId),
    appId: trim(appId),
    redirectUrl: safeRedirectUrl,
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
