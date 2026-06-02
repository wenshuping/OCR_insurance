import type {
  FamilyPlanningProfile,
} from '../../family-report-engine.mjs';

export const FAMILY_PLANNING_PROFILE_KEY = 'policy-ocr-app.familyPlanningProfile';

export function normalizePlanningProfile(value: unknown): FamilyPlanningProfile {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>;
  return {
    annualExpense: Math.max(0, Number(source.annualExpense) || 0),
    debt: Math.max(0, Number(source.debt) || 0),
    educationGoal: Math.max(0, Number(source.educationGoal) || 0),
    retirementGoal: Math.max(0, Number(source.retirementGoal) || 0),
    availableAssets: Math.max(0, Number(source.availableAssets) || 0),
  };
}

export function readFamilyPlanningProfile(): FamilyPlanningProfile {
  try {
    const raw = localStorage.getItem(FAMILY_PLANNING_PROFILE_KEY);
    return raw ? normalizePlanningProfile(JSON.parse(raw)) : {};
  } catch {
    return {};
  }
}

export function saveFamilyPlanningProfile(profile: FamilyPlanningProfile) {
  const normalized = normalizePlanningProfile(profile);
  localStorage.setItem(FAMILY_PLANNING_PROFILE_KEY, JSON.stringify(normalized));
  return normalized;
}
