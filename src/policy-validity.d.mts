export type PolicyValidityContext = {
  effectiveDate?: string;
  insuredBirthday?: string;
  now?: Date;
};

export type PolicyValidityStatus = {
  label: '有效' | '失效';
  tone: 'active' | 'expired';
  expiresAt: Date | null;
};

export function parseCoveragePeriodEndDate(
  coveragePeriod: string | undefined,
  context?: PolicyValidityContext,
): Date | null;

export function resolvePolicyValidityStatus(
  coveragePeriod: string | undefined,
  context?: PolicyValidityContext,
): PolicyValidityStatus;

export function policyValidityClassName(tone: PolicyValidityStatus['tone']): string;
