import type { Policy } from './policy';
import { authQuery, request } from '../client';

export type FamilyRelationToCore =
  | 'self'
  | 'spouse'
  | 'son'
  | 'daughter'
  | 'daughter_in_law'
  | 'son_in_law'
  | 'child'
  | 'father'
  | 'mother'
  | 'parent'
  | 'parent_in_law'
  | 'grandparent'
  | 'grandson'
  | 'granddaughter'
  | 'maternal_grandson'
  | 'maternal_granddaughter'
  | 'maternal_grandfather'
  | 'maternal_grandmother'
  | 'paternal_grandfather'
  | 'paternal_grandmother'
  | 'sibling'
  | 'other'
  | 'pending';

export type FamilyMember = {
  id: number;
  familyId: number;
  name: string;
  relationToCore: FamilyRelationToCore;
  relationLabel: string;
  role: 'core' | 'adult' | 'child' | 'elder' | 'unknown';
  gender?: 'male' | 'female' | 'unknown';
  birthday?: string;
  idNumberTail?: string;
  mobile?: string;
  notes?: string;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
};

export type FamilyProfile = {
  id: number;
  ownerUserId?: number | null;
  ownerGuestId?: string;
  familyName: string;
  notes?: string;
  coreMemberId: number | null;
  status: 'active' | 'archived';
  createdAt: string;
  updatedAt: string;
  members?: FamilyMember[];
};

export type FamilyReportShare = {
  id: number;
  token: string;
  familyId: number;
  createdAt: string;
};

export type FamilyReportSharePayload = {
  ok: true;
  family: Omit<FamilyProfile, 'ownerUserId' | 'ownerGuestId'>;
  members: FamilyMember[];
  policies: Policy[];
  snapshotAt: string;
};

export type FamilySalesReview = {
  id?: number;
  familyId?: number;
  status?: 'active' | 'archived';
  content: string;
  model: string;
  generatedAt: string;
  createdAt?: string;
  updatedAt?: string;
  inputSummary?: {
    familyId?: number | null;
    memberCount?: number;
    policyCount?: number;
    membersWithoutPolicyCount?: number;
    officialProductCount?: number;
  };
};

export function listFamilyProfiles(input: { token?: string; guestId?: string } = {}) {
  return request<{ ok: true; families: FamilyProfile[] }>(`/api/family-profiles${authQuery(input)}`, { token: input.token });
}

export function createFamilyProfile(input: { token?: string; guestId?: string; familyName: string; notes?: string }) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[] }>(`/api/family-profiles${authQuery(input)}`, {
    token: input.token,
    body: { familyName: input.familyName, notes: input.notes },
  });
}

export function updateFamilyProfile(input: { token?: string; guestId?: string; familyId: number; familyName?: string; notes?: string }) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[] }>(`/api/family-profiles/${input.familyId}${authQuery(input)}`, {
    token: input.token,
    method: 'PATCH',
    body: { familyName: input.familyName, notes: input.notes },
  });
}

export function deleteFamilyProfile(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{
    ok: true;
    family: FamilyProfile;
    archivedMemberCount: number;
    archivedShareCount: number;
    clearedPolicyCount: number;
  }>(`/api/family-profiles/${input.familyId}${authQuery(input)}`, {
    token: input.token,
    method: 'DELETE',
  });
}

export function ensureDefaultFamilyProfile(input: { token?: string; guestId?: string } = {}) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[] }>(`/api/family-profiles/default${authQuery(input)}`, {
    token: input.token,
    body: {},
  });
}

export function createFamilyMember(input: {
  token?: string;
  guestId?: string;
  familyId: number;
  name: string;
  relationLabel: string;
  birthday?: string;
  idNumberTail?: string;
  notes?: string;
  setAsCore?: boolean;
}) {
  return request<{ ok: true; family: FamilyProfile; member: FamilyMember; members: FamilyMember[] }>(`/api/family-profiles/${input.familyId}/members${authQuery(input)}`, {
    token: input.token,
    body: {
      name: input.name,
      relationLabel: input.relationLabel,
      birthday: input.birthday,
      idNumberTail: input.idNumberTail,
      notes: input.notes,
      setAsCore: input.setAsCore,
    },
  });
}

export function setFamilyCoreMember(input: { token?: string; guestId?: string; familyId: number; memberId: number }) {
  return request<{ ok: true; family: FamilyProfile; member: FamilyMember; members: FamilyMember[] }>(`/api/family-profiles/${input.familyId}/core${authQuery(input)}`, {
    token: input.token,
    method: 'PATCH',
    body: { memberId: input.memberId },
  });
}

export function updateFamilyMemberRelation(input: { token?: string; guestId?: string; familyId: number; memberId: number; relationLabel?: string; notes?: string }) {
  return request<{ ok: true; family: FamilyProfile; member: FamilyMember; members: FamilyMember[] }>(
    `/api/family-profiles/${input.familyId}/members/${input.memberId}${authQuery(input)}`,
    {
      token: input.token,
      method: 'PATCH',
      body: { relationLabel: input.relationLabel, notes: input.notes },
    },
  );
}

export function createFamilyReportShare(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; share: FamilyReportShare }>(`/api/family-profiles/${input.familyId}/share${authQuery(input)}`, {
    token: input.token,
    body: {},
  });
}

export function getFamilySalesReview(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; review: FamilySalesReview | null }>(`/api/family-profiles/${input.familyId}/sales-review${authQuery(input)}`, {
    token: input.token,
  });
}

export function createFamilySalesReview(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; review: FamilySalesReview }>(`/api/family-profiles/${input.familyId}/sales-review${authQuery(input)}`, {
    token: input.token,
    body: {},
  });
}

export function getFamilyReportShare(shareToken: string) {
  return request<FamilyReportSharePayload>(`/api/family-report-shares/${encodeURIComponent(shareToken)}`);
}
