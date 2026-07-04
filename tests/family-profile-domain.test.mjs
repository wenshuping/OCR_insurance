import assert from 'node:assert/strict';
import test from 'node:test';

import { createInitialState } from '../server/policy-ocr.domain.mjs';
import {
  archiveFamilyMember,
  ensureDefaultFamilyProfileForPrincipal,
  matchFamilyMemberByPerson,
  normalizeFamilyMemberInput,
  normalizeFamilyRelation,
  repairDuplicateFamilyMembers,
  upsertFamilyMember,
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

test('ensureDefaultFamilyProfileForPrincipal merges same-name insured people by family name', () => {
  const state = {
    ...createInitialState(),
    nextId: 20,
    policies: [
      {
        id: 1,
        userId: 8,
        guestId: '',
        applicant: '张三',
        insured: '李四',
        insuredBirthday: '2010-01-01',
        insuredIdNumber: '110101201001010022',
      },
      {
        id: 2,
        userId: 8,
        guestId: '',
        applicant: '张三',
        insured: '李四',
        insuredBirthday: '2012-02-02',
        insuredIdNumber: '110101201202020033',
      },
    ],
  };

  const family = ensureDefaultFamilyProfileForPrincipal(state, { userId: 8 });
  const insuredMembers = state.familyMembers.filter((member) => member.name === '李四');

  assert.equal(family.familyName, '默认家庭');
  assert.equal(insuredMembers.filter((member) => member.status === 'active').length, 1);
  assert.equal(state.policies[0].insuredMemberId, state.policies[1].insuredMemberId);
  assert.equal(state.familyMembers.find((member) => member.id === state.policies[0].insuredMemberId)?.birthday, '2012-02-02');
  assert.equal(state.familyMembers.find((member) => member.id === state.policies[1].insuredMemberId)?.idNumberTail, '0033');
});

test('ensureDefaultFamilyProfileForPrincipal merges same-name applicant and insured when only one side has identity', () => {
  const state = {
    ...createInitialState(),
    nextId: 30,
    policies: [
      {
        id: 1,
        userId: 8,
        guestId: '',
        applicant: '张三',
        insured: '张三',
        insuredBirthday: '1990-01-01',
        insuredIdNumber: '110101199001010033',
      },
    ],
  };

  ensureDefaultFamilyProfileForPrincipal(state, { userId: 8 });
  const zhangMembers = state.familyMembers.filter((member) => member.name === '张三');
  const member = zhangMembers[0];

  assert.equal(zhangMembers.length, 1);
  assert.ok(state.policies[0].insuredMemberId);
  assert.equal(state.policies[0].applicantMemberId, state.policies[0].insuredMemberId);
  assert.equal(member?.birthday, '1990-01-01');
  assert.equal(member?.idNumberTail, '0033');
});

test('ensureDefaultFamilyProfileForPrincipal repairs existing duplicate members with compatible identities', () => {
  const state = {
    ...createInitialState(),
    nextId: 60,
    familyProfiles: [
      { id: 10, userId: 8, guestId: '', ownerUserId: 8, ownerGuestId: '', familyName: '默认家庭', coreMemberId: 11, status: 'active' },
    ],
    familyMembers: [
      { id: 11, familyId: 10, name: '张三', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
      { id: 12, familyId: 10, name: '张三', birthday: '1990-01-01', idNumberTail: '0033', relationToCore: 'pending', relationLabel: '待确认', role: 'unknown', status: 'active' },
      { id: 13, familyId: 10, name: '李四', relationToCore: 'pending', relationLabel: '待确认', role: 'unknown', status: 'active' },
      { id: 14, familyId: 10, name: '李四', birthday: '1988-02-02', idNumberTail: '0044', relationToCore: 'pending', relationLabel: '待确认', role: 'unknown', status: 'active' },
    ],
    policies: [
      {
        id: 1,
        userId: 8,
        guestId: '',
        familyId: 10,
        applicant: '张三',
        insured: '张三',
        applicantMemberId: 11,
        insuredMemberId: 12,
        insuredBirthday: '1990-01-01',
        insuredIdNumber: '110101199001010033',
      },
      {
        id: 2,
        userId: 8,
        guestId: '',
        familyId: 10,
        applicant: '李四',
        insured: '李四',
        applicantMemberId: 13,
        insuredMemberId: 14,
        insuredBirthday: '1988-02-02',
        insuredIdNumber: '110101198802020044',
      },
    ],
  };

  ensureDefaultFamilyProfileForPrincipal(state, { userId: 8 });
  const activeMembers = state.familyMembers.filter((member) => member.status === 'active');
  const zhang = activeMembers.find((member) => member.name === '张三');
  const li = activeMembers.find((member) => member.name === '李四');

  assert.deepEqual(activeMembers.map((member) => member.name).sort(), ['张三', '李四']);
  assert.equal(zhang?.id, 11);
  assert.equal(zhang?.birthday, '1990-01-01');
  assert.equal(li?.id, 14);
  assert.equal(state.policies[0].applicantMemberId, 11);
  assert.equal(state.policies[0].insuredMemberId, 11);
  assert.equal(state.policies[1].applicantMemberId, 14);
  assert.equal(state.policies[1].insuredMemberId, 14);
});

test('matchFamilyMemberByPerson prefers exact name and birthday matches', () => {
  const members = [
    { id: 1, familyId: 20, name: '张三', birthday: '1980-01-01', idNumberTail: '2222', status: 'active' },
    { id: 2, familyId: 20, name: '张三', birthday: '1990-01-01', idNumberTail: '3333', status: 'active' },
  ];

  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01', idNumberTail: '3333' })?.id, 2);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01' })?.id, 2);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1990-01-01', idNumberTail: '9999' })?.id, 2);
  assert.equal(matchFamilyMemberByPerson(members, { name: '张三', birthday: '1970-01-01' })?.id, 1);
});

