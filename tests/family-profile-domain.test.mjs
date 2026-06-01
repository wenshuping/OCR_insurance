import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialState } from '../server/policy-ocr.domain.mjs';
import {
  ensureDefaultFamilyProfileForPrincipal,
  matchFamilyMemberByPerson,
  normalizeFamilyMemberInput,
  normalizeFamilyRelation,
  validatePolicyFamilyBinding,
} from '../server/family-profile.domain.mjs';

test('ensureDefaultFamilyProfileForPrincipal migrates existing policy participants into a default family', () => {
  const state = {
    ...createInitialState(),
    nextId: 10,
    policies: [
      { id: 1, userId: 8, guestId: '', applicant: '张三', insured: '李四', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: 2, userId: 8, guestId: '', applicant: '张三', insured: '王小明', createdAt: '2026-05-02T00:00:00.000Z' },
    ],
  };

  const family = ensureDefaultFamilyProfileForPrincipal(state, { userId: 8 });

  assert.equal(family.familyName, '默认家庭');
  assert.equal(state.familyProfiles.length, 1);
  assert.equal(state.familyMembers.length, 3);
  assert.equal(state.familyMembers.find((member) => member.id === family.coreMemberId)?.name, '张三');
  assert.equal(state.familyMembers.find((member) => member.name === '李四')?.relationToCore, 'pending');
  assert.equal(state.policies[0].familyId, family.id);
  assert.ok(state.policies[0].applicantMemberId);
  assert.ok(state.policies[0].insuredMemberId);
});

test('matchFamilyMemberByPerson prefers exact name and birthday matches', () => {
  const members = [
    { id: 1, familyId: 20, name: '张三', birthday: '1980-01-01', idNumberTail: '2222', status: 'active' },
    { id: 2, familyId: 20, name: '张三', birthday: '1990-01-01', idNumberTail: '3333', status: 'active' },
  ];

  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01', idNumberTail: '3333' })?.id, 2);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01' })?.id, 2);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01', idNumberTail: '9999' }), null);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1970-01-01' }), null);
});

test('validatePolicyFamilyBinding rejects participants outside the selected family', () => {
  const state = {
    ...createInitialState(),
    familyProfiles: [{ id: 1, familyName: '张三家庭', coreMemberId: 10, status: 'active' }],
    familyMembers: [
      { id: 10, familyId: 1, name: '张三', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
      { id: 20, familyId: 2, name: '李四', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
    ],
  };

  assert.throws(
    () => validatePolicyFamilyBinding(state, { familyId: 1, applicantMemberId: 10, insuredMemberId: 20 }),
    /POLICY_FAMILY_MEMBER_MISMATCH/,
  );
});

test('normalizeFamilyRelation maps common labels to stable values', () => {
  assert.deepEqual(normalizeFamilyRelation('儿子'), { relationToCore: 'son', relationLabel: '儿子', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('核心人员'), { relationToCore: 'self', relationLabel: '本人', role: 'core' });
  assert.deepEqual(normalizeFamilyRelation(''), { relationToCore: 'pending', relationLabel: '待确认', role: 'unknown' });
});

test('normalizeFamilyMemberInput applies relation normalization to member fields', () => {
  assert.deepEqual(
    normalizeFamilyMemberInput({ name: '张三', relationToCore: '核心人员' }),
    {
      name: '张三',
      birthday: '',
      idNumberTail: '',
      relationToCore: 'self',
      relationLabel: '本人',
      role: 'core',
      status: 'active',
    },
  );
});
