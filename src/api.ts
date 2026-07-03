import {
  confirmCashValue as confirmCashValueContract,
  scanCashValue as scanCashValueContract,
} from './api/contracts/cashflow';
import {
  createFamilyMember as createFamilyMemberContract,
  createFamilyPolicyAnalysisReport as createFamilyPolicyAnalysisReportContract,
  createFamilyProfile as createFamilyProfileContract,
  createFamilyReportShare as createFamilyReportShareContract,
  createFamilySalesReview as createFamilySalesReviewContract,
  deleteFamilyMember as deleteFamilyMemberContract,
  deleteFamilyProfile as deleteFamilyProfileContract,
  ensureDefaultFamilyProfile as ensureDefaultFamilyProfileContract,
  getFamilyPolicyAnalysisReport as getFamilyPolicyAnalysisReportContract,
  getFamilySalesReview as getFamilySalesReviewContract,
  getFamilyReportShare as getFamilyReportShareContract,
  listFamilyProfiles as listFamilyProfilesContract,
  regenerateFamilyReportRecord as regenerateFamilyReportRecordContract,
  setFamilyCoreMember as setFamilyCoreMemberContract,
  updateFamilyMember as updateFamilyMemberContract,
  updateFamilyProfile as updateFamilyProfileContract,
  updateFamilyMemberRelation as updateFamilyMemberRelationContract,
} from './api/contracts/family';
import {
  deletePolicy as deletePolicyContract,
  getPolicy as getPolicyContract,
  listPolicies as listPoliciesContract,
  regeneratePolicyReport as regeneratePolicyReportContract,
  updatePolicy as updatePolicyContract,
} from './api/contracts/policy';
import type {
  CashValueRow as CashValueRowContract,
  CashValueScanResult as CashValueScanResultContract,
} from './api/contracts/cashflow';
import type { FamilyPlanningProfile } from './family-report-engine.mjs';
import type { OptionalResponsibilityGap as OptionalResponsibilityGapContract } from './api/contracts/admin';
import type {
  FamilyMember as FamilyMemberContract,
  FamilyMemberPolicyReference as FamilyMemberPolicyReferenceContract,
  FamilyPolicyAnalysisReport as FamilyPolicyAnalysisReportContract,
  FamilyProfile as FamilyProfileContract,
  FamilyRelationToCore as FamilyRelationToCoreContract,
  FamilyReportRecord as FamilyReportRecordContract,
  FamilyReportShare as FamilyReportShareContract,
  FamilyReportSharePayload as FamilyReportSharePayloadContract,
  FamilySalesReview as FamilySalesReviewContract,
} from './api/contracts/family';
import type {
  Policy as PolicyContract,
  PolicyFormData as PolicyFormDataContract,
  PolicyUpdateInput as PolicyUpdateInputContract,
  UploadItem as UploadItemContract,
} from './api/contracts/policy';
import type {
  OptionalResponsibility as OptionalResponsibilityContract,
  QuantificationStatus as QuantificationStatusContract,
  Responsibility as ResponsibilityContract,
  ResponsibilitySelectionStatus as ResponsibilitySelectionStatusContract,
} from './api/contracts/responsibility';

export { ApiError, getHealthStatus, getWechatJsSdkSignature, logClientPerformance, logoutCustomer, register, sendCode } from './api/client';
export {
  markOptionalResponsibilityNotQuantifiable,
  reextractOptionalResponsibilities,
} from './api/contracts/admin';
export type { HealthStatus, User, WechatJsSdkSignature } from './api/client';
export * from './api/contracts/policy';
export * from './api/contracts/family';
export * from './api/contracts/admin';
export * from './api/contracts/responsibility';
export * from './api/contracts/cashflow';

export type ResponsibilitySelectionStatus = ResponsibilitySelectionStatusContract;
export type QuantificationStatus = QuantificationStatusContract;

export type Responsibility = ResponsibilityContract & {
  sourceUrl?: string;
  sourceTitle?: string;
};

export type OptionalResponsibility = OptionalResponsibilityContract & {
  selectionStatus: ResponsibilitySelectionStatus;
  quantificationStatus?: QuantificationStatus;
};

export type Policy = PolicyContract & {
  beneficiary?: string;
  coverageIndicators?: PolicyContract['coverageIndicators'];
};

export type PolicyFormData = PolicyFormDataContract & {
  beneficiary: string;
  familyId?: number | null;
  applicantMemberId?: number | null;
  insuredMemberId?: number | null;
};

export type PolicyUpdateInput = PolicyUpdateInputContract;

export type OptionalResponsibilityGap = OptionalResponsibilityGapContract;

