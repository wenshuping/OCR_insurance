export function parseConditionYearRange(
  condition: string,
  ctx: { effectiveYear: number; birthYear: number; coverageEndYear: number },
): { startYear: number; endYear: number } | null;

export function expandCashflowIndicator(indicator: any, policy: any): import('./api').CashflowEntry[];
export function buildScenarioEntries(indicators: any[], policy: any): import('./api').ScenarioEntry[];
export function buildPolicyCashflowPlans(policies: any[]): import('./api').PolicyCashflowPlan[];
export function buildMemberAnnualSummaries(plans: import('./api').PolicyCashflowPlan[]): import('./api').MemberAnnualSummary[];
