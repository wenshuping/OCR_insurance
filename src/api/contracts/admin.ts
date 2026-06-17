import type { User } from '../client';
import type { FamilyMember, FamilyProfile, FamilySalesReview } from './family';
import type { KnowledgeRecord, Policy, SourceRecord } from './policy';
import type { OptionalResponsibility, QuantificationStatus } from './responsibility';
import { request } from '../client';

export type AdminUserSummary = User & {
  familyCount: number;
  policyCount: number;
  insuredCount: number;
  totalCoverage: number;
  annualPremium: number;
};

export type AdminInsuredSummary = {
  key: string;
  userId: number;
  userMobile: string;
  insured: string;
  policyCount: number;
  totalCoverage: number;
  annualPremium: number;
};

export type OptionalResponsibilityGap = {
  id: string;
  company: string;
  productName: string;
  liability: string;
  quantificationStatus: QuantificationStatus;
  quantificationReason: string;
  missingFields: string[];
  sourceExcerpt: string;
  recentPolicyCount: number;
};

export type AdminOverview = {
  ok: true;
  summary: {
    userCount: number;
    familyCount?: number;
    insuredCount: number;
    policyCount: number;
    sourceRecordCount?: number;
    knowledgeRecordCount?: number;
    optionalResponsibilityGapCount?: number;
    totalCoverage: number;
    annualPremium: number;
  };
  users: AdminUserSummary[];
  insureds: AdminInsuredSummary[];
  policies: Policy[];
  sourceRecords?: SourceRecord[];
  optionalResponsibilityGaps: OptionalResponsibilityGap[];
};

export type AdminUserFamilySummary = FamilyProfile & {
  members: FamilyMember[];
  memberCount: number;
  policyCount: number;
  coreMemberName: string;
  latestPolicyAt?: string;
};

export type AdminUserFamiliesResponse = {
  ok: true;
  user: {
    id: number;
    mobile: string;
    createdAt?: string;
    updatedAt?: string;
  };
  families: AdminUserFamilySummary[];
};

export type AdminOfficialDomainProfile = {
  id: string;
  company: string;
  aliases: string[];
  companyAliases: string[];
  siteDomains: string[];
  officialDomains: string[];
  source?: 'system' | 'custom' | string;
  createdAt?: string;
  updatedAt?: string;
};

export type AdminOfficialDomainProfilesResponse = {
  ok: true;
  profiles: AdminOfficialDomainProfile[];
  defaultCount?: number;
  customCount?: number;
};

export type AdminKnowledgeRecordsResponse = {
  ok: true;
  records: KnowledgeRecord[];
  summary: {
    count: number;
    officialCount: number;
  };
};

export type AdminMembershipConfig = {
  enabled: boolean;
  annualPriceCents: 30000;
  annualDurationDays: 365;
  registeredFreePolicyQuota: number;
  familyReportDailyRefreshLimit: number;
  familySalesReviewDailyRefreshLimit: number;
  updatedAt: string;
};

export type AdminReportIssueSummary = {
  id: number;
  familyId: number;
  familyName: string;
  ownerMobile?: string;
  ownerGuestId?: string;
  generatedAt: string;
  policyCount: number;
  memberCount: number;
  issueCount: number;
  errorCount: number;
  warningCount: number;
  correctionCount?: number;
  autoAppliedCorrectionCount?: number;
  acceptedCorrectionCount?: number;
  pendingCorrectionCount?: number;
  source: string;
};

export type AdminReportIssue = {
  id: number;
  reportId: number;
  familyId: number;
  severity: 'error' | 'warning' | 'info' | string;
  category: string;
  title: string;
  detail: string;
  suggestion?: string;
  source: string;
  status: string;
  memberId?: number | null;
  memberName?: string;
  policyId?: number | null;
  productName?: string;
  dimension?: string;
  correctionStatus?: 'corrected' | 'pending_review' | 'not_corrected' | 'rejected' | 'not_applicable' | string;
  correctionLabel?: string;
  correctionReason?: string;
  correctionId?: number | null;
  createdAt: string;
  updatedAt?: string;
};

export type AdminReportCorrection = {
  id: number;
  reportId: number;
  familyId: number;
  policyId?: number | null;
  memberId?: number | null;
  dimension: string;
  action: string;
  status: string;
  originalValue?: unknown;
  correctedValue?: unknown;
  cashflowRows?: Array<{
    year: number;
    age?: number | null;
    amount: number;
    liability?: string;
    calculationText?: string;
    evidence?: string;
  }>;
  reason: string;
  evidence?: string;
  confidence?: number | null;
  riskLevel?: string;
  notAppliedReason?: string;
  memberName?: string;
  productName?: string;
};

