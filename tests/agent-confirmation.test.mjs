import assert from 'node:assert/strict';
import test from 'node:test';

import { createAgentConfirmationService } from '../server/agent-confirmation.service.mjs';

const NOW = '2026-07-12T04:00:00.000Z';

function state(overrides = {}) {
  return {
    stateVersion: 9,
    familyProfiles: [
      { id: 10, ownerUserId: 7, familyName: '张三家庭', status: 'active' },
      { id: 20, ownerUserId: 7, familyName: '李四家庭', status: 'active' },
    ],
    familyMembers: [
      { id: 101, familyId: 10, name: '张三', status: 'active' },
      { id: 201, familyId: 20, name: '李四', status: 'active' },
    ],
    policies: [{ id: 301, familyId: 10, policyNo: 'SECRET-12345678', name: '守护一生', applicantMemberId: 201, insuredMemberId: 201, sourceEvidence: { page: 3 } }],
    familyReports: [], familySalesReviews: [], familyReportShares: [],
    ...overrides,
  };
}

function harness(initial = state()) {
  let current = initial;
  const confirmations = new Map();
  const calls = { created: [], transferred: [], enqueued: [] };
  const store = {
    async createAgentActionConfirmation(input) {
      confirmations.set(input.id, { ...input, status: 'pending' });
      calls.created.push(input);
      return { ...input, status: 'pending' };
    },
    async transferPolicyBetweenFamilies(input) {
      calls.transferred.push(input);
      const confirmation = confirmations.get(input.confirmationId);
      if (!confirmation || confirmation.userId !== input.userId) return { status: 'not_found' };
      if (confirmation.status !== 'pending') return { status: 'already_consumed' };
      if (confirmation.expiresAt <= input.consumedAt) return { status: 'expired' };
      if (Number(current.stateVersion) !== Number(confirmation.payload.stateVersion)) return { status: 'state_changed' };
      confirmation.status = 'consumed';
      return { status: 'transferred', sourceFamilyId: 10, targetFamilyId: 20, policyId: 301 };
    },
  };
  const service = createAgentConfirmationService({
    store,
    loadState: async () => current,
    now: () => NOW,
    randomUUID: () => 'confirmation-1',
    reportQueue: { async enqueueUnique(job) { calls.enqueued.push(job); } },
  });
  return { service, store, calls, confirmations, setState(value) { current = value; } };
}

test('unique transfer preview creates a short lived, internal-only confirmation and redacted display', async () => {
  const h = harness();
  const result = await h.service.previewPolicyTransfer({
    userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: 'SECRET-12345678',
    targetApplicantMemberId: 201, targetInsuredMemberId: 201,
  });
  assert.equal(result.interaction.type, 'confirmation');
  assert.equal(result.confirmationId, 'confirmation-1');
  assert.match(result.interaction.text, /5678/);
  assert.doesNotMatch(JSON.stringify(result), /SECRET-12345678|张三/);
  assert.deepEqual(Object.keys(h.calls.created[0].payload).sort(), ['impact', 'policyId', 'sourceFamilyId', 'stateHash', 'stateVersion', 'targetApplicantMemberId', 'targetFamilyId', 'targetInsuredMemberId']);
  assert.equal(Date.parse(h.calls.created[0].expiresAt) - Date.parse(NOW), 5 * 60_000);
});

test('ambiguous policy and fuzzy family matches clarify without creating confirmation', async () => {
  const ambiguous = harness(state({ policies: [
    { id: 1, familyId: 10, name: '守护一生A', policyNo: 'A-1111', applicantMemberId: 201, insuredMemberId: 201 },
    { id: 2, familyId: 10, name: '守护一生B', policyNo: 'B-2222', applicantMemberId: 201, insuredMemberId: 201 },
  ] }));
  const policy = await ambiguous.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: '守护一生', targetMemberId: 201 });
  assert.equal(policy.interaction.type, 'clarification');
  const family = await ambiguous.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三', targetFamilyName: '李四家庭', policyHint: 'A-1111', targetMemberId: 201 });
  assert.equal(family.interaction.type, 'clarification');
  assert.equal(ambiguous.calls.created.length, 0);
});

test('preview refuses missing member links, unauthorized targets, duplicate target policies and in-flight policy state', async () => {
  const missing = harness(state({ policies: [{ id: 301, familyId: 10, policyNo: 'P-1' }] }));
  assert.equal((await missing.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: 'P-1' })).code, 'requires_web_member_link');

  const denied = harness(state({ familyProfiles: [{ id: 10, ownerUserId: 7, familyName: '张三家庭' }, { id: 20, ownerUserId: 8, familyName: '李四家庭' }] }));
  assert.equal((await denied.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: 'SECRET-12345678', targetMemberId: 201 })).interaction.type, 'clarification');

  const duplicate = harness(state({ policies: [state().policies[0], { id: 302, familyId: 20, policyNo: 'SECRET-12345678' }] }));
  assert.equal((await duplicate.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: 'SECRET-12345678', targetMemberId: 201 })).code, 'duplicate_policy');

  const busy = harness(state({ policies: [{ ...state().policies[0], transferStatus: 'processing' }] }));
  assert.equal((await busy.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: 'SECRET-12345678', targetMemberId: 201 })).code, 'policy_busy');
});

test('confirm delegates atomic consume/recheck, handles drift and enqueues both reports for both families only after success', async () => {
  const h = harness();
  await h.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: 'SECRET-12345678', targetMemberId: 201 });
  h.setState({ ...state(), stateVersion: 10 });
  const drift = await h.service.confirm({ userId: 7, confirmationId: 'confirmation-1' });
  assert.equal(drift.code, 'state_changed');
  assert.equal(h.calls.enqueued.length, 0);

  const success = harness();
  await success.service.previewPolicyTransfer({ userId: 7, sourceFamilyName: '张三家庭', targetFamilyName: '李四家庭', policyHint: 'SECRET-12345678', targetMemberId: 201 });
  const result = await success.service.confirm({ internalUserId: 7, confirmationId: 'confirmation-1' });
  assert.equal(result.status, 'transferred');
  assert.deepEqual(success.calls.enqueued.map((row) => [row.familyId, row.type]), [[10, 'family_report'], [10, 'family_sales_review'], [20, 'family_report'], [20, 'family_sales_review']]);
  assert.equal((await success.service.confirm({ userId: 7, confirmationId: 'confirmation-1' })).status, 'already_consumed');
  assert.equal(success.calls.enqueued.length, 4);
  await assert.rejects(success.service.confirm({ userId: 8, confirmationId: 'confirmation-1' }), { status: 404, code: 'AGENT_CONFIRMATION_NOT_OWNED' });
});
