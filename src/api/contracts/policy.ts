import type { CashflowEntry, CashValueRow, ScenarioEntry } from './cashflow';
import type { CoverageIndicator, OptionalResponsibility, Responsibility } from './responsibility';
import { authQuery, request } from '../client';

export type PolicySource = {
  title: string;
  url: string;
  snippet?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  official?: boolean;
  sourceType?: string;
};

export type Policy = {
  id: number;
  company: string;
  name: string;
  canonicalProductId?: string;
  applicant: string;
  beneficiary?: string;
  applicantRelation: string;
  insured: string;
  insuredRelation: string;
  insuredIdNumber?: string;
  insuredBirthday?: string;
  date: string;
  paymentPeriod: string;
  coveragePeriod: string;
  amount: number;
  firstPremium: number;
  plans?: PolicyPlan[];
  ocrText: string;
  responsibilities: Responsibility[];
  coverageIndicators?: CoverageIndicator[];
  optionalResponsibilities?: OptionalResponsibility[];
  report: string;
  sources?: PolicySource[];
  reportStatus?: 'generating' | 'ready' | 'failed' | string;
  reportError?: string;
  familyId?: number | null;
  applicantMemberId?: number | null;
  insuredMemberId?: number | null;
  applicantNameSnapshot?: string;
  insuredNameSnapshot?: string;
  applicantRelationSnapshot?: string;
  insuredRelationSnapshot?: string;
  participantReviewStatus?: 'ok' | 'name_mismatch' | 'pending_member' | string;
  familyName?: string;
  applicantMemberName?: string;
  applicantRelationLabel?: string;
  insuredMemberName?: string;
  insuredRelationLabel?: string;
  createdAt: string;
  userMobile?: string;
  cashflowEntries?: CashflowEntry[];
  scenarioEntries?: ScenarioEntry[];
  totalCashflow?: number;
  cashValues?: CashValueRow[];
};

export type PolicyPlan = {
  company: string;
  role: 'main' | 'rider' | 'linked_account' | 'unknown' | string;
  name: string;
  matchedProductName?: string;
  canonicalProductId?: string;
  productType?: string;
  amount: number | string;
  coveragePeriod: string;
  paymentMode?: string;
  paymentPeriod: string;
  premium: number | string;
  premiumText?: string;
  matchScore?: number;
  matchReason?: string;
};

export type SourceRecord = PolicySource & {
  id: number;
  policyId: number;
  company: string;
  productName: string;
  discoveredAt: string;
  lastUsedAt: string;
  useCount: number;
};

export type KnowledgeRecord = PolicySource & {
  id: number;
  company: string;
  productName: string;
  pageText?: string;
  materialType?: string;
  officialDomain?: string;
  parser?: string;
  discoveredAt?: string;
  lastFetchedAt?: string;
  lastUsedAt?: string;
  updatedAt?: string;
  useCount?: number;
};

export type UploadItem = {
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
};

export type PolicyScanData = {
  company: string;
  name: string;
  canonicalProductId?: string;
  applicant: string;
  beneficiary?: string;
  applicantRelation: string;
  insured: string;
  insuredRelation: string;
  insuredIdNumber?: string;
  insuredBirthday?: string;
  date: string;
  paymentPeriod: string;
  coveragePeriod: string;
  amount: number | string;
  firstPremium: number | string;
  plans?: PolicyPlan[];
};

export type PolicyScanResult = {
  ocrText: string;
  data: PolicyScanData;
  fieldConfidence?: Record<string, 'high' | 'review' | 'missing' | string>;
  ocrWarnings?: string[];
};

export type PolicyAnalysisResult = {
  report: string;
  coverageTable: Responsibility[];
  optionalResponsibilities?: OptionalResponsibility[];
  notes?: string[];
  sources?: PolicySource[];
  productOverview?: string;
  purchaseAdvice?: string;
  disclaimer?: string;
  model?: string;
  rawAnalysis?: unknown;
};

export type PolicyKnowledgeMatch = {
  company: string;
  productName: string;
  canonicalProductId?: string;
  title: string;
  score: number;
  matchReason: string;
  evidenceLabel: string;
  sourceCount: number;
  bestSource?: {
    title?: string;
    url?: string;
    sourceType?: string;
    materialType?: string;
  };
};

