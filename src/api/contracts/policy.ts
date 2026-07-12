import type { CashflowEntry, CashValueRow, ScenarioEntry } from './cashflow';
import type { CoverageIndicator, OptionalResponsibility, Responsibility, ResponsibilityCard } from './responsibility';
import { authQuery, request } from '../client';

export type PolicySource = {
  title: string;
  url: string;
  snippet?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  sourceKind?: string;
  verificationStatus?: string;
  verificationLabel?: string;
  referenceOnly?: boolean;
  official?: boolean;
  sourceType?: string;
  materialType?: string;
  sourceExcerpt?: string;
};

export type Policy = {
  id: number;
  company: string;
  name: string;
  canonicalProductId?: string;
  applicant: string;
  applicantBirthday?: string;
  beneficiary?: string;
  beneficiaryRelation?: string;
  beneficiaryBirthday?: string;
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
  responsibilityCards?: ResponsibilityCard[];
  optionalResponsibilities?: OptionalResponsibility[];
  report: string;
  sources?: PolicySource[];
  reportStatus?: 'generating' | 'ready' | 'failed' | string;
  reportError?: string;
  familyId?: number | null;
  familyBindingSource?: string;
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
  productCode?: string;
  productCodes?: string[];
  productType?: string;
  amount: number | string;
  coveragePeriod: string;
  paymentMode?: string;
  paymentPeriod: string;
  premium: number | string;
  premiumText?: string;
  matchScore?: number;
  matchReason?: string;
  benefitRows?: PolicyPlanBenefitRow[];
};

export type PolicyPlanBenefitRow = {
  responsibilityName?: string;
  amountText?: string;
  amount?: number | string;
  premium?: number | string;
  coveragePeriod?: string;
  paymentMode?: string;
  paymentPeriod?: string;
  paymentBasis?: string;
  benefitStandard?: string;
  deductible?: string;
  ratio?: string;
  evidence?: string;
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
  sourceKind?: string;
  reviewStatus?: 'pending' | 'approved' | 'rejected' | string;
  globalSearchable?: boolean;
  ownerUserId?: number;
  ownerGuestId?: string;
  uploadNames?: string[];
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
  applicantBirthday?: string;
  beneficiary?: string;
  beneficiaryRelation?: string;
  beneficiaryBirthday?: string;
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

export type PolicyFieldEvidence = {
  value?: string;
  rawValue?: string;
  labelText?: string;
  rowText?: string;
  relation?: 'inline' | 'right' | 'row' | 'header' | string;
  source?: string;
  confidence?: number;
  region?: string;
  labelBox?: number[];
  valueBox?: number[];
};

export type PolicyFieldAttribution = {
  field: string;
  value: string;
  label?: string;
  source: string;
  parser: string;
  confidence?: string | number;
};

export type PolicyScanResult = {
  ocrText: string;
  data: PolicyScanData;
  fieldConfidence?: Record<string, 'high' | 'review' | 'missing' | string>;
  fieldEvidence?: Record<string, PolicyFieldEvidence>;
  fieldAttribution?: Record<string, PolicyFieldAttribution>;
  ocrWarnings?: string[];
  visionDebug?: {
    provider?: string;
    model?: string;
    passLabel?: string;
    finishReason?: string;
    rawContent?: string;
    parsedData?: unknown;
    normalizedData?: unknown;
    dataBeforeOcrMerge?: unknown;
    recoveredFromPartialJson?: boolean;
    usage?: {
      promptTokens?: number;
      completionTokens?: number;
    };
    contentChars?: number;
    planCount?: number;
  };
};

export type PolicyAnalysisResult = {
  report: string;
  coverageTable: Responsibility[];
  responsibilityCards?: ResponsibilityCard[];
  optionalResponsibilities?: OptionalResponsibility[];
  notes?: string[];
  sources?: PolicySource[];
  officialResponsibilityText?: string;
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
  productCode?: string;
  productCodes?: string[];
  title: string;
  score: number;
  matchReason: string;
  evidenceLabel: string;
  evidenceLevel?: string;
  sourceKind?: 'local' | 'insurer_official' | 'jrcpcx' | string;
  verificationStatus?: string;
  verificationLabel?: string;
  referenceOnly?: boolean;
  inputName?: string;
  resolvedProductName?: string;
  needsConfirmation?: boolean;
  responsibilityDeferred?: boolean;
  sourceCount: number;
  bestSource?: {
    title?: string;
    url?: string;
    sourceType?: string;
    materialType?: string;
    sourceKind?: string;
    evidenceLevel?: string;
    verificationStatus?: string;
    verificationLabel?: string;
    referenceOnly?: boolean;
    detailUrl?: string;
    clauseUrl?: string;
    productCode?: string;
    productCodes?: string[];
    responsibilityDeferred?: boolean;
  };
};

export type PolicyFormData = {
  company: string;
  name: string;
  canonicalProductId?: string;
  applicant: string;
  applicantBirthday: string;
  beneficiary: string;
  beneficiaryRelation: string;
  beneficiaryBirthday: string;
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
  familyBindingSource?: string;
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

export function scanPolicyProductKnowledge(input: {
  token?: string;
  guestId: string;
  company: string;
  name: string;
  manualData?: Partial<PolicyFormData>;
  scan?: PolicyScanResult | null;
  uploadItems: UploadItem[];
}) {
  return request<{
    ok: true;
    scan: PolicyScanResult;
    supplementOcrText: string;
    optionalResponsibilities?: OptionalResponsibility[];
    knowledgeRecordIds: number[];
    uploadedCount: number;
    status: 'exact' | 'candidates' | 'not_found' | 'source_review_required';
    matches: PolicyKnowledgeMatch[];
    message?: string;
    savedRecordCount?: number;
  }>('/api/policies/product-knowledge-scan', {
    token: input.token,
    body: {
      guestId: input.guestId,
      company: input.company,
      name: input.name,
      manualData: input.manualData,
      scan: input.scan || undefined,
      uploadItems: input.uploadItems,
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

export function listPolicies(input: { token?: string; guestId?: string; signal?: AbortSignal } = {}) {
  return request<{ ok: true; policies: Policy[] }>(`/api/policies${authQuery(input)}`, { token: input.token, signal: input.signal });
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
