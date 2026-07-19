import type { User } from '../client';
import type { FamilyMember, FamilyProfile, FamilyReportRecord, FamilySalesChatThread, FamilySalesReview } from './family';
import type { KnowledgeRecord, Policy, SourceRecord } from './policy';
import type { OptionalResponsibility, QuantificationStatus } from './responsibility';
import { ApiError, request } from '../client';

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

export type AdminKnowledgeDocument = {
  id: string;
  fileName: string;
  mediaType: string;
  extension: string;
  byteSize: number;
  documentType: string;
  sourceAuthority: 'company_material' | 'expert_training' | string;
  parseStatus: string;
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
  payload: {
    libraryType?: 'expert' | 'company_product' | string;
    contributorName?: string;
    contributorRole?: string;
    title?: string;
    materialType?: string;
    materialUsage?: string;
    materialUsages?: string[];
    company?: string;
    productName?: string;
    productNames?: string[];
    versionLabel?: string;
    focusTags?: string[];
    specialInstructions?: string;
    sourceUrl?: string;
    [key: string]: unknown;
  };
  job?: {
    status: string;
    currentStep: string;
    errorCode?: string;
    errorMessage?: string;
  } | null;
  reviewChunks?: AdminKnowledgeChunk[];
  indexReview?: {
    activeIndexVersion?: string;
    candidateIndexVersion?: string;
    previousActiveIndexVersion?: string;
    diff?: { added: number; removed: number; unchanged: number };
  } | null;
  publishReadiness?: {
    decision: 'pass' | 'blocked';
    checks: Array<{ code?: string; status?: string; message?: string; affectedCount?: number }>;
    blockingReasons: Array<{ code?: string; status?: string; message?: string; affectedCount?: number }>;
  } | null;
  bindingProducts?: Array<{
    canonicalProductId: string;
    productVersionId?: string;
    company: string;
    officialName: string;
  }>;
};

export type AdminKnowledgeChunk = {
  id: string;
  canonicalProductId?: string;
  productVersionId?: string;
  chunkType: string;
  headingPath: string[];
  pageStart: number;
  pageEnd: number;
  content: string;
  contextualPrefix?: string;
  reviewStatus?: string;
  indexStatus: string;
  payload?: {
    documentMetadata?: {
      title?: string;
      fileName?: string;
      materialType?: string;
      documentType?: string;
      materialUsages?: string[];
      company?: string;
      productNames?: string[];
      versionLabel?: string;
      focusTags?: string[];
      specialInstructions?: string;
      contributorName?: string;
      contributorRole?: string;
      sourceAuthority?: string;
      sourceUrl?: string;
    };
    quality?: {
      decision?: string;
      checks?: Array<{ code?: string; status?: string; message?: string }>;
      qualityRuleVersion?: string;
    };
    [key: string]: unknown;
  };
};

export type AdminKnowledgeDocumentDetail = {
  ok: true;
  document: AdminKnowledgeDocument;
  chunks: AdminKnowledgeChunk[];
  summary: {
    pageCount: number;
    chunkCount: number;
    readyChunkCount: number;
    blockedChunkCount: number;
  };
};

export type AdminKnowledgeSourceRegion = {
  pageNo: number;
  bbox?: [number, number, number, number] | number[];
  elementIds: string[];
};

export type AdminKnowledgeSourceElement = {
  id: string;
  kind: 'text' | 'table' | 'business_image' | 'decoration' | 'header_footer' | 'qr_contact' | string;
  bbox?: [number, number, number, number] | number[];
  text?: string;
  caption?: string;
  assetRef?: string;
  ocrConfidence?: number | null;
};

export type AdminKnowledgeReviewPage = {
  id: string;
  pageNo: number;
  rawText: string;
  ocrConfidence?: number | null;
  imageUrl?: string;
  previewUrl?: string;
  layout?: {
    elements?: AdminKnowledgeSourceElement[];
    [key: string]: unknown;
  };
};

export type AdminKnowledgeCorrectionOperation = {
  type: string;
  targetChunkId?: string;
  targetChunkIds?: string[];
  elementIds?: string[];
  content?: string;
  splitAtText?: string;
  relationType?: string;
  relatedChunkId?: string;
  [key: string]: unknown;
};

