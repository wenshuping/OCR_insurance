import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateId, createInitialState, normalizeGuestId } from '../server/policy-ocr.domain.mjs';
import {
  createFamilySalesReviewRecord,
  resolveOwnerFields,
  shouldSkipFamilySalesReviewInput,
} from '../scripts/regenerate-family-sales-reviews.shared.mjs';

test('regenerate family sales review script creates owner-scoped active records', () => {
  const state = createInitialState();
  state.nextId = 31;
  const family = { id: 8, ownerUserId: null, ownerGuestId: 'guest-family' };
  const owner = resolveOwnerFields(family, normalizeGuestId);
  const record = createFamilySalesReviewRecord({
    state,
    family,
    owner,
    review: {
      content: '重新生成的家庭分析报告',
      model: 'test-model',
      generatedAt: '2026-06-16T00:00:00.000Z',
      inputSummary: { memberCount: 2, policyCount: 3 },
    },
    allocateId,
  });

  assert.equal(record.id, 31);
  assert.equal(state.nextId, 32);
  assert.equal(record.familyId, 8);
  assert.equal(record.ownerUserId, null);
  assert.equal(record.ownerGuestId, 'guest-family');
  assert.equal(record.status, 'active');
  assert.equal(record.inputSummary.familyId, 8);
  assert.equal(record.inputSummary.policyCount, 3);
});

test('regenerate family sales review script skips empty families', () => {
  assert.equal(shouldSkipFamilySalesReviewInput({ members: [], policies: [] }), true);
  assert.equal(shouldSkipFamilySalesReviewInput({ members: [{ id: 1 }], policies: [] }), false);
  assert.equal(shouldSkipFamilySalesReviewInput({ members: [], policies: [{ id: 1 }] }), false);
});
