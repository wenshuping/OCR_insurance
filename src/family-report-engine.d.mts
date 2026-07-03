import type { Policy } from './api';

export type FamilyReportSummary = {
  memberCount: number;
  policyCount: number;
  annualPremium: number;
  totalCoverage: number;
  cashValueTotal: number;
  futurePayoutTotal: number;
  attentionItems: string[];
};

export type FamilyPolicyInventoryPlanItem = {
  roleLabel: string;
  productName: string;
  matchedProductName: string;
  typeLabel: string;
  coverageText: string;
  premiumText: string;
  paymentPeriod: string;
  coveragePeriod: string;
  statusLabel: string;
};

export type FamilyPolicyInventoryRow = {
  policyId: number;
  memberKey: string;
  memberId: number | null;
  member: string;
  relationLabel: string;
  applicant: string;
  applicantMemberId: number | null;
  applicantRelationLabel: string;
  participantReviewStatus: string;
  company: string;
  policyNumber?: string;
  productName: string;
  planItems: FamilyPolicyInventoryPlanItem[];
  typeLabel: string;
  isInactive: boolean;
  policyStatusText: string;
  annualPremium: number;
  annualPremiumText: string;
  paymentPeriod: string;
  coveragePeriod: string;
  effectiveDate: string;
  coverage: number;
  coverageText: string;
  beneficiary: string;
  totalPremiumText?: string;
  cashValue: number;
  cashValueText: string;
  futurePayout: number;
  futurePayoutText: string;
  dataStatus: string;
};

export type FamilyInsuredPolicyGroup = {
  memberKey?: string;
  memberId?: number | null;
  member: string;
  relationLabel?: string;
  policies: FamilyPolicyInventoryRow[];
  annualPremium: number;
  totalCoverage: number;
  cashValueTotal: number;
  futurePayoutTotal: number;
};

export type FamilyPolicyInventory = {
  rows: FamilyPolicyInventoryRow[];
  insuredGroups: FamilyInsuredPolicyGroup[];
};

export type FamilyProtectionSourcePolicy = {
  sourceKey?: string;
  policyId: number | string | null | undefined;
  company?: string;
  productName: string;
  liability: string;
  formulaText: string;
  amount?: number;
  amountText?: string;
  calculationText?: string;
};

export type FamilyProtectionRow = {
  key: string;
  label: string;
  amount: number;
  amountText: string;
  countText: string;
  status: 'covered' | 'partial' | 'missing' | 'formula' | 'inactive' | 'unknown';
  conditionText: string;
  sourcePolicies: FamilyProtectionSourcePolicy[];
};

export type FamilyMemberProtectionReport = {
  memberKey?: string;
  memberId?: number | null;
  member: string;
  relationLabel?: string;
  rows: FamilyProtectionRow[];
  attentionItems: string[];
};

export type FamilySectionReport = {
  members: FamilyMemberProtectionReport[];
};

export type FamilyWealthPolicyCashflowRow = {
  year: number;
  age: number | null;
  amount: number;
  cumulative: number;
  liability: string;
  calculationText?: string;
  policyId: number;
  productName: string;
};

export type FamilyWealthPolicyCashValueRow = {
  policyYear: number;
  age: number | null;
  calendarYear: number;
  cashValueDate: string;
  cashValueDateLabel: string;
  cashValueTime: number | null;
  cashValue: number;
};

export type FamilyWealthPolicyAnnualCashflowRow = {
  year: number;
  age: number | null;
  amount: number;
  cumulative: number;
  cashValue: number | null;
  liabilities: string[];
  isMaturityPayout?: boolean;
  isContractTerminatingPayout?: boolean;
  cashValueReferenceType?: 'pre_maturity' | 'pre_termination' | 'surrender' | 'reference' | '';
  cashValueIsNonAdditiveReference?: boolean;
  cashValueIsPreMaturityReference?: boolean;
  cashValueNote?: string;
};

export type FamilyWealthKeyPoint = {
  label: string;
  value: string;
  amount: number;
  year?: number;
  note?: string;
};

export type FamilyWealthUncertaintyItem = {
  key: 'dividend' | 'universal_account' | string;
  label: string;
  reason: string;
};

export type FamilyWealthPolicyReport = {
  policyId: number;
  productName: string;
  company: string;
  annualPremium: number;
  cashflowRows: FamilyWealthPolicyCashflowRow[];
  cashValueRows: FamilyWealthPolicyCashValueRow[];
  excludedCashflowRows: FamilyWealthPolicyCashflowRow[];
  excludedCashValueRows: FamilyWealthPolicyCashValueRow[];
  annualCashflowRows: FamilyWealthPolicyAnnualCashflowRow[];
  uncertaintyItems: FamilyWealthUncertaintyItem[];
  uncertaintyNote: string;
  hasUncertainWealthFactors: boolean;
  keyPoints: FamilyWealthKeyPoint[];
  attentionItems: string[];
};

export type FamilyMemberWealthReport = {
  memberKey?: string;
  memberId?: number | null;
  member: string;
  relationLabel?: string;
  policies: FamilyWealthPolicyReport[];
  attentionItems: string[];
};

