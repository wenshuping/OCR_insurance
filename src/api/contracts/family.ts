import type { Policy } from './policy';
import type { FamilyPlanningProfile, FamilyReport } from '../../family-report-engine.mjs';
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

export type FamilyPolicySummary = {
  policyCount: number;
  totalCoverage: number;
  annualPremium: number;
  insuredGroups: Array<{
    insured: string;
    policyCount: number;
    totalCoverage: number;
    annualPremium: number;
    policyIds: number[];
  }>;
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
  policyCount?: number;
  policySummary?: FamilyPolicySummary;
  planningProfile?: FamilyPlanningProfile;
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

export type FamilyReportRecord = {
  id: number;
  familyId: number;
  status: 'active' | 'archived' | string;
  source: 'code' | 'deepseek' | string;
  generatedAt: string;
  createdAt?: string;
  updatedAt?: string;
  summary?: FamilyReport['summary'] & { issueCount?: number };
  report: FamilyReport;
};

export type FamilyPolicyAnalysisReport = {
  status: 'complete' | 'failed' | 'empty' | string;
  content: string;
  model?: string;
  generatedAt: string;
  error?: string;
  stale?: boolean;
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

export type FamilySalesChatMessage = {
  id: number;
  threadId: number;
  familyId: number;
  role: 'user' | 'assistant' | string;
  content: string;
  status: 'complete' | 'failed' | string;
  createdAt: string;
  error?: string;
};

export type FamilySalesChatThread = {
  id: number;
  familyId: number;
  status: 'active' | 'archived' | string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  latestMessageAt?: string;
  messages?: FamilySalesChatMessage[];
};

export type FamilyMemberPolicyReference = {
  id: number;
  company: string;
  name: string;
  policyNumber?: string;
  applicant?: string;
  insured?: string;
  roles: string[];
};

export type UpdateFamilyMemberResponse = {
  ok: true;
  family: FamilyProfile;
  member: FamilyMember;
  members: FamilyMember[];
  affectedPolicies?: FamilyMemberPolicyReference[];
  syncedPolicyCount?: number;
  policies?: Policy[];
};

export type PolicyImportTask = {
  taskId: number;
  familyId: number;
  channel: string;
  targetAgent: 'sales_champion' | 'insurance_expert';
  status: string;
  stateVersion: number;
  documentSummary: { count: number; statuses: Record<string, number> };
  intakeLimits: { maxDocumentBytes: number; transport: 'base64_data_url' };
  policyDraft: Record<string, string | number>;
  missingFields: string[];
  resolution: { product: 'pending' | 'trusted_match' | 'selected' | 'manual_confirmed'; insuredMember: 'pending' | 'resolved'; applicantMember: 'pending' | 'resolved' | 'not_required' };
  legalOptions: {
    products: Array<{ optionId: string; label: string }>;
    members: Array<{ optionId: string; label: string }>;
  };
  nextInteraction: { type: string; stateVersion: number; field?: string; status?: string } | null;
};

type PolicyImportScope = { token?: string; guestId?: string; familyId: number };

export function startPolicyImport(input: PolicyImportScope) {
  return request<{ ok: true; task: PolicyImportTask }>(`/api/family-profiles/${input.familyId}/policy-imports${authQuery(input)}`, { token: input.token, body: {} });
}

export function getPolicyImport(input: PolicyImportScope & { taskId: number }) {
  return request<{ ok: true; task: PolicyImportTask }>(`/api/family-profiles/${input.familyId}/policy-imports/${input.taskId}${authQuery(input)}`, { token: input.token });
}

export function appendPolicyImportFiles(input: PolicyImportScope & { taskId: number; stateVersion: number; files: Array<{ uploadItem: string; name?: string; mediaType?: string }> }) {
  return request<{ ok: true; task: PolicyImportTask }>(`/api/family-profiles/${input.familyId}/policy-imports/${input.taskId}/files${authQuery(input)}`, {
    token: input.token, body: { stateVersion: input.stateVersion, files: input.files },
  });
}

export function applyPolicyImportAction(input: PolicyImportScope & { taskId: number; stateVersion: number; action: string; field?: string; value?: string; optionId?: string; role?: string }) {
  const { token, guestId, familyId, taskId, ...body } = input;
  return request<{ ok: true; task: PolicyImportTask }>(`/api/family-profiles/${familyId}/policy-imports/${taskId}/actions${authQuery({ guestId })}`, { token, body });
}

export function listFamilyProfiles(input: { token?: string; guestId?: string } = {}) {
  return request<{ ok: true; families: FamilyProfile[] }>(`/api/family-profiles${authQuery(input)}`, { token: input.token });
}

export function createFamilyProfile(input: { token?: string; guestId?: string; familyName: string; notes?: string }) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[] }>(`/api/family-profiles${authQuery(input)}`, {
    token: input.token,
    body: { familyName: input.familyName, notes: input.notes },
  });
}