export type CashValueScanResult = CashValueScanResultContract & {
  source?: 'ocr' | 'macos_vision' | 'vision_llm' | 'manual';
};

export type CashValueRow = CashValueRowContract;

export type FamilyRelationToCore =
  | FamilyRelationToCoreContract
  | 'child';

export type FamilyMember = FamilyMemberContract;

export type FamilyMemberPolicyReference = FamilyMemberPolicyReferenceContract;

export type FamilyProfile = FamilyProfileContract;

export type FamilyReportRecord = FamilyReportRecordContract;

export type FamilyReportShare = FamilyReportShareContract;

export type FamilyReportSharePayload = FamilyReportSharePayloadContract;

export type FamilyPolicyAnalysisReport = FamilyPolicyAnalysisReportContract;

export type FamilySalesReview = FamilySalesReviewContract;

export function listPolicies(input: { token?: string; guestId?: string } = {}) {
  return listPoliciesContract(input);
}

export function getPolicy(input: { token?: string; guestId?: string; id: number }) {
  return getPolicyContract(input);
}

export function updatePolicy(input: { token?: string; guestId?: string; id: number; policy: PolicyUpdateInput }) {
  // method: 'PATCH'
  return updatePolicyContract(input);
}

export function deletePolicy(input: { token?: string; guestId?: string; id: number }) {
  // method: 'DELETE'
  return deletePolicyContract(input);
}

export function regeneratePolicyReport(input: { token?: string; guestId?: string; id: number }) {
  return regeneratePolicyReportContract(input);
}

export function scanCashValue(input: { token?: string; guestId?: string; policyId: number; uploadItem: UploadItemContract }) {
  return scanCashValueContract(input);
}

export function confirmCashValue(input: { token?: string; guestId?: string; policyId: number; rows: CashValueRow[] }) {
  return confirmCashValueContract(input);
}

export function listFamilyProfiles(input: { token?: string; guestId?: string } = {}) {
  // request<{ ok: true; families: FamilyProfile[] }>
  return listFamilyProfilesContract(input);
}

export function createFamilyProfile(input: { token?: string; guestId?: string; familyName: string; notes?: string }) {
  return createFamilyProfileContract(input);
}

export function updateFamilyProfile(input: { token?: string; guestId?: string; familyId: number; familyName?: string; notes?: string; planningProfile?: FamilyPlanningProfile | null }) {
  return updateFamilyProfileContract(input);
}

export function deleteFamilyProfile(input: { token?: string; guestId?: string; familyId: number }) {
  return deleteFamilyProfileContract(input);
}

export function ensureDefaultFamilyProfile(input: { token?: string; guestId?: string } = {}) {
  return ensureDefaultFamilyProfileContract(input);
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
  return createFamilyMemberContract(input);
}

export function setFamilyCoreMember(input: { token?: string; guestId?: string; familyId: number; memberId: number }) {
  return setFamilyCoreMemberContract(input);
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
  return updateFamilyMemberContract(input);
}

export function updateFamilyMemberRelation(input: { token?: string; guestId?: string; familyId: number; memberId: number; relationLabel?: string; notes?: string }) {
  return updateFamilyMemberRelationContract(input);
}

export function deleteFamilyMember(input: { token?: string; guestId?: string; familyId: number; memberId: number }) {
  return deleteFamilyMemberContract(input);
}

export function createFamilyReportShare(input: { token?: string; guestId?: string; familyId: number }) {
  return createFamilyReportShareContract(input);
}

export function regenerateFamilyReportRecord(input: { token?: string; guestId?: string; familyId: number; planningProfile?: FamilyPlanningProfile | null; userRefresh?: boolean }) {
  return regenerateFamilyReportRecordContract(input);
}

export function getFamilyPolicyAnalysisReport(input: { token?: string; guestId?: string; familyId: number }) {
  return getFamilyPolicyAnalysisReportContract(input);
}

export function createFamilyPolicyAnalysisReport(input: { token?: string; guestId?: string; familyId: number; planningProfile?: FamilyPlanningProfile | null }) {
  return createFamilyPolicyAnalysisReportContract(input);
}

export function getFamilySalesReview(input: { token?: string; guestId?: string; familyId: number }) {
  return getFamilySalesReviewContract(input);
}

export function createFamilySalesReview(input: { token?: string; guestId?: string; familyId: number; userRefresh?: boolean; salesChatMessageIds?: number[] }) {
  return createFamilySalesReviewContract(input);
}

export function getFamilyReportShare(shareToken: string) {
  return getFamilyReportShareContract(shareToken);
}