export type PolicyFormData = {
  company: string;
  name: string;
  canonicalProductId?: string;
  applicant: string;
  beneficiary: string;
  applicantRelation: string;
  insured: string;
  insuredRelation: string;
  insuredIdNumber?: string;
  insuredBirthday: string;
  date: string;
  paymentPeriod: string;
  coveragePeriod: string;
  amount: string;
  firstPremium: string;
  plans?: PolicyPlan[];
  familyId?: number | null;
  applicantMemberId?: number | null;
  insuredMemberId?: number | null;
  applicantNameSnapshot?: string;
  insuredNameSnapshot?: string;
  applicantRelationSnapshot?: string;
  insuredRelationSnapshot?: string;
  participantReviewStatus?: 'ok' | 'name_mismatch' | 'pending_member' | string;
  familyName?: string;
  applicantMemberName?: string;
  applicantRelationLabel?: string;
  insuredMemberName?: string;
  insuredRelationLabel?: string;
  optionalResponsibilities?: OptionalResponsibility[];
};

export type PolicyUpdateInput = Partial<PolicyFormData> & {
  optionalResponsibilities?: OptionalResponsibility[];
};

export function scanPolicy(input: {
  token?: string;
  guestId: string;
  ocrText: string;
  uploadItem: UploadItem | null;
  manualData?: Partial<PolicyFormData>;
  scan?: PolicyScanResult | null;
  analysis?: PolicyAnalysisResult | null;
}) {
  return request<{ ok: true; policy: Policy; registrationRequiredNext: boolean }>('/api/policies/scan', {
    token: input.token,
    body: {
      guestId: input.guestId,
      ocrText: input.ocrText,
      uploadItem: input.uploadItem,
      manualData: input.manualData,
      scan: input.scan || undefined,
      analysis: input.analysis || undefined,
    },
  });
}

export function recognizePolicy(input: {
  token?: string;
  guestId: string;
  ocrText: string;
  uploadItem: UploadItem | null;
  manualData?: Partial<PolicyFormData>;
}) {
  return request<{
    ok: true;
    scan: PolicyScanResult;
    analysis?: PolicyAnalysisResult | null;
    registrationRequiredNext: boolean;
  }>('/api/policies/recognize', {
    token: input.token,
    body: {
      guestId: input.guestId,
      ocrText: input.ocrText,
      uploadItem: input.uploadItem,
      manualData: input.manualData,
    },
  });
}

export function analyzePolicy(input: {
  token?: string;
  guestId: string;
  ocrText: string;
  uploadItem: UploadItem | null;
  manualData?: Partial<PolicyFormData>;
  scan?: PolicyScanResult | null;
}) {
  return request<{
    ok: true;
    scan: PolicyScanResult;
    analysis: PolicyAnalysisResult;
    registrationRequiredNext: boolean;
  }>('/api/policies/analyze', {
    token: input.token,
    body: {
      guestId: input.guestId,
      ocrText: input.ocrText,
      uploadItem: input.uploadItem,
      manualData: input.manualData,
      scan: input.scan || undefined,
    },
  });
}

export function listPolicies(input: { token?: string; guestId?: string } = {}) {
  return request<{ ok: true; policies: Policy[] }>(`/api/policies${authQuery(input)}`, { token: input.token });
}

export function getPolicy(input: { token?: string; guestId?: string; id: number }) {
  return request<{ ok: true; policy: Policy }>(`/api/policies/${input.id}${authQuery(input)}`, { token: input.token });
}

export function updatePolicy(input: { token?: string; guestId?: string; id: number; policy: PolicyUpdateInput }) {
  return request<{ ok: true; policy: Policy; reportRegenerating: boolean }>(`/api/policies/${input.id}${authQuery(input)}`, {
    token: input.token,
    method: 'PATCH',
    body: input.policy,
  });
}

export function deletePolicy(input: { token?: string; guestId?: string; id: number }) {
  return request<{ ok: true; deletedId: number }>(`/api/policies/${input.id}${authQuery(input)}`, {
    token: input.token,
    method: 'DELETE',
  });
}

export function regeneratePolicyReport(input: { token?: string; guestId?: string; id: number }) {
  return request<{ ok: true; policy: Policy; skipped?: boolean }>(`/api/policies/${input.id}/report${authQuery(input)}`, {
    token: input.token,
    body: {},
  });
}
