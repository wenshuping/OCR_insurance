export type IndicatorCalculationMeta = {
  basisKey: string;
  calculationKey: string;
  calculationEligible: boolean;
  calculationReason: string;
  value: number | null;
  unit: string;
};

export function normalizeIndicatorCalculation(indicator?: Record<string, unknown>): IndicatorCalculationMeta;
