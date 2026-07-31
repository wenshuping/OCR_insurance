export type IndicatorCalculationResult = {
  resolved: boolean;
  partial?: boolean;
  amount: number;
  minimumAmount?: number;
  isMinimumEstimate?: boolean;
  uncertaintyNote?: string;
  calculationText: string;
  meta: {
    calculationEligible: boolean;
    calculationReason?: string;
  };
};

export function hasQuantifiedCalculationSignal(value: unknown): boolean;

export function resolveIndicatorAmountFromCalculation(
  indicator?: Record<string, unknown>,
  inputs?: {
    baseAmount?: string | number;
    firstPremium?: string | number;
    paymentYears?: string | number;
  },
): IndicatorCalculationResult;
