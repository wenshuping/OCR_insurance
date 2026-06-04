import type { PolicyAnalysisResult, PolicyFormData, PolicyKnowledgeMatch } from './policy';
import { request } from '../client';

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
  return request<{
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
  return request<{
    ok: true;
    suggestions: PolicyCompanySuggestion[];
  }>(`/api/policy-responsibilities/company-suggestions${suffix}`);
}

export function listPolicyResponsibilityProductSuggestions(input: { company: string; q?: string; limit?: number }) {
  const params = new URLSearchParams();
  params.set('company', input.company);
  if (input.q) params.set('q', input.q);
  if (input.limit) params.set('limit', String(input.limit));
  return request<{
    ok: true;
    suggestions: PolicyProductSuggestion[];
  }>(`/api/policy-responsibilities/product-suggestions?${params.toString()}`);
}
