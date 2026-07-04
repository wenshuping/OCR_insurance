import type { PolicyAnalysisResult, PolicyFormData, PolicyKnowledgeMatch } from './policy';
import { ApiError, request } from '../client';

export type Responsibility = {
  productName?: string;
  coverageType: string;
  liability?: string;
  responsibilityName?: string;
  benefitName?: string;
  scenario: string;
  payout: string;
  note: string;
  triggerCondition?: string;
  condition?: string;
  formulaText?: string;
  basis?: string;
  basisKey?: string;
  calculationKey?: string;
  requiredInputs?: string[];
  calculationInputSchemaVersion?: string;
  value?: number | null;
  valueText?: string;
  unit?: string;
  calculationEligible?: boolean;
  calculationReason?: string;
  cashflowTreatment?: CashflowTreatment;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceExcerpt?: string;
  sourceKind?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  verificationStatus?: string;
  verificationLabel?: string;
  referenceOnly?: boolean;
  official?: boolean;
};

export type ResponsibilitySelectionStatus = 'selected' | 'not_selected' | 'unknown';

export type QuantificationStatus = 'quantified' | 'pending_review' | 'not_quantifiable';

export type ResponsibilityScope = 'basic' | 'optional' | 'rider' | 'plan' | string;

export type CashflowTreatment = 'scheduled_cashflow' | 'claim_contingent' | 'waiver_only' | 'not_cashflow';

export type ResponsibilityCardCategory =
  | '现金流'
  | '人寿保障'
  | '疾病保障'
  | '医疗保障'
  | '意外保障'
  | '豁免'
  | '规则参数'
  | '其他';

export type CalculationStatus =
  | 'calculable'
  | 'needs_table'
  | 'claim_contingent'
  | 'waiver_only'
  | 'not_cashflow'
  | 'needs_review';

export type OptionalResponsibility = {
  id: string;
  company?: string;
  productName?: string;
  coverageType?: string;
  liability?: string;
  title?: string;
  responsibilityScope: 'optional';
  selectionStatus: ResponsibilitySelectionStatus;
  selectionEvidence?: string;
  quantificationStatus?: QuantificationStatus;
  quantificationReason?: string;
  indicatorIds?: string[];
  sourceExcerpt?: string;
};

export type CoverageIndicator = {
  id?: string;
  version?: string;
  company: string;
  productName: string;
  productType?: string;
  salesStatus?: string;
  coverageType: string;
  liability: string;
  value?: number | null;
  valueText?: string;
  unit?: string;
  basis?: string;
  basisKey?: string;
  calculationKey?: string;
  requiredInputs?: string[];
  calculationInputSchemaVersion?: string;
  calculationEligible?: boolean;
  calculationReason?: string;
  formulaText?: string;
  condition?: string;
  extractionMethod?: string;
  sourceRecordId?: string;
  sourceUrl?: string;
  sourceExcerpt?: string;
  sourceKind?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  verificationStatus?: string;
  verificationLabel?: string;
  referenceOnly?: boolean;
  official?: boolean;
  responsibilityScope?: ResponsibilityScope;
  selectionStatus?: ResponsibilitySelectionStatus;
  selectionEvidence?: string;
  quantificationStatus?: QuantificationStatus;
  optionalResponsibilityId?: string;
};

export type QuantifiedIndicator = Partial<CoverageIndicator> & {
  category?: ResponsibilityCardCategory;
  triggerCondition?: string;
  payoutSummary?: string;
  sourceTitle?: string;
  confidence?: 'high' | 'medium' | 'low';
  calculationStatus?: CalculationStatus;
  basisKey?: string;
  calculationKey?: string;
  requiredInputs?: string[];
  calculationInputSchemaVersion?: string;
  calculationEligible?: boolean;
  calculationReason?: string;
  cashflowTreatment?: CashflowTreatment;
  sourceUrl?: string;
  sourceExcerpt?: string;
  sourceKind?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  verificationStatus?: string;
  verificationLabel?: string;
  referenceOnly?: boolean;
  official?: boolean;
};

export type ResponsibilityCard = {
  id?: string;
  company?: string;
  productName?: string;
  title?: string;
  category?: ResponsibilityCardCategory;
  plainSummary?: string;
  triggerCondition?: string;
  payoutSummary?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourceExcerpt?: string;
  sourceKind?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  verificationStatus?: string;
  verificationLabel?: string;
  referenceOnly?: boolean;
  official?: boolean;
  confidence?: 'high' | 'medium' | 'low';
  calculationStatus?: CalculationStatus;
  calculationReason?: string;
  basisKey?: string;
  calculationKey?: string;
  requiredInputs?: string[];
  calculationInputSchemaVersion?: string;
  cashflowTreatment?: CashflowTreatment;
  indicators?: QuantifiedIndicator[];
};