export type AdminKnowledgeReviewIssue = {
  id: string;
  runId?: string;
  type: string;
  severity: 'high' | 'medium' | 'low' | string;
  confidence?: number | null;
  reason: string;
  status: string;
  pageNos: number[];
  sourceRegions: AdminKnowledgeSourceRegion[];
  affectedChunkIds: string[];
  proposedOperations: AdminKnowledgeCorrectionOperation[];
  payload?: Record<string, unknown>;
};

export type AdminKnowledgeReviewRun = {
  id: string;
  indexVersion?: string;
  reviewType: string;
  model?: string;
  status: string;
  errorCode?: string;
  errorMessage?: string;
  startedAt?: string;
  completedAt?: string;
  summary?: Record<string, unknown>;
};

export type AdminKnowledgeCorrectionPlan = {
  id?: string;
  sourceIssueId?: string;
  reasonCode: string;
  note: string;
  scope: string;
  operations: AdminKnowledgeCorrectionOperation[];
  status?: string;
  requiresConfirmation?: boolean;
  model?: string;
  aiIssues?: AdminKnowledgeReviewIssue[];
  correctionVersion?: string;
};

export type AdminKnowledgePageReview = {
  pageNo: number;
  indexVersion: string;
  status: 'passed' | 'needs_correction' | 'excluded' | 'pending_confirmation';
  note?: string;
  reviewer?: string;
  reviewedAt: string;
};

