export function responsibilityTitlesMatch(left: unknown, right: unknown): boolean;
export function mergeCalculatedResponsibilityTitles(
  baseTitles: unknown[],
  cashflowEntries: Array<{ liability?: unknown; amount?: unknown }>,
  scenarioEntries: Array<{ scenario?: unknown; amount?: unknown }>,
): string[];