test('upsertFamilyMember reuses same-name compatible member instead of duplicating', () => {
  const state = {
    ...createInitialState(),
    nextId: 20,
    familyProfiles: [
      { id: 10, ownerGuestId: 'guest-upsert-member', familyName: '去重家庭', coreMemberId: null, status: 'active' },
    ],
    familyMembers: [
      { id: 11, familyId: 10, name: '翟卿', relationToCore: 'pending', relationLabel: '待确认', role: 'unknown', status: 'active' },
    ],
  };

  const family = state.familyProfiles[0];
  const member = upsertFamilyMember(state, family, { name: '翟卿', relationLabel: '儿子', birthday: '2018-01-01' });

  assert.equal(member.id, 11);
  assert.equal(member.birthday, '2018-01-01');
  assert.equal(state.familyMembers.filter((row) => row.status === 'active' && row.name === '翟卿').length, 1);
});

test('upsertFamilyMember syncs same-name member identity instead of duplicating', () => {
  const state = {
    ...createInitialState(),
    nextId: 30,
    familyProfiles: [
      { id: 10, ownerGuestId: 'guest-upsert-member-conflict', familyName: '同名家庭', coreMemberId: null, status: 'active' },
    ],
    familyMembers: [
      { id: 11, familyId: 10, name: '秦国英', birthday: '1969-01-01', idNumberTail: '1111', relationToCore: 'pending', relationLabel: '待确认', role: 'unknown', status: 'active' },
    ],
  };

  const family = state.familyProfiles[0];
  const member = upsertFamilyMember(state, family, { name: '秦国英', relationLabel: '母亲', birthday: '1970-01-06', idNumber: '110101197001060022' });

  assert.equal(member.id, 11);
  assert.equal(member.birthday, '1970-01-06');
  assert.equal(member.idNumberTail, '0022');
  assert.equal(state.familyMembers.filter((row) => row.status === 'active' && row.name === '秦国英').length, 1);
});

