export type Responsibility = {
  coverageType: string;
  scenario: string;
  payout: string;
  note: string;
};

export type PolicySource = {
  title: string;
  url: string;
  snippet?: string;
  evidenceLabel?: string;
  evidenceLevel?: string;
  official?: boolean;
  sourceType?: string;
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
};

export type Policy = {
  id: number;
  company: string;
  name: string;
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
  report: string;
  sources?: PolicySource[];
  reportStatus?: 'generating' | 'ready' | 'failed' | string;
  reportError?: string;
  createdAt: string;
  userMobile?: string;
};

export type PolicyPlan = {
  company: string;
  role: 'main' | 'rider' | 'linked_account' | 'unknown' | string;
  name: string;
  matchedProductName?: string;
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

export type User = {
  id: number;
  mobile: string;
  createdAt: string;
};

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

export type AdminOverview = {
  ok: true;
  summary: {
    userCount: number;
    insuredCount: number;
    policyCount: number;
    sourceRecordCount?: number;
    knowledgeRecordCount?: number;
    totalCoverage: number;
    annualPremium: number;
  };
  users: AdminUserSummary[];
  insureds: AdminInsuredSummary[];
  policies: Policy[];
  sourceRecords?: SourceRecord[];
};

export type AdminOcrModeOption = {
  value: string;
  implemented: boolean;
  selectable: boolean;
  ready: boolean;
  description: string;
  notReadyReason?: string;
};

export type AdminOcrConfig = {
  ok: true;
  config: {
    mode: string;
    updatedAt: string | null;
    updatedByActorId: number | null;
  };
  runtime: {
    provider: string;
    providerLabel: string;
    legacyProvider: string;
    legacyProviderLabel: string;
    localVisionFallback?: {
      enabled: boolean;
      provider: string;
      scope: string;
    };
  };
  options: AdminOcrModeOption[];
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

export type UploadItem = {
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
};

export type WechatJsSdkSignature = {
  ok: true;
  appId: string;
  nonceStr: string;
  timestamp: number;
  signature: string;
  jsApiList: string[];
};

export type PolicyScanData = {
  company: string;
  name: string;
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
};

export type PolicyAnalysisResult = {
  report: string;
  coverageTable: Responsibility[];
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

export type PolicyCompanySuggestion = {
  company: string;
  recordCount: number;
};

export type PolicyProductSuggestion = {
  company: string;
  productName: string;
  recordCount: number;
};

export type CashflowEntry = {
  year: number;
  age: number;
  amount: number;
  cumulative: number;
  liability: string;
  policyId: number;
  productName: string;
  calculationText: string;
  cashValue?: number | null;
};

export type ScenarioEntry = {
  scenario: string;
  formula: string;
  amount: number;
  condition: string;
  policyId: number;
  productName: string;
  calculationText: string;
};

export type PolicyCashflowPlan = {
  policyId: number;
  productName: string;
  company: string;
  insured: string;
  insuredBirthday: string;
  effectiveDate: string;
  annualEntries: CashflowEntry[];
  scenarioEntries: ScenarioEntry[];
  totalDeterministicCashflow: number;
  expired: boolean;
};

export type MemberYearEntry = {
  year: number;
  age: number;
  totalAmount: number;
  cumulative: number;
  details: CashflowEntry[];
};

export type MemberAnnualSummary = {
  member: string;
  birthday: string;
  entries: MemberYearEntry[];
  totalCashflow: number;
};

export type PolicyFormData = {
  company: string;
  name: string;
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
};

export type PolicyUpdateInput = Partial<PolicyFormData>;

type ApiOptions = {
  token?: string;
  body?: unknown;
  method?: string;
};

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const response = await fetch(path, {
    method: options.method || (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = (await response.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (!response.ok) {
    throw new ApiError(response.status, payload?.code || 'REQUEST_FAILED', payload?.message || '请求失败');
  }
  return payload as T;
}

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

export function matchPolicyResponsibilities(input: { company: string; name: string }) {
  return request<{
    ok: true;
    matches: PolicyKnowledgeMatch[];
  }>('/api/policy-responsibilities/matches', {
    body: {
      company: input.company,
      name: input.name,
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

export function sendCode(mobile: string) {
  return request<{ ok: true; devCode?: string; expiresInSeconds: number }>('/api/auth/send-code', {
    body: { mobile },
  });
}

export function register(input: { mobile: string; code: string; guestId: string }) {
  return request<{
    ok: true;
    token: string;
    user: User;
    migratedPolicyCount: number;
    policies: Policy[];
  }>('/api/auth/register', {
    body: input,
  });
}

export function logoutCustomer(token: string) {
  return request<{ ok: true }>('/api/auth/logout', {
    token,
    body: {},
  });
}

export function listPolicies(input: { token?: string; guestId?: string } = {}) {
  const query = input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
  return request<{ ok: true; policies: Policy[] }>(`/api/policies${query}`, { token: input.token });
}

export function getPolicy(input: { token?: string; guestId?: string; id: number }) {
  const query = input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
  return request<{ ok: true; policy: Policy }>(`/api/policies/${input.id}${query}`, { token: input.token });
}

export function updatePolicy(input: { token?: string; guestId?: string; id: number; policy: PolicyUpdateInput }) {
  const query = input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
  return request<{ ok: true; policy: Policy; reportRegenerating: boolean }>(`/api/policies/${input.id}${query}`, {
    token: input.token,
    method: 'PATCH',
    body: input.policy,
  });
}

export function deletePolicy(input: { token?: string; guestId?: string; id: number }) {
  const query = input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
  return request<{ ok: true; deletedId: number }>(`/api/policies/${input.id}${query}`, {
    token: input.token,
    method: 'DELETE',
  });
}

export function regeneratePolicyReport(input: { token?: string; guestId?: string; id: number }) {
  const query = input.guestId ? `?guestId=${encodeURIComponent(input.guestId)}` : '';
  return request<{ ok: true; policy: Policy; skipped?: boolean }>(`/api/policies/${input.id}/report${query}`, {
    token: input.token,
    body: {},
  });
}

export function getWechatJsSdkSignature(url: string) {
  return request<WechatJsSdkSignature>(`/api/wechat/js-sdk-signature?url=${encodeURIComponent(url)}`);
}

export function adminLogin(password: string) {
  return request<{ ok: true; token: string; expiresInSeconds: number }>('/api/admin/login', {
    body: { password },
  });
}

export function getAdminOverview(token: string) {
  return request<AdminOverview>('/api/admin/overview', { token });
}

export function getAdminOcrConfig(token: string) {
  return request<AdminOcrConfig>('/api/admin/ocr-config', { token });
}

export function updateAdminOcrConfig(token: string, mode: string) {
  return request<AdminOcrConfig>('/api/admin/ocr-config', {
    token,
    body: { mode },
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

export function logClientPerformance(input: Record<string, unknown>) {
  const body = JSON.stringify({
    ...input,
    page: window.location.pathname,
  });
  const blob = new Blob([body], { type: 'application/json' });
  if (navigator.sendBeacon && navigator.sendBeacon('/api/client-perf', blob)) {
    return;
  }
  void fetch('/api/client-perf', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}
