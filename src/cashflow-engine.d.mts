export function buildMemberAnnualSummaries(plans: import('./api').PolicyCashflowPlan[]): import('./api').MemberAnnualSummary[];
export function fillCashflowYears(
  annualEntries: import('./api').CashflowEntry[],
  effectiveYear: number,
  birthYear: number,
  endYear: number,
  policyInfo: { policyId: number; productName: string },
): import('./api').CashflowEntry[];
