import type { PolicyAnalysisResult, PolicyFormData, PolicyKnowledgeMatch } from './policy';
import { ApiError, request } from '../client';

export type Responsibility = {
  coverageType: string;
  scenario: string;
  payout: string;
  note: string;
  sourceUrl?: string;
  sourceTitle?: string;
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
  formulaText?: string;
  condition?: string;
  extractionMethod?: string;
  sourceRecordId?: string;
  sourceUrl?: string;
  sourceExcerpt?: string;
  responsibilityScope?: ResponsibilityScope;
  selectionStatus?: ResponsibilitySelectionStatus;
  selectionEvidence?: string;
  quantificationStatus?: QuantificationStatus;
  optionalResponsibilityId?: string;
};

export type QuantifiedIndicator = CoverageIndicator & {
  category?: ResponsibilityCardCategory;
  triggerCondition?: string;
  payoutSummary?: string;
  sourceTitle?: string;
  confidence?: 'high' | 'medium' | 'low';
  calculationStatus?: CalculationStatus;
  basisKey: string;
  calculationKey: string;
  calculationEligible: boolean;
  calculationReason: string;
  cashflowTreatment: CashflowTreatment;
  sourceUrl: string;
  sourceExcerpt: string;
};

export type ResponsibilityCard = {
  id: string;
  company: string;
  productName: string;
  title: string;
  category: ResponsibilityCardCategory;
  plainSummary: string;
  triggerCondition: string;
  payoutSummary: string;
  sourceUrl: string;
  sourceTitle: string;
  sourceExcerpt: string;
  confidence: 'high' | 'medium' | 'low';
  calculationStatus: CalculationStatus;
  calculationReason: string;
  cashflowTreatment: CashflowTreatment;
  indicators: QuantifiedIndicator[];
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

export function queryPolicyResponsibilities(input: { company: string; name: string; preferLocalKnowledgeAnswer?: boolean }) {
  return request<{
    ok: true;
    analysis: PolicyAnalysisResult;
  }>('/api/policy-responsibilities/query', {
    body: {
      company: input.company,
      name: input.name,
      preferLocalKnowledgeAnswer: input.preferLocalKnowledgeAnswer,
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

export function matchPolicyResponsibilities(input: { company: string; name: string; limit?: number; minScore?: number }) {
  return requestResponsibility<{
    ok: true;
    matches: PolicyKnowledgeMatch[];
  }>('/api/policy-responsibilities/matches', {
    body: {
      company: input.company,
      name: input.name,
      limit: input.limit,
      minScore: input.minScore,
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