export type FamilyWealthAggregateDetail = {
  type: 'premium' | 'payout' | 'cashValue' | string;
  policyId: number;
  productName: string;
  member: string;
  policyholder: string;
  amount: number;
  increase?: number;
  liability?: string;
  policyYear?: number;
  calendarYear?: number;
  age?: number | null;
};

export type FamilyWealthAggregateRow = {
  year: number;
  premiumOutflow: number;
  payoutInflow: number;
  cashValueIncrease: number;
  netCashflow: number;
  cumulativeNetCashflow: number;
  cumulativePayoutInflow: number;
  cashValueTotal: number;
  totalValue: number;
  details: FamilyWealthAggregateDetail[];
};

export type FamilyWealthExcludedPolicy = {
  policyId: number;
  member: string;
  productName: string;
  reasons: string[];
  note: string;
};

export type FamilyWealthReport = {
  memberReports: FamilyMemberWealthReport[];
  excludedPolicies: FamilyWealthExcludedPolicy[];
  statisticsScopeNote: string;
  aggregateRows: FamilyWealthAggregateRow[];
  keyPoints: FamilyWealthKeyPoint[];
};

export type FamilyRadarDimension = {
  key: 'critical' | 'accident' | 'medical' | 'life' | 'wealth';
  label: string;
};

export type FamilyRadarAmountDetail = {
  sourceKey?: string;
  policyId?: number | string | null | undefined;
  company: string;
  productName: string;
  liability: string;
  label: string;
  amount: number;
  amountText: string;
  calculationText: string;
  referenceOnly?: boolean;
};

export type FamilyPlanningProfile = {
  annualIncome?: number;
  annualExpense?: number;
  debt?: number;
  educationGoal?: number;
  parentSupportGoal?: number;
  retirementGoal?: number;
  availableAssets?: number;
  premiumBudget?: number;
};

export type FamilyPlanningAssumptions = {
  criticalRecoveryYears: number;
  criticalRecoveryReserve: number;
  medicalTarget: number;
  accidentExpenseYears: number;
  lifeExpenseYears: number;
  wealthDiscountRate: number;
};

export type FamilyRadarScore = {
  key: FamilyRadarDimension['key'];
  label: string;
  amount: number;
  effectiveAmount: number;
  coveragePresent: boolean;
  score: number;
  amountText: string;
  effectiveAmountText: string;
  policyCount: number;
  note: string;
  amountDetails: FamilyRadarAmountDetail[];
  target?: number;
  targetText?: string;
  gap?: number;
  gapText?: string;
  over?: number;
  overText?: string;
  adequacyRate?: number;
  adequacyText?: string;
  targetSource?: 'family' | 'system_estimate' | string;
};

export type FamilyRadarSeries = {
  memberKey?: string;
  memberId?: number | null;
  name: string;
  relationLabel?: string;
  role?: 'adult' | 'child' | 'elder' | string;
  roleLabel?: string;
  targetSource?: 'system_estimate' | string;
  scores: FamilyRadarScore[];
  totalAmount: number;
  notes: string[];
};

export type FamilyRadarReport = {
  dimensions: FamilyRadarDimension[];
  mode: 'structure' | 'planning';
  planningProfile: FamilyPlanningProfile | null;
  planningTargets: Record<FamilyRadarDimension['key'], number> | null;
  assumptions: FamilyPlanningAssumptions;
  family: FamilyRadarSeries;
  members: FamilyRadarSeries[];
  hiddenMembers: FamilyRadarSeries[];
};

export type FamilyReport = {
  summary: FamilyReportSummary;
  policyInventory: FamilyPolicyInventory;
  criticalIllness: FamilySectionReport;
  accident: FamilySectionReport;
  wealth: FamilyWealthReport;
  radar: FamilyRadarReport;
  familyPolicyAnalysisReport?: {
    status?: string;
    content?: string;
    model?: string;
    generatedAt?: string;
    error?: string;
  };
  appendix: { policies: Array<{ policyId: number; productName: string; ocrText: string }> };
};

export type FamilyReportOptions = {
  familyId?: number | null;
  corrections?: Array<{
    status?: string;
    action?: string;
    dimension?: string;
    policyId?: number | null;
    memberId?: number | null;
    productName?: string;
  }>;
};

export function buildFamilyReport(policies: Policy[], planningProfile?: FamilyPlanningProfile | null, options?: FamilyReportOptions): FamilyReport;
export function buildFamilyReportSummary(policies: Policy[]): FamilyReportSummary;
export function buildPolicyInventory(policies: Policy[]): FamilyPolicyInventory;
export function buildCriticalIllnessSection(policies: Policy[]): FamilySectionReport;
export function buildAccidentSection(policies: Policy[]): FamilySectionReport;
export function buildWealthSection(policies: Policy[]): FamilyWealthReport;
export function buildFamilyRadarReport(policies: Policy[], planningProfile?: FamilyPlanningProfile | null, options?: FamilyReportOptions): FamilyRadarReport;