export function adminLogin(password: string) {
  return request<{ ok: true; token: string; expiresInSeconds: number }>('/api/admin/login', {
    body: { password },
  });
}

export function getAdminOverview(token: string) {
  return request<AdminOverview>('/api/admin/overview', { token });
}

export function getAdminUserFamilies(token: string, userId: number) {
  return request<AdminUserFamiliesResponse>(`/api/admin/users/${encodeURIComponent(String(userId))}/families`, { token });
}

export function getAdminFamilySalesReview(token: string, familyId: number) {
  return request<{ ok: true; review: FamilySalesReview | null }>(`/api/admin/families/${encodeURIComponent(String(familyId))}/sales-review`, { token });
}

export function getAdminReportIssues(token: string) {
  return request<{ ok: true; reports: AdminReportIssueSummary[] }>('/api/admin/report-issues', { token });
}

export function getAdminReportIssueDetail(token: string, reportId: number) {
  return request<{ ok: true; report: AdminReportIssueSummary; issues: AdminReportIssue[]; corrections?: AdminReportCorrection[] }>(`/api/admin/report-issues/${reportId}`, { token });
}

export function rejectAdminReportCorrection(token: string, correctionId: number) {
  return request<{ ok: true; report: AdminReportIssueSummary; issues: AdminReportIssue[]; corrections: AdminReportCorrection[] }>(`/api/admin/report-corrections/${correctionId}/reject`, {
    token,
    method: 'POST',
  });
}

export function markOptionalResponsibilityNotQuantifiable(token: string, id: string, reason: string) {
  return request<{ ok: true; record: OptionalResponsibility }>(`/api/admin/optional-responsibilities/${encodeURIComponent(id)}/not-quantifiable`, {
    token,
    method: 'POST',
    body: { reason },
  });
}

export function reextractOptionalResponsibilities(token: string) {
  return request<{ ok: true; optionalResponsibilityCount: number; optionalIndicatorCount: number }>('/api/admin/optional-responsibilities/reextract', {
    token,
    method: 'POST',
  });
}

export function getAdminOfficialDomainProfiles(token: string) {
  return request<AdminOfficialDomainProfilesResponse>('/api/admin/official-domain-profiles', { token });
}

export function createAdminOfficialDomainProfile(token: string, input: Partial<AdminOfficialDomainProfile>) {
  return request<{ ok: true; profile: AdminOfficialDomainProfile; profiles: AdminOfficialDomainProfile[] }>('/api/admin/official-domain-profiles', {
    token,
    body: input,
  });
}

export function updateAdminOfficialDomainProfile(token: string, id: string, input: Partial<AdminOfficialDomainProfile>) {
  return request<{ ok: true; profile: AdminOfficialDomainProfile; profiles: AdminOfficialDomainProfile[] }>(`/api/admin/official-domain-profiles/${encodeURIComponent(id)}`, {
    token,
    body: input,
  });
}

export function deleteAdminOfficialDomainProfile(token: string, id: string) {
  return request<{ ok: true; profiles: AdminOfficialDomainProfile[] }>(`/api/admin/official-domain-profiles/${encodeURIComponent(id)}`, {
    token,
    method: 'DELETE',
  });
}

export function getAdminKnowledgeRecords(token: string) {
  return request<AdminKnowledgeRecordsResponse>('/api/admin/knowledge-records', { token });
}

export function crawlAdminKnowledge(token: string, input: { company: string; name: string }) {
  return request<AdminKnowledgeRecordsResponse & { savedCount: number }>('/api/admin/knowledge-crawl', {
    token,
    body: input,
  });
}

export function getAdminMembershipConfig(token: string) {
  return request<{ ok: true; config: AdminMembershipConfig }>('/api/admin/membership-config', { token });
}

export function updateAdminMembershipConfig(token: string, input: {
  enabled: boolean;
  registeredFreePolicyQuota: number;
  familyReportDailyRefreshLimit: number;
  familySalesReviewDailyRefreshLimit: number;
}) {
  return request<{ ok: true; config: AdminMembershipConfig }>('/api/admin/membership-config', {
    token,
    method: 'PATCH',
    body: input,
  });
}
