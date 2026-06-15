import {
  allocateId,
  normalizeDateOnly,
  normalizeGuestId,
  normalizeIdNumber,
} from './policy-ocr.domain.mjs';

const DEFAULT_FAMILY_NAME = '默认家庭';

const RELATION_MAP = new Map([
  ['self', { relationToCore: 'self', relationLabel: '本人', role: 'core' }],
  ['本人', { relationToCore: 'self', relationLabel: '本人', role: 'core' }],
  ['核心人员', { relationToCore: 'self', relationLabel: '本人', role: 'core' }],
  ['spouse', { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' }],
  ['配偶', { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' }],
  ['丈夫', { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' }],
  ['妻子', { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' }],
  ['夫妻', { relationToCore: 'spouse', relationLabel: '配偶', role: 'adult' }],
  ['child', { relationToCore: 'child', relationLabel: '子女', role: 'child' }],
  ['子女', { relationToCore: 'child', relationLabel: '子女', role: 'child' }],
  ['孩子', { relationToCore: 'child', relationLabel: '子女', role: 'child' }],
  ['小孩', { relationToCore: 'child', relationLabel: '子女', role: 'child' }],
  ['son', { relationToCore: 'son', relationLabel: '儿子', role: 'child' }],
  ['儿子', { relationToCore: 'son', relationLabel: '儿子', role: 'child' }],
  ['daughter', { relationToCore: 'daughter', relationLabel: '女儿', role: 'child' }],
  ['女儿', { relationToCore: 'daughter', relationLabel: '女儿', role: 'child' }],
  ['daughter_in_law', { relationToCore: 'daughter_in_law', relationLabel: '儿媳', role: 'adult' }],
  ['儿媳', { relationToCore: 'daughter_in_law', relationLabel: '儿媳', role: 'adult' }],
  ['son_in_law', { relationToCore: 'son_in_law', relationLabel: '女婿', role: 'adult' }],
  ['女婿', { relationToCore: 'son_in_law', relationLabel: '女婿', role: 'adult' }],
  ['grandson', { relationToCore: 'grandson', relationLabel: '孙子', role: 'child' }],
  ['孙子', { relationToCore: 'grandson', relationLabel: '孙子', role: 'child' }],
  ['granddaughter', { relationToCore: 'granddaughter', relationLabel: '孙女', role: 'child' }],
  ['孙女', { relationToCore: 'granddaughter', relationLabel: '孙女', role: 'child' }],
  ['maternal_grandson', { relationToCore: 'maternal_grandson', relationLabel: '外孙', role: 'child' }],
  ['外孙', { relationToCore: 'maternal_grandson', relationLabel: '外孙', role: 'child' }],
  ['maternal_granddaughter', { relationToCore: 'maternal_granddaughter', relationLabel: '外孙女', role: 'child' }],
  ['外孙女', { relationToCore: 'maternal_granddaughter', relationLabel: '外孙女', role: 'child' }],
  ['father', { relationToCore: 'father', relationLabel: '父亲', role: 'elder' }],
  ['父亲', { relationToCore: 'father', relationLabel: '父亲', role: 'elder' }],
  ['爸爸', { relationToCore: 'father', relationLabel: '父亲', role: 'elder' }],
  ['mother', { relationToCore: 'mother', relationLabel: '母亲', role: 'elder' }],
  ['母亲', { relationToCore: 'mother', relationLabel: '母亲', role: 'elder' }],
  ['妈妈', { relationToCore: 'mother', relationLabel: '母亲', role: 'elder' }],
  ['maternal_grandfather', { relationToCore: 'maternal_grandfather', relationLabel: '外公', role: 'elder' }],
  ['外公', { relationToCore: 'maternal_grandfather', relationLabel: '外公', role: 'elder' }],
  ['maternal_grandmother', { relationToCore: 'maternal_grandmother', relationLabel: '外婆', role: 'elder' }],
  ['外婆', { relationToCore: 'maternal_grandmother', relationLabel: '外婆', role: 'elder' }],
  ['paternal_grandfather', { relationToCore: 'paternal_grandfather', relationLabel: '爷爷', role: 'elder' }],
  ['爷爷', { relationToCore: 'paternal_grandfather', relationLabel: '爷爷', role: 'elder' }],
  ['paternal_grandmother', { relationToCore: 'paternal_grandmother', relationLabel: '奶奶', role: 'elder' }],
  ['奶奶', { relationToCore: 'paternal_grandmother', relationLabel: '奶奶', role: 'elder' }],
  ['parent', { relationToCore: 'parent', relationLabel: '父母', role: 'elder' }],
  ['父母', { relationToCore: 'parent', relationLabel: '父母', role: 'elder' }],
  ['长辈', { relationToCore: 'parent', relationLabel: '父母', role: 'elder' }],
  ['other', { relationToCore: 'other', relationLabel: '其他', role: 'unknown' }],
  ['其他', { relationToCore: 'other', relationLabel: '其他', role: 'unknown' }],
  ['pending', { relationToCore: 'pending', relationLabel: '待确认', role: 'unknown' }],
  ['待确认', { relationToCore: 'pending', relationLabel: '待确认', role: 'unknown' }],
]);

function ensureFamilyState(state) {
  state.familyProfiles = Array.isArray(state.familyProfiles) ? state.familyProfiles : [];
  state.familyMembers = Array.isArray(state.familyMembers) ? state.familyMembers : [];
  state.familyReportShares = Array.isArray(state.familyReportShares) ? state.familyReportShares : [];
  state.familySalesReviews = Array.isArray(state.familySalesReviews) ? state.familySalesReviews : [];
}

function normalizeOwner(owner = {}) {
  owner ||= {};
  const userId = Number(owner.userId || owner.ownerUserId || 0) || 0;
  const guestId = normalizeGuestId(owner.guestId || owner.ownerGuestId);
  return {
    ownerUserId: userId || null,
    ownerGuestId: userId ? '' : guestId,
  };
}

function hasOwnerPrincipal(owner) {
  const normalizedOwner = normalizeOwner(owner);
  return Boolean(normalizedOwner.ownerUserId || normalizedOwner.ownerGuestId);
}

function normalizeName(value) {
  return String(value || '').trim();
}

function normalizeIdNumberTail(value) {
  const direct = String(value || '').trim();
  if (!direct) return '';
  const idNumber = normalizeIdNumber(direct);
  return (idNumber || direct).slice(-4).toUpperCase();
}

function policyOwnerMatches(policy, owner = {}) {
  const normalizedOwner = normalizeOwner(owner);
  if (normalizedOwner.ownerUserId) {
    return Number(policy?.userId || 0) === normalizedOwner.ownerUserId;
  }
  if (normalizedOwner.ownerGuestId) {
    return normalizeGuestId(policy?.guestId) === normalizedOwner.ownerGuestId;
  }
  return false;
}

function policyPerson(policy, role) {
  const prefix = role === 'applicant' ? 'applicant' : 'insured';
  const name = normalizeName(policy?.[prefix]);
  const idNumber = normalizeIdNumber(
    policy?.[`${prefix}IdNumber`] ||
      policy?.[`${prefix}IdentityNumber`] ||
      policy?.[`${prefix}IdCard`],
  );
  const birthday = normalizeDateOnly(policy?.[`${prefix}Birthday`] || policy?.[`${prefix}BirthDate`]);
  return {
    name,
    birthday,
    idNumberTail: idNumber ? idNumber.slice(-4) : '',
  };
}

function familyBindingError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  error.status = 400;
  return error;
}

function personIdentityParts(person) {
  return {
    birthday: normalizeDateOnly(person?.birthday || person?.birthDate),
    idNumberTail: normalizeIdNumberTail(person?.idNumberTail || person?.idNumber || person?.identityNumber || person?.idCard),
  };
}

function hasPersonIdentity(person) {
  const identity = personIdentityParts(person);
  return Boolean(identity.birthday || identity.idNumberTail);
}

function peopleAreCompatible(left, right) {
  if (normalizeName(left?.name) !== normalizeName(right?.name)) return false;
  const leftIdentity = personIdentityParts(left);
  const rightIdentity = personIdentityParts(right);
  if (leftIdentity.birthday && rightIdentity.birthday && leftIdentity.birthday !== rightIdentity.birthday) return false;
  if (leftIdentity.idNumberTail && rightIdentity.idNumberTail && leftIdentity.idNumberTail !== rightIdentity.idNumberTail) return false;
  return true;
}

export function enrichFamilyMemberIdentity(member, person = {}) {
  if (!member) return false;
  const identity = personIdentityParts(person);
  let changed = false;
  if (!normalizeDateOnly(member.birthday) && identity.birthday) {
    member.birthday = identity.birthday;
    changed = true;
  }
  if (!normalizeIdNumberTail(member.idNumberTail) && identity.idNumberTail) {
    member.idNumberTail = identity.idNumberTail;
    changed = true;
  }
  if (changed) member.updatedAt = new Date().toISOString();
  return changed;
}

function familyMemberIdentityScore(member) {
  const identity = personIdentityParts(member);
  return (identity.birthday ? 1 : 0) + (identity.idNumberTail ? 1 : 0);
}

function chooseMergedFamilyMember(family, members) {
  return [...members].sort((left, right) => (
    (Number(right.id) === Number(family.coreMemberId || 0) ? 1 : 0) -
      (Number(left.id) === Number(family.coreMemberId || 0) ? 1 : 0) ||
    familyMemberIdentityScore(right) - familyMemberIdentityScore(left) ||
    Number(left.id || 0) - Number(right.id || 0)
  ))[0] || null;
}

function repairDuplicateFamilyMembers(state, family) {
  const activeMembers = listFamilyMembers(state, family.id);
  const membersByName = new Map();
  for (const member of activeMembers) {
    const name = normalizeName(member?.name);
    if (!name) continue;
    membersByName.set(name, [...(membersByName.get(name) || []), member]);
  }

  let changed = false;
  const now = new Date().toISOString();
  for (const members of membersByName.values()) {
    if (members.length <= 1) continue;
    const identityMembers = members.filter(hasPersonIdentity);
    const emptyIdentityMembers = members.filter((member) => !hasPersonIdentity(member));
    const groups = [];

    for (const member of identityMembers) {
      const group = groups.find((items) => items.every((item) => peopleAreCompatible(item, member)));
      if (group) group.push(member);
      else groups.push([member]);
    }
    if (!groups.length && emptyIdentityMembers.length > 1) groups.push([...emptyIdentityMembers]);
    if (groups.length === 1 && emptyIdentityMembers.length) groups[0].push(...emptyIdentityMembers);

    for (const group of groups) {
      if (group.length <= 1) continue;
      const keeper = chooseMergedFamilyMember(family, group);
      if (!keeper) continue;
      for (const member of group) {
        enrichFamilyMemberIdentity(keeper, member);
      }
      for (const member of group) {
        if (Number(member.id) === Number(keeper.id)) continue;
        member.status = 'archived';
        member.updatedAt = now;
        for (const policy of state.policies || []) {
          if (Number(policy?.familyId || 0) !== Number(family.id)) continue;
          if (Number(policy.applicantMemberId || 0) === Number(member.id)) policy.applicantMemberId = keeper.id;
          if (Number(policy.insuredMemberId || 0) === Number(member.id)) policy.insuredMemberId = keeper.id;
        }
        changed = true;
      }
      if (group.some((member) => Number(member.id) === Number(family.coreMemberId || 0))) {
        family.coreMemberId = keeper.id;
        changed = true;
      }
    }
  }

  if (changed) family.updatedAt = now;
  return changed;
}

function personIdentityKey(person, index) {
  const name = normalizeName(person?.name);
  if (!name) return '';
  const identity = personIdentityParts(person);
  if (!identity.birthday && !identity.idNumberTail) return name;
  return [name, identity.birthday, identity.idNumberTail, index].join('\u001f');
}

export function normalizeFamilyRelation(value) {
  const text = String(value || '').trim();
  const fallback = text ? RELATION_MAP.get('其他') : {
    relationToCore: 'pending',
    relationLabel: '待确认',
    role: 'unknown',
  };
  return { ...(RELATION_MAP.get(text) || fallback) };
}

export function normalizeFamilyName(value) {
  return String(value || '').trim() || DEFAULT_FAMILY_NAME;
}

export function normalizeFamilyMemberInput(input = {}) {
  const relation = normalizeFamilyRelation(input.relationToCore || input.relationLabel || input.relation);
  const idNumber = normalizeIdNumber(input.idNumber || input.identityNumber || input.idCard);
  return {
    name: normalizeName(input.name),
    birthday: normalizeDateOnly(input.birthday || input.birthDate),
    idNumberTail: normalizeIdNumberTail(input.idNumberTail || idNumber),
    relationToCore: relation.relationToCore,
    relationLabel: relation.relationLabel,
    role: relation.role,
    status: String(input.status || 'active').trim() || 'active',
  };
}

function applyFamilyMemberRelation(member, relationLabel, now = new Date().toISOString()) {
  const relation = normalizeFamilyRelation(relationLabel);
  member.relationToCore = relation.relationToCore;
  member.relationLabel = relation.relationLabel;
  member.role = relation.role;
  member.updatedAt = now;
  return member;
}

export function updateFamilyMemberRelation(member, relationLabel) {
  return applyFamilyMemberRelation(member, relationLabel);
}

export function createFamilyProfile(state, input = {}, owner = {}) {
  ensureFamilyState(state);
  const normalizedOwner = normalizeOwner(owner);
  const now = new Date().toISOString();
  const family = {
    id: allocateId(state),
    ownerUserId: normalizedOwner.ownerUserId,
    ownerGuestId: normalizedOwner.ownerGuestId,
    familyName: normalizeFamilyName(input.familyName || input.name),
    coreMemberId: Number(input.coreMemberId || 0) || null,
    status: String(input.status || 'active').trim() || 'active',
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
  state.familyProfiles.push(family);
  return family;
}

export function updateFamilyProfileName(family, input = {}) {
  if (!family) throw familyBindingError('FAMILY_NOT_FOUND', '家庭档案不存在');
  family.familyName = normalizeFamilyName(input.familyName || input.name);
  family.updatedAt = new Date().toISOString();
  return family;
}

export function createFamilyMember(state, familyId, input = {}) {
  ensureFamilyState(state);
  const memberInput = normalizeFamilyMemberInput(input);
  if (!memberInput.name) {
    const error = new Error('FAMILY_MEMBER_NAME_REQUIRED');
    error.code = 'FAMILY_MEMBER_NAME_REQUIRED';
    error.status = 400;
    throw error;
  }
  const now = new Date().toISOString();
  const member = {
    id: allocateId(state),
    familyId: Number(familyId),
    name: memberInput.name,
    birthday: memberInput.birthday,
    idNumberTail: memberInput.idNumberTail,
    relationToCore: memberInput.relationToCore,
    relationLabel: memberInput.relationLabel,
    role: memberInput.role,
    status: memberInput.status,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
  };
  state.familyMembers.push(member);
  return member;
}

export function familyOwnerMatches(family, owner = {}) {
  const normalizedOwner = normalizeOwner(owner);
  if (normalizedOwner.ownerUserId) {
    return Number(family?.ownerUserId || 0) === normalizedOwner.ownerUserId;
  }
  if (normalizedOwner.ownerGuestId) {
    return normalizeGuestId(family?.ownerGuestId) === normalizedOwner.ownerGuestId;
  }
  return !family?.ownerUserId && !family?.ownerGuestId;
}

export function listFamilyProfilesForOwner(state, owner = {}) {
  ensureFamilyState(state);
  return state.familyProfiles.filter((family) => (
    familyOwnerMatches(family, owner) &&
    String(family?.status || 'active') === 'active'
  ));
}

export function listFamilyMembers(state, familyId, options = {}) {
  ensureFamilyState(state);
  const includeInactive = Boolean(options.includeInactive);
  return state.familyMembers.filter((member) => (
    Number(member?.familyId || 0) === Number(familyId) &&
    (includeInactive || String(member?.status || 'active') === 'active')
  ));
}

export function matchFamilyMemberByPerson(members = [], person = {}) {
  const name = normalizeName(person.name);
  if (!name) return null;
  const birthday = normalizeDateOnly(person.birthday || person.birthDate);
  const idNumberTail = normalizeIdNumberTail(
    person.idNumberTail || person.idNumber || person.identityNumber || person.idCard,
  );
  const candidates = (Array.isArray(members) ? members : []).filter((member) => (
    String(member?.status || 'active') === 'active' &&
    peopleAreCompatible(member, { name, birthday, idNumberTail })
  ));
  if (!candidates.length) return null;

  if (birthday) {
    const birthdayMatches = candidates.filter((member) => normalizeDateOnly(member?.birthday) === birthday);
    if (birthdayMatches.length && idNumberTail) {
      const exact = birthdayMatches.find((member) => normalizeIdNumberTail(member?.idNumberTail) === idNumberTail);
      if (exact) return exact;
    }
    if (birthdayMatches.length) return birthdayMatches[0] || null;
  }

  if (idNumberTail) {
    const exact = candidates.find((member) => normalizeIdNumberTail(member?.idNumberTail) === idNumberTail);
    if (exact) return exact;
  }

  return candidates[0] || null;
}

export function setFamilyCoreMember(state, family, nextCoreMember) {
  ensureFamilyState(state);
  const members = listFamilyMembers(state, family.id);
  const member = members.find((row) => Number(row.id) === Number(nextCoreMember?.id || 0));
  if (!member) {
    throw familyBindingError('FAMILY_MEMBER_NOT_FOUND', '家庭成员不存在');
  }

  const previousCoreId = Number(family.coreMemberId || 0);
  const previousCore = members.find((row) => Number(row.id) === previousCoreId);
  const nextCorePreviousRelation = member.relationToCore;
  const now = new Date().toISOString();

  if (previousCoreId && previousCoreId !== Number(member.id)) {
    for (const row of members) {
      if (Number(row.id) === Number(member.id)) {
        applyFamilyMemberRelation(row, '本人', now);
      } else if (previousCore && Number(row.id) === Number(previousCore.id) && nextCorePreviousRelation === 'spouse') {
        applyFamilyMemberRelation(row, '配偶', now);
      } else {
        applyFamilyMemberRelation(row, '待确认', now);
      }
    }
  } else {
    applyFamilyMemberRelation(member, '本人', now);
  }

  family.coreMemberId = member.id;
  family.updatedAt = now;
  return member;
}

function clearPolicyFamilyBinding(policy, now) {
  policy.familyId = null;
  policy.familyBindingSource = '';
  policy.applicantMemberId = null;
  policy.insuredMemberId = null;
  policy.applicantSnapshot = null;
  policy.insuredSnapshot = null;
  policy.applicantNameSnapshot = '';
  policy.insuredNameSnapshot = '';
  policy.applicantRelationSnapshot = '';
  policy.insuredRelationSnapshot = '';
  policy.applicantMemberName = '';
  policy.insuredMemberName = '';
  policy.applicantRelation = '';
  policy.insuredRelation = '';
  policy.applicantRelationLabel = '';
  policy.insuredRelationLabel = '';
  policy.participantReviewStatus = 'pending_review';
  policy.updatedAt = now;
}

export function archiveFamilyProfile(state, family, owner = {}) {
  ensureFamilyState(state);
  if (!family) throw familyBindingError('FAMILY_NOT_FOUND', '家庭档案不存在');
  const now = new Date().toISOString();
  family.status = 'archived';
  family.coreMemberId = null;
  family.updatedAt = now;

  let archivedMemberCount = 0;
  for (const member of state.familyMembers || []) {
    if (Number(member?.familyId || 0) !== Number(family.id)) continue;
    if (String(member.status || 'active') === 'archived') continue;
    member.status = 'archived';
    member.updatedAt = now;
    archivedMemberCount += 1;
  }

  let archivedShareCount = 0;
  for (const share of state.familyReportShares || []) {
    if (Number(share?.familyId || 0) !== Number(family.id)) continue;
    if (String(share.status || 'active') === 'archived') continue;
    share.status = 'archived';
    share.updatedAt = now;
    archivedShareCount += 1;
  }

  let archivedSalesReviewCount = 0;
  for (const review of state.familySalesReviews || []) {
    if (Number(review?.familyId || 0) !== Number(family.id)) continue;
    if (String(review.status || 'active') === 'archived') continue;
    review.status = 'archived';
    review.updatedAt = now;
    archivedSalesReviewCount += 1;
  }

  let clearedPolicyCount = 0;
  for (const policy of state.policies || []) {
    if (Number(policy?.familyId || 0) !== Number(family.id)) continue;
    if (!policyOwnerMatches(policy, owner)) continue;
    clearPolicyFamilyBinding(policy, now);
    clearedPolicyCount += 1;
  }

  return { family, archivedMemberCount, archivedShareCount, archivedSalesReviewCount, clearedPolicyCount };
}

export function ensureDefaultFamilyProfileForPrincipal(state, owner = {}) {
  ensureFamilyState(state);
  const existingFamily = listFamilyProfilesForOwner(state, owner)
    .find((family) => String(family?.status || 'active') === 'active');
  const family = existingFamily || createFamilyProfile(state, { familyName: DEFAULT_FAMILY_NAME }, owner);
  const policies = (Array.isArray(state.policies) ? state.policies : [])
    .filter((policy) => (
      policyOwnerMatches(policy, owner) &&
      (!Number(policy?.familyId || 0) || Number(policy?.familyId || 0) === Number(family.id))
    ));
  const peopleByIdentity = new Map();
  for (const policy of policies) {
    for (const role of ['applicant', 'insured']) {
      const person = policyPerson(policy, role);
      if (!person.name) continue;
      const existingEntry = [...peopleByIdentity.entries()]
        .find(([, candidate]) => peopleAreCompatible(candidate, person));
      const key = existingEntry?.[0] || personIdentityKey(person, peopleByIdentity.size);
      const existing = existingEntry?.[1] || { ...person, count: 0 };
      existing.count += 1;
      existing.birthday ||= person.birthday;
      existing.idNumberTail ||= person.idNumberTail;
      peopleByIdentity.set(key, existing);
    }
  }

  const members = listFamilyMembers(state, family.id);
  const people = [...peopleByIdentity.values()].sort((left, right) => (
    right.count - left.count ||
    left.name.localeCompare(right.name, 'zh-CN') ||
    String(left.birthday || '').localeCompare(String(right.birthday || '')) ||
    String(left.idNumberTail || '').localeCompare(String(right.idNumberTail || ''))
  ));
  let coreMember = members.find((member) => Number(member.id) === Number(family.coreMemberId || 0));
  const corePerson = coreMember
    ? (people.find((person) => peopleAreCompatible(person, coreMember)) || {
      name: coreMember.name,
      birthday: coreMember.birthday,
      idNumberTail: coreMember.idNumberTail,
    })
    : (people[0] || { name: '本人', birthday: '', idNumberTail: '' });
  if (!coreMember && corePerson.name) {
    coreMember = matchFamilyMemberByPerson(members, corePerson);
  }
  if (!coreMember) {
    coreMember = createFamilyMember(state, family.id, {
      ...corePerson,
      relationToCore: 'self',
      relationLabel: '本人',
      role: 'core',
    });
    members.push(coreMember);
  }
  coreMember.relationToCore = 'self';
  coreMember.relationLabel = '本人';
  coreMember.role = 'core';
  enrichFamilyMemberIdentity(coreMember, corePerson);
  family.coreMemberId = coreMember.id;
  family.updatedAt = new Date().toISOString();

  for (const person of people) {
    if (peopleAreCompatible(person, corePerson)) continue;
    const existingMember = matchFamilyMemberByPerson(members, person);
    if (existingMember) {
      enrichFamilyMemberIdentity(existingMember, person);
      continue;
    }
    const member = createFamilyMember(state, family.id, {
      ...person,
      relationToCore: 'pending',
      relationLabel: '待确认',
      role: 'unknown',
    });
    members.push(member);
  }
  repairDuplicateFamilyMembers(state, family);

  const updatedMembers = listFamilyMembers(state, family.id);
  for (const policy of policies) {
    const applicant = policyPerson(policy, 'applicant');
    const insured = policyPerson(policy, 'insured');
    const applicantMember = matchFamilyMemberByPerson(updatedMembers, applicant) || coreMember;
    const insuredMember = matchFamilyMemberByPerson(updatedMembers, insured) || applicantMember || coreMember;
    enrichFamilyMemberIdentity(applicantMember, applicant);
    enrichFamilyMemberIdentity(insuredMember, insured);
    policy.familyId = family.id;
    policy.applicantMemberId = applicantMember?.id || null;
    policy.insuredMemberId = insuredMember?.id || null;
    policy.applicantSnapshot = applicant.name ? applicant : null;
    policy.insuredSnapshot = insured.name ? insured : null;
    policy.applicantNameSnapshot = applicant.name;
    policy.insuredNameSnapshot = insured.name;
    policy.applicantRelationSnapshot = applicantMember?.relationLabel || '';
    policy.insuredRelationSnapshot = insuredMember?.relationLabel || '';
    policy.applicantMemberName = applicantMember?.name || '';
    policy.insuredMemberName = insuredMember?.name || '';
    policy.applicantRelationLabel = applicantMember?.relationLabel || '';
    policy.insuredRelationLabel = insuredMember?.relationLabel || '';
    policy.participantReviewStatus = applicant.name && insured.name ? 'auto_matched' : 'pending_review';
  }

  return family;
}

export function validatePolicyFamilyBinding(state, input = {}, owner = null) {
  ensureFamilyState(state);
  const familyId = Number(input.familyId || 0);
  const family = state.familyProfiles.find((item) => (
    Number(item?.id || 0) === familyId &&
    String(item?.status || 'active') === 'active'
  ));
  if (!family) {
    throw familyBindingError('POLICY_FAMILY_REQUIRED');
  }
  const bindingOwner = owner || input.owner || null;
  if (hasOwnerPrincipal(bindingOwner) && !familyOwnerMatches(family, bindingOwner)) {
    throw familyBindingError('POLICY_FAMILY_FORBIDDEN');
  }

  const members = listFamilyMembers(state, family.id);
  const applicantMemberId = Number(input.applicantMemberId || 0);
  const insuredMemberId = Number(input.insuredMemberId || 0);
  const hasApplicant = members.some((member) => Number(member?.id || 0) === applicantMemberId);
  const hasInsured = members.some((member) => Number(member?.id || 0) === insuredMemberId);
  if (!hasApplicant || !hasInsured) {
    throw familyBindingError('POLICY_FAMILY_MEMBER_MISMATCH');
  }

  return true;
}
