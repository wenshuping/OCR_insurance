export type IndicatorCalculationMeta = {
  basisKey: string;
  calculationKey: string;
  calculationEligible: boolean;
  calculationReason: string;
  decisionSource?: string;
  value: number | null;
  unit: string;
};

export function normalizeIndicatorCalculation(indicator?: Record<string, unknown>): IndicatorCalculationMeta;

export type IndicatorCalculationResult = {
  resolved: boolean;
  amount: number;
  minimumAmount?: number;
  partial?: boolean;
  isMinimumEstimate?: boolean;
  hasBranchScenarios?: boolean;
  scenarioKind?: 'scheduled_benefit' | 'claim_event' | 'policy_parameter';
  uncertaintyNote?: string;
  formula?: string;
  calculationText: string;
  meta: IndicatorCalculationMeta;
};

export function hasQuantifiedCalculationSignal(value: unknown): boolean;

export function formulaVariablesFromIndicators(indicators?: Array<Record<string, unknown>>): Record<string, string>;

export function resolveIndicatorAmountFromCalculation(
  indicator?: Record<string, unknown>,
  inputs?: {
    baseAmount?: string | number;
    firstPremium?: string | number;
    paymentYears?: string | number;
    currentAge?: string | number;
    paymentPeriod?: string;
    coveragePeriod?: string;
    benefitFrequency?: string;
    paymentFrequency?: string;
    monthlyConversionFactor?: string | number;
    effectiveInsuranceAmount?: string | number;
    accumulatedDividendInsuredAmount?: string | number;
    policyYear?: string | number;
    formulaVariables?: Record<string, unknown>;
  },
): IndicatorCalculationResult;

export function resolveIndicatorAmountForCurrentContext(
  indicator?: Record<string, unknown>,
  inputs?: Parameters<typeof resolveIndicatorAmountFromCalculation>[1],
): IndicatorCalculationResult;