test('repairDuplicateFamilyMembers merges compatible duplicate names and rewires policies', () => {
  const state = {
    ...createInitialState(),
    familyProfiles: [
      { id: 10, ownerGuestId: 'guest-repair-member', familyName: '旧重复家庭', coreMemberId: 11, status: 'active' },
    ],
    familyMembers: [
      { id: 11, familyId: 10, name: '翟卿', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
      { id: 12, familyId: 10, name: '翟卿', birthday: '1990-01-01', relationToCore: 'pending', relationLabel: '待确认', role: 'unknown', status: 'active' },
    ],
    policies: [
      { id: 1, familyId: 10, applicantMemberId: 11, insuredMemberId: 12 },
    ],
  };

  assert.equal(repairDuplicateFamilyMembers(state, state.familyProfiles[0]), true);

  const activeMembers = state.familyMembers.filter((member) => member.status === 'active');
  assert.equal(activeMembers.length, 1);
  assert.equal(activeMembers[0].id, 11);
  assert.equal(activeMembers[0].birthday, '1990-01-01');
  assert.equal(state.policies[0].insuredMemberId, 11);
});

test('archiveFamilyMember clears policy bindings for deleted member only', () => {
  const state = {
    ...createInitialState(),
    familyProfiles: [
      { id: 10, ownerGuestId: 'guest-delete-member', familyName: '删除成员家庭', coreMemberId: 11, status: 'active' },
    ],
    familyMembers: [
      { id: 11, familyId: 10, name: '顾晨妍', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
      { id: 12, familyId: 10, name: '翟卿', relationToCore: 'son', relationLabel: '儿子', role: 'child', status: 'active' },
    ],
    policies: [
      { id: 1, familyId: 10, applicantMemberId: 11, insuredMemberId: 12, applicantRelationLabel: '本人', insuredRelationLabel: '儿子' },
    ],
  };

  const result = archiveFamilyMember(state, state.familyProfiles[0], state.familyMembers[1]);

  assert.equal(result.clearedPolicyCount, 1);
  assert.equal(state.familyMembers[1].status, 'archived');
  assert.equal(state.policies[0].applicantMemberId, 11);
  assert.equal(state.policies[0].insuredMemberId, null);
  assert.equal(state.policies[0].insuredRelationLabel, '');
  assert.equal(state.policies[0].participantReviewStatus, 'pending_review');
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

test('validatePolicyFamilyBinding rejects family owned by another principal', () => {
  const state = {
    ...createInitialState(),
    familyProfiles: [{ id: 1, ownerUserId: null, ownerGuestId: 'guest-a', familyName: '张三家庭', coreMemberId: 10, status: 'active' }],
    familyMembers: [
      { id: 10, familyId: 1, name: '张三', relationToCore: 'self', relationLabel: '本人', role: 'core', status: 'active' },
      { id: 11, familyId: 1, name: '李四', relationToCore: 'spouse', relationLabel: '配偶', role: 'adult', status: 'active' },
    ],
  };

  assert.throws(
    () => validatePolicyFamilyBinding(state, { familyId: 1, applicantMemberId: 10, insuredMemberId: 11 }, { guestId: 'guest-b' }),
    /POLICY_FAMILY_FORBIDDEN/,
  );
});

test('normalizeFamilyRelation maps common labels to stable values', () => {
  assert.deepEqual(normalizeFamilyRelation('儿子'), { relationToCore: 'son', relationLabel: '儿子', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('丈夫'), { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' });
  assert.deepEqual(normalizeFamilyRelation('妻子'), { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' });
  assert.deepEqual(normalizeFamilyRelation('夫妻'), { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' });
  assert.deepEqual(normalizeFamilyRelation('子女'), { relationToCore: 'child', relationLabel: '子女', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('孩子'), { relationToCore: 'child', relationLabel: '子女', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('小孩'), { relationToCore: 'child', relationLabel: '子女', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('儿媳'), { relationToCore: 'daughter_in_law', relationLabel: '儿媳', role: 'adult' });
  assert.deepEqual(normalizeFamilyRelation('女婿'), { relationToCore: 'son_in_law', relationLabel: '女婿', role: 'adult' });
  assert.deepEqual(normalizeFamilyRelation('孙子'), { relationToCore: 'grandson', relationLabel: '孙子', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('孙女'), { relationToCore: 'granddaughter', relationLabel: '孙女', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('外孙'), { relationToCore: 'maternal_grandson', relationLabel: '外孙', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('外孙女'), { relationToCore: 'maternal_granddaughter', relationLabel: '外孙女', role: 'child' });
  assert.deepEqual(normalizeFamilyRelation('外公'), { relationToCore: 'maternal_grandfather', relationLabel: '外公', role: 'elder' });
  assert.deepEqual(normalizeFamilyRelation('外婆'), { relationToCore: 'maternal_grandmother', relationLabel: '外婆', role: 'elder' });
  assert.deepEqual(normalizeFamilyRelation('爷爷'), { relationToCore: 'paternal_grandfather', relationLabel: '爷爷', role: 'elder' });
  assert.deepEqual(normalizeFamilyRelation('奶奶'), { relationToCore: 'paternal_grandmother', relationLabel: '奶奶', role: 'elder' });
  assert.deepEqual(normalizeFamilyRelation('待确认'), { relationToCore: 'pending', relationLabel: '待确认', role: 'unknown' });
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