export type AdminKnowledgeReviewWorkspaceResponse = {
  ok: true;
  document: AdminKnowledgeDocument;
  pages: AdminKnowledgeReviewPage[];
  reviewRuns: AdminKnowledgeReviewRun[];
  issues: AdminKnowledgeReviewIssue[];
  corrections: AdminKnowledgeCorrectionPlan[];
  pageReviews: AdminKnowledgePageReview[];
  indexReview?: AdminKnowledgeDocument['indexReview'];
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

export type AdminResponsibilityGenerationFailureExample = {
  badOutput: string;
  reason: string;
  correction: string;
};

export type AdminResponsibilityGenerationConfig = {
  enabled: boolean;
  plannerMode: 'auto' | 'all' | 'off' | string;
  promptRules: string[];
  blockedResponsibilityTitles: string[];
  failureExamples: AdminResponsibilityGenerationFailureExample[];
  fallbackMode: 'official_text_after_second_failure' | 'needs_review' | string;
  updatedAt: string;
};

export type AdminOcrScenarioRouting = {
  config: { routes: Record<string, string>; updatedAt: string };
  scenarios: Array<{ key: string; label: string }>;
  models: Array<{ value: string; label: string }>;
};

export type AdminAgentPolicyDecision = 'execute' | 'propose' | 'reject';
export type AdminAgentPolicyHandler = 'system' | 'insurance_expert' | 'sales_champion';
export type AdminAgentPolicyOperation = 'read' | 'write';
export type AdminAgentPolicyConfirmation = 'not_required' | 'required';
export type AdminAgentPolicyOutputMode = 'direct' | 'structured' | 'preview';
export type AdminAgentPolicyTool = 'list_families' | 'family_summary' | 'coverage_report' | 'sales_report' | 'product_knowledge_search' | 'create_upload_link' | 'propose_memory' | 'preview_transfer';

export type AdminAgentQuestionPolicy = {
  key: string;
  intent: string;
  decision: AdminAgentPolicyDecision;
  handler: AdminAgentPolicyHandler;
  operation: AdminAgentPolicyOperation;
  confirmation: AdminAgentPolicyConfirmation;
  outputMode: AdminAgentPolicyOutputMode;
  tool: AdminAgentPolicyTool | null;
  enabled?: boolean;
  confidenceThreshold?: number;
};

export type AdminAgentRuntimeSettings = {
  fallbackHistoryMessageLimit: number;
  productContextTtlMinutes: number;
};

export type AdminAgentQuestionPolicyVersion = {
  id: number;
  version: number;
  status: 'draft' | 'published' | 'archived';
  policies: AdminAgentQuestionPolicy[];
  runtimeSettings: AdminAgentRuntimeSettings;
  actor: string;
  createdAt: string;
  publishedAt: string;
  archivedAt: string;
};

export type AdminAgentQuestionPoliciesResponse = {
  ok: true;
  published: AdminAgentQuestionPolicyVersion | null;
  drafts: AdminAgentQuestionPolicyVersion[];
  history: AdminAgentQuestionPolicyVersion[];
  templates: AdminAgentQuestionPolicy[];
  defaultRuntimeSettings: AdminAgentRuntimeSettings;
};

export type AdminAgentPolicySimulationCandidate = {
  intent: string;
  requestedOperation: AdminAgentPolicyOperation;
  confidence?: number;
  question?: string;
  entities?: Record<string, string>;
};

export type AdminAgentPolicySimulationResponse = {
  ok: true;
  previewOnly: true;
  decision: {
    policyKey: string;
    policySource: 'draft' | 'published' | 'built_in';
    intent: string;
    decision: string;
    result: string;
    handler: AdminAgentPolicyHandler;
    operation: AdminAgentPolicyOperation;
    tool: AdminAgentPolicyTool | null;
    confirmationRequired: boolean;
    outputMode: AdminAgentPolicyOutputMode;
    familyResolved: boolean;
    fallback: boolean;
    explanation: string;
  };
};

export type AdminAgentUnknownQuestion = { id: number; userRef: string; category: string; fallbackDecision: string; occurrenceCount: number; status: string; createdAt: string };

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

export function getAdminPolicy(token: string, policyId: number) {
  return request<{ ok: true; policy: Policy }>(`/api/admin/policies/${encodeURIComponent(String(policyId))}`, { token });
}

export function getAdminUserFamilies(token: string, userId: number) {
  return request<AdminUserFamiliesResponse>(`/api/admin/users/${encodeURIComponent(String(userId))}/families`, { token });
}

export function getAdminFamilyReport(token: string, familyId: number) {
  return request<{ ok: true; reportRecord: FamilyReportRecord | null }>(`/api/admin/families/${encodeURIComponent(String(familyId))}/report`, { token });
}

export function createAdminFamilyReport(token: string, familyId: number) {
  return request<{ ok: true; reportRecord: FamilyReportRecord | null }>(`/api/admin/families/${encodeURIComponent(String(familyId))}/report`, {
    token,
    body: {},
  });
}

export function getAdminFamilySalesReview(token: string, familyId: number) {
  return request<{ ok: true; review: FamilySalesReview | null }>(`/api/admin/families/${encodeURIComponent(String(familyId))}/sales-review`, { token });
}

export function getAdminFamilySalesChatThreads(token: string, familyId: number) {
  return request<{ ok: true; threads: FamilySalesChatThread[] }>(`/api/admin/families/${encodeURIComponent(String(familyId))}/sales-chat/threads`, { token });
}

export function getAdminReportIssues(token: string) {
  return request<{ ok: true; reports: AdminReportIssueSummary[] }>('/api/admin/report-issues', { token });
}

export function getAdminReportIssueDetail(token: string, reportId: number) {
  return request<{ ok: true; report: AdminReportIssueSummary; issues: AdminReportIssue[]; corrections?: AdminReportCorrection[] }>(`/api/admin/report-issues/${reportId}`, { token });
}

export function getAdminOptionalResponsibilityGaps(token: string) {
  return request<{ ok: true; gaps: OptionalResponsibilityGap[] }>('/api/admin/optional-responsibility-gaps', { token });
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

export function reviewAdminKnowledgeRecord(token: string, input: { id: number; action: 'approved' | 'rejected' }) {
  return request<AdminKnowledgeRecordsResponse & { record: KnowledgeRecord }>(`/api/admin/knowledge-records/${encodeURIComponent(String(input.id))}/review`, {
    token,
    body: { action: input.action },
  });
}

export function getAdminKnowledgeDocuments(token: string, options: { includeReviewChunks?: boolean } = {}) {
  const query = options.includeReviewChunks ? '?includeChunks=review' : '';
  return request<{ ok: true; documents: AdminKnowledgeDocument[]; summary: { count: number } }>(`/api/admin/product-knowledge/documents${query}`, { token });
}

export function getAdminProductCatalogCompanies(token: string) {
  void token;
  return request<{ ok: true; suggestions: Array<{ company: string; recordCount: number; matchType: string }> }>('/api/policy-responsibilities/company-suggestions')
    .then((payload) => ({ ok: true as const, companies: payload.suggestions.map((item) => item.company), summary: { count: payload.suggestions.length } }));
}

export function searchAdminProductCatalog(token: string, input: { company?: string; query?: string; limit?: number }) {
  void token;
  const params = new URLSearchParams();
  if (input.company) params.set('company', input.company);
  if (input.query) params.set('q', input.query);
  if (input.limit) params.set('limit', String(input.limit));
  return request<{ ok: true; suggestions: Array<{ company: string; productName: string; recordCount: number; matchType: string }> }>(`/api/policy-responsibilities/product-suggestions?${params.toString()}`)
    .then((payload) => ({
      ok: true as const,
      products: payload.suggestions.map((item) => ({ ...item, score: 0 })),
      summary: { count: payload.suggestions.length, query: input.query || '', company: input.company || '' },
    }));
}

export function getAdminKnowledgeDocument(token: string, documentId: string) {
  return request<AdminKnowledgeDocumentDetail>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}`, { token });
}

export function uploadAdminKnowledgeDocument(token: string, input: {
  libraryType: 'expert' | 'company_product';
  fileName: string;
  mediaType: string;
  dataBase64: string;
  contributorName?: string;
  contributorRole?: string;
  title?: string;
  materialType?: string;
  materialUsage?: string;
  materialUsages?: string[];
  company?: string;
  productName?: string;
  productNames?: string[];
  versionLabel?: string;
  focusTags?: string[];
  specialInstructions?: string;
}) {
  return request<{ ok: true; deduplicated: boolean; document: AdminKnowledgeDocument }>('/api/admin/product-knowledge/documents', {
    token,
    body: input,
  });
}

export function uploadAdminKnowledgeDocumentFromUrl(token: string, input: {
  libraryType: 'expert' | 'company_product';
  sourceUrl: string;
  contributorName?: string;
  contributorRole?: string;
  title?: string;
  materialType?: string;
  materialUsage?: string;
  materialUsages?: string[];
  company?: string;
  productName?: string;
  productNames?: string[];
  versionLabel?: string;
  focusTags?: string[];
  specialInstructions?: string;
}) {
  return request<{ ok: true; deduplicated: boolean; document: AdminKnowledgeDocument }>('/api/admin/product-knowledge/documents/from-url', {
    token,
    body: input,
  });
}

export function processAdminKnowledgeDocument(token: string, documentId: string) {
  return request<{ ok: true; document: AdminKnowledgeDocument }>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/process`, {
    token,
    body: {},
  });
}

