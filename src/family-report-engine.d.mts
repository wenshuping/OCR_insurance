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

export type FamilyPolicyInventoryRow = {
  policyId: number;
  member: string;
  company: string;
  policyNumber?: string;
  productName: string;
  typeLabel: string;
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
  member: string;
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
  status: 'covered' | 'partial' | 'missing' | 'formula' | 'unknown';
  conditionText: string;
  sourcePolicies: FamilyProtectionSourcePolicy[];
};

export type FamilyMemberProtectionReport = {
  member: string;
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
  policyId: number;
  productName: string;
};

export type FamilyWealthPolicyCashValueRow = {
  policyYear: number;
  age: number | null;
  calendarYear: number;
  cashValue: number;
};

export type FamilyWealthPolicyAnnualCashflowRow = {
  year: number;
  age: number | null;
  amount: number;
  cumulative: number;
  cashValue: number | null;
  liabilities: string[];
};

export type FamilyWealthKeyPoint = {
  label: string;
  value: string;
  amount: number;
  year?: number;
};

export type FamilyWealthPolicyReport = {
  policyId: number;
  productName: string;
  company: string;
  annualPremium: number;
  cashflowRows: FamilyWealthPolicyCashflowRow[];
  cashValueRows: FamilyWealthPolicyCashValueRow[];
  annualCashflowRows: FamilyWealthPolicyAnnualCashflowRow[];
  keyPoints: FamilyWealthKeyPoint[];
  attentionItems: string[];
};

export type FamilyMemberWealthReport = {
  member: string;
  policies: FamilyWealthPolicyReport[];
  attentionItems: string[];
};

export type FamilyWealthAggregateDetail = {
  type: 'premium' | 'payout' | 'cashValue' | string;
  policyId: number;
  productName: string;
  member: string;
  amount: number;
  liability?: string;
  policyYear?: number;
  calendarYear?: number;
  age?: number | null;
};

export type FamilyWealthAggregateRow = {
  year: number;
  premiumOutflow: number;
  payoutInflow: number;
  netCashflow: number;
  cumulativeNetCashflow: number;
  cashValueTotal: number;
  details: FamilyWealthAggregateDetail[];
};

export type FamilyWealthReport = {
  memberReports: FamilyMemberWealthReport[];
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
};

export type FamilyPlanningProfile = {
  annualExpense?: number;
  debt?: number;
  educationGoal?: number;
  retirementGoal?: number;
  availableAssets?: number;
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
  name: string;
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
  appendix: { policies: Array<{ policyId: number; productName: string; ocrText: string }> };
};

export function buildFamilyReport(policies: Policy[], planningProfile?: FamilyPlanningProfile | null): FamilyReport;
export function buildFamilyReportSummary(policies: Policy[]): FamilyReportSummary;
export function buildPolicyInventory(policies: Policy[]): FamilyPolicyInventory;
export function buildCriticalIllnessSection(policies: Policy[]): FamilySectionReport;
export function buildAccidentSection(policies: Policy[]): FamilySectionReport;
export function buildWealthSection(policies: Policy[]): FamilyWealthReport;
export function buildFamilyRadarReport(policies: Policy[], planningProfile?: FamilyPlanningProfile | null): FamilyRadarReport;
