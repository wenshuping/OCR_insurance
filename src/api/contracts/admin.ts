import type { User } from '../client';
import type { KnowledgeRecord, Policy, SourceRecord } from './policy';
import type { OptionalResponsibility, QuantificationStatus } from './responsibility';
import { request } from '../client';

export type AdminUserSummary = User & {
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
  updatedAt: string;
};

export function adminLogin(password: string) {
  return request<{ ok: true; token: string; expiresInSeconds: number }>('/api/admin/login', {
    body: { password },
  });
}

export function getAdminOverview(token: string) {
  return request<AdminOverview>('/api/admin/overview', { token });
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

export function updateAdminMembershipConfig(token: string, input: { enabled: boolean; registeredFreePolicyQuota: number }) {
  return request<{ ok: true; config: AdminMembershipConfig }>('/api/admin/membership-config', {
    token,
    method: 'PATCH',
    body: input,
  });
}
