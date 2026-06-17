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
  assert.match(source, /读取会员状态/);
});

test('customer app handles membership required errors and invokes WeixinJSBridge only through purchase flow', () => {
  const source = read('src/apps/customer/CustomerApp.tsx');
  assert.match(source, /MEMBERSHIP_REQUIRED/);
  assert.match(source, /setShowMembershipDialog\(true\)/);
  assert.match(source, /membershipStatusRequestRef/);
  assert.match(source, /createMembershipOrder/);
  assert.match(source, /getBrandWCPayRequest/);
  assert.match(source, /confirmMockMembershipOrder/);
  assert.match(source, /membershipPurchaseErrorMessage/);
  assert.match(source, /WECHAT_PAY_NOT_CONFIGURED[\s\S]*会员支付暂未开放/);
  assert.match(source, /setMembershipMessage\(membershipPurchaseErrorMessage\(error\)\)/);
  assert.match(source, /showFamilyReport[\s\S]*membershipDialog/);
  assert.match(source, /cashflowMember[\s\S]*membershipDialog/);
});

test('membership purchase dialog disables unavailable purchase states', () => {
  const source = read('src/features/customer-membership/MembershipPurchaseDialog.tsx');
  assert.match(source, /purchase\.enabled/);
  assert.match(source, /会员购买暂未开放/);
  assert.match(source, /purchaseDisabled/);
});

test('admin app exposes membership settings controls', () => {
  const appSource = read('src/apps/admin/AdminApp.tsx');
  const pageSource = read('src/apps/admin/pages/AdminMembershipPage.tsx');
  assert.match(appSource, /getAdminMembershipConfig/);
  assert.match(appSource, /updateAdminMembershipConfig/);
  assert.match(appSource, /AdminMembershipPage/);
  assert.match(pageSource, /会员与报告刷新设置/);
  assert.match(pageSource, /注册用户免费保存保单数/);
  assert.match(pageSource, /家庭保单分析报告每日刷新次数/);
  assert.match(pageSource, /营销建议报告每日刷新次数/);
  assert.match(pageSource, /只统计用户在前台主动点击重新生成/);
  assert.match(appSource, /免费保存保单数请输入非负整数/);
  assert.match(appSource, /familyReportDailyRefreshLimitInput/);
  assert.match(appSource, /familySalesReviewDailyRefreshLimitInput/);
  assert.match(appSource, /家庭保单分析报告每日刷新次数请输入非负整数/);
  assert.match(appSource, /营销建议报告每日刷新次数请输入非负整数/);
  assert.match(appSource, /clearAdminAuthState/);
});

test('customer report refresh requests mark only explicit user refresh actions', () => {
  const source = read('src/apps/customer/CustomerApp.tsx');
  const familyApiSource = read('src/api/contracts/family.ts');
  assert.match(source, /regenerateFamilyReportRecord\(\{[\s\S]*userRefresh: true/);
  assert.match(source, /createFamilySalesReview\(\{[\s\S]*familyId: familySalesReviewFamilyId,[\s\S]*userRefresh: true/);
  assert.match(familyApiSource, /userRefresh\?: boolean/);
  assert.match(familyApiSource, /userRefresh: input\.userRefresh === true/);
});
