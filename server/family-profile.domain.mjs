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
  ['father', { relationToCore: 'father', relationLabel: '父亲', role: 'elder' }],
  ['父亲', { relationToCore: 'father', relationLabel: '父亲', role: 'elder' }],
  ['爸爸', { relationToCore: 'father', relationLabel: '父亲', role: 'elder' }],
  ['mother', { relationToCore: 'mother', relationLabel: '母亲', role: 'elder' }],
  ['母亲', { relationToCore: 'mother', relationLabel: '母亲', role: 'elder' }],
  ['妈妈', { relationToCore: 'mother', relationLabel: '母亲', role: 'elder' }],
  ['parent', { relationToCore: 'parent', relationLabel: '父母', role: 'elder' }],
  ['父母', { relationToCore: 'parent', relationLabel: '父母', role: 'elder' }],
  ['长辈', { relationToCore: 'parent', relationLabel: '父母', role: 'elder' }],
  ['other', { relationToCore: 'other', relationLabel: '其他', role: 'unknown' }],
  ['其他', { relationToCore: 'other', relationLabel: '其他', role: 'unknown' }],
  ['pending', { relationToCore: 'pending', relationLabel: '待确认', role: 'unknown' }],
]);

function ensureFamilyState(state) {
  state.familyProfiles = Array.isArray(state.familyProfiles) ? state.familyProfiles : [];
  state.familyMembers = Array.isArray(state.familyMembers) ? state.familyMembers : [];
  state.familyReportShares = Array.isArray(state.familyReportShares) ? state.familyReportShares : [];
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

function peopleAreCompatible(left, right) {
  if (normalizeName(left?.name) !== normalizeName(right?.name)) return false;
  const leftBirthday = normalizeDateOnly(left?.birthday || left?.birthDate);
  const rightBirthday = normalizeDateOnly(right?.birthday || right?.birthDate);
  if (leftBirthday && rightBirthday && leftBirthday !== rightBirthday) return false;
  const leftTail = normalizeIdNumberTail(left?.idNumberTail || left?.idNumber || left?.identityNumber || left?.idCard);
  const rightTail = normalizeIdNumberTail(right?.idNumberTail || right?.idNumber || right?.identityNumber || right?.idCard);
  if (leftTail && rightTail && leftTail !== rightTail) return false;
  return true;
}

function personIdentityKey(person, index) {
  const name = normalizeName(person?.name);
  if (!name) return '';
  const birthday = normalizeDateOnly(person?.birthday || person?.birthDate);
  const idNumberTail = normalizeIdNumberTail(person?.idNumberTail || person?.idNumber || person?.identityNumber || person?.idCard);
  if (!birthday && !idNumberTail) return name;
  return [name, birthday, idNumberTail, index].join('\u001f');
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
  return state.familyProfiles.filter((family) => familyOwnerMatches(family, owner));
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
    normalizeName(member?.name) === name
  ));
  if (!candidates.length) return null;

  if (birthday) {
    const birthdayMatches = candidates.filter((member) => normalizeDateOnly(member?.birthday) === birthday);
    if (!birthdayMatches.length) return null;
    if (idNumberTail) {
      const exact = birthdayMatches.find((member) => normalizeIdNumberTail(member?.idNumberTail) === idNumberTail);
      return exact || null;
    }
    return birthdayMatches[0] || null;
  }

  if (idNumberTail) {
    const exact = candidates.find((member) => normalizeIdNumberTail(member?.idNumberTail) === idNumberTail);
    if (exact) return exact;
  }

  return candidates[0] || null;
}

export function ensureDefaultFamilyProfileForPrincipal(state, owner = {}) {
  ensureFamilyState(state);
  const existingFamily = listFamilyProfilesForOwner(state, owner)
    .find((family) => String(family?.status || 'active') === 'active');
  if (existingFamily) return existingFamily;

  const family = createFamilyProfile(state, { familyName: DEFAULT_FAMILY_NAME }, owner);
  const policies = (Array.isArray(state.policies) ? state.policies : [])
    .filter((policy) => policyOwnerMatches(policy, owner));
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

  const people = [...peopleByIdentity.values()].sort((left, right) => (
    right.count - left.count ||
    left.name.localeCompare(right.name, 'zh-CN') ||
    String(left.birthday || '').localeCompare(String(right.birthday || '')) ||
    String(left.idNumberTail || '').localeCompare(String(right.idNumberTail || ''))
  ));
  const corePerson = people[0] || { name: '本人', birthday: '', idNumberTail: '' };
  const coreMember = createFamilyMember(state, family.id, {
    ...corePerson,
    relationToCore: 'self',
    relationLabel: '本人',
    role: 'core',
  });
  family.coreMemberId = coreMember.id;
  family.updatedAt = new Date().toISOString();

  for (const person of people) {
    if (person.name === corePerson.name) continue;
    createFamilyMember(state, family.id, {
      ...person,
      relationToCore: 'pending',
      relationLabel: '待确认',
      role: 'unknown',
    });
  }

  const members = listFamilyMembers(state, family.id);
  for (const policy of policies) {
    const applicant = policyPerson(policy, 'applicant');
    const insured = policyPerson(policy, 'insured');
    const applicantMember = matchFamilyMemberByPerson(members, applicant);
    const insuredMember = matchFamilyMemberByPerson(members, insured);
    policy.familyId = family.id;
    policy.applicantMemberId = applicantMember?.id || null;
    policy.insuredMemberId = insuredMember?.id || null;
    policy.applicantSnapshot = applicant.name ? applicant : null;
    policy.insuredSnapshot = insured.name ? insured : null;
    policy.participantReviewStatus = applicantMember && insuredMember ? 'auto_matched' : 'pending_review';
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
  const coreMember = members.find((member) => Number(member?.id || 0) === Number(family.coreMemberId || 0));
  if (!coreMember) {
    throw familyBindingError('POLICY_FAMILY_CORE_REQUIRED');
  }

  const applicantMemberId = Number(input.applicantMemberId || 0);
  const insuredMemberId = Number(input.insuredMemberId || 0);
  const hasApplicant = members.some((member) => Number(member?.id || 0) === applicantMemberId);
  const hasInsured = members.some((member) => Number(member?.id || 0) === insuredMemberId);
  if (!hasApplicant || !hasInsured) {
    throw familyBindingError('POLICY_FAMILY_MEMBER_MISMATCH');
  }

  return true;
}