export function reviewAdminKnowledgeDocument(token: string, documentId: string, action: 'publish' | 'reject' | 'rollback' | 'unpublish') {
  return request<{ ok: true; document: AdminKnowledgeDocument; registeredKnowledgeRecord?: KnowledgeRecord | null; registeredKnowledgeRecords?: KnowledgeRecord[] }>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/review`, {
    token,
    body: { action },
  });
}

export function updateAdminKnowledgeChunkBinding(token: string, documentId: string, chunkId: string, input: {
  action: 'bind' | 'exclude';
  canonicalProductId?: string;
}) {
  return request<{
    ok: true;
    chunk: AdminKnowledgeChunk;
    publishReadiness: NonNullable<AdminKnowledgeDocument['publishReadiness']>;
  }>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/chunks/${encodeURIComponent(chunkId)}/binding`, {
    token,
    method: 'PATCH',
    body: input,
  });
}

export function getAdminKnowledgeReviewWorkspace(token: string, documentId: string) {
  return request<AdminKnowledgeReviewWorkspaceResponse>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/review-workspace`, { token });
}

export async function getAdminKnowledgeDocumentSource(token: string, documentId: string) {
  const response = await fetch(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/source`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    throw new ApiError(response.status, payload?.code || 'PRODUCT_DOCUMENT_SOURCE_FAILED', payload?.message || '原始资料读取失败');
  }
  return response.blob();
}

export async function getAdminKnowledgePagePreview(token: string, documentId: string, pageNo: number) {
  const response = await fetch(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/pages/${pageNo}/preview`, {
    headers: { authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { code?: string; message?: string } | null;
    throw new ApiError(response.status, payload?.code || 'PRODUCT_DOCUMENT_PREVIEW_FAILED', payload?.message || '原页图片预览暂不可用');
  }
  return response.blob();
}

export function startAdminKnowledgePreReview(token: string, documentId: string) {
  return request<{
    ok: true;
    review: {
      decision: string;
      model?: string;
      summary?: Record<string, unknown>;
      issues: AdminKnowledgeReviewIssue[];
    };
    run: AdminKnowledgeReviewRun;
    issues: AdminKnowledgeReviewIssue[];
  }>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/pre-review`, {
    token,
    body: {},
  });
}

