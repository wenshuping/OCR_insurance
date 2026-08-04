export type IndicatorCalculationResult = {
  resolved: boolean;
  partial?: boolean;
  amount: number;
  minimumAmount?: number;
  isMinimumEstimate?: boolean;
  hasBranchScenarios?: boolean;
  scenarioKind?: string;
  uncertaintyNote?: string;
  calculationText: string;
  meta: {
    calculationEligible: boolean;
    calculationReason?: string;
  };
};

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

export function hasQuantifiedCalculationSignal(value: unknown): boolean;

export function formulaVariablesFromIndicators(indicators?: Array<Record<string, unknown>>): Record<string, string>;

export function resolveIndicatorAmountFromCalculation(
  indicator?: Record<string, unknown>,
  inputs?: {
    baseAmount?: string | number;
    firstPremium?: string | number;
    paymentYears?: string | number;
    paymentPeriod?: string;
    coveragePeriod?: string;
    benefitFrequency?: string;
    paymentFrequency?: string;
    monthlyConversionFactor?: string | number;
    effectiveInsuranceAmount?: string | number;
    accumulatedDividendInsuredAmount?: string | number;
    effectiveInsuranceAmount?: string | number;
    policyYear?: string | number;
    formulaVariables?: Record<string, string | number>;
  },
): IndicatorCalculationResult;

export function resolveIndicatorAmountForCurrentContext(
  indicator?: Record<string, unknown>,
  inputs?: Parameters<typeof resolveIndicatorAmountFromCalculation>[1],
): IndicatorCalculationResult;
