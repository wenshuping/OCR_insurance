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