export type CustomerResponsibilitySummaryItem = {
  title: string;
  plainText: string;
  triggerCondition?: string;
  howItPays: string;
  calculationStatus?: string;
  requiredPolicyFields: string[];
  sourceRefs?: string[];
};

export type ResponsibilityPlannerMode = 'auto' | 'all' | 'off';

export type CustomerResponsibilitySummaryBlock = {
  blockKey: 'productPurpose' | 'responsibilities' | 'productFunctions' | 'attentionNotes' | string;
  title: string;
  enabled: boolean;
  editable: boolean;
  order: number;
  content: string;
};

export type CustomerResponsibilitySummary = {
  company: string;
  productName: string;
  headline: string;
  mainResponsibilities: CustomerResponsibilitySummaryItem[];
  notices: string[];
  requiredPolicyFields: string[];
  sourceUrls: string[];
  officialResponsibilityText?: string;
  contentBlocks?: CustomerResponsibilitySummaryBlock[];
};

export type CustomerResponsibilitySummaryResponse =
  | {
      ok: true;
      source: 'database' | 'generated';
      summary: CustomerResponsibilitySummary;
    }
  | {
      ok: false;
      status: 'needs_source_review' | string;
      message: string;
    };

export type PolicyCompanySuggestion = {
  company: string;
  recordCount: number;
  matchType: string;
};

export type PolicyProductSuggestion = {
  company: string;
  productName: string;
  canonicalProductId?: string;
  productCode?: string;
  productCodes?: string[];
  recordCount: number;
  matchType: string;
};

const RESPONSIBILITY_TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504, 520, 522, 523, 524, 530]);

function waitForRetry(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestResponsibility<T>(path: string, options: Parameters<typeof request>[1] = {}): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await request<T>(path, options);
    } catch (error) {
      lastError = error;
      const shouldRetry = error instanceof ApiError && RESPONSIBILITY_TRANSIENT_STATUSES.has(error.status);
      if (!shouldRetry || attempt === 2) throw error;
      await waitForRetry(250 * (attempt + 1));
    }
  }
  throw lastError;
}

export function queryPolicyResponsibilities(input: {
  company: string;
  name: string;
  preferLocalKnowledgeAnswer?: boolean;
  allowExternalReferences?: boolean;
}) {
  return request<{
    ok: true;
    analysis: PolicyAnalysisResult;
  }>('/api/policy-responsibilities/query', {
    body: {
      company: input.company,
      name: input.name,
      preferLocalKnowledgeAnswer: input.preferLocalKnowledgeAnswer,
      allowExternalReferences: input.allowExternalReferences,
    },
  });
}

export function getLocalPolicyAnalysisDraft(input: { manualData: Partial<PolicyFormData>; ocrText?: string }) {
  return request<{
    ok: true;
    analysis: PolicyAnalysisResult | null;
  }>('/api/policy-responsibilities/local-draft', {
    body: {
      manualData: input.manualData,
      ocrText: input.ocrText,
    },
  });
}

export function matchPolicyResponsibilities(input: { company: string; name: string; limit?: number; minScore?: number; includeOnline?: boolean }) {
  return requestResponsibility<{
    ok: true;
    status: 'exact' | 'candidates' | 'not_found' | 'source_review_required';
    matches: PolicyKnowledgeMatch[];
    message?: string;
    savedRecordCount?: number;
  }>('/api/policy-responsibilities/matches', {
    body: {
      company: input.company,
      name: input.name,
      limit: input.limit,
      minScore: input.minScore,
      includeOnline: input.includeOnline,
    },
  });
}

export function getProductCustomerResponsibilitySummary(input: {
  company: string;
  name: string;
  plannerMode?: ResponsibilityPlannerMode;
}) {
  return requestResponsibility<CustomerResponsibilitySummaryResponse>('/api/policy-responsibilities/customer-summary', {
    body: {
      company: input.company,
      name: input.name,
      ...(input.plannerMode ? { plannerMode: input.plannerMode } : {}),
    },
  });
}

export function listPolicyResponsibilityCompanySuggestions(input: { q?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (input.q) params.set('q', input.q);
  if (input.limit) params.set('limit', String(input.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return requestResponsibility<{
    ok: true;
    suggestions: PolicyCompanySuggestion[];
  }>(`/api/policy-responsibilities/company-suggestions${suffix}`);
}

export function listPolicyResponsibilityProductSuggestions(input: { company: string; q?: string; limit?: number }) {
  const params = new URLSearchParams();
  params.set('company', input.company);
  if (input.q) params.set('q', input.q);
  if (input.limit) params.set('limit', String(input.limit));
  return requestResponsibility<{
    ok: true;
    suggestions: PolicyProductSuggestion[];
  }>(`/api/policy-responsibilities/product-suggestions?${params.toString()}`);
}