export function updateFamilyProfile(input: { token?: string; guestId?: string; familyId: number; familyName?: string; notes?: string; planningProfile?: FamilyPlanningProfile | null }) {
  return request<{ ok: true; family: FamilyProfile; members: FamilyMember[] }>(`/api/family-profiles/${input.familyId}${authQuery(input)}`, {
    token: input.token,
    method: 'PATCH',
    body: { familyName: input.familyName, notes: input.notes, planningProfile: input.planningProfile },
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

export function updateFamilyMember(input: {
  token?: string;
  guestId?: string;
  familyId: number;
  memberId: number;
  name?: string;
  relationLabel?: string;
  birthday?: string;
  idNumberTail?: string;
  notes?: string;
  syncBoundPolicies?: boolean;
}) {
  return request<UpdateFamilyMemberResponse>(
    `/api/family-profiles/${input.familyId}/members/${input.memberId}${authQuery(input)}`,
    {
      token: input.token,
      method: 'PATCH',
      body: {
        name: input.name,
        relationLabel: input.relationLabel,
        birthday: input.birthday,
        idNumberTail: input.idNumberTail,
        notes: input.notes,
        syncBoundPolicies: input.syncBoundPolicies,
      },
    },
  );
}

export const updateFamilyMemberRelation = updateFamilyMember;

export function deleteFamilyMember(input: { token?: string; guestId?: string; familyId: number; memberId: number }) {
  return request<{
    ok: true;
    family: FamilyProfile;
    member: FamilyMember;
    members: FamilyMember[];
    clearedPolicyCount: number;
  }>(`/api/family-profiles/${input.familyId}/members/${input.memberId}${authQuery(input)}`, {
    token: input.token,
    method: 'DELETE',
  });
}

export function createFamilyReportShare(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; share: FamilyReportShare }>(`/api/family-profiles/${input.familyId}/share${authQuery(input)}`, {
    token: input.token,
    body: {},
  });
}

export function getFamilyReportRecord(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; reportRecord: FamilyReportRecord | null }>(`/api/family-profiles/${input.familyId}/report${authQuery(input)}`, {
    token: input.token,
  });
}

export function createFamilyReportRecord(input: { token?: string; guestId?: string; familyId: number; planningProfile?: FamilyPlanningProfile | null; userRefresh?: boolean }) {
  return request<{ ok: true; reportRecord: FamilyReportRecord }>(`/api/family-profiles/${input.familyId}/report${authQuery(input)}`, {
    token: input.token,
    body: { planningProfile: input.planningProfile || null, userRefresh: input.userRefresh === true },
  });
}

export function regenerateFamilyReportRecord(input: { token?: string; guestId?: string; familyId: number; planningProfile?: FamilyPlanningProfile | null; userRefresh?: boolean }) {
  return createFamilyReportRecord(input);
}

export function getFamilyPolicyAnalysisReport(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; analysisReport: FamilyPolicyAnalysisReport | null }>(`/api/family-profiles/${input.familyId}/policy-analysis-report${authQuery(input)}`, {
    token: input.token,
  });
}

export function createFamilyPolicyAnalysisReport(input: { token?: string; guestId?: string; familyId: number; planningProfile?: FamilyPlanningProfile | null }) {
  return request<{ ok: true; analysisReport: FamilyPolicyAnalysisReport }>(`/api/family-profiles/${input.familyId}/policy-analysis-report${authQuery(input)}`, {
    token: input.token,
    body: { planningProfile: input.planningProfile || null },
  });
}

export function getFamilySalesReview(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; review: FamilySalesReview | null }>(`/api/family-profiles/${input.familyId}/sales-review${authQuery(input)}`, {
    token: input.token,
  });
}

export function createFamilySalesReview(input: { token?: string; guestId?: string; familyId: number; userRefresh?: boolean; salesChatMessageIds?: number[] }) {
  return request<{ ok: true; review: FamilySalesReview }>(`/api/family-profiles/${input.familyId}/sales-review${authQuery(input)}`, {
    token: input.token,
    body: {
      userRefresh: input.userRefresh === true,
      salesChatMessageIds: Array.isArray(input.salesChatMessageIds) ? input.salesChatMessageIds : [],
    },
  });
}

export function listFamilySalesChatThreads(input: { token?: string; guestId?: string; familyId: number }) {
  return request<{ ok: true; threads: FamilySalesChatThread[] }>(`/api/family-profiles/${input.familyId}/sales-chat/threads${authQuery(input)}`, {
    token: input.token,
  });
}

export function createFamilySalesChatThread(input: { token?: string; guestId?: string; familyId: number; message?: string }) {
  return request<{ ok: true; thread: FamilySalesChatThread; messages: FamilySalesChatMessage[] }>(
    `/api/family-profiles/${input.familyId}/sales-chat/threads${authQuery(input)}`,
    {
      token: input.token,
      body: { message: input.message || '' },
    },
  );
}

export function getFamilySalesChatThread(input: { token?: string; guestId?: string; familyId: number; threadId: number }) {
  return request<{ ok: true; thread: FamilySalesChatThread; messages: FamilySalesChatMessage[] }>(
    `/api/family-profiles/${input.familyId}/sales-chat/threads/${input.threadId}${authQuery(input)}`,
    {
      token: input.token,
    },
  );
}

export function sendFamilySalesChatMessage(input: { token?: string; guestId?: string; familyId: number; threadId: number; message: string }) {
  return request<{ ok: true; thread: FamilySalesChatThread; messages: FamilySalesChatMessage[] }>(
    `/api/family-profiles/${input.familyId}/sales-chat/threads/${input.threadId}/messages${authQuery(input)}`,
    {
      token: input.token,
      body: { message: input.message },
    },
  );
}

export function getFamilyReportShare(shareToken: string) {
  return request<FamilyReportSharePayload>(`/api/family-report-shares/${encodeURIComponent(shareToken)}`);
}