export function reviewAdminKnowledgePage(token: string, documentId: string, pageNo: number, input: {
  status: 'passed' | 'needs_correction' | 'excluded';
  note?: string;
  indexVersion?: string;
}) {
  return request<{ ok: true; review: AdminKnowledgePageReview; publishedChunkCount: number }>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/pages/${pageNo}/review`, {
    token,
    body: input,
  });
}

export function planAdminKnowledgeCorrections(token: string, documentId: string, input: {
  pageNo?: number;
  sourceIssueId?: string;
  reasonCode: string;
  note: string;
  scope?: 'current_chunk' | 'document_repeated_regions' | 'product_page_range' | string;
  targetChunkIds?: string[];
  sourceElementIds?: string[];
  operations?: AdminKnowledgeCorrectionOperation[];
}) {
  return request<{ ok: true; plan: AdminKnowledgeCorrectionPlan }>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/corrections/plan`, {
    token,
    body: input,
  });
}

export function confirmAdminKnowledgeCorrections(token: string, documentId: string, input: {
  plan: AdminKnowledgeCorrectionPlan;
  pageNo?: number;
  sourceIssueId?: string;
  indexVersion?: string;
}) {
  return request<{
    ok: true;
    correction: AdminKnowledgeCorrectionPlan;
    reprocessed?: { document?: AdminKnowledgeDocument; candidateIndexVersion?: string; [key: string]: unknown };
  }>(`/api/admin/product-knowledge/documents/${encodeURIComponent(documentId)}/corrections/confirm`, {
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

export function getAdminResponsibilityGenerationConfig(token: string) {
  return request<{ ok: true; config: AdminResponsibilityGenerationConfig }>('/api/admin/responsibility-generation-config', { token });
}

export function updateAdminResponsibilityGenerationConfig(token: string, input: Partial<AdminResponsibilityGenerationConfig>) {
  return request<{ ok: true; config: AdminResponsibilityGenerationConfig }>('/api/admin/responsibility-generation-config', {
    token,
    method: 'PATCH',
    body: input,
  });
}

export function getAdminOcrScenarioRouting(token: string) {
  return request<{ ok: true } & AdminOcrScenarioRouting>('/api/admin/ocr-scenario-routing', { token });
}

export function updateAdminOcrScenarioRouting(token: string, routes: Record<string, string>) {
  return request<{ ok: true } & AdminOcrScenarioRouting>('/api/admin/ocr-scenario-routing', {
    token,
    method: 'PATCH',
    body: { routes },
  });
}

export function getAdminAgentQuestionPolicies(token: string) {
  return request<AdminAgentQuestionPoliciesResponse>('/api/admin/agent-question-policies', { token });
}

export function createAdminAgentQuestionPolicyDraft(token: string, policies: AdminAgentQuestionPolicy[], runtimeSettings: AdminAgentRuntimeSettings) {
  return request<{ ok: true; draft: AdminAgentQuestionPolicyVersion }>('/api/admin/agent-question-policies/drafts', { token, body: { policies, runtimeSettings } });
}

export function updateAdminAgentQuestionPolicyDraft(token: string, draftId: number, policies: AdminAgentQuestionPolicy[], runtimeSettings: AdminAgentRuntimeSettings) {
  return request<{ ok: true; draft: AdminAgentQuestionPolicyVersion }>(`/api/admin/agent-question-policies/drafts/${draftId}`, { token, method: 'PATCH', body: { policies, runtimeSettings } });
}

export function publishAdminAgentQuestionPolicyDraft(token: string, draftId: number) {
  return request<{ ok: true; published: AdminAgentQuestionPolicyVersion }>(`/api/admin/agent-question-policies/drafts/${draftId}/publish`, { token, body: {} });
}

export function rollbackAdminAgentQuestionPolicyVersion(token: string, versionId: number) {
  return request<{ ok: true; sourceVersionId: number; published: AdminAgentQuestionPolicyVersion }>(`/api/admin/agent-question-policies/versions/${versionId}/rollback`, { token, body: {} });
}

export function simulateAdminAgentQuestionPolicy(token: string, input: { draftId?: number; candidate: AdminAgentPolicySimulationCandidate }) {
  return request<AdminAgentPolicySimulationResponse>('/api/admin/agent-question-policies/simulate', { token, body: input });
}

export function getAdminAgentUnknownQuestions(token: string, input: { limit?: number; offset?: number } = {}) {
  const params = new URLSearchParams({ limit: String(input.limit || 20), offset: String(input.offset || 0) });
  return request<{ ok: true; items: AdminAgentUnknownQuestion[]; total: number; limit: number; offset: number }>(`/api/admin/agent-unknown-questions?${params}`, { token });
}
