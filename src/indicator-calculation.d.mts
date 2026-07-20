export type IndicatorCalculationResult = {
  resolved: boolean;
  amount: number;
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
